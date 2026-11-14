import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import { ReplayAnalysisOverlay } from '../src/game/replay/ReplayAnalysisOverlay';
import {
  formatCollisionLabel,
  ReplayController,
} from '../src/game/replay/ReplayController';
import { ShotRecorder } from '../src/game/replay/ShotRecorder';
import {
  MAX_REPLAY_SHOTS,
  REPLAY_BALL_COUNT,
  REPLAY_FIXED_DT,
  REPLAY_FLOATS_PER_BALL,
  REPLAY_FLOATS_PER_FRAME,
  type ReplayBallFrame,
} from '../src/game/replay/types';
import { POCKET_POSITIONS, TABLE_DIMENSIONS } from '../src/game/utils/constants';
import type { OnlineBallFrame } from '../src/multiplayer/shared/protocol';
import { canLocalPlayerAct, useGameStore } from '../src/store/useGameStore';

function readBallFromPacked(
  framesData: Float32Array,
  frameIdx: number,
  ballNum: number,
): ReplayBallFrame {
  const off = frameIdx * REPLAY_FLOATS_PER_FRAME + ballNum * REPLAY_FLOATS_PER_BALL;
  return {
    number: ballNum,
    x: framesData[off + 0],
    y: framesData[off + 1],
    z: framesData[off + 2],
    qx: framesData[off + 3],
    qy: framesData[off + 4],
    qz: framesData[off + 5],
    qw: framesData[off + 6],
    vx: framesData[off + 7],
    vy: framesData[off + 8],
    vz: framesData[off + 9],
    pocketed: framesData[off + 10] > 0.5,
  };
}

function capturePhysicsBackup(physics: PhysicsWorld): ReplayBallFrame[] {
  const out: ReplayBallFrame[] = [];
  physics.forEachBallKinematics(
    (number, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed) => {
      out.push({ number, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed });
    },
  );
  return out;
}

