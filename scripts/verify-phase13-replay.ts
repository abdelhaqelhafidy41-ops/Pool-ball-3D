import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';
import { ProgressionModal } from '../src/components/ProgressionModal';
import { ReplayOverlay } from '../src/components/ReplayOverlay';
import { CameraController } from '../src/game/camera/CameraController';
import { PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import { generateMatchHighlights } from '../src/game/replay/HighlightGenerator';
import { ReplayController } from '../src/game/replay/ReplayController';
import { ReplayStorageService } from '../src/game/replay/ReplayStorage';
import { ReplayVideoRecorder } from '../src/game/replay/ReplayVideoRecorder';
import { ShotRecorder } from '../src/game/replay/ShotRecorder';
import {
  REPLAY_BALL_COUNT,
  REPLAY_FIXED_DT,
  REPLAY_FLOATS_PER_FRAME,
  REPLAY_FORMAT_VERSION,
  summarizeRecordedShot,
  type MatchReplayRecord,
  type ReplayBallFrame,
  type ReplayCameraMode,
} from '../src/game/replay/types';
import { MatchManager } from '../src/game/rules/MatchManager';
import { POCKET_POSITIONS, TABLE_DIMENSIONS } from '../src/game/utils/constants';
import type { OnlineBallFrame } from '../src/multiplayer/shared/protocol';
import { canLocalPlayerAct, useGameStore } from '../src/store/useGameStore';

function makeDummyFrameData(
  frameCount: number,
  cueStartX: number,
  cueEndX: number,
  pocketBallNumber?: number,
): Float32Array {
  const data = new Float32Array(frameCount * REPLAY_FLOATS_PER_FRAME);
  for (let f = 0; f < frameCount; f++) {
    const t = frameCount <= 1 ? 0 : f / (frameCount - 1);
    for (let n = 0; n < REPLAY_BALL_COUNT; n++) {
      const off = f * REPLAY_FLOATS_PER_FRAME + n * 11;
      data[off + 0] = n === 0 ? cueStartX + (cueEndX - cueStartX) * t : -0.6 + n * 0.08;
      data[off + 1] = TABLE_DIMENSIONS.surfaceY + 0.028575;
      data[off + 2] = n === 0 ? 0.04 * Math.sin(t * Math.PI) : 0.02 * (n % 5 - 2);
      data[off + 3] = 0;
      data[off + 4] = 0;
      data[off + 5] = 0;
      data[off + 6] = 1;
      data[off + 7] = n === 0 ? (cueEndX - cueStartX) / Math.max(0.05, frameCount * REPLAY_FIXED_DT) : 0;
      data[off + 8] = 0;
      data[off + 9] = 0;
      data[off + 10] = pocketBallNumber === n && f === frameCount - 1 ? 1 : 0;
    }
  }
  return data;
}

function captureBackupFromPhysics(physics: PhysicsWorld): ReplayBallFrame[] {
  const backup: ReplayBallFrame[] = [];
  physics.forEachBallKinematics(
    (number, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed) => {
      backup.push({ number, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed });
    },
  );
  return backup;
}

function buildSyntheticShotFrames(
  recorder: ShotRecorder,
  physics: PhysicsWorld,
  opts: {
    shotNumber: number;
    mode: 'ai' | 'local';
    shooter: 'player1' | 'player2';
    shooterName: string;
    isBreakShot: boolean;
    aimAngle: number;
    power: number;
    spin: { x: number; y: number };
    pocketEvents?: Array<{ ball: number; pocket: 'corner-tr' | 'corner-br' | 'side-top'; timeSec: number }>;
    collisions?: Array<{
      kind: 'cue_ball' | 'ball_ball' | 'cushion';
      ballA: number;
      ballB: number | null;
      speed: number;
      timeSec: number;
    }>;
    resultLabel: string;
    isFoul: boolean;
    foulReason: string | null;
    tableOpenAfter: boolean;
    playerGroupsAfter: { player1: 'solids' | 'stripes' | null; player2: 'solids' | 'stripes' | null };
    pocketedNumbersAfter: number[];
    activePlayerAfter: 'player1' | 'player2';
    ballInHandNext: boolean;
  },
) {
  recorder.beginShot({
    shotNumber: opts.shotNumber,
    mode: opts.mode,
    shooter: opts.shooter,
    shooterName: opts.shooterName,
    isBreakShot: opts.isBreakShot,
    cueAngle: opts.aimAngle,
    power: opts.power,
    spin: opts.spin,
    calledShot: { targetBall: null, targetPocket: null },
  });

  // Record 24 fixed-timestep samples (0.40s @ 60Hz)
  for (let f = 0; f < 24; f++) {
    physics.forEachBallKinematics(
      (num, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed) => {
        const moveCue = num === 0 ? f * 0.045 : 0;
        const moveOne = num === 1 ? f * 0.065 : 0;
        const pktNow = Boolean(opts.pocketEvents?.some((p) => p.ball === num && f >= 18)) || pocketed;
        recorder.writeBallSample(
          num,
          x + moveCue + moveOne,
          y,
          z + (num === 0 ? f * 0.008 : 0),
          qx,
          qy,
          qz,
          qw,
          num === 0 ? 1.8 : 0,
          0,
          0,
          pktNow,
        );
      },
    );
    recorder.commitFrame();
  }

  for (const col of opts.collisions ?? []) {
    recorder.recordCollision({
      kind: col.kind,
      ballA: col.ballA,
      ballB: col.ballB,
      x: 0.2,
      z: 0.1,
      impactSpeed: col.speed,
      timeSec: col.timeSec,
    });
  }
  for (const pkt of opts.pocketEvents ?? []) {
    recorder.recordPocket(pkt.ball, pkt.pocket);
  }

  return recorder.finalizeShot({
    resultLabel: opts.resultLabel,
    isFoul: opts.isFoul,
    foulReason: opts.foulReason,
    tableOpenAfter: opts.tableOpenAfter,
    playerGroupsAfter: opts.playerGroupsAfter,
    pocketedNumbersAfter: opts.pocketedNumbersAfter,
    activePlayerAfter: opts.activePlayerAfter,
    ballInHandNext: opts.ballInHandNext,
  });
}

async function main() {
  const physics = new PhysicsWorld();
  await physics.init();

  // ---------------------------------------------------------------------------
  // TEST 1: Complete AI Match Recording (Real Break + Mid-Game + Long/Multi/8-Ball Win)
  // ---------------------------------------------------------------------------
  physics.resetRack();
  const aiRecorder = new ShotRecorder();
  const aiMatchId = 'match_ai_phase13_001';
  aiRecorder.beginMatch({
    matchId: aiMatchId,
    createdAtMs: 1_700_000_000_000,
    matchType: 'ai',
    aiDifficulty: 'pro',
    gameMode: 'eightBall',
    ruleProfileId: 'casual',
    calledShotsEnabled: false,
    authoritative: false,
    player1Name: 'HeroCue',
    player2Name: 'Master Elena',
  });

  // Shot 1: Real Rapier Physics Break Shot
  aiRecorder.beginShot({
    shotNumber: 1,
    mode: 'ai',
    shooter: 'player1',
    shooterName: 'HeroCue',
    isBreakShot: true,
    cueAngle: 0,
    power: 0.88,
    spin: { x: 0, y: 0.2 },
    calledShot: { targetBall: null, targetPocket: null },
  });
  physics.setShotStepObserver({
    onFixedSample: () => {
      physics.forEachBallKinematics((num, x, y, z, qx, qy, qz, qw, vx, vy, vz, pkt) => {
        aiRecorder.writeBallSample(num, x, y, z, qx, qy, qz, qw, vx, vy, vz, pkt);
      });
      aiRecorder.commitFrame();
    },
    onCollision: (kind, a, b, x, z, spd) =>
      aiRecorder.recordCollision({ kind, ballA: a, ballB: b, x, z, impactSpeed: spd }),
    onPocket: (ball, pocket, x, z) => aiRecorder.recordPocket(ball, pocket, x, z),
  });
  physics.beginShotTelemetry(1, true, 'player1', { targetBall: null, targetPocket: null });
  physics.strikeCueBall(0, 0.88, { x: 0, y: 0.2 });
  for (let i = 0; i < 300; i++) {
    physics.step(REPLAY_FIXED_DT);
    if (i > 45 && !physics.areAnyBallsMoving()) break;
  }
  physics.setShotStepObserver(null);
  const s1 = aiRecorder.finalizeShot({
    resultLabel: 'Opening Break Complete',
    isFoul: false,
    foulReason: null,
    tableOpenAfter: true,
    playerGroupsAfter: { player1: null, player2: null },
    pocketedNumbersAfter: [],
    activePlayerAfter: 'player2',
    ballInHandNext: false,
  });
  assert(s1 !== null && s1.frameCount >= 20, 'AI match break shot recorded cleanly');
  aiRecorder.recordTurnChange('player2', 'Master Elena');

  // Shot 2: AI defensive cushion safety shot
  const s2 = buildSyntheticShotFrames(aiRecorder, physics, {
    shotNumber: 2,
    mode: 'ai',
    shooter: 'player2',
    shooterName: 'Master Elena',
    isBreakShot: false,
    aimAngle: 0.35,
    power: 0.32,
    spin: { x: -0.15, y: 0 },
    collisions: [
      { kind: 'cue_ball', ballA: 0, ballB: 9, speed: 1.1, timeSec: 0.08 },
      { kind: 'cushion', ballA: 9, ballB: null, speed: 0.7, timeSec: 0.22 },
    ],
    resultLabel: 'No Ball Pocketed',
    isFoul: false,
    foulReason: null,
    tableOpenAfter: true,
    playerGroupsAfter: { player1: null, player2: null },
    pocketedNumbersAfter: [],
    activePlayerAfter: 'player1',
    ballInHandNext: false,
  });
  assert(s2 !== null);
  aiRecorder.recordTurnChange('player1', 'HeroCue');

  // Shot 3: Player 1 long distance + multi-ball pot (#1 & #2) + bank
  const s3 = buildSyntheticShotFrames(aiRecorder, physics, {
    shotNumber: 3,
    mode: 'ai',
    shooter: 'player1',
    shooterName: 'HeroCue',
    isBreakShot: false,
    aimAngle: 0.12,
    power: 0.74,
    spin: { x: 0.3, y: 0.2 },
    collisions: [
      { kind: 'cue_ball', ballA: 0, ballB: 1, speed: 2.3, timeSec: 0.05 },
      { kind: 'ball_ball', ballA: 1, ballB: 2, speed: 1.5, timeSec: 0.12 },
      { kind: 'cushion', ballA: 2, ballB: null, speed: 1.0, timeSec: 0.2 },
    ],
    pocketEvents: [
      { ball: 1, pocket: 'corner-tr', timeSec: 0.3 },
      { ball: 2, pocket: 'corner-br', timeSec: 0.33 },
    ],
    resultLabel: 'Pocketed #1, #2',
    isFoul: false,
    foulReason: null,
    tableOpenAfter: false,
    playerGroupsAfter: { player1: 'solids', player2: 'stripes' },
    pocketedNumbersAfter: [1, 2],
    activePlayerAfter: 'player1',
    ballInHandNext: false,
  });
  assert(s3 !== null);

  // Shot 4: Player 1 wins on 8-ball
  const s4 = buildSyntheticShotFrames(aiRecorder, physics, {
    shotNumber: 4,
    mode: 'ai',
    shooter: 'player1',
    shooterName: 'HeroCue',
    isBreakShot: false,
    aimAngle: -0.2,
    power: 0.62,
    spin: { x: 0, y: -0.25 },
    collisions: [{ kind: 'cue_ball', ballA: 0, ballB: 8, speed: 1.9, timeSec: 0.07 }],
    pocketEvents: [{ ball: 8, pocket: 'side-top', timeSec: 0.3 }],
    resultLabel: 'HeroCue Wins',
    isFoul: false,
    foulReason: null,
    tableOpenAfter: false,
    playerGroupsAfter: { player1: 'solids', player2: 'stripes' },
    pocketedNumbersAfter: [1, 2, 8],
    activePlayerAfter: 'player1',
    ballInHandNext: false,
  });
  assert(s4 !== null);

  const aiReplay = aiRecorder.buildMatchReplayRecord({
    winner: 'player1',
    loser: 'player2',
    finalResult: 'HeroCue legally pocketed the 8-Ball.',
    playerGroups: { player1: 'solids', player2: 'stripes' },
    pocketedNumbers: [1, 2, 8],
    authoritative: false,
  });
  assert(aiReplay !== null, 'AI MatchReplayRecord constructed');
  assert.equal(aiReplay.version, REPLAY_FORMAT_VERSION);
  assert.equal(aiReplay.matchType, 'ai');
  assert.equal(aiReplay.authoritative, false);
  assert.equal(aiReplay.totalShots, 4);
  assert.equal(aiReplay.shots[0].shotNumber, 1);
  assert.equal(aiReplay.shots[3].shotNumber, 4);
  assert(aiReplay.timelineEvents.some((e) => e.kind === 'break'));
  assert(aiReplay.timelineEvents.some((e) => e.kind === 'eight_ball_pocketed'));
  assert(aiReplay.timelineEvents.some((e) => e.kind === 'victory'));
  console.log(
    `PASS [1] Complete AI match recorded chronologically (${aiReplay.totalShots} shots, ${aiReplay.durationSec.toFixed(2)}s, ${aiReplay.timelineEvents.length} timeline events)`,
  );

  // ---------------------------------------------------------------------------
  // TEST 2: Local PvP Match Recording with Foul & Ball-in-Hand Events
  // ---------------------------------------------------------------------------
  const localRecorder = new ShotRecorder();
  localRecorder.beginMatch({
    matchId: 'match_local_pvp_002',
    createdAtMs: 1_700_000_500_000,
    matchType: 'local',
    gameMode: 'eightBall',
    ruleProfileId: 'wpa',
    calledShotsEnabled: true,
    authoritative: false,
    player1Name: 'Alice',
    player2Name: 'Bob',
  });
  buildSyntheticShotFrames(localRecorder, physics, {
    shotNumber: 1,
    mode: 'local',
    shooter: 'player1',
    shooterName: 'Alice',
    isBreakShot: true,
    aimAngle: 0,
    power: 0.78,
    spin: { x: 0, y: 0 },
    pocketEvents: [{ ball: 0, pocket: 'corner-tr', timeSec: 0.25 }],
    resultLabel: 'Foul · Cue Ball Scratched',
    isFoul: true,
    foulReason: 'Cue Ball Scratched',
    tableOpenAfter: true,
    playerGroupsAfter: { player1: null, player2: null },
    pocketedNumbersAfter: [],
    activePlayerAfter: 'player2',
    ballInHandNext: true,
  });
  localRecorder.recordBallInHand('player2', 'Bob', 'Cue Ball Scratched');
  localRecorder.recordTurnChange('player2', 'Bob');
  buildSyntheticShotFrames(localRecorder, physics, {
    shotNumber: 2,
    mode: 'local',
    shooter: 'player2',
    shooterName: 'Bob',
    isBreakShot: false,
    aimAngle: 0.1,
    power: 0.55,
    spin: { x: 0, y: 0 },
    pocketEvents: [{ ball: 8, pocket: 'corner-br', timeSec: 0.28 }],
    resultLabel: 'Bob Wins',
    isFoul: false,
    foulReason: null,
    tableOpenAfter: false,
    playerGroupsAfter: { player1: 'solids', player2: 'stripes' },
    pocketedNumbersAfter: [8],
    activePlayerAfter: 'player2',
    ballInHandNext: false,
  });
  const localReplay = localRecorder.buildMatchReplayRecord({
    winner: 'player2',
    loser: 'player1',
    finalResult: 'Bob pocketed the 8-Ball.',
    playerGroups: { player1: 'solids', player2: 'stripes' },
    pocketedNumbers: [8],
    authoritative: false,
  });
  assert(localReplay !== null);
  assert.equal(localReplay.matchType, 'local');
  assert.equal(localReplay.ruleProfileId, 'wpa');
  assert(localReplay.timelineEvents.some((e) => e.kind === 'foul'));
  assert(localReplay.timelineEvents.some((e) => e.kind === 'ball_in_hand'));
  assert(localReplay.highlights.some((h) => h.category === 'foul'));
  console.log('PASS [2] Local PvP match recorded with fouls, ball-in-hand, and turn changes');

  // ---------------------------------------------------------------------------
  // TEST 3: Online Authoritative Resampled Match Recording
  // ---------------------------------------------------------------------------
  const onlineRecorder = new ShotRecorder();
  onlineRecorder.beginMatch({
    matchId: 'match_online_ranked_003',
    createdAtMs: 1_700_001_000_000,
    matchType: 'online',
    onlineSubType: 'ranked',
    gameMode: 'eightBall',
    ruleProfileId: 'wpa',
    calledShotsEnabled: true,
    authoritative: true,
    player1Id: 'player_1_id',
    player1Name: 'RankedAce',
    player2Id: 'player_2_id',
    player2Name: 'Contender',
  });
  onlineRecorder.beginShot({
    shotNumber: 1,
    mode: 'online',
    shooter: 'player1',
    shooterName: 'RankedAce',
    isBreakShot: true,
    cueAngle: 0,
    power: 0.9,
    spin: { x: 0.1, y: 0 },
    calledShot: { targetBall: null, targetPocket: null },
  });
  const makeOnlineBalls = (cueX: number, b8Pocketed: boolean): OnlineBallFrame[] =>
    Array.from({ length: 16 }, (_, n) => ({
      number: n,
      x: n === 0 ? cueX : -0.5 + n * 0.06,
      y: TABLE_DIMENSIONS.surfaceY + 0.028575,
      z: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      vx: n === 0 ? 2.4 : 0,
      vy: 0,
      vz: 0,
      pocketed: n === 8 ? b8Pocketed : false,
    }));
  onlineRecorder.pushOnlineSample(makeOnlineBalls(-0.5, false));
  await new Promise((r) => setTimeout(r, 40));
  onlineRecorder.pushOnlineSample(makeOnlineBalls(0.1, false));
  onlineRecorder.recordPocket(8, 'corner-tr');
  await new Promise((r) => setTimeout(r, 35));
  onlineRecorder.finalizeShot({
    resultLabel: 'RankedAce Wins',
    isFoul: false,
    foulReason: null,
    finalOnlineBalls: makeOnlineBalls(0.25, true),
  });
  const onlineReplay = onlineRecorder.buildMatchReplayRecord({
    winner: 'player1',
    loser: 'player2',
    finalResult: 'RankedAce legally sank the 8-Ball.',
    playerGroups: { player1: 'solids', player2: 'stripes' },
    pocketedNumbers: [8],
    authoritative: true,
    localPlayerPerspective: 'player2',
  });
  assert(onlineReplay !== null);
  assert.equal(onlineReplay.matchType, 'online');
  assert.equal(onlineReplay.authoritative, true);
  assert.equal(onlineReplay.shots[0].timestepSec, REPLAY_FIXED_DT);
  assert(onlineReplay.timelineEvents.some((e) => e.kind === 'defeat'));
  console.log('PASS [3] Online authoritative resampled match replay & perspective defeat timeline verified');

  // ---------------------------------------------------------------------------
  // TEST 4 & 5: Persistent Storage, LRU Eviction, Deduplication, JSON Export/Import & Corruption Guard
  // ---------------------------------------------------------------------------
  const storage = new ReplayStorageService();
  storage.configure({ maxCount: 2, maxBytes: 10 * 1024 * 1024 });

  await storage.saveReplay(aiReplay);
  await storage.saveReplay(localReplay);
  await storage.saveReplay(onlineReplay); // triggers LRU eviction of oldest so count stays <= 2

  const listed = await storage.listSavedReplays();
  assert.equal(listed.length, 2, 'Storage must enforce configurable maxCount limit via LRU');
  const stats = await storage.getStorageStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.maxCount, 2);
  assert(stats.totalBytes > 0);
  assert.equal(stats.backend, 'memory');

  // Deduplication by matchId
  const duplicateReplay: MatchReplayRecord = {
    ...onlineReplay,
    replayId: 'replay_duplicate_alias',
    savedAtMs: Date.now() + 50,
  };
  await storage.saveReplay(duplicateReplay);
  const afterDedup = await storage.listSavedReplays();
  assert.equal(
    afterDedup.filter((r) => r.matchId === onlineReplay.matchId).length,
    1,
    'Duplicate replays for the same matchId must be deduplicated',
  );

  const loaded = await storage.loadReplay(duplicateReplay.replayId);
  assert(loaded !== null);
  assert.equal(loaded.shots.length, onlineReplay.shots.length);
  assert(loaded.shots[0].framesData instanceof Float32Array);

  // Export & Import lossless round-trip + authoritative forced false on import
  const exportedJson = storage.exportReplayToJson(aiReplay);
  const imported = await storage.importReplayFromJson(exportedJson);
  assert.equal(imported.ok, true, 'Valid exported replay JSON must import cleanly');
  if (imported.ok) {
    assert.equal(
      imported.replay.authoritative,
      false,
      'Security invariant: imported replay JSON must NEVER be trusted as authoritative',
    );
    assert.equal(imported.replay.shots.length, aiReplay.shots.length);
    assert(Math.abs(imported.replay.shots[0].framesData[0] - aiReplay.shots[0].framesData[0]) < 1e-6);
  }

  // Corrupt / Malformed / Tampered JSON validation rejections
  for (const badPayload of [
    '',
    'not valid json {',
    JSON.stringify({ format: 'wrong', version: 1, replay: {} }),
    JSON.stringify({ format: 'ultimate-pool-3d-replay', version: 99, replay: {} }),
    JSON.stringify({ format: 'ultimate-pool-3d-replay', version: 1, replay: { matchType: 'ai', shots: [] } }),
    JSON.stringify({
      format: 'ultimate-pool-3d-replay',
      version: 1,
      replay: {
        matchType: 'ai',
        player1: { name: 'A' },
        player2: { name: 'B' },
        shots: [{ frameCount: 5, durationSec: 1, timestepSec: 1 / 60, framesBase64: 'AAAA' }],
      },
    }),
  ]) {
    const res = storage.validateAndParseImportJson(badPayload);
    assert.equal(res.ok, false, 'Corrupted/invalid replay payload must be rejected safely');
  }

  await storage.deleteReplay(duplicateReplay.replayId);
  const afterDelete = await storage.loadReplay(duplicateReplay.replayId);
  assert.equal(afterDelete, null, 'Deleted replay must no longer load');
  console.log('PASS [4] ReplayStorage persistence, LRU eviction, deduplication, export/import & corruption rejection verified');

  // ---------------------------------------------------------------------------
  // TEST 6 & 7: Full-Match ReplayController (Play/Pause, Seek, Prev/Next, Start/End, 0.25x..4x, Highlights, Isolation)
  // ---------------------------------------------------------------------------
  const matchCtrl = new ReplayController();
  const backup = captureBackupFromPhysics(physics);
  const versionBefore = physics.getWorldVersion();
  const matchMgr = new MatchManager();
  matchMgr.startMatch({ gameMode: 'eightBall', opponentType: 'ai' });
  const mgrSnapBefore = JSON.stringify(matchMgr.getSnapshot());

  matchCtrl.enterMatchReplay(aiReplay, backup);
  assert.equal(matchCtrl.isActive(), true);
  assert.equal(matchCtrl.getMode(), 'match');
  assert.equal(matchCtrl.getTotalShots(), 4);
  assert.equal(matchCtrl.getCurrentShotIndex(), 0);

  // Speeds including 4x
  for (const spd of [0.25, 0.5, 1, 2, 4] as const) {
    matchCtrl.jumpToBeginning();
    matchCtrl.setSpeed(spd);
    matchCtrl.step(0.05);
    assert(
      Math.abs(matchCtrl.getMatchTimeSec() - 0.05 * spd) < 1e-4,
      `Match playback speed ${spd}x mismatch`,
    );
  }

  // Next / Prev / Beginning / End
  assert.equal(matchCtrl.nextShot(), true);
  assert.equal(matchCtrl.getCurrentShotIndex(), 1);
  assert.equal(matchCtrl.prevShot(), true);
  assert.equal(matchCtrl.getCurrentShotIndex(), 0);
  matchCtrl.jumpToEnd();
  assert.equal(matchCtrl.getCurrentShotIndex(), 3);
  assert.equal(matchCtrl.isPlaying(), false);
  matchCtrl.jumpToBeginning();
  assert.equal(matchCtrl.getCurrentShotIndex(), 0);
  assert.equal(matchCtrl.isPlaying(), true);

  // Timeline scrubbing across shots
  const shot3Start = aiReplay.shots[2].startMatchTimeSec ?? 0;
  matchCtrl.seekMatch(shot3Start + 0.1);
  assert.equal(matchCtrl.getCurrentShotIndex(), 2, 'Seeking match timeline jumps cleanly into shot #3');
  const dynState = matchCtrl.getMatchStateAtCurrentTime();
  assert(dynState !== null);

  // Highlight generation & jump
  const highlights = generateMatchHighlights(aiReplay);
  assert(highlights.some((h) => h.category === 'break'), 'Detected Break highlight');
  assert(highlights.some((h) => h.category === 'defensive'), 'Detected Defensive Safety highlight');
  assert(highlights.some((h) => h.category === 'multi_pocket'), 'Detected Multi-Ball highlight');
  assert(highlights.some((h) => h.category === 'bank_or_combo'), 'Detected Bank/Carom highlight');
  assert(highlights.some((h) => h.category === 'eight_ball'), 'Detected 8-Ball highlight');
  assert(highlights.some((h) => h.category === 'winning_moment'), 'Detected Winning Moment highlight');

  const multiHl = highlights.find((h) => h.category === 'multi_pocket')!;
  const jumped = matchCtrl.jumpToHighlight(multiHl.id);
  assert(jumped !== null && jumped.id === multiHl.id);
  assert.equal(matchCtrl.getShot()?.id, multiHl.shotId);

  // Ensure live physics and MatchManager remained 100% isolated during replay
  assert.equal(physics.getWorldVersion(), versionBefore);
  assert.equal(JSON.stringify(matchMgr.getSnapshot()), mgrSnapBefore);

  const restored = matchCtrl.exitReplay();
  assert.equal(matchCtrl.isActive(), false);
  assert.equal(restored.length, backup.length);
  console.log('PASS [5] Match ReplayController (0.25x-4x, scrubbing, prev/next, highlights, physics isolation) verified');

  // ---------------------------------------------------------------------------
  // TEST 8: Replay Camera Controller Modes (All 6 Independent Replay Cameras + Restore)
  // ---------------------------------------------------------------------------
  const noopRoot = { addEventListener: () => {}, removeEventListener: () => {} };
  const fakeDom = {
    style: {},
    clientWidth: 1280,
    clientHeight: 720,
    ownerDocument: noopRoot,
    addEventListener: () => {},
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getRootNode: () => noopRoot,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  } as unknown as HTMLElement;
  const camCtrl = new CameraController(fakeDom, 16 / 9, true);

  camCtrl.setPreset('threeQuarter');
  camCtrl.update(0.016, false);
  const preReplayPos = camCtrl.camera.position.clone();
  camCtrl.saveBeforeReplay();

  const camModes: ReplayCameraMode[] = [
    'original',
    'topDown',
    'free',
    'cinematic',
    'ballFollow',
    'shotFocused',
  ];
  for (const cm of camModes) {
    camCtrl.updateReplayCamera(
      cm,
      {
        cueBallPos: new THREE.Vector3(-0.3, TABLE_DIMENSIONS.surfaceY + 0.0285, 0.1),
        focusBallPos: new THREE.Vector3(0.4, TABLE_DIMENSIONS.surfaceY + 0.0285, -0.2),
        cueAngle: 0.25,
        elapsedSec: 1.5,
      },
      0.016,
    );
    assert(Number.isFinite(camCtrl.camera.position.x));
    assert(camCtrl.camera.position.y >= 0.35, `Camera mode ${cm} stays above floor`);
  }
  camCtrl.restoreAfterReplay();
  assert(
    camCtrl.camera.position.distanceTo(preReplayPos) < 1e-4,
    'Exiting replay restores exact pre-replay gameplay camera pose',
  );
  console.log('PASS [6] All 6 Replay Camera Modes & pre-replay camera pose restoration verified');

  // ---------------------------------------------------------------------------
  // TEST 9: Store Action Lockout + Video Recorder Unsupported Fallback + SSR UI Contracts
  // ---------------------------------------------------------------------------
  assert.equal(
    ReplayVideoRecorder.isSupported(),
    false,
    'Headless Node env safely reports video recording unsupported without throwing',
  );

  const store = useGameStore.getState();
  store.resetMatchStats();
  store.setScreen('playing');
  store.updateMatchConfig({ opponentType: 'ai' });
  useGameStore.setState({ activePlayer: 'player1', matchPhase: 'OPEN_TABLE' });
  assert.equal(canLocalPlayerAct(useGameStore.getState()), true);

  store.setReplayShots(aiReplay.shots.map(summarizeRecordedShot).reverse());
  store.setReplayUiState({
    replayActive: true,
    replayMode: 'match',
    replayMatchId: aiReplay.matchId,
    replayShotId: aiReplay.shots[0].id,
    replayShotIndex: 0,
    replayTotalShots: aiReplay.shots.length,
    replayPlaying: true,
    replayTimeSec: 0.1,
    replayDurationSec: aiReplay.shots[0].durationSec,
    replayMatchTimeSec: 0.1,
    replayMatchDurationSec: aiReplay.durationSec,
    replaySpeed: 4,
    replayCameraMode: 'cinematic',
    replayHighlights: highlights,
    replayMatchMeta: {
      matchId: aiReplay.matchId,
      replayId: aiReplay.replayId,
      matchType: 'ai',
      ruleProfileId: 'casual',
      player1Name: 'HeroCue',
      player2Name: 'Master Elena',
      player1Group: 'solids',
      player2Group: 'stripes',
      player1PocketedCount: 3,
      player2PocketedCount: 0,
      winner: 'player1',
      finalResult: aiReplay.finalResult,
      authoritative: false,
    },
  });
  assert.equal(canLocalPlayerAct(useGameStore.getState()), false, 'Replay locks live shot actions');

  // Zustand v5 SSR reads getInitialState() via React useSyncExternalStore server snapshot
  Object.assign(useGameStore.getInitialState(), useGameStore.getState());

  const overlayHtml = renderToStaticMarkup(
    React.createElement(ReplayOverlay, {
      onExitReplay: () => {},
      onSelectShot: () => {},
      onPrevShot: () => {},
      onNextShot: () => {},
      onJumpToStart: () => {},
      onJumpToEnd: () => {},
      onJumpToHighlight: () => {},
      onTogglePlay: () => {},
      onRestart: () => {},
      onSeek: () => {},
      onSetSpeed: () => {},
      onSetCameraMode: () => {},
      onToggleAutoSlowMo: () => {},
      onToggleAnalysis: () => {},
      onJumpToImpact: () => {},
      onExportJson: () => {},
      onStartVideoRecording: () => {},
      onStopVideoRecording: () => {},
    }),
  );
  assert(overlayHtml.includes('data-testid="replay-overlay"'));
  assert(overlayHtml.includes('data-testid="replay-speed-4"'));
  assert(overlayHtml.includes('data-testid="replay-cam-cinematic"'));
  assert(overlayHtml.includes('data-testid="replay-cam-free"'));
  assert(overlayHtml.includes('data-testid="replay-cam-ballFollow"'));
  assert(overlayHtml.includes('data-testid="replay-cam-shotFocused"'));
  assert(overlayHtml.includes('data-testid="replay-tab-highlights"'));
  assert(overlayHtml.includes('data-testid="replay-export-json-btn"'));
  assert(overlayHtml.includes('data-testid="replay-match-scoreboard"'));
  assert(!overlayHtml.includes('animate-pulse'), 'ReplayOverlay must have zero animate-pulse');
  assert(!overlayHtml.includes('border-l-4'), 'ReplayOverlay must have zero border-l-4');
  assert(!overlayHtml.includes('backdrop-blur'), 'ReplayOverlay must have zero backdrop-blur');

  // Verify Match History tab renders unified saved AI/Local/Online replays + filters cleanly
  const savedSummaries = await storage.listSavedReplays();
  store.setSavedReplays(savedSummaries, stats);
  store.openProgressionModal('history');
  Object.assign(useGameStore.getInitialState(), useGameStore.getState());
  const historyHtml = renderToStaticMarkup(React.createElement(ProgressionModal));
  assert(historyHtml.includes('data-testid="match-history-panel"'));
  assert(historyHtml.includes('data-testid="history-mode-all"'));
  assert(historyHtml.includes('data-testid="history-mode-ai"'));
  assert(historyHtml.includes('data-testid="history-mode-online"'));
  assert(historyHtml.includes('data-testid="history-mode-local"'));
  assert(historyHtml.includes('data-testid="history-result-won"'));
  assert(historyHtml.includes('data-testid="history-result-lost"'));
  assert(historyHtml.includes('data-testid="import-replay-btn"'));
  assert(historyHtml.includes('Watch Replay'));
  assert(!historyHtml.includes('animate-pulse'), 'ProgressionModal must have zero animate-pulse');
  assert(!historyHtml.includes('border-l-4'), 'ProgressionModal must have zero border-l-4');

  // Test dummy float buffer helper compiles/works cleanly too
  const dummyBuf = makeDummyFrameData(10, -0.5, 0.4, 3);
  assert.equal(dummyBuf.length, 10 * REPLAY_FLOATS_PER_FRAME);

  store.closeProgressionModal();
  store.resetReplayUiState();
  Object.assign(useGameStore.getInitialState(), useGameStore.getState());
  physics.dispose();
  console.log('PASS [7] ReplayOverlay SSR, Match History archive UI, VideoRecorder fallback & UI hygiene verified');
  console.log('ALL PHASE 13 REPLAY & HIGHLIGHT VERIFICATION CHECKS PASSED!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
