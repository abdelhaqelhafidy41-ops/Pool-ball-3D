import * as THREE from 'three';
import type { CueSpin } from '../../store/useGameStore';
import type { OnlineBallFrame } from '../../multiplayer/shared/protocol';
import type {
  AiDifficulty,
  BallGroup,
  CalledShot,
  GameMode,
  PlayerId,
  PocketId,
  RuleProfileId,
} from '../rules/types';
import { BALL_SPECS, POCKET_POSITIONS, TABLE_DIMENSIONS } from '../utils/constants';
import { generateMatchHighlights } from './HighlightGenerator';
import {
  MAX_REPLAY_SHOTS,
  REPLAY_BALL_COUNT,
  REPLAY_FIXED_DT,
  REPLAY_FLOATS_PER_BALL,
  REPLAY_FLOATS_PER_FRAME,
  REPLAY_FORMAT_VERSION,
  summarizeRecordedShot,
  type BallTrajectoryPath,
  type MatchReplayRecord,
  type RecordedShot,
  type ReplayShotSummary,
  type ReplayTimelineEvent,
  type ShotCollisionEvent,
  type ShotCollisionKind,
  type ShotPocketRecord,
} from './types';

const MAX_FRAMES_PER_SHOT = 1500; // 25 seconds @ 60Hz hard memory cap
const INITIAL_CAPACITY_FRAMES = 360;

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qOut = new THREE.Quaternion();

interface ActiveRecordingMeta {
  id: string;
  shotNumber: number;
  mode: 'local' | 'ai' | 'online';
  shooter: PlayerId;
  shooterName: string;
  isBreakShot: boolean;
  cueAngle: number;
  power: number;
  spin: CueSpin;
  calledShot: CalledShot;
  startedAtMs: number;
}

export interface MatchRecordingContextMeta {
  matchId: string;
  replayId?: string;
  createdAtMs: number;
  matchType: 'ai' | 'local' | 'online';
  onlineSubType?: 'quick' | 'ranked' | 'private' | 'tournament';
  aiDifficulty?: AiDifficulty;
  gameMode: GameMode;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  authoritative: boolean;
  player1Id?: string | null;
  player1Name: string;
  player2Id?: string | null;
  player2Name: string;
}

interface OnlineRawSample {
  timeSec: number;
  balls: OnlineBallFrame[];
}

export class ShotRecorder {
  private shots: RecordedShot[] = [];
  private activeMeta: ActiveRecordingMeta | null = null;
  private buffer: Float32Array = new Float32Array(
    INITIAL_CAPACITY_FRAMES * REPLAY_FLOATS_PER_FRAME,
  );
  private frameCount = 0;
  private collisions: ShotCollisionEvent[] = [];
  private pocketedBalls: ShotPocketRecord[] = [];
  private lastCollisionKeyAt = new Map<string, number>();

  // Match-level chronological timeline state
  private matchMeta: MatchRecordingContextMeta | null = null;
  private cumulativeMatchTimeSec = 0;
  private timelineEvents: ReplayTimelineEvent[] = [];
  private eventSeq = 0;
  private savedMatchIds = new Set<string>();

  // Online-only raw capture buffer (resampled to fixed 60Hz on finalize)
  private onlineRawSamples: OnlineRawSample[] = [];
  private onlinePrevVelocities = new Map<number, { vx: number; vz: number }>();

  public isRecording(): boolean {
    return this.activeMeta !== null;
  }

  public getActiveMode(): 'local' | 'ai' | 'online' | null {
    return this.activeMeta?.mode ?? null;
  }

  public beginMatch(meta: MatchRecordingContextMeta): void {
    this.clearMatchShots();
    this.matchMeta = { ...meta };
    this.cumulativeMatchTimeSec = 0;
    this.timelineEvents = [
      {
        id: `evt_start_${this.eventSeq++}`,
        kind: 'match_start',
        matchTimeSec: 0,
        shotNumber: 0,
        player: null,
        label: `${meta.player1Name} vs ${meta.player2Name} — Match Start`,
      },
    ];
  }

  public updateMatchMeta(partial: Partial<MatchRecordingContextMeta>): void {
    if (!this.matchMeta) return;
    this.matchMeta = { ...this.matchMeta, ...partial };
  }

