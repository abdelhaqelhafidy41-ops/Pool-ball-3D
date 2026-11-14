import { DurableObject } from 'cloudflare:workers';
import type { RuleProfileId } from '../../src/game/rules/types';
import type {
  LeaderboardScope,
  MatchProgressionRewardSummary,
  MatchTelemetrySummaryForProgression,
  OnlineMatchType,
} from '../../src/multiplayer/shared/progression';
import type {
  ClientToServerMessage,
  MatchHistoryRecord,
  MultiplayerErrorCode,
  OnlineAvatarId,
  OnlineRoomInfo,
  OnlineRoomStatus,
  ServerToClientMessage,
} from '../../src/multiplayer/shared/protocol';
import {
  isValidManualPresence,
  sanitizeChatText,
  SOCIAL_LIMITS,
  type DirectMessageRecord,
  type FriendRequestAction,
  type ManualPresenceStatus,
  type MatchInvitationRecord,
  type MatchInviteAction,
  type PresenceStatus,
  type SocialOverviewPayload,
  type SocialSearchPlayerItem,
} from '../../src/multiplayer/shared/social';
import {
  clampLatency,
  constantTimeEqual,
  loadWorkerConfig,
  randomHexToken,
  sanitizeAvatarId,
  sanitizeDisplayName,
  type Env,
  type WorkerRuntimeConfig,
} from './config';
import { createDurableObjectSqlDb, D1ProgressionService } from './D1ProgressionService';
import { SocialService, type SocialError } from './SocialService';

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface LobbySocketAttachment {
  sessionId: string | null;
  playerId: string | null;
}

interface SessionRow {
  session_id: string;
  player_id: string | null;
  reconnect_token: string;
  display_name: string;
  avatar_id: string;
  latency_ms: number;
  active_room_id: string | null;
  in_matchmaking: number;
  created_at_ms: number;
  last_seen_at_ms: number;
}

interface QueueRow {
  session_id: string;
  rule_profile_id: string;
  called_shots_enabled: number;
  joined_at_ms: number;
  timeout_at_ms: number;
  latency_ms: number;
}

