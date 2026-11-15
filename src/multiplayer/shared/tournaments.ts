import type { RuleProfileId } from '../../game/rules/types';
import type { OnlineAvatarId } from './protocol';

export type TournamentType = 'quick' | 'daily' | 'weekly' | 'private' | 'scheduled';

export type TournamentStatus =
  | 'upcoming'
  | 'registration_open'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type TournamentCapacity = 8 | 16 | 32;

export type TournamentParticipantStatus =
  | 'registered'
  | 'active'
  | 'eliminated'
  | 'withdrawn'
  | 'champion'
  | 'runner_up'
  | 'third_place';

export type TournamentBracketMatchStatus =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'completed'
  | 'bye'
  | 'forfeited';

export type TournamentMatchResolutionType =
  | 'played'
  | 'bye'
  | 'forfeit'
  | 'no_show'
  | 'admin_resolved';

export interface TournamentPrizeConfig {
  championCoins: number;
  runnerUpCoins: number;
  thirdPlaceCoins: number;
  participantCoins: number;
  championBadgeId: string | null;
  finalistBadgeId: string | null;
  trophyId: string;
}

export interface TournamentTrophyDef {
  id: string;
  name: string;
  description: string;
  tier: 'gold' | 'silver' | 'bronze' | 'special';
  glyph: string;
}

export const TOURNAMENT_TROPHY_CATALOG: TournamentTrophyDef[] = [
  {
    id: 'trophy_first_champion',
    name: 'Championship Crown',
    description: 'Win 1st place in an official Ultimate Pool 3D tournament.',
    tier: 'gold',
    glyph: '🏆',
  },
  {
    id: 'trophy_weekly_championship',
    name: 'World Series Champion',
    description: 'Claim victory in a Weekly Championship bracket.',
    tier: 'gold',
    glyph: '👑',
  },
  {
    id: 'trophy_grand_finalist',
    name: 'Grand Finalist',
    description: 'Reach the Final match of an official tournament.',
    tier: 'silver',
    glyph: '🥈',
  },
  {
    id: 'trophy_podium_finish',
    name: 'Podium Contender',
    description: 'Finish in the top 3 of an official tournament.',
    tier: 'bronze',
    glyph: '🥉',
  },
  {
    id: 'trophy_dynasty_3',
    name: 'Championship Dynasty',
    description: 'Win 3 official tournament championships.',
    tier: 'special',
    glyph: '✦',
  },
];

export const TOURNAMENT_TROPHY_MAP = new Map<string, TournamentTrophyDef>(
  TOURNAMENT_TROPHY_CATALOG.map((t) => [t.id, t]),
);

export interface TournamentTrophyUnlock extends TournamentTrophyDef {
  tournamentId: string;
  tournamentTitle: string;
  unlockedAtMs: number;
}

export interface TournamentRecord {
  tournamentId: string;
  title: string;
  description: string;
  type: TournamentType;
  status: TournamentStatus;
  maxPlayers: TournamentCapacity;
  minPlayers: number;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  entryFeeCoins: number;
  minElo: number;
  isPrivate: boolean;
  inviteCode: string | null;
  createdByPlayerId: string | null;
  createdByName: string;
  seasonKey: string;
  prizes: TournamentPrizeConfig;
  registrationOpensAtMs: number;
  registrationClosesAtMs: number;
  startsAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  matchDeadlineMs: number;
  participantCount: number;
  bracketSize: number;
  totalRounds: number;
  currentRound: number;
  championPlayerId: string | null;
  championDisplayName: string | null;
  runnerUpPlayerId: string | null;
  runnerUpDisplayName: string | null;
  thirdPlacePlayerId: string | null;
  thirdPlaceDisplayName: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  viewerRegistered?: boolean;
}

export interface TournamentParticipant {
  tournamentId: string;
  playerId: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo: number;
  seed: number | null;
  status: TournamentParticipantStatus;
  placement: number | null;
  joinedAtMs: number;
  eliminatedRound: number | null;
}

