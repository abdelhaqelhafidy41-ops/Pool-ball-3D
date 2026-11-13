import { DurableObject } from 'cloudflare:workers';
import type { RuleProfileId } from '../../src/game/rules/types';
import type {
  ClientToServerMessage,
  MatchHistoryRecord,
  MultiplayerErrorCode,
  OnlineAvatarId,
  OnlineRoomStatus,
  ServerToClientMessage,
} from '../../src/multiplayer/shared/protocol';
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

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface LobbySocketAttachment {
  sessionId: string | null;
}

interface SessionRow {
  session_id: string;
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
        player1_name TEXT NOT NULL,
        player2_name TEXT NOT NULL,
        winner_name TEXT NOT NULL,
        winner_role TEXT NOT NULL,
        reason TEXT NOT NULL,
        total_shots INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL
      );
    `);
    this.schemaReady = true;
  }

  public async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const att: LobbySocketAttachment = { sessionId: null };
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
      this.sendSocket(ws, {
        type: 'pong',
        clientTimeMs: typeof msg.clientTimeMs === 'number' ? msg.clientTimeMs : Date.now(),
        serverTimeMs: Date.now(),
      });
      return;
    }

    if (msg.type === 'session:init') {
      const sess = this.createSession(msg.displayName, msg.avatarId, msg.latencyMs);
      this.bindSocketToSession(ws, sess.session_id);
      this.sendSocket(ws, {
        type: 'session:ready',
        sessionId: sess.session_id,
        reconnectToken: sess.reconnect_token,
        displayName: sess.display_name,
        avatarId: sanitizeAvatarId(sess.avatar_id),
        resumedRoom: null,
        resumedMatch: null,
        balls: null,
        serverTimeMs: Date.now(),
      });
      return;
    }

    if (msg.type === 'session:resume') {
      const verified = this.verifyReconnect(msg.sessionId, msg.reconnectToken);
      if (!verified) {
        const fresh = this.createSession(msg.displayName, msg.avatarId);
        this.bindSocketToSession(ws, fresh.session_id);
        this.sendSocket(ws, {
          type: 'session:ready',
          sessionId: fresh.session_id,
          reconnectToken: fresh.reconnect_token,
          displayName: fresh.display_name,
          avatarId: sanitizeAvatarId(fresh.avatar_id),
          resumedRoom: null,
          resumedMatch: null,
          balls: null,
          serverTimeMs: Date.now(),
        });
        return;
      }

      if (msg.displayName || msg.avatarId) {
        const nextName = sanitizeDisplayName(msg.displayName ?? verified.display_name);
        const nextAvatar = sanitizeAvatarId(msg.avatarId ?? verified.avatar_id);
        this.ctx.storage.sql.exec(
          'UPDATE sessions SET display_name = ?, avatar_id = ?, last_seen_at_ms = ? WHERE session_id = ?',
          nextName,
          nextAvatar,
          Date.now(),
          verified.session_id,
        );
        verified.display_name = nextName;
        verified.avatar_id = nextAvatar;
      }

      this.bindSocketToSession(ws, verified.session_id);

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
        displayName: verified.display_name,
        avatarId: sanitizeAvatarId(verified.avatar_id),
        resumedRoom,
        resumedMatch,
        balls,
        serverTimeMs: Date.now(),
      });
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
        if (session.active_room_id) {
          const roomStub = this.env.POOL_ROOM.get(
            this.env.POOL_ROOM.idFromName(session.active_room_id),
          );
          await roomStub.updatePlayerProfile(session.session_id, name, avatar);
        }
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
    await this.scheduleNextAlarm();
  }

  public async onRoomStatusChanged(roomId: string, status: OnlineRoomStatus): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      'UPDATE rooms SET status = ? WHERE room_id = ?',
      status,
      roomId,
    );
  }

  public async onPlayerLeftRoom(roomId: string, sessionId: string): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      'UPDATE sessions SET active_room_id = NULL WHERE session_id = ? AND active_room_id = ?',
      sessionId,
      roomId,
    );
  }

  public async onRoomClosed(roomId: string, sessionIds: string[]): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_id = ?', roomId);
    for (const sid of sessionIds) {
      this.ctx.storage.sql.exec(
        'UPDATE sessions SET active_room_id = NULL WHERE session_id = ? AND active_room_id = ?',
        sid,
        roomId,
      );
    }
  }

  public async recordMatchHistory(record: MatchHistoryRecord): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO match_history (
        match_id, room_id, player1_name, player2_name, winner_name,
        winner_role, reason, total_shots, ended_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.matchId,
      record.roomId,
      record.player1Name,
      record.player2Name,
      record.winnerName,
      record.winnerRole,
      record.reason,
      record.totalShots,
      record.endedAtMs,
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

    return rows.map((r) => ({
      matchId: String(r.match_id),
      roomId: String(r.room_id),
      player1Name: String(r.player1_name),
      player2Name: String(r.player2_name),
      winnerName: String(r.winner_name),
      winnerRole: r.winner_role === 'player2' ? 'player2' : 'player1',
      reason: String(r.reason),
      totalShots: Number(r.total_shots),
      endedAtMs: Number(r.ended_at_ms),
    }));
  }

  private async handleSocketDisconnected(ws: WebSocket): Promise<void> {
    const att = this.getAttachment(ws);
    if (!att.sessionId) return;

    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && this.getAttachment(other).sessionId === att.sessionId) {
        return;
      }
    }

    this.cancelMatchmaking(att.sessionId, 'Disconnected from queue.');
    await this.scheduleNextAlarm();
  }

  private createSession(
    displayName?: string,
    avatarId?: OnlineAvatarId,
    latencyMs = 35,
  ): SessionRow {
    const now = Date.now();
    const row: SessionRow = {
      session_id: `ply_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
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
        session_id, reconnect_token, display_name, avatar_id, latency_ms,
        active_room_id, in_matchmaking, created_at_ms, last_seen_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
      row.session_id,
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

  private bindSocketToSession(ws: WebSocket, sessionId: string): void {
    for (const existing of this.ctx.getWebSockets()) {
      if (existing === ws) continue;
      const att = this.getAttachment(existing);
      if (att.sessionId === sessionId) {
        att.sessionId = null;
        existing.serializeAttachment(att);
        try {
          existing.close(4001, 'Replaced by resumed session');
        } catch {
          // Ignore close errors
        }
      }
    }
    ws.serializeAttachment({ sessionId } satisfies LobbySocketAttachment);
  }

  private findSocketBySession(sessionId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.getAttachment(ws).sessionId === sessionId) {
        return ws;
      }
    }
    return null;
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
            reconnectToken: sessA.reconnect_token,
            displayName: sessA.display_name,
            avatarId: sanitizeAvatarId(sessA.avatar_id),
            latencyMs: sessA.latency_ms,
          },
          player2: {
            sessionId: sessB.session_id,
            reconnectToken: sessB.reconnect_token,
            displayName: sessB.display_name,
            avatarId: sanitizeAvatarId(sessB.avatar_id),
            latencyMs: sessB.latency_ms,
          },
        });

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
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const queueCount = this.getQueueCount();
    const earliestExpiry = this.ctx.storage.sql
      .exec<{ m: number | null }>(
        "SELECT MIN(expires_at_ms) AS m FROM rooms WHERE status IN ('waiting', 'ready')",
      )
      .one().m;

    const now = Date.now();
    const candidates: number[] = [];
    if (queueCount > 0) {
      candidates.push(now + 1000);
    }
    if (typeof earliestExpiry === 'number' && Number.isFinite(earliestExpiry)) {
      candidates.push(earliestExpiry);
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
    return raw ?? { sessionId: null };
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
