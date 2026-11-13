import type { PlayerSessionManager } from './PlayerSessionManager';
import type { RoomManager } from './RoomManager';

export class ReconnectionManager {
  private disconnectTimers = new Map<string, NodeJS.Timeout>();
  private sessionManager: PlayerSessionManager;
  private roomManager: RoomManager;
  private graceMs: number;

  constructor(options: {
    sessionManager: PlayerSessionManager;
    roomManager: RoomManager;
    graceMs: number;
  }) {
    this.sessionManager = options.sessionManager;
    this.roomManager = options.roomManager;
    this.graceMs = options.graceMs;
  }

  public handleDisconnect(sessionId: string): void {
    this.sessionManager.setConnected(sessionId, false);

    const room = this.roomManager.getRoomBySession(sessionId);
    if (!room) return;

    const player = room.players.find((p) => p.sessionId === sessionId);
    if (!player) return;

    const now = Date.now();
    const deadlineMs = now + this.graceMs;
    player.connected = false;
    player.disconnectedAtMs = now;
    player.reconnectDeadlineMs = deadlineMs;

    this.roomManager.broadcastToRoom(room, {
      type: 'opponent:disconnected',
      roomId: room.roomId,
      sessionId: player.sessionId,
      displayName: player.displayName,
      graceDeadlineMs: deadlineMs,
    });
    this.roomManager.broadcastRoomUpdate(room);

    this.clearTimer(sessionId);
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(sessionId);
      this.expireGracePeriod(sessionId, room.roomId);
    }, this.graceMs);
    this.disconnectTimers.set(sessionId, timer);
  }

  public handleReconnect(sessionId: string): void {
    this.clearTimer(sessionId);
    this.sessionManager.setConnected(sessionId, true);

    const room = this.roomManager.getRoomBySession(sessionId);
    if (!room) return;

    const player = room.players.find((p) => p.sessionId === sessionId);
    if (!player) return;

    player.connected = true;
    player.disconnectedAtMs = null;
    player.reconnectDeadlineMs = null;

    for (const other of room.players) {
      if (other.sessionId !== sessionId && other.connected) {
        this.roomManager.broadcastToRoom(room, {
          type: 'opponent:reconnected',
          roomId: room.roomId,
          sessionId: player.sessionId,
          displayName: player.displayName,
        });
        break;
      }
    }
    this.roomManager.broadcastRoomUpdate(room);
  }

  private expireGracePeriod(sessionId: string, roomId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (session?.connected) return;

    const room = this.roomManager.getRoom(roomId);
    if (!room) {
      this.sessionManager.bindRoom(sessionId, null);
      return;
    }

    const player = room.players.find((p) => p.sessionId === sessionId);
    if (!player || player.connected) return;

    if (room.status === 'playing' && room.match && room.match.getPhase() !== 'GAME_OVER') {
      room.match.forfeit(
        player.role,
        `${player.displayName} disconnected and did not reconnect in time.`,
      );
      room.status = 'finished';
      this.sessionManager.bindRoom(sessionId, null);
      room.players = room.players.filter((p) => p.sessionId !== sessionId);
      if (room.players.length === 0) {
        this.roomManager.destroyRoom(room.roomId, 'All players disconnected.');
      } else {
        this.roomManager.broadcastRoomUpdate(room);
      }
      return;
    }

    this.roomManager.leaveRoom(sessionId);
  }

  public clearTimer(sessionId: string): void {
    const t = this.disconnectTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.disconnectTimers.delete(sessionId);
    }
  }

  public dispose(): void {
    for (const t of this.disconnectTimers.values()) {
      clearTimeout(t);
    }
    this.disconnectTimers.clear();
  }
}
