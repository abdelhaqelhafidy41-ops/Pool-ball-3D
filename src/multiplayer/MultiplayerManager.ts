import type { PlayerId, PocketId, RuleProfileId } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import { useGameStore } from '../store/useGameStore';
import { NetworkManager, resolveHttpBaseUrl } from './NetworkManager';
import { StateSynchronizer } from './StateSynchronizer';
import type {
  MatchHistoryRecord,
  OnlineBallFrame,
  OnlineMatchSnapshot,
  OnlineRoomInfo,
  ServerToClientMessage,
} from './shared/protocol';

export interface MultiplayerSceneBridge {
  onApplyAuthoritativeBalls: (balls: OnlineBallFrame[]) => void;
  onRemoteShotStarted: (payload: {
    shotSeq: number;
    shooter: PlayerId;
    cueAngle: number;
    power: number;
    spinX: number;
    spinY: number;
  }) => void;
  onRemoteAimPreview: (cueAngle: number) => void;
  onRemoteSpinPreview: (x: number, y: number) => void;
  onOnlineMatchEntered: (snapshot: OnlineMatchSnapshot, balls: OnlineBallFrame[]) => void;
  onOnlineMatchExited: () => void;
}

class MultiplayerManagerImpl {
  private network: NetworkManager;
  public readonly synchronizer = new StateSynchronizer();
  private sceneBridge: MultiplayerSceneBridge | null = null;

  private lastAimSentAt = 0;
  private lastSpinSentAt = 0;
  private lastPlaceSentAt = 0;

  constructor() {
    this.network = new NetworkManager(
      {
        onConnectionChange: (state) => {
          useGameStore.getState().setOnlineConnectionStatus(state);
        },
        onLatencyUpdate: (latencyMs) => {
          useGameStore.getState().setOnlineLatencyMs(latencyMs);
        },
        onMessage: (msg) => this.handleServerMessage(msg),
      },
      () => useGameStore.getState().onlineProfile,
    );
  }

  public attachSceneBridge(bridge: MultiplayerSceneBridge | null): void {
    this.sceneBridge = bridge;
  }

  public ensureConnected(): void {
    this.network.connect();
  }

  public disconnect(): void {
    this.network.disconnect();
  }

  public updateProfile(displayName: string, avatarId: ReturnType<typeof useGameStore.getState>['onlineProfile']['avatarId']): void {
    const store = useGameStore.getState();
    store.setOnlineProfile({ displayName, avatarId });
    this.network.send({
      type: 'session:update_profile',
      displayName,
      avatarId,
    });
  }

  public createPrivateRoom(ruleProfileId: RuleProfileId, calledShotsEnabled: boolean): void {
    this.ensureConnected();
    useGameStore.getState().setOnlineError(null);
    this.network.send({
      type: 'room:create',
      isPrivate: true,
      ruleProfileId,
      calledShotsEnabled,
    });
  }

  public joinRoom(roomCode: string): void {
    this.ensureConnected();
    useGameStore.getState().setOnlineError(null);
    this.network.send({
      type: 'room:join',
      roomCode: roomCode.trim().toUpperCase(),
    });
  }

  public setReady(ready: boolean): void {
    this.network.send({
      type: 'room:ready',
      ready,
    });
  }

  public startRoomMatch(): void {
    useGameStore.getState().setOnlineError(null);
    this.network.send({ type: 'room:start' });
  }

  public cancelRoom(): void {
    this.network.send({ type: 'room:cancel' });
  }

  public startQuickMatch(ruleProfileId: RuleProfileId, calledShotsEnabled: boolean): void {
    this.ensureConnected();
    const store = useGameStore.getState();
    store.setOnlineError(null);
    store.setOnlineMatchmaking({ timedOutMessage: null });
    this.network.send({
      type: 'matchmaking:join',
      ruleProfileId,
      calledShotsEnabled,
    });
  }

  public cancelQuickMatch(): void {
    useGameStore.getState().setOnlineMatchmaking({ active: false });
    this.network.send({ type: 'matchmaking:cancel' });
  }

  public leaveMatchOrRoom(): void {
    const store = useGameStore.getState();
    this.network.send({ type: 'room:leave' });
    this.synchronizer.reset();
    store.clearOnlineMatchSession();
    if (store.screen === 'playing') {
      store.setScreen('menu');
    }
    this.sceneBridge?.onOnlineMatchExited();
  }

  public requestRematch(): void {
    this.network.send({ type: 'room:rematch' });
  }

