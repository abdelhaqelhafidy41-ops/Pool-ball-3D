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
import type { EquippedCosmetics } from './economy';
import type {
  MatchCompletionType,
  MatchProgressionRewardSummary,
  OnlineMatchType,
} from './progression';
import type {
  ClubChallengeRecord,
  ClubChatMessageRecord,
  ClubDetailPayload,
  ClubInvitationRecord,
  DirectMessageRecord,
  FriendRequestAction,
  FriendRequestRecord,
  ManualPresenceStatus,
  MatchInvitationRecord,
  MatchInviteAction,
  MatchInviteKind,
  PresenceStatus,
  PrivacySettings,
  RoomChatMessageRecord,
  SocialNotificationRecord,
  SocialOverviewPayload,
} from './social';
import type { TournamentMatch, TournamentRecord } from './tournaments';
import type { TeamSubMatchRecord } from './clubLeagues';

import type { RankTierDefinition } from './ranked';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type OpponentConnectionState = 'connected' | 'disconnected' | 'reconnected';
export type OnlineModeIntent = 'quick' | 'ranked' | 'create' | 'join' | 'friend' | 'spectate';
export type SpectatorCameraMode =
  | 'overview'
  | 'topDown'
  | 'ballFollow'
  | 'activeShot'
  | 'cinematic'
  | 'free';

export type StarterAvatarId =
  | 'cue_gold'
  | 'eight_obsidian'
  | 'crown_emerald'
  | 'shark_sky'
  | 'diamond_crimson'
  | 'ace_violet'
  | 'trophy_platinum'
  | 'break_amber';

export type StoreAvatarId =
  | 'avatar_neon_phoenix'
  | 'avatar_golden_crown'
  | 'avatar_void_samurai'
  | 'avatar_eclipse_grandmaster'
  | 'avatar_solar_sovereign';

export type OnlineAvatarId = StarterAvatarId | StoreAvatarId;

export const ONLINE_AVATARS: Array<{
  id: StarterAvatarId;
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
  { id: 'trophy_platinum', label: 'Champion', accent: '#e2e8f0', glyph: '🏆' },
  { id: 'break_amber', label: 'Breaker', accent: '#fb923c', glyph: '⚡' },
];

