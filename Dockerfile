# ── BLACKLINK v3 — Production Signaling Server ──
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# ──────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY server.js health.js ./

# Create non-root user
RUN addgroup -S blacklink && \
    adduser -S blacklink -G blacklink && \
    chown -R blacklink:blacklink /app

# Switch to non-root user
USER blacklink

# Expose port
EXPOSE 3000

# Environment variables
ENV NODE_ENV=production \
    PORT=3000

# Health check
HEALTHCHECK --interval=30s \
            --timeout=5s \
            --start-period=10s \
            --retries=3 \
            CMD node health.js

# Start with dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
