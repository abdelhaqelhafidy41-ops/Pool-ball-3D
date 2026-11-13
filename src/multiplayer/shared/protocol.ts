import type {
  BallGroup,
  CalledShot,
  MatchBannerNotice,
  MatchStatePhase,
  PlacementZone,
  PlayerId,
  PocketId,
  RuleProfileId,
} from '../../game/rules/types';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type OpponentConnectionState = 'connected' | 'disconnected' | 'reconnected';
export type OnlineModeIntent = 'quick' | 'create' | 'join' | 'friend';

export type OnlineAvatarId =
  | 'cue_gold'
  | 'eight_obsidian'
  | 'crown_emerald'
  | 'shark_sky'
  | 'diamond_crimson'
  | 'ace_violet';

export const ONLINE_AVATARS: Array<{
  id: OnlineAvatarId;
  label: string;
  accent: string;
  glyph: string;
}> = [
  { id: 'cue_gold', label: 'Gold Cue', accent: '#f59e0b', glyph: '★' },
  { id: 'eight_obsidian', label: '8-Ball', accent: '#cbd5e1', glyph: '8' },
  { id: 'crown_emerald', label: 'Crown', accent: '#10b981', glyph: '♛' },
  { id: 'shark_sky', label: 'Shark', accent: '#38bdf8', glyph: '◆' },
  { id: 'diamond_crimson', label: 'Ruby', accent: '#f43f5e', glyph: '♦' },
  { id: 'ace_violet', label: 'Ace', accent: '#a78bfa', glyph: '♠' },
];

export interface OnlinePlayerProfile {
  sessionId: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  role: PlayerId;
  connected: boolean;
  ready: boolean;
  latencyMs: number;
  disconnectedAtMs: number | null;
  reconnectDeadlineMs: number | null;
  rematchRequested: boolean;
}

export type OnlineRoomStatus =
  | 'waiting'
  | 'ready'
  | 'playing'
  | 'finished'
  | 'cancelled'
  | 'expired';

export interface OnlineRoomInfo {
  roomId: string;
  roomCode: string;
  hostSessionId: string;
  isPrivate: boolean;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  status: OnlineRoomStatus;
  players: OnlinePlayerProfile[];
  createdAtMs: number;
  expiresAtMs: number;
}

export interface OnlineBallFrame {
  number: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  pocketed: boolean;
}

export interface OnlineMatchSnapshot {
  matchId: string;
  roomId: string;
  roomCode: string;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  phase: MatchStatePhase;
  activePlayer: PlayerId;
  isBreakShot: boolean;
  tableOpen: boolean;
  playerGroups: Record<PlayerId, BallGroup>;
  ballInHandZone: PlacementZone;
  cuePlacementPos: { x: number; z: number };
  calledShot: CalledShot;
  pocketedNumbers: number[];
  winner: PlayerId | null;
  loser: PlayerId | null;
  gameOverReason: string | null;
  statusHeadline: string;
  lastFoulMessage: string | null;
  banner: MatchBannerNotice | null;
  totalMatchShots: number;
  shotSeq: number;
  player1Name: string;
  player2Name: string;
  rematchVotes: PlayerId[];
  serverTimeMs: number;
}

export interface MatchHistoryRecord {
  matchId: string;
  roomId: string;
  player1Name: string;
  player2Name: string;
  winnerName: string;
  winnerRole: PlayerId;
  reason: string;
  totalShots: number;
  endedAtMs: number;
}

export interface OnlineServerStats {
  activeRooms: number;
  activeMatches: number;
  queueSize: number;
  connectedPlayers: number;
  totalMatchesCompleted: number;
}

export type MultiplayerErrorCode =
  | 'CONNECTION_FAILED'
  | 'INVALID_ROOM'
  | 'ROOM_FULL'
  | 'ROOM_EXPIRED'
  | 'UNAUTHORIZED'
  | 'OUT_OF_TURN'
  | 'DUPLICATE_SHOT'
  | 'INVALID_INPUT'
  | 'ALREADY_IN_MATCH'
  | 'MATCH_FINISHED'
  | 'MATCH_NOT_READY'
  | 'RATE_LIMITED'
  | 'MATCHMAKING_TIMEOUT';

