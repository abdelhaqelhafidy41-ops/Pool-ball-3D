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
import type { FriendRequestAction, MatchInviteAction } from '../../src/multiplayer/shared/social';

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

    const getMatchmakerStub = () => env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));

    if (url.pathname === '/health' || url.pathname === '/api/health') {
      const matchmakerStub = getMatchmakerStub();
      const stats = await matchmakerStub.getHealthAndStats();
      return jsonResponse(
        {
          ok: true,
          status: 'healthy',
          runtime: 'cloudflare-workers',
          d1Configured: Boolean(env.DB),
          progressionBackend: env.DB ? 'd1' : 'durable-object-sqlite',
          progressionReady: true,
          ...stats,
        },
        200,
        cors,
      );
    }

    if (url.pathname === '/api/online/stats') {
      const matchmakerStub = getMatchmakerStub();
      const stats = await matchmakerStub.getHealthAndStats();
      return jsonResponse(stats, 200, cors);
    }

    if (url.pathname === '/api/online/history') {
      const matchmakerStub = getMatchmakerStub();
      const doHistory = await matchmakerStub.getHistory(30);
      try {
        const progHistory = env.DB
          ? await new D1ProgressionService(env.DB).getMatchHistory({ limit: 30 })
          : await matchmakerStub.progressionHistory({ limit: 30 });
        if (progHistory.length > 0) {
          const seen = new Set(progHistory.map((m) => m.matchId));
          const merged = [...progHistory];
          for (const rec of doHistory) {
            if (!seen.has(rec.matchId)) merged.push(rec);
          }
          merged.sort((a, b) => b.endedAtMs - a.endedAtMs);
          return jsonResponse({ history: merged.slice(0, 30) }, 200, cors);
        }
      } catch {
        // Fall back cleanly to DO history
      }
      return jsonResponse({ history: doHistory }, 200, cors);
    }

    // Competitive Progression & Identity REST API
    if (url.pathname === '/api/players/session' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'Invalid JSON request body.' }, 400, cors);
      }
      const tokenFromHeader = extractBearerToken(request, body);
      const input = {
        playerId: typeof body.playerId === 'string' ? body.playerId : null,
        playerToken: tokenFromHeader || null,
        displayName: typeof body.displayName === 'string' ? body.displayName : null,
        avatarId: typeof body.avatarId === 'string' ? body.avatarId : null,
        forceNewGuest: Boolean(body.forceNewGuest),
      };
      const res = env.DB
        ? await new D1ProgressionService(env.DB).authenticateOrCreatePlayer(input)
        : await getMatchmakerStub().progressionAuthenticateOrCreate(input);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/players/profile' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const updates = {
        displayName: body.displayName,
        avatarId: body.avatarId,
      };
      const res = env.DB
        ? await new D1ProgressionService(env.DB).updatePlayerProfile(body.playerId, token, updates)
        : await getMatchmakerStub().progressionUpdateProfile(body.playerId, token, updates);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/players/register' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const input = {
        username: body.username,
        password: body.password,
        displayName: body.displayName,
        avatarId: body.avatarId,
      };
      const res = env.DB
        ? await new D1ProgressionService(env.DB).registerAccount(body.playerId, token, input)
        : await getMatchmakerStub().progressionRegister(body.playerId, token, input);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/players/login' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'Invalid JSON request body.' }, 400, cors);
      }
      const input = {
        username: body.username,
        password: body.password,
      };
      const res = env.DB
        ? await new D1ProgressionService(env.DB).loginAccount(input)
        : await getMatchmakerStub().progressionLogin(input);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname.startsWith('/api/players/profile/') && request.method === 'GET') {
      const targetPlayerId = decodeURIComponent(
        url.pathname.slice('/api/players/profile/'.length),
      ).trim();
      const profile = env.DB
        ? await new D1ProgressionService(env.DB).getPublicProfile(targetPlayerId)
        : await getMatchmakerStub().progressionGetProfile(targetPlayerId);
      if (!profile) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Player profile not found.' }, 404, cors);
      }
      return jsonResponse({ ok: true, profile }, 200, cors);
    }

    if (url.pathname === '/api/players/search' && request.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '15', 10) || 15;
      const players = env.DB
        ? await new D1ProgressionService(env.DB).searchPlayers(q, limit)
        : await getMatchmakerStub().progressionSearch(q, limit);
      return jsonResponse({ ok: true, players }, 200, cors);
    }

    if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
      const rawScope = url.searchParams.get('scope');
      const scope: LeaderboardScope =
        rawScope === 'weekly' || rawScope === 'monthly' ? rawScope : 'global';
      const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;
      const query = url.searchParams.get('q') ?? '';
      const currentPlayerId = url.searchParams.get('playerId');

      const params = { scope, page, limit, query, currentPlayerId };
      const leaderboard = env.DB
        ? await new D1ProgressionService(env.DB).getLeaderboard(params)
        : await getMatchmakerStub().progressionLeaderboard(params);
      return jsonResponse({ ok: true, ...leaderboard }, 200, cors);
    }

    if (url.pathname === '/api/matches/history' && request.method === 'GET') {
      const playerId = url.searchParams.get('playerId');
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30;

      const matches = env.DB
        ? await new D1ProgressionService(env.DB).getMatchHistory({ playerId, limit })
        : await getMatchmakerStub().progressionHistory({ playerId, limit });
      return jsonResponse({ ok: true, matches }, 200, cors);
    }

    if (url.pathname === '/api/achievements' && request.method === 'GET') {
      const playerId = url.searchParams.get('playerId');
      if (playerId) {
        const profile = env.DB
          ? await new D1ProgressionService(env.DB).getPublicProfile(playerId)
          : await getMatchmakerStub().progressionGetProfile(playerId);
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

    // ===== Phase 7 Social, Presence, Invitations & Messaging API =====

    if (url.pathname === '/api/social/overview' && request.method === 'GET') {
      const playerId = (url.searchParams.get('playerId') ?? '').trim();
      const token = extractBearerToken(request);
      const res = await getMatchmakerStub().socialGetOverview(playerId, token);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/search' && request.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '15', 10) || 15;
      const viewerId = url.searchParams.get('playerId');
      const token = extractBearerToken(request) || null;
      const players = await getMatchmakerStub().socialSearchPlayers(viewerId, token, q, limit);
      return jsonResponse({ ok: true, players }, 200, cors);
    }

    if (url.pathname === '/api/social/friends/request' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.targetPlayerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and targetPlayerId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialSendFriendRequest(
        body.playerId,
        token,
        body.targetPlayerId,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/friends/respond' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const action = body?.action;
      if (
        !body ||
        typeof body.playerId !== 'string' ||
        typeof body.targetPlayerId !== 'string' ||
        (action !== 'accept' && action !== 'reject' && action !== 'cancel')
      ) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId, targetPlayerId, and valid action are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialRespondFriendRequest(
        body.playerId,
        token,
        body.targetPlayerId,
        action as FriendRequestAction,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/friends/remove' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.targetPlayerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and targetPlayerId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialRemoveFriend(
        body.playerId,
        token,
        body.targetPlayerId,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/block' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.targetPlayerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and targetPlayerId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialBlockPlayer(
        body.playerId,
        token,
        body.targetPlayerId,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/unblock' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.targetPlayerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and targetPlayerId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialUnblockPlayer(
        body.playerId,
        token,
        body.targetPlayerId,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/presence' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialSetPresence(body.playerId, token, {
        status: body.status,
        ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
        expireNow: Boolean(body.expireNow),
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/invites' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.targetPlayerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and targetPlayerId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialCreateInvite(body.playerId, token, {
        targetPlayerId: body.targetPlayerId,
        ruleProfileId: body.ruleProfileId === 'wpa' ? 'wpa' : 'casual',
        calledShotsEnabled: Boolean(body.calledShotsEnabled),
        ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/invites/respond' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const action = body?.action;
      if (
        !body ||
        typeof body.playerId !== 'string' ||
        typeof body.inviteId !== 'string' ||
        (action !== 'accept' && action !== 'reject' && action !== 'cancel')
      ) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId, inviteId, and valid action are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialRespondInvite(
        body.playerId,
        token,
        body.inviteId,
        action as MatchInviteAction,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname.startsWith('/api/social/messages/') && request.method === 'GET') {
      const peerId = decodeURIComponent(
        url.pathname.slice('/api/social/messages/'.length),
      ).trim();
      const playerId = (url.searchParams.get('playerId') ?? '').trim();
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '60', 10) || 60;
      const token = extractBearerToken(request);
      const res = await getMatchmakerStub().socialGetMessages(playerId, token, peerId, limit);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/messages' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.recipientId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and recipientId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialSendMessage(
        body.playerId,
        token,
        body.recipientId,
        body.body,
        typeof body.clientMessageId === 'string' ? body.clientMessageId : undefined,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/reports' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.reportedId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and reportedId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialCreateReport(body.playerId, token, {
        reportedId: body.reportedId,
        contextType: body.contextType,
        contextId: body.contextId,
        reason: body.reason,
        details: body.details,
        excerpt: body.excerpt,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
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
