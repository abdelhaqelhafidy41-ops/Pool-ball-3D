import type { AiDifficulty } from '../../game/rules/types';
import { getUtcDayKey, type CosmeticItemDef, type EquippedCosmetics, type WalletSummary } from './economy';
import type { OnlineMatchType } from './progression';

export type MissionCadence = 'daily' | 'weekly';
export type BattlePassTrack = 'free' | 'premium';
export type BattlePassSeasonStatus = 'active' | 'completed';

export interface MissionDefinition {
  id: string;
  cadence: MissionCadence;
  metric:
    | 'matches_played'
    | 'matches_won'
    | 'online_wins'
    | 'ai_wins'
    | 'balls_pocketed'
    | 'balls_3_in_match'
    | 'clean_match'
    | 'legal_eight_ball_win'
    | 'win_streak_3'
    | 'upset_higher_elo';
  title: string;
  description: string;
  requiredProgress: number;
  rewardCoins: number;
  rewardSeasonXp: number;
}

export interface MissionProgressRecord {
  missionId: string;
  cadence: MissionCadence;
  periodKey: string;
  title: string;
  description: string;
  metric: MissionDefinition['metric'];
  progress: number;
  requiredProgress: number;
  completed: boolean;
  claimed: boolean;
  rewardCoins: number;
  rewardSeasonXp: number;
  expiresAtMs: number;
  completedAtMs: number | null;
  claimedAtMs: number | null;
}

export interface BattlePassTierRewardSpec {
  coins: number;
  itemId: string | null;
}

export interface BattlePassTierDefinition {
  level: number;
  xpRequiredForLevel: number;
  cumulativeXpRequired: number;
  free: BattlePassTierRewardSpec;
  premium: BattlePassTierRewardSpec;
}

export interface BattlePassTierStatus {
  level: number;
  xpRequiredForLevel: number;
  cumulativeXpRequired: number;
  unlocked: boolean;
  free: {
    coins: number;
    itemId: string | null;
    item: CosmeticItemDef | null;
    hasReward: boolean;
    claimed: boolean;
    canClaim: boolean;
  };
  premium: {
    coins: number;
    itemId: string | null;
    item: CosmeticItemDef | null;
    hasReward: boolean;
    claimed: boolean;
    canClaim: boolean;
    lockedByPremium: boolean;
  };
}

export interface BattlePassSeasonRecord {
  seasonId: string;
  seasonNumber: number;
  name: string;
  theme: string;
  status: BattlePassSeasonStatus;
  startsAtMs: number;
  endsAtMs: number;
  durationDays: number;
  premiumPriceCoins: number;
  maxLevel: number;
}

export interface PlayerBattlePassState {
  seasonId: string;
  playerId: string;
  seasonXp: number;
  seasonLevel: number;
  xpIntoCurrentLevel: number;
  xpForNextLevel: number | null;
  levelProgressRatio: number;
  premiumUnlocked: boolean;
  premiumUnlockedAtMs: number | null;
  matchesPlayed: number;
  wins: number;
  losses: number;
  ballsPocketed: number;
  tournamentsPlayed: number;
  dailyMissionsCompleted: number;
  weeklyChallengesCompleted: number;
  currentWinStreak: number;
  bestWinStreak: number;
  dailyMatchXpEarned: number;
  dailyAiXpEarned: number;
  dailyXpDayKey: string;
}

export interface BattlePassOverview {
  serverNowMs: number;
  season: BattlePassSeasonRecord;
  playerState: PlayerBattlePassState;
  tiers: BattlePassTierStatus[];
  dailyMissions: MissionProgressRecord[];
  weeklyChallenges: MissionProgressRecord[];
  dailyResetAtMs: number;
  weeklyResetAtMs: number;
  claimableCounts: {
    daily: number;
    weekly: number;
    battlePassFree: number;
    battlePassPremium: number;
    total: number;
  };
  pastSeasons: Array<{
    season: BattlePassSeasonRecord;
    seasonXp: number;
    seasonLevel: number;
    premiumUnlocked: boolean;
    matchesPlayed: number;
    wins: number;
    dailyMissionsCompleted: number;
    weeklyChallengesCompleted: number;
  }>;
  config: {
    dailyMatchXpCap: number;
    dailyAiMatchXpCap: number;
    premiumPriceCoins: number;
    maxLevel: number;
    aiMinShots: number;
    aiMinDurationSec: number;
    aiCooldownMs: number;
  };
}

