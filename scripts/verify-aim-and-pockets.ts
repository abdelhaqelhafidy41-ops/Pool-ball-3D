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
  computeClampedShortGuideSegment,
  resolveAimGuideVisualMode,
  type AimGuideModeParams,
  type ShortGuideSegment,
} from '../src/game/objects/CueStick';
import { PoolTable } from '../src/game/objects/PoolTable';
import { PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import { BALL_DEFINITIONS, BALL_SPECS, POCKET_POSITIONS, TABLE_DIMENSIONS } from '../src/game/utils/constants';
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

function testShortGuideClamping() {
  const seg: ShortGuideSegment = { visible: false, startX: 0, startZ: 0, endX: 0, endZ: 0 };
  const D = TABLE_DIMENSIONS;
  const R = BALL_SPECS.radius;

  // 1. Open table: <= 0.22m long and starts outside cue ball
  computeClampedShortGuideSegment(0, 0, 0, [], seg);
  assert.equal(seg.visible, true);
  const openLen = Math.hypot(seg.endX - seg.startX, seg.endZ - seg.startZ);
  assert.ok(openLen > 0.20 && openLen <= 0.221, `Expected ~0.22m short guide, got ${openLen}`);

  // 2. Near right rail facing +X -> clamps inside D.halfLength - 0.004
  computeClampedShortGuideSegment(D.halfLength - 0.10, 0, 0, [], seg);
  assert.equal(seg.visible, true);
  assert.ok(seg.endX <= D.halfLength - 0.0039, `Guide crossed +X cushion: ${seg.endX}`);

  // 3. Near bottom rail facing +Z -> clamps inside D.halfWidth - 0.004
  computeClampedShortGuideSegment(0, D.halfWidth - 0.09, Math.PI / 2, [], seg);
  assert.equal(seg.visible, true);
  assert.ok(seg.endZ <= D.halfWidth - 0.0039, `Guide crossed +Z cushion: ${seg.endZ}`);

  // 4. Right against rail facing outward -> hidden
  computeClampedShortGuideSegment(D.halfLength - 0.03, 0, 0, [], seg);
  assert.equal(seg.visible, false, 'Expected guide right against cushion to hide instead of penetrating rail');

  // 5. Blocked closely by an object ball -> clamps before penetrating object ball
  const blockX = 0.14;
  computeClampedShortGuideSegment(0, 0, 0, [{ x: blockX, z: 0 }], seg);
  assert.equal(seg.visible, true);
  assert.ok(seg.endX <= blockX - R * 1.97, `Guide penetrated object ball at x=${blockX}: endX=${seg.endX}`);
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

  physics.dispose();
}

async function main() {
  testAimGuideVisibilityRules();
  console.log('✓ Aim guide visibility rules verified (normal short vs AI Master pro)');

  testShortGuideClamping();
  console.log('✓ Short aiming guide rail & object-ball clamping verified');

  testObjectBallColorMatching();
  console.log('✓ Object-ball trajectory color matching & blue-cloth readability verified');

  testAllSixPocketCutoutsWithRaycasting();
  console.log('✓ All 6 pocket cutouts (PlayingSurfaceCloth, SlateBed, CabinetApron, PocketWell) raycast-verified');

  await testPhysicsAimPredictionAndAllSixPocketsEntry();
  console.log('✓ Rapier3D aim prediction targetBallNumber & physical entry into all 6 pockets verified');

  console.log('ALL AIMING & 6-POCKET UNIT/PHYSICS CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
