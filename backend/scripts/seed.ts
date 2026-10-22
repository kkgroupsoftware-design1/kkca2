import fs from 'fs';
import path from 'path';
import { config } from '../src/config';
import { closePool, query } from '../src/db';
import { hashPassword } from '../src/auth-utils';
import { runMigrations } from '../src/migrate';
import { countUsers, findUserByUsername } from '../src/services/users';
import { assertCanInsertUser, validateSeedList } from '../src/users-cap';

/**
 * Secure initial provisioning for the (max) 10 authorized accounts.
 *
 * Input priority:
 *   1. USERS_FILE env (path to JSON)
 *   2. SEED_USERS_JSON env (inline JSON)
 *   3. seed/users.json        (gitignored — put the REAL passwords here)
 *   4. seed/users.example.json (CHANGE_ME placeholders, for a first boot check)
 *   5. Built-in fallback user1..user10 with CHANGE_ME passwords
 *
 * Format: [{ "username": "malik1", "password": "...", "displayName": "Malik 1" }]
 * Passwords are hashed with bcrypt cost 12. Only usernames are ever printed.
 * Idempotent: existing usernames are updated (password + display name + active).
 * Usage: npm run seed [-- --check]
 */

interface SeedUser {
  username: string;
  password: string;
  displayName?: string;
}

function loadSeedUsers(): SeedUser[] {
  if (config.usersFile) {
    const p = path.resolve(process.cwd(), config.usersFile);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) as SeedUser[];
  }
  if (config.seedUsersJson) return JSON.parse(config.seedUsersJson) as SeedUser[];
  for (const candidate of ['seed/users.json', 'seed/users.example.json']) {
    const p = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) as SeedUser[];
  }
  return Array.from({ length: 10 }, (_, i) => ({
    username: `user${i + 1}`,
    password: `CHANGE_ME_user${i + 1}_please_set_real_password`,
    displayName: `User ${i + 1}`,
  }));
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  await runMigrations();
  const current = await countUsers();
  if (checkOnly) {
    console.log(`Users in database: ${current} / max ${config.maxUsers}`);
    await closePool();
    return;
  }

  const seedUsers = loadSeedUsers();
  validateSeedList(seedUsers.map((u) => u.username), config.maxUsers);

  let inserted = 0;
  let updated = 0;
  for (const seedUser of seedUsers) {
    const username = seedUser.username.trim();
    if (!username || !seedUser.password || seedUser.password.length < 8) {
      throw new Error(`Seed entry for "${username}" is missing a username or a password of 8+ characters`);
    }
    const existing = await findUserByUsername(username);
    const hash = await hashPassword(seedUser.password);
    if (existing) {
      await query(
        'UPDATE users SET password_hash = $2, display_name = COALESCE($3, display_name), is_active = TRUE WHERE id = $1',
        [existing.id, hash, seedUser.displayName ?? null],
      );
      updated += 1;
    } else {
      // Re-count right before inserting: the cap is enforced per insert.
      assertCanInsertUser(await countUsers(), config.maxUsers);
      await query(
        'INSERT INTO users (username, password_hash, display_name, is_active) VALUES ($1,$2,$3,TRUE)',
        [username.toLowerCase(), hash, seedUser.displayName ?? username],
      );
      inserted += 1;
    }
    console.log(`  seeded: ${username}`);
  }
  const total = await countUsers();
  console.log(`Done. inserted=${inserted} updated=${updated} total=${total}/${config.maxUsers}`);
  if (seedUsers.some((u) => u.password.startsWith('CHANGE_ME'))) {
    console.log('WARNING: some seed passwords start with CHANGE_ME — change them in seed/users.json and re-run the seed before real use.');
  }
  await closePool();
}

main().catch(async (err) => {
  console.error('Seed failed:', (err as Error).message);
  await closePool().catch(() => undefined);
  process.exit(1);
});