export class MatchmakerDurableObject extends DurableObject<Env> {
  private readonly config: WorkerRuntimeConfig;
  private schemaReady = false;
  private rateMap = new Map<WebSocket, number[]>();
  private matchingBusy = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = loadWorkerConfig(env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        player_id TEXT,
        reconnect_token TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_id TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        active_room_id TEXT,
        in_matchmaking INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        last_seen_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        room_code TEXT UNIQUE NOT NULL,
        host_session_id TEXT NOT NULL,
        is_private INTEGER NOT NULL,
        rule_profile_id TEXT NOT NULL,
        called_shots_enabled INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_queue (
        session_id TEXT PRIMARY KEY,
        rule_profile_id TEXT NOT NULL,
        called_shots_enabled INTEGER NOT NULL,
        joined_at_ms INTEGER NOT NULL,
        timeout_at_ms INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_history (
        match_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        player1_id TEXT,
        player2_id TEXT,
        player1_name TEXT NOT NULL,
        player2_name TEXT NOT NULL,
        winner_name TEXT NOT NULL,
        winner_role TEXT NOT NULL,
        reason TEXT NOT NULL,
        total_shots INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL,
        payload_json TEXT
      );
    `);
    const alterStatements = [
      'ALTER TABLE sessions ADD COLUMN player_id TEXT',
      'ALTER TABLE match_history ADD COLUMN player1_id TEXT',
      'ALTER TABLE match_history ADD COLUMN player2_id TEXT',
      'ALTER TABLE match_history ADD COLUMN payload_json TEXT',
    ];
    for (const stmt of alterStatements) {
      try {
        this.ctx.storage.sql.exec(stmt);
      } catch {
        // Column already exists
      }
    }
    this.schemaReady = true;
  }

  public async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const att: LobbySocketAttachment = { sessionId: null, playerId: null };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(att);

    return new Response(null, { status: 101, webSocket: client });
  }

  public async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.ensureSchema();

    if (!this.checkRateLimit(ws)) {
      this.sendError(ws, 'RATE_LIMITED', 'Too many requests. Please slow down.');
      return;
    }

    let parsed: unknown;
    try {
      const text =
        typeof message === 'string'
          ? message
          : new TextDecoder().decode(message);
      parsed = JSON.parse(text);
    } catch {
      this.sendError(ws, 'INVALID_INPUT', 'Malformed JSON payload.');
      return;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    ) {
      this.sendError(ws, 'INVALID_INPUT', 'Missing message type.');
      return;
    }

    const msg = parsed as ClientToServerMessage;
    const att = this.getAttachment(ws);

    if (msg.type === 'ping') {
      if (att.sessionId && typeof msg.latencyMs === 'number') {
        this.ctx.storage.sql.exec(
          'UPDATE sessions SET latency_ms = ?, last_seen_at_ms = ? WHERE session_id = ?',
          clampLatency(msg.latencyMs),
          Date.now(),
          att.sessionId,
        );
      }
      if (att.playerId) {
        const res = await this.getSocialService().setPresence({
          playerId: att.playerId,
          ttlMs: this.config.presenceTtlMs,
        });
        if (res.changed) {
          await this.broadcastPresenceChanged(att.playerId, res.status, res.lastSeenAtMs);
        }
      }
      this.sendSocket(ws, {
        type: 'pong',
        clientTimeMs: typeof msg.clientTimeMs === 'number' ? msg.clientTimeMs : Date.now(),
        serverTimeMs: Date.now(),
      });
      return;
    }

    if (msg.type === 'session:init') {
      const identity = await this.resolvePersistentPlayerIdentity({
        playerId: msg.playerId,
        playerToken: msg.playerToken,
        displayName: msg.displayName,
        avatarId: msg.avatarId,
      });
      const sess = this.createSession(
        identity.displayName,
        identity.avatarId,
        msg.latencyMs,
        identity.playerId,
      );
      this.bindSocketToSession(ws, sess.session_id, identity.playerId);
      this.sendSocket(ws, {
        type: 'session:ready',
        sessionId: sess.session_id,
        reconnectToken: sess.reconnect_token,
        playerId: identity.playerId,
        playerToken: identity.playerToken,
        displayName: sess.display_name,
        avatarId: sanitizeAvatarId(sess.avatar_id),
        resumedRoom: null,
        resumedMatch: null,
        balls: null,
        serverTimeMs: Date.now(),
      });

      const pres = await this.getSocialService().setPresence({
        playerId: identity.playerId,
        status: 'online',
        activeRoomId: null,
        ttlMs: this.config.presenceTtlMs,
      });
      if (pres.changed) {
        await this.broadcastPresenceChanged(identity.playerId, pres.status, pres.lastSeenAtMs);
      }
      const overview = await this.getSocialService().getOverview(identity.playerId);
      this.sendSocket(ws, { type: 'social:state', overview });
      await this.scheduleNextAlarm();
      return;
    }

    if (msg.type === 'session:resume') {
      const verified = this.verifyReconnect(msg.sessionId, msg.reconnectToken);
      if (!verified) {
        const identity = await this.resolvePersistentPlayerIdentity({
          playerId: msg.playerId,
          playerToken: msg.playerToken,
          displayName: msg.displayName,
          avatarId: msg.avatarId,
        });
        const fresh = this.createSession(
          identity.displayName,
          identity.avatarId,
          35,
          identity.playerId,
        );
        this.bindSocketToSession(ws, fresh.session_id, identity.playerId);
        this.sendSocket(ws, {
          type: 'session:ready',
          sessionId: fresh.session_id,
          reconnectToken: fresh.reconnect_token,
          playerId: identity.playerId,
          playerToken: identity.playerToken,
          displayName: fresh.display_name,
          avatarId: sanitizeAvatarId(fresh.avatar_id),
          resumedRoom: null,
          resumedMatch: null,
          balls: null,
          serverTimeMs: Date.now(),
        });

        const pres = await this.getSocialService().setPresence({
          playerId: identity.playerId,
          status: 'online',
          activeRoomId: null,
          ttlMs: this.config.presenceTtlMs,
        });
        if (pres.changed) {
          await this.broadcastPresenceChanged(identity.playerId, pres.status, pres.lastSeenAtMs);
        }
        const overview = await this.getSocialService().getOverview(identity.playerId);
        this.sendSocket(ws, { type: 'social:state', overview });
        await this.scheduleNextAlarm();
        return;
      }

      const identity = await this.resolvePersistentPlayerIdentity({
        playerId: msg.playerId ?? verified.player_id,
        playerToken: msg.playerToken,
        displayName: msg.displayName ?? verified.display_name,
        avatarId: sanitizeAvatarId(msg.avatarId ?? verified.avatar_id),
      });

      const nextName = sanitizeDisplayName(msg.displayName ?? identity.displayName ?? verified.display_name);
      const nextAvatar = sanitizeAvatarId(msg.avatarId ?? identity.avatarId ?? verified.avatar_id);
      const effectivePlayerId = verified.player_id ?? identity.playerId;

      this.ctx.storage.sql.exec(
        'UPDATE sessions SET player_id = ?, display_name = ?, avatar_id = ?, last_seen_at_ms = ? WHERE session_id = ?',
        effectivePlayerId,
        nextName,
        nextAvatar,
        Date.now(),
        verified.session_id,
      );
      verified.display_name = nextName;
      verified.avatar_id = nextAvatar;
      verified.player_id = effectivePlayerId;

      this.bindSocketToSession(ws, verified.session_id, effectivePlayerId);

      let resumedRoom = null;
      let resumedMatch = null;
      let balls = null;
      if (verified.active_room_id) {
        const roomStub = this.env.POOL_ROOM.get(
          this.env.POOL_ROOM.idFromName(verified.active_room_id),
        );
        const resumeData = await roomStub.getResumeData();
        if (resumeData) {
          resumedRoom = resumeData.room;
          resumedMatch = resumeData.match;
          balls = resumeData.balls;
        } else {
          this.ctx.storage.sql.exec(
            'UPDATE sessions SET active_room_id = NULL WHERE session_id = ?',
            verified.session_id,
          );
        }
      }

      this.sendSocket(ws, {
        type: 'session:ready',
        sessionId: verified.session_id,
        reconnectToken: verified.reconnect_token,
        playerId: verified.player_id ?? undefined,
        playerToken: identity.playerToken,
        displayName: verified.display_name,
        avatarId: sanitizeAvatarId(verified.avatar_id),
        resumedRoom,
        resumedMatch,
        balls,
        serverTimeMs: Date.now(),
      });

      const inActiveMatch = resumedRoom?.status === 'playing';
      const pres = await this.getSocialService().setPresence({
        playerId: effectivePlayerId,
        status: inActiveMatch ? 'in_match' : 'online',
        activeRoomId: resumedRoom?.roomId ?? null,
        ttlMs: this.config.presenceTtlMs,
      });
      if (pres.changed) {
        await this.broadcastPresenceChanged(effectivePlayerId, pres.status, pres.lastSeenAtMs);
      }
      const overview = await this.getSocialService().getOverview(effectivePlayerId);
      this.sendSocket(ws, { type: 'social:state', overview });
      await this.scheduleNextAlarm();
      return;
    }

    if (!att.sessionId) {
      this.sendError(ws, 'UNAUTHORIZED', 'Initialize session first.');
      return;
    }

    const session = this.getSession(att.sessionId);
    if (!session) {
      this.sendError(ws, 'UNAUTHORIZED', 'Session expired or invalid.');
      return;
    }

    const playerId = session.player_id ?? session.session_id;

    switch (msg.type) {
      case 'session:update_profile': {
        const name = sanitizeDisplayName(msg.displayName);
        const avatar = sanitizeAvatarId(msg.avatarId);
        this.ctx.storage.sql.exec(
          'UPDATE sessions SET display_name = ?, avatar_id = ?, last_seen_at_ms = ? WHERE session_id = ?',
          name,
          avatar,
          Date.now(),
          session.session_id,
        );
        if (session.player_id) {
          try {
            const svc = this.getProgressionService();
            await svc.ensureRowForExternalId(session.player_id, name, avatar);
            if (this.env.DB) {
              await this.env.DB.prepare(
                'UPDATE players SET display_name = ?, avatar_id = ?, updated_at_ms = ? WHERE player_id = ?',
              )
                .bind(name, avatar, Date.now(), session.player_id)
                .run();
            } else {
              this.ctx.storage.sql.exec(
                'UPDATE players SET display_name = ?, avatar_id = ?, updated_at_ms = ? WHERE player_id = ?',
                name,
                avatar,
                Date.now(),
                session.player_id,
              );
            }
          } catch {
            // Non-blocking progression profile sync error
          }
        }
        if (session.active_room_id) {
          const roomStub = this.env.POOL_ROOM.get(
            this.env.POOL_ROOM.idFromName(session.active_room_id),
          );
          await roomStub.updatePlayerProfile(session.session_id, name, avatar);
        }
        break;
      }

      case 'presence:set': {
        if (!isValidManualPresence(msg.status)) {
          this.sendError(ws, 'INVALID_INPUT', 'Presence status must be online or busy.');
          return;
        }
        const res = await this.handlePresenceUpdate(playerId, {
          manualStatus: msg.status,
          status: session.active_room_id ? undefined : msg.status,
        });
        const overview = await this.getSocialService().getOverview(playerId);
        this.sendSocket(ws, { type: 'social:state', overview });
        if (res.changed) {
          await this.scheduleNextAlarm();
        }
        break;
      }

      case 'presence:heartbeat': {
        this.ctx.storage.sql.exec(
          'UPDATE sessions SET last_seen_at_ms = ? WHERE session_id = ?',
          Date.now(),
          session.session_id,
        );
        const manual = isValidManualPresence(msg.status) ? msg.status : undefined;
        await this.handlePresenceUpdate(playerId, {
          manualStatus: manual,
        });
        await this.scheduleNextAlarm();
        break;
      }

      case 'social:sync': {
        const overview = await this.getSocialService().getOverview(playerId);
        this.sendSocket(ws, { type: 'social:state', overview });
        break;
      }

      case 'social:friend_request': {
        const res = await this.handleFriendRequest(playerId, msg.targetPlayerId);
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
        }
        break;
      }

      case 'social:friend_respond': {
        const res = await this.handleFriendRespond(playerId, msg.targetPlayerId, msg.action);
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
        }
        break;
      }

      case 'social:friend_remove': {
        const res = await this.handleFriendRemove(playerId, msg.targetPlayerId);
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
        }
        break;
      }

      case 'social:block': {
        const res = await this.handleBlockPlayer(playerId, msg.targetPlayerId);
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
        }
        break;
      }

      case 'social:unblock': {
        const res = await this.handleUnblockPlayer(playerId, msg.targetPlayerId);
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
        }
        break;
      }

      case 'invite:send': {
        const res = await this.handleSendInvite(playerId, session.session_id, {
          targetPlayerId: msg.targetPlayerId,
          ruleProfileId: msg.ruleProfileId,
          calledShotsEnabled: msg.calledShotsEnabled,
          ttlMs: msg.ttlMs,
        });
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
        }
        break;
      }

      case 'invite:respond': {
        const res = await this.handleRespondInvite(
          playerId,
          session.session_id,
          msg.inviteId,
          msg.action,
        );
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
        }
        break;
      }

      case 'chat:dm_send': {
        const res = await this.handleSendDirectMessage(
          playerId,
          msg.recipientId,
          msg.body,
          msg.clientMessageId,
        );
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
        }
        break;
      }

      case 'chat:dm_mark_read': {
        const res = await this.getSocialService().markDirectMessagesRead(playerId, msg.peerPlayerId);
        if (res.changed) {
          this.sendToPlayer(msg.peerPlayerId, {
            type: 'chat:dm_read',
            readerId: playerId,
            peerPlayerId: msg.peerPlayerId,
            readAtMs: res.readAtMs,
          });
        }
        const overview = await this.getSocialService().getOverview(playerId);
        this.sendToPlayer(playerId, { type: 'social:state', overview });
        break;
      }

      case 'room:create': {
        await this.pruneExpiredWaitingRooms();
        if (session.active_room_id || session.in_matchmaking === 1) {
          this.sendError(
            ws,
            'ALREADY_IN_MATCH',
            'You are already in an active room or matchmaking queue.',
          );
          return;
        }

        const ruleProfileId: RuleProfileId = msg.ruleProfileId === 'wpa' ? 'wpa' : 'casual';
        const calledShotsEnabled = Boolean(msg.calledShotsEnabled);
        const now = Date.now();
        const expiresAtMs = now + this.config.roomTtlMs;
        const roomId = `room_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const roomCode = this.generateUniqueCode();

        this.ctx.storage.sql.exec(
          `INSERT INTO rooms (
            room_id, room_code, host_session_id, is_private, rule_profile_id,
            called_shots_enabled, status, created_at_ms, expires_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
          roomId,
          roomCode,
          session.session_id,
          msg.isPrivate !== false ? 1 : 0,
          ruleProfileId,
          calledShotsEnabled ? 1 : 0,
          now,
          expiresAtMs,
        );
        this.ctx.storage.sql.exec(
          'UPDATE sessions SET active_room_id = ?, in_matchmaking = 0 WHERE session_id = ?',
          roomId,
          session.session_id,
        );

        const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomId));
        const roomInfo = await roomStub.initPrivateRoom({
          roomId,
          roomCode,
          ruleProfileId,
          calledShotsEnabled,
          createdAtMs: now,
          expiresAtMs,
          host: {
            sessionId: session.session_id,
            playerId: session.player_id ?? session.session_id,
            reconnectToken: session.reconnect_token,
            displayName: session.display_name,
            avatarId: sanitizeAvatarId(session.avatar_id),
            latencyMs: session.latency_ms,
          },
        });

        await this.scheduleNextAlarm();
        this.sendSocket(ws, { type: 'room:created', room: roomInfo });
        break;
      }

      case 'room:join': {
        await this.pruneExpiredWaitingRooms();
        if (typeof msg.roomCode !== 'string' || msg.roomCode.trim().length < 4) {
          this.sendError(ws, 'INVALID_ROOM', 'Enter a valid 6-character room code.');
          return;
        }
        if (session.active_room_id || session.in_matchmaking === 1) {
          this.sendError(
            ws,
            'ALREADY_IN_MATCH',
            'Leave your current room or queue before joining another room.',
          );
          return;
        }

        const normalizedCode = msg.roomCode.trim().toUpperCase();
        const rows = this.ctx.storage.sql
          .exec<{ room_id: string; expires_at_ms: number; status: string }>(
            'SELECT room_id, expires_at_ms, status FROM rooms WHERE room_code = ? LIMIT 1',
            normalizedCode,
          )
          .toArray();

        if (rows.length === 0) {
          this.sendError(ws, 'INVALID_ROOM', 'Room code not found. Check the code and try again.');
          return;
        }

        const roomRow = rows[0];
        if (
          Date.now() > roomRow.expires_at_ms ||
          roomRow.status === 'expired' ||
          roomRow.status === 'cancelled'
        ) {
          this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_id = ?', roomRow.room_id);
          this.sendError(ws, 'ROOM_EXPIRED', 'This room has expired or was closed by the host.');
          return;
        }

        const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomRow.room_id));
        const joinRes = await roomStub.joinRoom({
          sessionId: session.session_id,
          playerId: session.player_id ?? session.session_id,
          reconnectToken: session.reconnect_token,
          displayName: session.display_name,
          avatarId: sanitizeAvatarId(session.avatar_id),
          latencyMs: session.latency_ms,
        });

        if (!joinRes.ok) {
          this.sendError(ws, joinRes.code, joinRes.message);
          return;
        }

        this.ctx.storage.sql.exec(
          'UPDATE sessions SET active_room_id = ?, in_matchmaking = 0 WHERE session_id = ?',
          roomRow.room_id,
          session.session_id,
        );
        this.ctx.storage.sql.exec(
          'UPDATE rooms SET expires_at_ms = ?, status = ? WHERE room_id = ?',
          joinRes.room.expiresAtMs,
          joinRes.room.status,
          roomRow.room_id,
        );
        await this.scheduleNextAlarm();
        this.sendSocket(ws, { type: 'room:updated', room: joinRes.room });
        break;
      }

      case 'room:cancel': {
        if (!session.active_room_id) {
          this.sendError(ws, 'INVALID_ROOM', 'Room not found.');
          return;
        }
        const roomStub = this.env.POOL_ROOM.get(
          this.env.POOL_ROOM.idFromName(session.active_room_id),
        );
        const res = await roomStub.cancelRoomFromLobby(session.session_id);
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
        }
        break;
      }

      case 'matchmaking:join': {
        const ruleProfileId: RuleProfileId = msg.ruleProfileId === 'wpa' ? 'wpa' : 'casual';
        const calledShotsEnabled = Boolean(msg.calledShotsEnabled);
        if (session.active_room_id) {
          this.sendError(ws, 'ALREADY_IN_MATCH', 'You are already in an active room or match.');
          return;
        }
        if (session.in_matchmaking === 1) {
          this.sendError(ws, 'ALREADY_IN_MATCH', 'You are already searching for an opponent.');
          return;
        }

        const now = Date.now();
        const timeoutAtMs = now + this.config.matchmakingTimeoutMs;
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO match_queue (
            session_id, rule_profile_id, called_shots_enabled, joined_at_ms, timeout_at_ms, latency_ms
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          session.session_id,
          ruleProfileId,
          calledShotsEnabled ? 1 : 0,
          now,
          timeoutAtMs,
          session.latency_ms,
        );
        this.ctx.storage.sql.exec(
          'UPDATE sessions SET in_matchmaking = 1 WHERE session_id = ?',
          session.session_id,
        );

        const queueCount = this.getQueueCount();
        this.sendSocket(ws, {
          type: 'matchmaking:searching',
          position: queueCount,
          startedAtMs: now,
          timeoutAtMs,
        });

        await this.processQueue();
        await this.scheduleNextAlarm();
        break;
      }

      case 'matchmaking:cancel': {
        this.cancelMatchmaking(session.session_id, 'Matchmaking cancelled.');
        await this.scheduleNextAlarm();
        break;
      }

      default:
        this.sendError(ws, 'INVALID_INPUT', 'Connect to your room socket for match actions.');
    }
  }

  public async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.ensureSchema();
    this.rateMap.delete(ws);
    const safeCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    try {
      ws.close(safeCode, reason || 'Connection closed');
    } catch {
      // Ignore if socket is already closed
    }
    await this.handleSocketDisconnected(ws);
  }

  public async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.ensureSchema();
    this.rateMap.delete(ws);
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // Ignore if socket is already closed
    }
    await this.handleSocketDisconnected(ws);
  }

  public async alarm(): Promise<void> {
    this.ensureSchema();
    await this.processQueue();
    await this.pruneExpiredWaitingRooms();
    await this.pruneExpiredSocialState();
    await this.scheduleNextAlarm();
  }

  public async onRoomStatusChanged(
    roomId: string,
    status: OnlineRoomStatus,
    playerIds: string[] = [],
  ): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      'UPDATE rooms SET status = ? WHERE room_id = ?',
      status,
      roomId,
    );

    const social = this.getSocialService();
    if (status === 'playing') {
      const expiredInvites = await social.expireInvitationsForRoom(roomId, 'expired');
      for (const inv of expiredInvites) {
        this.sendToPlayer(inv.senderId, { type: 'invite:updated', invitation: inv });
        this.sendToPlayer(inv.recipientId, { type: 'invite:updated', invitation: inv });
      }
      for (const pid of playerIds) {
        const res = await social.setPresence({
          playerId: pid,
          status: 'in_match',
          activeRoomId: roomId,
          ttlMs: Math.max(this.config.presenceTtlMs, 120_000),
        });
        if (res.changed) {
          await this.broadcastPresenceChanged(pid, res.status, res.lastSeenAtMs);
        }
      }
    } else if (status === 'finished') {
      for (const pid of playerIds) {
        const hasLobbySocket = this.findSocketsByPlayerId(pid).length > 0;
        const res = await social.setPresence({
          playerId: pid,
          status: hasLobbySocket ? 'online' : 'offline',
          activeRoomId: hasLobbySocket ? roomId : null,
          ttlMs: this.config.presenceTtlMs,
        });
        if (res.changed) {
          await this.broadcastPresenceChanged(pid, res.status, res.lastSeenAtMs);
        }
      }
    }
    await this.scheduleNextAlarm();
  }

  public async onPlayerLeftRoom(
    roomId: string,
    sessionId: string,
    playerId?: string,
  ): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      'UPDATE sessions SET active_room_id = NULL WHERE session_id = ? AND active_room_id = ?',
      sessionId,
      roomId,
    );
    const pid = playerId ?? this.getSession(sessionId)?.player_id ?? null;
    if (pid) {
      const hasLobbySocket = this.findSocketsByPlayerId(pid).length > 0;
      const res = await this.getSocialService().setPresence({
        playerId: pid,
        status: hasLobbySocket ? 'online' : 'offline',
        activeRoomId: null,
        ttlMs: this.config.presenceTtlMs,
      });
      if (res.changed) {
        await this.broadcastPresenceChanged(pid, res.status, res.lastSeenAtMs);
      }
    }
  }

  public async onRoomClosed(
    roomId: string,
    sessionIds: string[],
    playerIds: string[] = [],
  ): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_id = ?', roomId);
    const resolvedPlayerIds = new Set<string>(playerIds);
    for (const sid of sessionIds) {
      const sess = this.getSession(sid);
      if (sess?.player_id) resolvedPlayerIds.add(sess.player_id);
      this.ctx.storage.sql.exec(
        'UPDATE sessions SET active_room_id = NULL WHERE session_id = ? AND active_room_id = ?',
        sid,
        roomId,
      );
    }

    const social = this.getSocialService();
    const expiredInvites = await social.expireInvitationsForRoom(roomId, 'expired');
    for (const inv of expiredInvites) {
      this.sendToPlayer(inv.senderId, { type: 'invite:updated', invitation: inv });
      this.sendToPlayer(inv.recipientId, { type: 'invite:updated', invitation: inv });
    }

    for (const pid of resolvedPlayerIds) {
      const hasLobbySocket = this.findSocketsByPlayerId(pid).length > 0;
      const res = await social.setPresence({
        playerId: pid,
        status: hasLobbySocket ? 'online' : 'offline',
        activeRoomId: null,
        ttlMs: this.config.presenceTtlMs,
      });
      if (res.changed) {
        await this.broadcastPresenceChanged(pid, res.status, res.lastSeenAtMs);
      }
    }
    await this.scheduleNextAlarm();
  }

  public async recordMatchHistory(record: MatchHistoryRecord): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO match_history (
        match_id, room_id, player1_id, player2_id, player1_name, player2_name, winner_name,
        winner_role, reason, total_shots, ended_at_ms, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.matchId,
      record.roomId,
      record.player1Id ?? null,
      record.player2Id ?? null,
      record.player1Name,
      record.player2Name,
      record.winnerName,
      record.winnerRole,
      record.reason,
      record.totalShots,
      record.endedAtMs,
      JSON.stringify(record),
    );
    this.ctx.storage.sql.exec(`
      DELETE FROM match_history
      WHERE match_id NOT IN (
        SELECT match_id FROM match_history ORDER BY ended_at_ms DESC LIMIT 100
      )
    `);
  }

  public async getHealthAndStats(): Promise<{
    activeRooms: number;
    activeMatches: number;
    totalMatchesCompleted: number;
    queueSize: number;
    connectedPlayers: number;
  }> {
    this.ensureSchema();
    await this.pruneExpiredWaitingRooms();
    const sql = this.ctx.storage.sql;

    const totalRooms = sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM rooms').one().c;
    const activeMatches = sql
      .exec<{ c: number }>("SELECT COUNT(*) AS c FROM rooms WHERE status = 'playing'")
      .one().c;
    const totalHistory = sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM match_history').one().c;
    const queueSize = this.getQueueCount();

    const lobbySockets = this.ctx
      .getWebSockets()
      .filter((ws) => this.getAttachment(ws).sessionId !== null).length;

    return {
      activeRooms: Number(totalRooms),
      activeMatches: Number(activeMatches),
      totalMatchesCompleted: Number(totalHistory),
      queueSize,
      connectedPlayers: lobbySockets + Number(activeMatches) * 2,
    };
  }

  public async getHistory(limit = 30): Promise<MatchHistoryRecord[]> {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        'SELECT * FROM match_history ORDER BY ended_at_ms DESC LIMIT ?',
        Math.max(1, Math.min(100, limit)),
      )
      .toArray();

    return rows.map((r) => {
      if (typeof r.payload_json === 'string' && r.payload_json.length > 0) {
        try {
          return JSON.parse(r.payload_json) as MatchHistoryRecord;
        } catch {
          // Fall back to columns
        }
      }
      return {
        matchId: String(r.match_id),
        roomId: String(r.room_id),
        player1Id: r.player1_id ? String(r.player1_id) : undefined,
        player2Id: r.player2_id ? String(r.player2_id) : undefined,
        player1Name: String(r.player1_name),
        player2Name: String(r.player2_name),
        winnerName: String(r.winner_name),
        winnerRole: r.winner_role === 'player2' ? 'player2' : 'player1',
        reason: String(r.reason),
        totalShots: Number(r.total_shots),
        endedAtMs: Number(r.ended_at_ms),
      };
    });
  }

  private async handleSocketDisconnected(ws: WebSocket): Promise<void> {
    const att = this.getAttachment(ws);
    if (!att.sessionId) return;

    let hasOtherSessionSocket = false;
    let hasOtherPlayerSocket = false;
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const otherAtt = this.getAttachment(other);
      if (otherAtt.sessionId === att.sessionId) {
        hasOtherSessionSocket = true;
      }
      if (att.playerId && otherAtt.playerId === att.playerId) {
        hasOtherPlayerSocket = true;
      }
    }

    if (!hasOtherSessionSocket) {
      this.cancelMatchmaking(att.sessionId, 'Disconnected from queue.');
    }

    if (att.playerId && !hasOtherPlayerSocket) {
      const sess = this.getSession(att.sessionId);
      const isInPlayingRoom = Boolean(
        sess?.active_room_id &&
          this.ctx.storage.sql
            .exec<{ status: string }>('SELECT status FROM rooms WHERE room_id = ? LIMIT 1', sess.active_room_id)
            .toArray()[0]?.status === 'playing',
      );
      if (!isInPlayingRoom) {
        const res = await this.getSocialService().setPresence({
          playerId: att.playerId,
          status: 'offline',
          activeRoomId: null,
          ttlMs: this.config.presenceTtlMs,
        });
        if (res.changed) {
          await this.broadcastPresenceChanged(att.playerId, res.status, res.lastSeenAtMs);
        }
      }
    }

    await this.scheduleNextAlarm();
  }

  private getProgressionService(): D1ProgressionService {
    if (this.env.DB) {
      return new D1ProgressionService(this.env.DB);
    }
    return new D1ProgressionService(createDurableObjectSqlDb(this.ctx.storage.sql));
  }

  private getSocialService(): SocialService {
    if (this.env.DB) {
      return new SocialService(this.env.DB);
    }
    return new SocialService(createDurableObjectSqlDb(this.ctx.storage.sql));
  }

  private async authenticateRestPlayer(
    playerId: unknown,
    playerToken: unknown,
  ): Promise<{ ok: true; playerId: string } | SocialError> {
    if (typeof playerId !== 'string' || typeof playerToken !== 'string') {
      return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Missing player credentials.' };
    }
    const valid = await this.getProgressionService().verifyPlayerToken(playerId, playerToken);
    if (!valid) {
      return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Invalid player credentials.' };
    }
    return { ok: true, playerId: playerId.trim() };
  }

  // ===== Progression RPC Methods =====

  public async progressionAuthenticateOrCreate(input: {
    playerId?: string | null;
    playerToken?: string | null;
    displayName?: string | null;
    avatarId?: string | null;
    forceNewGuest?: boolean;
  }) {
    this.ensureSchema();
    return this.getProgressionService().authenticateOrCreatePlayer(input);
  }

  public async progressionUpdateProfile(
    playerId: string,
    playerToken: string,
    updates: { displayName?: unknown; avatarId?: unknown },
  ) {
    this.ensureSchema();
    return this.getProgressionService().updatePlayerProfile(playerId, playerToken, updates);
  }

  public async progressionRegister(
    playerId: string,
    playerToken: string,
    input: {
      username: unknown;
      password: unknown;
      displayName?: unknown;
      avatarId?: unknown;
    },
  ) {
    this.ensureSchema();
    return this.getProgressionService().registerAccount(playerId, playerToken, input);
  }

  public async progressionLogin(input: { username: unknown; password: unknown }) {
    this.ensureSchema();
    return this.getProgressionService().loginAccount(input);
  }

  public async progressionGetProfile(playerId: string) {
    this.ensureSchema();
    return this.getProgressionService().getPublicProfile(playerId);
  }

  public async progressionSearch(query: string, limit = 15) {
    this.ensureSchema();
    return this.getProgressionService().searchPlayers(query, limit);
  }

  public async progressionLeaderboard(params: {
    scope: LeaderboardScope;
    page?: number;
    limit?: number;
    query?: string;
    currentPlayerId?: string | null;
  }) {
    this.ensureSchema();
    return this.getProgressionService().getLeaderboard(params);
  }

  public async progressionHistory(params: { playerId?: string | null; limit?: number }) {
    this.ensureSchema();
    return this.getProgressionService().getMatchHistory(params);
  }

  public async progressionRecordMatch(input: {
    matchId: string;
    roomId: string;
    roomCode: string;
    ruleProfileId: RuleProfileId;
    matchType: OnlineMatchType;
    winnerRole: 'player1' | 'player2';
    reason: string;
    totalShots: number;
    endedAtMs: number;
    player1: { playerId: string; displayName: string; avatarId: OnlineAvatarId };
    player2: { playerId: string; displayName: string; avatarId: OnlineAvatarId };
    telemetry: MatchTelemetrySummaryForProgression;
  }): Promise<{
    alreadyRecorded: boolean;
    summary: MatchProgressionRewardSummary;
  }> {
    this.ensureSchema();
    return this.getProgressionService().recordCompletedMatch(input);
  }

  // ===== Phase 7 Social RPC Methods =====

  public async socialIsBlockedBetween(aId: string, bId: string): Promise<boolean> {
    this.ensureSchema();
    return this.getSocialService().isBlockedBetween(aId, bId);
  }

  public async socialGetOverview(
    playerId: string,
    playerToken: string,
  ): Promise<{ ok: true; overview: SocialOverviewPayload } | SocialError> {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const overview = await this.getSocialService().getOverview(auth.playerId);
    return { ok: true, overview };
  }

  public async socialSearchPlayers(
    viewerId: string | null,
    viewerToken: string | null,
    query: string,
    limit = 15,
  ): Promise<SocialSearchPlayerItem[]> {
    this.ensureSchema();
    let authenticatedViewer: string | null = null;
    if (viewerId && viewerToken) {
      const ok = await this.getProgressionService().verifyPlayerToken(viewerId, viewerToken);
      if (ok) authenticatedViewer = viewerId.trim();
    }
    return this.getSocialService().searchPlayersForSocial(authenticatedViewer, query, limit);
  }

  public async socialSendFriendRequest(
    playerId: string,
    playerToken: string,
    targetPlayerId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.handleFriendRequest(auth.playerId, targetPlayerId);
  }

  public async socialRespondFriendRequest(
    playerId: string,
    playerToken: string,
    targetPlayerId: string,
    action: FriendRequestAction,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.handleFriendRespond(auth.playerId, targetPlayerId, action);
  }

  public async socialRemoveFriend(
    playerId: string,
    playerToken: string,
    targetPlayerId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.handleFriendRemove(auth.playerId, targetPlayerId);
  }

  public async socialBlockPlayer(
    playerId: string,
    playerToken: string,
    targetPlayerId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.handleBlockPlayer(auth.playerId, targetPlayerId);
  }

  public async socialUnblockPlayer(
    playerId: string,
    playerToken: string,
    targetPlayerId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.handleUnblockPlayer(auth.playerId, targetPlayerId);
  }

  public async socialSetPresence(
    playerId: string,
    playerToken: string,
    input: { status?: unknown; ttlMs?: number; expireNow?: boolean },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;

    if (input.expireNow) {
      const res = await this.getSocialService().setPresence({
        playerId: auth.playerId,
        status: 'offline',
        activeRoomId: null,
        ttlMs: 0,
      });
      if (res.changed) {
        await this.broadcastPresenceChanged(auth.playerId, res.status, res.lastSeenAtMs);
      }
      return { ok: true as const, status: res.status };
    }

    const manual = isValidManualPresence(input.status) ? input.status : undefined;
    const res = await this.handlePresenceUpdate(auth.playerId, {
      manualStatus: manual,
      status: manual,
      ttlMs: input.ttlMs,
    });
    await this.scheduleNextAlarm();
    return { ok: true as const, status: res.status };
  }

  public async socialPruneExpired(): Promise<{
    expiredPresenceIds: string[];
    expiredInviteIds: string[];
  }> {
    this.ensureSchema();
    const res = await this.pruneExpiredSocialState();
    await this.scheduleNextAlarm();
    return res;
  }

  public async socialCreateInvite(
    playerId: string,
    playerToken: string,
    input: {
      targetPlayerId: string;
      ruleProfileId?: RuleProfileId;
      calledShotsEnabled?: boolean;
      ttlMs?: number;
    },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const sess = this.findLatestSessionByPlayerId(auth.playerId);
    return this.handleSendInvite(auth.playerId, sess?.session_id ?? null, {
      targetPlayerId: input.targetPlayerId,
      ruleProfileId: input.ruleProfileId === 'wpa' ? 'wpa' : 'casual',
      calledShotsEnabled: Boolean(input.calledShotsEnabled),
      ttlMs: input.ttlMs,
    });
  }

  public async socialRespondInvite(
    playerId: string,
    playerToken: string,
    inviteId: string,
    action: MatchInviteAction,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const sess = this.findLatestSessionByPlayerId(auth.playerId);
    return this.handleRespondInvite(auth.playerId, sess?.session_id ?? null, inviteId, action);
  }

  public async socialGetMessages(
    playerId: string,
    playerToken: string,
    peerPlayerId: string,
    limit: number = SOCIAL_LIMITS.maxDmHistory,
  ): Promise<{ ok: true; messages: DirectMessageRecord[] } | SocialError> {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getSocialService().getDirectMessageThread(
      auth.playerId,
      peerPlayerId,
      limit,
    );
    if (!res.ok) return res;
    if (res.markedReadAtMs !== null) {
      this.sendToPlayer(peerPlayerId, {
        type: 'chat:dm_read',
        readerId: auth.playerId,
        peerPlayerId,
        readAtMs: res.markedReadAtMs,
      });
      const overview = await this.getSocialService().getOverview(auth.playerId);
      this.sendToPlayer(auth.playerId, { type: 'social:state', overview });
    }
    return { ok: true, messages: res.messages };
  }

  public async socialSendMessage(
    playerId: string,
    playerToken: string,
    recipientId: string,
    body: unknown,
    clientMessageId?: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.handleSendDirectMessage(auth.playerId, recipientId, body, clientMessageId);
  }

  public async socialCreateReport(
    playerId: string,
    playerToken: string,
    input: {
      reportedId: string;
      contextType: unknown;
      contextId?: unknown;
      reason: unknown;
      details?: unknown;
      excerpt?: unknown;
    },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.getSocialService().createReport({
      reporterId: auth.playerId,
      ...input,
    });
  }

  // ===== Internal Social Handlers (shared between WS & REST) =====

  private async handlePresenceUpdate(
    playerId: string,
    opts: {
      status?: PresenceStatus;
      manualStatus?: ManualPresenceStatus;
      activeRoomId?: string | null;
      ttlMs?: number;
    },
  ): Promise<{ status: PresenceStatus; changed: boolean }> {
    const ttlMs =
      typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs)
        ? Math.max(500, Math.min(300_000, opts.ttlMs))
        : this.config.presenceTtlMs;

    const sess = this.findLatestSessionByPlayerId(playerId);
    const inActiveMatch = Boolean(
      sess?.active_room_id &&
        this.ctx.storage.sql
          .exec<{ status: string }>('SELECT status FROM rooms WHERE room_id = ? LIMIT 1', sess.active_room_id)
          .toArray()[0]?.status === 'playing',
    );

    const res = await this.getSocialService().setPresence({
      playerId,
      status: inActiveMatch ? 'in_match' : opts.status,
      manualStatus: opts.manualStatus,
      activeRoomId: opts.activeRoomId,
      ttlMs,
    });
    if (res.changed) {
      await this.broadcastPresenceChanged(playerId, res.status, res.lastSeenAtMs);
    }
    return { status: res.status, changed: res.changed };
  }

  private async handleFriendRequest(playerId: string, targetPlayerId: string) {
    const social = this.getSocialService();
    const res = await social.sendFriendRequest(playerId, targetPlayerId);
    if (!res.ok) return res;

    if (res.outcome === 'accepted') {
      this.sendToPlayer(targetPlayerId, {
        type: 'social:friend_updated',
        actorId: playerId,
        action: 'accepted',
      });
      this.sendToPlayer(playerId, {
        type: 'social:friend_updated',
        actorId: targetPlayerId,
        action: 'accepted',
      });
      await this.pushOverviewToPlayers([playerId, targetPlayerId]);
    } else {
      if (res.request) {
        this.sendToPlayer(targetPlayerId, {
          type: 'social:friend_request_received',
          request: res.request,
        });
      }
      await this.pushOverviewToPlayers([playerId, targetPlayerId]);
    }
    return { ok: true as const, outcome: res.outcome };
  }

  private async handleFriendRespond(
    actorId: string,
    targetPlayerId: string,
    action: FriendRequestAction,
  ) {
    const social = this.getSocialService();
    const res = await social.respondFriendRequest(actorId, targetPlayerId, action);
    if (!res.ok) return res;

    const mapped =
      action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'cancelled';
    this.sendToPlayer(targetPlayerId, {
      type: 'social:friend_updated',
      actorId,
      action: mapped,
    });
    this.sendToPlayer(actorId, {
      type: 'social:friend_updated',
      actorId: targetPlayerId,
      action: mapped,
    });
    await this.pushOverviewToPlayers([actorId, targetPlayerId]);
    return { ok: true as const, action };
  }

  private async handleFriendRemove(actorId: string, targetPlayerId: string) {
    const social = this.getSocialService();
    const res = await social.removeFriend(actorId, targetPlayerId);
    if (!res.ok) return res;

    this.sendToPlayer(targetPlayerId, {
      type: 'social:friend_updated',
      actorId,
      action: 'removed',
    });
    this.sendToPlayer(actorId, {
      type: 'social:friend_updated',
      actorId: targetPlayerId,
      action: 'removed',
    });
    await this.pushOverviewToPlayers([actorId, targetPlayerId]);
    return { ok: true as const };
  }

  private async handleBlockPlayer(blockerId: string, targetPlayerId: string) {
    const social = this.getSocialService();
    const res = await social.blockPlayer(blockerId, targetPlayerId);
    if (!res.ok) return res;

    for (const inv of res.cancelledInvites) {
      this.sendToPlayer(inv.senderId, { type: 'invite:updated', invitation: inv });
      this.sendToPlayer(inv.recipientId, { type: 'invite:updated', invitation: inv });
    }
    this.sendToPlayer(targetPlayerId, {
      type: 'social:friend_updated',
      actorId: blockerId,
      action: 'blocked',
    });
    this.sendToPlayer(blockerId, {
      type: 'social:friend_updated',
      actorId: targetPlayerId,
      action: 'blocked',
    });
    await this.pushOverviewToPlayers([blockerId, targetPlayerId]);
    return { ok: true as const };
  }

  private async handleUnblockPlayer(blockerId: string, targetPlayerId: string) {
    const social = this.getSocialService();
    const res = await social.unblockPlayer(blockerId, targetPlayerId);
    if (!res.ok) return res;

    this.sendToPlayer(blockerId, {
      type: 'social:friend_updated',
      actorId: targetPlayerId,
      action: 'unblocked',
    });
    await this.pushOverviewToPlayers([blockerId]);
    return { ok: true as const };
  }

  private async handleSendInvite(
    senderPlayerId: string,
    senderSessionId: string | null,
    input: {
      targetPlayerId: string;
      ruleProfileId?: RuleProfileId;
      calledShotsEnabled?: boolean;
      ttlMs?: number;
    },
  ): Promise<{ ok: true; invitation: MatchInvitationRecord } | SocialError> {
    await this.pruneExpiredWaitingRooms();
    const senderSess =
      (senderSessionId ? this.getSession(senderSessionId) : null) ??
      this.findLatestSessionByPlayerId(senderPlayerId);

    if (senderSess?.in_matchmaking === 1) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_IN_MATCH',
        message: 'Cancel matchmaking before sending a direct match invitation.',
      };
    }

    let attachedRoomId: string | null = null;
    let attachedRoomCode: string | null = null;

    if (senderSess?.active_room_id) {
      const roomRows = this.ctx.storage.sql
        .exec<{
          room_id: string;
          room_code: string;
          host_session_id: string;
          status: string;
          expires_at_ms: number;
          rule_profile_id: string;
          called_shots_enabled: number;
        }>('SELECT * FROM rooms WHERE room_id = ? LIMIT 1', senderSess.active_room_id)
        .toArray();
      const row = roomRows[0];
      if (!row || row.status === 'playing' || Date.now() >= row.expires_at_ms) {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_IN_MATCH',
          message: 'Finish or leave your current match before inviting another friend.',
        };
      }
      if (row.host_session_id !== senderSess.session_id || row.status !== 'waiting') {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_IN_MATCH',
          message: 'Your current room already has a challenger.',
        };
      }
      attachedRoomId = row.room_id;
      attachedRoomCode = row.room_code;
    }

    const social = this.getSocialService();
    const requestedTtl =
      typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs)
        ? Math.max(500, Math.min(this.config.inviteTtlMs, input.ttlMs))
        : this.config.inviteTtlMs;

    const res = await social.createInvitation({
      senderId: senderPlayerId,
      targetPlayerId: input.targetPlayerId,
      roomId: attachedRoomId,
      roomCode: attachedRoomCode,
      ruleProfileId: input.ruleProfileId === 'wpa' ? 'wpa' : 'casual',
      calledShotsEnabled: Boolean(input.calledShotsEnabled),
      ttlMs: requestedTtl,
    });
    if (!res.ok) return res;

    this.sendToPlayer(res.invitation.recipientId, {
      type: 'invite:received',
      invitation: res.invitation,
    });
    this.sendToPlayer(res.invitation.senderId, {
      type: 'invite:updated',
      invitation: res.invitation,
    });
    await this.pushOverviewToPlayers([res.invitation.senderId, res.invitation.recipientId]);
    await this.scheduleNextAlarm();
    return { ok: true, invitation: res.invitation };
  }

  private async handleRespondInvite(
    actorPlayerId: string,
    actorSessionId: string | null,
    inviteId: string,
    action: MatchInviteAction,
  ): Promise<
    | { ok: true; invitation: MatchInvitationRecord; room?: OnlineRoomInfo }
    | SocialError
  > {
    await this.pruneExpiredWaitingRooms();
    const social = this.getSocialService();
    const check = await social.getPendingInvitationForAction(actorPlayerId, inviteId, action);
    if (!check.ok) {
      if (check.code === 'INVITE_EXPIRED') {
        await this.pushOverviewToPlayers([actorPlayerId]);
      }
      return check;
    }

    const inv = check.invitation;
    if (action === 'reject' || action === 'cancel') {
      const nextStatus = action === 'reject' ? 'rejected' : 'cancelled';
      const updated = (await social.updateInvitationStatus(inv.inviteId, nextStatus)) ?? {
        ...inv,
        status: nextStatus,
        respondedAtMs: Date.now(),
      };
      this.sendToPlayer(inv.senderId, { type: 'invite:updated', invitation: updated });
      this.sendToPlayer(inv.recipientId, { type: 'invite:updated', invitation: updated });
      await this.pushOverviewToPlayers([inv.senderId, inv.recipientId]);
      return { ok: true, invitation: updated };
    }

    // Action === 'accept'
    const recipientSess =
      (actorSessionId ? this.getSession(actorSessionId) : null) ??
      this.findLatestSessionByPlayerId(actorPlayerId);

    if (!recipientSess) {
      return {
        ok: false,
        status: 409,
        code: 'PLAYER_OFFLINE',
        message: 'Connect to the online multiplayer service before accepting an invitation.',
      };
    }
    if (recipientSess.active_room_id || recipientSess.in_matchmaking === 1) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_IN_MATCH',
        message: 'Leave your current room or matchmaking queue before accepting an invitation.',
      };
    }

    // Case A: Invitation already references a waiting private room
    if (inv.roomId) {
      const roomRows = this.ctx.storage.sql
        .exec<{ room_id: string; room_code: string; status: string; expires_at_ms: number }>(
          'SELECT room_id, room_code, status, expires_at_ms FROM rooms WHERE room_id = ? LIMIT 1',
          inv.roomId,
        )
        .toArray();
      const row = roomRows[0];
      if (!row || Date.now() >= row.expires_at_ms || row.status !== 'waiting') {
        const expiredInv = (await social.updateInvitationStatus(inv.inviteId, 'expired')) ?? {
          ...inv,
          status: 'expired' as const,
          respondedAtMs: Date.now(),
        };
        this.sendToPlayer(inv.senderId, { type: 'invite:updated', invitation: expiredInv });
        this.sendToPlayer(inv.recipientId, { type: 'invite:updated', invitation: expiredInv });
        await this.pushOverviewToPlayers([inv.senderId, inv.recipientId]);
        return {
          ok: false,
          status: 410,
          code: 'ROOM_EXPIRED',
          message: 'The invited private room has expired or is no longer waiting.',
        };
      }

      const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(row.room_id));
      const joinRes = await roomStub.joinRoom({
        sessionId: recipientSess.session_id,
        playerId: actorPlayerId,
        reconnectToken: recipientSess.reconnect_token,
        displayName: recipientSess.display_name,
        avatarId: sanitizeAvatarId(recipientSess.avatar_id),
        latencyMs: recipientSess.latency_ms,
      });

      if (!joinRes.ok) {
        if (joinRes.code === 'ROOM_EXPIRED' || joinRes.code === 'INVALID_ROOM') {
          await social.updateInvitationStatus(inv.inviteId, 'expired');
        }
        return { ok: false, status: 409, code: joinRes.code, message: joinRes.message };
      }

      this.ctx.storage.sql.exec(
        'UPDATE sessions SET active_room_id = ?, in_matchmaking = 0 WHERE session_id = ?',
        row.room_id,
        recipientSess.session_id,
      );
      this.ctx.storage.sql.exec(
        'UPDATE rooms SET expires_at_ms = ?, status = ? WHERE room_id = ?',
        joinRes.room.expiresAtMs,
        joinRes.room.status,
        row.room_id,
      );

      const acceptedInv = (await social.updateInvitationStatus(inv.inviteId, 'accepted', {
        roomId: row.room_id,
        roomCode: row.room_code,
      })) ?? { ...inv, status: 'accepted' as const, respondedAtMs: Date.now() };

      this.sendToPlayer(inv.senderId, {
        type: 'invite:updated',
        invitation: acceptedInv,
        room: joinRes.room,
      });
      this.sendToPlayer(inv.recipientId, {
        type: 'invite:updated',
        invitation: acceptedInv,
        room: joinRes.room,
      });
      this.sendToPlayer(inv.senderId, { type: 'room:updated', room: joinRes.room });
      this.sendToPlayer(inv.recipientId, { type: 'room:updated', room: joinRes.room });
      await this.pushOverviewToPlayers([inv.senderId, inv.recipientId]);
      await this.scheduleNextAlarm();
      return { ok: true, invitation: acceptedInv, room: joinRes.room };
    }

    // Case B: Direct invitation without pre-created room — verify sender is online & free, then create private room
    const senderSockets = this.findSocketsByPlayerId(inv.senderId);
    const senderSess = this.findLatestConnectedSessionByPlayerId(inv.senderId);
    if (senderSockets.length === 0 || !senderSess) {
      const expiredInv = (await social.updateInvitationStatus(inv.inviteId, 'expired')) ?? {
        ...inv,
        status: 'expired' as const,
        respondedAtMs: Date.now(),
      };
      this.sendToPlayer(inv.recipientId, { type: 'invite:updated', invitation: expiredInv });
      await this.pushOverviewToPlayers([inv.senderId, inv.recipientId]);
      return {
        ok: false,
        status: 409,
        code: 'PLAYER_OFFLINE',
        message: `${inv.senderName} is no longer online to host this match.`,
      };
    }

    if (senderSess.active_room_id || senderSess.in_matchmaking === 1) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_IN_MATCH',
        message: `${inv.senderName} is currently busy in another room or queue.`,
      };
    }

    const now = Date.now();
    const expiresAtMs = now + this.config.roomTtlMs;
    const roomId = `room_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const roomCode = this.generateUniqueCode();

    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (
        room_id, room_code, host_session_id, is_private, rule_profile_id,
        called_shots_enabled, status, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, 1, ?, ?, 'waiting', ?, ?)`,
      roomId,
      roomCode,
      senderSess.session_id,
      inv.ruleProfileId,
      inv.calledShotsEnabled ? 1 : 0,
      now,
      expiresAtMs,
    );

    const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomId));
    await roomStub.initPrivateRoom({
      roomId,
      roomCode,
      ruleProfileId: inv.ruleProfileId,
      calledShotsEnabled: inv.calledShotsEnabled,
      createdAtMs: now,
      expiresAtMs,
      host: {
        sessionId: senderSess.session_id,
        playerId: inv.senderId,
        reconnectToken: senderSess.reconnect_token,
        displayName: senderSess.display_name,
        avatarId: sanitizeAvatarId(senderSess.avatar_id),
        latencyMs: senderSess.latency_ms,
      },
    });

    const joinRes = await roomStub.joinRoom({
      sessionId: recipientSess.session_id,
      playerId: actorPlayerId,
      reconnectToken: recipientSess.reconnect_token,
      displayName: recipientSess.display_name,
      avatarId: sanitizeAvatarId(recipientSess.avatar_id),
      latencyMs: recipientSess.latency_ms,
    });

    if (!joinRes.ok) {
      this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_id = ?', roomId);
      return { ok: false, status: 409, code: joinRes.code, message: joinRes.message };
    }

    this.ctx.storage.sql.exec(
      'UPDATE sessions SET active_room_id = ?, in_matchmaking = 0 WHERE session_id IN (?, ?)',
      roomId,
      senderSess.session_id,
      recipientSess.session_id,
    );
    this.ctx.storage.sql.exec(
      'UPDATE rooms SET expires_at_ms = ?, status = ? WHERE room_id = ?',
      joinRes.room.expiresAtMs,
      joinRes.room.status,
      roomId,
    );

    const acceptedInv = (await social.updateInvitationStatus(inv.inviteId, 'accepted', {
      roomId,
      roomCode,
    })) ?? {
      ...inv,
      roomId,
      roomCode,
      status: 'accepted' as const,
      respondedAtMs: Date.now(),
    };

    this.sendToPlayer(inv.senderId, {
      type: 'invite:updated',
      invitation: acceptedInv,
      room: joinRes.room,
    });
    this.sendToPlayer(inv.recipientId, {
      type: 'invite:updated',
      invitation: acceptedInv,
      room: joinRes.room,
    });
    this.sendToPlayer(inv.senderId, { type: 'room:created', room: joinRes.room });
    this.sendToPlayer(inv.recipientId, { type: 'room:updated', room: joinRes.room });
    await this.pushOverviewToPlayers([inv.senderId, inv.recipientId]);
    await this.scheduleNextAlarm();

    return { ok: true, invitation: acceptedInv, room: joinRes.room };
  }

  private async handleSendDirectMessage(
    senderId: string,
    recipientId: string,
    rawBody: unknown,
    clientMessageId?: string,
  ): Promise<{ ok: true; message: DirectMessageRecord } | SocialError> {
    const social = this.getSocialService();
    const textCheck = sanitizeChatText(rawBody);
    if (!textCheck.ok) {
      return { ok: false, status: 400, code: textCheck.code, message: textCheck.message };
    }

    const res = await social.sendDirectMessage({
      senderId,
      recipientId,
      body: textCheck.text,
    });
    if (!res.ok) return res;

    this.sendToPlayer(senderId, {
      type: 'chat:dm_message',
      message: res.message,
      clientMessageId,
    });
    this.sendToPlayer(recipientId, {
      type: 'chat:dm_message',
      message: res.message,
    });
    await this.pushOverviewToPlayers([recipientId]);
    return { ok: true, message: res.message };
  }

  private async broadcastPresenceChanged(
    playerId: string,
    status: PresenceStatus,
    lastSeenAtMs: number,
  ): Promise<void> {
    const msg: ServerToClientMessage = {
      type: 'social:presence_changed',
      playerId,
      status,
      lastSeenAtMs,
    };
    this.sendToPlayer(playerId, msg);
    const friendIds = await this.getSocialService().getFriendIds(playerId);
    for (const fid of friendIds) {
      this.sendToPlayer(fid, msg);
    }
  }

  private async pushOverviewToPlayers(playerIds: string[]): Promise<void> {
    const social = this.getSocialService();
    const seen = new Set<string>();
    for (const pid of playerIds) {
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      if (this.findSocketsByPlayerId(pid).length === 0) continue;
      try {
        const overview = await social.getOverview(pid);
        this.sendToPlayer(pid, { type: 'social:state', overview });
      } catch {
        // Non-blocking
      }
    }
  }

  private async pruneExpiredSocialState(): Promise<{
    expiredPresenceIds: string[];
    expiredInviteIds: string[];
  }> {
    const now = Date.now();
    const social = this.getSocialService();
    const expiredPresence = await social.expireStalePresence(now);
    for (const entry of expiredPresence) {
      await this.broadcastPresenceChanged(entry.playerId, 'offline', entry.lastSeenAtMs);
    }

    const expiredInvites = await social.expirePendingInvitations(now);
    for (const inv of expiredInvites) {
      this.sendToPlayer(inv.senderId, { type: 'invite:updated', invitation: inv });
      this.sendToPlayer(inv.recipientId, { type: 'invite:updated', invitation: inv });
    }
    if (expiredInvites.length > 0) {
      const affected = new Set<string>();
      for (const inv of expiredInvites) {
        affected.add(inv.senderId);
        affected.add(inv.recipientId);
      }
      await this.pushOverviewToPlayers([...affected]);
    }

    return {
      expiredPresenceIds: expiredPresence.map((e) => e.playerId),
      expiredInviteIds: expiredInvites.map((i) => i.inviteId),
    };
  }

  private async resolvePersistentPlayerIdentity(input: {
    playerId?: string | null;
    playerToken?: string | null;
    displayName?: string | null;
    avatarId?: OnlineAvatarId | null;
  }): Promise<{
    playerId: string;
    playerToken?: string;
    displayName: string;
    avatarId: OnlineAvatarId;
  }> {
    const fallbackName = sanitizeDisplayName(input.displayName);
    const fallbackAvatar = sanitizeAvatarId(input.avatarId);

    try {
      const svc = this.getProgressionService();
      const res = await svc.authenticateOrCreatePlayer({
        playerId: input.playerId,
        playerToken: input.playerToken,
        displayName: input.displayName,
        avatarId: input.avatarId,
      });
      if (res.ok) {
        return {
          playerId: res.playerId,
          playerToken: res.playerToken,
          displayName: res.profile.displayName,
          avatarId: sanitizeAvatarId(res.profile.avatarId),
        };
      }
    } catch {
      // Fallback cleanly if progression storage is temporarily busy
    }

    return {
      playerId: `ply_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      displayName: fallbackName,
      avatarId: fallbackAvatar,
    };
  }

  private createSession(
    displayName?: string,
    avatarId?: OnlineAvatarId,
    latencyMs = 35,
    playerId?: string,
  ): SessionRow {
    const now = Date.now();
    const sessionId = `ply_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const row: SessionRow = {
      session_id: sessionId,
      player_id: playerId ?? sessionId,
      reconnect_token: randomHexToken(24),
      display_name: sanitizeDisplayName(displayName),
      avatar_id: sanitizeAvatarId(avatarId),
      latency_ms: clampLatency(latencyMs),
      active_room_id: null,
      in_matchmaking: 0,
      created_at_ms: now,
      last_seen_at_ms: now,
    };

    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (
        session_id, player_id, reconnect_token, display_name, avatar_id, latency_ms,
        active_room_id, in_matchmaking, created_at_ms, last_seen_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
      row.session_id,
      row.player_id,
      row.reconnect_token,
      row.display_name,
      row.avatar_id,
      row.latency_ms,
      row.created_at_ms,
      row.last_seen_at_ms,
    );

    return row;
  }

  private getSession(sessionId: string): SessionRow | null {
    const rows = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>('SELECT * FROM sessions WHERE session_id = ? LIMIT 1', sessionId)
      .toArray();
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      session_id: String(r.session_id),
      player_id: r.player_id ? String(r.player_id) : String(r.session_id),
      reconnect_token: String(r.reconnect_token),
      display_name: String(r.display_name),
      avatar_id: String(r.avatar_id),
      latency_ms: Number(r.latency_ms),
      active_room_id: r.active_room_id ? String(r.active_room_id) : null,
      in_matchmaking: Number(r.in_matchmaking),
      created_at_ms: Number(r.created_at_ms),
      last_seen_at_ms: Number(r.last_seen_at_ms),
    };
  }

  private findLatestSessionByPlayerId(playerId: string): SessionRow | null {
    const rows = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        'SELECT * FROM sessions WHERE player_id = ? ORDER BY last_seen_at_ms DESC LIMIT 1',
        playerId,
      )
      .toArray();
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      session_id: String(r.session_id),
      player_id: r.player_id ? String(r.player_id) : String(r.session_id),
      reconnect_token: String(r.reconnect_token),
      display_name: String(r.display_name),
      avatar_id: String(r.avatar_id),
      latency_ms: Number(r.latency_ms),
      active_room_id: r.active_room_id ? String(r.active_room_id) : null,
      in_matchmaking: Number(r.in_matchmaking),
      created_at_ms: Number(r.created_at_ms),
      last_seen_at_ms: Number(r.last_seen_at_ms),
    };
  }

  private findLatestConnectedSessionByPlayerId(playerId: string): SessionRow | null {
    const sockets = this.findSocketsByPlayerId(playerId);
    for (const ws of sockets) {
      const att = this.getAttachment(ws);
      if (att.sessionId) {
        const sess = this.getSession(att.sessionId);
        if (sess) return sess;
      }
    }
    return null;
  }

  private verifyReconnect(sessionId: string, reconnectToken: string): SessionRow | null {
    if (typeof sessionId !== 'string' || typeof reconnectToken !== 'string') return null;
    const sess = this.getSession(sessionId);
    if (!sess) return null;
    if (!constantTimeEqual(reconnectToken, sess.reconnect_token)) return null;
    this.ctx.storage.sql.exec(
      'UPDATE sessions SET last_seen_at_ms = ? WHERE session_id = ?',
      Date.now(),
      sess.session_id,
    );
    return sess;
  }

  private bindSocketToSession(ws: WebSocket, sessionId: string, playerId: string): void {
    for (const existing of this.ctx.getWebSockets()) {
      if (existing === ws) continue;
      const att = this.getAttachment(existing);
      if (att.sessionId === sessionId) {
        att.sessionId = null;
        att.playerId = null;
        existing.serializeAttachment(att);
        try {
          existing.close(4001, 'Replaced by resumed session');
        } catch {
          // Ignore close errors
        }
      }
    }
    ws.serializeAttachment({ sessionId, playerId } satisfies LobbySocketAttachment);
  }

  private findSocketBySession(sessionId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.getAttachment(ws).sessionId === sessionId) {
        return ws;
      }
    }
    return null;
  }

  private findSocketsByPlayerId(playerId: string): WebSocket[] {
    const result: WebSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (att.playerId === playerId) {
        result.push(ws);
      }
    }
    return result;
  }

  private sendToPlayer(playerId: string, msg: ServerToClientMessage): void {
    const encoded = JSON.stringify(msg);
    for (const ws of this.findSocketsByPlayerId(playerId)) {
      try {
        ws.send(encoded);
      } catch {
        // Ignore closed socket
      }
    }
  }

  private cancelMatchmaking(sessionId: string, reason: string): boolean {
    const existing = this.ctx.storage.sql
      .exec<{ session_id: string }>(
        'SELECT session_id FROM match_queue WHERE session_id = ? LIMIT 1',
        sessionId,
      )
      .toArray();

    this.ctx.storage.sql.exec('DELETE FROM match_queue WHERE session_id = ?', sessionId);
    this.ctx.storage.sql.exec(
      'UPDATE sessions SET in_matchmaking = 0 WHERE session_id = ?',
      sessionId,
    );

    if (existing.length === 0) return false;

    const ws = this.findSocketBySession(sessionId);
    if (ws) {
      this.sendSocket(ws, { type: 'matchmaking:cancelled', reason });
    }
    return true;
  }

  private async processQueue(): Promise<void> {
    if (this.matchingBusy) return;
    this.matchingBusy = true;

    try {
      const now = Date.now();
      const rawRows = this.ctx.storage.sql
        .exec<Record<string, SqlStorageValue>>('SELECT * FROM match_queue ORDER BY joined_at_ms ASC')
        .toArray();

      const queue: QueueRow[] = [];
      for (const r of rawRows) {
        const sid = String(r.session_id);
        const sess = this.getSession(sid);
        const ws = this.findSocketBySession(sid);
        if (!sess || !ws || sess.active_room_id) {
          this.ctx.storage.sql.exec('DELETE FROM match_queue WHERE session_id = ?', sid);
          this.ctx.storage.sql.exec(
            'UPDATE sessions SET in_matchmaking = 0 WHERE session_id = ?',
            sid,
          );
          continue;
        }
        const timeoutAtMs = Number(r.timeout_at_ms);
        if (now >= timeoutAtMs) {
          this.ctx.storage.sql.exec('DELETE FROM match_queue WHERE session_id = ?', sid);
          this.ctx.storage.sql.exec(
            'UPDATE sessions SET in_matchmaking = 0 WHERE session_id = ?',
            sid,
          );
          this.sendSocket(ws, {
            type: 'matchmaking:timeout',
            message: 'No opponent found before timeout. Please try again or create a private room.',
          });
          continue;
        }

        queue.push({
          session_id: sid,
          rule_profile_id: r.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
          called_shots_enabled: Number(r.called_shots_enabled),
          joined_at_ms: Number(r.joined_at_ms),
          timeout_at_ms: timeoutAtMs,
          latency_ms: sess.latency_ms,
        });
      }

      while (queue.length >= 2) {
        let matchedPair: [number, number] | null = null;

        for (let i = 0; i < queue.length; i++) {
          const a = queue[i];
          const waitSecA = Math.max(0, (now - a.joined_at_ms) / 1000);

          for (let j = i + 1; j < queue.length; j++) {
            const b = queue[j];
            if (a.session_id === b.session_id) continue;

            const waitSecBoth = Math.min(waitSecA, Math.max(0, (now - b.joined_at_ms) / 1000));
            const sameRules =
              a.rule_profile_id === b.rule_profile_id &&
              a.called_shots_enabled === b.called_shots_enabled;
            if (!sameRules && waitSecBoth < 10) continue;

            const latencyDiff = Math.abs(a.latency_ms - b.latency_ms);
            const allowedSpread = this.config.maxLatencySpreadMs + waitSecBoth * 25;
            if (latencyDiff <= allowedSpread) {
              matchedPair = [i, j];
              break;
            }
          }
          if (matchedPair) break;
        }

        if (!matchedPair) break;

        const [idxA, idxB] = matchedPair;
        const entryB = queue.splice(idxB, 1)[0];
        const entryA = queue.splice(idxA, 1)[0];

        const sessA = this.getSession(entryA.session_id);
        const sessB = this.getSession(entryB.session_id);
        const wsA = this.findSocketBySession(entryA.session_id);
        const wsB = this.findSocketBySession(entryB.session_id);

        this.ctx.storage.sql.exec(
          'DELETE FROM match_queue WHERE session_id IN (?, ?)',
          entryA.session_id,
          entryB.session_id,
        );
        this.ctx.storage.sql.exec(
          'UPDATE sessions SET in_matchmaking = 0 WHERE session_id IN (?, ?)',
          entryA.session_id,
          entryB.session_id,
        );

        if (!sessA || !sessB || !wsA || !wsB) {
          continue;
        }

        const roomId = `room_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const roomCode = this.generateUniqueCode();
        const ruleProfileId: RuleProfileId =
          entryA.rule_profile_id === 'wpa' ? 'wpa' : 'casual';
        const calledShotsEnabled = entryA.called_shots_enabled === 1;
        const expiresAtMs = now + this.config.roomTtlMs;

        this.ctx.storage.sql.exec(
          `INSERT INTO rooms (
            room_id, room_code, host_session_id, is_private, rule_profile_id,
            called_shots_enabled, status, created_at_ms, expires_at_ms
          ) VALUES (?, ?, ?, 0, ?, ?, 'playing', ?, ?)`,
          roomId,
          roomCode,
          sessA.session_id,
          ruleProfileId,
          calledShotsEnabled ? 1 : 0,
          now,
          expiresAtMs,
        );
        this.ctx.storage.sql.exec(
          'UPDATE sessions SET active_room_id = ?, in_matchmaking = 0 WHERE session_id IN (?, ?)',
          roomId,
          sessA.session_id,
          sessB.session_id,
        );

        const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomId));
        const started = await roomStub.initMatchedRoom({
          roomId,
          roomCode,
          ruleProfileId,
          calledShotsEnabled,
          createdAtMs: now,
          expiresAtMs,
          player1: {
            sessionId: sessA.session_id,
            playerId: sessA.player_id ?? sessA.session_id,
            reconnectToken: sessA.reconnect_token,
            displayName: sessA.display_name,
            avatarId: sanitizeAvatarId(sessA.avatar_id),
            latencyMs: sessA.latency_ms,
          },
          player2: {
            sessionId: sessB.session_id,
            playerId: sessB.player_id ?? sessB.session_id,
            reconnectToken: sessB.reconnect_token,
            displayName: sessB.display_name,
            avatarId: sanitizeAvatarId(sessB.avatar_id),
            latencyMs: sessB.latency_ms,
          },
        });

