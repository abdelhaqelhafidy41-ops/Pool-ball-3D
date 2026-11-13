import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { PlayerId, PocketId, RuleProfileId } from '../src/game/rules/types';
import {
  type ClientToServerMessage,
  type MultiplayerErrorCode,
  type OnlineAvatarId,
  type ServerToClientMessage,
} from '../src/multiplayer/shared/protocol';
import { isOriginAllowed, type ServerConfig } from './config';
import { LocalProgressionStore } from './LocalProgressionStore';
import { MatchmakingManager } from './MatchmakingManager';
import { PlayerSessionManager } from './PlayerSessionManager';
import { ReconnectionManager } from './ReconnectionManager';
import { RoomManager } from './RoomManager';

interface SocketMeta {
  ws: WebSocket;
  sessionId: string | null;
  isAlive: boolean;
  rateTimestamps: number[];
}

export class SocketController {
  public readonly wss: WebSocketServer;
  public readonly progressionStore: LocalProgressionStore;
  public readonly sessionManager: PlayerSessionManager;
  public readonly roomManager: RoomManager;
  public readonly matchmakingManager: MatchmakingManager;
  public readonly reconnectionManager: ReconnectionManager;

  private config: ServerConfig;
  private socketToMeta = new Map<WebSocket, SocketMeta>();
  private sessionToSocket = new Map<string, WebSocket>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private upgradeHandler: (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void;
  private httpServer: HttpServer;

  constructor(httpServer: HttpServer, config: ServerConfig) {
    this.httpServer = httpServer;
    this.config = config;

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 32768,
    });

    this.progressionStore = new LocalProgressionStore();
    this.sessionManager = new PlayerSessionManager();
    this.roomManager = new RoomManager({
      sessionManager: this.sessionManager,
      progressionStore: this.progressionStore,
      roomTtlMs: config.roomTtlMs,
      physicsBroadcastHz: config.physicsBroadcastHz,
      callbacks: {
        sendToSession: (sessionId, payload) => this.sendToSession(sessionId, payload as ServerToClientMessage),
        onMatchHistoryRecorded: () => {
          // History stored on RoomManager and LocalProgressionStore
        },
      },
    });
    this.matchmakingManager = new MatchmakingManager({
      sessionManager: this.sessionManager,
      roomManager: this.roomManager,
      timeoutMs: config.matchmakingTimeoutMs,
      maxLatencySpreadMs: config.maxLatencySpreadMs,
      callbacks: {
        sendToSession: (sessionId, payload) => this.sendToSession(sessionId, payload as ServerToClientMessage),
      },
    });
    this.reconnectionManager = new ReconnectionManager({
      sessionManager: this.sessionManager,
      roomManager: this.roomManager,
      graceMs: config.reconnectGraceMs,
    });

    this.wss.on('connection', (ws) => this.onConnection(ws));

    this.upgradeHandler = (req, socket, head) => {
      const urlPath = (req.url || '').split('?')[0];
      if (urlPath !== '/ws') {
        return; // Allow Vite HMR or other upgrade listeners to handle non-/ws paths
      }
      const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      if (
        !isOriginAllowed(rawOrigin, this.config.corsOrigin, {
          allowDevLocalhost: process.env.NODE_ENV !== 'production',
        })
      ) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    };
    this.httpServer.on('upgrade', this.upgradeHandler);

