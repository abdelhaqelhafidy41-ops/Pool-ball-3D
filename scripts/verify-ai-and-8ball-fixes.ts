import assert from 'node:assert/strict';
import { WorkerMatchManager } from '../cloudflare/src/WorkerMatchManager';
import { ServerMatchManager } from '../server/ServerMatchManager';
import { AIPhysicsSimulator } from '../src/game/ai/AIPhysicsSimulator';
import { AITurnController } from '../src/game/ai/AITurnController';
import { PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import { canTargetEightBall, getLegalTargetBalls } from '../src/game/rules/BallGroupManager';
import { MatchManager } from '../src/game/rules/MatchManager';
import type { BallGroup, PlayerId, PocketEvent, PocketId, ShotTelemetry } from '../src/game/rules/types';
import { POCKET_POSITIONS, TABLE_DIMENSIONS } from '../src/game/utils/constants';
import { useGameStore, type CueSpin } from '../src/store/useGameStore';

function pe(shotId: number, ballNumber: number, pocketId: PocketId, order: number): PocketEvent {
  return { shotId, ballNumber, pocketId, order, timestampMs: order * 100 };
}

function runShotInPhysics(
  physics: PhysicsWorld,
  matchManager: MatchManager,
  power: number,
  angle: number,
  spin: CueSpin,
  maxSteps = 900,
): { telemetry: ShotTelemetry; snapshot: ReturnType<MatchManager['getSnapshot']> } {
  const preSnap = matchManager.getSnapshot();
  assert.equal(matchManager.beginShot(), true, 'Expected MatchManager.beginShot() to succeed');
  physics.beginShotTelemetry(
    preSnap.totalMatchShots + 1,
    preSnap.isBreakShot,
    preSnap.activePlayer,
    preSnap.calledShot,
  );
  physics.strikeCueBall(angle, power, spin);

  // Step deterministic 1/60s simulation frames until balls settle
  for (let i = 0; i < maxSteps; i++) {
    physics.step(1 / 60);
    if (i > 2 && !physics.areAnyBallsMoving()) {
      break;
    }
  }
  assert.equal(physics.areAnyBallsMoving(), false, 'Expected balls to come to rest');

  const telemetry = physics.finalizeShotTelemetry();
  const { snapshot } = matchManager.settleShot(telemetry);
  if (snapshot.phase === 'BALL_IN_HAND') {
    const spot = physics.findNearestValidCuePlacement(snapshot.ballInHandZone);
    physics.setCueBallPlacement(spot.x, spot.z);
    useGameStore.getState().setCuePlacementPreview(spot.x, spot.z, true, null);
  } else if (!physics.isCueBallAvailable() && snapshot.phase !== 'GAME_OVER') {
    physics.respotCueBall();
  }
  useGameStore.getState().syncFromMatchSnapshot(snapshot);
  return { telemetry, snapshot };
}

function setupClearBoard(
  physics: PhysicsWorld,
  balls: Array<{ number: number; x: number; z: number }>,
): void {
  const byNum = new Map(balls.map((b) => [b.number, b]));
  for (let num = 0; num <= 15; num++) {
    const entry = byNum.get(num);
    if (entry) {
      physics.setBallState(num, entry.x, entry.z, false);
    } else {
      physics.setBallState(num, 10 + num * 0.25, 10, true);
    }
  }
}

async function waitForStrike(
  trigger: () => void,
  getStrikeCount: () => number,
  targetCount: number,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  trigger();
  while (getStrikeCount() < targetCount) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for AI strike #${targetCount}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setupServerWithAssignedGroup(
  shooterGroup: 'solids' | 'stripes',
  remainingOwnBalls: number[],
  options?: { calledShotsEnabled?: boolean },
): Promise<ServerMatchManager> {
  const sm = new ServerMatchManager({
    roomId: 'room-test',
    roomCode: 'TEST01',
    ruleProfileId: options?.calledShotsEnabled ? 'wpa' : 'casual',
    calledShotsEnabled: options?.calledShotsEnabled ?? false,
    player1Name: 'Alice',
    player2Name: 'Bob',
    callbacks: {
      onShotStarted: () => {},
      onPhysicsFrame: () => {},
      onPocket: () => {},
      onSettled: () => {},
      onGameOver: () => {},
    },
  });
  await sm.init();

  const allOwn = shooterGroup === 'solids' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
  const oppBalls = shooterGroup === 'solids' ? [9, 10, 11] : [1, 2, 3];
  const prePocketed = allOwn.filter((n) => !remainingOwnBalls.includes(n));

  // Break: legal hit without pocketing -> Player 2's turn on open table, then Player 2 misses, back to Player 1, OR directly assign groups via a legal open-table shot
  const anyInternal = sm as unknown as {
    phase: string;
    isBreakShot: boolean;
    tableOpen: boolean;
    playerGroups: Record<PlayerId, BallGroup>;
    pocketedSet: Set<number>;
  };
  anyInternal.phase = 'GROUPS_ASSIGNED';
  anyInternal.isBreakShot = false;
  anyInternal.tableOpen = false;
  anyInternal.playerGroups = {
    player1: shooterGroup,
    player2: shooterGroup === 'solids' ? 'stripes' : 'solids',
  };
  anyInternal.pocketedSet = new Set(prePocketed);

  // Sync physics balls to match remaining balls
  const internalPhysics = sm.physics as unknown as { balls: Map<number, { body: { setTranslation: (t: { x: number; y: number; z: number }, wake: boolean) => void }; pocketed: boolean }> };
  if (internalPhysics?.balls) {
    for (const [num, entry] of internalPhysics.balls) {
      if (prePocketed.includes(num)) {
        entry.pocketed = true;
      } else if (num !== 0 && num !== 8 && !remainingOwnBalls.includes(num) && !oppBalls.includes(num)) {
        // leave or ignore
      }
    }
  }
  return sm;
}

async function setupWorkerMatchWithAssignedGroup(
  shooterGroup: 'solids' | 'stripes',
  remainingOwnBalls: number[],
  options?: { calledShotsEnabled?: boolean },
): Promise<WorkerMatchManager> {
  const wm = new WorkerMatchManager({
    roomId: 'wroom-test',
    roomCode: 'WTST01',
    ruleProfileId: options?.calledShotsEnabled ? 'wpa' : 'casual',
    calledShotsEnabled: options?.calledShotsEnabled ?? false,
    player1Name: 'Alice',
    player2Name: 'Bob',
    callbacks: {
      onShotStarted: () => {},
      onPhysicsFrame: () => {},
      onPocket: () => {},
      onSettled: () => {},
      onGameOver: () => {},
    },
  });
  await wm.init();

  const allOwn = shooterGroup === 'solids' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
  const prePocketed = allOwn.filter((n) => !remainingOwnBalls.includes(n));

  const anyInternal = wm as unknown as {
    phase: string;
    isBreakShot: boolean;
    tableOpen: boolean;
    playerGroups: Record<PlayerId, BallGroup>;
    pocketedSet: Set<number>;
  };
  anyInternal.phase = 'GROUPS_ASSIGNED';
  anyInternal.isBreakShot = false;
  anyInternal.tableOpen = false;
  anyInternal.playerGroups = {
    player1: shooterGroup,
    player2: shooterGroup === 'solids' ? 'stripes' : 'solids',
  };
  anyInternal.pocketedSet = new Set(prePocketed);
  return wm;
}

function setupLocalMatchWithAssignedGroup(
  shooterGroup: 'solids' | 'stripes',
  remainingOwnBalls: number[],
  options?: { calledShotsEnabled?: boolean; opponentType?: 'pvp' | 'ai' },
): MatchManager {
  const mm = new MatchManager({
    opponentType: options?.opponentType ?? 'pvp',
    ruleProfileId: options?.calledShotsEnabled ? 'wpa' : 'casual',
    calledShotsEnabled: options?.calledShotsEnabled ?? false,
    startingBreaker: 'player1',
  });
  mm.startMatch();

  const allOwn = shooterGroup === 'solids' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
  const prePocketed = allOwn.filter((n) => !remainingOwnBalls.includes(n));

  // Break legally, pocketing no balls -> switches to player2, player2 misses -> back to player1
  // Even faster and deterministic: drive via real settleShot calls to reach GROUPS_ASSIGNED for player1!
  mm.beginShot();
  mm.settleShot({
    shotId: 1,
    isBreakShot: true,
    shooter: 'player1',
    calledShot: { targetBall: null, targetPocket: null },
    firstBallContacted: allOwn[0],
    allBallsContacted: [allOwn[0]],
    pocketEvents: [pe(1, prePocketed[0] ?? allOwn[0], 'corner-tr', 1)],
    cueBallPocketed: false,
    railContactBalls: [1, 2, 3, 4],
    anyBallContactedRail: true,
    settledPositions: [],
  });

  // Next shot assigns group on open table
  const assignBall = prePocketed.length > 1 ? prePocketed[1] : (shooterGroup === 'solids' ? 1 : 9);
  mm.setCalledShot(assignBall, 'corner-tr');
  mm.beginShot();
  mm.settleShot({
    shotId: 2,
    isBreakShot: false,
    shooter: 'player1',
    calledShot: { targetBall: assignBall, targetPocket: 'corner-tr' },
    firstBallContacted: assignBall,
    allBallsContacted: [assignBall],
    pocketEvents: [pe(2, assignBall, 'corner-tr', 1)],
    cueBallPocketed: false,
    railContactBalls: [assignBall],
    anyBallContactedRail: true,
    settledPositions: [],
  });

  // Pocket remaining prePocketed balls cleanly
  let shotSeq = 3;
  for (const ballNum of prePocketed) {
    if (ballNum === prePocketed[0] || ballNum === assignBall) continue;
    const id = shotSeq++;
    mm.setCalledShot(ballNum, 'side-top');
    mm.beginShot();
    mm.settleShot({
      shotId: id,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: ballNum, targetPocket: 'side-top' },
      firstBallContacted: ballNum,
      allBallsContacted: [ballNum],
      pocketEvents: [pe(id, ballNum, 'side-top', 1)],
      cueBallPocketed: false,
      railContactBalls: [ballNum],
      anyBallContactedRail: true,
      settledPositions: [],
    });
  }

  return mm;
}

