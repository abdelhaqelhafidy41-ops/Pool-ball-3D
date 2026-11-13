import { randomUUID } from 'node:crypto';
import type { RuleProfileId } from '../src/game/rules/types';
import type {
  MatchHistoryRecord,
  MultiplayerErrorCode,
  OnlineBallFrame,
  OnlineMatchSnapshot,
  OnlinePlayerProfile,
  OnlineRoomInfo,
  OnlineRoomStatus,
} from '../src/multiplayer/shared/protocol';
import type { MatchProgressionRewardSummary } from '../src/multiplayer/shared/progression';
import type { LocalProgressionStore } from './LocalProgressionStore';
import type { PlayerSession, PlayerSessionManager } from './PlayerSessionManager';
import { ServerMatchManager } from './ServerMatchManager';

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface ManagedRoom {
  roomId: string;
  roomCode: string;
  hostSessionId: string;
  isPrivate: boolean;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  status: OnlineRoomStatus;
  players: OnlinePlayerProfile[];
  createdAtMs: number;
  expiresAtMs: number;
  match: ServerMatchManager | null;
}

export interface RoomBroadcastCallbacks {
  sendToSession: (sessionId: string, payload: unknown) => void;
  onMatchHistoryRecorded: (record: MatchHistoryRecord) => void;
}

export class RoomManager {
  private rooms = new Map<string, ManagedRoom>();
  private codeToRoomId = new Map<string, string>();
  private history: MatchHistoryRecord[] = [];
  private recordedMatchIds = new Set<string>();
  private totalMatchesCompleted = 0;