    this.heartbeatTimer = setInterval(() => {
      for (const [ws, meta] of this.socketToMeta) {
        if (!meta.isAlive) {
          ws.terminate();
          continue;
        }
        meta.isAlive = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, config.wsHeartbeatMs);
  }

  public sendToSession(sessionId: string, msg: ServerToClientMessage): void {
    const ws = this.sessionToSocket.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private sendSocket(ws: WebSocket, msg: ServerToClientMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private sendError(ws: WebSocket, code: MultiplayerErrorCode, message: string): void {
    this.sendSocket(ws, { type: 'error', code, message });
  }

  private onConnection(ws: WebSocket): void {
    const meta: SocketMeta = {
      ws,
      sessionId: null,
      isAlive: true,
      rateTimestamps: [],
    };
    this.socketToMeta.set(ws, meta);

    ws.on('pong', () => {
      meta.isAlive = true;
    });

    ws.on('message', (data) => {
      meta.isAlive = true;
      if (!this.checkRateLimit(meta)) {
        this.sendError(ws, 'RATE_LIMITED', 'Too many requests. Please slow down.');
        return;
      }

      let parsed: unknown;
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        parsed = JSON.parse(text);
      } catch {
        this.sendError(ws, 'INVALID_INPUT', 'Malformed JSON payload.');
        return;
      }

      if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
        this.sendError(ws, 'INVALID_INPUT', 'Missing message type.');
        return;
      }

      void this.handleMessage(ws, meta, parsed as ClientToServerMessage);
    });

    ws.on('close', () => {
      this.socketToMeta.delete(ws);
      if (meta.sessionId) {
        const activeSocket = this.sessionToSocket.get(meta.sessionId);
        if (activeSocket === ws) {
          this.sessionToSocket.delete(meta.sessionId);
          this.matchmakingManager.cancel(meta.sessionId, 'Disconnected from queue.');
          this.reconnectionManager.handleDisconnect(meta.sessionId);
        }
      }
    });

    ws.on('error', () => {
      // Handled cleanly by close
    });
  }

  private checkRateLimit(meta: SocketMeta): boolean {
    const now = Date.now();
    const cutoff = now - 1000;
    while (meta.rateTimestamps.length > 0 && meta.rateTimestamps[0] < cutoff) {
      meta.rateTimestamps.shift();
    }
    if (meta.rateTimestamps.length >= this.config.rateLimitMaxMsgPerSec) {
      return false;
    }
    meta.rateTimestamps.push(now);
    return true;
  }

  private async handleMessage(
    ws: WebSocket,
    meta: SocketMeta,
    msg: ClientToServerMessage,
  ): Promise<void> {
    if (msg.type === 'ping') {
      if (meta.sessionId && typeof msg.latencyMs === 'number') {
        this.sessionManager.updateLatency(meta.sessionId, msg.latencyMs);
      }
      this.sendSocket(ws, {
        type: 'pong',
        clientTimeMs: typeof msg.clientTimeMs === 'number' ? msg.clientTimeMs : Date.now(),
        serverTimeMs: Date.now(),
      });
      return;
    }

    if (msg.type === 'session:init') {
      const auth = await this.progressionStore.authenticateOrCreatePlayer({
        playerId: msg.playerId,
        playerToken: msg.playerToken,
        displayName: msg.displayName,
        avatarId: msg.avatarId,
      });
      const sess = this.sessionManager.createSession(
        auth.profile.displayName,
        auth.profile.avatarId as OnlineAvatarId,
        msg.latencyMs,
        auth.playerId,
      );
      meta.sessionId = sess.sessionId;
      this.sessionToSocket.set(sess.sessionId, ws);

      this.sendSocket(ws, {
        type: 'session:ready',
        sessionId: sess.sessionId,
        reconnectToken: sess.reconnectToken,
        playerId: auth.playerId,
        playerToken: auth.playerToken,
        displayName: sess.displayName,
        avatarId: sess.avatarId,
        resumedRoom: null,
        resumedMatch: null,
        balls: null,
        serverTimeMs: Date.now(),
      });
      return;
    }

    if (msg.type === 'session:resume') {
      const verified = this.sessionManager.verifyReconnect(
        msg.sessionId,
        msg.reconnectToken,
      );
      if (!verified) {
        const auth = await this.progressionStore.authenticateOrCreatePlayer({
          playerId: msg.playerId,
          playerToken: msg.playerToken,
          displayName: msg.displayName,
          avatarId: msg.avatarId,
        });
        const fresh = this.sessionManager.createSession(
          auth.profile.displayName,
          auth.profile.avatarId as OnlineAvatarId,
          35,
          auth.playerId,
        );
        meta.sessionId = fresh.sessionId;
        this.sessionToSocket.set(fresh.sessionId, ws);
        this.sendSocket(ws, {
          type: 'session:ready',
          sessionId: fresh.sessionId,
          reconnectToken: fresh.reconnectToken,
          playerId: auth.playerId,
          playerToken: auth.playerToken,
          displayName: fresh.displayName,
          avatarId: fresh.avatarId,
          resumedRoom: null,
          resumedMatch: null,
          balls: null,
          serverTimeMs: Date.now(),
        });
        return;
      }

      if (msg.playerId && msg.playerToken) {
        const auth = await this.progressionStore.authenticateOrCreatePlayer({
          playerId: msg.playerId,
          playerToken: msg.playerToken,
          displayName: msg.displayName ?? verified.displayName,
          avatarId: msg.avatarId ?? verified.avatarId,
        });
        this.sessionManager.setPlayerIdentity(
          verified.sessionId,
          auth.playerId,
          auth.profile.displayName,
          auth.profile.avatarId as OnlineAvatarId,
        );
      } else if (msg.displayName || msg.avatarId) {
        this.sessionManager.updateProfile(
          verified.sessionId,
          msg.displayName ?? verified.displayName,
          msg.avatarId ?? verified.avatarId,
        );
      }

      // Close previous stale socket if still open
      const oldWs = this.sessionToSocket.get(verified.sessionId);
      if (oldWs && oldWs !== ws && oldWs.readyState === WebSocket.OPEN) {
        oldWs.close(4001, 'Replaced by resumed session');
      }

      meta.sessionId = verified.sessionId;
      this.sessionToSocket.set(verified.sessionId, ws);
      this.reconnectionManager.handleReconnect(verified.sessionId);

      const room = this.roomManager.getRoomBySession(verified.sessionId);
      this.sendSocket(ws, {
        type: 'session:ready',
        sessionId: verified.sessionId,
        reconnectToken: verified.reconnectToken,
        playerId: verified.playerId,
        displayName: verified.displayName,
        avatarId: verified.avatarId,
        resumedRoom: room ? this.roomManager.toRoomInfo(room) : null,
        resumedMatch: room?.match ? room.match.getSnapshot() : null,
        balls: room?.match ? room.match.physics.getBallFrames() : null,
        serverTimeMs: Date.now(),
      });
      return;
    }

    // All remaining messages require an initialized session
    if (!meta.sessionId) {
      this.sendError(ws, 'UNAUTHORIZED', 'Initialize session first.');
      return;
    }
    const session = this.sessionManager.getSession(meta.sessionId);
    if (!session) {
      this.sendError(ws, 'UNAUTHORIZED', 'Session expired or invalid.');
      return;
    }

    switch (msg.type) {
      case 'session:update_profile': {
        this.sessionManager.updateProfile(session.sessionId, msg.displayName, msg.avatarId);
        void this.progressionStore.updateProfileInternal(
          session.playerId,
          session.displayName,
          session.avatarId,
        );
        this.roomManager.syncPlayerProfileInRoom(session);
        break;
      }

      case 'room:create': {
        const ruleProfileId: RuleProfileId = msg.ruleProfileId === 'wpa' ? 'wpa' : 'casual';
        const calledShotsEnabled = Boolean(msg.calledShotsEnabled);
        const res = this.roomManager.createRoom(session, {
          isPrivate: msg.isPrivate !== false,
          ruleProfileId,
          calledShotsEnabled,
        });
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
          return;
        }
        this.sendSocket(ws, {
          type: 'room:created',
          room: this.roomManager.toRoomInfo(res.room),
        });
        break;
      }

      case 'room:join': {
        if (typeof msg.roomCode !== 'string' || msg.roomCode.trim().length < 4) {
          this.sendError(ws, 'INVALID_ROOM', 'Enter a valid 6-character room code.');
          return;
        }
        const res = this.roomManager.joinRoomByCode(session, msg.roomCode);
        if (!res.ok) {
          this.sendError(ws, res.code, res.message);
          return;
        }
        this.sendSocket(ws, {
          type: 'room:updated',
          room: this.roomManager.toRoomInfo(res.room),
        });
        break;
      }

      case 'room:ready': {
        const res = this.roomManager.setPlayerReady(session.sessionId, Boolean(msg.ready));
        if (!res.ok) this.sendError(ws, res.code, res.message);
        break;
      }

      case 'room:start': {
        const res = await this.roomManager.startRoomMatch(session.sessionId);
        if (!res.ok) this.sendError(ws, res.code, res.message);
        break;
      }

      case 'room:cancel': {
        const res = this.roomManager.cancelRoom(session.sessionId);
        if (!res.ok) this.sendError(ws, res.code, res.message);
        break;
      }

      case 'room:leave': {
        this.reconnectionManager.clearTimer(session.sessionId);
        this.roomManager.leaveRoom(session.sessionId);
        break;
      }

      case 'room:rematch': {
        const res = await this.roomManager.requestRematch(session.sessionId);
        if (!res.ok) this.sendError(ws, res.code, res.message);
        break;
      }

      case 'matchmaking:join': {
        const ruleProfileId: RuleProfileId = msg.ruleProfileId === 'wpa' ? 'wpa' : 'casual';
        const res = await this.matchmakingManager.enqueue(
          session.sessionId,
          ruleProfileId,
          Boolean(msg.calledShotsEnabled),
        );
        if (!res.ok) this.sendError(ws, res.code, res.message);
        break;
      }

      case 'matchmaking:cancel': {
        this.matchmakingManager.cancel(session.sessionId);
        break;
      }

      case 'game:aim':
      case 'game:spin':
      case 'game:called_shot':
      case 'game:place_cue':
      case 'game:shoot':
      case 'game:forfeit':
      case 'game:request_sync': {
        this.handleGameplayMessage(ws, session.sessionId, msg);
        break;
      }

      default:
        this.sendError(ws, 'INVALID_INPUT', 'Unsupported message type.');
    }
  }

