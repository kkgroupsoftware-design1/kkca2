import fs from 'fs';
import path from 'path';

/**
 * Lazy Firebase Admin init.
 * - If FIREBASE_SERVICE_ACCOUNT_PATH is unset or the file does not exist,
 *   FCM is DISABLED: every send is a logged no-op and nothing crashes.
 * - firebase-admin is required lazily so a broken/absent config can never
 *   take down the API server.
 */

interface FirebaseApp {
  messaging: () => {
    sendEachForMulticast: (msg: unknown) => Promise<unknown>;
  };
}

let app: FirebaseApp | null = null;
let attempted = false;

export function fcmConfigured(): boolean {
  return getApp() !== null;
}

function getApp(): FirebaseApp | null {
  if (app) return app;
  if (attempted) return null;
  attempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('./config') as typeof import('./config');
    const servicePath = config.firebaseServiceAccountPath;
    if (!servicePath) {
      console.log('[fcm] FIREBASE_SERVICE_ACCOUNT_PATH not set — push notifications disabled (no-op)');
      return null;
    }
    const resolved = path.resolve(process.cwd(), servicePath);
    if (!fs.existsSync(resolved)) {
      console.warn(`[fcm] Service account file not found at ${resolved} — push notifications disabled (no-op)`);
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const admin = require('firebase-admin');
    const serviceAccount = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const created = admin.apps?.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    app = created as FirebaseApp;
    console.log('[fcm] Firebase Admin initialized');
    return app;
  } catch (err) {
    console.warn('[fcm] Failed to initialize Firebase Admin — push disabled:', (err as Error).message);
    return null;
  }
}

async function tokensForUser(userId: string): Promise<string[]> {
  const { query } = await import('./db');
  const { rows } = await query<{ fcm_token: string }>('SELECT fcm_token FROM devices WHERE user_id = $1', [userId]);
  return rows.map((r) => r.fcm_token).filter(Boolean);
}

/**
 * Send a data-only payload (call invites / new messages) to all of a user's
 * devices. Data-only so the Android app controls the full-screen call UI.
 * No-op (with a log line) when FCM is not configured or the user has no tokens.
 */
export async function sendToUser(
  userId: string,
  data: Record<string, string>,
  opts: { title?: string; body?: string } = {},
): Promise<void> {
  const firebase = getApp();
  if (!firebase) {
    console.log(`[fcm] (disabled) would send to user ${userId}:`, data.type ?? 'data');
    return;
  }
  try {
    const tokens = await tokensForUser(userId);
    if (!tokens.length) return;
    await firebase.messaging().sendEachForMulticast({
      tokens,
      data,
      ...(opts.title ? { notification: { title: opts.title, body: opts.body ?? '' } } : {}),
      android: { priority: 'high' as const },
    });
  } catch (err) {
    console.warn('[fcm] send failed:', (err as Error).message);
  }
}

export async function sendToUsers(userIds: string[], data: Record<string, string>): Promise<void> {
  await Promise.all(userIds.map((id) => sendToUser(id, data)));
}
