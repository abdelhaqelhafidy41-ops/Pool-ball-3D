import 'dotenv/config';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { ensureServerRapierInitialized } from './server/AuthoritativePhysicsManager';
import {
  isOriginAllowed,
  loadServerConfig,
  normalizeOriginValue,
  parseAllowedOrigins,
} from './server/config';
import { SocketController } from './server/SocketController';
import {
  ACHIEVEMENTS_CATALOG,
  type LeaderboardScope,
} from './src/multiplayer/shared/progression';

function resolveListenPort(fallbackPort: number): number {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) {
    const parsed = Number.parseInt(process.argv[idx + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallbackPort;
}

async function startServer() {
  const config = loadServerConfig();
  const listenPort = resolveListenPort(config.port);
  await ensureServerRapierInitialized();

  const app = express();
  app.use(express.json({ limit: '64kb' }));

  const isProd = process.env.NODE_ENV === 'production';
  const allowedOrigins = parseAllowedOrigins(config.corsOrigin);
  const allowAllOrigins = allowedOrigins.length === 0 || allowedOrigins.includes('*');

  app.use((req, res, next) => {
    const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const reqOrigin = rawOrigin ? normalizeOriginValue(rawOrigin) : '';

    if (allowAllOrigins) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (reqOrigin) {
      if (!isOriginAllowed(reqOrigin, config.corsOrigin, { allowDevLocalhost: !isProd })) {
        res.setHeader('Vary', 'Origin');
        res.status(403).json({ error: 'Origin not allowed' });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const httpServer = createServer(app);
  const socketController = new SocketController(httpServer, config);

  const buildHealthPayload = () => {
    const roomStats = socketController.roomManager.getStats();
    return {
      ok: true,
      status: 'healthy',
      uptimeSec: Math.round(process.uptime()),
      ...roomStats,
      queueSize: socketController.matchmakingManager.getQueueSize(),
      connectedPlayers: socketController.sessionManager.getConnectedCount(),
    };
  };

  app.get('/health', (_req, res) => {
    res.json(buildHealthPayload());
  });

  app.get('/api/health', (_req, res) => {
    res.json(buildHealthPayload());
  });

  app.get('/api/online/stats', (_req, res) => {
    const roomStats = socketController.roomManager.getStats();
    res.json({
      ...roomStats,
      queueSize: socketController.matchmakingManager.getQueueSize(),
      connectedPlayers: socketController.sessionManager.getConnectedCount(),
    });
  });

  app.get('/api/online/history', async (_req, res) => {
    const storeHistory = await socketController.progressionStore.getMatchHistory({ limit: 30 });
    const roomHistory = socketController.roomManager.getHistory(30);
    if (storeHistory.length > 0) {
      res.json({ history: storeHistory });
      return;
    }
    res.json({ history: roomHistory });
  });

  const extractBearer = (req: express.Request): string => {
    const auth = req.headers.authorization ?? '';
    if (auth.toLowerCase().startsWith('bearer ')) {
      return auth.slice(7).trim();
    }
    if (req.body && typeof req.body.playerToken === 'string') {
      return req.body.playerToken.trim();
    }
    return '';
  };

  app.post('/api/players/session', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = extractBearer(req);
    const result = await socketController.progressionStore.authenticateOrCreatePlayer({
      playerId: typeof body.playerId === 'string' ? body.playerId : null,
      playerToken: token || null,
      displayName: typeof body.displayName === 'string' ? body.displayName : null,
      avatarId: typeof body.avatarId === 'string' ? body.avatarId : null,
      forceNewGuest: Boolean(body.forceNewGuest),
    });
    res.json(result);
  });

  app.post('/api/players/profile', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.playerId !== 'string') {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'playerId is required.' });
      return;
    }
    const token = extractBearer(req);
    const result = await socketController.progressionStore.updatePlayerProfile(body.playerId, token, {
      displayName: body.displayName,
      avatarId: body.avatarId,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.code, message: result.message });
      return;
    }
    res.json(result);
  });

  app.post('/api/players/register', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.playerId !== 'string') {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'playerId is required.' });
      return;
    }
    const token = extractBearer(req);
    const result = await socketController.progressionStore.registerAccount(body.playerId, token, {
      username: body.username,
      password: body.password,
      displayName: body.displayName,
      avatarId: body.avatarId,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.code, message: result.message });
      return;
    }
    res.json(result);
  });

  app.post('/api/players/login', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await socketController.progressionStore.loginAccount({
      username: body.username,
      password: body.password,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.code, message: result.message });
      return;
    }
    res.json(result);
  });

  app.get('/api/players/profile/:playerId', async (req, res) => {
    const profile = await socketController.progressionStore.getPublicProfile(req.params.playerId);
    if (!profile) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Player profile not found.' });
      return;
    }
    res.json({ ok: true, profile });
  });

  app.get('/api/players/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Number.parseInt(String(req.query.limit ?? '15'), 10) || 15;
    const players = await socketController.progressionStore.searchPlayers(q, limit);
    res.json({ ok: true, players });
  });

  app.get('/api/leaderboard', async (req, res) => {
    const rawScope = req.query.scope;
    const scope: LeaderboardScope =
      rawScope === 'weekly' || rawScope === 'monthly' ? rawScope : 'global';
    const page = Number.parseInt(String(req.query.page ?? '1'), 10) || 1;
    const limit = Number.parseInt(String(req.query.limit ?? '20'), 10) || 20;
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const currentPlayerId = typeof req.query.playerId === 'string' ? req.query.playerId : null;
    const leaderboard = await socketController.progressionStore.getLeaderboard({
      scope,
      page,
      limit,
      query,
      currentPlayerId,
    });
    res.json({ ok: true, ...leaderboard });
  });

  app.get('/api/matches/history', async (req, res) => {
    const playerId = typeof req.query.playerId === 'string' ? req.query.playerId : null;
    const limit = Number.parseInt(String(req.query.limit ?? '30'), 10) || 30;
    const matches = await socketController.progressionStore.getMatchHistory({ playerId, limit });
    res.json({ ok: true, matches });
  });

  app.get('/api/achievements', async (req, res) => {
    const playerId = typeof req.query.playerId === 'string' ? req.query.playerId : null;
    if (playerId) {
      const profile = await socketController.progressionStore.getPublicProfile(playerId);
      res.json({
        ok: true,
        catalog: ACHIEVEMENTS_CATALOG,
        unlocked: profile?.achievements ?? [],
      });
      return;
    }
    res.json({ ok: true, catalog: ACHIEVEMENTS_CATALOG, unlocked: [] });
  });

  let viteServer: { close: () => Promise<void> } | null = null;
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true' ? { server: httpServer } : false,
      },
      appType: 'spa',
    });
    viteServer = vite;
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const indexHtmlPath = path.join(distDir, 'index.html');
    if (existsSync(indexHtmlPath)) {
      app.use(express.static(distDir));
      app.get('/{*splat}', (_req, res) => {
        res.sendFile(indexHtmlPath);
      });
    } else {
      app.get('/', (_req, res) => {
        res.json({
          ok: true,
          service: 'ULTIMATE POOL 3D WebSocket Server',
          health: '/health',
          wsPath: '/ws',
        });
      });
    }
  }

  httpServer.on('error', (err) => {
    console.error('HTTP server error:', err);
  });

  httpServer.listen(listenPort, '0.0.0.0', () => {
    console.log(`ULTIMATE POOL 3D server listening on http://0.0.0.0:${listenPort} (WS: /ws)`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => process.exit(0), 500);
    forceTimer.unref();

    socketController.dispose();
    void viteServer?.close().catch(() => {});
    httpServer.closeAllConnections?.();
    httpServer.close(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start ULTIMATE POOL 3D server:', err);
  process.exit(1);
});
