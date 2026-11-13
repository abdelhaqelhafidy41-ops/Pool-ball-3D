import type { CueSpin } from '../../store/useGameStore';
import type { AiDifficultyProfile } from './AIDifficultyConfig';
import { AISpinController } from './AISpinController';
import type { PlannedAiShot } from './AIStrategyPlanner';

export interface ExecutedAiShot {
  aimAngle: number;
  power: number;
  spin: CueSpin;
}

function sampleStandardNormal(): number {
  const u1 = Math.max(1e-7, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export function normalizeAngleDiff(from: number, to: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

export class AIAimingController {
  private spinController = new AISpinController();

  /**
   * Applies difficulty-calibrated execution accuracy (aim angle, speed, spin)
   * right before executing the real physical cue strike.
   */
  public applyExecutionAccuracy(
    plan: PlannedAiShot,
    profile: AiDifficultyProfile,
  ): ExecutedAiShot {
    // Break shots need a bit less angular jitter so break stays fair and realistic
    const angleScale = plan.kind === 'break' ? 0.5 : 1.0;
    const angleError = sampleStandardNormal() * profile.aimJitterStdDevRad * angleScale;
    const powerError = sampleStandardNormal() * profile.powerJitterStdDev;

    const aimAngle = plan.aimAngle + angleError;
    const power = Math.max(0.18, Math.min(0.96, plan.power + powerError));
    const spin = this.spinController.applyExecutionError(
      plan.spin,
      profile,
      sampleStandardNormal,
    );

    return { aimAngle, power, spin };
  }
}
