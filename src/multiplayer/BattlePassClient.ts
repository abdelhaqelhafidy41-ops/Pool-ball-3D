import {
  type AiMatchProgressRequest,
  type AiMatchProgressResponse,
  type BattlePassOverview,
  type BattlePassTrack,
  type ClaimRewardResponse,
  type MissionCadence,
  type UnlockPremiumResponse,
} from './shared/battlePass';
import { COSMETIC_CATALOG_MAP } from './shared/economy';
import {
  getStoredPlayerIdentity,
  progressionClient,
  resolveProgressionApiBase,
  type ApiResult,
} from './ProgressionClient';
import { economyClient } from './EconomyClient';
import { useGameStore } from '../store/useGameStore';

class BattlePassClientImpl {
  private inflightOverview: Promise<BattlePassOverview | null> | null = null;
  private inflightClaim: Promise<ApiResult<ClaimRewardResponse>> | null = null;
  private inflightUnlock: Promise<ApiResult<UnlockPremiumResponse>> | null = null;
  private inflightAiRecord: Promise<ApiResult<AiMatchProgressResponse>> | null = null;
  private serverTimeOffsetMs = 0;
  private announcedEndingSoonSeasonId: string | null = null;

  private updateServerClock(serverNowMs: number | undefined | null) {
    if (typeof serverNowMs === 'number' && Number.isFinite(serverNowMs) && serverNowMs > 0) {
      this.serverTimeOffsetMs = serverNowMs - Date.now();
    }
  }

  public getTrustedNowMs(): number {
    return Date.now() + this.serverTimeOffsetMs;
  }

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

  private applyOverviewAndDetectNotifications(
    next: BattlePassOverview,
    options?: { skipTransitionToasts?: boolean },
  ): BattlePassOverview {
    this.updateServerClock(next.serverNowMs);
    const store = useGameStore.getState();
    const prev = store.battlePassOverview;
    store.setBattlePassOverview(next);

    if (!options?.skipTransitionToasts && prev) {
      if (prev.season.seasonId !== next.season.seasonId) {
        store.pushProgressionNotification({
          kind: 'season_started',
          title: `${next.season.name} Started`,
          detail: `${next.season.maxLevel} seasonal Battle Pass tiers are now live.`,
        });
      }

      if (next.playerState.seasonLevel > prev.playerState.seasonLevel) {
        store.pushProgressionNotification({
          kind: 'tier_unlocked',
          title: `Battle Pass Tier ${next.playerState.seasonLevel} Unlocked`,
          detail: `Earn more Season XP or claim your unlocked rewards.`,
        });
      }

      const prevDailyMap = new Map(prev.dailyMissions.map((m) => [m.missionId, m]));
      for (const m of next.dailyMissions) {
        const old = prevDailyMap.get(m.missionId);
        if (m.completed && old && !old.completed) {
          store.pushProgressionNotification({
            kind: 'mission_completed',
            title: `Daily Mission Complete: ${m.title}`,
            detail: `+${m.rewardCoins} POOL COINS · +${m.rewardSeasonXp} Season XP ready to claim.`,
          });
        }
      }

      const prevWeeklyMap = new Map(prev.weeklyChallenges.map((m) => [m.missionId, m]));
      for (const w of next.weeklyChallenges) {
        const old = prevWeeklyMap.get(w.missionId);
        if (w.completed && old && !old.completed) {
          store.pushProgressionNotification({
            kind: 'weekly_completed',
            title: `Weekly Challenge Complete: ${w.title}`,
            detail: `+${w.rewardCoins} POOL COINS · +${w.rewardSeasonXp} Season XP ready to claim.`,
          });
        }
      }
    }

    const msRemaining = next.season.endsAtMs - next.serverNowMs;
    if (
      msRemaining > 0 &&
      msRemaining <= 48 * 3_600_000 &&
      this.announcedEndingSoonSeasonId !== next.season.seasonId
    ) {
      this.announcedEndingSoonSeasonId = next.season.seasonId;
      store.pushProgressionNotification({
        kind: 'season_ending_soon',
        title: `${next.season.name} Ending Soon`,
        detail: 'Claim any remaining Battle Pass rewards before rollover.',
      });
    }

    return next;
  }

