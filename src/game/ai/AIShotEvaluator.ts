import {
  canTargetEightBall,
  getBallCategory,
  getLegalTargetBalls,
} from '../rules/BallGroupManager';
import { evaluateEightBallShot } from '../rules/EightBallRules';
import type { BallSettledSnapshot, ShotEvaluationResult } from '../rules/types';
import { BALL_SPECS, POCKET_POSITIONS, TABLE_DIMENSIONS } from '../utils/constants';
import type { AiDifficultyProfile } from './AIDifficultyConfig';
import type { SimShotOutput } from './AIPhysicsSimulator';
import type { CandidateShot } from './AIShotGenerator';
import { isSegmentClear, type AnalyzedTableState } from './AITableAnalyzer';

export interface EvaluatedShot {
  candidate: CandidateShot;
  sim: SimShotOutput;
  rulesEval: ShotEvaluationResult;
  strategicScore: number;
  potSuccess: boolean;
  cueNextPosScore: number;
  opponentThreatPenalty: number;
}

const BALL_DIAMETER = BALL_SPECS.radius * 2;

export class AIShotEvaluator {
  /**
   * Evaluates a simulated physics outcome strictly against EightBallRules and strategic criteria.
   */
  public evaluateSimulatedShot(
    candidate: CandidateShot,
    sim: SimShotOutput,
    table: AnalyzedTableState,
    profile: AiDifficultyProfile,
  ): EvaluatedShot {
    const pocketedBefore = table.pocketedSet;
    const playerCanShootEight = {
      player1: canTargetEightBall(pocketedBefore, table.aiPlayer === 'player1' ? table.aiGroup : table.opponentGroup),
      player2: canTargetEightBall(pocketedBefore, table.aiPlayer === 'player2' ? table.aiGroup : table.opponentGroup),
    };

    const rulesEval = evaluateEightBallShot(sim.telemetry, {
      profile: table.ruleProfile,
      tableOpen: table.tableOpen,
      playerGroups: {
        player1: table.aiPlayer === 'player1' ? table.aiGroup : table.opponentGroup,
        player2: table.aiPlayer === 'player2' ? table.aiGroup : table.opponentGroup,
      },
      playerCanShootEight,
    });

    // Fatal loss condition (early 8-ball, scratch on 8-ball, wrong pocket on 8-ball)
    if (rulesEval.winner === table.opponentPlayer) {
      return {
        candidate,
        sim,
        rulesEval,
        strategicScore: -100000,
        potSuccess: false,
        cueNextPosScore: 0,
        opponentThreatPenalty: 1000,
      };
    }

    // Immediate legal win!
    if (rulesEval.winner === table.aiPlayer) {
      return {
        candidate,
        sim,
        rulesEval,
        strategicScore: 50000 + candidate.cutCosine * 40,
        potSuccess: true,
        cueNextPosScore: 0,
        opponentThreatPenalty: 0,
      };
    }

    let score = 0;

    // Foul penalty (scratch, no rail, wrong first ball)
    if (!rulesEval.isLegal) {
      score -= 1800;
    }
    if (sim.cuePocketed) {
      score -= 1200;
    }

    // Evaluate pocketed object balls
    const nextGroup = rulesEval.assignedGroupsNow
      ? rulesEval.assignedGroupsNow[table.aiPlayer]
      : table.aiGroup;
    const nextTableOpen = rulesEval.assignedGroupsNow ? false : table.tableOpen;

    let pottedOwnCount = 0;
    let pottedOppCount = 0;
    let calledMatched = false;

    for (const p of sim.pocketedBalls) {
      if (p.ballNumber === 8) continue;
      const cat = getBallCategory(p.ballNumber);
      if (nextTableOpen || !nextGroup || cat === nextGroup) {
        pottedOwnCount++;
        if (
          candidate.targetBall === p.ballNumber &&
          candidate.targetPocket === p.pocketId
        ) {
          calledMatched = true;
        }
      } else {
        pottedOppCount++;
      }
    }

    const potSuccess = rulesEval.isLegal && rulesEval.turnContinues && pottedOwnCount > 0;

    if (table.isBreakShot) {
      const legalBreakBonus = rulesEval.isLegal ? 120 : -600;
      const spreadBonus = this.computeBreakSpreadScore(sim.settledPositions);
      score += legalBreakBonus + pottedOwnCount * 90 + spreadBonus - pottedOppCount * 10;
    } else {
      if (potSuccess) {
        score += 220 + pottedOwnCount * 60;
        if (calledMatched) score += 35;
        // Favor higher cut cosine (easier center-pocket pots)
        score += candidate.cutCosine * 42;
      } else if (candidate.kind !== 'safety') {
        // Missed attack shot penalty
        score -= 75;
      }

      // Penalize pocketing opponent balls unless forced
      score -= pottedOppCount * 45;
    }

    // Cue ball positioning after shot
    const cueNextPosScore = this.computeNextPositionQuality(
      sim.cueFinalPos,
      sim.settledPositions,
      nextTableOpen,
      nextGroup,
    );

    // Opponent threat after shot (critical when AI doesn't continue turn or plays a safety)
    const oppNextGroup = rulesEval.assignedGroupsNow
      ? rulesEval.assignedGroupsNow[table.opponentPlayer]
      : table.opponentGroup;
    const opponentThreatPenalty = this.computeOpponentThreat(
      sim.cueFinalPos,
      sim.settledPositions,
      nextTableOpen,
      oppNextGroup,
    );

    if (potSuccess) {
      // Continuing turn: cue ball position for next shot matters most!
      score += cueNextPosScore * profile.positionWeight;
      // Avoid scratching or hugging rail awkwardly
      score -= this.computeScratchProximityPenalty(sim.cueFinalPos);
    } else if (rulesEval.isLegal) {
      // Turn passes to opponent: minimizing opponent's easy shots is crucial!
      score -= opponentThreatPenalty * profile.opponentThreatWeight;
      if (candidate.kind === 'safety') {
        score += 95 * profile.safetyWeight;
        // Bonus if opponent's easiest shot is blocked (snooker!)
        if (opponentThreatPenalty < 25) {
          score += 90 * profile.safetyWeight;
        }
      }
      // Still slightly reward leaving own balls open for later
      score += cueNextPosScore * 0.2 * profile.positionWeight;
    }

    // Beginner doesn't care about fine strategic nuances as much
    if (profile.id === 'beginner') {
      score += candidate.heuristicScore * 0.25;
    }

    return {
      candidate,
      sim,
      rulesEval,
      strategicScore: score,
      potSuccess,
      cueNextPosScore,
      opponentThreatPenalty,
    };
  }

