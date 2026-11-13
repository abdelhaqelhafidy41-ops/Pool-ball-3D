import {
  buildCorsHeaders,
  isOriginAllowed,
  loadWorkerConfig,
  type Env,
} from './config';
import { D1ProgressionService } from './D1ProgressionService';
import { MatchmakerDurableObject } from './MatchmakerDurableObject';
import { PoolRoomDurableObject } from './PoolRoomDurableObject';
import { ACHIEVEMENTS_CATALOG, type LeaderboardScope } from '../../src/multiplayer/shared/progression';

export { MatchmakerDurableObject, PoolRoomDurableObject };

const ROOM_ID_PATTERN = /^room_[a-zA-Z0-9_-]{4,40}$/;

const apiRateBuckets = new Map<string, number[]>();
const API_RATE_WINDOW_MS = 60_000;
const API_RATE_MAX_REQUESTS = 140;

function checkApiRateLimit(request: Request): boolean {
  const ip =
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'global';
  const now = Date.now();
  const cutoff = now - API_RATE_WINDOW_MS;
  const bucket = apiRateBuckets.get(ip) ?? [];
  while (bucket.length > 0 && bucket[0] < cutoff) {
    bucket.shift();
  }
  if (bucket.length >= API_RATE_MAX_REQUESTS) {
    apiRateBuckets.set(ip, bucket);
    return false;
  }
  bucket.push(now);
  if (apiRateBuckets.size > 5000) {
    apiRateBuckets.clear();
  }
  apiRateBuckets.set(ip, bucket);
  return true;
}

