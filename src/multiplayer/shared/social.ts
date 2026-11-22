import type { PlayerId, RuleProfileId } from '../../game/rules/types';
import type { OnlineAvatarId } from './protocol';

export type PresenceStatus =
  | 'online'
  | 'offline'
  | 'in_match'
  | 'in_tournament'
  | 'spectating'
  | 'busy';
export type ManualPresenceStatus = 'online' | 'busy';

export type FriendRequestAction = 'accept' | 'reject' | 'cancel';
export type MatchInviteAction = 'accept' | 'reject' | 'cancel';
export type MatchInviteStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
export type MatchInviteKind = 'match' | 'spectate';

export type FriendRequestPolicy = 'everyone' | 'nobody';
export type InviteOrMessagePolicy = 'everyone' | 'friends' | 'nobody';

export interface PrivacySettings {
  allowFriendRequests: FriendRequestPolicy;
  allowMatchInvites: InviteOrMessagePolicy;
  allowDirectMessages: InviteOrMessagePolicy;
  showOnlineStatus: boolean;
  showPublicStats: boolean;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  allowFriendRequests: 'everyone',
  allowMatchInvites: 'friends',
  allowDirectMessages: 'friends',
  showOnlineStatus: true,
  showPublicStats: true,
};

export type SocialReportContext = 'dm' | 'room_chat' | 'profile';
export type SocialReportReason =
  | 'spam'
  | 'harassment'
  | 'inappropriate_name'
  | 'cheating'
  | 'other';

export const SOCIAL_LIMITS = {
  chatMaxLength: 240,
  chatMinIntervalMs: 850,
  chatBurstWindowMs: 10_000,
  chatBurstMaxCount: 5,
  chatDuplicateWindowMs: 6_000,
  defaultPresenceTtlMs: 45_000,
  defaultInviteTtlMs: 90_000,
  defaultNotificationTtlMs: 14 * 24 * 60 * 60 * 1000,
  maxPendingOutgoingInvites: 8,
  maxFriends: 200,
  maxDmHistory: 60,
  maxRoomChatHistory: 80,
  maxNotifications: 100,
  maxClubMembers: 100,
  defaultClubCapacity: 50,
  minClubCapacity: 10,
  clubChatMaxLength: 240,
  clubAnnouncementMaxLength: 280,
  maxTeamsPerClub: 8,
  minTeamRoster: 1,
  maxTeamRoster: 10,
} as const;

export interface FriendRoomAvailability {
  roomId: string;
  roomCode: string;
  status: 'waiting' | 'ready' | 'playing';
  isPrivate: boolean;
  ruleProfileId: RuleProfileId;
  joinable: boolean;
  spectatable: boolean;
}

export interface PlayerClubBadgeSummary {
  clubId: string;
  name: string;
  tag: string;
  emblemColor: string;
  emblemIcon: string;
  role: ClubRole;
}

export interface FriendRecord {
  playerId: string;
  username: string | null;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo: number;
  level: number;
  wins: number;
  totalMatches: number;
  presence: PresenceStatus;
  lastSeenAtMs: number | null;
  unreadDmCount: number;
  friendedAtMs: number;
  activeRoom?: FriendRoomAvailability | null;
  club?: PlayerClubBadgeSummary | null;
}

export interface FriendRequestRecord {
  requestId: string;
  direction: 'incoming' | 'outgoing';
  playerId: string;
  username: string | null;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo: number;
  level: number;
  createdAtMs: number;
}

export interface BlockedPlayerRecord {
  playerId: string;
  username: string | null;
  displayName: string;
  avatarId: OnlineAvatarId;
  blockedAtMs: number;
}

export interface MatchInvitationRecord {
  inviteId: string;
  inviteKind?: MatchInviteKind;
  senderId: string;
  senderName: string;
  senderAvatar: OnlineAvatarId;
  senderElo: number;
  recipientId: string;
  recipientName: string;
  recipientAvatar: OnlineAvatarId;
  roomId: string | null;
  roomCode: string | null;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  status: MatchInviteStatus;
  createdAtMs: number;
  expiresAtMs: number;
  respondedAtMs: number | null;
}

export interface DirectMessageRecord {
  messageId: string;
  senderId: string;
  recipientId: string;
  senderName: string;
  senderAvatar: OnlineAvatarId;
  body: string;
  createdAtMs: number;
  readAtMs: number | null;
}

export interface RoomChatMessageRecord {
  messageId: string;
  roomId: string;
  senderSessionId: string;
  senderPlayerId: string;
  senderName: string;
  senderAvatar: OnlineAvatarId;
  senderRole: PlayerId | 'spectator';
  channel?: 'match' | 'spectator';
  body: string;
  createdAtMs: number;
}

export type NotificationType =
  | 'friend_request'
  | 'friend_response'
  | 'match_invite'
  | 'club_invite'
  | 'club_join_request'
  | 'private_message'
  | 'club_challenge'
  | 'tournament_event'
  | 'team_league_event'
  | 'club_championship_event';

