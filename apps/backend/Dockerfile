FROM golang:1.25 AS engine
WORKDIR /src
RUN go mod download github.com/ca-lee-b/towline@v0.0.0-20261119175256-fc116651e67c && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C "$(go env GOMODCACHE)/github.com/ca-lee-b/towline@v0.0.0-20261119175256-fc116651e67c" build -o /out/towline ./cmd/towline

FROM oven/bun:1.3.10 AS bun

FROM node:24-bookworm-slim AS dependencies
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/web/package.json ./apps/web/package.json
ENV HUSKY=0

FROM dependencies AS build
RUN bun install --frozen-lockfile --filter @juno/backend
COPY apps/backend/tsconfig*.json ./apps/backend/
COPY apps/backend/src ./apps/backend/src
RUN bun run --cwd apps/backend build:js

FROM dependencies AS production-dependencies
RUN bun install --frozen-lockfile --production --filter @juno/backend

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/apps/backend ./apps/backend
COPY --from=build --chown=node:node /app/apps/backend/dist ./apps/backend/dist
COPY --chown=node:node apps/backend/migrations ./apps/backend/migrations
WORKDIR /app/apps/backend
USER node
COPY --from=engine /out/towline ./bin/towline
EXPOSE 3000 3010
CMD ["node", "dist/api/main.js"]
