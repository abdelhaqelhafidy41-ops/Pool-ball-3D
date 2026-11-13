import type { RuleProfileId } from '../src/game/rules/types';
import type { MultiplayerErrorCode } from '../src/multiplayer/shared/protocol';
import type { PlayerSessionManager } from './PlayerSessionManager';
import type { RoomManager } from './RoomManager';

export interface QueueEntry {
  sessionId: string;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  joinedAtMs: number;
  timeoutAtMs: number;
  latencyMs: number;
}

export interface MatchmakingCallbacks {
  sendToSession: (sessionId: string, payload: unknown) => void;
}

export class MatchmakingManager {
  private queue: QueueEntry[] = [];
  private sessionManager: PlayerSessionManager;
  private roomManager: RoomManager;
  private timeoutMs: number;
  private maxLatencySpreadMs: number;
  private callbacks: MatchmakingCallbacks;
  private tickTimer: NodeJS.Timeout | null = null;
  private matchingBusy = false;

  constructor(options: {
    sessionManager: PlayerSessionManager;
    roomManager: RoomManager;
    timeoutMs: number;
    maxLatencySpreadMs: number;
    callbacks: MatchmakingCallbacks;
  }) {
    this.sessionManager = options.sessionManager;
    this.roomManager = options.roomManager;
    this.timeoutMs = options.timeoutMs;
    this.maxLatencySpreadMs = options.maxLatencySpreadMs;
    this.callbacks = options.callbacks;

    this.tickTimer = setInterval(() => {
      void this.processQueue();
    }, 300);
  }

  public getQueueSize(): number {
    return this.queue.length;
  }

  public async enqueue(
    sessionId: string,
    ruleProfileId: RuleProfileId,
    calledShotsEnabled: boolean,
  ): Promise<
    | { ok: true; position: number; startedAtMs: number; timeoutAtMs: number }
    | { ok: false; code: MultiplayerErrorCode; message: string }
  > {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Invalid session.' };
    }
    if (session.activeRoomId) {
      return {
        ok: false,
        code: 'ALREADY_IN_MATCH',
        message: 'You are already in an active room or match.',
      };
    }
    if (session.inMatchmaking || this.queue.some((q) => q.sessionId === sessionId)) {
      return {
        ok: false,
        code: 'ALREADY_IN_MATCH',
        message: 'You are already searching for an opponent.',
      };
    }

    const now = Date.now();
    const entry: QueueEntry = {
      sessionId,
      ruleProfileId,
      calledShotsEnabled,
      joinedAtMs: now,
      timeoutAtMs: now + this.timeoutMs,
      latencyMs: session.latencyMs,
    };

    this.queue.push(entry);
    this.sessionManager.setMatchmaking(sessionId, true);

    this.callbacks.sendToSession(sessionId, {
      type: 'matchmaking:searching',
      position: this.queue.length,
      startedAtMs: entry.joinedAtMs,
      timeoutAtMs: entry.timeoutAtMs,
    });

    await this.processQueue();
    return {
      ok: true,
      position: this.queue.length,
      startedAtMs: entry.joinedAtMs,
      timeoutAtMs: entry.timeoutAtMs,
    };
  }

  public cancel(sessionId: string, reason = 'Matchmaking cancelled.'): boolean {
    const idx = this.queue.findIndex((q) => q.sessionId === sessionId);
    if (idx === -1) {
      this.sessionManager.setMatchmaking(sessionId, false);
      return false;
    }
    this.queue.splice(idx, 1);
    this.sessionManager.setMatchmaking(sessionId, false);
    this.callbacks.sendToSession(sessionId, {
      type: 'matchmaking:cancelled',
      reason,
    });
    return true;
  }

  public async processQueue(): Promise<void> {
    if (this.matchingBusy) return;
    this.matchingBusy = true;

    try {
      const now = Date.now();

      // 1. Prune disconnected or timed-out entries
      const remaining: QueueEntry[] = [];
      for (const entry of this.queue) {
        const sess = this.sessionManager.getSession(entry.sessionId);
        if (!sess || !sess.connected || sess.activeRoomId) {
          this.sessionManager.setMatchmaking(entry.sessionId, false);
          continue;
        }
        if (now >= entry.timeoutAtMs) {
          this.sessionManager.setMatchmaking(entry.sessionId, false);
          this.callbacks.sendToSession(entry.sessionId, {
            type: 'matchmaking:timeout',
            message: 'No opponent found before timeout. Please try again or create a private room.',
          });
          continue;
        }
        entry.latencyMs = sess.latencyMs;
        remaining.push(entry);
      }
      this.queue = remaining;

      // 2. Pair compatible real players (never synthesize fake opponents)
      while (this.queue.length >= 2) {
        let matchedPair: [number, number] | null = null;

        for (let i = 0; i < this.queue.length; i++) {
          const a = this.queue[i];
          const waitSecA = Math.max(0, (now - a.joinedAtMs) / 1000);

          for (let j = i + 1; j < this.queue.length; j++) {
            const b = this.queue[j];
            if (a.sessionId === b.sessionId) continue;

            // Prefer matching same rule profile during first 10s; afterwards allow compatible fallback
            const waitSecBoth = Math.min(waitSecA, Math.max(0, (now - b.joinedAtMs) / 1000));
            const sameRules =
              a.ruleProfileId === b.ruleProfileId &&
              a.calledShotsEnabled === b.calledShotsEnabled;
            if (!sameRules && waitSecBoth < 10) continue;

            const latencyDiff = Math.abs(a.latencyMs - b.latencyMs);
            const allowedSpread = this.maxLatencySpreadMs + waitSecBoth * 25;
            if (latencyDiff <= allowedSpread) {
              matchedPair = [i, j];
              break;
            }
          }
          if (matchedPair) break;
        }

        if (!matchedPair) break;

        const [idxA, idxB] = matchedPair;
        const entryB = this.queue.splice(idxB, 1)[0];
        const entryA = this.queue.splice(idxA, 1)[0];

        const sessA = this.sessionManager.getSession(entryA.sessionId);
        const sessB = this.sessionManager.getSession(entryB.sessionId);
        if (!sessA || !sessB || !sessA.connected || !sessB.connected) {
          if (sessA) this.sessionManager.setMatchmaking(sessA.sessionId, false);
          if (sessB) this.sessionManager.setMatchmaking(sessB.sessionId, false);
          continue;
        }

        this.sessionManager.setMatchmaking(sessA.sessionId, false);
        this.sessionManager.setMatchmaking(sessB.sessionId, false);

        const { room } = await this.roomManager.createMatchedRoom(sessA, sessB, {
          ruleProfileId: entryA.ruleProfileId,
          calledShotsEnabled: entryA.calledShotsEnabled,
        });

        const roomInfo = this.roomManager.toRoomInfo(room);
        this.callbacks.sendToSession(sessA.sessionId, {
          type: 'matchmaking:matched',
          room: roomInfo,
        });
        this.callbacks.sendToSession(sessB.sessionId, {
          type: 'matchmaking:matched',
          room: roomInfo,
        });
      }
    } finally {
      this.matchingBusy = false;
    }
  }

  public dispose(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.queue = [];
  }
}
