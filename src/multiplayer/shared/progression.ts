import type { PlayerId, RuleProfileId } from '../../game/rules/types';

export type LeaderboardScope = 'global' | 'weekly' | 'monthly';
export type OnlineMatchType = 'quick' | 'private';
export type MatchCompletionType =
  | 'legal_8ball'
  | 'opponent_early_8ball'
  | 'opponent_8ball_foul'
  | 'forfeit'
  | 'disconnect_forfeit'
  | 'abandoned';

export type AchievementIconId =
  | 'trophy'
  | 'flame'
  | 'crown'
  | 'target'
  | 'zap'
  | 'shield'
  | 'award'
  | 'star'
  | 'compass'
  | 'crosshair';

export interface AchievementDefinition {
  id: string;
  name: string;
  description: string;
  icon: AchievementIconId;
  category: 'victories' | 'skill' | 'streaks' | 'competitive';
  rewardXp: number;
}

export interface UnlockedAchievement {
  id: string;
  name: string;
  description: string;
  icon: AchievementIconId;
  category: AchievementDefinition['category'];
  rewardXp: number;
  unlockedAtMs: number;
}

export const ACHIEVEMENTS_CATALOG: AchievementDefinition[] = [
  {
    id: 'first_victory',
    name: 'First Victory',
    description: 'Win your first verified online 8-Ball match.',
    icon: 'trophy',
    category: 'victories',
    rewardXp: 150,
  },
  {
    id: 'wins_10',
    name: 'Table Contender',
    description: 'Accumulate 10 verified online victories.',
    icon: 'award',
    category: 'victories',
    rewardXp: 300,
  },
  {
    id: 'wins_50',
    name: 'Club Champion',
    description: 'Accumulate 50 verified online victories.',
    icon: 'crown',
    category: 'victories',
    rewardXp: 750,
  },
  {
    id: 'wins_100',
    name: 'Grandmaster',
    description: 'Accumulate 100 verified online victories.',
    icon: 'star',
    category: 'victories',
    rewardXp: 1500,
  },
  {
    id: 'perfect_break',
    name: 'Perfect Break',
    description: 'Pocket at least one object ball on a legal opening break.',
    icon: 'zap',
    category: 'skill',
    rewardXp: 120,
  },
  {
    id: 'comeback_master',
    name: 'Comeback Master',
    description: 'Win a match after trailing your opponent by 3 or more pocketed group balls.',
    icon: 'shield',
    category: 'skill',
    rewardXp: 250,
  },
  {
    id: 'streak_5',
    name: 'Hot Hand',
    description: 'Win 5 consecutive verified online matches.',
    icon: 'flame',
    category: 'streaks',
    rewardXp: 400,
  },
  {
    id: 'eight_ball_champion',
    name: 'Eight-Ball Champion',
    description: 'Legally pocket the 8-ball to win a Strict Called (WPA) match.',
    icon: 'target',
    category: 'skill',
    rewardXp: 200,
  },
  {
    id: 'online_competitor',
    name: 'Online Competitor',
    description: 'Complete 5 verified online matches.',
    icon: 'compass',
    category: 'competitive',
    rewardXp: 150,
  },
  {
    id: 'sharpshooter_25',
    name: 'Sharpshooter',
    description: 'Sink 25 legal object balls across online matches.',
    icon: 'crosshair',
    category: 'skill',
    rewardXp: 200,
  },
];

export const ACHIEVEMENT_MAP = new Map<string, AchievementDefinition>(
  ACHIEVEMENTS_CATALOG.map((a) => [a.id, a]),
);

export const ELO_CONFIG = {
  initialElo: 1200,
  minElo: 100,
  provisionalMatches: 15,
  kProvisional: 40,
  kStandard: 24,
  kMaster: 16,
  masterThreshold: 2000,
} as const;

export interface LevelProgressInfo {
  level: number;
  totalXp: number;
  currentLevelXp: number;
  xpForNextLevel: number;
  progressRatio: number;
}

