import RAPIER from '@dimforge/rapier3d-compat';
import type { CueSpin } from '../../store/useGameStore';
import type { BallSettledSnapshot, PlacementZone, PocketId } from '../rules/types';
import {
  BALL_SPECS,
  CLOTH_PHYSICS,
  DRAG_SHOOT_CONFIG,
  POCKET_POSITIONS,
  TABLE_DIMENSIONS,
} from '../utils/constants';

export const BASE_FIXED_DT = 1 / 240;

// Explicit Rapier Collision Groups: (membership << 16) | filter
// Group 0 (0x0001): Billiard balls (collide with balls 0x0001 + table/cushions 0x0002 = 0x0003)
// Group 1 (0x0002): Table slate bed & rubber cushions (collide with balls 0x0001)
export const BALL_COLLISION_GROUPS = (0x0001 << 16) | 0x0003;
export const TABLE_COLLISION_GROUPS = (0x0002 << 16) | 0x0001;

export interface CushionNormal {
  nx: number;
  nz: number;
}

export interface PhysicsBallMapEntry {
  number: number;
  body: RAPIER.RigidBody;
  colliderHandle: number;
  pocketed: boolean;
  dropping?: boolean;
  active?: boolean;
}

export function createConfiguredRapierWorld(): RAPIER.World {
  const w = new RAPIER.World({ x: 0.0, y: -CLOTH_PHYSICS.gravity, z: 0.0 });
  w.timestep = BASE_FIXED_DT;
  w.numSolverIterations = 10;
  w.maxCcdSubsteps = 4;
  w.integrationParameters.normalizedPredictionDistance = 0.0002;
  w.integrationParameters.lengthUnit = 0.05;
  return w;
}

/**
 * Builds identical slate bed, mitered cushions, angled pocket jaws, and outer pocket enclosures
 * for the live simulation world, shadow prediction world, and AI physics simulator.
 */
