import RAPIER from '@dimforge/rapier3d-compat';
import type { CueSpin } from '../../store/useGameStore';
import {
  applyClothAndSpinForMap,
  applyCueStrikeImpulse,
  applyCushionSpinResponse,
  BALL_COLLISION_GROUPS,
  BASE_FIXED_DT,
  createConfiguredRapierWorld,
  isInsidePocketCaptureZone,
  needsNearImpactMicroStep,
  populateRapierTableColliders,
  type CushionNormal,
} from '../physics/RapierTableCore';
import type {
  BallSettledSnapshot,
  PocketEvent,
  PocketId,
  ShotTelemetry,
} from '../rules/types';
import { BALL_SPECS, TABLE_DIMENSIONS } from '../utils/constants';

export interface SimShotInput {
  candidateId: string;
  aimAngle: number;
  power: number;
  spin: CueSpin;
  calledBall: number | null;
  calledPocket: PocketId | null;
  maxSimSeconds?: number;
}

export interface SimShotOutput {
  candidateId: string;
  telemetry: ShotTelemetry;
  cueFinalPos: { x: number; z: number };
  cuePocketed: boolean;
  pocketedBalls: Array<{ ballNumber: number; pocketId: PocketId }>;
  firstBallContacted: number | null;
  anyBallContactedRail: boolean;
  settledPositions: BallSettledSnapshot[];
  stepsExecuted: number;
}

interface SimBallEntry {
  number: number;
  body: RAPIER.RigidBody;
  colliderHandle: number;
  active: boolean;
  pocketed: boolean;
}

/**
 * Isolated Rapier3D physics simulation engine used exclusively by the AI
 * (inside a Web Worker in browser or standalone in headless tests).
 * Never shares state with the live game world.
 */
export class RapierIsolatedSimEngine {
  private world!: RAPIER.World;
  private eventQueue!: RAPIER.EventQueue;
  private balls = new Map<number, SimBallEntry>();
  private colliderToBall = new Map<number, number>();
  private cushionHandles = new Set<number>();
  private cushionNormals = new Map<number, CushionNormal>();
  private initialized = false;

