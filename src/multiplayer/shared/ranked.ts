export type RankTierId =
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'platinum'
  | 'diamond'
  | 'master'
  | 'grandmaster';

export interface RankTierDefinition {
  id: RankTierId;
  name: string;
  tierIndex: number;
  minElo: number;
  color: string;
  accentHex: string;
  bgClass: string;
  borderClass: string;
  textClass: string;
  badgeGlyph: string;
}

export const RANK_TIERS_CONFIG: RankTierDefinition[] = [
  {
    id: 'bronze',
    name: 'Bronze',
    tierIndex: 0,
    minElo: 0,
    color: '#cd7f32',
    accentHex: '#b45309',
    bgClass: 'bg-amber-950/70',
    borderClass: 'border-amber-700/50',
    textClass: 'text-amber-400',
    badgeGlyph: 'B',
  },
  {
    id: 'silver',
    name: 'Silver',
    tierIndex: 1,
    minElo: 1050,
    color: '#cbd5e1',
    accentHex: '#94a3b8',
    bgClass: 'bg-slate-800/80',
    borderClass: 'border-slate-400/40',
    textClass: 'text-slate-200',
    badgeGlyph: 'S',
  },
  {
    id: 'gold',
    name: 'Gold',
    tierIndex: 2,
    minElo: 1250,
    color: '#fbbf24',
    accentHex: '#f59e0b',
    bgClass: 'bg-amber-500/15',
    borderClass: 'border-amber-400/50',
    textClass: 'text-amber-300',
    badgeGlyph: 'G',
  },
  {
    id: 'platinum',
    name: 'Platinum',
    tierIndex: 3,
    minElo: 1450,
    color: '#2dd4bf',
    accentHex: '#14b8a6',
    bgClass: 'bg-teal-500/15',
    borderClass: 'border-teal-400/50',
    textClass: 'text-teal-300',
    badgeGlyph: 'P',
  },
  {
    id: 'diamond',
    name: 'Diamond',
    tierIndex: 4,
    minElo: 1650,
    color: '#38bdf8',
    accentHex: '#0284c7',
    bgClass: 'bg-sky-500/15',
    borderClass: 'border-sky-400/50',
    textClass: 'text-sky-300',
    badgeGlyph: 'D',
  },
  {
    id: 'master',
    name: 'Master',
    tierIndex: 5,
    minElo: 1900,
    color: '#c084fc',
    accentHex: '#9333ea',
    bgClass: 'bg-purple-500/15',
    borderClass: 'border-purple-400/50',
    textClass: 'text-purple-300',
    badgeGlyph: 'M',
  },
  {
    id: 'grandmaster',
    name: 'Grandmaster',
    tierIndex: 6,
    minElo: 2150,
    color: '#fb7185',
    accentHex: '#e11d48',
    bgClass: 'bg-rose-500/15',
    borderClass: 'border-rose-400/60',
    textClass: 'text-rose-300',
    badgeGlyph: 'GM',
  },
];

export const RANK_TIER_MAP = new Map<RankTierId, RankTierDefinition>(
  RANK_TIERS_CONFIG.map((t) => [t.id, t]),
);

export interface RankProgressInfo {
  current: RankTierDefinition;
  next: RankTierDefinition | null;
  elo: number;
  eloIntoTier: number;
  eloNeededForNext: number | null;
  progressRatio: number;
}

export type RankTransitionDirection = 'none' | 'promoted' | 'demoted';

export interface RankTransitionInfo {
  direction: RankTransitionDirection;
  fromTier: RankTierDefinition;
  toTier: RankTierDefinition;
}

export function getRankForElo(eloRaw: number): RankTierDefinition {
  const elo = Number.isFinite(eloRaw) ? Math.round(eloRaw) : 1200;
  let matched = RANK_TIERS_CONFIG[0];
  for (const tier of RANK_TIERS_CONFIG) {
    if (elo >= tier.minElo) {
      matched = tier;
    }
  }
  return matched;
}

export function getRankById(tierId: string | null | undefined): RankTierDefinition {
  if (tierId && RANK_TIER_MAP.has(tierId as RankTierId)) {
    return RANK_TIER_MAP.get(tierId as RankTierId)!;
  }
  return RANK_TIERS_CONFIG[0];
}

export function getRankProgress(eloRaw: number): RankProgressInfo {
  const elo = Math.max(0, Number.isFinite(eloRaw) ? Math.round(eloRaw) : 1200);
  const current = getRankForElo(elo);
  const next =
    current.tierIndex + 1 < RANK_TIERS_CONFIG.length
      ? RANK_TIERS_CONFIG[current.tierIndex + 1]
      : null;

  if (!next) {
    return {
      current,
      next: null,
      elo,
      eloIntoTier: Math.max(0, elo - current.minElo),
      eloNeededForNext: null,
      progressRatio: 1,
    };
  }

  const bandSpan = Math.max(1, next.minElo - current.minElo);
  const intoTier = Math.max(0, elo - current.minElo);
  return {
    current,
    next,
    elo,
    eloIntoTier: intoTier,
    eloNeededForNext: Math.max(0, next.minElo - elo),
    progressRatio: Math.min(1, Math.max(0, intoTier / bandSpan)),
  };
}

