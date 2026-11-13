import type { CueSpin } from '../../store/useGameStore';
import type { PocketId } from '../rules/types';
import { getAiDifficultyProfile, type AiDifficultyProfile } from './AIDifficultyConfig';
import type { AIPhysicsSimulator } from './AIPhysicsSimulator';
import { AIShotEvaluator, type EvaluatedShot } from './AIShotEvaluator';
import { AIShotGenerator, type CandidateShot } from './AIShotGenerator';
import { AITableAnalyzer, type AnalyzedTableState } from './AITableAnalyzer';

export interface PlannedAiShot {
  aimAngle: number;
  power: number;
  spin: CueSpin;
  calledBall: number | null;
  calledPocket: PocketId | null;
  kind: CandidateShot['kind'];
  description: string;
  strategicScore: number;
  isSafety: boolean;
  wasLookaheadVerified: boolean;
}

export class AIStrategyPlanner {
  private generator = new AIShotGenerator();
  private evaluator = new AIShotEvaluator();
  private followUpAnalyzer = new AITableAnalyzer();

  public async planBestShot(
    table: AnalyzedTableState,
    difficulty: AiDifficultyProfile | ReturnType<typeof getAiDifficultyProfile>,
    simulator: AIPhysicsSimulator,
    signal?: AbortSignal,
    onProgress?: (statusMsg: string) => void,
  ): Promise<PlannedAiShot> {
    const profile = difficulty;
    const allCandidates = this.generator.generateCandidates(table, profile);

    if (allCandidates.length === 0) {
      return this.buildSafeFallback(table);
    }

    // Partition into attack/break vs safety so safety candidates aren't pruned away by attack scores
    const attackShots = allCandidates
      .filter((c) => c.kind !== 'safety')
      .sort((a, b) => b.heuristicScore - a.heuristicScore);
    const safetyShots = allCandidates
      .filter((c) => c.kind === 'safety')
      .sort((a, b) => b.heuristicScore - a.heuristicScore);

    const safetyQuota = profile.allowSafetyShots
      ? Math.min(safetyShots.length, profile.maxSafetyCandidates)
      : Math.min(safetyShots.length, 1);
    const attackQuota = Math.max(1, profile.maxCandidatesToSimulate - safetyQuota);

    // For Beginner, add slight natural selection variance among top heuristic shots
    let chosenAttacks = attackShots.slice(0, attackQuota);
    if (profile.id === 'beginner' && attackShots.length > 3) {
      chosenAttacks = attackShots.slice(0, Math.min(attackShots.length, attackQuota + 2));
    }

    const shortlist = [...chosenAttacks, ...safetyShots.slice(0, safetyQuota)];
    if (shortlist.length === 0) {
      return this.buildSafeFallback(table);
    }

    onProgress?.(
      table.isBreakShot
        ? 'Calculating break power & angle...'
        : 'Simulating candidate shot physics...',
    );

    const simInputs = shortlist.map((c) => ({
      candidateId: c.id,
      aimAngle: c.aimAngle,
      power: c.power,
      spin: c.spin,
      calledBall: c.targetBall,
      calledPocket: c.targetPocket,
    }));

    const simOutputs = await simulator.simulateBatch(
      table.balls,
      simInputs,
      table.isBreakShot,
      signal,
    );

    if (signal?.aborted || simOutputs.length === 0) {
      return this.buildSafeFallback(table);
    }

    const simById = new Map(simOutputs.map((s) => [s.candidateId, s]));
    const evaluated: EvaluatedShot[] = [];

    for (const candidate of shortlist) {
      const sim = simById.get(candidate.id);
      if (!sim) continue;
      evaluated.push(this.evaluator.evaluateSimulatedShot(candidate, sim, table, profile));
    }

    if (evaluated.length === 0) {
      return this.buildSafeFallback(table);
    }

    evaluated.sort((a, b) => b.strategicScore - a.strategicScore);

    // Pro & Legend: 2-shot lookahead & pocket tolerance stability check on top continuing candidates
    let wasLookaheadVerified = false;
    if (
      !table.isBreakShot &&
      profile.lookaheadDepth === 2 &&
      profile.maxLookaheadFollowUps > 0
    ) {
      const topContinuing = evaluated
        .filter((e) => e.potSuccess && e.rulesEval.winner === null)
        .slice(0, profile.maxLookaheadFollowUps);

      if (topContinuing.length > 0) {
        onProgress?.('Planning follow-up cue ball position...');
        await this.applyTwoShotLookahead(topContinuing, table, profile, simulator, signal);
        wasLookaheadVerified = true;
        evaluated.sort((a, b) => b.strategicScore - a.strategicScore);
      }

      // Stability check: test ±0.014 rad perturbation on top candidate to verify pocket margin
      const leader = evaluated[0];
      if (leader && leader.potSuccess && profile.stabilityCheckCount > 0 && !signal?.aborted) {
        const delta = profile.id === 'legend' ? 0.012 : 0.016;
        const perturbInputs = [-delta, delta].slice(0, profile.stabilityCheckCount * 2).map((d, idx) => ({
          candidateId: `${leader.candidate.id}-stab-${idx}`,
          aimAngle: leader.candidate.aimAngle + d,
          power: leader.candidate.power,
          spin: leader.candidate.spin,
          calledBall: leader.candidate.targetBall,
          calledPocket: leader.candidate.targetPocket,
        }));
        const stabRes = await simulator.simulateBatch(table.balls, perturbInputs, false, signal);
        let stableCount = 0;
        for (const r of stabRes) {
          const ev = this.evaluator.evaluateSimulatedShot(leader.candidate, r, table, profile);
          if (ev.potSuccess || ev.rulesEval.winner === table.aiPlayer) {
            stableCount++;
          }
        }
        leader.strategicScore += stableCount * 22;
        evaluated.sort((a, b) => b.strategicScore - a.strategicScore);
      }
    }

    // Strategic safety override check: if best offensive shot missed in simulation or has poor pot score
    // while a strong legal safety exists, Pro/Legend/Intermediate prefer the safety!
    let best = evaluated[0];
    if (!table.isBreakShot && profile.allowSafetyShots && !best.potSuccess) {
      const bestLegalSafety = evaluated.find(
        (e) => e.candidate.kind === 'safety' && e.rulesEval.isLegal,
      );
      if (bestLegalSafety && bestLegalSafety.strategicScore >= best.strategicScore - 15) {
        best = bestLegalSafety;
      }
    }

    // Beginner occasionally picks 2nd best candidate if close to simulate imperfect judgment
    if (profile.id === 'beginner' && evaluated.length >= 2 && Math.random() < 0.28) {
      const second = evaluated[1];
      if (second.rulesEval.winner !== table.opponentPlayer) {
        best = second;
      }
    }

    const isSafety = best.candidate.kind === 'safety' || !best.potSuccess;

    return {
      aimAngle: best.candidate.aimAngle,
      power: best.candidate.power,
      spin: best.candidate.spin,
      calledBall: best.candidate.targetBall,
      calledPocket: best.candidate.targetPocket,
      kind: best.candidate.kind,
      description: best.candidate.description,
      strategicScore: best.strategicScore,
      isSafety,
      wasLookaheadVerified,
    };
  }

