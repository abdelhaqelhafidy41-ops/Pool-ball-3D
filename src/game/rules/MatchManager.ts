import { canTargetEightBall, getBallCategory, getOpponent } from './BallGroupManager';
import { createEffectiveRuleProfile, evaluateEightBallShot } from './EightBallRules';
import {
  clearMatchStatistics,
  loadMatchStatistics,
  saveMatchStatistics,
} from './MatchStatistics';
import { TurnManager } from './TurnManager';
import type {
  BallGroup,
  CalledShot,
  GameMode,
  MatchBannerNotice,
  MatchConfig,
  MatchStatePhase,
  MatchStatistics,
  PlacementZone,
  PlayerId,
  PocketId,
  RuleProfile,
  ShotEvaluationResult,
  ShotTelemetry,
} from './types';

export interface MatchSnapshot {
  config: MatchConfig;
  profile: RuleProfile;
  phase: MatchStatePhase;
  activePlayer: PlayerId;
  isBreakShot: boolean;
  tableOpen: boolean;
  playerGroups: Record<PlayerId, BallGroup>;
  ballInHandZone: PlacementZone;
  calledShot: CalledShot;
  pocketedNumbers: number[];
  winner: PlayerId | null;
  loser: PlayerId | null;
  gameOverReason: string | null;
  statusHeadline: string;
  lastFoulMessage: string | null;
  banner: MatchBannerNotice | null;
  stats: MatchStatistics;
  totalMatchShots: number;
}

export function createDefaultMatchConfig(): MatchConfig {
  return {
    gameMode: 'eightBall',
    opponentType: 'pvp',
    player1Name: 'Player 1',
    player2Name: 'Player 2',
    ruleProfileId: 'casual',
    calledShotsEnabled: false,
    startingBreaker: 'player1',
    aiDifficulty: 'intermediate',
    aiThinkingSpeed: 'normal',
    showAiAimGuide: true,
    showAiAnalysisMessages: true,
  };
}

export class MatchManager {
  private config: MatchConfig;
  private profile: RuleProfile;
  private phase: MatchStatePhase = 'MENU';
  private turnManager: TurnManager;

  private isBreakShot = true;
  private tableOpen = true;
  private playerGroups: Record<PlayerId, BallGroup> = {
    player1: null,
    player2: null,
  };
  private ballInHandZone: PlacementZone = 'anywhere';
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

  private stats: MatchStatistics;

  constructor(initialConfig?: Partial<MatchConfig>) {
    this.config = { ...createDefaultMatchConfig(), ...initialConfig };
    this.profile = createEffectiveRuleProfile(
      this.config.ruleProfileId,
      this.config.calledShotsEnabled,
    );
    this.turnManager = new TurnManager();
    this.turnManager.reset(this.config.startingBreaker);
    this.stats = loadMatchStatistics();
  }

  public getConfig(): MatchConfig {
    return { ...this.config };
  }

  public getPhase(): MatchStatePhase {
    return this.phase;
  }

  public getGameMode(): GameMode {
    return this.config.gameMode;
  }

  public getActivePlayer(): PlayerId {
    return this.turnManager.getActivePlayer();
  }

  public isActivePlayerAi(): boolean {
    return (
      this.config.gameMode === 'eightBall' &&
      this.config.opponentType === 'ai' &&
      this.turnManager.getActivePlayer() === 'player2'
    );
  }

  public getPlayerName(player: PlayerId): string {
    if (player === 'player1') {
      return this.config.player1Name.trim() || 'Player 1';
    }
    if (this.config.opponentType === 'ai') {
      return this.config.player2Name.trim() || this.getDefaultAiName();
    }
    return this.config.player2Name.trim() || 'Player 2';
  }

  private getDefaultAiName(): string {
    switch (this.config.aiDifficulty) {
      case 'beginner':
        return 'Rookie Sam';
      case 'intermediate':
        return 'Club Victor';
      case 'pro':
        return 'Master Elena';
      case 'legend':
        return 'Grandmaster Vega';
      default:
        return 'CPU Pro';
    }
  }

  public canShoot(): boolean {
    return (
      this.phase === 'BREAK' ||
      this.phase === 'OPEN_TABLE' ||
      this.phase === 'GROUPS_ASSIGNED' ||
      this.phase === 'WAITING_FOR_TURN'
    );
  }

  public canPlaceCueBall(): boolean {
    return this.phase === 'BALL_IN_HAND';
  }

  public updateConfig(partial: Partial<MatchConfig>): MatchSnapshot {
    const prevAiDefault = this.getDefaultAiName();
    this.config = { ...this.config, ...partial };
    const nextAiDefault = this.getDefaultAiName();

    const isDefaultCpuName =
      !this.config.player2Name ||
      this.config.player2Name === 'Player 2' ||
      this.config.player2Name === 'CPU Pro' ||
      this.config.player2Name === prevAiDefault;

    if (this.config.opponentType === 'ai' && isDefaultCpuName && !partial.player2Name) {
      this.config.player2Name = nextAiDefault;
    } else if (partial.opponentType === 'pvp' && isDefaultCpuName && !partial.player2Name) {
      this.config.player2Name = 'Player 2';
    }

    this.profile = createEffectiveRuleProfile(
      this.config.ruleProfileId,
      this.config.calledShotsEnabled,
    );
    return this.getSnapshot();
  }

