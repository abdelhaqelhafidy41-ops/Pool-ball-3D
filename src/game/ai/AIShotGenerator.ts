import type { CueSpin } from '../../store/useGameStore';
import { getBallCategory } from '../rules/BallGroupManager';
import type { PocketId } from '../rules/types';
import { BALL_SPECS, TABLE_DIMENSIONS } from '../utils/constants';
import type { AiDifficultyProfile } from './AIDifficultyConfig';
import { AISpinController } from './AISpinController';
import { isSegmentClear, type AnalyzedTableState } from './AITableAnalyzer';

export type AiShotKind =
  | 'break'
  | 'direct'
  | 'cut'
  | 'bank'
  | 'combo'
  | 'eightBallFinish'
  | 'safety';

export interface CandidateShot {
  id: string;
  kind: AiShotKind;
  targetBall: number | null;
  targetPocket: PocketId | null;
  aimAngle: number;
  power: number;
  spin: CueSpin;
  heuristicScore: number;
  cutCosine: number;
  description: string;
}

const BALL_RADIUS = BALL_SPECS.radius;
const BALL_DIAMETER = BALL_RADIUS * 2;

export class AIShotGenerator {
  private spinController = new AISpinController();

  public generateCandidates(
    table: AnalyzedTableState,
    profile: AiDifficultyProfile,
  ): CandidateShot[] {
    const cue = table.cueBall;
    if (!cue || cue.pocketed) return [];

    // 1. Break shot generation
    if (table.isBreakShot) {
      return this.generateBreakCandidates(table, profile);
    }

    const candidates: CandidateShot[] = [];
    const D = TABLE_DIMENSIONS;
    const isEightStage =
      !table.tableOpen &&
      table.canAiShootEight &&
      table.legalTargets.length === 1 &&
      table.legalTargets[0] === 8;

    // 2. Direct & Cut shots across all legal target balls x all 6 pockets
    for (const targetNum of table.legalTargets) {
      const target = table.ballMap.get(targetNum);
      if (!target || target.pocketed) continue;

      for (const pocket of table.pockets) {
        if (!isSegmentClear(target.x, target.z, pocket.x, pocket.z, table.balls, 0, targetNum, 0.96)) {
          continue;
        }

        const toPocketX = pocket.x - target.x;
        const toPocketZ = pocket.z - target.z;
        const targetToPocketDist = Math.hypot(toPocketX, toPocketZ);
        if (targetToPocketDist < 0.05) continue;

        const pDirX = toPocketX / targetToPocketDist;
        const pDirZ = toPocketZ / targetToPocketDist;

        // Pocket entry angle quality (balls entering straight into mouth are much higher % than rail skims)
        const pocketEntryAlign = pDirX * pocket.entryDirX + pDirZ * pocket.entryDirZ;
        if (pocketEntryAlign < (pocket.isCorner ? 0.35 : 0.42)) continue;

        const ghostX = target.x - pDirX * BALL_DIAMETER;
        const ghostZ = target.z - pDirZ * BALL_DIAMETER;

        if (
          Math.abs(ghostX) > D.halfLength - BALL_RADIUS * 0.55 ||
          Math.abs(ghostZ) > D.halfWidth - BALL_RADIUS * 0.55
        ) {
          continue;
        }

        if (!isSegmentClear(cue.x, cue.z, ghostX, ghostZ, table.balls, 0, targetNum, 0.96)) {
          continue;
        }

        const toGhostX = ghostX - cue.x;
        const toGhostZ = ghostZ - cue.z;
        const cueToGhostDist = Math.hypot(toGhostX, toGhostZ);
        if (cueToGhostDist < 0.03) continue;

        const cueDirX = toGhostX / cueToGhostDist;
        const cueDirZ = toGhostZ / cueToGhostDist;

        const cutCos = cueDirX * pDirX + cueDirZ * pDirZ;
        if (cutCos < 0.22) continue; // > 77° cut is practically unmakeable directly

        const cutCross = cueDirX * pDirZ - cueDirZ * pDirX;
        const cutSign = cutCross >= 0 ? 1 : -1;

        const aimAngle = Math.atan2(cueDirZ, cueDirX);
        const kind: AiShotKind = isEightStage
          ? 'eightBallFinish'
          : cutCos > 0.93
            ? 'direct'
            : 'cut';

        // Estimate natural pocket speed based on distances and cut angle
        const basePower = Math.min(
          0.74,
          Math.max(0.28, 0.31 + (cueToGhostDist + targetToPocketDist) * 0.105 + (1 - cutCos) * 0.16),
        );

        const pocketBonus = pocket.isCorner ? 10 : 5;
        const heuristic =
          cutCos * 85 +
          pocketEntryAlign * 28 +
          pocketBonus -
          cueToGhostDist * 13 -
          targetToPocketDist * 17 +
          (isEightStage ? 22 : 0) -
          (target.nearCushion ? 6 : 0);

        const spinOptions = this.spinController.suggestSpinOptionsForShot(
          kind === 'direct' ? 'direct' : 'cut',
          cutCos,
          cutSign,
          profile,
        );

        // Include primary power + controlled pace variant for top shots
        const powerVariants =
          profile.id === 'beginner'
            ? [basePower]
            : [basePower, Math.min(0.8, basePower + 0.14)];

        spinOptions.forEach((opt, sIdx) => {
          const pwr = powerVariants[Math.min(sIdx, powerVariants.length - 1)];
          candidates.push({
            id: `${kind}-${targetNum}-${pocket.id}-s${sIdx}`,
            kind,
            targetBall: targetNum,
            targetPocket: pocket.id,
            aimAngle,
            power: pwr,
            spin: opt.spin,
            heuristicScore: heuristic - sIdx * 1.5,
            cutCosine: cutCos,
            description: `${kind === 'eightBallFinish' ? '8-Ball' : kind === 'direct' ? 'Direct' : 'Cut'} #${targetNum} → ${pocket.id} (${opt.label})`,
          });
        });
      }
    }

    // 3. Bank Shots (1-rail cushion reflection) for Intermediate, Pro, Legend
    if (profile.allowBankShots) {
      this.generateBankCandidates(table, profile, candidates);
    }

    // 4. Combination Shots (2-ball combo: legal ball -> target/8-ball -> pocket) for Intermediate, Pro, Legend
    if (profile.allowComboShots) {
      this.generateComboCandidates(table, profile, candidates);
    }

    // 5. Safety / Defensive Shots for Intermediate, Pro, Legend (and fallback hit for Beginner)
    this.generateSafetyAndFallbackCandidates(table, profile, candidates);

    return candidates;
  }

