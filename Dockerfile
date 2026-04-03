# syntax=docker/dockerfile:1

FROM node:23-slim AS base

RUN apt-get update && apt-get install -y \
  python3 make g++ git curl unzip \
  && rm -rf /var/lib/apt/lists/*

# Disable telemetry
ENV ELIZAOS_TELEMETRY_DISABLED=true
ENV DO_NOT_TRACK=1

WORKDIR /app

# Install bun
RUN npm install -g bun

# Copy package manifest and lockfile, install dependencies
COPY package.json bun.lock* ./
RUN bun install

# Copy all source files
COPY . .

# Compile TypeScript — produces dist/src/index.js (entry point for elizaos loadProject)
RUN bun run build

# Create data directory for SQLite volume mount
RUN mkdir -p /app/data

EXPOSE 3000

# Health check — triggers restart if port 3000 is unresponsive for 30s
HEALTHCHECK --interval=30s --timeout=30s --retries=3 --start-period=60s \
  CMD curl -f http://localhost:3000 || exit 1

ENV NODE_ENV=production
ENV SERVER_PORT=3000

CMD ["bun", "start"]