  private async applyTwoShotLookahead(
    topShots: EvaluatedShot[],
    parentTable: AnalyzedTableState,
    profile: AiDifficultyProfile,
    simulator: AIPhysicsSimulator,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const item of topShots) {
      if (signal?.aborted) return;

      const nextGroup = item.rulesEval.assignedGroupsNow
        ? item.rulesEval.assignedGroupsNow[parentTable.aiPlayer]
        : parentTable.aiGroup;
      const nextOppGroup = item.rulesEval.assignedGroupsNow
        ? item.rulesEval.assignedGroupsNow[parentTable.opponentPlayer]
        : parentTable.opponentGroup;
      const nextTableOpen = item.rulesEval.assignedGroupsNow ? false : parentTable.tableOpen;

      const nextTable = this.followUpAnalyzer.analyze({
        version: parentTable.version * 100 + 1,
        balls: item.sim.settledPositions,
        aiPlayer: parentTable.aiPlayer,
        aiGroup: nextGroup,
        opponentGroup: nextOppGroup,
        tableOpen: nextTableOpen,
        isBreakShot: false,
        ballInHandZone: 'anywhere',
        ruleProfile: parentTable.ruleProfile,
      });

      const followUps = this.generator
        .generateCandidates(nextTable, profile)
        .filter((c) => c.kind !== 'safety')
        .sort((a, b) => b.heuristicScore - a.heuristicScore)
        .slice(0, 2);

      if (followUps.length === 0) {
        item.strategicScore -= 25;
        continue;
      }

      const simFollow = await simulator.simulateBatch(
        nextTable.balls,
        followUps.map((f) => ({
          candidateId: f.id,
          aimAngle: f.aimAngle,
          power: f.power,
          spin: f.spin,
          calledBall: f.targetBall,
          calledPocket: f.targetPocket,
          maxSimSeconds: 3.4,
        })),
        false,
        signal,
      );

      let bestFollowBonus = -30;
      for (const f of followUps) {
        const s = simFollow.find((res) => res.candidateId === f.id);
        if (!s) continue;
        const fEval = this.evaluator.evaluateSimulatedShot(f, s, nextTable, profile);
        const bonus =
          fEval.rulesEval.winner === parentTable.aiPlayer
            ? 140
            : fEval.potSuccess
              ? 85 + f.cutCosine * 25
              : fEval.rulesEval.isLegal
                ? 5
                : -40;
        if (bonus > bestFollowBonus) bestFollowBonus = bonus;
      }

      item.strategicScore += bestFollowBonus * 0.65;
    }
  }

  private buildSafeFallback(table: AnalyzedTableState): PlannedAiShot {
    const cue = table.cueBall;
    const firstLegal = table.legalTargets
      .map((num) => table.ballMap.get(num))
      .find((b) => b && !b.pocketed);

    if (cue && firstLegal) {
      const angle = Math.atan2(firstLegal.z - cue.z, firstLegal.x - cue.x);
      return {
        aimAngle: angle,
        power: 0.48,
        spin: { x: 0, y: 0 },
        calledBall: firstLegal.number,
        calledPocket: table.pockets[0].id,
        kind: 'safety',
        description: `Fallback hit #${firstLegal.number}`,
        strategicScore: 0,
        isSafety: true,
        wasLookaheadVerified: false,
      };
    }

    return {
      aimAngle: 0,
      power: 0.5,
      spin: { x: 0, y: 0 },
      calledBall: null,
      calledPocket: null,
      kind: 'safety',
      description: 'Fallback shot',
      strategicScore: 0,
      isSafety: true,
      wasLookaheadVerified: false,
    };
  }
}