async function runTests() {
  const results: Array<{ id: string; name: string; passed: boolean; detail: string }> = [];

  const test = async (id: string, name: string, fn: () => Promise<string> | string) => {
    try {
      const detail = await fn();
      results.push({ id, name, passed: true, detail });
      console.log(`PASS [${id}] ${name}: ${detail}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ id, name, passed: false, detail: msg });
      console.error(`FAIL [${id}] ${name}: ${msg}`);
    }
  };

  // ============================================================================
  // PART A — AI TURN EXECUTION & LIFECYCLE (8 TESTS)
  // ============================================================================

  const physics = new PhysicsWorld();
  await physics.init();

  await test('AI-1', 'Human finishes shot -> turn transfers to AI -> AI executes real physical shot', async () => {
    const mm = new MatchManager({
      opponentType: 'ai',
      aiDifficulty: 'intermediate',
      aiThinkingSpeed: 'fast',
      startingBreaker: 'player1',
    });
    const startSnap = mm.startMatch();
    useGameStore.getState().setScreen('playing');
    useGameStore.getState().setSettingsOpen(false);
    useGameStore.getState().syncFromMatchSnapshot(startSnap);

    setupClearBoard(physics, [
      { number: 0, x: -0.5, z: 0 },
      { number: 1, x: 0.0, z: 0.25 },
      { number: 9, x: 0.7, z: -0.35 },
      { number: 8, x: 0.4, z: -0.2 },
    ]);

    let strikeCount = 0;
    let lastStrike: { power: number; angle: number; spin: CueSpin } | null = null;
    const ctrl = new AITurnController(mm, physics, {
      isDisposed: () => false,
      onExecuteStrike: (power, angle, spin) => {
        strikeCount++;
        lastStrike = { power, angle, spin };
      },
    });

    // Player 1 hits #1 away from pockets (hits rail cleanly with no pot)
    const aimAtOne = Math.atan2(0.25 - 0, 0.0 - -0.5);
    const { snapshot: afterP1 } = runShotInPhysics(physics, mm, 0.28, aimAtOne, { x: 0, y: 0 });
    assert.equal(afterP1.activePlayer, 'player2', 'Turn must switch to AI (player2)');
    assert.equal(mm.isActivePlayerAi(), true, 'MatchManager must report active player is AI');

    await waitForStrike(() => ctrl.scheduleTurnIfNeeded(), () => strikeCount, 1);
    const strike = lastStrike as { power: number; angle: number; spin: CueSpin } | null;
    assert.ok(strike !== null, 'AI strike callback must fire');

    const { snapshot: afterAi } = runShotInPhysics(physics, mm, strike.power, strike.angle, strike.spin);
    assert.notEqual(afterAi.phase, 'BALLS_MOVING', 'Match must settle after AI strike');
    assert.equal(useGameStore.getState().isAiThinking, false, 'isAiThinking must reset after strike');
    ctrl.dispose();
    return `AI fired strike (power=${strike.power.toFixed(2)}, totalMatchShots=${afterAi.totalMatchShots})`;
  });

  await test('AI-2', 'Multi-turn alternation: P1 -> AI pots & continues -> AI misses -> returns to P1 -> AI again', async () => {
    const mm = new MatchManager({
      opponentType: 'ai',
      aiDifficulty: 'pro',
      aiThinkingSpeed: 'fast',
      startingBreaker: 'player1',
    });
    useGameStore.getState().setScreen('playing');
    useGameStore.getState().setSettingsOpen(false);
    useGameStore.getState().syncFromMatchSnapshot(mm.startMatch());

    let strikeCount = 0;
    let lastStrike: { power: number; angle: number; spin: CueSpin } | null = null;
    const ctrl = new AITurnController(mm, physics, {
      isDisposed: () => false,
      onExecuteStrike: (power, angle, spin) => {
        strikeCount++;
        lastStrike = { power, angle, spin };
      },
    });

    // Place #1 directly in front of corner-tr so AI pots it cleanly, plus #2 far/blocked and #9 across table
    setupClearBoard(physics, [
      { number: 0, x: -0.6, z: 0.0 },
      { number: 1, x: 0.92, z: -0.44 }, // near corner-tr (+1.12, -0.56)
      { number: 2, x: -0.8, z: 0.38 },
      { number: 9, x: 0.2, z: 0.35 },
      { number: 8, x: 0.0, z: 0.0 },
    ]);

    // Human breaks safely into #9 without pocketing -> turn passes to AI
    const aimAtNine = Math.atan2(0.35 - 0, 0.2 - -0.6);
    const { snapshot: s1 } = runShotInPhysics(physics, mm, 0.36, aimAtNine, { x: 0, y: 0 });
    assert.equal(s1.activePlayer, 'player2');

    // AI turn 1
    await waitForStrike(() => ctrl.scheduleTurnIfNeeded(), () => strikeCount, 1);
    const { snapshot: s2 } = runShotInPhysics(physics, mm, lastStrike!.power, lastStrike!.angle, lastStrike!.spin);

    // If AI potted a ball and retained turn, ensure AI executes turn 2 without stalling
    if (s2.activePlayer === 'player2' && s2.phase !== 'GAME_OVER') {
      await waitForStrike(() => ctrl.scheduleTurnIfNeeded(), () => strikeCount, 2);
      runShotInPhysics(physics, mm, lastStrike!.power, lastStrike!.angle, lastStrike!.spin);
    }

    // Now force clean handoff back to P1 via Ball-in-Hand or direct check, then P1 misses again -> AI resumes
    if (mm.getActivePlayer() === 'player2' && mm.getPhase() !== 'GAME_OVER') {
      if (mm.getPhase() === 'BALL_IN_HAND') {
        mm.confirmBallInHandPlacement();
      }
      // Make AI miss intentionally using telemetry
      mm.beginShot();
      mm.settleShot({
        shotId: 99,
        isBreakShot: false,
        shooter: 'player2',
        calledShot: { targetBall: null, targetPocket: null },
        firstBallContacted: 8,
        allBallsContacted: [8],
        pocketEvents: [],
        cueBallPocketed: false,
        railContactBalls: [8],
        anyBallContactedRail: true,
        settledPositions: [],
      });
    }
    assert.equal(mm.getActivePlayer(), 'player1', 'Turn must return to P1');
    // P1 misses cleanly without potting
    if (mm.getPhase() === 'BALL_IN_HAND') mm.confirmBallInHandPlacement();
    mm.beginShot();
    mm.settleShot({
      shotId: 100,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: null, targetPocket: null },
      firstBallContacted: mm.getBallGroup('player1') === 'stripes' ? 9 : 2,
      allBallsContacted: [],
      pocketEvents: [],
      cueBallPocketed: false,
      railContactBalls: [2],
      anyBallContactedRail: true,
      settledPositions: [],
    });
    assert.equal(mm.getActivePlayer(), 'player2', 'Turn must return to AI on P1 miss');

    const prevCount = strikeCount;
    await waitForStrike(() => ctrl.scheduleTurnIfNeeded(), () => strikeCount, prevCount + 1);
    assert.equal(strikeCount, prevCount + 1, 'AI must execute again on subsequent turn');
    ctrl.dispose();
    return `Completed multi-turn alternation cleanly (${strikeCount} AI strikes executed)`;
  });

  await test('AI-3', 'AI Ball-in-Hand glide over blocking object ball + break + 8-ball shot', async () => {
    const mm = new MatchManager({
      opponentType: 'ai',
      aiDifficulty: 'pro',
      aiThinkingSpeed: 'fast',
      startingBreaker: 'player2',
    });
    useGameStore.getState().setScreen('playing');
    useGameStore.getState().setSettingsOpen(false);
    useGameStore.getState().syncFromMatchSnapshot(mm.startMatch());

    let strikeCount = 0;
    let lastStrike: { power: number; angle: number; spin: CueSpin } | null = null;
    const ctrl = new AITurnController(mm, physics, {
      isDisposed: () => false,
      onExecuteStrike: (power, angle, spin) => {
        strikeCount++;
        lastStrike = { power, angle, spin };
      },
    });

    // 3a. AI Opening Break
    physics.resetRack();
    await waitForStrike(() => ctrl.scheduleTurnIfNeeded(), () => strikeCount, 1);
    assert.ok(lastStrike!.power >= 0.7, 'AI break must use strong break power');

    // 3b. AI Ball-in-Hand with an object ball sitting directly along the glide path!
    mm.startMatch({ startingBreaker: 'player1' });
    setupClearBoard(physics, [
      { number: 0, x: -0.6, z: 0.0 },
      { number: 1, x: 0.0, z: 0.0 }, // Blocking midpoint on straight line from head spot toward foot spot!
      { number: 2, x: 0.75, z: -0.35 },
      { number: 9, x: -0.4, z: 0.35 },
      { number: 8, x: 0.3, z: 0.25 },
    ]);

    // Human scratches on break -> AI gets Ball-in-Hand!
    mm.beginShot();
    const bihSnap = mm.settleShot({
      shotId: 1,
      isBreakShot: true,
      shooter: 'player1',
      calledShot: { targetBall: null, targetPocket: null },
      firstBallContacted: 1,
      allBallsContacted: [1],
      pocketEvents: [],
      cueBallPocketed: true,
      railContactBalls: [1],
      anyBallContactedRail: true,
      settledPositions: [],
    }).snapshot;
    assert.equal(bihSnap.phase, 'BALL_IN_HAND');
    assert.equal(bihSnap.activePlayer, 'player2');
    useGameStore.getState().syncFromMatchSnapshot(bihSnap);
    useGameStore.getState().setCuePlacementPreview(-0.6, 0.0, true, null);

    // Step physics concurrently during AI BIH glide to mimic PoolScene animation loop!
    let stepping = true;
    const stepTimer = setInterval(() => {
      if (stepping) physics.step(1 / 60);
    }, 16);

    try {
      await waitForStrike(() => ctrl.scheduleTurnIfNeeded(), () => strikeCount, 2);
    } finally {
      stepping = false;
      clearInterval(stepTimer);
    }

    // Confirm #1 was NOT bumped out of (0,0) during glide!
    const ball1 = physics.getAllBallStates().find((b) => b.number === 1)!;
    assert.ok(Math.hypot(ball1.x - 0, ball1.z - 0) < 0.01, 'Blocking object ball must not be bumped by AI BIH glide');
    assert.equal(mm.getPhase(), 'OPEN_TABLE', 'Ball-in-Hand must transition cleanly to OPEN_TABLE before AI strike');

    // 3c. AI shoots final 8-ball under WPA called-pocket rules
    const mmWpa = setupLocalMatchWithAssignedGroup('solids', [], {
      calledShotsEnabled: true,
      opponentType: 'ai',
    });
    // Transfer turn to AI who also cleared stripes
    const mmAny = mmWpa as unknown as {
      pocketedSet: Set<number>;
      turnManager: { reset: (p: PlayerId) => void };
    };
    for (const s of [9, 10, 11, 12, 13, 14, 15]) mmAny.pocketedSet.add(s);
    mmAny.turnManager.reset('player2');
    useGameStore.getState().syncFromMatchSnapshot(mmWpa.getSnapshot());
    setupClearBoard(physics, [
      { number: 0, x: 0.4, z: -0.2 },
      { number: 8, x: 0.9, z: -0.45 },
    ]);

    let wpaStrikeCount = 0;
    let wpaCalledPocket: PocketId | null = null;
    const wpaCtrl = new AITurnController(mmWpa, physics, {
      isDisposed: () => false,
      onExecuteStrike: () => {
        wpaStrikeCount++;
        wpaCalledPocket = mmWpa.getSnapshot().calledShot.targetPocket;
      },
    });
    await waitForStrike(() => wpaCtrl.scheduleTurnIfNeeded(), () => wpaStrikeCount, 1);
    assert.ok(wpaCalledPocket !== null, 'AI must call pocket when shooting 8-ball in WPA called-pocket mode');
    wpaCtrl.dispose();
    ctrl.dispose();
    return `Break, collision-free BIH glide (#1 drifted ${Math.hypot(ball1.x, ball1.z).toFixed(4)}m), and WPA 8-ball call (${wpaCalledPocket}) succeeded`;
  });

  await test('AI-4', 'Worker timeout/error fallback + controller error recovery strike', async () => {
    // Verify AIPhysicsSimulator falls back cleanly when Worker stalls / throws
    const prevWorker = (globalThis as { Worker?: unknown }).Worker;
    class HangingMockWorker {
      public onmessage: ((e: unknown) => void) | null = null;
      public onerror: (() => void) | null = null;
      public onmessageerror: (() => void) | null = null;
      public terminated = false;
      public postMessage(): void {
        // Deliberately trigger error immediately on first call to simulate broken worker bundle
        setTimeout(() => this.onerror?.(), 5);
      }
      public terminate(): void {
        this.terminated = true;
      }
    }
    (globalThis as { Worker?: unknown }).Worker = HangingMockWorker;
    try {
      const sim = new AIPhysicsSimulator();
      const res = await sim.simulateBatch(
        [
          { number: 0, x: -0.5, z: 0, pocketed: false },
          { number: 1, x: 0.5, z: 0, pocketed: false },
          { number: 8, x: 0, z: 0.3, pocketed: false },
        ],
        [{ candidateId: 'w-fallback', aimAngle: 0, power: 0.6, spin: { x: 0, y: 0 }, calledBall: 1, calledPocket: null }],
        false,
      );
      assert.equal(res.length, 1, 'AIPhysicsSimulator must fall back cleanly to RapierIsolatedSimEngine when Worker fails');
      assert.equal(res[0].firstBallContacted, 1, 'Fallback physics simulation must remain accurate');
      sim.dispose();
    } finally {
      (globalThis as { Worker?: unknown }).Worker = prevWorker;
    }

    // Verify AITurnController emergency fallback strike on planner rejection
    const mm = new MatchManager({
      opponentType: 'ai',
      aiDifficulty: 'intermediate',
      aiThinkingSpeed: 'fast',
      startingBreaker: 'player2',
    });
    useGameStore.getState().setScreen('playing');
    useGameStore.getState().setSettingsOpen(false);
    useGameStore.getState().syncFromMatchSnapshot(mm.startMatch());
    setupClearBoard(physics, [
      { number: 0, x: -0.5, z: 0 },
      { number: 1, x: 0.4, z: 0 },
      { number: 8, x: 0, z: 0.3 },
    ]);

    let fallbackFired = 0;
    const ctrl = new AITurnController(mm, physics, {
      isDisposed: () => false,
      onExecuteStrike: () => {
        fallbackFired++;
      },
    });
    const internalCtrl = ctrl as unknown as {
      aiManager: { planShot: () => Promise<never> };
    };
    internalCtrl.aiManager.planShot = async () => {
      throw new Error('Simulated planner crash');
    };

    await waitForStrike(() => ctrl.scheduleTurnIfNeeded(), () => fallbackFired, 1);
    assert.equal(useGameStore.getState().isAiThinking, false, 'isAiThinking must reset after fallback');
    ctrl.dispose();
    return 'Worker failure fell back to isolated Rapier sim & planner crash triggered emergency fallback strike';
  });

  await test('AI-5', 'Pause (settingsOpen), GAME_OVER, moving balls, replayActive, and PvP guards', async () => {
    const mm = new MatchManager({
      opponentType: 'ai',
      aiDifficulty: 'intermediate',
      aiThinkingSpeed: 'fast',
      startingBreaker: 'player2',
    });
    useGameStore.getState().setScreen('playing');
    useGameStore.getState().syncFromMatchSnapshot(mm.startMatch());
    setupClearBoard(physics, [
      { number: 0, x: -0.5, z: 0 },
      { number: 1, x: 0.5, z: 0 },
      { number: 8, x: 0, z: 0.3 },
    ]);

    let strikeCount = 0;
    const ctrl = new AITurnController(mm, physics, {
      isDisposed: () => false,
      onExecuteStrike: () => {
        strikeCount++;
      },
    });

    // Guard 1: settingsOpen = true -> AI must wait cleanly, then resume when settingsOpen = false
    useGameStore.getState().setSettingsOpen(true);
    ctrl.scheduleTurnIfNeeded();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(strikeCount, 0, 'AI must not shoot while settingsOpen is true');

    // Now unpause and verify retry / resume shoots!
    useGameStore.getState().setSettingsOpen(false);
    await waitForStrike(() => ctrl.scheduleTurnIfNeeded(), () => strikeCount, 1);

    // Guard 2: replayActive = true
    useGameStore.getState().setReplayUiState({ replayActive: true });
    ctrl.scheduleTurnIfNeeded();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(strikeCount, 1, 'AI must not shoot during replayActive');
    useGameStore.getState().resetReplayUiState();

    // Guard 3: GAME_OVER phase
    mm.beginShot();
    mm.settleShot({
      shotId: 2,
      isBreakShot: false,
      shooter: 'player2',
      calledShot: { targetBall: null, targetPocket: null },
      firstBallContacted: 8,
      allBallsContacted: [8],
      pocketEvents: [pe(2, 8, 'corner-tr', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });
    assert.equal(mm.getPhase(), 'GAME_OVER');
    ctrl.scheduleTurnIfNeeded();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(strikeCount, 1, 'AI must not shoot after GAME_OVER');

    // Guard 4: PvP opponent mode
    const mmPvp = new MatchManager({ opponentType: 'pvp', startingBreaker: 'player2' });
    mmPvp.startMatch();
    let pvpStrikes = 0;
    const pvpCtrl = new AITurnController(mmPvp, physics, {
      isDisposed: () => false,
      onExecuteStrike: () => {
        pvpStrikes++;
      },
    });
    pvpCtrl.scheduleTurnIfNeeded();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pvpStrikes, 0, 'AI must not shoot in PvP mode');
    pvpCtrl.dispose();
    ctrl.dispose();
    return 'All pause/replay/GAME_OVER/PvP guards upheld and unpause resumed cleanly';
  });

  await test('AI-6', 'All 4 AI difficulty levels execute full AITurnController turns', async () => {
    const diffs = ['beginner', 'intermediate', 'pro', 'legend'] as const;
    for (const diff of diffs) {
      const mm = new MatchManager({
        opponentType: 'ai',
        aiDifficulty: diff,
        aiThinkingSpeed: 'fast',
        startingBreaker: 'player1',
      });
      useGameStore.getState().setScreen('playing');
      useGameStore.getState().setSettingsOpen(false);
      useGameStore.getState().syncFromMatchSnapshot(mm.startMatch());
      setupClearBoard(physics, [
        { number: 0, x: -0.4, z: 0.0 },
        { number: 3, x: 0.65, z: 0.25 },
        { number: 11, x: -0.7, z: -0.25 },
        { number: 8, x: 0.0, z: 0.0 },
      ]);
      // Move to non-break open table turn for AI
      mm.beginShot();
      mm.settleShot({
        shotId: 1,
        isBreakShot: true,
        shooter: 'player1',
        calledShot: { targetBall: null, targetPocket: null },
        firstBallContacted: 3,
        allBallsContacted: [3],
        pocketEvents: [],
        cueBallPocketed: false,
        railContactBalls: [3, 11],
        anyBallContactedRail: true,
        settledPositions: [],
      });
      useGameStore.getState().syncFromMatchSnapshot(mm.getSnapshot());

      let fired = 0;
      const ctrl = new AITurnController(mm, physics, {
        isDisposed: () => false,
        onExecuteStrike: () => {
          fired++;
        },
      });
      await waitForStrike(() => ctrl.scheduleTurnIfNeeded(), () => fired, 1, 12000);
      assert.equal(fired, 1, `Difficulty ${diff} must execute strike`);
      ctrl.dispose();
    }
    return 'All 4 difficulty profiles (beginner, intermediate, pro, legend) executed without stall';
  });

  // ============================================================================
  // PART B — 8-BALL LAST-BALL TURN MANAGEMENT (10 TESTS ACROSS ALL 3 MANAGERS)
  // ============================================================================

  await test('8B-1', 'Solids: legally pocketing 7th solid keeps turn & makes [8] legal target', () => {
    const mm = setupLocalMatchWithAssignedGroup('solids', [7]);
    assert.equal(mm.getActivePlayer(), 'player1');
    assert.equal(mm.canPlayerShootEight('player1'), false, 'Player cannot shoot 8 before 7th solid drops');

    mm.beginShot();
    const { snapshot, evaluation } = mm.settleShot({
      shotId: 50,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 7,
      allBallsContacted: [7],
      pocketEvents: [pe(50, 7, 'corner-br', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });

    assert.equal(evaluation?.isLegal, true, '7th solid pot must be legal');
    assert.equal(evaluation?.turnContinues, true, 'Turn must continue after pocketing 7th solid');
    assert.equal(evaluation?.nextPlayer, 'player1', 'Next player must remain player1');
    assert.equal(snapshot.activePlayer, 'player1', 'Active player must stay player1');
    assert.equal(snapshot.phase, 'GROUPS_ASSIGNED');
    assert.equal(snapshot.statusHeadline, '8-Ball Target');
    assert.equal(mm.canPlayerShootEight('player1'), true, 'Player1 must now be eligible to shoot 8-ball');
    assert.deepEqual(
      getLegalTargetBalls(new Set(snapshot.pocketedNumbers), snapshot.tableOpen, snapshot.playerGroups.player1),
      [8],
    );
    return '7th solid pocketed -> turnContinues=true, activePlayer=player1, legalTargets=[8]';
  });

  await test('8B-2', 'Stripes: legally pocketing 7th stripe keeps turn & makes [8] legal target', () => {
    const mm = setupLocalMatchWithAssignedGroup('stripes', [15]);
    mm.beginShot();
    const { snapshot, evaluation } = mm.settleShot({
      shotId: 51,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 15, targetPocket: 'corner-tl' },
      firstBallContacted: 15,
      allBallsContacted: [15],
      pocketEvents: [pe(51, 15, 'corner-tl', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });

    assert.equal(evaluation?.isLegal, true);
    assert.equal(evaluation?.turnContinues, true);
    assert.equal(snapshot.activePlayer, 'player1');
    assert.equal(snapshot.statusHeadline, '8-Ball Target');
    assert.deepEqual(
      getLegalTargetBalls(new Set(snapshot.pocketedNumbers), snapshot.tableOpen, snapshot.playerGroups.player1),
      [8],
    );
    return '7th stripe pocketed -> turnContinues=true, activePlayer=player1, legalTargets=[8]';
  });

  await test('8B-3', 'Multi-ball pot: 7th solid + opponent stripe -> legal continuation onto 8-ball', () => {
    const mm = setupLocalMatchWithAssignedGroup('solids', [7]);
    mm.beginShot();
    const { snapshot, evaluation } = mm.settleShot({
      shotId: 52,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 7,
      allBallsContacted: [7, 11],
      pocketEvents: [
        pe(52, 7, 'corner-br', 1),
        pe(52, 11, 'side-bottom', 2),
      ],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });

    assert.equal(evaluation?.isLegal, true);
    assert.equal(evaluation?.turnContinues, true);
    assert.equal(snapshot.activePlayer, 'player1');
    assert.equal(mm.canPlayerShootEight('player1'), true);
    return 'Multi-ball pot kept player1 at table targeting 8-ball';
  });

  await test('8B-4', 'Pocketing opponent ball only (with legal first hit) switches turn to opponent', () => {
    const mm = setupLocalMatchWithAssignedGroup('solids', [7]);
    mm.beginShot();
    const { snapshot, evaluation } = mm.settleShot({
      shotId: 53,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 7,
      allBallsContacted: [7, 12],
      pocketEvents: [pe(53, 12, 'corner-tr', 1)],
      cueBallPocketed: false,
      railContactBalls: [7],
      anyBallContactedRail: true,
      settledPositions: [],
    });

    assert.equal(evaluation?.isLegal, true);
    assert.equal(evaluation?.turnContinues, false);
    assert.equal(snapshot.activePlayer, 'player2');
    assert.equal(mm.canPlayerShootEight('player1'), false, '7th solid still on table');
    return 'Opponent-only pot transferred turn cleanly to player2';
  });

  await test('8B-5', 'Foul while pocketing 7th ball (scratch OR wrong first hit) switches turn with Ball in Hand', () => {
    // 5a: Scratch while pocketing 7th ball
    const mmScratch = setupLocalMatchWithAssignedGroup('solids', [7]);
    mmScratch.beginShot();
    const scratchRes = mmScratch.settleShot({
      shotId: 54,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 7,
      allBallsContacted: [7],
      pocketEvents: [pe(54, 7, 'corner-br', 1)],
      cueBallPocketed: true,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });
    assert.equal(scratchRes.evaluation?.isLegal, false);
    assert.equal(scratchRes.snapshot.activePlayer, 'player2');
    assert.equal(scratchRes.snapshot.phase, 'BALL_IN_HAND');

    // 5b: Wrong first hit while pocketing 7th ball
    const mmWrongHit = setupLocalMatchWithAssignedGroup('solids', [7]);
    mmWrongHit.beginShot();
    const wrongHitRes = mmWrongHit.settleShot({
      shotId: 55,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 12, // hit stripe first!
      allBallsContacted: [12, 7],
      pocketEvents: [pe(55, 7, 'corner-br', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });
    assert.equal(wrongHitRes.evaluation?.isLegal, false);
    assert.equal(wrongHitRes.snapshot.activePlayer, 'player2');
    assert.equal(wrongHitRes.snapshot.phase, 'BALL_IN_HAND');
    return 'Scratch & wrong-first-hit fouls on 7th ball transferred turn with BALL_IN_HAND';
  });

  await test('8B-6', 'Legal hit on 7th ball without pocketing switches turn cleanly (no foul)', () => {
    const mm = setupLocalMatchWithAssignedGroup('solids', [7]);
    mm.beginShot();
    const { snapshot, evaluation } = mm.settleShot({
      shotId: 56,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 7,
      allBallsContacted: [7],
      pocketEvents: [],
      cueBallPocketed: false,
      railContactBalls: [7],
      anyBallContactedRail: true,
      settledPositions: [],
    });

    assert.equal(evaluation?.isLegal, true);
    assert.equal(evaluation?.turnContinues, false);
    assert.equal(snapshot.activePlayer, 'player2');
    assert.equal(snapshot.phase, 'GROUPS_ASSIGNED');
    return 'Clean miss on 7th ball switched turn without false foul';
  });

  await test('8B-7', 'Pocketing 7th group ball AND 8-ball in the same shot is an early 8-ball loss', () => {
    const mm = setupLocalMatchWithAssignedGroup('solids', [7]);
    mm.beginShot();
    const { snapshot, evaluation } = mm.settleShot({
      shotId: 57,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 7,
      allBallsContacted: [7, 8],
      pocketEvents: [
        pe(57, 7, 'corner-br', 1),
        pe(57, 8, 'corner-tr', 2),
      ],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });

    assert.equal(evaluation?.isLegal, false);
    assert.equal(snapshot.phase, 'GAME_OVER');
    assert.equal(snapshot.winner, 'player2', 'Simultaneous 7th+8th pot must award win to opponent');
    assert.equal(snapshot.loser, 'player1');
    return 'Simultaneous 7th+8th ball pot correctly treated as early 8-ball loss';
  });

  await test('8B-8', 'Follow-up 8-ball shot: legal 8-ball pocket wins the match', () => {
    const mm = setupLocalMatchWithAssignedGroup('solids', [7], { calledShotsEnabled: true });
    mm.beginShot();
    const s1 = mm.settleShot({
      shotId: 58,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 7,
      allBallsContacted: [7],
      pocketEvents: [pe(58, 7, 'corner-br', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    }).snapshot;
    assert.equal(s1.activePlayer, 'player1');

    // Follow-up shot on 8-ball into called pocket
    mm.setCalledShot(8, 'corner-tl');
    mm.beginShot();
    const s2 = mm.settleShot({
      shotId: 59,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 8, targetPocket: 'corner-tl' },
      firstBallContacted: 8,
      allBallsContacted: [8],
      pocketEvents: [pe(59, 8, 'corner-tl', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    }).snapshot;
    assert.equal(s2.phase, 'GAME_OVER');
    assert.equal(s2.winner, 'player1');
    return '7th ball -> retained turn -> legal called 8-ball pocket -> player1 won match';
  });

  await test('8B-9', 'Follow-up 8-ball shot: scratch or wrong called pocket loses the match', () => {
    // 9a: Scratch on 8-ball
    const mmA = setupLocalMatchWithAssignedGroup('solids', [7]);
    mmA.beginShot();
    mmA.settleShot({
      shotId: 60,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 7,
      allBallsContacted: [7],
      pocketEvents: [pe(60, 7, 'corner-br', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });
    mmA.beginShot();
    const resA = mmA.settleShot({
      shotId: 61,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 8, targetPocket: 'corner-tl' },
      firstBallContacted: 8,
      allBallsContacted: [8],
      pocketEvents: [pe(61, 8, 'corner-tl', 1)],
      cueBallPocketed: true,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    }).snapshot;
    assert.equal(resA.phase, 'GAME_OVER');
    assert.equal(resA.winner, 'player2');

    // 9b: Wrong called pocket on 8-ball in WPA
    const mmB = setupLocalMatchWithAssignedGroup('solids', [7], { calledShotsEnabled: true });
    mmB.beginShot();
    mmB.settleShot({
      shotId: 62,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 7,
      allBallsContacted: [7],
      pocketEvents: [pe(62, 7, 'corner-br', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });
    mmB.setCalledShot(8, 'corner-tl');
    mmB.beginShot();
    const resB = mmB.settleShot({
      shotId: 63,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 8, targetPocket: 'corner-tl' },
      firstBallContacted: 8,
      allBallsContacted: [8],
      pocketEvents: [pe(63, 8, 'corner-br', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    }).snapshot;
    assert.equal(resB.phase, 'GAME_OVER');
    assert.equal(resB.winner, 'player2');
    return 'Scratch & wrong-pocket 8-ball losses enforced cleanly after clearing 7th ball';
  });

  await test('8B-10', 'Consistency across AI Mode physics, ServerMatchManager, and WorkerMatchManager', async () => {
    // 10a. Full end-to-end physics in AI Mode: Human pockets 7th solid -> stays turn -> pockets 8-ball -> wins (AI does not steal turn)
    const mmAi = setupLocalMatchWithAssignedGroup('solids', [7], { opponentType: 'ai' });
    useGameStore.getState().setScreen('playing');
    useGameStore.getState().syncFromMatchSnapshot(mmAi.getSnapshot());

    let aiStoleTurn = 0;
    const ctrl = new AITurnController(mmAi, physics, {
      isDisposed: () => false,
      onExecuteStrike: () => {
        aiStoleTurn++;
      },
    });

    const targetPocket = POCKET_POSITIONS.find((p) => p.id === 'corner-tr')!;
    setupClearBoard(physics, [
      { number: 0, x: 0.4, z: -0.2 },
      { number: 7, x: 0.9, z: -0.45 }, // straight-ish into corner-tr
      { number: 8, x: -0.88, z: -0.44 }, // near corner-tl (-1.12, -0.56)
      { number: 12, x: 0.0, z: 0.3 },
    ]);

    const aim7 = Math.atan2(-0.45 - -0.2, 0.9 - 0.4);
    const { snapshot: after7 } = runShotInPhysics(physics, mmAi, 0.52, aim7, { x: 0, y: 0 });
    assert.equal(after7.activePlayer, 'player1', 'After Human pockets 7th ball, turn must stay with Human in AI mode');
    assert.equal(after7.phase, 'GROUPS_ASSIGNED');
    assert.equal(canTargetEightBall(new Set(after7.pocketedNumbers), after7.playerGroups.player1), true);
    ctrl.scheduleTurnIfNeeded();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(aiStoleTurn, 0, 'AI must NOT attempt a turn when Human legally cleared 7th ball');

    // Align cue ball cleanly behind 8-ball towards corner-tl to verify real physics 8-ball win
    const cueSpot = { x: -0.5, z: -0.25 };
    physics.setCueBallPlacement(cueSpot.x, cueSpot.z);
    const eightPos = physics.getAllBallStates().find((b) => b.number === 8)!;
    const cornerTl = POCKET_POSITIONS.find((p) => p.id === 'corner-tl')!;
    const dirToPocketX = cornerTl.x - eightPos.x;
    const dirToPocketZ = cornerTl.z - eightPos.z;
    const len = Math.hypot(dirToPocketX, dirToPocketZ);
    const ghostX = eightPos.x - (dirToPocketX / len) * (2 * 0.028575);
    const ghostZ = eightPos.z - (dirToPocketZ / len) * (2 * 0.028575);
    const aim8 = Math.atan2(ghostZ - cueSpot.z, ghostX - cueSpot.x);
    const { snapshot: after8 } = runShotInPhysics(physics, mmAi, 0.55, aim8, { x: 0, y: 0 });
    assert.equal(after8.phase, 'GAME_OVER', `Expected GAME_OVER after 8-ball pot into ${cornerTl.id}, got ${after8.phase}`);
    assert.equal(after8.winner, 'player1', 'Human must win after legally pocketing 8-ball');
    ctrl.dispose();

    // 10b. ServerMatchManager (Node WS authoritative backend)
    const sm = await setupServerWithAssignedGroup('solids', [7]);
    const smAny = sm as unknown as { phase: string };
    smAny.phase = 'BALLS_MOVING';
    let serverSettledSnap: { activePlayer: PlayerId; statusHeadline: string } | null = null;
    (sm as unknown as { callbacks: { onSettled: (s: { activePlayer: PlayerId; statusHeadline: string }) => void } }).callbacks.onSettled = (s) => {
      serverSettledSnap = s;
    };
    sm.settleAuthoritativeShot({
      shotId: 70,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 7, targetPocket: 'corner-br' },
      firstBallContacted: 7,
      allBallsContacted: [7],
      pocketEvents: [pe(70, 7, 'corner-br', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });
    const resolvedServer = serverSettledSnap as { activePlayer: PlayerId; statusHeadline: string } | null;
    assert.equal(resolvedServer?.activePlayer, 'player1', 'ServerMatchManager must keep turn with player1 on 7th ball pot');
    assert.equal(resolvedServer?.statusHeadline, '8-Ball Target');
    sm.physics.dispose();

    // 10c. WorkerMatchManager (Cloudflare Durable Object authoritative backend)
    const wm = await setupWorkerMatchWithAssignedGroup('stripes', [15]);
    const wmAny = wm as unknown as { phase: string };
    wmAny.phase = 'BALLS_MOVING';
    let workerSettledSnap: { activePlayer: PlayerId; statusHeadline: string } | null = null;
    (wm as unknown as { callbacks: { onSettled: (s: { activePlayer: PlayerId; statusHeadline: string }) => void } }).callbacks.onSettled = (s) => {
      workerSettledSnap = s;
    };
    wm.settleAuthoritativeShot({
      shotId: 71,
      isBreakShot: false,
      shooter: 'player1',
      calledShot: { targetBall: 15, targetPocket: 'corner-tr' },
      firstBallContacted: 15,
      allBallsContacted: [15],
      pocketEvents: [pe(71, 15, 'corner-tr', 1)],
      cueBallPocketed: false,
      railContactBalls: [],
      anyBallContactedRail: false,
      settledPositions: [],
    });
    const resolvedWorker = workerSettledSnap as { activePlayer: PlayerId; statusHeadline: string } | null;
    assert.equal(resolvedWorker?.activePlayer, 'player1', 'WorkerMatchManager must keep turn with player1 on 7th ball pot');
    assert.equal(resolvedWorker?.statusHeadline, '8-Ball Target');
    wm.physics.dispose();

    void targetPocket;
    void TABLE_DIMENSIONS;
    return 'Verified end-to-end AI-mode 7th->8th physics win + ServerMatchManager + WorkerMatchManager parity';
  });

  physics.dispose();

  const failed = results.filter((r) => !r.passed);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
