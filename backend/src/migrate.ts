import fs from 'fs';
import path from 'path';
import { getPool, closePool } from './db';

/** Tiny migration runner: applies migrations/*.sql in filename order, once each. */
export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  // Works from src/ (tsx), dist/src/ (compiled local) and dist/ layouts.
  const candidates = [
    path.resolve(__dirname, '..', 'migrations'),
    path.resolve(__dirname, '..', '..', 'migrations'),
    path.resolve(process.cwd(), 'migrations'),
  ];
  const dir = candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (rows.length) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    applied.push(file);
  }
  return applied;
}

if (require.main === module) {
  runMigrations()
    .then(async (applied) => {
      console.log(applied.length ? `Migrations applied: ${applied.join(', ')}` : 'Migrations up to date');
      await closePool();
    })
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