export interface TournamentMatch {
  bracketMatchId: string;
  tournamentId: string;
  roundNumber: number;
  roundLabel: string;
  slotIndex: number;
  isThirdPlaceMatch: boolean;
  player1Id: string | null;
  player1Name: string | null;
  player1Avatar: OnlineAvatarId | null;
  player1Seed: number | null;
  player1Joined: boolean;
  player2Id: string | null;
  player2Name: string | null;
  player2Avatar: OnlineAvatarId | null;
  player2Seed: number | null;
  player2Joined: boolean;
  winnerId: string | null;
  winnerName: string | null;
  loserId: string | null;
  status: TournamentBracketMatchStatus;
  roomId: string | null;
  roomCode: string | null;
  matchId: string | null;
  resolutionType: TournamentMatchResolutionType | null;
  reason: string | null;
  nextMatchId: string | null;
  nextMatchSlot: 1 | 2 | null;
  readyDeadlineMs: number | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

export interface TournamentPayoutRecord {
  payoutId: string;
  tournamentId: string;
  playerId: string;
  displayName: string;
  placement: 'champion' | 'runner_up' | 'third_place' | 'participant';
  coinsAwarded: number;
  badgeAwarded: string | null;
  trophyAwarded: string | null;
  awardedAtMs: number;
}

export interface TournamentEventRecord {
  eventId: string;
  tournamentId: string;
  eventType: string;
  actorPlayerId: string | null;
  summary: string;
  metadata: Record<string, string | number | boolean | null> | null;
  createdAtMs: number;
}

export interface TournamentDetailPayload {
  tournament: TournamentRecord;
  participants: TournamentParticipant[];
  matches: TournamentMatch[];
  payouts: TournamentPayoutRecord[];
  events: TournamentEventRecord[];
  viewerStatus: {
    isRegistered: boolean;
    participant: TournamentParticipant | null;
    activeMatch: TournamentMatch | null;
  };
}

export interface TournamentLeaderboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo: number;
  championships: number;
  finalsAppearances: number;
  podiums: number;
  tournamentsPlayed: number;
  matchesWon: number;
  matchesLost: number;
  winRate: number;
  totalCoinsWon: number;
}

export interface PlayerTournamentHistoryItem {
  tournamentId: string;
  title: string;
  type: TournamentType;
  status: TournamentStatus;
  maxPlayers: TournamentCapacity;
  placement: number | null;
  participantStatus: TournamentParticipantStatus;
  coinsWon: number;
  completedAtMs: number | null;
  joinedAtMs: number;
}

export interface PlayerTournamentStats {
  playerId: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo: number;
  championships: number;
  finalsAppearances: number;
  thirdPlaceFinishes: number;
  tournamentsEntered: number;
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  winRate: number;
  totalCoinsWon: number;
  trophies: TournamentTrophyUnlock[];
  recentTournaments: PlayerTournamentHistoryItem[];
}

export interface CreateTournamentInput {
  title: string;
  description?: string;
  type: TournamentType;
  maxPlayers: TournamentCapacity;
  minPlayers?: number;
  ruleProfileId?: RuleProfileId;
  calledShotsEnabled?: boolean;
  entryFeeCoins?: number;
  minElo?: number;
  isPrivate?: boolean;
  inviteCode?: string;
  seasonKey?: string;
  prizes?: Partial<TournamentPrizeConfig>;
  registrationOpensAtMs?: number;
  registrationClosesAtMs?: number;
  startsAtMs?: number;
  matchDeadlineMs?: number;
  status?: 'upcoming' | 'registration_open';
}

export const TOURNAMENT_LIMITS = {
  maxTitleLen: 64,
  maxDescriptionLen: 240,
  minPlayersAllowed: 2,
  supportedCapacities: [8, 16, 32] as const satisfies readonly TournamentCapacity[],
  defaultMatchDeadlineMs: 300_000,
  minMatchDeadlineMs: 1_500,
  maxMatchDeadlineMs: 1_800_000,
  maxEntryFeeCoins: 10_000,
  maxPrizeCoins: 50_000,
} as const;

export function getCurrentSeasonKey(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `S${quarter}-${year}`;
}

