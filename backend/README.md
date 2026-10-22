# Malik Team Connect — Backend

Private backend for exactly **10 authorized users**: auth, team directory,
1-to-1 + group messaging, 1-to-1 WebRTC call signalling, LiveKit group-call
tokens, FCM push, file uploads. No public registration, no admin website.

Stack: Node.js + TypeScript, Express, Socket.IO, PostgreSQL (`pg`), bcryptjs,
jsonwebtoken, express-rate-limit, helmet, zod, multer, livekit-server-sdk,
firebase-admin (optional/lazy).

## API overview

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | rate-limited 10/15 min/IP; generic error on failure |
| POST | `/api/auth/logout` | revokes the session `jti` server-side |
| GET / PATCH | `/api/auth/me` | current user / profile update |
| GET | `/api/users` | team directory (active only, with online status) |
| GET / PATCH | `/api/users/me/profile` | profile |
| GET / POST | `/api/conversations` | direct (deduped) + group (3+), authorized members only |
| GET / POST | `/api/conversations/:id/messages` | member-only, paginated (`limit`, `offset`, `before`) |
| POST | `/api/conversations/:id/read` | read receipts + unread counters |
| POST | `/api/upload` | multipart field `file`, 25 MB max, allow-listed types → `{ url, name }` |
| GET | `/api/files/:name` | authenticated download |
| POST | `/api/calls/invite` | creates call, emits `call:incoming`, FCM wake-up |
| POST | `/api/calls/:id/accept\|reject\|cancel\|end` | participants only; reject/cancel while ringing ⇒ `missed` |
| GET | `/api/calls/history` | my calls |
| GET | `/api/calls/config` (alias `/api/config/calls`) | STUN/TURN ICE servers + LiveKit URL |
| POST | `/api/livekit/token` | 1-hour token; 503 with a clear message if LiveKit is not configured (never a fake token) |
| POST / DELETE | `/api/devices/fcm-token` | register / unregister push token |
| ANY | `/api/auth/register` | **404 — registration is disabled by design** |

Socket.IO events are documented at the top of `src/socket.ts`
(`message:send`, `message:typing`, `call:signal`, `call:invite/accept/reject/cancel/end`,
server events `message:new`, `presence:update`, `call:incoming`, …).

Responses use camelCase field names (Android DTOs) with snake_case aliases.

## Run locally (development)

Requirements: Node.js 20+, PostgreSQL 13+ running locally.

```bash
cd backend
cp .env.example .env          # set DATABASE_URL, JWT_SECRET (openssl rand -hex 32)
npm install
npm run migrate               # create tables
cp seed/users.example.json seed/users.json   # then edit REAL passwords in seed/users.json
npm run seed                  # create the 10 accounts (bcrypt cost 12)
npm run seed:check            # → Users in database: 10 / max 10
npm run dev                   # http://localhost:4000  (GET /health to check)
```

Local Docker alternative (database only):

```bash
docker run -d --name mtc-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=malik_team_connect -p 5432:5432 postgres:16-alpine
```

## Run on a VPS (production)

The full stack (Postgres + backend + LiveKit + coturn + Caddy HTTPS) lives in
the project-root `docker-compose.yml`. Follow the numbered guide:
**`../docs/VPS_DEPLOY.md`**. One-time server prep: `../deploy/vps-setup.sh`,
backups: `../deploy/backup.sh`.

## Tests

```bash
npm test        # unit (hashing, JWT, 10-user cap) + integration (pg-mem:
                # real migration SQL + login → /me → logout-revoke flow)
npm run build   # tsc — must be clean
```

## Configuration

Every variable is documented in `.env.example`. Key points:

- `JWT_SECRET` — required in production (server refuses to start without it).
- `MAX_USERS=10` — enforced in the seed (`src/users-cap.ts`) and everywhere accounts are created.
- LiveKit / FCM are optional at the API level: without LiveKit keys the token
  endpoint returns 503; without a Firebase service-account file, push sends
  are logged no-ops. Nothing is ever faked.
- TURN credentials in `.env` are returned to authenticated clients by
  `/api/calls/config` (this is how WebRTC works); rotate them if a device is lost.

## Security notes

- Passwords: bcrypt cost 12, hashes only, never printed or returned by any endpoint.
- Sessions: JWT with `jti` + `token_version`; logout revokes the `jti`;
  deactivating a user (`is_active=false`) or bumping `token_version` kills sessions.
- All conversation/call/file access is checked server-side per request.
- No end-to-end encryption is claimed — transport is HTTPS/WSS, media is
  DTLS-SRTP via WebRTC/LiveKit, messages are stored server-side in Postgres.

## Layout

```
src/            config, db, auth-utils, app, server, socket, fcm, presence
src/routes/     auth, users, conversations, calls (+livekit), devices, files
src/services/   users, conversations, calls (state machine)
src/middleware/ auth (JWT+revocation+version), error
migrations/     001_init.sql
scripts/seed.ts secure provisioning of the 10 accounts
seed/           users.example.json (+ gitignored users.json with real passwords)
tests/          node:test unit + pg-mem integration
```
