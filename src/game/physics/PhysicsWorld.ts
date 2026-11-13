import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { CueSpin } from '../../store/useGameStore';
import { computeInitialBallPositions } from '../objects/BilliardBalls';
import { PocketEventManager } from '../rules/PocketEventManager';
import type { BallRackCoordinate } from '../rules/RackGenerator';
import type {
  BallSettledSnapshot,
  CalledShot,
  PlacementZone,
  PlayerId,
  PocketId,
  ShotTelemetry,
} from '../rules/types';
import {
  BALL_SPECS,
  CLOTH_PHYSICS,
  POCKET_POSITIONS,
  TABLE_DIMENSIONS,
} from '../utils/constants';
import { soundEngine } from '../utils/SoundEngine';
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
} from './RapierTableCore';

export interface BallPhysicsSnapshot {
  number: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  pocketed: boolean;
}

export interface AimTrajectoryPrediction {
  cuePath: Array<{ x: number; z: number }>;
  cuePostPath: Array<{ x: number; z: number }>;
  targetPath: Array<{ x: number; z: number }>;
  hitType: 'ball' | 'cushion' | 'pocket' | 'none';
  ghostBallX: number | null;
  ghostBallZ: number | null;
  targetPocketed: boolean;
  cuePocketed: boolean;
}

interface BallBodyEntry {
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

interface PredBallEntry {
  number: number;
  body: RAPIER.RigidBody;
  colliderHandle: number;
  active: boolean;
  pocketed: boolean;
}

export class PhysicsWorld {
  private world!: RAPIER.World;
  private eventQueue!: RAPIER.EventQueue;
  private balls = new Map<number, BallBodyEntry>();
  private colliderToBall = new Map<number, number>();
  private cushionColliderHandles = new Set<number>();
  private cushionNormals = new Map<number, CushionNormal>();

  // Isolated shadow simulation world for physics-consistent trajectory prediction
  private predWorld!: RAPIER.World;
  private predEventQueue!: RAPIER.EventQueue;
  private predBalls = new Map<number, PredBallEntry>();
  private predColliderToBall = new Map<number, number>();
  private predCushionHandles = new Set<number>();
  private predCushionNormals = new Map<number, CushionNormal>();

  private lastPredKey = '';
  private lastPredResult: AimTrajectoryPrediction | null = null;
  private worldVersion = 0;

  private initialized = false;
  private accumulator = 0;

  private onBallPocketed?: (ballNumber: number, pocketId: PocketId) => void;

  // Authoritative per-shot physics telemetry (collected strictly from Rapier simulation events)
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

  public async init(
    onBallPocketed?: (ballNumber: number, pocketId: PocketId) => void,
  ): Promise<void> {
    this.onBallPocketed = onBallPocketed;
    await RAPIER.init();

    this.world = this.createConfiguredWorld();
    this.eventQueue = new RAPIER.EventQueue(true);
    this.populateTableColliders(
      this.world,
      this.cushionColliderHandles,
      this.cushionNormals,
    );
    this.buildLiveBallBodies();

    this.predWorld = this.createConfiguredWorld();
    this.predEventQueue = new RAPIER.EventQueue(true);
    this.populateTableColliders(
      this.predWorld,
      this.predCushionHandles,
      this.predCushionNormals,
    );
    this.buildPredictionBallBodies();

    this.initialized = true;
  }

  private readonly baseFixedDt = BASE_FIXED_DT;

  private createConfiguredWorld(): RAPIER.World {
    return createConfiguredRapierWorld();
  }

  private populateTableColliders(
    targetWorld: RAPIER.World,
    cushionSet: Set<number>,
    normalMap: Map<number, CushionNormal>,
  ) {
    populateRapierTableColliders(targetWorld, cushionSet, normalMap);
  }