  public computeNextPositionQuality(
    cuePos: { x: number; z: number },
    settled: BallSettledSnapshot[],
    tableOpen: boolean,
    group: 'solids' | 'stripes' | null,
  ): number {
    const pocketedSet = new Set(settled.filter((b) => b.pocketed).map((b) => b.number));
    const nextTargets = getLegalTargetBalls(pocketedSet, tableOpen, group);
    if (nextTargets.length === 0) return 0;

    const ballMap = new Map(settled.map((b) => [b.number, b]));
    let bestShotQuality = 0;
    let makeableCount = 0;

    for (const num of nextTargets) {
      const target = ballMap.get(num);
      if (!target || target.pocketed) continue;

      for (const pocket of POCKET_POSITIONS) {
        if (!isSegmentClear(target.x, target.z, pocket.x, pocket.z, settled, 0, num, 0.96)) {
          continue;
        }
        const toPx = pocket.x - target.x;
        const toPz = pocket.z - target.z;
        const pDist = Math.hypot(toPx, toPz);
        if (pDist < 0.05) continue;
        const pDx = toPx / pDist;
        const pDz = toPz / pDist;

        const ghostX = target.x - pDx * BALL_DIAMETER;
        const ghostZ = target.z - pDz * BALL_DIAMETER;
        if (!isSegmentClear(cuePos.x, cuePos.z, ghostX, ghostZ, settled, 0, num, 0.96)) {
          continue;
        }
        const toGx = ghostX - cuePos.x;
        const toGz = ghostZ - cuePos.z;
        const gDist = Math.hypot(toGx, toGz);
        if (gDist < 0.05) continue;

        const align = (toGx * pDx + toGz * pDz) / gDist;
        if (align < 0.45) continue;

        makeableCount++;
        const q = align * 85 - gDist * 14 - pDist * 16;
        if (q > bestShotQuality) bestShotQuality = q;
      }
    }

    // Also penalize cue ball frozen directly against a cushion
    const D = TABLE_DIMENSIONS;
    const railFrozenPenalty =
      Math.abs(cuePos.x) > D.halfLength - BALL_SPECS.radius * 1.4 ||
      Math.abs(cuePos.z) > D.halfWidth - BALL_SPECS.radius * 1.4
        ? 18
        : 0;

    return bestShotQuality + Math.min(35, makeableCount * 9) - railFrozenPenalty;
  }

