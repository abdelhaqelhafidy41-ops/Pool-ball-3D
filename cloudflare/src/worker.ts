import {
  buildCorsHeaders,
  isOriginAllowed,
  loadWorkerConfig,
  type Env,
} from './config';
import { MatchmakerDurableObject } from './MatchmakerDurableObject';
import { PoolRoomDurableObject } from './PoolRoomDurableObject';

export { MatchmakerDurableObject, PoolRoomDurableObject };

const ROOM_ID_PATTERN = /^room_[a-zA-Z0-9_-]{4,40}$/;

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

    if (url.pathname === '/health' || url.pathname === '/api/health') {
      const matchmakerStub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
      const stats = await matchmakerStub.getHealthAndStats();
      return jsonResponse(
        {
          ok: true,
          status: 'healthy',
          runtime: 'cloudflare-workers',
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
      const history = await matchmakerStub.getHistory(30);
      return jsonResponse({ history }, 200, cors);
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