  private handleGameplayMessage(
    ws: WebSocket,
    sessionId: string,
    msg: ClientToServerMessage,
  ): void {
    const room = this.roomManager.getRoomBySession(sessionId);
    if (!room || !room.match) {
      this.sendError(ws, 'INVALID_ROOM', 'No active online match found.');
      return;
    }

    const playerEntry = room.players.find((p) => p.sessionId === sessionId);
    if (!playerEntry) {
      this.sendError(ws, 'UNAUTHORIZED', 'You are not a participant in this match.');
      return;
    }

    const role: PlayerId = playerEntry.role;
    const match = room.match;

    if (msg.type === 'game:request_sync') {
      this.sendSocket(ws, {
        type: 'match:state_sync',
        room: this.roomManager.toRoomInfo(room),
        match: match.getSnapshot(),
        balls: match.physics.getBallFrames(),
      });
      return;
    }

    if (msg.type === 'game:forfeit') {
      match.forfeit(role, `${playerEntry.displayName} forfeited the match.`);
      room.status = 'finished';
      this.roomManager.broadcastRoomUpdate(room);
      return;
    }

    if (msg.type === 'game:aim') {
      if (role !== match.getActivePlayer() || !Number.isFinite(msg.cueAngle)) return;
      for (const other of room.players) {
        if (other.sessionId !== sessionId && other.connected) {
          this.sendToSession(other.sessionId, {
            type: 'match:aim_preview',
            roomId: room.roomId,
            player: role,
            cueAngle: msg.cueAngle,
          });
        }
      }
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
      for (const other of room.players) {
        if (other.sessionId !== sessionId && other.connected) {
          this.sendToSession(other.sessionId, {
            type: 'match:spin_preview',
            roomId: room.roomId,
            player: role,
            x: msg.x,
            y: msg.y,
          });
        }
      }
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
      this.roomManager.broadcastStateSync(room);
      return;
    }

    if (msg.type === 'game:place_cue') {
      const res = match.handleCuePlacement(role, msg.x, msg.z, Boolean(msg.confirm));
      if (!res.ok) {
        this.sendError(ws, res.code, res.message);
        return;
      }
      this.roomManager.broadcastToRoom(room, {
        type: 'match:state_sync',
        room: this.roomManager.toRoomInfo(room),
        match: res.snapshot,
        balls: res.balls,
      });
      return;
    }

    if (msg.type === 'game:shoot') {
      const res = match.handleShot(role, {
        shotToken: msg.shotToken,
        cueAngle: msg.cueAngle,
        power: msg.power,
        spinX: msg.spinX,
        spinY: msg.spinY,
        calledBall: msg.calledBall,
        calledPocket: msg.calledPocket,
      });
      if (!res.ok) {
        this.sendError(ws, res.code, res.message);
      }
    }
  }

  public dispose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.httpServer.off('upgrade', this.upgradeHandler);
    for (const ws of this.socketToMeta.keys()) {
      ws.terminate();
    }
    this.socketToMeta.clear();
    this.sessionToSocket.clear();
    this.matchmakingManager.dispose();
    this.reconnectionManager.dispose();
    this.roomManager.dispose();
    this.wss.close();
  }
}
