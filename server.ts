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

  app.get('/api/online/history', (_req, res) => {
    res.json({
      history: socketController.roomManager.getHistory(30),
    });
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
