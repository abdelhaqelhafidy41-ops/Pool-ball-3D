import { create } from 'zustand';
import { createDefaultMatchConfig, type MatchSnapshot } from '../game/rules/MatchManager';
import { loadMatchStatistics, saveMatchStatistics } from '../game/rules/MatchStatistics';
import type {
  AiDifficulty,
  AiStatusState,
  BallGroup,
  CalledShot,
  MatchBannerNotice,
  MatchConfig,
  MatchStatePhase,
  MatchStatistics,
  PlacementZone,
  PlayerId,
  PocketId,
} from '../game/rules/types';
import { TABLE_DIMENSIONS } from '../game/utils/constants';
import type {
  MatchProgressionRewardSummary,
  PublicPlayerProfile,
} from '../multiplayer/shared/progression';
import type {
  ConnectionState,
  MatchHistoryRecord,
  OnlineAvatarId,
  OnlineMatchSnapshot,
  OnlineModeIntent,
  OnlineRoomInfo,
  OpponentConnectionState,
} from '../multiplayer/shared/protocol';

const PROFILE_STORAGE_KEY = 'ultimate_pool_3d_online_profile_v1';

function loadSavedOnlineProfile(): { displayName: string; avatarId: OnlineAvatarId } {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { displayName: 'Player', avatarId: 'cue_gold' };
    }
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return { displayName: 'Player', avatarId: 'cue_gold' };
    const parsed = JSON.parse(raw) as { displayName?: string; avatarId?: OnlineAvatarId };
    return {
      displayName:
        typeof parsed.displayName === 'string' && parsed.displayName.trim()
          ? parsed.displayName.trim().slice(0, 16)
          : 'Player',
      avatarId: parsed.avatarId ?? 'cue_gold',
    };
  } catch {
    return { displayName: 'Player', avatarId: 'cue_gold' };
  }
}

function persistOnlineProfile(profile: { displayName: string; avatarId: OnlineAvatarId }) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    }
  } catch {
    // Ignore storage restriction
  }
}

function defaultNameForDifficulty(diff: AiDifficulty): string {
  switch (diff) {
    case 'beginner':
      return 'Rookie Sam';
    case 'intermediate':
      return 'Club Victor';
    case 'pro':
      return 'Master Elena';
    case 'legend':
      return 'Grandmaster Vega';
  }
}

const DEFAULT_AI_NAMES = new Set([
  'Player 2',
  'CPU Pro',
  'Rookie Sam',
  'Club Victor',
  'Master Elena',
  'Grandmaster Vega',
]);

export type GameScreen = 'menu' | 'playing';
export type CameraPreset = 'threeQuarter' | 'topDown' | 'cueAim' | 'sideView';
export type FeltTheme = 'tournamentGreen' | 'championshipBlue' | 'burgundyClub';
export type ProgressionTab = 'profile' | 'leaderboard' | 'achievements' | 'history';

export type CanvasInteractionMode = 'smart' | 'aim';

export interface CueSpin {
  x: number; // -0.78 (Left English) .. +0.78 (Right English)
  y: number; // -0.78 (Bottom/Draw) .. +0.78 (Top/Follow)
}

export interface GameSettings {
  feltTheme: FeltTheme;
  shadowsEnabled: boolean;
  showAimGuide: boolean;
  showFps: boolean;
  cameraSensitivity: number;
}

export interface OnlineMatchmakingState {
  active: boolean;
  startedAtMs: number;
  timeoutAtMs: number;
  position: number;
  timedOutMessage: string | null;
}

export interface OnlineOpponentStatus {
  state: OpponentConnectionState;
  displayName: string | null;
  graceDeadlineMs: number | null;
}

export interface GameState {
  screen: GameScreen;
  settingsOpen: boolean;
  isLoading: boolean;
  loadError: string | null;
  fps: number;
  cameraPreset: CameraPreset;
  cameraRequestCounter: number;
  soundEnabled: boolean;
  soundVolume: number;
  isFullscreen: boolean;
  hudCollapsed: boolean;
  cueAngle: number; // radians around cue ball
  cueSpin: CueSpin; // normalized contact point inside cue ball circle
  canvasInteractionMode: CanvasInteractionMode;
  dragPower: number; // 0.0 to 1.0 live pullback ratio from drag controller
  isDraggingCue: boolean;
  isShotAnimating: boolean;
  ballsMoving: boolean;
  pocketedNumbers: number[];
  cueBallPocketed: boolean;
  shotCount: number;
  settings: GameSettings;

