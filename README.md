# Snake Duel Arena

Monorepo TypeScript pour Snake Duel en local et en ligne (serveur autoritaire Colyseus), avec logique de jeu partagée.

## Stack

- `apps/client`: Vite + React + Phaser + Tailwind + Framer Motion + Zustand
- `apps/server`: Node.js + Colyseus + @colyseus/schema
- `packages/shared`: moteur pur grille/tick/collisions + types communs + tests Vitest

## Prérequis

- Node.js `>= 20.19.0`
- npm `>= 10`

## Installation

```bash
npm install
```

## Lancer en développement

```bash
npm run dev
```

- Client: `http://localhost:5173`
- Serveur: `ws://localhost:2567`
- Health: `http://localhost:2567/health`

Option client:

```bash
# apps/client/.env
VITE_COLYSEUS_URL=ws://localhost:2567
```

## Qualité

```bash
npm run typecheck
npm run test
npm run build
npm run qa:smoke
npm run health:public
```

Validation complète pré-prod:

```bash
npm run prod:check
```

Validation complète avec smoke UI multi-device:

```bash
npm run prod:check:full
```

## Variables d'environnement

Client:

- `VITE_COLYSEUS_URL` (ex: `ws://localhost:2567`)
- Exemple: `apps/client/.env.example`

Serveur:

- `HOST` (défaut: `0.0.0.0`)
- `PORT` (défaut: `2567`)
- Exemple: `apps/server/.env.example`

## Déploiement production (Docker)

Par défaut, la stack Docker est alignée avec le tunnel public actuel:

- client servi sur `http://127.0.0.1:5173`
- serveur WS/API servi sur `ws://127.0.0.1:2567`
- build client pointant vers `wss://apisnake.raphcvr.me`

Configuration optionnelle:

```bash
cp .env.prod.example .env.prod
```

Variables utiles:

- `CLIENT_HOST_PORT` (défaut: `5173`)
- `SERVER_HOST_PORT` (défaut: `2567`)
- `VITE_COLYSEUS_URL` (défaut: `wss://apisnake.raphcvr.me`)
- `PUBLIC_BASE_URL` (défaut: `https://snake.raphcvr.me`)
- `PUBLIC_WS_URL` (défaut: `wss://apisnake.raphcvr.me`)

Déploiement complet recommandé:

```bash
npm run deploy:prod
```

Cette commande:

- lance `npm run prod:check:full`
- remplace les anciens listeners locaux sur `5173` / `2567`
- rebuild et redémarre la stack Docker
- attend les healthchecks locaux
- lance un health check public
- lance une smoke suite publique multi-device

Docker manuel:

```bash
npm run docker:prod
```

Si tu utilises un `.env.prod`, tu peux aussi lancer:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Services:

- Client: `http://127.0.0.1:5173`
- Serveur WS: `ws://127.0.0.1:2567`
- Health: `http://127.0.0.1:2567/health`
- Ready: `http://127.0.0.1:2567/ready`

Pour éviter un conflit avec le tunnel, les ports Docker sont bindés uniquement sur `127.0.0.1`.
Si tu veux exposer le client ailleurs en local, surcharge `CLIENT_HOST_PORT` dans `.env.prod`.

Arrêt:

```bash
npm run docker:prod:down
```

Fichiers de déploiement:

- `docker-compose.prod.yml`
- `apps/client/Dockerfile`
- `apps/client/nginx.conf`
- `apps/server/Dockerfile`

## CI

Pipelines GitHub Actions:

- `npm ci`
- `npx playwright install --with-deps chromium webkit`
- `npm run prod:check:full`
- Monitoring horaire public léger: `.github/workflows/prod-monitor.yml`

## Ce qui est implémenté

- Tick fixe 140ms, wrap-around, input buffer, collisions strictes, food/score/winner
- Rendu Phaser interpolé (tweens 140ms) sans physique
- Juice: particules à l’ingestion, pulse nourriture, shake caméra à la mort
- Local: clavier + tactile (pointer coarse), pause locale
- Online: matchmaking `joinOrCreate`, sync schema, serveur autoritaire, vote rematch à 2
