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
import type {
  ReplayCameraMode,
  ReplayHighlight,
  ReplayMode,
  ReplayShotSummary,
  ReplaySpeed,
  ReplayStorageStats,
  ReplayTimelineEvent,
  SavedReplaySummary,
} from '../game/replay/types';
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
  SpectatableMatchSummary,
  SpectatorCameraMode,
} from '../multiplayer/shared/protocol';
import {
  DEFAULT_PRIVACY_SETTINGS,
  type BlockedPlayerRecord,
  type ClubChallengeRecord,
  type ClubChatMessageRecord,
  type ClubDetailPayload,
  type ClubInvitationRecord,
  type ClubLeaderboardEntry,
  type ClubLeaderboardScope,
  type ClubRecord,
  type ClubTrophyRecord,
  type DirectMessageRecord,
  type FriendRecord,
  type FriendRequestRecord,
  type MatchInvitationRecord,
  type PlayerClubBadgeSummary,
  type PresenceStatus,
  type PrivacySettings,
  type RoomChatMessageRecord,
  type SocialNotificationRecord,
  type SocialOverviewPayload,
} from '../multiplayer/shared/social';
import type {
  ClubChampionshipDetailPayload,
  ClubChampionshipRecord,
  ClubTeamRecord,
  TeamEloRankingsPayload,
  TeamLeagueDetailPayload,
  TeamLeagueRecord,
} from '../multiplayer/shared/clubLeagues';
import {
  COSMETIC_CATALOG,
  DEFAULT_EQUIPPED_COSMETICS,
  STARTER_COSMETIC_IDS,
  sanitizeEquippedCosmetics,
  type AiMatchRewardResponse,
  type CoinTransactionRecord,
  type CosmeticCategory,
  type CosmeticItemDef,
  type DailyRewardStatus,
  type EquippedCosmetics,
  type WalletSummary,
} from '../multiplayer/shared/economy';
import type {
  PlayerTournamentStats,
  TournamentDetailPayload,
  TournamentLeaderboardEntry,
  TournamentMatch,
  TournamentRecord,
} from '../multiplayer/shared/tournaments';
import type {
  CompetitiveSeasonRecord,
  PlayerModerationStatus,
  PlayerSeasonStanding,
} from '../multiplayer/shared/ranked';
import type {
  AiMatchProgressResponse,
  BattlePassOverview,
} from '../multiplayer/shared/battlePass';
import {
  detectRecommendedQuality,
  sanitizeGraphicsQuality,
  type GraphicsQuality,
} from '../game/utils/graphicsQuality';
import {
  applyDocumentLocale,
  getInitialLanguage,
  normalizeLanguage,
  persistLanguage,
  type AppLanguage,
} from '../i18n/core';

const PROFILE_STORAGE_KEY = 'ultimate_pool_3d_online_profile_v1';
const COSMETICS_STORAGE_KEY = 'ultimate_pool_3d_cosmetics_v1';
const AUDIO_STORAGE_KEY = 'ultimate_pool_3d_audio_v1';
const GRAPHICS_STORAGE_KEY = 'ultimate_pool_3d_graphics_v1';

interface PersistedAudioPrefs {
  soundEnabled: boolean;
  soundVolume: number;
  sfxVolume: number;
  sfxMuted: boolean;
  musicVolume: number;
  musicMuted: boolean;
}

const DEFAULT_AUDIO_PREFS: PersistedAudioPrefs = {
  soundEnabled: true,
  soundVolume: 0.78,
  sfxVolume: 0.85,
  sfxMuted: false,
  musicVolume: 0.3,
  musicMuted: false,
};

function clampUnit(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
}

function loadSavedAudioPrefs(): PersistedAudioPrefs {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { ...DEFAULT_AUDIO_PREFS };
    }
    const raw = window.localStorage.getItem(AUDIO_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AUDIO_PREFS };
    const parsed = JSON.parse(raw) as Partial<PersistedAudioPrefs>;
    return {
      soundEnabled:
        typeof parsed.soundEnabled === 'boolean'
          ? parsed.soundEnabled
          : DEFAULT_AUDIO_PREFS.soundEnabled,
      soundVolume: clampUnit(parsed.soundVolume, DEFAULT_AUDIO_PREFS.soundVolume),
      sfxVolume: clampUnit(parsed.sfxVolume, DEFAULT_AUDIO_PREFS.sfxVolume),
      sfxMuted:
        typeof parsed.sfxMuted === 'boolean' ? parsed.sfxMuted : DEFAULT_AUDIO_PREFS.sfxMuted,
      musicVolume: clampUnit(parsed.musicVolume, DEFAULT_AUDIO_PREFS.musicVolume),
      musicMuted:
        typeof parsed.musicMuted === 'boolean'
          ? parsed.musicMuted
          : DEFAULT_AUDIO_PREFS.musicMuted,
    };
  } catch {
    return { ...DEFAULT_AUDIO_PREFS };
  }
}

function persistAudioPrefs(prefs: PersistedAudioPrefs): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // Ignore storage restriction
  }
}

interface PersistedGraphicsPrefs {
  graphicsQuality?: GraphicsQuality;
  shadowsEnabled?: boolean;
  showFps?: boolean;
  showDiagnostics?: boolean;
  feltTheme?: FeltTheme;
  showAimGuide?: boolean;
  cameraSensitivity?: number;
}

function loadSavedGraphicsPrefs(recommended: GraphicsQuality): {
  graphicsQuality: GraphicsQuality;
  shadowsEnabled: boolean;
  showFps: boolean;
  showDiagnostics: boolean;
  feltTheme: FeltTheme;
  showAimGuide: boolean;
  cameraSensitivity: number;
} {
  const defaults = {
    graphicsQuality: recommended,
    shadowsEnabled: recommended !== 'low',
    showFps: false,
    showDiagnostics: false,
    feltTheme: 'tournamentGreen' as FeltTheme,
    showAimGuide: true,
    cameraSensitivity: 1.0,
  };
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return defaults;
    }
    const raw = window.localStorage.getItem(GRAPHICS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as PersistedGraphicsPrefs;
    const savedQuality = sanitizeGraphicsQuality(parsed.graphicsQuality) ?? recommended;
    const validTheme: FeltTheme =
      parsed.feltTheme === 'tournamentGreen' ||
      parsed.feltTheme === 'championshipBlue' ||
      parsed.feltTheme === 'burgundyClub'
        ? parsed.feltTheme
        : defaults.feltTheme;
    return {
      graphicsQuality: savedQuality,
      shadowsEnabled:
        typeof parsed.shadowsEnabled === 'boolean'
          ? parsed.shadowsEnabled
          : savedQuality !== 'low',
      showFps: typeof parsed.showFps === 'boolean' ? parsed.showFps : defaults.showFps,
      showDiagnostics:
        typeof parsed.showDiagnostics === 'boolean'
          ? parsed.showDiagnostics
          : defaults.showDiagnostics,
      feltTheme: validTheme,
      showAimGuide:
        typeof parsed.showAimGuide === 'boolean' ? parsed.showAimGuide : defaults.showAimGuide,
      cameraSensitivity:
        typeof parsed.cameraSensitivity === 'number' && Number.isFinite(parsed.cameraSensitivity)
          ? Math.max(0.4, Math.min(2.0, parsed.cameraSensitivity))
          : defaults.cameraSensitivity,
    };
  } catch {
    return defaults;
  }
}

function persistGraphicsPrefs(settings: GameSettings): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(GRAPHICS_STORAGE_KEY, JSON.stringify(settings));
    }
  } catch {
    // Ignore storage restriction
  }
}

function makeClientMatchId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ai_${crypto.randomUUID()}`;
  }
  return `ai_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function loadSavedEquippedCosmetics(): EquippedCosmetics {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { ...DEFAULT_EQUIPPED_COSMETICS };
    }
    const raw = window.localStorage.getItem(COSMETICS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_EQUIPPED_COSMETICS };
    return sanitizeEquippedCosmetics(JSON.parse(raw) as Partial<EquippedCosmetics>);
  } catch {
    return { ...DEFAULT_EQUIPPED_COSMETICS };
  }
}

