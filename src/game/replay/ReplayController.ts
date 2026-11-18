import * as THREE from 'three';
import type { BallGroup, PlayerId } from '../rules/types';
import { BALL_DEFINITIONS } from '../utils/constants';
import { soundEngine } from '../utils/SoundEngine';
import {
  REPLAY_BALL_COUNT,
  REPLAY_FLOATS_PER_BALL,
  REPLAY_FLOATS_PER_FRAME,
  type MatchReplayRecord,
  type RecordedShot,
  type ReplayBallFrame,
  type ReplayHighlight,
  type ReplayMode,
  type ReplaySpeed,
  type ShotCollisionEvent,
} from './types';

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qOut = new THREE.Quaternion();

export function formatCollisionLabel(col: ShotCollisionEvent): string {
  const nameA = col.ballA === 0 ? 'Cue Ball' : `#${col.ballA} (${BALL_DEFINITIONS[col.ballA]?.name ?? ''})`;
  if (col.kind === 'cushion') {
    return `${nameA} → Rail Cushion`;
  }
  const nameB =
    col.ballB === 0
      ? 'Cue Ball'
      : col.ballB !== null
        ? `#${col.ballB}`
        : 'Ball';
  return col.kind === 'cue_ball'
    ? `Cue Impact → ${col.ballA === 0 ? nameB : nameA}`
    : `Ball Collision: #${col.ballA} ↔ ${nameB}`;
}

export interface ReplayDynamicMatchState {
  player1Group: BallGroup;
  player2Group: BallGroup;
  pocketedNumbers: number[];
  activePlayer: PlayerId;
  tableOpen: boolean;
}

export class ReplayController {
  private active = false;
  private mode: ReplayMode = 'shot';
  private matchReplay: MatchReplayRecord | null = null;
  private shotIndex = 0;
  private shot: RecordedShot | null = null;
  private liveBackup: ReplayBallFrame[] = [];
  private playing = false;
  private currentTimeSec = 0;
  private speed: ReplaySpeed = 1;
  private autoSlowMo = false;
  private showAnalysis = true;

  public isActive(): boolean {
    return this.active;
  }

  public getMode(): ReplayMode {
    return this.mode;
  }

  public isPlaying(): boolean {
    return this.active && this.playing;
  }

  public getMatchReplay(): MatchReplayRecord | null {
    return this.matchReplay;
  }

  public getShot(): RecordedShot | null {
    return this.shot;
  }

  public getCurrentShotIndex(): number {
    return this.shotIndex;
  }

  public getTotalShots(): number {
    if (this.mode === 'match' && this.matchReplay) {
      return this.matchReplay.shots.length;
    }
    return this.shot ? 1 : 0;
  }

  public getCurrentTimeSec(): number {
    return this.currentTimeSec;
  }

  public getDurationSec(): number {
    return this.shot?.durationSec ?? 0;
  }

  public getMatchTimeSec(): number {
    if (!this.active || !this.shot) return 0;
    if (this.mode !== 'match' || !this.matchReplay) {
      return this.currentTimeSec;
    }
    const base = this.shot.startMatchTimeSec ?? 0;
    return Math.min(this.getMatchDurationSec(), base + this.currentTimeSec);
  }

  public getMatchDurationSec(): number {
    if (this.mode === 'match' && this.matchReplay) {
      return Math.max(0.02, this.matchReplay.durationSec);
    }
    return this.shot?.durationSec ?? 0;
  }

  public getSpeed(): ReplaySpeed {
    return this.speed;
  }

  public getAutoSlowMo(): boolean {
    return this.autoSlowMo;
  }

  public getShowAnalysis(): boolean {
    return this.showAnalysis;
  }

  public enterReplay(shot: RecordedShot, liveBackup: ReplayBallFrame[]): void {
    this.active = true;
    this.mode = 'shot';
    this.matchReplay = null;
    this.shotIndex = 0;
    this.shot = shot;
    this.liveBackup = liveBackup.map((b) => ({ ...b }));
    this.currentTimeSec = 0;
    this.playing = true;
  }