export function xpNeededForLevelStep(level: number): number {
  const safeLevel = Math.max(1, Math.floor(level));
  return 120 + (safeLevel - 1) * 45;
}

export function calculateLevelFromXp(totalXpRaw: number): LevelProgressInfo {
  const totalXp = Math.max(0, Math.floor(Number.isFinite(totalXpRaw) ? totalXpRaw : 0));
  let level = 1;
  let remaining = totalXp;

  while (level < 250) {
    const needed = xpNeededForLevelStep(level);
    if (remaining < needed) {
      return {
        level,
        totalXp,
        currentLevelXp: remaining,
        xpForNextLevel: needed,
        progressRatio: needed > 0 ? Math.min(1, Math.max(0, remaining / needed)) : 1,
      };
    }
    remaining -= needed;
    level++;
  }

  const maxStep = xpNeededForLevelStep(level);
  return {
    level,
    totalXp,
    currentLevelXp: remaining,
    xpForNextLevel: maxStep,
    progressRatio: 1,
  };
}

export function getEloKFactor(elo: number, totalMatches: number): number {
  if (totalMatches < ELO_CONFIG.provisionalMatches) return ELO_CONFIG.kProvisional;
  if (elo >= ELO_CONFIG.masterThreshold) return ELO_CONFIG.kMaster;
  return ELO_CONFIG.kStandard;
}

export function calculateEloUpdate(params: {
  player1Elo: number;
  player2Elo: number;
  player1Matches: number;
  player2Matches: number;
  winnerRole: PlayerId;
}): {
  player1After: number;
  player2After: number;
  player1Delta: number;
  player2Delta: number;
} {
  const expected1 = 1 / (1 + Math.pow(10, (params.player2Elo - params.player1Elo) / 400));
  const expected2 = 1 - expected1;
  const score1 = params.winnerRole === 'player1' ? 1 : 0;
  const score2 = 1 - score1;

  const k1 = getEloKFactor(params.player1Elo, params.player1Matches);
  const k2 = getEloKFactor(params.player2Elo, params.player2Matches);

  const rawAfter1 = Math.round(params.player1Elo + k1 * (score1 - expected1));
  const rawAfter2 = Math.round(params.player2Elo + k2 * (score2 - expected2));

  const player1After = Math.max(ELO_CONFIG.minElo, rawAfter1);
  const player2After = Math.max(ELO_CONFIG.minElo, rawAfter2);

  return {
    player1After,
    player2After,
    player1Delta: player1After - params.player1Elo,
    player2Delta: player2After - params.player2Elo,
  };
}

export interface PlayerMatchPerformance {
  won: boolean;
  shotsTaken: number;
  successfulShots: number;
  ballsPocketed: number;
  fouls: number;
  breaksAttempted: number;
  breaksSuccessful: number;
  legalEightBallWin: boolean;
  comebackWin: boolean;
  newWinStreak: number;
  ruleProfileId: RuleProfileId;
  validCompetitiveMatch: boolean;
}

export function computeBaseMatchXp(perf: PlayerMatchPerformance): number {
  if (!perf.validCompetitiveMatch) return 0;
  let xp = 40; // Completion XP
  if (perf.won) {
    xp += 80;
    xp += Math.min(5, Math.max(0, perf.newWinStreak)) * 10;
  }
  xp += Math.min(35, Math.max(0, perf.ballsPocketed) * 5);
  if (perf.breaksSuccessful > 0) xp += 25;
  if (perf.ruleProfileId === 'wpa') xp += 20;
  return xp;
}

export interface AchievementCheckInput {
  totalMatches: number;
  wins: number;
  bestStreak: number;
  ballsPocketed: number;
  breaksSuccessful: number;
  eightBallWins: number;
  comebackWinInMatch: boolean;
  alreadyUnlockedIds: Set<string>;
}

