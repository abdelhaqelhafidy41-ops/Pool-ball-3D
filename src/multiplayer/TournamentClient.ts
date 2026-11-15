import type { OnlineRoomInfo } from './shared/protocol';
import {
  TOURNAMENT_TROPHY_CATALOG,
  type CreateTournamentInput,
  type PlayerTournamentStats,
  type TournamentDetailPayload,
  type TournamentLeaderboardEntry,
  type TournamentMatch,
  type TournamentMatchResolutionType,
  type TournamentParticipant,
  type TournamentRecord,
  type TournamentStatus,
  type TournamentTrophyDef,
  type TournamentType,
} from './shared/tournaments';
import {
  getStoredPlayerIdentity,
  progressionClient,
  resolveProgressionApiBase,
  type ApiResult,
} from './ProgressionClient';
import { useGameStore } from '../store/useGameStore';

export interface JoinTournamentMatchResult {
  ok: true;
  tournament: TournamentRecord;
  match: TournamentMatch;
  room: OnlineRoomInfo;
  roomSession: { sessionId: string; reconnectToken: string };
}

class TournamentClientImpl {
  private async ensureIdentity() {
    let stored = getStoredPlayerIdentity();
    if (!stored) {
      await progressionClient.ensurePlayerSession();
      stored = getStoredPlayerIdentity();
    }
    return stored;
  }

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

  public async fetchTournaments(filters?: {
    type?: TournamentType | 'all';
    status?: TournamentStatus | 'all';
    adminKey?: string;
  }): Promise<{ tournaments: TournamentRecord[]; trophyCatalog: TournamentTrophyDef[] }> {
    try {
      const identity = getStoredPlayerIdentity();
      const qs = new URLSearchParams();
      if (identity?.playerId) qs.set('playerId', identity.playerId);
      if (filters?.type && filters.type !== 'all') qs.set('type', filters.type);
      if (filters?.status && filters.status !== 'all') qs.set('status', filters.status);
      const query = qs.toString();

      const headers: Record<string, string> = {};
      if (filters?.adminKey?.trim()) {
        headers['X-Admin-Key'] = filters.adminKey.trim();
      }

      const { ok, json } = await this.requestJson<{
        tournaments?: TournamentRecord[];
        trophyCatalog?: TournamentTrophyDef[];
      }>(`/api/tournaments${query ? `?${query}` : ''}`, { headers });

      const tournaments = ok && Array.isArray(json.tournaments) ? json.tournaments : [];
      if (ok) {
        useGameStore.getState().setTournamentsList(tournaments);
      }
      return {
        tournaments,
        trophyCatalog:
          ok && Array.isArray(json.trophyCatalog)
            ? json.trophyCatalog
            : TOURNAMENT_TROPHY_CATALOG,
      };
    } catch {
      return {
        tournaments: useGameStore.getState().tournamentsList,
        trophyCatalog: TOURNAMENT_TROPHY_CATALOG,
      };
    }
  }

