# Builder: use Debian-based Node for compatibility
FROM node:20-bullseye-slim AS builder
WORKDIR /app

# Copy package manifests and install deps
COPY package.json package-lock.json* ./
RUN npm ci --silent

# Copy source and build
COPY . .
RUN npm run build

# Runner image
FROM node:20-bullseye-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy production artifacts from builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/db ./db

EXPOSE 3732
CMD ["node", "scripts/docker-entrypoint.mjs"]
