export type PlayerId = 'player1' | 'player2';
export type BallGroup = 'solids' | 'stripes' | null;
export type BallCategory = 'cue' | 'solids' | 'stripes' | 'eight';

export type PocketId =
  | 'corner-tl'
  | 'corner-tr'
  | 'corner-bl'
  | 'corner-br'
  | 'side-top'
  | 'side-bottom';

export type GameMode = 'eightBall' | 'freePlay';
export type OpponentType = 'pvp' | 'ai' | 'online';
export type RuleProfileId = 'casual' | 'wpa';

export type AiDifficulty = 'beginner' | 'intermediate' | 'pro' | 'legend';
export type AiThinkingSpeed = 'fast' | 'normal' | 'realistic';

export type MatchStatePhase =
  | 'MENU'
  | 'RACKING'
  | 'BREAK'
  | 'OPEN_TABLE'
  | 'GROUPS_ASSIGNED'
  | 'BALL_IN_HAND'
  | 'BALLS_MOVING'
  | 'WAITING_FOR_TURN'
  | 'GAME_OVER';

export type PlacementZone = 'anywhere' | 'kitchen';

export interface CalledShot {
  targetBall: number | null;
  targetPocket: PocketId | null;
}

export interface BallSettledSnapshot {
  number: number;
  x: number;
  z: number;
  pocketed: boolean;
}

export interface PocketEvent {
  shotId: number;
  ballNumber: number;
  pocketId: PocketId;
  order: number;
  timestampMs: number;
}

export interface ShotTelemetry {
  shotId: number;
  isBreakShot: boolean;
  shooter: PlayerId;
  calledShot: CalledShot;
  firstBallContacted: number | null;
  allBallsContacted: number[];
  pocketEvents: PocketEvent[];
  cueBallPocketed: boolean;
  railContactBalls: number[];
  anyBallContactedRail: boolean;
  settledPositions: BallSettledSnapshot[];
}

export interface RuleProfile {
  id: RuleProfileId;
  label: string;
  calledShotsEnabled: boolean;
  requireBreakFourRailsOrPot: boolean;
  breakScratchKitchenOnly: boolean;
  respotEightOnBreak: boolean;
  lossOnBreakEightScratch: boolean;
}

export interface ShotEvaluationResult {
  isLegal: boolean;
  foulReason: string | null;
  foulMessage: string | null;
  turnContinues: boolean;
  nextPlayer: PlayerId;
  ballInHandNext: boolean;
  ballInHandZone: PlacementZone;
  assignedGroupsNow: Record<PlayerId, BallGroup> | null;
  respotEightBall: boolean;
  winner: PlayerId | null;
  loser: PlayerId | null;
  gameOverReason: string | null;
  statusHeadline: string;
}

export interface MatchBannerNotice {
  id: number;
  kind: 'break' | 'turn' | 'foul' | 'group' | 'victory';
  title: string;
  detail: string;
}

export interface MatchConfig {
  gameMode: GameMode;
  opponentType: OpponentType;
  player1Name: string;
  player2Name: string;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  startingBreaker: PlayerId;
  aiDifficulty: AiDifficulty;
  aiThinkingSpeed: AiThinkingSpeed;
  showAiAimGuide: boolean;
  showAiAnalysisMessages: boolean;
}

export interface MatchStatistics {
  matchesPlayed: number;
  wins: number;
  losses: number;
  totalShots: number;
  ballsPocketed: number;
  fouls: number;
  successfulBreaks: number;
  turnsCompleted: number;
}

export type AiTurnPhase =
  | 'idle'
  | 'analyzing'
  | 'placing'
  | 'evaluating'
  | 'aiming'
  | 'pullback';

export interface AiStatusState {
  active: boolean;
  phase: AiTurnPhase;
  message: string;
  shotTypeLabel: string | null;
}
