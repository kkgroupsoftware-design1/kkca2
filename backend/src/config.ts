import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function listEnv(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const jwtSecret = process.env.JWT_SECRET || '';
if (!jwtSecret && process.env.NODE_ENV === 'production') {
  // Fail fast in production rather than signing tokens with a known secret.
  throw new Error('JWT_SECRET must be set in production');
}
if (!jwtSecret) {
  // eslint-disable-next-line no-console
  console.warn('[config] JWT_SECRET is not set — using an insecure development fallback. Set it in .env.');
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: intEnv('PORT', 4000),
  corsOrigins: listEnv('CORS_ORIGINS', ['http://localhost:3000']),

  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/malik_team_connect',
  databaseSsl: (process.env.DATABASE_SSL || 'false').toLowerCase() === 'true',

  jwtSecret: jwtSecret || 'dev-only-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  /** Hard product rule: exactly 10 authorized accounts, never more. */
  maxUsers: intEnv('MAX_USERS', 10),

  uploadDir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads'),
  maxUploadBytes: intEnv('MAX_UPLOAD_BYTES', 25 * 1024 * 1024),

  livekit: {
    url: process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
    get configured(): boolean {
      return Boolean(this.url && this.apiKey && this.apiSecret);
    },
  },

  domain: process.env.DOMAIN || '',
  turnDomain: process.env.TURN_DOMAIN || '',

  ice: {
    stunUrls: listEnv('STUN_URLS', ['stun:stun.l.google.com:19302']),
    // If TURN_URLS is not set but TURN_DOMAIN is, derive standard coturn URLs.
    turnUrls: listEnv(
      'TURN_URLS',
      process.env.TURN_DOMAIN
        ? [
            `turn:${process.env.TURN_DOMAIN}:3478?transport=udp`,
            `turn:${process.env.TURN_DOMAIN}:3478?transport=tcp`,
            // turns:5349 is only included when explicitly listed in TURN_URLS —
            // it needs a TLS cert for coturn (see docs/VPS_DEPLOY.md § optional TURNS).
          ]
        : [],
    ),
    turnUsername: process.env.TURN_USERNAME || '',
    turnCredential: process.env.TURN_CREDENTIAL || '',
  },

  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
  seedUsersJson: process.env.SEED_USERS_JSON || '',
  usersFile: process.env.USERS_FILE || '',
} as const;

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** ICE servers handed to authenticated clients via GET /api/calls/config. */
export function iceServers(): IceServer[] {
  const servers: IceServer[] = [];
  if (config.ice.stunUrls.length) servers.push({ urls: config.ice.stunUrls });
  if (config.ice.turnUrls.length) {
    const turn: IceServer = { urls: config.ice.turnUrls };
    if (config.ice.turnUsername) turn.username = config.ice.turnUsername;
    if (config.ice.turnCredential) turn.credential = config.ice.turnCredential;
    servers.push(turn);
  }
  return servers;
}