export function populateRapierTableColliders(
  targetWorld: RAPIER.World,
  cushionSet: Set<number>,
  normalMap: Map<number, CushionNormal>,
): void {
  const D = TABLE_DIMENSIONS;

  const bedHalfThickness = 0.30;
  const bedBody = targetWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  bedBody.setTranslation({ x: 0, y: D.surfaceY - bedHalfThickness, z: 0 }, true);
  const bedCollider = RAPIER.ColliderDesc.cuboid(
    D.halfLength + 0.32,
    bedHalfThickness,
    D.halfWidth + 0.32,
  )
    .setFriction(0.0)
    .setRestitution(0.02)
    .setCollisionGroups(TABLE_COLLISION_GROUPS);
  targetWorld.createCollider(bedCollider, bedBody);

  const wallHalfHeight = 0.042;
  const wallHalfThick = 0.024;
  const wallCenterY = D.surfaceY + 0.036;

  const addCushionBox = (
    x: number,
    z: number,
    hx: number,
    hz: number,
    rotY: number,
    inwardNx: number,
    inwardNz: number,
  ) => {
    const rbDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, wallCenterY, z);
    const halfAngle = rotY * 0.5;
    rbDesc.setRotation({ x: 0, y: Math.sin(halfAngle), z: 0, w: Math.cos(halfAngle) });
    const rb = targetWorld.createRigidBody(rbDesc);
    const colDesc = RAPIER.ColliderDesc.cuboid(hx, wallHalfHeight, hz)
      .setRestitution(CLOTH_PHYSICS.cushionRestitution)
      .setFriction(0.04)
      .setCollisionGroups(TABLE_COLLISION_GROUPS);
    const col = targetWorld.createCollider(colDesc, rb);
    cushionSet.add(col.handle);
    const nLen = Math.hypot(inwardNx, inwardNz) || 1;
    normalMap.set(col.handle, {
      nx: inwardNx / nLen,
      nz: inwardNz / nLen,
    });
  };

  const addMiterJaw = (
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    inwardNx: number,
    inwardNz: number,
  ) => {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const segLen = Math.hypot(dx, dz);
    const jawHalfThick = 0.011;
    const len = Math.hypot(inwardNx, inwardNz) || 1;
    const nx = inwardNx / len;
    const nz = inwardNz / len;
    const cx = (x1 + x2) * 0.5 - nx * jawHalfThick;
    const cz = (z1 + z2) * 0.5 - nz * jawHalfThick;
    const rotY = Math.atan2(-dz, dx);
    addCushionBox(cx, cz, segLen * 0.5, jawHalfThick, rotY, nx, nz);
  };

  const sideNoseBevel = 0.032;
  const cornerNoseBevel = 0.032;
  const longSegStart = D.sideMouthGap + sideNoseBevel;
  const longSegEnd = D.halfLength - D.cornerMouthGap - cornerNoseBevel;
  const longHalfLen = (longSegEnd - longSegStart) * 0.5;
  const longCenter = (longSegStart + longSegEnd) * 0.5;

  for (const zSign of [-1, 1]) {
    const zNose = zSign * D.halfWidth;
    const zCenter = zSign * (D.halfWidth + wallHalfThick);
    const zBack = zSign * (D.halfWidth + D.cushionDepth);

    addCushionBox(-longCenter, zCenter, longHalfLen, wallHalfThick, 0, 0, -zSign);
    addCushionBox(longCenter, zCenter, longHalfLen, wallHalfThick, 0, 0, -zSign);

    addMiterJaw(-longSegStart, zNose, -D.sideMouthGap, zBack, 0.83, -zSign * 0.55);
    addMiterJaw(longSegStart, zNose, D.sideMouthGap, zBack, -0.83, -zSign * 0.55);
  }

  const shortSegEnd = D.halfWidth - D.cornerMouthGap - cornerNoseBevel;
  const shortHalfLen = shortSegEnd;
  for (const xSign of [-1, 1]) {
    const xCenter = xSign * (D.halfLength + wallHalfThick);
    addCushionBox(xCenter, 0, wallHalfThick, shortHalfLen, 0, -xSign, 0);
  }

  for (const p of POCKET_POSITIONS) {
    if (p.isCorner) {
      const sx = Math.sign(p.x);
      const sz = Math.sign(p.z);

      addMiterJaw(
        sx * longSegEnd,
        sz * D.halfWidth,
        sx * (D.halfLength - D.cornerMouthGap),
        sz * (D.halfWidth + D.cushionDepth),
        -sx * 0.83,
        -sz * 0.55,
      );

      addMiterJaw(
        sx * D.halfLength,
        sz * shortSegEnd,
        sx * (D.halfLength + D.cushionDepth),
        sz * (D.halfWidth - D.cornerMouthGap),
        -sx * 0.55,
        -sz * 0.83,
      );
    }

    const backX = p.isCorner ? p.x + Math.sign(p.x) * (p.radius + 0.028) : p.x;
    const backZ = p.z + Math.sign(p.z) * (p.radius + 0.028);
    addCushionBox(
      backX,
      backZ,
      0.10,
      0.024,
      p.isCorner ? -Math.PI * 0.25 * Math.sign(p.x * p.z) : 0,
      p.isCorner ? -Math.sign(p.x) : 0,
      -Math.sign(p.z),
    );
  }
}

export function applyCueStrikeImpulse(
  body: RAPIER.RigidBody,
  aimAngle: number,
  power: number,
  spin: CueSpin,
): void {
  const clampedPower = Math.max(0.02, Math.min(1, power));
  const baseSpeed =
    DRAG_SHOOT_CONFIG.minSpeed +
    clampedPower * (DRAG_SHOOT_CONFIG.maxSpeed - DRAG_SHOOT_CONFIG.minSpeed);

  const rawR = Math.hypot(spin.x, spin.y);
  const maxR = CLOTH_PHYSICS.maxTipOffsetRatio;
  const tipX = rawR > maxR ? (spin.x / rawR) * maxR : spin.x;
  const tipY = rawR > maxR ? (spin.y / rawR) * maxR : spin.y;
  const offsetNorm = Math.min(maxR, Math.hypot(tipX, tipY));

  const efficiency = Math.sqrt(Math.max(0.55, 1 - 0.32 * offsetNorm * offsetNorm));
  const speed = baseSpeed * efficiency;

  const fx = Math.cos(aimAngle);
  const fz = Math.sin(aimAngle);
  const rx = -fz;
  const rz = fx;

  const R = BALL_SPECS.radius;
  const m = BALL_SPECS.mass;
  const I = 0.4 * m * R * R;

  const xOff = tipX * R * 0.72;
  const yOff = tipY * R * 0.76;
  const J = m * speed;

  const spinBoost = 1.65;
  const omegaRollMag = (-yOff * J * spinBoost) / I;
  const omegaSpinY = (xOff * J * 1.45) / I;

  const maxOmegaRoll = (speed / R) * 1.65;
  const maxOmegaY = (speed / R) * 1.35;
  const clampedOmegaRoll = Math.max(-maxOmegaRoll, Math.min(maxOmegaRoll, omegaRollMag));
  const clampedOmegaY = Math.max(-maxOmegaY, Math.min(maxOmegaY, omegaSpinY));

  body.wakeUp();
  body.setLinvel({ x: fx * speed, y: 0, z: fz * speed }, true);
  body.setAngvel(
    {
      x: clampedOmegaRoll * rx,
      y: clampedOmegaY,
      z: clampedOmegaRoll * rz,
    },
    true,
  );
}