function persistEquippedCosmetics(equipped: EquippedCosmetics): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(COSMETICS_STORAGE_KEY, JSON.stringify(equipped));
    }
  } catch {
    // Ignore storage restriction
  }
}

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
export type ProgressionTab = 'profile' | 'leaderboard' | 'achievements' | 'history' | 'fairplay';
export type SocialTab =
  | 'friends'
  | 'search'
  | 'requests'
  | 'messages'
  | 'clubs'
  | 'club_rankings'
  | 'notifications'
  | 'privacy';
export type StoreTab = 'store' | 'inventory' | 'daily' | 'ledger';
export type StoreCategoryFilter = 'all' | CosmeticCategory;
export type TournamentTab = 'discover' | 'bracket' | 'leaderboard' | 'career' | 'admin';
export type BattlePassTab = 'pass' | 'daily' | 'weekly' | 'stats';
export type ClubLeagueTab = 'club_hq' | 'teams' | 'leagues' | 'championships' | 'rankings';
export type ClubLeagueLanguage = AppLanguage;

export type ProgressionNotificationKind =
  | 'mission_completed'
  | 'weekly_completed'
  | 'tier_unlocked'
  | 'reward_claimed'
  | 'season_started'
  | 'season_ending_soon';

export interface ProgressionNotificationItem {
  id: string;
  kind: ProgressionNotificationKind;
  title: string;
  detail: string;
  createdAtMs: number;
}

export interface TournamentMatchAlert {
  tournamentId: string;
  tournamentTitle: string;
  match: TournamentMatch;
  receivedAtMs: number;
}

export type CanvasInteractionMode = 'smart' | 'aim';

export interface CueSpin {
  x: number; // -0.78 (Left English) .. +0.78 (Right English)
  y: number; // -0.78 (Bottom/Draw) .. +0.78 (Top/Follow)
}

export type WebGlEngineStatus = 'active' | 'software' | 'context_lost';

export interface PerfDiagnosticsSnapshot {
  fps: number;
  avgFps: number;
  frameTimeMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  activeParticles: number;
}

export interface GameSettings {
  feltTheme: FeltTheme;
  graphicsQuality: GraphicsQuality;
  shadowsEnabled: boolean;
  showAimGuide: boolean;
  showFps: boolean;
  showDiagnostics: boolean;
  cameraSensitivity: number;
}

export interface OnlineMatchmakingState {
  active: boolean;
  mode: 'quick' | 'ranked';
  startedAtMs: number;
  timeoutAtMs: number;
  position: number;
  elo: number | null;
  eloSpread: number | null;
  region: string | null;
  estimatedWaitSec: number | null;
  timedOutMessage: string | null;
}

export interface OnlineOpponentStatus {
  state: OpponentConnectionState;
  displayName: string | null;
  graceDeadlineMs: number | null;
}

export interface GameState {
  language: AppLanguage;
  screen: GameScreen;
  settingsOpen: boolean;
  isLoading: boolean;
  loadError: string | null;
  webglStatus: WebGlEngineStatus;
  autoRecommendedQuality: GraphicsQuality;
  fps: number;
  perfStats: PerfDiagnosticsSnapshot;
  cameraPreset: CameraPreset;
  cameraRequestCounter: number;
  soundEnabled: boolean;
  soundVolume: number;
  sfxVolume: number;
  sfxMuted: boolean;
  musicVolume: number;
  musicMuted: boolean;
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

  // Spectator Mode State (Phase 14)
  onlineSpectating: boolean;
  spectatorSessionId: string | null;
  spectatorCameraMode: SpectatorCameraMode;
  spectatorZoomOffset: number;
  spectatorMutedPlayerIds: string[];
  spectatableMatches: SpectatableMatchSummary[];
  spectatableMatchesLoading: boolean;
  spectateReturnTarget: 'menu' | 'lobby' | 'tournament' | null;
  spectateReturnTournamentId: string | null;

  // Competitive Progression State (Phase 5)
  ownProfile: PublicPlayerProfile | null;
  lastOnlineMatchProgression: MatchProgressionRewardSummary | null;
  progressionModalOpen: boolean;
  progressionTab: ProgressionTab;
  inspectedPlayerId: string | null;

  // Replay & Shot Analysis State (Phase 6 & 13 - Strictly isolated from live match)
  replayShots: ReplayShotSummary[];
  replayActive: boolean;
  replayMode: ReplayMode;
  replayMatchId: string | null;
  replayShotId: string | null;
  replayShotIndex: number;
  replayTotalShots: number;
  replayPlaying: boolean;
  replayTimeSec: number;
  replayDurationSec: number;
  replayMatchTimeSec: number;
  replayMatchDurationSec: number;
  replaySpeed: ReplaySpeed;
  replayCameraMode: ReplayCameraMode;
  replayAutoSlowMo: boolean;
  replayShowAnalysis: boolean;
  replayActiveCollisionLabel: string | null;
  replayHighlights: ReplayHighlight[];
  replayTimelineEvents: ReplayTimelineEvent[];
  replayMatchMeta: {
    matchId: string;
    replayId: string;
    matchType: 'ai' | 'local' | 'online';
    ruleProfileId: 'casual' | 'wpa';
    player1Name: string;
    player2Name: string;
    player1Group: BallGroup;
    player2Group: BallGroup;
    player1PocketedCount: number;
    player2PocketedCount: number;
    winner: PlayerId | null;
    finalResult: string;
    authoritative: boolean;
  } | null;
  savedReplays: SavedReplaySummary[];
  replayStorageStats: ReplayStorageStats | null;
  pendingSavedReplayRequest: { replayId: string; seq: number } | null;
  replayIsRecordingVideo: boolean;
  replayVideoNotice: string | null;

  // Social, Presence, Invitations, Real-Time Chat, Privacy, Notifications & Clubs (Phase 7 & 15)
  socialModalOpen: boolean;
  socialTab: SocialTab;
  activeDmPeerId: string | null;
  selfPresence: PresenceStatus;
  friends: FriendRecord[];
  friendsTotal: number;
  incomingRequests: FriendRequestRecord[];
  outgoingRequests: FriendRequestRecord[];
  blockedPlayers: BlockedPlayerRecord[];
  incomingInvitations: MatchInvitationRecord[];
  outgoingInvitations: MatchInvitationRecord[];
  dmThreads: Record<string, DirectMessageRecord[]>;
  totalUnreadDmCount: number;
  roomChatMessages: RoomChatMessageRecord[];
  roomChatOpen: boolean;
  roomChatUnreadCount: number;
  socialNotice: { type: 'ok' | 'err'; text: string } | null;
  privacySettings: PrivacySettings;
  notifications: SocialNotificationRecord[];
  unreadNotificationCount: number;
  myClub: PlayerClubBadgeSummary | null;
  clubDetail: ClubDetailPayload | null;
  clubsList: ClubRecord[];
  incomingClubInvitations: ClubInvitationRecord[];
  clubLeaderboard: ClubLeaderboardEntry[];
  clubLeaderboardScope: ClubLeaderboardScope;

  // Economy, Store & Cosmetic Inventory (Phase 8)
  wallet: WalletSummary | null;
  inventoryIds: string[];
  equippedCosmetics: EquippedCosmetics;
  dailyReward: DailyRewardStatus | null;
  coinTransactions: CoinTransactionRecord[];
  storeModalOpen: boolean;
  storeTab: StoreTab;
  storeCategory: StoreCategoryFilter;
  storeCatalog: CosmeticItemDef[];
  aiMatchClientId: string;
  aiMatchStartedAtMs: number;
  lastAiRewardClaim: AiMatchRewardResponse | null;
  storeNotice: { type: 'ok' | 'err'; text: string } | null;

