# Malik Team Connect — Web App (Browser Client)

Chat and calls for the same private 10-user team, straight from a browser —
no APK or install needed. It talks to the **same backend** as the Android app
(same accounts, same conversations, same call history).

## What it does

- Login (username/password → backend JWT in `localStorage`). **No registration UI — ever.**
- Sidebar: team directory with live online dots (Socket.IO presence) + conversations with unread badges.
- Chat: text, photo/document attachments, voice messages (MediaRecorder), typing indicator, delivery/read ticks, group chats with member labels.
- 1-to-1 audio/video calls: browser WebRTC, signalling over the backend Socket.IO contract, ICE servers from the backend, ICE-restart reconnection, call history with call-back.
- Group calls: LiveKit (`livekit-client`) with a backend-minted token; a clear error is shown if the server has no LiveKit configured (HTTP 503).
- Incoming calls ring in any open tab, plus a browser Notification when the tab is hidden and permission was granted. **The browser must be open — Web Push is not included.**

## Configuration (read this)

Runtime config wins over build-time config:

1. **`/config.js`** — served next to the app, loaded before the app code, sets
   `window.__MTC_CONFIG__ = { apiUrl, livekitUrl }`. See `public/config.js`.
   On the VPS the Docker container **generates** this file at startup from
   the `API_URL` / `LIVEKIT_URL` environment variables (see `Dockerfile` +
   `entrypoint.sh`), so one image works for every domain. For a manual
   static deployment, use `public/config.production.js.example`.
2. **Build-time fallback** — `VITE_API_URL` / `VITE_LIVEKIT_URL` (see
   `.env.example`), mainly for `npm run dev` against a local backend.
3. **Default** — same-origin API (`""`) and a best-effort LiveKit URL derived
   from the page host (local development only).

VPS deployment: `../docs/WEB_APP.md`.

## Develop

```bash
npm install
cp .env.example .env   # local backend on http://localhost:4000
npm run dev            # http://localhost:5173
npm test               # vitest unit tests (helpers: duration, ticks, titles)
npm run build          # tsc --noEmit + vite build → dist/
```

## Layout

```
src/
  config.ts       runtime config resolution (config.js > Vite env > default)
  api.ts          REST client + authenticated file downloads (blob URLs)
  socket.ts       Socket.IO wrapper (JWT handshake, typed events)
  callManager.ts  1-to-1 WebRTC engine (offer/ICE buffering, ICE restart, ringtone)
  components/     Login, ChatView, CallPanel, GroupCall (LiveKit), HistoryPanel
  App.tsx         shell: sidebar (team + conversations), views, group creation
public/
  config.js / config.production.js.example / config.template.js (container)
Dockerfile        node build → nginx serve, entrypoint writes /config.js
```