export function applyCushionSpinResponse(
  body: RAPIER.RigidBody,
  nx: number,
  nz: number,
): void {
  const w = body.angvel();
  if (Math.abs(w.y) < 0.4) return;

  const v = body.linvel();
  const tx = -nz;
  const tz = nx;

  const R = BALL_SPECS.radius;
  const vt = v.x * tx + v.z * tz;
  const spinSurfaceV = w.y * R;
  const vn = v.x * nx + v.z * nz;

  const speedRef = Math.max(0.4, Math.hypot(v.x, v.z));
  const maxDeltaVt = speedRef * 0.45;
  const rawDeltaVt = -spinSurfaceV * CLOTH_PHYSICS.cushionSpinThrow;
  const deltaVt = Math.max(-maxDeltaVt, Math.min(maxDeltaVt, rawDeltaVt));

  const newVx = v.x + tx * deltaVt;
  const newVz = v.z + tz * deltaVt;

  const preSpeed = Math.hypot(v.x, v.z);
  const postSpeed = Math.hypot(newVx, newVz);
  const maxAllowedSpeed = Math.max(
    preSpeed * 1.02,
    Math.hypot(vn, vt) + Math.abs(deltaVt) * 0.32,
  );
  const scale =
    postSpeed > maxAllowedSpeed && postSpeed > 1e-4 ? maxAllowedSpeed / postSpeed : 1;

  body.setLinvel({ x: newVx * scale, y: 0, z: newVz * scale }, true);
  body.setAngvel({ x: w.x, y: w.y * 0.58, z: w.z }, true);
}

export function applyClothAndSpinForMap(
  map: Map<number, { body: RAPIER.RigidBody; pocketed: boolean; dropping?: boolean; active?: boolean }>,
  dt: number,
): void {
  const D = TABLE_DIMENSIONS;
  const R = BALL_SPECS.radius;
  const restY = D.surfaceY + R;

  const aSlide = CLOTH_PHYSICS.slideMu * CLOTH_PHYSICS.gravity;
  const aRoll = CLOTH_PHYSICS.rollMu * CLOTH_PHYSICS.gravity;

  for (const entry of map.values()) {
    if (entry.pocketed || entry.dropping || entry.active === false) continue;

    const v = entry.body.linvel();
    const w = entry.body.angvel();
    if (
      Math.abs(v.x) < 1e-5 &&
      Math.abs(v.z) < 1e-5 &&
      Math.abs(w.x) < 1e-4 &&
      Math.abs(w.y) < 1e-4 &&
      Math.abs(w.z) < 1e-4
    ) {
      continue;
    }

    const t = entry.body.translation();
    let vx = v.x;
    let vy = v.y;
    let vz = v.z;
    let wx = w.x;
    let wy = w.y;
    let wz = w.z;

    if (t.y > restY + 0.0015 && vy > 0) {
      vy = 0;
    } else if (t.y < restY - 0.0015 && vy < 0) {
      vy = 0;
    }

    const slipX = vx + wz * R;
    const slipZ = vz - wx * R;
    const slipMag = Math.hypot(slipX, slipZ);

    if (slipMag > 0.005) {
      const maxImpulseDv = (2 / 7) * slipMag;
      const dvMag = Math.min(maxImpulseDv, aSlide * dt);
      const dirX = -slipX / slipMag;
      const dirZ = -slipZ / slipMag;

      const dvx = dirX * dvMag;
      const dvz = dirZ * dvMag;

      vx += dvx;
      vz += dvz;
      wx -= (2.5 / R) * dvz;
      wz += (2.5 / R) * dvx;
    } else {
      const speed = Math.hypot(vx, vz);
      if (speed > 1e-4) {
        const decel = Math.min(speed, (aRoll + speed * 0.22) * dt);
        const scale = (speed - decel) / speed;
        vx *= scale;
        vz *= scale;
      } else {
        vx = 0;
        vz = 0;
      }
      wx = vz / R;
      wz = -vx / R;
    }

    if (Math.abs(wy) > 0.01) {
      const wyDecel = Math.min(
        Math.abs(wy),
        (CLOTH_PHYSICS.spinDecayY + Math.abs(wy) * 0.45) * dt,
      );
      wy -= Math.sign(wy) * wyDecel;
    } else {
      wy = 0;
    }

    const finalSpeed = Math.hypot(vx, vz);
    const finalSpin = Math.hypot(wx, wy, wz);
    if (finalSpeed < BALL_SPECS.sleepThreshold && finalSpin < 0.35) {
      entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      entry.body.setLinvel({ x: vx, y: vy, z: vz }, true);
      entry.body.setAngvel({ x: wx, y: wy, z: wz }, true);
    }
  }
}