export interface ClaimRewardResponse {
  ok: true;
  coinsAwarded: number;
  seasonXpAwarded: number;
  grantedItemIds: string[];
  alreadyClaimed: boolean;
  wallet: WalletSummary;
  inventoryIds: string[];
  equipped: EquippedCosmetics;
  overview: BattlePassOverview;
}

export interface UnlockPremiumResponse {
  ok: true;
  alreadyUnlocked: boolean;
  pricePaid: number;
  wallet: WalletSummary;
  overview: BattlePassOverview;
}

export interface AiMatchProgressRequest {
  clientMatchId: string;
  difficulty: AiDifficulty;
  won: boolean;
  totalShots: number;
  ballsPocketed: number;
  foulsCommitted: number;
  legalEightBallWin: boolean;
  durationSec: number;
}

export interface AiMatchProgressResponse {
  ok: true;
  alreadyRecorded: boolean;
  seasonXpAwarded: number;
  capReached: boolean;
  rejectedReason: string | null;
  completedMissionIds: string[];
  leveledUpTo: number | null;
  overview: BattlePassOverview;
}

export const BATTLE_PASS_CONFIG = {
  maxLevel: 30,
  defaultDurationDays: 30,
  premiumPriceCoins: 1200,
  dailyMissionsCount: 4,
  weeklyChallengesCount: 6,
  dailyMatchXpCap: 1500,
  dailyAiMatchXpCap: 500,
  antiAbuse: {
    aiMinShots: 2,
    aiMinDurationSec: 5,
    aiCooldownMs: 25_000,
    onlineMinShots: 1,
    onlineMinDurationSec: 3,
  },
  xpRewards: {
    onlineMatchWin: {
      quick: 115,
      private: 95,
      ranked: 140,
      tournament: 155,
    } satisfies Record<OnlineMatchType, number>,
    onlineMatchLoss: {
      quick: 45,
      private: 35,
      ranked: 60,
      tournament: 65,
    } satisfies Record<OnlineMatchType, number>,
    aiMatchWin: {
      beginner: 35,
      intermediate: 50,
      pro: 70,
      legend: 95,
    } satisfies Record<AiDifficulty, number>,
    aiMatchLoss: 20,
    tournamentFinishBonus: {
      champion: 350,
      runner_up: 200,
      third_place: 125,
      participant: 50,
    },
  },
} as const;

export const DAILY_MISSION_POOL: MissionDefinition[] = [
  {
    id: 'daily_play_3',
    cadence: 'daily',
    metric: 'matches_played',
    title: 'Table Regular',
    description: 'Complete 3 matches in any competitive or AI mode.',
    requiredProgress: 3,
    rewardCoins: 80,
    rewardSeasonXp: 150,
  },
  {
    id: 'daily_win_1',
    cadence: 'daily',
    metric: 'matches_won',
    title: 'First Blood',
    description: 'Win 1 official 8-Ball match.',
    requiredProgress: 1,
    rewardCoins: 60,
    rewardSeasonXp: 120,
  },
  {
    id: 'daily_win_3',
    cadence: 'daily',
    metric: 'matches_won',
    title: 'Hat Trick',
    description: 'Win 3 matches before the daily UTC reset.',
    requiredProgress: 3,
    rewardCoins: 150,
    rewardSeasonXp: 260,
  },
  {
    id: 'daily_pocket_10',
    cadence: 'daily',
    metric: 'balls_pocketed',
    title: 'Precision Potting',
    description: 'Pocket 10 object balls across completed matches.',
    requiredProgress: 10,
    rewardCoins: 90,
    rewardSeasonXp: 160,
  },
  {
    id: 'daily_pocket_3_one_match',
    cadence: 'daily',
    metric: 'balls_3_in_match',
    title: 'Table Runner',
    description: 'Pocket at least 3 balls in a single completed match.',
    requiredProgress: 1,
    rewardCoins: 85,
    rewardSeasonXp: 150,
  },
  {
    id: 'daily_win_ai',
    cadence: 'daily',
    metric: 'ai_wins',
    title: 'Sparring Victor',
    description: 'Defeat an AI opponent in an 8-Ball rack.',
    requiredProgress: 1,
    rewardCoins: 75,
    rewardSeasonXp: 140,
  },
  {
    id: 'daily_win_online',
    cadence: 'daily',
    metric: 'online_wins',
    title: 'Online Contender',
    description: 'Win an online multiplayer or tournament match.',
    requiredProgress: 1,
    rewardCoins: 120,
    rewardSeasonXp: 210,
  },
  {
    id: 'daily_clean_match',
    cadence: 'daily',
    metric: 'clean_match',
    title: 'Clean Execution',
    description: 'Complete a match without committing a single foul.',
    requiredProgress: 1,
    rewardCoins: 100,
    rewardSeasonXp: 180,
  },
  {
    id: 'daily_legal_8ball',
    cadence: 'daily',
    metric: 'legal_eight_ball_win',
    title: "Closer's Touch",
    description: 'Win a match by legally pocketing the black 8-ball.',
    requiredProgress: 1,
    rewardCoins: 110,
    rewardSeasonXp: 190,
  },
];

