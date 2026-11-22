import type { RuleProfileId } from '../game/rules/types';
import { getStoredPlayerIdentity, progressionClient, resolveProgressionApiBase } from './ProgressionClient';
import type { OnlineRoomInfo } from './shared/protocol';
import type {
  ClubChampionshipDetailPayload,
  ClubChampionshipFormat,
  ClubChampionshipRecord,
  ClubTeamRecord,
  LeagueCadence,
  LeagueScope,
  TeamEloHistoryEntry,
  TeamEloRankingsPayload,
  TeamLeagueDetailPayload,
  TeamLeagueRecord,
  TeamMatchFormat,
  TeamRosterRole,
  TeamSubMatchRecord,
} from './shared/clubLeagues';
import type { ClubEmblemIcon } from './shared/social';
import { useGameStore } from '../store/useGameStore';

export interface ClubLeagueApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

class ClubLeagueClientImpl {
  private getApiBase(): string {
    return resolveProgressionApiBase();
  }

  private async ensureCredentials(): Promise<{ playerId: string; playerToken: string } | null> {
    let creds = getStoredPlayerIdentity();
    if (!creds) {
      await progressionClient.ensurePlayerSession();
      creds = getStoredPlayerIdentity();
    }
    return creds ? { playerId: creds.playerId, playerToken: creds.playerToken } : null;
  }

