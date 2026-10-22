import { Router } from 'express';
import { query } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { toPublicUser, type UserRow } from '../services/users';
import { isOnline } from '../presence';
import { applyProfileUpdate } from './auth';

export function usersRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // Team directory: active authorized members only.
  r.get('/', async (req: AuthedRequest, res, next) => {
    try {
      const excludeSelf = req.query.excludeSelf === 'true' || req.query.exclude_self === 'true';
      const { rows } = await query<UserRow>(
        'SELECT * FROM users WHERE is_active = TRUE ORDER BY username ASC',
      );
      const users = rows
        .filter((u) => !excludeSelf || u.id !== req.user!.id)
        .map((u) => toPublicUser(u, isOnline(u.id)));
      res.json(users);
    } catch (err) {
      next(err);
    }
  });

  r.get('/me/profile', (req: AuthedRequest, res) => {
    res.json(toPublicUser(req.user!, isOnline(req.user!.id)));
  });

  r.patch('/me/profile', async (req: AuthedRequest, res, next) => {
    try {
      await applyProfileUpdate(req, res);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
