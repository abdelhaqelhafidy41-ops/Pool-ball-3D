import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ONLINE_AVARS_FALLBACK } from './utils';
import type { OnlineAvatarId } from '../src/multiplayer/shared/protocol';

export interface PlayerSession {
  sessionId: string;
  reconnectToken: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  latencyMs: number;
  connected: boolean;
  activeRoomId: string | null;
  inMatchmaking: boolean;
  createdAtMs: number;
  lastSeenAtMs: number;
}

export class PlayerSessionManager {
  private sessions = new Map<string, PlayerSession>();

  public sanitizeDisplayName(raw: unknown): string {
    if (typeof raw !== 'string') return 'Player';
    const cleaned = raw
      .replace(/[\u0000-\u001F\u007F<>]/g, '')
      .trim()
      .slice(0, 16);
    return cleaned.length > 0 ? cleaned : 'Player';
  }

  public sanitizeAvatarId(raw: unknown): OnlineAvatarId {
    if (typeof raw === 'string' && ONLINE_AVARS_FALLBACK.has(raw as OnlineAvatarId)) {
      return raw as OnlineAvatarId;
    }
    return 'cue_gold';
  }

  public createSession(
    displayName?: string,
    avatarId?: OnlineAvatarId,
    latencyMs = 35,
  ): PlayerSession {
    const now = Date.now();
    const session: PlayerSession = {
      sessionId: `ply_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      reconnectToken: randomBytes(24).toString('hex'),
      displayName: this.sanitizeDisplayName(displayName),
      avatarId: this.sanitizeAvatarId(avatarId),
      latencyMs: this.clampLatency(latencyMs),
      connected: true,
      activeRoomId: null,
      inMatchmaking: false,
      createdAtMs: now,
      lastSeenAtMs: now,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  public getSession(sessionId: string): PlayerSession | undefined {
    return this.sessions.get(sessionId);
  }

  public verifyReconnect(sessionId: string, reconnectToken: string): PlayerSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (
      typeof reconnectToken !== 'string' ||
      reconnectToken.length !== session.reconnectToken.length
    ) {
      return null;
    }
    const a = Buffer.from(reconnectToken, 'utf8');
    const b = Buffer.from(session.reconnectToken, 'utf8');
    if (!timingSafeEqual(a, b)) return null;
    session.connected = true;
    session.lastSeenAtMs = Date.now();
    return session;
  }

  public updateProfile(
    sessionId: string,
    displayName: unknown,
    avatarId: unknown,
  ): PlayerSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.displayName = this.sanitizeDisplayName(displayName);
    session.avatarId = this.sanitizeAvatarId(avatarId);
    session.lastSeenAtMs = Date.now();
    return session;
  }

  public updateLatency(sessionId: string, latencyMs: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.latencyMs = this.clampLatency(latencyMs);
    session.lastSeenAtMs = Date.now();
  }

  public setConnected(sessionId: string, connected: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.connected = connected;
    session.lastSeenAtMs = Date.now();
  }

  public bindRoom(sessionId: string, roomId: string | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeRoomId = roomId;
    if (roomId !== null) {
      session.inMatchmaking = false;
    }
  }

  public setMatchmaking(sessionId: string, active: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.inMatchmaking = active;
  }

  public removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  public getConnectedCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.connected) count++;
    }
    return count;
  }

  private clampLatency(ms: unknown): number {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 35;
    return Math.max(1, Math.min(2000, Math.round(ms)));
  }
}
