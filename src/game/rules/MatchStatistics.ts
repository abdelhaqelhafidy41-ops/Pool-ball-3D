import type { MatchStatistics } from './types';

const STATS_STORAGE_KEY = 'ultimate_pool_3d_stats_v1';

export function createEmptyStatistics(): MatchStatistics {
  return {
    matchesPlayed: 0,
    wins: 0,
    losses: 0,
    totalShots: 0,
    ballsPocketed: 0,
    fouls: 0,
    successfulBreaks: 0,
    turnsCompleted: 0,
  };
}

export function loadMatchStatistics(): MatchStatistics {
  const defaults = createEmptyStatistics();
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return defaults;
    }
    const raw = window.localStorage.getItem(STATS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<MatchStatistics>;
    return {
      matchesPlayed: Number(parsed.matchesPlayed) || 0,
      wins: Number(parsed.wins) || 0,
      losses: Number(parsed.losses) || 0,
      totalShots: Number(parsed.totalShots) || 0,
      ballsPocketed: Number(parsed.ballsPocketed) || 0,
      fouls: Number(parsed.fouls) || 0,
      successfulBreaks: Number(parsed.successfulBreaks) || 0,
      turnsCompleted: Number(parsed.turnsCompleted) || 0,
    };
  } catch {
    return defaults;
  }
}

export function saveMatchStatistics(stats: MatchStatistics): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // Ignore storage quota / private mode errors
  }
}

export function clearMatchStatistics(): MatchStatistics {
  const empty = createEmptyStatistics();
  saveMatchStatistics(empty);
  return empty;
}

export function computeAverageBallsPerTurn(stats: MatchStatistics): number {
  if (!stats.turnsCompleted || stats.turnsCompleted <= 0) return 0;
  return stats.ballsPocketed / stats.turnsCompleted;
}