  public enterMatchReplay(
    matchReplay: MatchReplayRecord,
    liveBackup: ReplayBallFrame[],
    initialShotId?: string,
  ): void {
    if (matchReplay.shots.length === 0) return;
    let cursor = 0;
    for (const s of matchReplay.shots) {
      if (s.startMatchTimeSec === undefined) s.startMatchTimeSec = cursor;
      s.endMatchTimeSec = s.startMatchTimeSec + s.durationSec;
      cursor = s.endMatchTimeSec;
    }
    matchReplay.durationSec = Math.max(matchReplay.durationSec, cursor);

    let startIdx = 0;
    if (initialShotId) {
      const found = matchReplay.shots.findIndex((s) => s.id === initialShotId);
      if (found >= 0) startIdx = found;
    }

    this.active = true;
    this.mode = 'match';
    this.matchReplay = matchReplay;
    this.shotIndex = startIdx;
    this.shot = matchReplay.shots[startIdx];
    this.liveBackup = liveBackup.map((b) => ({ ...b }));
    this.currentTimeSec = 0;
    this.playing = true;
  }

  public switchShot(shot: RecordedShot): void {
    if (!this.active) return;
    if (this.mode === 'match' && this.matchReplay) {
      const idx = this.matchReplay.shots.findIndex((s) => s.id === shot.id);
      if (idx >= 0) {
        this.shotIndex = idx;
        this.shot = this.matchReplay.shots[idx];
        this.currentTimeSec = 0;
        this.playing = true;
        return;
      }
    }
    this.shot = shot;
    this.currentTimeSec = 0;
    this.playing = true;
  }

  public nextShot(): boolean {
    if (!this.active || this.mode !== 'match' || !this.matchReplay) return false;
    if (this.shotIndex >= this.matchReplay.shots.length - 1) return false;
    this.shotIndex++;
    this.shot = this.matchReplay.shots[this.shotIndex];
    this.currentTimeSec = 0;
    return true;
  }

  public prevShot(): boolean {
    if (!this.active || this.mode !== 'match' || !this.matchReplay) return false;
    if (this.shotIndex <= 0) return false;
    this.shotIndex--;
    this.shot = this.matchReplay.shots[this.shotIndex];
    this.currentTimeSec = 0;
    return true;
  }

  public jumpToBeginning(): void {
    if (!this.active) return;
    if (this.mode === 'match' && this.matchReplay && this.matchReplay.shots.length > 0) {
      this.shotIndex = 0;
      this.shot = this.matchReplay.shots[0];
    }
    this.currentTimeSec = 0;
    this.playing = true;
  }

  public jumpToEnd(): void {
    if (!this.active || !this.shot) return;
    if (this.mode === 'match' && this.matchReplay && this.matchReplay.shots.length > 0) {
      this.shotIndex = this.matchReplay.shots.length - 1;
      this.shot = this.matchReplay.shots[this.shotIndex];
    }
    this.currentTimeSec = this.shot.durationSec;
    this.playing = false;
  }

  public jumpToHighlight(highlightId: string): ReplayHighlight | null {
    if (!this.active || !this.matchReplay) return null;
    const hl = this.matchReplay.highlights.find((h) => h.id === highlightId);
    if (!hl) return null;
    const targetIdx = hl.shotId
      ? this.matchReplay.shots.findIndex((s) => s.id === hl.shotId)
      : -1;
    if (targetIdx >= 0) {
      this.shotIndex = targetIdx;
      this.shot = this.matchReplay.shots[targetIdx];
      const shotStart = this.shot.startMatchTimeSec ?? 0;
      this.currentTimeSec = Math.max(
        0,
        Math.min(this.shot.durationSec, hl.matchTimeSec - shotStart),
      );
    } else {
      this.seekMatch(hl.matchTimeSec);
    }
    this.playing = true;
    return hl;
  }

  public exitReplay(): ReplayBallFrame[] {
    const backup = this.liveBackup;
    this.active = false;
    this.mode = 'shot';
    this.matchReplay = null;
    this.shotIndex = 0;
    this.shot = null;
    this.liveBackup = [];
    this.playing = false;
    this.currentTimeSec = 0;
    return backup;
  }

  public play(): void {
    if (!this.active || !this.shot) return;
    if (this.mode === 'match' && this.matchReplay) {
      const atMatchEnd =
        this.shotIndex >= this.matchReplay.shots.length - 1 &&
        this.currentTimeSec >= this.shot.durationSec - 0.001;
      if (atMatchEnd) {
        this.shotIndex = 0;
        this.shot = this.matchReplay.shots[0];
        this.currentTimeSec = 0;
      }
    } else if (this.currentTimeSec >= this.shot.durationSec - 0.001) {
      this.currentTimeSec = 0;
    }
    this.playing = true;
  }

  public pause(): void {
    this.playing = false;
  }

  public togglePlay(): boolean {
    if (!this.active) return false;
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
    return this.playing;
  }

