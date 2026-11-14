import type { CalledShot, PlayerId, PocketId } from '../rules/types';
import type { CueSpin } from '../../store/useGameStore';

export type ReplaySpeed = 0.25 | 0.5 | 1 | 2;

export const REPLAY_FIXED_DT = 1 / 60;
export const MAX_REPLAY_SHOTS = 10;
export const REPLAY_BALL_COUNT = 16;
/** Floats stored per ball per frame: x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed */
export const REPLAY_FLOATS_PER_BALL = 11;
export const REPLAY_FLOATS_PER_FRAME = REPLAY_BALL_COUNT * REPLAY_FLOATS_PER_BALL;

export interface ReplayBallFrame {
  number: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  pocketed: boolean;
}

export type ShotCollisionKind = 'cue_ball' | 'ball_ball' | 'cushion';

export interface ShotCollisionEvent {
  id: string;
  kind: ShotCollisionKind;
  timeSec: number;
  ballA: number;
  ballB: number | null;
  x: number;
  z: number;
  impactSpeed: number;
}

export interface ShotPocketRecord {
  ballNumber: number;
  pocketId: PocketId;
  timeSec: number;
  x: number;
  z: number;
}

export interface BallTrajectoryPoint {
  x: number;
  z: number;
  timeSec: number;
}

export interface BallTrajectoryPath {
  ballNumber: number;
  points: BallTrajectoryPoint[];
  totalDistance: number;
}

export interface RecordedShot {
  id: string;
  shotNumber: number;
  recordedAtMs: number;
  mode: 'local' | 'ai' | 'online';
  shooter: PlayerId;
  shooterName: string;
  isBreakShot: boolean;
  cueAngle: number;
  power: number;
  spin: CueSpin;
  calledShot: CalledShot;
  durationSec: number;
  timestepSec: number;
  frameCount: number;
  /** Packed fixed-timestep frames: frameIndex * REPLAY_FLOATS_PER_FRAME + ballNumber * REPLAY_FLOATS_PER_BALL */
  framesData: Float32Array;
  collisions: ShotCollisionEvent[];
  pocketedBalls: ShotPocketRecord[];
  trajectories: BallTrajectoryPath[];
  firstImpactTimeSec: number | null;
  resultLabel: string;
  isFoul: boolean;
  foulReason: string | null;
}

/** Lightweight metadata stored in Zustand for UI display without copying Float32Array buffers */
export interface ReplayShotSummary {
  id: string;
  shotNumber: number;
  shooter: PlayerId;
  shooterName: string;
  isBreakShot: boolean;
  spin: CueSpin;
  power: number;
  durationSec: number;
  resultLabel: string;
  isFoul: boolean;
  foulReason: string | null;
  firstImpactTimeSec: number | null;
  collisions: ShotCollisionEvent[];
  pocketedBalls: ShotPocketRecord[];
  trajectoriesCount: number;
}

export function summarizeRecordedShot(shot: RecordedShot): ReplayShotSummary {
  return {
    id: shot.id,
    shotNumber: shot.shotNumber,
    shooter: shot.shooter,
    shooterName: shot.shooterName,
    isBreakShot: shot.isBreakShot,
    spin: { ...shot.spin },
    power: shot.power,
    durationSec: shot.durationSec,
    resultLabel: shot.resultLabel,
    isFoul: shot.isFoul,
    foulReason: shot.foulReason,
    firstImpactTimeSec: shot.firstImpactTimeSec,
    collisions: shot.collisions,
    pocketedBalls: shot.pocketedBalls,
    trajectoriesCount: shot.trajectories.length,
  };
}
