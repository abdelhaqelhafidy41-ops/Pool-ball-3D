import type {
  LeaderboardResponse,
  LeaderboardScope,
  PlayerSearchResult,
  PublicPlayerProfile,
} from './shared/progression';
import type { MatchHistoryRecord, OnlineAvatarId } from './shared/protocol';
import { resolveHttpBaseUrl } from './NetworkManager';
import { useGameStore } from '../store/useGameStore';

const IDENTITY_STORAGE_KEY = 'ultimate_pool_3d_player_identity_v1';

export interface StoredPlayerIdentity {
  playerId: string;
  playerToken: string;
}

export function getStoredPlayerIdentity(): StoredPlayerIdentity | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPlayerIdentity>;
    if (
      typeof parsed.playerId === 'string' &&
      parsed.playerId.trim().length >= 6 &&
      typeof parsed.playerToken === 'string' &&
      parsed.playerToken.trim().length >= 16
    ) {
      return {
        playerId: parsed.playerId.trim(),
        playerToken: parsed.playerToken.trim(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveStoredPlayerIdentity(identity: StoredPlayerIdentity): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
    }
  } catch {
    // Ignore storage errors
  }
}

export function clearStoredPlayerIdentity(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(IDENTITY_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function resolveProgressionApiBase(): string {
  const loc = typeof window !== 'undefined' ? window.location : undefined;
  return resolveHttpBaseUrl(import.meta.env.VITE_WS_URL, loc);
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

class ProgressionClientImpl {
  private inflightSessionPromise: Promise<PublicPlayerProfile | null> | null = null;

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

  public async ensurePlayerSession(options?: {
    displayName?: string;
    avatarId?: OnlineAvatarId;
    forceNewGuest?: boolean;
  }): Promise<PublicPlayerProfile | null> {
    if (!options?.forceNewGuest && this.inflightSessionPromise) {
      return this.inflightSessionPromise;
    }

    const runner = async (): Promise<PublicPlayerProfile | null> => {
      try {
        const stored = options?.forceNewGuest ? null : getStoredPlayerIdentity();
        const store = useGameStore.getState();
        const desiredName = options?.displayName ?? store.onlineProfile.displayName;
        const desiredAvatar = options?.avatarId ?? store.onlineProfile.avatarId;

        const { ok, json } = await this.requestJson<{
          playerId: string;
          playerToken: string;
          profile: PublicPlayerProfile;
        }>('/api/players/session', {
          method: 'POST',
          headers: stored ? { Authorization: `Bearer ${stored.playerToken}` } : undefined,
          body: JSON.stringify({
            playerId: stored?.playerId ?? undefined,
            displayName: desiredName,
            avatarId: desiredAvatar,
            forceNewGuest: Boolean(options?.forceNewGuest),
          }),
        });

        if (!ok || !json.playerId || !json.playerToken || !json.profile) {
          return null;
        }

        saveStoredPlayerIdentity({
          playerId: json.playerId,
          playerToken: json.playerToken,
        });
        useGameStore.getState().setOwnProfile(json.profile);
        useGameStore.getState().setOnlineProfile({
          displayName: json.profile.displayName,
          avatarId: json.profile.avatarId as OnlineAvatarId,
        });
        return json.profile;
      } catch {
        return null;
      }
    };

    if (options?.forceNewGuest) {
      return runner();
    }

    this.inflightSessionPromise = runner().finally(() => {
      this.inflightSessionPromise = null;
    });
    return this.inflightSessionPromise;
  }

  public async refreshOwnProfile(): Promise<PublicPlayerProfile | null> {
    const stored = getStoredPlayerIdentity();
    if (!stored) {
      return this.ensurePlayerSession();
    }
    try {
      const { ok, json } = await this.requestJson<{ profile: PublicPlayerProfile }>(
        `/api/players/profile/${encodeURIComponent(stored.playerId)}`,
      );
      if (!ok || !json.profile) {
        return this.ensurePlayerSession();
      }
      useGameStore.getState().setOwnProfile(json.profile);
      return json.profile;
    } catch {
      return null;
    }
  }

  public async updateProfile(
    displayName: string,
    avatarId: OnlineAvatarId,
  ): Promise<ApiResult<PublicPlayerProfile>> {
    let stored = getStoredPlayerIdentity();
    if (!stored) {
      await this.ensurePlayerSession({ displayName, avatarId });
      stored = getStoredPlayerIdentity();
    }
    if (!stored) {
      return { ok: false, error: 'Unable to reach competitive profile service.' };
    }

    try {
      const { ok, json } = await this.requestJson<{ profile: PublicPlayerProfile }>(
        '/api/players/profile',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${stored.playerToken}` },
          body: JSON.stringify({
            playerId: stored.playerId,
            displayName,
            avatarId,
          }),
        },
      );
      if (!ok || !json.profile) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Failed to save profile.',
        };
      }
      useGameStore.getState().setOwnProfile(json.profile);
      useGameStore.getState().setOnlineProfile({
        displayName: json.profile.displayName,
        avatarId: json.profile.avatarId as OnlineAvatarId,
      });
      return { ok: true, data: json.profile };
    } catch {
      return { ok: false, error: 'Network error while saving profile.' };
    }
  }

  public async registerAccount(params: {
    username: string;
    password: string;
    displayName?: string;
    avatarId?: OnlineAvatarId;
  }): Promise<ApiResult<PublicPlayerProfile>> {
    let stored = getStoredPlayerIdentity();
    if (!stored) {
      await this.ensurePlayerSession({
        displayName: params.displayName,
        avatarId: params.avatarId,
      });
      stored = getStoredPlayerIdentity();
    }
    if (!stored) {
      return { ok: false, error: 'Competitive server is currently unavailable.' };
    }

    try {
      const { ok, json } = await this.requestJson<{
        playerId: string;
        playerToken: string;
        profile: PublicPlayerProfile;
      }>('/api/players/register', {
        method: 'POST',
        headers: { Authorization: `Bearer ${stored.playerToken}` },
        body: JSON.stringify({
          playerId: stored.playerId,
          username: params.username,
          password: params.password,
          displayName: params.displayName,
          avatarId: params.avatarId,
        }),
      });
      if (!ok || !json.profile || !json.playerToken) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Registration failed.',
        };
      }
      saveStoredPlayerIdentity({
        playerId: json.playerId,
        playerToken: json.playerToken,
      });
      useGameStore.getState().setOwnProfile(json.profile);
      useGameStore.getState().setOnlineProfile({
        displayName: json.profile.displayName,
        avatarId: json.profile.avatarId as OnlineAvatarId,
      });
      return { ok: true, data: json.profile };
    } catch {
      return { ok: false, error: 'Network error during registration.' };
    }
  }

  public async loginAccount(params: {
    username: string;
    password: string;
  }): Promise<ApiResult<PublicPlayerProfile>> {
    try {
      const { ok, json } = await this.requestJson<{
        playerId: string;
        playerToken: string;
        profile: PublicPlayerProfile;
      }>('/api/players/login', {
        method: 'POST',
        body: JSON.stringify({
          username: params.username,
          password: params.password,
        }),
      });
      if (!ok || !json.profile || !json.playerToken) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Invalid username or password.',
        };
      }
      saveStoredPlayerIdentity({
        playerId: json.playerId,
        playerToken: json.playerToken,
      });
      useGameStore.getState().setOwnProfile(json.profile);
      useGameStore.getState().setOnlineProfile({
        displayName: json.profile.displayName,
        avatarId: json.profile.avatarId as OnlineAvatarId,
      });
      return { ok: true, data: json.profile };
    } catch {
      return { ok: false, error: 'Network error during sign in.' };
    }
  }

  public async fetchPublicProfile(playerId: string): Promise<PublicPlayerProfile | null> {
    try {
      const { ok, json } = await this.requestJson<{ profile: PublicPlayerProfile }>(
        `/api/players/profile/${encodeURIComponent(playerId)}`,
      );
      return ok && json.profile ? json.profile : null;
    } catch {
      return null;
    }
  }

  public async searchPlayers(query: string, limit = 15): Promise<PlayerSearchResult[]> {
    try {
      const params = new URLSearchParams({
        q: query,
        limit: String(limit),
      });
      const { ok, json } = await this.requestJson<{ players: PlayerSearchResult[] }>(
        `/api/players/search?${params.toString()}`,
      );
      return ok && Array.isArray(json.players) ? json.players : [];
    } catch {
      return [];
    }
  }

  public async fetchLeaderboard(params: {
    scope: LeaderboardScope;
    page?: number;
    limit?: number;
    query?: string;
  }): Promise<LeaderboardResponse | null> {
    try {
      const stored = getStoredPlayerIdentity();
      const qs = new URLSearchParams({
        scope: params.scope,
        page: String(params.page ?? 1),
        limit: String(params.limit ?? 20),
      });
      if (params.query?.trim()) qs.set('q', params.query.trim());
      if (stored?.playerId) qs.set('playerId', stored.playerId);

      const { ok, json } = await this.requestJson<LeaderboardResponse>(
        `/api/leaderboard?${qs.toString()}`,
      );
      return ok ? json : null;
    } catch {
      return null;
    }
  }

  public async fetchMatchHistory(params?: {
    playerId?: string | null;
    limit?: number;
  }): Promise<MatchHistoryRecord[]> {
    try {
      const qs = new URLSearchParams({
        limit: String(params?.limit ?? 30),
      });
      if (params?.playerId) qs.set('playerId', params.playerId);

      const { ok, json } = await this.requestJson<{ matches: MatchHistoryRecord[] }>(
        `/api/matches/history?${qs.toString()}`,
      );
      return ok && Array.isArray(json.matches) ? json.matches : [];
    } catch {
      return [];
    }
  }
}

export const progressionClient = new ProgressionClientImpl();
