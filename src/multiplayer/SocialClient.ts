import type { RuleProfileId } from '../game/rules/types';
import { useGameStore } from '../store/useGameStore';
import { getStoredPlayerIdentity, progressionClient, resolveProgressionApiBase, type ApiResult } from './ProgressionClient';
import type { OnlineRoomInfo } from './shared/protocol';
import type {
  DirectMessageRecord,
  FriendRequestAction,
  ManualPresenceStatus,
  MatchInvitationRecord,
  MatchInviteAction,
  PresenceStatus,
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
  ): Promise<ApiResult<{ invitation: MatchInvitationRecord; room?: OnlineRoomInfo }>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{
        invitation: MatchInvitationRecord;
        room?: OnlineRoomInfo;
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
      return { ok: true, data: { invitation: json.invitation, room: json.room } };
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
}

export const socialClient = new SocialClientImpl();
