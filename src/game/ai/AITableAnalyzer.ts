import {
  canTargetEightBall,
  getBallCategory,
  getLegalTargetBalls,
  getOpponent,
} from '../rules/BallGroupManager';
import type {
  BallGroup,
  BallSettledSnapshot,
  PlacementZone,
  PlayerId,
  PocketId,
  RuleProfile,
} from '../rules/types';
import { BALL_SPECS, POCKET_POSITIONS, TABLE_DIMENSIONS } from '../utils/constants';

export interface AnalyzedPocket {
  id: PocketId;
  x: number;
  z: number;
  radius: number;
  isCorner: boolean;
  // Unit vector pointing from table center / pocket entrance toward pocket back
  entryDirX: number;
  entryDirZ: number;
}

export interface AnalyzedBall {
  number: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  pocketed: boolean;
  category: 'cue' | 'solids' | 'stripes' | 'eight';
  nearCushion: boolean;
  clusterCount: number;
}

export interface AnalyzedTableState {
  version: number;
  cueBall: AnalyzedBall | null;
  balls: BallSettledSnapshot[];
  ballMap: Map<number, AnalyzedBall>;
  pockets: AnalyzedPocket[];
  cushionBounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  pocketedSet: Set<number>;
  aiPlayer: PlayerId;
  opponentPlayer: PlayerId;
  aiGroup: BallGroup;
  opponentGroup: BallGroup;
  tableOpen: boolean;
  isBreakShot: boolean;
  canAiShootEight: boolean;
  canOpponentShootEight: boolean;
  legalTargets: number[];
  opponentLegalTargets: number[];
  ballInHandZone: PlacementZone;
  ruleProfile: RuleProfile;
  anyBallMoving: boolean;
}

export interface AnalyzeTableInput {
  version: number;
  balls: BallSettledSnapshot[];
  velocities?: Map<number, { vx: number; vz: number }>;
  aiPlayer: PlayerId;
  aiGroup: BallGroup;
  opponentGroup: BallGroup;
  tableOpen: boolean;
  isBreakShot: boolean;
  ballInHandZone: PlacementZone;
  ruleProfile: RuleProfile;
}

const BALL_RADIUS = BALL_SPECS.radius;
const BALL_DIAMETER = BALL_RADIUS * 2;

export class AITableAnalyzer {
  private lastVersion = -1;
  private cachedState: AnalyzedTableState | null = null;

  public invalidate(): void {
    this.lastVersion = -1;
    this.cachedState = null;
  }

