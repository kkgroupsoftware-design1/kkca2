import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, issueToken, verifyToken, BCRYPT_COST } from '../src/auth-utils';
import { canInsertUser, assertCanInsertUser, validateSeedList } from '../src/users-cap';

describe('password hashing', () => {
  it('hashes with bcrypt cost 12 and verifies', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.match(hash, /^\$2[aby]\$12\$/); // $2b$12$… cost factor embedded
    assert.equal(BCRYPT_COST, 12);
    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('wrong password', hash), false);
    assert.notEqual(hash.includes('correct'), true);
  });

  it('rejects short passwords', async () => {
    await assert.rejects(() => hashPassword('short'));
  });
});

describe('JWT issue / verify / tamper', () => {
  const user = { id: '11111111-1111-4111-8111-111111111111', username: 'malik1', token_version: 3 };

  it('issues a token that verifies with jti + token version', () => {
    const issued = issueToken(user);
    const payload = verifyToken(issued.token);
    assert.equal(payload.sub, user.id);
    assert.equal(payload.username, 'malik1');
    assert.equal(payload.tv, 3);
    assert.equal(payload.jti, issued.jti);
    assert.ok(issued.expiresAt.getTime() > Date.now());
  });

  it('each issued token has a unique jti (per-session revocation works)', () => {
    assert.notEqual(issueToken(user).jti, issueToken(user).jti);
  });

  it('rejects a tampered token', () => {
    const { token } = issueToken(user);
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'attacker', username: 'x', tv: 3, jti: 'fake' })).toString('base64url');
    assert.throws(() => verifyToken(parts.join('.')));
  });

  it('rejects an expired token', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { config } = await import('../src/config');
    const expired = jwt.sign({ sub: user.id, username: user.username, tv: 3 }, config.jwtSecret, {
      jwtid: 'expired-jti',
      expiresIn: '-10s',
    });
    assert.throws(() => verifyToken(expired), /expired/i);
  });
});

describe('10-user cap (canInsertUser)', () => {
  it('allows inserts below the cap and blocks at/above it', () => {
    assert.equal(canInsertUser(0), true);
    assert.equal(canInsertUser(9), true);
    assert.equal(canInsertUser(10), false);
    assert.equal(canInsertUser(11), false);
    assert.equal(canInsertUser(2, 3), true);
    assert.equal(canInsertUser(3, 3), false);
    assert.throws(() => assertCanInsertUser(10), /capped at 10/);
    assert.doesNotThrow(() => assertCanInsertUser(9));
  });

  it('validates seed lists: size, duplicates, empties', () => {
    assert.doesNotThrow(() => validateSeedList(['a', 'b']));
    assert.throws(() => validateSeedList(Array.from({ length: 11 }, (_, i) => `u${i}`)), /cap is 10/);
    assert.throws(() => validateSeedList(['Malik1', 'malik1']), /Duplicate/);
    assert.throws(() => validateSeedList([]), /empty/);
  });
});
