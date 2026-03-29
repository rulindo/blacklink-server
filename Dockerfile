# ── BLACKLINK v3 — Signaling Server ──────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app

# Install production deps only
COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js health.js ./

# Non-root user for security
RUN addgroup -S blacklink && adduser -S blacklink -G blacklink
USER blacklink

EXPOSE 3000 3001

ENV NODE_ENV=production \
    PORT=3000 \
    HTTP_PORT=3001

HEALTHCHECK \
  --interval=30s \
  --timeout=5s \
  --start-period=10s \
  --retries=3 \
  CMD node health.js

CMD ["node", "server.js"]
