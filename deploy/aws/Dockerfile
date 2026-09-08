# syntax=docker/dockerfile:1.7

FROM node:24.20-bookworm-slim AS build

WORKDIR /app
RUN npm install --global pnpm@11.5.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/market-core/package.json packages/market-core/package.json
COPY packages/recorder-replay/package.json packages/recorder-replay/package.json
COPY packages/signal-engine/package.json packages/signal-engine/package.json
COPY packages/source-preflight/package.json packages/source-preflight/package.json
COPY packages/strategy-engine/package.json packages/strategy-engine/package.json
RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
RUN pnpm build

FROM node:24.20-bookworm-slim AS side-server

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    INIT_CWD=/app
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3001
CMD ["node", "apps/server/dist/src/main.js"]

FROM caddy:2.11.4-alpine AS side-web

RUN setcap -r /usr/bin/caddy \
    && addgroup -S -g 10001 sideweb \
    && adduser -S -D -H -u 10001 -G sideweb sideweb
COPY deploy/aws/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
USER sideweb
EXPOSE 8080
