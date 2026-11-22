import type { RuleProfileId } from '../../game/rules/types';
import type { OnlineAvatarId } from './protocol';
import type { ClubEmblemIcon, ClubTrophyRecord } from './social';

export type CompetitionRegion =
  | 'GLOBAL'
  | 'MENA'
  | 'EU'
  | 'NA'
  | 'APAC'
  | 'LATAM'
  | 'SA'
  | 'EG'
  | 'AE'
  | 'US'
  | 'UK';

export const COMPETITION_REGIONS: Array<{ id: CompetitionRegion; label: string; scope: 'international' | 'regional' | 'national' }> = [
  { id: 'GLOBAL', label: 'Global International', scope: 'international' },
  { id: 'MENA', label: 'Middle East & North Africa', scope: 'regional' },
  { id: 'EU', label: 'Europe', scope: 'regional' },
  { id: 'NA', label: 'North America', scope: 'regional' },
  { id: 'APAC', label: 'Asia Pacific', scope: 'regional' },
  { id: 'LATAM', label: 'Latin America', scope: 'regional' },
  { id: 'SA', label: 'Saudi Arabia (National)', scope: 'national' },
  { id: 'EG', label: 'Egypt (National)', scope: 'national' },
  { id: 'AE', label: 'UAE (National)', scope: 'national' },
  { id: 'US', label: 'United States (National)', scope: 'national' },
  { id: 'UK', label: 'United Kingdom (National)', scope: 'national' },
];

export type LeagueScope = 'regional' | 'national' | 'international';
export type LeagueCadence = 'weekly' | 'seasonal';
export type LeagueStatus = 'registration_open' | 'in_progress' | 'completed' | 'cancelled';

export type ClubChampionshipFormat =
  | 'single_elimination'
  | 'double_elimination'
  | 'group_knockout'
  | 'swiss';
export type ClubChampionshipStatus =
  | 'registration_open'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type TeamMatchFormat = 'singles' | 'doubles' | 'team_bo3' | 'team_bo5';
export type TeamRosterRole = 'captain' | 'starter' | 'substitute';
export type TeamEncounterStatus =
  | 'pending'
  | 'scheduled'
  | 'lineup_ready'
  | 'in_progress'
  | 'completed'
  | 'bye'
  | 'walkover'
  | 'forfeited'
  | 'disqualified';

export type TeamSubMatchStatus = 'pending' | 'ready' | 'in_progress' | 'completed' | 'forfeited';

export interface TeamRosterMember {
  teamId: string;
  clubId: string;
  playerId: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo: number;
  role: TeamRosterRole;
  matchesPlayed: number;
  wins: number;
  losses: number;
  mvpCount: number;
  joinedAtMs: number;
}

export interface ClubTeamRecord {
  teamId: string;
  clubId: string;
  clubName: string;
  clubTag: string;
  name: string;
  tag: string;
  badgeColor: string;
  badgeIcon: ClubEmblemIcon;
  region: string;
  captainId: string;
  captainName: string;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  draws: number;
  matchesPlayed: number;
  titlesCount: number;
  minRosterSize: number;
  maxRosterSize: number;
  rosterCount: number;
  roster: TeamRosterMember[];
  status: 'active' | 'archived';
  createdAtMs: number;
  updatedAtMs: number;
}

export interface TeamEloHistoryEntry {
  eventId: string;
  teamId: string;
  competitionKind: 'league' | 'club_championship' | 'season_reset';
  competitionId: string;
  competitionTitle: string;
  opponentTeamId: string | null;
  opponentTeamName: string | null;
  eloBefore: number;
  eloAfter: number;
  eloDelta: number;
  outcome: 'win' | 'loss' | 'draw' | 'reset';
  createdAtMs: number;
}

export interface TeamLineupSlot {
  slotIndex: number;
  playerId: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo: number;
}

export interface TeamSubMatchRecord {
  subMatchId: string;
  competitionKind: 'league' | 'club_championship';
  competitionId: string;
  encounterId: string;
  slotIndex: number;
  boardLabel: string;
  homeTeamId: string;
  awayTeamId: string;
  homePlayerId: string | null;
  homePlayerName: string | null;
  homePlayerAvatar?: OnlineAvatarId | null;
  awayPlayerId: string | null;
  awayPlayerName: string | null;
  awayPlayerAvatar?: OnlineAvatarId | null;
  winnerTeamId: string | null;
  winnerPlayerId: string | null;
  roomId: string | null;
  roomCode: string | null;
  verifiedMatchId: string | null;
  status: TeamSubMatchStatus;
  completionReason: string | null;
  completedAtMs: number | null;
}

