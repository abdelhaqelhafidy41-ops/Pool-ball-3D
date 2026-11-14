import type { RuleProfileId } from '../../src/game/rules/types';
import { isValidPlayerIdFormat, sanitizeAvatarId } from '../../src/multiplayer/shared/authCrypto';
import type { MultiplayerErrorCode, OnlineAvatarId } from '../../src/multiplayer/shared/protocol';
import {
  isValidReportReason,
  orderedPlayerPair,
  sanitizeChatText,
  sanitizeReportDetails,
  SOCIAL_LIMITS,
  type BlockedPlayerRecord,
  type DirectMessageRecord,
  type FriendRecord,
  type FriendRequestAction,
  type FriendRequestRecord,
  type ManualPresenceStatus,
  type MatchInvitationRecord,
  type MatchInviteAction,
  type MatchInviteStatus,
  type PresenceStatus,
  type SocialOverviewPayload,
  type SocialRelationship,
  type SocialReportContext,
  type SocialSearchPlayerItem,
} from '../../src/multiplayer/shared/social';
import { D1ProgressionService, type ProgressionSqlDb } from './D1ProgressionService';

export type SocialError = {
  ok: false;
  status: number;
  code: MultiplayerErrorCode;
  message: string;
};

const SOCIAL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_low_id TEXT NOT NULL,
    player_high_id TEXT NOT NULL,
    requester_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    accepted_at_ms INTEGER,
    UNIQUE(player_low_id, player_high_id)
  )`,
  `CREATE TABLE IF NOT EXISTS player_blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  )`,
  `CREATE TABLE IF NOT EXISTS match_invitations (
    invite_id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    room_id TEXT,
    room_code TEXT,
    rule_profile_id TEXT NOT NULL DEFAULT 'casual',
    called_shots_enabled INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    responded_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS direct_messages (
    message_id TEXT PRIMARY KEY,
    pair_low_id TEXT NOT NULL,
    pair_high_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    read_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS player_presence (
    player_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'offline',
    manual_status TEXT,
    active_room_id TEXT,
    last_heartbeat_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS player_reports (
    report_id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL,
    reported_id TEXT NOT NULL,
    context_type TEXT NOT NULL,
    context_id TEXT,
    reason TEXT NOT NULL,
    details TEXT,
    excerpt TEXT,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships (requester_id, status, updated_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_recipient ON friendships (recipient_id, status, updated_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON player_blocks (blocked_id, blocker_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invites_recipient ON match_invitations (recipient_id, status, expires_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_invites_sender ON match_invitations (sender_id, status, expires_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_invites_room ON match_invitations (room_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages (pair_low_id, pair_high_id, created_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dm_unread ON direct_messages (recipient_id, read_at_ms, created_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_presence_expiry ON player_presence (status, expires_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_reported ON player_reports (reported_id, created_at_ms DESC)`,
];

interface ChatSpamBucket {
  timestamps: number[];
  lastText: string;
  lastTextAt: number;
}

const chatSpamBuckets = new Map<string, ChatSpamBucket>();

export function checkChatAntiSpam(
  playerId: string,
  text: string,
  now = Date.now(),
): { ok: true } | { ok: false; message: string } {
  let bucket = chatSpamBuckets.get(playerId);
  if (!bucket) {
    bucket = { timestamps: [], lastText: '', lastTextAt: 0 };
    chatSpamBuckets.set(playerId, bucket);
  }

  const cutoff = now - SOCIAL_LIMITS.chatBurstWindowMs;
  while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
    bucket.timestamps.shift();
  }

  const lastAt = bucket.timestamps.length > 0 ? bucket.timestamps[bucket.timestamps.length - 1] : 0;
  if (lastAt > 0 && now - lastAt < SOCIAL_LIMITS.chatMinIntervalMs) {
    return { ok: false, message: 'You are sending messages too quickly. Please wait a moment.' };
  }
  if (bucket.timestamps.length >= SOCIAL_LIMITS.chatBurstMaxCount) {
    return {
      ok: false,
      message: 'Message rate limit reached. Slow down before sending more messages.',
    };
  }
  if (
    bucket.lastText === text.toLowerCase() &&
    now - bucket.lastTextAt < SOCIAL_LIMITS.chatDuplicateWindowMs
  ) {
    return {
      ok: false,
      message: 'Duplicate message blocked. Avoid repeating identical messages.',
    };
  }

  bucket.timestamps.push(now);
  bucket.lastText = text.toLowerCase();
  bucket.lastTextAt = now;
  if (chatSpamBuckets.size > 4000) {
    chatSpamBuckets.clear();
  }
  return { ok: true };
}

export class SocialService {
  private static readonly bootstrappedDbs = new WeakSet<object>();

  constructor(private readonly db: ProgressionSqlDb | D1Database | undefined) {}

  private async ensureSchema(): Promise<ProgressionSqlDb> {
    if (!this.db) {
      throw new Error('Social database is not configured.');
    }
    const db = this.db as unknown as ProgressionSqlDb;
    if (!SocialService.bootstrappedDbs.has(this.db)) {
      // Ensure Phase 5 progression tables (`players`) exist before social queries
      await new D1ProgressionService(this.db).searchPlayers('', 1);
      for (const stmt of SOCIAL_SCHEMA_STATEMENTS) {
        await db.prepare(stmt).run();
      }
      SocialService.bootstrappedDbs.add(this.db);
    }
    return db;
  }

  private async getPlayerRow(db: ProgressionSqlDb, playerId: string) {
    if (!isValidPlayerIdFormat(playerId)) return null;
    return db
      .prepare(
        'SELECT player_id, username, display_name, avatar_id, elo, level, wins, total_matches FROM players WHERE player_id = ? LIMIT 1',
      )
      .bind(playerId.trim())
      .first<Record<string, unknown>>();
  }

  public async isBlockedBetween(aId: string, bId: string): Promise<boolean> {
    if (!aId || !bId || aId === bId) return false;
    const db = await this.ensureSchema();
    const row = await db
      .prepare(
        `SELECT 1 AS blocked FROM player_blocks
         WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
         LIMIT 1`,
      )
      .bind(aId, bId, bId, aId)
      .first<{ blocked: number }>();
    return Boolean(row);
  }

  public async areFriends(aId: string, bId: string): Promise<boolean> {
    if (!aId || !bId || aId === bId) return false;
    const db = await this.ensureSchema();
    const [low, high] = orderedPlayerPair(aId, bId);
    const row = await db
      .prepare(
        `SELECT status FROM friendships WHERE player_low_id = ? AND player_high_id = ? LIMIT 1`,
      )
      .bind(low, high)
      .first<{ status: string }>();
    return row?.status === 'accepted';
  }

  public async getFriendIds(playerId: string): Promise<string[]> {
    const db = await this.ensureSchema();
    const rows = await db
      .prepare(
        `SELECT player_low_id, player_high_id FROM friendships
         WHERE status = 'accepted' AND (player_low_id = ? OR player_high_id = ?)`,
      )
      .bind(playerId, playerId)
      .all<{ player_low_id: string; player_high_id: string }>();

    return (rows.results ?? []).map((r) =>
      String(r.player_low_id) === playerId ? String(r.player_high_id) : String(r.player_low_id),
    );
  }

  public async getPresenceStatus(playerId: string, now = Date.now()): Promise<PresenceStatus> {
    const db = await this.ensureSchema();
    const row = await db
      .prepare('SELECT status, expires_at_ms FROM player_presence WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<{ status: string; expires_at_ms: number }>();
    if (!row) return 'offline';
    if (row.status !== 'offline' && Number(row.expires_at_ms) <= now) {
      return 'offline';
    }
    return this.normalizePresence(row.status);
  }

  public async setPresence(params: {
    playerId: string;
    status?: PresenceStatus;
    manualStatus?: ManualPresenceStatus | null;
    activeRoomId?: string | null;
    ttlMs: number;
    now?: number;
  }): Promise<{ status: PresenceStatus; changed: boolean; lastSeenAtMs: number }> {
    const db = await this.ensureSchema();
    const now = params.now ?? Date.now();
    const existing = await db
      .prepare('SELECT status, manual_status, active_room_id, expires_at_ms FROM player_presence WHERE player_id = ? LIMIT 1')
      .bind(params.playerId)
      .first<{
        status: string;
        manual_status: string | null;
        active_room_id: string | null;
        expires_at_ms: number;
      }>();

    const prevEffective: PresenceStatus =
      existing && (existing.status === 'offline' || Number(existing.expires_at_ms) > now)
        ? this.normalizePresence(existing.status)
        : 'offline';

    const nextManual: ManualPresenceStatus =
      params.manualStatus !== undefined && params.manualStatus !== null
        ? params.manualStatus
        : existing?.manual_status === 'busy'
          ? 'busy'
          : 'online';

    let nextStatus: PresenceStatus;
    if (params.status === 'offline') {
      nextStatus = 'offline';
    } else if (params.status === 'in_match') {
      nextStatus = 'in_match';
    } else if (params.status === 'busy') {
      nextStatus = 'busy';
    } else if (params.status === 'online') {
      nextStatus = params.manualStatus === 'busy' || (params.manualStatus === undefined && existing?.manual_status === 'busy')
        ? 'busy'
        : 'online';
    } else {
      nextStatus = prevEffective === 'in_match' ? 'in_match' : nextManual;
    }

    const nextRoomId =
      params.activeRoomId !== undefined
        ? params.activeRoomId
        : nextStatus === 'offline'
          ? null
          : existing?.active_room_id ?? null;

    const expiresAtMs = nextStatus === 'offline' ? now : now + Math.max(500, params.ttlMs);

    await db
      .prepare(
        `INSERT INTO player_presence (
          player_id, status, manual_status, active_room_id, last_heartbeat_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
          status = excluded.status,
          manual_status = excluded.manual_status,
          active_room_id = excluded.active_room_id,
          last_heartbeat_ms = excluded.last_heartbeat_ms,
          expires_at_ms = excluded.expires_at_ms`,
      )
      .bind(params.playerId, nextStatus, nextManual, nextRoomId, now, expiresAtMs)
      .run();

    return {
      status: nextStatus,
      changed: prevEffective !== nextStatus,
      lastSeenAtMs: now,
    };
  }

  public async expireStalePresence(now = Date.now()): Promise<Array<{ playerId: string; lastSeenAtMs: number }>> {
    const db = await this.ensureSchema();
    const stale = await db
      .prepare(
        `SELECT player_id, last_heartbeat_ms FROM player_presence
         WHERE status != 'offline' AND expires_at_ms <= ?`,
      )
      .bind(now)
      .all<{ player_id: string; last_heartbeat_ms: number }>();

    const rows = stale.results ?? [];
    if (rows.length === 0) return [];

    await db
      .prepare(
        `UPDATE player_presence
         SET status = 'offline', active_room_id = NULL
         WHERE status != 'offline' AND expires_at_ms <= ?`,
      )
      .bind(now)
      .run();

    return rows.map((r) => ({
      playerId: String(r.player_id),
      lastSeenAtMs: Number(r.last_heartbeat_ms),
    }));
  }

  public async getEarliestExpiryTimes(): Promise<{
    presenceExpiryMs: number | null;
    inviteExpiryMs: number | null;
  }> {
    const db = await this.ensureSchema();
    const pRow = await db
      .prepare(
        `SELECT MIN(expires_at_ms) AS m FROM player_presence WHERE status != 'offline'`,
      )
      .first<{ m: number | null }>();
    const iRow = await db
      .prepare(
        `SELECT MIN(expires_at_ms) AS m FROM match_invitations WHERE status = 'pending'`,
      )
      .first<{ m: number | null }>();

    return {
      presenceExpiryMs: pRow?.m !== null && pRow?.m !== undefined ? Number(pRow.m) : null,
      inviteExpiryMs: iRow?.m !== null && iRow?.m !== undefined ? Number(iRow.m) : null,
    };
  }

  public async expirePendingInvitations(now = Date.now()): Promise<MatchInvitationRecord[]> {
    const db = await this.ensureSchema();
    const expiredRows = await db
      .prepare(
        `SELECT * FROM match_invitations WHERE status = 'pending' AND expires_at_ms <= ?`,
      )
      .bind(now)
      .all<Record<string, unknown>>();

    const list = expiredRows.results ?? [];
    if (list.length === 0) return [];

    await db
      .prepare(
        `UPDATE match_invitations
         SET status = 'expired', responded_at_ms = ?
         WHERE status = 'pending' AND expires_at_ms <= ?`,
      )
      .bind(now, now)
      .run();

    const mapped: MatchInvitationRecord[] = [];
    for (const r of list) {
      mapped.push(await this.hydrateInviteRow(db, { ...r, status: 'expired', responded_at_ms: now }));
    }
    return mapped;
  }

  public async expireInvitationsForRoom(
    roomId: string,
    nextStatus: MatchInviteStatus = 'expired',
  ): Promise<MatchInvitationRecord[]> {
    const db = await this.ensureSchema();
    const now = Date.now();
    const rows = await db
      .prepare(`SELECT * FROM match_invitations WHERE room_id = ? AND status = 'pending'`)
      .bind(roomId)
      .all<Record<string, unknown>>();

    const list = rows.results ?? [];
    if (list.length === 0) return [];

    await db
      .prepare(
        `UPDATE match_invitations
         SET status = ?, responded_at_ms = ?
         WHERE room_id = ? AND status = 'pending'`,
      )
      .bind(nextStatus, now, roomId)
      .run();

    const out: MatchInvitationRecord[] = [];
    for (const r of list) {
      out.push(await this.hydrateInviteRow(db, { ...r, status: nextStatus, responded_at_ms: now }));
    }
    return out;
  }

  public async sendFriendRequest(
    requesterId: string,
    targetPlayerIdRaw: string,
  ): Promise<
    | {
        ok: true;
        outcome: 'requested' | 'accepted';
        request?: FriendRequestRecord;
      }
    | SocialError
  > {
    const db = await this.ensureSchema();
    const targetPlayerId = targetPlayerIdRaw.trim();
    if (!isValidPlayerIdFormat(requesterId) || !isValidPlayerIdFormat(targetPlayerId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid player ID format.' };
    }
    if (requesterId === targetPlayerId) {
      return {
        ok: false,
        status: 400,
        code: 'SELF_ACTION_FORBIDDEN',
        message: 'You cannot add yourself as a friend.',
      };
    }

    const [requesterRow, targetRow] = await Promise.all([
      this.getPlayerRow(db, requesterId),
      this.getPlayerRow(db, targetPlayerId),
    ]);
    if (!requesterRow || !targetRow) {
      return { ok: false, status: 404, code: 'INVALID_INPUT', message: 'Player not found.' };
    }

    if (await this.isBlockedBetween(requesterId, targetPlayerId)) {
      return {
        ok: false,
        status: 403,
        code: 'BLOCKED_PLAYER',
        message: 'Friend requests cannot be sent while a block is active between players.',
      };
    }

    const [low, high] = orderedPlayerPair(requesterId, targetPlayerId);
    const existing = await db
      .prepare(
        'SELECT * FROM friendships WHERE player_low_id = ? AND player_high_id = ? LIMIT 1',
      )
      .bind(low, high)
      .first<Record<string, unknown>>();

    const now = Date.now();
    if (existing) {
      if (String(existing.status) === 'accepted') {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_FRIENDS',
          message: 'You are already friends with this player.',
        };
      }
      if (String(existing.requester_id) === requesterId) {
        return {
          ok: false,
          status: 409,
          code: 'DUPLICATE_REQUEST',
          message: 'A friend request to this player is already pending.',
        };
      }
      // Mutual request from target -> auto-accept!
      await db
        .prepare(
          `UPDATE friendships SET status = 'accepted', updated_at_ms = ?, accepted_at_ms = ?
           WHERE player_low_id = ? AND player_high_id = ?`,
        )
        .bind(now, now, low, high)
        .run();
      return { ok: true, outcome: 'accepted' };
    }

    const friendCountRow = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM friendships
         WHERE status = 'accepted' AND (player_low_id = ? OR player_high_id = ?)`,
      )
      .bind(requesterId, requesterId)
      .first<{ c: number }>();
    if (Number(friendCountRow?.c ?? 0) >= SOCIAL_LIMITS.maxFriends) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: `Friend list limit (${SOCIAL_LIMITS.maxFriends}) reached.`,
      };
    }

    await db
      .prepare(
        `INSERT INTO friendships (
          player_low_id, player_high_id, requester_id, recipient_id, status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(low, high, requesterId, targetPlayerId, now, now)
      .run();

    const created = await db
      .prepare(
        'SELECT id FROM friendships WHERE player_low_id = ? AND player_high_id = ? LIMIT 1',
      )
      .bind(low, high)
      .first<{ id: number }>();

    return {
      ok: true,
      outcome: 'requested',
      request: {
        requestId: String(created?.id ?? `${low}_${high}`),
        direction: 'incoming',
        playerId: String(requesterRow.player_id),
        username: requesterRow.username ? String(requesterRow.username) : null,
        displayName: String(requesterRow.display_name),
        avatarId: sanitizeAvatarId(requesterRow.avatar_id),
        elo: Number(requesterRow.elo),
        level: Number(requesterRow.level),
        createdAtMs: now,
      },
    };
  }

  public async respondFriendRequest(
    actorId: string,
    targetPlayerIdRaw: string,
    action: FriendRequestAction,
  ): Promise<{ ok: true; action: FriendRequestAction } | SocialError> {
    const db = await this.ensureSchema();
    const targetPlayerId = targetPlayerIdRaw.trim();
    if (!isValidPlayerIdFormat(actorId) || !isValidPlayerIdFormat(targetPlayerId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid player ID.' };
    }

    const [low, high] = orderedPlayerPair(actorId, targetPlayerId);
    const row = await db
      .prepare(
        'SELECT * FROM friendships WHERE player_low_id = ? AND player_high_id = ? LIMIT 1',
      )
      .bind(low, high)
      .first<Record<string, unknown>>();

    if (!row || String(row.status) !== 'pending') {
      return {
        ok: false,
        status: 404,
        code: 'INVALID_INPUT',
        message: 'Pending friend request not found.',
      };
    }

    const requesterId = String(row.requester_id);
    const recipientId = String(row.recipient_id);
    const now = Date.now();

    if (action === 'accept') {
      if (recipientId !== actorId) {
        return {
          ok: false,
          status: 403,
          code: 'UNAUTHORIZED',
          message: 'Only the recipient can accept this friend request.',
        };
      }
      if (await this.isBlockedBetween(actorId, targetPlayerId)) {
        return {
          ok: false,
          status: 403,
          code: 'BLOCKED_PLAYER',
          message: 'Cannot accept request while a player is blocked.',
        };
      }
      await db
        .prepare(
          `UPDATE friendships SET status = 'accepted', updated_at_ms = ?, accepted_at_ms = ?
           WHERE player_low_id = ? AND player_high_id = ?`,
        )
        .bind(now, now, low, high)
        .run();
      return { ok: true, action: 'accept' };
    }

    if (action === 'reject') {
      if (recipientId !== actorId) {
        return {
          ok: false,
          status: 403,
          code: 'UNAUTHORIZED',
          message: 'Only the recipient can reject this friend request.',
        };
      }
      await db
        .prepare('DELETE FROM friendships WHERE player_low_id = ? AND player_high_id = ?')
        .bind(low, high)
        .run();
      return { ok: true, action: 'reject' };
    }

    if (action === 'cancel') {
      if (requesterId !== actorId) {
        return {
          ok: false,
          status: 403,
          code: 'UNAUTHORIZED',
          message: 'Only the sender can cancel this outgoing friend request.',
        };
      }
      await db
        .prepare('DELETE FROM friendships WHERE player_low_id = ? AND player_high_id = ?')
        .bind(low, high)
        .run();
      return { ok: true, action: 'cancel' };
    }

    return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid action.' };
  }

  public async removeFriend(
    actorId: string,
    targetPlayerIdRaw: string,
  ): Promise<{ ok: true } | SocialError> {
    const db = await this.ensureSchema();
    const targetPlayerId = targetPlayerIdRaw.trim();
    if (!isValidPlayerIdFormat(actorId) || !isValidPlayerIdFormat(targetPlayerId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid player ID.' };
    }
    const [low, high] = orderedPlayerPair(actorId, targetPlayerId);
    const existing = await db
      .prepare(
        `SELECT status FROM friendships WHERE player_low_id = ? AND player_high_id = ? LIMIT 1`,
      )
      .bind(low, high)
      .first<{ status: string }>();
    if (!existing || existing.status !== 'accepted') {
      return { ok: false, status: 404, code: 'INVALID_INPUT', message: 'Friendship not found.' };
    }
    await db
      .prepare('DELETE FROM friendships WHERE player_low_id = ? AND player_high_id = ?')
      .bind(low, high)
      .run();
    return { ok: true };
  }

  public async blockPlayer(
    blockerId: string,
    targetPlayerIdRaw: string,
  ): Promise<{ ok: true; cancelledInvites: MatchInvitationRecord[] } | SocialError> {
    const db = await this.ensureSchema();
    const targetPlayerId = targetPlayerIdRaw.trim();
    if (!isValidPlayerIdFormat(blockerId) || !isValidPlayerIdFormat(targetPlayerId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid player ID.' };
    }
    if (blockerId === targetPlayerId) {
      return {
        ok: false,
        status: 400,
        code: 'SELF_ACTION_FORBIDDEN',
        message: 'You cannot block yourself.',
      };
    }

    const targetRow = await this.getPlayerRow(db, targetPlayerId);
    if (!targetRow) {
      return { ok: false, status: 404, code: 'INVALID_INPUT', message: 'Player not found.' };
    }

    const now = Date.now();
    await db
      .prepare(
        `INSERT OR IGNORE INTO player_blocks (blocker_id, blocked_id, created_at_ms)
         VALUES (?, ?, ?)`,
      )
      .bind(blockerId, targetPlayerId, now)
      .run();

    const [low, high] = orderedPlayerPair(blockerId, targetPlayerId);
    await db
      .prepare('DELETE FROM friendships WHERE player_low_id = ? AND player_high_id = ?')
      .bind(low, high)
      .run();

    const pendingInvites = await db
      .prepare(
        `SELECT * FROM match_invitations
         WHERE status = 'pending'
           AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`,
      )
      .bind(blockerId, targetPlayerId, targetPlayerId, blockerId)
      .all<Record<string, unknown>>();

    const cancelledInvites: MatchInvitationRecord[] = [];
    if ((pendingInvites.results ?? []).length > 0) {
      await db
        .prepare(
          `UPDATE match_invitations
           SET status = 'cancelled', responded_at_ms = ?
           WHERE status = 'pending'
             AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`,
        )
        .bind(now, blockerId, targetPlayerId, targetPlayerId, blockerId)
        .run();
      for (const r of pendingInvites.results ?? []) {
        cancelledInvites.push(
          await this.hydrateInviteRow(db, { ...r, status: 'cancelled', responded_at_ms: now }),
        );
      }
    }

    return { ok: true, cancelledInvites };
  }

  public async unblockPlayer(
    blockerId: string,
    targetPlayerIdRaw: string,
  ): Promise<{ ok: true } | SocialError> {
    const db = await this.ensureSchema();
    const targetPlayerId = targetPlayerIdRaw.trim();
    if (!isValidPlayerIdFormat(blockerId) || !isValidPlayerIdFormat(targetPlayerId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid player ID.' };
    }
    await db
      .prepare('DELETE FROM player_blocks WHERE blocker_id = ? AND blocked_id = ?')
      .bind(blockerId, targetPlayerId)
      .run();
    return { ok: true };
  }

  public async createInvitation(params: {
    senderId: string;
    targetPlayerId: string;
    roomId: string | null;
    roomCode: string | null;
    ruleProfileId: RuleProfileId;
    calledShotsEnabled: boolean;
    ttlMs: number;
  }): Promise<{ ok: true; invitation: MatchInvitationRecord } | SocialError> {
    const db = await this.ensureSchema();
    const targetId = params.targetPlayerId.trim();
    if (!isValidPlayerIdFormat(params.senderId) || !isValidPlayerIdFormat(targetId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid player ID.' };
    }
    if (params.senderId === targetId) {
      return {
        ok: false,
        status: 400,
        code: 'SELF_ACTION_FORBIDDEN',
        message: 'You cannot invite yourself to a match.',
      };
    }

    const [senderRow, recipientRow] = await Promise.all([
      this.getPlayerRow(db, params.senderId),
      this.getPlayerRow(db, targetId),
    ]);
    if (!senderRow || !recipientRow) {
      return { ok: false, status: 404, code: 'INVALID_INPUT', message: 'Target player not found.' };
    }

    if (await this.isBlockedBetween(params.senderId, targetId)) {
      return {
        ok: false,
        status: 403,
        code: 'BLOCKED_PLAYER',
        message: 'Cannot send match invitation because one player has blocked the other.',
      };
    }

    if (!(await this.areFriends(params.senderId, targetId))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Direct match invitations can only be sent to friends.',
      };
    }

    const now = Date.now();
    await this.expirePendingInvitations(now);

    const dup = await db
      .prepare(
        `SELECT invite_id FROM match_invitations
         WHERE sender_id = ? AND recipient_id = ? AND status = 'pending' AND expires_at_ms > ?
         LIMIT 1`,
      )
      .bind(params.senderId, targetId, now)
      .first<{ invite_id: string }>();
    if (dup) {
      return {
        ok: false,
        status: 409,
        code: 'INVITE_ALREADY_EXISTS',
        message: 'You already have a pending match invitation sent to this player.',
      };
    }

    const countRow = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM match_invitations
         WHERE sender_id = ? AND status = 'pending' AND expires_at_ms > ?`,
      )
      .bind(params.senderId, now)
      .first<{ c: number }>();
    if (Number(countRow?.c ?? 0) >= SOCIAL_LIMITS.maxPendingOutgoingInvites) {
      return {
        ok: false,
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Too many active outgoing invitations. Cancel old ones first.',
      };
    }

    const safeTtlMs = Math.max(500, Math.min(300_000, params.ttlMs));
    const inviteId = `inv_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const expiresAtMs = now + safeTtlMs;

    await db
      .prepare(
        `INSERT INTO match_invitations (
          invite_id, sender_id, recipient_id, room_id, room_code,
          rule_profile_id, called_shots_enabled, status, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        inviteId,
        params.senderId,
        targetId,
        params.roomId,
        params.roomCode,
        params.ruleProfileId === 'wpa' ? 'wpa' : 'casual',
        params.calledShotsEnabled ? 1 : 0,
        now,
        expiresAtMs,
      )
      .run();

    const invitation: MatchInvitationRecord = {
      inviteId,
      senderId: String(senderRow.player_id),
      senderName: String(senderRow.display_name),
      senderAvatar: sanitizeAvatarId(senderRow.avatar_id),
      senderElo: Number(senderRow.elo),
      recipientId: String(recipientRow.player_id),
      recipientName: String(recipientRow.display_name),
      recipientAvatar: sanitizeAvatarId(recipientRow.avatar_id),
      roomId: params.roomId,
      roomCode: params.roomCode,
      ruleProfileId: params.ruleProfileId === 'wpa' ? 'wpa' : 'casual',
      calledShotsEnabled: Boolean(params.calledShotsEnabled),
      status: 'pending',
      createdAtMs: now,
      expiresAtMs,
      respondedAtMs: null,
    };

    return { ok: true, invitation };
  }

  public async getPendingInvitationForAction(
    actorId: string,
    inviteId: string,
    action: MatchInviteAction,
  ): Promise<{ ok: true; invitation: MatchInvitationRecord } | SocialError> {
    const db = await this.ensureSchema();
    const row = await db
      .prepare('SELECT * FROM match_invitations WHERE invite_id = ? LIMIT 1')
      .bind(inviteId.trim())
      .first<Record<string, unknown>>();

    if (!row) {
      return { ok: false, status: 404, code: 'INVITE_EXPIRED', message: 'Match invitation not found.' };
    }

    const invite = await this.hydrateInviteRow(db, row);
    const now = Date.now();

    if (action === 'cancel') {
      if (invite.senderId !== actorId) {
        return {
          ok: false,
          status: 403,
          code: 'UNAUTHORIZED',
          message: 'Only the sender can cancel this invitation.',
        };
      }
    } else {
      if (invite.recipientId !== actorId) {
        return {
          ok: false,
          status: 403,
          code: 'UNAUTHORIZED',
          message: 'Only the invited player can respond to this invitation.',
        };
      }
    }

    if (invite.status !== 'pending') {
      return {
        ok: false,
        status: 410,
        code: 'INVITE_EXPIRED',
        message: `This invitation is already ${invite.status}.`,
      };
    }

    if (now >= invite.expiresAtMs) {
      await db
        .prepare(
          `UPDATE match_invitations SET status = 'expired', responded_at_ms = ? WHERE invite_id = ?`,
        )
        .bind(now, invite.inviteId)
        .run();
      return {
        ok: false,
        status: 410,
        code: 'INVITE_EXPIRED',
        message: 'This match invitation has expired.',
      };
    }

    if (await this.isBlockedBetween(invite.senderId, invite.recipientId)) {
      await db
        .prepare(
          `UPDATE match_invitations SET status = 'cancelled', responded_at_ms = ? WHERE invite_id = ?`,
        )
        .bind(now, invite.inviteId)
        .run();
      return {
        ok: false,
        status: 403,
        code: 'BLOCKED_PLAYER',
        message: 'Invitation unavailable because one player has blocked the other.',
      };
    }

    if (action === 'accept' && !(await this.areFriends(invite.senderId, invite.recipientId))) {
      await db
        .prepare(
          `UPDATE match_invitations SET status = 'cancelled', responded_at_ms = ? WHERE invite_id = ?`,
        )
        .bind(now, invite.inviteId)
        .run();
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Friendship is no longer active.',
      };
    }

    return { ok: true, invitation: invite };
  }

  public async updateInvitationStatus(
    inviteId: string,
    status: MatchInviteStatus,
    roomOverride?: { roomId: string; roomCode: string },
  ): Promise<MatchInvitationRecord | null> {
    const db = await this.ensureSchema();
    const now = Date.now();
    if (roomOverride) {
      await db
        .prepare(
          `UPDATE match_invitations
           SET status = ?, room_id = ?, room_code = ?, responded_at_ms = ?
           WHERE invite_id = ?`,
        )
        .bind(status, roomOverride.roomId, roomOverride.roomCode, now, inviteId)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE match_invitations SET status = ?, responded_at_ms = ? WHERE invite_id = ?`,
        )
        .bind(status, now, inviteId)
        .run();
    }

    const row = await db
      .prepare('SELECT * FROM match_invitations WHERE invite_id = ? LIMIT 1')
      .bind(inviteId)
      .first<Record<string, unknown>>();
    return row ? this.hydrateInviteRow(db, row) : null;
  }

  public async sendDirectMessage(params: {
    senderId: string;
    recipientId: string;
    body: unknown;
  }): Promise<{ ok: true; message: DirectMessageRecord } | SocialError> {
    const db = await this.ensureSchema();
    const recipientId = params.recipientId.trim();
    if (!isValidPlayerIdFormat(params.senderId) || !isValidPlayerIdFormat(recipientId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid player ID.' };
    }
    if (params.senderId === recipientId) {
      return {
        ok: false,
        status: 400,
        code: 'SELF_ACTION_FORBIDDEN',
        message: 'You cannot send direct messages to yourself.',
      };
    }

    const textRes = sanitizeChatText(params.body);
    if (!textRes.ok) {
      return { ok: false, status: 400, code: textRes.code, message: textRes.message };
    }

    const [senderRow, recipientRow] = await Promise.all([
      this.getPlayerRow(db, params.senderId),
      this.getPlayerRow(db, recipientId),
    ]);
    if (!senderRow || !recipientRow) {
      return { ok: false, status: 404, code: 'INVALID_INPUT', message: 'Recipient not found.' };
    }

    if (await this.isBlockedBetween(params.senderId, recipientId)) {
      return {
        ok: false,
        status: 403,
        code: 'BLOCKED_PLAYER',
        message: 'Direct messages cannot be exchanged with a blocked player.',
      };
    }

    if (!(await this.areFriends(params.senderId, recipientId))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'You can only send private messages to friends.',
      };
    }

    const now = Date.now();
    const spamCheck = checkChatAntiSpam(`dm:${params.senderId}`, textRes.text, now);
    if (!spamCheck.ok) {
      return { ok: false, status: 429, code: 'RATE_LIMITED', message: spamCheck.message };
    }

    const [pairLow, pairHigh] = orderedPlayerPair(params.senderId, recipientId);
    const messageId = `dm_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

    await db
      .prepare(
        `INSERT INTO direct_messages (
          message_id, pair_low_id, pair_high_id, sender_id, recipient_id, body, created_at_ms, read_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(messageId, pairLow, pairHigh, params.senderId, recipientId, textRes.text, now)
      .run();

    return {
      ok: true,
      message: {
        messageId,
        senderId: String(senderRow.player_id),
        recipientId: String(recipientRow.player_id),
        senderName: String(senderRow.display_name),
        senderAvatar: sanitizeAvatarId(senderRow.avatar_id),
        body: textRes.text,
        createdAtMs: now,
        readAtMs: null,
      },
    };
  }

  public async getDirectMessageThread(
    viewerId: string,
    peerIdRaw: string,
    limit: number = SOCIAL_LIMITS.maxDmHistory,
  ): Promise<
    { ok: true; messages: DirectMessageRecord[]; markedReadAtMs: number | null } | SocialError
  > {
    const db = await this.ensureSchema();
    const peerId = peerIdRaw.trim();
    if (!isValidPlayerIdFormat(viewerId) || !isValidPlayerIdFormat(peerId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid player ID.' };
    }
    const [pairLow, pairHigh] = orderedPlayerPair(viewerId, peerId);
    const safeLimit = Math.max(1, Math.min(100, limit));

    const now = Date.now();
    const markRes = await db
      .prepare(
        `UPDATE direct_messages SET read_at_ms = ?
         WHERE pair_low_id = ? AND pair_high_id = ?
           AND sender_id = ? AND recipient_id = ? AND read_at_ms IS NULL`,
      )
      .bind(now, pairLow, pairHigh, peerId, viewerId)
      .run();

    const rows = await db
      .prepare(
        `SELECT dm.*, p.display_name AS sender_name, p.avatar_id AS sender_avatar
         FROM direct_messages dm
         LEFT JOIN players p ON p.player_id = dm.sender_id
         WHERE dm.pair_low_id = ? AND dm.pair_high_id = ?
         ORDER BY dm.created_at_ms DESC
         LIMIT ?`,
      )
      .bind(pairLow, pairHigh, safeLimit)
      .all<Record<string, unknown>>();

    const messages: DirectMessageRecord[] = (rows.results ?? [])
      .map((r) => ({
        messageId: String(r.message_id),
        senderId: String(r.sender_id),
        recipientId: String(r.recipient_id),
        senderName: r.sender_name ? String(r.sender_name) : 'Player',
        senderAvatar: sanitizeAvatarId(r.sender_avatar),
        body: String(r.body),
        createdAtMs: Number(r.created_at_ms),
        readAtMs: r.read_at_ms !== null && r.read_at_ms !== undefined ? Number(r.read_at_ms) : null,
      }))
      .reverse();

    return {
      ok: true,
      messages,
      markedReadAtMs: (markRes.meta?.changes ?? 0) > 0 ? now : null,
    };
  }

  public async markDirectMessagesRead(
    readerId: string,
    peerPlayerIdRaw: string,
  ): Promise<{ changed: boolean; readAtMs: number }> {
    const db = await this.ensureSchema();
    const peerId = peerPlayerIdRaw.trim();
    if (!isValidPlayerIdFormat(readerId) || !isValidPlayerIdFormat(peerId)) {
      return { changed: false, readAtMs: Date.now() };
    }
    const [pairLow, pairHigh] = orderedPlayerPair(readerId, peerId);
    const now = Date.now();
    const res = await db
      .prepare(
        `UPDATE direct_messages SET read_at_ms = ?
         WHERE pair_low_id = ? AND pair_high_id = ?
           AND sender_id = ? AND recipient_id = ? AND read_at_ms IS NULL`,
      )
      .bind(now, pairLow, pairHigh, peerId, readerId)
      .run();

    return { changed: (res.meta?.changes ?? 0) > 0, readAtMs: now };
  }

  public async getOverview(playerId: string): Promise<SocialOverviewPayload> {
    const db = await this.ensureSchema();
    const now = Date.now();
    await this.expireStalePresence(now);
    await this.expirePendingInvitations(now);

    const selfPresence = await this.getPresenceStatus(playerId, now);

    // Friends
    const friendRows = await db
      .prepare(
        `SELECT
           f.player_low_id, f.player_high_id, f.accepted_at_ms, f.updated_at_ms,
           p.player_id, p.username, p.display_name, p.avatar_id, p.elo, p.level, p.wins, p.total_matches,
           pr.status AS presence_status, pr.last_heartbeat_ms, pr.expires_at_ms
         FROM friendships f
         JOIN players p ON p.player_id = CASE WHEN f.player_low_id = ? THEN f.player_high_id ELSE f.player_low_id END
         LEFT JOIN player_presence pr ON pr.player_id = p.player_id
         WHERE f.status = 'accepted' AND (f.player_low_id = ? OR f.player_high_id = ?)
         ORDER BY p.display_name COLLATE NOCASE ASC`,
      )
      .bind(playerId, playerId, playerId)
      .all<Record<string, unknown>>();

    const unreadRows = await db
      .prepare(
        `SELECT sender_id, COUNT(*) AS c
         FROM direct_messages
         WHERE recipient_id = ? AND read_at_ms IS NULL
         GROUP BY sender_id`,
      )
      .bind(playerId)
      .all<{ sender_id: string; c: number }>();
    const unreadBySender = new Map<string, number>();
    let totalUnreadDmCount = 0;
    for (const u of unreadRows.results ?? []) {
      const count = Number(u.c ?? 0);
      unreadBySender.set(String(u.sender_id), count);
      totalUnreadDmCount += count;
    }

    const friends: FriendRecord[] = (friendRows.results ?? []).map((r) => {
      const fid = String(r.player_id);
      const rawStatus = r.presence_status ? String(r.presence_status) : 'offline';
      const exp = r.expires_at_ms !== null && r.expires_at_ms !== undefined ? Number(r.expires_at_ms) : 0;
      const presence: PresenceStatus =
        rawStatus !== 'offline' && exp > now ? this.normalizePresence(rawStatus) : 'offline';
      return {
        playerId: fid,
        username: r.username ? String(r.username) : null,
        displayName: String(r.display_name),
        avatarId: sanitizeAvatarId(r.avatar_id),
        elo: Number(r.elo),
        level: Number(r.level),
        wins: Number(r.wins),
        totalMatches: Number(r.total_matches),
        presence,
        lastSeenAtMs:
          r.last_heartbeat_ms !== null && r.last_heartbeat_ms !== undefined
            ? Number(r.last_heartbeat_ms)
            : null,
        unreadDmCount: unreadBySender.get(fid) ?? 0,
        friendedAtMs: Number(r.accepted_at_ms ?? r.updated_at_ms),
      };
    });

    // Pending Friend Requests
    const incReqRows = await db
      .prepare(
        `SELECT f.id, f.created_at_ms, p.player_id, p.username, p.display_name, p.avatar_id, p.elo, p.level
         FROM friendships f
         JOIN players p ON p.player_id = f.requester_id
         WHERE f.status = 'pending' AND f.recipient_id = ?
         ORDER BY f.created_at_ms DESC`,
      )
      .bind(playerId)
      .all<Record<string, unknown>>();

    const outReqRows = await db
      .prepare(
        `SELECT f.id, f.created_at_ms, p.player_id, p.username, p.display_name, p.avatar_id, p.elo, p.level
         FROM friendships f
         JOIN players p ON p.player_id = f.recipient_id
         WHERE f.status = 'pending' AND f.requester_id = ?
         ORDER BY f.created_at_ms DESC`,
      )
      .bind(playerId)
      .all<Record<string, unknown>>();

    const mapReq = (
      r: Record<string, unknown>,
      direction: 'incoming' | 'outgoing',
    ): FriendRequestRecord => ({
      requestId: String(r.id),
      direction,
      playerId: String(r.player_id),
      username: r.username ? String(r.username) : null,
      displayName: String(r.display_name),
      avatarId: sanitizeAvatarId(r.avatar_id),
      elo: Number(r.elo),
      level: Number(r.level),
      createdAtMs: Number(r.created_at_ms),
    });

    // Blocked list
    const blockedRows = await db
      .prepare(
        `SELECT b.created_at_ms, p.player_id, p.username, p.display_name, p.avatar_id
         FROM player_blocks b
         JOIN players p ON p.player_id = b.blocked_id
         WHERE b.blocker_id = ?
         ORDER BY b.created_at_ms DESC`,
      )
      .bind(playerId)
      .all<Record<string, unknown>>();

    const blocked: BlockedPlayerRecord[] = (blockedRows.results ?? []).map((r) => ({
      playerId: String(r.player_id),
      username: r.username ? String(r.username) : null,
      displayName: String(r.display_name),
      avatarId: sanitizeAvatarId(r.avatar_id),
      blockedAtMs: Number(r.created_at_ms),
    }));

    // Pending Invitations
    const incInvRows = await db
      .prepare(
        `SELECT * FROM match_invitations
         WHERE recipient_id = ? AND status = 'pending' AND expires_at_ms > ?
         ORDER BY created_at_ms DESC`,
      )
      .bind(playerId, now)
      .all<Record<string, unknown>>();

    const outInvRows = await db
      .prepare(
        `SELECT * FROM match_invitations
         WHERE sender_id = ? AND status = 'pending' AND expires_at_ms > ?
         ORDER BY created_at_ms DESC`,
      )
      .bind(playerId, now)
      .all<Record<string, unknown>>();

    const incomingInvitations: MatchInvitationRecord[] = [];
    for (const r of incInvRows.results ?? []) {
      incomingInvitations.push(await this.hydrateInviteRow(db, r));
    }
    const outgoingInvitations: MatchInvitationRecord[] = [];
    for (const r of outInvRows.results ?? []) {
      outgoingInvitations.push(await this.hydrateInviteRow(db, r));
    }

    return {
      selfPresence,
      friends,
      incomingRequests: (incReqRows.results ?? []).map((r) => mapReq(r, 'incoming')),
      outgoingRequests: (outReqRows.results ?? []).map((r) => mapReq(r, 'outgoing')),
      blocked,
      incomingInvitations,
      outgoingInvitations,
      totalUnreadDmCount,
    };
  }

  public async searchPlayersForSocial(
    viewerId: string | null,
    query: string,
    limit = 15,
  ): Promise<SocialSearchPlayerItem[]> {
    const db = await this.ensureSchema();
    const now = Date.now();
    const trimmed = query.trim();
    const cleaned = trimmed.toLowerCase().slice(0, 32);
    const safeLimit = Math.max(1, Math.min(30, limit));

    const sql = cleaned
      ? `SELECT p.player_id, p.username, p.display_name, p.avatar_id, p.elo, p.level, p.wins, p.total_matches,
                pr.status AS presence_status, pr.expires_at_ms
         FROM players p
         LEFT JOIN player_presence pr ON pr.player_id = p.player_id
         WHERE p.username_lower LIKE ? OR LOWER(p.display_name) LIKE ? OR p.player_id = ?
         ORDER BY CASE WHEN p.player_id = ? THEN 0 ELSE 1 END, p.elo DESC, p.wins DESC
         LIMIT ?`
      : `SELECT p.player_id, p.username, p.display_name, p.avatar_id, p.elo, p.level, p.wins, p.total_matches,
                pr.status AS presence_status, pr.expires_at_ms
         FROM players p
         LEFT JOIN player_presence pr ON pr.player_id = p.player_id
         ORDER BY p.elo DESC, p.wins DESC
         LIMIT ?`;

    const likePattern = `%${cleaned.replace(/[%_]/g, '')}%`;
    const rows = cleaned
      ? await db
          .prepare(sql)
          .bind(likePattern, likePattern, trimmed, trimmed, safeLimit)
          .all<Record<string, unknown>>()
      : await db.prepare(sql).bind(safeLimit).all<Record<string, unknown>>();

    const friendMap = new Map<string, string>();
    const blockedByViewer = new Set<string>();
    const blockedViewer = new Set<string>();

    if (viewerId && isValidPlayerIdFormat(viewerId)) {
      const fs = await db
        .prepare(
          `SELECT player_low_id, player_high_id, requester_id, status FROM friendships
           WHERE player_low_id = ? OR player_high_id = ?`,
        )
        .bind(viewerId, viewerId)
        .all<{
          player_low_id: string;
          player_high_id: string;
          requester_id: string;
          status: string;
        }>();
      for (const f of fs.results ?? []) {
        const peer =
          String(f.player_low_id) === viewerId ? String(f.player_high_id) : String(f.player_low_id);
        if (f.status === 'accepted') {
          friendMap.set(peer, 'friend');
        } else if (f.status === 'pending') {
          friendMap.set(
            peer,
            String(f.requester_id) === viewerId ? 'outgoing_request' : 'incoming_request',
          );
        }
      }

      const bl = await db
        .prepare(
          `SELECT blocker_id, blocked_id FROM player_blocks
           WHERE blocker_id = ? OR blocked_id = ?`,
        )
        .bind(viewerId, viewerId)
        .all<{ blocker_id: string; blocked_id: string }>();
      for (const b of bl.results ?? []) {
        if (String(b.blocker_id) === viewerId) {
          blockedByViewer.add(String(b.blocked_id));
        } else {
          blockedViewer.add(String(b.blocker_id));
        }
      }
    }

    const out: SocialSearchPlayerItem[] = [];
    for (const r of rows.results ?? []) {
      const pid = String(r.player_id);
      if (blockedViewer.has(pid)) {
        continue;
      }

      let relationship: SocialRelationship = 'none';
      if (viewerId && pid === viewerId) {
        relationship = 'self';
      } else if (blockedByViewer.has(pid)) {
        relationship = 'blocked';
      } else {
        const rel = friendMap.get(pid);
        if (rel === 'friend' || rel === 'incoming_request' || rel === 'outgoing_request') {
          relationship = rel;
        }
      }

      const rawStatus = r.presence_status ? String(r.presence_status) : 'offline';
      const exp = r.expires_at_ms !== null && r.expires_at_ms !== undefined ? Number(r.expires_at_ms) : 0;
      const presence: PresenceStatus =
        rawStatus !== 'offline' && exp > now ? this.normalizePresence(rawStatus) : 'offline';

      out.push({
        playerId: pid,
        username: r.username ? String(r.username) : null,
        displayName: String(r.display_name),
        avatarId: sanitizeAvatarId(r.avatar_id),
        elo: Number(r.elo),
        level: Number(r.level),
        wins: Number(r.wins),
        totalMatches: Number(r.total_matches),
        presence,
        relationship,
      });
    }

    return out;
  }

  public async createReport(params: {
    reporterId: string;
    reportedId: string;
    contextType: unknown;
    contextId?: unknown;
    reason: unknown;
    details?: unknown;
    excerpt?: unknown;
  }): Promise<{ ok: true; reportId: string } | SocialError> {
    const db = await this.ensureSchema();
    const reportedId = typeof params.reportedId === 'string' ? params.reportedId.trim() : '';
    if (!isValidPlayerIdFormat(params.reporterId) || !isValidPlayerIdFormat(reportedId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid player ID.' };
    }
    if (params.reporterId === reportedId) {
      return {
        ok: false,
        status: 400,
        code: 'SELF_ACTION_FORBIDDEN',
        message: 'You cannot report yourself.',
      };
    }
    if (!isValidReportReason(params.reason)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid report reason.' };
    }
    const ctx: SocialReportContext =
      params.contextType === 'dm' || params.contextType === 'room_chat'
        ? params.contextType
        : 'profile';

    const targetRow = await this.getPlayerRow(db, reportedId);
    if (!targetRow) {
      return { ok: false, status: 404, code: 'INVALID_INPUT', message: 'Reported player not found.' };
    }

    const reportId = `rep_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const now = Date.now();
    const contextId =
      typeof params.contextId === 'string' ? params.contextId.trim().slice(0, 64) : null;
    const details = sanitizeReportDetails(params.details);
    const excerpt = sanitizeReportDetails(params.excerpt);

    await db
      .prepare(
        `INSERT INTO player_reports (
          report_id, reporter_id, reported_id, context_type, context_id, reason, details, excerpt, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(reportId, params.reporterId, reportedId, ctx, contextId, params.reason, details, excerpt, now)
      .run();

    return { ok: true, reportId };
  }

  private async hydrateInviteRow(
    db: ProgressionSqlDb,
    r: Record<string, unknown>,
  ): Promise<MatchInvitationRecord> {
    const senderId = String(r.sender_id);
    const recipientId = String(r.recipient_id);
    const [senderRow, recipientRow] = await Promise.all([
      this.getPlayerRow(db, senderId),
      this.getPlayerRow(db, recipientId),
    ]);

    return {
      inviteId: String(r.invite_id),
      senderId,
      senderName: senderRow ? String(senderRow.display_name) : 'Player',
      senderAvatar: sanitizeAvatarId(senderRow?.avatar_id),
      senderElo: senderRow ? Number(senderRow.elo) : 1200,
      recipientId,
      recipientName: recipientRow ? String(recipientRow.display_name) : 'Player',
      recipientAvatar: sanitizeAvatarId(recipientRow?.avatar_id),
      roomId: r.room_id ? String(r.room_id) : null,
      roomCode: r.room_code ? String(r.room_code) : null,
      ruleProfileId: r.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
      calledShotsEnabled: Number(r.called_shots_enabled) === 1,
      status: String(r.status) as MatchInviteStatus,
      createdAtMs: Number(r.created_at_ms),
      expiresAtMs: Number(r.expires_at_ms),
      respondedAtMs:
        r.responded_at_ms !== null && r.responded_at_ms !== undefined
          ? Number(r.responded_at_ms)
          : null,
    };
  }

  private normalizePresence(raw: unknown): PresenceStatus {
    if (raw === 'online' || raw === 'in_match' || raw === 'busy') return raw;
    return 'offline';
  }
}
