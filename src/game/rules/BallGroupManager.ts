import type { BallCategory, BallGroup, PlayerId } from './types';

export const SOLIDS_NUMBERS = [1, 2, 3, 4, 5, 6, 7] as const;
export const STRIPES_NUMBERS = [9, 10, 11, 12, 13, 14, 15] as const;

export function getBallCategory(ballNumber: number): BallCategory {
  if (ballNumber === 0) return 'cue';
  if (ballNumber === 8) return 'eight';
  if (ballNumber >= 1 && ballNumber <= 7) return 'solids';
  return 'stripes';
}

export function getOpponent(player: PlayerId): PlayerId {
  return player === 'player1' ? 'player2' : 'player1';
}

function toSet(pocketed: Set<number> | number[]): Set<number> {
  return pocketed instanceof Set ? pocketed : new Set(pocketed);
}

export function getRemainingBallsForGroup(
  pocketed: Set<number> | number[],
  group: BallGroup,
): number[] {
  if (!group) return [];
  const pSet = toSet(pocketed);
  const source = group === 'solids' ? SOLIDS_NUMBERS : STRIPES_NUMBERS;
  return source.filter((num) => !pSet.has(num));
}

export function canTargetEightBall(
  pocketed: Set<number> | number[],
  group: BallGroup,
): boolean {
  if (!group) return false;
  return getRemainingBallsForGroup(pocketed, group).length === 0;
}

export function getLegalTargetBalls(
  pocketed: Set<number> | number[],
  tableOpen: boolean,
  group: BallGroup,
): number[] {
  const pSet = toSet(pocketed);

  if (tableOpen || !group) {
    const openBalls: number[] = [];
    for (const num of SOLIDS_NUMBERS) {
      if (!pSet.has(num)) openBalls.push(num);
    }
    for (const num of STRIPES_NUMBERS) {
      if (!pSet.has(num)) openBalls.push(num);
    }
    return openBalls;
  }

  const remaining = getRemainingBallsForGroup(pSet, group);
  if (remaining.length > 0) {
    return remaining;
  }
  return pSet.has(8) ? [] : [8];
}