  public async refreshOverview(options?: {
    skipTransitionToasts?: boolean;
  }): Promise<BattlePassOverview | null> {
    if (this.inflightOverview) return this.inflightOverview;

    const run = async (): Promise<BattlePassOverview | null> => {
      const identity = await this.ensureIdentity();
      if (!identity) return null;

      try {
        const { ok, json } = await this.requestJson<{ overview?: BattlePassOverview }>(
          `/api/battle-pass/overview?playerId=${encodeURIComponent(identity.playerId)}`,
          {
            headers: { Authorization: `Bearer ${identity.playerToken}` },
          },
        );
        if (!ok || !json.overview) return null;
        return this.applyOverviewAndDetectNotifications(json.overview, options);
      } catch {
        return null;
      }
    };

    this.inflightOverview = run().finally(() => {
      this.inflightOverview = null;
    });
    return this.inflightOverview;
  }

  public async claimMission(
    missionId: string,
    cadence?: MissionCadence,
    periodKey?: string,
  ): Promise<ApiResult<ClaimRewardResponse>> {
    if (this.inflightClaim) return this.inflightClaim;

    const run = async (): Promise<ApiResult<ClaimRewardResponse>> => {
      const identity = await this.ensureIdentity();
      if (!identity) return { ok: false, error: 'Player session not initialized.' };

      try {
        const { ok, json } = await this.requestJson<ClaimRewardResponse>(
          '/api/battle-pass/missions/claim',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${identity.playerToken}` },
            body: JSON.stringify({
              playerId: identity.playerId,
              missionId,
              cadence,
              periodKey,
            }),
          },
        );
        if (!ok || !json.overview) {
          return {
            ok: false,
            error: json.message ?? 'Could not claim mission reward.',
            code: json.error,
          };
        }

        this.applyOverviewAndDetectNotifications(json.overview);
        const store = useGameStore.getState();
        store.applyEconomySnapshot({
          wallet: json.wallet,
          inventoryIds: json.inventoryIds,
          equipped: json.equipped,
        });
        if (!json.alreadyClaimed) {
          store.pushProgressionNotification({
            kind: 'reward_claimed',
            title: 'Mission Reward Claimed',
            detail: `+${json.coinsAwarded} POOL COINS · +${json.seasonXpAwarded} Season XP added.`,
          });
        }
        return { ok: true, data: json };
      } catch {
        return { ok: false, error: 'Network error while claiming mission reward.' };
      }
    };

    this.inflightClaim = run().finally(() => {
      this.inflightClaim = null;
    });
    return this.inflightClaim;
  }

  public async unlockPremium(): Promise<ApiResult<UnlockPremiumResponse>> {
    if (this.inflightUnlock) return this.inflightUnlock;

    const run = async (): Promise<ApiResult<UnlockPremiumResponse>> => {
      const identity = await this.ensureIdentity();
      if (!identity) return { ok: false, error: 'Player session not initialized.' };

      try {
        const { ok, json } = await this.requestJson<UnlockPremiumResponse>(
          '/api/battle-pass/premium/unlock',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${identity.playerToken}` },
            body: JSON.stringify({
              playerId: identity.playerId,
            }),
          },
        );
        if (!ok || !json.overview) {
          return {
            ok: false,
            error: json.message ?? 'Unable to unlock Premium Battle Pass.',
            code: json.error,
          };
        }

        this.applyOverviewAndDetectNotifications(json.overview);
        const store = useGameStore.getState();
        store.applyEconomySnapshot({ wallet: json.wallet });
        if (!json.alreadyUnlocked) {
          store.pushProgressionNotification({
            kind: 'reward_claimed',
            title: 'Premium Battle Pass Activated',
            detail: `${json.overview.season.name} Premium Track rewards are now unlocked.`,
          });
        }
        void economyClient.refreshWallet();
        return { ok: true, data: json };
      } catch {
        return { ok: false, error: 'Network error while unlocking Premium Pass.' };
      }
    };

    this.inflightUnlock = run().finally(() => {
      this.inflightUnlock = null;
    });
    return this.inflightUnlock;
  }

  public async claimTierReward(
    level: number,
    track: BattlePassTrack,
  ): Promise<ApiResult<ClaimRewardResponse>> {
    if (this.inflightClaim) return this.inflightClaim;

    const run = async (): Promise<ApiResult<ClaimRewardResponse>> => {
      const identity = await this.ensureIdentity();
      if (!identity) return { ok: false, error: 'Player session not initialized.' };

      try {
        const { ok, json } = await this.requestJson<ClaimRewardResponse>(
          '/api/battle-pass/tiers/claim',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${identity.playerToken}` },
            body: JSON.stringify({
              playerId: identity.playerId,
              level,
              track,
            }),
          },
        );
        if (!ok || !json.overview) {
          return {
            ok: false,
            error: json.message ?? 'Could not claim Battle Pass reward.',
            code: json.error,
          };
        }

        this.applyOverviewAndDetectNotifications(json.overview);
        const store = useGameStore.getState();
        store.applyEconomySnapshot({
          wallet: json.wallet,
          inventoryIds: json.inventoryIds,
          equipped: json.equipped,
        });
        if (!json.alreadyClaimed) {
          const itemNames = json.grantedItemIds
            .map((id) => COSMETIC_CATALOG_MAP.get(id)?.name ?? id)
            .join(', ');
          const parts: string[] = [];
          if (json.coinsAwarded > 0) parts.push(`+${json.coinsAwarded} POOL COINS`);
          if (itemNames) parts.push(itemNames);
          store.pushProgressionNotification({
            kind: 'reward_claimed',
            title: `Tier ${level} Reward Claimed`,
            detail: parts.join(' · ') || 'Reward added to your account.',
          });
        }
        return { ok: true, data: json };
      } catch {
        return { ok: false, error: 'Network error while claiming Battle Pass tier.' };
      }
    };

    this.inflightClaim = run().finally(() => {
      this.inflightClaim = null;
    });
    return this.inflightClaim;
  }

  public async claimAllAvailable(): Promise<ApiResult<ClaimRewardResponse>> {
    if (this.inflightClaim) return this.inflightClaim;

    const run = async (): Promise<ApiResult<ClaimRewardResponse>> => {
      const identity = await this.ensureIdentity();
      if (!identity) return { ok: false, error: 'Player session not initialized.' };

      try {
        const { ok, json } = await this.requestJson<ClaimRewardResponse>(
          '/api/battle-pass/claim-all',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${identity.playerToken}` },
            body: JSON.stringify({
              playerId: identity.playerId,
            }),
          },
        );
        if (!ok || !json.overview) {
          return {
            ok: false,
            error: json.message ?? 'Could not claim pending rewards.',
            code: json.error,
          };
        }

        this.applyOverviewAndDetectNotifications(json.overview);
        const store = useGameStore.getState();
        store.applyEconomySnapshot({
          wallet: json.wallet,
          inventoryIds: json.inventoryIds,
          equipped: json.equipped,
        });
        if (!json.alreadyClaimed) {
          const parts: string[] = [];
          if (json.coinsAwarded > 0) parts.push(`+${json.coinsAwarded} POOL COINS`);
          if (json.seasonXpAwarded > 0) parts.push(`+${json.seasonXpAwarded} Season XP`);
          if (json.grantedItemIds.length > 0) {
            parts.push(`${json.grantedItemIds.length} cosmetic item(s)`);
          }
          store.pushProgressionNotification({
            kind: 'reward_claimed',
            title: 'All Pending Rewards Claimed',
            detail: parts.join(' · ') || 'Account synchronized.',
          });
        }
        return { ok: true, data: json };
      } catch {
        return { ok: false, error: 'Network error while claiming all rewards.' };
      }
    };

    this.inflightClaim = run().finally(() => {
      this.inflightClaim = null;
    });
    return this.inflightClaim;
  }

  public async recordAiMatch(
    payload: AiMatchProgressRequest,
  ): Promise<ApiResult<AiMatchProgressResponse>> {
    if (this.inflightAiRecord) return this.inflightAiRecord;

    const run = async (): Promise<ApiResult<AiMatchProgressResponse>> => {
      const identity = await this.ensureIdentity();
      if (!identity) return { ok: false, error: 'Player session not initialized.' };

      try {
        const { ok, json } = await this.requestJson<AiMatchProgressResponse>(
          '/api/battle-pass/ai-match',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${identity.playerToken}` },
            body: JSON.stringify({
              playerId: identity.playerId,
              ...payload,
            }),
          },
        );
        if (!ok || !json.overview) {
          return {
            ok: false,
            error: json.message ?? 'Could not record AI match progression.',
            code: json.error,
          };
        }

        this.applyOverviewAndDetectNotifications(json.overview);
        useGameStore.getState().setLastAiBattlePassClaim(json);
        return { ok: true, data: json };
      } catch {
        return { ok: false, error: 'Network error while recording AI match progression.' };
      }
    };

    this.inflightAiRecord = run().finally(() => {
      this.inflightAiRecord = null;
    });
    return this.inflightAiRecord;
  }
}

export const battlePassClient = new BattlePassClientImpl();
