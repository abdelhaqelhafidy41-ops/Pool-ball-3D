import { DurableObject } from 'cloudflare:workers';
import type { PlayerId, PocketId, RuleProfileId } from '../../src/game/rules/types';
import type {
  ClientToServerMessage,
  MatchHistoryRecord,
  MultiplayerErrorCode,
  OnlineAvatarId,
  OnlineBallFrame,
  OnlineMatchSnapshot,
  OnlinePlayerProfile,
  OnlineRoomInfo,
  OnlineRoomStatus,
  ServerToClientMessage,
} from '../../src/multiplayer/shared/protocol';
import {
  clampLatency,
  constantTimeEqual,
  loadWorkerConfig,
  sanitizeAvatarId,
  sanitizeDisplayName,
  type Env,
  type WorkerRuntimeConfig,
} from './config';
import { D1ProgressionService } from './D1ProgressionService';
import {
  WorkerMatchManager,
  type PersistedMatchState,
} from './WorkerMatchManager';
import type {
  MatchProgressionRewardSummary,
  MatchTelemetrySummaryForProgression,
} from '../../src/multiplayer/shared/progression';

interface RoomSocketAttachment {
  sessionId: string | null;
  role: PlayerId | null;
}

interface StoredPlayerRecord extends OnlinePlayerProfile {
  reconnectToken: string;
}

interface StoredRoomState {
  roomId: string;
  roomCode: string;
  hostSessionId: string;
  isPrivate: boolean;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  status: OnlineRoomStatus;
  createdAtMs: number;
  expiresAtMs: number;
  players: StoredPlayerRecord[];
}

export interface InitRoomPlayerInput {
  sessionId: string;
  playerId?: string;
  reconnectToken: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  latencyMs: number;
}

