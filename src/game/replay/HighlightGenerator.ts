import { BALL_DEFINITIONS } from '../utils/constants';
import type {
  MatchReplayRecord,
  RecordedShot,
  ReplayHighlight,
} from './types';

function describeBallNumbers(ballNumbers: number[]): string {
  return ballNumbers
    .map((n) => (n === 8 ? '#8 (8-Ball)' : `#${n} ${BALL_DEFINITIONS[n]?.name ?? ''}`.trim()))
    .join(', ');
}

function createHighlightId(matchId: string, shotNumber: number, category: string, idx: number): string {
  return `hl_${matchId}_${shotNumber}_${category}_${idx}`;
}

/**
 * Pure deterministic match highlight extractor derived strictly from recorded
 * gameplay events, collisions, pockets, and trajectory distances.
 * Never mutates gameplay state, scores, or ratings.
 */
export function generateMatchHighlights(
  replay: Pick<
    MatchReplayRecord,
    'matchId' | 'player1' | 'player2' | 'winner' | 'finalResult' | 'shots'
  >,
): ReplayHighlight[] {
  const highlights: ReplayHighlight[] = [];
  let seq = 0;

  const shots: RecordedShot[] = replay.shots ?? [];
  const finalShotIndex = shots.length - 1;

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const shotStart = shot.startMatchTimeSec ?? 0;
    const objectPockets = shot.pocketedBalls.filter((p) => p.ballNumber !== 0);
    const cueBallScratch = shot.pocketedBalls.some((p) => p.ballNumber === 0);
    const pocketedEightBall = objectPockets.some((p) => p.ballNumber === 8);

    // 1. Opening Break Shot
    if (shot.isBreakShot || i === 0) {
      const pocketNote =
        objectPockets.length > 0 && !shot.isFoul
          ? ` — ${objectPockets.length} ball${objectPockets.length > 1 ? 's' : ''} pocketed`
          : shot.isFoul
            ? ' (Break Foul)'
            : '';
      highlights.push({
        id: createHighlightId(replay.matchId, shot.shotNumber, 'break', seq++),
        category: 'break',
        title: 'Opening Break',
        description: `${shot.shooterName} breaks the rack at ${Math.round(shot.power * 100)}% power${pocketNote}.`,
        matchTimeSec: shotStart,
        shotNumber: shot.shotNumber,
        shotId: shot.id,
        shooter: shot.shooter,
        shooterName: shot.shooterName,
        importanceScore: 70 + objectPockets.length * 6,
      });
    }

    // 2. Final 8-Ball / Match Winning Shot
    const isMatchWinningShot =
      i === finalShotIndex && replay.winner !== null;
    if (pocketedEightBall) {
      const targetTime = Math.max(
        shotStart,
        shotStart + Math.max(0, (shot.pocketedBalls.find((p) => p.ballNumber === 8)?.timeSec ?? 0) - 0.35),
      );
      highlights.push({
        id: createHighlightId(replay.matchId, shot.shotNumber, 'eight_ball', seq++),
        category: 'eight_ball',
        title: shot.isFoul ? '8-Ball Foul' : '8-Ball Pocketed',
        description: `${shot.shooterName} potted the 8-Ball — ${shot.resultLabel}.`,
        matchTimeSec: targetTime,
        shotNumber: shot.shotNumber,
        shotId: shot.id,
        shooter: shot.shooter,
        shooterName: shot.shooterName,
        importanceScore: 98,
      });
    } else if (isMatchWinningShot) {
      highlights.push({
        id: createHighlightId(replay.matchId, shot.shotNumber, 'winning_moment', seq++),
        category: 'winning_moment',
        title: 'Winning Moment',
        description: `${replay.winner === 'player1' ? replay.player1.name : replay.player2.name} clinches the match: ${replay.finalResult}.`,
        matchTimeSec: Math.max(shotStart, (shot.endMatchTimeSec ?? shotStart + shot.durationSec) - 0.5),
        shotNumber: shot.shotNumber,
        shotId: shot.id,
        shooter: shot.shooter,
        shooterName: shot.shooterName,
        importanceScore: 100,
      });
    }

    // 3. Multi-Ball Pocket in one legal shot
    if (!shot.isFoul && objectPockets.length >= 2 && !shot.isBreakShot) {
      highlights.push({
        id: createHighlightId(replay.matchId, shot.shotNumber, 'multi_pocket', seq++),
        category: 'multi_pocket',
        title: `${objectPockets.length}-Ball Combo Pocket`,
        description: `${shot.shooterName} sank ${describeBallNumbers(objectPockets.map((p) => p.ballNumber))} in one visit.`,
        matchTimeSec: shotStart,
        shotNumber: shot.shotNumber,
        shotId: shot.id,
        shooter: shot.shooter,
        shooterName: shot.shooterName,
        importanceScore: 86 + objectPockets.length * 4,
      });
    }

    // 4. Long-distance Legal Pocket (real traveled trajectory length >= 1.35m)
    if (!shot.isFoul && objectPockets.length > 0 && !pocketedEightBall) {
      const longPockets = objectPockets.filter((p) => {
        const traj = shot.trajectories.find((t) => t.ballNumber === p.ballNumber);
        const cueTraj = shot.trajectories.find((t) => t.ballNumber === 0);
        return (traj?.totalDistance ?? 0) >= 1.35 || ((cueTraj?.totalDistance ?? 0) >= 1.45 && (traj?.totalDistance ?? 0) >= 0.75);
      });
      if (longPockets.length > 0) {
        const focus = longPockets[0];
        const dist = shot.trajectories.find((t) => t.ballNumber === focus.ballNumber)?.totalDistance ?? 1.4;
        highlights.push({
          id: createHighlightId(replay.matchId, shot.shotNumber, 'long_pocket', seq++),
          category: 'long_pocket',
          title: 'Long-Distance Pot',
          description: `${shot.shooterName} sank #${focus.ballNumber} over ${dist.toFixed(2)}m into pocket ${focus.pocketId.toUpperCase()}.`,
          matchTimeSec: shotStart,
          shotNumber: shot.shotNumber,
          shotId: shot.id,
          shooter: shot.shooter,
          shooterName: shot.shooterName,
          importanceScore: 82,
        });
      }
    }

    // 5. Bank / Cluster / Carom Pocket (cushion bounce or multi-ball chain prior to pocketing)
    const cushionHits = shot.collisions.filter((c) => c.kind === 'cushion').length;
    const ballCollisions = shot.collisions.filter(
      (c) => c.kind === 'cue_ball' || c.kind === 'ball_ball',
    ).length;
    if (
      !shot.isFoul &&
      !shot.isBreakShot &&
      objectPockets.length >= 1 &&
      (cushionHits >= 1 || ballCollisions >= 3) &&
      !pocketedEightBall
    ) {
      const targetPotted = objectPockets[0];
      highlights.push({
        id: createHighlightId(replay.matchId, shot.shotNumber, 'bank_or_combo', seq++),
        category: 'bank_or_combo',
        title: cushionHits >= 1 ? 'Bank / Cushion Shot' : 'Cluster Carom Shot',
        description: `${shot.shooterName} converted #${targetPotted.ballNumber} with ${cushionHits} rail bounce(s) and ${ballCollisions} ball contact(s).`,
        matchTimeSec: shotStart,
        shotNumber: shot.shotNumber,
        shotId: shot.id,
        shooter: shot.shooter,
        shooterName: shot.shooterName,
        importanceScore: 80,
      });
    }

    // 6. Legal Defensive Safety Shot (clean ball hit + cushion rebound, zero balls potted, zero foul)
    if (
      !shot.isFoul &&
      !shot.isBreakShot &&
      objectPockets.length === 0 &&
      ballCollisions >= 1 &&
      cushionHits >= 1
    ) {
      highlights.push({
        id: createHighlightId(replay.matchId, shot.shotNumber, 'defensive', seq++),
        category: 'defensive',
        title: 'Defensive Safety Play',
        description: `${shot.shooterName} played a clean safety with ${cushionHits} cushion contact(s) leaving no foul.`,
        matchTimeSec: shotStart,
        shotNumber: shot.shotNumber,
        shotId: shot.id,
        shooter: shot.shooter,
        shooterName: shot.shooterName,
        importanceScore: 55,
      });
    }

    // 7. Foul / Scratch Event
    if (shot.isFoul && !pocketedEightBall) {
      highlights.push({
        id: createHighlightId(replay.matchId, shot.shotNumber, 'foul', seq++),
        category: 'foul',
        title: cueBallScratch ? 'Cue Ball Scratch Foul' : 'Rule Foul',
        description: `${shot.shooterName}: ${shot.foulReason ?? shot.resultLabel}.`,
        matchTimeSec: shotStart,
        shotNumber: shot.shotNumber,
        shotId: shot.id,
        shooter: shot.shooter,
        shooterName: shot.shooterName,
        importanceScore: 60,
      });
    }
  }

  // Ensure a winning moment marker exists even if final shot had 8-ball pocketed
  if (
    replay.winner &&
    shots.length > 0 &&
    !highlights.some((h) => h.category === 'winning_moment')
  ) {
    const lastShot = shots[shots.length - 1];
    const winnerName =
      replay.winner === 'player1' ? replay.player1.name : replay.player2.name;
    highlights.push({
      id: createHighlightId(replay.matchId, lastShot.shotNumber, 'winning_moment', seq++),
      category: 'winning_moment',
      title: 'Match Victory',
      description: `${winnerName} wins — ${replay.finalResult}.`,
      matchTimeSec: lastShot.endMatchTimeSec ?? ((lastShot.startMatchTimeSec ?? 0) + lastShot.durationSec),
      shotNumber: lastShot.shotNumber,
      shotId: lastShot.id,
      shooter: lastShot.shooter,
      shooterName: winnerName,
      importanceScore: 100,
    });
  }

  highlights.sort((a, b) => a.matchTimeSec - b.matchTimeSec || a.shotNumber - b.shotNumber);
  return highlights;
}
