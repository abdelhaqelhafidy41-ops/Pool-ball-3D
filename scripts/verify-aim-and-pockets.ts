import assert from 'node:assert/strict';
import * as THREE from 'three';

// Minimal DOM canvas stub so PoolTable/CueStick/ProceduralTextures can instantiate in pure Node for geometry & raycast checks
if (typeof globalThis.document === 'undefined') {
  const noop = () => {};
  const gradStub = { addColorStop: noop };
  const ctxStub = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    shadowColor: '',
    shadowBlur: 0,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    createLinearGradient: () => gradStub,
    createRadialGradient: () => gradStub,
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    ellipse: noop,
    arcTo: noop,
    rect: noop,
    clip: noop,
    setTransform: noop,
    resetTransform: noop,
  };
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 256,
          height: 256,
          getContext: () => ctxStub,
        };
      }
      return {};
    },
  };
}

import { resolveObjectBallAimColor } from '../src/game/objects/BilliardBalls';
import {
  CueStick,
  resolveAimGuideVisualMode,
  trimPolylineByMaxLength,
  type AimGuideModeParams,
  type PolyPoint2D,
} from '../src/game/objects/CueStick';
import { PoolTable } from '../src/game/objects/PoolTable';
import { PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import { BALL_DEFINITIONS, POCKET_POSITIONS, TABLE_DIMENSIONS } from '../src/game/utils/constants';
import { getTableSkinVisualSpec } from '../src/game/utils/ProceduralTextures';

function baseAimParams(overrides: Partial<AimGuideModeParams> = {}): AimGuideModeParams {
  return {
    screen: 'playing',
    gameMode: 'eightBall',
    opponentType: 'ai',
    aiDifficulty: 'pro',
    showAimGuideSetting: true,
    showAiAimGuideSetting: true,
    isAiThinking: false,
    aiPhase: 'idle',
    canLocalAct: true,
    canDisplayCue: true,
    isStrikeAnimating: false,
    ballsMoving: false,
    replayActive: false,
    onlineSpectating: false,
    ...overrides,
  };
}

function testAimGuideVisibilityRules() {
  // 1. AI Master ('pro') in 8-Ball when local player actively aims -> 'master_preview'
  assert.equal(
    resolveAimGuideVisualMode(baseAimParams()),
    'master_preview',
    'Expected AI Master (pro) in active 8-Ball turn to allow master_preview',
  );

  // 2. All other AI difficulties -> 'short' ONLY
  for (const diff of ['beginner', 'intermediate', 'legend'] as const) {
    assert.equal(
      resolveAimGuideVisualMode(baseAimParams({ aiDifficulty: diff })),
      'short',
      `Expected AI difficulty "${diff}" to restrict guide to short`,
    );
  }

  // 3. Local PvP, Online PvP -> 'short' ONLY (never master_preview)
  for (const opp of ['pvp', 'online'] as const) {
    assert.equal(
      resolveAimGuideVisualMode(baseAimParams({ gameMode: 'eightBall', opponentType: opp, aiDifficulty: 'pro' })),
      'short',
      `Expected opponentType="${opp}" to restrict guide to short`,
    );
  }

  // 4. Free Play mode even with aiDifficulty='pro' & opponentType='ai' -> 'short'
  assert.equal(
    resolveAimGuideVisualMode(baseAimParams({ gameMode: 'freePlay', opponentType: 'ai', aiDifficulty: 'pro' })),
    'short',
    'Expected freePlay mode not to unlock 8-ball AI Master preview',
  );

  // 5. During AI's own shot thinking/aiming -> never master_preview (short if showAiAimGuideSetting & aiming, else none)
  assert.equal(
    resolveAimGuideVisualMode(baseAimParams({ isAiThinking: true, aiPhase: 'aiming', canLocalAct: false })),
    'short',
  );
  assert.equal(
    resolveAimGuideVisualMode(baseAimParams({ isAiThinking: true, aiPhase: 'analyzing', canLocalAct: false })),
    'none',
  );

  // 6. Disappears immediately when shot starts, balls move, setting is off, replay or spectate is active
  assert.equal(resolveAimGuideVisualMode(baseAimParams({ isStrikeAnimating: true })), 'none');
  assert.equal(resolveAimGuideVisualMode(baseAimParams({ ballsMoving: true })), 'none');
  assert.equal(resolveAimGuideVisualMode(baseAimParams({ showAimGuideSetting: false })), 'none');
  assert.equal(resolveAimGuideVisualMode(baseAimParams({ canDisplayCue: false })), 'none');
  assert.equal(resolveAimGuideVisualMode(baseAimParams({ replayActive: true })), 'none');
  assert.equal(resolveAimGuideVisualMode(baseAimParams({ onlineSpectating: true })), 'none');
  assert.equal(resolveAimGuideVisualMode(baseAimParams({ canLocalAct: false })), 'none');
}

function polylineArcLength(line: THREE.Line): number {
  if (!line.visible) return 0;
  const count = line.geometry.drawRange.count;
  if (count < 2) return 0;
  const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  let total = 0;
  for (let i = 1; i < count; i++) {
    total += Math.hypot(pos.getX(i) - pos.getX(i - 1), pos.getZ(i) - pos.getZ(i - 1));
  }
  return total;
}

function testTrimPolylineByMaxLength() {
  const scratch: PolyPoint2D[] = Array.from({ length: 16 }, () => ({ x: 0, z: 0 }));
  const longPath: PolyPoint2D[] = [
    { x: 0, z: 0 },
    { x: 0.1, z: 0 },
    { x: 0.25, z: 0 },
    { x: 0.8, z: 0 },
  ];

  const count = trimPolylineByMaxLength(longPath, 0.14, 16, scratch);
  assert.equal(count, 3);
  assert.ok(Math.abs(scratch[count - 1].x - 0.14) < 1e-6);

  assert.equal(trimPolylineByMaxLength([{ x: 0, z: 0 }], 0.14, 16, scratch), 0);
}

function testObjectBallColorMatching() {
  const out = new THREE.Color();
  const blueClothHex = getTableSkinVisualSpec('table_blue_tournament', 'championshipBlue').clothBase;
  const greenClothHex = getTableSkinVisualSpec('table_classic_green', 'tournamentGreen').clothBase;

  // Cue ball / invalid -> neutral fallback (not hardcoded orange 0xf59e0b)
  const invalid = resolveObjectBallAimColor(0, 'ball_classic', blueClothHex, out);
  assert.equal(invalid.needsContrastHalo, false);
  assert.notEqual(out.getHex(), 0xf59e0b);

  // Solid Yellow #1
  resolveObjectBallAimColor(1, 'ball_classic', blueClothHex, out);
  const hsl1 = { h: 0, s: 0, l: 0 };
  out.getHSL(hsl1);
  assert.ok(hsl1.h > 0.08 && hsl1.h < 0.18, `Expected yellow hue for #1, got h=${hsl1.h}`);

  // Solid Red #3
  resolveObjectBallAimColor(3, 'ball_classic', blueClothHex, out);
  const hsl3 = { h: 0, s: 0, l: 0 };
  out.getHSL(hsl3);
  assert.ok(hsl3.h < 0.06 || hsl3.h > 0.94, `Expected red hue for #3, got h=${hsl3.h}`);

  // Blue #2 and Stripe Blue #10 on blue cloth -> same hue family but luminance boosted + halo enabled for readability
  const res2 = resolveObjectBallAimColor(2, 'ball_classic', blueClothHex, out);
  const hsl2 = { h: 0, s: 0, l: 0 };
  out.getHSL(hsl2);
  assert.equal(res2.needsContrastHalo, true, 'Blue #2 on blue cloth should enable contrast halo');
  assert.ok(hsl2.l >= 0.60, `Blue #2 on blue cloth luminance should lift >= 0.60, got ${hsl2.l}`);

  const res10 = resolveObjectBallAimColor(10, 'ball_classic', blueClothHex, out);
  assert.equal(res10.needsContrastHalo, true);

  // Black 8-Ball -> genuine black hue + contrast halo
  const res8 = resolveObjectBallAimColor(8, 'ball_classic', blueClothHex, out);
  assert.equal(res8.needsContrastHalo, true, '8-ball should enable contrast halo');
  assert.equal(out.getHex(), 0x111318);

  // Green #6 on green cloth -> luminance lift + halo
  const res6 = resolveObjectBallAimColor(6, 'ball_classic', greenClothHex, out);
  assert.equal(res6.needsContrastHalo, true);

  // Every ball 1..15 resolves cleanly without orange fallback
  for (const def of BALL_DEFINITIONS) {
    if (def.number === 0) continue;
    resolveObjectBallAimColor(def.number, 'ball_classic', blueClothHex, out);
    assert.notEqual(out.getHex(), 0xf59e0b, `Ball #${def.number} unexpectedly fell back to amber`);
  }
}

function testAllSixPocketCutoutsWithRaycasting() {
  const table = new PoolTable('championshipBlue', 1);
  table.group.updateMatrixWorld(true);

  const feltMesh = table.group.getObjectByName('PlayingSurfaceCloth') as THREE.Mesh | undefined;
  const slateMesh = table.group.getObjectByName('SlateBed') as THREE.Mesh | undefined;
  const apronMesh = table.group.getObjectByName('CabinetApron') as THREE.Mesh | undefined;

  assert.ok(feltMesh, 'PlayingSurfaceCloth mesh missing');
  assert.ok(slateMesh, 'SlateBed mesh missing');
  assert.ok(apronMesh, 'CabinetApron mesh missing');

  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);

  // Verify playing surface center DOES hit felt & slate (sanity check)
  raycaster.set(new THREE.Vector3(0, TABLE_DIMENSIONS.surfaceY + 0.5, 0), down);
  assert.ok(raycaster.intersectObject(feltMesh, false).length >= 1, 'Center of table must hit cloth');
  assert.ok(raycaster.intersectObject(slateMesh, false).length >= 1, 'Center of table must hit slate');

  // Verify ALL SIX pockets have clean open cutouts (zero cloth, slate, or apron wood above well bottom)
  for (const pocket of POCKET_POSITIONS) {
    const wellMesh = table.group.getObjectByName(`PocketWell_${pocket.id}`) as THREE.Mesh | undefined;
    assert.ok(wellMesh, `PocketWell_${pocket.id} mesh missing`);

    const sampleOffsets: Array<[number, number]> = [
      [0, 0],
      [pocket.radius * 0.55, 0],
      [-pocket.radius * 0.55, 0],
      [0, pocket.radius * 0.55],
      [0, -pocket.radius * 0.55],
      [pocket.radius * 0.38, pocket.radius * 0.38],
      [-pocket.radius * 0.38, -pocket.radius * 0.38],
    ];

    for (const [ox, oz] of sampleOffsets) {
      const px = pocket.x + ox;
      const pz = pocket.z + oz;
      raycaster.set(new THREE.Vector3(px, TABLE_DIMENSIONS.surfaceY + 0.5, pz), down);

      const feltHits: THREE.Intersection[] = raycaster.intersectObject(feltMesh, false);
      assert.equal(
        feltHits.length,
        0,
        `Pocket "${pocket.id}" sample (${px.toFixed(3)}, ${pz.toFixed(3)}) covered by PlayingSurfaceCloth!`,
      );

      const slateHits: THREE.Intersection[] = raycaster.intersectObject(slateMesh, false);
      assert.equal(
        slateHits.length,
        0,
        `Pocket "${pocket.id}" sample (${px.toFixed(3)}, ${pz.toFixed(3)}) covered by SlateBed!`,
      );

      const apronHits: THREE.Intersection[] = raycaster.intersectObject(apronMesh, false);
      assert.equal(
        apronHits.length,
        0,
        `Pocket "${pocket.id}" sample (${px.toFixed(3)}, ${pz.toFixed(3)}) obstructed by CabinetApron!`,
      );

      const wellHits: THREE.Intersection[] = raycaster.intersectObject(wellMesh, false);
      assert.ok(
        wellHits.length >= 1,
        `Pocket "${pocket.id}" sample (${px.toFixed(3)}, ${pz.toFixed(3)}) missed PocketWell interior!`,
      );
      assert.ok(
        wellHits[0].point.y < TABLE_DIMENSIONS.surfaceY - 0.0001,
        `Pocket "${pocket.id}" well hit point ${wellHits[0].point.y} poked above cloth surface ${TABLE_DIMENSIONS.surfaceY}`,
      );
    }
  }

  table.dispose();
}

