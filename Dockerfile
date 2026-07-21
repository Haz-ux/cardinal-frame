# ── Stage 1: Build client (Vite) ──────────────────────────────────────
FROM node:22-slim AS client-builder

WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ── Stage 2: Build server deps (compile better-sqlite3 native addon) ──
FROM node:22-slim AS server-builder

# Build tools ONLY in this stage — never carried to runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 3: Production runtime (no build tools) ───────────────────────
FROM node:22-slim

# Install dumb-init for proper signal handling + tini alternative
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get clean

WORKDIR /app

# Copy compiled node_modules from builder stage (includes native .node addons)
COPY --from=server-builder /app/node_modules ./node_modules

# Copy package.json for `npm start` script resolution
COPY package.json ./

# Copy server source
COPY src/ ./src/

# Copy built client from stage 1
COPY --from=client-builder /app/client/dist ./client/dist

# Data directory for SQLite (WAL mode persists across restarts)
RUN mkdir -p /app/data
VOLUME /app/data

# Non-root user for security
RUN groupadd -r cardinal && useradd -r -g cardinal -d /app -s /sbin/nologin cardinal
RUN chown -R cardinal:cardinal /app
USER cardinal

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data

EXPOSE 8080

# dumb-init handles SIGTERM/SIGINT properly for graceful SQLite shutdown
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server/server.mjs"]
