import { getBallCategory, getOpponent } from './BallGroupManager';
import type {
  BallGroup,
  PlacementZone,
  PlayerId,
  RuleProfile,
  RuleProfileId,
  ShotEvaluationResult,
  ShotTelemetry,
} from './types';

export interface EightBallEvaluationContext {
  profile: RuleProfile;
  tableOpen: boolean;
  playerGroups: Record<PlayerId, BallGroup>;
  playerCanShootEight: Record<PlayerId, boolean>;
}

export function createEffectiveRuleProfile(
  profileId: RuleProfileId,
  calledShotsEnabled: boolean,
): RuleProfile {
  if (profileId === 'wpa') {
    return {
      id: 'wpa',
      label: 'Strict Called (WPA)',
      calledShotsEnabled,
      requireBreakFourRailsOrPot: true,
      breakScratchKitchenOnly: true,
      respotEightOnBreak: true,
      lossOnBreakEightScratch: true,
    };
  }
  return {
    id: 'casual',
    label: 'Standard Casual',
    calledShotsEnabled,
    requireBreakFourRailsOrPot: false,
    breakScratchKitchenOnly: false,
    respotEightOnBreak: true,
    lossOnBreakEightScratch: false,
  };
}

export function evaluateEightBallShot(
  telemetry: ShotTelemetry,
  ctx: EightBallEvaluationContext,
): ShotEvaluationResult {
  const shooter = telemetry.shooter;
  const opponent = getOpponent(shooter);
  const shooterGroup = ctx.playerGroups[shooter];
  const shooterCanShootEight = ctx.playerCanShootEight[shooter];

  const objectPockets = telemetry.pocketEvents.filter((e) => e.ballNumber !== 0);
  const pocketedEightEvt = objectPockets.find((e) => e.ballNumber === 8) ?? null;
  const pocketedEight = pocketedEightEvt !== null;
  const pocketedSolidsOrStripes = objectPockets.filter((e) => e.ballNumber !== 8);

  // 1. Handle Break Shot
  if (telemetry.isBreakShot) {
    let foulReason: string | null = null;
    if (telemetry.cueBallPocketed) {
      foulReason = 'Cue ball scratched on the break.';
    } else if (telemetry.firstBallContacted === null) {
      foulReason = 'Break failed to strike any object ball.';
    } else if (
      ctx.profile.requireBreakFourRailsOrPot &&
      objectPockets.length === 0 &&
      telemetry.railContactBalls.length < 4
    ) {
      foulReason = 'Illegal break: must pocket a ball or drive 4 object balls to rails.';
    }

    const isLegal = foulReason === null;
    const zone: PlacementZone =
      !isLegal && ctx.profile.breakScratchKitchenOnly ? 'kitchen' : 'anywhere';

    if (pocketedEight) {
      if (telemetry.cueBallPocketed && ctx.profile.lossOnBreakEightScratch) {
        return {
          isLegal: false,
          foulReason,
          foulMessage: foulReason,
          turnContinues: false,
          nextPlayer: opponent,
          ballInHandNext: false,
          ballInHandZone: 'anywhere',
          assignedGroupsNow: null,
          respotEightBall: false,
          winner: opponent,
          loser: shooter,
          gameOverReason: 'Scratched while pocketing the 8-ball on the break.',
          statusHeadline: 'Loss of Frame — Break 8-Ball Scratch',
        };
      }

      if (ctx.profile.respotEightOnBreak || !isLegal) {
        const turnContinues = isLegal && pocketedSolidsOrStripes.length > 0;
        const nextPlayer = turnContinues ? shooter : opponent;
        return {
          isLegal,
          foulReason,
          foulMessage: foulReason,
          turnContinues,
          nextPlayer,
          ballInHandNext: !isLegal,
          ballInHandZone: zone,
          assignedGroupsNow: null,
          respotEightBall: true,
          winner: null,
          loser: null,
          gameOverReason: null,
          statusHeadline: isLegal ? 'Open Table' : 'Ball in Hand',
        };
      }
    }

    const turnContinues = isLegal && pocketedSolidsOrStripes.length > 0;
    const nextPlayer = turnContinues ? shooter : opponent;
    return {
      isLegal,
      foulReason,
      foulMessage: foulReason,
      turnContinues,
      nextPlayer,
      ballInHandNext: !isLegal,
      ballInHandZone: zone,
      assignedGroupsNow: null,
      respotEightBall: false,
      winner: null,
      loser: null,
      gameOverReason: null,
      statusHeadline: !isLegal ? 'Ball in Hand' : 'Open Table',
    };
  }

  // 2. Standard Non-Break Shot — Check Legal First Contact & Rail Rules
  let foulReason: string | null = null;
  const firstHit = telemetry.firstBallContacted;

  if (telemetry.cueBallPocketed) {
    foulReason = 'Scratch: Cue ball fell into a pocket.';
  } else if (firstHit === null) {
    foulReason = 'Foul: Cue ball failed to contact any object ball.';
  } else {
    const firstCat = getBallCategory(firstHit);
    if (ctx.tableOpen) {
      if (firstCat === 'eight') {
        foulReason = 'Foul: Cannot hit the 8-ball first on an open table.';
      }
    } else if (shooterCanShootEight) {
      if (firstHit !== 8) {
        foulReason = 'Foul: Must strike the 8-ball first after clearing your group.';
      }
    } else if (shooterGroup) {
      if (firstCat !== shooterGroup) {
        foulReason = `Foul: Must strike a ${shooterGroup === 'solids' ? 'SOLID (1–7)' : 'STRIPE (9–15)'} ball first.`;
      }
    }

    if (!foulReason && objectPockets.length === 0 && !telemetry.anyBallContactedRail) {
      foulReason = 'Foul: No ball pocketed and no ball contacted a cushion after hit.';
    }
  }

  const isLegal = foulReason === null;

  // 3. Evaluate 8-Ball Pocketed (Win or Loss!)
  if (pocketedEight) {
    // Early 8-ball if table is open or player hasn't cleared their group
    if (ctx.tableOpen || !shooterCanShootEight) {
      return {
        isLegal: false,
        foulReason: foulReason ?? 'Early 8-ball pocketed before clearing group.',
        foulMessage: foulReason ?? '8-ball pocketed before clearing your ball group.',
        turnContinues: false,
        nextPlayer: opponent,
        ballInHandNext: false,
        ballInHandZone: 'anywhere',
        assignedGroupsNow: null,
        respotEightBall: false,
        winner: opponent,
        loser: shooter,
        gameOverReason: 'Illegally pocketed the 8-ball before clearing group balls.',
        statusHeadline: 'Loss of Frame — Early 8-Ball',
      };
    }

    // Scratch / Foul while pocketing 8-ball loses
    if (!isLegal || telemetry.cueBallPocketed) {
      return {
        isLegal: false,
        foulReason,
        foulMessage: foulReason,
        turnContinues: false,
        nextPlayer: opponent,
        ballInHandNext: false,
        ballInHandZone: 'anywhere',
        assignedGroupsNow: null,
        respotEightBall: false,
        winner: opponent,
        loser: shooter,
        gameOverReason: foulReason ?? 'Fouled while pocketing the 8-ball.',
        statusHeadline: 'Loss of Frame — Foul on 8-Ball',
      };
    }

    // Called pocket check for 8-ball (enforced when calledShotsEnabled is true)
    if (ctx.profile.calledShotsEnabled) {
      const calledBall = telemetry.calledShot.targetBall;
      const calledPocket = telemetry.calledShot.targetPocket;
      if (calledPocket === null || (calledBall !== null && calledBall !== 8) || pocketedEightEvt.pocketId !== calledPocket) {
        return {
          isLegal: false,
          foulReason: '8-ball pocketed in an uncalled pocket.',
          foulMessage: '8-ball went into an uncalled pocket.',
          turnContinues: false,
          nextPlayer: opponent,
          ballInHandNext: false,
          ballInHandZone: 'anywhere',
          assignedGroupsNow: null,
          respotEightBall: false,
          winner: opponent,
          loser: shooter,
          gameOverReason: '8-ball was pocketed in an uncalled or wrong pocket.',
          statusHeadline: 'Loss of Frame — Wrong Pocket on 8-Ball',
        };
      }
    }

    // Clean legal 8-ball win!
    return {
      isLegal: true,
      foulReason: null,
      foulMessage: null,
      turnContinues: false,
      nextPlayer: shooter,
      ballInHandNext: false,
      ballInHandZone: 'anywhere',
      assignedGroupsNow: null,
      respotEightBall: false,
      winner: shooter,
      loser: opponent,
      gameOverReason: 'Legally pocketed the 8-ball to win the frame.',
      statusHeadline: '8-Ball Pocketed — Victory!',
    };
  }

  // 4. Foul without 8-ball -> opponent gets Ball in Hand
  if (!isLegal) {
    return {
      isLegal: false,
      foulReason,
      foulMessage: foulReason,
      turnContinues: false,
      nextPlayer: opponent,
      ballInHandNext: true,
      ballInHandZone: 'anywhere',
      assignedGroupsNow: null,
      respotEightBall: false,
      winner: null,
      loser: null,
      gameOverReason: null,
      statusHeadline: 'Foul — Ball in Hand',
    };
  }

  // 5. Legal Shot — Check Group Assignment on Open Table & Called Shot Continuation
  let assignedGroupsNow: Record<PlayerId, BallGroup> | null = null;
  let turnContinues = false;

  if (ctx.tableOpen) {
    // Check if any valid non-8 ball was pocketed (and matches called shot if required)
    const eligiblePots = ctx.profile.calledShotsEnabled
      ? pocketedSolidsOrStripes.filter(
          (e) =>
            telemetry.calledShot.targetBall === e.ballNumber &&
            telemetry.calledShot.targetPocket === e.pocketId,
        )
      : pocketedSolidsOrStripes;

    if (eligiblePots.length > 0) {
      const firstCat = getBallCategory(eligiblePots[0].ballNumber);
      if (firstCat === 'solids' || firstCat === 'stripes') {
        assignedGroupsNow = {
          [shooter]: firstCat,
          [opponent]: firstCat === 'solids' ? 'stripes' : 'solids',
        } as Record<PlayerId, BallGroup>;
        turnContinues = true;
      }
    } else if (pocketedSolidsOrStripes.length > 0 && ctx.profile.calledShotsEnabled) {
      // Pocketed uncalled ball on open table -> remains open, turn ends
      turnContinues = false;
    }
  } else if (shooterGroup) {
    const matchingGroupPots = pocketedSolidsOrStripes.filter(
      (e) => getBallCategory(e.ballNumber) === shooterGroup,
    );
    if (ctx.profile.calledShotsEnabled) {
      turnContinues = matchingGroupPots.some(
        (e) =>
          telemetry.calledShot.targetBall === e.ballNumber &&
          telemetry.calledShot.targetPocket === e.pocketId,
      );
    } else {
      turnContinues = matchingGroupPots.length > 0;
    }
  }

  const nextPlayer = turnContinues ? shooter : opponent;
  const statusHeadline = assignedGroupsNow
    ? 'Groups Assigned'
    : ctx.tableOpen
      ? 'Open Table'
      : 'Groups Assigned';

  return {
    isLegal: true,
    foulReason: null,
    foulMessage: null,
    turnContinues,
    nextPlayer,
    ballInHandNext: false,
    ballInHandZone: 'anywhere',
    assignedGroupsNow,
    respotEightBall: false,
    winner: null,
    loser: null,
    gameOverReason: null,
    statusHeadline,
  };
}
