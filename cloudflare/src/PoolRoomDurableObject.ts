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
  OnlineRoomTournamentContext,
  ServerToClientMessage,
} from '../../src/multiplayer/shared/protocol';
import { getRankForElo, type RankTierDefinition } from '../../src/multiplayer/shared/ranked';
import {
  DEFAULT_EQUIPPED_COSMETICS,
  sanitizeEquippedCosmetics,
  type EquippedCosmetics,
} from '../../src/multiplayer/shared/economy';
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
import { D1ProgressionService } from './D1ProgressionService';
import {
  WorkerMatchManager,
  type PersistedMatchState,
} from './WorkerMatchManager';
import { CLOTH_PHYSICS } from '../../src/game/utils/constants';
import type {
  MatchProgressionRewardSummary,
  MatchTelemetrySummaryForProgression,
  OnlineMatchType,
} from '../../src/multiplayer/shared/progression';
import {
  sanitizeChatText,
  SOCIAL_LIMITS,
  type RoomChatMessageRecord,
} from '../../src/multiplayer/shared/social';
import { AntiCheatService } from './AntiCheatService';
import { checkChatAntiSpam } from './SocialService';

interface RoomSocketAttachment {
  sessionId: string | null;
  role: PlayerId | null;
  isSpectator?: boolean;
}

interface StoredPlayerRecord extends OnlinePlayerProfile {
  reconnectToken: string;
}

interface StoredSpectatorRecord {
  sessionId: string;
  playerId: string;
  reconnectToken: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  connected: boolean;
  disconnectedAtMs: number | null;
  reconnectDeadlineMs: number | null;
  reconnectCount: number;
  joinedAtMs: number;
  lastActiveAtMs: number;
}

interface StoredRoomState {
  roomId: string;
  roomCode: string;
  hostSessionId: string;
  isPrivate: boolean;
  matchType?: OnlineMatchType;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  status: OnlineRoomStatus;
  allowSpectators: boolean;
  allowSpectatorChat: boolean;
  maxSpectators: number;
  spectatorShareToken: string;
  createdAtMs: number;
  expiresAtMs: number;
  players: StoredPlayerRecord[];
  spectators: StoredSpectatorRecord[];
  tournament?: OnlineRoomTournamentContext | null;
}