  public analyze(input: AnalyzeTableInput): AnalyzedTableState {
    if (
      this.cachedState &&
      this.lastVersion === input.version &&
      this.cachedState.aiPlayer === input.aiPlayer &&
      this.cachedState.aiGroup === input.aiGroup &&
      this.cachedState.tableOpen === input.tableOpen &&
      this.cachedState.isBreakShot === input.isBreakShot &&
      this.cachedState.ruleProfile.calledShotsEnabled === input.ruleProfile.calledShotsEnabled
    ) {
      return this.cachedState;
    }

    const D = TABLE_DIMENSIONS;
    const cushionBounds = {
      minX: -D.halfLength + BALL_RADIUS,
      maxX: D.halfLength - BALL_RADIUS,
      minZ: -D.halfWidth + BALL_RADIUS,
      maxZ: D.halfWidth - BALL_RADIUS,
    };

    const pockets: AnalyzedPocket[] = POCKET_POSITIONS.map((p) => {
      if (p.isCorner) {
        const len = Math.hypot(p.x, p.z) || 1;
        return {
          id: p.id as PocketId,
          x: p.x,
          z: p.z,
          radius: p.radius,
          isCorner: true,
          entryDirX: Math.sign(p.x) / Math.SQRT2,
          entryDirZ: Math.sign(p.z) / Math.SQRT2,
          ...(len > 0 ? {} : {}),
        };
      }
      return {
        id: p.id as PocketId,
        x: p.x,
        z: p.z,
        radius: p.radius,
        isCorner: false,
        entryDirX: 0,
        entryDirZ: Math.sign(p.z),
      };
    });

    const pocketedSet = new Set<number>();
    const ballMap = new Map<number, AnalyzedBall>();
    let anyBallMoving = false;

    const activeList: AnalyzedBall[] = [];

    for (const snap of input.balls) {
      if (snap.pocketed && snap.number !== 0) {
        pocketedSet.add(snap.number);
      }
      const vel = input.velocities?.get(snap.number) ?? { vx: 0, vz: 0 };
      if (!snap.pocketed && Math.hypot(vel.vx, vel.vz) > BALL_SPECS.sleepThreshold) {
        anyBallMoving = true;
      }

      const nearCushion =
        Math.abs(snap.x) > D.halfLength - BALL_RADIUS * 2.2 ||
        Math.abs(snap.z) > D.halfWidth - BALL_RADIUS * 2.2;

      const analyzed: AnalyzedBall = {
        number: snap.number,
        x: snap.x,
        z: snap.z,
        vx: vel.vx,
        vz: vel.vz,
        pocketed: snap.pocketed,
        category: getBallCategory(snap.number),
        nearCushion,
        clusterCount: 0,
      };
      ballMap.set(snap.number, analyzed);
      if (!snap.pocketed && snap.number !== 0) {
        activeList.push(analyzed);
      }
    }

    // Detect clusters (balls within 3.1 ball diameters of each other)
    const clusterDistSq = (BALL_DIAMETER * 3.1) ** 2;
    for (let i = 0; i < activeList.length; i++) {
      for (let j = i + 1; j < activeList.length; j++) {
        const dx = activeList[i].x - activeList[j].x;
        const dz = activeList[i].z - activeList[j].z;
        if (dx * dx + dz * dz < clusterDistSq) {
          activeList[i].clusterCount++;
          activeList[j].clusterCount++;
        }
      }
    }

    const opponentPlayer = getOpponent(input.aiPlayer);
    const legalTargets = getLegalTargetBalls(pocketedSet, input.tableOpen, input.aiGroup);
    const opponentLegalTargets = getLegalTargetBalls(
      pocketedSet,
      input.tableOpen,
      input.opponentGroup,
    );

    const state: AnalyzedTableState = {
      version: input.version,
      cueBall: ballMap.get(0) ?? null,
      balls: input.balls.map((b) => ({ ...b })),
      ballMap,
      pockets,
      cushionBounds,
      pocketedSet,
      aiPlayer: input.aiPlayer,
      opponentPlayer,
      aiGroup: input.aiGroup,
      opponentGroup: input.opponentGroup,
      tableOpen: input.tableOpen,
      isBreakShot: input.isBreakShot,
      canAiShootEight: canTargetEightBall(pocketedSet, input.aiGroup),
      canOpponentShootEight: canTargetEightBall(pocketedSet, input.opponentGroup),
      legalTargets,
      opponentLegalTargets,
      ballInHandZone: input.ballInHandZone,
      ruleProfile: input.ruleProfile,
      anyBallMoving,
    };

    this.lastVersion = input.version;
    this.cachedState = state;
    return state;
  }
}

export function isSegmentClear(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  balls: BallSettledSnapshot[],
  ignoreA: number,
  ignoreB: number,
  clearanceScale = 0.99,
): boolean {
  const abx = bx - ax;
  const abz = bz - az;
  const abLenSq = abx * abx + abz * abz;
  if (abLenSq < 1e-8) return true;

  const clearanceSq = (BALL_DIAMETER * clearanceScale) ** 2;
  for (const ball of balls) {
    if (ball.pocketed || ball.number === ignoreA || ball.number === ignoreB) continue;
    const apx = ball.x - ax;
    const apz = ball.z - az;
    const t = Math.max(0, Math.min(1, (apx * abx + apz * abz) / abLenSq));
    if (t <= 0.025 || t >= 0.975) continue;

    const cx = ax + abx * t;
    const cz = az + abz * t;
    const dx = ball.x - cx;
    const dz = ball.z - cz;
    if (dx * dx + dz * dz < clearanceSq) {
      return false;
    }
  }
  return true;
}