async function main() {
  const physics = new PhysicsWorld();
  await physics.init();

  const recorder = new ShotRecorder();
  const cornerTR = POCKET_POSITIONS.find((p) => p.id === 'corner-tr')!;
  const spinInput = { x: 0.35, y: -0.45 };

  // Setup shot that strikes Ball #1 straight into top-right pocket with cue back-right spin
  physics.resetRack();
  for (let n = 2; n <= 15; n++) {
    physics.setBallState(n, 0, 0, true);
  }
  const b1x = cornerTR.x - 0.18;
  const b1z = cornerTR.z + 0.18;
  const b0x = cornerTR.x - 0.52;
  const b0z = cornerTR.z + 0.52;
  physics.setBallState(0, b0x, b0z, false);
  physics.setBallState(1, b1x, b1z, false);

  const aimDx = b1x - b0x;
  const aimDz = b1z - b0z;
  const aimAngle = Math.atan2(aimDz, aimDx);

  recorder.beginShot({
    shotNumber: 1,
    mode: 'local',
    shooter: 'player1',
    shooterName: 'Player 1',
    isBreakShot: false,
    cueAngle: aimAngle,
    power: 0.72,
    spin: spinInput,
    calledShot: { targetBall: 1, targetPocket: 'corner-tr' },
  });

  const captureFrame = () => {
    physics.forEachBallKinematics(
      (num, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed) => {
        recorder.writeBallSample(num, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed);
      },
    );
    recorder.commitFrame();
  };

  physics.setShotStepObserver({
    onFixedSample: captureFrame,
    onCollision: (kind, ballA, ballB, x, z, impactSpeed) =>
      recorder.recordCollision({ kind, ballA, ballB, x, z, impactSpeed }),
    onPocket: (ballNumber, pocketId, x, z) =>
      recorder.recordPocket(ballNumber, pocketId, x, z),
  });

  physics.beginShotTelemetry(1, false, 'player1', {
    targetBall: 1,
    targetPocket: 'corner-tr',
  });
  physics.strikeCueBall(aimAngle, 0.72, spinInput);
  captureFrame();

  for (let i = 0; i < 420; i++) {
    physics.step(1 / 60);
    if (i > 30 && !physics.areAnyBallsMoving()) break;
  }
  captureFrame();
  physics.setShotStepObserver(null);

  const recorded = recorder.finalizeShot({
    resultLabel: 'Pocketed #1',
    isFoul: false,
    foulReason: null,
  });

  assert(recorded !== null, 'Recorded shot should be created');
  assert.equal(recorded.timestepSec, REPLAY_FIXED_DT);
  assert(recorded.frameCount >= 20, `Expected >= 20 fixed frames, got ${recorded.frameCount}`);
  assert.deepEqual(recorded.spin, spinInput);
  assert(
    recorded.collisions.some((c) => c.kind === 'cue_ball'),
    'Expected cue_ball collision recorded',
  );
  assert(
    recorded.pocketedBalls.some((p) => p.ballNumber === 1),
    'Expected ball #1 pocket event recorded',
  );
  assert(recorded.firstImpactTimeSec !== null, 'Expected firstImpactTimeSec recorded');
  assert(
    recorded.trajectories.some((t) => t.ballNumber === 0 && t.points.length >= 2),
    'Expected cue ball trajectory extracted',
  );
  assert(
    recorded.trajectories.some((t) => t.ballNumber === 1 && t.points.length >= 2),
    'Expected object ball #1 trajectory extracted',
  );
  console.log(
    `PASS [1] Real PhysicsWorld shot recorded (${recorded.frameCount} fixed 60Hz frames, ${recorded.collisions.length} collisions, ${recorded.pocketedBalls.length} pocketed, ${recorded.trajectories.length} trajectories)`,
  );

  // 2. Test bounded 10-shot FIFO storage
  for (let s = 2; s <= 13; s++) {
    recorder.beginShot({
      shotNumber: s,
      mode: 'local',
      shooter: s % 2 === 0 ? 'player2' : 'player1',
      shooterName: s % 2 === 0 ? 'Player 2' : 'Player 1',
      isBreakShot: false,
      cueAngle: 0,
      power: 0.4,
      spin: { x: 0, y: 0 },
      calledShot: { targetBall: null, targetPocket: null },
    });
    captureFrame();
    captureFrame();
    recorder.finalizeShot({
      resultLabel: `Shot ${s}`,
      isFoul: false,
      foulReason: null,
    });
  }
  const stored = recorder.getShots();
  assert.equal(stored.length, MAX_REPLAY_SHOTS, 'Shot storage must stay bounded at 10 shots');
  assert.equal(stored[0].shotNumber, 4, 'Oldest retained shot after 13 shots should be #4');
  assert.equal(stored[stored.length - 1].shotNumber, 13, 'Newest retained shot should be #13');
  console.log('PASS [2] Shot history FIFO capped cleanly at 10 most recent shots');

  // 3. Test ReplayController accuracy, pause/resume, restart, seek, slow-mo & speeds
  const liveBackupBefore = capturePhysicsBackup(physics);
  const worldVersionBefore = physics.getWorldVersion();
  const controller = new ReplayController();
  const scratch: ReplayBallFrame[] = [];

  controller.enterReplay(recorded, liveBackupBefore);
  assert.equal(controller.isActive(), true);
  assert.equal(controller.isPlaying(), true);

  // Verify exact reproduction at frame 0 and a later frame k
  controller.seek(0);
  assert.equal(controller.sampleInterpolatedFrames(scratch), true);
  const expectedF0 = readBallFromPacked(recorded.framesData, 0, 0);
  assert(Math.abs(scratch[0].x - expectedF0.x) < 1e-6);
  assert(Math.abs(scratch[0].z - expectedF0.z) < 1e-6);

  const checkFrameIdx = Math.min(recorded.frameCount - 2, 12);
  controller.seek(checkFrameIdx * REPLAY_FIXED_DT);
  controller.sampleInterpolatedFrames(scratch);
  const expectedFk = readBallFromPacked(recorded.framesData, checkFrameIdx, 0);
  const expectedFkNext = readBallFromPacked(recorded.framesData, checkFrameIdx + 1, 0);
  assert(Math.abs(scratch[0].x - expectedFk.x) < 1e-5);
  assert(Math.abs(scratch[0].z - expectedFk.z) < 1e-5);

  // Mid-frame linear + slerp interpolation for smooth slow motion
  controller.seek((checkFrameIdx + 0.5) * REPLAY_FIXED_DT);
  controller.sampleInterpolatedFrames(scratch);
  const midExpectedX = (expectedFk.x + expectedFkNext.x) * 0.5;
  assert(Math.abs(scratch[0].x - midExpectedX) < 1e-5, 'Sub-frame midpoint interpolation accurate');

  // Pause & resume
  controller.pause();
  const pausedTime = controller.getCurrentTimeSec();
  controller.step(0.25);
  assert.equal(controller.getCurrentTimeSec(), pausedTime, 'Paused replay must not advance');
  controller.play();
  controller.setSpeed(1);
  controller.step(0.1);
  assert(Math.abs(controller.getCurrentTimeSec() - (pausedTime + 0.1)) < 1e-6);

  // Playback speeds: 0.25x, 0.5x, 1x, 2x
  for (const spd of [0.25, 0.5, 1, 2] as const) {
    controller.restart();
    assert.equal(controller.getCurrentTimeSec(), 0);
    assert.equal(controller.isPlaying(), true);
    controller.setSpeed(spd);
    controller.step(0.08);
    assert(
      Math.abs(controller.getCurrentTimeSec() - 0.08 * spd) < 1e-6,
      `Speed ${spd}x progression mismatch`,
    );
  }

  // Slow-mo impact jump & auto slow-mo near collision
  controller.setAutoSlowMo(true);
  controller.setSpeed(1);
  controller.jumpToFirstImpact();
  assert.equal(controller.getSpeed(), 0.25);
  controller.seek(recorded.firstImpactTimeSec!);
  const highlight = controller.getActiveCollisionHighlight();
  assert(highlight !== null, 'Collision highlight active at firstImpactTimeSec');
  assert(formatCollisionLabel(highlight).length > 0);
  controller.setSpeed(2);
  assert.equal(
    controller.getEffectivePlaybackSpeed(),
    0.25,
    'Auto Slow-Mo should drop effective speed to 0.25x at collision moment',
  );

  // Confirm live PhysicsWorld was completely untouched during replay
  assert.equal(
    physics.getWorldVersion(),
    worldVersionBefore,
    'Replay must never mutate live Rapier physics world',
  );
  const liveAfterReplay = capturePhysicsBackup(physics);
  for (let i = 0; i < REPLAY_BALL_COUNT; i++) {
    assert.equal(liveAfterReplay[i].x, liveBackupBefore[i].x);
    assert.equal(liveAfterReplay[i].z, liveBackupBefore[i].z);
  }
  const restored = controller.exitReplay();
  assert.equal(controller.isActive(), false);
  assert.equal(restored.length, liveBackupBefore.length);
  console.log('PASS [3] ReplayController playback, 0.25x-2x speeds, slow-mo, & live physics isolation verified');

  // 4. Three.js ReplayAnalysisOverlay creation & resource disposal
  const overlay = new ReplayAnalysisOverlay();
  overlay.setShot(recorded);
  overlay.update(true, recorded.firstImpactTimeSec!);
  assert.equal(overlay.group.visible, true);
  assert(overlay.group.children.length > 0, 'Overlay should contain trajectories & markers');
  overlay.dispose();
  assert.equal(overlay.group.children.length, 0, 'Overlay dispose() must free all Three.js objects');
  console.log('PASS [4] ReplayAnalysisOverlay geometry creation & clean disposal verified');

  // 5. Store lockout & Online passive shot recording
  const store = useGameStore.getState();
  store.resetMatchStats();
  store.setScreen('playing');
  store.updateMatchConfig({ opponentType: 'online' });
  store.setOnlineConnectionStatus('connected');
  useGameStore.setState({
    onlineLocalRole: 'player1',
    activePlayer: 'player1',
    matchPhase: 'OPEN_TABLE',
  });
  assert.equal(canLocalPlayerAct(useGameStore.getState()), true);
  store.setReplayUiState({ replayActive: true });
  assert.equal(
    canLocalPlayerAct(useGameStore.getState()),
    false,
    'Replay mode must lock shooting/aiming input during an active match',
  );
  store.resetReplayUiState();
  assert.equal(
    canLocalPlayerAct(useGameStore.getState()),
    true,
    'Exiting replay must restore exact local turn capability',
  );

  // Simulate passive online keyframes resampled onto fixed 60Hz grid
  const onlineRecorder = new ShotRecorder();
  onlineRecorder.beginShot({
    shotNumber: 1,
    mode: 'online',
    shooter: 'player2',
    shooterName: 'Opponent',
    isBreakShot: false,
    cueAngle: 0,
    power: 0.6,
    spin: { x: -0.2, y: 0.1 },
    calledShot: { targetBall: null, targetPocket: null },
  });
  const makeOnlineFrame = (cueX: number, objX: number, cueVx: number, pocketed1: boolean): OnlineBallFrame[] => {
    const arr: OnlineBallFrame[] = [];
    for (let n = 0; n < 16; n++) {
      const isCue = n === 0;
      const isOne = n === 1;
      arr.push({
        number: n,
        x: isCue ? cueX : isOne ? objX : -0.9 + n * 0.05,
        y: TABLE_DIMENSIONS.surfaceY + 0.0285,
        z: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
        vx: isCue ? cueVx : 0,
        vy: 0,
        vz: 0,
        pocketed: isOne ? pocketed1 : n > 1,
      });
    }
    return arr;
  };
  onlineRecorder.pushOnlineSample(makeOnlineFrame(-0.5, 0.0, 2.2, false));
  await new Promise((r) => setTimeout(r, 35));
  onlineRecorder.pushOnlineSample(makeOnlineFrame(-0.04, 0.0, 0.2, false));
  onlineRecorder.recordPocket(1, 'corner-tr');
  await new Promise((r) => setTimeout(r, 35));
  const finalOnline = makeOnlineFrame(-0.02, 1.1, 0, true);
  const onlineRec = onlineRecorder.finalizeShot({
    resultLabel: 'Opponent Pocketed #1',
    isFoul: false,
    foulReason: null,
    finalOnlineBalls: finalOnline,
  });
  assert(onlineRec !== null, 'Online shot replay must be finalized cleanly');
  assert.equal(onlineRec.timestepSec, REPLAY_FIXED_DT);
  assert(onlineRec.collisions.length >= 1, 'Online velocity-change collision inferred');
  assert.equal(onlineRec.pocketedBalls.length, 1);

  physics.dispose();
  console.log('PASS [5] Multiplayer turn lock, non-disruptive online recording, & fixed resampling verified');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