export interface InitRoomPlayerInput {
  sessionId: string;
  playerId?: string;
  reconnectToken: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo?: number;
  rankTier?: RankTierDefinition;
  equippedCosmetics?: EquippedCosmetics;
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
        match_type TEXT,
        rule_profile_id TEXT NOT NULL,
        called_shots_enabled INTEGER NOT NULL,
        status TEXT NOT NULL,
        allow_spectators INTEGER NOT NULL DEFAULT 1,
        allow_spectator_chat INTEGER NOT NULL DEFAULT 1,
        max_spectators INTEGER NOT NULL DEFAULT 16,
        spectator_share_token TEXT,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        tournament_json TEXT
      );
      CREATE TABLE IF NOT EXISTS room_players (
        session_id TEXT PRIMARY KEY,
        player_id TEXT,
        reconnect_token TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_id TEXT NOT NULL,
        elo INTEGER,
        rank_tier_json TEXT,
        cosmetics_json TEXT,
        role TEXT NOT NULL,
        connected INTEGER NOT NULL,
        ready INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        disconnected_at_ms INTEGER,
        reconnect_deadline_ms INTEGER,
        rematch_requested INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_spectators (
        session_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        reconnect_token TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_id TEXT NOT NULL,
        connected INTEGER NOT NULL,
        disconnected_at_ms INTEGER,
        reconnect_deadline_ms INTEGER,
        reconnect_count INTEGER NOT NULL DEFAULT 0,
        joined_at_ms INTEGER NOT NULL,
        last_active_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_shot_tokens (
        token TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_chat_messages (
        message_id TEXT PRIMARY KEY,
        sender_session_id TEXT NOT NULL,
        sender_player_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_avatar TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'match',
        body TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
    const alterStmts = [
      'ALTER TABLE room_meta ADD COLUMN tournament_json TEXT',
      'ALTER TABLE room_meta ADD COLUMN match_type TEXT',
      'ALTER TABLE room_meta ADD COLUMN allow_spectators INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE room_meta ADD COLUMN allow_spectator_chat INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE room_meta ADD COLUMN max_spectators INTEGER NOT NULL DEFAULT 16',
      'ALTER TABLE room_meta ADD COLUMN spectator_share_token TEXT',
      'ALTER TABLE room_players ADD COLUMN player_id TEXT',
      'ALTER TABLE room_players ADD COLUMN cosmetics_json TEXT',
      'ALTER TABLE room_players ADD COLUMN elo INTEGER',
      'ALTER TABLE room_players ADD COLUMN rank_tier_json TEXT',
      "ALTER TABLE room_chat_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'match'",
    ];
    for (const stmt of alterStmts) {
      try {
        sql.exec(stmt);
      } catch {
        // Already present
      }
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

      let parsedTournament: OnlineRoomTournamentContext | null = null;
      if (typeof m.tournament_json === 'string' && m.tournament_json.length > 0) {
        try {
          parsedTournament = JSON.parse(m.tournament_json) as OnlineRoomTournamentContext;
        } catch {
          parsedTournament = null;
        }
      }

      const persistedMatchType: OnlineMatchType =
        m.match_type === 'ranked'
          ? 'ranked'
          : m.match_type === 'tournament'
            ? 'tournament'
            : m.match_type === 'private'
              ? 'private'
              : m.match_type === 'quick'
                ? 'quick'
                : parsedTournament
                  ? 'tournament'
                  : Number(m.is_private) === 1
                    ? 'private'
                    : 'quick';

      const spectatorRows = sql
        .exec<Record<string, SqlStorageValue>>(
          'SELECT * FROM room_spectators ORDER BY joined_at_ms ASC',
        )
        .toArray();

      this.room = {
        roomId: String(m.room_id),
        roomCode: String(m.room_code),
        hostSessionId: String(m.host_session_id),
        isPrivate: Number(m.is_private) === 1,
        matchType: persistedMatchType,
        ruleProfileId: m.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
        calledShotsEnabled: Number(m.called_shots_enabled) === 1,
        status: String(m.status) as OnlineRoomStatus,
        allowSpectators:
          m.allow_spectators === undefined || m.allow_spectators === null
            ? Number(m.is_private) !== 1
            : Number(m.allow_spectators) === 1,
        allowSpectatorChat:
          m.allow_spectator_chat === undefined || m.allow_spectator_chat === null
            ? true
            : Number(m.allow_spectator_chat) === 1,
        maxSpectators:
          typeof m.max_spectators === 'number' && m.max_spectators > 0
            ? Number(m.max_spectators)
            : this.config.maxSpectatorsPerRoom,
        spectatorShareToken:
          typeof m.spectator_share_token === 'string' && m.spectator_share_token.length > 0
            ? m.spectator_share_token
            : randomHexToken(12),
        createdAtMs: Number(m.created_at_ms),
        expiresAtMs: Number(m.expires_at_ms),
        tournament: parsedTournament,
        players: playerRows.map((p) => {
          let equipped: EquippedCosmetics = { ...DEFAULT_EQUIPPED_COSMETICS };
          if (typeof p.cosmetics_json === 'string' && p.cosmetics_json.length > 0) {
            try {
              equipped = sanitizeEquippedCosmetics(JSON.parse(p.cosmetics_json) as Partial<EquippedCosmetics>);
            } catch {
              equipped = { ...DEFAULT_EQUIPPED_COSMETICS };
            }
          }
          let rankTier: RankTierDefinition | undefined;
          if (typeof p.rank_tier_json === 'string' && p.rank_tier_json.length > 0) {
            try {
              rankTier = JSON.parse(p.rank_tier_json) as RankTierDefinition;
            } catch {
              rankTier = undefined;
            }
          }
          const elo = typeof p.elo === 'number' ? Number(p.elo) : undefined;
          return {
            sessionId: String(p.session_id),
            playerId: p.player_id ? String(p.player_id) : String(p.session_id),
            reconnectToken: String(p.reconnect_token),
            displayName: String(p.display_name),
            avatarId: sanitizeAvatarId(p.avatar_id),
            elo,
            rankTier: rankTier ?? (elo !== undefined ? getRankForElo(elo) : undefined),
            equippedCosmetics: equipped,
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
          };
        }),
        spectators: spectatorRows.map((s) => ({
          sessionId: String(s.session_id),
          playerId: String(s.player_id),
          reconnectToken: String(s.reconnect_token),
          displayName: String(s.display_name),
          avatarId: sanitizeAvatarId(s.avatar_id),
          connected: Number(s.connected) === 1,
          disconnectedAtMs:
            s.disconnected_at_ms === null || s.disconnected_at_ms === undefined
              ? null
              : Number(s.disconnected_at_ms),
          reconnectDeadlineMs:
            s.reconnect_deadline_ms === null || s.reconnect_deadline_ms === undefined
              ? null
              : Number(s.reconnect_deadline_ms),
          reconnectCount: Number(s.reconnect_count ?? 0),
          joinedAtMs: Number(s.joined_at_ms),
          lastActiveAtMs: Number(s.last_active_at_ms),
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

    const computedMatchType: OnlineMatchType =
      this.room.matchType ??
      (this.room.tournament ? 'tournament' : this.room.isPrivate ? 'private' : 'quick');

    sql.exec(
      `INSERT OR REPLACE INTO room_meta (
        id, room_id, room_code, host_session_id, is_private, match_type,
        rule_profile_id, called_shots_enabled, status, allow_spectators, allow_spectator_chat,
        max_spectators, spectator_share_token, created_at_ms, expires_at_ms, tournament_json
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.room.roomId,
      this.room.roomCode,
      this.room.hostSessionId,
      this.room.isPrivate ? 1 : 0,
      computedMatchType,
      this.room.ruleProfileId,
      this.room.calledShotsEnabled ? 1 : 0,
      this.room.status,
      this.room.allowSpectators ? 1 : 0,
      this.room.allowSpectatorChat ? 1 : 0,
      this.room.maxSpectators,
      this.room.spectatorShareToken,
      this.room.createdAtMs,
      this.room.expiresAtMs,
      this.room.tournament ? JSON.stringify(this.room.tournament) : null,
    );

    sql.exec('DELETE FROM room_players');
    for (const p of this.room.players) {
      sql.exec(
        `INSERT INTO room_players (
          session_id, player_id, reconnect_token, display_name, avatar_id, elo, rank_tier_json,
          cosmetics_json, role, connected, ready, latency_ms, disconnected_at_ms,
          reconnect_deadline_ms, rematch_requested
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.sessionId,
        p.playerId ?? p.sessionId,
        p.reconnectToken,
        p.displayName,
        p.avatarId,
        p.elo ?? null,
        p.rankTier ? JSON.stringify(p.rankTier) : null,
        JSON.stringify(p.equippedCosmetics ?? DEFAULT_EQUIPPED_COSMETICS),
        p.role,
        p.connected ? 1 : 0,
        p.ready ? 1 : 0,
        p.latencyMs,
        p.disconnectedAtMs,
        p.reconnectDeadlineMs,
        p.rematchRequested ? 1 : 0,
      );
    }

    sql.exec('DELETE FROM room_spectators');
    for (const s of this.room.spectators) {
      sql.exec(
        `INSERT INTO room_spectators (
          session_id, player_id, reconnect_token, display_name, avatar_id,
          connected, disconnected_at_ms, reconnect_deadline_ms, reconnect_count,
          joined_at_ms, last_active_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.sessionId,
        s.playerId,
        s.reconnectToken,
        s.displayName,
        s.avatarId,
        s.connected ? 1 : 0,
        s.disconnectedAtMs,
        s.reconnectDeadlineMs,
        s.reconnectCount,
        s.joinedAtMs,
        s.lastActiveAtMs,
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
    isPrivate?: boolean;
    allowSpectators?: boolean;
    allowSpectatorChat?: boolean;
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<OnlineRoomInfo> {
    await this.ensureHydrated();
    this.match?.dispose();
    this.match = null;
    this.ctx.storage.sql.exec('DELETE FROM match_state');
    this.ctx.storage.sql.exec('DELETE FROM used_shot_tokens');
    this.ctx.storage.sql.exec('DELETE FROM room_chat_messages');
    this.ctx.storage.sql.exec('DELETE FROM room_spectators');

    const isPrivate = params.isPrivate !== false;
    this.room = {
      roomId: params.roomId,
      roomCode: params.roomCode,
      hostSessionId: params.host.sessionId,
      isPrivate,
      matchType: 'private',
      ruleProfileId: params.ruleProfileId,
      calledShotsEnabled: params.calledShotsEnabled,
      status: 'waiting',
      allowSpectators: Boolean(params.allowSpectators ?? !isPrivate),
      allowSpectatorChat: params.allowSpectatorChat !== false,
      maxSpectators: this.config.maxSpectatorsPerRoom,
      spectatorShareToken: randomHexToken(12),
      createdAtMs: params.createdAtMs,
      expiresAtMs: params.expiresAtMs,
      players: [
        {
          sessionId: params.host.sessionId,
          playerId: params.host.playerId ?? params.host.sessionId,
          reconnectToken: params.host.reconnectToken,
          displayName: sanitizeDisplayName(params.host.displayName),
          avatarId: sanitizeAvatarId(params.host.avatarId),
          elo: params.host.elo,
          rankTier:
            params.host.rankTier ??
            (params.host.elo !== undefined ? getRankForElo(params.host.elo) : undefined),
          equippedCosmetics: sanitizeEquippedCosmetics(params.host.equippedCosmetics),
          role: 'player1',
          connected: true,
          ready: true,
          latencyMs: clampLatency(params.host.latencyMs),
          disconnectedAtMs: null,
          reconnectDeadlineMs: null,
          rematchRequested: false,
        },
      ],
      spectators: [],
    };

    this.persistRoomState();
    await this.scheduleNextAlarm();
    return this.toRoomInfo(this.room, true);
  }

  public async initMatchedRoom(params: {
    roomId: string;
    roomCode: string;
    matchType?: 'quick' | 'ranked';
    ruleProfileId: RuleProfileId;
    calledShotsEnabled: boolean;
    player1: InitRoomPlayerInput;
    player2: InitRoomPlayerInput;
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<{ room: OnlineRoomInfo; match: OnlineMatchSnapshot; balls: OnlineBallFrame[] }> {
    await this.ensureHydrated();
    this.ctx.storage.sql.exec('DELETE FROM used_shot_tokens');
    this.ctx.storage.sql.exec('DELETE FROM room_chat_messages');
    this.ctx.storage.sql.exec('DELETE FROM room_spectators');

    this.room = {
      roomId: params.roomId,
      roomCode: params.roomCode,
      hostSessionId: params.player1.sessionId,
      isPrivate: false,
      matchType: params.matchType === 'ranked' ? 'ranked' : 'quick',
      ruleProfileId: params.ruleProfileId,
      calledShotsEnabled: params.calledShotsEnabled,
      status: 'ready',
      allowSpectators: true,
      allowSpectatorChat: true,
      maxSpectators: this.config.maxSpectatorsPerRoom,
      spectatorShareToken: randomHexToken(12),
      createdAtMs: params.createdAtMs,
      expiresAtMs: params.expiresAtMs,
      players: [
        {
          sessionId: params.player1.sessionId,
          playerId: params.player1.playerId ?? params.player1.sessionId,
          reconnectToken: params.player1.reconnectToken,
          displayName: sanitizeDisplayName(params.player1.displayName),
          avatarId: sanitizeAvatarId(params.player1.avatarId),
          elo: params.player1.elo,
          rankTier:
            params.player1.rankTier ??
            (params.player1.elo !== undefined ? getRankForElo(params.player1.elo) : undefined),
          equippedCosmetics: sanitizeEquippedCosmetics(params.player1.equippedCosmetics),
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
          elo: params.player2.elo,
          rankTier:
            params.player2.rankTier ??
            (params.player2.elo !== undefined ? getRankForElo(params.player2.elo) : undefined),
          equippedCosmetics: sanitizeEquippedCosmetics(params.player2.equippedCosmetics),
          role: 'player2',
          connected: true,
          ready: true,
          latencyMs: clampLatency(params.player2.latencyMs),
          disconnectedAtMs: null,
          reconnectDeadlineMs: null,
          rematchRequested: false,
        },
      ],
      spectators: [],
    };

    const started = await this.initializeAndStartMatch(this.room);
    await this.scheduleNextAlarm();
    return {
      room: this.toRoomInfo(this.room),
      match: started.match,
      balls: started.balls,
    };
  }

  public async initTournamentRoom(params: {
    roomId: string;
    roomCode: string;
    ruleProfileId: RuleProfileId;
    calledShotsEnabled: boolean;
    tournament: OnlineRoomTournamentContext;
    player1: InitRoomPlayerInput;
    player2: InitRoomPlayerInput;
    allowSpectators?: boolean;
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<OnlineRoomInfo> {
    await this.ensureHydrated();
    this.match?.dispose();
    this.match = null;
    this.ctx.storage.sql.exec('DELETE FROM match_state');
    this.ctx.storage.sql.exec('DELETE FROM used_shot_tokens');
    this.ctx.storage.sql.exec('DELETE FROM room_chat_messages');
    this.ctx.storage.sql.exec('DELETE FROM room_spectators');

    this.room = {
      roomId: params.roomId,
      roomCode: params.roomCode,
      hostSessionId: params.player1.sessionId,
      isPrivate: false,
      matchType: 'tournament',
      ruleProfileId: params.ruleProfileId,
      calledShotsEnabled: params.calledShotsEnabled,
      status: 'waiting',
      allowSpectators: params.allowSpectators !== false,
      allowSpectatorChat: true,
      maxSpectators: this.config.maxSpectatorsPerRoom,
      spectatorShareToken: randomHexToken(12),
      createdAtMs: params.createdAtMs,
      expiresAtMs: params.expiresAtMs,
      tournament: params.tournament,
      players: [
        {
          sessionId: params.player1.sessionId,
          playerId: params.player1.playerId ?? params.player1.sessionId,
          reconnectToken: params.player1.reconnectToken,
          displayName: sanitizeDisplayName(params.player1.displayName),
          avatarId: sanitizeAvatarId(params.player1.avatarId),
          elo: params.player1.elo,
          rankTier:
            params.player1.rankTier ??
            (params.player1.elo !== undefined ? getRankForElo(params.player1.elo) : undefined),
          equippedCosmetics: sanitizeEquippedCosmetics(params.player1.equippedCosmetics),
          role: 'player1',
          connected: false,
          ready: false,
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
          elo: params.player2.elo,
          rankTier:
            params.player2.rankTier ??
            (params.player2.elo !== undefined ? getRankForElo(params.player2.elo) : undefined),
          equippedCosmetics: sanitizeEquippedCosmetics(params.player2.equippedCosmetics),
          role: 'player2',
          connected: false,
          ready: false,
          latencyMs: clampLatency(params.player2.latencyMs),
          disconnectedAtMs: null,
          reconnectDeadlineMs: null,
          rematchRequested: false,
        },
      ],
      spectators: [],
    };

    this.persistRoomState();
    await this.scheduleNextAlarm();
    return this.toRoomInfo(this.room);
  }

  public async prepareTournamentPlayerSession(
    playerId: string,
    input: InitRoomPlayerInput,
  ): Promise<
    | { ok: true; room: OnlineRoomInfo }
    | { ok: false; code: MultiplayerErrorCode; message: string }
  > {
    await this.ensureHydrated();
    if (!this.room || !this.room.tournament) {
      return { ok: false, code: 'INVALID_ROOM', message: 'Tournament match room no longer exists.' };
    }
    const existing = this.room.players.find((p) => p.playerId === playerId);
    if (!existing) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'You are not an assigned competitor in this tournament match.',
      };
    }

    existing.sessionId = input.sessionId;
    existing.reconnectToken = input.reconnectToken;
    existing.displayName = sanitizeDisplayName(input.displayName);
    existing.avatarId = sanitizeAvatarId(input.avatarId);
    if (input.elo !== undefined) {
      existing.elo = input.elo;
      existing.rankTier = input.rankTier ?? getRankForElo(input.elo);
    }
    if (input.equippedCosmetics) {
      existing.equippedCosmetics = sanitizeEquippedCosmetics(input.equippedCosmetics);
    }
    existing.latencyMs = clampLatency(input.latencyMs);
    if (existing.role === 'player1') {
      this.room.hostSessionId = existing.sessionId;
    }

    this.persistRoomState();
    return { ok: true, room: this.toRoomInfo(this.room) };
  }

  public async forceCloseTournamentRoom(reason: string): Promise<void> {
    await this.ensureHydrated();
    await this.destroyRoom(reason);
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
      elo: player.elo,
      rankTier:
        player.rankTier ??
        (player.elo !== undefined ? getRankForElo(player.elo) : undefined),
      equippedCosmetics: sanitizeEquippedCosmetics(player.equippedCosmetics),
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
    await this.notifyMatchmakerRoomMeta();
    await this.scheduleNextAlarm();

    return { ok: true, room: this.toRoomInfo(this.room) };
  }

  public async joinAsSpectator(input: {
    sessionId?: string;
    playerId?: string;
    displayName: string;
    avatarId: OnlineAvatarId;
    roomCode?: string;
    shareToken?: string;
  }): Promise<
    | {
        ok: true;
        room: OnlineRoomInfo;
        match: OnlineMatchSnapshot | null;
        balls: OnlineBallFrame[] | null;
        chatHistory: RoomChatMessageRecord[];
        spectatorSessionId: string;
        spectatorReconnectToken: string;
      }
    | { ok: false; code: MultiplayerErrorCode; message: string }
  > {
    await this.ensureHydrated();
    if (!this.room) {
      return { ok: false, code: 'SPECTATE_UNAVAILABLE', message: 'Match room no longer exists.' };
    }

    const now = Date.now();
    if (
      this.room.status === 'expired' ||
      this.room.status === 'cancelled' ||
      ((this.room.status === 'waiting' || this.room.status === 'ready') &&
        now > this.room.expiresAtMs)
    ) {
      return { ok: false, code: 'ROOM_EXPIRED', message: 'Match room is no longer active.' };
    }
    if (this.room.status === 'finished') {
      return {
        ok: false,
        code: 'SPECTATE_UNAVAILABLE',
        message: 'This match has already finished.',
      };
    }

    if (!this.room.allowSpectators) {
      return {
        ok: false,
        code: 'SPECTATE_UNAVAILABLE',
        message: 'Spectators are not enabled for this match.',
      };
    }

    // Private rooms require an authorized share token OR matching room code even after host enables spectators
    if (this.room.isPrivate) {
      const providedToken = typeof input.shareToken === 'string' ? input.shareToken.trim() : '';
      const providedCode = typeof input.roomCode === 'string' ? input.roomCode.trim().toUpperCase() : '';
      const tokenValid =
        providedToken.length > 0 && constantTimeEqual(providedToken, this.room.spectatorShareToken);
      const codeValid =
        providedCode.length > 0 && providedCode === this.room.roomCode.toUpperCase();
      if (!tokenValid && !codeValid) {
        return {
          ok: false,
          code: 'SPECTATE_UNAVAILABLE',
          message: 'A valid room code or host share link is required to spectate this private room.',
        };
      }
    }

    const specPlayerId =
      typeof input.playerId === 'string' && input.playerId.trim().length > 0
        ? input.playerId.trim()
        : input.sessionId?.trim() || `spec_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

    const isRoomPlayer = this.room.players.some(
      (p) =>
        (p.playerId && p.playerId === specPlayerId) ||
        (input.sessionId && p.sessionId === input.sessionId),
    );
    if (isRoomPlayer) {
      return {
        ok: false,
        code: 'ALREADY_IN_MATCH',
        message: 'You are an active player in this match.',
      };
    }

    for (const p of this.room.players) {
      const targetId = p.playerId ?? p.sessionId;
      if (targetId && targetId !== specPlayerId) {
        const blocked = await this.getMatchmakerStub().socialIsBlockedBetween(
          specPlayerId,
          targetId,
        );
        if (blocked) {
          return {
            ok: false,
            code: 'BLOCKED_PLAYER',
            message: 'Spectating is unavailable due to an active player block.',
          };
        }
      }
    }

    this.pruneExpiredSpectators(now);

    const existing = this.room.spectators.find(
      (s) =>
        s.playerId === specPlayerId ||
        (input.sessionId && s.sessionId === input.sessionId),
    );

    let specRecord: StoredSpectatorRecord;
    if (existing) {
      existing.displayName = sanitizeDisplayName(input.displayName);
      existing.avatarId = sanitizeAvatarId(input.avatarId);
      existing.connected = true;
      existing.disconnectedAtMs = null;
      existing.reconnectDeadlineMs = null;
      existing.lastActiveAtMs = now;
      specRecord = existing;
    } else {
      if (this.room.spectators.length >= this.room.maxSpectators) {
        return {
          ok: false,
          code: 'ROOM_FULL',
          message: `Spectator capacity reached (${this.room.maxSpectators}/${this.room.maxSpectators}).`,
        };
      }
      const preferredSid =
        typeof input.sessionId === 'string' &&
        input.sessionId.trim().length > 0 &&
        !this.room.players.some((p) => p.sessionId === input.sessionId)
          ? input.sessionId.trim()
          : `spec_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

      specRecord = {
        sessionId: preferredSid,
        playerId: specPlayerId,
        reconnectToken: randomHexToken(24),
        displayName: sanitizeDisplayName(input.displayName),
        avatarId: sanitizeAvatarId(input.avatarId),
        connected: true,
        disconnectedAtMs: null,
        reconnectDeadlineMs: null,
        reconnectCount: 0,
        joinedAtMs: now,
        lastActiveAtMs: now,
      };
      this.room.spectators.push(specRecord);
    }

    this.persistRoomState();
    await this.notifyMatchmakerRoomMeta();
    this.broadcastRoomUpdate(this.room);
    await this.scheduleNextAlarm();

    return {
      ok: true,
      room: this.toRoomInfo(this.room, false),
      match: this.match ? this.match.getSnapshot() : null,
      balls: this.match ? this.match.physics.getBallFrames() : null,
      chatHistory: this.loadRoomChatHistory(this.room.roomId),
      spectatorSessionId: specRecord.sessionId,
      spectatorReconnectToken: specRecord.reconnectToken,
    };
  }

  public async setSpectatorSettingsByHost(
    sessionId: string,
    settings: { allowSpectators: boolean; allowSpectatorChat?: boolean },
  ): Promise<
    | { ok: true; room: OnlineRoomInfo }
    | { ok: false; code: MultiplayerErrorCode; message: string }
  > {
    await this.ensureHydrated();
    if (!this.room) {
      return { ok: false, code: 'INVALID_ROOM', message: 'Room no longer exists.' };
    }
    if (this.room.hostSessionId !== sessionId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Only the room host can change spectator access.',
      };
    }
    const nextAllow = Boolean(settings.allowSpectators);
    const nextChat =
      settings.allowSpectatorChat !== undefined
        ? Boolean(settings.allowSpectatorChat)
        : this.room.allowSpectatorChat;

    this.room.allowSpectators = nextAllow;
    this.room.allowSpectatorChat = nextChat;

    if (!nextAllow && this.room.spectators.length > 0) {
      await this.evictAllSpectators('Host disabled spectator access.');
    }

    this.persistRoomState();
    await this.notifyMatchmakerRoomMeta();
    this.broadcastRoomUpdate(this.room);
    await this.scheduleNextAlarm();
    return { ok: true, room: this.toRoomInfo(this.room, true) };
  }

  public async leaveSpectatorBySession(
    sessionIdOrPlayerId: string,
  ): Promise<{ ok: true; removed: boolean }> {
    await this.ensureHydrated();
    if (!this.room) return { ok: true, removed: false };
    const idx = this.room.spectators.findIndex(
      (s) => s.sessionId === sessionIdOrPlayerId || s.playerId === sessionIdOrPlayerId,
    );
    if (idx === -1) return { ok: true, removed: false };
    const [removed] = this.room.spectators.splice(idx, 1);
    this.closeSpectatorSockets(removed.sessionId, 'Left spectator mode.');
    this.persistRoomState();
    await this.notifyMatchmakerRoomMeta();
    await this.notifyMatchmakerSpectatorLeft(this.room.roomId, removed.playerId);
    this.broadcastRoomUpdate(this.room);
    await this.scheduleNextAlarm();
    return { ok: true, removed: true };
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

  public async updatePlayerCosmetics(
    playerId: string,
    equippedCosmetics: EquippedCosmetics,
  ): Promise<void> {
    await this.ensureHydrated();
    if (!this.room) return;
    const player = this.room.players.find(
      (p) => p.playerId === playerId || p.sessionId === playerId,
    );
    if (!player) return;
    const sanitized = sanitizeEquippedCosmetics(equippedCosmetics);
    player.equippedCosmetics = sanitized;
    player.avatarId = sanitizeAvatarId(sanitized.avatarId);
    this.persistRoomState();
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
      if (attachment.sessionId && this.room) {
        if (attachment.isSpectator) {
          const s = this.room.spectators.find((sp) => sp.sessionId === attachment.sessionId);
          if (s) s.lastActiveAtMs = Date.now();
        } else if (typeof msg.latencyMs === 'number') {
          const p = this.room.players.find((pl) => pl.sessionId === attachment.sessionId);
          if (p) {
            p.latencyMs = clampLatency(msg.latencyMs);
          }
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

    if (attachment.isSpectator) {
      const spectator = this.room.spectators.find((s) => s.sessionId === attachment.sessionId);
      if (!spectator) {
        this.sendError(ws, 'UNAUTHORIZED', 'Spectator session is no longer active.');
        return;
      }
      if (!this.room.allowSpectators) {
        this.sendError(ws, 'SPECTATE_UNAVAILABLE', 'Spectator access was disabled by the host.');
        return;
      }
      spectator.lastActiveAtMs = Date.now();

      switch (msg.type) {
        case 'room:leave': {
          await this.handleSpectatorLeave(spectator.sessionId, ws);
          return;
        }
        case 'game:request_sync': {
          if (this.match) {
            this.sendSocket(ws, {
              type: 'match:state_sync',
              room: this.toRoomInfo(this.room, false),
              match: this.match.getSnapshot(),
              balls: this.match.physics.getBallFrames(),
            });
          } else {
            this.sendSocket(ws, {
              type: 'room:updated',
              room: this.toRoomInfo(this.room, false),
            });
          }
          return;
        }
        case 'chat:room_send': {
          await this.handleSpectatorChatMessage(ws, spectator, msg.body, msg.clientMessageId);
          return;
        }
        default: {
          // Strict read-only enforcement: block all gameplay & room mutation commands without penalizing match players
          this.sendError(
            ws,
            'UNAUTHORIZED',
            'Spectators have read-only access and cannot perform gameplay or room actions.',
          );
          return;
        }
      }
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
        await this.notifyMatchmakerRoomMeta();
        this.broadcastRoomUpdate(this.room);
        break;
      }

      case 'room:set_spectators': {
        const res = await this.setSpectatorSettingsByHost(player.sessionId, {
          allowSpectators: Boolean(msg.allowSpectators),
          allowSpectatorChat:
            msg.allowSpectatorChat !== undefined ? Boolean(msg.allowSpectatorChat) : undefined,
        });
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
        }
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
        await this.notifyMatchmakerRoomMeta();
        this.broadcastRoomUpdate(this.room);
        if (
          this.room.tournament &&
          this.room.players.length === 2 &&
          this.room.players.every((p) => p.ready && p.connected)
        ) {
          await this.initializeAndStartMatch(this.room);
          await this.getMatchmakerStub().onTournamentMatchStarted(
            this.room.tournament.tournamentId,
            this.room.tournament.bracketMatchId,
          );
          await this.scheduleNextAlarm();
        }
        break;
      }

      case 'room:start': {
        if (this.room.hostSessionId !== player.sessionId && !this.room.tournament) {
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
        if (this.room.tournament) {
          await this.getMatchmakerStub().onTournamentMatchStarted(
            this.room.tournament.tournamentId,
            this.room.tournament.bracketMatchId,
          );
        }
        await this.scheduleNextAlarm();
        break;
      }

      case 'room:cancel': {
        if (this.room.tournament) {
          this.sendError(
            ws,
            'UNAUTHORIZED',
            'Tournament rooms cannot be cancelled manually. Withdraw or forfeit instead.',
          );
          return;
        }
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
        if (this.room.tournament) {
          this.sendError(
            ws,
            'INVALID_INPUT',
            'Rematches are disabled in single-elimination tournament matches.',
          );
          return;
        }
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

      case 'chat:room_send': {
        await this.handleRoomChatMessage(ws, player, msg.body, msg.clientMessageId);
        break;
      }

      default:
        this.match?.recordRejectedInput(player.role);
        this.sendError(ws, 'INVALID_INPUT', 'Unsupported or unauthorized message type.');
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
        await this.notifyMatchmakerPlayerLeft(
          player.sessionId,
          player.playerId ?? player.sessionId,
        );
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

    if (this.room) {
      const removedSpecIds = this.pruneExpiredSpectators(now);
      if (removedSpecIds.length > 0) {
        this.persistRoomState();
        await this.notifyMatchmakerRoomMeta();
        for (const pid of removedSpecIds) {
          await this.notifyMatchmakerSpectatorLeft(this.room.roomId, pid);
        }
        this.broadcastRoomUpdate(this.room);
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
    if (player && constantTimeEqual(msg.reconnectToken, player.reconnectToken)) {
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
          att.isSpectator = false;
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
        isSpectator: false,
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

      const includeToken = player.sessionId === this.room.hostSessionId;
      this.sendSocket(ws, {
        type: 'session:ready',
        sessionId: player.sessionId,
        reconnectToken: player.reconnectToken,
        playerId: player.playerId ?? player.sessionId,
        displayName: player.displayName,
        avatarId: player.avatarId,
        isSpectator: false,
        spectatorCount: this.room.spectators.length,
        resumedRoom: this.toRoomInfo(this.room, includeToken),
        resumedMatch: this.match ? this.match.getSnapshot() : null,
        balls: this.match ? this.match.physics.getBallFrames() : null,
        serverTimeMs: Date.now(),
      });

      const chatHistory = this.loadRoomChatHistory(this.room.roomId);
      if (chatHistory.length > 0) {
        this.sendSocket(ws, {
          type: 'chat:room_history',
          roomId: this.room.roomId,
          messages: chatHistory,
        });
      }

      if (wasDisconnected) {
        this.broadcastToOthers(player.sessionId, {
          type: 'opponent:reconnected',
          roomId: this.room.roomId,
          sessionId: player.sessionId,
          displayName: player.displayName,
        });
      }
      this.broadcastRoomUpdate(this.room);
      return;
    }

    // Spectator resume path (read-only)
    const spec = this.room.spectators.find((s) => s.sessionId === msg.sessionId);
    if (!spec || !constantTimeEqual(msg.reconnectToken, spec.reconnectToken)) {
      this.sendError(ws, 'UNAUTHORIZED', 'Invalid room session or reconnect token.');
      return;
    }

    if (!this.room.allowSpectators) {
      this.sendError(ws, 'SPECTATE_UNAVAILABLE', 'Spectator access was disabled by the host.');
      return;
    }

    const wasSpecDisconnected = !spec.connected;
    if (wasSpecDisconnected && spec.reconnectCount >= this.config.spectatorReconnectLimit) {
      this.room.spectators = this.room.spectators.filter((s) => s.sessionId !== spec.sessionId);
      this.persistRoomState();
      await this.notifyMatchmakerRoomMeta();
      await this.notifyMatchmakerSpectatorLeft(this.room.roomId, spec.playerId);
      this.sendError(
        ws,
        'RATE_LIMITED',
        'Spectator reconnect limit reached for this match session.',
      );
      return;
    }

    if (msg.displayName) {
      spec.displayName = sanitizeDisplayName(msg.displayName);
    }
    if (msg.avatarId) {
      spec.avatarId = sanitizeAvatarId(msg.avatarId);
    }
    if (wasSpecDisconnected) {
      spec.reconnectCount += 1;
    }
    spec.connected = true;
    spec.disconnectedAtMs = null;
    spec.reconnectDeadlineMs = null;
    spec.lastActiveAtMs = Date.now();

    for (const existingWs of this.ctx.getWebSockets()) {
      if (existingWs === ws) continue;
      const att = this.getAttachment(existingWs);
      if (att.sessionId === spec.sessionId) {
        att.sessionId = null;
        att.role = null;
        att.isSpectator = false;
        existingWs.serializeAttachment(att);
        try {
          existingWs.close(4001, 'Replaced by resumed spectator session');
        } catch {
          // Ignore close errors on stale socket
        }
      }
    }

    ws.serializeAttachment({
      sessionId: spec.sessionId,
      role: null,
      isSpectator: true,
    } satisfies RoomSocketAttachment);

    this.persistRoomState();
    await this.notifyMatchmakerRoomMeta();
    await this.scheduleNextAlarm();

    this.sendSocket(ws, {
      type: 'session:ready',
      sessionId: spec.sessionId,
      reconnectToken: spec.reconnectToken,
      playerId: spec.playerId,
      displayName: spec.displayName,
      avatarId: spec.avatarId,
      isSpectator: true,
      spectatorCount: this.room.spectators.length,
      resumedRoom: this.toRoomInfo(this.room, false),
      resumedMatch: this.match ? this.match.getSnapshot() : null,
      balls: this.match ? this.match.physics.getBallFrames() : null,
      serverTimeMs: Date.now(),
    });

    const chatHistory = this.loadRoomChatHistory(this.room.roomId);
    if (chatHistory.length > 0) {
      this.sendSocket(ws, {
        type: 'chat:room_history',
        roomId: this.room.roomId,
        messages: chatHistory,
      });
    }

    if (wasSpecDisconnected) {
      this.broadcastRoomUpdate(this.room);
    }
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

    if (att.isSpectator) {
      const spec = this.room.spectators.find((s) => s.sessionId === att.sessionId);
      if (!spec) return;
      const now = Date.now();
      spec.connected = false;
      spec.disconnectedAtMs = now;
      spec.reconnectDeadlineMs = now + this.config.spectatorReconnectGraceMs;
      this.persistRoomState();
      await this.notifyMatchmakerRoomMeta();
      this.broadcastRoomUpdate(this.room);
      await this.scheduleNextAlarm();
      return;
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

  private async handleSpectatorLeave(sessionId: string, ws?: WebSocket): Promise<void> {
    if (!this.room) return;
    const spec = this.room.spectators.find((s) => s.sessionId === sessionId);
    if (!spec) return;

    this.room.spectators = this.room.spectators.filter((s) => s.sessionId !== sessionId);
    if (ws) {
      ws.serializeAttachment({ sessionId: null, role: null, isSpectator: false });
      try {
        ws.close(1000, 'Left spectator mode');
      } catch {
        // Ignore close errors
      }
    }
    this.closeSpectatorSockets(sessionId, 'Left spectator mode');
    this.persistRoomState();
    await this.notifyMatchmakerRoomMeta();
    await this.notifyMatchmakerSpectatorLeft(this.room.roomId, spec.playerId);
    this.broadcastRoomUpdate(this.room);
    await this.scheduleNextAlarm();
  }

  private async handlePlayerLeave(sessionId: string): Promise<void> {
    if (!this.room) return;
    const leaving = this.room.players.find((p) => p.sessionId === sessionId);
    if (!leaving) return;

    await this.notifyMatchmakerPlayerLeft(sessionId, leaving.playerId ?? leaving.sessionId);

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
      await this.notifyMatchmakerRoomMeta();
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
      await this.notifyMatchmakerRoomMeta();
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
      if (role !== match.getActivePlayer()) return;
      if (typeof msg.cueAngle !== 'number' || !Number.isFinite(msg.cueAngle) || Math.abs(msg.cueAngle) > 1000) {
        match.recordRejectedInput(role);
        this.sendError(ws, 'CHEAT_REJECTED', 'Invalid cue aim vector rejected.');
        return;
      }
      this.broadcastToOthers(player.sessionId, {
        type: 'match:aim_preview',
        roomId: this.room.roomId,
        player: role,
        cueAngle: msg.cueAngle,
      });
      return;
    }

    if (msg.type === 'game:spin') {
      if (role !== match.getActivePlayer()) return;
      if (
        typeof msg.x !== 'number' ||
        typeof msg.y !== 'number' ||
        !Number.isFinite(msg.x) ||
        !Number.isFinite(msg.y) ||
        Math.hypot(msg.x, msg.y) > CLOTH_PHYSICS.maxTipOffsetRatio + 0.08
      ) {
        match.recordRejectedInput(role);
        this.sendError(ws, 'CHEAT_REJECTED', 'Invalid cue spin offset rejected.');
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

    const matchType: OnlineMatchType =
      params.roomSnapshot.matchType ??
      (params.roomSnapshot.tournament
        ? 'tournament'
        : params.roomSnapshot.isPrivate
          ? 'private'
          : 'quick');

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
      matchType,
      ruleProfileId: params.roomSnapshot.ruleProfileId,
    };

    let progression: MatchProgressionRewardSummary | undefined;
    const matchInput = {
      matchId: enrichedRecord.matchId,
      roomId: params.roomSnapshot.roomId,
      roomCode: params.roomSnapshot.roomCode,
      ruleProfileId: params.roomSnapshot.ruleProfileId,
      matchType,
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
      enrichedRecord.p1EloBefore = recRes.summary.players.player1.eloBefore;
      enrichedRecord.p1EloAfter = recRes.summary.players.player1.eloAfter;
      enrichedRecord.p1EloDelta = recRes.summary.players.player1.eloDelta;
      enrichedRecord.p2EloBefore = recRes.summary.players.player2.eloBefore;
      enrichedRecord.p2EloAfter = recRes.summary.players.player2.eloAfter;
      enrichedRecord.p2EloDelta = recRes.summary.players.player2.eloDelta;
      enrichedRecord.p1RankTier = recRes.summary.players.player1.rankAfter;
      enrichedRecord.p2RankTier = recRes.summary.players.player2.rankAfter;
      enrichedRecord.seasonId = recRes.summary.seasonId ?? null;
    } catch {
      // Non-blocking fallback if progression storage fails
    }

    try {
      const acTelemetry = this.match?.getAntiCheatTelemetry() ?? {
        p1RejectedInputs: 0,
        p2RejectedInputs: 0,
        minShotIntervalMs: null,
      };
      const acInput = {
        matchId: enrichedRecord.matchId,
        roomId: params.roomSnapshot.roomId,
        matchMode: matchType,
        player1Id: params.p1.playerId,
        player2Id: params.p2.playerId,
        winnerRole: enrichedRecord.winnerRole,
        winnerId:
          enrichedRecord.winnerRole === 'player1' ? params.p1.playerId : params.p2.playerId,
        completionType: params.telemetrySummary.completionType,
        totalShots: enrichedRecord.totalShots,
        durationSec: params.telemetrySummary.durationSec,
        p1RejectedInputs: acTelemetry.p1RejectedInputs,
        p2RejectedInputs: acTelemetry.p2RejectedInputs,
        minShotIntervalMs: acTelemetry.minShotIntervalMs,
        p1WinStreakAfter: 0,
        p2WinStreakAfter: 0,
        endedAtMs: enrichedRecord.endedAtMs,
      };
      if (this.env.DB) {
        await new AntiCheatService(this.env.DB).inspectCompletedMatch(acInput);
      } else {
        await this.getMatchmakerStub().inspectCompletedMatch(acInput);
      }
    } catch {
      // Non-blocking anti-cheat audit fallback
    }

    await Promise.all([
      this.notifyMatchmakerRoomStatus('finished'),
      this.notifyMatchmakerHistory(enrichedRecord),
    ]);

    if (params.roomSnapshot.tournament) {
      const winnerPlayerId =
        enrichedRecord.winnerRole === 'player1' ? params.p1.playerId : params.p2.playerId;
      const resolutionType =
        params.telemetrySummary.completionType === 'forfeit' ||
        params.telemetrySummary.completionType === 'disconnect_forfeit'
          ? ('forfeit' as const)
          : ('played' as const);
      try {
        await this.getMatchmakerStub().onTournamentMatchCompleted({
          tournamentId: params.roomSnapshot.tournament.tournamentId,
          bracketMatchId: params.roomSnapshot.tournament.bracketMatchId,
          roomId: params.roomSnapshot.roomId,
          matchId: enrichedRecord.matchId,
          winnerPlayerId,
          resolutionType,
          reason: enrichedRecord.reason,
          completedAtMs: enrichedRecord.endedAtMs,
        });
      } catch {
        // Non-blocking fallback
      }
    }

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
    const playerIds = this.room.players.map((p) => p.playerId ?? p.sessionId);
    const spectatorPlayerIds = this.room.spectators.map((s) => s.playerId);

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
    await this.notifyMatchmakerRoomClosed(roomId, sessionIds, playerIds, spectatorPlayerIds);
  }

  private pruneExpiredSpectators(now = Date.now()): string[] {
    if (!this.room || this.room.spectators.length === 0) return [];
    const removedPlayerIds: string[] = [];
    this.room.spectators = this.room.spectators.filter((s) => {
      if (!s.connected && s.reconnectDeadlineMs !== null && now >= s.reconnectDeadlineMs) {
        removedPlayerIds.push(s.playerId);
        return false;
      }
      return true;
    });
    return removedPlayerIds;
  }

  private closeSpectatorSockets(targetSessionId: string | null, reason: string): void {
    for (const sock of this.ctx.getWebSockets()) {
      const att = this.getAttachment(sock);
      if (!att.isSpectator) continue;
      if (targetSessionId !== null && att.sessionId !== targetSessionId) continue;
      att.sessionId = null;
      att.role = null;
      att.isSpectator = false;
      sock.serializeAttachment(att);
      try {
        sock.close(4003, reason);
      } catch {
        // Ignore closed socket
      }
    }
  }

  private async evictAllSpectators(reason: string): Promise<void> {
    if (!this.room) return;
    const removed = [...this.room.spectators];
    this.room.spectators = [];
    for (const sock of this.ctx.getWebSockets()) {
      const att = this.getAttachment(sock);
      if (!att.isSpectator) continue;
      this.sendSocket(sock, {
        type: 'room:closed',
        roomId: this.room.roomId,
        reason,
      });
      att.sessionId = null;
      att.role = null;
      att.isSpectator = false;
      sock.serializeAttachment(att);
      try {
        sock.close(4003, reason);
      } catch {
        // Ignore close error
      }
    }
    for (const sp of removed) {
      await this.notifyMatchmakerSpectatorLeft(this.room.roomId, sp.playerId);
    }
  }

  private updateWaitingStatus(room: StoredRoomState): void {
    if (room.status === 'playing' || room.status === 'finished') return;
    if (room.players.length === 2 && room.players.every((p) => p.ready && p.connected)) {
      room.status = 'ready';
    } else {
      room.status = 'waiting';
    }
  }

  private toRoomInfo(room: StoredRoomState, includeShareToken = false): OnlineRoomInfo {
    const matchType: OnlineMatchType =
      room.matchType ??
      (room.tournament ? 'tournament' : room.isPrivate ? 'private' : 'quick');
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      hostSessionId: room.hostSessionId,
      isPrivate: room.isPrivate,
      matchType,
      ruleProfileId: room.ruleProfileId,
      calledShotsEnabled: room.calledShotsEnabled,
      status: room.status,
      allowSpectators: room.allowSpectators,
      allowSpectatorChat: room.allowSpectatorChat,
      maxSpectators: room.maxSpectators,
      spectatorShareToken: includeShareToken ? room.spectatorShareToken : undefined,
      spectatorCount: room.spectators.length,
      spectators: room.spectators.map((s) => ({
        playerId: s.playerId,
        displayName: s.displayName,
        avatarId: s.avatarId,
        connected: s.connected,
      })),
      players: room.players.map((p) => ({
        sessionId: p.sessionId,
        playerId: p.playerId ?? p.sessionId,
        displayName: p.displayName,
        avatarId: p.avatarId,
        elo: p.elo,
        rankTier: p.rankTier,
        equippedCosmetics: p.equippedCosmetics ?? DEFAULT_EQUIPPED_COSMETICS,
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
      tournament: room.tournament ?? null,
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
    for (const s of this.room.spectators) {
      if (!s.connected && s.reconnectDeadlineMs !== null) {
        candidates.push(s.reconnectDeadlineMs);
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
    return raw ?? { sessionId: null, role: null, isSpectator: false };
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
    const publicEncoded = JSON.stringify({
      type: 'room:updated',
      room: this.toRoomInfo(room, false),
    } satisfies ServerToClientMessage);
    const hostEncoded = JSON.stringify({
      type: 'room:updated',
      room: this.toRoomInfo(room, true),
    } satisfies ServerToClientMessage);
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (!att.sessionId) continue;
      try {
        ws.send(!att.isSpectator && att.sessionId === room.hostSessionId ? hostEncoded : publicEncoded);
      } catch {
        // Ignore closed socket
      }
    }
  }

  private broadcastStateSync(room: StoredRoomState): void {
    if (!this.match) return;
    this.broadcastToRoom({
      type: 'match:state_sync',
      room: this.toRoomInfo(room, false),
      match: this.match.getSnapshot(),
      balls: this.match.physics.getBallFrames(),
    });
  }

  private async handleRoomChatMessage(
    ws: WebSocket,
    sender: StoredPlayerRecord,
    rawBody: unknown,
    clientMessageId?: string,
  ): Promise<void> {
    if (!this.room) {
      this.sendError(ws, 'INVALID_ROOM', 'Room no longer exists.');
      return;
    }

    const textCheck = sanitizeChatText(rawBody);
    if (!textCheck.ok) {
      this.sendError(ws, textCheck.code, textCheck.message);
      return;
    }

    const senderPlayerId = sender.playerId ?? sender.sessionId;
    const spamCheck = checkChatAntiSpam(`room:${senderPlayerId}`, textCheck.text, Date.now());
    if (!spamCheck.ok) {
      this.sendError(ws, 'RATE_LIMITED', spamCheck.message);
      return;
    }

    const otherPlayers = this.room.players.filter((p) => p.sessionId !== sender.sessionId);
    for (const peer of otherPlayers) {
      const peerPlayerId = peer.playerId ?? peer.sessionId;
      if (peerPlayerId !== senderPlayerId) {
        const blocked = await this.getMatchmakerStub().socialIsBlockedBetween(
          senderPlayerId,
          peerPlayerId,
        );
        if (blocked) {
          this.sendError(
            ws,
            'BLOCKED_PLAYER',
            'Room chat is disabled because a player block is active between participants.',
          );
          return;
        }
      }
    }

    const now = Date.now();
    const message: RoomChatMessageRecord = {
      messageId: `rc_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`,
      roomId: this.room.roomId,
      senderSessionId: sender.sessionId,
      senderPlayerId,
      senderName: sender.displayName,
      senderAvatar: sender.avatarId,
      senderRole: sender.role,
      channel: 'match',
      body: textCheck.text,
      createdAtMs: now,
    };

    this.persistAndBroadcastChatMessage(message, clientMessageId);
  }

  private async handleSpectatorChatMessage(
    ws: WebSocket,
    sender: StoredSpectatorRecord,
    rawBody: unknown,
    clientMessageId?: string,
  ): Promise<void> {
    if (!this.room) {
      this.sendError(ws, 'INVALID_ROOM', 'Room no longer exists.');
      return;
    }
    if (!this.room.allowSpectatorChat) {
      this.sendError(
        ws,
        'SPECTATOR_CHAT_DISABLED',
        'Spectator chat is currently disabled for this match.',
      );
      return;
    }

    const textCheck = sanitizeChatText(rawBody);
    if (!textCheck.ok) {
      this.sendError(ws, textCheck.code, textCheck.message);
      return;
    }

    const spamCheck = checkChatAntiSpam(`spec:${sender.playerId}`, textCheck.text, Date.now());
    if (!spamCheck.ok) {
      this.sendError(ws, 'RATE_LIMITED', spamCheck.message);
      return;
    }

    for (const peer of this.room.players) {
      const peerPlayerId = peer.playerId ?? peer.sessionId;
      if (peerPlayerId && peerPlayerId !== sender.playerId) {
        const blocked = await this.getMatchmakerStub().socialIsBlockedBetween(
          sender.playerId,
          peerPlayerId,
        );
        if (blocked) {
          this.sendError(
            ws,
            'BLOCKED_PLAYER',
            'Spectator chat is unavailable because of an active block.',
          );
          return;
        }
      }
    }

    const message: RoomChatMessageRecord = {
      messageId: `sc_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`,
      roomId: this.room.roomId,
      senderSessionId: sender.sessionId,
      senderPlayerId: sender.playerId,
      senderName: sender.displayName,
      senderAvatar: sender.avatarId,
      senderRole: 'spectator',
      channel: 'spectator',
      body: textCheck.text,
      createdAtMs: Date.now(),
    };

    this.persistAndBroadcastChatMessage(message, clientMessageId);
  }

  private persistAndBroadcastChatMessage(
    message: RoomChatMessageRecord,
    clientMessageId?: string,
  ): void {
    if (!this.room) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO room_chat_messages (
        message_id, sender_session_id, sender_player_id, sender_name, sender_avatar, sender_role, channel, body, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.messageId,
      message.senderSessionId,
      message.senderPlayerId,
      message.senderName,
      message.senderAvatar,
      message.senderRole,
      message.channel ?? (message.senderRole === 'spectator' ? 'spectator' : 'match'),
      message.body,
      message.createdAtMs,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM room_chat_messages
       WHERE message_id NOT IN (
         SELECT message_id FROM room_chat_messages ORDER BY created_at_ms DESC LIMIT ?
       )`,
      SOCIAL_LIMITS.maxRoomChatHistory,
    );

    const encoded = JSON.stringify({
      type: 'chat:room_message',
      roomId: this.room.roomId,
      message,
      clientMessageId,
    } satisfies ServerToClientMessage);

    for (const sock of this.ctx.getWebSockets()) {
      const att = this.getAttachment(sock);
      if (!att.sessionId) continue;
      try {
        sock.send(encoded);
      } catch {
        // Ignore closed socket
      }
    }
  }

  private loadRoomChatHistory(roomId: string): RoomChatMessageRecord[] {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        'SELECT * FROM room_chat_messages ORDER BY created_at_ms ASC LIMIT ?',
        SOCIAL_LIMITS.maxRoomChatHistory,
      )
      .toArray();

    return rows.map((r) => {
      const role: RoomChatMessageRecord['senderRole'] =
        r.sender_role === 'spectator'
          ? 'spectator'
          : r.sender_role === 'player2'
            ? 'player2'
            : 'player1';
      return {
        messageId: String(r.message_id),
        roomId,
        senderSessionId: String(r.sender_session_id),
        senderPlayerId: String(r.sender_player_id),
        senderName: String(r.sender_name),
        senderAvatar: sanitizeAvatarId(r.sender_avatar),
        senderRole: role,
        channel:
          r.channel === 'spectator' || role === 'spectator' ? 'spectator' : 'match',
        body: String(r.body),
        createdAtMs: Number(r.created_at_ms),
      };
    });
  }

  private getMatchmakerStub() {
    return this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('global'));
  }

  private async notifyMatchmakerRoomStatus(status: OnlineRoomStatus): Promise<void> {
    if (!this.room) return;
    const playerIds = this.room.players.map((p) => p.playerId ?? p.sessionId);
    await this.getMatchmakerStub().onRoomStatusChanged(this.room.roomId, status, playerIds);
    await this.notifyMatchmakerRoomMeta();
  }

  private async notifyMatchmakerRoomMeta(): Promise<void> {
    if (!this.room) return;
    try {
      await this.getMatchmakerStub().onRoomMetaUpdated(this.room.roomId, {
        status: this.room.status,
        isPrivate: this.room.isPrivate,
        allowSpectators: this.room.allowSpectators,
        allowSpectatorChat: this.room.allowSpectatorChat,
        spectatorCount: this.room.spectators.length,
        maxSpectators: this.room.maxSpectators,
        matchType:
          this.room.matchType ??
          (this.room.tournament ? 'tournament' : this.room.isPrivate ? 'private' : 'quick'),
        ruleProfileId: this.room.ruleProfileId,
        calledShotsEnabled: this.room.calledShotsEnabled,
        players: this.room.players.map((p) => ({
          playerId: p.playerId ?? p.sessionId,
          displayName: p.displayName,
          avatarId: p.avatarId,
          role: p.role,
          elo: p.elo,
          rankTier: p.rankTier,
        })),
        tournament: this.room.tournament ?? null,
      });
    } catch {
      // Non-blocking sync
    }
  }

  private async notifyMatchmakerPlayerLeft(
    sessionId: string,
    playerId?: string,
  ): Promise<void> {
    if (!this.room) return;
    await this.getMatchmakerStub().onPlayerLeftRoom(this.room.roomId, sessionId, playerId);
  }

  private async notifyMatchmakerSpectatorLeft(
    roomId: string,
    playerId: string,
  ): Promise<void> {
    try {
      await this.getMatchmakerStub().onSpectatorLeftRoom(roomId, playerId);
    } catch {
      // Non-blocking sync
    }
  }

  private async notifyMatchmakerRoomClosed(
    roomId: string,
    sessionIds: string[],
    playerIds: string[] = [],
    spectatorPlayerIds: string[] = [],
  ): Promise<void> {
    await this.getMatchmakerStub().onRoomClosed(
      roomId,
      sessionIds,
      playerIds,
      spectatorPlayerIds,
    );
  }

  private async notifyMatchmakerHistory(record: MatchHistoryRecord): Promise<void> {
    await this.getMatchmakerStub().recordMatchHistory(record);
  }
}
