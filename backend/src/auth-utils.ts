import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';

export const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  if (!plain || plain.length < 8) throw new Error('Password must be at least 8 characters');
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

export interface TokenPayload {
  sub: string; // user id
  username: string;
  tv: number; // token_version at issue time
  jti: string;
}

export interface IssuedToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

export function issueToken(user: { id: string; username: string; token_version: number }): IssuedToken {
  const jti = uuidv4();
  const payload: Omit<TokenPayload, 'jti'> = { sub: user.id, username: user.username, tv: user.token_version };
  const token = jwt.sign(payload, config.jwtSecret, {
    jwtid: jti,
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
  const decoded = jwt.decode(token) as { exp?: number } | null;
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 12 * 3600 * 1000);
  return { token, jti, expiresAt };
}

export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  if (!decoded.sub || typeof decoded.jti !== 'string') throw new Error('Malformed token');
  return {
    sub: String(decoded.sub),
    username: String(decoded.username ?? ''),
    tv: Number(decoded.tv ?? 0),
    jti: decoded.jti,
  };
}
