#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Malik Team Connect — backup: PostgreSQL dump + uploads archive.
# Run from the project folder on the VPS (stack must be running):
#     ./deploy/backup.sh
# Output: backups/mtc-backup-<timestamp>/  (db.sql.gz, uploads.tar.gz, MANIFEST.txt)
# Suggested cron (daily 03:30):  30 3 * * *  cd /path/to/malik-team-connect && ./deploy/backup.sh >> backups/backup.log 2>&1
# Copy backups OFF the VPS regularly (laptop / cloud storage) — a backup that
# lives only on the same server is not a real backup.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# Load POSTGRES_* from .env (defaults match docker-compose.yml)
set -a; [ -f .env ] && . ./.env; set +a
PGUSER="${POSTGRES_USER:-malik}"
PGDB="${POSTGRES_DB:-malik_team_connect}"

TS="$(date +%Y%m%d-%H%M%S)"
OUT="backups/mtc-backup-${TS}"
mkdir -p "$OUT"

echo "==> Dumping PostgreSQL (${PGDB})"
docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$PGDB" | gzip > "${OUT}/db.sql.gz"

echo "==> Archiving uploads (Docker volume)"
# Read the uploads volume through a throwaway container so host paths don't matter.
docker run --rm -v malik-team-connect_uploads:/data:ro -v "$PROJECT_DIR/$OUT":/out alpine \
  tar czf /out/uploads.tar.gz -C /data . 2>/dev/null || \
  docker run --rm -v "$(basename "$PROJECT_DIR")_uploads":/data:ro -v "$PROJECT_DIR/$OUT":/out alpine \
  tar czf /out/uploads.tar.gz -C /data .

{
  echo "Malik Team Connect backup"
  echo "created: $(date -Is)"
  echo "host: $(hostname)"
  echo "files:"
  ls -lah "$OUT"
  echo ""
  echo "Restore DB:      gunzip -c db.sql.gz | docker compose exec -T postgres psql -U ${PGUSER} -d ${PGDB}"
  echo "Restore uploads: extract uploads.tar.gz into the 'uploads' Docker volume, then restart the backend."
} > "${OUT}/MANIFEST.txt"

echo "==> Done: $OUT"
ls -lah "$OUT"

# Keep the newest 14 backups, delete older ones.
ls -dt backups/mtc-backup-* 2>/dev/null | tail -n +15 | xargs -r rm -rf
echo "==> Old backups pruned (kept newest 14)"
