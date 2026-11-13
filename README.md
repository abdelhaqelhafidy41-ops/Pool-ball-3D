# ULTIMATE POOL 3D

Realistic 3D American 8-Ball pool built with React, Three.js, Rapier3D physics, and an authoritative multiplayer backend on **Cloudflare Workers + SQLite-backed Durable Objects** (Free-plan compatible) with the frontend hosted on **GitHub Pages**.

---

## Architecture

- **Frontend (GitHub Pages)**: Vite + React + Three.js + client Rapier3D (`src/`), deployed automatically by `.github/workflows/deploy.yml`.
- **Multiplayer Backend (Cloudflare Workers + Durable Objects)**:
  - `cloudflare/src/worker.ts`: Edge HTTP/WebSocket router, CORS origin enforcement, `/health`, `/api/health`, `/api/online/stats`, `/api/online/history`, and `/ws` upgrades.
  - `cloudflare/src/MatchmakerDurableObject.ts`: Global SQLite-backed Durable Object managing authenticated player sessions, room code registry, quick matchmaking queue, DO Alarms, and match history using the **WebSocket Hibernation API**.
  - `cloudflare/src/PoolRoomDurableObject.ts`: Per-room SQLite-backed Durable Object running authoritative `WorkerMatchManager` + `WorkerPhysicsManager` (Rapier3D WASM), shot token deduplication, disconnect grace alarms, and **WebSocket Hibernation API** connections.

---

## Local Development

```bash
# Install dependencies
npm install

# Run local full-stack dev server (Vite + local WS on http://localhost:3000)
npm run dev

# Or run the Cloudflare Worker locally with Wrangler
npm run cf:dev
```

---

## Verification Commands

```bash
# Frontend & shared TypeScript check
npm run lint

# Cloudflare Worker & Durable Objects TypeScript check
npm run cf:typecheck

# Build Cloudflare Worker bundle + CompiledWasm Rapier asset
npm run cf:build

# Build GitHub Pages frontend bundle
npm run build:frontend
```

---

## Deploying the Multiplayer Backend to Cloudflare Workers

1. **Authenticate with Cloudflare**:
   ```bash
   npx wrangler login
   ```
2. **Configure allowed GitHub Pages origin** (`CORS_ORIGIN`):
   - Edit `cloudflare/wrangler.jsonc` under `"vars"."CORS_ORIGIN"` (or set as a secret/variable in the Cloudflare Dashboard) to your exact GitHub Pages origin **without** a path or trailing slash:
     ```jsonc
     "CORS_ORIGIN": "https://<your-github-username>.github.io"
     ```
   - Or deploy with an environment variable / secret:
     ```bash
     npx wrangler secret put CORS_ORIGIN --config cloudflare/wrangler.jsonc
     ```
3. **Deploy the Worker & SQLite Durable Object migrations**:
   ```bash
   npm run cf:deploy
   ```
4. **Verify deployment**:
   - Note the deployed Worker URL printed by Wrangler, e.g. `https://ultimate-pool-3d-multiplayer.<your-subdomain>.workers.dev`.
   - Open `https://ultimate-pool-3d-multiplayer.<your-subdomain>.workers.dev/health` and confirm `"ok": true, "runtime": "cloudflare-workers"`.

---

## Deploying the Frontend to GitHub Pages

1. In your GitHub repository, open **Settings -> Pages** and set **Build and deployment -> Source** to **GitHub Actions**.
2. Open **Settings -> Secrets and variables -> Actions -> Variables -> Repository variables** and add:
   - **Name**: `VITE_WS_URL`
   - **Value**: `wss://ultimate-pool-3d-multiplayer.<your-subdomain>.workers.dev/ws`
3. Push to `main` (or trigger **Actions -> Deploy Frontend to GitHub Pages -> Run workflow**).
4. `.github/workflows/deploy.yml` automatically detects user sites (`/` for `<user>.github.io`) vs project repositories (`/<repo-name>/`) and injects `VITE_WS_URL`.
