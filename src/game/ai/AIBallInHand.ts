import { validateCuePlacementAgainstBalls } from '../physics/RapierTableCore';
import type { BallSettledSnapshot, PlacementZone } from '../rules/types';
import { BALL_SPECS, TABLE_DIMENSIONS } from '../utils/constants';
import type { AiDifficultyProfile } from './AIDifficultyConfig';
import type { AIPhysicsSimulator } from './AIPhysicsSimulator';
import { isSegmentClear, type AnalyzedTableState } from './AITableAnalyzer';

export interface AiBallPlacementDecision {
  x: number;
  z: number;
  reason: string;
}

const BALL_RADIUS = BALL_SPECS.radius;
const BALL_DIAMETER = BALL_RADIUS * 2;

export class AIBallInHand {
  public async choosePlacement(
    table: AnalyzedTableState,
    profile: AiDifficultyProfile,
    simulator: AIPhysicsSimulator,
    signal?: AbortSignal,
  ): Promise<AiBallPlacementDecision> {
    const D = TABLE_DIMENSIONS;
    const zone: PlacementZone = table.ballInHandZone;
    const ballMap = table.ballMap;

    interface PlacementCandidate {
      x: number;
      z: number;
      score: number;
      targetNum: number;
      pocketId: string;
      aimAngle: number;
      power: number;
    }

    const candidates: PlacementCandidate[] = [];

    // 1. Evaluate straight-in and slight-cut setups behind every legal target ball x pocket
    for (const targetNum of table.legalTargets) {
      const target = ballMap.get(targetNum);
      if (!target || target.pocketed) continue;

      for (const pocket of table.pockets) {
        if (!isSegmentClear(target.x, target.z, pocket.x, pocket.z, table.balls, 0, targetNum, 0.96)) {
          continue;
        }
        const toPx = pocket.x - target.x;
        const toPz = pocket.z - target.z;
        const pocketDist = Math.hypot(toPx, toPz);
        if (pocketDist < 0.06) continue;

        const pDirX = toPx / pocketDist;
        const pDirZ = toPz / pocketDist;

        const ghostX = target.x - pDirX * BALL_DIAMETER;
        const ghostZ = target.z - pDirZ * BALL_DIAMETER;

        // Try straight behind ghost point + slight angle offsets (helps avoid rail/kitchen limits)
        const angleOffsets = profile.id === 'beginner' ? [0] : [0, 0.16, -0.16];
        const standOffs = [0.24, 0.38, 0.54];
        const baseBackAngle = Math.atan2(-pDirZ, -pDirX);

        for (const aOff of angleOffsets) {
          const dirBackX = Math.cos(baseBackAngle + aOff);
          const dirBackZ = Math.sin(baseBackAngle + aOff);

          for (const standOff of standOffs) {
            const cx = ghostX + dirBackX * standOff;
            const cz = ghostZ + dirBackZ * standOff;

            const check = validateCuePlacementAgainstBalls(cx, cz, table.balls, zone);
            if (!check.valid) continue;

            if (
              !isSegmentClear(
                check.clampedX,
                check.clampedZ,
                ghostX,
                ghostZ,
                table.balls,
                0,
                targetNum,
                0.96,
              )
            ) {
              continue;
            }

            const aimAngle = Math.atan2(ghostZ - check.clampedZ, ghostX - check.clampedX);
            const score =
              110 -
              pocketDist * 18 -
              standOff * 7 -
              Math.abs(aOff) * 28 +
              (pocket.isCorner ? 6 : 2);

            candidates.push({
              x: check.clampedX,
              z: check.clampedZ,
              score,
              targetNum,
              pocketId: pocket.id,
              aimAngle,
              power: Math.min(0.68, 0.34 + (pocketDist + standOff) * 0.11),
            });
          }
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    // Pro & Legend: verify top placement candidates with isolated Rapier simulation!
    if (
      candidates.length > 0 &&
      (profile.id === 'pro' || profile.id === 'legend') &&
      !signal?.aborted
    ) {
      const topToVerify = candidates.slice(0, 4);
      for (const cand of topToVerify) {
        if (signal?.aborted) break;
        const testBalls: BallSettledSnapshot[] = table.balls.map((b) =>
          b.number === 0 ? { number: 0, x: cand.x, z: cand.z, pocketed: false } : { ...b },
        );
        const res = await simulator.simulateBatch(
          testBalls,
          [
            {
              candidateId: `bih-${cand.targetNum}-${cand.pocketId}`,
              aimAngle: cand.aimAngle,
              power: cand.power,
              spin: { x: 0, y: 0 },
              calledBall: cand.targetNum,
              calledPocket: cand.pocketId as any,
              maxSimSeconds: 3.2,
            },
          ],
          false,
          signal,
        );
        const out = res[0];
        if (out) {
          const madeTarget = out.pocketedBalls.some((p) => p.ballNumber === cand.targetNum);
          if (madeTarget && !out.cuePocketed) {
            return {
              x: cand.x,
              z: cand.z,
              reason: `Aligned behind #${cand.targetNum}`,
            };
          }
        }
      }
    }

    if (candidates.length > 0) {
      const best = candidates[0];
      return {
        x: best.x,
        z: best.z,
        reason: `Positioned for #${best.targetNum}`,
      };
    }

    // Fallback: valid grid scan inside legal zone
    const minX = -D.halfLength + BALL_RADIUS + 0.08;
    const maxX = zone === 'kitchen' ? D.headSpotX - 0.02 : D.halfLength - BALL_RADIUS - 0.08;
    const maxZ = D.halfWidth - BALL_RADIUS - 0.08;

    for (let x = Math.min(D.headSpotX, maxX); x >= minX; x -= 0.08) {
      for (let stepZ = 0; stepZ <= maxZ; stepZ += 0.08) {
        for (const z of stepZ === 0 ? [0] : [stepZ, -stepZ]) {
          const check = validateCuePlacementAgainstBalls(x, z, table.balls, zone);
          if (check.valid) {
            return {
              x: check.clampedX,
              z: check.clampedZ,
              reason: 'Legal table placement',
            };
          }
        }
      }
    }

    return { x: D.headSpotX, z: 0, reason: 'Head spot placement' };
  }
}
