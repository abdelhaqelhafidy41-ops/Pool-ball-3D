import type { CueSpin } from '../../store/useGameStore';
import { getAiDifficultyProfile } from '../ai/AIDifficultyConfig';
import { AIBallInHand } from '../ai/AIBallInHand';
import { AIPhysicsSimulator } from '../ai/AIPhysicsSimulator';
import { AIStrategyPlanner } from '../ai/AIStrategyPlanner';
import { AITableAnalyzer } from '../ai/AITableAnalyzer';
import { createEffectiveRuleProfile } from './EightBallRules';
import type {
  AiDifficulty,
  BallGroup,
  BallSettledSnapshot,
  PlacementZone,
  PocketId,
} from './types';

export interface AiShotPlan {
  aimAngle: number;
  power: number;
  spin: CueSpin;
  calledBall: number | null;
  calledPocket: PocketId | null;
}

export interface AiPlacementChoice {
  x: number;
  z: number;
}

export async function chooseAiCuePlacementAsync(
  balls: BallSettledSnapshot[],
  tableOpen: boolean,
  aiGroup: BallGroup,
  zone: PlacementZone,
  difficulty: AiDifficulty = 'pro',
  simulator?: AIPhysicsSimulator,
): Promise<AiPlacementChoice> {
  const analyzer = new AITableAnalyzer();
  const sim = simulator ?? new AIPhysicsSimulator();
  const bih = new AIBallInHand();
  const table = analyzer.analyze({
    version: Date.now(),
    balls,
    aiPlayer: 'player2',
    aiGroup,
    opponentGroup: aiGroup === 'solids' ? 'stripes' : aiGroup === 'stripes' ? 'solids' : null,
    tableOpen,
    isBreakShot: false,
    ballInHandZone: zone,
    ruleProfile: createEffectiveRuleProfile('casual', false),
  });
  const res = await bih.choosePlacement(table, getAiDifficultyProfile(difficulty), sim);
  if (!simulator) sim.dispose();
  return { x: res.x, z: res.z };
}

export async function chooseAiShotAsync(
  balls: BallSettledSnapshot[],
  isBreakShot: boolean,
  tableOpen: boolean,
  aiGroup: BallGroup,
  difficulty: AiDifficulty = 'pro',
  calledShotsEnabled = false,
  simulator?: AIPhysicsSimulator,
): Promise<AiShotPlan> {
  const analyzer = new AITableAnalyzer();
  const sim = simulator ?? new AIPhysicsSimulator();
  const planner = new AIStrategyPlanner();
  const table = analyzer.analyze({
    version: Date.now(),
    balls,
    aiPlayer: 'player2',
    aiGroup,
    opponentGroup: aiGroup === 'solids' ? 'stripes' : aiGroup === 'stripes' ? 'solids' : null,
    tableOpen,
    isBreakShot,
    ballInHandZone: 'anywhere',
    ruleProfile: createEffectiveRuleProfile(calledShotsEnabled ? 'wpa' : 'casual', calledShotsEnabled),
  });
  const planned = await planner.planBestShot(table, getAiDifficultyProfile(difficulty), sim);
  if (!simulator) sim.dispose();
  return {
    aimAngle: planned.aimAngle,
    power: planned.power,
    spin: planned.spin,
    calledBall: planned.calledBall,
    calledPocket: planned.calledPocket,
  };
}
