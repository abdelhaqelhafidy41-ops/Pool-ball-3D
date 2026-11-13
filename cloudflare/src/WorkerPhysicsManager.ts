import RAPIER from '@dimforge/rapier3d-compat';
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
  validateCuePlacementAgainstBalls,
  type CushionNormal,
} from '../../src/game/physics/RapierTableCore';
import { PocketEventManager } from '../../src/game/rules/PocketEventManager';
import { generateOfficialEightBallRack, type BallRackCoordinate } from '../../src/game/rules/RackGenerator';
import type {
  BallSettledSnapshot,
  CalledShot,
  PlacementZone,
  PlayerId,
  PocketId,
  ShotTelemetry,
} from '../../src/game/rules/types';
import {
  BALL_SPECS,
  CLOTH_PHYSICS,
  POCKET_POSITIONS,
  TABLE_DIMENSIONS,
} from '../../src/game/utils/constants';
import type { OnlineBallFrame } from '../../src/multiplayer/shared/protocol';

let rapierInitPromise: Promise<void> | null = null;

export function ensureWorkerRapierInitialized(): Promise<void> {
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER.init();
  }
  return rapierInitPromise;
}

interface WorkerBallEntry {
  number: number;
  body: RAPIER.RigidBody;
  colliderHandle: number;
  pocketed: boolean;
  dropping: boolean;
  dropTargetX: number;
  dropTargetZ: number;
  dropPocketId: PocketId | null;
  dropVelY: number;
  dropY: number;
  lastValidX: number;
  lastValidY: number;
  lastValidZ: number;
}

export interface WorkerShotCallbacks {
  onFrame: (frames: OnlineBallFrame[]) => void;
  onPocket: (ballNumber: number, pocketId: PocketId, order: number) => void;
  onSettled: (telemetry: ShotTelemetry, frames: OnlineBallFrame[]) => void;
}

export class WorkerPhysicsManager {
  private world!: RAPIER.World;
  private eventQueue!: RAPIER.EventQueue;
  private balls = new Map<number, WorkerBallEntry>();
  private colliderToBall = new Map<number, number>();
  private cushionColliderHandles = new Set<number>();
  private cushionNormals = new Map<number, CushionNormal>();

  private initialized = false;
  private disposed = false;
  private accumulator = 0;
  private simTimer: ReturnType<typeof setTimeout> | null = null;
  private simFinishResolve: (() => void) | null = null;
  private readonly broadcastHz: number;
  private pocketEventManager = new PocketEventManager();

  private activeTelemetry: {
    active: boolean;
    shotId: number;
    isBreakShot: boolean;
    shooter: PlayerId;
    calledShot: CalledShot;
    firstBallContacted: number | null;
    allBallsContacted: number[];
    cueBallPocketed: boolean;
    railContactBalls: Set<number>;
    anyBallContactedRail: boolean;
  } = {
    active: false,
    shotId: 0,
    isBreakShot: false,
    shooter: 'player1',
    calledShot: { targetBall: null, targetPocket: null },
    firstBallContacted: null,
    allBallsContacted: [],
    cueBallPocketed: false,
    railContactBalls: new Set<number>(),
    anyBallContactedRail: false,
  };