export const WEEKLY_CHALLENGE_POOL: MissionDefinition[] = [
  {
    id: 'weekly_win_10',
    cadence: 'weekly',
    metric: 'matches_won',
    title: 'Weekly Domination',
    description: 'Win 10 matches during the current UTC week.',
    requiredProgress: 10,
    rewardCoins: 420,
    rewardSeasonXp: 650,
  },
  {
    id: 'weekly_win_5_online',
    cadence: 'weekly',
    metric: 'online_wins',
    title: 'Online Sharpshooter',
    description: 'Win 5 online multiplayer or tournament matches.',
    requiredProgress: 5,
    rewardCoins: 450,
    rewardSeasonXp: 700,
  },
  {
    id: 'weekly_play_20',
    cadence: 'weekly',
    metric: 'matches_played',
    title: 'Iron Rack',
    description: 'Complete 20 matches across online or AI tables.',
    requiredProgress: 20,
    rewardCoins: 350,
    rewardSeasonXp: 550,
  },
  {
    id: 'weekly_streak_3',
    cadence: 'weekly',
    metric: 'win_streak_3',
    title: 'Unstoppable Run',
    description: 'Win 3 consecutive matches within the current week.',
    requiredProgress: 3,
    rewardCoins: 500,
    rewardSeasonXp: 750,
  },
  {
    id: 'weekly_pocket_50',
    cadence: 'weekly',
    metric: 'balls_pocketed',
    title: 'Century Clearer',
    description: 'Pocket 50 object balls across completed matches.',
    requiredProgress: 50,
    rewardCoins: 380,
    rewardSeasonXp: 600,
  },
  {
    id: 'weekly_upset_higher_elo',
    cadence: 'weekly',
    metric: 'upset_higher_elo',
    title: 'Giant Slayer',
    description: 'Defeat a higher-ranked ELO opponent in an online match.',
    requiredProgress: 1,
    rewardCoins: 400,
    rewardSeasonXp: 620,
  },
];

export const MISSION_DEF_MAP = new Map<string, MissionDefinition>(
  [...DAILY_MISSION_POOL, ...WEEKLY_CHALLENGE_POOL].map((m) => [m.id, m]),
);

const LEVEL_XP_STEPS: number[] = Array.from({ length: BATTLE_PASS_CONFIG.maxLevel }, (_, idx) => {
  const lvl = idx + 1;
  if (lvl <= 5) return 200;
  if (lvl <= 15) return 300;
  if (lvl <= 25) return 400;
  return 500;
});

const PREMIUM_COSMETIC_MILESTONES: Record<number, { itemId: string; coins: number }> = {
  1: { itemId: 'avatar_solar_sovereign', coins: 50 },
  5: { itemId: 'decor_season1_obsidian_gold', coins: 75 },
  10: { itemId: 'cue_season1_eclipse', coins: 100 },
  15: { itemId: 'ball_season1_eclipse', coins: 125 },
  20: { itemId: 'table_season1_champions', coins: 150 },
  24: { itemId: 'badge_season1_sovereign', coins: 175 },
  28: { itemId: 'victory_season1_solar_crown', coins: 200 },
  30: { itemId: 'cue_season1_solar_apex', coins: 600 },
};