export function sanitizeTournamentCapacity(raw: unknown): TournamentCapacity {
  const n = Number(raw);
  if (n === 16) return 16;
  if (n === 32) return 32;
  return 8;
}

export function getRoundLabelForBracketSize(
  bracketSize: number,
  roundNumber: number,
  isThirdPlaceMatch = false,
): string {
  if (isThirdPlaceMatch) return 'Third Place';
  const remainingTeams = Math.max(2, Math.round(bracketSize / Math.pow(2, roundNumber - 1)));
  if (remainingTeams <= 2) return 'Final';
  if (remainingTeams <= 4) return 'Semi-finals';
  if (remainingTeams <= 8) return 'Quarter-finals';
  if (remainingTeams <= 16) return 'Round of 16';
  return 'Round of 32';
}

export function getDefaultPrizesForType(type: TournamentType): TournamentPrizeConfig {
  switch (type) {
    case 'weekly':
      return {
        championCoins: 2400,
        runnerUpCoins: 1000,
        thirdPlaceCoins: 450,
        participantCoins: 100,
        championBadgeId: 'badge_tournament_champion',
        finalistBadgeId: 'badge_tournament_finalist',
        trophyId: 'trophy_weekly_championship',
      };
    case 'daily':
      return {
        championCoins: 1100,
        runnerUpCoins: 450,
        thirdPlaceCoins: 200,
        participantCoins: 60,
        championBadgeId: 'badge_tournament_champion',
        finalistBadgeId: 'badge_tournament_finalist',
        trophyId: 'trophy_first_champion',
      };
    case 'scheduled':
      return {
        championCoins: 1600,
        runnerUpCoins: 700,
        thirdPlaceCoins: 300,
        participantCoins: 80,
        championBadgeId: 'badge_tournament_champion',
        finalistBadgeId: 'badge_tournament_finalist',
        trophyId: 'trophy_first_champion',
      };
    case 'private':
      return {
        championCoins: 300,
        runnerUpCoins: 120,
        thirdPlaceCoins: 60,
        participantCoins: 25,
        championBadgeId: null,
        finalistBadgeId: null,
        trophyId: 'trophy_first_champion',
      };
    case 'quick':
    default:
      return {
        championCoins: 600,
        runnerUpCoins: 250,
        thirdPlaceCoins: 100,
        participantCoins: 40,
        championBadgeId: 'badge_tournament_champion',
        finalistBadgeId: 'badge_tournament_finalist',
        trophyId: 'trophy_first_champion',
      };
  }
}

export function sanitizePrizeConfig(
  type: TournamentType,
  raw?: Partial<TournamentPrizeConfig> | null,
): TournamentPrizeConfig {
  const defaults = getDefaultPrizesForType(type);
  const clampCoins = (val: unknown, fallback: number): number => {
    const n = typeof val === 'number' && Number.isFinite(val) ? Math.floor(val) : fallback;
    return Math.max(0, Math.min(TOURNAMENT_LIMITS.maxPrizeCoins, n));
  };
  return {
    championCoins: clampCoins(raw?.championCoins, defaults.championCoins),
    runnerUpCoins: clampCoins(raw?.runnerUpCoins, defaults.runnerUpCoins),
    thirdPlaceCoins: clampCoins(raw?.thirdPlaceCoins, defaults.thirdPlaceCoins),
    participantCoins: clampCoins(raw?.participantCoins, defaults.participantCoins),
    championBadgeId:
      raw?.championBadgeId === null
        ? null
        : typeof raw?.championBadgeId === 'string' && raw.championBadgeId.trim()
          ? raw.championBadgeId.trim()
          : defaults.championBadgeId,
    finalistBadgeId:
      raw?.finalistBadgeId === null
        ? null
        : typeof raw?.finalistBadgeId === 'string' && raw.finalistBadgeId.trim()
          ? raw.finalistBadgeId.trim()
          : defaults.finalistBadgeId,
    trophyId:
      typeof raw?.trophyId === 'string' && TOURNAMENT_TROPHY_MAP.has(raw.trophyId)
        ? raw.trophyId
        : defaults.trophyId,
  };
}