  // Global Tournaments & Championships (Phase 9)
  tournamentModalOpen: boolean;
  tournamentTab: TournamentTab;
  tournamentsList: TournamentRecord[];
  selectedTournamentId: string | null;
  activeTournamentDetail: TournamentDetailPayload | null;
  tournamentLeaderboard: TournamentLeaderboardEntry[];
  playerTournamentStats: PlayerTournamentStats | null;
  tournamentMatchAlert: TournamentMatchAlert | null;
  tournamentNotice: { type: 'ok' | 'err'; text: string } | null;

  // Ranked Seasons & Anti-Cheat / Moderation (Phase 10)
  activeSeason: CompetitiveSeasonRecord | null;
  seasonsList: CompetitiveSeasonRecord[];
  playerSeasonStanding: PlayerSeasonStanding | null;
  moderationStatus: PlayerModerationStatus | null;

  // Daily Missions, Weekly Challenges & Battle Pass (Phase 11)
  matchPlayer1BallsPocketed: number;
  matchPlayer1Fouls: number;
  matchPlayer1LegalEightBallWin: boolean;
  battlePassOverview: BattlePassOverview | null;
  battlePassModalOpen: boolean;
  battlePassTab: BattlePassTab;
  battlePassNotice: { type: 'ok' | 'err'; text: string } | null;
  lastAiBattlePassClaim: AiMatchProgressResponse | null;
  progressionNotifications: ProgressionNotificationItem[];

  // Phase 16 Professional Club Championships & Team Leagues
  clubLeagueModalOpen: boolean;
  clubLeagueTab: ClubLeagueTab;
  clubLeagueLanguage: ClubLeagueLanguage;
  clubTeams: ClubTeamRecord[];
  clubChatMessages: ClubChatMessageRecord[];
  clubTrophies: ClubTrophyRecord[];
  teamLeagues: TeamLeagueRecord[];
  selectedLeagueId: string | null;
  selectedLeagueDetail: TeamLeagueDetailPayload | null;
  clubChampionships: ClubChampionshipRecord[];
  selectedChampionshipId: string | null;
  selectedChampionshipDetail: ClubChampionshipDetailPayload | null;
  teamEloRankings: TeamEloRankingsPayload | null;
  clubLeagueNotice: { type: 'ok' | 'err'; text: string } | null;

  // Actions
  setLanguage: (language: AppLanguage) => void;
  setScreen: (screen: GameScreen) => void;
  setSettingsOpen: (open: boolean) => void;
  setLoading: (loading: boolean) => void;
  setLoadError: (error: string | null) => void;
  setWebglStatus: (status: WebGlEngineStatus) => void;
  setFps: (fps: number) => void;
  setPerfStats: (stats: PerfDiagnosticsSnapshot) => void;
  requestCameraPreset: (preset: CameraPreset) => void;
  toggleSound: () => void;
  setSoundVolume: (vol: number) => void;
  setSfxVolume: (vol: number) => void;
  toggleSfxMuted: () => void;
  setMusicVolume: (vol: number) => void;
  toggleMusicMuted: () => void;
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

  // Spectator Actions (Phase 14)
  setOnlineSpectating: (spectating: boolean, spectatorSessionId?: string | null) => void;
  setSpectatableMatches: (matches: SpectatableMatchSummary[]) => void;
  setSpectatableMatchesLoading: (loading: boolean) => void;
  setSpectatorCameraMode: (mode: SpectatorCameraMode) => void;
  adjustSpectatorZoom: (delta: number) => void;
  resetSpectatorZoom: () => void;
  toggleMuteSpectatorChatUser: (playerId: string) => void;
  setSpectateReturnContext: (
    target: 'menu' | 'lobby' | 'tournament' | null,
    tournamentId?: string | null,
  ) => void;

  // Progression Actions (Phase 5)
  setOwnProfile: (profile: PublicPlayerProfile | null) => void;
  setLastOnlineMatchProgression: (summary: MatchProgressionRewardSummary | null) => void;
  openProgressionModal: (tab?: ProgressionTab, inspectedPlayerId?: string | null) => void;
  closeProgressionModal: () => void;
  setProgressionTab: (tab: ProgressionTab) => void;
  setInspectedPlayerId: (playerId: string | null) => void;

  // Replay Actions (Phase 6 & 13)
  setReplayShots: (shots: ReplayShotSummary[]) => void;
  setSavedReplays: (savedReplays: SavedReplaySummary[], stats?: ReplayStorageStats | null) => void;
  requestWatchSavedReplay: (replayId: string) => void;
  clearWatchSavedReplayRequest: () => void;
  setReplayUiState: (
    partial: Partial<{
      replayActive: boolean;
      replayMode: ReplayMode;
      replayMatchId: string | null;
      replayShotId: string | null;
      replayShotIndex: number;
      replayTotalShots: number;
      replayPlaying: boolean;
      replayTimeSec: number;
      replayDurationSec: number;
      replayMatchTimeSec: number;
      replayMatchDurationSec: number;
      replaySpeed: ReplaySpeed;
      replayCameraMode: ReplayCameraMode;
      replayAutoSlowMo: boolean;
      replayShowAnalysis: boolean;
      replayActiveCollisionLabel: string | null;
      replayHighlights: ReplayHighlight[];
      replayTimelineEvents: ReplayTimelineEvent[];
      replayMatchMeta: GameState['replayMatchMeta'];
      replayIsRecordingVideo: boolean;
      replayVideoNotice: string | null;
    }>,
  ) => void;
  resetReplayUiState: () => void;

  // Social Actions (Phase 7 & 15)
  openSocialModal: (tab?: SocialTab, dmPeerId?: string | null) => void;
  closeSocialModal: () => void;
  setSocialTab: (tab: SocialTab) => void;
  setActiveDmPeerId: (peerId: string | null) => void;
  setSocialNotice: (notice: { type: 'ok' | 'err'; text: string } | null) => void;
  applySocialOverview: (overview: SocialOverviewPayload) => void;
  setFriendsPage: (friends: FriendRecord[], total: number, append?: boolean) => void;
  setPrivacySettings: (privacy: PrivacySettings) => void;
  applyNotificationNew: (notification: SocialNotificationRecord, unreadCount: number) => void;
  applyNotificationsUpdated: (
    notifications: SocialNotificationRecord[],
    unreadCount: number,
  ) => void;
  setMyClub: (club: PlayerClubBadgeSummary | null) => void;
  setClubDetail: (detail: ClubDetailPayload | null) => void;
  setClubsList: (clubs: ClubRecord[]) => void;
  setIncomingClubInvitations: (invitations: ClubInvitationRecord[]) => void;
  setClubLeaderboard: (scope: ClubLeaderboardScope, entries: ClubLeaderboardEntry[]) => void;
  applyClubChallengeUpdated: (challenge: ClubChallengeRecord) => void;
  updatePlayerPresence: (playerId: string, status: PresenceStatus, lastSeenAtMs: number) => void;
  upsertIncomingFriendRequest: (req: FriendRequestRecord) => void;
  upsertInvitation: (inv: MatchInvitationRecord) => void;
  setDmThreadMessages: (peerId: string, messages: DirectMessageRecord[]) => void;
  appendDirectMessage: (msg: DirectMessageRecord, selfPlayerId: string | null) => void;
  markDmThreadRead: (peerId: string, readerId: string, readAtMs: number, selfPlayerId: string | null) => void;
  setRoomChatHistory: (messages: RoomChatMessageRecord[]) => void;
  appendRoomChatMessage: (msg: RoomChatMessageRecord, selfPlayerId: string | null) => void;
  setRoomChatOpen: (open: boolean) => void;
  clearRoomChat: () => void;
  resetSocialState: () => void;

