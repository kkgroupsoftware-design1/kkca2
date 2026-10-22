import http from 'http';
import fs from 'fs';
import { createApp } from './app';
import { attachSocket } from './socket';
import { runMigrations } from './migrate';
import { config } from './config';

async function main(): Promise<void> {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  // Auto-migrate on boot keeps VPS/Docker deploys one-step (`npm run migrate` also works).
  try {
    const applied = await runMigrations();
    if (applied.length) console.log(`[db] migrations applied: ${applied.join(', ')}`);
  } catch (err) {
    console.error('[db] migration on boot failed — is Postgres reachable?', err);
    if (process.env.SKIP_MIGRATE_ON_BOOT !== 'true') process.exit(1);
  }
  const app = createApp();
  const server = http.createServer(app);
  attachSocket(server);
  server.listen(config.port, () => {
    console.log(`[server] Malik Team Connect backend listening on :${config.port} (${config.nodeEnv})`);
    console.log(`[server] LiveKit configured: ${config.livekit.configured}`);
  });
}

void main();
