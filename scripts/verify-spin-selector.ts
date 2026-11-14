import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import {
  clampSpinToCircle,
  describeCueSpin,
  mapClientPointToCueSpin,
} from '../src/components/CueBallSpinControl';
import { PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import {
  applyCueStrikeImpulse,
  createConfiguredRapierWorld,
} from '../src/game/physics/RapierTableCore';
import { BALL_SPECS, CLOTH_PHYSICS, TABLE_DIMENSIONS } from '../src/game/utils/constants';
import { useGameStore } from '../src/store/useGameStore';

async function main() {
  const MAX_R = CLOTH_PHYSICS.maxTipOffsetRatio; // 0.78
  const rect = { left: 100, top: 200, width: 80, height: 80 };
  const cx = rect.left + rect.width / 2; // 140
  const cy = rect.top + rect.height / 2; // 240
  const r = rect.width / 2; // 40

  // 1. Store starts centered
  useGameStore.getState().resetMatchStats();
  assert.deepEqual(useGameStore.getState().cueSpin, { x: 0, y: 0 });
  assert.equal(describeCueSpin(0, 0), 'Center');

  // 2. All 9 impact regions map accurately
  const center = mapClientPointToCueSpin(cx, cy, rect);
  assert.deepEqual(center, { x: 0, y: 0 });
  assert.equal(describeCueSpin(center.x, center.y), 'Center');

  const top = mapClientPointToCueSpin(cx, cy - r * 0.7, rect);
  assert(top.y > 0.65 && Math.abs(top.x) < 1e-6);
  assert.equal(describeCueSpin(top.x, top.y), 'Top Spin');

  const bottom = mapClientPointToCueSpin(cx, cy + r * 0.7, rect);
  assert(bottom.y < -0.65 && Math.abs(bottom.x) < 1e-6);
  assert.equal(describeCueSpin(bottom.x, bottom.y), 'Back Spin');

  const left = mapClientPointToCueSpin(cx - r * 0.7, cy, rect);
  assert(left.x < -0.65 && Math.abs(left.y) < 1e-6);
  assert.equal(describeCueSpin(left.x, left.y), 'Left Spin');

  const right = mapClientPointToCueSpin(cx + r * 0.7, cy, rect);
  assert(right.x > 0.65 && Math.abs(right.y) < 1e-6);
  assert.equal(describeCueSpin(right.x, right.y), 'Right Spin');

  const topLeft = mapClientPointToCueSpin(cx - r * 0.55, cy - r * 0.55, rect);
  assert(topLeft.x < -0.4 && topLeft.y > 0.4);
  assert.equal(describeCueSpin(topLeft.x, topLeft.y), 'Top-Left');

  const topRight = mapClientPointToCueSpin(cx + r * 0.55, cy - r * 0.55, rect);
  assert(topRight.x > 0.4 && topRight.y > 0.4);
  assert.equal(describeCueSpin(topRight.x, topRight.y), 'Top-Right');

  const backLeft = mapClientPointToCueSpin(cx - r * 0.55, cy + r * 0.55, rect);
  assert(backLeft.x < -0.4 && backLeft.y < -0.4);
  assert.equal(describeCueSpin(backLeft.x, backLeft.y), 'Back-Left');

  const backRight = mapClientPointToCueSpin(cx + r * 0.55, cy + r * 0.55, rect);
  assert(backRight.x > 0.4 && backRight.y < -0.4);
  assert.equal(describeCueSpin(backRight.x, backRight.y), 'Back-Right');

  // 3. Circular boundary clamping even when pointer drags far outside the square/circle
  const farCorner = mapClientPointToCueSpin(cx + r * 5, cy - r * 5, rect);
  const farDist = Math.hypot(farCorner.x, farCorner.y);
  assert(Math.abs(farDist - MAX_R) < 1e-6, `Expected radius ${MAX_R}, got ${farDist}`);
  assert(farCorner.x > 0 && farCorner.y > 0);

  const clampedDirect = clampSpinToCircle(-2, -2);
  assert(Math.abs(Math.hypot(clampedDirect.x, clampedDirect.y) - MAX_R) < 1e-6);

  // 4. Store clamping & reset
  useGameStore.getState().setCueSpin(topRight.x, topRight.y);
  assert.deepEqual(useGameStore.getState().cueSpin, topRight);
  useGameStore.getState().resetCueSpin();
  assert.deepEqual(useGameStore.getState().cueSpin, { x: 0, y: 0 });

  console.log('PASS [1] All 9 impact regions, circular boundary clamp, and store state verified');

  // 5. Direct Rapier strike angular velocity verification
  await RAPIER.init();
  const measureStrikeAngVel = (spin: { x: number; y: number }) => {
    const world = createConfiguredRapierWorld();
    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius, 0);
    const body = world.createRigidBody(rbDesc);
    world.createCollider(RAPIER.ColliderDesc.ball(BALL_SPECS.radius).setMass(BALL_SPECS.mass), body);
    applyCueStrikeImpulse(body, 0, 0.72, spin);
    const w = body.angvel();
    world.free();
    return { x: w.x, y: w.y, z: w.z };
  };

  const centerW = measureStrikeAngVel({ x: 0, y: 0 });
  const topW = measureStrikeAngVel({ x: 0, y: 0.78 });
  const backW = measureStrikeAngVel({ x: 0, y: -0.78 });
  const leftW = measureStrikeAngVel({ x: -0.78, y: 0 });
  const rightW = measureStrikeAngVel({ x: 0.78, y: 0 });
  const diagW = measureStrikeAngVel(topRight);

  assert.equal(centerW.y, 0);
  assert.equal(centerW.z, 0);
  assert(topW.z < -20, `Expected negative Z roll for top spin, got ${topW.z}`);
  assert(backW.z > 20, `Expected positive Z draw spin, got ${backW.z}`);
  assert(leftW.y < -15, `Left English should yield negative Y spin, got ${leftW.y}`);
  assert(rightW.y > 15, `Right English should yield positive Y spin, got ${rightW.y}`);
  assert(diagW.z < -10 && diagW.y > 10, `Expected combined diagonal spin, got ${JSON.stringify(diagW)}`);

  // 6. Full PhysicsWorld simulation checks (follow, draw, and English cushion throw)
  const physics = new PhysicsWorld();
  await physics.init();
  const cuePosOut = new THREE.Vector3();

  const runHeadOnShot = (spin: { x: number; y: number }) => {
    physics.resetRack();
    for (let n = 2; n <= 15; n++) {
      physics.setBallState(n, 0, 0, true);
    }
    physics.setBallState(0, -0.35, 0, false);
    physics.setBallState(1, 0.05, 0, false);
    physics.strikeCueBall(0, 0.72, spin);
    for (let i = 0; i < 180; i++) {
      physics.step(1 / 60);
    }
    return physics.getCueBallPosition(cuePosOut).x;
  };

  const centerAfterX = runHeadOnShot({ x: 0, y: 0 });
  const topAfterX = runHeadOnShot({ x: 0, y: 0.78 });
  const backAfterX = runHeadOnShot({ x: 0, y: -0.78 });

  assert(
    topAfterX > centerAfterX + 0.15,
    `Top spin should follow further forward (${topAfterX} vs ${centerAfterX})`,
  );
  assert(
    backAfterX < -0.02,
    `Back spin should draw cue ball backward behind contact (got x=${backAfterX})`,
  );

  // Side spin cushion throw check: shoot perpendicular into top cushion (-Z direction) away from side pocket
  const runCushionEnglishShot = (spinX: number) => {
    physics.resetRack();
    for (let n = 1; n <= 15; n++) {
      physics.setBallState(n, 0, 0, true);
    }
    physics.setBallState(0, -0.5, 0, false);
    physics.strikeCueBall(-Math.PI / 2, 0.65, { x: spinX, y: 0 });
    for (let i = 0; i < 90; i++) {
      physics.step(1 / 60);
    }
    return physics.getCueBallPosition(cuePosOut).x;
  };

  const leftReboundX = runCushionEnglishShot(-0.78);
  const rightReboundX = runCushionEnglishShot(0.78);
  assert(leftReboundX < -0.55, `Left English should throw rebound left from -0.5, got x=${leftReboundX}`);
  assert(rightReboundX > -0.45, `Right English should throw rebound right from -0.5, got x=${rightReboundX}`);

  physics.dispose();
  console.log('PASS [2] Real Rapier3D cue-ball spin physics (follow, draw, left/right English cushion throw, diagonal) verified');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