export function needsNearImpactMicroStep(
  map: Map<number, { body: RAPIER.RigidBody; pocketed: boolean; dropping?: boolean; active?: boolean }>,
  fixedDt = BASE_FIXED_DT,
): boolean {
  const twoR = BALL_SPECS.radius * 2;
  const activeEntries: Array<{ x: number; z: number; speed: number }> = [];

  for (const entry of map.values()) {
    if (entry.pocketed || entry.dropping || entry.active === false) continue;
    const v = entry.body.linvel();
    const t = entry.body.translation();
    activeEntries.push({
      x: t.x,
      z: t.z,
      speed: Math.hypot(v.x, v.z),
    });
  }

  for (let i = 0; i < activeEntries.length; i++) {
    const a = activeEntries[i];
    if (a.speed < 0.25) continue;
    for (let j = 0; j < activeEntries.length; j++) {
      if (i === j) continue;
      const b = activeEntries[j];
      const reach = twoR + (a.speed + b.speed) * fixedDt * 1.45 + 0.006;
      if (Math.hypot(a.x - b.x, a.z - b.z) <= reach) {
        return true;
      }
    }
  }
  return false;
}

export function isInsidePocketCaptureZone(
  x: number,
  z: number,
): {
  captured: boolean;
  px: number;
  pz: number;
  pocketId: PocketId | null;
} {
  const D = TABLE_DIMENSIONS;
  for (const pocket of POCKET_POSITIONS) {
    const dx = x - pocket.x;
    const dz = z - pocket.z;
    const distSq = dx * dx + dz * dz;

    if (pocket.isCorner) {
      const captureR = pocket.radius * 0.90;
      const pastJawEntrance =
        Math.abs(x) > D.halfLength - 0.044 || Math.abs(z) > D.halfWidth - 0.044;
      if (pastJawEntrance && distSq < captureR * captureR) {
        return {
          captured: true,
          px: pocket.x,
          pz: pocket.z,
          pocketId: pocket.id as PocketId,
        };
      }
    } else {
      const captureR = pocket.radius * 0.86;
      const insideThroat =
        Math.abs(x) < D.sideMouthGap * 0.88 && Math.abs(z) > D.halfWidth - 0.022;
      if (insideThroat && distSq < captureR * captureR) {
        return {
          captured: true,
          px: pocket.x,
          pz: pocket.z,
          pocketId: pocket.id as PocketId,
        };
      }
    }
  }
  return { captured: false, px: 0, pz: 0, pocketId: null };
}

export function validateCuePlacementAgainstBalls(
  x: number,
  z: number,
  balls: BallSettledSnapshot[],
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
  for (const ball of balls) {
    if (ball.number === 0 || ball.pocketed) continue;
    const dx = clampedX - ball.x;
    const dz = clampedZ - ball.z;
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
