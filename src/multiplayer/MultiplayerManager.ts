import type { PlayerId, PocketId, RuleProfileId } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import { useGameStore } from '../store/useGameStore';
import { NetworkManager, resolveHttpBaseUrl } from './NetworkManager';
import { getStoredPlayerIdentity, progressionClient } from './ProgressionClient';
import { StateSynchronizer } from './StateSynchronizer';
import { tournamentClient } from './TournamentClient';
import type { OnlineMatchType } from './shared/progression';
import type {
  MatchHistoryRecord,
  OnlineBallFrame,
  OnlineMatchSnapshot,
  OnlineRoomInfo,
  ServerToClientMessage,
  SpectatableMatchSummary,
} from './shared/protocol';
import type {
  FriendRequestAction,
  ManualPresenceStatus,
  MatchInviteAction,
  PrivacySettings,
  RoomChatMessageRecord,
} from './shared/social';
import { clubLeagueClient } from './ClubLeagueClient';
import { socialClient } from './SocialClient';

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
  onOnlineShotFrame?: (balls: OnlineBallFrame[]) => void;
  onOnlinePocketEvent?: (ballNumber: number, pocketId: PocketId) => void;
  onOnlineShotSettled?: (snapshot: OnlineMatchSnapshot, balls: OnlineBallFrame[]) => void;
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
        onConnectionError: (message) => {
          useGameStore.getState().setOnlineError({
            code: 'CONNECTION_FAILED',
            message,
          });
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

  public retryConnection(): void {
    useGameStore.getState().setOnlineError(null);
    this.network.retryConnect();
  }

  public disconnect(): void {
    this.network.disconnect();
  }

  public reauthenticateSocketIdentity(): void {
    this.network.clearSessionCredentials();
    useGameStore.getState().resetSocialState();
    void import('./EconomyClient').then(({ economyClient }) => economyClient.refreshWallet());
    const state = this.network.getConnectionState();
    if (state === 'connected' || state === 'connecting' || state === 'reconnecting') {
      this.network.retryConnect();
    }
  }

  public updateProfile(
    displayName: string,
    avatarId: ReturnType<typeof useGameStore.getState>['onlineProfile']['avatarId'],
    options?: { syncProgression?: boolean },
  ): void {
    const store = useGameStore.getState();
    store.setOnlineProfile({ displayName, avatarId });
    this.network.send({
      type: 'session:update_profile',
      displayName,
      avatarId,
    });
    if (options?.syncProgression !== false) {
      void progressionClient.updateProfile(displayName, avatarId);
    }
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

  public joinMatchmaking(
    mode: 'quick' | 'ranked',
    ruleProfileId: RuleProfileId,
    calledShotsEnabled: boolean,
  ): void {
    this.ensureConnected();
    const store = useGameStore.getState();
    store.setOnlineError(null);
    store.setOnlineMatchmaking({
      mode,
      timedOutMessage: null,
      eloSpread: null,
      estimatedWaitSec: null,
    });
    this.network.send({
      type: 'matchmaking:join',
      mode,
      ruleProfileId,
      calledShotsEnabled,
    });
  }

  public startQuickMatch(ruleProfileId: RuleProfileId, calledShotsEnabled: boolean): void {
    this.joinMatchmaking('quick', ruleProfileId, calledShotsEnabled);
  }

  public startRankedMatch(ruleProfileId: RuleProfileId, calledShotsEnabled: boolean): void {
    this.joinMatchmaking('ranked', ruleProfileId, calledShotsEnabled);
  }

  public cancelQuickMatch(): void {
    useGameStore.getState().setOnlineMatchmaking({ active: false });
    this.network.send({ type: 'matchmaking:cancel' });
  }

  public cancelMatchmaking(): void {
    this.cancelQuickMatch();
  }

  public leaveMatchOrRoom(): void {
    const store = useGameStore.getState();
    if (store.onlineSpectating) {
      this.leaveSpectatorMode();
      return;
    }
    this.network.send({ type: 'room:leave' });
    this.network.bindRoomSocket(null);
    this.synchronizer.reset();
    store.clearOnlineMatchSession();
    if (store.screen === 'playing') {
      store.setScreen('menu');
    }
    this.sceneBridge?.onOnlineMatchExited();
  }

  public setRoomSpectatorSettings(allowSpectators: boolean, allowSpectatorChat?: boolean): void {
    this.network.send({
      type: 'room:set_spectators',
      allowSpectators,
      allowSpectatorChat,
    });
  }

  public async fetchSpectatableMatches(filters?: {
    matchType?: OnlineMatchType | 'all';
    status?: string;
    tournamentId?: string;
  }): Promise<SpectatableMatchSummary[]> {
    const store = useGameStore.getState();
    store.setSpectatableMatchesLoading(true);
    try {
      const loc = typeof window !== 'undefined' ? window.location : undefined;
      const baseUrl = resolveHttpBaseUrl(import.meta.env?.VITE_WS_URL, loc);
      const url = new URL(`${baseUrl || (loc ? `${loc.protocol}//${loc.host}` : 'http://127.0.0.1:8787')}/api/spectate/matches`);
      if (filters?.matchType && filters.matchType !== 'all') {
        url.searchParams.set('matchType', filters.matchType);
      }
      if (filters?.status) {
        url.searchParams.set('status', filters.status);
      }
      if (filters?.tournamentId) {
        url.searchParams.set('tournamentId', filters.tournamentId);
      }
      const res = await fetch(url.toString());
      if (!res.ok) return [];
      const json = (await res.json()) as { matches?: SpectatableMatchSummary[] };
      const list = Array.isArray(json.matches) ? json.matches : [];
      store.setSpectatableMatches(list);
      return list;
    } catch {
      return [];
    } finally {
      useGameStore.getState().setSpectatableMatchesLoading(false);
    }
  }

  public async joinSpectate(params: {
    roomId?: string;
    roomCode?: string;
    targetPlayerId?: string;
    shareToken?: string;
    returnTarget?: 'menu' | 'lobby' | 'tournament';
    tournamentId?: string | null;
  }): Promise<{ ok: boolean; error?: string }> {
    const store = useGameStore.getState();
    store.setOnlineError(null);
    const identity = getStoredPlayerIdentity();
    try {
      const loc = typeof window !== 'undefined' ? window.location : undefined;
      const baseUrl = resolveHttpBaseUrl(import.meta.env?.VITE_WS_URL, loc);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (identity?.playerToken) {
        headers.Authorization = `Bearer ${identity.playerToken}`;
      }
      const res = await fetch(`${baseUrl}/api/spectate/join`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          roomId: params.roomId,
          roomCode: params.roomCode?.trim().toUpperCase(),
          targetPlayerId: params.targetPlayerId,
          shareToken: params.shareToken,
          sessionId: store.onlineSessionId ?? undefined,
          playerId: identity?.playerId,
          playerToken: identity?.playerToken,
          displayName: store.onlineProfile.displayName,
          avatarId: store.onlineProfile.avatarId,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        message?: string;
        room?: OnlineRoomInfo;
        match?: OnlineMatchSnapshot | null;
        balls?: OnlineBallFrame[] | null;
        chatHistory?: RoomChatMessageRecord[];
        spectatorSessionId?: string;
        spectatorReconnectToken?: string;
      };
      if (!res.ok || !json.ok || !json.room || !json.spectatorSessionId || !json.spectatorReconnectToken) {
        const message = json.message ?? 'Unable to join match as spectator.';
        store.setOnlineError({
          code: json.error ?? 'SPECTATE_UNAVAILABLE',
          message,
        });
        return { ok: false, error: message };
      }

      this.enterSpectatorRoomState(
        {
          room: json.room,
          match: json.match ?? null,
          balls: json.balls ?? null,
          chatHistory: json.chatHistory ?? [],
          spectatorSessionId: json.spectatorSessionId,
          spectatorReconnectToken: json.spectatorReconnectToken,
        },
        params.returnTarget ?? 'lobby',
        params.tournamentId ?? json.room.tournament?.tournamentId ?? null,
      );
      soundEngine.playUiClick();
      return { ok: true };
    } catch {
      const message = 'Network error while joining live broadcast.';
      store.setOnlineError({ code: 'CONNECTION_FAILED', message });
      return { ok: false, error: message };
    }
  }

  public leaveSpectatorMode(targetOverride?: 'menu' | 'lobby' | 'tournament'): void {
    const store = useGameStore.getState();
    const roomId = store.onlineRoom?.roomId ?? this.network.getActiveRoomId();
    const specSid = store.spectatorSessionId;
    const returnTarget = targetOverride ?? store.spectateReturnTarget ?? 'lobby';
    const returnTournamentId =
      store.spectateReturnTournamentId ?? store.onlineRoom?.tournament?.tournamentId ?? null;
    const identity = getStoredPlayerIdentity();

    if (roomId) {
      this.network.send({ type: 'room:leave' });
      try {
        const loc = typeof window !== 'undefined' ? window.location : undefined;
        const baseUrl = resolveHttpBaseUrl(import.meta.env?.VITE_WS_URL, loc);
        void fetch(`${baseUrl}/api/spectate/leave`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(identity?.playerToken ? { Authorization: `Bearer ${identity.playerToken}` } : {}),
          },
          body: JSON.stringify({
            roomId,
            sessionId: specSid ?? undefined,
            playerId: identity?.playerId,
            playerToken: identity?.playerToken,
          }),
        });
      } catch {
        // Best-effort cleanup
      }
    }

    this.network.bindRoomSocket(null);
    this.synchronizer.reset();
    store.clearOnlineMatchSession();
    store.setScreen('menu');
    this.sceneBridge?.onOnlineMatchExited();

    if (returnTarget === 'tournament' && returnTournamentId) {
      store.openTournamentModal('bracket', returnTournamentId);
      void tournamentClient.fetchTournamentDetail(returnTournamentId);
    } else if (returnTarget === 'lobby') {
      store.openOnlineLobby('spectate');
      void this.fetchSpectatableMatches();
    }
  }

  private enterSpectatorRoomState(
    data: {
      room: OnlineRoomInfo;
      match: OnlineMatchSnapshot | null;
      balls: OnlineBallFrame[] | null;
      chatHistory?: RoomChatMessageRecord[];
      spectatorSessionId: string;
      spectatorReconnectToken: string;
    },
    returnTarget: 'menu' | 'lobby' | 'tournament',
    tournamentId: string | null,
  ): void {
    this.ensureConnected();
    const store = useGameStore.getState();
    this.network.setRoomSessionOverride({
      sessionId: data.spectatorSessionId,
      reconnectToken: data.spectatorReconnectToken,
    });
    store.setOnlineError(null);
    store.setSpectateReturnContext(returnTarget, tournamentId);
    store.setOnlineSpectating(true, data.spectatorSessionId);
    store.setOnlineRoom(data.room);
    store.setRoomChatHistory(data.chatHistory ?? []);
    store.resetMatchStats();
    store.updateMatchConfig({
      gameMode: 'eightBall',
      opponentType: 'online',
      player1Name: data.room.players[0]?.displayName ?? 'Player 1',
      player2Name: data.room.players[1]?.displayName ?? 'Player 2',
      ruleProfileId: data.room.ruleProfileId,
      calledShotsEnabled: data.room.calledShotsEnabled,
    });
    this.network.bindRoomSocket(data.room.roomId);

    this.synchronizer.reset();
    if (data.match && data.balls) {
      this.synchronizer.applySettledState(data.balls);
      store.syncFromOnlineMatchSnapshot(data.match, null);
    }
    store.closeOnlineLobby();
    store.closeTournamentModal();
    store.closeClubLeagueModal();
    store.setScreen('playing');
    if (data.match && data.balls) {
      this.sceneBridge?.onOnlineMatchEntered(data.match, data.balls);
    }
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
      const baseUrl = resolveHttpBaseUrl(import.meta.env?.VITE_WS_URL, loc);
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

  public setManualPresence(status: ManualPresenceStatus): void {
    this.ensureConnected();
    this.network.send({ type: 'presence:set', status });
  }

  public syncSocialState(): void {
    this.ensureConnected();
    this.network.send({ type: 'social:sync' });
  }

  public sendFriendRequestWs(targetPlayerId: string): void {
    this.ensureConnected();
    this.network.send({ type: 'social:friend_request', targetPlayerId });
  }

  public respondFriendRequestWs(targetPlayerId: string, action: FriendRequestAction): void {
    this.ensureConnected();
    this.network.send({ type: 'social:friend_respond', targetPlayerId, action });
  }

  public sendMatchInviteWs(
    targetPlayerId: string,
    ruleProfileId: RuleProfileId,
    calledShotsEnabled: boolean,
  ): void {
    this.ensureConnected();
    this.network.send({
      type: 'invite:send',
      targetPlayerId,
      ruleProfileId,
      calledShotsEnabled,
    });
  }

  public sendSpectateInviteWs(
    targetPlayerId: string,
    roomId: string,
    ruleProfileId: RuleProfileId,
    calledShotsEnabled: boolean,
  ): void {
    this.ensureConnected();
    this.network.send({
      type: 'invite:send',
      targetPlayerId,
      inviteKind: 'spectate',
      roomId,
      ruleProfileId,
      calledShotsEnabled,
    });
  }

  public respondMatchInviteWs(inviteId: string, action: MatchInviteAction): void {
    this.ensureConnected();
    this.network.send({ type: 'invite:respond', inviteId, action });
  }

  public async joinFriendRoom(friendPlayerId: string): Promise<{ ok: boolean; error?: string }> {
    this.ensureConnected();
    const store = useGameStore.getState();
    const res = await socialClient.joinFriendRoom(friendPlayerId, store.onlineSessionId);
    if (!res.ok || !res.data?.room) {
      const msg = res.error ?? 'Unable to join friend room.';
      store.setSocialNotice({ type: 'err', text: msg });
      return { ok: false, error: msg };
    }
    this.network.bindRoomSocket(res.data.room.roomId);
    store.setOnlineRoom(res.data.room);
    store.setOnlineError(null);
    store.closeSocialModal();
    if (store.screen !== 'playing') {
      store.openOnlineLobby('friend');
    }
    soundEngine.playUiClick();
    return { ok: true };
  }

  public markNotificationReadWs(notificationId?: string): void {
    this.ensureConnected();
    this.network.send({ type: 'social:mark_notification_read', notificationId });
  }

  public clearNotificationsWs(notificationId?: string): void {
    this.ensureConnected();
    this.network.send({ type: 'social:clear_notifications', notificationId });
  }

  public updatePrivacyWs(privacy: Partial<PrivacySettings>): void {
    this.ensureConnected();
    this.network.send({ type: 'social:privacy_update', privacy });
  }

  public syncClubWs(): void {
    this.ensureConnected();
    this.network.send({ type: 'club:sync' });
  }

  public sendDirectMessageWs(recipientId: string, body: string): void {
    this.ensureConnected();
    this.network.send({
      type: 'chat:dm_send',
      recipientId,
      body,
      clientMessageId: `dm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    });
  }

  public markDirectMessagesReadWs(peerPlayerId: string): void {
    this.ensureConnected();
    this.network.send({ type: 'chat:dm_mark_read', peerPlayerId });
  }

  public sendRoomChatMessage(body: string): boolean {
    return this.network.send({
      type: 'chat:room_send',
      body,
      clientMessageId: `rc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    });
  }

  public subscribeTournamentWs(tournamentId: string): void {
    this.ensureConnected();
    this.network.send({
      type: 'tournament:subscribe',
      tournamentId,
    });
  }

  public unsubscribeTournamentWs(tournamentId?: string): void {
    this.network.send({
      type: 'tournament:unsubscribe',
      tournamentId,
    });
  }

  public async joinTournamentMatch(
    tournamentId: string,
    bracketMatchId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    this.ensureConnected();
    const store = useGameStore.getState();
    const res = await tournamentClient.joinMatch(
      tournamentId,
      bracketMatchId,
      store.onlineSessionId,
    );
    if (!res.ok || !res.data) {
      const msg = res.error ?? 'Unable to enter tournament match room.';
      store.setTournamentNotice({ type: 'err', text: msg });
      store.setOnlineError({ code: res.code ?? 'INVALID_ROOM', message: msg });
      return { ok: false, error: msg };
    }

    this.network.saveSessionCredentials(
      res.data.roomSession.sessionId,
      res.data.roomSession.reconnectToken,
    );
    store.setOnlineSessionId(res.data.roomSession.sessionId);
    this.network.bindRoomSocket(res.data.room.roomId);
    store.setOnlineRoom(res.data.room);
    store.setOnlineError(null);
    if (
      store.tournamentMatchAlert &&
      store.tournamentMatchAlert.match.bracketMatchId === bracketMatchId
    ) {
      store.setTournamentMatchAlert(null);
    }
    store.closeTournamentModal();
    if (store.screen !== 'playing') {
      store.openOnlineLobby('quick');
    }
    soundEngine.playUiClick();
    return { ok: true };
  }

  public async joinTeamSubMatch(
    subMatchId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    this.ensureConnected();
    const store = useGameStore.getState();
    const res = await clubLeagueClient.joinSubMatch(subMatchId, store.onlineSessionId);
    if (!res.ok || !res.data) {
      const msg = res.error ?? 'Unable to enter club board match room.';
      store.setClubLeagueNotice({ type: 'err', text: msg });
      store.setOnlineError({ code: res.code ?? 'INVALID_ROOM', message: msg });
      return { ok: false, error: msg };
    }

    this.network.saveSessionCredentials(
      res.data.roomSession.sessionId,
      res.data.roomSession.reconnectToken,
    );
    store.setOnlineSessionId(res.data.roomSession.sessionId);
    this.network.bindRoomSocket(res.data.room.roomId);
    store.setOnlineRoom(res.data.room);
    store.setOnlineError(null);
    store.closeClubLeagueModal();
    if (store.screen !== 'playing') {
      store.openOnlineLobby('quick');
    }
    soundEngine.playUiClick();
    return { ok: true };
  }

  private resolveLocalRole(room: OnlineRoomInfo | null): PlayerId | null {
    const state = useGameStore.getState();
    if (state.onlineSpectating) return null;
    const sid = state.onlineSessionId;
    if (!room || !sid) return state.onlineLocalRole;
    return room.players.find((p) => p.sessionId === sid)?.role ?? null;
  }

  private handleServerMessage(msg: ServerToClientMessage): void {
    const store = useGameStore.getState();

    switch (msg.type) {
      case 'session:ready': {
        if (msg.isSpectator) {
          store.setOnlineSpectating(true, msg.sessionId);
          store.setOnlineError(null);
          if (msg.resumedRoom) {
            store.setOnlineRoom(msg.resumedRoom);
            if (msg.resumedMatch && msg.balls) {
              this.synchronizer.applySettledState(msg.balls);
              store.syncFromOnlineMatchSnapshot(msg.resumedMatch, null);
              store.closeOnlineLobby();
              store.closeTournamentModal();
              store.setScreen('playing');
              this.sceneBridge?.onOnlineMatchEntered(msg.resumedMatch, msg.balls);
            }
          }
          break;
        }

        store.setOnlineSessionId(msg.sessionId);
        store.setOnlineError(null);
        void progressionClient.refreshOwnProfile();
        void progressionClient.fetchModerationStatus();
        void progressionClient.fetchRankedSeasons();

        if (msg.resumedRoom && !store.onlineSpectating) {
          this.network.bindRoomSocket(msg.resumedRoom.roomId);
          const role =
            msg.resumedRoom.players.find((p) => p.sessionId === msg.sessionId)?.role ?? null;
          store.setOnlineRoom(msg.resumedRoom);

          if (msg.resumedMatch && msg.balls) {
            if (store.onlineMatchId !== msg.resumedMatch.matchId) {
              store.resetMatchStats();
            }
            this.synchronizer.applySettledState(msg.balls);
            store.syncFromOnlineMatchSnapshot(msg.resumedMatch, role);
            store.closeOnlineLobby();
            store.setScreen('playing');
            this.sceneBridge?.onOnlineMatchEntered(msg.resumedMatch, msg.balls);
          }
        }
        break;
      }

      case 'spectate:joined': {
        this.enterSpectatorRoomState(
          {
            room: msg.room,
            match: msg.match,
            balls: msg.balls,
            chatHistory: msg.chatHistory,
            spectatorSessionId: msg.spectatorSessionId,
            spectatorReconnectToken: msg.spectatorReconnectToken,
          },
          store.spectateReturnTarget ?? 'lobby',
          store.spectateReturnTournamentId ?? msg.room.tournament?.tournamentId ?? null,
        );
        break;
      }

      case 'error': {
        if (
          this.network.getActiveRoomId() &&
          (msg.code === 'ROOM_EXPIRED' ||
            msg.code === 'INVALID_ROOM' ||
            msg.code === 'UNAUTHORIZED' ||
            msg.code === 'SPECTATE_UNAVAILABLE')
        ) {
          const wasSpectating = store.onlineSpectating;
          const returnTarget = store.spectateReturnTarget ?? 'lobby';
          const returnTournamentId = store.spectateReturnTournamentId;
          const wasPlaying = store.screen === 'playing' && store.matchConfig.opponentType === 'online';
          this.network.bindRoomSocket(null);
          this.synchronizer.reset();
          store.clearOnlineMatchSession();
          if (wasPlaying || wasSpectating) {
            store.setScreen('menu');
            if (wasSpectating && returnTarget === 'tournament' && returnTournamentId) {
              store.openTournamentModal('bracket', returnTournamentId);
            } else {
              store.openOnlineLobby(wasSpectating ? 'spectate' : 'create');
            }
          }
          this.sceneBridge?.onOnlineMatchExited();
        }
        store.setOnlineError({ code: msg.code, message: msg.message });
        if (
          msg.code === 'ALREADY_IN_MATCH' ||
          msg.code === 'MATCHMAKING_TIMEOUT' ||
          msg.code === 'RANKED_RESTRICTED' ||
          msg.code === 'SUSPENDED'
        ) {
          store.setOnlineMatchmaking({ active: false });
        }
        if (msg.code === 'RANKED_RESTRICTED' || msg.code === 'SUSPENDED') {
          void progressionClient.fetchModerationStatus();
        }
        break;
      }

      case 'room:created':
      case 'room:updated': {
        if (!store.onlineSpectating) {
          this.network.bindRoomSocket(msg.room.roomId);
        }
        store.setOnlineRoom(msg.room);
        store.setOnlineError(null);
        break;
      }

      case 'room:closed': {
        const wasSpectating = store.onlineSpectating;
        const returnTarget = store.spectateReturnTarget ?? 'lobby';
        const returnTournamentId = store.spectateReturnTournamentId;
        const wasPlaying = store.screen === 'playing' && store.matchConfig.opponentType === 'online';
        this.network.bindRoomSocket(null);
        this.synchronizer.reset();
        store.clearOnlineMatchSession();
        store.setOnlineError({ code: 'ROOM_EXPIRED', message: msg.reason });
        if (wasPlaying || wasSpectating) {
          store.setScreen('menu');
          if (wasSpectating && returnTarget === 'tournament' && returnTournamentId) {
            store.openTournamentModal('bracket', returnTournamentId);
          } else {
            store.openOnlineLobby(wasSpectating ? 'spectate' : 'create');
          }
        }
        this.sceneBridge?.onOnlineMatchExited();
        break;
      }

      case 'matchmaking:searching': {
        store.setOnlineMatchmaking({
          active: true,
          mode: msg.mode ?? store.onlineMatchmaking.mode,
          position: msg.position,
          startedAtMs: msg.startedAtMs,
          timeoutAtMs: msg.timeoutAtMs,
          elo: msg.elo ?? null,
          eloSpread: msg.eloSpread ?? null,
          region: msg.region ?? null,
          estimatedWaitSec:
            msg.estimatedWaitSec !== undefined ? msg.estimatedWaitSec : null,
          timedOutMessage: null,
        });
        break;
      }

      case 'matchmaking:matched': {
        this.network.bindRoomSocket(msg.room.roomId);
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
        this.sceneBridge?.onOnlineShotFrame?.(msg.balls);
        break;
      }

      case 'physics:pocket': {
        if (this.synchronizer.markPocketEvent(msg.shotSeq, msg.ballNumber, msg.pocketId)) {
          store.addPocketedBall(msg.ballNumber);
          this.sceneBridge?.onOnlinePocketEvent?.(msg.ballNumber, msg.pocketId);
        }
        break;
      }

      case 'match:settled': {
        const role = this.resolveLocalRole(msg.room);
        this.synchronizer.applySettledState(msg.balls);
        store.setOnlineRoom(msg.room);
        store.syncFromOnlineMatchSnapshot(msg.match, role);
        this.sceneBridge?.onApplyAuthoritativeBalls(msg.balls);
        this.sceneBridge?.onOnlineShotSettled?.(msg.match, msg.balls);
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
        store.syncFromOnlineMatchSnapshot(msg.match, role, msg.historyRecord, msg.progression);
        this.sceneBridge?.onApplyAuthoritativeBalls(msg.balls);
        this.sceneBridge?.onOnlineShotSettled?.(msg.match, msg.balls);
        void progressionClient.refreshOwnProfile();
        void import('./EconomyClient').then(({ economyClient }) => economyClient.refreshWallet());
        void import('./BattlePassClient').then(({ battlePassClient }) =>
          battlePassClient.refreshOverview(),
        );
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

      case 'social:state': {
        store.applySocialOverview(msg.overview);
        break;
      }

      case 'social:presence_changed': {
        store.updatePlayerPresence(msg.playerId, msg.status, msg.lastSeenAtMs);
        break;
      }

      case 'social:friend_request_received': {
        store.upsertIncomingFriendRequest(msg.request);
        soundEngine.playUiClick();
        break;
      }

      case 'social:friend_updated': {
        this.network.send({ type: 'social:sync' });
        break;
      }

      case 'invite:received': {
        store.upsertInvitation(msg.invitation);
        soundEngine.playUiClick();
        break;
      }

      case 'invite:updated': {
        store.upsertInvitation(msg.invitation);
        if (
          msg.invitation.inviteKind !== 'spectate' &&
          msg.invitation.status === 'accepted' &&
          msg.room
        ) {
          this.network.bindRoomSocket(msg.room.roomId);
          store.setOnlineRoom(msg.room);
          store.setOnlineError(null);
          store.closeSocialModal();
          if (store.screen !== 'playing') {
            store.openOnlineLobby('friend');
          }
          soundEngine.playUiClick();
        }
        break;
      }

      case 'notification:new': {
        store.applyNotificationNew(msg.notification, msg.unreadCount);
        soundEngine.playUiClick();
        break;
      }

      case 'notifications:updated': {
        store.applyNotificationsUpdated(msg.notifications, msg.unreadCount);
        break;
      }

      case 'privacy:updated': {
        store.setPrivacySettings(msg.privacy);
        break;
      }

      case 'club:updated': {
        if (msg.clubDetail !== undefined) {
          store.setClubDetail(msg.clubDetail ?? null);
          if (msg.clubDetail?.viewerRole) {
            store.setMyClub({
              clubId: msg.clubDetail.club.clubId,
              name: msg.clubDetail.club.name,
              tag: msg.clubDetail.club.tag,
              emblemColor: msg.clubDetail.club.emblemColor,
              emblemIcon: msg.clubDetail.club.emblemIcon,
              role: msg.clubDetail.viewerRole,
            });
          } else {
            store.setMyClub(null);
          }
        }
        if (msg.incomingInvitations !== undefined) {
          store.setIncomingClubInvitations(msg.incomingInvitations);
        }
        break;
      }

      case 'club:challenge_updated': {
        store.applyClubChallengeUpdated(msg.challenge);
        break;
      }

      case 'club:chat_message': {
        if (store.myClub?.clubId === msg.clubId || store.clubDetail?.club.clubId === msg.clubId) {
          store.appendClubChatMessage(msg.message);
        }
        break;
      }

      case 'club:league_updated': {
        if (store.clubLeagueModalOpen) {
          void clubLeagueClient.listLeagues();
          if (store.selectedLeagueId === msg.leagueId) {
            void clubLeagueClient.getLeagueDetail(msg.leagueId);
          }
        }
        break;
      }

      case 'club:championship_updated': {
        if (store.clubLeagueModalOpen) {
          void clubLeagueClient.listChampionships();
          if (store.selectedChampionshipId === msg.championshipId) {
            void clubLeagueClient.getChampionshipDetail(msg.championshipId);
          }
        }
        break;
      }

      case 'club:team_match_ready': {
        store.setClubLeagueNotice({
          type: 'ok',
          text: `${msg.competitionTitle} · ${msg.subMatch.boardLabel} is ready to play.`,
        });
        soundEngine.playUiClick();
        if (store.clubLeagueModalOpen) {
          if (msg.competitionKind === 'league' && store.selectedLeagueId === msg.competitionId) {
            void clubLeagueClient.getLeagueDetail(msg.competitionId);
          } else if (
            msg.competitionKind === 'club_championship' &&
            store.selectedChampionshipId === msg.competitionId
          ) {
            void clubLeagueClient.getChampionshipDetail(msg.competitionId);
          }
        }
        break;
      }

      case 'chat:dm_message': {
        const selfId = store.ownProfile?.playerId ?? null;
        store.appendDirectMessage(msg.message, selfId);
        if (
          selfId &&
          msg.message.recipientId === selfId &&
          store.socialModalOpen &&
          store.socialTab === 'messages' &&
          store.activeDmPeerId === msg.message.senderId
        ) {
          this.network.send({
            type: 'chat:dm_mark_read',
            peerPlayerId: msg.message.senderId,
          });
        }
        break;
      }

      case 'chat:dm_read': {
        const selfId = store.ownProfile?.playerId ?? null;
        store.markDmThreadRead(msg.peerPlayerId, msg.readerId, msg.readAtMs, selfId);
        break;
      }

      case 'chat:room_history': {
        store.setRoomChatHistory(msg.messages);
        break;
      }

      case 'chat:room_message': {
        const selfId = store.ownProfile?.playerId ?? null;
        store.appendRoomChatMessage(msg.message, selfId);
        break;
      }

      case 'tournament:updated': {
        store.applyTournamentLiveUpdate(msg.tournament, msg.matches);
        if (store.tournamentModalOpen && store.selectedTournamentId === msg.tournament.tournamentId) {
          void tournamentClient.fetchTournamentDetail(msg.tournament.tournamentId);
        }
        break;
      }

      case 'tournament:match_ready': {
        store.setTournamentMatchAlert({
          tournamentId: msg.tournamentId,
          tournamentTitle: msg.tournamentTitle,
          match: msg.match,
          receivedAtMs: Date.now(),
        });
        soundEngine.playUiClick();
        if (store.tournamentModalOpen && store.selectedTournamentId === msg.tournamentId) {
          void tournamentClient.fetchTournamentDetail(msg.tournamentId);
        }
        break;
      }

      case 'tournament:completed': {
        store.applyTournamentCompleted(msg.tournament);
        void progressionClient.refreshOwnProfile();
        void import('./EconomyClient').then(({ economyClient }) => economyClient.refreshWallet());
        void import('./BattlePassClient').then(({ battlePassClient }) =>
          battlePassClient.refreshOverview(),
        );
        void tournamentClient.fetchPlayerStats();
        if (store.tournamentModalOpen && store.selectedTournamentId === msg.tournament.tournamentId) {
          void tournamentClient.fetchTournamentDetail(msg.tournament.tournamentId);
        }
        break;
      }
    }
  }
}

export const multiplayerManager = new MultiplayerManagerImpl();