export interface TeamLeagueRecord {
  leagueId: string;
  title: string;
  description: string;
  scope: LeagueScope;
  region: string;
  cadence: LeagueCadence;
  divisionTier: number;
  seasonLabel: string;
  matchFormat: TeamMatchFormat;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  doubleRoundRobin: boolean;
  maxTeams: number;
  registeredCount: number;
  promotionSlots: number;
  relegationSlots: number;
  matchDurationMinutes: number;
  status: LeagueStatus;
  createdByPlayerId: string | null;
  championTeamId: string | null;
  championTeamName: string | null;
  startsAtMs: number | null;
  completedAtMs: number | null;
  createdAtMs: number;
}

export interface TeamLeagueStandingRow {
  leagueId: string;
  teamId: string;
  clubId: string;
  clubTag: string;
  teamName: string;
  teamTag: string;
  badgeColor: string;
  badgeIcon: ClubEmblemIcon;
  teamElo: number;
  rank: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  matchWins: number;
  matchLosses: number;
  frameDiff: number;
  points: number;
  streak: number;
  zone: 'champion' | 'promotion' | 'safe' | 'relegation';
  outcomeTag: 'promoted' | 'relegated' | 'stayed' | null;
}

export interface TeamLeagueFixtureRecord {
  fixtureId: string;
  leagueId: string;
  roundNumber: number;
  legNumber: number;
  homeTeamId: string;
  homeTeamName: string;
  homeTeamTag: string;
  homeClubTag: string;
  awayTeamId: string;
  awayTeamName: string;
  awayTeamTag: string;
  awayClubTag: string;
  homeLineup: TeamLineupSlot[];
  awayLineup: TeamLineupSlot[];
  homeScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  isDraw: boolean;
  status: TeamEncounterStatus;
  scheduledAtMs: number | null;
  deadlineAtMs: number | null;
  completedAtMs: number | null;
  subMatches: TeamSubMatchRecord[];
}

export interface TeamLeagueDetailPayload {
  league: TeamLeagueRecord;
  standings: TeamLeagueStandingRow[];
  fixtures: TeamLeagueFixtureRecord[];
  viewerTeamIds: string[];
  canManage: boolean;
}

