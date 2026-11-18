import type {
  AiDifficulty,
  BallGroup,
  CalledShot,
  GameMode,
  PlayerId,
  PocketId,
  RuleProfileId,
} from '../rules/types';
import type { CueSpin } from '../../store/useGameStore';

export type ReplaySpeed = 0.25 | 0.5 | 1 | 2 | 4;
export type ReplayMode = 'shot' | 'match';
export type ReplayCameraMode =
  | 'original'
  | 'topDown'
  | 'free'
  | 'cinematic'
  | 'ballFollow'
  | 'shotFocused';

export const REPLAY_FORMAT_VERSION = 1;
export const REPLAY_FIXED_DT = 1 / 60;
export const MAX_REPLAY_SHOTS = 160;
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
  /** Match-relative timeline offsets & state snapshot (populated for full-match replays) */
  startMatchTimeSec?: number;
  endMatchTimeSec?: number;
  tableOpenAfter?: boolean;
  playerGroupsAfter?: Record<PlayerId, BallGroup>;
  pocketedNumbersAfter?: number[];
  activePlayerAfter?: PlayerId;
  ballInHandNext?: boolean;
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
  startMatchTimeSec: number;
  endMatchTimeSec: number;
  resultLabel: string;
  isFoul: boolean;
  foulReason: string | null;
  firstImpactTimeSec: number | null;
  collisions: ShotCollisionEvent[];
  pocketedBalls: ShotPocketRecord[];
  trajectoriesCount: number;
}

export type ReplayTimelineEventKind =
  | 'match_start'
  | 'break'
  | 'cue_strike'
  | 'collision'
  | 'rail'
  | 'pocket'
  | 'foul'
  | 'turn_change'
  | 'ball_in_hand'
  | 'eight_ball_pocketed'
  | 'victory'
  | 'defeat';

export interface ReplayTimelineEvent {
  id: string;
  kind: ReplayTimelineEventKind;
  matchTimeSec: number;
  shotNumber: number;
  shotId?: string;
  player: PlayerId | null;
  playerName?: string;
  ballNumber?: number;
  pocketId?: PocketId;
  label: string;
}

export type ReplayHighlightCategory =
  | 'break'
  | 'long_pocket'
  | 'multi_pocket'
  | 'bank_or_combo'
  | 'defensive'
  | 'foul'
  | 'eight_ball'
  | 'winning_moment';

export interface ReplayHighlight {
  id: string;
  category: ReplayHighlightCategory;
  title: string;
  description: string;
  matchTimeSec: number;
  shotNumber: number;
  shotId: string;
  shooter: PlayerId;
  shooterName: string;
  importanceScore: number;
}

export interface ReplayPlayerInfo {
  id?: string | null;
  name: string;
  group: BallGroup;
  pocketedCount: number;
}

export interface MatchReplayRecord {
  version: number;
  replayId: string;
  matchId: string;
  createdAtMs: number;
  endedAtMs: number;
  durationSec: number;
  matchType: 'ai' | 'local' | 'online';
  onlineSubType?: 'quick' | 'ranked' | 'private' | 'tournament';
  aiDifficulty?: AiDifficulty;
  gameMode: GameMode;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  authoritative: boolean;
  player1: ReplayPlayerInfo;
  player2: ReplayPlayerInfo;
  winner: PlayerId | null;
  loser: PlayerId | null;
  finalResult: string;
  totalShots: number;
  shots: RecordedShot[];
  timelineEvents: ReplayTimelineEvent[];
  highlights: ReplayHighlight[];
  savedAtMs?: number;
}

export interface SavedReplaySummary {
  replayId: string;
  matchId: string;
  createdAtMs: number;
  endedAtMs: number;
  savedAtMs: number;
  durationSec: number;
  matchType: 'ai' | 'local' | 'online';
  onlineSubType?: 'quick' | 'ranked' | 'private' | 'tournament';
  aiDifficulty?: AiDifficulty;
  gameMode: GameMode;
  ruleProfileId: RuleProfileId;
  authoritative: boolean;
  player1Name: string;
  player2Name: string;
  winner: PlayerId | null;
  finalResult: string;
  totalShots: number;
  highlightCount: number;
  byteSize: number;
}

export interface ReplayStorageStats {
  count: number;
  maxCount: number;
  totalBytes: number;
  maxBytes: number;
  backend: 'indexeddb' | 'memory';
}

export function summarizeRecordedShot(shot: RecordedShot): ReplayShotSummary {
  const startMatchTimeSec = shot.startMatchTimeSec ?? 0;
  const endMatchTimeSec = shot.endMatchTimeSec ?? startMatchTimeSec + shot.durationSec;
  return {
    id: shot.id,
    shotNumber: shot.shotNumber,
    shooter: shot.shooter,
    shooterName: shot.shooterName,
    isBreakShot: shot.isBreakShot,
    spin: { ...shot.spin },
    power: shot.power,
    durationSec: shot.durationSec,
    startMatchTimeSec,
    endMatchTimeSec,
    resultLabel: shot.resultLabel,
    isFoul: shot.isFoul,
    foulReason: shot.foulReason,
    firstImpactTimeSec: shot.firstImpactTimeSec,
    collisions: shot.collisions,
    pocketedBalls: shot.pocketedBalls,
    trajectoriesCount: shot.trajectories.length,
  };
}

export function summarizeMatchReplay(
  replay: MatchReplayRecord,
  byteSize = 0,
): SavedReplaySummary {
  return {
    replayId: replay.replayId,
    matchId: replay.matchId,
    createdAtMs: replay.createdAtMs,
    endedAtMs: replay.endedAtMs,
    savedAtMs: replay.savedAtMs ?? replay.endedAtMs,
    durationSec: replay.durationSec,
    matchType: replay.matchType,
    onlineSubType: replay.onlineSubType,
    aiDifficulty: replay.aiDifficulty,
    gameMode: replay.gameMode,
    ruleProfileId: replay.ruleProfileId,
    authoritative: replay.authoritative,
    player1Name: replay.player1.name,
    player2Name: replay.player2.name,
    winner: replay.winner,
    finalResult: replay.finalResult,
    totalShots: replay.totalShots,
    highlightCount: replay.highlights.length,
    byteSize,
  };
}