  public getMatchMeta(): MatchRecordingContextMeta | null {
    return this.matchMeta ? { ...this.matchMeta } : null;
  }

  public getTimelineEvents(): ReplayTimelineEvent[] {
    return [...this.timelineEvents];
  }

  public hasMatchBeenSaved(matchId: string): boolean {
    return this.savedMatchIds.has(matchId);
  }

  public markMatchSaved(matchId: string): void {
    this.savedMatchIds.add(matchId);
  }

  public recordTurnChange(player: PlayerId, playerName: string): void {
    if (!this.matchMeta) return;
    this.timelineEvents.push({
      id: `evt_turn_${this.eventSeq++}`,
      kind: 'turn_change',
      matchTimeSec: Number(this.cumulativeMatchTimeSec.toFixed(3)),
      shotNumber: this.shots.length,
      player,
      playerName,
      label: `Turn: ${playerName}`,
    });
  }

  public recordBallInHand(player: PlayerId, playerName: string, reason?: string | null): void {
    if (!this.matchMeta) return;
    this.timelineEvents.push({
      id: `evt_bih_${this.eventSeq++}`,
      kind: 'ball_in_hand',
      matchTimeSec: Number(this.cumulativeMatchTimeSec.toFixed(3)),
      shotNumber: this.shots.length,
      player,
      playerName,
      label: `${playerName} gets Ball in Hand${reason ? ` (${reason})` : ''}`,
    });
  }

  public clearMatchShots(): void {
    this.cancelActiveRecording();
    this.shots = [];
    this.matchMeta = null;
    this.cumulativeMatchTimeSec = 0;
    this.timelineEvents = [];
    this.eventSeq = 0;
  }

  public cancelActiveRecording(): void {
    this.activeMeta = null;
    this.frameCount = 0;
    this.collisions = [];
    this.pocketedBalls = [];
    this.lastCollisionKeyAt.clear();
    this.onlineRawSamples = [];
    this.onlinePrevVelocities.clear();
  }