  public restart(): void {
    if (!this.active || !this.shot) return;
    this.jumpToBeginning();
  }

  public seek(timeSec: number): void {
    if (!this.active || !this.shot) return;
    this.currentTimeSec = Math.max(0, Math.min(this.shot.durationSec, timeSec));
  }

  public seekMatch(matchTimeSec: number): void {
    if (!this.active || !this.shot) return;
    if (this.mode !== 'match' || !this.matchReplay || this.matchReplay.shots.length === 0) {
      this.seek(matchTimeSec);
      return;
    }
    const clamped = Math.max(0, Math.min(this.getMatchDurationSec(), matchTimeSec));
    const shots = this.matchReplay.shots;
    let foundIdx = shots.length - 1;
    for (let i = 0; i < shots.length; i++) {
      const start = shots[i].startMatchTimeSec ?? 0;
      const end = shots[i].endMatchTimeSec ?? start + shots[i].durationSec;
      if (clamped < end - 0.0001 || i === shots.length - 1) {
        foundIdx = i;
        break;
      }
    }
    this.shotIndex = foundIdx;
    this.shot = shots[foundIdx];
    const shotStart = this.shot.startMatchTimeSec ?? 0;
    this.currentTimeSec = Math.max(0, Math.min(this.shot.durationSec, clamped - shotStart));
  }