  public async fetchTournamentDetail(
    tournamentId: string,
    adminKey?: string,
  ): Promise<ApiResult<TournamentDetailPayload>> {
    try {
      const identity = getStoredPlayerIdentity();
      const qs = identity?.playerId
        ? `?playerId=${encodeURIComponent(identity.playerId)}`
        : '';
      const headers: Record<string, string> = {};
      if (adminKey?.trim()) {
        headers['X-Admin-Key'] = adminKey.trim();
      }
      const { ok, json } = await this.requestJson<TournamentDetailPayload>(
        `/api/tournaments/${encodeURIComponent(tournamentId)}${qs}`,
        { headers },
      );
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Tournament not found.',
        };
      }
      const detail: TournamentDetailPayload = {
        tournament: json.tournament,
        participants: json.participants ?? [],
        matches: json.matches ?? [],
        payouts: json.payouts ?? [],
        events: json.events ?? [],
        viewerStatus: json.viewerStatus ?? {
          isRegistered: false,
          participant: null,
          activeMatch: null,
        },
      };
      useGameStore.getState().setActiveTournamentDetail(detail);
      return { ok: true, data: detail };
    } catch {
      return { ok: false, error: 'Network error loading tournament details.' };
    }
  }

  public async fetchLeaderboard(
    seasonKey?: string | null,
    limit = 30,
  ): Promise<TournamentLeaderboardEntry[]> {
    try {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (seasonKey && seasonKey !== 'ALL') {
        qs.set('seasonKey', seasonKey);
      }
      const { ok, json } = await this.requestJson<{
        entries?: TournamentLeaderboardEntry[];
      }>(`/api/tournaments/leaderboard?${qs.toString()}`);
      if (!ok || !Array.isArray(json.entries)) return [];
      useGameStore.getState().setTournamentLeaderboard(json.entries);
      return json.entries;
    } catch {
      return [];
    }
  }

  public async fetchPlayerStats(
    playerId?: string | null,
  ): Promise<PlayerTournamentStats | null> {
    try {
      const targetId = playerId?.trim() || getStoredPlayerIdentity()?.playerId;
      if (!targetId) return null;
      const { ok, json } = await this.requestJson<{ stats?: PlayerTournamentStats }>(
        `/api/tournaments/stats/${encodeURIComponent(targetId)}`,
      );
      if (!ok || !json.stats) return null;
      if (targetId === getStoredPlayerIdentity()?.playerId) {
        useGameStore.getState().setPlayerTournamentStats(json.stats);
      }
      return json.stats;
    } catch {
      return null;
    }
  }

  public async createPrivateTournament(
    input: Partial<CreateTournamentInput>,
  ): Promise<ApiResult<{ tournament: TournamentRecord }>> {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Competitive player session unavailable.' };
    }
    try {
      const { ok, json } = await this.requestJson<{ tournament: TournamentRecord }>(
        '/api/tournaments/private',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${identity.playerToken}` },
          body: JSON.stringify({
            playerId: identity.playerId,
            ...input,
          }),
        },
      );
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to create private tournament.',
        };
      }
      await this.fetchTournaments();
      await this.fetchTournamentDetail(json.tournament.tournamentId);
      return { ok: true, data: { tournament: json.tournament } };
    } catch {
      return { ok: false, error: 'Network error creating private tournament.' };
    }
  }

  public async joinByInviteCode(
    inviteCode: string,
  ): Promise<
    ApiResult<{
      tournament: TournamentRecord;
      participant: TournamentParticipant;
      autoStarted?: boolean;
    }>
  > {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Competitive player session unavailable.' };
    }
    try {
      const { ok, json } = await this.requestJson<{
        tournament: TournamentRecord;
        participant: TournamentParticipant;
        autoStarted?: boolean;
      }>('/api/tournaments/join-code', {
        method: 'POST',
        headers: { Authorization: `Bearer ${identity.playerToken}` },
        body: JSON.stringify({
          playerId: identity.playerId,
          inviteCode: inviteCode.trim().toUpperCase(),
        }),
      });
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Invalid or closed tournament invite code.',
        };
      }
      void import('./EconomyClient').then(({ economyClient }) => economyClient.refreshWallet());
      await Promise.all([
        this.fetchTournaments(),
        this.fetchTournamentDetail(json.tournament.tournamentId),
      ]);
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error joining tournament by code.' };
    }
  }

  public async register(
    tournamentId: string,
    inviteCode?: string,
  ): Promise<
    ApiResult<{
      tournament: TournamentRecord;
      participant: TournamentParticipant;
      autoStarted?: boolean;
    }>
  > {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Competitive player session unavailable.' };
    }
    try {
      const { ok, json } = await this.requestJson<{
        tournament: TournamentRecord;
        participant: TournamentParticipant;
        autoStarted?: boolean;
      }>(`/api/tournaments/${encodeURIComponent(tournamentId)}/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${identity.playerToken}` },
        body: JSON.stringify({
          playerId: identity.playerId,
          inviteCode: inviteCode?.trim() || undefined,
        }),
      });
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Registration failed.',
        };
      }
      void import('./EconomyClient').then(({ economyClient }) => economyClient.refreshWallet());
      await Promise.all([
        this.fetchTournaments(),
        this.fetchTournamentDetail(tournamentId),
      ]);
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error registering for tournament.' };
    }
  }

  public async withdraw(
    tournamentId: string,
  ): Promise<ApiResult<{ tournament: TournamentRecord; refundedCoins: number }>> {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Competitive player session unavailable.' };
    }
    try {
      const { ok, json } = await this.requestJson<{
        tournament: TournamentRecord;
        refundedCoins: number;
      }>(`/api/tournaments/${encodeURIComponent(tournamentId)}/withdraw`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${identity.playerToken}` },
        body: JSON.stringify({
          playerId: identity.playerId,
        }),
      });
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Withdrawal failed.',
        };
      }
      void import('./EconomyClient').then(({ economyClient }) => economyClient.refreshWallet());
      await Promise.all([
        this.fetchTournaments(),
        this.fetchTournamentDetail(tournamentId),
      ]);
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error withdrawing from tournament.' };
    }
  }

  public async startTournament(
    tournamentId: string,
  ): Promise<ApiResult<{ tournament: TournamentRecord; cancelledInsufficient?: boolean }>> {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Competitive player session unavailable.' };
    }
    try {
      const { ok, json } = await this.requestJson<{
        tournament: TournamentRecord;
        cancelledInsufficient?: boolean;
      }>(`/api/tournaments/${encodeURIComponent(tournamentId)}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${identity.playerToken}` },
        body: JSON.stringify({
          playerId: identity.playerId,
        }),
      });
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to start tournament.',
        };
      }
      await Promise.all([
        this.fetchTournaments(),
        this.fetchTournamentDetail(tournamentId),
      ]);
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error starting tournament.' };
    }
  }

  public async cancelTournament(
    tournamentId: string,
    reason?: string,
  ): Promise<ApiResult<{ tournament: TournamentRecord; refundedCount: number }>> {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Competitive player session unavailable.' };
    }
    try {
      const { ok, json } = await this.requestJson<{
        tournament: TournamentRecord;
        refundedCount: number;
      }>(`/api/tournaments/${encodeURIComponent(tournamentId)}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${identity.playerToken}` },
        body: JSON.stringify({
          playerId: identity.playerId,
          reason,
        }),
      });
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to cancel tournament.',
        };
      }
      void import('./EconomyClient').then(({ economyClient }) => economyClient.refreshWallet());
      await Promise.all([
        this.fetchTournaments(),
        this.fetchTournamentDetail(tournamentId),
      ]);
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error cancelling tournament.' };
    }
  }

  public async joinMatch(
    tournamentId: string,
    bracketMatchId: string,
    preferredSessionId?: string | null,
  ): Promise<ApiResult<JoinTournamentMatchResult>> {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Competitive player session unavailable.' };
    }
    try {
      const { ok, json } = await this.requestJson<JoinTournamentMatchResult>(
        `/api/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(bracketMatchId)}/join`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${identity.playerToken}` },
          body: JSON.stringify({
            playerId: identity.playerId,
            sessionId: preferredSessionId ?? undefined,
          }),
        },
      );
      if (!ok || !json.room || !json.roomSession) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to join tournament match room.',
        };
      }
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error entering tournament match room.' };
    }
  }

  // ===== Server-Verified Admin Operations (operator secret passed at runtime only) =====

  public async adminCreateTournament(
    adminKey: string,
    input: Partial<CreateTournamentInput>,
  ): Promise<ApiResult<{ tournament: TournamentRecord }>> {
    try {
      const { ok, json } = await this.requestJson<{ tournament: TournamentRecord }>(
        '/api/admin/tournaments',
        {
          method: 'POST',
          headers: { 'X-Admin-Key': adminKey.trim() },
          body: JSON.stringify(input),
        },
      );
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Admin verification failed or invalid tournament config.',
        };
      }
      await this.fetchTournaments({ adminKey });
      return { ok: true, data: { tournament: json.tournament } };
    } catch {
      return { ok: false, error: 'Network error creating admin tournament.' };
    }
  }

  public async adminStartTournament(
    adminKey: string,
    tournamentId: string,
  ): Promise<ApiResult<{ tournament: TournamentRecord; cancelledInsufficient?: boolean }>> {
    try {
      const { ok, json } = await this.requestJson<{
        tournament: TournamentRecord;
        cancelledInsufficient?: boolean;
      }>(`/api/admin/tournaments/${encodeURIComponent(tournamentId)}/start`, {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey.trim() },
      });
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to start tournament as admin.',
        };
      }
      await Promise.all([
        this.fetchTournaments({ adminKey }),
        this.fetchTournamentDetail(tournamentId, adminKey),
      ]);
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error starting tournament.' };
    }
  }

  public async adminCancelTournament(
    adminKey: string,
    tournamentId: string,
    reason?: string,
  ): Promise<ApiResult<{ tournament: TournamentRecord; refundedCount: number }>> {
    try {
      const { ok, json } = await this.requestJson<{
        tournament: TournamentRecord;
        refundedCount: number;
      }>(`/api/admin/tournaments/${encodeURIComponent(tournamentId)}/cancel`, {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey.trim() },
        body: JSON.stringify({ reason }),
      });
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to cancel tournament as admin.',
        };
      }
      await Promise.all([
        this.fetchTournaments({ adminKey }),
        this.fetchTournamentDetail(tournamentId, adminKey),
      ]);
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error cancelling tournament.' };
    }
  }

  public async adminResolveMatch(
    adminKey: string,
    tournamentId: string,
    bracketMatchId: string,
    input: {
      winnerId: string;
      resolutionType?: TournamentMatchResolutionType;
      reason?: string;
    },
  ): Promise<ApiResult<{ tournament: TournamentRecord; resolvedMatch: TournamentMatch }>> {
    try {
      const { ok, json } = await this.requestJson<{
        tournament: TournamentRecord;
        resolvedMatch: TournamentMatch;
      }>(
        `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(bracketMatchId)}/resolve`,
        {
          method: 'POST',
          headers: { 'X-Admin-Key': adminKey.trim() },
          body: JSON.stringify(input),
        },
      );
      if (!ok || !json.tournament) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to resolve bracket match.',
        };
      }
      await Promise.all([
        this.fetchTournaments({ adminKey }),
        this.fetchTournamentDetail(tournamentId, adminKey),
      ]);
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error resolving match.' };
    }
  }

  public async adminProcessTimers(
    adminKey: string,
    tournamentId: string,
  ): Promise<ApiResult<{ ok: true }>> {
    try {
      const { ok, json } = await this.requestJson<{ ok: true }>(
        `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/process-timers`,
        {
          method: 'POST',
          headers: { 'X-Admin-Key': adminKey.trim() },
        },
      );
      if (!ok) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Failed to process tournament timers.',
        };
      }
      await Promise.all([
        this.fetchTournaments({ adminKey }),
        this.fetchTournamentDetail(tournamentId, adminKey),
      ]);
      return { ok: true, data: { ok: true } };
    } catch {
      return { ok: false, error: 'Network error processing timers.' };
    }
  }
}

export const tournamentClient = new TournamentClientImpl();
