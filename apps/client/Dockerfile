FROM node:22-alpine AS builder

WORKDIR /app

ARG VITE_COLYSEUS_URL=ws://localhost:2567
ENV VITE_COLYSEUS_URL=${VITE_COLYSEUS_URL}

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps/client/package.json apps/client/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --ignore-scripts

COPY apps/client apps/client
COPY packages/shared packages/shared

RUN npm run build --workspace @snake-duel/shared \
  && npm run build --workspace @snake-duel/client

FROM nginx:1.27-alpine AS runner

COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/client/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