export type ClientToServerMessage =
  | {
      type: 'session:init';
      displayName: string;
      avatarId: OnlineAvatarId;
      latencyMs?: number;
    }
  | {
      type: 'session:resume';
      sessionId: string;
      reconnectToken: string;
      displayName?: string;
      avatarId?: OnlineAvatarId;
    }
  | {
      type: 'session:update_profile';
      displayName: string;
      avatarId: OnlineAvatarId;
    }
  | {
      type: 'ping';
      clientTimeMs: number;
      latencyMs?: number;
    }
  | {
      type: 'room:create';
      isPrivate: boolean;
      ruleProfileId: RuleProfileId;
      calledShotsEnabled: boolean;
    }
  | {
      type: 'room:join';
      roomCode: string;
    }
  | {
      type: 'room:ready';
      ready: boolean;
    }
  | {
      type: 'room:start';
    }
  | {
      type: 'room:cancel';
    }
  | {
      type: 'room:leave';
    }
  | {
      type: 'room:rematch';
    }
  | {
      type: 'matchmaking:join';
      ruleProfileId: RuleProfileId;
      calledShotsEnabled: boolean;
    }
  | {
      type: 'matchmaking:cancel';
    }
  | {
      type: 'game:aim';
      cueAngle: number;
    }
  | {
      type: 'game:spin';
      x: number;
      y: number;
    }
  | {
      type: 'game:called_shot';
      targetBall: number | null;
      targetPocket: PocketId | null;
    }
  | {
      type: 'game:place_cue';
      x: number;
      z: number;
      confirm: boolean;
    }
  | {
      type: 'game:shoot';
      shotToken: string;
      cueAngle: number;
      power: number;
      spinX: number;
      spinY: number;
      calledBall: number | null;
      calledPocket: PocketId | null;
    }
  | {
      type: 'game:forfeit';
    }
  | {
      type: 'game:request_sync';
    };

export type ServerToClientMessage =
  | {
      type: 'session:ready';
      sessionId: string;
      reconnectToken: string;
      displayName: string;
      avatarId: OnlineAvatarId;
      resumedRoom: OnlineRoomInfo | null;
      resumedMatch: OnlineMatchSnapshot | null;
      balls: OnlineBallFrame[] | null;
      serverTimeMs: number;
    }
  | {
      type: 'pong';
      clientTimeMs: number;
      serverTimeMs: number;
    }
  | {
      type: 'error';
      code: MultiplayerErrorCode;
      message: string;
    }
  | {
      type: 'room:created';
      room: OnlineRoomInfo;
    }
  | {
      type: 'room:updated';
      room: OnlineRoomInfo;
    }
  | {
      type: 'room:closed';
      roomId: string;
      reason: string;
    }
  | {
      type: 'matchmaking:searching';
      position: number;
      startedAtMs: number;
      timeoutAtMs: number;
    }
  | {
      type: 'matchmaking:matched';
      room: OnlineRoomInfo;
    }
  | {
      type: 'matchmaking:cancelled';
      reason: string;
    }
  | {
      type: 'matchmaking:timeout';
      message: string;
    }
  | {
      type: 'match:started';
      room: OnlineRoomInfo;
      match: OnlineMatchSnapshot;
      balls: OnlineBallFrame[];
    }
  | {
      type: 'match:shot_started';
      roomId: string;
      shotSeq: number;
      shooter: PlayerId;
      cueAngle: number;
      power: number;
      spinX: number;
      spinY: number;
    }
  | {
      type: 'physics:frame';
      roomId: string;
      shotSeq: number;
      serverTimeMs: number;
      balls: OnlineBallFrame[];
    }
  | {
      type: 'physics:pocket';
      roomId: string;
      shotSeq: number;
      ballNumber: number;
      pocketId: PocketId;
      order: number;
    }
  | {
      type: 'match:settled';
      room: OnlineRoomInfo;
      match: OnlineMatchSnapshot;
      balls: OnlineBallFrame[];
    }
  | {
      type: 'match:state_sync';
      room: OnlineRoomInfo;
      match: OnlineMatchSnapshot;
      balls: OnlineBallFrame[];
    }
  | {
      type: 'match:over';
      room: OnlineRoomInfo;
      match: OnlineMatchSnapshot;
      balls: OnlineBallFrame[];
      historyRecord: MatchHistoryRecord;
    }
  | {
      type: 'match:rematch_started';
      room: OnlineRoomInfo;
      match: OnlineMatchSnapshot;
      balls: OnlineBallFrame[];
    }
  | {
      type: 'match:aim_preview';
      roomId: string;
      player: PlayerId;
      cueAngle: number;
    }
  | {
      type: 'match:spin_preview';
      roomId: string;
      player: PlayerId;
      x: number;
      y: number;
    }
  | {
      type: 'opponent:disconnected';
      roomId: string;
      sessionId: string;
      displayName: string;
      graceDeadlineMs: number;
    }
  | {
      type: 'opponent:reconnected';
      roomId: string;
      sessionId: string;
      displayName: string;
    };
