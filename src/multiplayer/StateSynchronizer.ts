import * as THREE from 'three';
import type { PocketId } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import type { OnlineBallFrame } from './shared/protocol';

interface TimedFrame {
  receivedAtMs: number;
  byBall: Map<number, OnlineBallFrame>;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qOut = new THREE.Quaternion();

export class StateSynchronizer {
  private buffer: TimedFrame[] = [];
  private latestSettled: OnlineBallFrame[] | null = null;
  private activeShotSeq = -1;
  private seenPocketKeys = new Set<string>();
  private lastClackAtMs = 0;
  private prevBallSpeeds = new Map<number, number>();
  private readonly interpolationDelayMs = 38;

  public reset(): void {
    this.buffer = [];
    this.latestSettled = null;
    this.activeShotSeq = -1;
    this.seenPocketKeys.clear();
    this.prevBallSpeeds.clear();
  }

  public beginShot(shotSeq: number): void {
    this.activeShotSeq = shotSeq;
    this.buffer = [];
    this.prevBallSpeeds.clear();
  }

  public pushFrame(shotSeq: number, balls: OnlineBallFrame[]): void {
    if (shotSeq < this.activeShotSeq) return;
    this.activeShotSeq = shotSeq;

    const now = performance.now();
    const byBall = new Map<number, OnlineBallFrame>();
    for (const b of balls) {
      byBall.set(b.number, b);
    }

    this.detectCollisionSounds(balls, now);

    this.buffer.push({ receivedAtMs: now, byBall });
    if (this.buffer.length > 18) {
      this.buffer.shift();
    }
  }

  public markPocketEvent(shotSeq: number, ballNumber: number, _pocketId: PocketId): boolean {
    const key = `${shotSeq}:${ballNumber}`;
    if (this.seenPocketKeys.has(key)) return false;
    this.seenPocketKeys.add(key);
    if (this.seenPocketKeys.size > 200) {
      const oldest = this.seenPocketKeys.values().next().value;
      if (oldest) this.seenPocketKeys.delete(oldest);
    }
    soundEngine.playPocketDrop();
    return true;
  }

  public applySettledState(balls: OnlineBallFrame[]): void {
    this.buffer = [];
    this.latestSettled = balls;
    this.prevBallSpeeds.clear();
  }

  public getLatestSettledBalls(): OnlineBallFrame[] | null {
    return this.latestSettled;
  }

  public sampleRenderFrames(out: OnlineBallFrame[]): boolean {
    out.length = 0;
    if (this.buffer.length === 0) {
      if (!this.latestSettled) return false;
      for (let i = 0; i < this.latestSettled.length; i++) {
        out.push(this.latestSettled[i]);
      }
      return true;
    }

    if (this.buffer.length === 1) {
      for (const b of this.buffer[0].byBall.values()) {
        out.push(b);
      }
      return true;
    }

    const renderTime = performance.now() - this.interpolationDelayMs;
    while (this.buffer.length > 2 && this.buffer[1].receivedAtMs <= renderTime) {
      this.buffer.shift();
    }

    const a = this.buffer[0];
    const b = this.buffer[1];
    if (!b) {
      for (const item of a.byBall.values()) out.push(item);
      return true;
    }

    const span = Math.max(1, b.receivedAtMs - a.receivedAtMs);
    const alpha = Math.max(0, Math.min(1, (renderTime - a.receivedAtMs) / span));

    for (const [num, fa] of a.byBall) {
      const fb = b.byBall.get(num) ?? fa;
      if (fb.pocketed) {
        out.push(fb);
        continue;
      }

      _qa.set(fa.qx, fa.qy, fa.qz, fa.qw);
      _qb.set(fb.qx, fb.qy, fb.qz, fb.qw);
      _qOut.slerpQuaternions(_qa, _qb, alpha);

      out.push({
        number: num,
        x: fa.x + (fb.x - fa.x) * alpha,
        y: fa.y + (fb.y - fa.y) * alpha,
        z: fa.z + (fb.z - fa.z) * alpha,
        qx: _qOut.x,
        qy: _qOut.y,
        qz: _qOut.z,
        qw: _qOut.w,
        vx: fb.vx,
        vy: fb.vy,
        vz: fb.vz,
        pocketed: fb.pocketed,
      });
    }
    return true;
  }

  private detectCollisionSounds(balls: OnlineBallFrame[], nowMs: number): void {
    if (nowMs - this.lastClackAtMs < 55) return;

    let strongestDelta = 0;
    for (const b of balls) {
      if (b.pocketed) continue;
      const speed = Math.hypot(b.vx, b.vz);
      const prev = this.prevBallSpeeds.get(b.number) ?? speed;
      const delta = Math.abs(speed - prev);
      this.prevBallSpeeds.set(b.number, speed);
      if (delta > strongestDelta) {
        strongestDelta = delta;
      }
    }

    if (strongestDelta > 0.65) {
      this.lastClackAtMs = nowMs;
      soundEngine.playBallClack(Math.min(6, strongestDelta * 1.15));
    }
  }
}
