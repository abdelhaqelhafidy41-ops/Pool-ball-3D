export interface ServerConfig {
  port: number;
  corsOrigin: string;
  wsHeartbeatMs: number;
  reconnectGraceMs: number;
  matchmakingTimeoutMs: number;
  roomTtlMs: number;
  rateLimitMaxMsgPerSec: number;
  physicsBroadcastHz: number;
  maxLatencySpreadMs: number;
}

function readIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function normalizeOriginValue(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim()
    .replace(/[^\t \x21-\x7e\x80-\xff]/g, '');
  if (!cleaned || cleaned === '*') return cleaned;
  return cleaned.replace(/\/+$/, '');
}

function sanitizeCorsOrigin(raw: string | undefined): string {
  if (!raw) return '*';
  const parts = raw
    .split(',')
    .map((part) => normalizeOriginValue(part))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(',') : '*';
}

export function parseAllowedOrigins(corsOrigin: string): string[] {
  return corsOrigin
    .split(',')
    .map((o) => normalizeOriginValue(o))
    .filter(Boolean);
}

export function isLocalhostOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

export function isOriginAllowed(
  originHeader: string | undefined,
  corsOrigin: string,
  options?: { allowDevLocalhost?: boolean },
): boolean {
  const allowed = parseAllowedOrigins(corsOrigin);
  if (allowed.length === 0 || allowed.includes('*')) {
    return true;
  }
  if (!originHeader) {
    // Allow non-browser probes, health checks, and server-side tools with no Origin header
    return true;
  }
  const normalized = normalizeOriginValue(originHeader);
  if (!normalized) return false;
  if (allowed.includes(normalized)) {
    return true;
  }
  if (options?.allowDevLocalhost && isLocalhostOrigin(normalized)) {
    return true;
  }
  return false;
}

export function loadServerConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    port: overrides?.port ?? readIntEnv('PORT', 3000, 1),
    corsOrigin: sanitizeCorsOrigin(overrides?.corsOrigin ?? process.env.CORS_ORIGIN),
    wsHeartbeatMs: overrides?.wsHeartbeatMs ?? readIntEnv('WS_HEARTBEAT_MS', 15000, 1000),
    reconnectGraceMs: overrides?.reconnectGraceMs ?? readIntEnv('RECONNECT_GRACE_MS', 30000, 1000),
    matchmakingTimeoutMs:
      overrides?.matchmakingTimeoutMs ?? readIntEnv('MATCHMAKING_TIMEOUT_MS', 45000, 1000),
    roomTtlMs: overrides?.roomTtlMs ?? readIntEnv('ROOM_TTL_MS', 900000, 5000),
    rateLimitMaxMsgPerSec:
      overrides?.rateLimitMaxMsgPerSec ?? readIntEnv('RATE_LIMIT_MAX_MSG_PER_SEC', 45, 5),
    physicsBroadcastHz:
      overrides?.physicsBroadcastHz ?? readIntEnv('PHYSICS_BROADCAST_HZ', 35, 10),
    maxLatencySpreadMs:
      overrides?.maxLatencySpreadMs ?? readIntEnv('MAX_LATENCY_SPREAD_MS', 250, 25),
  };
}