/**
 * Generates standard tournament bracket pairing order for power-of-2 sizes (2, 4, 8, 16, 32).
 * Example for 8: [1, 8, 4, 5, 2, 7, 3, 6] => Match 0: 1v8, Match 1: 4v5, Match 2: 2v7, Match 3: 3v6.
 */
export function buildBracketSeedOrder(bracketSize: number): number[] {
  let seeds = [1, 2];
  let currentSize = 2;
  while (currentSize < bracketSize) {
    currentSize *= 2;
    const next: number[] = [];
    for (const seed of seeds) {
      next.push(seed, currentSize + 1 - seed);
    }
    seeds = next;
  }
  return seeds;
}

export function computeSmallestPowerOfTwo(count: number): number {
  const clamped = Math.max(2, Math.min(32, Math.floor(count)));
  let size = 2;
  while (size < clamped) {
    size *= 2;
  }
  return size;
}

export interface GeneratedBracketBlueprint {
  bracketSize: number;
  totalRounds: number;
  seededParticipants: TournamentParticipant[];
  matches: TournamentMatch[];
}

/**
 * Builds an explicit single-elimination bracket tree for N participants,
 * filling unused power-of-2 slots with explicit BYEs and auto-advancing Round 1 BYEs.
 */
export function buildSingleEliminationBracket(
  tournamentId: string,
  participantsInput: TournamentParticipant[],
): GeneratedBracketBlueprint {
  const sorted = [...participantsInput].sort((a, b) => {
    if (b.elo !== a.elo) return b.elo - a.elo;
    if (a.joinedAtMs !== b.joinedAtMs) return a.joinedAtMs - b.joinedAtMs;
    return a.playerId.localeCompare(b.playerId);
  });

  const seededParticipants: TournamentParticipant[] = sorted.map((p, index) => ({
    ...p,
    seed: index + 1,
    status: 'active',
    placement: null,
    eliminatedRound: null,
  }));

  const bracketSize = computeSmallestPowerOfTwo(seededParticipants.length);
  const totalRounds = Math.round(Math.log2(bracketSize));
  const seedOrder = buildBracketSeedOrder(bracketSize);
  const participantBySeed = new Map<number, TournamentParticipant>();
  for (const p of seededParticipants) {
    if (p.seed !== null) {
      participantBySeed.set(p.seed, p);
    }
  }

  const matchesByRound = new Map<number, TournamentMatch[]>();
  const makeMatchId = (round: number, slot: number, isThird = false) =>
    isThird ? `${tournamentId}_third_place` : `${tournamentId}_r${round}_s${slot}`;

  // Build skeleton rounds bottom-up (Final is round totalRounds)
  for (let round = 1; round <= totalRounds; round++) {
    const matchCount = Math.max(1, bracketSize / Math.pow(2, round));
    const roundLabel = getRoundLabelForBracketSize(bracketSize, round, false);
    const list: TournamentMatch[] = [];

    for (let slot = 0; slot < matchCount; slot++) {
      const nextMatchId =
        round < totalRounds ? makeMatchId(round + 1, Math.floor(slot / 2)) : null;
      const nextMatchSlot = round < totalRounds ? ((slot % 2 === 0 ? 1 : 2) as 1 | 2) : null;

      list.push({
        bracketMatchId: makeMatchId(round, slot),
        tournamentId,
        roundNumber: round,
        roundLabel,
        slotIndex: slot,
        isThirdPlaceMatch: false,
        player1Id: null,
        player1Name: null,
        player1Avatar: null,
        player1Seed: null,
        player1Joined: false,
        player2Id: null,
        player2Name: null,
        player2Avatar: null,
        player2Seed: null,
        player2Joined: false,
        winnerId: null,
        winnerName: null,
        loserId: null,
        status: 'pending',
        roomId: null,
        roomCode: null,
        matchId: null,
        resolutionType: null,
        reason: null,
        nextMatchId,
        nextMatchSlot,
        readyDeadlineMs: null,
        startedAtMs: null,
        completedAtMs: null,
      });
    }
    matchesByRound.set(round, list);
  }

  // Populate Round 1 slots from seedOrder
  const round1 = matchesByRound.get(1) ?? [];
  for (let slot = 0; slot < round1.length; slot++) {
    const seedA = seedOrder[slot * 2];
    const seedB = seedOrder[slot * 2 + 1];
    const p1 = participantBySeed.get(seedA) ?? null;
    const p2 = participantBySeed.get(seedB) ?? null;
    const m = round1[slot];

    if (p1) {
      m.player1Id = p1.playerId;
      m.player1Name = p1.displayName;
      m.player1Avatar = p1.avatarId;
      m.player1Seed = p1.seed;
    }
    if (p2) {
      m.player2Id = p2.playerId;
      m.player2Name = p2.displayName;
      m.player2Avatar = p2.avatarId;
      m.player2Seed = p2.seed;
    }
  }

  // Add Third Place match if >= 4 bracket slots (i.e. Semi-finals exist)
  let thirdPlaceMatch: TournamentMatch | null = null;
  if (bracketSize >= 4) {
    thirdPlaceMatch = {
      bracketMatchId: makeMatchId(totalRounds, 1, true),
      tournamentId,
      roundNumber: totalRounds,
      roundLabel: 'Third Place',
      slotIndex: 1,
      isThirdPlaceMatch: true,
      player1Id: null,
      player1Name: null,
      player1Avatar: null,
      player1Seed: null,
      player1Joined: false,
      player2Id: null,
      player2Name: null,
      player2Avatar: null,
      player2Seed: null,
      player2Joined: false,
      winnerId: null,
      winnerName: null,
      loserId: null,
      status: 'pending',
      roomId: null,
      roomCode: null,
      matchId: null,
      resolutionType: null,
      reason: null,
      nextMatchId: null,
      nextMatchSlot: null,
      readyDeadlineMs: null,
      startedAtMs: null,
      completedAtMs: null,
    };
  }

  const allMatches: TournamentMatch[] = [];
  for (let round = 1; round <= totalRounds; round++) {
    allMatches.push(...(matchesByRound.get(round) ?? []));
  }
  if (thirdPlaceMatch) {
    allMatches.push(thirdPlaceMatch);
  }

  // Cascade explicit BYEs in Round 1 immediately
  const matchMap = new Map(allMatches.map((m) => [m.bracketMatchId, m]));
  const nowMs = Date.now();
  for (const m of round1) {
    const hasP1 = Boolean(m.player1Id);
    const hasP2 = Boolean(m.player2Id);
    if (hasP1 && hasP2) {
      m.status = 'ready';
    } else if (hasP1 || hasP2) {
      const winnerId = hasP1 ? m.player1Id! : m.player2Id!;
      const winnerName = hasP1 ? m.player1Name! : m.player2Name!;
      const winnerAvatar = hasP1 ? m.player1Avatar! : m.player2Avatar!;
      const winnerSeed = hasP1 ? m.player1Seed : m.player2Seed;

      m.status = 'bye';
      m.winnerId = winnerId;
      m.winnerName = winnerName;
      m.resolutionType = 'bye';
      m.reason = 'Automatic BYE advancement';
      m.completedAtMs = nowMs;

      if (m.nextMatchId && m.nextMatchSlot) {
        const nextMatch = matchMap.get(m.nextMatchId);
        if (nextMatch) {
          if (m.nextMatchSlot === 1) {
            nextMatch.player1Id = winnerId;
            nextMatch.player1Name = winnerName;
            nextMatch.player1Avatar = winnerAvatar;
            nextMatch.player1Seed = winnerSeed;
          } else {
            nextMatch.player2Id = winnerId;
            nextMatch.player2Name = winnerName;
            nextMatch.player2Avatar = winnerAvatar;
            nextMatch.player2Seed = winnerSeed;
          }
          if (nextMatch.player1Id && nextMatch.player2Id) {
            nextMatch.status = 'ready';
          }
        }
      }
    } else {
      m.status = 'bye';
      m.resolutionType = 'bye';
      m.reason = 'Empty BYE slot';
      m.completedAtMs = nowMs;
    }
  }

  return {
    bracketSize,
    totalRounds,
    seededParticipants,
    matches: allMatches,
  };
}