  public requestSync(): void {
    this.network.send({ type: 'game:request_sync' });
  }

  public sendAimPreview(cueAngle: number): void {
    const now = performance.now();
    if (now - this.lastAimSentAt < 65) return;
    this.lastAimSentAt = now;
    this.network.send({ type: 'game:aim', cueAngle });
  }

  public sendSpinPreview(x: number, y: number): void {
    const now = performance.now();
    if (now - this.lastSpinSentAt < 80) return;
    this.lastSpinSentAt = now;
    this.network.send({ type: 'game:spin', x, y });
  }

  public sendCalledShot(targetBall: number | null, targetPocket: PocketId | null): void {
    this.network.send({
      type: 'game:called_shot',
      targetBall,
      targetPocket,
    });
  }

  public sendCuePlacement(x: number, z: number, confirm: boolean): void {
    const now = performance.now();
    if (!confirm && now - this.lastPlaceSentAt < 55) return;
    this.lastPlaceSentAt = now;
    this.network.send({
      type: 'game:place_cue',
      x,
      z,
      confirm,
    });
  }

  public sendShot(params: {
    cueAngle: number;
    power: number;
    spinX: number;
    spinY: number;
    calledBall: number | null;
    calledPocket: PocketId | null;
  }): boolean {
    const shotToken =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `shot_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    return this.network.send({
      type: 'game:shoot',
      shotToken,
      cueAngle: params.cueAngle,
      power: params.power,
      spinX: params.spinX,
      spinY: params.spinY,
      calledBall: params.calledBall,
      calledPocket: params.calledPocket,
    });
  }

  public async fetchOnlineHistory(): Promise<MatchHistoryRecord[]> {
    try {
      const loc = typeof window !== 'undefined' ? window.location : undefined;
      const baseUrl = resolveHttpBaseUrl(import.meta.env.VITE_WS_URL, loc);
      const res = await fetch(`${baseUrl}/api/online/history`);
      if (!res.ok) return [];
      const json = (await res.json()) as { history?: MatchHistoryRecord[] };
      const list = Array.isArray(json.history) ? json.history : [];
      useGameStore.getState().setOnlineHistory(list);
      return list;
    } catch {
      return [];
    }
  }

  private resolveLocalRole(room: OnlineRoomInfo | null): PlayerId | null {
    const sid = useGameStore.getState().onlineSessionId;
    if (!room || !sid) return useGameStore.getState().onlineLocalRole;
    return room.players.find((p) => p.sessionId === sid)?.role ?? null;
  }

  private handleServerMessage(msg: ServerToClientMessage): void {
    const store = useGameStore.getState();

    switch (msg.type) {
      case 'session:ready': {
        store.setOnlineSessionId(msg.sessionId);
        store.setOnlineError(null);

        if (msg.resumedRoom) {
          const role =
            msg.resumedRoom.players.find((p) => p.sessionId === msg.sessionId)?.role ?? null;
          store.setOnlineRoom(msg.resumedRoom);

          if (msg.resumedMatch && msg.balls) {
            this.synchronizer.applySettledState(msg.balls);
            store.syncFromOnlineMatchSnapshot(msg.resumedMatch, role);
            store.closeOnlineLobby();
            store.setScreen('playing');
            this.sceneBridge?.onOnlineMatchEntered(msg.resumedMatch, msg.balls);
          }
        }
        break;
      }

      case 'error': {
        store.setOnlineError({ code: msg.code, message: msg.message });
        if (msg.code === 'ALREADY_IN_MATCH' || msg.code === 'MATCHMAKING_TIMEOUT') {
          store.setOnlineMatchmaking({ active: false });
        }
        break;
      }

      case 'room:created':
      case 'room:updated': {
        store.setOnlineRoom(msg.room);
        store.setOnlineError(null);
        break;
      }

      case 'room:closed': {
        const wasPlaying = store.screen === 'playing' && store.matchConfig.opponentType === 'online';
        this.synchronizer.reset();
        store.clearOnlineMatchSession();
        store.setOnlineError({ code: 'ROOM_EXPIRED', message: msg.reason });
        if (wasPlaying) {
          store.setScreen('menu');
          store.openOnlineLobby('create');
        }
        this.sceneBridge?.onOnlineMatchExited();
        break;
      }

      case 'matchmaking:searching': {
        store.setOnlineMatchmaking({
          active: true,
          position: msg.position,
          startedAtMs: msg.startedAtMs,
          timeoutAtMs: msg.timeoutAtMs,
          timedOutMessage: null,
        });
        break;
      }

      case 'matchmaking:matched': {
        store.setOnlineMatchmaking({
          active: false,
          timedOutMessage: null,
        });
        store.setOnlineRoom(msg.room);
        soundEngine.playUiClick();
        break;
      }

      case 'matchmaking:cancelled': {
        store.setOnlineMatchmaking({ active: false });
        break;
      }

      case 'matchmaking:timeout': {
        store.setOnlineMatchmaking({
          active: false,
          timedOutMessage: msg.message,
        });
        break;
      }

      case 'match:started':
      case 'match:rematch_started': {
        const role = this.resolveLocalRole(msg.room);
        this.synchronizer.reset();
        this.synchronizer.applySettledState(msg.balls);
        store.setOnlineRoom(msg.room);
        store.setOnlineOpponentStatus({
          state: 'connected',
          displayName: null,
          graceDeadlineMs: null,
        });
        store.resetMatchStats();
        store.syncFromOnlineMatchSnapshot(msg.match, role);
        store.closeOnlineLobby();
        store.setScreen('playing');
        this.sceneBridge?.onOnlineMatchEntered(msg.match, msg.balls);
        break;
      }

      case 'match:shot_started': {
        this.synchronizer.beginShot(msg.shotSeq);
        store.setBallsMoving(true);
        soundEngine.playCueStrike(msg.power);
        this.sceneBridge?.onRemoteShotStarted({
          shotSeq: msg.shotSeq,
          shooter: msg.shooter,
          cueAngle: msg.cueAngle,
          power: msg.power,
          spinX: msg.spinX,
          spinY: msg.spinY,
        });
        break;
      }

      case 'physics:frame': {
        this.synchronizer.pushFrame(msg.shotSeq, msg.balls);
        break;
      }

      case 'physics:pocket': {
        if (this.synchronizer.markPocketEvent(msg.shotSeq, msg.ballNumber, msg.pocketId)) {
          store.addPocketedBall(msg.ballNumber);
        }
        break;
      }

      case 'match:settled': {
        const role = this.resolveLocalRole(msg.room);
        this.synchronizer.applySettledState(msg.balls);
        store.setOnlineRoom(msg.room);
        store.syncFromOnlineMatchSnapshot(msg.match, role);
        this.sceneBridge?.onApplyAuthoritativeBalls(msg.balls);
        break;
      }

      case 'match:state_sync': {
        const role = this.resolveLocalRole(msg.room);
        this.synchronizer.applySettledState(msg.balls);
        store.setOnlineRoom(msg.room);
        store.syncFromOnlineMatchSnapshot(msg.match, role);
        this.sceneBridge?.onApplyAuthoritativeBalls(msg.balls);
        break;
      }

      case 'match:over': {
        const role = this.resolveLocalRole(msg.room);
        this.synchronizer.applySettledState(msg.balls);
        store.setOnlineRoom(msg.room);
        store.syncFromOnlineMatchSnapshot(msg.match, role, msg.historyRecord);
        this.sceneBridge?.onApplyAuthoritativeBalls(msg.balls);
        break;
      }

      case 'match:aim_preview': {
        if (msg.player !== store.onlineLocalRole) {
          this.sceneBridge?.onRemoteAimPreview(msg.cueAngle);
        }
        break;
      }

      case 'match:spin_preview': {
        if (msg.player !== store.onlineLocalRole) {
          this.sceneBridge?.onRemoteSpinPreview(msg.x, msg.y);
        }
        break;
      }

      case 'opponent:disconnected': {
        store.setOnlineOpponentStatus({
          state: 'disconnected',
          displayName: msg.displayName,
          graceDeadlineMs: msg.graceDeadlineMs,
        });
        break;
      }

      case 'opponent:reconnected': {
        store.setOnlineOpponentStatus({
          state: 'reconnected',
          displayName: msg.displayName,
          graceDeadlineMs: null,
        });
        window.setTimeout(() => {
          const cur = useGameStore.getState();
          if (cur.onlineOpponentStatus.state === 'reconnected') {
            cur.setOnlineOpponentStatus({
              state: 'connected',
              displayName: msg.displayName,
              graceDeadlineMs: null,
            });
          }
        }, 3000);
        break;
      }
    }
  }
}

export const multiplayerManager = new MultiplayerManagerImpl();
