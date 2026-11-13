import type {
  AiDifficulty,
  BallGroup,
  BallSettledSnapshot,
  PlacementZone,
  PlayerId,
  RuleProfile,
} from '../rules/types';
import { AIAimingController, type ExecutedAiShot } from './AIAimingController';
import { AIBallInHand, type AiBallPlacementDecision } from './AIBallInHand';
import { getAiDifficultyProfile } from './AIDifficultyConfig';
import { AIPhysicsSimulator } from './AIPhysicsSimulator';
import { AIStrategyPlanner, type PlannedAiShot } from './AIStrategyPlanner';
import { AITableAnalyzer, type AnalyzeTableInput } from './AITableAnalyzer';

export interface AiTurnContext {
  worldVersion: number;
  balls: BallSettledSnapshot[];
  velocities?: Map<number, { vx: number; vz: number }>;
  aiPlayer: PlayerId;
  aiGroup: BallGroup;
  opponentGroup: BallGroup;
  tableOpen: boolean;
  isBreakShot: boolean;
  ballInHandZone: PlacementZone;
  ruleProfile: RuleProfile;
  difficulty: AiDifficulty;
}

export class AIManager {
  private analyzer = new AITableAnalyzer();
  private simulator = new AIPhysicsSimulator();
  private planner = new AIStrategyPlanner();
  private aiming = new AIAimingController();
  private ballInHand = new AIBallInHand();
  private abortController: AbortController | null = null;

  public cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.simulator.cancelPending();
    this.analyzer.invalidate();
  }

  private beginOperation(): AbortSignal {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    return this.abortController.signal;
  }

  public async decideBallInHandPlacement(
    ctx: AiTurnContext,
  ): Promise<AiBallPlacementDecision> {
    const signal = this.beginOperation();
    const profile = getAiDifficultyProfile(ctx.difficulty);
    const input: AnalyzeTableInput = {
      version: ctx.worldVersion,
      balls: ctx.balls,
      velocities: ctx.velocities,
      aiPlayer: ctx.aiPlayer,
      aiGroup: ctx.aiGroup,
      opponentGroup: ctx.opponentGroup,
      tableOpen: ctx.tableOpen,
      isBreakShot: ctx.isBreakShot,
      ballInHandZone: ctx.ballInHandZone,
      ruleProfile: ctx.ruleProfile,
    };
    const analyzed = this.analyzer.analyze(input);
    return this.ballInHand.choosePlacement(analyzed, profile, this.simulator, signal);
  }

  public async planShot(
    ctx: AiTurnContext,
    onProgress?: (statusMsg: string) => void,
  ): Promise<{ plan: PlannedAiShot; executed: ExecutedAiShot }> {
    const signal = this.beginOperation();
    const profile = getAiDifficultyProfile(ctx.difficulty);
    const input: AnalyzeTableInput = {
      version: ctx.worldVersion,
      balls: ctx.balls,
      velocities: ctx.velocities,
      aiPlayer: ctx.aiPlayer,
      aiGroup: ctx.aiGroup,
      opponentGroup: ctx.opponentGroup,
      tableOpen: ctx.tableOpen,
      isBreakShot: ctx.isBreakShot,
      ballInHandZone: ctx.ballInHandZone,
      ruleProfile: ctx.ruleProfile,
    };
    const analyzed = this.analyzer.analyze(input);
    const plan = await this.planner.planBestShot(
      analyzed,
      profile,
      this.simulator,
      signal,
      onProgress,
    );
    const executed = this.aiming.applyExecutionAccuracy(plan, profile);
    return { plan, executed };
  }

  public getSimulator(): AIPhysicsSimulator {
    return this.simulator;
  }

  public dispose(): void {
    this.cancel();
    this.simulator.dispose();
  }
}
