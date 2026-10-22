# Malik Team Connect — Web App (Browser) Deployment

The web app lets the same 10 team members chat and call **from a browser** —
no Android APK, no app install. It uses the **same backend, same database,
same accounts** (`malik1` … `malik10`) as the Android app. Deploy the backend
first (see `VPS_DEPLOY.md`), then follow these steps.

Simple rule: the whole system only works over **HTTPS**. Browsers refuse
microphone/camera access on plain HTTP, so the domain + Caddy HTTPS setup in
`VPS_DEPLOY.md` is required, not optional.

---

## Step 1 — Add ONE extra DNS record

At your domain provider, add this A record (same VPS IP as the others):

| Type | Name  | Value   |
|------|-------|---------|
| A    | `app` | VPS IP  |

Your full record set is now:

- `api.<your-domain>` → VPS IP (backend)
- `livekit.<your-domain>` → VPS IP (group calls)
- `turn.<your-domain>` → VPS IP (TURN)
- `app.<your-domain>` → VPS IP (**new — the web app**)
- `<your-domain>` (apex/@) → VPS IP (optional: it simply redirects to `app.` — if you skip this record, delete the `{$DOMAIN}` block at the top of `Caddyfile`)

Wait a few minutes for DNS to spread. Check: `ping app.<your-domain>` shows your VPS IP.

## Step 2 — Make sure CORS allows the web app

On the VPS, open the project-root `.env` and check this line contains your
real domain (the example in `backend/.env.example` already shows the shape):

```
CORS_ORIGINS=https://app.<your-domain>,https://<your-domain>,https://api.<your-domain>
```

Without this, the browser will block the web app's requests and login will fail.

## Step 3 — Rebuild and restart the stack

On the VPS, in the project folder:

```bash
docker compose up -d --build
docker compose ps        # web, backend, postgres, livekit, coturn, caddy all "Up"
docker compose logs web --tail 20     # should show nginx starting, no errors
```

The new `web` container serves the app. At startup it writes its own
`/config.js` from the `API_URL` / `LIVEKIT_URL` values in `docker-compose.yml`
(which are built from your `DOMAIN`), so the app automatically points at
`https://api.<your-domain>` and `wss://livekit.<your-domain>`. Nothing to edit.

## Step 4 — Open the app and sign in

1. Open **https://app.<your-domain>** in Chrome (recommended).
2. Sign in with the **same accounts** as the Android app — e.g. `malik1` and
   the password you set in `backend/seed/users.json` before seeding.
   There is no sign-up, by design.
3. The browser asks **"Allow notifications?"** — allow it. This is how an
   incoming call can pop up when the tab is in the background.
4. When you start or answer a call, the browser asks for **microphone /
   camera permission** — allow it. If you blocked it earlier: click the 🔒
   icon in the address bar → Site settings → set Microphone/Camera to Allow.

## Step 5 — Test it properly

- [ ] Team list on the left shows all members; open a second browser/profile,
      sign in as another user, and watch the green **online dot** appear.
- [ ] Send a text message both ways; send a photo, a document, and a voice
      message (🎤 button, tap again to stop and send).
- [ ] Check the ticks on your messages: ✓ sent, ✓✓ delivered, green ✓✓ read.
- [ ] Audio call and video call between two users — try one on Wi-Fi and one
      on mobile data. Mute, camera on/off, End — all should work.
- [ ] Create a group (👥 New group, pick 2+ members), then **Start Group Call**
      inside it: the other members get a ringing invitation with a **Join**
      button. Max 10 participants (that is the whole team).
- [ ] Open **🕘 History** — missed/ended calls are listed with call-back buttons.

## How calls work in the browser (good to know)

- **1-to-1 calls** are direct browser-to-browser WebRTC. The server only
  passes the invitation and the connection signals; your own coturn TURN
  server (already in the stack) helps when the two users are on different
  networks. If a connection drops mid-call, the app shows "Reconnecting…"
  and tries an ICE restart automatically.
- **Group calls** run through your LiveKit server. The backend checks your
  login and gives the browser a 1-hour room token. If LiveKit is not
  configured on the server, the app shows the server's clear error message
  instead of pretending to connect.
- **Speaker choice:** browsers cannot force a phone's loudspeaker like a
  native app. In Chrome/Edge on desktop, if more than one audio output
  exists, a 🔊 "Audio output" picker appears during the call. On phones,
  use the system volume/Bluetooth controls.

## Limitations (honest list)

- **The browser tab must be open for calls to ring.** If the browser is
  fully closed, there is no ringing and no missed-call push. This app does
  **not** include Web Push (push-to-closed-browser) — the design is: keep a
  tab open/pinned on desktop, or keep the browser open on the phone.
  A call that nobody answers is still recorded in History.
- An incoming call shows a ringing screen in the tab, and a browser
  notification if the tab is in the background and notifications were allowed.
- **iPhone / iOS Safari:** calls generally work, but Safari is stricter —
  the tab must be in the foreground for ringing, notifications for web apps
  require iOS 16.4+ and "Add to Home Screen", and background behaviour is
  limited. Chrome on Android/desktop gives the best experience.
- HTTPS is mandatory for mic/camera — if you open the site by IP or HTTP,
  calls will fail with a permission error.
- No end-to-end encryption is claimed (same note as the rest of the project):
  transport is HTTPS/WSS, media is standard WebRTC/LiveKit encryption in transit.

## Troubleshooting

| Problem | Fix |
|---|---|
| Login spins/fails, console shows CORS errors | Step 2: `CORS_ORIGINS` must include `https://app.<your-domain>` exactly; restart backend (`docker compose restart backend`) |
| Page loads but everything is offline/empty | Open `https://app.<your-domain>/config.js` — it must show your real `api.` / `livekit.` URLs. If it shows empty strings, the `web` container env is wrong: check `DOMAIN` in root `.env`, then `docker compose up -d --build web` |
| "Cannot reach the server" | Check `https://api.<your-domain>/health` in the browser; if that fails, the backend/Caddy issue is in `VPS_DEPLOY.md` troubleshooting |
| No mic/camera in a call | Allow permissions (Step 4.4); confirm you are on the `https://` address, in Chrome |
| Group call says "LiveKit is not configured on the server" | Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in root `.env`, restart backend + livekit |
| Web app shows an old version after an update | Hard refresh (Ctrl+Shift+R). `/config.js` is served no-cache, build assets are content-hashed |

## Local development (optional, on your own PC)

```bash
cd web-app
cp .env.example .env     # points at http://localhost:4000 (local backend)
npm install
npm run dev              # http://localhost:5173
npm test                 # unit tests
npm run build            # production build into dist/
```