export interface ClubChampionshipRecord {
  championshipId: string;
  title: string;
  description: string;
  format: ClubChampionshipFormat;
  region: string;
  seasonLabel: string;
  matchFormat: TeamMatchFormat;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  maxTeams: number;
  registeredCount: number;
  currentRound: number;
  totalRounds: number;
  swissRounds: number;
  groupSize: number;
  groupAdvanceCount: number;
  stage: 'registration' | 'groups' | 'knockout' | 'swiss' | 'completed';
  status: ClubChampionshipStatus;
  createdByPlayerId: string | null;
  championTeamId: string | null;
  championTeamName: string | null;
  championClubId: string | null;
  championClubName: string | null;
  runnerUpTeamId: string | null;
  runnerUpTeamName: string | null;
  prizeCoinsChampion: number;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

export interface ClubChampionshipEntryRecord {
  championshipId: string;
  teamId: string;
  clubId: string;
  clubTag: string;
  teamName: string;
  teamTag: string;
  badgeColor: string;
  badgeIcon: ClubEmblemIcon;
  seed: number | null;
  groupIndex: number | null;
  teamEloAtEntry: number;
  wins: number;
  losses: number;
  points: number;
  buchholz: number;
  frameDiff: number;
  eliminated: boolean;
  disqualified: boolean;
  placement: number | null;
}

export interface ClubChampionshipMatchRecord {
  matchNodeId: string;
  championshipId: string;
  stageType: 'group' | 'winners' | 'losers' | 'grand_final' | 'knockout' | 'swiss';
  groupIndex: number | null;
  roundNumber: number;
  roundLabel: string;
  slotIndex: number;
  homeTeamId: string | null;
  homeTeamName: string | null;
  homeTeamTag: string | null;
  homeSeed: number | null;
  awayTeamId: string | null;
  awayTeamName: string | null;
  awayTeamTag: string | null;
  awaySeed: number | null;
  homeLineup: TeamLineupSlot[];
  awayLineup: TeamLineupSlot[];
  homeScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  nextWinnerNodeId: string | null;
  nextWinnerSlot: 'home' | 'away' | null;
  nextLoserNodeId: string | null;
  nextLoserSlot: 'home' | 'away' | null;
  status: TeamEncounterStatus;
  resolutionNote: string | null;
  deadlineAtMs: number | null;
  completedAtMs: number | null;
  subMatches: TeamSubMatchRecord[];
}

export interface ClubChampionshipDetailPayload {
  championship: ClubChampionshipRecord;
  entries: ClubChampionshipEntryRecord[];
  matches: ClubChampionshipMatchRecord[];
  viewerTeamIds: string[];
  canManage: boolean;
}

export interface TeamLeaderboardEntry {
  rank: number;
  teamId: string;
  clubId: string;
  clubName: string;
  clubTag: string;
  name: string;
  tag: string;
  badgeColor: string;
  badgeIcon: ClubEmblemIcon;
  region: string;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  draws: number;
  matchesPlayed: number;
  titlesCount: number;
  rosterCount: number;
}

export interface TeamEloRankingsPayload {
  region: string;
  teams: TeamLeaderboardEntry[];
  trophies: ClubTrophyRecord[];
}

export const TEAM_MATCH_FORMAT_SPEC: Record<
  TeamMatchFormat,
  {
    label: string;
    boards: number;
    requiredLineupPlayers: number;
    targetWins: number;
    allowDraws: boolean;
  }
> = {
  singles: {
    label: '1v1 Singles',
    boards: 1,
    requiredLineupPlayers: 1,
    targetWins: 1,
    allowDraws: false,
  },
  doubles: {
    label: 'Doubles Relay (2 Players · Bo3)',
    boards: 3,
    requiredLineupPlayers: 2,
    targetWins: 2,
    allowDraws: false,
  },
  team_bo3: {
    label: '3v3 Team Series (Bo3)',
    boards: 3,
    requiredLineupPlayers: 3,
    targetWins: 2,
    allowDraws: false,
  },
  team_bo5: {
    label: '5v5 Pro Encounter (Bo5)',
    boards: 5,
    requiredLineupPlayers: 5,
    targetWins: 3,
    allowDraws: false,
  },
};

/**
 * Resolves the two lineup player assignments for a given sub-match board index.
 * For 'doubles' (2 nominated players per side across 3 boards):
 *   Board 0 -> [home[0], away[0]]
 *   Board 1 -> [home[1], away[1]]
 *   Board 2 (Decider) -> [home[0], away[1]] (cross-captain decider)
 */
export function resolveLineupBoardPlayers(
  format: TeamMatchFormat,
  homeLineup: TeamLineupSlot[],
  awayLineup: TeamLineupSlot[],
  boardIndex: number,
): { home: TeamLineupSlot | null; away: TeamLineupSlot | null; label: string } {
  if (format === 'doubles') {
    if (boardIndex === 0) {
      return {
        home: homeLineup[0] ?? null,
        away: awayLineup[0] ?? null,
        label: 'Doubles Pair · Board 1',
      };
    }
    if (boardIndex === 1) {
      return {
        home: homeLineup[1] ?? homeLineup[0] ?? null,
        away: awayLineup[1] ?? awayLineup[0] ?? null,
        label: 'Doubles Pair · Board 2',
      };
    }
    return {
      home: homeLineup[0] ?? null,
      away: awayLineup[1] ?? awayLineup[0] ?? null,
      label: 'Doubles Decider · Board 3',
    };
  }
  return {
    home: homeLineup[boardIndex] ?? null,
    away: awayLineup[boardIndex] ?? null,
    label: format === 'singles' ? 'Main Singles Match' : `Board ${boardIndex + 1}`,
  };
}

export function calculateTeamEloUpdate(
  ratingA: number,
  ratingB: number,
  scoreA: number,
  kFactor = 32,
): { newA: number; newB: number; deltaA: number; deltaB: number } {
  const safeA = Math.max(400, Math.min(3500, Math.round(ratingA)));
  const safeB = Math.max(400, Math.min(3500, Math.round(ratingB)));
  const expectedA = 1 / (1 + Math.pow(10, (safeB - safeA) / 400));
  const expectedB = 1 - expectedA;
  const deltaA = Math.round(kFactor * (scoreA - expectedA));
  const deltaB = Math.round(kFactor * (1 - scoreA - expectedB));
  return {
    newA: Math.max(600, safeA + deltaA),
    newB: Math.max(600, safeB + deltaB),
    deltaA,
    deltaB,
  };
}

export interface GeneratedRoundRobinFixture {
  roundNumber: number;
  legNumber: number;
  homeTeamId: string;
  awayTeamId: string;
}

/**
 * Deterministic circle-method Round-Robin fixture generator.
 * Alternates home/away balance and supports single or double (home & away) round-robin.
 */
export function generateRoundRobinFixtures(
  teamIds: string[],
  doubleRoundRobin = true,
): GeneratedRoundRobinFixture[] {
  const clean = teamIds.filter(Boolean);
  if (clean.length < 2) return [];

  const list: Array<string | null> = [...clean];
  if (list.length % 2 === 1) {
    list.push(null); // Bye slot
  }
  const n = list.length;
  const roundsPerLeg = n - 1;
  const half = n / 2;
  const leg1: GeneratedRoundRobinFixture[] = [];

  const rotating = [...list];
  for (let roundIdx = 0; roundIdx < roundsPerLeg; roundIdx++) {
    for (let i = 0; i < half; i++) {
      const a = rotating[i];
      const b = rotating[n - 1 - i];
      if (!a || !b) continue;
      const flip = (roundIdx + i) % 2 === 1;
      leg1.push({
        roundNumber: roundIdx + 1,
        legNumber: 1,
        homeTeamId: flip ? b : a,
        awayTeamId: flip ? a : b,
      });
    }
    // Rotate all except index 0 clockwise
    const last = rotating.pop()!;
    rotating.splice(1, 0, last);
  }

  if (!doubleRoundRobin) return leg1;

  const leg2: GeneratedRoundRobinFixture[] = leg1.map((f) => ({
    roundNumber: f.roundNumber + roundsPerLeg,
    legNumber: 2,
    homeTeamId: f.awayTeamId,
    awayTeamId: f.homeTeamId,
  }));

  return [...leg1, ...leg2];
}

export function sortLeagueStandings(
  rows: TeamLeagueStandingRow[],
  completedFixtures: Array<{
    homeTeamId: string;
    awayTeamId: string;
    homeScore: number;
    awayScore: number;
    winnerTeamId: string | null;
    isDraw: boolean;
    status: TeamEncounterStatus;
  }>,
): TeamLeagueStandingRow[] {
  const copy = rows.map((r) => ({ ...r }));

  const h2hPoints = (teamA: string, teamB: string): number => {
    let ptsA = 0;
    let ptsB = 0;
    for (const f of completedFixtures) {
      if (
        f.status !== 'completed' &&
        f.status !== 'walkover' &&
        f.status !== 'forfeited'
      ) {
        continue;
      }
      const matchPair =
        (f.homeTeamId === teamA && f.awayTeamId === teamB) ||
        (f.homeTeamId === teamB && f.awayTeamId === teamA);
      if (!matchPair) continue;
      if (f.isDraw || !f.winnerTeamId) {
        ptsA += 1;
        ptsB += 1;
      } else if (f.winnerTeamId === teamA) {
        ptsA += 3;
      } else if (f.winnerTeamId === teamB) {
        ptsB += 3;
      }
    }
    return ptsA - ptsB;
  };

  copy.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const h2h = h2hPoints(b.teamId, a.teamId);
    if (h2h !== 0) return h2h;
    if (b.frameDiff !== a.frameDiff) return b.frameDiff - a.frameDiff;
    if (b.matchWins !== a.matchWins) return b.matchWins - a.matchWins;
    if (b.won !== a.won) return b.won - a.won;
    if (b.teamElo !== a.teamElo) return b.teamElo - a.teamElo;
    return a.teamName.localeCompare(b.teamName);
  });

  return copy.map((row, idx) => ({ ...row, rank: idx + 1 }));
}

export function seedTeamsByElo<T extends { elo: number; name: string }>(teams: T[]): T[] {
  return [...teams].sort((a, b) => {
    if (b.elo !== a.elo) return b.elo - a.elo;
    return a.name.localeCompare(b.name);
  });
}

export function formatClubRoleBadgeLabel(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'president':
      return 'President';
    case 'vice_president':
    case 'admin':
      return 'Vice President';
    case 'captain':
      return 'Captain';
    default:
      return 'Member';
  }
}