  public setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;
  }

  public setAutoSlowMo(enabled: boolean): void {
    this.autoSlowMo = enabled;
  }

  public setShowAnalysis(show: boolean): void {
    this.showAnalysis = show;
  }

  public jumpToFirstImpact(): void {
    if (!this.active || !this.shot) return;
    const target =
      this.shot.firstImpactTimeSec !== null
        ? Math.max(0, this.shot.firstImpactTimeSec - 0.14)
        : 0;
    this.currentTimeSec = Math.min(this.shot.durationSec, target);
    this.speed = 0.25;
    this.playing = true;
  }

  public getEffectivePlaybackSpeed(): number {
    if (!this.active || !this.shot) return this.speed;
    if (this.autoSlowMo && this.isNearKeyCollision(this.currentTimeSec)) {
      return Math.min(this.speed, 0.25);
    }
    return this.speed;
  }

  private isNearKeyCollision(timeSec: number): boolean {
    if (!this.shot) return false;
    for (const c of this.shot.collisions) {
      if (c.kind === 'cushion') continue;
      if (Math.abs(timeSec - c.timeSec) <= 0.18) {
        return true;
      }
    }
    return false;
  }

  public getActiveCollisionHighlight(): ShotCollisionEvent | null {
    if (!this.active || !this.shot) return null;
    let best: ShotCollisionEvent | null = null;
    let bestScore = Infinity;

    for (const c of this.shot.collisions) {
      const windowSec = c.kind === 'cushion' ? 0.12 : 0.2;
      const dist = Math.abs(this.currentTimeSec - c.timeSec);
      if (dist <= windowSec) {
        const priorityPenalty = c.kind === 'cue_ball' ? 0 : c.kind === 'ball_ball' ? 0.04 : 0.1;
        const score = dist + priorityPenalty;
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    return best;
  }

  public getMatchStateAtCurrentTime(): ReplayDynamicMatchState | null {
    if (!this.active || !this.shot) return null;
    if (this.mode !== 'match' || !this.matchReplay) return null;
    const prevShot = this.shotIndex > 0 ? this.matchReplay.shots[this.shotIndex - 1] : null;
    const nearEnd = this.currentTimeSec >= this.shot.durationSec - 0.05;
    const refShot = nearEnd ? this.shot : prevShot;

    const groups = refShot?.playerGroupsAfter ?? {
      player1: null,
      player2: null,
    };
    const pocketedNumbers = refShot?.pocketedNumbersAfter ?? [];
    return {
      player1Group: groups.player1,
      player2Group: groups.player2,
      pocketedNumbers,
      activePlayer: this.shot.shooter,
      tableOpen: refShot?.tableOpenAfter ?? true,
    };
  }

  public step(dt: number): void {
    if (!this.active || !this.shot || !this.playing) return;

    const prevTime = this.currentTimeSec;
    const effSpeed = this.getEffectivePlaybackSpeed();
    const nextTime = Math.min(this.shot.durationSec, prevTime + dt * effSpeed);
    this.currentTimeSec = nextTime;

    for (const col of this.shot.collisions) {
      if (col.timeSec > prevTime && col.timeSec <= nextTime) {
        if (col.kind === 'cushion') {
          soundEngine.playCushionBounce(col.impactSpeed);
        } else {
          soundEngine.playBallClack(col.impactSpeed);
        }
      }
    }
    for (const p of this.shot.pocketedBalls) {
      if (p.timeSec > prevTime && p.timeSec <= nextTime) {
        soundEngine.playPocketDrop();
      }
    }

    if (nextTime >= this.shot.durationSec) {
      if (
        this.mode === 'match' &&
        this.matchReplay &&
        this.shotIndex < this.matchReplay.shots.length - 1
      ) {
        this.shotIndex++;
        this.shot = this.matchReplay.shots[this.shotIndex];
        this.currentTimeSec = 0;
      } else {
        this.playing = false;
      }
    }
  }

  /**
   * Samples smoothly interpolated ball transforms at `currentTimeSec`.
   * Reuses objects in `out` to avoid per-frame allocations.
   */
  public sampleInterpolatedFrames(out: ReplayBallFrame[]): boolean {
    if (!this.active || !this.shot || this.shot.frameCount === 0) {
      return false;
    }

    const { framesData, frameCount, timestepSec } = this.shot;
    const exactFrame = Math.max(
      0,
      Math.min(frameCount - 1, this.currentTimeSec / timestepSec),
    );
    const idxA = Math.floor(exactFrame);
    const idxB = Math.min(frameCount - 1, idxA + 1);
    const alpha = exactFrame - idxA;

    const baseFrameA = idxA * REPLAY_FLOATS_PER_FRAME;
    const baseFrameB = idxB * REPLAY_FLOATS_PER_FRAME;

    if (out.length !== REPLAY_BALL_COUNT) {
      out.length = 0;
      for (let i = 0; i < REPLAY_BALL_COUNT; i++) {
        out.push({
          number: i,
          x: 0,
          y: 0,
          z: 0,
          qx: 0,
          qy: 0,
          qz: 0,
          qw: 1,
          vx: 0,
          vy: 0,
          vz: 0,
          pocketed: false,
        });
      }
    }

    for (let ballNum = 0; ballNum < REPLAY_BALL_COUNT; ballNum++) {
      const offA = baseFrameA + ballNum * REPLAY_FLOATS_PER_BALL;
      const offB = baseFrameB + ballNum * REPLAY_FLOATS_PER_BALL;

      const pocketedA = framesData[offA + 10] > 0.5;
      const pocketedB = framesData[offB + 10] > 0.5;
      const dst = out[ballNum];
      dst.number = ballNum;

      if (idxA === idxB || alpha <= 0.0001) {
        dst.x = framesData[offA + 0];
        dst.y = framesData[offA + 1];
        dst.z = framesData[offA + 2];
        dst.qx = framesData[offA + 3];
        dst.qy = framesData[offA + 4];
        dst.qz = framesData[offA + 5];
        dst.qw = framesData[offA + 6];
        dst.vx = framesData[offA + 7];
        dst.vy = framesData[offA + 8];
        dst.vz = framesData[offA + 9];
        dst.pocketed = pocketedA;
        continue;
      }

      dst.x = framesData[offA + 0] + (framesData[offB + 0] - framesData[offA + 0]) * alpha;
      dst.y = framesData[offA + 1] + (framesData[offB + 1] - framesData[offA + 1]) * alpha;
      dst.z = framesData[offA + 2] + (framesData[offB + 2] - framesData[offA + 2]) * alpha;

      _qa.set(
        framesData[offA + 3],
        framesData[offA + 4],
        framesData[offA + 5],
        framesData[offA + 6],
      );
      _qb.set(
        framesData[offB + 3],
        framesData[offB + 4],
        framesData[offB + 5],
        framesData[offB + 6],
      );
      _qOut.slerpQuaternions(_qa, _qb, alpha);

      dst.qx = _qOut.x;
      dst.qy = _qOut.y;
      dst.qz = _qOut.z;
      dst.qw = _qOut.w;

      dst.vx = framesData[offA + 7] + (framesData[offB + 7] - framesData[offA + 7]) * alpha;
      dst.vy = framesData[offA + 8] + (framesData[offB + 8] - framesData[offA + 8]) * alpha;
      dst.vz = framesData[offA + 9] + (framesData[offB + 9] - framesData[offA + 9]) * alpha;
      dst.pocketed = pocketedA || (alpha >= 0.99 && pocketedB);
    }

    return true;
  }
}