function isLocalWorkerRequest(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

function jsonResponse(
  payload: unknown,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
    },
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (!text || text.length > 32768) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractBearerToken(request: Request, body?: Record<string, unknown> | null): string {
  const auth = request.headers.get('Authorization') ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  if (body && typeof body.playerToken === 'string') {
    return body.playerToken.trim();
  }
  return '';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const config = loadWorkerConfig(env);
    const originHeader = request.headers.get('Origin');
    const allowDevLocalhost = isLocalWorkerRequest(url);
    const originOk = isOriginAllowed(originHeader, config.corsOrigin, { allowDevLocalhost });
    const cors = buildCorsHeaders(originHeader, config.corsOrigin, { allowDevLocalhost });

    if (!originOk) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, cors);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const isWebSocketUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    const isWsPath = url.pathname === '/ws' || url.pathname === '/ws/';

    if (isWsPath || (url.pathname === '/' && isWebSocketUpgrade)) {
      if (!isWebSocketUpgrade) {
        return new Response('Expected WebSocket upgrade', { status: 426, headers: cors });
      }

      const roomId = (url.searchParams.get('roomId') ?? '').trim();
      if (roomId) {
        if (!ROOM_ID_PATTERN.test(roomId)) {
          return jsonResponse({ error: 'Invalid roomId parameter' }, 400, cors);
        }
        const roomStub = env.POOL_ROOM.get(env.POOL_ROOM.idFromName(roomId));
        return roomStub.fetch(request);
      }

      const matchmakerStub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
      return matchmakerStub.fetch(request);
    }

    if (url.pathname.startsWith('/api/') && !checkApiRateLimit(request)) {
      return jsonResponse(
        { error: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
        429,
        cors,
      );
    }

    if (url.pathname === '/health' || url.pathname === '/api/health') {
      const matchmakerStub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
      const stats = await matchmakerStub.getHealthAndStats();
      return jsonResponse(
        {
          ok: true,
          status: 'healthy',
          runtime: 'cloudflare-workers',
          d1Configured: Boolean(env.DB),
          ...stats,
        },
        200,
        cors,
      );
    }

    if (url.pathname === '/api/online/stats') {
      const matchmakerStub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
      const stats = await matchmakerStub.getHealthAndStats();
      return jsonResponse(stats, 200, cors);
    }

    if (url.pathname === '/api/online/history') {
      const matchmakerStub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
      const doHistory = await matchmakerStub.getHistory(30);
      if (env.DB) {
        try {
          const d1 = new D1ProgressionService(env.DB);
          const d1History = await d1.getMatchHistory({ limit: 30 });
          if (d1History.length > 0) {
            const seen = new Set(d1History.map((m) => m.matchId));
            const merged = [...d1History];
            for (const rec of doHistory) {
              if (!seen.has(rec.matchId)) merged.push(rec);
            }
            merged.sort((a, b) => b.endedAtMs - a.endedAtMs);
            return jsonResponse({ history: merged.slice(0, 30) }, 200, cors);
          }
        } catch {
          // Fall back cleanly to DO history
        }
      }
      return jsonResponse({ history: doHistory }, 200, cors);
    }

    // Competitive Progression & Identity REST API
    if (url.pathname === '/api/players/session' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse(
          { error: 'DB_UNAVAILABLE', message: 'Player progression database is not configured.' },
          503,
          cors,
        );
      }
      const body = await readJsonBody(request);
      if (!body) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'Invalid JSON request body.' }, 400, cors);
      }
      const d1 = new D1ProgressionService(env.DB);
      const tokenFromHeader = extractBearerToken(request, body);
      const res = await d1.authenticateOrCreatePlayer({
        playerId: typeof body.playerId === 'string' ? body.playerId : null,
        playerToken: tokenFromHeader || null,
        displayName: typeof body.displayName === 'string' ? body.displayName : null,
        avatarId: typeof body.avatarId === 'string' ? body.avatarId : null,
        forceNewGuest: Boolean(body.forceNewGuest),
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/players/profile' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse(
          { error: 'DB_UNAVAILABLE', message: 'Player progression database is not configured.' },
          503,
          cors,
        );
      }
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const d1 = new D1ProgressionService(env.DB);
      const res = await d1.updatePlayerProfile(body.playerId, token, {
        displayName: body.displayName,
        avatarId: body.avatarId,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/players/register' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse(
          { error: 'DB_UNAVAILABLE', message: 'Player progression database is not configured.' },
          503,
          cors,
        );
      }
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const d1 = new D1ProgressionService(env.DB);
      const res = await d1.registerAccount(body.playerId, token, {
        username: body.username,
        password: body.password,
        displayName: body.displayName,
        avatarId: body.avatarId,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/players/login' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse(
          { error: 'DB_UNAVAILABLE', message: 'Player progression database is not configured.' },
          503,
          cors,
        );
      }
      const body = await readJsonBody(request);
      if (!body) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'Invalid JSON request body.' }, 400, cors);
      }
      const d1 = new D1ProgressionService(env.DB);
      const res = await d1.loginAccount({
        username: body.username,
        password: body.password,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname.startsWith('/api/players/profile/') && request.method === 'GET') {
      if (!env.DB) {
        return jsonResponse(
          { error: 'DB_UNAVAILABLE', message: 'Player progression database is not configured.' },
          503,
          cors,
        );
      }
      const targetPlayerId = decodeURIComponent(
        url.pathname.slice('/api/players/profile/'.length),
      ).trim();
      const d1 = new D1ProgressionService(env.DB);
      const profile = await d1.getPublicProfile(targetPlayerId);
      if (!profile) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Player profile not found.' }, 404, cors);
      }
      return jsonResponse({ ok: true, profile }, 200, cors);
    }

    if (url.pathname === '/api/players/search' && request.method === 'GET') {
      if (!env.DB) {
        return jsonResponse({ ok: true, players: [] }, 200, cors);
      }
      const q = url.searchParams.get('q') ?? '';
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '15', 10) || 15;
      const d1 = new D1ProgressionService(env.DB);
      const players = await d1.searchPlayers(q, limit);
      return jsonResponse({ ok: true, players }, 200, cors);
    }

    if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
      if (!env.DB) {
        return jsonResponse(
          {
            scope: 'global',
            page: 1,
            limit: 20,
            total: 0,
            totalPages: 1,
            items: [],
            currentPlayer: null,
          },
          200,
          cors,
        );
      }
      const rawScope = url.searchParams.get('scope');
      const scope: LeaderboardScope =
        rawScope === 'weekly' || rawScope === 'monthly' ? rawScope : 'global';
      const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;
      const query = url.searchParams.get('q') ?? '';
      const currentPlayerId = url.searchParams.get('playerId');

      const d1 = new D1ProgressionService(env.DB);
      const leaderboard = await d1.getLeaderboard({
        scope,
        page,
        limit,
        query,
        currentPlayerId,
      });
      return jsonResponse({ ok: true, ...leaderboard }, 200, cors);
    }

    if (url.pathname === '/api/matches/history' && request.method === 'GET') {
      const playerId = url.searchParams.get('playerId');
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30;

      if (env.DB) {
        const d1 = new D1ProgressionService(env.DB);
        const matches = await d1.getMatchHistory({ playerId, limit });
        return jsonResponse({ ok: true, matches }, 200, cors);
      }

      const matchmakerStub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
      const history = await matchmakerStub.getHistory(limit);
      return jsonResponse({ ok: true, matches: history }, 200, cors);
    }

    if (url.pathname === '/api/achievements' && request.method === 'GET') {
      const playerId = url.searchParams.get('playerId');
      if (playerId && env.DB) {
        const d1 = new D1ProgressionService(env.DB);
        const profile = await d1.getPublicProfile(playerId);
        return jsonResponse(
          {
            ok: true,
            catalog: ACHIEVEMENTS_CATALOG,
            unlocked: profile?.achievements ?? [],
          },
          200,
          cors,
        );
      }
      return jsonResponse({ ok: true, catalog: ACHIEVEMENTS_CATALOG, unlocked: [] }, 200, cors);
    }

    if (url.pathname === '/') {
      return jsonResponse(
        {
          ok: true,
          service: 'ULTIMATE POOL 3D Cloudflare Worker Multiplayer Server',
          health: '/health',
          wsPath: '/ws',
        },
        200,
        cors,
      );
    }

    return jsonResponse({ error: 'Not found' }, 404, cors);
  },
} satisfies ExportedHandler<Env>;