  private async requestJson<T>(
    path: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; json: T & { error?: string; message?: string } }> {
    const res = await fetch(`${this.getApiBase()}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    const json = (await res.json()) as T & { error?: string; message?: string };
    return { ok: res.ok, status: res.status, json };
  }

  // ===== Teams & Rosters =====

  public async listClubTeams(clubId: string): Promise<ClubTeamRecord[]> {
    try {
      const { ok, json } = await this.requestJson<{ teams: ClubTeamRecord[] }>(
        `/api/clubs/${encodeURIComponent(clubId)}/teams`,
      );
      const teams = ok && Array.isArray(json.teams) ? json.teams : [];
      useGameStore.getState().setClubTeams(teams);
      return teams;
    } catch {
      return [];
    }
  }

  public async getTeamDetail(
    teamId: string,
  ): Promise<ClubLeagueApiResult<{ team: ClubTeamRecord; eloHistory: TeamEloHistoryEntry[] }>> {
    try {
      const { ok, json } = await this.requestJson<{
        team: ClubTeamRecord;
        eloHistory: TeamEloHistoryEntry[];
      }>(`/api/teams/${encodeURIComponent(teamId)}`);
      if (!ok || !json.team) {
        return { ok: false, code: json.error, error: json.message ?? 'Team not found.' };
      }
      return { ok: true, data: { team: json.team, eloHistory: json.eloHistory ?? [] } };
    } catch {
      return { ok: false, error: 'Network error loading team detail.' };
    }
  }

  public async createTeam(
    clubId: string,
    input: {
      name: string;
      tag: string;
      badgeColor?: string;
      badgeIcon?: ClubEmblemIcon;
      region?: string;
      minRosterSize?: number;
      maxRosterSize?: number;
      captainId?: string;
      memberIds?: string[];
    },
  ): Promise<ClubLeagueApiResult<ClubTeamRecord>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ team: ClubTeamRecord }>(
        `/api/clubs/${encodeURIComponent(clubId)}/teams`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, ...input }),
        },
      );
      if (!ok || !json.team) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to create team.' };
      }
      await this.listClubTeams(clubId);
      return { ok: true, data: json.team };
    } catch {
      return { ok: false, error: 'Network error creating team.' };
    }
  }

  public async addTeamMember(
    teamId: string,
    targetPlayerId: string,
    role: TeamRosterRole = 'starter',
  ): Promise<ClubLeagueApiResult<ClubTeamRecord>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ team: ClubTeamRecord }>(
        `/api/teams/${encodeURIComponent(teamId)}/members`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId, role }),
        },
      );
      if (!ok || !json.team) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to add roster member.',
        };
      }
      await this.listClubTeams(json.team.clubId);
      return { ok: true, data: json.team };
    } catch {
      return { ok: false, error: 'Network error updating roster.' };
    }
  }

  public async removeTeamMember(
    teamId: string,
    targetPlayerId: string,
  ): Promise<ClubLeagueApiResult<ClubTeamRecord>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ team: ClubTeamRecord }>(
        `/api/teams/${encodeURIComponent(teamId)}/members/remove`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId }),
        },
      );
      if (!ok || !json.team) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to remove roster member.',
        };
      }
      await this.listClubTeams(json.team.clubId);
      return { ok: true, data: json.team };
    } catch {
      return { ok: false, error: 'Network error removing roster member.' };
    }
  }

  public async setTeamMemberRole(
    teamId: string,
    targetPlayerId: string,
    role: TeamRosterRole,
  ): Promise<ClubLeagueApiResult<ClubTeamRecord>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ team: ClubTeamRecord }>(
        `/api/teams/${encodeURIComponent(teamId)}/members/role`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, targetPlayerId, role }),
        },
      );
      if (!ok || !json.team) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to update team role.',
        };
      }
      await this.listClubTeams(json.team.clubId);
      return { ok: true, data: json.team };
    } catch {
      return { ok: false, error: 'Network error updating team role.' };
    }
  }

  // ===== Team Leagues =====

  public async listLeagues(opts?: {
    scope?: LeagueScope | 'all';
    region?: string;
    status?: string;
  }): Promise<TeamLeagueRecord[]> {
    try {
      const qs = new URLSearchParams();
      if (opts?.scope && opts.scope !== 'all') qs.set('scope', opts.scope);
      if (opts?.region && opts.region !== 'ALL') qs.set('region', opts.region);
      if (opts?.status && opts.status !== 'all') qs.set('status', opts.status);
      const qStr = qs.toString();
      const { ok, json } = await this.requestJson<{ leagues: TeamLeagueRecord[] }>(
        `/api/team-leagues${qStr ? `?${qStr}` : ''}`,
      );
      const leagues = ok && Array.isArray(json.leagues) ? json.leagues : [];
      useGameStore.getState().setTeamLeagues(leagues);
      return leagues;
    } catch {
      return [];
    }
  }

  public async getLeagueDetail(
    leagueId: string,
  ): Promise<ClubLeagueApiResult<TeamLeagueDetailPayload>> {
    try {
      const creds = getStoredPlayerIdentity();
      const qs = creds?.playerId ? `?playerId=${encodeURIComponent(creds.playerId)}` : '';
      const { ok, json } = await this.requestJson<{ detail: TeamLeagueDetailPayload }>(
        `/api/team-leagues/${encodeURIComponent(leagueId)}${qs}`,
      );
      if (!ok || !json.detail) {
        return { ok: false, code: json.error, error: json.message ?? 'Team league not found.' };
      }
      useGameStore.getState().setSelectedLeagueDetail(json.detail);
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error loading team league.' };
    }
  }

  public async createLeague(input: {
    title: string;
    description?: string;
    scope: LeagueScope;
    region?: string;
    cadence: LeagueCadence;
    divisionTier?: number;
    seasonLabel?: string;
    matchFormat: TeamMatchFormat;
    ruleProfileId?: RuleProfileId;
    calledShotsEnabled?: boolean;
    doubleRoundRobin?: boolean;
    maxTeams?: number;
    promotionSlots?: number;
    relegationSlots?: number;
    matchDurationMinutes?: number;
  }): Promise<ClubLeagueApiResult<TeamLeagueDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: TeamLeagueDetailPayload }>(
        '/api/team-leagues',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, ...input }),
        },
      );
      if (!ok || !json.detail) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to create league.' };
      }
      useGameStore.getState().setSelectedLeagueDetail(json.detail);
      void this.listLeagues();
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error creating league.' };
    }
  }

  public async registerTeamForLeague(
    leagueId: string,
    teamId: string,
  ): Promise<ClubLeagueApiResult<TeamLeagueDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: TeamLeagueDetailPayload }>(
        `/api/team-leagues/${encodeURIComponent(leagueId)}/register`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, teamId }),
        },
      );
      if (!ok || !json.detail) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to register team for league.',
        };
      }
      useGameStore.getState().setSelectedLeagueDetail(json.detail);
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error registering for league.' };
    }
  }

  public async withdrawTeamFromLeague(
    leagueId: string,
    teamId: string,
  ): Promise<ClubLeagueApiResult<TeamLeagueDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: TeamLeagueDetailPayload }>(
        `/api/team-leagues/${encodeURIComponent(leagueId)}/withdraw`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, teamId }),
        },
      );
      if (!ok || !json.detail) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to withdraw team from league.',
        };
      }
      useGameStore.getState().setSelectedLeagueDetail(json.detail);
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error withdrawing team.' };
    }
  }

  public async startLeague(leagueId: string): Promise<ClubLeagueApiResult<TeamLeagueDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: TeamLeagueDetailPayload }>(
        `/api/team-leagues/${encodeURIComponent(leagueId)}/start`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId }),
        },
      );
      if (!ok || !json.detail) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to start league.' };
      }
      useGameStore.getState().setSelectedLeagueDetail(json.detail);
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error starting league.' };
    }
  }

  public async resolveLeagueEncounter(
    leagueId: string,
    encounterId: string,
    winnerTeamId: string,
    resolution: 'walkover' | 'disqualified',
    reason?: string,
  ): Promise<ClubLeagueApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<Record<string, unknown>>(
        `/api/team-leagues/${encodeURIComponent(leagueId)}/resolve`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({
            playerId: creds.playerId,
            encounterId,
            winnerTeamId,
            resolution,
            reason,
          }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to resolve fixture.' };
      }
      await this.getLeagueDetail(leagueId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error resolving fixture.' };
    }
  }

  // ===== Club Championships =====

  public async listChampionships(opts?: {
    format?: ClubChampionshipFormat | 'all';
    region?: string;
    status?: string;
  }): Promise<ClubChampionshipRecord[]> {
    try {
      const qs = new URLSearchParams();
      if (opts?.format && opts.format !== 'all') qs.set('format', opts.format);
      if (opts?.region && opts.region !== 'ALL') qs.set('region', opts.region);
      if (opts?.status && opts.status !== 'all') qs.set('status', opts.status);
      const qStr = qs.toString();
      const { ok, json } = await this.requestJson<{ championships: ClubChampionshipRecord[] }>(
        `/api/club-championships${qStr ? `?${qStr}` : ''}`,
      );
      const championships = ok && Array.isArray(json.championships) ? json.championships : [];
      useGameStore.getState().setClubChampionships(championships);
      return championships;
    } catch {
      return [];
    }
  }

  public async getChampionshipDetail(
    championshipId: string,
  ): Promise<ClubLeagueApiResult<ClubChampionshipDetailPayload>> {
    try {
      const creds = getStoredPlayerIdentity();
      const qs = creds?.playerId ? `?playerId=${encodeURIComponent(creds.playerId)}` : '';
      const { ok, json } = await this.requestJson<{ detail: ClubChampionshipDetailPayload }>(
        `/api/club-championships/${encodeURIComponent(championshipId)}${qs}`,
      );
      if (!ok || !json.detail) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Club championship not found.',
        };
      }
      useGameStore.getState().setSelectedChampionshipDetail(json.detail);
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error loading club championship.' };
    }
  }

  public async createChampionship(input: {
    title: string;
    description?: string;
    format: ClubChampionshipFormat;
    region?: string;
    seasonLabel?: string;
    matchFormat: TeamMatchFormat;
    ruleProfileId?: RuleProfileId;
    calledShotsEnabled?: boolean;
    maxTeams?: number;
    swissRounds?: number;
    groupSize?: number;
    groupAdvanceCount?: number;
    prizeCoinsChampion?: number;
  }): Promise<ClubLeagueApiResult<ClubChampionshipDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: ClubChampionshipDetailPayload }>(
        '/api/club-championships',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, ...input }),
        },
      );
      if (!ok || !json.detail) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to create championship.',
        };
      }
      useGameStore.getState().setSelectedChampionshipDetail(json.detail);
      void this.listChampionships();
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error creating championship.' };
    }
  }

  public async registerTeamForChampionship(
    championshipId: string,
    teamId: string,
  ): Promise<ClubLeagueApiResult<ClubChampionshipDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: ClubChampionshipDetailPayload }>(
        `/api/club-championships/${encodeURIComponent(championshipId)}/register`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, teamId }),
        },
      );
      if (!ok || !json.detail) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to register team for championship.',
        };
      }
      useGameStore.getState().setSelectedChampionshipDetail(json.detail);
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error registering for championship.' };
    }
  }

  public async withdrawTeamFromChampionship(
    championshipId: string,
    teamId: string,
  ): Promise<ClubLeagueApiResult<ClubChampionshipDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: ClubChampionshipDetailPayload }>(
        `/api/club-championships/${encodeURIComponent(championshipId)}/withdraw`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, teamId }),
        },
      );
      if (!ok || !json.detail) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to withdraw team.',
        };
      }
      useGameStore.getState().setSelectedChampionshipDetail(json.detail);
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error withdrawing team.' };
    }
  }

  public async startChampionship(
    championshipId: string,
  ): Promise<ClubLeagueApiResult<ClubChampionshipDetailPayload>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ detail: ClubChampionshipDetailPayload }>(
        `/api/club-championships/${encodeURIComponent(championshipId)}/start`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId }),
        },
      );
      if (!ok || !json.detail) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to start championship.',
        };
      }
      useGameStore.getState().setSelectedChampionshipDetail(json.detail);
      return { ok: true, data: json.detail };
    } catch {
      return { ok: false, error: 'Network error starting championship.' };
    }
  }

  public async resolveChampionshipEncounter(
    championshipId: string,
    encounterId: string,
    winnerTeamId: string,
    resolution: 'walkover' | 'disqualified',
    reason?: string,
  ): Promise<ClubLeagueApiResult<void>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<Record<string, unknown>>(
        `/api/club-championships/${encodeURIComponent(championshipId)}/resolve`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({
            playerId: creds.playerId,
            encounterId,
            winnerTeamId,
            resolution,
            reason,
          }),
        },
      );
      if (!ok) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to resolve championship match.',
        };
      }
      await this.getChampionshipDetail(championshipId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error resolving championship match.' };
    }
  }

  // ===== Lineups, Substitutions & Sub-Match Joining =====

  public async submitEncounterLineup(params: {
    competitionKind: 'league' | 'club_championship';
    competitionId: string;
    encounterId: string;
    teamId: string;
    playerIds: string[];
  }): Promise<ClubLeagueApiResult<TeamSubMatchRecord[]>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ subMatches: TeamSubMatchRecord[] }>(
        '/api/club-competitions/lineup',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, ...params }),
        },
      );
      if (!ok) {
        return { ok: false, code: json.error, error: json.message ?? 'Unable to submit lineup.' };
      }
      if (params.competitionKind === 'league') {
        await this.getLeagueDetail(params.competitionId);
      } else {
        await this.getChampionshipDetail(params.competitionId);
      }
      return { ok: true, data: json.subMatches ?? [] };
    } catch {
      return { ok: false, error: 'Network error submitting lineup.' };
    }
  }

  public async substituteLineupSlot(params: {
    subMatchId: string;
    teamId: string;
    newPlayerId: string;
  }): Promise<ClubLeagueApiResult<TeamSubMatchRecord>> {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{ subMatch: TeamSubMatchRecord }>(
        '/api/club-competitions/substitute',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.playerToken}` },
          body: JSON.stringify({ playerId: creds.playerId, ...params }),
        },
      );
      if (!ok || !json.subMatch) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to substitute player.',
        };
      }
      if (json.subMatch.competitionKind === 'league') {
        await this.getLeagueDetail(json.subMatch.competitionId);
      } else {
        await this.getChampionshipDetail(json.subMatch.competitionId);
      }
      return { ok: true, data: json.subMatch };
    } catch {
      return { ok: false, error: 'Network error making substitution.' };
    }
  }

  public async joinSubMatch(
    subMatchId: string,
    sessionId?: string | null,
  ): Promise<
    ClubLeagueApiResult<{
      subMatch: TeamSubMatchRecord;
      room: OnlineRoomInfo;
      roomSession: { sessionId: string; reconnectToken: string };
    }>
  > {
    const creds = await this.ensureCredentials();
    if (!creds) return { ok: false, error: 'Player session not initialized.' };
    try {
      const { ok, json } = await this.requestJson<{
        subMatch: TeamSubMatchRecord;
        room: OnlineRoomInfo;
        roomSession: { sessionId: string; reconnectToken: string };
      }>('/api/club-competitions/submatches/join', {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.playerToken}` },
        body: JSON.stringify({ playerId: creds.playerId, subMatchId, sessionId }),
      });
      if (!ok || !json.room || !json.roomSession) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to enter board room.',
        };
      }
      return {
        ok: true,
        data: { subMatch: json.subMatch, room: json.room, roomSession: json.roomSession },
      };
    } catch {
      return { ok: false, error: 'Network error entering board room.' };
    }
  }

  // ===== Rankings & Honors =====

  public async fetchRankings(region = 'ALL', limit = 30): Promise<TeamEloRankingsPayload | null> {
    try {
      const qs = new URLSearchParams({ region, limit: String(limit) });
      const { ok, json } = await this.requestJson<TeamEloRankingsPayload>(
        `/api/rankings/clubs-teams?${qs.toString()}`,
      );
      if (!ok) return null;
      const payload: TeamEloRankingsPayload = {
        region: json.region ?? region,
        teams: Array.isArray(json.teams) ? json.teams : [],
        trophies: Array.isArray(json.trophies) ? json.trophies : [],
      };
      useGameStore.getState().setTeamEloRankings(payload);
      return payload;
    } catch {
      return null;
    }
  }
}

export const clubLeagueClient = new ClubLeagueClientImpl();
