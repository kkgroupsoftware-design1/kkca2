# Malik Team Connect backend — multi-stage build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY seed ./seed
# scripts/ is only needed by Railway (scripts/railway-start.sh is the Railway
# start command — see backend/railway.json). Harmless for the VPS image:
# the default CMD below does not use it.
COPY scripts ./scripts
RUN mkdir -p uploads && addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
