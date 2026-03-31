FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --ignore-scripts

COPY apps/server apps/server
COPY packages/shared packages/shared

RUN npm run build --workspace @snake-duel/shared \
  && npm run build --workspace @snake-duel/server

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/apps/server/dist apps/server/dist
COPY --from=builder /app/packages/shared/dist packages/shared/dist

EXPOSE 2567

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:2567/health || exit 1

CMD ["node", "apps/server/dist/index.js"]
