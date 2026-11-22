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
  OnlineBallFrame,
  OnlineMatchSnapshot,
  OnlineRoomClubLeagueContext,
  OnlineRoomInfo,
  OnlineRoomStatus,
  OnlineRoomTournamentContext,
  ServerToClientMessage,
  SpectatableMatchPlayer,
  SpectatableMatchSummary,
} from '../../src/multiplayer/shared/protocol';
import type { RoomChatMessageRecord } from '../../src/multiplayer/shared/social';
import {
  DEFAULT_PRIVACY_SETTINGS,
  isValidManualPresence,
  sanitizeChatText,
  SOCIAL_LIMITS,
  type ClubChallengeRecord,
  type ClubChatMessageRecord,
  type ClubDetailPayload,
  type ClubInvitationRecord,
  type ClubLeaderboardEntry,
  type ClubLeaderboardScope,
  type ClubRecord,
  type ClubRole,
  type ClubTrophyRecord,
  type DirectMessageRecord,
  type FriendRecord,
  type FriendRequestAction,
  type FriendRoomAvailability,
  type ManualPresenceStatus,
  type MatchInvitationRecord,
  type MatchInviteAction,
  type MatchInviteKind,
  type NotificationType,
  type PlayerClubBadgeSummary,
  type PresenceStatus,
  type PrivacySettings,
  type SocialNotificationRecord,
  type SocialOverviewPayload,
  type SocialSearchPlayerItem,
} from '../../src/multiplayer/shared/social';
import type {
  AiMatchRewardRequest,
  EquippedCosmetics,
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
import { createDurableObjectSqlDb, D1ProgressionService, type ProgressionSqlDb } from './D1ProgressionService';
import { ClubService, type ClubServiceError } from './ClubService';
import { ClubLeagueService, type ClubLeagueServiceError } from './ClubLeagueService';
import { EconomyService } from './EconomyService';
import { AntiCheatService, type AntiCheatMatchInspectionInput } from './AntiCheatService';
import { RankedSeasonService } from './RankedSeasonService';
import { SocialService, type SocialError } from './SocialService';
import { TournamentService, type TournamentServiceError } from './TournamentService';
import { BattlePassService } from './BattlePassService';
import type { TeamSubMatchRecord } from '../../src/multiplayer/shared/clubLeagues';
import type {
  AiMatchProgressRequest,
  BattlePassTrack,
  MissionCadence,
} from '../../src/multiplayer/shared/battlePass';
import {
  computeAllowedRankedEloSpread,
  RANKED_MATCHMAKING_CONFIG,
  type PenaltyType,
} from '../../src/multiplayer/shared/ranked';
import type {
  CreateTournamentInput,
  TournamentMatch,
  TournamentMatchResolutionType,
  TournamentRecord,
} from '../../src/multiplayer/shared/tournaments';

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface LobbySocketAttachment {
  sessionId: string | null;
  playerId: string | null;
  subscribedTournamentId?: string | null;
  region?: string | null;
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
  player_id: string;
  queue_mode: 'quick' | 'ranked';
  elo: number;
  region: string;
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
  private lastRankedSpreadSent = new Map<string, number>();

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
        match_type TEXT NOT NULL DEFAULT 'quick',
        rule_profile_id TEXT NOT NULL,
        called_shots_enabled INTEGER NOT NULL,
        status TEXT NOT NULL,
        allow_spectators INTEGER NOT NULL DEFAULT 1,
        allow_spectator_chat INTEGER NOT NULL DEFAULT 1,
        spectator_count INTEGER NOT NULL DEFAULT 0,
        max_spectators INTEGER NOT NULL DEFAULT 16,
        meta_json TEXT,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_queue (
        session_id TEXT PRIMARY KEY,
        player_id TEXT,
        queue_mode TEXT NOT NULL DEFAULT 'quick',
        elo INTEGER NOT NULL DEFAULT 1200,
        region TEXT NOT NULL DEFAULT 'global',
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
      "ALTER TABLE rooms ADD COLUMN match_type TEXT NOT NULL DEFAULT 'quick'",
      'ALTER TABLE rooms ADD COLUMN allow_spectators INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE rooms ADD COLUMN allow_spectator_chat INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE rooms ADD COLUMN spectator_count INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE rooms ADD COLUMN max_spectators INTEGER NOT NULL DEFAULT 16',
      'ALTER TABLE rooms ADD COLUMN meta_json TEXT',
      'ALTER TABLE match_queue ADD COLUMN player_id TEXT',
      "ALTER TABLE match_queue ADD COLUMN queue_mode TEXT NOT NULL DEFAULT 'quick'",
      'ALTER TABLE match_queue ADD COLUMN elo INTEGER NOT NULL DEFAULT 1200',
      "ALTER TABLE match_queue ADD COLUMN region TEXT NOT NULL DEFAULT 'global'",
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

    const cf = (request as Request & { cf?: { continent?: string; country?: string } }).cf;
    const detectedRegion = this.normalizeRegion(cf?.continent ?? cf?.country ?? 'global');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const att: LobbySocketAttachment = {
      sessionId: null,
      playerId: null,
      subscribedTournamentId: null,
      region: detectedRegion,
    };
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
      const overview = await this.buildSocialOverview(identity.playerId);
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
        const overview = await this.buildSocialOverview(identity.playerId);
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
      const overview = await this.buildSocialOverview(effectivePlayerId);
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
            await this.getEconomyService().syncStarterAvatarIfChanged(session.player_id, avatar);
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
        const overview = await this.buildSocialOverview(playerId);
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
        const overview = await this.buildSocialOverview(playerId);
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

      case 'social:mark_notification_read': {
        const res = await this.getSocialService().markNotificationRead(playerId, msg.notificationId);
        this.sendSocket(ws, {
          type: 'notifications:updated',
          notifications: res.notifications,
          unreadCount: res.unreadCount,
        });
        break;
      }

      case 'social:clear_notifications': {
        const res = await this.getSocialService().clearNotifications(playerId, msg.notificationId);
        this.sendSocket(ws, {
          type: 'notifications:updated',
          notifications: res.notifications,
          unreadCount: res.unreadCount,
        });
        break;
      }

      case 'social:privacy_update': {
        const updated = await this.handleUpdatePrivacySettings(playerId, msg.privacy);
        this.sendSocket(ws, { type: 'privacy:updated', privacy: updated });
        break;
      }

      case 'club:sync': {
        const clubSvc = this.getClubService();
        const summary = await clubSvc.getPlayerClubSummary(playerId);
        const [clubDetail, incomingInvitations] = await Promise.all([
          summary ? clubSvc.getClubDetail(summary.clubId, playerId) : Promise.resolve(null),
          clubSvc.getIncomingClubInvitations(playerId),
        ]);
        this.sendSocket(ws, {
          type: 'club:updated',
          clubDetail,
          incomingInvitations,
        });
        break;
      }

      case 'invite:send': {
        const res = await this.handleSendInvite(playerId, session.session_id, {
          targetPlayerId: msg.targetPlayerId,
          inviteKind: msg.inviteKind,
          roomId: msg.roomId,
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

      case 'room:join_friend': {
        const res = await this.handleJoinFriendRoom(
          playerId,
          session.session_id,
          msg.friendPlayerId,
        );
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
          return;
        }
        this.sendSocket(ws, { type: 'room:updated', room: res.room });
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
        const overview = await this.buildSocialOverview(playerId);
        this.sendToPlayer(playerId, { type: 'social:state', overview });
        break;
      }

      case 'room:create': {
        await this.pruneExpiredWaitingRooms();
        const restriction = await this.getAntiCheatService().getPlayerRestriction(playerId);
        if (restriction.blockedFromOnline) {
          this.sendError(
            ws,
            'SUSPENDED',
            'Your account is currently suspended from online multiplayer. Review status in Fair Play & Appeals.',
          );
          return;
        }
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
        const isPrivateRoom = msg.isPrivate !== false;
        const hostPlayerId = session.player_id ?? session.session_id;
        const [hostCosmetics, hostProfile] = await Promise.all([
          this.getEconomyService().getEquippedCosmetics(hostPlayerId),
          this.getProgressionService().getPublicProfile(hostPlayerId),
        ]);
        const initialMeta = JSON.stringify({
          players: [
            {
              playerId: hostPlayerId,
              displayName: session.display_name,
              avatarId: sanitizeAvatarId(session.avatar_id),
              role: 'player1',
              elo: hostProfile?.elo,
              rankTier: hostProfile?.rankTier,
            } satisfies SpectatableMatchPlayer,
          ],
          tournament: null,
        });

        const allowSpectatorsDefault = !isPrivateRoom;
        this.ctx.storage.sql.exec(
          `INSERT INTO rooms (
            room_id, room_code, host_session_id, is_private, match_type, rule_profile_id,
            called_shots_enabled, status, allow_spectators, allow_spectator_chat,
            spectator_count, max_spectators, meta_json, created_at_ms, expires_at_ms
          ) VALUES (?, ?, ?, ?, 'private', ?, ?, 'waiting', ?, 1, 0, ?, ?, ?, ?)`,
          roomId,
          roomCode,
          session.session_id,
          isPrivateRoom ? 1 : 0,
          ruleProfileId,
          calledShotsEnabled ? 1 : 0,
          allowSpectatorsDefault ? 1 : 0,
          this.config.maxSpectatorsPerRoom,
          initialMeta,
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
          isPrivate: isPrivateRoom,
          allowSpectators: allowSpectatorsDefault,
          createdAtMs: now,
          expiresAtMs,
          host: {
            sessionId: session.session_id,
            playerId: hostPlayerId,
            reconnectToken: session.reconnect_token,
            displayName: session.display_name,
            avatarId: sanitizeAvatarId(session.avatar_id),
            elo: hostProfile?.elo,
            rankTier: hostProfile?.rankTier,
            equippedCosmetics: hostCosmetics,
            latencyMs: session.latency_ms,
          },
        });

        await this.scheduleNextAlarm();
        this.sendSocket(ws, { type: 'room:created', room: roomInfo });
        const creatorFriendIds = await this.getSocialService().getFriendIds(hostPlayerId);
        await this.pushOverviewToPlayers(creatorFriendIds);
        break;
      }

      case 'room:join': {
        await this.pruneExpiredWaitingRooms();
        const restriction = await this.getAntiCheatService().getPlayerRestriction(playerId);
        if (restriction.blockedFromOnline) {
          this.sendError(
            ws,
            'SUSPENDED',
            'Your account is currently suspended from online multiplayer. Review status in Fair Play & Appeals.',
          );
          return;
        }
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

        const joinPlayerId = session.player_id ?? session.session_id;
        const [joinCosmetics, joinProfile] = await Promise.all([
          this.getEconomyService().getEquippedCosmetics(joinPlayerId),
          this.getProgressionService().getPublicProfile(joinPlayerId),
        ]);
        const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomRow.room_id));
        const joinRes = await roomStub.joinRoom({
          sessionId: session.session_id,
          playerId: joinPlayerId,
          reconnectToken: session.reconnect_token,
          displayName: session.display_name,
          avatarId: sanitizeAvatarId(session.avatar_id),
          elo: joinProfile?.elo,
          rankTier: joinProfile?.rankTier,
          equippedCosmetics: joinCosmetics,
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
        const mode: 'quick' | 'ranked' = msg.mode === 'ranked' ? 'ranked' : 'quick';
        const ruleProfileId: RuleProfileId =
          msg.ruleProfileId === 'wpa'
            ? 'wpa'
            : msg.ruleProfileId === 'casual'
              ? 'casual'
              : mode === 'ranked'
                ? RANKED_MATCHMAKING_CONFIG.defaultRuleProfile
                : 'casual';
        const calledShotsEnabled =
          msg.calledShotsEnabled !== undefined
            ? Boolean(msg.calledShotsEnabled)
            : mode === 'ranked';

        if (session.active_room_id) {
          this.sendError(ws, 'ALREADY_IN_MATCH', 'You are already in an active room or match.');
          return;
        }
        if (session.in_matchmaking === 1) {
          this.sendError(ws, 'ALREADY_IN_MATCH', 'You are already searching for an opponent.');
          return;
        }

        const restriction = await this.getAntiCheatService().getPlayerRestriction(playerId);
        if (restriction.blockedFromOnline) {
          this.sendError(
            ws,
            'SUSPENDED',
            'Your account is suspended from online play. View Fair Play & Appeals for details.',
          );
          return;
        }
        if (mode === 'ranked' && restriction.blockedFromRanked) {
          const activePenalty = restriction.activePenalties.find(
            (p) => p.penaltyType === 'ranked_restriction',
          );
          this.sendError(
            ws,
            'RANKED_RESTRICTED',
            activePenalty
              ? `Ranked queue restricted: ${activePenalty.reason}`
              : 'Your account is currently restricted from Ranked play.',
          );
          return;
        }

        const dupPlayerQueue = this.ctx.storage.sql
          .exec<{ session_id: string }>(
            'SELECT session_id FROM match_queue WHERE player_id = ? LIMIT 1',
            playerId,
          )
          .toArray();
        if (dupPlayerQueue.length > 0 && dupPlayerQueue[0].session_id !== session.session_id) {
          this.sendError(
            ws,
            'ALREADY_IN_MATCH',
            'Your account is already queued in another active session.',
          );
          return;
        }

        const profile = await this.getProgressionService().getPublicProfile(playerId);
        const playerElo = profile?.elo ?? 1200;
        const region = this.normalizeRegion(msg.region ?? att.region ?? 'global');
        const initialSpread = computeAllowedRankedEloSpread(0);
        const estimatedWaitSec = await this.getEstimatedQueueWaitSec(mode);

        const now = Date.now();
        const timeoutAtMs = now + this.config.matchmakingTimeoutMs;
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO match_queue (
            session_id, player_id, queue_mode, elo, region,
            rule_profile_id, called_shots_enabled, joined_at_ms, timeout_at_ms, latency_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          session.session_id,
          playerId,
          mode,
          playerElo,
          region,
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
        if (mode === 'ranked') {
          this.lastRankedSpreadSent.set(session.session_id, initialSpread);
        }

        const queueCount = this.getQueueCount(mode);
        this.sendSocket(ws, {
          type: 'matchmaking:searching',
          position: queueCount,
          startedAtMs: now,
          timeoutAtMs,
          mode,
          elo: playerElo,
          eloSpread: mode === 'ranked' ? initialSpread : undefined,
          region,
          estimatedWaitSec,
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

      case 'tournament:subscribe': {
        if (typeof msg.tournamentId === 'string' && msg.tournamentId.trim()) {
          const tid = msg.tournamentId.trim();
          const currentAtt = this.getAttachment(ws);
          ws.serializeAttachment({
            ...currentAtt,
            subscribedTournamentId: tid,
          } satisfies LobbySocketAttachment);
          const detail = await this.getTournamentService().getTournamentDetail(tid, {
            viewerId: playerId,
          });
          if (detail) {
            this.sendSocket(ws, {
              type: 'tournament:updated',
              tournament: detail.tournament,
              matches: detail.matches,
            });
          }
        }
        break;
      }

      case 'tournament:unsubscribe': {
        const currentAtt = this.getAttachment(ws);
        ws.serializeAttachment({
          ...currentAtt,
          subscribedTournamentId: null,
        } satisfies LobbySocketAttachment);
        break;
      }

      case 'tournament:join_match': {
        const res = await this.handleJoinTournamentMatch(
          playerId,
          session.session_id,
          msg.tournamentId,
          msg.bracketMatchId,
        );
        if (!res.ok) {
          this.sendError(ws, res.code as MultiplayerErrorCode, res.message);
          return;
        }
        this.sendSocket(ws, { type: 'room:updated', room: res.room });
        break;
      }

      case 'room:spectate': {
        if (session.active_room_id || session.in_matchmaking === 1) {
          this.sendError(
            ws,
            'ALREADY_IN_MATCH',
            'Leave your current room or matchmaking queue before spectating.',
          );
          return;
        }
        const specRes = await this.spectateJoin({
          roomId: msg.roomId,
          roomCode: msg.roomCode,
          targetPlayerId: msg.targetPlayerId,
          shareToken: msg.shareToken,
          sessionId: session.session_id,
          playerId,
          displayName: session.display_name,
          avatarId: sanitizeAvatarId(session.avatar_id),
          trustedWsSession: true,
        });
        if (!specRes.ok) {
          this.sendError(ws, specRes.code as MultiplayerErrorCode, specRes.message);
          return;
        }
        this.sendSocket(ws, {
          type: 'spectate:joined',
          room: specRes.room,
          match: specRes.match,
          balls: specRes.balls,
          chatHistory: specRes.chatHistory,
          spectatorSessionId: specRes.spectatorSessionId,
          spectatorReconnectToken: specRes.spectatorReconnectToken,
        });
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
    await this.processTournamentTimersInternal();
    await this.processClubLeagueTimersInternal();
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

  public async onRoomMetaUpdated(
    roomId: string,
    meta: {
      status: OnlineRoomStatus;
      isPrivate: boolean;
      allowSpectators: boolean;
      allowSpectatorChat: boolean;
      spectatorCount: number;
      maxSpectators: number;
      matchType: OnlineMatchType;
      ruleProfileId: RuleProfileId;
      calledShotsEnabled: boolean;
      players: SpectatableMatchPlayer[];
      tournament?: OnlineRoomTournamentContext | null;
      clubLeague?: OnlineRoomClubLeagueContext | null;
    },
  ): Promise<void> {
    this.ensureSchema();
    const serialized = JSON.stringify({
      players: meta.players,
      tournament: meta.tournament ?? null,
      clubLeague: meta.clubLeague ?? null,
    });
    this.ctx.storage.sql.exec(
      `UPDATE rooms
       SET status = ?, is_private = ?, match_type = ?, rule_profile_id = ?,
           called_shots_enabled = ?, allow_spectators = ?, allow_spectator_chat = ?,
           spectator_count = ?, max_spectators = ?, meta_json = ?
       WHERE room_id = ?`,
      meta.status,
      meta.isPrivate ? 1 : 0,
      meta.matchType,
      meta.ruleProfileId,
      meta.calledShotsEnabled ? 1 : 0,
      meta.allowSpectators ? 1 : 0,
      meta.allowSpectatorChat ? 1 : 0,
      Math.max(0, Math.floor(meta.spectatorCount)),
      Math.max(1, Math.floor(meta.maxSpectators)),
      serialized,
      roomId,
    );
  }

  public async onSpectatorLeftRoom(roomId: string, playerId: string): Promise<void> {
    this.ensureSchema();
    if (!playerId) return;
    const sess = this.findLatestSessionByPlayerId(playerId);
    const activeMatchRoom =
      sess?.active_room_id && sess.active_room_id !== roomId
        ? this.ctx.storage.sql
            .exec<{ status: string }>(
              'SELECT status FROM rooms WHERE room_id = ? LIMIT 1',
              sess.active_room_id,
            )
            .toArray()[0]?.status === 'playing'
        : false;
    if (activeMatchRoom) return;

    const hasLobbySocket = this.findSocketsByPlayerId(playerId).length > 0;
    const res = await this.getSocialService().setPresence({
      playerId,
      status: hasLobbySocket ? 'online' : 'offline',
      activeRoomId: null,
      ttlMs: this.config.presenceTtlMs,
    });
    if (res.changed) {
      await this.broadcastPresenceChanged(playerId, res.status, res.lastSeenAtMs);
    }
  }

  public async onRoomClosed(
    roomId: string,
    sessionIds: string[],
    playerIds: string[] = [],
    spectatorPlayerIds: string[] = [],
  ): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_id = ?', roomId);
    const resolvedPlayerIds = new Set<string>([...playerIds, ...spectatorPlayerIds]);
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

    if (record.player1Id && record.player2Id) {
      try {
        const clubSvc = this.getClubService();
        const linkedChallenge = await clubSvc.autoLinkMatchToActiveChallenge({
          matchId: record.matchId,
          player1Id: record.player1Id,
          player2Id: record.player2Id,
        });
        if (linkedChallenge) {
          await this.broadcastClubChallengeUpdate(linkedChallenge, {
            notifyTitle:
              linkedChallenge.status === 'completed'
                ? 'Club Challenge Completed'
                : 'Club Challenge Score Updated',
            notifyBody:
              linkedChallenge.status === 'completed'
                ? `${linkedChallenge.winnerClubId === linkedChallenge.challengerClubId ? linkedChallenge.challengerClubName : linkedChallenge.targetClubName} won ${linkedChallenge.challengerClubTag} vs ${linkedChallenge.targetClubTag} (${linkedChallenge.challengerScore}-${linkedChallenge.targetScore}).`
                : `${linkedChallenge.challengerClubTag} ${linkedChallenge.challengerScore} - ${linkedChallenge.targetScore} ${linkedChallenge.targetClubTag} after verified match.`,
          });
        }
      } catch {
        // Non-blocking club challenge linking
      }
    }
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

  private getEconomyService(): EconomyService {
    if (this.env.DB) {
      return new EconomyService(this.env.DB);
    }
    return new EconomyService(createDurableObjectSqlDb(this.ctx.storage.sql));
  }

  private getTournamentService(): TournamentService {
    if (this.env.DB) {
      return new TournamentService(this.env.DB);
    }
    return new TournamentService(createDurableObjectSqlDb(this.ctx.storage.sql));
  }

  private getRankedSeasonService(): RankedSeasonService {
    if (this.env.DB) {
      return new RankedSeasonService(this.env.DB);
    }
    return new RankedSeasonService(createDurableObjectSqlDb(this.ctx.storage.sql));
  }

  private getAntiCheatService(): AntiCheatService {
    if (this.env.DB) {
      return new AntiCheatService(this.env.DB);
    }
    return new AntiCheatService(createDurableObjectSqlDb(this.ctx.storage.sql));
  }

  private getBattlePassService(): BattlePassService {
    if (this.env.DB) {
      return new BattlePassService(this.env.DB);
    }
    return new BattlePassService(createDurableObjectSqlDb(this.ctx.storage.sql));
  }

  private getClubService(): ClubService {
    if (this.env.DB) {
      return new ClubService(this.env.DB);
    }
    return new ClubService(createDurableObjectSqlDb(this.ctx.storage.sql));
  }

  private getClubLeagueService(): ClubLeagueService {
    const db = (this.env.DB ?? createDurableObjectSqlDb(this.ctx.storage.sql)) as unknown as ProgressionSqlDb;
    return new ClubLeagueService(db);
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

  public async progressionGetProfile(
    playerId: string,
    viewerId?: string | null,
    viewerToken?: string | null,
  ) {
    this.ensureSchema();
    let authenticatedViewer: string | null = null;
    if (viewerId && viewerToken) {
      const ok = await this.getProgressionService().verifyPlayerToken(viewerId, viewerToken);
      if (ok) authenticatedViewer = viewerId.trim();
    }
    return this.getProgressionService().getPublicProfile(playerId, authenticatedViewer);
  }

  public async progressionSearch(query: string, limit = 15) {
    this.ensureSchema();
    return this.getProgressionService().searchPlayers(query, limit);
  }

  public async progressionLeaderboard(params: {
    scope: LeaderboardScope;
    seasonId?: string | null;
    page?: number;
    limit?: number;
    query?: string;
    currentPlayerId?: string | null;
  }) {
    this.ensureSchema();
    return this.getProgressionService().getLeaderboard(params);
  }

  public async progressionHistory(params: {
    playerId?: string | null;
    matchType?: OnlineMatchType | 'all' | null;
    seasonId?: string | null;
    limit?: number;
  }) {
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

  // ===== Phase 10 Ranked Seasons & Anti-Cheat / Moderation RPC Methods =====

  public async rankedGetSeasons() {
    this.ensureSchema();
    return this.getRankedSeasonService().listSeasons();
  }

  public async rankedGetStanding(playerId: string, seasonId?: string | null) {
    this.ensureSchema();
    return this.getRankedSeasonService().getPlayerSeasonStanding(playerId, seasonId);
  }

  public async rankedRolloverSeason(options?: {
    nowMs?: number;
    newSeasonName?: string;
    newDurationDays?: number;
    softResetAnchor?: number;
    softResetFactor?: number;
  }) {
    this.ensureSchema();
    return this.getRankedSeasonService().rolloverSeason(options);
  }

  public async inspectCompletedMatch(input: AntiCheatMatchInspectionInput) {
    this.ensureSchema();
    return this.getAntiCheatService().inspectCompletedMatch(input);
  }

  public async moderationGetStatus(playerId: string, playerToken: string) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const status = await this.getAntiCheatService().getPlayerModerationStatus(auth.playerId);
    return { ok: true as const, moderation: status };
  }

  public async moderationSubmitAppeal(
    playerId: string,
    playerToken: string,
    penaltyId: string,
    message: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.getAntiCheatService().submitAppeal({
      playerId: auth.playerId,
      penaltyId,
      message,
    });
  }

  public async moderationAdminQueue(limit = 50) {
    this.ensureSchema();
    return this.getAntiCheatService().getAdminModerationQueue(limit);
  }

  public async moderationIssuePenalty(params: {
    playerId: string;
    penaltyType: PenaltyType;
    reason: string;
    issuedBy: string;
    isAdmin: boolean;
    durationMs?: number | null;
  }) {
    this.ensureSchema();
    return this.getAntiCheatService().issuePenalty(params);
  }

  public async moderationRevokePenalty(params: {
    penaltyId: string;
    adminActor: string;
    notes?: string;
  }) {
    this.ensureSchema();
    return this.getAntiCheatService().revokePenalty(params);
  }

  public async moderationReviewAppeal(params: {
    appealId: string;
    adminActor: string;
    decision: 'approved' | 'rejected';
    adminNotes?: string;
  }) {
    this.ensureSchema();
    return this.getAntiCheatService().reviewAppeal(params);
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
    const overview = await this.buildSocialOverview(auth.playerId);
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
    const items = await this.getSocialService().searchPlayersForSocial(
      authenticatedViewer,
      query,
      limit,
    );
    try {
      const badges = await this.getClubService().getClubBadgesForPlayers(
        items.map((p) => p.playerId),
      );
      return items.map((p) => ({
        ...p,
        club: badges.get(p.playerId) ?? null,
      }));
    } catch {
      return items;
    }
  }

  public async socialGetFriendsPaginated(
    playerId: string,
    playerToken: string,
    opts?: { limit?: number; offset?: number; query?: string },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const overview = await this.buildSocialOverview(auth.playerId);
    const cleaned = (opts?.query ?? '').trim().toLowerCase();
    const filtered = cleaned
      ? overview.friends.filter(
          (f) =>
            f.displayName.toLowerCase().includes(cleaned) ||
            (f.username && f.username.toLowerCase().includes(cleaned)) ||
            f.playerId.toLowerCase().includes(cleaned),
        )
      : overview.friends;
    const total = filtered.length;
    const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
    const limit = Math.max(1, Math.min(100, Math.floor(opts?.limit ?? 25)));
    const items = filtered.slice(offset, offset + limit);
    return {
      ok: true as const,
      friends: items,
      total,
      hasMore: offset + items.length < total,
    };
  }

  public async socialGetPrivacy(playerId: string, playerToken: string) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const privacy = await this.getSocialService().getPrivacySettings(auth.playerId);
    return { ok: true as const, privacy };
  }

  public async socialUpdatePrivacy(
    playerId: string,
    playerToken: string,
    updates: Partial<PrivacySettings>,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const privacy = await this.handleUpdatePrivacySettings(auth.playerId, updates);
    return { ok: true as const, privacy };
  }

  public async socialGetNotifications(
    playerId: string,
    playerToken: string,
    opts?: { limit?: number; unreadOnly?: boolean },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getSocialService().getNotifications(auth.playerId, opts);
    return { ok: true as const, ...res };
  }

  public async socialMarkNotificationRead(
    playerId: string,
    playerToken: string,
    notificationId?: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getSocialService().markNotificationRead(auth.playerId, notificationId);
    this.sendToPlayer(auth.playerId, {
      type: 'notifications:updated',
      notifications: res.notifications,
      unreadCount: res.unreadCount,
    });
    return { ok: true as const, ...res };
  }

  public async socialClearNotifications(
    playerId: string,
    playerToken: string,
    notificationId?: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getSocialService().clearNotifications(auth.playerId, notificationId);
    this.sendToPlayer(auth.playerId, {
      type: 'notifications:updated',
      notifications: res.notifications,
      unreadCount: res.unreadCount,
    });
    return { ok: true as const, ...res };
  }

  public async socialJoinFriendRoom(
    playerId: string,
    playerToken: string,
    friendPlayerId: string,
    sessionId?: string | null,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.handleJoinFriendRoom(auth.playerId, sessionId ?? null, friendPlayerId);
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
      inviteKind?: MatchInviteKind;
      roomId?: string;
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
      inviteKind: input.inviteKind === 'spectate' ? 'spectate' : 'match',
      roomId: input.roomId,
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
      const overview = await this.buildSocialOverview(auth.playerId);
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

  // ===== Phase 15 Clubs, Club Competitions & Leaderboards RPC Methods =====

  public async clubList(opts?: { query?: string; limit?: number }): Promise<ClubRecord[]> {
    this.ensureSchema();
    return this.getClubService().listClubs(opts);
  }

  public async clubGetDetail(
    clubId: string,
    viewerId?: string | null,
    viewerToken?: string | null,
  ): Promise<ClubDetailPayload | null> {
    this.ensureSchema();
    let authViewer: string | null = null;
    if (viewerId && viewerToken) {
      const ok = await this.getProgressionService().verifyPlayerToken(viewerId, viewerToken);
      if (ok) authViewer = viewerId.trim();
    }
    return this.getClubService().getClubDetail(clubId, authViewer);
  }

  public async clubCreate(
    playerId: string,
    playerToken: string,
    input: {
      name: unknown;
      tag: unknown;
      description?: unknown;
      emblemColor?: unknown;
      emblemIcon?: unknown;
      joinMode?: unknown;
      region?: unknown;
      maxMembers?: unknown;
    },
  ): Promise<{ ok: true; detail: ClubDetailPayload } | ClubServiceError> {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubService().createClub(auth.playerId, input);
    if (!res.ok) return res;
    await this.broadcastClubUpdated([auth.playerId], res.detail.club.clubId);
    return res;
  }

  public async clubUpdate(
    playerId: string,
    playerToken: string,
    clubId: string,
    input: {
      description?: unknown;
      emblemColor?: unknown;
      emblemIcon?: unknown;
      joinMode?: unknown;
      region?: unknown;
      maxMembers?: unknown;
      announcement?: unknown;
    },
  ): Promise<{ ok: true; detail: ClubDetailPayload } | ClubServiceError> {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubService().updateClub(auth.playerId, clubId, input);
    if (!res.ok) return res;
    const memberIds = await this.getClubService().getClubMemberPlayerIds(clubId);
    await this.broadcastClubUpdated(memberIds, clubId);
    return res;
  }

  public async clubJoinOrRequest(
    playerId: string,
    playerToken: string,
    clubId: string,
    message?: unknown,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.joinOrRequestClub(auth.playerId, clubId, message);
    if (!res.ok) return res;

    if (res.outcome === 'requested') {
      const [officers, applicantProfile, detail] = await Promise.all([
        clubSvc.getOfficerPlayerIds(clubId),
        this.getProgressionService().getPublicProfile(auth.playerId),
        clubSvc.getClubDetail(clubId, auth.playerId),
      ]);
      const clubName = detail?.club.name ?? 'your club';
      const actorName = applicantProfile?.displayName ?? 'A player';
      for (const oid of officers) {
        await this.emitNotification({
          recipientId: oid,
          type: 'club_join_request',
          title: 'Club Join Request',
          body: `${actorName} requested to join ${clubName}.`,
          actorId: auth.playerId,
          actorName,
          referenceId: clubId,
          dedupeKey: `club_req:${clubId}:${auth.playerId}`,
        });
      }
      await this.broadcastClubUpdated(officers, clubId);
    } else {
      const memberIds = await clubSvc.getClubMemberPlayerIds(clubId);
      await this.broadcastClubUpdated(memberIds, clubId);
    }
    return res;
  }

  public async clubRespondJoinRequest(
    playerId: string,
    playerToken: string,
    clubId: string,
    requestId: string,
    action: 'accept' | 'reject',
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.respondJoinRequest(auth.playerId, clubId, requestId, action);
    if (!res.ok) return res;

    const memberIds = await clubSvc.getClubMemberPlayerIds(clubId);
    await this.broadcastClubUpdated([...memberIds, res.targetPlayerId], clubId);
    if (res.targetPlayerId) {
      const detail = await clubSvc.getClubDetail(clubId, auth.playerId);
      const clubLabel = detail ? `[${detail.club.tag}] ${detail.club.name}` : 'Club';
      await this.emitNotification({
        recipientId: res.targetPlayerId,
        type: 'club_join_request',
        title: action === 'accept' ? 'Club Application Accepted' : 'Club Application Declined',
        body:
          action === 'accept'
            ? `Your request to join ${clubLabel} was accepted.`
            : `Your request to join ${clubLabel} was declined.`,
        actorId: auth.playerId,
        referenceId: clubId,
        dedupeKey: `club_req_res:${clubId}:${res.targetPlayerId}`,
      });
    }
    return res;
  }

  public async clubInvitePlayer(
    playerId: string,
    playerToken: string,
    clubId: string,
    targetPlayerId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.invitePlayerToClub(auth.playerId, clubId, targetPlayerId);
    if (!res.ok) return res;

    await this.emitNotification({
      recipientId: res.invitation.recipientId,
      type: 'club_invite',
      title: 'Club Invitation',
      body: `${res.invitation.inviterName} invited you to join [${res.invitation.clubTag}] ${res.invitation.clubName}.`,
      actorId: auth.playerId,
      actorName: res.invitation.inviterName,
      referenceId: res.invitation.inviteId,
      dedupeKey: `club_inv:${clubId}:${res.invitation.recipientId}`,
    });
    const memberIds = await clubSvc.getClubMemberPlayerIds(clubId);
    await this.broadcastClubUpdated([...memberIds, res.invitation.recipientId], clubId);
    return res;
  }

  public async clubRespondInvite(
    playerId: string,
    playerToken: string,
    inviteId: string,
    action: 'accept' | 'reject',
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.respondClubInvite(auth.playerId, inviteId, action);
    if (!res.ok) return res;

    const memberIds = await clubSvc.getClubMemberPlayerIds(res.clubId);
    await this.broadcastClubUpdated([...memberIds, auth.playerId], res.clubId);
    return res;
  }

  public async clubLeave(playerId: string, playerToken: string, clubId: string) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.leaveClub(auth.playerId, clubId);
    if (!res.ok) return res;

    const remainingMembers = res.disbanded ? [] : await clubSvc.getClubMemberPlayerIds(clubId);
    await this.broadcastClubUpdated([...remainingMembers, auth.playerId], clubId);
    return res;
  }

  public async clubUpdateMemberRole(
    playerId: string,
    playerToken: string,
    clubId: string,
    targetPlayerId: string,
    role: ClubRole,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.updateMemberRole(auth.playerId, clubId, targetPlayerId, role);
    if (!res.ok) return res;

    const memberIds = await clubSvc.getClubMemberPlayerIds(clubId);
    await this.broadcastClubUpdated(memberIds, clubId);
    return res;
  }

  public async clubKickMember(
    playerId: string,
    playerToken: string,
    clubId: string,
    targetPlayerId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.kickMember(auth.playerId, clubId, targetPlayerId);
    if (!res.ok) return res;

    const memberIds = await clubSvc.getClubMemberPlayerIds(clubId);
    await this.broadcastClubUpdated([...memberIds, targetPlayerId], clubId);
    return res;
  }

  public async clubLeaderboard(opts?: {
    scope?: ClubLeaderboardScope;
    limit?: number;
    page?: number;
    query?: string;
  }): Promise<ClubLeaderboardEntry[]> {
    this.ensureSchema();
    const board = await this.getClubService().getClubLeaderboard({
      scope: opts?.scope ?? 'global',
      limit: opts?.limit,
      page: opts?.page,
      query: opts?.query,
    });
    return board.items;
  }

  public async clubCreateChallenge(
    playerId: string,
    playerToken: string,
    input: {
      challengerClubId: string;
      targetClubId: string;
      ruleProfileId?: RuleProfileId;
      calledShotsEnabled?: boolean;
      targetWins?: number;
      notes?: string;
    },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.createChallenge(auth.playerId, input.challengerClubId, input);
    if (!res.ok) return res;

    await this.broadcastClubChallengeUpdate(res.challenge, {
      notifyRecipients: await clubSvc.getOfficerPlayerIds(res.challenge.targetClubId),
      notifyTitle: 'New Club Challenge',
      notifyBody: `[${res.challenge.challengerClubTag}] ${res.challenge.challengerClubName} challenged your club (First to ${res.challenge.targetWins} wins).`,
      actorId: auth.playerId,
    });
    return res;
  }

  public async clubRespondChallenge(
    playerId: string,
    playerToken: string,
    challengeId: string,
    action: 'accept' | 'decline' | 'cancel',
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.respondChallenge(auth.playerId, challengeId, action);
    if (!res.ok) return res;

    const notifyIds =
      action === 'cancel'
        ? await clubSvc.getOfficerPlayerIds(res.challenge.targetClubId)
        : await clubSvc.getOfficerPlayerIds(res.challenge.challengerClubId);
    await this.broadcastClubChallengeUpdate(res.challenge, {
      notifyRecipients: notifyIds,
      notifyTitle:
        action === 'accept'
          ? 'Club Challenge Accepted'
          : action === 'decline'
            ? 'Club Challenge Declined'
            : 'Club Challenge Cancelled',
      notifyBody:
        action === 'accept'
          ? `[${res.challenge.targetClubTag}] accepted your club challenge! Verified matches between members now count toward the score.`
          : `[${res.challenge.targetClubTag}] challenge status updated (${action}).`,
      actorId: auth.playerId,
    });
    return res;
  }

  public async clubGetChatMessages(
    clubId: string,
    limit = 50,
  ): Promise<ClubChatMessageRecord[]> {
    this.ensureSchema();
    return this.getClubService().getClubChatMessages(clubId, limit);
  }

  public async clubSendChatMessage(
    playerId: string,
    playerToken: string,
    clubId: string,
    body: unknown,
  ): Promise<{ ok: true; message: ClubChatMessageRecord } | ClubServiceError> {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.sendClubChatMessage(auth.playerId, clubId, body);
    if (!res.ok) return res;

    const memberIds = await clubSvc.getClubMemberPlayerIds(clubId);
    for (const pid of memberIds) {
      this.sendToPlayer(pid, {
        type: 'club:chat_message',
        clubId,
        message: res.message,
      });
    }
    return res;
  }

  public async clubUpdateAnnouncement(
    playerId: string,
    playerToken: string,
    clubId: string,
    announcement: unknown,
  ): Promise<{ ok: true; detail: ClubDetailPayload } | ClubServiceError> {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const clubSvc = this.getClubService();
    const res = await clubSvc.updateClub(auth.playerId, clubId, { announcement });
    if (!res.ok) return res;
    const memberIds = await clubSvc.getClubMemberPlayerIds(clubId);
    await this.broadcastClubUpdated(memberIds, clubId);
    return res;
  }

  public async clubGetTrophies(clubId: string, limit = 30): Promise<ClubTrophyRecord[]> {
    this.ensureSchema();
    return this.getClubService().getClubTrophies(clubId, limit);
  }

  // ===== Phase 16 Club Teams, Team Leagues & Club Championships RPC Methods =====

  public async teamListByClub(clubId: string) {
    this.ensureSchema();
    return this.getClubLeagueService().listClubTeams(clubId);
  }

  public async teamGetDetail(teamId: string) {
    this.ensureSchema();
    return this.getClubLeagueService().getTeamById(teamId);
  }

  public async teamCreate(
    playerId: string,
    playerToken: string,
    clubId: string,
    input: {
      name: unknown;
      tag: unknown;
      badgeColor?: unknown;
      badgeIcon?: unknown;
      region?: unknown;
      minRosterSize?: unknown;
      maxRosterSize?: unknown;
      captainId?: unknown;
      memberIds?: unknown;
    },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().createTeam(auth.playerId, clubId, input);
    if (!res.ok) return res;
    const memberIds = await this.getClubService().getClubMemberPlayerIds(clubId);
    await this.broadcastClubUpdated(memberIds, clubId);
    return res;
  }

  public async teamAddMember(
    playerId: string,
    playerToken: string,
    teamId: string,
    targetPlayerId: string,
    role?: unknown,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().addTeamMember(
      auth.playerId,
      teamId,
      targetPlayerId,
      role,
    );
    if (!res.ok) return res;
    const memberIds = await this.getClubService().getClubMemberPlayerIds(res.team.clubId);
    await this.broadcastClubUpdated(memberIds, res.team.clubId);
    return res;
  }

  public async teamRemoveMember(
    playerId: string,
    playerToken: string,
    teamId: string,
    targetPlayerId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().removeTeamMember(
      auth.playerId,
      teamId,
      targetPlayerId,
    );
    if (!res.ok) return res;
    const memberIds = await this.getClubService().getClubMemberPlayerIds(res.team.clubId);
    await this.broadcastClubUpdated(memberIds, res.team.clubId);
    return res;
  }

  public async teamSetMemberRole(
    playerId: string,
    playerToken: string,
    teamId: string,
    targetPlayerId: string,
    role: unknown,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().setTeamMemberRole(
      auth.playerId,
      teamId,
      targetPlayerId,
      role,
    );
    if (!res.ok) return res;
    const memberIds = await this.getClubService().getClubMemberPlayerIds(res.team.clubId);
    await this.broadcastClubUpdated(memberIds, res.team.clubId);
    return res;
  }

  public async leagueList(opts?: {
    scope?: string | null;
    region?: string | null;
    status?: string | null;
  }) {
    this.ensureSchema();
    return this.getClubLeagueService().listLeagues(opts);
  }

  public async leagueGetDetail(leagueId: string, viewerId?: string | null) {
    this.ensureSchema();
    return this.getClubLeagueService().getLeagueDetail(leagueId, viewerId ?? undefined);
  }

  public async leagueCreate(
    playerId: string,
    playerToken: string,
    input: {
      title: unknown;
      description?: unknown;
      scope?: unknown;
      region?: unknown;
      cadence?: unknown;
      divisionTier?: unknown;
      seasonLabel?: unknown;
      matchFormat?: unknown;
      ruleProfileId?: unknown;
      calledShotsEnabled?: unknown;
      doubleRoundRobin?: unknown;
      maxTeams?: unknown;
      promotionSlots?: unknown;
      relegationSlots?: unknown;
      matchDurationMinutes?: unknown;
    },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().createLeague(auth.playerId, input);
    if (!res.ok) return res;
    this.broadcastClubLeagueUpdate('league', res.detail.league.leagueId);
    return res;
  }

  public async leagueRegisterTeam(
    playerId: string,
    playerToken: string,
    leagueId: string,
    teamId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().registerTeamForLeague(
      auth.playerId,
      leagueId,
      teamId,
    );
    if (!res.ok) return res;
    this.broadcastClubLeagueUpdate('league', leagueId);
    return res;
  }

  public async leagueWithdrawTeam(
    playerId: string,
    playerToken: string,
    leagueId: string,
    teamId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().withdrawTeamFromLeague(
      auth.playerId,
      leagueId,
      teamId,
    );
    if (!res.ok) return res;
    this.broadcastClubLeagueUpdate('league', leagueId);
    return res;
  }

  public async leagueStart(playerId: string, playerToken: string, leagueId: string) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().startLeague(auth.playerId, leagueId);
    if (!res.ok) return res;
    this.broadcastClubLeagueUpdate('league', leagueId);
    await this.scheduleNextAlarm();
    return res;
  }

  public async championshipList(opts?: {
    format?: string | null;
    region?: string | null;
    status?: string | null;
  }) {
    this.ensureSchema();
    return this.getClubLeagueService().listChampionships(opts);
  }

  public async championshipGetDetail(championshipId: string, viewerId?: string | null) {
    this.ensureSchema();
    return this.getClubLeagueService().getChampionshipDetail(
      championshipId,
      viewerId ?? undefined,
    );
  }

  public async championshipCreate(
    playerId: string,
    playerToken: string,
    input: {
      title: unknown;
      description?: unknown;
      format?: unknown;
      region?: unknown;
      seasonLabel?: unknown;
      matchFormat?: unknown;
      ruleProfileId?: unknown;
      calledShotsEnabled?: unknown;
      maxTeams?: unknown;
      swissRounds?: unknown;
      groupSize?: unknown;
      groupAdvanceCount?: unknown;
      prizeCoinsChampion?: unknown;
    },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().createChampionship(auth.playerId, input);
    if (!res.ok) return res;
    this.broadcastClubLeagueUpdate('club_championship', res.detail.championship.championshipId);
    return res;
  }

  public async championshipRegisterTeam(
    playerId: string,
    playerToken: string,
    championshipId: string,
    teamId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().registerTeamForChampionship(
      auth.playerId,
      championshipId,
      teamId,
    );
    if (!res.ok) return res;
    this.broadcastClubLeagueUpdate('club_championship', championshipId);
    return res;
  }

  public async championshipWithdrawTeam(
    playerId: string,
    playerToken: string,
    championshipId: string,
    teamId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().withdrawTeamFromChampionship(
      auth.playerId,
      championshipId,
      teamId,
    );
    if (!res.ok) return res;
    this.broadcastClubLeagueUpdate('club_championship', championshipId);
    return res;
  }

  public async championshipStart(
    playerId: string,
    playerToken: string,
    championshipId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().startChampionship(auth.playerId, championshipId);
    if (!res.ok) return res;
    this.broadcastClubLeagueUpdate('club_championship', championshipId);
    await this.scheduleNextAlarm();
    return res;
  }

  public async championshipResolveEncounter(
    playerId: string,
    playerToken: string,
    competitionKind: 'league' | 'club_championship',
    competitionId: string,
    encounterId: string,
    input: {
      winnerTeamId: string;
      resolution: 'walkover' | 'disqualified';
      reason?: string;
    },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().resolveEncounterWalkoverOrDq(auth.playerId, {
      competitionKind,
      competitionId,
      encounterId,
      winnerTeamId: input.winnerTeamId,
      resolution: input.resolution,
      reason: input.reason,
    });
    if (!res.ok) return res;
    for (const rid of res.roomsToClose) {
      await this.closeRoomFromTournament(rid, 'Encounter resolved by competition organizer.');
    }
    this.broadcastClubLeagueUpdate(competitionKind, competitionId);
    await this.scheduleNextAlarm();
    return res;
  }

  public async encounterSubmitLineup(
    playerId: string,
    playerToken: string,
    input: {
      competitionKind: 'league' | 'club_championship';
      competitionId: string;
      encounterId: string;
      teamId: string;
      playerIds: string[];
    },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().submitEncounterLineup(auth.playerId, input);
    if (!res.ok) return res;

    const competitionTitle =
      input.competitionKind === 'league'
        ? ((await this.getClubLeagueService().getLeagueDetail(input.competitionId))?.league.title ?? 'Team League')
        : ((await this.getClubLeagueService().getChampionshipDetail(input.competitionId))?.championship.title ??
            'Club Championship');

    for (const sm of res.subMatches) {
      if (sm.status === 'ready' && sm.homePlayerId && sm.awayPlayerId) {
        const msg: ServerToClientMessage = {
          type: 'club:team_match_ready',
          competitionKind: input.competitionKind,
          competitionId: input.competitionId,
          competitionTitle,
          encounterId: input.encounterId,
          subMatch: sm,
        };
        this.sendToPlayer(sm.homePlayerId, msg);
        this.sendToPlayer(sm.awayPlayerId, msg);
      }
    }
    this.broadcastClubLeagueUpdate(input.competitionKind, input.competitionId);
    return res;
  }

  public async encounterSubstituteSlot(
    playerId: string,
    playerToken: string,
    input: {
      subMatchId: string;
      teamId: string;
      newPlayerId: string;
    },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getClubLeagueService().substituteLineupSlot(auth.playerId, input);
    if (!res.ok) return res;

    if (res.closedRoomId) {
      await this.closeRoomFromTournament(
        res.closedRoomId,
        'Team captain updated the lineup before match start.',
      );
    }
    if (res.subMatch.homePlayerId && res.subMatch.awayPlayerId) {
      const competitionTitle =
        res.subMatch.competitionKind === 'league'
          ? ((await this.getClubLeagueService().getLeagueDetail(res.subMatch.competitionId))?.league.title ??
              'Team League')
          : ((await this.getClubLeagueService().getChampionshipDetail(res.subMatch.competitionId))?.championship
              .title ?? 'Club Championship');
      const msg: ServerToClientMessage = {
        type: 'club:team_match_ready',
        competitionKind: res.subMatch.competitionKind,
        competitionId: res.subMatch.competitionId,
        competitionTitle,
        encounterId: res.subMatch.encounterId,
        subMatch: res.subMatch,
      };
      this.sendToPlayer(res.subMatch.homePlayerId, msg);
      this.sendToPlayer(res.subMatch.awayPlayerId, msg);
    }
    this.broadcastClubLeagueUpdate(res.subMatch.competitionKind, res.subMatch.competitionId);
    return res;
  }

  public async subMatchJoin(
    playerId: string,
    playerToken: string,
    subMatchId: string,
    sessionId?: string | null,
  ): Promise<
    | {
        ok: true;
        subMatch: TeamSubMatchRecord;
        room: OnlineRoomInfo;
        roomSession: { sessionId: string; reconnectToken: string };
      }
    | ClubLeagueServiceError
  > {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;

    const svc = this.getClubLeagueService();
    const prepInfo = await svc.prepareSubMatchForRoom(auth.playerId, subMatchId);
    if (!prepInfo.ok) return prepInfo;
    const sm = prepInfo.subMatch;
    if (!sm.homePlayerId || !sm.awayPlayerId) {
      return {
        ok: false,
        status: 409,
        code: 'MATCH_NOT_READY',
        message: 'Both teams must nominate lineups before entering the match room.',
      };
    }

    let sess =
      (sessionId ? this.getSession(sessionId) : null) ??
      this.findLatestConnectedSessionByPlayerId(auth.playerId) ??
      this.findLatestSessionByPlayerId(auth.playerId);

    if (!sess) {
      const prof = await this.getProgressionService().getPublicProfile(auth.playerId);
      sess = this.createSession(
        prof?.displayName ?? 'Player',
        sanitizeAvatarId(prof?.avatarId),
        35,
        auth.playerId,
      );
    }

    if (sess.in_matchmaking === 1) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_IN_MATCH',
        message: 'Leave matchmaking before entering a club team board.',
      };
    }

    if (sess.active_room_id && sess.active_room_id !== sm.roomId) {
      const activeRoomRows = this.ctx.storage.sql
        .exec<{ status: string }>(
          'SELECT status FROM rooms WHERE room_id = ? LIMIT 1',
          sess.active_room_id,
        )
        .toArray();
      if (activeRoomRows[0]?.status === 'playing') {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_IN_MATCH',
          message: 'Finish your active match before entering a team board.',
        };
      }
      this.ctx.storage.sql.exec(
        'UPDATE sessions SET active_room_id = NULL WHERE session_id = ?',
        sess.session_id,
      );
      sess.active_room_id = null;
    }

    // Provision room if missing
    let roomInfo: OnlineRoomInfo | null = null;
    if (sm.roomId) {
      const existingStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(sm.roomId));
      const resume = await existingStub.getResumeData();
      if (resume) {
        roomInfo = resume.room;
      }
    }

    if (!roomInfo) {
      const p1Id = sm.homePlayerId;
      const p2Id = sm.awayPlayerId;
      const now = Date.now();
      const newRoomId = `room_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const newRoomCode = this.generateUniqueCode();
      const expiresAtMs = now + this.config.roomTtlMs + 180_000;

      const p1Sess = this.findLatestSessionByPlayerId(p1Id);
      const p2Sess = this.findLatestSessionByPlayerId(p2Id);
      const [p1Cosmetics, p2Cosmetics, p1Profile, p2Profile] = await Promise.all([
        this.getEconomyService().getEquippedCosmetics(p1Id),
        this.getEconomyService().getEquippedCosmetics(p2Id),
        this.getProgressionService().getPublicProfile(p1Id),
        this.getProgressionService().getPublicProfile(p2Id),
      ]);

      const p1SessId =
        p1Sess?.session_id ?? `ply_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const p2SessId =
        p2Sess?.session_id ?? `ply_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const p1Rec = p1Sess?.reconnect_token ?? randomHexToken(24);
      const p2Rec = p2Sess?.reconnect_token ?? randomHexToken(24);
      const p1Name = sm.homePlayerName ?? p1Profile?.displayName ?? 'Player 1';
      const p2Name = sm.awayPlayerName ?? p2Profile?.displayName ?? 'Player 2';
      const p1Avatar = sanitizeAvatarId(sm.homePlayerAvatar ?? p1Profile?.avatarId);
      const p2Avatar = sanitizeAvatarId(sm.awayPlayerAvatar ?? p2Profile?.avatarId);

      const clubLeagueCtx: OnlineRoomClubLeagueContext = {
        competitionKind: sm.competitionKind,
        competitionId: sm.competitionId,
        competitionTitle: prepInfo.competitionTitle,
        encounterId: sm.encounterId,
        subMatchId: sm.subMatchId,
        slotIndex: sm.slotIndex,
        boardLabel: sm.boardLabel,
        homeTeamId: prepInfo.homeTeam.teamId,
        homeTeamName: prepInfo.homeTeam.name,
        homeTeamTag: prepInfo.homeTeam.tag,
        awayTeamId: prepInfo.awayTeam.teamId,
        awayTeamName: prepInfo.awayTeam.name,
        awayTeamTag: prepInfo.awayTeam.tag,
      };

      const metaJson = JSON.stringify({
        players: [
          {
            playerId: p1Id,
            displayName: p1Name,
            avatarId: p1Avatar,
            role: 'player1',
            elo: p1Profile?.elo,
            rankTier: p1Profile?.rankTier,
          },
          {
            playerId: p2Id,
            displayName: p2Name,
            avatarId: p2Avatar,
            role: 'player2',
            elo: p2Profile?.elo,
            rankTier: p2Profile?.rankTier,
          },
        ] satisfies SpectatableMatchPlayer[],
        tournament: null,
        clubLeague: clubLeagueCtx,
      });

      this.ctx.storage.sql.exec(
        `INSERT INTO rooms (
          room_id, room_code, host_session_id, is_private, match_type, rule_profile_id,
          called_shots_enabled, status, allow_spectators, allow_spectator_chat,
          spectator_count, max_spectators, meta_json, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, 0, 'tournament', ?, ?, 'waiting', 1, 1, 0, ?, ?, ?, ?)`,
        newRoomId,
        newRoomCode,
        p1SessId,
        prepInfo.ruleProfileId,
        prepInfo.calledShotsEnabled ? 1 : 0,
        this.config.maxSpectatorsPerRoom,
        metaJson,
        now,
        expiresAtMs,
      );

      const newStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(newRoomId));
      roomInfo = await newStub.initClubLeagueRoom({
        roomId: newRoomId,
        roomCode: newRoomCode,
        ruleProfileId: prepInfo.ruleProfileId,
        calledShotsEnabled: prepInfo.calledShotsEnabled,
        allowSpectators: true,
        clubLeague: clubLeagueCtx,
        createdAtMs: now,
        expiresAtMs,
        player1: {
          sessionId: p1SessId,
          playerId: p1Id,
          reconnectToken: p1Rec,
          displayName: p1Name,
          avatarId: p1Avatar,
          elo: p1Profile?.elo,
          rankTier: p1Profile?.rankTier,
          equippedCosmetics: p1Cosmetics,
          latencyMs: p1Sess?.latency_ms ?? 35,
        },
        player2: {
          sessionId: p2SessId,
          playerId: p2Id,
          reconnectToken: p2Rec,
          displayName: p2Name,
          avatarId: p2Avatar,
          elo: p2Profile?.elo,
          rankTier: p2Profile?.rankTier,
          equippedCosmetics: p2Cosmetics,
          latencyMs: p2Sess?.latency_ms ?? 35,
        },
      });

      await svc.attachRoomToSubMatch(subMatchId, newRoomId, newRoomCode);
      sm.roomId = newRoomId;
      sm.roomCode = newRoomCode;

      const opponentId = auth.playerId === p1Id ? p2Id : p1Id;
      await this.emitNotification({
        recipientId: opponentId,
        type:
          sm.competitionKind === 'league' ? 'team_league_event' : 'club_championship_event',
        title: `${prepInfo.competitionTitle} · ${sm.boardLabel}`,
        body: `[${prepInfo.homeTeam.tag}] vs [${prepInfo.awayTeam.tag}] board room ${newRoomCode} is ready.`,
        referenceId: sm.competitionId,
        dedupeKey: `tsm_ready:${sm.subMatchId}`,
      });
      this.sendToPlayer(opponentId, {
        type: 'club:team_match_ready',
        competitionKind: sm.competitionKind,
        competitionId: sm.competitionId,
        competitionTitle: prepInfo.competitionTitle,
        encounterId: sm.encounterId,
        subMatch: sm,
        room: roomInfo,
      });
    }

    const joinCosmetics = await this.getEconomyService().getEquippedCosmetics(auth.playerId);
    const joinProfile = await this.getProgressionService().getPublicProfile(auth.playerId);
    const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomInfo.roomId));
    const prepRes = await roomStub.prepareClubLeaguePlayerSession(auth.playerId, {
      sessionId: sess.session_id,
      playerId: auth.playerId,
      reconnectToken: sess.reconnect_token,
      displayName: sess.display_name,
      avatarId: sanitizeAvatarId(sess.avatar_id),
      elo: joinProfile?.elo,
      rankTier: joinProfile?.rankTier,
      equippedCosmetics: joinCosmetics,
      latencyMs: sess.latency_ms,
    });

    if (!prepRes.ok) {
      return {
        ok: false,
        status: 409,
        code: prepRes.code,
        message: prepRes.message,
      };
    }

    this.ctx.storage.sql.exec(
      'UPDATE sessions SET active_room_id = ?, in_matchmaking = 0 WHERE session_id = ?',
      roomInfo.roomId,
      sess.session_id,
    );
    this.broadcastClubLeagueUpdate(sm.competitionKind, sm.competitionId);
    await this.scheduleNextAlarm();

    return {
      ok: true,
      subMatch: sm,
      room: prepRes.room,
      roomSession: {
        sessionId: sess.session_id,
        reconnectToken: sess.reconnect_token,
      },
    };
  }

  public async onTeamSubMatchStarted(subMatchId: string): Promise<void> {
    this.ensureSchema();
    const res = await this.getClubLeagueService().markSubMatchInProgress(subMatchId);
    if (res) {
      this.broadcastClubLeagueUpdate(res.competitionKind, res.competitionId);
    }
  }

  public async onTeamSubMatchCompleted(input: {
    subMatchId: string;
    matchId: string;
    winnerPlayerId: string;
    reason: string;
    completedAtMs: number;
  }): Promise<void> {
    this.ensureSchema();
    const res = await this.getClubLeagueService().settleSubMatchResult({
      subMatchId: input.subMatchId,
      matchId: input.matchId,
      winnerPlayerId: input.winnerPlayerId,
      reason: input.reason,
      nowMs: input.completedAtMs,
    });
    if (!res.ok) return;

    for (const rid of res.roomsToClose) {
      await this.closeRoomFromTournament(rid, 'Team match series already clinched.');
    }
    this.broadcastClubLeagueUpdate(res.competitionKind, res.competitionId);
    await this.scheduleNextAlarm();
  }

  public async clubLeaguesRankings(opts?: { region?: string | null; limit?: number }) {
    this.ensureSchema();
    return this.getClubLeagueService().getTeamRankings(opts);
  }

  private async processClubLeagueTimersInternal(): Promise<void> {
    try {
      const res = await this.getClubLeagueService().processDueDeadlines(Date.now());
      for (const rid of res.roomsToClose) {
        await this.closeRoomFromTournament(rid, 'Team match deadline expired.');
      }
    } catch {
      // Non-blocking deadline processor
    }
  }

  private broadcastClubLeagueUpdate(
    competitionKind: 'league' | 'club_championship',
    competitionId: string,
  ): void {
    const encoded = JSON.stringify(
      competitionKind === 'league'
        ? ({ type: 'club:league_updated', leagueId: competitionId } satisfies ServerToClientMessage)
        : ({
            type: 'club:championship_updated',
            championshipId: competitionId,
          } satisfies ServerToClientMessage),
    );
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

  // ===== Phase 14 Spectator & Live Broadcast RPC Methods =====

  private parseRoomMetaJson(raw: unknown): {
    players: SpectatableMatchPlayer[];
    tournament: OnlineRoomTournamentContext | null;
    clubLeague: OnlineRoomClubLeagueContext | null;
  } {
    if (typeof raw !== 'string' || !raw) {
      return { players: [], tournament: null, clubLeague: null };
    }
    try {
      const parsed = JSON.parse(raw) as {
        players?: SpectatableMatchPlayer[];
        tournament?: OnlineRoomTournamentContext | null;
        clubLeague?: OnlineRoomClubLeagueContext | null;
      };
      return {
        players: Array.isArray(parsed.players) ? parsed.players : [],
        tournament: parsed.tournament ?? null,
        clubLeague: parsed.clubLeague ?? null,
      };
    } catch {
      return { players: [], tournament: null, clubLeague: null };
    }
  }

  public async listSpectatableMatches(filters?: {
    matchType?: OnlineMatchType | 'all' | null;
    status?: string | null;
    tournamentId?: string | null;
  }): Promise<SpectatableMatchSummary[]> {
    this.ensureSchema();
    await this.pruneExpiredWaitingRooms();
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM rooms
         WHERE is_private = 0
           AND allow_spectators = 1
           AND status IN ('waiting', 'ready', 'playing')
           AND (status = 'playing' OR expires_at_ms > ?)
         ORDER BY CASE WHEN status = 'playing' THEN 0 ELSE 1 END, spectator_count DESC, created_at_ms DESC
         LIMIT 50`,
        now,
      )
      .toArray();

    const wantType =
      filters?.matchType && filters.matchType !== 'all' ? filters.matchType : null;
    const wantStatus = filters?.status?.trim() || null;
    const wantTournament = filters?.tournamentId?.trim() || null;

    const results: SpectatableMatchSummary[] = [];
    for (const r of rows) {
      const matchType = (String(r.match_type ?? 'quick') as OnlineMatchType) || 'quick';
      const status = String(r.status) as OnlineRoomStatus;
      if (wantType && matchType !== wantType) continue;
      if (wantStatus && status !== wantStatus) continue;

      const meta = this.parseRoomMetaJson(r.meta_json);
      if (wantTournament && meta.tournament?.tournamentId !== wantTournament) continue;
      if (meta.players.length === 0) continue;

      results.push({
        roomId: String(r.room_id),
        roomCode: String(r.room_code),
        matchType,
        ruleProfileId: r.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
        calledShotsEnabled: Number(r.called_shots_enabled) === 1,
        status,
        isPrivate: Number(r.is_private) === 1,
        allowSpectators: Number(r.allow_spectators) === 1,
        allowSpectatorChat: Number(r.allow_spectator_chat ?? 1) === 1,
        spectatorCount: Number(r.spectator_count ?? 0),
        maxSpectators: Number(r.max_spectators ?? this.config.maxSpectatorsPerRoom),
        createdAtMs: Number(r.created_at_ms),
        startedAtMs: status === 'playing' ? Number(r.created_at_ms) : null,
        players: meta.players,
        tournament: meta.tournament,
        clubLeague: meta.clubLeague,
      });
    }
    return results;
  }

  private resolveRoomRecordForSpectate(query: {
    roomId?: string;
    roomCode?: string;
    targetPlayerId?: string;
  }): Record<string, SqlStorageValue> | null {
    const cleanRoomId = typeof query.roomId === 'string' ? query.roomId.trim() : '';
    const cleanCode = typeof query.roomCode === 'string' ? query.roomCode.trim().toUpperCase() : '';
    const cleanTargetPlayer =
      typeof query.targetPlayerId === 'string' ? query.targetPlayerId.trim() : '';

    if (cleanRoomId) {
      const rows = this.ctx.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          'SELECT * FROM rooms WHERE room_id = ? LIMIT 1',
          cleanRoomId,
        )
        .toArray();
      return rows[0] ?? null;
    }

    if (cleanCode) {
      const rows = this.ctx.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          'SELECT * FROM rooms WHERE room_code = ? LIMIT 1',
          cleanCode,
        )
        .toArray();
      return rows[0] ?? null;
    }

    if (cleanTargetPlayer) {
      const sess =
        this.findLatestConnectedSessionByPlayerId(cleanTargetPlayer) ??
        this.findLatestSessionByPlayerId(cleanTargetPlayer);
      if (sess?.active_room_id) {
        const rows = this.ctx.storage.sql
          .exec<Record<string, SqlStorageValue>>(
            'SELECT * FROM rooms WHERE room_id = ? LIMIT 1',
            sess.active_room_id,
          )
          .toArray();
        return rows[0] ?? null;
      }
    }

    return null;
  }

  public async resolveSpectateTarget(query: {
    roomId?: string;
    roomCode?: string;
    targetPlayerId?: string;
    shareToken?: string;
  }): Promise<
    | { ok: true; match: SpectatableMatchSummary }
    | { ok: false; status: number; code: MultiplayerErrorCode; message: string }
  > {
    this.ensureSchema();
    await this.pruneExpiredWaitingRooms();
    const row = this.resolveRoomRecordForSpectate(query);
    if (!row) {
      return {
        ok: false,
        status: 404,
        code: 'INVALID_ROOM',
        message: 'Live match room not found.',
      };
    }

    const roomId = String(row.room_id);
    const roomCode = String(row.room_code);
    const isPrivate = Number(row.is_private) === 1;
    const allowSpectators = Number(row.allow_spectators) === 1;
    if (!allowSpectators) {
      return {
        ok: false,
        status: 403,
        code: 'SPECTATE_UNAVAILABLE',
        message: 'Spectators are not enabled for this match.',
      };
    }

    if (isPrivate) {
      const codeMatch =
        typeof query.roomCode === 'string' &&
        query.roomCode.trim().toUpperCase() === roomCode.toUpperCase();
      const hasToken = typeof query.shareToken === 'string' && query.shareToken.trim().length > 0;
      if (!codeMatch && !hasToken) {
        return {
          ok: false,
          status: 403,
          code: 'SPECTATE_UNAVAILABLE',
          message: 'Private matches require a room code or host spectator link.',
        };
      }
      if (hasToken && !codeMatch) {
        const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomId));
        const resume = await roomStub.getResumeData();
        if (!resume || !resume.room.allowSpectators) {
          return {
            ok: false,
            status: 403,
            code: 'SPECTATE_UNAVAILABLE',
            message: 'Spectators are not enabled for this private match.',
          };
        }
      }
    }

    const meta = this.parseRoomMetaJson(row.meta_json);
    return {
      ok: true,
      match: {
        roomId,
        roomCode,
        matchType: (String(row.match_type ?? 'quick') as OnlineMatchType) || 'quick',
        ruleProfileId: row.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
        calledShotsEnabled: Number(row.called_shots_enabled) === 1,
        status: String(row.status) as OnlineRoomStatus,
        isPrivate,
        allowSpectators,
        allowSpectatorChat: Number(row.allow_spectator_chat ?? 1) === 1,
        spectatorCount: Number(row.spectator_count ?? 0),
        maxSpectators: Number(row.max_spectators ?? this.config.maxSpectatorsPerRoom),
        createdAtMs: Number(row.created_at_ms),
        startedAtMs: row.status === 'playing' ? Number(row.created_at_ms) : null,
        players: meta.players,
        tournament: meta.tournament,
        clubLeague: meta.clubLeague,
      },
    };
  }

  public async spectateJoin(input: {
    roomId?: string;
    roomCode?: string;
    targetPlayerId?: string;
    shareToken?: string;
    sessionId?: string;
    playerId?: string;
    playerToken?: string;
    displayName?: string;
    avatarId?: OnlineAvatarId;
    trustedWsSession?: boolean;
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
    | { ok: false; status: number; code: MultiplayerErrorCode; message: string }
  > {
    this.ensureSchema();
    await this.pruneExpiredWaitingRooms();

    const row = this.resolveRoomRecordForSpectate(input);
    if (!row) {
      return {
        ok: false,
        status: 404,
        code: 'INVALID_ROOM',
        message: 'Live match room not found or has ended.',
      };
    }

    const roomId = String(row.room_id);
    const status = String(row.status);
    if (status === 'expired' || status === 'cancelled') {
      return {
        ok: false,
        status: 410,
        code: 'ROOM_EXPIRED',
        message: 'Match room is no longer active.',
      };
    }

    let resolvedPlayerId: string | undefined;
    let resolvedName = sanitizeDisplayName(input.displayName || 'Spectator');
    let resolvedAvatar = sanitizeAvatarId(input.avatarId);

    if (input.trustedWsSession && input.playerId) {
      resolvedPlayerId = input.playerId;
    } else if (
      typeof input.playerId === 'string' &&
      input.playerId.trim().length > 0 &&
      typeof input.playerToken === 'string' &&
      input.playerToken.trim().length > 0
    ) {
      const auth = await this.authenticateRestPlayer(input.playerId, input.playerToken);
      if (!auth.ok) {
        return auth;
      }
      resolvedPlayerId = auth.playerId;
      const profile = await this.getProgressionService().getPublicProfile(auth.playerId);
      if (profile) {
        resolvedName = sanitizeDisplayName(input.displayName || profile.displayName);
        resolvedAvatar = sanitizeAvatarId(input.avatarId ?? profile.avatarId);
      }
    }

    if (resolvedPlayerId) {
      const activeSess =
        (input.sessionId ? this.getSession(input.sessionId) : null) ??
        this.findLatestConnectedSessionByPlayerId(resolvedPlayerId);
      if (activeSess && (activeSess.active_room_id || activeSess.in_matchmaking === 1)) {
        if (activeSess.active_room_id !== roomId) {
          return {
            ok: false,
            status: 409,
            code: 'ALREADY_IN_MATCH',
            message: 'Leave your current room or matchmaking queue before spectating.',
          };
        }
      }
    }

    const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomId));
    const joinRes = await roomStub.joinAsSpectator({
      sessionId: input.sessionId,
      playerId: resolvedPlayerId,
      displayName: resolvedName,
      avatarId: resolvedAvatar,
      roomCode: input.roomCode,
      shareToken: input.shareToken,
    });

    if (!joinRes.ok) {
      const httpStatus =
        joinRes.code === 'SPECTATE_UNAVAILABLE' || joinRes.code === 'BLOCKED_PLAYER'
          ? 403
          : joinRes.code === 'ROOM_FULL' || joinRes.code === 'ALREADY_IN_MATCH'
            ? 409
            : joinRes.code === 'ROOM_EXPIRED'
              ? 410
              : joinRes.code === 'INVALID_ROOM'
                ? 404
                : 400;
      return {
        ok: false,
        status: httpStatus,
        code: joinRes.code,
        message: joinRes.message,
      };
    }

    if (resolvedPlayerId) {
      const pres = await this.getSocialService().setPresence({
        playerId: resolvedPlayerId,
        status: 'spectating',
        activeRoomId: roomId,
        ttlMs: Math.max(this.config.presenceTtlMs, 120_000),
      });
      if (pres.changed) {
        await this.broadcastPresenceChanged(resolvedPlayerId, pres.status, pres.lastSeenAtMs);
      }
    }

    await this.scheduleNextAlarm();
    return joinRes;
  }

  public async spectateLeave(input: {
    roomId: string;
    sessionId?: string;
    playerId?: string;
    playerToken?: string;
  }): Promise<{ ok: true; removed: boolean } | SocialError> {
    this.ensureSchema();
    const cleanRoomId = typeof input.roomId === 'string' ? input.roomId.trim() : '';
    if (!cleanRoomId) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'roomId is required.',
      };
    }

    let lookupId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    if (
      typeof input.playerId === 'string' &&
      input.playerId.trim().length > 0 &&
      typeof input.playerToken === 'string' &&
      input.playerToken.trim().length > 0
    ) {
      const auth = await this.authenticateRestPlayer(input.playerId, input.playerToken);
      if (!auth.ok) return auth;
      if (!lookupId) lookupId = auth.playerId;
    }

    if (!lookupId) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'sessionId or authenticated player credentials required.',
      };
    }

    const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(cleanRoomId));
    return roomStub.leaveSpectatorBySession(lookupId);
  }

  // ===== Phase 8 Economy & Store RPC Methods =====

  public async economyGetOverview(playerId: string, playerToken: string) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const overview = await this.getEconomyService().getOverview(auth.playerId);
    return { ok: true as const, ...overview };
  }

  public async economyGetTransactions(
    playerId: string,
    playerToken: string,
    limit = 40,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const transactions = await this.getEconomyService().getTransactions(auth.playerId, limit);
    return { ok: true as const, transactions };
  }

  public async economyPurchaseItem(
    playerId: string,
    playerToken: string,
    itemId: unknown,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.getEconomyService().purchaseItem(auth.playerId, itemId);
  }

  public async economyEquipItem(
    playerId: string,
    playerToken: string,
    category: unknown,
    itemId: unknown,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getEconomyService().equipItem(auth.playerId, category, itemId);
    if (res.ok) {
      await this.syncPlayerCosmeticsInRoom(auth.playerId, res.equipped);
    }
    return res;
  }

  public async economyClaimDaily(playerId: string, playerToken: string) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.getEconomyService().claimDailyReward(auth.playerId);
  }

  public async economyClaimAiReward(
    playerId: string,
    playerToken: string,
    input: Partial<AiMatchRewardRequest>,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.getEconomyService().claimAiMatchReward(auth.playerId, input);
  }

  public async syncPlayerCosmeticsInRoom(
    playerId: string,
    equipped: EquippedCosmetics,
  ): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      'UPDATE sessions SET avatar_id = ? WHERE player_id = ?',
      sanitizeAvatarId(equipped.avatarId),
      playerId,
    );
    const sess =
      this.findLatestConnectedSessionByPlayerId(playerId) ??
      this.findLatestSessionByPlayerId(playerId);
    if (sess?.active_room_id) {
      try {
        const roomStub = this.env.POOL_ROOM.get(
          this.env.POOL_ROOM.idFromName(sess.active_room_id),
        );
        await roomStub.updatePlayerCosmetics(playerId, equipped);
      } catch {
        // Ignore if room already closed
      }
    }
  }

  // ===== Phase 11 Daily Missions, Weekly Challenges & Battle Pass RPC Methods =====

  public async battlePassGetOverview(playerId: string, playerToken: string) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const overview = await this.getBattlePassService().getOverview(auth.playerId);
    return { ok: true as const, overview };
  }

  public async battlePassClaimMission(
    playerId: string,
    playerToken: string,
    input: { missionId: string; cadence?: MissionCadence; periodKey?: string },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.getBattlePassService().claimMission(auth.playerId, input);
  }

  public async battlePassUnlockPremium(playerId: string, playerToken: string) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.getBattlePassService().unlockPremium(auth.playerId);
  }

  public async battlePassClaimTier(
    playerId: string,
    playerToken: string,
    input: { level: number; track: BattlePassTrack },
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.getBattlePassService().claimTierReward(auth.playerId, input);
  }

  public async battlePassClaimAll(playerId: string, playerToken: string) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.getBattlePassService().claimAllAvailable(auth.playerId);
  }

  public async battlePassRecordAiMatch(
    playerId: string,
    playerToken: string,
    input: Partial<AiMatchProgressRequest>,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.getBattlePassService().recordAiMatchProgress(auth.playerId, input);
  }

  public async battlePassAdminRollover(options?: {
    nowMs?: number;
    newSeasonName?: string;
    newSeasonTheme?: string;
    durationDays?: number;
    premiumPriceCoins?: number;
  }) {
    this.ensureSchema();
    return this.getBattlePassService().adminRolloverSeason(options);
  }

  // ===== Phase 9 Global Tournaments & Championships RPC Methods =====

  public async tournamentList(params?: {
    viewerId?: string | null;
    type?: string | null;
    status?: string | null;
    includePrivateForAdmin?: boolean;
  }) {
    this.ensureSchema();
    const svc = this.getTournamentService();
    await svc.processDueTimers();
    return svc.listTournaments(params);
  }

  public async tournamentDetail(
    tournamentId: string,
    opts?: { viewerId?: string | null; isAdmin?: boolean },
  ) {
    this.ensureSchema();
    const svc = this.getTournamentService();
    await svc.processDueTimers(Date.now(), tournamentId);
    return svc.getTournamentDetail(tournamentId, opts);
  }

  public async tournamentLeaderboard(params?: {
    seasonKey?: string | null;
    limit?: number;
  }) {
    this.ensureSchema();
    return this.getTournamentService().getTournamentLeaderboard(params);
  }

  public async tournamentPlayerStats(playerId: string) {
    this.ensureSchema();
    return this.getTournamentService().getPlayerTournamentStats(playerId);
  }

  public async tournamentCreatePrivate(
    playerId: string,
    playerToken: string,
    input: Partial<CreateTournamentInput>,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const profile = await this.getProgressionService().getPublicProfile(auth.playerId);
    const res = await this.getTournamentService().createTournament(
      { ...input, type: 'private', isPrivate: true },
      {
        actorPlayerId: auth.playerId,
        actorName: profile?.displayName ?? 'Host',
        isAdmin: false,
      },
    );
    if (!res.ok) return res;
    await this.scheduleNextAlarm();
    return res;
  }

  public async tournamentAdminCreate(input: Partial<CreateTournamentInput>) {
    this.ensureSchema();
    const res = await this.getTournamentService().createTournament(input, {
      actorPlayerId: null,
      actorName: 'Tournament Admin',
      isAdmin: true,
    });
    if (!res.ok) return res;
    await this.scheduleNextAlarm();
    return res;
  }

  public async tournamentRegister(
    playerId: string,
    playerToken: string,
    tournamentId: string,
    inviteCode?: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const svc = this.getTournamentService();
    const res = await svc.registerPlayer({
      tournamentId,
      playerId: auth.playerId,
      inviteCode,
    });
    if (!res.ok) return res;

    if (res.shouldAutoStart) {
      const started = await svc.startTournamentBracket(tournamentId, { isAdmin: true });
      if (started.ok) {
        const provisioned = await this.notifyReadyTournamentMatches(
          started.tournament,
          started.readyMatches,
        );
        await this.broadcastTournamentState(started.tournament.tournamentId, provisioned);
        await this.scheduleNextAlarm();
        return {
          ok: true as const,
          tournament: started.tournament,
          participant: res.participant,
          autoStarted: true,
        };
      }
    }

    await this.broadcastTournamentState(tournamentId);
    await this.scheduleNextAlarm();
    return {
      ok: true as const,
      tournament: res.tournament,
      participant: res.participant,
      autoStarted: false,
    };
  }

  public async tournamentJoinByCode(
    playerId: string,
    playerToken: string,
    inviteCode: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const svc = this.getTournamentService();
    const res = await svc.registerByInviteCode({
      inviteCode,
      playerId: auth.playerId,
    });
    if (!res.ok) return res;

    if (res.shouldAutoStart) {
      const started = await svc.startTournamentBracket(res.tournament.tournamentId, {
        isAdmin: true,
      });
      if (started.ok) {
        await this.notifyReadyTournamentMatches(started.tournament, started.readyMatches);
        await this.broadcastTournamentState(started.tournament.tournamentId);
        await this.scheduleNextAlarm();
        return {
          ok: true as const,
          tournament: started.tournament,
          participant: res.participant,
          autoStarted: true,
        };
      }
    }

    await this.broadcastTournamentState(res.tournament.tournamentId);
    await this.scheduleNextAlarm();
    return {
      ok: true as const,
      tournament: res.tournament,
      participant: res.participant,
      autoStarted: false,
    };
  }

  public async tournamentWithdraw(
    playerId: string,
    playerToken: string,
    tournamentId: string,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    const res = await this.getTournamentService().withdrawPlayer({
      tournamentId,
      playerId: auth.playerId,
    });
    if (!res.ok) return res;

    for (const roomId of res.roomIdsToClose) {
      await this.closeRoomFromTournament(roomId, 'Match forfeited due to player withdrawal.');
    }
    if (res.newlyReadyMatches.length > 0) {
      await this.notifyReadyTournamentMatches(res.tournament, res.newlyReadyMatches);
    }
    await this.broadcastTournamentState(tournamentId);
    await this.scheduleNextAlarm();
    return res;
  }

  public async tournamentStart(
    tournamentId: string,
    opts: { playerId?: string | null; playerToken?: string | null; isAdmin?: boolean },
  ) {
    this.ensureSchema();
    let actorId: string | null = null;
    if (!opts.isAdmin) {
      const auth = await this.authenticateRestPlayer(opts.playerId, opts.playerToken);
      if (!auth.ok) return auth;
      actorId = auth.playerId;
    }

    const res = await this.getTournamentService().startTournamentBracket(tournamentId, {
      actorPlayerId: actorId,
      isAdmin: Boolean(opts.isAdmin),
    });
    if (!res.ok) return res;

    if (!res.cancelledInsufficient) {
      await this.notifyReadyTournamentMatches(res.tournament, res.readyMatches);
    }
    await this.broadcastTournamentState(tournamentId);
    await this.scheduleNextAlarm();
    return res;
  }

  public async tournamentCancel(
    tournamentId: string,
    opts: {
      playerId?: string | null;
      playerToken?: string | null;
      isAdmin?: boolean;
      reason?: string;
    },
  ) {
    this.ensureSchema();
    let actorId: string | null = null;
    if (!opts.isAdmin) {
      const auth = await this.authenticateRestPlayer(opts.playerId, opts.playerToken);
      if (!auth.ok) return auth;
      actorId = auth.playerId;
    }

    const res = await this.getTournamentService().cancelTournament({
      tournamentId,
      actorPlayerId: actorId,
      isAdmin: Boolean(opts.isAdmin),
      reason: opts.reason,
    });
    if (!res.ok) return res;

    for (const roomId of res.roomIdsToClose) {
      await this.closeRoomFromTournament(roomId, 'Tournament cancelled.');
    }
    await this.broadcastTournamentState(tournamentId);
    await this.scheduleNextAlarm();
    return res;
  }

  public async tournamentJoinMatch(
    playerId: string,
    playerToken: string,
    tournamentId: string,
    bracketMatchId: string,
    sessionId?: string | null,
  ) {
    this.ensureSchema();
    const auth = await this.authenticateRestPlayer(playerId, playerToken);
    if (!auth.ok) return auth;
    return this.handleJoinTournamentMatch(
      auth.playerId,
      sessionId ?? null,
      tournamentId,
      bracketMatchId,
    );
  }

  public async tournamentAdminResolveMatch(
    tournamentId: string,
    bracketMatchId: string,
    input: {
      winnerId: string;
      resolutionType?: TournamentMatchResolutionType;
      reason?: string;
    },
  ) {
    this.ensureSchema();
    const res = await this.getTournamentService().completeBracketMatch({
      tournamentId,
      bracketMatchId,
      winnerId: input.winnerId,
      resolutionType: input.resolutionType ?? 'admin_resolved',
      reason: input.reason ?? 'Resolved by tournament administrator.',
      adminOverride: true,
    });
    if (!res.ok) return res;

    if (res.roomIdToClose) {
      await this.closeRoomFromTournament(res.roomIdToClose, 'Match resolved by tournament administrator.');
    }
    if (res.newlyReadyMatches.length > 0) {
      await this.notifyReadyTournamentMatches(res.tournament, res.newlyReadyMatches);
    }
    await this.broadcastTournamentState(tournamentId);
    await this.scheduleNextAlarm();
    return res;
  }

  public async tournamentProcessTimers(tournamentId?: string) {
    this.ensureSchema();
    return this.processTournamentTimersInternal(tournamentId);
  }

  public async onTournamentMatchStarted(
    tournamentId: string,
    bracketMatchId: string,
  ): Promise<void> {
    this.ensureSchema();
    await this.getTournamentService().markMatchInProgress(tournamentId, bracketMatchId);
    await this.broadcastTournamentState(tournamentId);
  }

  public async onTournamentMatchCompleted(input: {
    tournamentId: string;
    bracketMatchId: string;
    roomId: string;
    matchId: string;
    winnerPlayerId: string;
    resolutionType?: 'played' | 'forfeit';
    reason: string;
    completedAtMs: number;
  }): Promise<void> {
    this.ensureSchema();
    const res = await this.getTournamentService().completeBracketMatch({
      tournamentId: input.tournamentId,
      bracketMatchId: input.bracketMatchId,
      winnerId: input.winnerPlayerId,
      matchId: input.matchId,
      resolutionType: input.resolutionType ?? 'played',
      reason: input.reason,
      nowMs: input.completedAtMs,
    });
    if (!res.ok) return;

    if (res.newlyReadyMatches.length > 0) {
      await this.notifyReadyTournamentMatches(res.tournament, res.newlyReadyMatches);
    }
    await this.broadcastTournamentState(input.tournamentId);
    await this.scheduleNextAlarm();
  }

  private async handleJoinTournamentMatch(
    playerId: string,
    preferredSessionId: string | null,
    tournamentId: string,
    bracketMatchId: string,
  ): Promise<
    | {
        ok: true;
        tournament: TournamentRecord;
        match: TournamentMatch;
        room: OnlineRoomInfo;
        roomSession: { sessionId: string; reconnectToken: string };
      }
    | TournamentServiceError
  > {
    const svc = this.getTournamentService();
    const detail = await svc.getTournamentDetail(tournamentId, { viewerId: playerId });
    if (!detail) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Tournament not found.' };
    }
    const targetMatch = detail.matches.find((m) => m.bracketMatchId === bracketMatchId);
    if (!targetMatch) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Bracket match not found.' };
    }
    if (targetMatch.player1Id !== playerId && targetMatch.player2Id !== playerId) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'You are not assigned to this tournament match.',
      };
    }

    let sess =
      (preferredSessionId ? this.getSession(preferredSessionId) : null) ??
      this.findLatestConnectedSessionByPlayerId(playerId) ??
      this.findLatestSessionByPlayerId(playerId);

    if (!sess) {
      const prof = await this.getProgressionService().getPublicProfile(playerId);
      sess = this.createSession(
        prof?.displayName ?? 'Player',
        sanitizeAvatarId(prof?.avatarId),
        35,
        playerId,
      );
    }

    if (sess.in_matchmaking === 1) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_IN_MATCH',
        message: 'Leave matchmaking before entering a tournament match.',
      };
    }

    if (sess.active_room_id && sess.active_room_id !== targetMatch.roomId) {
      const activeRoomRows = this.ctx.storage.sql
        .exec<{ status: string }>(
          'SELECT status FROM rooms WHERE room_id = ? LIMIT 1',
          sess.active_room_id,
        )
        .toArray();
      const activeStatus = activeRoomRows[0]?.status;
      if (activeStatus === 'playing') {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_IN_MATCH',
          message: 'Finish your current active match before entering another tournament match.',
        };
      }
      // Clear stale or finished room pointer so player can enter the next round seamlessly
      this.ctx.storage.sql.exec(
        'UPDATE sessions SET active_room_id = NULL WHERE session_id = ?',
        sess.session_id,
      );
      sess.active_room_id = null;
    }

    const joined = await svc.markPlayerJoinedMatch({
      tournamentId,
      bracketMatchId,
      playerId,
    });
    if (!joined.ok) return joined;

    const provisioned = await this.ensureMatchRoomProvisioned(joined.tournament, joined.match);
    const joinCosmetics = await this.getEconomyService().getEquippedCosmetics(playerId);
    const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(provisioned.room.roomId));
    const prep = await roomStub.prepareTournamentPlayerSession(playerId, {
      sessionId: sess.session_id,
      playerId,
      reconnectToken: sess.reconnect_token,
      displayName: sess.display_name,
      avatarId: sanitizeAvatarId(sess.avatar_id),
      equippedCosmetics: joinCosmetics,
      latencyMs: sess.latency_ms,
    });

    if (!prep.ok) {
      return {
        ok: false,
        status: 409,
        code: prep.code,
        message: prep.message,
      };
    }

    this.ctx.storage.sql.exec(
      'UPDATE sessions SET active_room_id = ?, in_matchmaking = 0 WHERE session_id = ?',
      provisioned.room.roomId,
      sess.session_id,
    );

    await this.broadcastTournamentState(tournamentId);
    await this.scheduleNextAlarm();

    return {
      ok: true,
      tournament: joined.tournament,
      match: provisioned.match,
      room: prep.room,
      roomSession: {
        sessionId: sess.session_id,
        reconnectToken: sess.reconnect_token,
      },
    };
  }

  private async ensureMatchRoomProvisioned(
    tournament: TournamentRecord,
    match: TournamentMatch,
  ): Promise<{ match: TournamentMatch; room: OnlineRoomInfo }> {
    const svc = this.getTournamentService();
    if (match.roomId) {
      const existingStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(match.roomId));
      const resume = await existingStub.getResumeData();
      if (resume) {
        return { match, room: resume.room };
      }
    }

    const p1Id = match.player1Id!;
    const p2Id = match.player2Id!;
    const now = Date.now();
    const roomId = `room_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const roomCode = this.generateUniqueCode();
    const expiresAtMs = Math.max(
      now + this.config.roomTtlMs + 60_000,
      (match.readyDeadlineMs ?? now) + 120_000,
    );

    const p1Sess = this.findLatestSessionByPlayerId(p1Id);
    const p2Sess = this.findLatestSessionByPlayerId(p2Id);
    const [p1Cosmetics, p2Cosmetics, p1Profile, p2Profile] = await Promise.all([
      this.getEconomyService().getEquippedCosmetics(p1Id),
      this.getEconomyService().getEquippedCosmetics(p2Id),
      this.getProgressionService().getPublicProfile(p1Id),
      this.getProgressionService().getPublicProfile(p2Id),
    ]);

    const p1SessionId = p1Sess?.session_id ?? `ply_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const p2SessionId = p2Sess?.session_id ?? `ply_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const p1Reconnect = p1Sess?.reconnect_token ?? randomHexToken(24);
    const p2Reconnect = p2Sess?.reconnect_token ?? randomHexToken(24);
    const p1Name = match.player1Name ?? p1Sess?.display_name ?? 'Player 1';
    const p2Name = match.player2Name ?? p2Sess?.display_name ?? 'Player 2';
    const p1Avatar = sanitizeAvatarId(match.player1Avatar ?? p1Sess?.avatar_id);
    const p2Avatar = sanitizeAvatarId(match.player2Avatar ?? p2Sess?.avatar_id);

    const tourneyContext: OnlineRoomTournamentContext = {
      tournamentId: tournament.tournamentId,
      tournamentTitle: tournament.title,
      bracketMatchId: match.bracketMatchId,
      roundNumber: match.roundNumber,
      roundLabel: match.roundLabel,
      readyDeadlineMs: match.readyDeadlineMs,
    };
    const tourneyAllowSpectators = !tournament.isPrivate;
    const tourneyMetaJson = JSON.stringify({
      players: [
        {
          playerId: p1Id,
          displayName: p1Name,
          avatarId: p1Avatar,
          role: 'player1',
          elo: p1Profile?.elo,
          rankTier: p1Profile?.rankTier,
        },
        {
          playerId: p2Id,
          displayName: p2Name,
          avatarId: p2Avatar,
          role: 'player2',
          elo: p2Profile?.elo,
          rankTier: p2Profile?.rankTier,
        },
      ] satisfies SpectatableMatchPlayer[],
      tournament: tourneyContext,
    });

    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (
        room_id, room_code, host_session_id, is_private, match_type, rule_profile_id,
        called_shots_enabled, status, allow_spectators, allow_spectator_chat,
        spectator_count, max_spectators, meta_json, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, 'tournament', ?, ?, 'waiting', ?, 1, 0, ?, ?, ?, ?)`,
      roomId,
      roomCode,
      p1SessionId,
      tournament.isPrivate ? 1 : 0,
      tournament.ruleProfileId,
      tournament.calledShotsEnabled ? 1 : 0,
      tourneyAllowSpectators ? 1 : 0,
      this.config.maxSpectatorsPerRoom,
      tourneyMetaJson,
      now,
      expiresAtMs,
    );

    const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomId));
    const roomInfo = await roomStub.initTournamentRoom({
      roomId,
      roomCode,
      ruleProfileId: tournament.ruleProfileId,
      calledShotsEnabled: tournament.calledShotsEnabled,
      allowSpectators: tourneyAllowSpectators,
      tournament: tourneyContext,
      createdAtMs: now,
      expiresAtMs,
      player1: {
        sessionId: p1SessionId,
        playerId: p1Id,
        reconnectToken: p1Reconnect,
        displayName: p1Name,
        avatarId: p1Avatar,
        elo: p1Profile?.elo,
        rankTier: p1Profile?.rankTier,
        equippedCosmetics: p1Cosmetics,
        latencyMs: p1Sess?.latency_ms ?? 35,
      },
      player2: {
        sessionId: p2SessionId,
        playerId: p2Id,
        reconnectToken: p2Reconnect,
        displayName: p2Name,
        avatarId: p2Avatar,
        elo: p2Profile?.elo,
        rankTier: p2Profile?.rankTier,
        equippedCosmetics: p2Cosmetics,
        latencyMs: p2Sess?.latency_ms ?? 35,
      },
    });

    await svc.attachRoomToMatch({
      tournamentId: tournament.tournamentId,
      bracketMatchId: match.bracketMatchId,
      roomId,
      roomCode,
      readyDeadlineMs: match.readyDeadlineMs ?? undefined,
    });

    const updatedMatch: TournamentMatch = {
      ...match,
      roomId,
      roomCode,
    };
    return { match: updatedMatch, room: roomInfo };
  }

  private async notifyReadyTournamentMatches(
    tournament: TournamentRecord,
    readyMatches: TournamentMatch[],
  ): Promise<TournamentMatch[]> {
    const out: TournamentMatch[] = [];
    for (const m of readyMatches) {
      if (!m.player1Id || !m.player2Id) continue;
      try {
        const provisioned = await this.ensureMatchRoomProvisioned(tournament, m);
        out.push(provisioned.match);
        const msg: ServerToClientMessage = {
          type: 'tournament:match_ready',
          tournamentId: tournament.tournamentId,
          tournamentTitle: tournament.title,
          match: provisioned.match,
          room: provisioned.room,
        };
        this.sendToPlayer(m.player1Id, msg);
        this.sendToPlayer(m.player2Id, msg);
        await this.emitNotification({
          recipientId: m.player1Id,
          type: 'tournament_event',
          title: 'Tournament Match Ready',
          body: `${tournament.title}: ${m.roundLabel} vs ${m.player2Name ?? 'Opponent'} is ready.`,
          referenceId: tournament.tournamentId,
          dedupeKey: `tmatch:${m.bracketMatchId}`,
        });
        await this.emitNotification({
          recipientId: m.player2Id,
          type: 'tournament_event',
          title: 'Tournament Match Ready',
          body: `${tournament.title}: ${m.roundLabel} vs ${m.player1Name ?? 'Opponent'} is ready.`,
          referenceId: tournament.tournamentId,
          dedupeKey: `tmatch:${m.bracketMatchId}`,
        });
      } catch {
        out.push(m);
      }
    }
    return out;
  }

  private async closeRoomFromTournament(roomId: string, reason: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_id = ?', roomId);
    this.ctx.storage.sql.exec(
      'UPDATE sessions SET active_room_id = NULL WHERE active_room_id = ?',
      roomId,
    );
    try {
      const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomId));
      await roomStub.forceCloseTournamentRoom(reason);
    } catch {
      // Room already inactive
    }
  }

  private async broadcastTournamentState(
    tournamentId: string,
    overrideMatches?: TournamentMatch[],
  ): Promise<void> {
    const detail = await this.getTournamentService().getTournamentDetail(tournamentId, {
      isAdmin: true,
    });
    if (!detail) return;
    const participantIds = new Set(detail.participants.map((p) => p.playerId));
    const matches =
      overrideMatches && overrideMatches.length > 0 && detail.matches.length === 0
        ? overrideMatches
        : detail.matches;

    const updatedEncoded = JSON.stringify({
      type: 'tournament:updated',
      tournament: detail.tournament,
      matches,
    } satisfies ServerToClientMessage);
    const completedEncoded =
      detail.tournament.status === 'completed'
        ? JSON.stringify({
            type: 'tournament:completed',
            tournament: detail.tournament,
          } satisfies ServerToClientMessage)
        : null;

    if (detail.tournament.status === 'completed' && detail.tournament.championPlayerId) {
      for (const pid of participantIds) {
        await this.emitNotification({
          recipientId: pid,
          type: 'tournament_event',
          title: 'Tournament Completed',
          body: `${detail.tournament.title} concluded — Champion: ${detail.tournament.championDisplayName ?? 'Champion'}.`,
          referenceId: tournamentId,
          dedupeKey: `tdone:${tournamentId}`,
        });
      }
    }

    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      const isSubscriber = att.subscribedTournamentId === tournamentId;
      const isParticipant = Boolean(att.playerId && participantIds.has(att.playerId));
      if (!isSubscriber && !isParticipant) continue;
      try {
        ws.send(updatedEncoded);
        if (completedEncoded) {
          ws.send(completedEncoded);
        }
      } catch {
        // Ignore closed socket
      }
    }
  }

  private async processTournamentTimersInternal(targetTournamentId?: string) {
    const svc = this.getTournamentService();
    const res = await svc.processDueTimers(Date.now(), targetTournamentId);

    for (const st of res.startedTournaments) {
      if (st.readyMatches.length > 0) {
        await this.notifyReadyTournamentMatches(st.tournament, st.readyMatches);
      }
      await this.broadcastTournamentState(st.tournament.tournamentId);
    }

    for (const rm of res.resolvedMatches) {
      if (rm.roomIdToClose) {
        await this.closeRoomFromTournament(
          rm.roomIdToClose,
          rm.resolvedMatch.reason ?? 'Tournament match closed.',
        );
      }
      const detail = await svc.getTournamentDetail(rm.tournamentId, { isAdmin: true });
      if (detail && rm.newlyReadyMatches.length > 0) {
        await this.notifyReadyTournamentMatches(detail.tournament, rm.newlyReadyMatches);
      }
      await this.broadcastTournamentState(rm.tournamentId);
    }

    return res;
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
      const targetProfile = await this.getProgressionService().getPublicProfile(playerId);
      const actorName = targetProfile?.displayName ?? 'Player';
      await this.emitNotification({
        recipientId: targetPlayerId,
        type: 'friend_response',
        title: 'Friend Request Accepted',
        body: `${actorName} is now your friend.`,
        actorId: playerId,
        actorName,
        referenceId: playerId,
        dedupeKey: `f_acc:${playerId}`,
      });
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
        await this.emitNotification({
          recipientId: targetPlayerId,
          type: 'friend_request',
          title: 'New Friend Request',
          body: `${res.request.displayName} sent you a friend request.`,
          actorId: playerId,
          actorName: res.request.displayName,
          referenceId: res.request.requestId,
          dedupeKey: `f_req:${playerId}`,
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

    if (action === 'accept') {
      const actorProfile = await this.getProgressionService().getPublicProfile(actorId);
      const actorName = actorProfile?.displayName ?? 'Player';
      await this.emitNotification({
        recipientId: targetPlayerId,
        type: 'friend_response',
        title: 'Friend Request Accepted',
        body: `${actorName} accepted your friend request.`,
        actorId,
        actorName,
        referenceId: actorId,
        dedupeKey: `f_acc:${actorId}`,
      });
    }

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
      inviteKind?: MatchInviteKind;
      roomId?: string;
      ruleProfileId?: RuleProfileId;
      calledShotsEnabled?: boolean;
      ttlMs?: number;
    },
  ): Promise<{ ok: true; invitation: MatchInvitationRecord } | SocialError> {
    await this.pruneExpiredWaitingRooms();
    const inviteKind: MatchInviteKind = input.inviteKind === 'spectate' ? 'spectate' : 'match';
    const senderSess =
      (senderSessionId ? this.getSession(senderSessionId) : null) ??
      this.findLatestSessionByPlayerId(senderPlayerId);

    if (inviteKind === 'match' && senderSess?.in_matchmaking === 1) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_IN_MATCH',
        message: 'Cancel matchmaking before sending a direct match invitation.',
      };
    }

    let attachedRoomId: string | null = null;
    let attachedRoomCode: string | null = null;
    let effectiveRuleProfile: RuleProfileId = input.ruleProfileId === 'wpa' ? 'wpa' : 'casual';
    let effectiveCalledShots = Boolean(input.calledShotsEnabled);

    if (inviteKind === 'spectate') {
      const targetRoomId = (typeof input.roomId === 'string' && input.roomId.trim()) || senderSess?.active_room_id || null;
      if (!targetRoomId) {
        return {
          ok: false,
          status: 400,
          code: 'INVALID_ROOM',
          message: 'Join or specify an active match room before sending a spectator invite.',
        };
      }
      const roomRows = this.ctx.storage.sql
        .exec<{
          room_id: string;
          room_code: string;
          host_session_id: string;
          status: string;
          is_private: number;
          allow_spectators: number;
          expires_at_ms: number;
          rule_profile_id: string;
          called_shots_enabled: number;
          meta_json: string | null;
        }>('SELECT * FROM rooms WHERE room_id = ? LIMIT 1', targetRoomId)
        .toArray();
      const row = roomRows[0];
      if (
        !row ||
        row.status === 'expired' ||
        row.status === 'cancelled' ||
        row.status === 'finished' ||
        (row.status === 'waiting' && Date.now() >= row.expires_at_ms)
      ) {
        return {
          ok: false,
          status: 410,
          code: 'ROOM_EXPIRED',
          message: 'That match room is no longer active for spectating.',
        };
      }
      if (Number(row.allow_spectators) !== 1) {
        return {
          ok: false,
          status: 403,
          code: 'SPECTATE_UNAVAILABLE',
          message: 'Spectators are disabled for this room.',
        };
      }
      if (Number(row.is_private) === 1) {
        const meta = this.parseRoomMetaJson(row.meta_json);
        const isParticipant =
          meta.players.some((p) => p.playerId === senderPlayerId) ||
          (senderSess ? row.host_session_id === senderSess.session_id : false);
        if (!isParticipant) {
          return {
            ok: false,
            status: 403,
            code: 'SPECTATE_UNAVAILABLE',
            message: 'Only room participants can send spectate invitations for a private match.',
          };
        }
      }
      attachedRoomId = row.room_id;
      attachedRoomCode = row.room_code;
      effectiveRuleProfile = row.rule_profile_id === 'wpa' ? 'wpa' : 'casual';
      effectiveCalledShots = Number(row.called_shots_enabled) === 1;
    } else if (senderSess?.active_room_id) {
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
      inviteKind,
      roomId: attachedRoomId,
      roomCode: attachedRoomCode,
      ruleProfileId: effectiveRuleProfile,
      calledShotsEnabled: effectiveCalledShots,
      ttlMs: requestedTtl,
    });
    if (!res.ok) return res;

    await this.emitNotification({
      recipientId: res.invitation.recipientId,
      type: 'match_invite',
      title: inviteKind === 'spectate' ? 'Spectate Match Invite' : 'Match Invitation',
      body:
        inviteKind === 'spectate'
          ? `${res.invitation.senderName} invited you to watch a live match.`
          : `${res.invitation.senderName} challenged you (${res.invitation.ruleProfileId.toUpperCase()}).`,
      actorId: res.invitation.senderId,
      actorName: res.invitation.senderName,
      referenceId: res.invitation.inviteId,
      dedupeKey: `inv:${inviteKind}:${res.invitation.senderId}`,
      ttlMs: requestedTtl,
    });

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
    | {
        ok: true;
        invitation: MatchInvitationRecord;
        room?: OnlineRoomInfo;
        spectateTarget?: { roomId: string; roomCode: string | null };
      }
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

    if (inv.inviteKind === 'spectate') {
      if (recipientSess && (recipientSess.active_room_id || recipientSess.in_matchmaking === 1)) {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_IN_MATCH',
          message: 'Leave your current room or matchmaking queue before spectating.',
        };
      }
      const targetRoomId = inv.roomId;
      if (!targetRoomId) {
        await social.updateInvitationStatus(inv.inviteId, 'expired');
        return {
          ok: false,
          status: 410,
          code: 'ROOM_EXPIRED',
          message: 'Spectate match room is no longer available.',
        };
      }
      const roomRows = this.ctx.storage.sql
        .exec<{
          room_id: string;
          room_code: string;
          status: string;
          allow_spectators: number;
          expires_at_ms: number;
        }>('SELECT room_id, room_code, status, allow_spectators, expires_at_ms FROM rooms WHERE room_id = ? LIMIT 1', targetRoomId)
        .toArray();
      const row = roomRows[0];
      if (
        !row ||
        row.status === 'expired' ||
        row.status === 'cancelled' ||
        row.status === 'finished' ||
        (row.status === 'waiting' && Date.now() >= row.expires_at_ms)
      ) {
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
          message: 'The invited match has already finished or closed.',
        };
      }
      if (Number(row.allow_spectators) !== 1) {
        return {
          ok: false,
          status: 403,
          code: 'SPECTATE_UNAVAILABLE',
          message: 'Spectators are disabled for this match.',
        };
      }

      const acceptedInv = (await social.updateInvitationStatus(inv.inviteId, 'accepted', {
        roomId: row.room_id,
        roomCode: row.room_code,
      })) ?? {
        ...inv,
        roomId: row.room_id,
        roomCode: row.room_code,
        status: 'accepted' as const,
        respondedAtMs: Date.now(),
      };

      this.sendToPlayer(inv.senderId, { type: 'invite:updated', invitation: acceptedInv });
      this.sendToPlayer(inv.recipientId, { type: 'invite:updated', invitation: acceptedInv });
      await this.pushOverviewToPlayers([inv.senderId, inv.recipientId]);
      return {
        ok: true,
        invitation: acceptedInv,
        spectateTarget: { roomId: row.room_id, roomCode: row.room_code },
      };
    }

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

      const [joinCosmetics, guestProfile] = await Promise.all([
        this.getEconomyService().getEquippedCosmetics(actorPlayerId),
        this.getProgressionService().getPublicProfile(actorPlayerId),
      ]);
      const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(row.room_id));
      const joinRes = await roomStub.joinRoom({
        sessionId: recipientSess.session_id,
        playerId: actorPlayerId,
        reconnectToken: recipientSess.reconnect_token,
        displayName: recipientSess.display_name,
        avatarId: sanitizeAvatarId(recipientSess.avatar_id),
        elo: guestProfile?.elo,
        rankTier: guestProfile?.rankTier,
        equippedCosmetics: joinCosmetics,
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

    const [hostCosmetics, guestCosmetics, hostProfile, guestProfile] = await Promise.all([
      this.getEconomyService().getEquippedCosmetics(inv.senderId),
      this.getEconomyService().getEquippedCosmetics(actorPlayerId),
      this.getProgressionService().getPublicProfile(inv.senderId),
      this.getProgressionService().getPublicProfile(actorPlayerId),
    ]);

    const inviteMetaJson = JSON.stringify({
      players: [
        {
          playerId: inv.senderId,
          displayName: senderSess.display_name,
          avatarId: sanitizeAvatarId(senderSess.avatar_id),
          role: 'player1',
          elo: hostProfile?.elo,
          rankTier: hostProfile?.rankTier,
        },
        {
          playerId: actorPlayerId,
          displayName: recipientSess.display_name,
          avatarId: sanitizeAvatarId(recipientSess.avatar_id),
          role: 'player2',
          elo: guestProfile?.elo,
          rankTier: guestProfile?.rankTier,
        },
      ] satisfies SpectatableMatchPlayer[],
      tournament: null,
    });

    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (
        room_id, room_code, host_session_id, is_private, match_type, rule_profile_id,
        called_shots_enabled, status, allow_spectators, allow_spectator_chat,
        spectator_count, max_spectators, meta_json, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, 1, 'private', ?, ?, 'waiting', 0, 1, 0, ?, ?, ?, ?)`,
      roomId,
      roomCode,
      senderSess.session_id,
      inv.ruleProfileId,
      inv.calledShotsEnabled ? 1 : 0,
      this.config.maxSpectatorsPerRoom,
      inviteMetaJson,
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
        elo: hostProfile?.elo,
        rankTier: hostProfile?.rankTier,
        equippedCosmetics: hostCosmetics,
        latencyMs: senderSess.latency_ms,
      },
    });

    const joinRes = await roomStub.joinRoom({
      sessionId: recipientSess.session_id,
      playerId: actorPlayerId,
      reconnectToken: recipientSess.reconnect_token,
      displayName: recipientSess.display_name,
      avatarId: sanitizeAvatarId(recipientSess.avatar_id),
      elo: guestProfile?.elo,
      rankTier: guestProfile?.rankTier,
      equippedCosmetics: guestCosmetics,
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

  private async handleJoinFriendRoom(
    playerId: string,
    preferredSessionId: string | null,
    friendPlayerIdRaw: string,
  ): Promise<{ ok: true; room: OnlineRoomInfo } | SocialError> {
    await this.pruneExpiredWaitingRooms();
    const friendPlayerId = typeof friendPlayerIdRaw === 'string' ? friendPlayerIdRaw.trim() : '';
    if (!friendPlayerId || friendPlayerId === playerId) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid friend player ID.' };
    }

    const restriction = await this.getAntiCheatService().getPlayerRestriction(playerId);
    if (restriction.blockedFromOnline) {
      return {
        ok: false,
        status: 403,
        code: 'SUSPENDED',
        message: 'Your account is currently suspended from online multiplayer.',
      };
    }

    const social = this.getSocialService();
    if (await social.isBlockedBetween(playerId, friendPlayerId)) {
      return {
        ok: false,
        status: 403,
        code: 'BLOCKED_PLAYER',
        message: 'Cannot join a room involving a blocked player.',
      };
    }
    if (!(await social.areFriends(playerId, friendPlayerId))) {
      return {
        ok: false,
        status: 403,
        code: 'NOT_FRIENDS',
        message: 'You can only quick-join rooms of players on your friends list.',
      };
    }

    const friendPrivacy = await social.getPrivacySettings(friendPlayerId);
    if (!friendPrivacy.showOnlineStatus) {
      return {
        ok: false,
        status: 403,
        code: 'PRIVACY_RESTRICTED',
        message: 'This friend has hidden their online room activity.',
      };
    }

    const sess =
      (preferredSessionId ? this.getSession(preferredSessionId) : null) ??
      this.findLatestConnectedSessionByPlayerId(playerId) ??
      this.findLatestSessionByPlayerId(playerId);

    if (!sess) {
      return {
        ok: false,
        status: 409,
        code: 'PLAYER_OFFLINE',
        message: 'Connect to online multiplayer before joining a friend room.',
      };
    }
    if (sess.active_room_id || sess.in_matchmaking === 1) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_IN_MATCH',
        message: 'Leave your current room or matchmaking queue before joining a friend.',
      };
    }

    const friendSess =
      this.findLatestConnectedSessionByPlayerId(friendPlayerId) ??
      this.findLatestSessionByPlayerId(friendPlayerId);
    const friendRoomId = friendSess?.active_room_id;
    if (!friendRoomId) {
      return {
        ok: false,
        status: 404,
        code: 'INVALID_ROOM',
        message: 'Your friend is not currently in an open room.',
      };
    }

    const row = this.ctx.storage.sql
      .exec<{ room_id: string; status: string; expires_at_ms: number }>(
        'SELECT room_id, status, expires_at_ms FROM rooms WHERE room_id = ? LIMIT 1',
        friendRoomId,
      )
      .toArray()[0];
    if (!row || row.status !== 'waiting' || Date.now() >= row.expires_at_ms) {
      return {
        ok: false,
        status: 409,
        code: 'ROOM_FULL',
        message: 'Your friend’s room is no longer waiting for a challenger.',
      };
    }

    const [joinCosmetics, joinProfile] = await Promise.all([
      this.getEconomyService().getEquippedCosmetics(playerId),
      this.getProgressionService().getPublicProfile(playerId),
    ]);
    const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(row.room_id));
    const joinRes = await roomStub.joinRoom({
      sessionId: sess.session_id,
      playerId,
      reconnectToken: sess.reconnect_token,
      displayName: sess.display_name,
      avatarId: sanitizeAvatarId(sess.avatar_id),
      elo: joinProfile?.elo,
      rankTier: joinProfile?.rankTier,
      equippedCosmetics: joinCosmetics,
      latencyMs: sess.latency_ms,
    });

    if (!joinRes.ok) {
      return { ok: false, status: 409, code: joinRes.code, message: joinRes.message };
    }

    this.ctx.storage.sql.exec(
      'UPDATE sessions SET active_room_id = ?, in_matchmaking = 0 WHERE session_id = ?',
      row.room_id,
      sess.session_id,
    );
    this.ctx.storage.sql.exec(
      'UPDATE rooms SET expires_at_ms = ?, status = ? WHERE room_id = ?',
      joinRes.room.expiresAtMs,
      joinRes.room.status,
      row.room_id,
    );
    await this.pushOverviewToPlayers([playerId, friendPlayerId]);
    await this.scheduleNextAlarm();
    return { ok: true, room: joinRes.room };
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

    await this.emitNotification({
      recipientId,
      type: 'private_message',
      title: `Message from ${res.message.senderName}`,
      body: res.message.body.slice(0, 110),
      actorId: senderId,
      actorName: res.message.senderName,
      referenceId: res.message.messageId,
      dedupeKey: `dm:${senderId}`,
    });

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

  private async handleUpdatePrivacySettings(
    playerId: string,
    updates: Partial<PrivacySettings>,
  ): Promise<PrivacySettings> {
    const social = this.getSocialService();
    const updated = await social.updatePrivacySettings(playerId, updates);
    const liveStatus = await social.getPresenceStatus(playerId);
    await this.broadcastPresenceChanged(playerId, liveStatus, Date.now());
    await this.pushOverviewToPlayers([playerId]);
    return updated;
  }

  private async emitNotification(params: {
    recipientId: string;
    type: NotificationType;
    title: string;
    body: string;
    actorId?: string | null;
    actorName?: string | null;
    referenceId?: string | null;
    dedupeKey?: string | null;
    ttlMs?: number | null;
  }): Promise<void> {
    if (!params.recipientId) return;
    try {
      const created = await this.getSocialService().createNotification(params);
      this.sendToPlayer(params.recipientId, {
        type: 'notification:new',
        notification: created.notification,
        unreadCount: created.unreadCount,
      });
    } catch {
      // Non-blocking notification persistence error
    }
  }

  private async broadcastClubUpdated(playerIds: string[], clubId?: string | null): Promise<void> {
    const clubSvc = this.getClubService();
    const seen = new Set<string>();
    for (const pid of playerIds) {
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      if (this.findSocketsByPlayerId(pid).length === 0) continue;
      try {
        const summary = await clubSvc.getPlayerClubSummary(pid);
        const targetClubId = summary?.clubId ?? clubId ?? null;
        const [clubDetail, incomingInvitations] = await Promise.all([
          targetClubId ? clubSvc.getClubDetail(targetClubId, pid) : Promise.resolve(null),
          clubSvc.getIncomingClubInvitations(pid),
        ]);
        this.sendToPlayer(pid, {
          type: 'club:updated',
          clubDetail: summary ? clubDetail : null,
          incomingInvitations,
        });
        const overview = await this.buildSocialOverview(pid);
        this.sendToPlayer(pid, { type: 'social:state', overview });
      } catch {
        // Non-blocking club push
      }
    }
  }

  private async broadcastClubChallengeUpdate(
    challenge: ClubChallengeRecord,
    opts?: {
      notifyRecipients?: string[];
      notifyTitle?: string;
      notifyBody?: string;
      actorId?: string | null;
    },
  ): Promise<void> {
    const clubSvc = this.getClubService();
    const [m1, m2] = await Promise.all([
      clubSvc.getClubMemberPlayerIds(challenge.challengerClubId),
      clubSvc.getClubMemberPlayerIds(challenge.targetClubId),
    ]);
    const allMembers = [...new Set([...m1, ...m2])];
    for (const pid of allMembers) {
      this.sendToPlayer(pid, {
        type: 'club:challenge_updated',
        challenge,
      });
    }
    const recipients = opts?.notifyRecipients ?? allMembers;
    if (opts?.notifyTitle && opts?.notifyBody) {
      for (const pid of recipients) {
        if (opts.actorId && pid === opts.actorId) continue;
        await this.emitNotification({
          recipientId: pid,
          type: 'club_challenge',
          title: opts.notifyTitle,
          body: opts.notifyBody,
          actorId: opts.actorId ?? null,
          referenceId: challenge.challengeId,
          dedupeKey: `cchal:${challenge.challengeId}`,
        });
      }
    }
    await this.broadcastClubUpdated(allMembers, challenge.challengerClubId);
  }

  private async buildSocialOverview(playerId: string): Promise<SocialOverviewPayload> {
    const social = this.getSocialService();
    const clubSvc = this.getClubService();
    const base = await social.getOverview(playerId);

    const [myClub, incomingClubInvitations, clubBadges] = await Promise.all([
      clubSvc.getPlayerClubSummary(playerId).catch(() => null),
      clubSvc.getIncomingClubInvitations(playerId).catch(() => []),
      clubSvc.getClubBadgesForPlayers(base.friends.map((f) => f.playerId)).catch(() => new Map<string, PlayerClubBadgeSummary>()),
    ]);

    // Map active rooms to friends whose online status is visible
    const activeRoomsByPlayer = new Map<string, FriendRoomAvailability>();
    const now = Date.now();
    try {
      const roomRows = this.ctx.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT room_id, room_code, is_private, match_type, rule_profile_id, status,
                  allow_spectators, spectator_count, max_spectators, meta_json, expires_at_ms
           FROM rooms
           WHERE status IN ('waiting', 'ready', 'playing')`,
        )
        .toArray();
      const visibleFriendIds = new Set(
        base.friends.filter((f) => f.presence !== 'offline').map((f) => f.playerId),
      );
      if (visibleFriendIds.size > 0 && roomRows.length > 0) {
        const roomLookup = new Map<string, Record<string, SqlStorageValue>>();
        for (const r of roomRows) {
          roomLookup.set(String(r.room_id), r);
        }
        const sessRows = this.ctx.storage.sql
          .exec<{ player_id: string | null; active_room_id: string | null }>(
            'SELECT player_id, active_room_id FROM sessions WHERE active_room_id IS NOT NULL ORDER BY last_seen_at_ms DESC',
          )
          .toArray();
        for (const sr of sessRows) {
          const pid = sr.player_id ? String(sr.player_id) : '';
          const rid = sr.active_room_id ? String(sr.active_room_id) : '';
          if (!pid || !rid || !visibleFriendIds.has(pid) || activeRoomsByPlayer.has(pid)) continue;
          const r = roomLookup.get(rid);
          if (!r) continue;
          const meta = this.parseRoomMetaJson(r.meta_json);
          const rawStatus = String(r.status);
          if (rawStatus !== 'waiting' && rawStatus !== 'ready' && rawStatus !== 'playing') continue;
          const isPrivate = Number(r.is_private) === 1;
          const allowSpec = Number(r.allow_spectators) === 1;
          const joinable =
            rawStatus === 'waiting' &&
            meta.players.length < 2 &&
            now < Number(r.expires_at_ms) &&
            (String(r.match_type) === 'private' || String(r.match_type) === 'quick');
          const spectatable =
            allowSpec &&
            !isPrivate &&
            Number(r.spectator_count ?? 0) < Number(r.max_spectators ?? this.config.maxSpectatorsPerRoom);
          activeRoomsByPlayer.set(pid, {
            roomId: String(r.room_id),
            roomCode: joinable ? String(r.room_code) : '',
            status: rawStatus,
            isPrivate,
            ruleProfileId: r.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
            joinable,
            spectatable,
          });
        }
      }
    } catch {
      // Non-blocking room lookup
    }

    const enrichedFriends: FriendRecord[] = base.friends.map((f) => ({
      ...f,
      club: clubBadges.get(f.playerId) ?? null,
      activeRoom: activeRoomsByPlayer.get(f.playerId) ?? null,
    }));

    return {
      ...base,
      friends: enrichedFriends,
      friendsTotal: enrichedFriends.length,
      myClub,
      incomingClubInvitations,
    };
  }

  private async broadcastPresenceChanged(
    playerId: string,
    status: PresenceStatus,
    lastSeenAtMs: number,
  ): Promise<void> {
    const social = this.getSocialService();
    const privacy = await social.getPrivacySettings(playerId).catch(() => DEFAULT_PRIVACY_SETTINGS);

    this.sendToPlayer(playerId, {
      type: 'social:presence_changed',
      playerId,
      status,
      lastSeenAtMs,
    });

    const visibleStatus: PresenceStatus = privacy.showOnlineStatus ? status : 'offline';
    const visibleLastSeen = privacy.showOnlineStatus ? lastSeenAtMs : 0;
    const friendMsg: ServerToClientMessage = {
      type: 'social:presence_changed',
      playerId,
      status: visibleStatus,
      lastSeenAtMs: visibleLastSeen,
    };
    const friendIds = await social.getFriendIds(playerId);
    for (const fid of friendIds) {
      this.sendToPlayer(fid, friendMsg);
    }
  }

  private async pushOverviewToPlayers(playerIds: string[]): Promise<void> {
    const seen = new Set<string>();
    for (const pid of playerIds) {
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      if (this.findSocketsByPlayerId(pid).length === 0) continue;
      try {
        const overview = await this.buildSocialOverview(pid);
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

    await social.expireNotifications(now);

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
    let preservedSubscription: string | null = null;
    let preservedRegion: string | null = null;
    const prevSelf = this.getAttachment(ws);
    if (prevSelf.subscribedTournamentId) {
      preservedSubscription = prevSelf.subscribedTournamentId;
    }
    if (prevSelf.region) {
      preservedRegion = prevSelf.region;
    }
    for (const existing of this.ctx.getWebSockets()) {
      if (existing === ws) continue;
      const att = this.getAttachment(existing);
      if (att.sessionId === sessionId) {
        att.sessionId = null;
        att.playerId = null;
        att.subscribedTournamentId = null;
        existing.serializeAttachment(att);
        try {
          existing.close(4001, 'Replaced by resumed session');
        } catch {
          // Ignore close errors
        }
      }
    }
    ws.serializeAttachment({
      sessionId,
      playerId,
      subscribedTournamentId: preservedSubscription,
      region: preservedRegion,
    } satisfies LobbySocketAttachment);
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

  private normalizeRegion(raw: unknown): string {
    if (typeof raw !== 'string') return 'global';
    const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
    return cleaned || 'global';
  }

  private async getEstimatedQueueWaitSec(mode: 'quick' | 'ranked'): Promise<number | null> {
    try {
      const db = this.env.DB ?? createDurableObjectSqlDb(this.ctx.storage.sql);
      await this.getRankedSeasonService().ensureSchema();
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const rows = await (db as unknown as ReturnType<typeof createDurableObjectSqlDb>)
        .prepare(
          `SELECT wait_ms FROM ranked_matchmaking_metrics
           WHERE mode = ? AND matched_at_ms >= ?
           ORDER BY matched_at_ms DESC LIMIT 25`,
        )
        .bind(mode, cutoff)
        .all<{ wait_ms: number }>();
      const list = rows.results ?? [];
      if (list.length < RANKED_MATCHMAKING_CONFIG.minWaitSamplesForEstimate) {
        return null;
      }
      const avgMs =
        list.reduce((acc, row) => acc + Math.max(0, Number(row.wait_ms ?? 0)), 0) / list.length;
      return Math.max(1, Math.round(avgMs / 1000));
    } catch {
      return null;
    }
  }

  private async recordMatchmakingMetric(params: {
    mode: 'quick' | 'ranked';
    region: string;
    waitMs: number;
    eloGap: number;
    matchedAtMs: number;
  }): Promise<void> {
    try {
      await this.getRankedSeasonService().ensureSchema();
      const db = this.env.DB ?? createDurableObjectSqlDb(this.ctx.storage.sql);
      await (db as unknown as ReturnType<typeof createDurableObjectSqlDb>)
        .prepare(
          `INSERT INTO ranked_matchmaking_metrics (mode, region, wait_ms, elo_gap, matched_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          params.mode,
          params.region,
          Math.max(0, Math.round(params.waitMs)),
          Math.max(0, Math.round(params.eloGap)),
          params.matchedAtMs,
        )
        .run();
    } catch {
      // Non-blocking queue metric write
    }
  }

  private cancelMatchmaking(sessionId: string, reason: string): boolean {
    const existing = this.ctx.storage.sql
      .exec<{ session_id: string }>(
        'SELECT session_id FROM match_queue WHERE session_id = ? LIMIT 1',
        sessionId,
      )
      .toArray();

    this.lastRankedSpreadSent.delete(sessionId);
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
          this.lastRankedSpreadSent.delete(sid);
          this.ctx.storage.sql.exec('DELETE FROM match_queue WHERE session_id = ?', sid);
          this.ctx.storage.sql.exec(
            'UPDATE sessions SET in_matchmaking = 0 WHERE session_id = ?',
            sid,
          );
          continue;
        }
        const timeoutAtMs = Number(r.timeout_at_ms);
        if (now >= timeoutAtMs) {
          this.lastRankedSpreadSent.delete(sid);
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
          player_id: r.player_id ? String(r.player_id) : sess.player_id ?? sid,
          queue_mode: r.queue_mode === 'ranked' ? 'ranked' : 'quick',
          elo: Number(r.elo ?? 1200),
          region: this.normalizeRegion(r.region ?? 'global'),
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
            // Strictly prevent self-matching on same account
            if (a.player_id === b.player_id) continue;
            // Strictly isolate Ranked and Quick matchmaking queues
            if (a.queue_mode !== b.queue_mode) continue;

            const waitSecB = Math.max(0, (now - b.joined_at_ms) / 1000);
            const waitSecBoth = Math.min(waitSecA, waitSecB);
            const sameRules =
              a.rule_profile_id === b.rule_profile_id &&
              a.called_shots_enabled === b.called_shots_enabled;

            if (a.queue_mode === 'ranked') {
              if (!sameRules) continue;

              const spreadA = computeAllowedRankedEloSpread(waitSecA);
              const spreadB = computeAllowedRankedEloSpread(waitSecB);
              const allowedEloSpread = Math.max(spreadA, spreadB);
              if (Math.abs(a.elo - b.elo) > allowedEloSpread) continue;

              if (
                waitSecBoth < RANKED_MATCHMAKING_CONFIG.regionPreferenceWindowSec &&
                a.region !== 'GLOBAL' &&
                b.region !== 'GLOBAL' &&
                a.region !== b.region
              ) {
                continue;
              }
            } else {
              if (!sameRules && waitSecBoth < 10) continue;
            }

            const latencyDiff = Math.abs(a.latency_ms - b.latency_ms);
            const allowedLatencySpread = this.config.maxLatencySpreadMs + waitSecBoth * 25;
            if (latencyDiff <= allowedLatencySpread) {
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

        this.lastRankedSpreadSent.delete(entryA.session_id);
        this.lastRankedSpreadSent.delete(entryB.session_id);
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
        const matchType: 'quick' | 'ranked' = entryA.queue_mode === 'ranked' ? 'ranked' : 'quick';
        const ruleProfileId: RuleProfileId =
          entryA.rule_profile_id === 'wpa' ? 'wpa' : 'casual';
        const calledShotsEnabled = entryA.called_shots_enabled === 1;
        const expiresAtMs = now + this.config.roomTtlMs;

        const p1Id = sessA.player_id ?? sessA.session_id;
        const p2Id = sessB.player_id ?? sessB.session_id;
        const [p1Cosmetics, p2Cosmetics, p1Profile, p2Profile] = await Promise.all([
          this.getEconomyService().getEquippedCosmetics(p1Id),
          this.getEconomyService().getEquippedCosmetics(p2Id),
          this.getProgressionService().getPublicProfile(p1Id),
          this.getProgressionService().getPublicProfile(p2Id),
        ]);

        const matchedMetaJson = JSON.stringify({
          players: [
            {
              playerId: p1Id,
              displayName: sessA.display_name,
              avatarId: sanitizeAvatarId(sessA.avatar_id),
              role: 'player1',
              elo: p1Profile?.elo,
              rankTier: p1Profile?.rankTier,
            },
            {
              playerId: p2Id,
              displayName: sessB.display_name,
              avatarId: sanitizeAvatarId(sessB.avatar_id),
              role: 'player2',
              elo: p2Profile?.elo,
              rankTier: p2Profile?.rankTier,
            },
          ] satisfies SpectatableMatchPlayer[],
          tournament: null,
        });

        this.ctx.storage.sql.exec(
          `INSERT INTO rooms (
            room_id, room_code, host_session_id, is_private, match_type, rule_profile_id,
            called_shots_enabled, status, allow_spectators, allow_spectator_chat,
            spectator_count, max_spectators, meta_json, created_at_ms, expires_at_ms
          ) VALUES (?, ?, ?, 0, ?, ?, ?, 'playing', 1, 1, 0, ?, ?, ?, ?)`,
          roomId,
          roomCode,
          sessA.session_id,
          matchType,
          ruleProfileId,
          calledShotsEnabled ? 1 : 0,
          this.config.maxSpectatorsPerRoom,
          matchedMetaJson,
          now,
          expiresAtMs,
        );
        this.ctx.storage.sql.exec(
          'UPDATE sessions SET active_room_id = ?, in_matchmaking = 0 WHERE session_id IN (?, ?)',
          roomId,
          sessA.session_id,
          sessB.session_id,
        );

        const avgWaitMs = Math.round(
          (Math.max(0, now - entryA.joined_at_ms) + Math.max(0, now - entryB.joined_at_ms)) / 2,
        );
        await this.recordMatchmakingMetric({
          mode: matchType,
          region: entryA.region === entryB.region ? entryA.region : 'GLOBAL',
          waitMs: avgWaitMs,
          eloGap: Math.abs(entryA.elo - entryB.elo),
          matchedAtMs: now,
        });

        const roomStub = this.env.POOL_ROOM.get(this.env.POOL_ROOM.idFromName(roomId));
        const started = await roomStub.initMatchedRoom({
          roomId,
          roomCode,
          matchType,
          ruleProfileId,
          calledShotsEnabled,
          createdAtMs: now,
          expiresAtMs,
          player1: {
            sessionId: sessA.session_id,
            playerId: p1Id,
            reconnectToken: sessA.reconnect_token,
            displayName: sessA.display_name,
            avatarId: sanitizeAvatarId(sessA.avatar_id),
            elo: p1Profile?.elo,
            rankTier: p1Profile?.rankTier,
            equippedCosmetics: p1Cosmetics,
            latencyMs: sessA.latency_ms,
          },
          player2: {
            sessionId: sessB.session_id,
            playerId: p2Id,
            reconnectToken: sessB.reconnect_token,
            displayName: sessB.display_name,
            avatarId: sanitizeAvatarId(sessB.avatar_id),
            elo: p2Profile?.elo,
            rankTier: p2Profile?.rankTier,
            equippedCosmetics: p2Cosmetics,
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

      // Broadcast live ELO spread expansions for waiting ranked competitors
      if (queue.length > 0) {
        for (let idx = 0; idx < queue.length; idx++) {
          const entry = queue[idx];
          if (entry.queue_mode !== 'ranked') continue;
          const waitSec = Math.max(0, (now - entry.joined_at_ms) / 1000);
          const currentSpread = computeAllowedRankedEloSpread(waitSec);
          const prevSent = this.lastRankedSpreadSent.get(entry.session_id);
          if (prevSent !== undefined && prevSent === currentSpread) continue;
          const ws = this.findSocketBySession(entry.session_id);
          if (!ws) continue;
          this.lastRankedSpreadSent.set(entry.session_id, currentSpread);
          const estimatedWaitSec = await this.getEstimatedQueueWaitSec('ranked');
          this.sendSocket(ws, {
            type: 'matchmaking:searching',
            position: idx + 1,
            startedAtMs: entry.joined_at_ms,
            timeoutAtMs: entry.timeout_at_ms,
            mode: 'ranked',
            elo: entry.elo,
            eloSpread: currentSpread,
            region: entry.region,
            estimatedWaitSec,
          });
        }
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

    try {
      const tourneyDue = await this.getTournamentService().getEarliestDueTimestampMs();
      if (tourneyDue !== null) {
        candidates.push(Math.max(now + 250, tourneyDue));
      }
    } catch {
      // Ignore if tournament schema not yet ready
    }

    try {
      const clubLeagueDue = await this.getClubLeagueService().getEarliestDueTimestampMs();
      if (clubLeagueDue !== null) {
        candidates.push(Math.max(now + 250, clubLeagueDue));
      }
    } catch {
      // Ignore if club league schema not yet ready
    }

    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private getQueueCount(mode?: 'quick' | 'ranked'): number {
    if (mode) {
      return Number(
        this.ctx.storage.sql
          .exec<{ c: number }>('SELECT COUNT(*) AS c FROM match_queue WHERE queue_mode = ?', mode)
          .one().c,
      );
    }
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
    return raw
      ? {
          sessionId: raw.sessionId ?? null,
          playerId: raw.playerId ?? null,
          subscribedTournamentId: raw.subscribedTournamentId ?? null,
          region: raw.region ?? null,
        }
      : { sessionId: null, playerId: null, subscribedTournamentId: null, region: null };
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
