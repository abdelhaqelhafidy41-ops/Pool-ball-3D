import type { CueSpin } from '../../store/useGameStore';
import { CLOTH_PHYSICS } from '../utils/constants';
import type { AiDifficultyProfile } from './AIDifficultyConfig';

export type SpinLabel =
  | 'Center'
  | 'Follow'
  | 'Draw'
  | 'Stun'
  | 'Left English'
  | 'Right English'
  | 'Combined Spin';

export interface SpinOption {
  spin: CueSpin;
  label: SpinLabel;
}

const MAX_R = CLOTH_PHYSICS.maxTipOffsetRatio;

export function clampSpin(spin: CueSpin): CueSpin {
  const r = Math.hypot(spin.x, spin.y);
  if (r <= MAX_R) return { x: spin.x, y: spin.y };
  const s = MAX_R / r;
  return { x: spin.x * s, y: spin.y * s };
}

export function classifySpin(spin: CueSpin): SpinLabel {
  const r = Math.hypot(spin.x, spin.y);
  if (r < 0.1) return 'Center';
  const hasTop = spin.y > 0.2;
  const hasBack = spin.y < -0.3;
  const hasStun = spin.y <= -0.1 && spin.y >= -0.3;
  const hasLeft = spin.x < -0.18;
  const hasRight = spin.x > 0.18;

  if ((hasTop || hasBack || hasStun) && (hasLeft || hasRight)) return 'Combined Spin';
  if (hasTop) return 'Follow';
  if (hasBack) return 'Draw';
  if (hasStun) return 'Stun';
  if (hasLeft) return 'Left English';
  if (hasRight) return 'Right English';
  return 'Center';
}

export class AISpinController {
  /**
   * Generates purposeful cue-ball spin options tailored to the shot geometry and AI difficulty.
   */
  public suggestSpinOptionsForShot(
    shotType: 'break' | 'direct' | 'cut' | 'bank' | 'combo' | 'safety',
    cutCosine: number,
    cutSign: number, // +1 if target goes right of aim line, -1 if left
    profile: AiDifficultyProfile,
  ): SpinOption[] {
    const center: SpinOption = { spin: { x: 0, y: 0 }, label: 'Center' };

    if (!profile.allowSpin) {
      // Beginner occasionally slips slightly off-center accidentally, almost always center
      return [center];
    }

    if (shotType === 'break') {
      if (profile.id === 'pro' || profile.id === 'legend') {
        return [
          { spin: { x: 0, y: -0.16 }, label: 'Stun' },
          { spin: { x: 0, y: 0.25 }, label: 'Follow' },
          center,
        ];
      }
      return [center];
    }

    if (shotType === 'safety') {
      if (profile.allowSideEnglish) {
        return [
          { spin: { x: 0, y: -0.35 }, label: 'Draw' },
          { spin: { x: -cutSign * 0.35, y: 0.15 }, label: 'Combined Spin' },
          center,
        ];
      }
      return [center, { spin: { x: 0, y: -0.25 }, label: 'Stun' }];
    }

    const options: SpinOption[] = [center];

    // Straight or mild cut: Follow, Draw, and Stun strongly control cue ball position
    if (cutCosine > 0.72) {
      options.push({ spin: { x: 0, y: 0.52 }, label: 'Follow' });
      options.push({ spin: { x: 0, y: -0.56 }, label: 'Draw' });
      if (profile.id === 'pro' || profile.id === 'legend') {
        options.push({ spin: { x: 0, y: -0.22 }, label: 'Stun' });
      }
    } else {
      // Angled cut: Follow drives forward off tangent; Draw pulls cue ball back
      options.push({ spin: { x: 0, y: 0.42 }, label: 'Follow' });
      options.push({ spin: { x: 0, y: -0.44 }, label: 'Draw' });
    }

    // Side English and combined spin for Pro & Legend (helps cushion angle shaping & throw control)
    if (profile.allowSideEnglish) {
      const runningSide = cutSign !== 0 ? -cutSign * 0.44 : 0.44;
      const checkSide = cutSign !== 0 ? cutSign * 0.44 : -0.44;
      options.push({
        spin: clampSpin({ x: runningSide, y: 0.32 }),
        label: 'Combined Spin',
      });
      options.push({
        spin: clampSpin({ x: checkSide, y: -0.34 }),
        label: 'Combined Spin',
      });
      if (shotType === 'bank') {
        options.push({
          spin: { x: runningSide, y: 0 },
          label: runningSide < 0 ? 'Left English' : 'Right English',
        });
      }
    }

    // Intermediate uses fewer spin variations than Pro/Legend
    if (profile.id === 'intermediate') {
      return options.slice(0, 3);
    }
    if (profile.id === 'pro') {
      return options.slice(0, 4);
    }
    return options;
  }

  public applyExecutionError(
    idealSpin: CueSpin,
    profile: AiDifficultyProfile,
    gaussianFn: () => number,
  ): CueSpin {
    if (!profile.allowSpin && Math.hypot(idealSpin.x, idealSpin.y) < 1e-4) {
      // Beginner: rare accidental slight tip offset
      if (Math.random() < 0.15) {
        return clampSpin({
          x: gaussianFn() * 0.08,
          y: gaussianFn() * 0.08,
        });
      }
      return { x: 0, y: 0 };
    }
    return clampSpin({
      x: idealSpin.x + gaussianFn() * profile.spinErrorStdDev,
      y: idealSpin.y + gaussianFn() * profile.spinErrorStdDev,
    });
  }
}