const FREE_MILESTONE_REWARDS: Record<number, { itemId: string | null; coins: number }> = {
  1: { itemId: null, coins: 75 },
  3: { itemId: null, coins: 100 },
  6: { itemId: null, coins: 120 },
  8: { itemId: 'badge_season1_challenger', coins: 0 },
  10: { itemId: null, coins: 150 },
  12: { itemId: null, coins: 140 },
  14: { itemId: null, coins: 160 },
  16: { itemId: 'avatar_eclipse_grandmaster', coins: 0 },
  18: { itemId: null, coins: 180 },
  21: { itemId: null, coins: 200 },
  23: { itemId: null, coins: 225 },
  26: { itemId: null, coins: 250 },
  28: { itemId: null, coins: 275 },
  30: { itemId: 'nameplate_season1_eclipse', coins: 350 },
};

export const BATTLE_PASS_TIERS: BattlePassTierDefinition[] = (() => {
  const tiers: BattlePassTierDefinition[] = [];
  let cumulative = 0;
  for (let i = 0; i < BATTLE_PASS_CONFIG.maxLevel; i++) {
    const level = i + 1;
    const step = LEVEL_XP_STEPS[i];
    cumulative += step;

    const freeSpec = FREE_MILESTONE_REWARDS[level] ?? { itemId: null, coins: 0 };
    const premMilestone = PREMIUM_COSMETIC_MILESTONES[level];
    const premCoins = premMilestone
      ? premMilestone.coins
      : 70 + Math.floor(level / 3) * 20;

    tiers.push({
      level,
      xpRequiredForLevel: step,
      cumulativeXpRequired: cumulative,
      free: {
        coins: freeSpec.coins,
        itemId: freeSpec.itemId,
      },
      premium: {
        coins: premCoins,
        itemId: premMilestone?.itemId ?? null,
      },
    });
  }
  return tiers;
})();

export function calculateBattlePassLevelFromXp(seasonXp: number): {
  level: number;
  xpIntoCurrentLevel: number;
  xpForNextLevel: number | null;
  progressRatio: number;
  maxLevel: number;
} {
  const safeXp = Math.max(0, Math.floor(seasonXp));
  let unlockedLevel = 0;
  let prevThreshold = 0;

  for (const tier of BATTLE_PASS_TIERS) {
    if (safeXp >= tier.cumulativeXpRequired) {
      unlockedLevel = tier.level;
      prevThreshold = tier.cumulativeXpRequired;
    } else {
      const nextStep = tier.xpRequiredForLevel;
      const into = safeXp - prevThreshold;
      return {
        level: unlockedLevel,
        xpIntoCurrentLevel: into,
        xpForNextLevel: nextStep,
        progressRatio: Math.max(0, Math.min(1, into / nextStep)),
        maxLevel: BATTLE_PASS_CONFIG.maxLevel,
      };
    }
  }

  return {
    level: BATTLE_PASS_CONFIG.maxLevel,
    xpIntoCurrentLevel: 0,
    xpForNextLevel: null,
    progressRatio: 1,
    maxLevel: BATTLE_PASS_CONFIG.maxLevel,
  };
}

export function getUtcDayWindow(nowMs: number): {
  dayKey: string;
  startMs: number;
  expiresAtMs: number;
} {
  const d = new Date(nowMs);
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  const expiresAtMs = startMs + 86_400_000;
  return {
    dayKey: getUtcDayKey(nowMs),
    startMs,
    expiresAtMs,
  };
}

/**
 * Computes ISO-8601 UTC week key (Monday 00:00:00 UTC .. next Monday 00:00:00 UTC).
 */
export function getUtcWeekWindow(nowMs: number): {
  weekKey: string;
  startMs: number;
  expiresAtMs: number;
} {
  const d = new Date(nowMs);
  const utcDay = d.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (utcDay + 6) % 7;
  const midnightToday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  const startMs = midnightToday - daysSinceMonday * 86_400_000;
  const expiresAtMs = startMs + 7 * 86_400_000;

  // ISO week number calculation anchored on Thursday of the same week
  const thursdayMs = startMs + 3 * 86_400_000;
  const thu = new Date(thursdayMs);
  const isoYear = thu.getUTCFullYear();
  const jan4Ms = Date.UTC(isoYear, 0, 4, 0, 0, 0, 0);
  const jan4 = new Date(jan4Ms);
  const jan4DaysSinceMon = (jan4.getUTCDay() + 6) % 7;
  const week1MonMs = jan4Ms - jan4DaysSinceMon * 86_400_000;
  const weekNum = Math.floor((startMs - week1MonMs) / (7 * 86_400_000)) + 1;

  return {
    weekKey: `${isoYear}-W${String(weekNum).padStart(2, '0')}`,
    startMs,
    expiresAtMs,
  };
}

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic daily rotation across mission buckets so each UTC day delivers
 * a varied, balanced mix of volume, win, skill, and online/AI objectives.
 */