  // 8-Ball Match State
  matchConfig: MatchConfig;
  matchPhase: MatchStatePhase;
  activePlayer: PlayerId;
  isBreakShot: boolean;
  tableOpen: boolean;
  playerGroups: Record<PlayerId, BallGroup>;
  ballInHandZone: PlacementZone;
  cuePlacementPos: { x: number; z: number };
  cuePlacementValid: boolean;
  cuePlacementReason: string | null;
  calledShot: CalledShot;
  winner: PlayerId | null;
  loser: PlayerId | null;
  gameOverReason: string | null;
  statusHeadline: string;
  lastFoulMessage: string | null;
  matchBanner: MatchBannerNotice | null;
  matchStats: MatchStatistics;
  isAiThinking: boolean;
  aiStatus: AiStatusState;
  aiPullbackPower: number;

  // Online Multiplayer State
  onlineLobbyOpen: boolean;
  onlineModeIntent: OnlineModeIntent;
  onlineProfile: { displayName: string; avatarId: OnlineAvatarId };
  onlineConnectionStatus: ConnectionState;
  onlineSessionId: string | null;
  onlineLatencyMs: number | null;
  onlineRoom: OnlineRoomInfo | null;
  onlineMatchId: string | null;
  onlineLocalRole: PlayerId | null;
  onlineMatchmaking: OnlineMatchmakingState;
  onlineOpponentStatus: OnlineOpponentStatus;
  onlineError: { code: string; message: string } | null;
  onlineRematchVotes: PlayerId[];
  onlineHistory: MatchHistoryRecord[];
  onlineRecordedMatchIds: string[];

  // Competitive Progression State (Phase 5)
  ownProfile: PublicPlayerProfile | null;
  lastOnlineMatchProgression: MatchProgressionRewardSummary | null;
  progressionModalOpen: boolean;
  progressionTab: ProgressionTab;
  inspectedPlayerId: string | null;

  // Actions
  setScreen: (screen: GameScreen) => void;
  setSettingsOpen: (open: boolean) => void;
  setLoading: (loading: boolean) => void;
  setLoadError: (error: string | null) => void;
  setFps: (fps: number) => void;
  requestCameraPreset: (preset: CameraPreset) => void;
  toggleSound: () => void;
  setSoundVolume: (vol: number) => void;
  setIsFullscreen: (fs: boolean) => void;
  toggleHudCollapsed: () => void;
  setCueAngle: (angle: number) => void;
  adjustCueAngle: (delta: number) => void;
  resetCueAngle: () => void;
  setCueSpin: (x: number, y: number) => void;
  resetCueSpin: () => void;
  setCanvasInteractionMode: (mode: CanvasInteractionMode) => void;
  toggleShowAimGuide: () => void;
  setDragState: (isDragging: boolean, power: number) => void;
  setIsShotAnimating: (animating: boolean) => void;
  setBallsMoving: (moving: boolean) => void;
  addPocketedBall: (ballNumber: number) => void;
  clearPocketedBalls: () => void;
  incrementShotCount: () => void;
  resetMatchStats: () => void;
  updateSettings: (partial: Partial<GameSettings>) => void;

  // Match Actions
  syncFromMatchSnapshot: (snapshot: MatchSnapshot) => void;
  updateMatchConfig: (partial: Partial<MatchConfig>) => void;
  setCuePlacementPreview: (
    x: number,
    z: number,
    valid: boolean,
    reason?: string | null,
  ) => void;
  setCalledShotSelection: (
    targetBall: number | null,
    targetPocket: PocketId | null,
  ) => void;
  setIsAiThinking: (thinking: boolean) => void;
  setAiStatus: (status: AiStatusState) => void;
  setAiPullbackPower: (power: number) => void;
  dismissMatchBanner: () => void;
  setMatchStats: (stats: MatchStatistics) => void;

