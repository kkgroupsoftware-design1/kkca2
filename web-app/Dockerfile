# Malik Team Connect — web app image
# Stage 1 builds the Vite/React app; stage 2 serves it with nginx and
# generates /config.js from the API_URL / LIVEKIT_URL env vars at startup
# (see entrypoint.sh), so ONE image works for any domain.

# ── Build ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build-time fallbacks only — runtime config.js wins when present.
ARG VITE_API_URL=""
ARG VITE_LIVEKIT_URL=""
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_LIVEKIT_URL=$VITE_LIVEKIT_URL
RUN npm run build

# ── Serve ──────────────────────────────────────────────────────────────────
FROM nginx:alpine
# The server block is a TEMPLATE: entrypoint.sh renders it to
# /etc/nginx/conf.d/default.conf at startup with this platform's port —
# 80 on the VPS (docker-compose), Railway's injected $PORT on Railway.
# (nginx.conf stays in the repo as the port-80 reference copy.)
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
