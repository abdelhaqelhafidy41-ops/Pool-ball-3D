import {
  canTargetEightBall,
  getLegalTargetBalls,
  getOpponent,
} from '../../src/game/rules/BallGroupManager';
import { createEffectiveRuleProfile, evaluateEightBallShot } from '../../src/game/rules/EightBallRules';
import { TurnManager } from '../../src/game/rules/TurnManager';
import type {
  BallGroup,
  CalledShot,
  MatchBannerNotice,
  MatchStatePhase,
  PlacementZone,
  PlayerId,
  PocketId,
  RuleProfile,
  RuleProfileId,
  ShotTelemetry,
} from '../../src/game/rules/types';
import { CLOTH_PHYSICS, TABLE_DIMENSIONS } from '../../src/game/utils/constants';
import type {
  MatchHistoryRecord,
  MultiplayerErrorCode,
  OnlineBallFrame,
  OnlineMatchSnapshot,
} from '../../src/multiplayer/shared/protocol';
import {
  VALID_POCKET_IDS,
  WorkerPhysicsManager,
} from './WorkerPhysicsManager';

export interface PersistedMatchState {
  matchId: string;
  phase: MatchStatePhase;
  activePlayer: PlayerId;
  isBreakShot: boolean;
  tableOpen: boolean;
  playerGroups: Record<PlayerId, BallGroup>;
  ballInHandZone: PlacementZone;
  cuePlacementPos: { x: number; z: number };
  calledShot: CalledShot;
  pocketedNumbers: number[];
  balls: OnlineBallFrame[];
  winner: PlayerId | null;
  loser: PlayerId | null;
  gameOverReason: string | null;
  statusHeadline: string;
  lastFoulMessage: string | null;
  banner: MatchBannerNotice | null;
  bannerSeq: number;
  totalMatchShots: number;
  shotSeq: number;
  resultRecorded: boolean;
  rematchVotes: PlayerId[];
}

export interface WorkerMatchCallbacks {
  onShotStarted: (payload: {
    shotSeq: number;
    shooter: PlayerId;
    cueAngle: number;
    power: number;
    spinX: number;
    spinY: number;
  }) => void;
  onPhysicsFrame: (shotSeq: number, balls: OnlineBallFrame[]) => void;
  onPocket: (shotSeq: number, ballNumber: number, pocketId: PocketId, order: number) => void;
  onSettled: (snapshot: OnlineMatchSnapshot, balls: OnlineBallFrame[]) => void;
  onGameOver: (
    snapshot: OnlineMatchSnapshot,
    balls: OnlineBallFrame[],
    historyRecord: MatchHistoryRecord,
  ) => void;
}

export class WorkerMatchManager {
  public readonly physics: WorkerPhysicsManager;
  public readonly roomId: string;
  public readonly roomCode: string;

  private matchId: string;
  private ruleProfileId: RuleProfileId;
  private calledShotsEnabled: boolean;
  private profile: RuleProfile;
  private turnManager = new TurnManager();

  private phase: MatchStatePhase = 'BREAK';
  private isBreakShot = true;
  private tableOpen = true;
  private playerGroups: Record<PlayerId, BallGroup> = { player1: null, player2: null };
  private ballInHandZone: PlacementZone = 'anywhere';
  private cuePlacementPos: { x: number; z: number } = { x: TABLE_DIMENSIONS.headSpotX, z: 0 };
  private calledShot: CalledShot = { targetBall: null, targetPocket: null };
  private pocketedSet = new Set<number>();

  private winner: PlayerId | null = null;
  private loser: PlayerId | null = null;
  private gameOverReason: string | null = null;
  private statusHeadline = 'Break Shot';
  private lastFoulMessage: string | null = null;
  private banner: MatchBannerNotice | null = null;
  private bannerSeq = 1;
  private totalMatchShots = 0;
  private shotSeq = 0;

