import {
  buildCorsHeaders,
  isOriginAllowed,
  loadWorkerConfig,
  verifyAdminRequest,
  verifyTournamentAdmin,
  type Env,
} from './config';
import { AntiCheatService } from './AntiCheatService';
import { D1ProgressionService } from './D1ProgressionService';
import { EconomyService } from './EconomyService';
import { BattlePassService } from './BattlePassService';
import { MatchmakerDurableObject } from './MatchmakerDurableObject';
import { PoolRoomDurableObject } from './PoolRoomDurableObject';
import { RankedSeasonService } from './RankedSeasonService';
import type {
  AiMatchProgressRequest,
  BattlePassTrack,
  MissionCadence,
} from '../../src/multiplayer/shared/battlePass';
import {
  COSMETIC_CATALOG,
  DAILY_LOGIN_SCHEDULE,
  ECONOMY_CONFIG,
  type AiMatchRewardRequest,
} from '../../src/multiplayer/shared/economy';
import {
  ACHIEVEMENTS_CATALOG,
  type LeaderboardScope,
  type OnlineMatchType,
} from '../../src/multiplayer/shared/progression';
import type { PenaltyType } from '../../src/multiplayer/shared/ranked';
import type {
  ClubLeaderboardScope,
  ClubRole,
  FriendRequestAction,
  MatchInviteAction,
  MatchInviteKind,
  PrivacySettings,
} from '../../src/multiplayer/shared/social';
import {
  TOURNAMENT_TROPHY_CATALOG,
  type CreateTournamentInput,
  type TournamentMatchResolutionType,
} from '../../src/multiplayer/shared/tournaments';

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
      const rawViewerId = url.searchParams.get('viewerId')?.trim() || null;
      const viewerToken = extractBearerToken(request) || null;
      let profile = null;
      if (env.DB) {
        let verifiedViewer: string | null = null;
        if (rawViewerId && viewerToken) {
          const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(
            rawViewerId,
            viewerToken,
          );
          if (valid) verifiedViewer = rawViewerId;
        }
        profile = await new D1ProgressionService(env.DB).getPublicProfile(
          targetPlayerId,
          verifiedViewer,
        );
      } else {
        profile = await getMatchmakerStub().progressionGetProfile(
          targetPlayerId,
          rawViewerId,
          viewerToken,
        );
      }
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
        rawScope === 'weekly' || rawScope === 'monthly' || rawScope === 'season'
          ? rawScope
          : 'global';
      const seasonId = url.searchParams.get('seasonId')?.trim() || null;
      const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;
      const query = url.searchParams.get('q') ?? '';
      const currentPlayerId = url.searchParams.get('playerId');

      const params = { scope, seasonId, page, limit, query, currentPlayerId };
      const leaderboard = env.DB
        ? await new D1ProgressionService(env.DB).getLeaderboard(params)
        : await getMatchmakerStub().progressionLeaderboard(params);
      return jsonResponse({ ok: true, ...leaderboard }, 200, cors);
    }

    if (url.pathname === '/api/matches/history' && request.method === 'GET') {
      const playerId = url.searchParams.get('playerId');
      const rawType = url.searchParams.get('matchType');
      const matchType: OnlineMatchType | 'all' | null =
        rawType === 'ranked' ||
        rawType === 'quick' ||
        rawType === 'private' ||
        rawType === 'tournament' ||
        rawType === 'all'
          ? rawType
          : null;
      const seasonId = url.searchParams.get('seasonId')?.trim() || null;
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30;

      const matches = env.DB
        ? await new D1ProgressionService(env.DB).getMatchHistory({
            playerId,
            matchType,
            seasonId,
            limit,
          })
        : await getMatchmakerStub().progressionHistory({ playerId, matchType, seasonId, limit });
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
      const inviteKind: MatchInviteKind = body.inviteKind === 'spectate' ? 'spectate' : 'match';
      const res = await getMatchmakerStub().socialCreateInvite(body.playerId, token, {
        targetPlayerId: body.targetPlayerId,
        inviteKind,
        roomId: typeof body.roomId === 'string' ? body.roomId.trim() : undefined,
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

    // ===== Phase 15 Social Community, Privacy, Notifications & Clubs API =====

    if (url.pathname === '/api/social/friends' && request.method === 'GET') {
      const playerId = (url.searchParams.get('playerId') ?? '').trim();
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '25', 10) || 25;
      const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
      const query = url.searchParams.get('q') ?? '';
      const token = extractBearerToken(request);
      const res = await getMatchmakerStub().socialGetFriendsPaginated(playerId, token, {
        limit,
        offset,
        query,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/privacy' && request.method === 'GET') {
      const playerId = (url.searchParams.get('playerId') ?? '').trim();
      const token = extractBearerToken(request);
      const res = await getMatchmakerStub().socialGetPrivacy(playerId, token);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/privacy' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const updates: Partial<PrivacySettings> = {
        ...(body.allowFriendRequests !== undefined
          ? { allowFriendRequests: body.allowFriendRequests as PrivacySettings['allowFriendRequests'] }
          : {}),
        ...(body.allowMatchInvites !== undefined
          ? { allowMatchInvites: body.allowMatchInvites as PrivacySettings['allowMatchInvites'] }
          : {}),
        ...(body.allowDirectMessages !== undefined
          ? { allowDirectMessages: body.allowDirectMessages as PrivacySettings['allowDirectMessages'] }
          : {}),
        ...(typeof body.showOnlineStatus === 'boolean'
          ? { showOnlineStatus: body.showOnlineStatus }
          : {}),
        ...(typeof body.showPublicStats === 'boolean'
          ? { showPublicStats: body.showPublicStats }
          : {}),
      };
      const res = await getMatchmakerStub().socialUpdatePrivacy(body.playerId, token, updates);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/notifications' && request.method === 'GET') {
      const playerId = (url.searchParams.get('playerId') ?? '').trim();
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '40', 10) || 40;
      const unreadOnly = url.searchParams.get('unreadOnly') === '1';
      const token = extractBearerToken(request);
      const res = await getMatchmakerStub().socialGetNotifications(playerId, token, {
        limit,
        unreadOnly,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/notifications/read' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialMarkNotificationRead(
        body.playerId,
        token,
        typeof body.notificationId === 'string' ? body.notificationId : undefined,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/notifications/clear' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialClearNotifications(
        body.playerId,
        token,
        typeof body.notificationId === 'string' ? body.notificationId : undefined,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/social/rooms/join-friend' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.friendPlayerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and friendPlayerId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().socialJoinFriendRoom(
        body.playerId,
        token,
        body.friendPlayerId,
        typeof body.sessionId === 'string' ? body.sessionId : undefined,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/clubs' && request.method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30;
      const clubs = await getMatchmakerStub().clubList({ query, limit });
      return jsonResponse({ ok: true, clubs }, 200, cors);
    }

    if (url.pathname === '/api/clubs' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().clubCreate(body.playerId, token, {
        name: body.name,
        tag: body.tag,
        description: body.description,
        emblemColor: body.emblemColor,
        emblemIcon: body.emblemIcon,
        joinMode: body.joinMode,
        region: body.region,
        maxMembers: body.maxMembers,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/clubs/leaderboard' && request.method === 'GET') {
      const rawScope = url.searchParams.get('scope');
      const scope: ClubLeaderboardScope =
        rawScope === 'weekly' || rawScope === 'seasonal' ? rawScope : 'global';
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30;
      const entries = await getMatchmakerStub().clubLeaderboard({ scope, limit });
      return jsonResponse({ ok: true, scope, entries }, 200, cors);
    }

    if (url.pathname === '/api/clubs/invites/respond' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const action = body?.action;
      if (
        !body ||
        typeof body.playerId !== 'string' ||
        typeof body.inviteId !== 'string' ||
        (action !== 'accept' && action !== 'reject')
      ) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId, inviteId, and action (accept|reject) are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().clubRespondInvite(
        body.playerId,
        token,
        body.inviteId,
        action,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/clubs/challenges' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (
        !body ||
        typeof body.playerId !== 'string' ||
        typeof body.challengerClubId !== 'string' ||
        typeof body.targetClubId !== 'string'
      ) {
        return jsonResponse(
          {
            error: 'INVALID_INPUT',
            message: 'playerId, challengerClubId, and targetClubId are required.',
          },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().clubCreateChallenge(body.playerId, token, {
        challengerClubId: body.challengerClubId,
        targetClubId: body.targetClubId,
        ruleProfileId: body.ruleProfileId === 'wpa' ? 'wpa' : 'casual',
        calledShotsEnabled: Boolean(body.calledShotsEnabled),
        targetWins: typeof body.targetWins === 'number' ? body.targetWins : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (
      url.pathname.startsWith('/api/clubs/challenges/') &&
      url.pathname.endsWith('/respond') &&
      request.method === 'POST'
    ) {
      const challengeId = decodeURIComponent(
        url.pathname.slice('/api/clubs/challenges/'.length, url.pathname.length - '/respond'.length),
      ).trim();
      const body = await readJsonBody(request);
      const action = body?.action;
      if (
        !body ||
        typeof body.playerId !== 'string' ||
        (action !== 'accept' && action !== 'decline' && action !== 'cancel')
      ) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and valid action are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().clubRespondChallenge(
        body.playerId,
        token,
        challengeId,
        action,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname.startsWith('/api/clubs/') && request.method === 'GET') {
      const restPath = url.pathname.slice('/api/clubs/'.length);
      const slashIdx = restPath.indexOf('/');
      if (slashIdx > 0) {
        const clubId = decodeURIComponent(restPath.slice(0, slashIdx)).trim();
        const subAction = restPath.slice(slashIdx + 1);
        if (subAction === 'chat') {
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
          const messages = await getMatchmakerStub().clubGetChatMessages(clubId, limit);
          return jsonResponse({ ok: true, messages }, 200, cors);
        }
        if (subAction === 'trophies') {
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30;
          const trophies = await getMatchmakerStub().clubGetTrophies(clubId, limit);
          return jsonResponse({ ok: true, trophies }, 200, cors);
        }
        if (subAction === 'teams') {
          const teams = await getMatchmakerStub().teamListByClub(clubId);
          return jsonResponse({ ok: true, teams }, 200, cors);
        }
        return jsonResponse({ error: 'NOT_FOUND', message: 'Club resource not found.' }, 404, cors);
      }
      const clubId = decodeURIComponent(restPath).trim();
      if (!clubId) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'Invalid clubId.' }, 400, cors);
      }
      const viewerId = url.searchParams.get('playerId')?.trim() || null;
      const viewerToken = extractBearerToken(request) || null;
      const detail = await getMatchmakerStub().clubGetDetail(clubId, viewerId, viewerToken);
      if (!detail) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Club not found.' }, 404, cors);
      }
      return jsonResponse({ ok: true, detail }, 200, cors);
    }

    if (url.pathname.startsWith('/api/clubs/') && request.method === 'POST') {
      const restPath = url.pathname.slice('/api/clubs/'.length);
      const slashIdx = restPath.indexOf('/');
      if (slashIdx <= 0) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Club action not found.' }, 404, cors);
      }
      const clubId = decodeURIComponent(restPath.slice(0, slashIdx)).trim();
      const subAction = restPath.slice(slashIdx + 1);
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);

      if (subAction === 'update') {
        const res = await getMatchmakerStub().clubUpdate(body.playerId, token, clubId, {
          description: body.description,
          emblemColor: body.emblemColor,
          emblemIcon: body.emblemIcon,
          joinMode: body.joinMode,
          region: body.region,
          maxMembers: body.maxMembers,
          announcement: body.announcement,
        });
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'chat') {
        const res = await getMatchmakerStub().clubSendChatMessage(
          body.playerId,
          token,
          clubId,
          body.body,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'announcement') {
        const res = await getMatchmakerStub().clubUpdateAnnouncement(
          body.playerId,
          token,
          clubId,
          body.announcement,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'teams') {
        const res = await getMatchmakerStub().teamCreate(body.playerId, token, clubId, {
          name: body.name,
          tag: body.tag,
          badgeColor: body.badgeColor,
          badgeIcon: body.badgeIcon,
          region: body.region,
          minRosterSize: body.minRosterSize,
          maxRosterSize: body.maxRosterSize,
          captainId: body.captainId,
          memberIds: body.memberIds,
        });
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'join') {
        const res = await getMatchmakerStub().clubJoinOrRequest(
          body.playerId,
          token,
          clubId,
          body.message,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'requests/respond') {
        const action = body.action;
        if (typeof body.requestId !== 'string' || (action !== 'accept' && action !== 'reject')) {
          return jsonResponse(
            { error: 'INVALID_INPUT', message: 'requestId and action (accept|reject) are required.' },
            400,
            cors,
          );
        }
        const res = await getMatchmakerStub().clubRespondJoinRequest(
          body.playerId,
          token,
          clubId,
          body.requestId,
          action,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'invite') {
        if (typeof body.targetPlayerId !== 'string') {
          return jsonResponse(
            { error: 'INVALID_INPUT', message: 'targetPlayerId is required.' },
            400,
            cors,
          );
        }
        const res = await getMatchmakerStub().clubInvitePlayer(
          body.playerId,
          token,
          clubId,
          body.targetPlayerId,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'leave') {
        const res = await getMatchmakerStub().clubLeave(body.playerId, token, clubId);
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'members/role') {
        const role = body.role;
        const validRoles = new Set([
          'owner',
          'president',
          'vice_president',
          'captain',
          'member',
          'admin',
        ]);
        if (typeof body.targetPlayerId !== 'string' || typeof role !== 'string' || !validRoles.has(role)) {
          return jsonResponse(
            { error: 'INVALID_INPUT', message: 'targetPlayerId and valid role are required.' },
            400,
            cors,
          );
        }
        const res = await getMatchmakerStub().clubUpdateMemberRole(
          body.playerId,
          token,
          clubId,
          body.targetPlayerId,
          role as ClubRole,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'members/kick') {
        if (typeof body.targetPlayerId !== 'string') {
          return jsonResponse(
            { error: 'INVALID_INPUT', message: 'targetPlayerId is required.' },
            400,
            cors,
          );
        }
        const res = await getMatchmakerStub().clubKickMember(
          body.playerId,
          token,
          clubId,
          body.targetPlayerId,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      return jsonResponse({ error: 'NOT_FOUND', message: 'Unknown club endpoint.' }, 404, cors);
    }

    // ===== Phase 16 Teams, Team Leagues & Club Championships API =====

    if (url.pathname.startsWith('/api/teams/') && request.method === 'GET') {
      const teamId = decodeURIComponent(url.pathname.slice('/api/teams/'.length)).trim();
      if (!teamId || teamId.includes('/')) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'Invalid teamId.' }, 400, cors);
      }
      const detail = await getMatchmakerStub().teamGetDetail(teamId);
      if (!detail) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Team not found.' }, 404, cors);
      }
      return jsonResponse({ ok: true, ...detail }, 200, cors);
    }

    if (url.pathname.startsWith('/api/teams/') && request.method === 'POST') {
      const restPath = url.pathname.slice('/api/teams/'.length);
      const slashIdx = restPath.indexOf('/');
      if (slashIdx <= 0) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Team action not found.' }, 404, cors);
      }
      const teamId = decodeURIComponent(restPath.slice(0, slashIdx)).trim();
      const subAction = restPath.slice(slashIdx + 1);
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);

      if (subAction === 'members') {
        if (typeof body.targetPlayerId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'targetPlayerId is required.' }, 400, cors);
        }
        const res = await getMatchmakerStub().teamAddMember(
          body.playerId,
          token,
          teamId,
          body.targetPlayerId,
          body.role,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'members/remove') {
        if (typeof body.targetPlayerId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'targetPlayerId is required.' }, 400, cors);
        }
        const res = await getMatchmakerStub().teamRemoveMember(
          body.playerId,
          token,
          teamId,
          body.targetPlayerId,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'members/role') {
        if (typeof body.targetPlayerId !== 'string' || typeof body.role !== 'string') {
          return jsonResponse(
            { error: 'INVALID_INPUT', message: 'targetPlayerId and role are required.' },
            400,
            cors,
          );
        }
        const res = await getMatchmakerStub().teamSetMemberRole(
          body.playerId,
          token,
          teamId,
          body.targetPlayerId,
          body.role,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      return jsonResponse({ error: 'NOT_FOUND', message: 'Unknown team endpoint.' }, 404, cors);
    }

    if (url.pathname === '/api/team-leagues' && request.method === 'GET') {
      const leagues = await getMatchmakerStub().leagueList({
        scope: url.searchParams.get('scope'),
        region: url.searchParams.get('region'),
        status: url.searchParams.get('status'),
      });
      return jsonResponse({ ok: true, leagues }, 200, cors);
    }

    if (url.pathname === '/api/team-leagues' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().leagueCreate(body.playerId, token, {
        title: body.title,
        description: body.description,
        scope: body.scope,
        region: body.region,
        cadence: body.cadence,
        divisionTier: body.divisionTier,
        seasonLabel: body.seasonLabel,
        matchFormat: body.matchFormat,
        ruleProfileId: body.ruleProfileId,
        calledShotsEnabled: body.calledShotsEnabled,
        doubleRoundRobin: body.doubleRoundRobin,
        maxTeams: body.maxTeams,
        promotionSlots: body.promotionSlots,
        relegationSlots: body.relegationSlots,
        matchDurationMinutes: body.matchDurationMinutes,
      });
      if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname.startsWith('/api/team-leagues/') && request.method === 'GET') {
      const leagueId = decodeURIComponent(url.pathname.slice('/api/team-leagues/'.length)).trim();
      if (!leagueId || leagueId.includes('/')) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'Invalid leagueId.' }, 400, cors);
      }
      const viewerId = url.searchParams.get('playerId')?.trim() || null;
      const detail = await getMatchmakerStub().leagueGetDetail(leagueId, viewerId);
      if (!detail) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Team league not found.' }, 404, cors);
      }
      return jsonResponse({ ok: true, detail }, 200, cors);
    }

    if (url.pathname.startsWith('/api/team-leagues/') && request.method === 'POST') {
      const restPath = url.pathname.slice('/api/team-leagues/'.length);
      const slashIdx = restPath.indexOf('/');
      if (slashIdx <= 0) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'League action not found.' }, 404, cors);
      }
      const leagueId = decodeURIComponent(restPath.slice(0, slashIdx)).trim();
      const subAction = restPath.slice(slashIdx + 1);
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);

      if (subAction === 'register') {
        if (typeof body.teamId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'teamId is required.' }, 400, cors);
        }
        const res = await getMatchmakerStub().leagueRegisterTeam(
          body.playerId,
          token,
          leagueId,
          body.teamId,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'withdraw') {
        if (typeof body.teamId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'teamId is required.' }, 400, cors);
        }
        const res = await getMatchmakerStub().leagueWithdrawTeam(
          body.playerId,
          token,
          leagueId,
          body.teamId,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'start') {
        const res = await getMatchmakerStub().leagueStart(body.playerId, token, leagueId);
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'resolve') {
        if (
          typeof body.encounterId !== 'string' ||
          typeof body.winnerTeamId !== 'string' ||
          (body.resolution !== 'walkover' && body.resolution !== 'disqualified')
        ) {
          return jsonResponse(
            { error: 'INVALID_INPUT', message: 'encounterId, winnerTeamId, and resolution are required.' },
            400,
            cors,
          );
        }
        const res = await getMatchmakerStub().championshipResolveEncounter(
          body.playerId,
          token,
          'league',
          leagueId,
          body.encounterId,
          {
            winnerTeamId: body.winnerTeamId,
            resolution: body.resolution,
            reason: typeof body.reason === 'string' ? body.reason : undefined,
          },
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      return jsonResponse({ error: 'NOT_FOUND', message: 'Unknown league endpoint.' }, 404, cors);
    }

    if (url.pathname === '/api/club-championships' && request.method === 'GET') {
      const championships = await getMatchmakerStub().championshipList({
        format: url.searchParams.get('format'),
        region: url.searchParams.get('region'),
        status: url.searchParams.get('status'),
      });
      return jsonResponse({ ok: true, championships }, 200, cors);
    }

    if (url.pathname === '/api/club-championships' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().championshipCreate(body.playerId, token, {
        title: body.title,
        description: body.description,
        format: body.format,
        region: body.region,
        seasonLabel: body.seasonLabel,
        matchFormat: body.matchFormat,
        ruleProfileId: body.ruleProfileId,
        calledShotsEnabled: body.calledShotsEnabled,
        maxTeams: body.maxTeams,
        swissRounds: body.swissRounds,
        groupSize: body.groupSize,
        groupAdvanceCount: body.groupAdvanceCount,
        prizeCoinsChampion: body.prizeCoinsChampion,
      });
      if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname.startsWith('/api/club-championships/') && request.method === 'GET') {
      const championshipId = decodeURIComponent(
        url.pathname.slice('/api/club-championships/'.length),
      ).trim();
      if (!championshipId || championshipId.includes('/')) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'Invalid championshipId.' }, 400, cors);
      }
      const viewerId = url.searchParams.get('playerId')?.trim() || null;
      const detail = await getMatchmakerStub().championshipGetDetail(championshipId, viewerId);
      if (!detail) {
        return jsonResponse(
          { error: 'NOT_FOUND', message: 'Club championship not found.' },
          404,
          cors,
        );
      }
      return jsonResponse({ ok: true, detail }, 200, cors);
    }

    if (url.pathname.startsWith('/api/club-championships/') && request.method === 'POST') {
      const restPath = url.pathname.slice('/api/club-championships/'.length);
      const slashIdx = restPath.indexOf('/');
      if (slashIdx <= 0) {
        return jsonResponse(
          { error: 'NOT_FOUND', message: 'Championship action not found.' },
          404,
          cors,
        );
      }
      const championshipId = decodeURIComponent(restPath.slice(0, slashIdx)).trim();
      const subAction = restPath.slice(slashIdx + 1);
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);

      if (subAction === 'register') {
        if (typeof body.teamId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'teamId is required.' }, 400, cors);
        }
        const res = await getMatchmakerStub().championshipRegisterTeam(
          body.playerId,
          token,
          championshipId,
          body.teamId,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'withdraw') {
        if (typeof body.teamId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'teamId is required.' }, 400, cors);
        }
        const res = await getMatchmakerStub().championshipWithdrawTeam(
          body.playerId,
          token,
          championshipId,
          body.teamId,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'start') {
        const res = await getMatchmakerStub().championshipStart(
          body.playerId,
          token,
          championshipId,
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      if (subAction === 'resolve') {
        if (
          typeof body.encounterId !== 'string' ||
          typeof body.winnerTeamId !== 'string' ||
          (body.resolution !== 'walkover' && body.resolution !== 'disqualified')
        ) {
          return jsonResponse(
            {
              error: 'INVALID_INPUT',
              message: 'encounterId, winnerTeamId, and resolution are required.',
            },
            400,
            cors,
          );
        }
        const res = await getMatchmakerStub().championshipResolveEncounter(
          body.playerId,
          token,
          'club_championship',
          championshipId,
          body.encounterId,
          {
            winnerTeamId: body.winnerTeamId,
            resolution: body.resolution,
            reason: typeof body.reason === 'string' ? body.reason : undefined,
          },
        );
        if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        return jsonResponse(res, 200, cors);
      }

      return jsonResponse({ error: 'NOT_FOUND', message: 'Unknown championship endpoint.' }, 404, cors);
    }

    if (url.pathname === '/api/club-competitions/lineup' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (
        !body ||
        typeof body.playerId !== 'string' ||
        (body.competitionKind !== 'league' && body.competitionKind !== 'club_championship') ||
        typeof body.competitionId !== 'string' ||
        typeof body.encounterId !== 'string' ||
        typeof body.teamId !== 'string' ||
        !Array.isArray(body.playerIds)
      ) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'Valid competitionKind, competitionId, encounterId, teamId, and playerIds are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().encounterSubmitLineup(body.playerId, token, {
        competitionKind: body.competitionKind,
        competitionId: body.competitionId,
        encounterId: body.encounterId,
        teamId: body.teamId,
        playerIds: body.playerIds.filter((id): id is string => typeof id === 'string'),
      });
      if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/club-competitions/substitute' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (
        !body ||
        typeof body.playerId !== 'string' ||
        typeof body.subMatchId !== 'string' ||
        typeof body.teamId !== 'string' ||
        typeof body.newPlayerId !== 'string'
      ) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId, subMatchId, teamId, and newPlayerId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().encounterSubstituteSlot(body.playerId, token, {
        subMatchId: body.subMatchId,
        teamId: body.teamId,
        newPlayerId: body.newPlayerId,
      });
      if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/club-competitions/submatches/join' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.subMatchId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and subMatchId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().subMatchJoin(
        body.playerId,
        token,
        body.subMatchId,
        typeof body.sessionId === 'string' ? body.sessionId : undefined,
      );
      if (!res.ok) return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/rankings/clubs-teams' && request.method === 'GET') {
      const region = url.searchParams.get('region') ?? 'ALL';
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30;
      const rankings = await getMatchmakerStub().clubLeaguesRankings({ region, limit });
      return jsonResponse({ ok: true, ...rankings }, 200, cors);
    }

    // ===== Phase 8 In-Game Store, Currency & Cosmetic Inventory API =====

    if (url.pathname === '/api/store/catalog' && request.method === 'GET') {
      return jsonResponse(
        {
          ok: true,
          currencyName: ECONOMY_CONFIG.currencyName,
          catalog: COSMETIC_CATALOG,
          dailySchedule: DAILY_LOGIN_SCHEDULE,
          economyConfig: ECONOMY_CONFIG,
        },
        200,
        cors,
      );
    }

    if (url.pathname === '/api/economy/wallet' && request.method === 'GET') {
      const playerId = (url.searchParams.get('playerId') ?? '').trim();
      const token = extractBearerToken(request);
      if (!playerId || !token) {
        return jsonResponse(
          { error: 'UNAUTHORIZED', message: 'Missing player credentials.' },
          401,
          cors,
        );
      }
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const overview = await new EconomyService(env.DB).getOverview(playerId);
        return jsonResponse({ ok: true, ...overview }, 200, cors);
      }
      const res = await getMatchmakerStub().economyGetOverview(playerId, token);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/economy/transactions' && request.method === 'GET') {
      const playerId = (url.searchParams.get('playerId') ?? '').trim();
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '40', 10) || 40;
      const token = extractBearerToken(request);
      if (!playerId || !token) {
        return jsonResponse(
          { error: 'UNAUTHORIZED', message: 'Missing player credentials.' },
          401,
          cors,
        );
      }
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const transactions = await new EconomyService(env.DB).getTransactions(playerId, limit);
        return jsonResponse({ ok: true, transactions }, 200, cors);
      }
      const res = await getMatchmakerStub().economyGetTransactions(playerId, token, limit);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/economy/purchase' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.itemId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and itemId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(body.playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const res = await new EconomyService(env.DB).purchaseItem(body.playerId.trim(), body.itemId);
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }
      const res = await getMatchmakerStub().economyPurchaseItem(body.playerId, token, body.itemId);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/economy/equip' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.category !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and category are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(body.playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const res = await new EconomyService(env.DB).equipItem(
          body.playerId.trim(),
          body.category,
          body.itemId ?? null,
        );
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        await getMatchmakerStub().syncPlayerCosmeticsInRoom(body.playerId.trim(), res.equipped);
        return jsonResponse(res, 200, cors);
      }
      const res = await getMatchmakerStub().economyEquipItem(
        body.playerId,
        token,
        body.category,
        body.itemId ?? null,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/economy/daily-claim' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId is required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(body.playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const res = await new EconomyService(env.DB).claimDailyReward(body.playerId.trim());
        if (!res.ok) {
          return jsonResponse(
            { error: res.code, message: res.message, nextClaimAtMs: res.nextClaimAtMs },
            res.status,
            cors,
          );
        }
        return jsonResponse(res, 200, cors);
      }
      const res = await getMatchmakerStub().economyClaimDaily(body.playerId, token);
      if (!res.ok) {
        return jsonResponse(
          {
            error: res.code,
            message: res.message,
            nextClaimAtMs: 'nextClaimAtMs' in res ? res.nextClaimAtMs : undefined,
          },
          res.status,
          cors,
        );
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/economy/ai-reward' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId is required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const payload: Partial<AiMatchRewardRequest> = {
        clientMatchId: typeof body.clientMatchId === 'string' ? body.clientMatchId : '',
        difficulty: body.difficulty as AiMatchRewardRequest['difficulty'],
        won: Boolean(body.won),
        totalShots: Number(body.totalShots ?? 0),
        ballsPocketed: Number(body.ballsPocketed ?? 0),
        durationSec: Number(body.durationSec ?? 0),
      };
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(body.playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const res = await new EconomyService(env.DB).claimAiMatchReward(body.playerId.trim(), payload);
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }
      const res = await getMatchmakerStub().economyClaimAiReward(body.playerId, token, payload);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    // ===== Phase 11 Daily Missions, Weekly Challenges & Battle Pass API =====

    if (url.pathname === '/api/battle-pass/overview' && request.method === 'GET') {
      const playerId = (url.searchParams.get('playerId') ?? '').trim();
      const token = extractBearerToken(request);
      if (!playerId || !token) {
        return jsonResponse(
          { error: 'UNAUTHORIZED', message: 'Missing player credentials.' },
          401,
          cors,
        );
      }
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const overview = await new BattlePassService(env.DB).getOverview(playerId);
        return jsonResponse({ ok: true, overview }, 200, cors);
      }
      const res = await getMatchmakerStub().battlePassGetOverview(playerId, token);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/battle-pass/missions/claim' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.missionId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and missionId are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const input = {
        missionId: body.missionId.trim(),
        cadence:
          body.cadence === 'daily' || body.cadence === 'weekly'
            ? (body.cadence as MissionCadence)
            : undefined,
        periodKey: typeof body.periodKey === 'string' ? body.periodKey.trim() : undefined,
      };
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(body.playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const res = await new BattlePassService(env.DB).claimMission(body.playerId.trim(), input);
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }
      const res = await getMatchmakerStub().battlePassClaimMission(body.playerId, token, input);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/battle-pass/premium/unlock' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId is required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(body.playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const res = await new BattlePassService(env.DB).unlockPremium(body.playerId.trim());
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }
      const res = await getMatchmakerStub().battlePassUnlockPremium(body.playerId, token);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/battle-pass/tiers/claim' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (
        !body ||
        typeof body.playerId !== 'string' ||
        typeof body.level !== 'number' ||
        (body.track !== 'free' && body.track !== 'premium')
      ) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId, level, and track (free|premium) are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const input = {
        level: Math.floor(body.level),
        track: body.track as BattlePassTrack,
      };
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(body.playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const res = await new BattlePassService(env.DB).claimTierReward(body.playerId.trim(), input);
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }
      const res = await getMatchmakerStub().battlePassClaimTier(body.playerId, token, input);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/battle-pass/claim-all' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId is required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(body.playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const res = await new BattlePassService(env.DB).claimAllAvailable(body.playerId.trim());
        return jsonResponse(res, 200, cors);
      }
      const res = await getMatchmakerStub().battlePassClaimAll(body.playerId, token);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/battle-pass/ai-match' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId is required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const payload: Partial<AiMatchProgressRequest> = {
        clientMatchId: typeof body.clientMatchId === 'string' ? body.clientMatchId : '',
        difficulty: body.difficulty as AiMatchProgressRequest['difficulty'],
        won: Boolean(body.won),
        totalShots: Number(body.totalShots ?? 0),
        ballsPocketed: Number(body.ballsPocketed ?? 0),
        foulsCommitted: Number(body.foulsCommitted ?? 0),
        legalEightBallWin: Boolean(body.legalEightBallWin),
        durationSec: Number(body.durationSec ?? 0),
      };
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(body.playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const res = await new BattlePassService(env.DB).recordAiMatchProgress(body.playerId.trim(), payload);
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }
      const res = await getMatchmakerStub().battlePassRecordAiMatch(body.playerId, token, payload);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    // ===== Phase 9 Global Tournaments & Championships API =====

    if (url.pathname === '/api/tournaments' && request.method === 'GET') {
      const viewerId = url.searchParams.get('playerId')?.trim() || null;
      const type = url.searchParams.get('type')?.trim() || null;
      const status = url.searchParams.get('status')?.trim() || null;
      const adminCheck = verifyTournamentAdmin(request, env);
      const tournaments = await getMatchmakerStub().tournamentList({
        viewerId,
        type,
        status,
        includePrivateForAdmin: adminCheck.ok,
      });
      return jsonResponse(
        {
          ok: true,
          tournaments,
          trophyCatalog: TOURNAMENT_TROPHY_CATALOG,
        },
        200,
        cors,
      );
    }

    if (url.pathname === '/api/tournaments/leaderboard' && request.method === 'GET') {
      const seasonKey = url.searchParams.get('seasonKey')?.trim() || null;
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '25', 10) || 25;
      const entries = await getMatchmakerStub().tournamentLeaderboard({ seasonKey, limit });
      return jsonResponse({ ok: true, seasonKey: seasonKey ?? 'ALL', entries }, 200, cors);
    }

    if (url.pathname.startsWith('/api/tournaments/stats/') && request.method === 'GET') {
      const targetId = decodeURIComponent(
        url.pathname.slice('/api/tournaments/stats/'.length),
      ).trim();
      if (!targetId) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const stats = await getMatchmakerStub().tournamentPlayerStats(targetId);
      return jsonResponse({ ok: true, stats, trophyCatalog: TOURNAMENT_TROPHY_CATALOG }, 200, cors);
    }

    if (url.pathname === '/api/tournaments/private' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string') {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().tournamentCreatePrivate(
        body.playerId,
        token,
        body as Partial<CreateTournamentInput>,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/tournaments/join-code' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (
        !body ||
        typeof body.playerId !== 'string' ||
        typeof body.inviteCode !== 'string'
      ) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and inviteCode are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().tournamentJoinByCode(
        body.playerId,
        token,
        body.inviteCode,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    // Admin tournament routes (server-verified secret required; never exposed in frontend)
    if (url.pathname === '/api/admin/tournaments' && request.method === 'POST') {
      const adminAuth = verifyTournamentAdmin(request, env);
      if (!adminAuth.ok) {
        return jsonResponse({ error: adminAuth.code, message: adminAuth.message }, adminAuth.status, cors);
      }
      const body = await readJsonBody(request);
      if (!body) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'Invalid JSON request body.' }, 400, cors);
      }
      const res = await getMatchmakerStub().tournamentAdminCreate(
        body as Partial<CreateTournamentInput>,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname.startsWith('/api/admin/tournaments/')) {
      const adminAuth = verifyTournamentAdmin(request, env);
      if (!adminAuth.ok) {
        return jsonResponse({ error: adminAuth.code, message: adminAuth.message }, adminAuth.status, cors);
      }
      const rest = url.pathname.slice('/api/admin/tournaments/'.length);
      const parts = rest.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

      if (parts.length === 2 && parts[1] === 'start' && request.method === 'POST') {
        const res = await getMatchmakerStub().tournamentStart(parts[0], { isAdmin: true });
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }

      if (parts.length === 2 && parts[1] === 'cancel' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const res = await getMatchmakerStub().tournamentCancel(parts[0], {
          isAdmin: true,
          reason: typeof body?.reason === 'string' ? body.reason : undefined,
        });
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }

      if (parts.length === 2 && parts[1] === 'process-timers' && request.method === 'POST') {
        const res = await getMatchmakerStub().tournamentProcessTimers(parts[0]);
        return jsonResponse({ ok: true, ...res }, 200, cors);
      }

      if (
        parts.length === 4 &&
        parts[1] === 'matches' &&
        parts[3] === 'resolve' &&
        request.method === 'POST'
      ) {
        const body = await readJsonBody(request);
        if (!body || typeof body.winnerId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'winnerId is required.' }, 400, cors);
        }
        const res = await getMatchmakerStub().tournamentAdminResolveMatch(parts[0], parts[2], {
          winnerId: body.winnerId,
          resolutionType:
            typeof body.resolutionType === 'string'
              ? (body.resolutionType as TournamentMatchResolutionType)
              : 'admin_resolved',
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        });
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }
    }

    if (url.pathname.startsWith('/api/tournaments/')) {
      const rest = url.pathname.slice('/api/tournaments/'.length);
      const parts = rest.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

      if (parts.length === 1 && request.method === 'GET') {
        const viewerId = url.searchParams.get('playerId')?.trim() || null;
        const adminCheck = verifyTournamentAdmin(request, env);
        const detail = await getMatchmakerStub().tournamentDetail(parts[0], {
          viewerId,
          isAdmin: adminCheck.ok,
        });
        if (!detail) {
          return jsonResponse({ error: 'NOT_FOUND', message: 'Tournament not found.' }, 404, cors);
        }
        return jsonResponse(
          { ok: true, ...detail, trophyCatalog: TOURNAMENT_TROPHY_CATALOG },
          200,
          cors,
        );
      }

      if (parts.length === 2 && parts[1] === 'register' && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (!body || typeof body.playerId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
        }
        const token = extractBearerToken(request, body);
        const res = await getMatchmakerStub().tournamentRegister(
          body.playerId,
          token,
          parts[0],
          typeof body.inviteCode === 'string' ? body.inviteCode : undefined,
        );
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }

      if (parts.length === 2 && parts[1] === 'withdraw' && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (!body || typeof body.playerId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
        }
        const token = extractBearerToken(request, body);
        const res = await getMatchmakerStub().tournamentWithdraw(body.playerId, token, parts[0]);
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }

      if (parts.length === 2 && parts[1] === 'start' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const adminCheck = verifyTournamentAdmin(request, env);
        if (adminCheck.ok) {
          const res = await getMatchmakerStub().tournamentStart(parts[0], { isAdmin: true });
          if (!res.ok) {
            return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
          }
          return jsonResponse(res, 200, cors);
        }
        if (!body || typeof body.playerId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
        }
        const token = extractBearerToken(request, body);
        const res = await getMatchmakerStub().tournamentStart(parts[0], {
          playerId: body.playerId,
          playerToken: token,
          isAdmin: false,
        });
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }

      if (parts.length === 2 && parts[1] === 'cancel' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const adminCheck = verifyTournamentAdmin(request, env);
        if (adminCheck.ok) {
          const res = await getMatchmakerStub().tournamentCancel(parts[0], {
            isAdmin: true,
            reason: typeof body?.reason === 'string' ? body.reason : undefined,
          });
          if (!res.ok) {
            return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
          }
          return jsonResponse(res, 200, cors);
        }
        if (!body || typeof body.playerId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
        }
        const token = extractBearerToken(request, body);
        const res = await getMatchmakerStub().tournamentCancel(parts[0], {
          playerId: body.playerId,
          playerToken: token,
          isAdmin: false,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        });
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }

      if (
        parts.length === 4 &&
        parts[1] === 'matches' &&
        parts[3] === 'join' &&
        request.method === 'POST'
      ) {
        const body = await readJsonBody(request);
        if (!body || typeof body.playerId !== 'string') {
          return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
        }
        const token = extractBearerToken(request, body);
        const res = await getMatchmakerStub().tournamentJoinMatch(
          body.playerId,
          token,
          parts[0],
          parts[2],
          typeof body.sessionId === 'string' ? body.sessionId : null,
        );
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }
    }

    // ===== Phase 10 Ranked Seasons, Fair Play & Anti-Cheat Moderation API =====

    if (url.pathname === '/api/ranked/seasons' && request.method === 'GET') {
      const data = env.DB
        ? await new RankedSeasonService(env.DB).listSeasons()
        : await getMatchmakerStub().rankedGetSeasons();
      return jsonResponse({ ok: true, ...data }, 200, cors);
    }

    if (url.pathname.startsWith('/api/ranked/standing/') && request.method === 'GET') {
      const targetPlayerId = decodeURIComponent(
        url.pathname.slice('/api/ranked/standing/'.length),
      ).trim();
      if (!targetPlayerId) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'playerId is required.' }, 400, cors);
      }
      const seasonId = url.searchParams.get('seasonId')?.trim() || null;
      const standing = env.DB
        ? await new RankedSeasonService(env.DB).getPlayerSeasonStanding(targetPlayerId, seasonId)
        : await getMatchmakerStub().rankedGetStanding(targetPlayerId, seasonId);
      return jsonResponse({ ok: true, standing }, 200, cors);
    }

    if (url.pathname === '/api/moderation/status' && request.method === 'GET') {
      const playerId = (url.searchParams.get('playerId') ?? '').trim();
      const token = extractBearerToken(request);
      if (!playerId || !token) {
        return jsonResponse(
          { error: 'UNAUTHORIZED', message: 'Missing player credentials.' },
          401,
          cors,
        );
      }
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const moderation = await new AntiCheatService(env.DB).getPlayerModerationStatus(playerId);
        return jsonResponse({ ok: true, moderation }, 200, cors);
      }
      const res = await getMatchmakerStub().moderationGetStatus(playerId, token);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/moderation/appeals' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (
        !body ||
        typeof body.playerId !== 'string' ||
        typeof body.penaltyId !== 'string' ||
        typeof body.message !== 'string'
      ) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId, penaltyId, and message are required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      if (env.DB) {
        const valid = await new D1ProgressionService(env.DB).verifyPlayerToken(body.playerId, token);
        if (!valid) {
          return jsonResponse({ error: 'UNAUTHORIZED', message: 'Invalid player credentials.' }, 401, cors);
        }
        const res = await new AntiCheatService(env.DB).submitAppeal({
          playerId: body.playerId.trim(),
          penaltyId: body.penaltyId.trim(),
          message: body.message,
        });
        if (!res.ok) {
          return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
        }
        return jsonResponse(res, 200, cors);
      }
      const res = await getMatchmakerStub().moderationSubmitAppeal(
        body.playerId.trim(),
        token,
        body.penaltyId.trim(),
        body.message,
      );
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    // Admin season & moderation endpoints (guarded by server-verified secret)
    if (url.pathname === '/api/admin/seasons/rollover' && request.method === 'POST') {
      const adminAuth = verifyAdminRequest(request, env);
      if (!adminAuth.ok) {
        return jsonResponse({ error: adminAuth.code, message: adminAuth.message }, adminAuth.status, cors);
      }
      const body = await readJsonBody(request);
      const opts = {
        newSeasonName: typeof body?.newSeasonName === 'string' ? body.newSeasonName : undefined,
        newDurationDays:
          typeof body?.newDurationDays === 'number' ? body.newDurationDays : undefined,
        softResetAnchor:
          typeof body?.softResetAnchor === 'number' ? body.softResetAnchor : undefined,
        softResetFactor:
          typeof body?.softResetFactor === 'number' ? body.softResetFactor : undefined,
      };
      const result = env.DB
        ? await new RankedSeasonService(env.DB).rolloverSeason(opts)
        : await getMatchmakerStub().rankedRolloverSeason(opts);
      return jsonResponse({ ok: true, ...result }, 200, cors);
    }

    if (url.pathname === '/api/admin/moderation/flags' && request.method === 'GET') {
      const adminAuth = verifyAdminRequest(request, env);
      if (!adminAuth.ok) {
        return jsonResponse({ error: adminAuth.code, message: adminAuth.message }, adminAuth.status, cors);
      }
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
      const queue = env.DB
        ? await new AntiCheatService(env.DB).getAdminModerationQueue(limit)
        : await getMatchmakerStub().moderationAdminQueue(limit);
      return jsonResponse({ ok: true, ...queue }, 200, cors);
    }

    if (url.pathname === '/api/admin/moderation/penalties' && request.method === 'POST') {
      const adminAuth = verifyAdminRequest(request, env);
      if (!adminAuth.ok) {
        return jsonResponse({ error: adminAuth.code, message: adminAuth.message }, adminAuth.status, cors);
      }
      const body = await readJsonBody(request);
      if (!body || typeof body.playerId !== 'string' || typeof body.penaltyType !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'playerId and penaltyType are required.' },
          400,
          cors,
        );
      }
      const params = {
        playerId: body.playerId.trim(),
        penaltyType: body.penaltyType as PenaltyType,
        reason: typeof body.reason === 'string' ? body.reason : 'Fair play enforcement.',
        issuedBy: typeof body.issuedBy === 'string' ? body.issuedBy : 'admin',
        isAdmin: true,
        durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
      };
      const res = env.DB
        ? await new AntiCheatService(env.DB).issuePenalty(params)
        : await getMatchmakerStub().moderationIssuePenalty(params);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (
      url.pathname.startsWith('/api/admin/moderation/penalties/') &&
      url.pathname.endsWith('/revoke') &&
      request.method === 'POST'
    ) {
      const adminAuth = verifyAdminRequest(request, env);
      if (!adminAuth.ok) {
        return jsonResponse({ error: adminAuth.code, message: adminAuth.message }, adminAuth.status, cors);
      }
      const inner = url.pathname.slice(
        '/api/admin/moderation/penalties/'.length,
        url.pathname.length - '/revoke'.length,
      );
      const penaltyId = decodeURIComponent(inner).trim();
      const body = await readJsonBody(request);
      const params = {
        penaltyId,
        adminActor: typeof body?.adminActor === 'string' ? body.adminActor : 'admin',
        notes: typeof body?.notes === 'string' ? body.notes : undefined,
      };
      const res = env.DB
        ? await new AntiCheatService(env.DB).revokePenalty(params)
        : await getMatchmakerStub().moderationRevokePenalty(params);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (
      url.pathname.startsWith('/api/admin/moderation/appeals/') &&
      url.pathname.endsWith('/review') &&
      request.method === 'POST'
    ) {
      const adminAuth = verifyAdminRequest(request, env);
      if (!adminAuth.ok) {
        return jsonResponse({ error: adminAuth.code, message: adminAuth.message }, adminAuth.status, cors);
      }
      const inner = url.pathname.slice(
        '/api/admin/moderation/appeals/'.length,
        url.pathname.length - '/review'.length,
      );
      const appealId = decodeURIComponent(inner).trim();
      const body = await readJsonBody(request);
      if (!body || (body.decision !== 'approved' && body.decision !== 'rejected')) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'decision must be approved or rejected.' },
          400,
          cors,
        );
      }
      const params = {
        appealId,
        adminActor: typeof body.adminActor === 'string' ? body.adminActor : 'admin',
        decision: body.decision as 'approved' | 'rejected',
        adminNotes: typeof body.adminNotes === 'string' ? body.adminNotes : undefined,
      };
      const res = env.DB
        ? await new AntiCheatService(env.DB).reviewAppeal(params)
        : await getMatchmakerStub().moderationReviewAppeal(params);
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/admin/battle-pass/rollover' && request.method === 'POST') {
      const adminAuth = verifyAdminRequest(request, env);
      if (!adminAuth.ok) {
        return jsonResponse({ error: adminAuth.code, message: adminAuth.message }, adminAuth.status, cors);
      }
      const body = (await readJsonBody(request)) ?? {};
      const options = {
        nowMs: typeof body.nowMs === 'number' ? body.nowMs : undefined,
        newSeasonName: typeof body.newSeasonName === 'string' ? body.newSeasonName : undefined,
        newSeasonTheme: typeof body.newSeasonTheme === 'string' ? body.newSeasonTheme : undefined,
        durationDays: typeof body.durationDays === 'number' ? body.durationDays : undefined,
        premiumPriceCoins:
          typeof body.premiumPriceCoins === 'number' ? body.premiumPriceCoins : undefined,
      };
      const result = env.DB
        ? await new BattlePassService(env.DB).adminRolloverSeason(options)
        : await getMatchmakerStub().battlePassAdminRollover(options);
      return jsonResponse({ ok: true, ...result }, 200, cors);
    }

    // ===== Phase 14 Spectator & Live Broadcast API =====

    if (url.pathname === '/api/spectate/matches' && request.method === 'GET') {
      const rawType = url.searchParams.get('matchType')?.trim();
      const matchType: OnlineMatchType | 'all' | null =
        rawType === 'quick' ||
        rawType === 'ranked' ||
        rawType === 'tournament' ||
        rawType === 'private' ||
        rawType === 'all'
          ? rawType
          : null;
      const status = url.searchParams.get('status')?.trim() || null;
      const tournamentId = url.searchParams.get('tournamentId')?.trim() || null;
      const matches = await getMatchmakerStub().listSpectatableMatches({
        matchType,
        status,
        tournamentId,
      });
      return jsonResponse({ ok: true, matches }, 200, cors);
    }

    if (url.pathname === '/api/spectate/resolve' && request.method === 'GET') {
      const roomId = url.searchParams.get('roomId')?.trim() || undefined;
      const roomCode = (url.searchParams.get('code') ?? url.searchParams.get('roomCode'))?.trim() || undefined;
      const targetPlayerId = url.searchParams.get('targetPlayerId')?.trim() || undefined;
      const shareToken = (url.searchParams.get('token') ?? url.searchParams.get('shareToken'))?.trim() || undefined;
      if (!roomId && !roomCode && !targetPlayerId) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'roomId, code, or targetPlayerId is required.' },
          400,
          cors,
        );
      }
      const res = await getMatchmakerStub().resolveSpectateTarget({
        roomId,
        roomCode,
        targetPlayerId,
        shareToken,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse({ ok: true, match: res.match }, 200, cors);
    }

    if (url.pathname === '/api/spectate/join' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body) {
        return jsonResponse({ error: 'INVALID_INPUT', message: 'Invalid JSON request body.' }, 400, cors);
      }
      const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : undefined;
      const roomCode = typeof body.roomCode === 'string' ? body.roomCode.trim() : undefined;
      const targetPlayerId =
        typeof body.targetPlayerId === 'string' ? body.targetPlayerId.trim() : undefined;
      if (!roomId && !roomCode && !targetPlayerId) {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'roomId, roomCode, or targetPlayerId is required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().spectateJoin({
        roomId,
        roomCode,
        targetPlayerId,
        shareToken: typeof body.shareToken === 'string' ? body.shareToken.trim() : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined,
        playerId: typeof body.playerId === 'string' ? body.playerId.trim() : undefined,
        playerToken: token || undefined,
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        avatarId: typeof body.avatarId === 'string' ? (body.avatarId as never) : undefined,
      });
      if (!res.ok) {
        return jsonResponse({ error: res.code, message: res.message }, res.status, cors);
      }
      return jsonResponse(res, 200, cors);
    }

    if (url.pathname === '/api/spectate/leave' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body.roomId !== 'string') {
        return jsonResponse(
          { error: 'INVALID_INPUT', message: 'roomId is required.' },
          400,
          cors,
        );
      }
      const token = extractBearerToken(request, body);
      const res = await getMatchmakerStub().spectateLeave({
        roomId: body.roomId,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        playerId: typeof body.playerId === 'string' ? body.playerId : undefined,
        playerToken: token || undefined,
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
