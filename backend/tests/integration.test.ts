import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';

/**
 * Integration test: real Express app + real SQL schema on pg-mem (in-memory
 * Postgres), exercising the login → me → logout(revoke) flow end to end.
 * Skips gracefully only if pg-mem itself cannot start.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-secret';
process.env.NODE_ENV = 'test';

let server: Server;
let base = '';
let skipReason = '';

before(async () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { newDb, DataType } = require('pg-mem');
    const { randomUUID } = await import('crypto');
    const db = newDb();
    // pg-mem does not ship gen_random_uuid(); register an equivalent so the
    // REAL production migration SQL runs unmodified.
    db.public.registerFunction({
      name: 'gen_random_uuid',
      args: [],
      returns: DataType.uuid,
      impure: true, // pg-mem otherwise caches the first UUID for every row
      implementation: () => randomUUID(),
    });
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const { setPoolForTests } = await import('../src/db');
    setPoolForTests(pool as never);

    // Real migration SQL against the in-memory database.
    const sql = fs.readFileSync(path.resolve(__dirname, '..', 'migrations', '001_init.sql'), 'utf8');
    await pool.query(sql);
    // schema_migrations bookkeeping for idempotency parity with the runner:
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');

    const { hashPassword } = await import('../src/auth-utils');
    const hash = await hashPassword('integration-pass-1');
    await pool.query(
      'INSERT INTO users (username, password_hash, display_name, is_active) VALUES ($1,$2,$3,TRUE)',
      ['malik1', hash, 'Malik One'],
    );
    await pool.query(
      'INSERT INTO users (username, password_hash, display_name, is_active) VALUES ($1,$2,$3,FALSE)',
      ['ghost', hash, 'Deactivated'],
    );

    const { createApp } = await import('../src/app');
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  } catch (err) {
    skipReason = `pg-mem unavailable: ${(err as Error).message}`;
  }
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, json };
}

describe('integration: auth flow on pg-mem', () => {
  it('logs in, reads /me, rejects bad credentials generically, revokes on logout', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }

    const bad = await call('POST', '/api/auth/login', { username: 'malik1', password: 'wrong-password' });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, 'Invalid username or password');

    const unknown = await call('POST', '/api/auth/login', { username: 'nobody', password: 'whatever-pass' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.json.error, 'Invalid username or password');

    const inactive = await call('POST', '/api/auth/login', { username: 'ghost', password: 'integration-pass-1' });
    assert.equal(inactive.status, 401);

    const ok = await call('POST', '/api/auth/login', { username: 'malik1', password: 'integration-pass-1' });
    assert.equal(ok.status, 200);
    const token = ok.json.token as string;
    assert.ok(token);
    const user = ok.json.user as Record<string, unknown>;
    assert.equal(user.username, 'malik1');
    assert.equal(user.displayName, 'Malik One');
    assert.equal('password_hash' in user, false);
    assert.equal('passwordHash' in user, false);

    const me = await call('GET', '/api/auth/me', undefined, token);
    assert.equal(me.status, 200);
    assert.equal((me.json as Record<string, unknown>).username, 'malik1');

    const directory = await call('GET', '/api/users', undefined, token);
    assert.equal(directory.status, 200);

    const noAuth = await call('GET', '/api/auth/me');
    assert.equal(noAuth.status, 401);

    const register = await call('POST', '/api/auth/register', { username: 'evil', password: 'evil-password' });
    assert.equal(register.status, 404);

    const out = await call('POST', '/api/auth/logout', undefined, token);
    assert.equal(out.status, 200);
    const meAfter = await call('GET', '/api/auth/me', undefined, token);
    assert.equal(meAfter.status, 401); // jti revoked server-side
  });

  it('health endpoint responds', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  });
});