export function detectRankTransition(eloBefore: number, eloAfter: number): RankTransitionInfo {
  const fromTier = getRankForElo(eloBefore);
  const toTier = getRankForElo(eloAfter);
  if (toTier.tierIndex > fromTier.tierIndex) {
    return { direction: 'promoted', fromTier, toTier };
  }
  if (toTier.tierIndex < fromTier.tierIndex) {
    return { direction: 'demoted', fromTier, toTier };
  }
  return { direction: 'none', fromTier, toTier };
}

export const RANKED_MATCHMAKING_CONFIG = {
  initialEloSpread: 75,
  expandStepSec: 4,
  expandAmount: 50,
  maxEloSpread: 500,
  regionPreferenceWindowSec: 12,
  defaultRuleProfile: 'wpa' as const,
  minWaitSamplesForEstimate: 2,
} as const;

export function computeAllowedRankedEloSpread(waitSec: number): number {
  const safeWait = Math.max(0, Number.isFinite(waitSec) ? waitSec : 0);
  const steps = Math.floor(safeWait / RANKED_MATCHMAKING_CONFIG.expandStepSec);
  return Math.min(
    RANKED_MATCHMAKING_CONFIG.maxEloSpread,
    RANKED_MATCHMAKING_CONFIG.initialEloSpread + steps * RANKED_MATCHMAKING_CONFIG.expandAmount,
  );
}

export const SEASON_CONFIG = {
  defaultDurationDays: 30,
  softResetAnchor: 1200,
  softResetFactor: 0.5,
  minElo: 100,
  rewardsByTier: {
    bronze: { coins: 75, badgeTitle: 'Bronze Competitor' },
    silver: { coins: 150, badgeTitle: 'Silver Contender' },
    gold: { coins: 300, badgeTitle: 'Gold Challenger' },
    platinum: { coins: 500, badgeTitle: 'Platinum Tactician' },
    diamond: { coins: 800, badgeTitle: 'Diamond Ace' },
    master: { coins: 1200, badgeTitle: 'Master Shark' },
    grandmaster: { coins: 2000, badgeTitle: 'Grandmaster Legend' },
  } satisfies Record<RankTierId, { coins: number; badgeTitle: string }>,
} as const;

export function calculateSoftResetElo(
  previousSeasonElo: number,
  anchor: number = SEASON_CONFIG.softResetAnchor,
  factor: number = SEASON_CONFIG.softResetFactor,
): number {
  const raw = Math.round(anchor + (previousSeasonElo - anchor) * factor);
  return Math.max(SEASON_CONFIG.minElo, raw);
}

export type CompetitiveSeasonStatus = 'upcoming' | 'active' | 'completed';

export interface CompetitiveSeasonRecord {
  seasonId: string;
  seasonNumber: number;
  name: string;
  status: CompetitiveSeasonStatus;
  startsAtMs: number;
  endsAtMs: number;
  completedAtMs: number | null;
  softResetAnchor: number;
  softResetFactor: number;
  participantCount?: number;
}

export interface PlayerSeasonStanding {
  seasonId: string;
  seasonNumber: number;
  seasonName: string;
  playerId: string;
  seasonElo: number;
  peakSeasonElo: number;
  highestRankTier: RankTierId;
  currentRankTier: RankTierDefinition;
  rankProgress: RankProgressInfo;
  matchesPlayed: number;
  wins: number;
  losses: number;
  winRate: number;
  currentStreak: number;
  bestStreak: number;
  leaderboardRank: number | null;
  rewardClaimed: boolean;
  rewardCoins: number;
  rewardBadgeTitle: string | null;
}

export type PenaltyType =
  | 'warning'
  | 'ranked_restriction'
  | 'temp_suspension'
  | 'permanent_suspension';

export type PenaltyAppealStatus = 'pending' | 'approved' | 'rejected';

export interface PlayerPenaltyRecord {
  penaltyId: string;
  playerId: string;
  penaltyType: PenaltyType;
  reason: string;
  issuedBy: string;
  issuedAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  active: boolean;
}

export interface PenaltyAppealRecord {
  appealId: string;
  penaltyId: string;
  playerId: string;
  message: string;
  status: PenaltyAppealStatus;
  adminNotes: string | null;
  submittedAtMs: number;
  reviewedAtMs: number | null;
}

export interface PlayerModerationStatus {
  playerId: string;
  canPlayOnline: boolean;
  canPlayRanked: boolean;
  activePenalties: PlayerPenaltyRecord[];
  recentPenalties: PlayerPenaltyRecord[];
  appeals: PenaltyAppealRecord[];
}