export interface OnlinePlayerProfile {
  sessionId: string;
  playerId?: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo?: number;
  rankTier?: RankTierDefinition;
  equippedCosmetics?: EquippedCosmetics;
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

export interface OnlineRoomTournamentContext {
  tournamentId: string;
  tournamentTitle: string;
  bracketMatchId: string;
  roundNumber: number;
  roundLabel: string;
  readyDeadlineMs: number | null;
}

export interface OnlineRoomClubLeagueContext {
  competitionKind: 'league' | 'club_championship';
  competitionId: string;
  competitionTitle: string;
  encounterId: string;
  subMatchId: string;
  slotIndex: number;
  boardLabel: string;
  homeTeamId: string;
  homeTeamName: string;
  homeTeamTag: string;
  awayTeamId: string;
  awayTeamName: string;
  awayTeamTag: string;
}

export interface SpectatorSummary {
  playerId: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  connected?: boolean;
}

export interface SpectatableMatchPlayer {
  playerId: string;
  displayName: string;
  avatarId: OnlineAvatarId;
  role: PlayerId;
  elo?: number;
  rankTier?: RankTierDefinition;
}

export interface SpectatableMatchSummary {
  roomId: string;
  roomCode: string;
  matchType: OnlineMatchType;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  status: OnlineRoomStatus;
  isPrivate: boolean;
  allowSpectators: boolean;
  allowSpectatorChat: boolean;
  spectatorCount: number;
  maxSpectators: number;
  createdAtMs: number;
  startedAtMs?: number | null;
  players: SpectatableMatchPlayer[];
  tournament?: OnlineRoomTournamentContext | null;
  clubLeague?: OnlineRoomClubLeagueContext | null;
}

export interface OnlineRoomInfo {
  roomId: string;
  roomCode: string;
  hostSessionId: string;
  isPrivate: boolean;
  matchType?: OnlineMatchType;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  status: OnlineRoomStatus;
  players: OnlinePlayerProfile[];
  allowSpectators?: boolean;
  allowSpectatorChat?: boolean;
  maxSpectators?: number;
  spectatorShareToken?: string | null;
  spectatorCount?: number;
  spectators?: SpectatorSummary[];
  createdAtMs: number;
  expiresAtMs: number;
  tournament?: OnlineRoomTournamentContext | null;
  clubLeague?: OnlineRoomClubLeagueContext | null;
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
  player1Id?: string;
  player2Id?: string;
  player1Name: string;
  player2Name: string;
  player1Avatar?: OnlineAvatarId;
  player2Avatar?: OnlineAvatarId;
  winnerId?: string | null;
  winnerName: string;
  winnerRole: PlayerId;
  ruleProfileId?: RuleProfileId;
  matchType?: OnlineMatchType;
  completionType?: MatchCompletionType;
  rankedApplied?: boolean;
  p1EloBefore?: number;
  p1EloAfter?: number;
  p1EloDelta?: number;
  p2EloBefore?: number;
  p2EloAfter?: number;
  p2EloDelta?: number;
  p1RankTier?: RankTierDefinition;
  p2RankTier?: RankTierDefinition;
  seasonId?: string | null;
  durationSec?: number;
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
  | 'MATCHMAKING_TIMEOUT'
  | 'BLOCKED_PLAYER'
  | 'INVITE_EXPIRED'
  | 'INVITE_ALREADY_EXISTS'
  | 'PLAYER_OFFLINE'
  | 'SELF_ACTION_FORBIDDEN'
  | 'ALREADY_FRIENDS'
  | 'DUPLICATE_REQUEST'
  | 'MESSAGE_TOO_LONG'
  | 'TOURNAMENT_FULL'
  | 'ALREADY_REGISTERED'
  | 'TOURNAMENT_CLOSED'
  | 'MATCH_LOCKED'
  | 'RANKED_RESTRICTED'
  | 'SUSPENDED'
  | 'CHEAT_REJECTED'
  | 'PRIVACY_RESTRICTED'
  | 'NOT_FRIENDS'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CLUB_ERROR'
  | 'SPECTATE_UNAVAILABLE'
  | 'SPECTATOR_CHAT_DISABLED';

export type ClientToServerMessage =
  | {
      type: 'session:init';
      displayName: string;
      avatarId: OnlineAvatarId;
      latencyMs?: number;
      playerId?: string;
      playerToken?: string;
    }
  | {
      type: 'session:resume';
      sessionId: string;
      reconnectToken: string;
      displayName?: string;
      avatarId?: OnlineAvatarId;
      playerId?: string;
      playerToken?: string;
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
      mode?: 'quick' | 'ranked';
      region?: string;
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
    }
  | {
      type: 'presence:set';
      status: ManualPresenceStatus;
    }
  | {
      type: 'presence:heartbeat';
      status?: ManualPresenceStatus;
    }
  | {
      type: 'social:sync';
    }
  | {
      type: 'social:friend_request';
      targetPlayerId: string;
    }
  | {
      type: 'social:friend_respond';
      targetPlayerId: string;
      action: FriendRequestAction;
    }
  | {
      type: 'social:friend_remove';
      targetPlayerId: string;
    }
  | {
      type: 'social:block';
      targetPlayerId: string;
    }
  | {
      type: 'social:unblock';
      targetPlayerId: string;
    }
  | {
      type: 'invite:send';
      targetPlayerId: string;
      ruleProfileId: RuleProfileId;
      calledShotsEnabled: boolean;
      inviteKind?: MatchInviteKind;
      roomId?: string;
      ttlMs?: number;
    }
  | {
      type: 'invite:respond';
      inviteId: string;
      action: MatchInviteAction;
    }
  | {
      type: 'chat:dm_send';
      recipientId: string;
      body: string;
      clientMessageId?: string;
    }
  | {
      type: 'chat:dm_mark_read';
      peerPlayerId: string;
    }
  | {
      type: 'chat:room_send';
      body: string;
      clientMessageId?: string;
    }
  | {
      type: 'social:mark_notification_read';
      notificationId?: string;
    }
  | {
      type: 'social:clear_notifications';
      notificationId?: string;
    }
  | {
      type: 'social:privacy_update';
      privacy: Partial<PrivacySettings>;
    }
  | {
      type: 'room:join_friend';
      friendPlayerId: string;
    }
  | {
      type: 'room:spectate';
      roomId?: string;
      roomCode?: string;
      targetPlayerId?: string;
      shareToken?: string;
    }
  | {
      type: 'room:set_spectators';
      allowSpectators: boolean;
      allowSpectatorChat?: boolean;
    }
  | {
      type: 'club:sync';
    }
  | {
      type: 'tournament:subscribe';
      tournamentId: string;
    }
  | {
      type: 'tournament:unsubscribe';
      tournamentId?: string;
    }
  | {
      type: 'tournament:join_match';
      tournamentId: string;
      bracketMatchId: string;
    };

export type ServerToClientMessage =
  | {
      type: 'session:ready';
      sessionId: string;
      reconnectToken: string;
      playerId?: string;
      playerToken?: string;
      displayName: string;
      avatarId: OnlineAvatarId;
      isSpectator?: boolean;
      spectatorCount?: number;
      resumedRoom: OnlineRoomInfo | null;
      resumedMatch: OnlineMatchSnapshot | null;
      balls: OnlineBallFrame[] | null;
      serverTimeMs: number;
    }
  | {
      type: 'spectate:joined';
      room: OnlineRoomInfo;
      match: OnlineMatchSnapshot | null;
      balls: OnlineBallFrame[] | null;
      chatHistory?: RoomChatMessageRecord[];
      spectatorSessionId: string;
      spectatorReconnectToken: string;
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
      mode?: 'quick' | 'ranked';
      elo?: number;
      eloSpread?: number;
      region?: string;
      estimatedWaitSec?: number | null;
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
      progression?: MatchProgressionRewardSummary;
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
    }
  | {
      type: 'social:state';
      overview: SocialOverviewPayload;
    }
  | {
      type: 'social:presence_changed';
      playerId: string;
      status: PresenceStatus;
      lastSeenAtMs: number;
    }
  | {
      type: 'social:friend_request_received';
      request: FriendRequestRecord;
    }
  | {
      type: 'social:friend_updated';
      actorId: string;
      action: 'accepted' | 'rejected' | 'cancelled' | 'removed' | 'blocked' | 'unblocked';
    }
  | {
      type: 'invite:received';
      invitation: MatchInvitationRecord;
    }
  | {
      type: 'invite:updated';
      invitation: MatchInvitationRecord;
      room?: OnlineRoomInfo;
    }
  | {
      type: 'chat:dm_message';
      message: DirectMessageRecord;
      clientMessageId?: string;
    }
  | {
      type: 'chat:dm_read';
      readerId: string;
      peerPlayerId: string;
      readAtMs: number;
    }
  | {
      type: 'chat:room_history';
      roomId: string;
      messages: RoomChatMessageRecord[];
    }
  | {
      type: 'chat:room_message';
      roomId: string;
      message: RoomChatMessageRecord;
      clientMessageId?: string;
    }
  | {
      type: 'tournament:updated';
      tournament: TournamentRecord;
      matches?: TournamentMatch[];
    }
  | {
      type: 'tournament:match_ready';
      tournamentId: string;
      tournamentTitle: string;
      match: TournamentMatch;
      room?: OnlineRoomInfo;
    }
  | {
      type: 'tournament:completed';
      tournament: TournamentRecord;
    }
  | {
      type: 'notification:new';
      notification: SocialNotificationRecord;
      unreadCount: number;
    }
  | {
      type: 'notifications:updated';
      notifications: SocialNotificationRecord[];
      unreadCount: number;
    }
  | {
      type: 'privacy:updated';
      privacy: PrivacySettings;
    }
  | {
      type: 'club:updated';
      clubDetail?: ClubDetailPayload | null;
      incomingInvitations?: ClubInvitationRecord[];
    }
  | {
      type: 'club:challenge_updated';
      challenge: ClubChallengeRecord;
    }
  | {
      type: 'club:chat_message';
      clubId: string;
      message: ClubChatMessageRecord;
    }
  | {
      type: 'club:league_updated';
      leagueId: string;
      status?: string;
    }
  | {
      type: 'club:championship_updated';
      championshipId: string;
      status?: string;
    }
  | {
      type: 'club:team_match_ready';
      competitionKind: 'league' | 'club_championship';
      competitionId: string;
      competitionTitle: string;
      encounterId: string;
      subMatch: TeamSubMatchRecord;
      room?: OnlineRoomInfo;
    };
