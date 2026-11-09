FROM oven/bun:1.3.10 AS bun

FROM node:24-bookworm-slim AS dependencies
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./

FROM dependencies AS build
RUN bun install --frozen-lockfile
COPY tsconfig*.json ./
COPY src ./src
RUN bun run build

FROM dependencies AS production-dependencies
RUN bun install --frozen-lockfile --production

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/api/main.js"]