  private buildLiveBallBodies() {
    const initial = computeInitialBallPositions();

    for (const pos of initial) {
      const rbDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setLinearDamping(BALL_SPECS.linearDamping)
        .setAngularDamping(BALL_SPECS.angularDamping)
        .setCcdEnabled(true)
        .setCanSleep(false); // Keep balls awake so low-speed collisions never bounce off sleeping walls

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
  }

  private buildPredictionBallBodies() {
    const initial = computeInitialBallPositions();
    for (const pos of initial) {
      const rbDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setLinearDamping(BALL_SPECS.linearDamping)
        .setAngularDamping(BALL_SPECS.angularDamping)
        .setCcdEnabled(true)
        .setCanSleep(false);

      const body = this.predWorld.createRigidBody(rbDesc);
      const colDesc = RAPIER.ColliderDesc.ball(BALL_SPECS.radius)
        .setMass(BALL_SPECS.mass)
        .setRestitution(0.94)
        .setFriction(0.03)
        .setCollisionGroups(BALL_COLLISION_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

      const collider = this.predWorld.createCollider(colDesc, body);
      this.predBalls.set(pos.number, {
        number: pos.number,
        body,
        colliderHandle: collider.handle,
        active: true,
        pocketed: false,
      });
      this.predColliderToBall.set(collider.handle, pos.number);
    }
  }

  private applyCueStrikeImpulse(
    body: RAPIER.RigidBody,
    aimAngle: number,
    power: number,
    spin: CueSpin,
  ) {
    applyCueStrikeImpulse(body, aimAngle, power, spin);
  }

  public strikeCueBall(
    aimAngle: number,
    power: number,
    spin: CueSpin = { x: 0, y: 0 },
  ) {
    if (!this.initialized) return;
    const cue = this.balls.get(0);
    if (!cue || cue.pocketed || cue.dropping) return;

    // Ensure all active balls are awake before shot impact
    for (const entry of this.balls.values()) {
      if (!entry.pocketed && !entry.dropping) {
        entry.body.wakeUp();
      }
    }

    this.applyCueStrikeImpulse(cue.body, aimAngle, power, spin);
    this.worldVersion++;
  }

  public beginShotTelemetry(
    shotId: number,
    isBreakShot: boolean,
    shooter: PlayerId,
    calledShot: CalledShot = { targetBall: null, targetPocket: null },
  ) {
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
  }

  public finalizeShotTelemetry(): ShotTelemetry {
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

  public getWorldVersion(): number {
    return this.worldVersion;
  }

  public getBallVelocities(): Map<number, { vx: number; vz: number }> {
    const map = new Map<number, { vx: number; vz: number }>();
    for (const entry of this.balls.values()) {
      const v = entry.body.linvel();
      map.set(entry.number, { vx: v.x, vz: v.z });
    }
    return map;
  }

  public getAllBallStates(): BallSettledSnapshot[] {
    const list: BallSettledSnapshot[] = [];
    for (const entry of this.balls.values()) {
      const t = entry.body.translation();
      list.push({
        number: entry.number,
        x: t.x,
        z: t.z,
        pocketed: entry.pocketed || entry.dropping,
      });
    }
    return list;
  }

  public validateCueBallPlacement(
    x: number,
    z: number,
    zone: PlacementZone,
  ): { valid: boolean; reason?: string; clampedX: number; clampedZ: number } {
    const D = TABLE_DIMENSIONS;
    const R = BALL_SPECS.radius;
    const margin = R + 0.012;
    const minX = -D.halfLength + margin;
    const maxX = zone === 'kitchen' ? D.headSpotX : D.halfLength - margin;
    const maxZ = D.halfWidth - margin;

    const clampedX = Math.max(minX, Math.min(maxX, x));
    const clampedZ = Math.max(-maxZ, Math.min(maxZ, z));

    if (zone === 'kitchen' && x > D.headSpotX + 0.002) {
      return {
        valid: false,
        reason: 'Cue ball must be placed behind the head string (kitchen).',
        clampedX,
        clampedZ,
      };
    }

    if (Math.abs(x) > D.halfLength - margin + 0.002 || Math.abs(z) > maxZ + 0.002) {
      return {
        valid: false,
        reason: 'Cue ball must stay inside the table rails.',
        clampedX,
        clampedZ,
      };
    }

    const minDistSq = (R * 2.06) ** 2;
    for (const [num, entry] of this.balls) {
      if (num === 0 || entry.pocketed || entry.dropping) continue;
      const t = entry.body.translation();
      const dx = clampedX - t.x;
      const dz = clampedZ - t.z;
      if (dx * dx + dz * dz < minDistSq) {
        return {
          valid: false,
          reason: 'Cue ball cannot overlap another ball.',
          clampedX,
          clampedZ,
        };
      }
    }

    for (const pocket of POCKET_POSITIONS) {
      const dx = clampedX - pocket.x;
      const dz = clampedZ - pocket.z;
      const minP = pocket.radius + R * 0.7;
      if (dx * dx + dz * dz < minP * minP) {
        return {
          valid: false,
          reason: 'Cue ball cannot be placed inside a pocket.',
          clampedX,
          clampedZ,
        };
      }
    }

    return { valid: true, clampedX, clampedZ };
  }

  public findNearestValidCuePlacement(zone: PlacementZone): { x: number; z: number } {
    const D = TABLE_DIMENSIONS;
    const R = BALL_SPECS.radius;

    // Try head spot first
    const headCheck = this.validateCueBallPlacement(D.headSpotX, 0, zone);
    if (headCheck.valid) return { x: headCheck.clampedX, z: headCheck.clampedZ };

    const minX = -D.halfLength + R + 0.06;
    const maxX = zone === 'kitchen' ? D.headSpotX : D.halfLength - R - 0.06;
    const maxZ = D.halfWidth - R - 0.06;

    for (let x = Math.min(D.headSpotX, maxX); x >= minX; x -= 0.055) {
      for (let stepZ = 0; stepZ <= maxZ; stepZ += 0.055) {
        for (const z of stepZ === 0 ? [0] : [stepZ, -stepZ]) {
          const check = this.validateCueBallPlacement(x, z, zone);
          if (check.valid) return { x: check.clampedX, z: check.clampedZ };
        }
      }
    }

    return { x: D.headSpotX, z: 0 };
  }

  public setCueBallPlacement(x: number, z: number) {
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
    this.worldVersion++;
  }

  public setBallState(ballNumber: number, x: number, z: number, pocketed = false) {
    if (!this.initialized) return;
    const entry = this.balls.get(ballNumber);
    if (!entry) return;
    const D = TABLE_DIMENSIONS;
    const y = pocketed ? D.surfaceY - 0.118 : D.surfaceY + BALL_SPECS.radius;

    entry.pocketed = pocketed;
    entry.dropping = false;
    entry.dropPocketId = null;
    entry.dropVelY = 0;
    entry.dropY = y;
    entry.lastValidX = x;
    entry.lastValidY = y;
    entry.lastValidZ = z;
    entry.body.setBodyType(
      pocketed ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic,
      true,
    );
    entry.body.setTranslation({ x, y, z }, true);
    entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (!pocketed) entry.body.wakeUp();
    this.worldVersion++;
  }

  public syncAllFromServerFrames(
    frames: Array<{
      number: number;
      x: number;
      y: number;
      z: number;
      qx: number;
      qy: number;
      qz: number;
      qw: number;
      pocketed: boolean;
    }>,
  ) {
    if (!this.initialized) return;
    for (const f of frames) {
      const entry = this.balls.get(f.number);
      if (!entry) continue;
      entry.pocketed = f.pocketed;
      entry.dropping = false;
      entry.dropPocketId = null;
      entry.dropVelY = 0;
      entry.dropY = f.y;
      entry.lastValidX = f.x;
      entry.lastValidY = f.y;
      entry.lastValidZ = f.z;
      entry.body.setBodyType(
        f.pocketed ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic,
        true,
      );
      entry.body.setTranslation({ x: f.x, y: f.y, z: f.z }, true);
      entry.body.setRotation({ x: f.qx, y: f.qy, z: f.qz, w: f.qw }, true);
      entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.worldVersion++;
  }

  public respotEightBall() {
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
    this.worldVersion++;
  }

  public respotCueBall() {
    if (!this.initialized) return;
    const cue = this.balls.get(0);
    if (!cue) return;

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
    this.worldVersion++;
  }

  public resetRack(customPositions?: BallRackCoordinate[]) {
    if (!this.initialized) return;
    const initial = customPositions ?? computeInitialBallPositions();
    for (const pos of initial) {
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
    this.worldVersion++;
  }

  private needsNearImpactMicroStep(
    map: Map<number, { body: RAPIER.RigidBody; pocketed: boolean; dropping?: boolean; active?: boolean }>,
  ): boolean {
    return needsNearImpactMicroStep(map, this.baseFixedDt);
  }

  public step(deltaSec: number) {
    if (!this.initialized) return;

    const fixedDt = this.baseFixedDt;
    this.accumulator = Math.min(this.accumulator + deltaSec, 0.08);

    let stepped = false;
    while (this.accumulator >= fixedDt) {
      if (this.needsNearImpactMicroStep(this.balls)) {
        const subDt = fixedDt / 4;
        this.world.timestep = subDt;
        for (let s = 0; s < 4; s++) {
          this.world.step(this.eventQueue);
          this.processCollisionEvents();
          this.applyClothAndSpinForMap(this.balls, subDt);
          this.enforceTableSafetyAndRecovery();
          this.checkPocketsAndDrop(subDt);
        }
        this.world.timestep = fixedDt;
      } else {
        this.world.step(this.eventQueue);
        this.processCollisionEvents();
        this.applyClothAndSpinForMap(this.balls, fixedDt);
        this.enforceTableSafetyAndRecovery();
        this.checkPocketsAndDrop(fixedDt);
      }
      this.accumulator -= fixedDt;
      stepped = true;
    }

    if (stepped && this.areAnyBallsMoving()) {
      this.worldVersion++;
    }
  }

  private processCollisionEvents() {
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;

      const b1 = this.colliderToBall.get(h1);
      const b2 = this.colliderToBall.get(h2);

      if (b1 !== undefined && b2 !== undefined) {
        // Let Rapier resolve ball-to-ball momentum transfer cleanly without modifying velocities here
        const e1 = this.balls.get(b1);
        const e2 = this.balls.get(b2);
        if (!e1 || !e2 || e1.pocketed || e2.pocketed || e1.dropping || e2.dropping) return;

        // Record cue-to-object ball contact telemetry
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

        const v1 = e1.body.linvel();
        const v2 = e2.body.linvel();
        const relSpeed = Math.hypot(v1.x - v2.x, v1.z - v2.z);
        if (relSpeed > 0.08) {
          soundEngine.playBallClack(relSpeed);
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

          const v = e.body.linvel();
          const speed = Math.hypot(v.x, v.z);
          if (speed > 0.12) {
            soundEngine.playCushionBounce(speed);
          }

          const cNorm = this.cushionNormals.get(other);
          if (cNorm) {
            this.applyCushionSpinResponse(e.body, cNorm.nx, cNorm.nz);
          }
        }
      }
    });
  }

  private applyCushionSpinResponse(body: RAPIER.RigidBody, nx: number, nz: number) {
    applyCushionSpinResponse(body, nx, nz);
  }

  private applyClothAndSpinForMap(
    map: Map<number, { body: RAPIER.RigidBody; pocketed: boolean; dropping?: boolean }>,
    dt: number,
  ) {
    applyClothAndSpinForMap(map, dt);
  }

  private enforceTableSafetyAndRecovery() {
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
        const safeX = THREE.MathUtils.clamp(
          Number.isFinite(entry.lastValidX) ? entry.lastValidX : 0,
          -D.halfLength + R * 1.1,
          D.halfLength - R * 1.1,
        );
        const safeZ = THREE.MathUtils.clamp(
          Number.isFinite(entry.lastValidZ) ? entry.lastValidZ : 0,
          -D.halfWidth + R * 1.1,
          D.halfWidth - R * 1.1,
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

  private isInsidePocketCaptureZone(x: number, z: number): {
    captured: boolean;
    px: number;
    pz: number;
    pocketId: PocketId | null;
  } {
    return isInsidePocketCaptureZone(x, z);
  }

  private checkPocketsAndDrop(dt: number) {
    const D = TABLE_DIMENSIONS;
    const cupRestY = D.surfaceY - 0.118;

    for (const entry of this.balls.values()) {
      if (entry.pocketed) continue;

      if (entry.dropping) {
        entry.dropVelY += CLOTH_PHYSICS.gravity * dt;
        entry.dropY -= entry.dropVelY * dt;

        const cur = entry.body.translation();
        const nx = THREE.MathUtils.lerp(cur.x, entry.dropTargetX, 1 - Math.exp(-14 * dt));
        const nz = THREE.MathUtils.lerp(cur.z, entry.dropTargetZ, 1 - Math.exp(-14 * dt));

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
            this.pocketEventManager.recordPocket(entry.number, pid);
          }
          this.onBallPocketed?.(entry.number, pid);
          this.worldVersion++;
        } else {
          entry.body.setNextKinematicTranslation({ x: nx, y: entry.dropY, z: nz });
        }
        continue;
      }

      const t = entry.body.translation();
      const check = this.isInsidePocketCaptureZone(t.x, t.z);
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
        soundEngine.playPocketDrop();
      }
    }
  }

  public getCueBallPosition(out: THREE.Vector3): THREE.Vector3 {
    const cue = this.balls.get(0);
    if (!cue || !this.initialized) {
      return out.set(
        TABLE_DIMENSIONS.headSpotX,
        TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius,
        0,
      );
    }
    const t = cue.body.translation();
    return out.set(t.x, t.y, t.z);
  }

  public isCueBallAvailable(): boolean {
    const cue = this.balls.get(0);
    return Boolean(cue && !cue.pocketed && !cue.dropping);
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

  /**
   * Runs an isolated, non-destructive shadow Rapier physics simulation using the exact
   * table colliders, ball masses, radii, timestep, and shot spin/power parameters.
   * Cached by shot parameters and live world version so idle rendering incurs zero overhead.
   */
  public predictAimTrajectory(
    aimAngle: number,
    spin: CueSpin = { x: 0, y: 0 },
    power = 0.58,
  ): AimTrajectoryPrediction | null {
    if (!this.initialized) return null;
    const cueLive = this.balls.get(0);
    if (!cueLive || cueLive.pocketed || cueLive.dropping) return null;

    const effectivePower = Math.max(0.22, Math.min(1, power));
    const predKey = `${this.worldVersion}|${aimAngle.toFixed(4)}|${spin.x.toFixed(3)}|${spin.y.toFixed(3)}|${effectivePower.toFixed(3)}`;
    if (predKey === this.lastPredKey && this.lastPredResult) {
      return this.lastPredResult;
    }

    const restY = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;

    // 1. Mirror live ball state into shadow prediction world
    for (const [num, live] of this.balls) {
      const pred = this.predBalls.get(num)!;
      pred.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      pred.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

      if (live.pocketed || live.dropping) {
        pred.active = false;
        pred.pocketed = true;
        pred.body.setTranslation({ x: 10 + num * 0.25, y: restY, z: 10 }, true);
      } else {
        const t = live.body.translation();
        pred.active = true;
        pred.pocketed = false;
        pred.body.setTranslation({ x: t.x, y: restY, z: t.z }, true);
      }
    }

    const predCue = this.predBalls.get(0)!;
    const cueStart = predCue.body.translation();
    this.applyCueStrikeImpulse(predCue.body, aimAngle, effectivePower, spin);

    const cuePath: Array<{ x: number; z: number }> = [{ x: cueStart.x, z: cueStart.z }];
    const cuePostPath: Array<{ x: number; z: number }> = [];
    const targetPath: Array<{ x: number; z: number }> = [];

    let hitType: 'ball' | 'cushion' | 'pocket' | 'none' = 'none';
    let ghostBallX: number | null = null;
    let ghostBallZ: number | null = null;
    let firstTargetNum: number | null = null;
    let cuePocketed = false;
    let targetPocketed = false;
    let cueBounceCount = 0;

    let lastCueSampleX = cueStart.x;
    let lastCueSampleZ = cueStart.z;
    let lastTargetSampleX = 0;
    let lastTargetSampleZ = 0;

    const fixedDt = this.baseFixedDt;
    const maxSteps = 288; // 1.2 seconds of true physics trajectory at 240Hz (960Hz near impact)
    let postImpactSteps = 0;

    for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
      // Full 960Hz micro-stepping up to & through primary target impact; skip 4x micro-steps during multi-ball break scatters
      const useMicro =
        (firstTargetNum === null || postImpactSteps < 2) &&
        this.needsNearImpactMicroStep(this.predBalls);
      const subCount = useMicro ? 4 : 1;
      const stepDt = fixedDt / subCount;
      this.predWorld.timestep = stepDt;

      let cueHitBallThisStep: number | null = null;
      let cueHitCushionThisStep = false;

      for (let sub = 0; sub < subCount; sub++) {
        this.predWorld.step(this.predEventQueue);

        this.predEventQueue.drainCollisionEvents((h1, h2, started) => {
          if (!started) return;
          const b1 = this.predColliderToBall.get(h1);
          const b2 = this.predColliderToBall.get(h2);

          if (b1 !== undefined && b2 !== undefined) {
            if (b1 === 0 && cueHitBallThisStep === null) cueHitBallThisStep = b2;
            else if (b2 === 0 && cueHitBallThisStep === null) cueHitBallThisStep = b1;
          } else {
            const bNum = b1 !== undefined ? b1 : b2;
            const other = b1 !== undefined ? h2 : h1;
            if (bNum !== undefined && this.predCushionHandles.has(other)) {
              const pEntry = this.predBalls.get(bNum);
              if (pEntry && !pEntry.pocketed) {
                const cNorm = this.predCushionNormals.get(other);
                if (cNorm) {
                  this.applyCushionSpinResponse(pEntry.body, cNorm.nx, cNorm.nz);
                }
                if (bNum === 0) cueHitCushionThisStep = true;
              }
            }
          }
        });

        this.applyClothAndSpinForMap(this.predBalls, stepDt);
      }

      if (useMicro) {
        this.predWorld.timestep = fixedDt;
      }

      // Check pocket captures in prediction world
      for (const pEntry of this.predBalls.values()) {
        if (!pEntry.active || pEntry.pocketed) continue;
        const pt = pEntry.body.translation();
        const pCheck = this.isInsidePocketCaptureZone(pt.x, pt.z);
        if (pCheck.captured) {
          pEntry.pocketed = true;
          pEntry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          pEntry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          pEntry.body.setTranslation({ x: pCheck.px, y: restY, z: pCheck.pz }, true);

          if (pEntry.number === 0) {
            cuePocketed = true;
            if (hitType === 'none') {
              hitType = 'pocket';
              ghostBallX = pCheck.px;
              ghostBallZ = pCheck.pz;
            }
            if (firstTargetNum === null) {
              cuePath.push({ x: pCheck.px, z: pCheck.pz });
            } else {
              cuePostPath.push({ x: pCheck.px, z: pCheck.pz });
            }
          } else if (pEntry.number === firstTargetNum) {
            targetPocketed = true;
            targetPath.push({ x: pCheck.px, z: pCheck.pz });
          }
        }
      }

      const ct = predCue.body.translation();

      // Record first ball impact
      if (firstTargetNum === null && cueHitBallThisStep !== null) {
        firstTargetNum = cueHitBallThisStep;
        hitType = 'ball';
        ghostBallX = ct.x;
        ghostBallZ = ct.z;
        cuePath.push({ x: ct.x, z: ct.z });
        cuePostPath.push({ x: ct.x, z: ct.z });

        const targetObj = this.predBalls.get(firstTargetNum)!;
        const tt = targetObj.body.translation();
        targetPath.push({ x: tt.x, z: tt.z });
        lastTargetSampleX = tt.x;
        lastTargetSampleZ = tt.z;
        lastCueSampleX = ct.x;
        lastCueSampleZ = ct.z;
      } else if (firstTargetNum === null && cueHitCushionThisStep) {
        cueBounceCount++;
        cuePath.push({ x: ct.x, z: ct.z });
        lastCueSampleX = ct.x;
        lastCueSampleZ = ct.z;
        if (hitType === 'none') {
          hitType = 'cushion';
          ghostBallX = ct.x;
          ghostBallZ = ct.z;
        }
        if (cueBounceCount >= 2) break;
      }

      if (firstTargetNum !== null) {
        postImpactSteps++;
      }

      // Sample cue path
      if (!cuePocketed) {
        if (firstTargetNum === null) {
          if (Math.hypot(ct.x - lastCueSampleX, ct.z - lastCueSampleZ) >= 0.025) {
            cuePath.push({ x: ct.x, z: ct.z });
            lastCueSampleX = ct.x;
            lastCueSampleZ = ct.z;
          }
        } else if (cuePostPath.length < 60) {
          if (Math.hypot(ct.x - lastCueSampleX, ct.z - lastCueSampleZ) >= 0.022) {
            cuePostPath.push({ x: ct.x, z: ct.z });
            lastCueSampleX = ct.x;
            lastCueSampleZ = ct.z;
          }
        }
      }

      // Sample target ball path
      if (firstTargetNum !== null && !targetPocketed) {
        const targetObj = this.predBalls.get(firstTargetNum)!;
        const tt = targetObj.body.translation();
        if (Math.hypot(tt.x - lastTargetSampleX, tt.z - lastTargetSampleZ) >= 0.025) {
          targetPath.push({ x: tt.x, z: tt.z });
          lastTargetSampleX = tt.x;
          lastTargetSampleZ = tt.z;
        }
      }

      // Stop early once relevant balls settle or break-cluster trace limit reached
      const cv = predCue.body.linvel();
      const cueSpeed = Math.hypot(cv.x, cv.z);
      if (firstTargetNum === null && (cuePocketed || cueSpeed < 0.03)) {
        if (!cuePocketed) cuePath.push({ x: ct.x, z: ct.z });
        break;
      }
      if (firstTargetNum !== null) {
        const tv = this.predBalls.get(firstTargetNum)!.body.linvel();
        const targetSpeed = Math.hypot(tv.x, tv.z);
        if ((cuePocketed || cueSpeed < 0.03) && (targetPocketed || targetSpeed < 0.03)) {
          break;
        }
        // Keep break-shot prediction responsive when many balls scatter simultaneously
        if (postImpactSteps >= 12) {
          let movingBalls = 0;
          for (const pEntry of this.predBalls.values()) {
            if (!pEntry.active || pEntry.pocketed) continue;
            const pv = pEntry.body.linvel();
            if (Math.hypot(pv.x, pv.z) > 0.15) movingBalls++;
          }
          if (movingBalls >= 5) break;
        }
      }
    }

    const result: AimTrajectoryPrediction = {
      cuePath,
      cuePostPath,
      targetPath,
      hitType,
      ghostBallX,
      ghostBallZ,
      targetPocketed,
      cuePocketed,
    };

    this.lastPredKey = predKey;
    this.lastPredResult = result;
    return result;
  }

  public getSnapshots(out: BallPhysicsSnapshot[]): BallPhysicsSnapshot[] {
    out.length = 0;
    if (!this.initialized) return out;

    for (const entry of this.balls.values()) {
      const t = entry.body.translation();
      const r = entry.body.rotation();
      out.push({
        number: entry.number,
        x: t.x,
        y: t.y,
        z: t.z,
        qx: r.x,
        qy: r.y,
        qz: r.z,
        qw: r.w,
        pocketed: entry.pocketed,
      });
    }
    return out;
  }

  public dispose() {
    if (this.initialized) {
      this.eventQueue.free();
      this.world.free();
      this.predEventQueue.free();
      this.predWorld.free();
      this.initialized = false;
    }
  }
}