export function getActiveDailyMissionsForDay(
  dayKey: string,
  count: number = BATTLE_PASS_CONFIG.dailyMissionsCount,
): MissionDefinition[] {
  const bucketWins = DAILY_MISSION_POOL.filter((m) =>
    ['daily_win_1', 'daily_win_3'].includes(m.id),
  );
  const bucketVolume = DAILY_MISSION_POOL.filter((m) =>
    ['daily_play_3', 'daily_pocket_10', 'daily_pocket_3_one_match'].includes(m.id),
  );
  const bucketSkill = DAILY_MISSION_POOL.filter((m) =>
    ['daily_clean_match', 'daily_legal_8ball'].includes(m.id),
  );
  const bucketMode = DAILY_MISSION_POOL.filter((m) =>
    ['daily_win_ai', 'daily_win_online'].includes(m.id),
  );

  const seed = hashSeed(dayKey);
  const picked: MissionDefinition[] = [
    bucketWins[seed % bucketWins.length],
    bucketVolume[(seed >>> 3) % bucketVolume.length],
    bucketSkill[(seed >>> 6) % bucketSkill.length],
    bucketMode[(seed >>> 9) % bucketMode.length],
  ];

  const pickedIds = new Set(picked.map((m) => m.id));
  for (const candidate of DAILY_MISSION_POOL) {
    if (picked.length >= count) break;
    if (!pickedIds.has(candidate.id)) {
      picked.push(candidate);
      pickedIds.add(candidate.id);
    }
  }
  return picked.slice(0, Math.max(1, Math.min(DAILY_MISSION_POOL.length, count)));
}

export function getActiveWeeklyChallengesForWeek(
  weekKey: string,
  count: number = BATTLE_PASS_CONFIG.weeklyChallengesCount,
): MissionDefinition[] {
  const seed = hashSeed(weekKey);
  const safeCount = Math.max(1, Math.min(WEEKLY_CHALLENGE_POOL.length, count));
  if (safeCount >= WEEKLY_CHALLENGE_POOL.length) {
    return [...WEEKLY_CHALLENGE_POOL];
  }
  const copy = [...WEEKLY_CHALLENGE_POOL];
  const selected: MissionDefinition[] = [];
  for (let i = 0; i < safeCount; i++) {
    const idx = (seed + i * 7) % copy.length;
    selected.push(copy.splice(idx, 1)[0]);
  }
  return selected;
}

export function buildDefaultSeasonTheme(seasonNumber: number): { name: string; theme: string } {
  const themes: Array<{ name: string; theme: string }> = [
    { name: 'Season I: Golden Eclipse', theme: 'Obsidian & 24K Championship Gold' },
    { name: 'Season II: Neon Velocity', theme: 'Cyber Arena & Electric Cyan' },
    { name: 'Season III: Imperial Crimson', theme: 'Monte Carlo Velvet & Brass' },
    { name: 'Season IV: Platinum Summit', theme: 'World Masters Sapphire & Chrome' },
  ];
  const entry = themes[(Math.max(1, seasonNumber) - 1) % themes.length];
  if (seasonNumber <= themes.length) return entry;
  return {
    name: `Season ${seasonNumber}: Masters Tour`,
    theme: entry.theme,
  };
}

export function computeOnlineMatchSeasonXp(params: {
  matchType: OnlineMatchType;
  won: boolean;
  totalShots: number;
  durationSec: number;
  rankedValid: boolean;
}): number {
  if (!params.rankedValid) return 0;
  if (
    params.totalShots < BATTLE_PASS_CONFIG.antiAbuse.onlineMinShots ||
    params.durationSec < BATTLE_PASS_CONFIG.antiAbuse.onlineMinDurationSec
  ) {
    return 0;
  }
  return params.won
    ? BATTLE_PASS_CONFIG.xpRewards.onlineMatchWin[params.matchType]
    : BATTLE_PASS_CONFIG.xpRewards.onlineMatchLoss[params.matchType];
}

export function computeAiMatchSeasonXp(params: {
  difficulty: AiDifficulty;
  won: boolean;
}): number {
  return params.won
    ? BATTLE_PASS_CONFIG.xpRewards.aiMatchWin[params.difficulty]
    : BATTLE_PASS_CONFIG.xpRewards.aiMatchLoss;
}