  constructor(broadcastHz = 35) {
    this.broadcastHz = Math.max(20, Math.min(60, broadcastHz));
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public async init(initialRack?: BallRackCoordinate[]): Promise<void> {
    if (this.initialized) return;
    await ensureWorkerRapierInitialized();
    if (this.disposed) return;

    this.world = createConfiguredRapierWorld();
    this.eventQueue = new RAPIER.EventQueue(true);
    populateRapierTableColliders(
      this.world,
      this.cushionColliderHandles,
      this.cushionNormals,
    );

    const rack = initialRack ?? generateOfficialEightBallRack();
    for (const pos of rack) {
      const rbDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
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

      const collider = this.world.createCollider(colDesc, body);
      this.balls.set(pos.number, {
        number: pos.number,
        body,
        colliderHandle: collider.handle,
        pocketed: false,
        dropping: false,
        dropTargetX: 0,
        dropTargetZ: 0,
        dropPocketId: null,
        dropVelY: 0,
        dropY: pos.y,
        lastValidX: pos.x,
        lastValidY: pos.y,
        lastValidZ: pos.z,
      });
      this.colliderToBall.set(collider.handle, pos.number);
    }

    this.initialized = true;
  }

  public async restoreFromBallFrames(frames: OnlineBallFrame[]): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
    this.stopSimulationLoop();
    const D = TABLE_DIMENSIONS;
    for (const f of frames) {
      const entry = this.balls.get(f.number);
      if (!entry) continue;
      const y = f.pocketed ? D.surfaceY - 0.118 : D.surfaceY + BALL_SPECS.radius;
      entry.pocketed = f.pocketed;
      entry.dropping = false;
      entry.dropPocketId = null;
      entry.dropVelY = 0;
      entry.dropY = y;
      entry.lastValidX = f.x;
      entry.lastValidY = y;
      entry.lastValidZ = f.z;
      entry.body.setBodyType(
        f.pocketed ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic,
        true,
      );
      entry.body.setTranslation({ x: f.x, y: Number.isFinite(f.y) ? f.y : y, z: f.z }, true);
      entry.body.setRotation(
        {
          x: Number.isFinite(f.qx) ? f.qx : 0,
          y: Number.isFinite(f.qy) ? f.qy : 0,
          z: Number.isFinite(f.qz) ? f.qz : 0,
          w: Number.isFinite(f.qw) ? f.qw : 1,
        },
        true,
      );
      entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.activeTelemetry.active = false;
    this.accumulator = 0;
  }

  public resetRack(customPositions?: BallRackCoordinate[]): void {
    this.stopSimulationLoop();
    if (!this.initialized) return;
    const rack = customPositions ?? generateOfficialEightBallRack();
    for (const pos of rack) {
      const entry = this.balls.get(pos.number);
      if (!entry) continue;
      entry.pocketed = false;
      entry.dropping = false;
      entry.dropPocketId = null;
      entry.dropVelY = 0;
      entry.dropY = pos.y;
      entry.lastValidX = pos.x;
      entry.lastValidY = pos.y;
      entry.lastValidZ = pos.z;
      entry.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      entry.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
      entry.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.activeTelemetry.active = false;
    this.accumulator = 0;
  }

  public getAllBallStates(): BallSettledSnapshot[] {
    const out: BallSettledSnapshot[] = [];
    for (const entry of this.balls.values()) {
      const t = entry.body.translation();
      out.push({
        number: entry.number,
        x: t.x,
        z: t.z,
        pocketed: entry.pocketed || entry.dropping,
      });
    }
    return out;
  }

  public getBallFrames(): OnlineBallFrame[] {
    const frames: OnlineBallFrame[] = [];
    for (const entry of this.balls.values()) {
      const t = entry.body.translation();
      const r = entry.body.rotation();
      const v = entry.body.linvel();
      frames.push({
        number: entry.number,
        x: t.x,
        y: t.y,
        z: t.z,
        qx: r.x,
        qy: r.y,
        qz: r.z,
        qw: r.w,
        vx: v.x,
        vy: v.y,
        vz: v.z,
        pocketed: entry.pocketed,
      });
    }
    return frames;
  }

  public getCueBallPosition(): { x: number; z: number } {
    const cue = this.balls.get(0);
    if (!cue || !this.initialized) {
      return { x: TABLE_DIMENSIONS.headSpotX, z: 0 };
    }
    const t = cue.body.translation();
    return { x: t.x, z: t.z };
  }

  public isCueBallAvailable(): boolean {
    const cue = this.balls.get(0);
    return Boolean(cue && !cue.pocketed && !cue.dropping);
  }

  public validateCuePlacement(
    x: number,
    z: number,
    zone: PlacementZone,
  ): { valid: boolean; reason?: string; clampedX: number; clampedZ: number } {
    return validateCuePlacementAgainstBalls(x, z, this.getAllBallStates(), zone);
  }

  public findNearestValidCuePlacement(zone: PlacementZone): { x: number; z: number } {
    const D = TABLE_DIMENSIONS;
    const R = BALL_SPECS.radius;
    const headCheck = this.validateCuePlacement(D.headSpotX, 0, zone);
    if (headCheck.valid) return { x: headCheck.clampedX, z: headCheck.clampedZ };

    const minX = -D.halfLength + R + 0.06;
    const maxX = zone === 'kitchen' ? D.headSpotX : D.halfLength - R - 0.06;
    const maxZ = D.halfWidth - R - 0.06;

    for (let x = Math.min(D.headSpotX, maxX); x >= minX; x -= 0.055) {
      for (let stepZ = 0; stepZ <= maxZ; stepZ += 0.055) {
        for (const z of stepZ === 0 ? [0] : [stepZ, -stepZ]) {
          const check = this.validateCuePlacement(x, z, zone);
          if (check.valid) return { x: check.clampedX, z: check.clampedZ };
        }
      }
    }
    return { x: D.headSpotX, z: 0 };
  }

  public setCuePlacement(x: number, z: number): void {
    if (!this.initialized) return;
    const cue = this.balls.get(0);
    if (!cue) return;
    const y = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;

    cue.pocketed = false;
    cue.dropping = false;
    cue.dropPocketId = null;
    cue.dropVelY = 0;
    cue.dropY = y;
    cue.lastValidX = x;
    cue.lastValidY = y;
    cue.lastValidZ = z;
    cue.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    cue.body.setTranslation({ x, y, z }, true);
    cue.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    cue.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    cue.body.wakeUp();
  }

  public respotEightBall(): void {
    if (!this.initialized) return;
    const eight = this.balls.get(8);
    if (!eight) return;

    const D = TABLE_DIMENSIONS;
    const R = BALL_SPECS.radius;
    const y = D.surfaceY + R;
    const minDistSq = (R * 2.08) ** 2;

    let spotX = D.footSpotX;
    let spotZ = 0;
    for (let step = 0; step < 30; step++) {
      let blocked = false;
      for (const [num, entry] of this.balls) {
        if (num === 8 || entry.pocketed || entry.dropping) continue;
        const t = entry.body.translation();
        const dx = t.x - spotX;
        const dz = t.z - spotZ;
        if (dx * dx + dz * dz < minDistSq) {
          blocked = true;
          break;
        }
      }
      if (!blocked) break;
      spotX += R * 2.15;
      if (spotX > D.halfLength - R * 1.4) {
        spotX = D.footSpotX - step * R * 1.4;
        spotZ = (step % 2 === 0 ? 1 : -1) * R * 2.2;
      }
    }

    eight.pocketed = false;
    eight.dropping = false;
    eight.dropPocketId = null;
    eight.dropVelY = 0;
    eight.dropY = y;
    eight.lastValidX = spotX;
    eight.lastValidY = y;
    eight.lastValidZ = spotZ;
    eight.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    eight.body.setTranslation({ x: spotX, y, z: spotZ }, true);
    eight.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    eight.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  public respotCueBall(): { x: number; z: number } {
    if (!this.initialized) return { x: TABLE_DIMENSIONS.headSpotX, z: 0 };
    const cue = this.balls.get(0);
    if (!cue) return { x: TABLE_DIMENSIONS.headSpotX, z: 0 };

    const y = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;
    let spotX = TABLE_DIMENSIONS.headSpotX;
    let spotZ = 0;
    const minDistSq = (BALL_SPECS.radius * 2.15) ** 2;

    for (let attempt = 0; attempt < 24; attempt++) {
      let blocked = false;
      for (const [num, entry] of this.balls) {
        if (num === 0 || entry.pocketed) continue;
        const t = entry.body.translation();
        const dx = t.x - spotX;
        const dz = t.z - spotZ;
        if (dx * dx + dz * dz < minDistSq) {
          blocked = true;
          break;
        }
      }
      if (!blocked) break;
      spotX -= 0.06;
      if (spotX < -TABLE_DIMENSIONS.halfLength + 0.1) {
        spotX = TABLE_DIMENSIONS.headSpotX;
        spotZ = (attempt % 2 === 0 ? 1 : -1) * Math.ceil(attempt / 2) * 0.07;
      }
    }

    cue.pocketed = false;
    cue.dropping = false;
    cue.dropPocketId = null;
    cue.dropVelY = 0;
    cue.dropY = y;
    cue.lastValidX = spotX;
    cue.lastValidY = y;
    cue.lastValidZ = spotZ;
    cue.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    cue.body.setTranslation({ x: spotX, y, z: spotZ }, true);
    cue.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    cue.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    return { x: spotX, z: spotZ };
  }

  public areAnyBallsMoving(): boolean {
    if (!this.initialized) return false;
    for (const entry of this.balls.values()) {
      if (entry.dropping) return true;
      if (entry.pocketed) continue;
      const v = entry.body.linvel();
      const w = entry.body.angvel();
      if (
        Math.hypot(v.x, v.y, v.z) > BALL_SPECS.sleepThreshold ||
        Math.hypot(w.x, w.y, w.z) > 0.35
      ) {
        return true;
      }
    }
    return false;
  }

  public startShotSimulation(
    shotId: number,
    isBreakShot: boolean,
    shooter: PlayerId,
    calledShot: CalledShot,
    aimAngle: number,
    power: number,
    spin: { x: number; y: number },
    callbacks: WorkerShotCallbacks,
  ): Promise<void> {
    this.stopSimulationLoop();
    if (!this.initialized || this.disposed) {
      return Promise.resolve();
    }

    if (!this.isCueBallAvailable()) {
      this.respotCueBall();
    }

    for (const entry of this.balls.values()) {
      if (!entry.pocketed && !entry.dropping) {
        entry.body.wakeUp();
      }
    }

    this.pocketEventManager.startShot(shotId);
    this.activeTelemetry = {
      active: true,
      shotId,
      isBreakShot,
      shooter,
      calledShot: { ...calledShot },
      firstBallContacted: null,
      allBallsContacted: [],
      cueBallPocketed: false,
      railContactBalls: new Set<number>(),
      anyBallContactedRail: false,
    };

    const cue = this.balls.get(0)!;
    applyCueStrikeImpulse(cue.body, aimAngle, power, spin);
    this.accumulator = 0;

    const tickMs = Math.round(1000 / this.broadcastHz);
    const stepDt = tickMs / 1000;
    const maxSimTicks = Math.ceil(22 / stepDt);
    let tickCount = 0;

    return new Promise<void>((resolve) => {
      this.simFinishResolve = resolve;

      const scheduleNext = () => {
        if (this.disposed) {
          this.stopSimulationLoop();
          return;
        }
        this.simTimer = setTimeout(runTick, tickMs);
      };

      const runTick = () => {
        this.simTimer = null;
        if (this.disposed) {
          this.stopSimulationLoop();
          return;
        }

        tickCount++;
        this.stepDelta(stepDt, (ballNumber, pocketId, order) => {
          callbacks.onPocket(ballNumber, pocketId, order);
        });

        const frames = this.getBallFrames();
        callbacks.onFrame(frames);

        const stillMoving = this.areAnyBallsMoving();
        if (!stillMoving || tickCount >= maxSimTicks) {
          if (tickCount >= maxSimTicks && stillMoving) {
            this.forceStopAllBalls();
          }
          const telemetry = this.finalizeShotTelemetry();
          const settledFrames = this.getBallFrames();
          this.simFinishResolve = null;
          callbacks.onSettled(telemetry, settledFrames);
          resolve();
          return;
        }

        scheduleNext();
      };

      scheduleNext();
    });
  }

  public stopSimulationLoop(): void {
    if (this.simTimer !== null) {
      clearTimeout(this.simTimer);
      this.simTimer = null;
    }
    if (this.simFinishResolve) {
      const res = this.simFinishResolve;
      this.simFinishResolve = null;
      res();
    }
  }

  public stepDelta(
    deltaSec: number,
    onPocketCallback?: (ballNumber: number, pocketId: PocketId, order: number) => void,
  ): void {
    if (!this.initialized) return;
    const fixedDt = BASE_FIXED_DT;
    this.accumulator = Math.min(this.accumulator + deltaSec, 0.08);

    while (this.accumulator >= fixedDt) {
      if (needsNearImpactMicroStep(this.balls, fixedDt)) {
        const subDt = fixedDt / 4;
        this.world.timestep = subDt;
        for (let s = 0; s < 4; s++) {
          this.world.step(this.eventQueue);
          this.processCollisionEvents();
          applyClothAndSpinForMap(this.balls, subDt);
          this.enforceTableSafetyAndRecovery();
          this.checkPocketsAndDrop(subDt, onPocketCallback);
        }
        this.world.timestep = fixedDt;
      } else {
        this.world.step(this.eventQueue);
        this.processCollisionEvents();
        applyClothAndSpinForMap(this.balls, fixedDt);
        this.enforceTableSafetyAndRecovery();
        this.checkPocketsAndDrop(fixedDt, onPocketCallback);
      }
      this.accumulator -= fixedDt;
    }
  }

  private forceStopAllBalls(): void {
    for (const entry of this.balls.values()) {
      if (entry.dropping) {
        const pid = entry.dropPocketId ?? 'corner-tl';
        entry.dropping = false;
        entry.pocketed = true;
        entry.body.setNextKinematicTranslation({
          x: entry.dropTargetX,
          y: TABLE_DIMENSIONS.surfaceY - 0.118,
          z: entry.dropTargetZ,
        });
        if (this.activeTelemetry.active) {
          if (entry.number === 0) this.activeTelemetry.cueBallPocketed = true;
          this.pocketEventManager.recordPocket(entry.number, pid);
        }
      }
      entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  private processCollisionEvents(): void {
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const b1 = this.colliderToBall.get(h1);
      const b2 = this.colliderToBall.get(h2);

      if (b1 !== undefined && b2 !== undefined) {
        const e1 = this.balls.get(b1);
        const e2 = this.balls.get(b2);
        if (!e1 || !e2 || e1.pocketed || e2.pocketed || e1.dropping || e2.dropping) return;

        if (this.activeTelemetry.active) {
          const hitObj = b1 === 0 ? b2 : b2 === 0 ? b1 : null;
          if (hitObj !== null) {
            if (this.activeTelemetry.firstBallContacted === null) {
              this.activeTelemetry.firstBallContacted = hitObj;
            }
            if (!this.activeTelemetry.allBallsContacted.includes(hitObj)) {
              this.activeTelemetry.allBallsContacted.push(hitObj);
            }
          }
        }
      } else {
        const ballNum = b1 !== undefined ? b1 : b2;
        const other = b1 !== undefined ? h2 : h1;
        if (ballNum !== undefined && this.cushionColliderHandles.has(other)) {
          const e = this.balls.get(ballNum);
          if (!e || e.pocketed || e.dropping) return;

          if (this.activeTelemetry.active) {
            this.activeTelemetry.railContactBalls.add(ballNum);
            if (this.activeTelemetry.firstBallContacted !== null) {
              this.activeTelemetry.anyBallContactedRail = true;
            }
          }

          const cNorm = this.cushionNormals.get(other);
          if (cNorm) {
            applyCushionSpinResponse(e.body, cNorm.nx, cNorm.nz);
          }
        }
      }
    });
  }

  private enforceTableSafetyAndRecovery(): void {
    const D = TABLE_DIMENSIONS;
    const R = BALL_SPECS.radius;
    const restY = D.surfaceY + R;
    const maxValidX = D.halfLength + 0.09;
    const maxValidZ = D.halfWidth + 0.09;

    for (const entry of this.balls.values()) {
      if (entry.pocketed || entry.dropping) continue;
      const t = entry.body.translation();
      const v = entry.body.linvel();

      const outOfBounds =
        !Number.isFinite(t.x) ||
        !Number.isFinite(t.y) ||
        !Number.isFinite(t.z) ||
        Math.abs(t.x) > maxValidX ||
        Math.abs(t.z) > maxValidZ ||
        t.y < D.surfaceY - 0.018 ||
        t.y > restY + 0.09;

      if (outOfBounds) {
        const safeX = Math.max(
          -D.halfLength + R * 1.1,
          Math.min(D.halfLength - R * 1.1, Number.isFinite(entry.lastValidX) ? entry.lastValidX : 0),
        );
        const safeZ = Math.max(
          -D.halfWidth + R * 1.1,
          Math.min(D.halfWidth - R * 1.1, Number.isFinite(entry.lastValidZ) ? entry.lastValidZ : 0),
        );
        entry.body.setTranslation({ x: safeX, y: restY, z: safeZ }, true);
        entry.body.setLinvel(
          {
            x: Number.isFinite(v.x) ? v.x * 0.4 : 0,
            y: 0,
            z: Number.isFinite(v.z) ? v.z * 0.4 : 0,
          },
          true,
        );
        continue;
      }

      if (t.y < restY - 0.002) {
        entry.body.setTranslation({ x: t.x, y: restY, z: t.z }, true);
        if (v.y < 0) {
          entry.body.setLinvel({ x: v.x, y: 0, z: v.z }, true);
        }
      }

      if (
        Math.abs(t.x) <= D.halfLength - R * 0.85 &&
        Math.abs(t.z) <= D.halfWidth - R * 0.85
      ) {
        entry.lastValidX = t.x;
        entry.lastValidY = restY;
        entry.lastValidZ = t.z;
      }
    }
  }

  private checkPocketsAndDrop(
    dt: number,
    onPocketCallback?: (ballNumber: number, pocketId: PocketId, order: number) => void,
  ): void {
    const D = TABLE_DIMENSIONS;
    const cupRestY = D.surfaceY - 0.118;

    for (const entry of this.balls.values()) {
      if (entry.pocketed) continue;

      if (entry.dropping) {
        entry.dropVelY += CLOTH_PHYSICS.gravity * dt;
        entry.dropY -= entry.dropVelY * dt;

        const cur = entry.body.translation();
        const alpha = 1 - Math.exp(-14 * dt);
        const nx = cur.x + (entry.dropTargetX - cur.x) * alpha;
        const nz = cur.z + (entry.dropTargetZ - cur.z) * alpha;

        if (entry.dropY <= cupRestY) {
          entry.dropY = cupRestY;
          entry.body.setNextKinematicTranslation({
            x: entry.dropTargetX,
            y: cupRestY,
            z: entry.dropTargetZ,
          });
          entry.pocketed = true;
          entry.dropping = false;
          const pid = entry.dropPocketId ?? 'corner-tl';
          if (this.activeTelemetry.active) {
            if (entry.number === 0) {
              this.activeTelemetry.cueBallPocketed = true;
            }
            const recorded = this.pocketEventManager.recordPocket(entry.number, pid);
            if (recorded) {
              onPocketCallback?.(entry.number, pid, recorded.order);
            }
          }
        } else {
          entry.body.setNextKinematicTranslation({ x: nx, y: entry.dropY, z: nz });
        }
        continue;
      }

      const t = entry.body.translation();
      const check = isInsidePocketCaptureZone(t.x, t.z);
      if (check.captured && check.pocketId) {
        entry.dropping = true;
        entry.dropTargetX = check.px;
        entry.dropTargetZ = check.pz;
        entry.dropPocketId = check.pocketId;
        entry.dropY = t.y;
        entry.dropVelY = 0.52;
        entry.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
        entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
  }

  private finalizeShotTelemetry(): ShotTelemetry {
    const settledPositions = this.getAllBallStates();
    const result: ShotTelemetry = {
      shotId: this.activeTelemetry.shotId,
      isBreakShot: this.activeTelemetry.isBreakShot,
      shooter: this.activeTelemetry.shooter,
      calledShot: { ...this.activeTelemetry.calledShot },
      firstBallContacted: this.activeTelemetry.firstBallContacted,
      allBallsContacted: [...this.activeTelemetry.allBallsContacted],
      pocketEvents: this.pocketEventManager.getEvents(),
      cueBallPocketed: this.activeTelemetry.cueBallPocketed,
      railContactBalls: Array.from(this.activeTelemetry.railContactBalls),
      anyBallContactedRail: this.activeTelemetry.anyBallContactedRail,
      settledPositions,
    };
    this.activeTelemetry.active = false;
    return result;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSimulationLoop();
    if (this.initialized) {
      this.eventQueue.free();
      this.world.free();
      this.initialized = false;
    }
  }
}

export const VALID_POCKET_IDS = new Set<PocketId>(
  POCKET_POSITIONS.map((p) => p.id as PocketId),
);