  public beginShot(params: {
    shotNumber: number;
    mode: 'local' | 'ai' | 'online';
    shooter: PlayerId;
    shooterName: string;
    isBreakShot: boolean;
    cueAngle: number;
    power: number;
    spin: CueSpin;
    calledShot: CalledShot;
  }): void {
    this.cancelActiveRecording();
    if (!this.matchMeta) {
      this.beginMatch({
        matchId: `match_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAtMs: Date.now(),
        matchType: params.mode,
        gameMode: 'eightBall',
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
        authoritative: params.mode === 'online',
        player1Name: params.shooter === 'player1' ? params.shooterName : 'Player 1',
        player2Name: params.shooter === 'player2' ? params.shooterName : 'Player 2',
      });
    }
    this.activeMeta = {
      id: `shot_${params.shotNumber}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      shotNumber: params.shotNumber,
      mode: params.mode,
      shooter: params.shooter,
      shooterName: params.shooterName,
      isBreakShot: params.isBreakShot,
      cueAngle: params.cueAngle,
      power: params.power,
      spin: { ...params.spin },
      calledShot: { ...params.calledShot },
      startedAtMs: performance.now(),
    };
  }

  private ensureFrameCapacity(neededFrames: number): void {
    const neededFloats = neededFrames * REPLAY_FLOATS_PER_FRAME;
    if (this.buffer.length >= neededFloats) return;
    const currentFrames = Math.floor(this.buffer.length / REPLAY_FLOATS_PER_FRAME);
    const nextFrames = Math.min(
      MAX_FRAMES_PER_SHOT,
      Math.max(neededFrames, currentFrames * 2),
    );
    const next = new Float32Array(nextFrames * REPLAY_FLOATS_PER_FRAME);
    next.set(this.buffer.subarray(0, this.frameCount * REPLAY_FLOATS_PER_FRAME));
    this.buffer = next;
  }

  /**
   * Zero-allocation per-ball write into the current frame slot.
   * Call once per ball 0..15, then call commitFrame().
   */
  public writeBallSample(
    ballNumber: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    vx: number,
    vy: number,
    vz: number,
    pocketed: boolean,
  ): void {
    if (!this.activeMeta || this.frameCount >= MAX_FRAMES_PER_SHOT) return;
    if (ballNumber < 0 || ballNumber >= REPLAY_BALL_COUNT) return;
    this.ensureFrameCapacity(this.frameCount + 1);

    const base =
      this.frameCount * REPLAY_FLOATS_PER_FRAME + ballNumber * REPLAY_FLOATS_PER_BALL;
    this.buffer[base + 0] = x;
    this.buffer[base + 1] = y;
    this.buffer[base + 2] = z;
    this.buffer[base + 3] = qx;
    this.buffer[base + 4] = qy;
    this.buffer[base + 5] = qz;
    this.buffer[base + 6] = qw;
    this.buffer[base + 7] = vx;
    this.buffer[base + 8] = vy;
    this.buffer[base + 9] = vz;
    this.buffer[base + 10] = pocketed ? 1 : 0;
  }

  public commitFrame(): void {
    if (!this.activeMeta || this.frameCount >= MAX_FRAMES_PER_SHOT) return;
    this.frameCount++;
  }

  public recordCollision(params: {
    kind: ShotCollisionKind;
    ballA: number;
    ballB: number | null;
    x: number;
    z: number;
    impactSpeed: number;
    timeSec?: number;
  }): void {
    if (!this.activeMeta) return;
    if (params.impactSpeed < 0.08) return;

    const timeSec =
      params.timeSec !== undefined
        ? Math.max(0, params.timeSec)
        : this.frameCount * REPLAY_FIXED_DT;

    const pairKey =
      params.ballB !== null
        ? `${params.kind}:${Math.min(params.ballA, params.ballB)}-${Math.max(params.ballA, params.ballB)}`
        : `${params.kind}:${params.ballA}`;

    const prevTime = this.lastCollisionKeyAt.get(pairKey);
    if (prevTime !== undefined && Math.abs(timeSec - prevTime) < 0.045) {
      return;
    }
    this.lastCollisionKeyAt.set(pairKey, timeSec);

    if (this.collisions.length >= 96) return;
    this.collisions.push({
      id: `col_${this.collisions.length}_${Math.round(timeSec * 1000)}`,
      kind: params.kind,
      timeSec,
      ballA: params.ballA,
      ballB: params.ballB,
      x: params.x,
      z: params.z,
      impactSpeed: params.impactSpeed,
    });
  }

  public recordPocket(ballNumber: number, pocketId: PocketId, x?: number, z?: number): void {
    if (!this.activeMeta) return;
    if (this.pocketedBalls.some((p) => p.ballNumber === ballNumber)) return;

    const pPos = POCKET_POSITIONS.find((p) => p.id === pocketId);
    const timeSec =
      this.activeMeta.mode === 'online'
        ? Math.max(0, (performance.now() - this.activeMeta.startedAtMs) / 1000)
        : this.frameCount * REPLAY_FIXED_DT;

    this.pocketedBalls.push({
      ballNumber,
      pocketId,
      timeSec,
      x: x ?? pPos?.x ?? 0,
      z: z ?? pPos?.z ?? 0,
    });
  }

  /**
   * Captures incoming authoritative server frames during an online shot without mutating live physics.
   */
  public pushOnlineSample(balls: OnlineBallFrame[]): void {
    if (!this.activeMeta || this.activeMeta.mode !== 'online') return;
    if (this.onlineRawSamples.length >= 600) return;

    const timeSec = Math.max(0, (performance.now() - this.activeMeta.startedAtMs) / 1000);
    const cloned = balls.map((b) => ({ ...b }));
    this.onlineRawSamples.push({ timeSec, balls: cloned });

    // Infer collisions from sharp velocity changes for online shot analysis
    const D = TABLE_DIMENSIONS;
    const R = BALL_SPECS.radius;
    for (const b of cloned) {
      if (b.pocketed) continue;
      const prev = this.onlinePrevVelocities.get(b.number);
      this.onlinePrevVelocities.set(b.number, { vx: b.vx, vz: b.vz });
      if (!prev) continue;

      const dvx = b.vx - prev.vx;
      const dvz = b.vz - prev.vz;
      const dv = Math.hypot(dvx, dvz);
      if (dv < 0.45) continue;

      let partner: OnlineBallFrame | null = null;
      let bestDist = R * 2.85;
      for (const other of cloned) {
        if (other.number === b.number || other.pocketed) continue;
        const d = Math.hypot(other.x - b.x, other.z - b.z);
        if (d < bestDist) {
          bestDist = d;
          partner = other;
        }
      }

      if (partner) {
        const kind: ShotCollisionKind =
          b.number === 0 || partner.number === 0 ? 'cue_ball' : 'ball_ball';
        this.recordCollision({
          kind,
          ballA: Math.min(b.number, partner.number),
          ballB: Math.max(b.number, partner.number),
          x: (b.x + partner.x) * 0.5,
          z: (b.z + partner.z) * 0.5,
          impactSpeed: dv,
          timeSec,
        });
      } else if (
        Math.abs(b.x) > D.halfLength - R * 2.2 ||
        Math.abs(b.z) > D.halfWidth - R * 2.2
      ) {
        this.recordCollision({
          kind: 'cushion',
          ballA: b.number,
          ballB: null,
          x: b.x,
          z: b.z,
          impactSpeed: dv,
          timeSec,
        });
      }
    }
  }

  public finalizeShot(outcome: {
    resultLabel: string;
    isFoul: boolean;
    foulReason: string | null;
    finalOnlineBalls?: OnlineBallFrame[];
    tableOpenAfter?: boolean;
    playerGroupsAfter?: Record<PlayerId, BallGroup>;
    pocketedNumbersAfter?: number[];
    activePlayerAfter?: PlayerId;
    ballInHandNext?: boolean;
  }): RecordedShot | null {
    const meta = this.activeMeta;
    if (!meta) return null;

    if (meta.mode === 'online') {
      if (outcome.finalOnlineBalls && outcome.finalOnlineBalls.length > 0) {
        this.pushOnlineSample(outcome.finalOnlineBalls);
      }
      this.resampleOnlineSamplesToFixedGrid();
    }

    if (this.frameCount < 2) {
      this.cancelActiveRecording();
      return null;
    }

    const packedCopy = new Float32Array(
      this.buffer.subarray(0, this.frameCount * REPLAY_FLOATS_PER_FRAME),
    );
    const durationSec = Math.max(
      REPLAY_FIXED_DT,
      (this.frameCount - 1) * REPLAY_FIXED_DT,
    );

    this.collisions.sort((a, b) => a.timeSec - b.timeSec);
    this.pocketedBalls.sort((a, b) => a.timeSec - b.timeSec);

    const firstCueHit = this.collisions.find((c) => c.kind === 'cue_ball');
    const firstBallHit = this.collisions.find(
      (c) => c.kind === 'cue_ball' || c.kind === 'ball_ball',
    );
    const firstImpactTimeSec =
      firstCueHit?.timeSec ?? firstBallHit?.timeSec ?? null;

    const trajectories = this.extractTrajectories(packedCopy, this.frameCount);
    const startMatchTimeSec = this.cumulativeMatchTimeSec;
    const endMatchTimeSec = startMatchTimeSec + durationSec;

    const recorded: RecordedShot = {
      id: meta.id,
      shotNumber: meta.shotNumber,
      recordedAtMs: Date.now(),
      mode: meta.mode,
      shooter: meta.shooter,
      shooterName: meta.shooterName,
      isBreakShot: meta.isBreakShot,
      cueAngle: meta.cueAngle,
      power: meta.power,
      spin: { ...meta.spin },
      calledShot: { ...meta.calledShot },
      durationSec,
      timestepSec: REPLAY_FIXED_DT,
      frameCount: this.frameCount,
      framesData: packedCopy,
      collisions: [...this.collisions],
      pocketedBalls: [...this.pocketedBalls],
      trajectories,
      firstImpactTimeSec,
      resultLabel: outcome.resultLabel,
      isFoul: outcome.isFoul,
      foulReason: outcome.foulReason,
      startMatchTimeSec,
      endMatchTimeSec,
      tableOpenAfter: outcome.tableOpenAfter,
      playerGroupsAfter: outcome.playerGroupsAfter ? { ...outcome.playerGroupsAfter } : undefined,
      pocketedNumbersAfter: outcome.pocketedNumbersAfter
        ? [...outcome.pocketedNumbersAfter]
        : undefined,
      activePlayerAfter: outcome.activePlayerAfter,
      ballInHandNext: outcome.ballInHandNext,
    };

    // Append chronological match timeline events for this shot
    this.timelineEvents.push({
      id: `evt_strike_${this.eventSeq++}`,
      kind: meta.isBreakShot ? 'break' : 'cue_strike',
      matchTimeSec: Number(startMatchTimeSec.toFixed(3)),
      shotNumber: meta.shotNumber,
      shotId: recorded.id,
      player: meta.shooter,
      playerName: meta.shooterName,
      label: meta.isBreakShot
        ? `${meta.shooterName} executes Break Shot`
        : `${meta.shooterName} strikes Cue Ball`,
    });

    if (recorded.collisions.length > 0) {
      const firstCol = recorded.collisions[0];
      this.timelineEvents.push({
        id: `evt_col_${this.eventSeq++}`,
        kind: firstCol.kind === 'cushion' ? 'rail' : 'collision',
        matchTimeSec: Number((startMatchTimeSec + firstCol.timeSec).toFixed(3)),
        shotNumber: meta.shotNumber,
        shotId: recorded.id,
        player: meta.shooter,
        playerName: meta.shooterName,
        ballNumber: firstCol.ballB ?? firstCol.ballA,
        label:
          firstCol.kind === 'cushion'
            ? `Rail cushion impact (#${firstCol.ballA})`
            : `First contact (${firstCol.ballA === 0 ? 'Cue' : `#${firstCol.ballA}`} -> #${firstCol.ballB ?? firstCol.ballA})`,
      });
    }

    for (const pkt of recorded.pocketedBalls) {
      this.timelineEvents.push({
        id: `evt_pkt_${this.eventSeq++}`,
        kind: pkt.ballNumber === 8 ? 'eight_ball_pocketed' : 'pocket',
        matchTimeSec: Number((startMatchTimeSec + pkt.timeSec).toFixed(3)),
        shotNumber: meta.shotNumber,
        shotId: recorded.id,
        player: meta.shooter,
        playerName: meta.shooterName,
        ballNumber: pkt.ballNumber,
        pocketId: pkt.pocketId,
        label:
          pkt.ballNumber === 0
            ? `${meta.shooterName} scratched Cue Ball`
            : pkt.ballNumber === 8
              ? `8-Ball pocketed into ${pkt.pocketId.toUpperCase()}`
              : `#${pkt.ballNumber} pocketed (${pkt.pocketId.toUpperCase()})`,
      });
    }

    if (recorded.isFoul) {
      this.timelineEvents.push({
        id: `evt_foul_${this.eventSeq++}`,
        kind: 'foul',
        matchTimeSec: Number(endMatchTimeSec.toFixed(3)),
        shotNumber: meta.shotNumber,
        shotId: recorded.id,
        player: meta.shooter,
        playerName: meta.shooterName,
        label: recorded.foulReason ?? 'Foul committed',
      });
    }

    this.cumulativeMatchTimeSec = endMatchTimeSec;
    this.shots.push(recorded);
    if (this.shots.length > MAX_REPLAY_SHOTS) {
      this.shots.splice(0, this.shots.length - MAX_REPLAY_SHOTS);
    }

    this.cancelActiveRecording();
    return recorded;
  }

  public buildMatchReplayRecord(params: {
    winner: PlayerId | null;
    loser: PlayerId | null;
    finalResult: string;
    playerGroups: Record<PlayerId, BallGroup>;
    pocketedNumbers: number[];
    player1Name?: string;
    player2Name?: string;
    player1Id?: string | null;
    player2Id?: string | null;
    matchId?: string;
    authoritative?: boolean;
    localPlayerPerspective?: PlayerId | null;
  }): MatchReplayRecord | null {
    if (this.shots.length === 0) return null;

    const meta = this.matchMeta ?? {
      matchId: params.matchId ?? `match_${Date.now()}`,
      createdAtMs: this.shots[0].recordedAtMs,
      matchType: this.shots[0].mode,
      gameMode: 'eightBall' as GameMode,
      ruleProfileId: 'casual' as RuleProfileId,
      calledShotsEnabled: false,
      authoritative: Boolean(params.authoritative),
      player1Name: params.player1Name ?? 'Player 1',
      player2Name: params.player2Name ?? 'Player 2',
    };

    const p1Name = (params.player1Name ?? meta.player1Name).trim() || 'Player 1';
    const p2Name = (params.player2Name ?? meta.player2Name).trim() || 'Player 2';

    // Ensure contiguous match-relative times across all retained shots
    let cursor = 0;
    const timelineShots = this.shots.map((s) => {
      const start = s.startMatchTimeSec ?? cursor;
      const end = start + s.durationSec;
      cursor = end;
      return {
        ...s,
        startMatchTimeSec: start,
        endMatchTimeSec: end,
      };
    });

    const totalDurationSec = Math.max(REPLAY_FIXED_DT, cursor);
    const events = [...this.timelineEvents];

    if (params.winner) {
      const winnerName = params.winner === 'player1' ? p1Name : p2Name;
      const isDefeat =
        params.localPlayerPerspective != null &&
        params.winner !== params.localPlayerPerspective;
      events.push({
        id: `evt_end_${this.eventSeq++}`,
        kind: isDefeat ? 'defeat' : 'victory',
        matchTimeSec: Number(totalDurationSec.toFixed(3)),
        shotNumber: timelineShots[timelineShots.length - 1]?.shotNumber ?? timelineShots.length,
        shotId: timelineShots[timelineShots.length - 1]?.id,
        player: params.winner,
        playerName: winnerName,
        label: `${winnerName} Wins — ${params.finalResult}`,
      });
    }

    const p1Count = timelineShots
      .filter((s) => s.shooter === 'player1' && !s.isFoul)
      .reduce((acc, s) => acc + s.pocketedBalls.filter((p) => p.ballNumber !== 0).length, 0);
    const p2Count = timelineShots
      .filter((s) => s.shooter === 'player2' && !s.isFoul)
      .reduce((acc, s) => acc + s.pocketedBalls.filter((p) => p.ballNumber !== 0).length, 0);

    const effectiveMatchId = params.matchId ?? meta.matchId;
    const replayId = meta.replayId ?? `replay_${effectiveMatchId}`;

    const record: MatchReplayRecord = {
      version: REPLAY_FORMAT_VERSION,
      replayId,
      matchId: effectiveMatchId,
      createdAtMs: meta.createdAtMs,
      endedAtMs: Date.now(),
      durationSec: Number(totalDurationSec.toFixed(3)),
      matchType: meta.matchType,
      onlineSubType: meta.onlineSubType,
      aiDifficulty: meta.aiDifficulty,
      gameMode: meta.gameMode,
      ruleProfileId: meta.ruleProfileId,
      calledShotsEnabled: meta.calledShotsEnabled,
      authoritative: params.authoritative ?? meta.authoritative,
      player1: {
        id: params.player1Id ?? meta.player1Id ?? null,
        name: p1Name,
        group: params.playerGroups.player1,
        pocketedCount: p1Count,
      },
      player2: {
        id: params.player2Id ?? meta.player2Id ?? null,
        name: p2Name,
        group: params.playerGroups.player2,
        pocketedCount: p2Count,
      },
      winner: params.winner,
      loser: params.loser,
      finalResult: params.finalResult,
      totalShots: timelineShots.length,
      shots: timelineShots,
      timelineEvents: events,
      highlights: [],
    };

    record.highlights = generateMatchHighlights(record);
    return record;
  }

  private resampleOnlineSamplesToFixedGrid(): void {
    const raw = this.onlineRawSamples;
    this.frameCount = 0;
    if (raw.length < 2) return;

    const totalSec = Math.min(24, Math.max(REPLAY_FIXED_DT, raw[raw.length - 1].timeSec));
    const targetFrames = Math.min(
      MAX_FRAMES_PER_SHOT,
      Math.max(2, Math.round(totalSec / REPLAY_FIXED_DT) + 1),
    );

    const byBallA = new Map<number, OnlineBallFrame>();
    const byBallB = new Map<number, OnlineBallFrame>();
    let segIdx = 0;

    for (let f = 0; f < targetFrames; f++) {
      const t = Math.min(totalSec, f * REPLAY_FIXED_DT);
      while (segIdx < raw.length - 2 && raw[segIdx + 1].timeSec < t) {
        segIdx++;
      }
      const sa = raw[segIdx];
      const sb = raw[Math.min(raw.length - 1, segIdx + 1)];
      const span = Math.max(0.0001, sb.timeSec - sa.timeSec);
      const alpha = sb === sa ? 0 : Math.max(0, Math.min(1, (t - sa.timeSec) / span));

      byBallA.clear();
      byBallB.clear();
      for (const b of sa.balls) byBallA.set(b.number, b);
      for (const b of sb.balls) byBallB.set(b.number, b);

      for (let num = 0; num < REPLAY_BALL_COUNT; num++) {
        const ba = byBallA.get(num);
        const bb = byBallB.get(num) ?? ba;
        if (!ba || !bb) continue;

        _qa.set(ba.qx, ba.qy, ba.qz, ba.qw);
        _qb.set(bb.qx, bb.qy, bb.qz, bb.qw);
        _qOut.slerpQuaternions(_qa, _qb, alpha);

        const pocketed = alpha >= 0.99 ? bb.pocketed : ba.pocketed;
        this.writeBallSample(
          num,
          ba.x + (bb.x - ba.x) * alpha,
          ba.y + (bb.y - ba.y) * alpha,
          ba.z + (bb.z - ba.z) * alpha,
          _qOut.x,
          _qOut.y,
          _qOut.z,
          _qOut.w,
          ba.vx + (bb.vx - ba.vx) * alpha,
          ba.vy + (bb.vy - ba.vy) * alpha,
          ba.vz + (bb.vz - ba.vz) * alpha,
          pocketed,
        );
      }
      this.commitFrame();
    }
  }

  private extractTrajectories(
    data: Float32Array,
    frames: number,
  ): BallTrajectoryPath[] {
    const result: BallTrajectoryPath[] = [];

    for (let ballNum = 0; ballNum < REPLAY_BALL_COUNT; ballNum++) {
      const base0 = ballNum * REPLAY_FLOATS_PER_BALL;
      const startPocketed = data[base0 + 10] > 0.5;
      if (startPocketed) continue;

      let lastX = data[base0 + 0];
      let lastZ = data[base0 + 2];
      let totalDist = 0;
      const points = [{ x: lastX, z: lastZ, timeSec: 0 }];

      for (let f = 1; f < frames; f++) {
        const idx = f * REPLAY_FLOATS_PER_FRAME + ballNum * REPLAY_FLOATS_PER_BALL;
        const x = data[idx + 0];
        const z = data[idx + 2];
        const pocketed = data[idx + 10] > 0.5;
        const stepDist = Math.hypot(x - lastX, z - lastZ);

        if (stepDist >= 0.016 || (f === frames - 1 && stepDist > 0.004) || pocketed) {
          totalDist += stepDist;
          points.push({ x, z, timeSec: f * REPLAY_FIXED_DT });
          lastX = x;
          lastZ = z;
        }
        if (pocketed) break;
      }

      if (ballNum === 0 || totalDist > 0.018) {
        result.push({
          ballNumber: ballNum,
          points,
          totalDistance: totalDist,
        });
      }
    }

    return result;
  }

  public getShots(): RecordedShot[] {
    return this.shots;
  }

  public getShotById(shotId: string | null): RecordedShot | null {
    if (this.shots.length === 0) return null;
    if (!shotId) return this.shots[this.shots.length - 1];
    return this.shots.find((s) => s.id === shotId) ?? null;
  }

  public getLatestShot(): RecordedShot | null {
    return this.shots.length > 0 ? this.shots[this.shots.length - 1] : null;
  }

  public getSummariesNewestFirst(): ReplayShotSummary[] {
    const out: ReplayShotSummary[] = [];
    for (let i = this.shots.length - 1; i >= 0; i--) {
      out.push(summarizeRecordedShot(this.shots[i]));
    }
    return out;
  }
}