  // Online Actions
  openOnlineLobby: (intent?: OnlineModeIntent) => void;
  closeOnlineLobby: () => void;
  setOnlineModeIntent: (intent: OnlineModeIntent) => void;
  setOnlineProfile: (partial: Partial<{ displayName: string; avatarId: OnlineAvatarId }>) => void;
  setOnlineConnectionStatus: (status: ConnectionState) => void;
  setOnlineSessionId: (sessionId: string | null) => void;
  setOnlineLatencyMs: (latencyMs: number | null) => void;
  setOnlineRoom: (room: OnlineRoomInfo | null) => void;
  setOnlineMatchmaking: (partial: Partial<OnlineMatchmakingState>) => void;
  setOnlineOpponentStatus: (status: OnlineOpponentStatus) => void;
  setOnlineError: (err: { code: string; message: string } | null) => void;
  setOnlineHistory: (history: MatchHistoryRecord[]) => void;
  syncFromOnlineMatchSnapshot: (
    snapshot: OnlineMatchSnapshot,
    localRole: PlayerId | null,
    historyRecord?: MatchHistoryRecord,
    progression?: MatchProgressionRewardSummary,
  ) => void;
  clearOnlineMatchSession: () => void;

  // Progression Actions (Phase 5)
  setOwnProfile: (profile: PublicPlayerProfile | null) => void;
  setLastOnlineMatchProgression: (summary: MatchProgressionRewardSummary | null) => void;
  openProgressionModal: (tab?: ProgressionTab, inspectedPlayerId?: string | null) => void;
  closeProgressionModal: () => void;
  setProgressionTab: (tab: ProgressionTab) => void;
  setInspectedPlayerId: (playerId: string | null) => void;
}

export function canLocalPlayerAct(state: GameState): boolean {
  if (state.matchConfig.opponentType === 'online') {
    if (state.onlineConnectionStatus !== 'connected') return false;
    if (!state.onlineLocalRole) return false;
    return state.activePlayer === state.onlineLocalRole;
  }
  if (
    state.matchConfig.gameMode === 'eightBall' &&
    state.matchConfig.opponentType === 'ai' &&
    state.activePlayer === 'player2'
  ) {
    return false;
  }
  return true;
}

const MAX_SPIN_RADIUS = 0.78;

function clampCueSpin(x: number, y: number): CueSpin {
  const r = Math.hypot(x, y);
  if (r <= MAX_SPIN_RADIUS) {
    return { x, y };
  }
  const scale = MAX_SPIN_RADIUS / r;
  return { x: x * scale, y: y * scale };
}