  // Economy & Store Actions (Phase 8)
  openStoreModal: (tab?: StoreTab, category?: StoreCategoryFilter) => void;
  closeStoreModal: () => void;
  setStoreTab: (tab: StoreTab) => void;
  setStoreCategory: (category: StoreCategoryFilter) => void;
  setStoreCatalog: (catalog: CosmeticItemDef[]) => void;
  applyEconomySnapshot: (snapshot: {
    wallet?: WalletSummary;
    inventoryIds?: string[];
    equipped?: EquippedCosmetics;
    dailyReward?: DailyRewardStatus;
  }) => void;
  setCoinTransactions: (transactions: CoinTransactionRecord[]) => void;
  setLastAiRewardClaim: (claim: AiMatchRewardResponse | null) => void;
  setStoreNotice: (notice: { type: 'ok' | 'err'; text: string } | null) => void;

  // Tournament Actions (Phase 9)
  openTournamentModal: (tab?: TournamentTab, tournamentId?: string | null) => void;
  closeTournamentModal: () => void;
  setTournamentTab: (tab: TournamentTab) => void;
  setTournamentsList: (tournaments: TournamentRecord[]) => void;
  setSelectedTournamentId: (tournamentId: string | null) => void;
  setActiveTournamentDetail: (detail: TournamentDetailPayload | null) => void;
  setTournamentLeaderboard: (entries: TournamentLeaderboardEntry[]) => void;
  setPlayerTournamentStats: (stats: PlayerTournamentStats | null) => void;
  setTournamentMatchAlert: (alert: TournamentMatchAlert | null) => void;
  setTournamentNotice: (notice: { type: 'ok' | 'err'; text: string } | null) => void;
  applyTournamentLiveUpdate: (
    tournament: TournamentRecord,
    matches?: TournamentMatch[],
  ) => void;
  applyTournamentCompleted: (tournament: TournamentRecord) => void;

  // Ranked Seasons & Moderation Actions (Phase 10)
  setSeasonsData: (
    activeSeason: CompetitiveSeasonRecord | null,
    seasonsList: CompetitiveSeasonRecord[],
  ) => void;
  setPlayerSeasonStanding: (standing: PlayerSeasonStanding | null) => void;
  setModerationStatus: (status: PlayerModerationStatus | null) => void;

  // Daily Missions, Weekly Challenges & Battle Pass Actions (Phase 11)
  openBattlePassModal: (tab?: BattlePassTab) => void;
  closeBattlePassModal: () => void;
  setBattlePassTab: (tab: BattlePassTab) => void;
  setBattlePassOverview: (overview: BattlePassOverview | null) => void;
  setBattlePassNotice: (notice: { type: 'ok' | 'err'; text: string } | null) => void;
  setLastAiBattlePassClaim: (claim: AiMatchProgressResponse | null) => void;
  pushProgressionNotification: (
    item: Omit<ProgressionNotificationItem, 'id' | 'createdAtMs'>,
  ) => void;
  dismissProgressionNotification: (id: string) => void;

  // Phase 16 Club League & Team Championship Actions
  openClubLeagueModal: (tab?: ClubLeagueTab) => void;
  closeClubLeagueModal: () => void;
  setClubLeagueTab: (tab: ClubLeagueTab) => void;
  setClubLeagueLanguage: (lang: ClubLeagueLanguage) => void;
  setClubTeams: (teams: ClubTeamRecord[]) => void;
  setClubChatMessages: (messages: ClubChatMessageRecord[]) => void;
  appendClubChatMessage: (message: ClubChatMessageRecord) => void;
  setClubTrophies: (trophies: ClubTrophyRecord[]) => void;
  setTeamLeagues: (leagues: TeamLeagueRecord[]) => void;
  setSelectedLeagueId: (leagueId: string | null) => void;
  setSelectedLeagueDetail: (detail: TeamLeagueDetailPayload | null) => void;
  setClubChampionships: (championships: ClubChampionshipRecord[]) => void;
  setSelectedChampionshipId: (championshipId: string | null) => void;
  setSelectedChampionshipDetail: (detail: ClubChampionshipDetailPayload | null) => void;
  setTeamEloRankings: (rankings: TeamEloRankingsPayload | null) => void;
  setClubLeagueNotice: (notice: { type: 'ok' | 'err'; text: string } | null) => void;
}