  public enterMenu(): MatchSnapshot {
    this.phase = 'MENU';
    return this.getSnapshot();
  }

  public startMatch(overrideConfig?: Partial<MatchConfig>): MatchSnapshot {
    if (overrideConfig) {
      this.updateConfig(overrideConfig);
    }

    this.phase = 'RACKING';
    this.turnManager.reset(this.config.startingBreaker);
    this.isBreakShot = this.config.gameMode === 'eightBall';
    this.tableOpen = true;
    this.playerGroups = { player1: null, player2: null };
    this.ballInHandZone = 'anywhere';
    this.calledShot = { targetBall: null, targetPocket: null };
    this.pocketedSet.clear();
    this.winner = null;
    this.loser = null;
    this.gameOverReason = null;
    this.lastFoulMessage = null;
    this.totalMatchShots = 0;

    if (this.config.gameMode === 'freePlay') {
      this.phase = 'WAITING_FOR_TURN';
      this.statusHeadline = 'Free Play';
      this.banner = null;
    } else {
      this.phase = 'BREAK';
      this.statusHeadline = 'Break Shot';
      this.banner = null;
    }

    return this.getSnapshot();
  }

  public setCalledShot(targetBall: number | null, targetPocket: PocketId | null): MatchSnapshot {
    if (this.phase === 'BALLS_MOVING' || this.phase === 'GAME_OVER') {
      return this.getSnapshot();
    }
    this.calledShot = { targetBall, targetPocket };
    return this.getSnapshot();
  }

  public clearCalledShot(): MatchSnapshot {
    this.calledShot = { targetBall: null, targetPocket: null };
    return this.getSnapshot();
  }

  public beginShot(): boolean {
    if (!this.canShoot()) return false;
    this.phase = 'BALLS_MOVING';
    this.lastFoulMessage = null;
    return true;
  }

  public confirmBallInHandPlacement(): MatchSnapshot {
    if (this.phase !== 'BALL_IN_HAND') return this.getSnapshot();
    this.phase = this.tableOpen ? 'OPEN_TABLE' : 'GROUPS_ASSIGNED';
    this.statusHeadline = this.tableOpen ? 'Open Table' : 'Groups Assigned';
    return this.getSnapshot();
  }