  private generateBreakCandidates(
    table: AnalyzedTableState,
    profile: AiDifficultyProfile,
  ): CandidateShot[] {
    const cue = table.cueBall!;
    const D = TABLE_DIMENSIONS;
    const candidates: CandidateShot[] = [];

    const apex = table.ballMap.get(1);
    const targetX = apex && !apex.pocketed ? apex.x : D.footSpotX;
    const targetZ = apex && !apex.pocketed ? apex.z : 0;

    // Head-ball break + slight off-center cut breaks
    const breakOffsets =
      profile.id === 'beginner'
        ? [0.005]
        : [0.004, -0.018, 0.022];

    const breakPowers =
      profile.id === 'beginner'
        ? [0.76]
        : profile.id === 'intermediate'
          ? [0.86, 0.82]
          : [0.92, 0.88, 0.84];

    breakOffsets.forEach((zOff, idx) => {
      const dx = targetX - cue.x;
      const dz = targetZ + zOff - cue.z;
      const angle = Math.atan2(dz, dx);
      const power = breakPowers[idx % breakPowers.length];
      const spinOpts = this.spinController.suggestSpinOptionsForShot('break', 1, 1, profile);
      const spin = spinOpts[idx % spinOpts.length].spin;

      candidates.push({
        id: `break-${idx}`,
        kind: 'break',
        targetBall: 1,
        targetPocket: null,
        aimAngle: angle,
        power,
        spin,
        heuristicScore: 100 - idx * 4,
        cutCosine: 1,
        description: `Power Break (${Math.round(power * 100)}%)`,
      });
    });

    return candidates;
  }

