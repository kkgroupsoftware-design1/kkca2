import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';

const tokenSchema = z.object({
  token: z.string().trim().min(10).max(4096).optional(),
  fcmToken: z.string().trim().min(10).max(4096).optional(),
  fcm_token: z.string().trim().min(10).max(4096).optional(),
  platform: z.string().trim().max(32).optional().default('android'),
});

export function devicesRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.post('/fcm-token', async (req: AuthedRequest, res, next) => {
    try {
      const body = tokenSchema.parse(req.body ?? {});
      const token = body.token ?? body.fcmToken ?? body.fcm_token;
      if (!token) {
        res.status(400).json({ error: 'token is required' });
        return;
      }
      // A token belongs to exactly one user at a time (device hand-over safe).
      await query('DELETE FROM devices WHERE fcm_token = $1 AND user_id <> $2', [token, req.user!.id]);
      await query(
        `INSERT INTO devices (user_id, fcm_token, platform, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (user_id, fcm_token) DO UPDATE SET platform = EXCLUDED.platform, updated_at = NOW()`,
        [req.user!.id, token, body.platform],
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Android calls DELETE with no body → remove all of the user's tokens.
  // With a token in body/query, remove just that one.
  r.delete('/fcm-token', async (req: AuthedRequest, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const token =
        (typeof body.token === 'string' && body.token) ||
        (typeof req.query.token === 'string' && req.query.token) ||
        null;
      if (token) {
        await query('DELETE FROM devices WHERE user_id = $1 AND fcm_token = $2', [req.user!.id, token]);
      } else {
        await query('DELETE FROM devices WHERE user_id = $1', [req.user!.id]);
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
