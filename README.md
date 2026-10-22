# Malik Team Connect — VPS Version (sirf VPS ke liye)

Ye zip **sirf apne VPS pe deploy** karne ke liye hai.
Is me **Railway ki files nahi hain, Android app nahi hai** — koi mix nahi.
Browser wali web app is me shamil hai (APK ki zaroorat nahi).

## ⭐ Is zip ki khaas baat: `.env` TAYYAR hai

Aapke VPS IP **209.74.71.241** ke hisaab se `.env` file is zip me pehle se
bani hui hai — domain wali tamam settings `209.74.71.241.sslip.io` pe set hain
aur saare secrets (JWT, database, LiveKit, TURN) naye generate karke lage hue hain.
**Aapko `.env` edit nahi karni.** Sirf ek kaam baqi hai: `backend/seed/users.json`
me 10 users ke passwords badalna.
⚠️ `.env` ko GitHub pe ya kisi ko **kabhi na bhejein** — is me aapke secrets hain.

## Is zip me kya hai

```
malik-team-connect-vps/
├── README.md            <- ye file
├── VPS_DEPLOY.md        <- POORI GUIDE: pehle ye parhein (10 steps)
├── WEB_APP.md           <- web app (app.<domain>) ki alag chhoti guide
├── docker-compose.yml   <- pura system ek command se: Database + Backend
│                           + Web App + LiveKit (group call) + TURN + HTTPS
├── Caddyfile            <- HTTPS khud banega (api. / livekit. / app. subdomains)
├── livekit.yaml         <- group call server ki setting
├── deploy/
│   ├── vps-setup.sh     <- VPS pe Docker + firewall + secrets khud bana dega
│   └── backup.sh        <- database backup
├── backend/             <- server (login, chat, calls)
│   └── seed/users.json  <- ⚠️ deploy se PEHLE is me CHANGE_ME passwords badlein
└── web-app/             <- browser wali app (chat + audio/video call)
```

## VPS ki zarooratein

- Ubuntu 22.04 / 24.04, kam az kam **2 GB RAM** (4 GB behtar), 2 vCPU
- **Domain ki zaroorat nahi** — aapki IP `209.74.71.241` ke liye free
  `sslip.io` wala naam set hai (`.env` me), isi pe HTTPS certificate banega.
  DNS records bhi nahi lagane. Deploy ke baad address hoga:
  **https://app.209.74.71.241.sslip.io**

## Khulasa (tafseel VPS_DEPLOY.md me)

1. **Passwords badlein:** `backend/seed/users.json` me malik1…malik10 ke
   `CHANGE_ME` passwords strong passwords se badal dein.
2. **Zip VPS pe bhejein,** `deploy/vps-setup.sh` chalayein — Docker, firewall
   aur saare secrets khud ban jayenge.
3. **`.env` pehle se tayyar hai** — kuch edit nahi karna (setup script usay
   khud mehfooz rakhega, secrets dobara nahi badlega).
4. **`docker compose up -d --build`** — pura system chal jayega, phir seed
   command se 10 users banayein (guide step 7).
5. Browser me **https://app.209.74.71.241.sslip.io** kholein — login, chat, call.

## Railway se farq (kyun ye down nahi hoga)

- Ye aapka **apna server** hai — koi shared platform nahi jo so jaye ya band ho.
  Saari services `restart: unless-stopped` pe hain: koi hisa band ho to
  Docker usay **khud dobara chala deta hai**, server restart ho to sab khud wapas a jata hai.
- VPS pe **UDP chalta hai**, is liye TURN server bhi hai — mushkil networks
  pe bhi calls nikalti hain (ye Railway pe mumkin nahi tha).
- Mahana kharcha VPS ka fixed hai, usage wala hisaab nahi.
