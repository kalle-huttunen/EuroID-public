# EuroID Backend API — multi-stage production build
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install

FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json tsconfig.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
# Migrations run from dist/ (compiled by nest build); the .ts files give migrate-mongo the names
# migration_changelog holds (scripts/load-compiled-migrations.js)
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/migrate-mongo-config.ts ./
COPY --from=builder /app/scripts/load-compiled-migrations.js ./scripts/
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
  CMD curl -sf http://localhost:3001/api/v1/health || exit 1
CMD ["sh", "-c", "npm run --silent migrate:up:dist && node -r tsconfig-paths/register dist/src/main.js"]