  public computeOpponentThreat(
    cuePos: { x: number; z: number },
    settled: BallSettledSnapshot[],
    tableOpen: boolean,
    oppGroup: 'solids' | 'stripes' | null,
  ): number {
    const pocketedSet = new Set(settled.filter((b) => b.pocketed).map((b) => b.number));
    const oppTargets = getLegalTargetBalls(pocketedSet, tableOpen, oppGroup);
    if (oppTargets.length === 0) return 0;

    const ballMap = new Map(settled.map((b) => [b.number, b]));
    let maxThreat = 0;
    let openShots = 0;

    for (const num of oppTargets) {
      const target = ballMap.get(num);
      if (!target || target.pocketed) continue;

      for (const pocket of POCKET_POSITIONS) {
        if (!isSegmentClear(target.x, target.z, pocket.x, pocket.z, settled, 0, num, 0.96)) {
          continue;
        }
        const toPx = pocket.x - target.x;
        const toPz = pocket.z - target.z;
        const pDist = Math.hypot(toPx, toPz);
        if (pDist < 0.05) continue;
        const pDx = toPx / pDist;
        const pDz = toPz / pDist;

        const ghostX = target.x - pDx * BALL_DIAMETER;
        const ghostZ = target.z - pDz * BALL_DIAMETER;
        if (!isSegmentClear(cuePos.x, cuePos.z, ghostX, ghostZ, settled, 0, num, 0.96)) {
          continue;
        }

        const toGx = ghostX - cuePos.x;
        const toGz = ghostZ - cuePos.z;
        const gDist = Math.hypot(toGx, toGz);
        if (gDist < 0.04) continue;
        const align = (toGx * pDx + toGz * pDz) / gDist;
        if (align < 0.42) continue;

        openShots++;
        const threat = align * 85 - gDist * 14 - pDist * 14 + (num === 8 ? 35 : 0);
        if (threat > maxThreat) maxThreat = threat;
      }
    }

    return Math.max(0, maxThreat + Math.min(30, openShots * 6));
  }

  private computeScratchProximityPenalty(cuePos: { x: number; z: number }): number {
    let minDist = Infinity;
    for (const p of POCKET_POSITIONS) {
      const d = Math.hypot(cuePos.x - p.x, cuePos.z - p.z);
      if (d < minDist) minDist = d;
    }
    if (minDist < 0.14) return 40;
    if (minDist < 0.22) return 15;
    return 0;
  }

  private computeBreakSpreadScore(settled: BallSettledSnapshot[]): number {
    let spread = 0;
    for (const b of settled) {
      if (b.number === 0 || b.pocketed) continue;
      // Reward balls spreading away from foot spot rack cluster
      const d = Math.hypot(b.x - TABLE_DIMENSIONS.footSpotX, b.z);
      spread += Math.min(0.6, d);
    }
    return spread * 8;
  }
}