export function evaluateUnlockedAchievements(input: AchievementCheckInput): AchievementDefinition[] {
  const candidates: Array<[string, boolean]> = [
    ['first_victory', input.wins >= 1],
    ['wins_10', input.wins >= 10],
    ['wins_50', input.wins >= 50],
    ['wins_100', input.wins >= 100],
    ['perfect_break', input.breaksSuccessful >= 1],
    ['comeback_master', input.comebackWinInMatch],
    ['streak_5', input.bestStreak >= 5],
    ['eight_ball_champion', input.eightBallWins >= 1],
    ['online_competitor', input.totalMatches >= 5],
    ['sharpshooter_25', input.ballsPocketed >= 25],
  ];

  const newlyUnlocked: AchievementDefinition[] = [];
  for (const [id, met] of candidates) {
    if (!met || input.alreadyUnlockedIds.has(id)) continue;
    const def = ACHIEVEMENT_MAP.get(id);
    if (def) newlyUnlocked.push(def);
  }
  return newlyUnlocked;
}

export interface PlayerPerformanceStats {
  totalMatches: number;
  wins: number;
  losses: number;
  winRate: number;
  currentStreak: number;
  bestStreak: number;
  totalShots: number;
  successfulShots: number;
  ballsPocketed: number;
  fouls: number;
  breaksAttempted: number;
  breaksSuccessful: number;
  breakSuccessRate: number;
  eightBallWins: number;
  avgMatchDurationSec: number;
  byMatchType: {
    casual: { matches: number; wins: number };
    wpa: { matches: number; wins: number };
    quick: { matches: number; wins: number };
    private: { matches: number; wins: number };
  };
}

export interface PublicPlayerProfile {
  playerId: string;
  username: string | null;
  displayName: string;
  avatarId: string;
  isGuest: boolean;
  elo: number;
  peakElo: number;
  xp: number;
  level: number;
  levelProgress: LevelProgressInfo;
  rank: number | null;
  stats: PlayerPerformanceStats;
  achievements: UnlockedAchievement[];
  createdAtMs: number;
  lastMatchAtMs: number | null;
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  username: string | null;
  displayName: string;
  avatarId: string;
  isGuest: boolean;
  elo: number;
  periodDelta: number;
  level: number;
  wins: number;
  losses: number;
  totalMatches: number;
  winRate: number;
}

export interface LeaderboardResponse {
  scope: LeaderboardScope;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  items: LeaderboardEntry[];
  currentPlayer: LeaderboardEntry | null;
}

export interface PlayerProgressionDelta {
  playerId: string;
  role: PlayerId;
  eloBefore: number;
  eloAfter: number;
  eloDelta: number;
  xpBefore: number;
  xpAfter: number;
  xpGained: number;
  levelBefore: number;
  levelAfter: number;
  unlockedAchievements: UnlockedAchievement[];
}

export interface MatchProgressionRewardSummary {
  matchId: string;
  rankedApplied: boolean;
  durationSec: number;
  players: Record<PlayerId, PlayerProgressionDelta>;
}

export interface PlayerSearchResult {
  playerId: string;
  username: string | null;
  displayName: string;
  avatarId: string;
  elo: number;
  level: number;
  wins: number;
  totalMatches: number;
}

export interface MatchTelemetrySummaryForProgression {
  durationSec: number;
  completionType: MatchCompletionType;
  rankedValid: boolean;
  player1: {
    shotsTaken: number;
    successfulShots: number;
    ballsPocketed: number;
    fouls: number;
    breaksAttempted: number;
    breaksSuccessful: number;
    legalEightBallWin: boolean;
    comebackWin: boolean;
  };
  player2: {
    shotsTaken: number;
    successfulShots: number;
    ballsPocketed: number;
    fouls: number;
    breaksAttempted: number;
    breaksSuccessful: number;
    legalEightBallWin: boolean;
    comebackWin: boolean;
  };
}
