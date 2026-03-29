# ── BLACKLINK v3 — Signaling Server ──
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev && npm cache clean --force

# Copy application files
COPY server.js health.js ./

# Create non-root user for security
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

# Start the application
CMD ["node", "server.js"]