  private sessionManager: PlayerSessionManager;
  private progressionStore?: LocalProgressionStore;
  private roomTtlMs: number;
  private physicsBroadcastHz: number;
  private callbacks: RoomBroadcastCallbacks;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: {
    sessionManager: PlayerSessionManager;
    progressionStore?: LocalProgressionStore;
    roomTtlMs: number;
    physicsBroadcastHz: number;
    callbacks: RoomBroadcastCallbacks;
  }) {
    this.sessionManager = options.sessionManager;
    this.progressionStore = options.progressionStore;
    this.roomTtlMs = options.roomTtlMs;
    this.physicsBroadcastHz = options.physicsBroadcastHz;
    this.callbacks = options.callbacks;

    this.cleanupTimer = setInterval(() => this.pruneExpiredRooms(), 15000);
  }

  public getHistory(limit = 30): MatchHistoryRecord[] {
    return this.history.slice(0, limit);
  }

  public getStats(): {
    activeRooms: number;
    activeMatches: number;
    totalMatchesCompleted: number;
  } {
    let activeMatches = 0;
    for (const room of this.rooms.values()) {
      if (room.status === 'playing') activeMatches++;
    }
    return {
      activeRooms: this.rooms.size,
      activeMatches,
      totalMatchesCompleted: this.totalMatchesCompleted,
    };
  }

  public getRoom(roomId: string): ManagedRoom | undefined {
    return this.rooms.get(roomId);
  }

  public getRoomBySession(sessionId: string): ManagedRoom | undefined {
    const session = this.sessionManager.getSession(sessionId);
    if (!session?.activeRoomId) return undefined;
    return this.rooms.get(session.activeRoomId);
  }

  public toRoomInfo(room: ManagedRoom): OnlineRoomInfo {
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      hostSessionId: room.hostSessionId,
      isPrivate: room.isPrivate,
      ruleProfileId: room.ruleProfileId,
      calledShotsEnabled: room.calledShotsEnabled,
      status: room.status,
      players: room.players.map((p) => ({ ...p })),
      createdAtMs: room.createdAtMs,
      expiresAtMs: room.expiresAtMs,
    };
  }

  public createRoom(
    host: PlayerSession,
    options: {
      isPrivate: boolean;
      ruleProfileId: RuleProfileId;
      calledShotsEnabled: boolean;
    },
  ): { ok: true; room: ManagedRoom } | { ok: false; code: MultiplayerErrorCode; message: string } {
    if (host.activeRoomId || host.inMatchmaking) {
      return {
        ok: false,
        code: 'ALREADY_IN_MATCH',
        message: 'You are already in an active room or matchmaking queue.',
      };
    }

    const now = Date.now();
    const roomId = `room_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const roomCode = this.generateUniqueCode();

    const room: ManagedRoom = {
      roomId,
      roomCode,
      hostSessionId: host.sessionId,
      isPrivate: options.isPrivate,
      ruleProfileId: options.ruleProfileId,
      calledShotsEnabled: options.calledShotsEnabled,
      status: 'waiting',
      players: [
        {
          sessionId: host.sessionId,
          playerId: host.playerId,
          displayName: host.displayName,
          avatarId: host.avatarId,
          role: 'player1',
          connected: host.connected,
          ready: true,
          latencyMs: host.latencyMs,
          disconnectedAtMs: null,
          reconnectDeadlineMs: null,
          rematchRequested: false,
        },
      ],
      createdAtMs: now,
      expiresAtMs: now + this.roomTtlMs,
      match: null,
    };

    this.rooms.set(roomId, room);
    this.codeToRoomId.set(roomCode, roomId);
    this.sessionManager.bindRoom(host.sessionId, roomId);
    return { ok: true, room };
  }

  public async createMatchedRoom(
    p1: PlayerSession,
    p2: PlayerSession,
    options: {
      ruleProfileId: RuleProfileId;
      calledShotsEnabled: boolean;
    },
  ): Promise<{ room: ManagedRoom; match: OnlineMatchSnapshot; balls: OnlineBallFrame[] }> {
    const now = Date.now();
    const roomId = `room_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const roomCode = this.generateUniqueCode();

    const room: ManagedRoom = {
      roomId,
      roomCode,
      hostSessionId: p1.sessionId,
      isPrivate: false,
      ruleProfileId: options.ruleProfileId,
      calledShotsEnabled: options.calledShotsEnabled,
      status: 'ready',
      players: [
        {
          sessionId: p1.sessionId,
          playerId: p1.playerId,
          displayName: p1.displayName,
          avatarId: p1.avatarId,
          role: 'player1',
          connected: p1.connected,
          ready: true,
          latencyMs: p1.latencyMs,
          disconnectedAtMs: null,
          reconnectDeadlineMs: null,
          rematchRequested: false,
        },
        {
          sessionId: p2.sessionId,
          playerId: p2.playerId,
          displayName: p2.displayName,
          avatarId: p2.avatarId,
          role: 'player2',
          connected: p2.connected,
          ready: true,
          latencyMs: p2.latencyMs,
          disconnectedAtMs: null,
          reconnectDeadlineMs: null,
          rematchRequested: false,
        },
      ],
      createdAtMs: now,
      expiresAtMs: now + this.roomTtlMs,
      match: null,
    };

    this.rooms.set(roomId, room);
    this.codeToRoomId.set(roomCode, roomId);
    this.sessionManager.bindRoom(p1.sessionId, roomId);
    this.sessionManager.bindRoom(p2.sessionId, roomId);

    const started = await this.initializeAndStartMatch(room);
    return { room, ...started };
  }

  public joinRoomByCode(
    player: PlayerSession,
    rawCode: string,
  ): { ok: true; room: ManagedRoom } | { ok: false; code: MultiplayerErrorCode; message: string } {
    if (player.activeRoomId || player.inMatchmaking) {
      return {
        ok: false,
        code: 'ALREADY_IN_MATCH',
        message: 'Leave your current room or queue before joining another room.',
      };
    }

    const normalizedCode = rawCode.trim().toUpperCase();
    const roomId = this.codeToRoomId.get(normalizedCode);
    if (!roomId) {
      return {
        ok: false,
        code: 'INVALID_ROOM',
        message: 'Room code not found. Check the code and try again.',
      };
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      this.codeToRoomId.delete(normalizedCode);
      return {
        ok: false,
        code: 'INVALID_ROOM',
        message: 'Room no longer exists.',
      };
    }

    if (Date.now() > room.expiresAtMs || room.status === 'expired' || room.status === 'cancelled') {
      this.destroyRoom(room.roomId, 'Room expired.');
      return {
        ok: false,
        code: 'ROOM_EXPIRED',
        message: 'This room has expired or was closed by the host.',
      };
    }

    if (room.status === 'playing' || room.status === 'finished') {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Match is already underway in this private room.',
      };
    }

    if (room.players.length >= 2) {
      return {
        ok: false,
        code: 'ROOM_FULL',
        message: 'This room is already full (2/2 players).',
      };
    }

    if (room.players.some((p) => p.sessionId === player.sessionId)) {
      return { ok: true, room };
    }

    room.players.push({
      sessionId: player.sessionId,
      playerId: player.playerId,
      displayName: player.displayName,
      avatarId: player.avatarId,
      role: 'player2',
      connected: player.connected,
      ready: false,
      latencyMs: player.latencyMs,
      disconnectedAtMs: null,
      reconnectDeadlineMs: null,
      rematchRequested: false,
    });
    room.expiresAtMs = Date.now() + this.roomTtlMs;
    this.updateWaitingStatus(room);
    this.sessionManager.bindRoom(player.sessionId, room.roomId);

    this.broadcastRoomUpdate(room);
    return { ok: true, room };
  }

  public setPlayerReady(
    sessionId: string,
    ready: boolean,
  ): { ok: true; room: ManagedRoom } | { ok: false; code: MultiplayerErrorCode; message: string } {
    const room = this.getRoomBySession(sessionId);
    if (!room) {
      return { ok: false, code: 'INVALID_ROOM', message: 'You are not in a room.' };
    }
    if (room.status === 'playing') {
      return { ok: false, code: 'INVALID_INPUT', message: 'Match already started.' };
    }
    const p = room.players.find((pl) => pl.sessionId === sessionId);
    if (!p) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Not a member of this room.' };
    }
    p.ready = ready;
    this.updateWaitingStatus(room);
    this.broadcastRoomUpdate(room);
    return { ok: true, room };
  }

  public async startRoomMatch(
    hostSessionId: string,
  ): Promise<
    | { ok: true; room: ManagedRoom; match: OnlineMatchSnapshot; balls: OnlineBallFrame[] }
    | { ok: false; code: MultiplayerErrorCode; message: string }
  > {
    const room = this.getRoomBySession(hostSessionId);
    if (!room) {
      return { ok: false, code: 'INVALID_ROOM', message: 'Room not found.' };
    }
    if (room.hostSessionId !== hostSessionId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Only the room host can start the match.',
      };
    }
    if (room.players.length < 2) {
      return {
        ok: false,
        code: 'MATCH_NOT_READY',
        message: 'Waiting for an opponent to join the room.',
      };
    }
    if (!room.players.every((p) => p.ready && p.connected)) {
      return {
        ok: false,
        code: 'MATCH_NOT_READY',
        message: 'Both players must be connected and ready before starting.',
      };
    }

    const started = await this.initializeAndStartMatch(room);
    return { ok: true, room, ...started };
  }

  public cancelRoom(
    sessionId: string,
  ): { ok: true } | { ok: false; code: MultiplayerErrorCode; message: string } {
    const room = this.getRoomBySession(sessionId);
    if (!room) {
      return { ok: false, code: 'INVALID_ROOM', message: 'Room not found.' };
    }
    if (room.hostSessionId !== sessionId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Only the host can cancel this room.',
      };
    }
    if (room.status === 'playing') {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: 'Cannot cancel an active match; use leave/forfeit instead.',
      };
    }

    this.destroyRoom(room.roomId, 'Host cancelled the room.');
    return { ok: true };
  }

  public leaveRoom(sessionId: string): void {
    const room = this.getRoomBySession(sessionId);
    if (!room) {
      this.sessionManager.bindRoom(sessionId, null);
      return;
    }

    const leaving = room.players.find((p) => p.sessionId === sessionId);
    this.sessionManager.bindRoom(sessionId, null);

    if (!leaving) return;

    if (room.status === 'playing' && room.match && room.match.getPhase() !== 'GAME_OVER') {
      room.match.forfeit(
        leaving.role,
        `${leaving.displayName} left the match.`,
      );
      room.status = 'finished';
    }

    if (room.status === 'waiting' || room.status === 'ready') {
      if (room.hostSessionId === sessionId || room.players.length <= 1) {
        this.destroyRoom(room.roomId, `${leaving.displayName} closed the room.`);
        return;
      }
      room.players = room.players.filter((p) => p.sessionId !== sessionId);
      this.updateWaitingStatus(room);
      this.broadcastRoomUpdate(room);
      return;
    }

    // Finished room: remove leaving player and clean up if empty
    room.players = room.players.filter((p) => p.sessionId !== sessionId);
    if (room.players.length === 0) {
      this.destroyRoom(room.roomId, 'All players left the match.');
    } else {
      this.broadcastRoomUpdate(room);
    }
  }

  public async requestRematch(
    sessionId: string,
  ): Promise<
    | { ok: true; started: boolean; room: ManagedRoom }
    | { ok: false; code: MultiplayerErrorCode; message: string }
  > {
    const room = this.getRoomBySession(sessionId);
    if (!room || !room.match) {
      return { ok: false, code: 'INVALID_ROOM', message: 'No finished match found for rematch.' };
    }
    if (room.match.getPhase() !== 'GAME_OVER') {
      return {
        ok: false,
        code: 'MATCH_NOT_READY',
        message: 'Rematch is only available after the current match finishes.',
      };
    }
    const player = room.players.find((p) => p.sessionId === sessionId);
    if (!player) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Not in this room.' };
    }
    if (room.players.length < 2) {
      return {
        ok: false,
        code: 'MATCH_NOT_READY',
        message: 'Opponent has already left the room.',
      };
    }

    player.rematchRequested = true;
    const voteRes = room.match.voteRematch(player.role);

    if (voteRes.bothReady) {
      for (const p of room.players) {
        p.rematchRequested = false;
        p.ready = true;
      }
      room.status = 'playing';
      room.match.resetForNewMatch();
      const snapshot = room.match.getSnapshot();
      const balls = room.match.physics.getBallFrames();
      this.broadcastToRoom(room, {
        type: 'match:rematch_started',
        room: this.toRoomInfo(room),
        match: snapshot,
        balls,
      });
      return { ok: true, started: true, room };
    }

    this.broadcastRoomUpdate(room);
    this.broadcastStateSync(room);
    return { ok: true, started: false, room };
  }

  public syncPlayerProfileInRoom(session: PlayerSession): void {
    const room = this.getRoomBySession(session.sessionId);
    if (!room) return;
    const entry = room.players.find((p) => p.sessionId === session.sessionId);
    if (!entry) return;
    entry.displayName = session.displayName;
    entry.avatarId = session.avatarId;
    entry.latencyMs = session.latencyMs;
    if (room.match && room.players.length === 2) {
      const p1 = room.players.find((p) => p.role === 'player1');
      const p2 = room.players.find((p) => p.role === 'player2');
      if (p1 && p2) {
        room.match.updatePlayerNames(p1.displayName, p2.displayName);
      }
    }
    this.broadcastRoomUpdate(room);
  }

  public broadcastToRoom(room: ManagedRoom, payload: unknown): void {
    for (const player of room.players) {
      if (player.connected) {
        this.callbacks.sendToSession(player.sessionId, payload);
      }
    }
  }

  public broadcastRoomUpdate(room: ManagedRoom): void {
    this.broadcastToRoom(room, {
      type: 'room:updated',
      room: this.toRoomInfo(room),
    });
  }

  public broadcastStateSync(room: ManagedRoom): void {
    if (!room.match) return;
    this.broadcastToRoom(room, {
      type: 'match:state_sync',
      room: this.toRoomInfo(room),
      match: room.match.getSnapshot(),
      balls: room.match.physics.getBallFrames(),
    });
  }

  public destroyRoom(roomId: string, reason: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const p of room.players) {
      this.callbacks.sendToSession(p.sessionId, {
        type: 'room:closed',
        roomId: room.roomId,
        reason,
      });
      const sess = this.sessionManager.getSession(p.sessionId);
      if (sess?.activeRoomId === roomId) {
        this.sessionManager.bindRoom(p.sessionId, null);
      }
    }

    room.match?.dispose();
    this.codeToRoomId.delete(room.roomCode);
    this.rooms.delete(roomId);
  }

  private async initializeAndStartMatch(
    room: ManagedRoom,
  ): Promise<{ match: OnlineMatchSnapshot; balls: OnlineBallFrame[] }> {
    const p1 = room.players.find((p) => p.role === 'player1') ?? room.players[0];
    const p2 = room.players.find((p) => p.role === 'player2') ?? room.players[1];

    room.match?.dispose();
    const match = new ServerMatchManager({
      roomId: room.roomId,
      roomCode: room.roomCode,
      ruleProfileId: room.ruleProfileId,
      calledShotsEnabled: room.calledShotsEnabled,
      player1Name: p1.displayName,
      player2Name: p2.displayName,
      physicsBroadcastHz: this.physicsBroadcastHz,
      callbacks: {
        onShotStarted: (payload) => {
          this.broadcastToRoom(room, {
            type: 'match:shot_started',
            roomId: room.roomId,
            ...payload,
          });
        },
        onPhysicsFrame: (shotSeq, balls) => {
          this.broadcastToRoom(room, {
            type: 'physics:frame',
            roomId: room.roomId,
            shotSeq,
            serverTimeMs: Date.now(),
            balls,
          });
        },
        onPocket: (shotSeq, ballNumber, pocketId, order) => {
          this.broadcastToRoom(room, {
            type: 'physics:pocket',
            roomId: room.roomId,
            shotSeq,
            ballNumber,
            pocketId,
            order,
          });
        },
        onSettled: (snapshot, balls) => {
          this.broadcastToRoom(room, {
            type: 'match:settled',
            room: this.toRoomInfo(room),
            match: snapshot,
            balls,
          });
        },
        onGameOver: (snapshot, balls, historyRecord, telemetrySummary) => {
          room.status = 'finished';
          // Capture player snapshots synchronously before leave/disconnect filters room.players
          const p1Snap = room.players.find((p) => p.role === 'player1') ?? p1;
          const p2Snap = room.players.find((p) => p.role === 'player2') ?? p2;
          const roomSnapshot = this.toRoomInfo(room);
          const recipientSessionIds = room.players
            .filter((p) => p.connected)
            .map((p) => p.sessionId);

          const p1Id = p1Snap.playerId ?? p1Snap.sessionId;
          const p2Id = p2Snap.playerId ?? p2Snap.sessionId;
          const matchType = room.isPrivate ? 'private' : 'quick';

          void (async () => {
            let progression: MatchProgressionRewardSummary | undefined;
            const enrichedRecord: MatchHistoryRecord = {
              ...historyRecord,
              player1Id: p1Id,
              player2Id: p2Id,
              player1Avatar: p1Snap.avatarId,
              player2Avatar: p2Snap.avatarId,
              winnerId: historyRecord.winnerRole === 'player1' ? p1Id : p2Id,
              matchType,
            };

            if (this.progressionStore) {
              try {
                const res = await this.progressionStore.recordCompletedMatch({
                  matchId: snapshot.matchId,
                  roomId: room.roomId,
                  roomCode: room.roomCode,
                  ruleProfileId: room.ruleProfileId,
                  matchType,
                  winnerRole: historyRecord.winnerRole,
                  reason: historyRecord.reason,
                  totalShots: historyRecord.totalShots,
                  endedAtMs: historyRecord.endedAtMs,
                  player1: {
                    playerId: p1Id,
                    displayName: p1Snap.displayName,
                    avatarId: p1Snap.avatarId,
                  },
                  player2: {
                    playerId: p2Id,
                    displayName: p2Snap.displayName,
                    avatarId: p2Snap.avatarId,
                  },
                  telemetry: telemetrySummary,
                });
                progression = res.summary;
                enrichedRecord.rankedApplied = res.summary.rankedApplied;
                enrichedRecord.p1EloDelta = res.summary.players.player1.eloDelta;
                enrichedRecord.p2EloDelta = res.summary.players.player2.eloDelta;
              } catch (err) {
                console.error('[RoomManager] Failed to record local progression:', err);
              }
            }

            this.recordHistoryOnce(enrichedRecord);
            for (const sid of recipientSessionIds) {
              this.callbacks.sendToSession(sid, {
                type: 'match:over',
                room: roomSnapshot,
                match: snapshot,
                balls,
                historyRecord: enrichedRecord,
                progression,
              });
            }
          })();
        },
      },
    });

    await match.init();
    room.match = match;
    room.status = 'playing';

    const snapshot = match.getSnapshot();
    const balls = match.physics.getBallFrames();
    this.broadcastToRoom(room, {
      type: 'match:started',
      room: this.toRoomInfo(room),
      match: snapshot,
      balls,
    });
    return { match: snapshot, balls };
  }

  public recordHistoryOnce(record: MatchHistoryRecord): void {
    if (this.recordedMatchIds.has(record.matchId)) return;
    this.recordedMatchIds.add(record.matchId);
    this.totalMatchesCompleted++;
    this.history.unshift(record);
    if (this.history.length > 100) {
      this.history.length = 100;
    }
    this.callbacks.onMatchHistoryRecorded(record);
  }

  private updateWaitingStatus(room: ManagedRoom): void {
    if (room.status === 'playing' || room.status === 'finished') return;
    if (room.players.length === 2 && room.players.every((p) => p.ready && p.connected)) {
      room.status = 'ready';
    } else {
      room.status = 'waiting';
    }
  }

  private generateUniqueCode(): string {
    for (let attempt = 0; attempt < 30; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
      }
      if (!this.codeToRoomId.has(code)) return code;
    }
    return randomUUID().slice(0, 6).toUpperCase();
  }

  public pruneExpiredRooms(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (
        (room.status === 'waiting' || room.status === 'ready') &&
        now > room.expiresAtMs
      ) {
        this.destroyRoom(room.roomId, 'Room expired due to inactivity.');
      }
    }
  }

  public dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const room of this.rooms.values()) {
      room.match?.dispose();
    }
    this.rooms.clear();
    this.codeToRoomId.clear();
  }
}