  private generateBankCandidates(
    table: AnalyzedTableState,
    profile: AiDifficultyProfile,
    out: CandidateShot[],
  ): void {
    const cue = table.cueBall!;
    const D = TABLE_DIMENSIONS;
    const rails = [
      { axis: 'z' as const, plane: -D.halfWidth + BALL_RADIUS },
      { axis: 'z' as const, plane: D.halfWidth - BALL_RADIUS },
      { axis: 'x' as const, plane: -D.halfLength + BALL_RADIUS },
      { axis: 'x' as const, plane: D.halfLength - BALL_RADIUS },
    ];

    const maxBanks = profile.id === 'legend' ? 8 : profile.id === 'pro' ? 6 : 3;
    const bankCandidates: CandidateShot[] = [];

    for (const targetNum of table.legalTargets) {
      const target = table.ballMap.get(targetNum);
      if (!target || target.pocketed) continue;

      for (const pocket of table.pockets) {
        for (const rail of rails) {
          // Account for cushion restitution (0.84) shortening the rebound normal component
          const restFactor = 0.88;
          const mirX =
            rail.axis === 'x'
              ? rail.plane + (rail.plane - pocket.x) / restFactor
              : pocket.x;
          const mirZ =
            rail.axis === 'z'
              ? rail.plane + (rail.plane - pocket.z) / restFactor
              : pocket.z;

          const toMirX = mirX - target.x;
          const toMirZ = mirZ - target.z;
          const bankDist = Math.hypot(toMirX, toMirZ);
          if (bankDist < 0.25) continue;

          const bDirX = toMirX / bankDist;
          const bDirZ = toMirZ / bankDist;

          // Compute bounce point on the cushion plane
          let bounceX = 0;
          let bounceZ = 0;
          let tBounce = 0;
          if (rail.axis === 'z') {
            if (Math.abs(bDirZ) < 0.18) continue;
            tBounce = (rail.plane - target.z) / bDirZ;
            if (tBounce <= 0.08) continue;
            bounceX = target.x + bDirX * tBounce;
            bounceZ = rail.plane;
            if (Math.abs(bounceX) > D.halfLength - 0.1) continue;
          } else {
            if (Math.abs(bDirX) < 0.18) continue;
            tBounce = (rail.plane - target.x) / bDirX;
            if (tBounce <= 0.08) continue;
            bounceX = rail.plane;
            bounceZ = target.z + bDirZ * tBounce;
            if (Math.abs(bounceZ) > D.halfWidth - 0.1) continue;
          }

          if (
            !isSegmentClear(target.x, target.z, bounceX, bounceZ, table.balls, 0, targetNum, 0.95) ||
            !isSegmentClear(bounceX, bounceZ, pocket.x, pocket.z, table.balls, 0, targetNum, 0.95)
          ) {
            continue;
          }

          const ghostX = target.x - bDirX * BALL_DIAMETER;
          const ghostZ = target.z - bDirZ * BALL_DIAMETER;
          if (
            Math.abs(ghostX) > D.halfLength - BALL_RADIUS * 0.6 ||
            Math.abs(ghostZ) > D.halfWidth - BALL_RADIUS * 0.6
          ) {
            continue;
          }

          if (!isSegmentClear(cue.x, cue.z, ghostX, ghostZ, table.balls, 0, targetNum, 0.96)) {
            continue;
          }

          const toGhostX = ghostX - cue.x;
          const toGhostZ = ghostZ - cue.z;
          const cueToGhost = Math.hypot(toGhostX, toGhostZ);
          if (cueToGhost < 0.04) continue;

          const cueDirX = toGhostX / cueToGhost;
          const cueDirZ = toGhostZ / cueToGhost;
          const cutCos = cueDirX * bDirX + cueDirZ * bDirZ;
          if (cutCos < 0.55) continue; // bank shots need fuller hit to stay predictable

          const baseAngle = Math.atan2(cueDirZ, cueDirX);
          const heuristic =
            cutCos * 55 -
            (cueToGhost + bankDist) * 14 +
            (pocket.isCorner ? 4 : 6);

          const angleTweaks = profile.id === 'legend' || profile.id === 'pro' ? [0, -0.025, 0.025] : [0];
          angleTweaks.forEach((tweak, tIdx) => {
            bankCandidates.push({
              id: `bank-${targetNum}-${pocket.id}-${rail.axis}${Math.sign(rail.plane)}-t${tIdx}`,
              kind: 'bank',
              targetBall: targetNum,
              targetPocket: pocket.id,
              aimAngle: baseAngle + tweak,
              power: Math.min(0.84, Math.max(0.46, 0.44 + (cueToGhost + bankDist) * 0.11)),
              spin: { x: 0, y: 0 },
              heuristicScore: heuristic - Math.abs(tweak) * 20,
              cutCosine: cutCos,
              description: `Bank #${targetNum} → ${pocket.id}`,
            });
          });
        }
      }
    }

    bankCandidates.sort((a, b) => b.heuristicScore - a.heuristicScore);
    out.push(...bankCandidates.slice(0, maxBanks));
  }