        await this.onRoomStatusChanged(roomId, 'playing', [
          sessA.player_id ?? sessA.session_id,
          sessB.player_id ?? sessB.session_id,
        ]);

        this.sendSocket(wsA, { type: 'matchmaking:matched', room: started.room });
        this.sendSocket(wsB, { type: 'matchmaking:matched', room: started.room });
      }
    } finally {
      this.matchingBusy = false;
    }
  }

  private async pruneExpiredWaitingRooms(): Promise<void> {
    const now = Date.now();
    const expired = this.ctx.storage.sql
      .exec<{ room_id: string }>(
        "SELECT room_id FROM rooms WHERE status IN ('waiting', 'ready') AND expires_at_ms <= ?",
        now,
      )
      .toArray();

    for (const row of expired) {
      this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_id = ?', row.room_id);
      this.ctx.storage.sql.exec(
        'UPDATE sessions SET active_room_id = NULL WHERE active_room_id = ?',
        row.room_id,
      );
      const expiredInvites = await this.getSocialService().expireInvitationsForRoom(
        row.room_id,
        'expired',
      );
      for (const inv of expiredInvites) {
        this.sendToPlayer(inv.senderId, { type: 'invite:updated', invitation: inv });
        this.sendToPlayer(inv.recipientId, { type: 'invite:updated', invitation: inv });
      }
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const queueCount = this.getQueueCount();
    const earliestRoomExpiry = this.ctx.storage.sql
      .exec<{ m: number | null }>(
        "SELECT MIN(expires_at_ms) AS m FROM rooms WHERE status IN ('waiting', 'ready')",
      )
      .one().m;

    const now = Date.now();
    const candidates: number[] = [];
    if (queueCount > 0) {
      candidates.push(now + 1000);
    }
    if (typeof earliestRoomExpiry === 'number' && Number.isFinite(earliestRoomExpiry)) {
      candidates.push(earliestRoomExpiry);
    }

    try {
      const socialExpiry = await this.getSocialService().getEarliestExpiryTimes();
      if (socialExpiry.presenceExpiryMs !== null) {
        candidates.push(Math.max(now + 500, socialExpiry.presenceExpiryMs));
      }
      if (socialExpiry.inviteExpiryMs !== null) {
        candidates.push(Math.max(now + 500, socialExpiry.inviteExpiryMs));
      }
    } catch {
      // Ignore if social schema not yet ready
    }

    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private getQueueCount(): number {
    return Number(
      this.ctx.storage.sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM match_queue').one().c,
    );
  }

  private generateUniqueCode(): string {
    const existingRows = this.ctx.storage.sql
      .exec<{ room_code: string }>('SELECT room_code FROM rooms')
      .toArray();
    const used = new Set(existingRows.map((r) => r.room_code));
    const rand = new Uint8Array(6);

    for (let attempt = 0; attempt < 30; attempt++) {
      crypto.getRandomValues(rand);
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += ROOM_CODE_CHARS[rand[i] % ROOM_CODE_CHARS.length];
      }
      if (!used.has(code)) return code;
    }

    return crypto.randomUUID().slice(0, 6).toUpperCase();
  }

  private checkRateLimit(ws: WebSocket): boolean {
    const now = Date.now();
    const cutoff = now - 1000;
    let stamps = this.rateMap.get(ws);
    if (!stamps) {
      stamps = [];
      this.rateMap.set(ws, stamps);
    }
    while (stamps.length > 0 && stamps[0] < cutoff) {
      stamps.shift();
    }
    if (stamps.length >= this.config.rateLimitMaxMsgPerSec) {
      return false;
    }
    stamps.push(now);
    return true;
  }

  private getAttachment(ws: WebSocket): LobbySocketAttachment {
    const raw = ws.deserializeAttachment() as LobbySocketAttachment | null;
    return raw ? { sessionId: raw.sessionId ?? null, playerId: raw.playerId ?? null } : { sessionId: null, playerId: null };
  }

  private sendSocket(ws: WebSocket, msg: ServerToClientMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Ignore closed socket
    }
  }

  private sendError(ws: WebSocket, code: MultiplayerErrorCode, message: string): void {
    this.sendSocket(ws, { type: 'error', code, message });
  }
}