  private playerNames: Record<PlayerId, string>;
  private resultRecorded = false;
  private rematchVotes = new Set<PlayerId>();
  private callbacks: WorkerMatchCallbacks;

  constructor(options: {
    roomId: string;
    roomCode: string;
    ruleProfileId: RuleProfileId;
    calledShotsEnabled: boolean;
    player1Name: string;
    player2Name: string;
    physicsBroadcastHz?: number;
    callbacks: WorkerMatchCallbacks;
  }) {
    this.roomId = options.roomId;
    this.roomCode = options.roomCode;
    this.matchId = `m_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    this.ruleProfileId = options.ruleProfileId;
    this.calledShotsEnabled = options.calledShotsEnabled;
    this.profile = createEffectiveRuleProfile(this.ruleProfileId, this.calledShotsEnabled);
    this.playerNames = {
      player1: options.player1Name,
      player2: options.player2Name,
    };
    this.callbacks = options.callbacks;
    this.physics = new WorkerPhysicsManager(options.physicsBroadcastHz ?? 35);
  }

  public async init(): Promise<void> {
    await this.physics.init();
    this.resetForNewMatch();
  }

  public async restorePersistedState(state: PersistedMatchState): Promise<void> {
    this.matchId = state.matchId;
    this.phase = state.phase === 'BALLS_MOVING' ? (state.tableOpen ? 'OPEN_TABLE' : 'GROUPS_ASSIGNED') : state.phase;
    this.turnManager.reset(state.activePlayer);
    this.isBreakShot = state.isBreakShot;
    this.tableOpen = state.tableOpen;
    this.playerGroups = { ...state.playerGroups };
    this.ballInHandZone = state.ballInHandZone;
    this.cuePlacementPos = { ...state.cuePlacementPos };
    this.calledShot = { ...state.calledShot };
    this.pocketedSet = new Set<number>(state.pocketedNumbers);
    this.winner = state.winner;
    this.loser = state.loser;
    this.gameOverReason = state.gameOverReason;
    this.statusHeadline = state.statusHeadline;
    this.lastFoulMessage = state.lastFoulMessage;
    this.banner = state.banner ? { ...state.banner } : null;
    this.bannerSeq = state.bannerSeq;
    this.totalMatchShots = state.totalMatchShots;
    this.shotSeq = state.shotSeq;
    this.resultRecorded = state.resultRecorded;
    this.rematchVotes = new Set<PlayerId>(state.rematchVotes);
    await this.physics.restoreFromBallFrames(state.balls);
  }

  public exportPersistedState(): PersistedMatchState {
    return {
      matchId: this.matchId,
      phase: this.phase,
      activePlayer: this.turnManager.getActivePlayer(),
      isBreakShot: this.isBreakShot,
      tableOpen: this.tableOpen,
      playerGroups: { ...this.playerGroups },
      ballInHandZone: this.ballInHandZone,
      cuePlacementPos: { ...this.cuePlacementPos },
      calledShot: { ...this.calledShot },
      pocketedNumbers: Array.from(this.pocketedSet).sort((a, b) => a - b),
      balls: this.physics.getBallFrames(),
      winner: this.winner,
      loser: this.loser,
      gameOverReason: this.gameOverReason,
      statusHeadline: this.statusHeadline,
      lastFoulMessage: this.lastFoulMessage,
      banner: this.banner ? { ...this.banner } : null,
      bannerSeq: this.bannerSeq,
      totalMatchShots: this.totalMatchShots,
      shotSeq: this.shotSeq,
      resultRecorded: this.resultRecorded,
      rematchVotes: Array.from(this.rematchVotes),
    };
  }

  public resetForNewMatch(): void {
    this.matchId = `m_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    this.turnManager.reset('player1');
    this.phase = 'BREAK';
    this.isBreakShot = true;
    this.tableOpen = true;
    this.playerGroups = { player1: null, player2: null };
    this.ballInHandZone = 'anywhere';
    this.cuePlacementPos = { x: TABLE_DIMENSIONS.headSpotX, z: 0 };
    this.calledShot = { targetBall: null, targetPocket: null };
    this.pocketedSet.clear();
    this.winner = null;
    this.loser = null;
    this.gameOverReason = null;
    this.statusHeadline = 'Break Shot';
    this.lastFoulMessage = null;
    this.banner = null;
    this.totalMatchShots = 0;
    this.shotSeq = 0;
    this.resultRecorded = false;
    this.rematchVotes.clear();
    this.physics.resetRack();
  }

