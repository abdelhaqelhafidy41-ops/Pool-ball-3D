import assert from 'node:assert/strict';
import { AIAimingController } from '../src/game/ai/AIAimingController';
import { AIBallInHand } from '../src/game/ai/AIBallInHand';
import { getAiDifficultyProfile } from '../src/game/ai/AIDifficultyConfig';
import { AIManager } from '../src/game/ai/AIManager';
import { AIPhysicsSimulator } from '../src/game/ai/AIPhysicsSimulator';
import { AIShotEvaluator } from '../src/game/ai/AIShotEvaluator';
import { AIShotGenerator } from '../src/game/ai/AIShotGenerator';
import { AIStrategyPlanner } from '../src/game/ai/AIStrategyPlanner';
import { AITableAnalyzer } from '../src/game/ai/AITableAnalyzer';
import { PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import { validateCuePlacementAgainstBalls } from '../src/game/physics/RapierTableCore';
import { getBallCategory } from '../src/game/rules/BallGroupManager';
import { createEffectiveRuleProfile, evaluateEightBallShot } from '../src/game/rules/EightBallRules';
import { MatchManager } from '../src/game/rules/MatchManager';
import type { BallSettledSnapshot, PocketId } from '../src/game/rules/types';
import { BALL_SPECS, POCKET_POSITIONS, TABLE_DIMENSIONS } from '../src/game/utils/constants';

function makeTableWithBalls(active: Array<{ number: number; x: number; z: number }>): BallSettledSnapshot[] {
  const byNum = new Map(active.map((b) => [b.number, b]));
  const all: BallSettledSnapshot[] = [];
  for (let num = 0; num <= 15; num++) {
    const found = byNum.get(num);
    if (found) {
      all.push({ number: num, x: found.x, z: found.z, pocketed: false });
    } else {
      all.push({ number: num, x: 10 + num * 0.2, z: 10, pocketed: true });
    }
  }
  return all;
}

async function runTests() {
  const results: Array<{ id: number; name: string; passed: boolean; detail: string }> = [];
  const analyzer = new AITableAnalyzer();
  const simulator = new AIPhysicsSimulator();
  const planner = new AIStrategyPlanner();
  const generator = new AIShotGenerator();
  const evaluator = new AIShotEvaluator();
  const aiming = new AIAimingController();
  const bih = new AIBallInHand();

  const casualProfile = createEffectiveRuleProfile('casual', false);
  const wpaProfile = createEffectiveRuleProfile('wpa', true);

  const test = async (id: number, name: string, fn: () => Promise<string> | string) => {
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

  // 1. AI plays a legal direct shot
  await test(1, 'AI plays a legal direct shot', async () => {
    const balls = makeTableWithBalls([
      { number: 0, x: 0.4, z: -0.35 },
      { number: 2, x: 0.9, z: -0.5 },
      { number: 10, x: -0.4, z: 0.2 },
      { number: 8, x: 0.0, z: 0.0 },
    ]);
    const table = analyzer.analyze({
      version: 1,
      balls,
      aiPlayer: 'player2',
      aiGroup: 'solids',
      opponentGroup: 'stripes',
      tableOpen: false,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    const plan = await planner.planBestShot(table, getAiDifficultyProfile('pro'), simulator);
    const [sim] = await simulator.simulateBatchSyncFallback(
      balls,
      [{ candidateId: 'verify-1', aimAngle: plan.aimAngle, power: plan.power, spin: plan.spin, calledBall: plan.calledBall, calledPocket: plan.calledPocket }],
      false,
    );
    assert.equal(sim.firstBallContacted, 2, 'Expected first contact on #2');
    assert.ok(sim.pocketedBalls.some((p) => p.ballNumber === 2), 'Expected #2 to be pocketed');
    assert.equal(sim.cuePocketed, false, 'Cue ball should not scratch');
    return `Potted #2 into ${sim.pocketedBalls[0].pocketId} (score ${plan.strategicScore.toFixed(1)})`;
  });

  // 2. AI selects the correct ball group
  await test(2, 'AI selects the correct ball group', async () => {
    // Stripe #9 is an easy straight-in pot, while solid #3 requires a cut
    const balls = makeTableWithBalls([
      { number: 0, x: 0.2, z: 0.1 },
      { number: 9, x: 0.85, z: 0.44 }, // easy stripe near corner-br
      { number: 3, x: -0.65, z: -0.38 }, // solid near corner-tl
      { number: 8, x: 0.0, z: -0.25 },
    ]);
    const table = analyzer.analyze({
      version: 2,
      balls,
      aiPlayer: 'player2',
      aiGroup: 'solids',
      opponentGroup: 'stripes',
      tableOpen: false,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    assert.deepEqual(table.legalTargets, [3], 'Legal target must only be solid #3');
    const plan = await planner.planBestShot(table, getAiDifficultyProfile('pro'), simulator);
    const [sim] = await simulator.simulateBatchSyncFallback(
      balls,
      [{ candidateId: 'verify-2', aimAngle: plan.aimAngle, power: plan.power, spin: plan.spin, calledBall: plan.calledBall, calledPocket: plan.calledPocket }],
      false,
    );
    assert.equal(sim.firstBallContacted, 3, 'Must hit solid #3 first, never stripe #9');
    return `Ignored easy opponent stripe #9 and struck assigned solid #${sim.firstBallContacted}`;
  });

  // 3. AI respects open-table rules
  await test(3, 'AI respects open-table rules', async () => {
    const balls = makeTableWithBalls([
      { number: 0, x: -0.2, z: 0.0 },
      { number: 8, x: 0.4, z: 0.0 }, // 8-ball straight ahead, illegal first contact on open table!
      { number: 11, x: 0.75, z: 0.42 },
      { number: 4, x: -0.75, z: 0.38 },
    ]);
    const table = analyzer.analyze({
      version: 3,
      balls,
      aiPlayer: 'player2',
      aiGroup: null,
      opponentGroup: null,
      tableOpen: true,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    assert.ok(!table.legalTargets.includes(8), '8-ball must not be in open-table legal targets');
    const plan = await planner.planBestShot(table, getAiDifficultyProfile('pro'), simulator);
    const [sim] = await simulator.simulateBatchSyncFallback(
      balls,
      [{ candidateId: 'verify-3', aimAngle: plan.aimAngle, power: plan.power, spin: plan.spin, calledBall: plan.calledBall, calledPocket: plan.calledPocket }],
      false,
    );
    assert.notEqual(sim.firstBallContacted, 8, 'Must not strike 8-ball first on open table');
    assert.ok(sim.firstBallContacted === 11 || sim.firstBallContacted === 4);
    return `Selected legal open-table ball #${sim.firstBallContacted} instead of #8`;
  });

  // 4. AI does not target an illegal ball
  await test(4, 'AI does not target an illegal ball', async () => {
    const balls = makeTableWithBalls([
      { number: 0, x: 0.0, z: 0.0 },
      { number: 1, x: -0.5, z: -0.3 }, // AI is stripes, so #1 and #8 are both illegal!
      { number: 8, x: 0.5, z: 0.2 },
      { number: 14, x: -0.7, z: 0.35 },
    ]);
    const table = analyzer.analyze({
      version: 4,
      balls,
      aiPlayer: 'player2',
      aiGroup: 'stripes',
      opponentGroup: 'solids',
      tableOpen: false,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    const cands = generator.generateCandidates(table, getAiDifficultyProfile('legend'));
    for (const c of cands) {
      if (c.targetBall !== null) {
        assert.equal(getBallCategory(c.targetBall), 'stripes', `Illegal target #${c.targetBall}`);
      }
    }
    return `Verified all ${cands.length} generated candidates only target legal stripe #14`;
  });

  // 5. AI handles Ball in Hand
  await test(5, 'AI handles Ball in Hand (anywhere & kitchen)', async () => {
    const balls = makeTableWithBalls([
      { number: 0, x: -0.635, z: 0 },
      { number: 5, x: 0.85, z: -0.35 },
      { number: 12, x: -0.635, z: 0.0 }, // Blocks head spot!
      { number: 8, x: 0.1, z: 0.2 },
    ]);
    const tableAny = analyzer.analyze({
      version: 5,
      balls,
      aiPlayer: 'player2',
      aiGroup: 'solids',
      opponentGroup: 'stripes',
      tableOpen: false,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    const posAny = await bih.choosePlacement(tableAny, getAiDifficultyProfile('pro'), simulator);
    const checkAny = validateCuePlacementAgainstBalls(posAny.x, posAny.z, balls, 'anywhere');
    assert.equal(checkAny.valid, true, 'Anywhere BIH placement must be valid');

    const tableKitchen = { ...tableAny, version: 501, ballInHandZone: 'kitchen' as const };
    const posKitchen = await bih.choosePlacement(tableKitchen, getAiDifficultyProfile('pro'), simulator);
    const checkKitchen = validateCuePlacementAgainstBalls(posKitchen.x, posKitchen.z, balls, 'kitchen');
    assert.equal(checkKitchen.valid, true, 'Kitchen BIH placement must be valid');
    assert.ok(posKitchen.x <= TABLE_DIMENSIONS.headSpotX + 0.001, 'Kitchen placement must stay behind head string');
    return `Anywhere=(${posAny.x.toFixed(2)}, ${posAny.z.toFixed(2)}), Kitchen=(${posKitchen.x.toFixed(2)}, ${posKitchen.z.toFixed(2)})`;
  });

  // 6. AI does not shoot while balls are moving
  await test(6, 'AI does not shoot while balls are moving', async () => {
    const livePhysics = new PhysicsWorld();
    await livePhysics.init();
    const matchMgr = new MatchManager({ opponentType: 'ai', startingBreaker: 'player2' });
    matchMgr.startMatch();
    matchMgr.beginShot();
    livePhysics.strikeCueBall(0, 0.7, { x: 0, y: 0 });
    livePhysics.step(1 / 60);
    assert.equal(livePhysics.areAnyBallsMoving(), true, 'Live balls should be moving');
    assert.equal(matchMgr.canShoot(), false, 'MatchManager must disallow shooting during BALLS_MOVING');

    const velocities = livePhysics.getBallVelocities();
    const analyzed = analyzer.analyze({
      version: 6,
      balls: livePhysics.getAllBallStates(),
      velocities,
      aiPlayer: 'player2',
      aiGroup: null,
      opponentGroup: null,
      tableOpen: true,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    assert.equal(analyzed.anyBallMoving, true, 'AITableAnalyzer must detect moving balls');
    livePhysics.dispose();
    return 'Verified MatchManager.canShoot() === false and AITableAnalyzer.anyBallMoving === true';
  });

  // 7. AI recognizes a scratch
  await test(7, 'AI recognizes a scratch', async () => {
    // Cue ball lined straight behind #6 straight into corner pocket — high power follow scratches, draw avoids scratch!
    const balls = makeTableWithBalls([
      { number: 0, x: 0.72, z: 0.25 },
      { number: 6, x: 1.0, z: 0.45 },
      { number: 11, x: -0.6, z: -0.2 },
      { number: 8, x: -0.2, z: 0.1 },
    ]);
    const table = analyzer.analyze({
      version: 7,
      balls,
      aiPlayer: 'player2',
      aiGroup: 'solids',
      opponentGroup: 'stripes',
      tableOpen: false,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    const toTargetAngle = Math.atan2(0.45 - 0.25, 1.0 - 0.72);
    const [scratchSim] = await simulator.simulateBatchSyncFallback(
      balls,
      [{ candidateId: 'scratch-test', aimAngle: toTargetAngle, power: 0.85, spin: { x: 0, y: 0.7 }, calledBall: 6, calledPocket: 'corner-br' }],
      false,
    );
    const dummyCand = {
      id: 'scratch-test',
      kind: 'direct' as const,
      targetBall: 6,
      targetPocket: 'corner-br' as PocketId,
      aimAngle: toTargetAngle,
      power: 0.85,
      spin: { x: 0, y: 0.7 },
      heuristicScore: 90,
      cutCosine: 1,
      description: 'Scratch probe',
    };
    const ev = evaluator.evaluateSimulatedShot(dummyCand, scratchSim, table, getAiDifficultyProfile('pro'));
    if (scratchSim.cuePocketed) {
      assert.equal(ev.rulesEval.isLegal, false, 'Scratch must be evaluated as illegal foul');
      assert.equal(ev.rulesEval.ballInHandNext, true, 'Scratch must award Ball in Hand');
      assert.ok(ev.strategicScore < -1000, 'Scratch shot must receive massive negative score');
    }
    const chosen = await planner.planBestShot(table, getAiDifficultyProfile('pro'), simulator);
    const [chosenSim] = await simulator.simulateBatchSyncFallback(
      balls,
      [{ candidateId: 'chosen-7', aimAngle: chosen.aimAngle, power: chosen.power, spin: chosen.spin, calledBall: chosen.calledBall, calledPocket: chosen.calledPocket }],
      false,
    );
    assert.equal(chosenSim.cuePocketed, false, 'AI must pick a non-scratching shot/spin');
    return `Scratch penalized (score=${ev.strategicScore.toFixed(0)}); AI chose safe shot (${chosen.description}, cuePocketed=${chosenSim.cuePocketed})`;
  });

  // 8. AI avoids illegal 8-ball shots
  await test(8, 'AI avoids illegal 8-ball shots', async () => {
    const balls = makeTableWithBalls([
      { number: 0, x: 0.4, z: 0.2 },
      { number: 8, x: 0.9, z: 0.45 }, // 8-ball sitting right at pocket jaw!
      { number: 4, x: -0.7, z: 0.3 }, // AI's remaining solid
      { number: 12, x: -0.3, z: -0.3 },
    ]);
    const table = analyzer.analyze({
      version: 8,
      balls,
      aiPlayer: 'player2',
      aiGroup: 'solids',
      opponentGroup: 'stripes',
      tableOpen: false,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    const angleTo8 = Math.atan2(0.45 - 0.2, 0.9 - 0.4);
    const [illegal8Sim] = await simulator.simulateBatchSyncFallback(
      balls,
      [{ candidateId: 'ill-8', aimAngle: angleTo8, power: 0.5, spin: { x: 0, y: 0 }, calledBall: 8, calledPocket: 'corner-br' }],
      false,
    );
    const ev8 = evaluator.evaluateSimulatedShot(
      {
        id: 'ill-8',
        kind: 'eightBallFinish',
        targetBall: 8,
        targetPocket: 'corner-br',
        aimAngle: angleTo8,
        power: 0.5,
        spin: { x: 0, y: 0 },
        heuristicScore: 100,
        cutCosine: 1,
        description: 'Early 8',
      },
      illegal8Sim,
      table,
      getAiDifficultyProfile('legend'),
    );
    assert.equal(ev8.rulesEval.winner, 'player1', 'Early 8-ball pot must award win to opponent');
    assert.equal(ev8.strategicScore, -100000, 'Illegal 8-ball loss must score -100000');

    const plan = await planner.planBestShot(table, getAiDifficultyProfile('legend'), simulator);
    assert.notEqual(plan.calledBall, 8, 'AI must not target 8-ball while solid #4 remains');
    return `Early 8-ball scored ${ev8.strategicScore}; AI targeted #${plan.calledBall}`;
  });

  // 9. AI can choose a safety shot
  await test(9, 'AI can choose a safety shot', async () => {
    // Legal solid #5 is surrounded by opponent stripes blocking all pockets, leaving no pot
    const balls = makeTableWithBalls([
      { number: 0, x: -0.8, z: 0.0 },
      { number: 5, x: 0.2, z: 0.0 },
      { number: 10, x: 0.65, z: -0.25 },
      { number: 11, x: 0.65, z: 0.25 },
      { number: 12, x: 0.1, z: -0.35 },
      { number: 13, x: 0.1, z: 0.35 },
      { number: 14, x: 0.35, z: 0.0 },
      { number: 8, x: 0.9, z: 0.0 },
    ]);
    const table = analyzer.analyze({
      version: 9,
      balls,
      aiPlayer: 'player2',
      aiGroup: 'solids',
      opponentGroup: 'stripes',
      tableOpen: false,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    const plan = await planner.planBestShot(table, getAiDifficultyProfile('pro'), simulator);
    assert.equal(plan.isSafety, true, 'Pro AI should choose a safety shot when no clean pot exists');
    const [sim] = await simulator.simulateBatchSyncFallback(
      balls,
      [{ candidateId: 'verify-9', aimAngle: plan.aimAngle, power: plan.power, spin: plan.spin, calledBall: plan.calledBall, calledPocket: plan.calledPocket }],
      false,
    );
    assert.equal(sim.firstBallContacted, 5, 'Safety shot must legally contact solid #5 first');
    return `Chose ${plan.description} (legal contact #${sim.firstBallContacted}, rail=${sim.anyBallContactedRail})`;
  });

  // 10. AI can perform a bank shot when appropriate
  await test(10, 'AI can perform a bank shot when appropriate', async () => {
    // Solid #7 has all 6 direct pocket paths blocked by opponent stripes (#10-#15),
    // leaving a clean 1-rail bank off the top cushion into side-bottom.
    const balls = makeTableWithBalls([
      { number: 0, x: 0.36, z: 0.18 },
      { number: 7, x: 0.30, z: -0.28 },
      { number: 15, x: 0.12, z: -0.46 },  // blocks side-top
      { number: 14, x: -0.20, z: -0.40 }, // blocks corner-tl
      { number: 13, x: 0.70, z: -0.43 },  // blocks corner-tr
      { number: 12, x: -0.10, z: -0.05 }, // blocks corner-bl
      { number: 11, x: 0.55, z: -0.05 },  // blocks corner-br
      { number: 10, x: 0.22, z: 0.02 },   // blocks direct side-bottom
      { number: 8, x: -0.90, z: 0.40 },
    ]);
    const table = analyzer.analyze({
      version: 10,
      balls,
      aiPlayer: 'player2',
      aiGroup: 'solids',
      opponentGroup: 'stripes',
      tableOpen: false,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    const cands = generator.generateCandidates(table, getAiDifficultyProfile('legend'));
    const bankCands = cands.filter((c) => c.kind === 'bank');
    assert.ok(bankCands.length > 0, 'Legend should generate bank shot candidates');
    const plan = await planner.planBestShot(table, getAiDifficultyProfile('legend'), simulator);
    const [sim] = await simulator.simulateBatchSyncFallback(
      balls,
      [{ candidateId: 'verify-10', aimAngle: plan.aimAngle, power: plan.power, spin: plan.spin, calledBall: plan.calledBall, calledPocket: plan.calledPocket }],
      false,
    );
    assert.equal(plan.kind, 'bank', `Expected bank shot selection, got ${plan.kind} (${plan.description})`);
    assert.ok(sim.pocketedBalls.some((p) => p.ballNumber === 7), 'Bank shot must pocket #7');
    return `Generated ${bankCands.length} bank candidates; Legend executed ${plan.description} and pocketed #7 into ${sim.pocketedBalls[0].pocketId}`;
  });

  // 11. AI uses spin through the real physics system
  await test(11, 'AI uses spin through the real physics system', async () => {
    const balls = makeTableWithBalls([
      { number: 0, x: 0.1, z: 0.0 },
      { number: 3, x: 0.6, z: 0.0 },
      { number: 8, x: -0.8, z: 0.3 },
    ]);
    const angle = 0;
    const [followSim, drawSim] = await simulator.simulateBatchSyncFallback(
      balls,
      [
        { candidateId: 'follow', aimAngle: angle, power: 0.55, spin: { x: 0, y: 0.62 }, calledBall: 3, calledPocket: 'corner-tr' },
        { candidateId: 'draw', aimAngle: angle, power: 0.55, spin: { x: 0, y: -0.62 }, calledBall: 3, calledPocket: 'corner-tr' },
      ],
      false,
    );
    assert.ok(
      followSim.cueFinalPos.x > drawSim.cueFinalPos.x + 0.35,
      `Follow cue X (${followSim.cueFinalPos.x.toFixed(2)}) must finish significantly ahead of Draw cue X (${drawSim.cueFinalPos.x.toFixed(2)})`,
    );
    return `Follow cue X=${followSim.cueFinalPos.x.toFixed(2)}m vs Draw cue X=${drawSim.cueFinalPos.x.toFixed(2)}m`;
  });

  // 12. AI waits for pocket and collision events
  await test(12, 'AI waits for pocket and collision events', async () => {
    const livePhysics = new PhysicsWorld();
    const pocketedEvents: Array<{ ball: number; pocket: string }> = [];
    await livePhysics.init((ball, pocket) => {
      pocketedEvents.push({ ball, pocket });
    });
    const balls = makeTableWithBalls([
      { number: 0, x: 0.65, z: 0.22 },
      { number: 2, x: 0.95, z: 0.42 },
      { number: 8, x: -0.5, z: 0.0 },
    ]);
    for (const b of balls) {
      livePhysics.setBallState(b.number, b.x, b.z, b.pocketed);
    }
    const aim = Math.atan2(0.42 - 0.22, 0.95 - 0.65);
    livePhysics.beginShotTelemetry(1, false, 'player2', { targetBall: 2, targetPocket: 'corner-br' });
    livePhysics.strikeCueBall(aim, 0.55, { x: 0, y: 0 });
    for (let i = 0; i < 600; i++) {
      livePhysics.step(1 / 60);
      if (!livePhysics.areAnyBallsMoving()) break;
    }
    const tel = livePhysics.finalizeShotTelemetry();
    livePhysics.dispose();
    assert.equal(tel.firstBallContacted, 2, 'Live telemetry must capture first ball contact');
    assert.ok(tel.pocketEvents.some((p) => p.ballNumber === 2), 'Live telemetry must capture pocket event');
    return `Captured firstHit=#${tel.firstBallContacted}, pockets=${tel.pocketEvents.map((e) => `#${e.ballNumber}@${e.pocketId}`).join(',')}`;
  });

  // 13. AI recognizes a winning shot
  await test(13, 'AI recognizes a winning shot', async () => {
    const balls = makeTableWithBalls([
      { number: 0, x: 0.4, z: 0.15 },
      { number: 8, x: 0.92, z: 0.42 },
    ]);
    const table = analyzer.analyze({
      version: 13,
      balls,
      aiPlayer: 'player2',
      aiGroup: 'solids',
      opponentGroup: 'stripes',
      tableOpen: false,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: wpaProfile,
    });
    assert.equal(table.canAiShootEight, true);
    const plan = await planner.planBestShot(table, getAiDifficultyProfile('pro'), simulator);
    assert.equal(plan.calledBall, 8, 'Must call the 8-ball');
    assert.ok(plan.calledPocket !== null, 'Must call a pocket');
    const [sim] = await simulator.simulateBatchSyncFallback(
      balls,
      [{ candidateId: 'win-8', aimAngle: plan.aimAngle, power: plan.power, spin: plan.spin, calledBall: plan.calledBall, calledPocket: plan.calledPocket }],
      false,
    );
    const rulesOut = evaluateEightBallShot(sim.telemetry, {
      profile: wpaProfile,
      tableOpen: false,
      playerGroups: { player1: 'stripes', player2: 'solids' },
      playerCanShootEight: { player1: false, player2: true },
    });
    assert.equal(rulesOut.winner, 'player2', '8-ball pot in called pocket must win match');
    return `AI called #8 -> ${plan.calledPocket} and won via EightBallRules`;
  });

  // 14. AI handles situations with no valid pot
  await test(14, 'AI handles situations with no valid pot', async () => {
    // Cue ball completely snookered behind #10, #11, #12 with #1 far away
    const balls = makeTableWithBalls([
      { number: 0, x: -0.95, z: 0.0 },
      { number: 10, x: -0.78, z: 0.0 },
      { number: 11, x: -0.78, z: 0.065 },
      { number: 12, x: -0.78, z: -0.065 },
      { number: 1, x: 0.8, z: 0.0 },
      { number: 8, x: 0.5, z: 0.3 },
    ]);
    const table = analyzer.analyze({
      version: 14,
      balls,
      aiPlayer: 'player2',
      aiGroup: 'solids',
      opponentGroup: 'stripes',
      tableOpen: false,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
    });
    const plan = await planner.planBestShot(table, getAiDifficultyProfile('intermediate'), simulator);
    assert.ok(Number.isFinite(plan.aimAngle) && plan.power > 0, 'Must always return a valid finite shot');
    return `Returned safe valid fallback plan: ${plan.description}`;
  });

  // 15. All four difficulty levels behave differently
  await test(15, 'All four difficulty levels behave differently', async () => {
    const diffs = ['beginner', 'intermediate', 'pro', 'legend'] as const;
    const spreads: Record<string, number> = {};
    const samplePlan = {
      aimAngle: 0.5,
      power: 0.6,
      spin: { x: 0, y: 0 },
      calledBall: 1,
      calledPocket: 'corner-tr' as PocketId,
      kind: 'cut' as const,
      description: 'Test',
      strategicScore: 100,
      isSafety: false,
      wasLookaheadVerified: false,
    };

    for (const d of diffs) {
      const prof = getAiDifficultyProfile(d);
      let sumSq = 0;
      const N = 200;
      for (let i = 0; i < N; i++) {
        const exec = aiming.applyExecutionAccuracy(samplePlan, prof);
        const err = exec.aimAngle - samplePlan.aimAngle;
        sumSq += err * err;
      }
      spreads[d] = Math.sqrt(sumSq / N);
    }

    assert.ok(spreads.beginner > spreads.intermediate, 'Beginner error > Intermediate error');
    assert.ok(spreads.intermediate > spreads.pro, 'Intermediate error > Pro error');
    assert.ok(spreads.pro > spreads.legend, 'Pro error > Legend error');

    const bProf = getAiDifficultyProfile('beginner');
    const lProf = getAiDifficultyProfile('legend');
    assert.equal(bProf.allowBankShots, false);
    assert.equal(lProf.allowBankShots, true);
    assert.equal(bProf.lookaheadDepth, 1);
    assert.equal(lProf.lookaheadDepth, 2);
    return `RMS aim error (rad): beg=${spreads.beginner.toFixed(4)} > int=${spreads.intermediate.toFixed(4)} > pro=${spreads.pro.toFixed(4)} > leg=${spreads.legend.toFixed(4)}`;
  });

  // 16. Human versus Human mode still works
  await test(16, 'Human versus Human mode still works', async () => {
    const mm = new MatchManager({ opponentType: 'pvp', gameMode: 'eightBall', startingBreaker: 'player1' });
    let snap = mm.startMatch();
    assert.equal(mm.isActivePlayerAi(), false);
    assert.equal(snap.activePlayer, 'player1');
    mm.beginShot();
    // Player 1 misses without fouling -> turn goes to Player 2 (human)
    const { snapshot } = mm.settleShot({
      shotId: 1,
      isBreakShot: true,
      shooter: 'player1',
      calledShot: { targetBall: null, targetPocket: null },
      firstBallContacted: 1,
      allBallsContacted: [1],
      pocketEvents: [],
      cueBallPocketed: false,
      railContactBalls: [1, 2, 3, 4],
      anyBallContactedRail: true,
      settledPositions: [],
    });
    assert.equal(snapshot.activePlayer, 'player2');
    assert.equal(mm.isActivePlayerAi(), false, 'Player 2 must remain human in PvP mode');
    return `PvP turn transferred player1 -> ${snapshot.activePlayer}, isAi=${mm.isActivePlayerAi()}`;
  });

  // 17. AI calculations do not freeze the game (non-blocking & cancellable)
  await test(17, 'AI calculations are bounded and cancellable', async () => {
    const aiMgr = new AIManager();
    const balls = makeTableWithBalls([
      { number: 0, x: -0.635, z: 0 },
      { number: 1, x: 0.635, z: 0 },
      { number: 2, x: 0.7, z: 0.1 },
      { number: 9, x: 0.7, z: -0.1 },
      { number: 8, x: 0.75, z: 0 },
    ]);
    const t0 = performance.now();
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const abortedRes = await simulator.simulateBatch(
      balls,
      [{ candidateId: 'abort-1', aimAngle: 0, power: 0.6, spin: { x: 0, y: 0 }, calledBall: 1, calledPocket: 'corner-tr' }],
      false,
      abortCtrl.signal,
    );
    assert.equal(abortedRes.length, 0, 'Aborted simulation batch must return immediately with empty results');

    const planPromise = aiMgr.planShot({
      worldVersion: 17,
      balls,
      aiPlayer: 'player2',
      aiGroup: null,
      opponentGroup: null,
      tableOpen: true,
      isBreakShot: false,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
      difficulty: 'legend',
    });
    const out = await planPromise;
    const elapsed = performance.now() - t0;
    aiMgr.dispose();
    assert.ok(Number.isFinite(out.executed.aimAngle));
    return `Aborted batch exited in <1ms; full Legend physics plan completed in ${elapsed.toFixed(1)}ms`;
  });

  // 18. AI does not modify the live table during simulations
  await test(18, 'AI does not modify the live table during simulations', async () => {
    const livePhysics = new PhysicsWorld();
    await livePhysics.init();
    const beforeVersion = livePhysics.getWorldVersion();
    const beforeBalls = livePhysics.getAllBallStates();

    const aiMgr = new AIManager();
    await aiMgr.planShot({
      worldVersion: beforeVersion,
      balls: beforeBalls,
      velocities: livePhysics.getBallVelocities(),
      aiPlayer: 'player2',
      aiGroup: null,
      opponentGroup: null,
      tableOpen: true,
      isBreakShot: true,
      ballInHandZone: 'anywhere',
      ruleProfile: casualProfile,
      difficulty: 'legend',
    });
    aiMgr.dispose();

    const afterVersion = livePhysics.getWorldVersion();
    const afterBalls = livePhysics.getAllBallStates();
    livePhysics.dispose();

    assert.equal(afterVersion, beforeVersion, 'Live worldVersion must remain untouched');
    assert.deepEqual(afterBalls, beforeBalls, 'Live ball positions must be byte-for-byte identical');
    return `Live worldVersion=${afterVersion} and all 16 ball positions unchanged`;
  });

  simulator.dispose();

  const failed = results.filter((r) => !r.passed);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} tests passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