export interface SocialNotificationRecord {
  notificationId: string;
  recipientId: string;
  type: NotificationType;
  title: string;
  body: string;
  actorId: string | null;
  actorName: string | null;
  referenceId: string | null;
  dedupeKey: string | null;
  readAtMs: number | null;
  createdAtMs: number;
  expiresAtMs: number | null;
}

export type ClubRole =
  | 'owner'
  | 'president'
  | 'vice_president'
  | 'captain'
  | 'member'
  | 'admin';

export const CLUB_ROLE_RANK: Record<ClubRole, number> = {
  owner: 5,
  president: 4,
  vice_president: 3,
  admin: 3,
  captain: 2,
  member: 1,
};

export function normalizeClubRole(raw: unknown): ClubRole {
  switch (raw) {
    case 'owner':
    case 'president':
    case 'vice_president':
    case 'captain':
    case 'admin':
    case 'member':
      return raw;
    default:
      return 'member';
  }
}

export function isClubOfficerRole(role: ClubRole | null | undefined): boolean {
  return (
    role === 'owner' ||
    role === 'president' ||
    role === 'vice_president' ||
    role === 'admin'
  );
}

export function canManageClubTeams(role: ClubRole | null | undefined): boolean {
  return isClubOfficerRole(role) || role === 'captain';
}

export function getClubRoleLabel(role: ClubRole): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'president':
      return 'President';
    case 'vice_president':
    case 'admin':
      return 'Vice President';
    case 'captain':
      return 'Captain';
    case 'member':
    default:
      return 'Member';
  }
}

export function calculateClubLevelFromXp(rawXp: number): {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
} {
  const xp = Math.max(0, Math.floor(Number.isFinite(rawXp) ? rawXp : 0));
  let level = 1;
  let remaining = xp;
  while (level < 100) {
    const req = 250 + (level - 1) * 150;
    if (remaining < req) {
      return {
        level,
        xp,
        xpIntoLevel: remaining,
        xpForNextLevel: req,
      };
    }
    remaining -= req;
    level += 1;
  }
  return {
    level: 100,
    xp,
    xpIntoLevel: remaining,
    xpForNextLevel: 250 + 99 * 150,
  };
}

export type ClubJoinMode = 'public' | 'approval';
export type ClubEmblemIcon = 'shield' | 'crown' | 'flame' | 'star' | 'swords' | 'target';
export type ClubLeaderboardScope = 'global' | 'weekly' | 'seasonal';
export type ClubChallengeStatus =
  | 'pending'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'expired';

