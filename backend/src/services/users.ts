import { query } from '../db';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  avatar_url: string | null;
  is_active: boolean;
  token_version: number;
  last_seen: Date | null;
  created_at: Date;
}

/** Public shape: camelCase (Android DTOs) + snake_case aliases for API consumers. Never includes the hash. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  display_name: string;
  avatarUrl: string | null;
  avatar_url: string | null;
  isOnline: boolean;
  is_online: boolean;
  isActive: boolean;
  is_active: boolean;
  lastSeen: string | null;
  last_seen: string | null;
  createdAt: string;
  created_at: string;
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

export function toPublicUser(row: UserRow, isOnline = false): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? row.username,
    display_name: row.display_name ?? row.username,
    avatarUrl: row.avatar_url,
    avatar_url: row.avatar_url,
    isOnline,
    is_online: isOnline,
    isActive: row.is_active,
    is_active: row.is_active,
    lastSeen: iso(row.last_seen),
    last_seen: iso(row.last_seen),
    createdAt: iso(row.created_at) ?? '',
    created_at: iso(row.created_at) ?? '',
  };
}

export async function findUserByUsername(username: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function countUsers(): Promise<number> {
  const { rows } = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}

export async function isRevoked(jti: string): Promise<boolean> {
  const { rows } = await query('SELECT 1 FROM revoked_sessions WHERE jti = $1 AND expires_at > NOW()', [jti]);
  return rows.length > 0;
}

export async function revokeToken(jti: string, userId: string, expiresAt: Date): Promise<void> {
  await query(
    `INSERT INTO revoked_sessions (jti, user_id, expires_at) VALUES ($1,$2,$3)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, userId, expiresAt],
  );
  // Opportunistic cleanup so the table stays small.
  await query('DELETE FROM revoked_sessions WHERE expires_at <= NOW()');
}