export const useGameStore = create<GameState>((set) => ({
  screen: 'menu',
  settingsOpen: false,
  isLoading: true,
  loadError: null,
  fps: 60,
  cameraPreset: 'threeQuarter',
  cameraRequestCounter: 0,
  soundEnabled: true,
  soundVolume: 0.75,
  isFullscreen: false,
  hudCollapsed: false,
  cueAngle: 0,
  cueSpin: { x: 0, y: 0 },
  canvasInteractionMode: 'smart',
  dragPower: 0,
  isDraggingCue: false,
  isShotAnimating: false,
  ballsMoving: false,
  pocketedNumbers: [],
  cueBallPocketed: false,
  shotCount: 0,
  settings: {
    feltTheme: 'tournamentGreen',
    shadowsEnabled: true,
    showAimGuide: true,
    showFps: true,
    cameraSensitivity: 1.0,
  },

  matchConfig: createDefaultMatchConfig(),
  matchPhase: 'MENU',
  activePlayer: 'player1',
  isBreakShot: true,
  tableOpen: true,
  playerGroups: { player1: null, player2: null },
  ballInHandZone: 'anywhere',
  cuePlacementPos: { x: TABLE_DIMENSIONS.headSpotX, z: 0 },
  cuePlacementValid: true,
  cuePlacementReason: null,
  calledShot: { targetBall: null, targetPocket: null },
  winner: null,
  loser: null,
  gameOverReason: null,
  statusHeadline: 'Break Shot',
  lastFoulMessage: null,
  matchBanner: null,
  matchStats: loadMatchStatistics(),
  isAiThinking: false,
  aiStatus: {
    active: false,
    phase: 'idle',
    message: 'Standby',
    shotTypeLabel: null,
  },
  aiPullbackPower: 0,

  onlineLobbyOpen: false,
  onlineModeIntent: 'quick',
  onlineProfile: loadSavedOnlineProfile(),
  onlineConnectionStatus: 'disconnected',
  onlineSessionId: null,
  onlineLatencyMs: null,
  onlineRoom: null,
  onlineMatchId: null,
  onlineLocalRole: null,
  onlineMatchmaking: {
    active: false,
    startedAtMs: 0,
    timeoutAtMs: 0,
    position: 0,
    timedOutMessage: null,
  },
  onlineOpponentStatus: {
    state: 'connected',
    displayName: null,
    graceDeadlineMs: null,
  },
  onlineError: null,
  onlineRematchVotes: [],
  onlineHistory: [],
  onlineRecordedMatchIds: [],

  ownProfile: null,
  lastOnlineMatchProgression: null,
  progressionModalOpen: false,
  progressionTab: 'profile',
  inspectedPlayerId: null,

  setScreen: (screen) => set({ screen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setLoading: (isLoading) => set({ isLoading }),
  setLoadError: (loadError) => set({ loadError }),
  setFps: (fps) => set({ fps }),
  requestCameraPreset: (cameraPreset) =>
    set((state) => ({
      cameraPreset,
      cameraRequestCounter: state.cameraRequestCounter + 1,
    })),
  toggleSound: () => set((state) => ({ soundEnabled: !state.soundEnabled })),
  setSoundVolume: (soundVolume) => set({ soundVolume: Math.max(0, Math.min(1, soundVolume)) }),
  setIsFullscreen: (isFullscreen) => set({ isFullscreen }),
  toggleHudCollapsed: () => set((state) => ({ hudCollapsed: !state.hudCollapsed })),
  setCueAngle: (cueAngle) => set({ cueAngle }),
  adjustCueAngle: (delta) => set((state) => ({ cueAngle: state.cueAngle + delta })),
  resetCueAngle: () => set({ cueAngle: 0 }),
  setCueSpin: (x, y) => set({ cueSpin: clampCueSpin(x, y) }),
  resetCueSpin: () => set({ cueSpin: { x: 0, y: 0 } }),
  setCanvasInteractionMode: (canvasInteractionMode) => set({ canvasInteractionMode }),
  toggleShowAimGuide: () =>
    set((state) => ({
      settings: { ...state.settings, showAimGuide: !state.settings.showAimGuide },
    })),
  setDragState: (isDraggingCue, dragPower) =>
    set({
      isDraggingCue,
      dragPower: Math.max(0, Math.min(1, dragPower)),
    }),
  setIsShotAnimating: (isShotAnimating) => set({ isShotAnimating }),
  setBallsMoving: (ballsMoving) => set({ ballsMoving }),
  addPocketedBall: (ballNumber) =>
    set((state) => {
      if (ballNumber === 0) {
        return { cueBallPocketed: true };
      }
      if (state.pocketedNumbers.includes(ballNumber)) return state;
      return { pocketedNumbers: [...state.pocketedNumbers, ballNumber] };
    }),
  clearPocketedBalls: () => set({ pocketedNumbers: [], cueBallPocketed: false }),
  incrementShotCount: () => set((state) => ({ shotCount: state.shotCount + 1 })),
  resetMatchStats: () =>
    set({
      pocketedNumbers: [],
      cueBallPocketed: false,
      shotCount: 0,
      cueAngle: 0,
      cueSpin: { x: 0, y: 0 },
      dragPower: 0,
      isDraggingCue: false,
      isShotAnimating: false,
      lastOnlineMatchProgression: null,
    }),
  updateSettings: (partial) =>
    set((state) => ({
      settings: { ...state.settings, ...partial },
    })),

  syncFromMatchSnapshot: (snapshot) =>
    set({
      matchConfig: snapshot.config,
      matchPhase: snapshot.phase,
      activePlayer: snapshot.activePlayer,
      isBreakShot: snapshot.isBreakShot,
      tableOpen: snapshot.tableOpen,
      playerGroups: snapshot.playerGroups,
      ballInHandZone: snapshot.ballInHandZone,
      calledShot: snapshot.calledShot,
      pocketedNumbers: snapshot.pocketedNumbers,
      winner: snapshot.winner,
      loser: snapshot.loser,
      gameOverReason: snapshot.gameOverReason,
      statusHeadline: snapshot.statusHeadline,
      lastFoulMessage: snapshot.lastFoulMessage,
      matchBanner: snapshot.banner,
      matchStats: snapshot.stats,
      shotCount: snapshot.totalMatchShots,
    }),

  updateMatchConfig: (partial) =>
    set((state) => {
      const next = { ...state.matchConfig, ...partial };
      const isDefaultName =
        !state.matchConfig.player2Name.trim() ||
        DEFAULT_AI_NAMES.has(state.matchConfig.player2Name.trim());

      if (next.opponentType === 'ai' && isDefaultName && !partial.player2Name) {
        next.player2Name = defaultNameForDifficulty(next.aiDifficulty);
      } else if (partial.opponentType === 'pvp' && isDefaultName && !partial.player2Name) {
        next.player2Name = 'Player 2';
      }

      if (partial.ruleProfileId === 'wpa' && partial.calledShotsEnabled === undefined) {
        next.calledShotsEnabled = true;
      } else if (partial.ruleProfileId === 'casual' && partial.calledShotsEnabled === undefined) {
        next.calledShotsEnabled = false;
      }
      return { matchConfig: next };
    }),

  setCuePlacementPreview: (x, z, valid, reason = null) =>
    set({
      cuePlacementPos: { x, z },
      cuePlacementValid: valid,
      cuePlacementReason: reason,
    }),

  setCalledShotSelection: (targetBall, targetPocket) =>
    set({ calledShot: { targetBall, targetPocket } }),

  setIsAiThinking: (isAiThinking) => set({ isAiThinking }),

  setAiStatus: (aiStatus) => set({ aiStatus }),

  setAiPullbackPower: (aiPullbackPower) =>
    set({ aiPullbackPower: Math.max(0, Math.min(1, aiPullbackPower)) }),

  dismissMatchBanner: () => set({ matchBanner: null }),

  setMatchStats: (matchStats) => set({ matchStats }),

  openOnlineLobby: (intent) =>
    set((state) => ({
      onlineLobbyOpen: true,
      onlineModeIntent: intent ?? state.onlineModeIntent,
      onlineError: null,
    })),

  closeOnlineLobby: () =>
    set({
      onlineLobbyOpen: false,
      onlineError: null,
    }),

  setOnlineModeIntent: (onlineModeIntent) => set({ onlineModeIntent }),

  setOnlineProfile: (partial) =>
    set((state) => {
      const next = {
        displayName:
          partial.displayName !== undefined
            ? partial.displayName.slice(0, 16)
            : state.onlineProfile.displayName,
        avatarId: partial.avatarId ?? state.onlineProfile.avatarId,
      };
      persistOnlineProfile(next);
      return { onlineProfile: next };
    }),

  setOnlineConnectionStatus: (onlineConnectionStatus) => set({ onlineConnectionStatus }),

  setOnlineSessionId: (onlineSessionId) => set({ onlineSessionId }),

  setOnlineLatencyMs: (onlineLatencyMs) => set({ onlineLatencyMs }),

  setOnlineRoom: (onlineRoom) =>
    set((state) => {
      const localRole =
        onlineRoom && state.onlineSessionId
          ? onlineRoom.players.find((p) => p.sessionId === state.onlineSessionId)?.role ?? null
          : null;
      return {
        onlineRoom,
        onlineLocalRole: localRole ?? state.onlineLocalRole,
      };
    }),

  setOnlineMatchmaking: (partial) =>
    set((state) => ({
      onlineMatchmaking: { ...state.onlineMatchmaking, ...partial },
    })),

  setOnlineOpponentStatus: (onlineOpponentStatus) => set({ onlineOpponentStatus }),

  setOnlineError: (onlineError) => set({ onlineError }),

  setOnlineHistory: (onlineHistory) => set({ onlineHistory }),

  syncFromOnlineMatchSnapshot: (snapshot, localRole, historyRecord, progression) =>
    set((state) => {
      const effectiveRole = localRole ?? state.onlineLocalRole;
      let nextStats = state.matchStats;
      let nextRecordedIds = state.onlineRecordedMatchIds;
      let nextHistory = state.onlineHistory;

      if (
        snapshot.phase === 'GAME_OVER' &&
        snapshot.winner &&
        !state.onlineRecordedMatchIds.includes(snapshot.matchId)
      ) {
        const won = effectiveRole ? snapshot.winner === effectiveRole : false;
        nextStats = {
          ...state.matchStats,
          matchesPlayed: state.matchStats.matchesPlayed + 1,
          wins: state.matchStats.wins + (won ? 1 : 0),
          losses: state.matchStats.losses + (won ? 0 : 1),
        };
        saveMatchStatistics(nextStats);
        nextRecordedIds = [...state.onlineRecordedMatchIds.slice(-30), snapshot.matchId];
        if (historyRecord && !state.onlineHistory.some((h) => h.matchId === historyRecord.matchId)) {
          nextHistory = [historyRecord, ...state.onlineHistory].slice(0, 30);
        }
      }

      return {
        matchConfig: {
          ...state.matchConfig,
          gameMode: 'eightBall',
          opponentType: 'online',
          player1Name: snapshot.player1Name,
          player2Name: snapshot.player2Name,
          ruleProfileId: snapshot.ruleProfileId,
          calledShotsEnabled: snapshot.calledShotsEnabled,
        },
        matchPhase: snapshot.phase,
        activePlayer: snapshot.activePlayer,
        isBreakShot: snapshot.isBreakShot,
        tableOpen: snapshot.tableOpen,
        playerGroups: snapshot.playerGroups,
        ballInHandZone: snapshot.ballInHandZone,
        cuePlacementPos: snapshot.cuePlacementPos,
        cuePlacementValid: true,
        cuePlacementReason: null,
        calledShot: snapshot.calledShot,
        pocketedNumbers: snapshot.pocketedNumbers,
        cueBallPocketed: false,
        winner: snapshot.winner,
        loser: snapshot.loser,
        gameOverReason: snapshot.gameOverReason,
        statusHeadline: snapshot.statusHeadline,
        lastFoulMessage: snapshot.lastFoulMessage,
        matchBanner: snapshot.banner,
        shotCount: snapshot.totalMatchShots,
        ballsMoving: snapshot.phase === 'BALLS_MOVING',
        onlineMatchId: snapshot.matchId,
        onlineLocalRole: effectiveRole,
        onlineRematchVotes: snapshot.rematchVotes,
        matchStats: nextStats,
        onlineRecordedMatchIds: nextRecordedIds,
        onlineHistory: nextHistory,
        lastOnlineMatchProgression:
          snapshot.phase === 'GAME_OVER'
            ? (progression ?? state.lastOnlineMatchProgression)
            : null,
      };
    }),

  clearOnlineMatchSession: () =>
    set((state) => ({
      onlineRoom: null,
      onlineMatchId: null,
      onlineLocalRole: null,
      onlineRematchVotes: [],
      lastOnlineMatchProgression: null,
      onlineOpponentStatus: {
        state: 'connected',
        displayName: null,
        graceDeadlineMs: null,
      },
      onlineMatchmaking: {
        active: false,
        startedAtMs: 0,
        timeoutAtMs: 0,
        position: 0,
        timedOutMessage: null,
      },
      matchConfig:
        state.matchConfig.opponentType === 'online'
          ? { ...state.matchConfig, opponentType: 'pvp', player2Name: 'Player 2' }
          : state.matchConfig,
    })),

  setOwnProfile: (ownProfile) => set({ ownProfile }),
  setLastOnlineMatchProgression: (lastOnlineMatchProgression) =>
    set({ lastOnlineMatchProgression }),
  openProgressionModal: (tab, inspectedPlayerId = null) =>
    set((state) => ({
      progressionModalOpen: true,
      progressionTab: tab ?? state.progressionTab,
      inspectedPlayerId,
    })),
  closeProgressionModal: () =>
    set({
      progressionModalOpen: false,
      inspectedPlayerId: null,
    }),
  setProgressionTab: (progressionTab) =>
    set({
      progressionTab,
      inspectedPlayerId: null,
    }),
  setInspectedPlayerId: (inspectedPlayerId) => set({ inspectedPlayerId }),
}));
