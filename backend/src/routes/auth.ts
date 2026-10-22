import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { issueToken, verifyPassword } from '../auth-utils';
import { query } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { findUserByUsername, revokeToken, toPublicUser } from '../services/users';
import { isOnline } from '../presence';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  display_name: z.string().trim().min(1).max(80).optional(),
  avatarUrl: z.string().trim().max(500).nullable().optional(),
  avatar_url: z.string().trim().max(500).nullable().optional(),
});

export async function applyProfileUpdate(req: AuthedRequest, res: import('express').Response): Promise<void> {
  const body = profileSchema.parse(req.body ?? {});
  const displayName = body.displayName ?? body.display_name;
  const avatarUrl = body.avatarUrl !== undefined ? body.avatarUrl : body.avatar_url;
  const user = req.user!;
  const { rows } = await query<import('../services/users').UserRow>(
    'UPDATE users SET display_name = $2, avatar_url = $3 WHERE id = $1 RETURNING *',
    [user.id, displayName ?? user.display_name, avatarUrl !== undefined ? avatarUrl : user.avatar_url],
  );
  res.json(toPublicUser(rows[0], isOnline(user.id)));
}

export function authRouter(): Router {
  const r = Router();

  // No public registration — ever. Explicit 404 so clients don't retry.
  r.all('/register', (_req, res) => res.status(404).json({ error: 'Registration is disabled. This is a private team app.' }));
  r.all('/signup', (_req, res) => res.status(404).json({ error: 'Registration is disabled. This is a private team app.' }));

  r.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const { username, password } = loginSchema.parse(req.body ?? {});
      const user = await findUserByUsername(username);
      // Generic error for unknown user, wrong password AND inactive account:
      // never reveal which one failed.
      if (!user || !user.is_active) {
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }
      await query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);
      const issued = issueToken(user);
      res.json({ token: issued.token, expiresAt: issued.expiresAt.toISOString(), user: toPublicUser(user, true) });
    } catch (err) {
      next(err);
    }
  });

  r.post('/logout', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const payload = req.token!;
      // Revoke this session's jti until its natural expiry.
      const exp = req.tokenExpiresAt ?? new Date(Date.now() + 24 * 3600 * 1000);
      await revokeToken(payload.jti, req.user!.id, exp);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  r.get('/me', requireAuth, (req: AuthedRequest, res) => {
    res.json(toPublicUser(req.user!, isOnline(req.user!.id)));
  });

  // Android client uses PATCH /api/auth/me for profile updates.
  r.patch('/me', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      await applyProfileUpdate(req, res);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
