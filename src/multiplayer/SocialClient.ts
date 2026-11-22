import type { RuleProfileId } from '../game/rules/types';
import { useGameStore } from '../store/useGameStore';
import { getStoredPlayerIdentity, progressionClient, resolveProgressionApiBase, type ApiResult } from './ProgressionClient';
import type { OnlineRoomInfo } from './shared/protocol';
import type {
  ClubChallengeRecord,
  ClubChatMessageRecord,
  ClubDetailPayload,
  ClubEmblemIcon,
  ClubJoinMode,
  ClubLeaderboardEntry,
  ClubLeaderboardScope,
  ClubRecord,
  ClubRole,
  ClubTrophyRecord,
  DirectMessageRecord,
  FriendRecord,
  FriendRequestAction,
  ManualPresenceStatus,
  MatchInvitationRecord,
  MatchInviteAction,
  MatchInviteKind,
  PresenceStatus,
  PrivacySettings,
  SocialNotificationRecord,
  SocialOverviewPayload,
  SocialReportContext,
  SocialReportReason,
  SocialSearchPlayerItem,
} from './shared/social';

class SocialClientImpl {
  private async requestJson<T>(
    path: string,
    options?: RequestInit,
  ): Promise<{ ok: boolean; status: number; json: T & { error?: string; message?: string } }> {
    const base = resolveProgressionApiBase();
    const res = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
    });
    const json = (await res.json().catch(() => ({}))) as T & {
      error?: string;
      message?: string;
    };
    return { ok: res.ok, status: res.status, json };
  }

  private async ensureCredentials() {
    let stored = getStoredPlayerIdentity();
    if (!stored) {
      await progressionClient.ensurePlayerSession();
      stored = getStoredPlayerIdentity();
    }
    return stored;
  }

  public async fetchOverview(): Promise<ApiResult<SocialOverviewPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) {
      return { ok: false, error: 'Unable to verify player identity.' };
    }
    try {
      const { ok, json } = await this.requestJson<{ overview: SocialOverviewPayload }>(
        `/api/social/overview?playerId=${encodeURIComponent(creds.playerId)}`,
        {
          headers: { Authorization: `Bearer ${creds.playerToken}` },
        },
      );
      if (!ok || !json.overview) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to load social list.' };
      }
      useGameStore.getState().applySocialOverview(json.overview);
      return { ok: true, data: json.overview };
    } catch {
      return { ok: false, error: 'Network error loading friends & social data.' };
    }
  }

  public async searchPlayers(query: string, limit = 15): Promise<SocialSearchPlayerItem[]> {
    const creds = getStoredPlayerIdentity();
    try {
      const qs = new URLSearchParams({ q: query, limit: String(limit) });
      if (creds?.playerId) qs.set('playerId', creds.playerId);
      const { ok, json } = await this.requestJson<{ players: SocialSearchPlayerItem[] }>(
        `/api/social/search?${qs.toString()}`,
        creds ? { headers: { Authorization: `Bearer ${creds.playerToken}` } } : undefined,
      );
      return ok && Array.isArray(json.players) ? json.players : [];
    } catch {
      return [];
    }
  }

  public async sendFriendRequest(
    targetPlayerId: string,
  ): Promise<ApiResult<{ outcome: 'requested' | 'accepted' }>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ outcome: 'requested' | 'accepted' }>(
        '/api/social/friends/request',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Friend request failed.' };
      }
      void this.fetchOverview();
      return { ok: true, data: { outcome: json.outcome } };
    } catch {
      return { ok: false, error: 'Network error sending friend request.' };
    }
  }

  public async respondFriendRequest(
    targetPlayerId: string,
    action: FriendRequestAction,
  ): Promise<ApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<Record<string, unknown>>(
        '/api/social/friends/respond',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId, action }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Action failed.' };
      }
      void this.fetchOverview();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error updating friend request.' };
    }
  }

  public async removeFriend(targetPlayerId: string): Promise<ApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<Record<string, unknown>>(
        '/api/social/friends/remove',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to remove friend.' };
      }
      void this.fetchOverview();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error removing friend.' };
    }
  }

  public async blockPlayer(targetPlayerId: string): Promise<ApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<Record<string, unknown>>(
        '/api/social/block',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to block player.' };
      }
      void this.fetchOverview();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error blocking player.' };
    }
  }

  public async unblockPlayer(targetPlayerId: string): Promise<ApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<Record<string, unknown>>(
        '/api/social/unblock',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to unblock player.' };
      }
      void this.fetchOverview();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error unblocking player.' };
    }
  }

  public async setPresence(status: ManualPresenceStatus): Promise<ApiResult<PresenceStatus>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ status: PresenceStatus }>(
        '/api/social/presence',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, status }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to update status.' };
      }
      useGameStore
        .getState()
        .updatePlayerPresence(creds.playerId, json.status, Date.now());
      return { ok: true, data: json.status };
    } catch {
      return { ok: false, error: 'Network error updating presence.' };
    }
  }

  public async sendInvite(params: {
    targetPlayerId: string;
    ruleProfileId: RuleProfileId;
    calledShotsEnabled: boolean;
    inviteKind?: MatchInviteKind;
    roomId?: string;
  }): Promise<ApiResult<MatchInvitationRecord>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ invitation: MatchInvitationRecord }>(
        '/api/social/invites',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({
            playerId: creds.playerId,
            targetPlayerId: params.targetPlayerId,
            ruleProfileId: params.ruleProfileId,
            calledShotsEnabled: params.calledShotsEnabled,
            inviteKind: params.inviteKind,
            roomId: params.roomId,
          }),
        },
      );
      if (!ok || !json.invitation) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to send invitation.' };
      }
      useGameStore.getState().upsertInvitation(json.invitation);
      return { ok: true, data: json.invitation };
    } catch {
      return { ok: false, error: 'Network error sending match invitation.' };
    }
  }

  public async respondInvite(
    inviteId: string,
    action: MatchInviteAction,
  ): Promise<
    ApiResult<{
      invitation: MatchInvitationRecord;
      room?: OnlineRoomInfo;
      spectateTarget?: { roomId: string; roomCode: string | null };
    }>
  > {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{
        invitation: MatchInvitationRecord;
        room?: OnlineRoomInfo;
        spectateTarget?: { roomId: string; roomCode: string | null };
      }>('/api/social/invites/respond', {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.playerToken}` },
        body: JSON.stringify({
          playerId: creds.playerId,
          inviteId,
          action,
        }),
      });
      if (!ok || !json.invitation) {
        void this.fetchOverview();
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to respond to invitation.',
        };
      }
      useGameStore.getState().upsertInvitation(json.invitation);
      return {
        ok: true,
        data: {
          invitation: json.invitation,
          room: json.room,
          spectateTarget: json.spectateTarget,
        },
      };
    } catch {
      return { ok: false, error: 'Network error responding to match invitation.' };
    }
  }

  public async fetchDirectMessages(peerId: string): Promise<ApiResult<DirectMessageRecord[]>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ messages: DirectMessageRecord[] }>(
        `/api/social/messages/${encodeURIComponent(peerId)}?playerId=${encodeURIComponent(creds.playerId)}`,
        {
          headers: { Authorization: `Bearer ${creds.playerToken}` },
        },
      );
      if (!ok || !Array.isArray(json.messages)) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to load chat.' };
      }
      useGameStore.getState().setDmThreadMessages(peerId, json.messages);
      return { ok: true, data: json.messages };
    } catch {
      return { ok: false, error: 'Network error loading messages.' };
    }
  }

  public async sendDirectMessage(
    recipientId: string,
    body: string,
  ): Promise<ApiResult<DirectMessageRecord>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    const clientMessageId = `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { ok, json } = await this.requestJson<{ message: DirectMessageRecord }>(
        '/api/social/messages',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({
            playerId: creds.playerId,
            recipientId,
            body,
            clientMessageId,
          }),
        },
      );
      if (!ok || !json.message) {
        return { ok: false, code: json.error, error: json.message ?? 'Message failed to send.' };
      }
      useGameStore.getState().appendDirectMessage(json.message, creds.playerId);
      return { ok: true, data: json.message };
    } catch {
      return { ok: false, error: 'Network error sending message.' };
    }
  }

  public async submitReport(params: {
    reportedId: string;
    contextType: SocialReportContext;
    contextId?: string | null;
    reason: SocialReportReason;
    details?: string;
    excerpt?: string;
  }): Promise<ApiResult<{ reportId: string }>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ reportId: string }>(
        '/api/social/reports',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({
            playerId: creds.playerId,
            ...params,
          }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to submit report.' };
      }
      return { ok: true, data: { reportId: json.reportId } };
    } catch {
      return { ok: false, error: 'Network error submitting report.' };
    }
  }

  public async joinFriendRoom(
    friendPlayerId: string,
    sessionId?: string | null,
  ): Promise<ApiResult<{ room: OnlineRoomInfo }>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ room: OnlineRoomInfo }>(
        '/api/social/rooms/join-friend',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({
            playerId: creds.playerId,
            friendPlayerId,
            sessionId: sessionId ?? useGameStore.getState().onlineSessionId ?? undefined,
          }),
        },
      );
      if (!ok || !json.room) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to join friend room.',
        };
      }
      return { ok: true, data: { room: json.room } };
    } catch {
      return { ok: false, error: 'Network error joining friend room.' };
    }
  }

  public async fetchFriendsPaginated(opts?: {
    limit?: number;
    offset?: number;
    query?: string;
  }): Promise<ApiResult<{ friends: FriendRecord[]; total: number; hasMore: boolean }>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const qs = new URLSearchParams({
        playerId: creds.playerId,
        limit: String(opts?.limit ?? 25),
        offset: String(opts?.offset ?? 0),
      });
      if (opts?.query) qs.set('q', opts.query);
      const { ok, json } = await this.requestJson<{
        friends: FriendRecord[];
        total: number;
        hasMore: boolean;
      }>(`/api/social/friends?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${creds.playerToken}` },
      });
      if (!ok || !Array.isArray(json.friends)) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to load friends.' };
      }
      useGameStore
        .getState()
        .setFriendsPage(json.friends, json.total, (opts?.offset ?? 0) > 0);
      return {
        ok: true,
        data: { friends: json.friends, total: json.total, hasMore: Boolean(json.hasMore) },
      };
    } catch {
      return { ok: false, error: 'Network error loading friends.' };
    }
  }

  public async fetchPrivacySettings(): Promise<ApiResult<PrivacySettings>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ privacy: PrivacySettings }>(
        `/api/social/privacy?playerId=${encodeURIComponent(creds.playerId)}`,
        {
          headers: { Authorization: `Bearer ${creds.playerToken}` },
        },
      );
      if (!ok || !json.privacy) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to load privacy settings.',
        };
      }
      useGameStore.getState().setPrivacySettings(json.privacy);
      return { ok: true, data: json.privacy };
    } catch {
      return { ok: false, error: 'Network error loading privacy settings.' };
    }
  }

  public async updatePrivacySettings(
    partial: Partial<PrivacySettings>,
  ): Promise<ApiResult<PrivacySettings>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ privacy: PrivacySettings }>(
        '/api/social/privacy',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({
            playerId: creds.playerId,
            ...partial,
          }),
        },
      );
      if (!ok || !json.privacy) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to update privacy settings.',
        };
      }
      useGameStore.getState().setPrivacySettings(json.privacy);
      return { ok: true, data: json.privacy };
    } catch {
      return { ok: false, error: 'Network error saving privacy settings.' };
    }
  }

  public async fetchNotifications(opts?: {
    limit?: number;
    unreadOnly?: boolean;
  }): Promise<ApiResult<{ notifications: SocialNotificationRecord[]; unreadCount: number }>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const qs = new URLSearchParams({
        playerId: creds.playerId,
        limit: String(opts?.limit ?? 40),
      });
      if (opts?.unreadOnly) qs.set('unreadOnly', '1');
      const { ok, json } = await this.requestJson<{
        notifications: SocialNotificationRecord[];
        unreadCount: number;
      }>(`/api/social/notifications?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${creds.playerToken}` },
      });
      if (!ok || !Array.isArray(json.notifications)) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to load notifications.',
        };
      }
      useGameStore
        .getState()
        .applyNotificationsUpdated(json.notifications, json.unreadCount ?? 0);
      return {
        ok: true,
        data: { notifications: json.notifications, unreadCount: json.unreadCount ?? 0 },
      };
    } catch {
      return { ok: false, error: 'Network error loading notifications.' };
    }
  }

  public async markNotificationsRead(
    notificationId?: string,
  ): Promise<ApiResult<{ notifications: SocialNotificationRecord[]; unreadCount: number }>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{
        notifications: SocialNotificationRecord[];
        unreadCount: number;
      }>('/api/social/notifications/read', {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.playerToken}` },
        body: JSON.stringify({
          playerId: creds.playerId,
          notificationId,
        }),
      });
      if (!ok || !Array.isArray(json.notifications)) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to mark notifications read.',
        };
      }
      useGameStore
        .getState()
        .applyNotificationsUpdated(json.notifications, json.unreadCount ?? 0);
      return {
        ok: true,
        data: { notifications: json.notifications, unreadCount: json.unreadCount ?? 0 },
      };
    } catch {
      return { ok: false, error: 'Network error updating notifications.' };
    }
  }

  public async clearNotifications(
    notificationId?: string,
  ): Promise<ApiResult<{ notifications: SocialNotificationRecord[]; unreadCount: number }>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{
        notifications: SocialNotificationRecord[];
        unreadCount: number;
      }>('/api/social/notifications/clear', {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.playerToken}` },
        body: JSON.stringify({
          playerId: creds.playerId,
          notificationId,
        }),
      });
      if (!ok || !Array.isArray(json.notifications)) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to clear notifications.',
        };
      }
      useGameStore
        .getState()
        .applyNotificationsUpdated(json.notifications, json.unreadCount ?? 0);
      return {
        ok: true,
        data: { notifications: json.notifications, unreadCount: json.unreadCount ?? 0 },
      };
    } catch {
      return { ok: false, error: 'Network error clearing notifications.' };
    }
  }

  public async listClubs(query = '', limit = 30): Promise<ClubRecord[]> {
    try {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (query.trim()) qs.set('q', query.trim());
      const { ok, json } = await this.requestJson<{ clubs: ClubRecord[] }>(
        `/api/clubs?${qs.toString()}`,
      );
      const list = ok && Array.isArray(json.clubs) ? json.clubs : [];
      useGameStore.getState().setClubsList(list);
      return list;
    } catch {
      return [];
    }
  }

  public async getClubDetail(clubId: string): Promise<ApiResult<ClubDetailPayload>> {
    const creds = getStoredPlayerIdentity();
    try {
      const qs = creds?.playerId ? `?playerId=${encodeURIComponent(creds.playerId)}` : '';
      const { ok, json } = await this.requestJson<{ detail: ClubDetailPayload }>(
        `/api/clubs/${encodeURIComponent(clubId)}${qs}`,
        creds ? { headers: { Authorization: `Bearer ${creds.playerToken}` } } : undefined,
      );
      if (!ok || !json.detail) {
        return { ok: false, code: json.error, error: json.message ?? 'Club not found.' };
      }
      const store = useGameStore.getState();
      store.setClubDetail(json.detail);
      if (json.detail.viewerRole) {
        store.setMyClub({
          clubId: json.detail.club.clubId,
          name: json.detail.club.name,
          tag: json.detail.club.tag,
          emblemColor: json.detail.club.emblemColor,
          emblemIcon: json.detail.club.emblemIcon,
          role: json.detail.viewerRole,
        });
      }
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error loading club details.' };
    }
  }

  public async createClub(input: {
    name: string;
    tag: string;
    description?: string;
    emblemColor?: string;
    emblemIcon?: ClubEmblemIcon;
    joinMode?: ClubJoinMode;
    region?: string;
    maxMembers?: number;
  }): Promise<ApiResult<ClubDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: ClubDetailPayload }>('/api/clubs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.playerToken}` },
        body: JSON.stringify({ playerId: creds.playerId, ...input }),
      });
      if (!ok || !json.detail) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to create club.' };
      }
      const store = useGameStore.getState();
      store.setClubDetail(json.detail);
      store.setMyClub({
        clubId: json.detail.club.clubId,
        name: json.detail.club.name,
        tag: json.detail.club.tag,
        emblemColor: json.detail.club.emblemColor,
        emblemIcon: json.detail.club.emblemIcon,
        role: 'owner',
      });
      void this.listClubs();
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error creating club.' };
    }
  }

  public async updateClub(
    clubId: string,
    input: {
      description?: string;
      emblemColor?: string;
      emblemIcon?: ClubEmblemIcon;
      joinMode?: ClubJoinMode;
      region?: string;
      maxMembers?: number;
      announcement?: string;
    },
  ): Promise<ApiResult<ClubDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: ClubDetailPayload }>(
        `/api/clubs/${encodeURIComponent(clubId)}/update`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, ...input }),
        },
      );
      if (!ok || !json.detail) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to update club.' };
      }
      const store = useGameStore.getState();
      store.setClubDetail(json.detail);
      if (json.detail.viewerRole) {
        store.setMyClub({
          clubId: json.detail.club.clubId,
          name: json.detail.club.name,
          tag: json.detail.club.tag,
          emblemColor: json.detail.club.emblemColor,
          emblemIcon: json.detail.club.emblemIcon,
          role: json.detail.viewerRole,
        });
      }
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error updating club.' };
    }
  }

  public async joinClub(
    clubId: string,
    message?: string,
  ): Promise<ApiResult<{ outcome: 'joined' | 'requested'; detail?: ClubDetailPayload }>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{
        outcome: 'joined' | 'requested';
        detail?: ClubDetailPayload;
      }>(`/api/clubs/${encodeURIComponent(clubId)}/join`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.playerToken}` },
        body: JSON.stringify({ playerId: creds.playerId, message }),
      });
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to join club.' };
      }
      if (json.outcome === 'joined' && json.detail) {
        const store = useGameStore.getState();
        store.setClubDetail(json.detail);
        store.setMyClub({
          clubId: json.detail.club.clubId,
          name: json.detail.club.name,
          tag: json.detail.club.tag,
          emblemColor: json.detail.club.emblemColor,
          emblemIcon: json.detail.club.emblemIcon,
          role: json.detail.viewerRole ?? 'member',
        });
      }
      void this.listClubs();
      return { ok: true, data: { outcome: json.outcome, detail: json.detail } };
    } catch {
      return { ok: false, error: 'Network error joining club.' };
    }
  }

  public async respondClubJoinRequest(
    clubId: string,
    requestId: string,
    action: 'accept' | 'reject',
  ): Promise<ApiResult<ClubDetailPayload | undefined>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail?: ClubDetailPayload }>(
        `/api/clubs/${encodeURIComponent(clubId)}/requests/respond`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, requestId, action }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Action failed.' };
      }
      if (json.detail) {
        useGameStore.getState().setClubDetail(json.detail);
      } else {
        void this.getClubDetail(clubId);
      }
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error updating join request.' };
    }
  }

  public async inviteToClub(clubId: string, targetPlayerId: string): Promise<ApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<Record<string, unknown>>(
        `/api/clubs/${encodeURIComponent(clubId)}/invite`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to invite player.' };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error sending club invite.' };
    }
  }

  public async respondClubInvite(
    inviteId: string,
    action: 'accept' | 'reject',
  ): Promise<ApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ clubId?: string; detail?: ClubDetailPayload }>(
        '/api/clubs/invites/respond',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, inviteId, action }),
        },
      );
      if (!ok) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to respond to club invite.',
        };
      }
      await this.fetchOverview();
      if (action === 'accept' && json.clubId) {
        await this.getClubDetail(json.clubId);
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error responding to club invite.' };
    }
  }

  public async leaveClub(clubId: string): Promise<ApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<Record<string, unknown>>(
        `/api/clubs/${encodeURIComponent(clubId)}/leave`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to leave club.' };
      }
      const store = useGameStore.getState();
      store.setMyClub(null);
      store.setClubDetail(null);
      void this.listClubs();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error leaving club.' };
    }
  }

  public async updateClubMemberRole(
    clubId: string,
    targetPlayerId: string,
    role: ClubRole,
  ): Promise<ApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail?: ClubDetailPayload }>(
        `/api/clubs/${encodeURIComponent(clubId)}/members/role`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId, role }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to update role.' };
      }
      await this.getClubDetail(clubId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error updating club role.' };
    }
  }

  public async kickClubMember(clubId: string, targetPlayerId: string): Promise<ApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<Record<string, unknown>>(
        `/api/clubs/${encodeURIComponent(clubId)}/members/kick`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to remove member.' };
      }
      await this.getClubDetail(clubId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error kicking club member.' };
    }
  }

  public async fetchClubLeaderboard(
    scope: ClubLeaderboardScope = 'global',
    limit = 30,
  ): Promise<ClubLeaderboardEntry[]> {
    try {
      const qs = new URLSearchParams({ scope, limit: String(limit) });
      const { ok, json } = await this.requestJson<{ entries: ClubLeaderboardEntry[] }>(
        `/api/clubs/leaderboard?${qs.toString()}`,
      );
      const entries = ok && Array.isArray(json.entries) ? json.entries : [];
      useGameStore.getState().setClubLeaderboard(scope, entries);
      return entries;
    } catch {
      return [];
    }
  }

  public async createClubChallenge(input: {
    challengerClubId: string;
    targetClubId: string;
    ruleProfileId?: RuleProfileId;
    calledShotsEnabled?: boolean;
    targetWins?: number;
    notes?: string;
  }): Promise<ApiResult<ClubChallengeRecord>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ challenge: ClubChallengeRecord }>(
        '/api/clubs/challenges',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, ...input }),
        },
      );
      if (!ok || !json.challenge) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to create club challenge.',
        };
      }
      useGameStore.getState().applyClubChallengeUpdated(json.challenge);
      return { ok: true, data: json.challenge };
    } catch {
      return { ok: false, error: 'Network error creating club challenge.' };
    }
  }

  public async respondClubChallenge(
    challengeId: string,
    action: 'accept' | 'decline' | 'cancel',
  ): Promise<ApiResult<ClubChallengeRecord>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ challenge: ClubChallengeRecord }>(
        `/api/clubs/challenges/${encodeURIComponent(challengeId)}/respond`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, action }),
        },
      );
      if (!ok || !json.challenge) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to respond to club challenge.',
        };
      }
      useGameStore.getState().applyClubChallengeUpdated(json.challenge);
      return { ok: true, data: json.challenge };
    } catch {
      return { ok: false, error: 'Network error responding to club challenge.' };
    }
  }

  public async fetchClubChat(clubId: string, limit = 50): Promise<ClubChatMessageRecord[]> {
    try {
      const { ok, json } = await this.requestJson<{ messages: ClubChatMessageRecord[] }>(
        `/api/clubs/${encodeURIComponent(clubId)}/chat?limit=${encodeURIComponent(String(limit))}`,
      );
      const messages = ok && Array.isArray(json.messages) ? json.messages : [];
      useGameStore.getState().setClubChatMessages(messages);
      return messages;
    } catch {
      return [];
    }
  }

  public async sendClubChat(
    clubId: string,
    body: string,
  ): Promise<ApiResult<ClubChatMessageRecord>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ message: ClubChatMessageRecord }>(
        `/api/clubs/${encodeURIComponent(clubId)}/chat`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, body }),
        },
      );
      if (!ok || !json.message) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to post club chat message.',
        };
      }
      useGameStore.getState().appendClubChatMessage(json.message);
      return { ok: true, data: json.message };
    } catch {
      return { ok: false, error: 'Network error posting club chat message.' };
    }
  }

  public async updateClubAnnouncement(
    clubId: string,
    announcement: string,
  ): Promise<ApiResult<ClubDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: ClubDetailPayload }>(
        `/api/clubs/${encodeURIComponent(clubId)}/announcement`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, announcement }),
        },
      );
      if (!ok || !json.detail) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to update announcement.',
        };
      }
      useGameStore.getState().setClubDetail(json.detail);
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error updating club announcement.' };
    }
  }

  public async fetchClubTrophies(clubId: string, limit = 30): Promise<ClubTrophyRecord[]> {
    try {
      const { ok, json } = await this.requestJson<{ trophies: ClubTrophyRecord[] }>(
        `/api/clubs/${encodeURIComponent(clubId)}/trophies?limit=${encodeURIComponent(String(limit))}`,
      );
      const trophies = ok && Array.isArray(json.trophies) ? json.trophies : [];
      useGameStore.getState().setClubTrophies(trophies);
      return trophies;
    } catch {
      return [];
    }
  }
}

export const socialClient = new SocialClientImpl();
