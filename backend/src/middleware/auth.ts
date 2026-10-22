import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type TokenPayload } from '../auth-utils';
import { findUserById, isRevoked, type UserRow } from '../services/users';

export interface AuthedRequest extends Request {
  user?: UserRow;
  token?: TokenPayload;
  tokenExpiresAt?: Date;
}

export function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  // File downloads from the Android client may pass the token as a query param.
  const q = req.query.access_token;
  return typeof q === 'string' && q ? q : null;
}

/**
 * Full session check on every request: signature + expiry (jsonwebtoken),
 * server-side revocation (logout), token_version (password change / admin
 * revocation bumps it and kills all older tokens), and is_active.
 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearer(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    let payload: TokenPayload;
    try {
      payload = verifyToken(token);
    } catch {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }
    if (await isRevoked(payload.jti)) {
      res.status(401).json({ error: 'Session has been revoked' });
      return;
    }
    const user = await findUserById(payload.sub);
    if (!user || !user.is_active) {
      res.status(401).json({ error: 'Account is not authorized' });
      return;
    }
    if (user.token_version !== payload.tv) {
      res.status(401).json({ error: 'Session has been revoked' });
      return;
    }
    req.user = user;
    req.token = payload;
    // Recover exp for exact revocation lifetime (verifyToken strips it).
    try {
      const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: number };
      if (decoded.exp) req.tokenExpiresAt = new Date(decoded.exp * 1000);
    } catch { /* revocation falls back to a safe upper bound in the route */ }
    next();
  } catch (err) {
    next(err);
  }
}