  public settleShot(telemetry: ShotTelemetry): {
    snapshot: MatchSnapshot;
    evaluation: ShotEvaluationResult | null;
  } {
    // Guard against double-settlement if already settled
    if (this.phase !== 'BALLS_MOVING') {
      return { snapshot: this.getSnapshot(), evaluation: null };
    }

    this.totalMatchShots++;
    this.stats.totalShots++;

    // Record pocketed object balls into authoritative set (except cue ball 0)
    const newlyPocketedObjects: number[] = [];
    for (const evt of telemetry.pocketEvents) {
      if (evt.ballNumber !== 0 && !this.pocketedSet.has(evt.ballNumber)) {
        newlyPocketedObjects.push(evt.ballNumber);
        this.pocketedSet.add(evt.ballNumber);
      }
    }
    this.stats.ballsPocketed += newlyPocketedObjects.length;

    // Free Play bypasses 8-ball match rules
    if (this.config.gameMode === 'freePlay') {
      this.isBreakShot = false;
      this.phase = 'WAITING_FOR_TURN';
      this.statusHeadline = 'Free Play Practice';
      this.calledShot = { targetBall: null, targetPocket: null };
      saveMatchStatistics(this.stats);
      return { snapshot: this.getSnapshot(), evaluation: null };
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

    // If 8-ball was pocketed on break and respotted, remove 8 from pocketedSet!
    if (evaluation.respotEightBall) {
      this.pocketedSet.delete(8);
    }

    const shooter = telemetry.shooter;
    const shooterName = this.getPlayerName(shooter);
    const nextName = this.getPlayerName(evaluation.nextPlayer);

    // Update persistent stats
    if (telemetry.isBreakShot && evaluation.isLegal) {
      this.stats.successfulBreaks++;
    }
    if (!evaluation.isLegal) {
      this.stats.fouls++;
    }
    if (!evaluation.turnContinues || evaluation.winner !== null) {
      this.stats.turnsCompleted++;
    }

    // Apply group assignment (never on break or foul — enforced by EightBallRules)
    if (evaluation.assignedGroupsNow) {
      this.tableOpen = false;
      this.playerGroups = { ...evaluation.assignedGroupsNow };
    }

    this.isBreakShot = false;
    this.calledShot = { targetBall: null, targetPocket: null };

    // Handle Game Over
    if (evaluation.winner !== null) {
      this.phase = 'GAME_OVER';
      this.winner = evaluation.winner;
      this.loser = evaluation.loser ?? getOpponent(evaluation.winner);
      this.gameOverReason = evaluation.gameOverReason;
      this.statusHeadline = evaluation.statusHeadline;
      this.lastFoulMessage = evaluation.foulMessage;

      this.stats.matchesPlayed++;
      if (this.config.opponentType === 'ai') {
        if (evaluation.winner === 'player1') {
          this.stats.wins++;
        } else {
          this.stats.losses++;
        }
      } else {
        this.stats.wins++;
      }
      saveMatchStatistics(this.stats);

      const winnerName = this.getPlayerName(evaluation.winner);
      this.emitNotice(
        'victory',
        `${winnerName} Wins!`,
        evaluation.gameOverReason ?? evaluation.statusHeadline,
      );
      return { snapshot: this.getSnapshot(), evaluation };
    }

    // Advance turn manager
    this.turnManager.resolveAfterShot(evaluation.turnContinues, {
      player1: { id: 'player1', name: this.getPlayerName('player1'), isAi: false },
      player2: {
        id: 'player2',
        name: this.getPlayerName('player2'),
        isAi: this.config.opponentType === 'ai',
      },
    });

    // Determine next phase
    if (evaluation.ballInHandNext) {
      this.phase = 'BALL_IN_HAND';
      this.ballInHandZone = evaluation.ballInHandZone;
      this.lastFoulMessage = evaluation.foulMessage;
      this.statusHeadline = 'Ball in Hand';
      const zoneLabel =
        evaluation.ballInHandZone === 'kitchen'
          ? 'Place cue ball behind the head string.'
          : 'Place cue ball anywhere on the table.';
      this.emitNotice(
        'foul',
        `Foul by ${shooterName}`,
        `${evaluation.foulMessage ?? 'Foul committed.'} ${nextName} gets Ball in Hand. ${zoneLabel}`,
      );
    } else if (this.tableOpen) {
      this.phase = 'OPEN_TABLE';
      this.lastFoulMessage = null;
      this.statusHeadline = 'Open Table';
      if (evaluation.respotEightBall) {
        this.emitNotice(
          'break',
          '8-Ball Respotted',
          '8-ball spotted on foot spot.',
        );
      } else {
        this.banner = null;
      }
    } else {
      this.phase = 'GROUPS_ASSIGNED';
      this.lastFoulMessage = null;
      this.statusHeadline = 'Groups Assigned';

      if (evaluation.assignedGroupsNow) {
        const assignedGroup = evaluation.assignedGroupsNow[shooter];
        this.emitNotice(
          'group',
          `${shooterName} takes ${assignedGroup?.toUpperCase()}`,
          `Opponent assigned ${assignedGroup === 'solids' ? 'STRIPES (9–15)' : 'SOLIDS (1–7)'}.`,
        );
      } else {
        this.banner = null;
      }
    }

    saveMatchStatistics(this.stats);
    return { snapshot: this.getSnapshot(), evaluation };
  }

  public resetAllTimeStats(): MatchSnapshot {
    this.stats = clearMatchStatistics();
    return this.getSnapshot();
  }

  public getBallGroup(player: PlayerId): BallGroup {
    return this.playerGroups[player];
  }

  public canPlayerShootEight(player: PlayerId): boolean {
    return canTargetEightBall(this.pocketedSet, this.playerGroups[player]);
  }

  public getPocketedCategorySummary(): { solids: number[]; stripes: number[]; eight: boolean } {
    const solids: number[] = [];
    const stripes: number[] = [];
    let eight = false;
    for (const num of this.pocketedSet) {
      const cat = getBallCategory(num);
      if (cat === 'solids') solids.push(num);
      else if (cat === 'stripes') stripes.push(num);
      else if (cat === 'eight') eight = true;
    }
    return { solids, stripes, eight };
  }

  private emitNotice(
    kind: MatchBannerNotice['kind'],
    title: string,
    detail: string,
  ) {
    this.banner = {
      id: this.bannerSeq++,
      kind,
      title,
      detail,
    };
  }

  public clearBanner(): MatchSnapshot {
    this.banner = null;
    return this.getSnapshot();
  }

  public getSnapshot(): MatchSnapshot {
    return {
      config: { ...this.config },
      profile: { ...this.profile },
      phase: this.phase,
      activePlayer: this.turnManager.getActivePlayer(),
      isBreakShot: this.isBreakShot,
      tableOpen: this.tableOpen,
      playerGroups: { ...this.playerGroups },
      ballInHandZone: this.ballInHandZone,
      calledShot: { ...this.calledShot },
      pocketedNumbers: Array.from(this.pocketedSet).sort((a, b) => a - b),
      winner: this.winner,
      loser: this.loser,
      gameOverReason: this.gameOverReason,
      statusHeadline: this.statusHeadline,
      lastFoulMessage: this.lastFoulMessage,
      banner: this.banner ? { ...this.banner } : null,
      stats: { ...this.stats },
      totalMatchShots: this.totalMatchShots,
    };
  }
}
