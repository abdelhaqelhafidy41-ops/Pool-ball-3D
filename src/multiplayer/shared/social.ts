import type { PlayerId, RuleProfileId } from '../../game/rules/types';
import type { OnlineAvatarId } from './protocol';

export type PresenceStatus = 'online' | 'offline' | 'in_match' | 'busy';
export type ManualPresenceStatus = 'online' | 'busy';

export type FriendRequestAction = 'accept' | 'reject' | 'cancel';
export type MatchInviteAction = 'accept' | 'reject' | 'cancel';
export type MatchInviteStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';

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
  maxPendingOutgoingInvites: 8,
  maxFriends: 200,
  maxDmHistory: 60,
  maxRoomChatHistory: 80,
} as const;

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
  senderRole: PlayerId;
  body: string;
  createdAtMs: number;
}

export interface SocialOverviewPayload {
  selfPresence: PresenceStatus;
  friends: FriendRecord[];
  incomingRequests: FriendRequestRecord[];
  outgoingRequests: FriendRequestRecord[];
  blocked: BlockedPlayerRecord[];
  incomingInvitations: MatchInvitationRecord[];
  outgoingInvitations: MatchInvitationRecord[];
  totalUnreadDmCount: number;
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
