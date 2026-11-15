import {
  COSMETIC_CATALOG,
  type AiMatchRewardRequest,
  type AiMatchRewardResponse,
  type CoinTransactionRecord,
  type CosmeticCategory,
  type CosmeticItemDef,
  type DailyClaimResponse,
  type EquipCosmeticResponse,
  type PlayerCosmeticSnapshot,
  type PurchaseItemResponse,
} from './shared/economy';
import type { OnlineAvatarId } from './shared/protocol';
import {
  getStoredPlayerIdentity,
  progressionClient,
  resolveProgressionApiBase,
  type ApiResult,
} from './ProgressionClient';
import { multiplayerManager } from './MultiplayerManager';
import { useGameStore } from '../store/useGameStore';

class EconomyClientImpl {
  private inflightWallet: Promise<PlayerCosmeticSnapshot | null> | null = null;
  private catalogLoaded = false;

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

  public async fetchCatalog(): Promise<CosmeticItemDef[]> {
    if (this.catalogLoaded) {
      return useGameStore.getState().storeCatalog;
    }
    try {
      const { ok, json } = await this.requestJson<{ catalog: CosmeticItemDef[] }>(
        '/api/store/catalog',
      );
      if (ok && Array.isArray(json.catalog) && json.catalog.length > 0) {
        this.catalogLoaded = true;
        useGameStore.getState().setStoreCatalog(json.catalog);
        return json.catalog;
      }
    } catch {
      // Fallback cleanly to bundled COSMETIC_CATALOG
    }
    return COSMETIC_CATALOG;
  }

  public async refreshWallet(): Promise<PlayerCosmeticSnapshot | null> {
    if (this.inflightWallet) return this.inflightWallet;

    const run = async (): Promise<PlayerCosmeticSnapshot | null> => {
      const identity = await this.ensureIdentity();
      if (!identity) return null;

      try {
        const { ok, json } = await this.requestJson<{ snapshot: PlayerCosmeticSnapshot }>(
          `/api/economy/wallet?playerId=${encodeURIComponent(identity.playerId)}`,
          {
            headers: { Authorization: `Bearer ${identity.playerToken}` },
          },
        );
        if (!ok || !json.snapshot) return null;

        const store = useGameStore.getState();
        store.applyEconomySnapshot(json.snapshot);
        if (json.snapshot.equipped.avatarId !== store.onlineProfile.avatarId) {
          store.setOnlineProfile({
            avatarId: json.snapshot.equipped.avatarId as OnlineAvatarId,
          });
        }
        return json.snapshot;
      } catch {
        return null;
      }
    };

    this.inflightWallet = run().finally(() => {
      this.inflightWallet = null;
    });
    return this.inflightWallet;
  }

  public async fetchTransactions(limit = 40): Promise<CoinTransactionRecord[]> {
    const identity = await this.ensureIdentity();
    if (!identity) return [];

    try {
      const { ok, json } = await this.requestJson<{ transactions: CoinTransactionRecord[] }>(
        `/api/economy/transactions?playerId=${encodeURIComponent(identity.playerId)}&limit=${limit}`,
        {
          headers: { Authorization: `Bearer ${identity.playerToken}` },
        },
      );
      if (!ok || !Array.isArray(json.transactions)) return [];
      useGameStore.getState().setCoinTransactions(json.transactions);
      return json.transactions;
    } catch {
      return [];
    }
  }

  public async purchaseItem(itemId: string): Promise<ApiResult<PurchaseItemResponse>> {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Player session not initialized.' };
    }

    try {
      const { ok, json } = await this.requestJson<PurchaseItemResponse>(
        '/api/economy/purchase',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${identity.playerToken}` },
          body: JSON.stringify({
            playerId: identity.playerId,
            itemId,
          }),
        },
      );
      if (!ok || !json.wallet) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Purchase failed.',
        };
      }
      useGameStore.getState().applyEconomySnapshot({
        wallet: json.wallet,
        inventoryIds: json.inventoryIds,
        equipped: json.equipped,
      });
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error while purchasing item.' };
    }
  }

  public async equipItem(
    category: CosmeticCategory,
    itemId: string,
  ): Promise<ApiResult<EquipCosmeticResponse>> {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Player session not initialized.' };
    }

    try {
      const { ok, json } = await this.requestJson<EquipCosmeticResponse>(
        '/api/economy/equip',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${identity.playerToken}` },
          body: JSON.stringify({
            playerId: identity.playerId,
            category,
            itemId,
          }),
        },
      );
      if (!ok || !json.equipped) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Failed to equip cosmetic.',
        };
      }
      const store = useGameStore.getState();
      store.applyEconomySnapshot({ equipped: json.equipped });
      if (category === 'avatar') {
        const avatarId = json.equipped.avatarId as OnlineAvatarId;
        multiplayerManager.updateProfile(store.onlineProfile.displayName, avatarId, {
          syncProgression: false,
        });
        void progressionClient.refreshOwnProfile();
      }
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error while equipping item.' };
    }
  }

  public async claimDailyReward(): Promise<ApiResult<DailyClaimResponse>> {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Player session not initialized.' };
    }

    try {
      const { ok, json } = await this.requestJson<DailyClaimResponse>(
        '/api/economy/daily-claim',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${identity.playerToken}` },
          body: JSON.stringify({
            playerId: identity.playerId,
          }),
        },
      );
      if (!ok || !json.wallet) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Daily reward already claimed today.',
        };
      }
      useGameStore.getState().applyEconomySnapshot({
        wallet: json.wallet,
        dailyReward: json.dailyReward,
      });
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error claiming daily reward.' };
    }
  }

  public async claimAiMatchReward(
    req: AiMatchRewardRequest,
  ): Promise<ApiResult<AiMatchRewardResponse>> {
    const identity = await this.ensureIdentity();
    if (!identity) {
      return { ok: false, error: 'Player session not initialized.' };
    }

    try {
      const { ok, json } = await this.requestJson<AiMatchRewardResponse>(
        '/api/economy/ai-reward',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${identity.playerToken}` },
          body: JSON.stringify({
            playerId: identity.playerId,
            ...req,
          }),
        },
      );
      if (!ok || !json.wallet) {
        return {
          ok: false,
          code: json.error,
          error: json.message ?? 'Unable to verify AI match reward.',
        };
      }
      const store = useGameStore.getState();
      store.applyEconomySnapshot({ wallet: json.wallet });
      store.setLastAiRewardClaim(json);
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: 'Network error claiming AI match coins.' };
    }
  }
}

export const economyClient = new EconomyClientImpl();