  public async init(): Promise<void> {
    if (this.initialized) return;
    await RAPIER.init();
    this.world = createConfiguredRapierWorld();
    this.eventQueue = new RAPIER.EventQueue(true);
    populateRapierTableColliders(this.world, this.cushionHandles, this.cushionNormals);

    const restY = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;
    for (let num = 0; num <= 15; num++) {
      const rbDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(10 + num * 0.25, restY, 10)
        .setLinearDamping(BALL_SPECS.linearDamping)
        .setAngularDamping(BALL_SPECS.angularDamping)
        .setCcdEnabled(true)
        .setCanSleep(false);
      const body = this.world.createRigidBody(rbDesc);
      const colDesc = RAPIER.ColliderDesc.ball(BALL_SPECS.radius)
        .setMass(BALL_SPECS.mass)
        .setRestitution(0.94)
        .setFriction(0.03)
        .setCollisionGroups(BALL_COLLISION_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const col = this.world.createCollider(colDesc, body);
      this.balls.set(num, {
        number: num,
        body,
        colliderHandle: col.handle,
        active: false,
        pocketed: true,
      });
      this.colliderToBall.set(col.handle, num);
    }

    this.initialized = true;
  }

  public simulateShot(
    ballSnapshot: BallSettledSnapshot[],
    shot: SimShotInput,
    isBreakShot: boolean,
  ): SimShotOutput {
    if (!this.initialized) {
      throw new Error('RapierIsolatedSimEngine must be initialized before simulateShot()');
    }

    const restY = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;
    const snapMap = new Map(ballSnapshot.map((b) => [b.number, b]));

    for (const [num, entry] of this.balls) {
      entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);

      const s = snapMap.get(num);
      if (!s || s.pocketed) {
        entry.active = false;
        entry.pocketed = true;
        entry.body.setTranslation({ x: 10 + num * 0.25, y: restY, z: 10 }, true);
      } else {
        entry.active = true;
        entry.pocketed = false;
        entry.body.setTranslation({ x: s.x, y: restY, z: s.z }, true);
        entry.body.wakeUp();
      }
    }

    // Drain any stale queued events
    this.eventQueue.drainCollisionEvents(() => {});

    const cueEntry = this.balls.get(0)!;
    applyCueStrikeImpulse(cueEntry.body, shot.aimAngle, shot.power, shot.spin);

    let firstBallContacted: number | null = null;
    const allBallsContacted: number[] = [];
    const railContactBalls = new Set<number>();
    let anyBallContactedRail = false;
    let cuePocketed = false;
    const pocketEvents: PocketEvent[] = [];
    const pocketedBalls: Array<{ ballNumber: number; pocketId: PocketId }> = [];

    const fixedDt = BASE_FIXED_DT;
    const maxSteps = Math.round((shot.maxSimSeconds ?? 3.4) / fixedDt);
    let stepsExecuted = 0;

    for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
      stepsExecuted++;
      const useMicro = needsNearImpactMicroStep(this.balls, fixedDt);
      const subCount = useMicro ? 4 : 1;
      const stepDt = fixedDt / subCount;
      this.world.timestep = stepDt;

      for (let sub = 0; sub < subCount; sub++) {
        this.world.step(this.eventQueue);
        this.eventQueue.drainCollisionEvents((h1, h2, started) => {
          if (!started) return;
          const b1 = this.colliderToBall.get(h1);
          const b2 = this.colliderToBall.get(h2);

          if (b1 !== undefined && b2 !== undefined) {
            const e1 = this.balls.get(b1);
            const e2 = this.balls.get(b2);
            if (!e1 || !e2 || !e1.active || !e2.active || e1.pocketed || e2.pocketed) return;
            const hitObj = b1 === 0 ? b2 : b2 === 0 ? b1 : null;
            if (hitObj !== null) {
              if (firstBallContacted === null) {
                firstBallContacted = hitObj;
              }
              if (!allBallsContacted.includes(hitObj)) {
                allBallsContacted.push(hitObj);
              }
            }
          } else {
            const bNum = b1 !== undefined ? b1 : b2;
            const other = b1 !== undefined ? h2 : h1;
            if (bNum !== undefined && this.cushionHandles.has(other)) {
              const e = this.balls.get(bNum);
              if (!e || !e.active || e.pocketed) return;
              railContactBalls.add(bNum);
              if (firstBallContacted !== null) {
                anyBallContactedRail = true;
              }
              const cNorm = this.cushionNormals.get(other);
              if (cNorm) {
                applyCushionSpinResponse(e.body, cNorm.nx, cNorm.nz);
              }
            }
          }
        });

        applyClothAndSpinForMap(this.balls, stepDt);
      }

      if (useMicro) {
        this.world.timestep = fixedDt;
      }

      // Pocket checks
      for (const entry of this.balls.values()) {
        if (!entry.active || entry.pocketed) continue;
        const pt = entry.body.translation();
        const check = isInsidePocketCaptureZone(pt.x, pt.z);
        if (check.captured && check.pocketId) {
          entry.pocketed = true;
          entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          entry.body.setTranslation({ x: 10 + entry.number * 0.25, y: restY, z: 10 }, true);

          if (entry.number === 0) {
            cuePocketed = true;
          } else {
            pocketedBalls.push({ ballNumber: entry.number, pocketId: check.pocketId });
          }

          pocketEvents.push({
            shotId: 0,
            ballNumber: entry.number,
            pocketId: check.pocketId,
            order: pocketEvents.length + 1,
            timestampMs: stepIdx,
          });
        }
      }

      // Check early settlement once all active non-pocketed balls stop moving
      if (stepIdx >= 6) {
        let moving = false;
        for (const entry of this.balls.values()) {
          if (!entry.active || entry.pocketed) continue;
          const v = entry.body.linvel();
          const w = entry.body.angvel();
          if (
            Math.hypot(v.x, v.z) > BALL_SPECS.sleepThreshold ||
            Math.hypot(w.x, w.y, w.z) > 0.35
          ) {
            moving = true;
            break;
          }
        }
        if (!moving) break;
      }
    }

    const settledPositions: BallSettledSnapshot[] = [];
    let cueFinalPos = { x: 0, z: 0 };

    for (const entry of this.balls.values()) {
      const orig = snapMap.get(entry.number);
      if (!orig) continue;
      if (entry.pocketed) {
        settledPositions.push({
          number: entry.number,
          x: orig.x,
          z: orig.z,
          pocketed: true,
        });
      } else {
        const t = entry.body.translation();
        if (entry.number === 0) {
          cueFinalPos = { x: t.x, z: t.z };
        }
        settledPositions.push({
          number: entry.number,
          x: t.x,
          z: t.z,
          pocketed: false,
        });
      }
    }

    const telemetry: ShotTelemetry = {
      shotId: 0,
      isBreakShot,
      shooter: 'player2',
      calledShot: {
        targetBall: shot.calledBall,
        targetPocket: shot.calledPocket,
      },
      firstBallContacted,
      allBallsContacted,
      pocketEvents,
      cueBallPocketed: cuePocketed,
      railContactBalls: Array.from(railContactBalls),
      anyBallContactedRail,
      settledPositions,
    };

    return {
      candidateId: shot.candidateId,
      telemetry,
      cueFinalPos,
      cuePocketed,
      pocketedBalls,
      firstBallContacted,
      anyBallContactedRail,
      settledPositions,
      stepsExecuted,
    };
  }

  public dispose(): void {
    if (this.initialized) {
      this.eventQueue.free();
      this.world.free();
      this.initialized = false;
    }
  }
}
