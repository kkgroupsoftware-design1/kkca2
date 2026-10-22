#!/bin/sh
# Malik Team Connect — web container entrypoint.
#
# Two jobs at container start, then nginx in the foreground:
#   1. Render the nginx server block from nginx.conf.template, substituting
#      ONLY ${PORT}. VPS/docker-compose does not set PORT -> default 80
#      (same behaviour as before). Railway injects PORT -> nginx listens
#      on Railway's port.
#   2. Generate the runtime config (/config.js) from API_URL / LIVEKIT_URL.
#      This is what lets one Docker image work for any domain:
#      docker-compose passes https://api.<DOMAIN> etc., Railway passes
#      https://<service>.up.railway.app domains the same way.
set -e

# ── 1. nginx server block for this platform's port ──────────────────────
PORT_VALUE="${PORT:-80}"
NGINX_TEMPLATE=/etc/nginx/nginx.conf.template
NGINX_CONF=/etc/nginx/conf.d/default.conf

if [ -f "$NGINX_TEMPLATE" ]; then
  if command -v envsubst >/dev/null 2>&1; then
    # Substitute ONLY ${PORT}; every other $variable in the template is an
    # nginx variable and must survive untouched.
    PORT="$PORT_VALUE" envsubst '${PORT}' < "$NGINX_TEMPLATE" > "$NGINX_CONF"
  else
    # Fallback for images without envsubst: the template's only ${...}
    # token is ${PORT} (all nginx variables are written braceless).
    sed "s|\${PORT}|${PORT_VALUE}|g" "$NGINX_TEMPLATE" > "$NGINX_CONF"
  fi
  echo "[web] nginx listening on port ${PORT_VALUE}"
fi

# ── 2. Runtime app config (/config.js) ──────────────────────────────────
TEMPLATE=/usr/share/nginx/html/config.template.js
TARGET=/usr/share/nginx/html/config.js

# Escape sed special characters in the values (| is the delimiter).
esc() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }

API_URL_ESC=$(esc "${API_URL:-}")
LIVEKIT_URL_ESC=$(esc "${LIVEKIT_URL:-}")

if [ -f "$TEMPLATE" ]; then
  sed -e "s|__API_URL__|${API_URL_ESC}|g" \
      -e "s|__LIVEKIT_URL__|${LIVEKIT_URL_ESC}|g" \
      "$TEMPLATE" > "$TARGET"
fi

exec nginx -g 'daemon off;'