async function testPhysicsAimPredictionAndAllSixPocketsEntry() {
  const physics = new PhysicsWorld();
  await physics.init();

  // A. Aim prediction returns targetBallNumber for object ball hit, null for rail-only hit
  for (let num = 0; num <= 15; num++) {
    if (num === 0) physics.setBallState(0, -0.5, 0, false);
    else if (num === 8) physics.setBallState(8, 0.25, 0, false);
    else physics.setBallState(num, 10 + num * 0.25, 10, true);
  }
  const hit8 = physics.predictAimTrajectory(0, { x: 0, y: 0 }, 0.65);
  assert.ok(hit8, 'Expected aim prediction result for 8-ball');
  assert.equal(hit8.hitType, 'ball');
  assert.equal(hit8.targetBallNumber, 8, 'Expected targetBallNumber=8 when aiming at 8-ball');

  const hitRail = physics.predictAimTrajectory(Math.PI / 2, { x: 0, y: 0 }, 0.65);
  assert.ok(hitRail, 'Expected aim prediction result for cushion');
  assert.equal(hitRail.hitType, 'cushion');
  assert.equal(hitRail.targetBallNumber, null, 'Expected targetBallNumber=null when aiming at cushion');

  // B. Verify balls physically enter and register pocket events in ALL SIX pockets cleanly
  for (let i = 0; i < POCKET_POSITIONS.length; i++) {
    const pocket = POCKET_POSITIONS[i];
    const ballNum = i + 1;
    for (let num = 0; num <= 15; num++) {
      if (num === 0) {
        // Place cue ball slightly offset from pocket approach line toward table center
        const dirX = -Math.sign(pocket.x || 0.001);
        const dirZ = -Math.sign(pocket.z || 0.001);
        const norm = Math.hypot(dirX, dirZ) || 1;
        const ux = pocket.id.startsWith('side') ? 0 : dirX / norm;
        const uz = pocket.id.startsWith('side') ? -Math.sign(pocket.z) : dirZ / norm;
        const objX = pocket.x + ux * 0.22;
        const objZ = pocket.z + uz * 0.22;
        const cueX = objX + ux * 0.24;
        const cueZ = objZ + uz * 0.24;
        physics.setBallState(0, cueX, cueZ, false);
      } else if (num === ballNum) {
        const dirX = -Math.sign(pocket.x || 0.001);
        const dirZ = -Math.sign(pocket.z || 0.001);
        const norm = Math.hypot(dirX, dirZ) || 1;
        const ux = pocket.id.startsWith('side') ? 0 : dirX / norm;
        const uz = pocket.id.startsWith('side') ? -Math.sign(pocket.z) : dirZ / norm;
        physics.setBallState(ballNum, pocket.x + ux * 0.22, pocket.z + uz * 0.22, false);
      } else {
        physics.setBallState(num, 10 + num * 0.25, 10, true);
      }
    }

    const dirX = -Math.sign(pocket.x || 0.001);
    const dirZ = -Math.sign(pocket.z || 0.001);
    const norm = Math.hypot(dirX, dirZ) || 1;
    const ux = pocket.id.startsWith('side') ? 0 : dirX / norm;
    const uz = pocket.id.startsWith('side') ? -Math.sign(pocket.z) : dirZ / norm;
    const objX = pocket.x + ux * 0.22;
    const objZ = pocket.z + uz * 0.22;
    const cueX = objX + ux * 0.24;
    const cueZ = objZ + uz * 0.24;
    const shotAngle = Math.atan2(pocket.z - cueZ, pocket.x - cueX);

    physics.beginShotTelemetry(i + 1, false, 'player1', { targetBall: null, targetPocket: null });
    physics.strikeCueBall(shotAngle, 0.55, { x: 0, y: 0 });
    for (let step = 0; step < 600; step++) {
      physics.step(1 / 60);
      if (step > 3 && !physics.areAnyBallsMoving()) break;
    }
    const telemetry = physics.finalizeShotTelemetry();
    const matched = telemetry.pocketEvents.some(
      (ev) => ev.ballNumber === ballNum && ev.pocketId === pocket.id,
    );
    assert.equal(
      matched,
      true,
      `Expected ball #${ballNum} to drop cleanly into pocket "${pocket.id}", got events=${JSON.stringify(telemetry.pocketEvents)}`,
    );
  }

  // C. Verify actual Three.js CueStick rendering objects across normal modes vs AI Master
  const cueStick = new CueStick(1);
  const aimLine = cueStick.group.getObjectByName('AimGuideCueLine') as THREE.Line;
  const objectLine = cueStick.group.getObjectByName('AimGuideObjectLine') as THREE.Line;
  const objectContrastLine = cueStick.group.getObjectByName('AimGuideObjectContrastLine') as THREE.Line;
  const deflectLine = cueStick.group.getObjectByName('AimGuideDeflectLine') as THREE.Line;
  const ghostRing = cueStick.group.getObjectByName('AimGuideGhostRing') as THREE.Mesh;

  // Set cue at (-0.6, 0), Yellow #1 at (0.2, 0), Red #3 at (-0.6, 0.45), Black #8 at (-0.6, -0.45)
  for (let num = 0; num <= 15; num++) {
    if (num === 0) physics.setBallState(0, -0.6, 0, false);
    else if (num === 1) physics.setBallState(1, 0.2, 0, false);
    else if (num === 3) physics.setBallState(3, -0.6, 0.45, false);
    else if (num === 8) physics.setBallState(8, -0.6, -0.45, false);
    else physics.setBallState(num, 10 + num * 0.25, 10, true);
  }
  const cueVec = new THREE.Vector3(-0.6, TABLE_DIMENSIONS.surfaceY + 0.028575, 0);

  // Case 1: Aim cue ball toward empty left cushion without striking any object ball -> full-length Cue Ball Trajectory preserved!
  const noHitPred = physics.predictAimTrajectory(Math.PI, { x: 0, y: 0 }, 0.25)!;
  assert.equal(noHitPred.targetBallNumber, null);
  cueStick.update(cueVec, Math.PI, 0.04, true, 'short', noHitPred, null, false, { x: 0, y: 0 });
  const cueLenNoHit = polylineArcLength(aimLine);
  assert.ok(cueLenNoHit > 0.60, `Expected full-length cue ball guide without hit, got ${cueLenNoHit}`);
  assert.equal(objectLine.visible, false);
  assert.equal(objectContrastLine.visible, false);

  // Case 2 & 3: Aim at colored ball #1 in normal gameplay ('short', covering Local PvP, Online, Free Play, AI Easy/Medium/Hard)
  // -> cue guide stays full length, object path is SHORT!
  const hit1Pred = physics.predictAimTrajectory(0, { x: 0, y: 0 }, 0.75)!;
  assert.equal(hit1Pred.targetBallNumber, 1);
  for (const mode of [
    resolveAimGuideVisualMode(baseAimParams({ opponentType: 'pvp' })),
    resolveAimGuideVisualMode(baseAimParams({ opponentType: 'online' })),
    resolveAimGuideVisualMode(baseAimParams({ gameMode: 'freePlay', aiDifficulty: 'pro' })),
    resolveAimGuideVisualMode(baseAimParams({ aiDifficulty: 'beginner' })),
    resolveAimGuideVisualMode(baseAimParams({ aiDifficulty: 'intermediate' })),
    resolveAimGuideVisualMode(baseAimParams({ aiDifficulty: 'legend' })),
  ]) {
    assert.equal(mode, 'short');
    cueStick.update(cueVec, 0, 0.04, true, mode, hit1Pred, null, false, { x: 0, y: 0 });
    const cueLenNormal = polylineArcLength(aimLine);
    const objLenNormal = polylineArcLength(objectLine);
    assert.ok(cueLenNormal > 0.70, `Expected full-length cue ball guide (~0.74m) in normal mode, got ${cueLenNormal}`);
    assert.ok(objLenNormal > 0.08 && objLenNormal <= 0.145, `Expected short object ball trajectory (<= 0.14m), got ${objLenNormal}`);
    assert.equal(ghostRing.visible, true);
    assert.equal(objectContrastLine.visible, false);
    assert.notEqual((objectLine.material as THREE.LineBasicMaterial).color.getHex(), 0xf59e0b);
  }

  // Case 4 & 5: Aim at #1 then switch aim to #3 and #8 in AI Master ('master_preview') -> object path LONG & dynamically color-matched!
  const blueClothHex = getTableSkinVisualSpec('table_blue_tournament', 'championshipBlue').clothBase;
  const color1 = new THREE.Color();
  const c1 = resolveObjectBallAimColor(1, 'ball_classic', blueClothHex, color1);
  cueStick.update(cueVec, 0, 0.04, true, 'master_preview', hit1Pred, color1, c1.needsContrastHalo, { x: 0, y: 0 });
  const cueLenMaster = polylineArcLength(aimLine);
  const objLenMaster1 = polylineArcLength(objectLine);
  assert.ok(cueLenMaster > 0.70, `Cue ball guide must stay full length in Master mode, got ${cueLenMaster}`);
  assert.ok(objLenMaster1 > 0.50, `Expected long object ball trajectory in AI Master mode, got ${objLenMaster1}`);
  assert.equal((objectLine.material as THREE.LineBasicMaterial).color.getHex(), color1.getHex());
  assert.equal((aimLine.material as THREE.LineDashedMaterial).color.getHex(), 0xf8fafc);

  const hit3Pred = physics.predictAimTrajectory(Math.PI / 2, { x: 0, y: 0 }, 0.75)!;
  assert.equal(hit3Pred.targetBallNumber, 3);
  const color3 = new THREE.Color();
  const c3 = resolveObjectBallAimColor(3, 'ball_classic', blueClothHex, color3);
  cueStick.update(cueVec, Math.PI / 2, 0.04, true, 'master_preview', hit3Pred, color3, c3.needsContrastHalo, { x: 0, y: 0 });
  const objLenMaster3 = polylineArcLength(objectLine);
  assert.ok(objLenMaster3 > 0.35, `Expected long object ball trajectory for #3 in Master mode, got ${objLenMaster3}`);
  assert.equal((objectLine.material as THREE.LineBasicMaterial).color.getHex(), color3.getHex());
  assert.notEqual(color3.getHex(), color1.getHex(), 'Target ball trajectory color must update dynamically');

  // Verify Black #8 in AI Master activates contrast halo while staying long
  const hit8Pred = physics.predictAimTrajectory(-Math.PI / 2, { x: 0, y: 0 }, 0.75)!;
  assert.equal(hit8Pred.targetBallNumber, 8);
  const color8 = new THREE.Color();
  const c8 = resolveObjectBallAimColor(8, 'ball_classic', blueClothHex, color8);
  assert.equal(c8.needsContrastHalo, true);
  cueStick.update(cueVec, -Math.PI / 2, 0.04, true, 'master_preview', hit8Pred, color8, c8.needsContrastHalo, { x: 0, y: 0 });
  const objLenMaster8 = polylineArcLength(objectLine);
  assert.ok(objLenMaster8 > 0.35, `Expected long object ball trajectory for #8 in Master mode, got ${objLenMaster8}`);
  assert.equal(objectContrastLine.visible, true);
  assert.ok(deflectLine !== undefined);

  cueStick.dispose();
  physics.dispose();
}

async function main() {
  testAimGuideVisibilityRules();
  console.log('✓ Aim guide & object ball visibility rules verified (normal short vs AI Master pro)');

  testTrimPolylineByMaxLength();
  console.log('✓ Object ball trajectory arc-length trimming verified');

  testObjectBallColorMatching();
  console.log('✓ Object-ball trajectory color matching & blue-cloth readability verified');

  testAllSixPocketCutoutsWithRaycasting();
  console.log('✓ All 6 pocket cutouts (PlayingSurfaceCloth, SlateBed, CabinetApron, PocketWell) raycast-verified');

  await testPhysicsAimPredictionAndAllSixPocketsEntry();
  console.log('✓ Rapier3D aim prediction, CueStick cue-vs-object separation, and 6-pocket entry verified');

  console.log('ALL AIMING & 6-POCKET UNIT/PHYSICS CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