  public updatePlayerNames(player1Name: string, player2Name: string): void {
    this.playerNames.player1 = player1Name;
    this.playerNames.player2 = player2Name;
  }

  public getPhase(): MatchStatePhase {
    return this.phase;
  }

  public getActivePlayer(): PlayerId {
    return this.turnManager.getActivePlayer();
  }

  public canShoot(): boolean {
    return (
      this.phase === 'BREAK' ||
      this.phase === 'OPEN_TABLE' ||
      this.phase === 'GROUPS_ASSIGNED'
    );
  }

  public handleCalledShot(
    player: PlayerId,
    targetBall: number | null,
    targetPocket: PocketId | null,
  ): { ok: true; snapshot: OnlineMatchSnapshot } | { ok: false; code: MultiplayerErrorCode; message: string } {
    if (this.phase === 'GAME_OVER') {
      return { ok: false, code: 'MATCH_FINISHED', message: 'Match has already finished.' };
    }
    if (player !== this.turnManager.getActivePlayer()) {
      return { ok: false, code: 'OUT_OF_TURN', message: 'Wait for your turn.' };
    }
    if (this.phase === 'BALLS_MOVING') {
      return { ok: false, code: 'OUT_OF_TURN', message: 'Balls are currently moving.' };
    }

    if (targetBall !== null) {
      const legal = getLegalTargetBalls(
        this.pocketedSet,
        this.tableOpen,
        this.playerGroups[player],
      );
      if (!legal.includes(targetBall)) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          message: `Ball #${targetBall} is not a legal target.`,
        };
      }
    }

    if (targetPocket !== null && !VALID_POCKET_IDS.has(targetPocket)) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: 'Invalid pocket selection.',
      };
    }

    this.calledShot = { targetBall, targetPocket };
    return { ok: true, snapshot: this.getSnapshot() };
  }

  public handleCuePlacement(
    player: PlayerId,
    x: number,
    z: number,
    confirm: boolean,
  ):
    | { ok: true; confirmed: boolean; snapshot: OnlineMatchSnapshot; balls: OnlineBallFrame[] }
    | { ok: false; code: MultiplayerErrorCode; message: string } {
    if (this.phase === 'GAME_OVER') {
      return { ok: false, code: 'MATCH_FINISHED', message: 'Match has already finished.' };
    }
    if (player !== this.turnManager.getActivePlayer()) {
      return { ok: false, code: 'OUT_OF_TURN', message: 'Only the active player can place the cue ball.' };
    }
    if (this.phase !== 'BALL_IN_HAND') {
      return { ok: false, code: 'INVALID_INPUT', message: 'Ball in Hand is not currently active.' };
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Invalid cue ball coordinates.' };
    }

    const check = this.physics.validateCuePlacement(x, z, this.ballInHandZone);
    if (!check.valid) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: check.reason ?? 'Invalid cue ball placement.',
      };
    }

    this.physics.setCuePlacement(check.clampedX, check.clampedZ);
    this.cuePlacementPos = { x: check.clampedX, z: check.clampedZ };

    if (confirm) {
      this.phase = this.tableOpen ? 'OPEN_TABLE' : 'GROUPS_ASSIGNED';
      this.statusHeadline = this.tableOpen ? 'Open Table' : 'Groups Assigned';
    }

    return {
      ok: true,
      confirmed: confirm,
      snapshot: this.getSnapshot(),
      balls: this.physics.getBallFrames(),
    };
  }

  public handleShot(
    player: PlayerId,
    input: {
      shotToken: string;
      cueAngle: number;
      power: number;
      spinX: number;
      spinY: number;
      calledBall: number | null;
      calledPocket: PocketId | null;
    },
    hasUsedShotToken: (token: string) => boolean,
    recordShotToken: (token: string) => void,
  ):
    | { ok: true; shotSeq: number; simulationPromise: Promise<void> }
    | { ok: false; code: MultiplayerErrorCode; message: string } {
    if (this.phase === 'GAME_OVER') {
      return { ok: false, code: 'MATCH_FINISHED', message: 'Match has already finished.' };
    }
    if (
      typeof input.shotToken !== 'string' ||
      input.shotToken.length < 4 ||
      input.shotToken.length > 64
    ) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Missing or invalid shot token.' };
    }
    if (hasUsedShotToken(input.shotToken)) {
      return { ok: false, code: 'DUPLICATE_SHOT', message: 'Duplicate shot submission ignored.' };
    }
    if (player !== this.turnManager.getActivePlayer()) {
      return { ok: false, code: 'OUT_OF_TURN', message: 'Cannot shoot out of turn.' };
    }
    if (!this.canShoot() || this.physics.areAnyBallsMoving()) {
      return {
        ok: false,
        code: 'OUT_OF_TURN',
        message: 'Shot rejected because the table is not ready.',
      };
    }

    if (
      !Number.isFinite(input.cueAngle) ||
      !Number.isFinite(input.power) ||
      !Number.isFinite(input.spinX) ||
      !Number.isFinite(input.spinY)
    ) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Invalid shot vector parameters.' };
    }

    const maxR = CLOTH_PHYSICS.maxTipOffsetRatio;
    const rawR = Math.hypot(input.spinX, input.spinY);
    const spinX = rawR > maxR ? (input.spinX / rawR) * maxR : input.spinX;
    const spinY = rawR > maxR ? (input.spinY / rawR) * maxR : input.spinY;
    const power = Math.max(0.02, Math.min(1, input.power));
    const cueAngle = input.cueAngle;

    let effectiveCalledBall = this.calledShot.targetBall;
    let effectiveCalledPocket = this.calledShot.targetPocket;
    if (input.calledBall !== null || input.calledPocket !== null) {
      if (input.calledBall !== null) {
        const legal = getLegalTargetBalls(
          this.pocketedSet,
          this.tableOpen,
          this.playerGroups[player],
        );
        if (legal.includes(input.calledBall)) {
          effectiveCalledBall = input.calledBall;
        }
      } else {
        effectiveCalledBall = null;
      }
      if (input.calledPocket !== null && VALID_POCKET_IDS.has(input.calledPocket)) {
        effectiveCalledPocket = input.calledPocket;
      } else {
        effectiveCalledPocket = null;
      }
      this.calledShot = {
        targetBall: effectiveCalledBall,
        targetPocket: effectiveCalledPocket,
      };
    }

    recordShotToken(input.shotToken);

    this.shotSeq++;
    const activeShotSeq = this.shotSeq;
    const isBreak = this.isBreakShot;
    this.phase = 'BALLS_MOVING';
    this.lastFoulMessage = null;
    this.banner = null;

    this.callbacks.onShotStarted({
      shotSeq: activeShotSeq,
      shooter: player,
      cueAngle,
      power,
      spinX,
      spinY,
    });

    const simulationPromise = this.physics.startShotSimulation(
      activeShotSeq,
      isBreak,
      player,
      this.calledShot,
      cueAngle,
      power,
      { x: spinX, y: spinY },
      {
        onFrame: (frames) => {
          this.callbacks.onPhysicsFrame(activeShotSeq, frames);
        },
        onPocket: (ballNumber, pocketId, order) => {
          this.callbacks.onPocket(activeShotSeq, ballNumber, pocketId, order);
        },
        onSettled: (telemetry) => {
          this.settleAuthoritativeShot(telemetry);
        },
      },
    );

    return { ok: true, shotSeq: activeShotSeq, simulationPromise };
  }

  public settleAuthoritativeShot(telemetry: ShotTelemetry): void {
    if (this.phase !== 'BALLS_MOVING') return;

    this.totalMatchShots++;
    for (const evt of telemetry.pocketEvents) {
      if (evt.ballNumber !== 0) {
        this.pocketedSet.add(evt.ballNumber);
      }
    }

    const canShootEightMap: Record<PlayerId, boolean> = {
      player1: canTargetEightBall(this.pocketedSet, this.playerGroups.player1),
      player2: canTargetEightBall(this.pocketedSet, this.playerGroups.player2),
    };

    const evaluation = evaluateEightBallShot(telemetry, {
      profile: this.profile,
      tableOpen: this.tableOpen,
      playerGroups: { ...this.playerGroups },
      playerCanShootEight: canShootEightMap,
    });

    if (evaluation.respotEightBall) {
      this.pocketedSet.delete(8);
      this.physics.respotEightBall();
    }

    if (evaluation.assignedGroupsNow) {
      this.tableOpen = false;
      this.playerGroups = { ...evaluation.assignedGroupsNow };
    }

    this.isBreakShot = false;
    this.calledShot = { targetBall: null, targetPocket: null };

    if (evaluation.winner !== null) {
      this.phase = 'GAME_OVER';
      this.winner = evaluation.winner;
      this.loser = evaluation.loser ?? getOpponent(evaluation.winner);
      this.gameOverReason = evaluation.gameOverReason;
      this.statusHeadline = 'Victory';
      this.lastFoulMessage = evaluation.foulMessage;
      const winnerName = this.playerNames[evaluation.winner];
      this.emitBanner('victory', `${winnerName} Wins!`, evaluation.gameOverReason ?? 'Match complete.');

      const frames = this.physics.getBallFrames();
      const historyRecord = this.buildHistoryRecordOnce();
      if (historyRecord) {
        this.callbacks.onGameOver(this.getSnapshot(), frames, historyRecord);
      } else {
        this.callbacks.onSettled(this.getSnapshot(), frames);
      }
      return;
    }

    this.turnManager.resolveAfterShot(evaluation.turnContinues, {
      player1: { id: 'player1', name: this.playerNames.player1, isAi: false },
      player2: { id: 'player2', name: this.playerNames.player2, isAi: false },
    });

    const shooterName = this.playerNames[telemetry.shooter];
    const nextName = this.playerNames[evaluation.nextPlayer];

    if (evaluation.ballInHandNext) {
      this.phase = 'BALL_IN_HAND';
      this.ballInHandZone = evaluation.ballInHandZone;
      this.lastFoulMessage = evaluation.foulMessage;
      this.statusHeadline = 'Ball in Hand';

      const validSpot = this.physics.findNearestValidCuePlacement(this.ballInHandZone);
      this.physics.setCuePlacement(validSpot.x, validSpot.z);
      this.cuePlacementPos = validSpot;

      this.emitBanner(
        'foul',
        `Foul — ${shooterName}`,
        `${evaluation.foulMessage ?? 'Foul committed.'} ${nextName} has Ball in Hand.`,
      );
    } else {
      if (!this.physics.isCueBallAvailable() || telemetry.cueBallPocketed) {
        const spot = this.physics.respotCueBall();
        this.cuePlacementPos = spot;
      } else {
        this.cuePlacementPos = this.physics.getCueBallPosition();
      }

      this.lastFoulMessage = null;
      if (this.tableOpen) {
        this.phase = 'OPEN_TABLE';
        this.statusHeadline = 'Open Table';
        if (evaluation.respotEightBall) {
          this.emitBanner('break', '8-Ball Respotted', '8-ball spotted on the foot spot.');
        }
      } else {
        this.phase = 'GROUPS_ASSIGNED';
        this.statusHeadline = 'Groups Assigned';
        if (evaluation.assignedGroupsNow) {
          const assignedGroup = evaluation.assignedGroupsNow[telemetry.shooter];
          this.emitBanner(
            'group',
            `${shooterName} takes ${assignedGroup?.toUpperCase()}`,
            `${this.playerNames[getOpponent(telemetry.shooter)]} assigned ${
              assignedGroup === 'solids' ? 'STRIPES' : 'SOLIDS'
            }.`,
          );
        }
      }
    }

    this.callbacks.onSettled(this.getSnapshot(), this.physics.getBallFrames());
  }

  public forfeit(forfeitingPlayer: PlayerId, reason: string): MatchHistoryRecord | null {
    if (this.phase === 'GAME_OVER') return null;
    this.physics.stopSimulationLoop();

    const winner = getOpponent(forfeitingPlayer);
    this.phase = 'GAME_OVER';
    this.winner = winner;
    this.loser = forfeitingPlayer;
    this.gameOverReason = reason;
    this.statusHeadline = 'Match Forfeited';
    this.emitBanner('victory', `${this.playerNames[winner]} Wins!`, reason);

    const record = this.buildHistoryRecordOnce();
    if (record) {
      this.callbacks.onGameOver(this.getSnapshot(), this.physics.getBallFrames(), record);
    }
    return record;
  }

  public voteRematch(player: PlayerId): { bothReady: boolean; snapshot: OnlineMatchSnapshot } {
    this.rematchVotes.add(player);
    const bothReady =
      this.rematchVotes.has('player1') && this.rematchVotes.has('player2');
    return { bothReady, snapshot: this.getSnapshot() };
  }

  private emitBanner(
    kind: MatchBannerNotice['kind'],
    title: string,
    detail: string,
  ): void {
    this.banner = {
      id: this.bannerSeq++,
      kind,
      title,
      detail,
    };
  }

  private buildHistoryRecordOnce(): MatchHistoryRecord | null {
    if (this.resultRecorded || !this.winner) return null;
    this.resultRecorded = true;
    return {
      matchId: this.matchId,
      roomId: this.roomId,
      player1Name: this.playerNames.player1,
      player2Name: this.playerNames.player2,
      winnerName: this.playerNames[this.winner],
      winnerRole: this.winner,
      reason: this.gameOverReason ?? 'Match complete.',
      totalShots: this.totalMatchShots,
      endedAtMs: Date.now(),
    };
  }

  public getSnapshot(): OnlineMatchSnapshot {
    return {
      matchId: this.matchId,
      roomId: this.roomId,
      roomCode: this.roomCode,
      ruleProfileId: this.ruleProfileId,
      calledShotsEnabled: this.calledShotsEnabled,
      phase: this.phase,
      activePlayer: this.turnManager.getActivePlayer(),
      isBreakShot: this.isBreakShot,
      tableOpen: this.tableOpen,
      playerGroups: { ...this.playerGroups },
      ballInHandZone: this.ballInHandZone,
      cuePlacementPos: { ...this.cuePlacementPos },
      calledShot: { ...this.calledShot },
      pocketedNumbers: Array.from(this.pocketedSet).sort((a, b) => a - b),
      winner: this.winner,
      loser: this.loser,
      gameOverReason: this.gameOverReason,
      statusHeadline: this.statusHeadline,
      lastFoulMessage: this.lastFoulMessage,
      banner: this.banner ? { ...this.banner } : null,
      totalMatchShots: this.totalMatchShots,
      shotSeq: this.shotSeq,
      player1Name: this.playerNames.player1,
      player2Name: this.playerNames.player2,
      rematchVotes: Array.from(this.rematchVotes),
      serverTimeMs: Date.now(),
    };
  }

  public dispose(): void {
    this.physics.dispose();
  }
}
