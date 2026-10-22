#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Malik Team Connect — one-time VPS setup (Ubuntu 22.04 / 24.04)
# Run as root or with sudo, FROM the project folder on the VPS:
#     chmod +x deploy/vps-setup.sh && sudo ./deploy/vps-setup.sh
# It installs Docker, opens the firewall ports, creates folders, prepares .env.
# It does NOT start the stack — follow the printed next steps (docs/VPS_DEPLOY.md).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

echo "==> 1/5  System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw openssl

echo "==> 2/5  Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
docker --version
docker compose version

echo "==> 3/5  Firewall (ufw)"
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP (Caddy / Lets Encrypt)'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 443/udp comment 'HTTPS HTTP/3'
ufw allow 3478/udp comment 'coturn STUN/TURN'
ufw allow 3478/tcp comment 'coturn STUN/TURN tcp'
ufw allow 5349/tcp comment 'coturn TURNS tls'
ufw allow 7881/tcp comment 'LiveKit RTC TCP'
ufw allow 7882/udp comment 'LiveKit RTC UDP'
ufw allow 50000:60000/udp comment 'LiveKit media range'
ufw allow 60001:65000/udp comment 'coturn relay range'
ufw --force enable
ufw status | head -30

echo "==> 4/5  Folders"
mkdir -p backups deploy
# Docker volumes hold postgres data, uploads and Caddy certs; ./backups is for deploy/backup.sh output.

echo "==> 5/5  Environment file (.env at project root)"
if [ ! -f .env ]; then
  cp backend/.env.example .env
  echo "    Created .env from backend/.env.example — secrets were auto-generated below."
  # Fill the CHANGE_ME placeholders with fresh random secrets (idempotent: only replaces placeholders).
  JWT="$(openssl rand -hex 32)"
  PGPW="$(openssl rand -hex 24)"
  LKSEC="$(openssl rand -hex 32)"
  TURNPW="$(openssl rand -hex 24)"
  sed -i "s|JWT_SECRET=CHANGE_ME.*|JWT_SECRET=${JWT}|" .env
  sed -i "s|POSTGRES_PASSWORD=CHANGE_ME.*|POSTGRES_PASSWORD=${PGPW}|" .env
  sed -i "s|LIVEKIT_API_SECRET=CHANGE_ME.*|LIVEKIT_API_SECRET=${LKSEC}|" .env
  sed -i "s|TURN_CREDENTIAL=CHANGE_ME.*|TURN_CREDENTIAL=${TURNPW}|" .env
  echo "    Generated: JWT_SECRET, POSTGRES_PASSWORD, LIVEKIT_API_SECRET, TURN_CREDENTIAL"
else
  echo "    .env already exists — leaving it untouched."
fi

cat <<'NEXT'

─────────────────────────────────────────────────────────────────────────────
SETUP DONE. Next steps:
  1. Edit .env and set: DOMAIN, TURN_DOMAIN, TURN_REALM (your real domain),
     and check CORS_ORIGINS / STUN_URLS / TURN_URLS match that domain.
  2. Point DNS A records to this VPS:  api.<DOMAIN>  livekit.<DOMAIN>  turn.<DOMAIN>
  3. Edit backend/seed/users.json — set the REAL passwords for malik1..malik10.
  4. Start everything:        docker compose up -d --build
  5. Create the 10 accounts:  docker compose exec backend npm run seed:prod
  6. Check:                   curl https://api.<DOMAIN>/health
Full guide: docs/VPS_DEPLOY.md
─────────────────────────────────────────────────────────────────────────────
NEXT