export function canLocalPlayerAct(state: GameState): boolean {
  if (state.replayActive) return false;
  if (state.onlineSpectating) return false;
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

const INITIAL_RECOMMENDED_QUALITY = detectRecommendedQuality();
const INITIAL_AUDIO_PREFS = loadSavedAudioPrefs();
const INITIAL_GRAPHICS_PREFS = loadSavedGraphicsPrefs(INITIAL_RECOMMENDED_QUALITY);
const INITIAL_LANGUAGE = getInitialLanguage();

export const useGameStore = create<GameState>((set) => ({
  language: INITIAL_LANGUAGE,
  screen: 'menu',
  settingsOpen: false,
  isLoading: true,
  loadError: null,
  webglStatus: 'active',
  autoRecommendedQuality: INITIAL_RECOMMENDED_QUALITY,
  fps: 60,
  perfStats: {
    fps: 60,
    avgFps: 60,
    frameTimeMs: 16.7,
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    activeParticles: 0,
  },
  cameraPreset: 'threeQuarter',
  cameraRequestCounter: 0,
  soundEnabled: INITIAL_AUDIO_PREFS.soundEnabled,
  soundVolume: INITIAL_AUDIO_PREFS.soundVolume,
  sfxVolume: INITIAL_AUDIO_PREFS.sfxVolume,
  sfxMuted: INITIAL_AUDIO_PREFS.sfxMuted,
  musicVolume: INITIAL_AUDIO_PREFS.musicVolume,
  musicMuted: INITIAL_AUDIO_PREFS.musicMuted,
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
    feltTheme: INITIAL_GRAPHICS_PREFS.feltTheme,
    graphicsQuality: INITIAL_GRAPHICS_PREFS.graphicsQuality,
    shadowsEnabled: INITIAL_GRAPHICS_PREFS.shadowsEnabled,
    showAimGuide: INITIAL_GRAPHICS_PREFS.showAimGuide,
    showFps: INITIAL_GRAPHICS_PREFS.showFps,
    showDiagnostics: INITIAL_GRAPHICS_PREFS.showDiagnostics,
    cameraSensitivity: INITIAL_GRAPHICS_PREFS.cameraSensitivity,
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
    mode: 'quick',
    startedAtMs: 0,
    timeoutAtMs: 0,
    position: 0,
    elo: null,
    eloSpread: null,
    region: null,
    estimatedWaitSec: null,
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

  onlineSpectating: false,
  spectatorSessionId: null,
  spectatorCameraMode: 'overview',
  spectatorZoomOffset: 0,
  spectatorMutedPlayerIds: [],
  spectatableMatches: [],
  spectatableMatchesLoading: false,
  spectateReturnTarget: null,
  spectateReturnTournamentId: null,

  ownProfile: null,
  lastOnlineMatchProgression: null,
  progressionModalOpen: false,
  progressionTab: 'profile',
  inspectedPlayerId: null,

  replayShots: [],
  replayActive: false,
  replayMode: 'shot',
  replayMatchId: null,
  replayShotId: null,
  replayShotIndex: 0,
  replayTotalShots: 0,
  replayPlaying: false,
  replayTimeSec: 0,
  replayDurationSec: 0,
  replayMatchTimeSec: 0,
  replayMatchDurationSec: 0,
  replaySpeed: 1,
  replayCameraMode: 'original',
  replayAutoSlowMo: false,
  replayShowAnalysis: true,
  replayActiveCollisionLabel: null,
  replayHighlights: [],
  replayTimelineEvents: [],
  replayMatchMeta: null,
  savedReplays: [],
  replayStorageStats: null,
  pendingSavedReplayRequest: null,
  replayIsRecordingVideo: false,
  replayVideoNotice: null,

  socialModalOpen: false,
  socialTab: 'friends',
  activeDmPeerId: null,
  selfPresence: 'offline',
  friends: [],
  friendsTotal: 0,
  incomingRequests: [],
  outgoingRequests: [],
  blockedPlayers: [],
  incomingInvitations: [],
  outgoingInvitations: [],
  dmThreads: {},
  totalUnreadDmCount: 0,
  roomChatMessages: [],
  roomChatOpen: false,
  roomChatUnreadCount: 0,
  socialNotice: null,
  privacySettings: { ...DEFAULT_PRIVACY_SETTINGS },
  notifications: [],
  unreadNotificationCount: 0,
  myClub: null,
  clubDetail: null,
  clubsList: [],
  incomingClubInvitations: [],
  clubLeaderboard: [],
  clubLeaderboardScope: 'global',

  wallet: null,
  inventoryIds: [...STARTER_COSMETIC_IDS],
  equippedCosmetics: loadSavedEquippedCosmetics(),
  dailyReward: null,
  coinTransactions: [],
  storeModalOpen: false,
  storeTab: 'store',
  storeCategory: 'all',
  storeCatalog: COSMETIC_CATALOG,
  aiMatchClientId: makeClientMatchId(),
  aiMatchStartedAtMs: Date.now(),
  lastAiRewardClaim: null,
  storeNotice: null,

  tournamentModalOpen: false,
  tournamentTab: 'discover',
  tournamentsList: [],
  selectedTournamentId: null,
  activeTournamentDetail: null,
  tournamentLeaderboard: [],
  playerTournamentStats: null,
  tournamentMatchAlert: null,
  tournamentNotice: null,

  activeSeason: null,
  seasonsList: [],
  playerSeasonStanding: null,
  moderationStatus: null,

  matchPlayer1BallsPocketed: 0,
  matchPlayer1Fouls: 0,
  matchPlayer1LegalEightBallWin: false,
  battlePassOverview: null,
  battlePassModalOpen: false,
  battlePassTab: 'pass',
  battlePassNotice: null,
  lastAiBattlePassClaim: null,
  progressionNotifications: [],

  clubLeagueModalOpen: false,
  clubLeagueTab: 'club_hq',
  clubLeagueLanguage: INITIAL_LANGUAGE,
  clubTeams: [],
  clubChatMessages: [],
  clubTrophies: [],
  teamLeagues: [],
  selectedLeagueId: null,
  selectedLeagueDetail: null,
  clubChampionships: [],
  selectedChampionshipId: null,
  selectedChampionshipDetail: null,
  teamEloRankings: null,
  clubLeagueNotice: null,

  setLanguage: (nextLang) => {
    const safe = normalizeLanguage(nextLang);
    persistLanguage(safe);
    applyDocumentLocale(safe);
    set({ language: safe, clubLeagueLanguage: safe });
  },
  setScreen: (screen) => set({ screen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setLoading: (isLoading) => set({ isLoading }),
  setLoadError: (loadError) => set({ loadError }),
  setWebglStatus: (webglStatus) => set({ webglStatus }),
  setFps: (fps) => set({ fps }),
  setPerfStats: (perfStats) => set({ perfStats, fps: perfStats.fps }),
  requestCameraPreset: (cameraPreset) =>
    set((state) => ({
      cameraPreset,
      cameraRequestCounter: state.cameraRequestCounter + 1,
    })),
  toggleSound: () =>
    set((state) => {
      const next = {
        soundEnabled: !state.soundEnabled,
        soundVolume: state.soundVolume,
        sfxVolume: state.sfxVolume,
        sfxMuted: state.sfxMuted,
        musicVolume: state.musicVolume,
        musicMuted: state.musicMuted,
      };
      persistAudioPrefs(next);
      return { soundEnabled: next.soundEnabled };
    }),
  setSoundVolume: (soundVolume) =>
    set((state) => {
      const v = Math.max(0, Math.min(1, soundVolume));
      persistAudioPrefs({
        soundEnabled: state.soundEnabled,
        soundVolume: v,
        sfxVolume: state.sfxVolume,
        sfxMuted: state.sfxMuted,
        musicVolume: state.musicVolume,
        musicMuted: state.musicMuted,
      });
      return { soundVolume: v };
    }),
  setSfxVolume: (sfxVolume) =>
    set((state) => {
      const v = Math.max(0, Math.min(1, sfxVolume));
      persistAudioPrefs({
        soundEnabled: state.soundEnabled,
        soundVolume: state.soundVolume,
        sfxVolume: v,
        sfxMuted: state.sfxMuted,
        musicVolume: state.musicVolume,
        musicMuted: state.musicMuted,
      });
      return { sfxVolume: v };
    }),
  toggleSfxMuted: () =>
    set((state) => {
      const nextMuted = !state.sfxMuted;
      persistAudioPrefs({
        soundEnabled: state.soundEnabled,
        soundVolume: state.soundVolume,
        sfxVolume: state.sfxVolume,
        sfxMuted: nextMuted,
        musicVolume: state.musicVolume,
        musicMuted: state.musicMuted,
      });
      return { sfxMuted: nextMuted };
    }),
  setMusicVolume: (musicVolume) =>
    set((state) => {
      const v = Math.max(0, Math.min(1, musicVolume));
      persistAudioPrefs({
        soundEnabled: state.soundEnabled,
        soundVolume: state.soundVolume,
        sfxVolume: state.sfxVolume,
        sfxMuted: state.sfxMuted,
        musicVolume: v,
        musicMuted: state.musicMuted,
      });
      return { musicVolume: v };
    }),
  toggleMusicMuted: () =>
    set((state) => {
      const nextMuted = !state.musicMuted;
      persistAudioPrefs({
        soundEnabled: state.soundEnabled,
        soundVolume: state.soundVolume,
        sfxVolume: state.sfxVolume,
        sfxMuted: state.sfxMuted,
        musicVolume: state.musicVolume,
        musicMuted: nextMuted,
      });
      return { musicMuted: nextMuted };
    }),
  setIsFullscreen: (isFullscreen) => set({ isFullscreen }),
  toggleHudCollapsed: () => set((state) => ({ hudCollapsed: !state.hudCollapsed })),
  setCueAngle: (cueAngle) => set({ cueAngle }),
  adjustCueAngle: (delta) => set((state) => ({ cueAngle: state.cueAngle + delta })),
  resetCueAngle: () => set({ cueAngle: 0 }),
  setCueSpin: (x, y) => set({ cueSpin: clampCueSpin(x, y) }),
  resetCueSpin: () => set({ cueSpin: { x: 0, y: 0 } }),
  setCanvasInteractionMode: (canvasInteractionMode) => set({ canvasInteractionMode }),
  toggleShowAimGuide: () =>
    set((state) => {
      const next = { ...state.settings, showAimGuide: !state.settings.showAimGuide };
      persistGraphicsPrefs(next);
      return { settings: next };
    }),
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
      replayShots: [],
      replayActive: false,
      replayShotId: null,
      replayPlaying: false,
      replayTimeSec: 0,
      replayDurationSec: 0,
      replayActiveCollisionLabel: null,
      aiMatchClientId: makeClientMatchId(),
      aiMatchStartedAtMs: Date.now(),
      lastAiRewardClaim: null,
      lastAiBattlePassClaim: null,
      matchPlayer1BallsPocketed: 0,
      matchPlayer1Fouls: 0,
      matchPlayer1LegalEightBallWin: false,
    }),
  updateSettings: (partial) =>
    set((state) => {
      const next = { ...state.settings, ...partial };
      persistGraphicsPrefs(next);
      return { settings: next };
    }),

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
      matchPlayer1BallsPocketed: snapshot.player1BallsPocketed,
      matchPlayer1Fouls: snapshot.player1Fouls,
      matchPlayer1LegalEightBallWin: snapshot.player1LegalEightBallWin,
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
      if (state.onlineSpectating) {
        return {
          onlineRoom,
          onlineLocalRole: null,
        };
      }
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
        mode: 'quick',
        startedAtMs: 0,
        timeoutAtMs: 0,
        position: 0,
        elo: null,
        eloSpread: null,
        region: null,
        estimatedWaitSec: null,
        timedOutMessage: null,
      },
      matchConfig:
        state.matchConfig.opponentType === 'online'
          ? { ...state.matchConfig, opponentType: 'pvp', player2Name: 'Player 2' }
          : state.matchConfig,
      replayShots: [],
      replayActive: false,
      replayShotId: null,
      replayPlaying: false,
      replayTimeSec: 0,
      replayDurationSec: 0,
      replayActiveCollisionLabel: null,
      roomChatMessages: [],
      roomChatOpen: false,
      roomChatUnreadCount: 0,
      onlineSpectating: false,
      spectatorSessionId: null,
      spectatorCameraMode: 'overview',
      spectatorZoomOffset: 0,
      spectateReturnTarget: null,
      spectateReturnTournamentId: null,
    })),

  setOnlineSpectating: (onlineSpectating, spectatorSessionId) =>
    set((state) => ({
      onlineSpectating,
      spectatorSessionId:
        spectatorSessionId !== undefined
          ? spectatorSessionId
          : onlineSpectating
            ? state.spectatorSessionId
            : null,
      onlineLocalRole: onlineSpectating ? null : state.onlineLocalRole,
    })),
  setSpectatableMatches: (spectatableMatches) => set({ spectatableMatches }),
  setSpectatableMatchesLoading: (spectatableMatchesLoading) => set({ spectatableMatchesLoading }),
  setSpectatorCameraMode: (spectatorCameraMode) =>
    set({ spectatorCameraMode, spectatorZoomOffset: 0 }),
  adjustSpectatorZoom: (delta) =>
    set((state) => ({
      spectatorZoomOffset: Math.max(-0.45, Math.min(0.75, state.spectatorZoomOffset + delta)),
    })),
  resetSpectatorZoom: () => set({ spectatorZoomOffset: 0 }),
  toggleMuteSpectatorChatUser: (playerId) =>
    set((state) => {
      const exists = state.spectatorMutedPlayerIds.includes(playerId);
      return {
        spectatorMutedPlayerIds: exists
          ? state.spectatorMutedPlayerIds.filter((id) => id !== playerId)
          : [...state.spectatorMutedPlayerIds, playerId],
      };
    }),
  setSpectateReturnContext: (spectateReturnTarget, spectateReturnTournamentId = null) =>
    set({
      spectateReturnTarget,
      spectateReturnTournamentId: spectateReturnTournamentId ?? null,
    }),

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

  setReplayShots: (replayShots) => set({ replayShots }),
  setSavedReplays: (savedReplays, stats) =>
    set((state) => ({
      savedReplays,
      replayStorageStats: stats !== undefined ? stats : state.replayStorageStats,
    })),
  requestWatchSavedReplay: (replayId) =>
    set((state) => ({
      pendingSavedReplayRequest: {
        replayId,
        seq: (state.pendingSavedReplayRequest?.seq ?? 0) + 1,
      },
    })),
  clearWatchSavedReplayRequest: () => set({ pendingSavedReplayRequest: null }),
  setReplayUiState: (partial) => set(partial),
  resetReplayUiState: () =>
    set({
      replayActive: false,
      replayMode: 'shot',
      replayMatchId: null,
      replayShotId: null,
      replayShotIndex: 0,
      replayTotalShots: 0,
      replayPlaying: false,
      replayTimeSec: 0,
      replayDurationSec: 0,
      replayMatchTimeSec: 0,
      replayMatchDurationSec: 0,
      replayActiveCollisionLabel: null,
      replayHighlights: [],
      replayTimelineEvents: [],
      replayMatchMeta: null,
      replayIsRecordingVideo: false,
      replayVideoNotice: null,
    }),

  openSocialModal: (tab, dmPeerId = null) =>
    set((state) => ({
      socialModalOpen: true,
      socialTab: tab ?? (dmPeerId ? 'messages' : state.socialTab),
      activeDmPeerId: dmPeerId ?? state.activeDmPeerId,
      socialNotice: null,
    })),
  closeSocialModal: () =>
    set({
      socialModalOpen: false,
      socialNotice: null,
    }),
  setSocialTab: (socialTab) => set({ socialTab, socialNotice: null }),
  setActiveDmPeerId: (activeDmPeerId) => set({ activeDmPeerId }),
  setSocialNotice: (socialNotice) => set({ socialNotice }),
  applySocialOverview: (overview) =>
    set((state) => ({
      selfPresence: overview.selfPresence,
      friends: overview.friends,
      friendsTotal: overview.friendsTotal ?? overview.friends.length,
      incomingRequests: overview.incomingRequests,
      outgoingRequests: overview.outgoingRequests,
      blockedPlayers: overview.blocked,
      incomingInvitations: overview.incomingInvitations,
      outgoingInvitations: overview.outgoingInvitations,
      totalUnreadDmCount: overview.totalUnreadDmCount,
      privacySettings: overview.privacy ?? state.privacySettings,
      notifications: overview.notifications ?? state.notifications,
      unreadNotificationCount:
        overview.unreadNotificationCount !== undefined
          ? overview.unreadNotificationCount
          : state.unreadNotificationCount,
      myClub: overview.myClub !== undefined ? overview.myClub : state.myClub,
      incomingClubInvitations:
        overview.incomingClubInvitations ?? state.incomingClubInvitations,
    })),
  setFriendsPage: (friends, total, append = false) =>
    set((state) => {
      if (!append) {
        return { friends, friendsTotal: total };
      }
      const seen = new Set(state.friends.map((f) => f.playerId));
      const merged = [...state.friends, ...friends.filter((f) => !seen.has(f.playerId))];
      return { friends: merged, friendsTotal: total };
    }),
  setPrivacySettings: (privacySettings) => set({ privacySettings }),
  applyNotificationNew: (notification, unreadNotificationCount) =>
    set((state) => ({
      notifications: [
        notification,
        ...state.notifications.filter((n) => n.notificationId !== notification.notificationId),
      ].slice(0, 100),
      unreadNotificationCount,
    })),
  applyNotificationsUpdated: (notifications, unreadNotificationCount) =>
    set({ notifications, unreadNotificationCount }),
  setMyClub: (myClub) => set({ myClub }),
  setClubDetail: (clubDetail) => set({ clubDetail }),
  setClubsList: (clubsList) => set({ clubsList }),
  setIncomingClubInvitations: (incomingClubInvitations) => set({ incomingClubInvitations }),
  setClubLeaderboard: (clubLeaderboardScope, clubLeaderboard) =>
    set({ clubLeaderboardScope, clubLeaderboard }),
  applyClubChallengeUpdated: (challenge) =>
    set((state) => {
      if (!state.clubDetail) return state;
      const isRelated =
        state.clubDetail.club.clubId === challenge.challengerClubId ||
        state.clubDetail.club.clubId === challenge.targetClubId;
      if (!isRelated) return state;
      const idx = state.clubDetail.challenges.findIndex(
        (c) => c.challengeId === challenge.challengeId,
      );
      const nextChallenges =
        idx >= 0
          ? state.clubDetail.challenges.map((c, i) => (i === idx ? challenge : c))
          : [challenge, ...state.clubDetail.challenges];
      return {
        clubDetail: {
          ...state.clubDetail,
          challenges: nextChallenges,
        },
      };
    }),
  updatePlayerPresence: (playerId, status, lastSeenAtMs) =>
    set((state) => ({
      selfPresence: state.ownProfile?.playerId === playerId ? status : state.selfPresence,
      friends: state.friends.map((f) =>
        f.playerId === playerId ? { ...f, presence: status, lastSeenAtMs } : f,
      ),
    })),
  upsertIncomingFriendRequest: (req) =>
    set((state) => {
      if (state.incomingRequests.some((r) => r.playerId === req.playerId)) {
        return state;
      }
      return {
        incomingRequests: [req, ...state.incomingRequests],
      };
    }),
  upsertInvitation: (inv) =>
    set((state) => {
      const myId = state.ownProfile?.playerId ?? null;
      const now = Date.now();
      const activePending = inv.status === 'pending' && inv.expiresAtMs > now;
      if (myId && inv.recipientId === myId) {
        const rest = state.incomingInvitations.filter((i) => i.inviteId !== inv.inviteId);
        return {
          incomingInvitations: activePending ? [inv, ...rest] : rest,
        };
      }
      if (myId && inv.senderId === myId) {
        const rest = state.outgoingInvitations.filter((i) => i.inviteId !== inv.inviteId);
        return {
          outgoingInvitations: activePending ? [inv, ...rest] : rest,
        };
      }
      return state;
    }),
  setDmThreadMessages: (peerId, messages) =>
    set((state) => {
      let clearedUnread = 0;
      const friends = state.friends.map((f) => {
        if (f.playerId === peerId) {
          clearedUnread = f.unreadDmCount;
          return { ...f, unreadDmCount: 0 };
        }
        return f;
      });
      return {
        dmThreads: { ...state.dmThreads, [peerId]: messages },
        friends,
        totalUnreadDmCount: Math.max(0, state.totalUnreadDmCount - clearedUnread),
      };
    }),
  appendDirectMessage: (msg, selfPlayerId) =>
    set((state) => {
      const peerId = msg.senderId === selfPlayerId ? msg.recipientId : msg.senderId;
      const existing = state.dmThreads[peerId] ?? [];
      if (existing.some((m) => m.messageId === msg.messageId)) {
        return state;
      }
      const isIncoming = Boolean(selfPlayerId && msg.recipientId === selfPlayerId);
      const isViewingThread =
        state.socialModalOpen &&
        state.socialTab === 'messages' &&
        state.activeDmPeerId === peerId;

      const incrementUnread = isIncoming && !isViewingThread ? 1 : 0;
      return {
        dmThreads: {
          ...state.dmThreads,
          [peerId]: [...existing, msg].slice(-80),
        },
        friends: state.friends.map((f) =>
          f.playerId === peerId
            ? { ...f, unreadDmCount: f.unreadDmCount + incrementUnread }
            : f,
        ),
        totalUnreadDmCount: state.totalUnreadDmCount + incrementUnread,
      };
    }),
  markDmThreadRead: (peerId, readerId, readAtMs, selfPlayerId) =>
    set((state) => {
      const targetPeer = readerId === selfPlayerId ? peerId : readerId;
      const thread = state.dmThreads[targetPeer];
      const updatedThreads = thread
        ? {
            ...state.dmThreads,
            [targetPeer]: thread.map((m) =>
              m.recipientId === readerId && m.readAtMs === null ? { ...m, readAtMs } : m,
            ),
          }
        : state.dmThreads;

      let clearedUnread = 0;
      const friends =
        readerId === selfPlayerId
          ? state.friends.map((f) => {
              if (f.playerId === targetPeer) {
                clearedUnread = f.unreadDmCount;
                return { ...f, unreadDmCount: 0 };
              }
              return f;
            })
          : state.friends;

      return {
        dmThreads: updatedThreads,
        friends,
        totalUnreadDmCount: Math.max(0, state.totalUnreadDmCount - clearedUnread),
      };
    }),
  setRoomChatHistory: (roomChatMessages) =>
    set({
      roomChatMessages,
      roomChatUnreadCount: 0,
    }),
  appendRoomChatMessage: (msg, selfPlayerId) =>
    set((state) => {
      if (state.roomChatMessages.some((m) => m.messageId === msg.messageId)) {
        return state;
      }
      const isSelf = Boolean(selfPlayerId && msg.senderPlayerId === selfPlayerId);
      const bumpUnread = !state.roomChatOpen && !isSelf ? 1 : 0;
      return {
        roomChatMessages: [...state.roomChatMessages, msg].slice(-80),
        roomChatUnreadCount: state.roomChatUnreadCount + bumpUnread,
      };
    }),
  setRoomChatOpen: (roomChatOpen) =>
    set((state) => ({
      roomChatOpen,
      roomChatUnreadCount: roomChatOpen ? 0 : state.roomChatUnreadCount,
    })),
  clearRoomChat: () =>
    set({
      roomChatMessages: [],
      roomChatOpen: false,
      roomChatUnreadCount: 0,
    }),
  resetSocialState: () =>
    set({
      selfPresence: 'offline',
      friends: [],
      friendsTotal: 0,
      incomingRequests: [],
      outgoingRequests: [],
      blockedPlayers: [],
      incomingInvitations: [],
      outgoingInvitations: [],
      dmThreads: {},
      totalUnreadDmCount: 0,
      roomChatMessages: [],
      roomChatOpen: false,
      roomChatUnreadCount: 0,
      socialNotice: null,
      privacySettings: { ...DEFAULT_PRIVACY_SETTINGS },
      notifications: [],
      unreadNotificationCount: 0,
      myClub: null,
      clubDetail: null,
      clubsList: [],
      incomingClubInvitations: [],
      clubLeaderboard: [],
      clubLeaderboardScope: 'global',
    }),

  openStoreModal: (tab, category) =>
    set((state) => ({
      storeModalOpen: true,
      storeTab: tab ?? state.storeTab,
      storeCategory: category ?? state.storeCategory,
      storeNotice: null,
    })),
  closeStoreModal: () => set({ storeModalOpen: false, storeNotice: null }),
  setStoreTab: (storeTab) => set({ storeTab, storeNotice: null }),
  setStoreCategory: (storeCategory) => set({ storeCategory }),
  setStoreCatalog: (storeCatalog) => set({ storeCatalog }),
  applyEconomySnapshot: (snapshot) =>
    set((state) => {
      const nextEquipped = snapshot.equipped
        ? sanitizeEquippedCosmetics(snapshot.equipped)
        : state.equippedCosmetics;
      if (snapshot.equipped) {
        persistEquippedCosmetics(nextEquipped);
      }
      return {
        wallet: snapshot.wallet ?? state.wallet,
        inventoryIds: snapshot.inventoryIds ?? state.inventoryIds,
        equippedCosmetics: nextEquipped,
        dailyReward: snapshot.dailyReward ?? state.dailyReward,
      };
    }),
  setCoinTransactions: (coinTransactions) => set({ coinTransactions }),
  setLastAiRewardClaim: (lastAiRewardClaim) => set({ lastAiRewardClaim }),
  setStoreNotice: (storeNotice) => set({ storeNotice }),

  openTournamentModal: (tab, tournamentId) =>
    set((state) => ({
      tournamentModalOpen: true,
      tournamentTab: tab ?? state.tournamentTab,
      selectedTournamentId:
        tournamentId !== undefined ? tournamentId : state.selectedTournamentId,
      tournamentNotice: null,
    })),
  closeTournamentModal: () =>
    set({
      tournamentModalOpen: false,
      tournamentNotice: null,
    }),
  setTournamentTab: (tournamentTab) => set({ tournamentTab, tournamentNotice: null }),
  setTournamentsList: (tournamentsList) => set({ tournamentsList }),
  setSelectedTournamentId: (selectedTournamentId) => set({ selectedTournamentId }),
  setActiveTournamentDetail: (activeTournamentDetail) =>
    set((state) => {
      if (!activeTournamentDetail) return { activeTournamentDetail: null };
      const idx = state.tournamentsList.findIndex(
        (t) => t.tournamentId === activeTournamentDetail.tournament.tournamentId,
      );
      const nextList =
        idx >= 0
          ? state.tournamentsList.map((t, i) =>
              i === idx ? activeTournamentDetail.tournament : t,
            )
          : [activeTournamentDetail.tournament, ...state.tournamentsList];
      return {
        activeTournamentDetail,
        selectedTournamentId: activeTournamentDetail.tournament.tournamentId,
        tournamentsList: nextList,
      };
    }),
  setTournamentLeaderboard: (tournamentLeaderboard) => set({ tournamentLeaderboard }),
  setPlayerTournamentStats: (playerTournamentStats) => set({ playerTournamentStats }),
  setTournamentMatchAlert: (tournamentMatchAlert) => set({ tournamentMatchAlert }),
  setTournamentNotice: (tournamentNotice) => set({ tournamentNotice }),
  applyTournamentLiveUpdate: (tournament, matches) =>
    set((state) => {
      const idx = state.tournamentsList.findIndex(
        (t) => t.tournamentId === tournament.tournamentId,
      );
      const nextList =
        idx >= 0
          ? state.tournamentsList.map((t, i) => (i === idx ? tournament : t))
          : [tournament, ...state.tournamentsList];

      let nextDetail = state.activeTournamentDetail;
      if (nextDetail && nextDetail.tournament.tournamentId === tournament.tournamentId) {
        const nextMatches = matches ?? nextDetail.matches;
        const selfId = state.ownProfile?.playerId ?? null;
        const activeMatch =
          selfId
            ? (nextMatches.find(
                (m) =>
                  (m.status === 'ready' || m.status === 'in_progress') &&
                  (m.player1Id === selfId || m.player2Id === selfId),
              ) ?? null)
            : null;
        nextDetail = {
          ...nextDetail,
          tournament,
          matches: nextMatches,
          viewerStatus: {
            ...nextDetail.viewerStatus,
            activeMatch,
          },
        };
      }

      const nextAlert =
        state.tournamentMatchAlert &&
        state.tournamentMatchAlert.tournamentId === tournament.tournamentId &&
        matches
          ? (() => {
              const updatedM = matches.find(
                (m) => m.bracketMatchId === state.tournamentMatchAlert!.match.bracketMatchId,
              );
              if (updatedM && updatedM.status !== 'ready' && updatedM.status !== 'in_progress') {
                return null;
              }
              return updatedM
                ? { ...state.tournamentMatchAlert, match: updatedM }
                : state.tournamentMatchAlert;
            })()
          : state.tournamentMatchAlert;

      return {
        tournamentsList: nextList,
        activeTournamentDetail: nextDetail,
        tournamentMatchAlert: nextAlert,
      };
    }),
  applyTournamentCompleted: (tournament) =>
    set((state) => {
      const nextList = state.tournamentsList.map((t) =>
        t.tournamentId === tournament.tournamentId ? tournament : t,
      );
      const nextDetail =
        state.activeTournamentDetail &&
        state.activeTournamentDetail.tournament.tournamentId === tournament.tournamentId
          ? { ...state.activeTournamentDetail, tournament }
          : state.activeTournamentDetail;
      const championBanner = tournament.championDisplayName
        ? `${tournament.title} completed — Champion: ${tournament.championDisplayName}!`
        : `${tournament.title} completed.`;
      return {
        tournamentsList: nextList,
        activeTournamentDetail: nextDetail,
        tournamentMatchAlert:
          state.tournamentMatchAlert?.tournamentId === tournament.tournamentId
            ? null
            : state.tournamentMatchAlert,
        tournamentNotice: { type: 'ok', text: championBanner },
      };
    }),

  setSeasonsData: (activeSeason, seasonsList) => set({ activeSeason, seasonsList }),
  setPlayerSeasonStanding: (playerSeasonStanding) => set({ playerSeasonStanding }),
  setModerationStatus: (moderationStatus) => set({ moderationStatus }),

  openBattlePassModal: (tab) =>
    set((state) => ({
      battlePassModalOpen: true,
      battlePassTab: tab ?? state.battlePassTab,
      battlePassNotice: null,
    })),
  closeBattlePassModal: () => set({ battlePassModalOpen: false, battlePassNotice: null }),
  setBattlePassTab: (battlePassTab) => set({ battlePassTab, battlePassNotice: null }),
  setBattlePassOverview: (battlePassOverview) => set({ battlePassOverview }),
  setBattlePassNotice: (battlePassNotice) => set({ battlePassNotice }),
  setLastAiBattlePassClaim: (lastAiBattlePassClaim) => set({ lastAiBattlePassClaim }),
  pushProgressionNotification: (item) =>
    set((state) => {
      const deduped = state.progressionNotifications.some(
        (existing) => existing.kind === item.kind && existing.title === item.title,
      );
      if (deduped) return state;
      const next: ProgressionNotificationItem = {
        ...item,
        id: `prog_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        createdAtMs: Date.now(),
      };
      return {
        progressionNotifications: [...state.progressionNotifications.slice(-3), next],
      };
    }),
  dismissProgressionNotification: (id) =>
    set((state) => ({
      progressionNotifications: state.progressionNotifications.filter((n) => n.id !== id),
    })),

  openClubLeagueModal: (tab) =>
    set((state) => ({
      clubLeagueModalOpen: true,
      clubLeagueTab: tab ?? state.clubLeagueTab,
      clubLeagueNotice: null,
    })),
  closeClubLeagueModal: () => set({ clubLeagueModalOpen: false, clubLeagueNotice: null }),
  setClubLeagueTab: (clubLeagueTab) => set({ clubLeagueTab, clubLeagueNotice: null }),
  setClubLeagueLanguage: (clubLeagueLanguage) => {
    const safe = normalizeLanguage(clubLeagueLanguage);
    persistLanguage(safe);
    applyDocumentLocale(safe);
    set({ language: safe, clubLeagueLanguage: safe });
  },
  setClubTeams: (clubTeams) => set({ clubTeams }),
  setClubChatMessages: (clubChatMessages) => set({ clubChatMessages }),
  appendClubChatMessage: (message) =>
    set((state) => {
      if (state.clubChatMessages.some((m) => m.messageId === message.messageId)) {
        return state;
      }
      return {
        clubChatMessages: [...state.clubChatMessages, message].slice(-80),
      };
    }),
  setClubTrophies: (clubTrophies) => set({ clubTrophies }),
  setTeamLeagues: (teamLeagues) => set({ teamLeagues }),
  setSelectedLeagueId: (selectedLeagueId) => set({ selectedLeagueId }),
  setSelectedLeagueDetail: (selectedLeagueDetail) =>
    set((state) => {
      if (!selectedLeagueDetail) return { selectedLeagueDetail: null };
      const idx = state.teamLeagues.findIndex(
        (l) => l.leagueId === selectedLeagueDetail.league.leagueId,
      );
      const nextLeagues =
        idx >= 0
          ? state.teamLeagues.map((l, i) =>
              i === idx ? selectedLeagueDetail.league : l,
            )
          : [selectedLeagueDetail.league, ...state.teamLeagues];
      return {
        selectedLeagueDetail,
        selectedLeagueId: selectedLeagueDetail.league.leagueId,
        teamLeagues: nextLeagues,
      };
    }),
  setClubChampionships: (clubChampionships) => set({ clubChampionships }),
  setSelectedChampionshipId: (selectedChampionshipId) => set({ selectedChampionshipId }),
  setSelectedChampionshipDetail: (selectedChampionshipDetail) =>
    set((state) => {
      if (!selectedChampionshipDetail) return { selectedChampionshipDetail: null };
      const idx = state.clubChampionships.findIndex(
        (c) => c.championshipId === selectedChampionshipDetail.championship.championshipId,
      );
      const nextList =
        idx >= 0
          ? state.clubChampionships.map((c, i) =>
              i === idx ? selectedChampionshipDetail.championship : c,
            )
          : [selectedChampionshipDetail.championship, ...state.clubChampionships];
      return {
        selectedChampionshipDetail,
        selectedChampionshipId: selectedChampionshipDetail.championship.championshipId,
        clubChampionships: nextList,
      };
    }),
  setTeamEloRankings: (teamEloRankings) => set({ teamEloRankings }),
  setClubLeagueNotice: (clubLeagueNotice) => set({ clubLeagueNotice }),
}));