export interface ClubRecord {
  clubId: string;
  name: string;
  tag: string;
  description: string;
  emblemColor: string;
  emblemIcon: ClubEmblemIcon;
  joinMode: ClubJoinMode;
  ownerId: string;
  region?: string;
  maxMembers?: number;
  level?: number;
  xp?: number;
  xpIntoLevel?: number;
  xpForNextLevel?: number;
  announcement?: string;
  announcementUpdatedAtMs?: number | null;
  leagueTitles?: number;
  championshipTitles?: number;
  memberCount: number;
  totalWins: number;
  totalMatches: number;
  weeklyWins: number;
  seasonalWins: number;
  challengeWins: number;
  clubRating: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ClubMemberRecord {
  clubId: string;
  playerId: string;
  username: string | null;
  displayName: string;
  avatarId: OnlineAvatarId;
  role: ClubRole;
  elo: number;
  level: number;
  wins: number;
  totalMatches: number;
  presence: PresenceStatus;
  joinedAtMs: number;
}

export interface ClubJoinRequestRecord {
  requestId: string;
  clubId: string;
  playerId: string;
  username: string | null;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo: number;
  level: number;
  message: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  createdAtMs: number;
}

export interface ClubInvitationRecord {
  inviteId: string;
  clubId: string;
  clubName: string;
  clubTag: string;
  emblemColor: string;
  emblemIcon: ClubEmblemIcon;
  inviterId: string;
  inviterName: string;
  recipientId: string;
  recipientName: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ClubActivityRecord {
  activityId: string;
  clubId: string;
  actorId: string | null;
  actorName: string | null;
  eventType: string;
  summary: string;
  createdAtMs: number;
}

export interface ClubLeaderboardEntry {
  rank: number;
  clubId: string;
  name: string;
  tag: string;
  emblemColor: string;
  emblemIcon: ClubEmblemIcon;
  memberCount: number;
  totalWins: number;
  totalMatches: number;
  challengeWins: number;
  clubRating: number;
  periodWins: number;
  periodScore: number;
}

export interface ClubChallengeRecord {
  challengeId: string;
  challengerClubId: string;
  challengerClubName: string;
  challengerClubTag: string;
  targetClubId: string;
  targetClubName: string;
  targetClubTag: string;
  createdByPlayerId: string;
  ruleProfileId: RuleProfileId;
  calledShotsEnabled: boolean;
  targetWins: number;
  challengerScore: number;
  targetScore: number;
  status: ClubChallengeStatus;
  winnerClubId: string | null;
  activeRoomId: string | null;
  activeRoomCode: string | null;
  linkedMatchIds: string[];
  notes: string;
  createdAtMs: number;
  expiresAtMs: number;
  respondedAtMs: number | null;
  completedAtMs: number | null;
}

export interface ClubChatMessageRecord {
  messageId: string;
  clubId: string;
  senderId: string;
  senderName: string;
  senderAvatar: OnlineAvatarId;
  senderRole: ClubRole;
  body: string;
  createdAtMs: number;
}

export interface ClubTrophyRecord {
  trophyId: string;
  clubId: string;
  teamId?: string | null;
  teamName?: string | null;
  competitionKind: 'league' | 'club_championship' | 'challenge';
  competitionId: string;
  title: string;
  tier: 'champion' | 'runner_up' | 'promoted' | 'milestone';
  seasonLabel: string;
  awardedAtMs: number;
}

export interface ClubDetailPayload {
  club: ClubRecord;
  members: ClubMemberRecord[];
  recentActivity: ClubActivityRecord[];
  joinRequests: ClubJoinRequestRecord[];
  challenges: ClubChallengeRecord[];
  chatMessages?: ClubChatMessageRecord[];
  trophies?: ClubTrophyRecord[];
  viewerRole: ClubRole | null;
  viewerHasPendingRequest: boolean;
}

export interface SocialOverviewPayload {
  selfPresence: PresenceStatus;
  friends: FriendRecord[];
  friendsTotal?: number;
  incomingRequests: FriendRequestRecord[];
  outgoingRequests: FriendRequestRecord[];
  blocked: BlockedPlayerRecord[];
  incomingInvitations: MatchInvitationRecord[];
  outgoingInvitations: MatchInvitationRecord[];
  totalUnreadDmCount: number;
  privacy?: PrivacySettings;
  notifications?: SocialNotificationRecord[];
  unreadNotificationCount?: number;
  myClub?: PlayerClubBadgeSummary | null;
  incomingClubInvitations?: ClubInvitationRecord[];
}

export type SocialRelationship =
  | 'self'
  | 'friend'
  | 'incoming_request'
  | 'outgoing_request'
  | 'blocked'
  | 'none';

export interface SocialSearchPlayerItem {
  playerId: string;
  username: string | null;
  displayName: string;
  avatarId: OnlineAvatarId;
  elo: number;
  level: number;
  wins: number;
  totalMatches: number;
  presence: PresenceStatus;
  relationship: SocialRelationship;
  club?: PlayerClubBadgeSummary | null;
}

export function orderedPlayerPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

export function sanitizeChatText(
  raw: unknown,
  maxLength = SOCIAL_LIMITS.chatMaxLength,
): { ok: true; text: string } | { ok: false; code: 'INVALID_INPUT' | 'MESSAGE_TOO_LONG'; message: string } {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'INVALID_INPUT', message: 'Message must be plain text.' };
  }
  const stripped = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Message cannot be empty.' };
  }
  if (stripped.length > maxLength) {
    return {
      ok: false,
      code: 'MESSAGE_TOO_LONG',
      message: `Message exceeds the ${maxLength}-character limit.`,
    };
  }
  return { ok: true, text: stripped };
}

export function sanitizeClubText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeReportDetails(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

export function isValidReportReason(raw: unknown): raw is SocialReportReason {
  return (
    raw === 'spam' ||
    raw === 'harassment' ||
    raw === 'inappropriate_name' ||
    raw === 'cheating' ||
    raw === 'other'
  );
}

export function isValidManualPresence(raw: unknown): raw is ManualPresenceStatus {
  return raw === 'online' || raw === 'busy';
}

export function normalizePrivacySettings(raw: Partial<PrivacySettings> | null | undefined): PrivacySettings {
  const allowFriendRequests: FriendRequestPolicy =
    raw?.allowFriendRequests === 'nobody' ? 'nobody' : 'everyone';
  const allowMatchInvites: InviteOrMessagePolicy =
    raw?.allowMatchInvites === 'everyone' || raw?.allowMatchInvites === 'nobody'
      ? raw.allowMatchInvites
      : 'friends';
  const allowDirectMessages: InviteOrMessagePolicy =
    raw?.allowDirectMessages === 'everyone' || raw?.allowDirectMessages === 'nobody'
      ? raw.allowDirectMessages
      : 'friends';
  return {
    allowFriendRequests,
    allowMatchInvites,
    allowDirectMessages,
    showOnlineStatus: raw?.showOnlineStatus !== undefined ? Boolean(raw.showOnlineStatus) : true,
    showPublicStats: raw?.showPublicStats !== undefined ? Boolean(raw.showPublicStats) : true,
  };
}
