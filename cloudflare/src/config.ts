import { ONLINE_AVATARS, type OnlineAvatarId } from '../../src/multiplayer/shared/protocol';
import type { MatchmakerDurableObject } from './MatchmakerDurableObject';
import type { PoolRoomDurableObject } from './PoolRoomDurableObject';

export interface Env {
  MATCHMAKER: DurableObjectNamespace<MatchmakerDurableObject>;
  POOL_ROOM: DurableObjectNamespace<PoolRoomDurableObject>;
  CORS_ORIGIN?: string;
  WS_HEARTBEAT_MS?: string;
  RECONNECT_GRACE_MS?: string;
  MATCHMAKING_TIMEOUT_MS?: string;
  ROOM_TTL_MS?: string;
  RATE_LIMIT_MAX_MSG_PER_SEC?: string;
  PHYSICS_BROADCAST_HZ?: string;
  MAX_LATENCY_SPREAD_MS?: string;
}

export interface WorkerRuntimeConfig {
  corsOrigin: string;
  wsHeartbeatMs: number;
  reconnectGraceMs: number;
  matchmakingTimeoutMs: number;
  roomTtlMs: number;
  rateLimitMaxMsgPerSec: number;
  physicsBroadcastHz: number;
  maxLatencySpreadMs: number;
}

const VALID_AVATARS = new Set<OnlineAvatarId>(ONLINE_AVATARS.map((a) => a.id));

function readIntVar(raw: string | undefined, fallback: number, min = 1): number {
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

export function sanitizeCorsOrigin(raw: string | undefined): string {
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
  originHeader: string | null | undefined,
  corsOrigin: string,
  options?: { allowDevLocalhost?: boolean },
): boolean {
  const allowed = parseAllowedOrigins(corsOrigin);
  if (allowed.length === 0 || allowed.includes('*')) {
    return true;
  }
  if (!originHeader) {
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

export function buildCorsHeaders(
  originHeader: string | null,
  corsOrigin: string,
  options?: { allowDevLocalhost?: boolean },
): Record<string, string> {
  const allowed = parseAllowedOrigins(corsOrigin);
  const allowAll = allowed.length === 0 || allowed.includes('*');

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };

  if (allowAll) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (originHeader && isOriginAllowed(originHeader, corsOrigin, options)) {
    headers['Access-Control-Allow-Origin'] = normalizeOriginValue(originHeader);
    headers['Vary'] = 'Origin';
  } else {
    headers['Vary'] = 'Origin';
  }

  return headers;
}

export function loadWorkerConfig(env: Env): WorkerRuntimeConfig {
  return {
    corsOrigin: sanitizeCorsOrigin(env.CORS_ORIGIN),
    wsHeartbeatMs: readIntVar(env.WS_HEARTBEAT_MS, 15000, 1000),
    reconnectGraceMs: readIntVar(env.RECONNECT_GRACE_MS, 30000, 1000),
    matchmakingTimeoutMs: readIntVar(env.MATCHMAKING_TIMEOUT_MS, 45000, 1000),
    roomTtlMs: readIntVar(env.ROOM_TTL_MS, 900000, 5000),
    rateLimitMaxMsgPerSec: readIntVar(env.RATE_LIMIT_MAX_MSG_PER_SEC, 45, 5),
    physicsBroadcastHz: readIntVar(env.PHYSICS_BROADCAST_HZ, 35, 10),
    maxLatencySpreadMs: readIntVar(env.MAX_LATENCY_SPREAD_MS, 250, 25),
  };
}

export function sanitizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Player';
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .trim()
    .slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'Player';
}

export function sanitizeAvatarId(raw: unknown): OnlineAvatarId {
  if (typeof raw === 'string' && VALID_AVATARS.has(raw as OnlineAvatarId)) {
    return raw as OnlineAvatarId;
  }
  return 'cue_gold';
}

export function clampLatency(ms: unknown): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 35;
  return Math.max(1, Math.min(2000, Math.round(ms)));
}

export function randomHexToken(byteLen = 24): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}