export class PoolRoomDurableObject extends DurableObject<Env> {
  private readonly config: WorkerRuntimeConfig;
  private schemaReady = false;
  private hydrated = false;
  private room: StoredRoomState | null = null;
  private match: WorkerMatchManager | null = null;
  private rateMap = new Map<WebSocket, number[]>();
  private pendingGameOverPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = loadWorkerConfig(env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS room_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        room_id TEXT NOT NULL,
        room_code TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        is_private INTEGER NOT NULL,
        rule_profile_id TEXT NOT NULL,
        called_shots_enabled INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_players (
        session_id TEXT PRIMARY KEY,
        player_id TEXT,
        reconnect_token TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_id TEXT NOT NULL,
        role TEXT NOT NULL,
        connected INTEGER NOT NULL,
        ready INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        disconnected_at_ms INTEGER,
        reconnect_deadline_ms INTEGER,
        rematch_requested INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_shot_tokens (
        token TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL
      );
    `);
    try {
      sql.exec('ALTER TABLE room_players ADD COLUMN player_id TEXT');
    } catch {
      // Already present
    }
    this.schemaReady = true;
  }

  private async ensureHydrated(): Promise<void> {
    this.ensureSchema();
    if (this.hydrated) return;

    const sql = this.ctx.storage.sql;
    const metaRows = sql
      .exec<Record<string, SqlStorageValue>>('SELECT * FROM room_meta WHERE id = 1')
      .toArray();

    if (metaRows.length > 0) {
      const m = metaRows[0];
      const playerRows = sql
        .exec<Record<string, SqlStorageValue>>('SELECT * FROM room_players ORDER BY role ASC')
        .toArray();

      this.room = {
        roomId: String(m.room_id),
        roomCode: String(m.room_code),
        hostSessionId: String(m.host_session_id),
        isPrivate: Number(m.is_private) === 1,
        ruleProfileId: m.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
        calledShotsEnabled: Number(m.called_shots_enabled) === 1,
        status: String(m.status) as OnlineRoomStatus,
        createdAtMs: Number(m.created_at_ms),
        expiresAtMs: Number(m.expires_at_ms),
        players: playerRows.map((p) => ({
          sessionId: String(p.session_id),
          playerId: p.player_id ? String(p.player_id) : String(p.session_id),
          reconnectToken: String(p.reconnect_token),
          displayName: String(p.display_name),
          avatarId: sanitizeAvatarId(p.avatar_id),
          role: p.role === 'player2' ? 'player2' : 'player1',
          connected: Number(p.connected) === 1,
          ready: Number(p.ready) === 1,
          latencyMs: Number(p.latency_ms),
          disconnectedAtMs:
            p.disconnected_at_ms === null || p.disconnected_at_ms === undefined
              ? null
              : Number(p.disconnected_at_ms),
          reconnectDeadlineMs:
            p.reconnect_deadline_ms === null || p.reconnect_deadline_ms === undefined
              ? null
              : Number(p.reconnect_deadline_ms),
          rematchRequested: Number(p.rematch_requested) === 1,
        })),
      };

      const matchRows = sql
        .exec<{ payload_json: string }>('SELECT payload_json FROM match_state WHERE id = 1')
        .toArray();

      if (matchRows.length > 0) {
        const persisted = JSON.parse(matchRows[0].payload_json) as PersistedMatchState;
        const p1 = this.room.players.find((p) => p.role === 'player1') ?? this.room.players[0];
        const p2 = this.room.players.find((p) => p.role === 'player2') ?? this.room.players[1];
        const match = this.createMatchManagerInstance(
          this.room,
          p1?.displayName ?? 'Player 1',
          p2?.displayName ?? 'Player 2',
        );
        await match.restorePersistedState(persisted);
        this.match = match;
      }
    }

    this.hydrated = true;
  }

  private persistRoomState(): void {
    this.ensureSchema();
    if (!this.room) return;
    const sql = this.ctx.storage.sql;

    sql.exec(
      `INSERT OR REPLACE INTO room_meta (
        id, room_id, room_code, host_session_id, is_private,
        rule_profile_id, called_shots_enabled, status, created_at_ms, expires_at_ms
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.room.roomId,
      this.room.roomCode,
      this.room.hostSessionId,
      this.room.isPrivate ? 1 : 0,
      this.room.ruleProfileId,
      this.room.calledShotsEnabled ? 1 : 0,
      this.room.status,
      this.room.createdAtMs,
      this.room.expiresAtMs,
    );

    sql.exec('DELETE FROM room_players');
    for (const p of this.room.players) {
      sql.exec(
        `INSERT INTO room_players (
          session_id, player_id, reconnect_token, display_name, avatar_id, role,
          connected, ready, latency_ms, disconnected_at_ms, reconnect_deadline_ms, rematch_requested
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.sessionId,
        p.playerId ?? p.sessionId,
        p.reconnectToken,
        p.displayName,
        p.avatarId,
        p.role,
        p.connected ? 1 : 0,
        p.ready ? 1 : 0,
        p.latencyMs,
        p.disconnectedAtMs,
        p.reconnectDeadlineMs,
        p.rematchRequested ? 1 : 0,
      );
    }
  }

  private persistMatchState(): void {
    this.ensureSchema();
    if (!this.match) {
      this.ctx.storage.sql.exec('DELETE FROM match_state');
      return;
    }
    const payload = JSON.stringify(this.match.exportPersistedState());
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO match_state (id, payload_json) VALUES (1, ?)',
      payload,
    );
  }

  private hasUsedShotToken(token: string): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ token: string }>('SELECT token FROM used_shot_tokens WHERE token = ? LIMIT 1', token)
      .toArray();
    return rows.length > 0;
  }

  private recordShotToken(token: string): void {
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO used_shot_tokens (token, created_at_ms) VALUES (?, ?)',
      token,
      Date.now(),
    );
    this.ctx.storage.sql.exec(`
      DELETE FROM used_shot_tokens
      WHERE token NOT IN (
        SELECT token FROM used_shot_tokens ORDER BY created_at_ms DESC LIMIT 500
      )
    `);
  }

  public async initPrivateRoom(params: {
    roomId: string;
    roomCode: string;
    ruleProfileId: RuleProfileId;
    calledShotsEnabled: boolean;
    host: InitRoomPlayerInput;
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<OnlineRoomInfo> {
    await this.ensureHydrated();
    this.match?.dispose();
    this.match = null;
    this.ctx.storage.sql.exec('DELETE FROM match_state');
    this.ctx.storage.sql.exec('DELETE FROM used_shot_tokens');

    this.room = {
      roomId: params.roomId,
      roomCode: params.roomCode,
      hostSessionId: params.host.sessionId,
      isPrivate: true,
      ruleProfileId: params.ruleProfileId,
      calledShotsEnabled: params.calledShotsEnabled,
      status: 'waiting',
      createdAtMs: params.createdAtMs,
      expiresAtMs: params.expiresAtMs,
      players: [
        {
          sessionId: params.host.sessionId,
          playerId: params.host.playerId ?? params.host.sessionId,
          reconnectToken: params.host.reconnectToken,
          displayName: sanitizeDisplayName(params.host.displayName),
          avatarId: sanitizeAvatarId(params.host.avatarId),
          role: 'player1',
          connected: true,
          ready: true,
          latencyMs: clampLatency(params.host.latencyMs),
          disconnectedAtMs: null,
          reconnectDeadlineMs: null,
          rematchRequested: false,
        },
      ],
    };

    this.persistRoomState();
    await this.scheduleNextAlarm();
    return this.toRoomInfo(this.room);
  }

  public async initMatchedRoom(params: {
    roomId: string;
    roomCode: string;
    ruleProfileId: RuleProfileId;
    calledShotsEnabled: boolean;
    player1: InitRoomPlayerInput;
    player2: InitRoomPlayerInput;
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<{ room: OnlineRoomInfo; match: OnlineMatchSnapshot; balls: OnlineBallFrame[] }> {
    await this.ensureHydrated();
    this.ctx.storage.sql.exec('DELETE FROM used_shot_tokens');

    this.room = {
      roomId: params.roomId,
      roomCode: params.roomCode,
      hostSessionId: params.player1.sessionId,
      isPrivate: false,
      ruleProfileId: params.ruleProfileId,
      calledShotsEnabled: params.calledShotsEnabled,
      status: 'ready',
      createdAtMs: params.createdAtMs,
      expiresAtMs: params.expiresAtMs,
      players: [
        {
          sessionId: params.player1.sessionId,
          playerId: params.player1.playerId ?? params.player1.sessionId,
          reconnectToken: params.player1.reconnectToken,
          displayName: sanitizeDisplayName(params.player1.displayName),
          avatarId: sanitizeAvatarId(params.player1.avatarId),
          role: 'player1',
          connected: true,
          ready: true,
          latencyMs: clampLatency(params.player1.latencyMs),
          disconnectedAtMs: null,
          reconnectDeadlineMs: null,
          rematchRequested: false,
        },
        {
          sessionId: params.player2.sessionId,
          playerId: params.player2.playerId ?? params.player2.sessionId,
          reconnectToken: params.player2.reconnectToken,
          displayName: sanitizeDisplayName(params.player2.displayName),
          avatarId: sanitizeAvatarId(params.player2.avatarId),
          role: 'player2',
          connected: true,
          ready: true,
          latencyMs: clampLatency(params.player2.latencyMs),
          disconnectedAtMs: null,
          reconnectDeadlineMs: null,
          rematchRequested: false,
        },
      ],
    };

    const started = await this.initializeAndStartMatch(this.room);
    await this.scheduleNextAlarm();
    return {
      room: this.toRoomInfo(this.room),
      match: started.match,
      balls: started.balls,
    };
  }

  public async joinRoom(
    player: InitRoomPlayerInput,
  ): Promise<
    | { ok: true; room: OnlineRoomInfo }
    | { ok: false; code: MultiplayerErrorCode; message: string }
  > {
    await this.ensureHydrated();
    if (!this.room) {
      return { ok: false, code: 'INVALID_ROOM', message: 'Room no longer exists.' };
    }
    const now = Date.now();
    if (now > this.room.expiresAtMs || this.room.status === 'expired' || this.room.status === 'cancelled') {
      await this.destroyRoom('Room expired.');
      return {
        ok: false,
        code: 'ROOM_EXPIRED',
        message: 'This room has expired or was closed by the host.',
      };
    }
    if (this.room.status === 'playing' || this.room.status === 'finished') {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Match is already underway in this private room.',
      };
    }
    const existing = this.room.players.find((p) => p.sessionId === player.sessionId);
    if (existing) {
      return { ok: true, room: this.toRoomInfo(this.room) };
    }
    if (this.room.players.length >= 2) {
      return {
        ok: false,
        code: 'ROOM_FULL',
        message: 'This room is already full (2/2 players).',
      };
    }

    this.room.players.push({
      sessionId: player.sessionId,
      playerId: player.playerId ?? player.sessionId,
      reconnectToken: player.reconnectToken,
      displayName: sanitizeDisplayName(player.displayName),
      avatarId: sanitizeAvatarId(player.avatarId),
      role: 'player2',
      connected: true,
      ready: false,
      latencyMs: clampLatency(player.latencyMs),
      disconnectedAtMs: null,
      reconnectDeadlineMs: null,
      rematchRequested: false,
    });
    this.room.expiresAtMs = now + this.config.roomTtlMs;
    this.updateWaitingStatus(this.room);
    this.persistRoomState();
    this.broadcastRoomUpdate(this.room);
    await this.scheduleNextAlarm();

    return { ok: true, room: this.toRoomInfo(this.room) };
  }

  public async updatePlayerProfile(
    sessionId: string,
    displayName: string,
    avatarId: OnlineAvatarId,
  ): Promise<void> {
    await this.ensureHydrated();
    if (!this.room) return;
    const player = this.room.players.find((p) => p.sessionId === sessionId);
    if (!player) return;
    player.displayName = sanitizeDisplayName(displayName);
    player.avatarId = sanitizeAvatarId(avatarId);

    if (this.match && this.room.players.length === 2) {
      const p1 = this.room.players.find((p) => p.role === 'player1');
      const p2 = this.room.players.find((p) => p.role === 'player2');
      if (p1 && p2) {
        this.match.updatePlayerNames(p1.displayName, p2.displayName);
      }
    }

    this.persistRoomState();
    this.persistMatchState();
    this.broadcastRoomUpdate(this.room);
  }

  public async getResumeData(): Promise<{
    room: OnlineRoomInfo;
    match: OnlineMatchSnapshot | null;
    balls: OnlineBallFrame[] | null;
  } | null> {
    await this.ensureHydrated();
    if (!this.room) return null;
    return {
      room: this.toRoomInfo(this.room),
      match: this.match ? this.match.getSnapshot() : null,
      balls: this.match ? this.match.physics.getBallFrames() : null,
    };
  }

  public async cancelRoomFromLobby(
    sessionId: string,
  ): Promise<{ ok: true } | { ok: false; code: MultiplayerErrorCode; message: string }> {
    await this.ensureHydrated();
    if (!this.room) {
      return { ok: false, code: 'INVALID_ROOM', message: 'Room not found.' };
    }
    if (this.room.hostSessionId !== sessionId) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Only the host can cancel this room.' };
    }
    if (this.room.status === 'playing') {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: 'Cannot cancel an active match; use leave/forfeit instead.',
      };
    }
    await this.destroyRoom('Host cancelled the room.');
    return { ok: true };
  }

  public async fetch(request: Request): Promise<Response> {
    await this.ensureHydrated();
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: RoomSocketAttachment = {
      sessionId: null,
      role: null,
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  public async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureHydrated();

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
    const attachment = this.getAttachment(ws);

    if (msg.type === 'ping') {
      if (attachment.sessionId && this.room && typeof msg.latencyMs === 'number') {
        const p = this.room.players.find((pl) => pl.sessionId === attachment.sessionId);
        if (p) {
          p.latencyMs = clampLatency(msg.latencyMs);
        }
      }
      this.sendSocket(ws, {
        type: 'pong',
        clientTimeMs: typeof msg.clientTimeMs === 'number' ? msg.clientTimeMs : Date.now(),
        serverTimeMs: Date.now(),
      });
      return;
    }

    if (msg.type === 'session:resume') {
      await this.handleResume(ws, msg);
      return;
    }

    if (!attachment.sessionId || !this.room) {
      this.sendError(ws, 'UNAUTHORIZED', 'Initialize or resume a valid room session first.');
      return;
    }

    const player = this.room.players.find((p) => p.sessionId === attachment.sessionId);
    if (!player) {
      this.sendError(ws, 'UNAUTHORIZED', 'You are not a participant in this room.');
      return;
    }

    switch (msg.type) {
      case 'session:update_profile': {
        player.displayName = sanitizeDisplayName(msg.displayName);
        player.avatarId = sanitizeAvatarId(msg.avatarId);
        if (this.match && this.room.players.length === 2) {
          const p1 = this.room.players.find((p) => p.role === 'player1');
          const p2 = this.room.players.find((p) => p.role === 'player2');
          if (p1 && p2) {
            this.match.updatePlayerNames(p1.displayName, p2.displayName);
          }
        }
        this.persistRoomState();
        this.persistMatchState();
        this.broadcastRoomUpdate(this.room);
        break;
      }

      case 'room:ready': {
        if (this.room.status === 'playing') {
          this.sendError(ws, 'INVALID_INPUT', 'Match already started.');
          return;
        }
        player.ready = Boolean(msg.ready);
        this.updateWaitingStatus(this.room);
        this.persistRoomState();
        this.broadcastRoomUpdate(this.room);
        break;
      }

      case 'room:start': {
        if (this.room.hostSessionId !== player.sessionId) {
          this.sendError(ws, 'UNAUTHORIZED', 'Only the room host can start the match.');
          return;
        }
        if (this.room.players.length < 2) {
          this.sendError(ws, 'MATCH_NOT_READY', 'Waiting for an opponent to join the room.');
          return;
        }
        if (!this.room.players.every((p) => p.ready && p.connected)) {
          this.sendError(
            ws,
            'MATCH_NOT_READY',
            'Both players must be connected and ready before starting.',
          );
          return;
        }
        await this.initializeAndStartMatch(this.room);
        await this.scheduleNextAlarm();
        break;
      }

      case 'room:cancel': {
        if (this.room.hostSessionId !== player.sessionId) {
          this.sendError(ws, 'UNAUTHORIZED', 'Only the host can cancel this room.');
          return;
        }
        if (this.room.status === 'playing') {
          this.sendError(
            ws,
            'INVALID_INPUT',
            'Cannot cancel an active match; use leave/forfeit instead.',
          );
          return;
        }
        await this.destroyRoom('Host cancelled the room.');
        break;
      }

      case 'room:leave': {
        await this.handlePlayerLeave(player.sessionId);
        break;
      }

      case 'room:rematch': {
        if (!this.match || this.match.getPhase() !== 'GAME_OVER') {
          this.sendError(
            ws,
            'MATCH_NOT_READY',
            'Rematch is only available after the current match finishes.',
          );
          return;
        }
        if (this.room.players.length < 2) {
          this.sendError(ws, 'MATCH_NOT_READY', 'Opponent has already left the room.');
          return;
        }
        player.rematchRequested = true;
        const voteRes = this.match.voteRematch(player.role);
        if (voteRes.bothReady) {
          for (const p of this.room.players) {
            p.rematchRequested = false;
            p.ready = true;
          }
          this.room.status = 'playing';
          this.match.resetForNewMatch();
          this.ctx.storage.sql.exec('DELETE FROM used_shot_tokens');
          this.persistRoomState();
          this.persistMatchState();
          await this.notifyMatchmakerRoomStatus('playing');
          this.broadcastToRoom({
            type: 'match:rematch_started',
            room: this.toRoomInfo(this.room),
            match: this.match.getSnapshot(),
            balls: this.match.physics.getBallFrames(),
          });
        } else {
          this.persistRoomState();
          this.persistMatchState();
          this.broadcastRoomUpdate(this.room);
          this.broadcastStateSync(this.room);
        }
        break;
      }

      case 'game:aim':
      case 'game:spin':
      case 'game:called_shot':
      case 'game:place_cue':
      case 'game:shoot':
      case 'game:forfeit':
      case 'game:request_sync': {
        await this.handleGameplayMessage(ws, player, msg);
        break;
      }

      default:
        this.sendError(ws, 'INVALID_INPUT', 'Unsupported message type.');
    }
  }

  public async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.ensureHydrated();
    this.rateMap.delete(ws);
    const safeCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    try {
      ws.close(safeCode, reason || 'Connection closed');
    } catch {
      // Ignore if socket is already closed
    }
    await this.handleSocketClosed(ws);
  }

  public async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.ensureHydrated();
    this.rateMap.delete(ws);
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // Ignore if socket is already closed
    }
    await this.handleSocketClosed(ws);
  }

  public async alarm(): Promise<void> {
    await this.ensureHydrated();
    if (!this.room) return;

    const now = Date.now();
    const expiredPlayers = this.room.players.filter(
      (p) => !p.connected && p.reconnectDeadlineMs !== null && now >= p.reconnectDeadlineMs,
    );

    for (const player of expiredPlayers) {
      if (!this.room) break;
      if (this.room.status === 'playing' && this.match && this.match.getPhase() !== 'GAME_OVER') {
        this.match.forfeit(
          player.role,
          `${player.displayName} disconnected and did not reconnect in time.`,
        );
        if (this.pendingGameOverPromise) {
          await this.pendingGameOverPromise;
        }
        this.room.status = 'finished';
        this.room.players = this.room.players.filter((p) => p.sessionId !== player.sessionId);
        await this.notifyMatchmakerPlayerLeft(player.sessionId);
        if (this.room.players.length === 0) {
          await this.destroyRoom('All players disconnected.');
          return;
        }
        this.persistRoomState();
        this.persistMatchState();
        this.broadcastRoomUpdate(this.room);
      } else {
        await this.handlePlayerLeave(player.sessionId);
      }
    }

    if (
      this.room &&
      (this.room.status === 'waiting' || this.room.status === 'ready') &&
      now >= this.room.expiresAtMs
    ) {
      await this.destroyRoom('Room expired due to inactivity.');
      return;
    }

    await this.scheduleNextAlarm();
  }

  private async handleResume(
    ws: WebSocket,
    msg: Extract<ClientToServerMessage, { type: 'session:resume' }>,
  ): Promise<void> {
    if (!this.room) {
      this.sendError(ws, 'ROOM_EXPIRED', 'This room no longer exists.');
      return;
    }

    const player = this.room.players.find((p) => p.sessionId === msg.sessionId);
    if (!player || !constantTimeEqual(msg.reconnectToken, player.reconnectToken)) {
      this.sendError(ws, 'UNAUTHORIZED', 'Invalid room session or reconnect token.');
      return;
    }

    const wasDisconnected = !player.connected;
    if (msg.displayName) {
      player.displayName = sanitizeDisplayName(msg.displayName);
    }
    if (msg.avatarId) {
      player.avatarId = sanitizeAvatarId(msg.avatarId);
    }

    for (const existingWs of this.ctx.getWebSockets()) {
      if (existingWs === ws) continue;
      const att = this.getAttachment(existingWs);
      if (att.sessionId === player.sessionId) {
        att.sessionId = null;
        att.role = null;
        existingWs.serializeAttachment(att);
        try {
          existingWs.close(4001, 'Replaced by resumed session');
        } catch {
          // Ignore close errors on stale socket
        }
      }
    }

    const nextAttachment: RoomSocketAttachment = {
      sessionId: player.sessionId,
      role: player.role,
    };
    ws.serializeAttachment(nextAttachment);

    player.connected = true;
    player.disconnectedAtMs = null;
    player.reconnectDeadlineMs = null;

    if (this.match && this.room.players.length === 2) {
      const p1 = this.room.players.find((p) => p.role === 'player1');
      const p2 = this.room.players.find((p) => p.role === 'player2');
      if (p1 && p2) {
        this.match.updatePlayerNames(p1.displayName, p2.displayName);
      }
    }

    this.updateWaitingStatus(this.room);
    this.persistRoomState();
    this.persistMatchState();
    await this.scheduleNextAlarm();

    this.sendSocket(ws, {
      type: 'session:ready',
      sessionId: player.sessionId,
      reconnectToken: player.reconnectToken,
      playerId: player.playerId ?? player.sessionId,
      displayName: player.displayName,
      avatarId: player.avatarId,
      resumedRoom: this.toRoomInfo(this.room),
      resumedMatch: this.match ? this.match.getSnapshot() : null,
      balls: this.match ? this.match.physics.getBallFrames() : null,
      serverTimeMs: Date.now(),
    });

    if (wasDisconnected) {
      this.broadcastToOthers(player.sessionId, {
        type: 'opponent:reconnected',
        roomId: this.room.roomId,
        sessionId: player.sessionId,
        displayName: player.displayName,
      });
    }
    this.broadcastRoomUpdate(this.room);
  }

  private async handleSocketClosed(ws: WebSocket): Promise<void> {
    const att = this.getAttachment(ws);
    if (!att.sessionId || !this.room) return;

    // Check if another active socket already replaced this session
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const otherAtt = this.getAttachment(other);
      if (otherAtt.sessionId === att.sessionId) {
        return;
      }
    }

    const player = this.room.players.find((p) => p.sessionId === att.sessionId);
    if (!player) return;

    const now = Date.now();
    const deadlineMs = now + this.config.reconnectGraceMs;
    player.connected = false;
    player.disconnectedAtMs = now;
    player.reconnectDeadlineMs = deadlineMs;

    this.persistRoomState();
    this.broadcastToOthers(player.sessionId, {
      type: 'opponent:disconnected',
      roomId: this.room.roomId,
      sessionId: player.sessionId,
      displayName: player.displayName,
      graceDeadlineMs: deadlineMs,
    });
    this.broadcastRoomUpdate(this.room);
    await this.scheduleNextAlarm();
  }

  private async handlePlayerLeave(sessionId: string): Promise<void> {
    if (!this.room) return;
    const leaving = this.room.players.find((p) => p.sessionId === sessionId);
    if (!leaving) return;

    await this.notifyMatchmakerPlayerLeft(sessionId);

    if (this.room.status === 'playing' && this.match && this.match.getPhase() !== 'GAME_OVER') {
      this.match.forfeit(leaving.role, `${leaving.displayName} left the match.`);
      if (this.pendingGameOverPromise) {
        await this.pendingGameOverPromise;
      }
      this.room.status = 'finished';
    }

    if (this.room.status === 'waiting' || this.room.status === 'ready') {
      if (this.room.hostSessionId === sessionId || this.room.players.length <= 1) {
        await this.destroyRoom(`${leaving.displayName} closed the room.`);
        return;
      }
      this.room.players = this.room.players.filter((p) => p.sessionId !== sessionId);
      this.updateWaitingStatus(this.room);
      this.persistRoomState();
      this.broadcastRoomUpdate(this.room);
      await this.scheduleNextAlarm();
      return;
    }

    this.room.players = this.room.players.filter((p) => p.sessionId !== sessionId);
    if (this.room.players.length === 0) {
      await this.destroyRoom('All players left the match.');
    } else {
      this.persistRoomState();
      this.persistMatchState();
      this.broadcastRoomUpdate(this.room);
      await this.scheduleNextAlarm();
    }
  }

  private async handleGameplayMessage(
    ws: WebSocket,
    player: StoredPlayerRecord,
    msg: ClientToServerMessage,
  ): Promise<void> {
    if (!this.room || !this.match) {
      this.sendError(ws, 'INVALID_ROOM', 'No active online match found.');
      return;
    }

    const role = player.role;
    const match = this.match;

    if (msg.type === 'game:request_sync') {
      this.sendSocket(ws, {
        type: 'match:state_sync',
        room: this.toRoomInfo(this.room),
        match: match.getSnapshot(),
        balls: match.physics.getBallFrames(),
      });
      return;
    }

    if (msg.type === 'game:forfeit') {
      match.forfeit(role, `${player.displayName} forfeited the match.`);
      if (this.pendingGameOverPromise) {
        await this.pendingGameOverPromise;
      }
      this.room.status = 'finished';
      this.persistRoomState();
      this.persistMatchState();
      await this.notifyMatchmakerRoomStatus('finished');
      this.broadcastRoomUpdate(this.room);
      return;
    }

    if (msg.type === 'game:aim') {
      if (role !== match.getActivePlayer() || !Number.isFinite(msg.cueAngle)) return;
      this.broadcastToOthers(player.sessionId, {
        type: 'match:aim_preview',
        roomId: this.room.roomId,
        player: role,
        cueAngle: msg.cueAngle,
      });
      return;
    }

    if (msg.type === 'game:spin') {
      if (
        role !== match.getActivePlayer() ||
        !Number.isFinite(msg.x) ||
        !Number.isFinite(msg.y)
      ) {
        return;
      }
      this.broadcastToOthers(player.sessionId, {
        type: 'match:spin_preview',
        roomId: this.room.roomId,
        player: role,
        x: msg.x,
        y: msg.y,
      });
      return;
    }

    if (msg.type === 'game:called_shot') {
      const res = match.handleCalledShot(
        role,
        msg.targetBall,
        msg.targetPocket as PocketId | null,
      );
      if (!res.ok) {
        this.sendError(ws, res.code, res.message);
        return;
      }
      this.persistMatchState();
      this.broadcastStateSync(this.room);
      return;
    }

    if (msg.type === 'game:place_cue') {
      const res = match.handleCuePlacement(role, msg.x, msg.z, Boolean(msg.confirm));
      if (!res.ok) {
        this.sendError(ws, res.code, res.message);
        return;
      }
      this.persistMatchState();
      this.broadcastToRoom({
        type: 'match:state_sync',
        room: this.toRoomInfo(this.room),
        match: res.snapshot,
        balls: res.balls,
      });
      return;
    }

    if (msg.type === 'game:shoot') {
      const res = match.handleShot(
        role,
        {
          shotToken: msg.shotToken,
          cueAngle: msg.cueAngle,
          power: msg.power,
          spinX: msg.spinX,
          spinY: msg.spinY,
          calledBall: msg.calledBall,
          calledPocket: msg.calledPocket,
        },
        (token) => this.hasUsedShotToken(token),
        (token) => this.recordShotToken(token),
      );
      if (!res.ok) {
        this.sendError(ws, res.code, res.message);
        return;
      }
      this.persistMatchState();
      this.ctx.waitUntil(res.simulationPromise);
    }
  }

  private createMatchManagerInstance(
    room: StoredRoomState,
    p1Name: string,
    p2Name: string,
  ): WorkerMatchManager {
    return new WorkerMatchManager({
      roomId: room.roomId,
      roomCode: room.roomCode,
      ruleProfileId: room.ruleProfileId,
      calledShotsEnabled: room.calledShotsEnabled,
      player1Name: p1Name,
      player2Name: p2Name,
      physicsBroadcastHz: this.config.physicsBroadcastHz,
      callbacks: {
        onShotStarted: (payload) => {
          this.broadcastToRoom({
            type: 'match:shot_started',
            roomId: room.roomId,
            ...payload,
          });
        },
        onPhysicsFrame: (shotSeq, balls) => {
          this.broadcastToRoom({
            type: 'physics:frame',
            roomId: room.roomId,
            shotSeq,
            serverTimeMs: Date.now(),
            balls,
          });
        },
        onPocket: (shotSeq, ballNumber, pocketId, order) => {
          this.broadcastToRoom({
            type: 'physics:pocket',
            roomId: room.roomId,
            shotSeq,
            ballNumber,
            pocketId,
            order,
          });
        },
        onSettled: (snapshot, balls) => {
          if (!this.room) return;
          this.persistRoomState();
          this.persistMatchState();
          this.broadcastToRoom({
            type: 'match:settled',
            room: this.toRoomInfo(this.room),
            match: snapshot,
            balls,
          });
        },
        onGameOver: (snapshot, balls, historyRecord, telemetrySummary) => {
          const roomSnapshot = this.room;
          if (!roomSnapshot) return;
          const p1Rec = roomSnapshot.players.find((p) => p.role === 'player1') ?? roomSnapshot.players[0];
          const p2Rec = roomSnapshot.players.find((p) => p.role === 'player2') ?? roomSnapshot.players[1];

          const job = this.finalizeMatchGameOver({
            roomSnapshot: {
              ...roomSnapshot,
              players: roomSnapshot.players.map((pl) => ({ ...pl })),
            },
            p1: p1Rec
              ? {
                  playerId: p1Rec.playerId ?? p1Rec.sessionId,
                  displayName: p1Rec.displayName,
                  avatarId: p1Rec.avatarId,
                }
              : {
                  playerId: `guest_${snapshot.matchId}_p1`,
                  displayName: snapshot.player1Name,
                  avatarId: 'cue_gold' as OnlineAvatarId,
                },
            p2: p2Rec
              ? {
                  playerId: p2Rec.playerId ?? p2Rec.sessionId,
                  displayName: p2Rec.displayName,
                  avatarId: p2Rec.avatarId,
                }
              : {
                  playerId: `guest_${snapshot.matchId}_p2`,
                  displayName: snapshot.player2Name,
                  avatarId: 'eight_obsidian' as OnlineAvatarId,
                },
            snapshot,
            balls,
            historyRecord,
            telemetrySummary,
          });
          this.pendingGameOverPromise = job;
          this.ctx.waitUntil(
            job.finally(() => {
              if (this.pendingGameOverPromise === job) {
                this.pendingGameOverPromise = null;
              }
            }),
          );
          return job;
        },
      },
    });
  }

  private async finalizeMatchGameOver(params: {
    roomSnapshot: StoredRoomState;
    p1: { playerId: string; displayName: string; avatarId: OnlineAvatarId };
    p2: { playerId: string; displayName: string; avatarId: OnlineAvatarId };
    snapshot: OnlineMatchSnapshot;
    balls: OnlineBallFrame[];
    historyRecord: MatchHistoryRecord;
    telemetrySummary: MatchTelemetrySummaryForProgression;
  }): Promise<void> {
    if (this.room) {
      this.room.status = 'finished';
      this.persistRoomState();
      this.persistMatchState();
    }

    const enrichedRecord: MatchHistoryRecord = {
      ...params.historyRecord,
      player1Id: params.p1.playerId,
      player2Id: params.p2.playerId,
      player1Avatar: params.p1.avatarId,
      player2Avatar: params.p2.avatarId,
      winnerId:
        params.historyRecord.winnerRole === 'player1'
          ? params.p1.playerId
          : params.p2.playerId,
      matchType: params.roomSnapshot.isPrivate ? 'private' : 'quick',
      ruleProfileId: params.roomSnapshot.ruleProfileId,
    };

    let progression: MatchProgressionRewardSummary | undefined;
    const matchInput = {
      matchId: enrichedRecord.matchId,
      roomId: params.roomSnapshot.roomId,
      roomCode: params.roomSnapshot.roomCode,
      ruleProfileId: params.roomSnapshot.ruleProfileId,
      matchType: (params.roomSnapshot.isPrivate ? 'private' : 'quick') as 'private' | 'quick',
      winnerRole: enrichedRecord.winnerRole,
      reason: enrichedRecord.reason,
      totalShots: enrichedRecord.totalShots,
      endedAtMs: enrichedRecord.endedAtMs,
      player1: params.p1,
      player2: params.p2,
      telemetry: params.telemetrySummary,
    };

    try {
      const recRes = this.env.DB
        ? await new D1ProgressionService(this.env.DB).recordCompletedMatch(matchInput)
        : await this.getMatchmakerStub().progressionRecordMatch(matchInput);
      progression = recRes.summary;
      enrichedRecord.rankedApplied = recRes.summary.rankedApplied;
      enrichedRecord.p1EloDelta = recRes.summary.players.player1.eloDelta;
      enrichedRecord.p2EloDelta = recRes.summary.players.player2.eloDelta;
    } catch {
      // Non-blocking fallback if progression storage fails
    }

    await Promise.all([
      this.notifyMatchmakerRoomStatus('finished'),
      this.notifyMatchmakerHistory(enrichedRecord),
    ]);

    const currentRoom = this.room ?? params.roomSnapshot;
    currentRoom.status = 'finished';
    this.broadcastToRoom({
      type: 'match:over',
      room: this.toRoomInfo(currentRoom),
      match: params.snapshot,
      balls: params.balls,
      historyRecord: enrichedRecord,
      progression,
    });
  }

  private async initializeAndStartMatch(
    room: StoredRoomState,
  ): Promise<{ match: OnlineMatchSnapshot; balls: OnlineBallFrame[] }> {
    const p1 = room.players.find((p) => p.role === 'player1') ?? room.players[0];
    const p2 = room.players.find((p) => p.role === 'player2') ?? room.players[1];

    this.match?.dispose();
    const match = this.createMatchManagerInstance(room, p1.displayName, p2.displayName);
    await match.init();
    this.match = match;
    room.status = 'playing';

    this.persistRoomState();
    this.persistMatchState();
    await this.notifyMatchmakerRoomStatus('playing');

    const snapshot = match.getSnapshot();
    const balls = match.physics.getBallFrames();
    this.broadcastToRoom({
      type: 'match:started',
      room: this.toRoomInfo(room),
      match: snapshot,
      balls,
    });
    return { match: snapshot, balls };
  }

  private async destroyRoom(reason: string): Promise<void> {
    if (!this.room) return;
    const roomId = this.room.roomId;
    const sessionIds = this.room.players.map((p) => p.sessionId);

    this.broadcastToRoom({
      type: 'room:closed',
      roomId,
      reason,
    });

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, reason);
      } catch {
        // Ignore close errors
      }
    }

    this.match?.dispose();
    this.match = null;
    this.room = null;
    this.schemaReady = false;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.notifyMatchmakerRoomClosed(roomId, sessionIds);
  }

  private updateWaitingStatus(room: StoredRoomState): void {
    if (room.status === 'playing' || room.status === 'finished') return;
    if (room.players.length === 2 && room.players.every((p) => p.ready && p.connected)) {
      room.status = 'ready';
    } else {
      room.status = 'waiting';
    }
  }

  private toRoomInfo(room: StoredRoomState): OnlineRoomInfo {
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      hostSessionId: room.hostSessionId,
      isPrivate: room.isPrivate,
      ruleProfileId: room.ruleProfileId,
      calledShotsEnabled: room.calledShotsEnabled,
      status: room.status,
      players: room.players.map((p) => ({
        sessionId: p.sessionId,
        playerId: p.playerId ?? p.sessionId,
        displayName: p.displayName,
        avatarId: p.avatarId,
        role: p.role,
        connected: p.connected,
        ready: p.ready,
        latencyMs: p.latencyMs,
        disconnectedAtMs: p.disconnectedAtMs,
        reconnectDeadlineMs: p.reconnectDeadlineMs,
        rematchRequested: p.rematchRequested,
      })),
      createdAtMs: room.createdAtMs,
      expiresAtMs: room.expiresAtMs,
    };
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (!this.room) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const candidates: number[] = [];
    for (const p of this.room.players) {
      if (!p.connected && p.reconnectDeadlineMs !== null) {
        candidates.push(p.reconnectDeadlineMs);
      }
    }
    if (this.room.status === 'waiting' || this.room.status === 'ready') {
      candidates.push(this.room.expiresAtMs);
    }

    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const earliest = Math.min(...candidates);
    await this.ctx.storage.setAlarm(earliest);
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

  private getAttachment(ws: WebSocket): RoomSocketAttachment {
    const raw = ws.deserializeAttachment() as RoomSocketAttachment | null;
    return raw ?? { sessionId: null, role: null };
  }

  private sendSocket(ws: WebSocket, msg: ServerToClientMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket already closed
    }
  }

  private sendError(ws: WebSocket, code: MultiplayerErrorCode, message: string): void {
    this.sendSocket(ws, { type: 'error', code, message });
  }

  private broadcastToRoom(msg: ServerToClientMessage): void {
    const encoded = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (!att.sessionId) continue;
      try {
        ws.send(encoded);
      } catch {
        // Ignore closed socket
      }
    }
  }

  private broadcastToOthers(senderSessionId: string, msg: ServerToClientMessage): void {
    const encoded = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (!att.sessionId || att.sessionId === senderSessionId) continue;
      try {
        ws.send(encoded);
      } catch {
        // Ignore closed socket
      }
    }
  }

  private broadcastRoomUpdate(room: StoredRoomState): void {
    this.broadcastToRoom({
      type: 'room:updated',
      room: this.toRoomInfo(room),
    });
  }

  private broadcastStateSync(room: StoredRoomState): void {
    if (!this.match) return;
    this.broadcastToRoom({
      type: 'match:state_sync',
      room: this.toRoomInfo(room),
      match: this.match.getSnapshot(),
      balls: this.match.physics.getBallFrames(),
    });
  }

  private getMatchmakerStub() {
    return this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('global'));
  }

  private async notifyMatchmakerRoomStatus(status: OnlineRoomStatus): Promise<void> {
    if (!this.room) return;
    await this.getMatchmakerStub().onRoomStatusChanged(this.room.roomId, status);
  }

  private async notifyMatchmakerPlayerLeft(sessionId: string): Promise<void> {
    if (!this.room) return;
    await this.getMatchmakerStub().onPlayerLeftRoom(this.room.roomId, sessionId);
  }

  private async notifyMatchmakerRoomClosed(roomId: string, sessionIds: string[]): Promise<void> {
    await this.getMatchmakerStub().onRoomClosed(roomId, sessionIds);
  }

  private async notifyMatchmakerHistory(record: MatchHistoryRecord): Promise<void> {
    await this.getMatchmakerStub().recordMatchHistory(record);
  }
}