  private generateComboCandidates(
    table: AnalyzedTableState,
    profile: AiDifficultyProfile,
    out: CandidateShot[],
  ): void {
    const cue = table.cueBall!;
    const D = TABLE_DIMENSIONS;
    const maxCombos = profile.id === 'legend' ? 6 : profile.id === 'pro' ? 4 : 2;
    const comboCandidates: CandidateShot[] = [];

    // First ball must be a legal target ball! Second ball can be any non-cue, non-illegal-8 ball
    for (const firstNum of table.legalTargets) {
      if (firstNum === 8) continue; // 8-ball is not struck into another ball to win
      const firstBall = table.ballMap.get(firstNum);
      if (!firstBall || firstBall.pocketed) continue;

      for (const secondBall of table.ballMap.values()) {
        if (
          secondBall.pocketed ||
          secondBall.number === 0 ||
          secondBall.number === firstNum
        ) {
          continue;
        }
        // Never combo-pot the 8-ball illegally when group is not cleared!
        if (secondBall.number === 8 && !table.canAiShootEight) continue;
        // Prefer secondBall belonging to own group (or open table)
        if (!table.tableOpen && table.aiGroup) {
          const cat = getBallCategory(secondBall.number);
          if (cat !== table.aiGroup) continue;
        }

        const interDist = Math.hypot(secondBall.x - firstBall.x, secondBall.z - firstBall.z);
        if (interDist > 0.72 || interDist < BALL_DIAMETER * 0.95) continue;

        for (const pocket of table.pockets) {
          if (
            !isSegmentClear(
              secondBall.x,
              secondBall.z,
              pocket.x,
              pocket.z,
              table.balls,
              firstNum,
              secondBall.number,
              0.95,
            )
          ) {
            continue;
          }

          const toPx = pocket.x - secondBall.x;
          const toPz = pocket.z - secondBall.z;
          const pDist = Math.hypot(toPx, toPz);
          if (pDist < 0.05) continue;
          const pDirX = toPx / pDist;
          const pDirZ = toPz / pDist;

          // Contact ghost point behind secondBall
          const ghost2X = secondBall.x - pDirX * BALL_DIAMETER;
          const ghost2Z = secondBall.z - pDirZ * BALL_DIAMETER;

          const toG2X = ghost2X - firstBall.x;
          const toG2Z = ghost2Z - firstBall.z;
          const firstToG2 = Math.hypot(toG2X, toG2Z);
          if (firstToG2 < 0.01) continue;
          const fDirX = toG2X / firstToG2;
          const fDirZ = toG2Z / firstToG2;

          const secondAlign = fDirX * pDirX + fDirZ * pDirZ;
          if (secondAlign < 0.65) continue;

          // Contact ghost point behind firstBall
          const ghost1X = firstBall.x - fDirX * BALL_DIAMETER;
          const ghost1Z = firstBall.z - fDirZ * BALL_DIAMETER;

          if (
            Math.abs(ghost1X) > D.halfLength - BALL_RADIUS * 0.6 ||
            Math.abs(ghost1Z) > D.halfWidth - BALL_RADIUS * 0.6
          ) {
            continue;
          }
          if (!isSegmentClear(cue.x, cue.z, ghost1X, ghost1Z, table.balls, 0, firstNum, 0.96)) {
            continue;
          }

          const toG1X = ghost1X - cue.x;
          const toG1Z = ghost1Z - cue.z;
          const cueDist = Math.hypot(toG1X, toG1Z);
          if (cueDist < 0.04) continue;

          const cueDirX = toG1X / cueDist;
          const cueDirZ = toG1Z / cueDist;
          const firstAlign = cueDirX * fDirX + cueDirZ * fDirZ;
          if (firstAlign < 0.58) continue;

          const heuristic =
            firstAlign * 44 +
            secondAlign * 48 -
            (cueDist + firstToG2 + pDist) * 14;

          comboCandidates.push({
            id: `combo-${firstNum}-${secondBall.number}-${pocket.id}`,
            kind: 'combo',
            targetBall: secondBall.number,
            targetPocket: pocket.id,
            aimAngle: Math.atan2(cueDirZ, cueDirX),
            power: Math.min(0.78, Math.max(0.42, 0.4 + (cueDist + pDist) * 0.1)),
            spin: { x: 0, y: 0 },
            heuristicScore: heuristic,
            cutCosine: firstAlign * secondAlign,
            description: `Combo #${firstNum} → #${secondBall.number} → ${pocket.id}`,
          });
        }
      }
    }

    comboCandidates.sort((a, b) => b.heuristicScore - a.heuristicScore);
    out.push(...comboCandidates.slice(0, maxCombos));
  }

  private generateSafetyAndFallbackCandidates(
    table: AnalyzedTableState,
    profile: AiDifficultyProfile,
    out: CandidateShot[],
  ): void {
    const cue = table.cueBall!;
    const safetyList: CandidateShot[] = [];

    for (const targetNum of table.legalTargets) {
      const target = table.ballMap.get(targetNum);
      if (!target || target.pocketed) continue;

      const dx = target.x - cue.x;
      const dz = target.z - cue.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.02) continue;

      const clear = isSegmentClear(cue.x, cue.z, target.x, target.z, table.balls, 0, targetNum, 0.94);
      const centerAngle = Math.atan2(dz, dx);

      // Center hit (guarantees legal contact; moderate power ensures rail contact)
      safetyList.push({
        id: `safety-hit-${targetNum}`,
        kind: 'safety',
        targetBall: targetNum,
        targetPocket: table.pockets[0].id,
        aimAngle: centerAngle,
        power: clear ? Math.min(0.56, 0.34 + dist * 0.1) : 0.62,
        spin: { x: 0, y: 0 },
        heuristicScore: (clear ? 35 : -55) - dist * 10,
        cutCosine: 0.9,
        description: `Safety hit on #${targetNum}`,
      });

      if (profile.allowSafetyShots && clear) {
        // Thin left/right glancing safety edges to tuck cue ball away while sending object ball to cushion
        const edgeOffsetAngle = Math.atan2(BALL_DIAMETER * 0.72, dist);
        for (const side of [-1, 1]) {
          safetyList.push({
            id: `safety-thin-${targetNum}-${side > 0 ? 'r' : 'l'}`,
            kind: 'safety',
            targetBall: targetNum,
            targetPocket: table.pockets[0].id,
            aimAngle: centerAngle + side * edgeOffsetAngle,
            power: Math.min(0.54, 0.32 + dist * 0.09),
            spin: profile.allowSpin ? { x: 0, y: -0.25 } : { x: 0, y: 0 },
            heuristicScore: 30 - dist * 8,
            cutCosine: 0.45,
            description: `Thin safety off #${targetNum}`,
          });
        }
      }
    }

    // Bank-cushion kick fallback if every legal ball is snookered
    const hasClearHit = safetyList.some((c) => c.heuristicScore > 0);
    if (!hasClearHit && table.legalTargets.length > 0) {
      const D = TABLE_DIMENSIONS;
      const firstTarget = table.ballMap.get(table.legalTargets[0]);
      if (firstTarget) {
        const rails = [
          { axis: 'z' as const, plane: -D.halfWidth + BALL_RADIUS },
          { axis: 'z' as const, plane: D.halfWidth - BALL_RADIUS },
          { axis: 'x' as const, plane: -D.halfLength + BALL_RADIUS },
          { axis: 'x' as const, plane: D.halfLength - BALL_RADIUS },
        ];
        for (const rail of rails) {
          const mirX = rail.axis === 'x' ? 2 * rail.plane - firstTarget.x : firstTarget.x;
          const mirZ = rail.axis === 'z' ? 2 * rail.plane - firstTarget.z : firstTarget.z;
          const angle = Math.atan2(mirZ - cue.z, mirX - cue.x);
          safetyList.push({
            id: `kick-${firstTarget.number}-${rail.axis}${Math.sign(rail.plane)}`,
            kind: 'safety',
            targetBall: firstTarget.number,
            targetPocket: table.pockets[0].id,
            aimAngle: angle,
            power: 0.68,
            spin: { x: 0, y: 0 },
            heuristicScore: -10,
            cutCosine: 0.6,
            description: `Kick cushion at #${firstTarget.number}`,
          });
        }
      }
    }

    safetyList.sort((a, b) => b.heuristicScore - a.heuristicScore);
    out.push(...safetyList.slice(0, Math.max(2, profile.maxSafetyCandidates)));
  }
}
