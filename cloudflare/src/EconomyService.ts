import type { AiDifficulty, RuleProfileId } from '../../src/game/rules/types';
import {
  categorySlotKey,
  computeDailyRewardState,
  computeOnlineMatchCoinBreakdown,
  COSMETIC_CATALOG_MAP,
  DEFAULT_EQUIPPED_COSMETICS,
  ECONOMY_CONFIG,
  getCategoryDefaultItemId,
  getUtcDayKey,
  sanitizeEquippedCosmetics,
  STARTER_COSMETIC_IDS,
  type AiMatchRewardRequest,
  type AiMatchRewardResponse,
  type CoinTransactionReason,
  type CoinTransactionRecord,
  type CosmeticCategory,
  type CosmeticItemDef,
  type DailyClaimResponse,
  type EquipCosmeticResponse,
  type EquippedCosmetics,
  type PlayerCosmeticSnapshot,
  type PurchaseItemResponse,
  type WalletSummary,
} from '../../src/multiplayer/shared/economy';
import type { ProgressionSqlDb } from './D1ProgressionService';

interface WalletDbRow {
  player_id: string;
  balance: number;
  total_earned: number;
  total_spent: number;
  daily_streak: number;
  last_daily_claim_ms: number | null;
  ai_daily_day_key: string | null;
  ai_daily_coins: number;
  last_ai_claim_ms: number | null;
  updated_at_ms: number;
}

interface EquippedDbRow {
  player_id: string;
  cue_id: string;
  ball_id: string;
  table_id: string;
  avatar_id: string;
  nameplate_id: string;
  badge_id: string;
  victory_id: string;
  decoration_id: string;
  updated_at_ms: number;
}

export type EconomyServiceError = {
  ok: false;
  status: number;
  code: string;
  message: string;
  nextClaimAtMs?: number;
};

const VALID_CATEGORIES = new Set<CosmeticCategory>([
  'cue',
  'ball',
  'table',
  'avatar',
  'nameplate',
  'badge',
  'victory',
  'decoration',
]);

const VALID_AI_DIFFICULTIES = new Set<AiDifficulty>([
  'beginner',
  'intermediate',
  'pro',
  'legend',
]);

const ECONOMY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS player_wallets (
    player_id TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 100,
    total_earned INTEGER NOT NULL DEFAULT 100,
    total_spent INTEGER NOT NULL DEFAULT 0,
    daily_streak INTEGER NOT NULL DEFAULT 0,
    last_daily_claim_ms INTEGER,
    ai_daily_day_key TEXT,
    ai_daily_coins INTEGER NOT NULL DEFAULT 0,
    last_ai_claim_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS player_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    acquired_at_ms INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'store_purchase',
    UNIQUE(player_id, item_id)
  )`,
  `CREATE TABLE IF NOT EXISTS player_equipped_cosmetics (
    player_id TEXT PRIMARY KEY,
    cue_id TEXT NOT NULL DEFAULT 'cue_classic_maple',
    ball_id TEXT NOT NULL DEFAULT 'ball_classic',
    table_id TEXT NOT NULL DEFAULT 'table_classic_green',
    avatar_id TEXT NOT NULL DEFAULT 'cue_gold',
    nameplate_id TEXT NOT NULL DEFAULT 'nameplate_standard',
    badge_id TEXT NOT NULL DEFAULT 'badge_none',
    victory_id TEXT NOT NULL DEFAULT 'victory_classic_burst',
    decoration_id TEXT NOT NULL DEFAULT 'decor_none',
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS coin_transactions (
    tx_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason TEXT NOT NULL,
    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    idempotency_key TEXT UNIQUE NOT NULL,
    metadata_json TEXT,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_match_claims (
    client_match_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    coins_awarded INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_player_inventory_player ON player_inventory (player_id, acquired_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_transactions_player_time ON coin_transactions (player_id, created_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_match_claims_player_time ON ai_match_claims (player_id, created_at_ms DESC)`,
];

function generateTxId(): string {
  return `tx_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function mapEquippedColumn(category: CosmeticCategory): string {
  switch (category) {
    case 'cue':
      return 'cue_id';
    case 'ball':
      return 'ball_id';
    case 'table':
      return 'table_id';
    case 'avatar':
      return 'avatar_id';
    case 'nameplate':
      return 'nameplate_id';
    case 'badge':
      return 'badge_id';
    case 'victory':
      return 'victory_id';
    case 'decoration':
      return 'decoration_id';
  }
}

export class EconomyService {
  private static readonly bootstrappedDbs = new WeakSet<object>();
  private static readonly playerLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly db: ProgressionSqlDb | D1Database | undefined) {}

  private async ensureSchema(): Promise<ProgressionSqlDb> {
    if (!this.db) {
      throw new Error('Economy database is not configured.');
    }
    const db = this.db as unknown as ProgressionSqlDb;
    if (!EconomyService.bootstrappedDbs.has(this.db)) {
      for (const stmt of ECONOMY_SCHEMA_STATEMENTS) {
        await db.prepare(stmt).run();
      }
      EconomyService.bootstrappedDbs.add(this.db);
    }
    return db;
  }

  private async withPlayerLock<T>(playerId: string, task: () => Promise<T>): Promise<T> {
    const prev = EconomyService.playerLocks.get(playerId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    EconomyService.playerLocks.set(playerId, run);
    try {
      return await run;
    } finally {
      if (EconomyService.playerLocks.get(playerId) === run) {
        EconomyService.playerLocks.delete(playerId);
      }
    }
  }

  private async ensurePlayerInitialized(
    db: ProgressionSqlDb,
    playerId: string,
    nowMs: number = Date.now(),
  ): Promise<WalletDbRow> {
    const existing = await db
      .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<WalletDbRow>();

    if (!existing) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO player_wallets (
            player_id, balance, total_earned, total_spent,
            daily_streak, last_daily_claim_ms, ai_daily_day_key, ai_daily_coins, last_ai_claim_ms,
            updated_at_ms
          ) VALUES (?, ?, ?, 0, 0, NULL, NULL, 0, NULL, ?)`,
        )
        .bind(
          playerId,
          ECONOMY_CONFIG.startingBalance,
          ECONOMY_CONFIG.startingBalance,
          nowMs,
        )
        .run();

      await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, 'online_match_play', 'starter', ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          playerId,
          ECONOMY_CONFIG.startingBalance,
          ECONOMY_CONFIG.startingBalance,
          'welcome_grant',
          `welcome:${playerId}`,
          JSON.stringify({ label: 'Welcome Pool Coins Grant' }),
          nowMs,
        )
        .run();
    }

    // Ensure equipped row exists (syncing initial avatar from players table if present)
    const equippedRow = await db
      .prepare('SELECT * FROM player_equipped_cosmetics WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<EquippedDbRow>();

    if (!equippedRow) {
      const playerRow = await db
        .prepare('SELECT avatar_id FROM players WHERE player_id = ? LIMIT 1')
        .bind(playerId)
        .first<{ avatar_id?: string }>();
      const safeAvatar =
        playerRow?.avatar_id && COSMETIC_CATALOG_MAP.get(playerRow.avatar_id)?.category === 'avatar'
          ? playerRow.avatar_id
          : DEFAULT_EQUIPPED_COSMETICS.avatarId;

      await db
        .prepare(
          `INSERT OR IGNORE INTO player_equipped_cosmetics (
            player_id, cue_id, ball_id, table_id, avatar_id,
            nameplate_id, badge_id, victory_id, decoration_id, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          playerId,
          DEFAULT_EQUIPPED_COSMETICS.cueId,
          DEFAULT_EQUIPPED_COSMETICS.ballId,
          DEFAULT_EQUIPPED_COSMETICS.tableId,
          safeAvatar,
          DEFAULT_EQUIPPED_COSMETICS.nameplateId,
          DEFAULT_EQUIPPED_COSMETICS.badgeId,
          DEFAULT_EQUIPPED_COSMETICS.victoryId,
          DEFAULT_EQUIPPED_COSMETICS.decorationId,
          nowMs,
        )
        .run();
    }

    return (await db
      .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<WalletDbRow>())!;
  }

  private async loadInventoryIds(db: ProgressionSqlDb, playerId: string): Promise<string[]> {
    const rows = await db
      .prepare('SELECT item_id FROM player_inventory WHERE player_id = ?')
      .bind(playerId)
      .all<{ item_id: string }>();

    const owned = new Set<string>(STARTER_COSMETIC_IDS);
    for (const r of rows.results ?? []) {
      if (COSMETIC_CATALOG_MAP.has(String(r.item_id))) {
        owned.add(String(r.item_id));
      }
    }
    return [...owned];
  }

  private async loadEquipped(db: ProgressionSqlDb, playerId: string): Promise<EquippedCosmetics> {
    const row = await db
      .prepare('SELECT * FROM player_equipped_cosmetics WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<EquippedDbRow>();
    if (!row) return { ...DEFAULT_EQUIPPED_COSMETICS };
    return sanitizeEquippedCosmetics({
      cueId: row.cue_id,
      ballId: row.ball_id,
      tableId: row.table_id,
      avatarId: row.avatar_id,
      nameplateId: row.nameplate_id,
      badgeId: row.badge_id,
      victoryId: row.victory_id,
      decorationId: row.decoration_id,
    });
  }

  private mapWalletSummary(row: WalletDbRow): WalletSummary {
    return {
      playerId: row.player_id,
      balance: Number(row.balance),
      totalEarned: Number(row.total_earned),
      totalSpent: Number(row.total_spent),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  public async getEquippedCosmetics(playerId: string): Promise<EquippedCosmetics> {
    const db = await this.ensureSchema();
    await this.ensurePlayerInitialized(db, playerId);
    return this.loadEquipped(db, playerId);
  }

  public async syncStarterAvatarIfChanged(playerId: string, avatarId: string): Promise<void> {
    const item = COSMETIC_CATALOG_MAP.get(avatarId);
    if (!item || item.category !== 'avatar') return;
    const db = await this.ensureSchema();
    await this.ensurePlayerInitialized(db, playerId);
    const owned = await this.loadInventoryIds(db, playerId);
    if (!owned.includes(avatarId)) return;
    await db
      .prepare('UPDATE player_equipped_cosmetics SET avatar_id = ?, updated_at_ms = ? WHERE player_id = ?')
      .bind(avatarId, Date.now(), playerId)
      .run();
  }

  public async getOverview(
    playerId: string,
    nowMs: number = Date.now(),
  ): Promise<PlayerCosmeticSnapshot> {
    const db = await this.ensureSchema();
    const walletRow = await this.ensurePlayerInitialized(db, playerId, nowMs);
    const [inventoryIds, equipped] = await Promise.all([
      this.loadInventoryIds(db, playerId),
      this.loadEquipped(db, playerId),
    ]);

    return {
      wallet: this.mapWalletSummary(walletRow),
      inventoryIds,
      equipped,
      dailyReward: computeDailyRewardState(
        Number(walletRow.daily_streak ?? 0),
        walletRow.last_daily_claim_ms !== null && walletRow.last_daily_claim_ms !== undefined
          ? Number(walletRow.last_daily_claim_ms)
          : null,
        nowMs,
      ),
    };
  }

  public async getTransactions(
    playerId: string,
    limit = 40,
  ): Promise<CoinTransactionRecord[]> {
    const db = await this.ensureSchema();
    await this.ensurePlayerInitialized(db, playerId);
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await db
      .prepare(
        'SELECT * FROM coin_transactions WHERE player_id = ? ORDER BY created_at_ms DESC LIMIT ?',
      )
      .bind(playerId, safeLimit)
      .all<Record<string, unknown>>();

    return (rows.results ?? []).map((r) => {
      let metadata: Record<string, string | number | boolean> | null = null;
      if (typeof r.metadata_json === 'string' && r.metadata_json.length > 0) {
        try {
          metadata = JSON.parse(r.metadata_json) as Record<string, string | number | boolean>;
        } catch {
          metadata = null;
        }
      }
      return {
        txId: String(r.tx_id),
        playerId: String(r.player_id),
        amount: Number(r.amount),
        balanceAfter: Number(r.balance_after),
        reason: String(r.reason) as CoinTransactionReason,
        referenceType: String(r.reference_type),
        referenceId: String(r.reference_id),
        metadata,
        createdAtMs: Number(r.created_at_ms),
      };
    });
  }

  public async purchaseItem(
    playerId: string,
    itemIdRaw: unknown,
  ): Promise<PurchaseItemResponse | EconomyServiceError> {
    if (typeof itemIdRaw !== 'string' || !itemIdRaw.trim()) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'itemId is required.' };
    }
    const itemId = itemIdRaw.trim();
    const item: CosmeticItemDef | undefined = COSMETIC_CATALOG_MAP.get(itemId);
    if (!item) {
      return { ok: false, status: 404, code: 'ITEM_NOT_FOUND', message: 'Store item not found.' };
    }
    if (item.isRewardExclusive) {
      return {
        ok: false,
        status: 403,
        code: 'REWARD_EXCLUSIVE',
        message: 'This cosmetic is exclusively unlocked via tournament rewards.',
      };
    }
    if (item.isStarter || item.price <= 0) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_OWNED',
        message: 'This starter cosmetic is already owned.',
      };
    }

    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      const now = Date.now();
      await this.ensurePlayerInitialized(db, playerId, now);

      const alreadyRow = await db
        .prepare('SELECT id FROM player_inventory WHERE player_id = ? AND item_id = ? LIMIT 1')
        .bind(playerId, item.id)
        .first<{ id: number }>();
      if (alreadyRow) {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_OWNED',
          message: `You already own ${item.name}.`,
        };
      }

      // Atomic conditional debit prevents negative balances or double-spending
      const debitRes = await db
        .prepare(
          `UPDATE player_wallets
           SET balance = balance - ?, total_spent = total_spent + ?, updated_at_ms = ?
           WHERE player_id = ? AND balance >= ?`,
        )
        .bind(item.price, item.price, now, playerId, item.price)
        .run();

      if ((debitRes.meta?.changes ?? 0) === 0) {
        return {
          ok: false,
          status: 402,
          code: 'INSUFFICIENT_FUNDS',
          message: `You need ${item.price} POOL COINS to unlock ${item.name}.`,
        };
      }

      const invRes = await db
        .prepare(
          `INSERT OR IGNORE INTO player_inventory (player_id, item_id, acquired_at_ms, source)
           VALUES (?, ?, ?, 'store_purchase')`,
        )
        .bind(playerId, item.id, now)
        .run();

      if ((invRes.meta?.changes ?? 0) === 0) {
        // Concurrent duplicate guard: roll back wallet debit cleanly
        await db
          .prepare(
            `UPDATE player_wallets
             SET balance = balance + ?, total_spent = MAX(0, total_spent - ?), updated_at_ms = ?
             WHERE player_id = ?`,
          )
          .bind(item.price, item.price, Date.now(), playerId)
          .run();
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_OWNED',
          message: `You already own ${item.name}.`,
        };
      }

      const updatedWallet = (await db
        .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
        .bind(playerId)
        .first<WalletDbRow>())!;

      await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, 'store_purchase', 'cosmetic_item', ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          playerId,
          -item.price,
          Number(updatedWallet.balance),
          item.id,
          `purchase:${playerId}:${item.id}`,
          JSON.stringify({ label: `Purchased ${item.name}`, category: item.category }),
          now,
        )
        .run();

      const [inventoryIds, equipped] = await Promise.all([
        this.loadInventoryIds(db, playerId),
        this.loadEquipped(db, playerId),
      ]);

      return {
        ok: true,
        item,
        wallet: this.mapWalletSummary(updatedWallet),
        inventoryIds,
        equipped,
      };
    });
  }

  public async equipItem(
    playerId: string,
    categoryRaw: unknown,
    itemIdRaw: unknown,
  ): Promise<EquipCosmeticResponse | EconomyServiceError> {
    if (typeof categoryRaw !== 'string' || !VALID_CATEGORIES.has(categoryRaw as CosmeticCategory)) {
      return { ok: false, status: 400, code: 'INVALID_CATEGORY', message: 'Invalid cosmetic category.' };
    }
    const category = categoryRaw as CosmeticCategory;
    const targetItemId =
      itemIdRaw === null || itemIdRaw === undefined || itemIdRaw === ''
        ? getCategoryDefaultItemId(category)
        : String(itemIdRaw).trim();

    const item = COSMETIC_CATALOG_MAP.get(targetItemId);
    if (!item || item.category !== category) {
      return {
        ok: false,
        status: 404,
        code: 'ITEM_NOT_FOUND',
        message: 'Cosmetic item does not belong to that category.',
      };
    }

    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      const now = Date.now();
      await this.ensurePlayerInitialized(db, playerId, now);

      if (!item.isStarter) {
        const ownedRow = await db
          .prepare('SELECT id FROM player_inventory WHERE player_id = ? AND item_id = ? LIMIT 1')
          .bind(playerId, item.id)
          .first<{ id: number }>();
        if (!ownedRow) {
          return {
            ok: false,
            status: 403,
            code: 'NOT_OWNED',
            message: `Unlock ${item.name} in the Store before equipping it.`,
          };
        }
      }

      const col = mapEquippedColumn(category);
      await db
        .prepare(`UPDATE player_equipped_cosmetics SET ${col} = ?, updated_at_ms = ? WHERE player_id = ?`)
        .bind(item.id, now, playerId)
        .run();

      if (category === 'avatar') {
        await db
          .prepare('UPDATE players SET avatar_id = ?, updated_at_ms = ? WHERE player_id = ?')
          .bind(item.id, now, playerId)
          .run();
      }

      const equipped = await this.loadEquipped(db, playerId);
      const slot = categorySlotKey(category);
      return {
        ok: true,
        category,
        itemId: equipped[slot],
        equipped,
      };
    });
  }

  public async claimDailyReward(
    playerId: string,
    nowMs: number = Date.now(),
  ): Promise<DailyClaimResponse | EconomyServiceError> {
    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      const walletRow = await this.ensurePlayerInitialized(db, playerId, nowMs);
      const status = computeDailyRewardState(
        Number(walletRow.daily_streak ?? 0),
        walletRow.last_daily_claim_ms !== null && walletRow.last_daily_claim_ms !== undefined
          ? Number(walletRow.last_daily_claim_ms)
          : null,
        nowMs,
      );

      if (!status.canClaim) {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_CLAIMED',
          message: 'Daily login reward already claimed today. Come back after UTC midnight.',
          nextClaimAtMs: status.nextClaimAtMs,
        };
      }

      const dayKey = getUtcDayKey(nowMs);
      const rewardCoins = status.nextRewardCoins;
      const newStreak = status.streak + 1;
      const nextBalance = Number(walletRow.balance) + rewardCoins;

      const txRes = await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, 'daily_login', 'daily_streak', ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          playerId,
          rewardCoins,
          nextBalance,
          dayKey,
          `daily:${playerId}:${dayKey}`,
          JSON.stringify({ label: `Daily Login Day ${status.nextDayIndex}`, streak: newStreak }),
          nowMs,
        )
        .run();

      if ((txRes.meta?.changes ?? 0) === 0) {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_CLAIMED',
          message: 'Daily login reward already claimed today.',
          nextClaimAtMs: status.nextClaimAtMs,
        };
      }

      await db
        .prepare(
          `UPDATE player_wallets
           SET balance = balance + ?, total_earned = total_earned + ?,
               daily_streak = ?, last_daily_claim_ms = ?, updated_at_ms = ?
           WHERE player_id = ?`,
        )
        .bind(rewardCoins, rewardCoins, newStreak, nowMs, nowMs, playerId)
        .run();

      const updatedRow = (await db
        .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
        .bind(playerId)
        .first<WalletDbRow>())!;

      return {
        ok: true,
        claimedAmount: rewardCoins,
        streak: newStreak,
        wallet: this.mapWalletSummary(updatedRow),
        dailyReward: computeDailyRewardState(
          Number(updatedRow.daily_streak),
          Number(updatedRow.last_daily_claim_ms),
          nowMs,
        ),
      };
    });
  }

  public async awardOnlineMatchCoins(params: {
    matchId: string;
    playerId: string;
    won: boolean;
    ruleProfileId: RuleProfileId;
    validCompetitiveMatch: boolean;
    unlockedAchievementIds: string[];
    endedAtMs: number;
  }): Promise<{ totalCoins: number; breakdown: Array<{ label: string; amount: number }> }> {
    const computed = computeOnlineMatchCoinBreakdown({
      won: params.won,
      ruleProfileId: params.ruleProfileId,
      validCompetitiveMatch: params.validCompetitiveMatch,
      unlockedAchievementIds: params.unlockedAchievementIds,
    });
    if (computed.totalCoins <= 0) {
      return { totalCoins: 0, breakdown: [] };
    }

    return this.withPlayerLock(params.playerId, async () => {
      const db = await this.ensureSchema();
      let walletRow = await this.ensurePlayerInitialized(db, params.playerId, params.endedAtMs);
      let currentBalance = Number(walletRow.balance);

      const awardedBreakdown: Array<{ label: string; amount: number }> = [];
      let totalCredited = 0;

      // 1) Base online match payout (idempotent per matchId + playerId)
      const baseAmount = params.won
        ? ECONOMY_CONFIG.onlineMatch.winBaseCoins +
          (params.ruleProfileId === 'wpa' ? ECONOMY_CONFIG.onlineMatch.winWpaBonusCoins : 0)
        : ECONOMY_CONFIG.onlineMatch.lossParticipationCoins;

      if (baseAmount > 0) {
        const nextBalance = currentBalance + baseAmount;
        const baseReason: CoinTransactionReason = params.won
          ? 'online_match_win'
          : 'online_match_play';
        const baseLabel = params.won
          ? params.ruleProfileId === 'wpa'
            ? 'Online Victory (WPA Bonus)'
            : 'Online Match Victory'
          : 'Online Match Completion';

        const baseTx = await db
          .prepare(
            `INSERT OR IGNORE INTO coin_transactions (
              tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, 'online_match', ?, ?, ?, ?)`,
          )
          .bind(
            generateTxId(),
            params.playerId,
            baseAmount,
            nextBalance,
            baseReason,
            params.matchId,
            `online_match:${params.matchId}:${params.playerId}`,
            JSON.stringify({ label: baseLabel, ruleProfileId: params.ruleProfileId, won: params.won }),
            params.endedAtMs,
          )
          .run();

        if ((baseTx.meta?.changes ?? 0) > 0) {
          currentBalance = nextBalance;
          totalCredited += baseAmount;
          awardedBreakdown.push({ label: baseLabel, amount: baseAmount });
        }
      }

      // 2) Achievement coin bonuses (idempotent per playerId + achievementId)
      for (const achId of params.unlockedAchievementIds) {
        const bonus = ECONOMY_CONFIG.achievementCoinRewards[achId] ?? 0;
        if (bonus <= 0) continue;
        const nextBalance = currentBalance + bonus;
        const achTx = await db
          .prepare(
            `INSERT OR IGNORE INTO coin_transactions (
              tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
            ) VALUES (?, ?, ?, ?, 'achievement_unlock', 'achievement', ?, ?, ?, ?)`,
          )
          .bind(
            generateTxId(),
            params.playerId,
            bonus,
            nextBalance,
            achId,
            `achievement:${params.playerId}:${achId}`,
            JSON.stringify({ label: `Achievement: ${achId}`, matchId: params.matchId }),
            params.endedAtMs,
          )
          .run();

        if ((achTx.meta?.changes ?? 0) > 0) {
          currentBalance = nextBalance;
          totalCredited += bonus;
          awardedBreakdown.push({ label: `Achievement Bonus`, amount: bonus });
        }
      }

      if (totalCredited > 0) {
        await db
          .prepare(
            `UPDATE player_wallets
             SET balance = balance + ?, total_earned = total_earned + ?, updated_at_ms = ?
             WHERE player_id = ?`,
          )
          .bind(totalCredited, totalCredited, params.endedAtMs, params.playerId)
          .run();
      }

      return {
        totalCoins: totalCredited,
        breakdown: awardedBreakdown,
      };
    });
  }

  public async claimAiMatchReward(
    playerId: string,
    rawReq: Partial<AiMatchRewardRequest>,
    nowMs: number = Date.now(),
  ): Promise<AiMatchRewardResponse | EconomyServiceError> {
    const clientMatchId =
      typeof rawReq.clientMatchId === 'string' ? rawReq.clientMatchId.trim() : '';
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(clientMatchId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid clientMatchId.' };
    }
    if (!rawReq.difficulty || !VALID_AI_DIFFICULTIES.has(rawReq.difficulty)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid AI difficulty.' };
    }
    if (rawReq.won !== true) {
      return {
        ok: false,
        status: 400,
        code: 'MATCH_NOT_WON',
        message: 'Pool Coins for AI matches are awarded only upon winning.',
      };
    }

    const totalShots = Number(rawReq.totalShots ?? 0);
    const durationSec = Number(rawReq.durationSec ?? 0);
    if (
      !Number.isFinite(totalShots) ||
      totalShots < ECONOMY_CONFIG.aiMatch.minShotsForReward ||
      !Number.isFinite(durationSec) ||
      durationSec < ECONOMY_CONFIG.aiMatch.minDurationSecForReward
    ) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_MATCH_SUMMARY',
        message: 'Match did not meet minimum shot/duration criteria for coin rewards.',
      };
    }

    const difficulty = rawReq.difficulty;

    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      const walletRow = await this.ensurePlayerInitialized(db, playerId, nowMs);
      const todayKey = getUtcDayKey(nowMs);
      const currentDailyEarned =
        walletRow.ai_daily_day_key === todayKey ? Number(walletRow.ai_daily_coins ?? 0) : 0;

      const existingClaim = await db
        .prepare('SELECT * FROM ai_match_claims WHERE client_match_id = ? LIMIT 1')
        .bind(clientMatchId)
        .first<{ client_match_id: string; player_id: string; coins_awarded: number }>();

      if (existingClaim) {
        return {
          ok: true,
          coinsAwarded: Number(existingClaim.coins_awarded),
          alreadyClaimed: true,
          dailyCapReached: currentDailyEarned >= ECONOMY_CONFIG.aiMatch.dailyCoinCap,
          dailyEarned: currentDailyEarned,
          dailyCap: ECONOMY_CONFIG.aiMatch.dailyCoinCap,
          nextCooldownAtMs:
            walletRow.last_ai_claim_ms !== null && walletRow.last_ai_claim_ms !== undefined
              ? Number(walletRow.last_ai_claim_ms) + ECONOMY_CONFIG.aiMatch.cooldownMs
              : null,
          wallet: this.mapWalletSummary(walletRow),
        };
      }

      if (
        walletRow.last_ai_claim_ms !== null &&
        walletRow.last_ai_claim_ms !== undefined &&
        nowMs - Number(walletRow.last_ai_claim_ms) < ECONOMY_CONFIG.aiMatch.cooldownMs
      ) {
        return {
          ok: false,
          status: 429,
          code: 'COOLDOWN_ACTIVE',
          message: 'Please wait briefly between AI match coin reward claims.',
        };
      }

      const remainingCap = Math.max(0, ECONOMY_CONFIG.aiMatch.dailyCoinCap - currentDailyEarned);
      if (remainingCap <= 0) {
        return {
          ok: true,
          coinsAwarded: 0,
          alreadyClaimed: false,
          dailyCapReached: true,
          dailyEarned: currentDailyEarned,
          dailyCap: ECONOMY_CONFIG.aiMatch.dailyCoinCap,
          nextCooldownAtMs: null,
          wallet: this.mapWalletSummary(walletRow),
        };
      }

      const scheduledReward = ECONOMY_CONFIG.aiMatch.rewardsByDifficulty[difficulty];
      const awarded = Math.min(scheduledReward, remainingCap);
      const nextBalance = Number(walletRow.balance) + awarded;
      const nextDailyEarned = currentDailyEarned + awarded;

      await db
        .prepare(
          `INSERT OR IGNORE INTO ai_match_claims (
            client_match_id, player_id, difficulty, coins_awarded, created_at_ms
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(clientMatchId, playerId, difficulty, awarded, nowMs)
        .run();

      await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, 'ai_match_win', 'ai_match', ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          playerId,
          awarded,
          nextBalance,
          clientMatchId,
          `ai:${playerId}:${clientMatchId}`,
          JSON.stringify({ label: `AI Victory (${difficulty})`, difficulty, totalShots }),
          nowMs,
        )
        .run();

      await db
        .prepare(
          `UPDATE player_wallets
           SET balance = balance + ?, total_earned = total_earned + ?,
               ai_daily_day_key = ?, ai_daily_coins = ?, last_ai_claim_ms = ?, updated_at_ms = ?
           WHERE player_id = ?`,
        )
        .bind(awarded, awarded, todayKey, nextDailyEarned, nowMs, nowMs, playerId)
        .run();

      const updatedWallet = (await db
        .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
        .bind(playerId)
        .first<WalletDbRow>())!;

      return {
        ok: true,
        coinsAwarded: awarded,
        alreadyClaimed: false,
        dailyCapReached: nextDailyEarned >= ECONOMY_CONFIG.aiMatch.dailyCoinCap,
        dailyEarned: nextDailyEarned,
        dailyCap: ECONOMY_CONFIG.aiMatch.dailyCoinCap,
        nextCooldownAtMs: nowMs + ECONOMY_CONFIG.aiMatch.cooldownMs,
        wallet: this.mapWalletSummary(updatedWallet),
      };
    });
  }

  public async awardTournamentCoins(params: {
    tournamentId: string;
    playerId: string;
    placement: 'champion' | 'runner_up' | 'participant';
    awardedAtMs?: number;
  }): Promise<{ coinsAwarded: number; wallet: WalletSummary }> {
    const now = params.awardedAtMs ?? Date.now();
    const amount =
      params.placement === 'champion'
        ? ECONOMY_CONFIG.tournament.championCoins
        : params.placement === 'runner_up'
          ? ECONOMY_CONFIG.tournament.runnerUpCoins
          : ECONOMY_CONFIG.tournament.participationCoins;

    return this.withPlayerLock(params.playerId, async () => {
      const db = await this.ensureSchema();
      const walletRow = await this.ensurePlayerInitialized(db, params.playerId, now);
      const nextBalance = Number(walletRow.balance) + amount;
      const tx = await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, 'tournament_reward', 'tournament', ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          params.playerId,
          amount,
          nextBalance,
          params.tournamentId,
          `tournament:${params.tournamentId}:${params.playerId}:${params.placement}`,
          JSON.stringify({ label: `Tournament (${params.placement})`, placement: params.placement }),
          now,
        )
        .run();

      if ((tx.meta?.changes ?? 0) === 0) {
        return { coinsAwarded: 0, wallet: this.mapWalletSummary(walletRow) };
      }

      await db
        .prepare(
          `UPDATE player_wallets
           SET balance = balance + ?, total_earned = total_earned + ?, updated_at_ms = ?
           WHERE player_id = ?`,
        )
        .bind(amount, amount, now, params.playerId)
        .run();

      const updated = (await db
        .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
        .bind(params.playerId)
        .first<WalletDbRow>())!;
      return { coinsAwarded: amount, wallet: this.mapWalletSummary(updated) };
    });
  }

  public async awardCustomTournamentCoins(params: {
    tournamentId: string;
    tournamentTitle?: string;
    playerId: string;
    placement: 'champion' | 'runner_up' | 'third_place' | 'participant';
    amount: number;
    awardedAtMs?: number;
  }): Promise<{ coinsAwarded: number; alreadyAwarded: boolean; wallet: WalletSummary }> {
    const now = params.awardedAtMs ?? Date.now();
    const amount = Math.max(0, Math.floor(params.amount));
    return this.withPlayerLock(params.playerId, async () => {
      const db = await this.ensureSchema();
      const walletRow = await this.ensurePlayerInitialized(db, params.playerId, now);
      if (amount <= 0) {
        return { coinsAwarded: 0, alreadyAwarded: false, wallet: this.mapWalletSummary(walletRow) };
      }
      const nextBalance = Number(walletRow.balance) + amount;
      const idempotencyKey = `tournament:${params.tournamentId}:${params.playerId}:${params.placement}`;
      const tx = await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, 'tournament_reward', 'tournament', ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          params.playerId,
          amount,
          nextBalance,
          params.tournamentId,
          idempotencyKey,
          JSON.stringify({
            label: `${params.tournamentTitle ?? 'Tournament'} (${params.placement.replace('_', ' ')})`,
            placement: params.placement,
            tournamentId: params.tournamentId,
          }),
          now,
        )
        .run();

      if ((tx.meta?.changes ?? 0) === 0) {
        return { coinsAwarded: 0, alreadyAwarded: true, wallet: this.mapWalletSummary(walletRow) };
      }

      await db
        .prepare(
          `UPDATE player_wallets
           SET balance = balance + ?, total_earned = total_earned + ?, updated_at_ms = ?
           WHERE player_id = ?`,
        )
        .bind(amount, amount, now, params.playerId)
        .run();

      const updated = (await db
        .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
        .bind(params.playerId)
        .first<WalletDbRow>())!;
      return { coinsAwarded: amount, alreadyAwarded: false, wallet: this.mapWalletSummary(updated) };
    });
  }

  public async awardSeasonCoins(params: {
    seasonId: string;
    seasonName: string;
    playerId: string;
    highestTier: string;
    badgeTitle: string;
    amount: number;
    awardedAtMs?: number;
  }): Promise<{ coinsAwarded: number; alreadyAwarded: boolean; wallet: WalletSummary }> {
    const now = params.awardedAtMs ?? Date.now();
    const amount = Math.max(0, Math.floor(params.amount));
    return this.withPlayerLock(params.playerId, async () => {
      const db = await this.ensureSchema();
      const walletRow = await this.ensurePlayerInitialized(db, params.playerId, now);
      if (amount <= 0) {
        return { coinsAwarded: 0, alreadyAwarded: false, wallet: this.mapWalletSummary(walletRow) };
      }
      const nextBalance = Number(walletRow.balance) + amount;
      const idempotencyKey = `season_reward:${params.seasonId}:${params.playerId}`;
      const tx = await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, 'season_reward', 'season', ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          params.playerId,
          amount,
          nextBalance,
          params.seasonId,
          idempotencyKey,
          JSON.stringify({
            label: `${params.seasonName} Reward (${params.badgeTitle})`,
            seasonId: params.seasonId,
            highestTier: params.highestTier,
            badgeTitle: params.badgeTitle,
          }),
          now,
        )
        .run();

      if ((tx.meta?.changes ?? 0) === 0) {
        return { coinsAwarded: 0, alreadyAwarded: true, wallet: this.mapWalletSummary(walletRow) };
      }

      await db
        .prepare(
          `UPDATE player_wallets
           SET balance = balance + ?, total_earned = total_earned + ?, updated_at_ms = ?
           WHERE player_id = ?`,
        )
        .bind(amount, amount, now, params.playerId)
        .run();

      const updated = (await db
        .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
        .bind(params.playerId)
        .first<WalletDbRow>())!;
      return { coinsAwarded: amount, alreadyAwarded: false, wallet: this.mapWalletSummary(updated) };
    });
  }

  public async debitTournamentEntryFee(params: {
    tournamentId: string;
    tournamentTitle: string;
    playerId: string;
    amount: number;
    nowMs?: number;
  }): Promise<{ ok: true; wallet: WalletSummary } | EconomyServiceError> {
    const now = params.nowMs ?? Date.now();
    const fee = Math.max(0, Math.floor(params.amount));
    return this.withPlayerLock(params.playerId, async () => {
      const db = await this.ensureSchema();
      const walletRow = await this.ensurePlayerInitialized(db, params.playerId, now);
      if (fee <= 0) {
        return { ok: true, wallet: this.mapWalletSummary(walletRow) };
      }

      const idempotencyKey = `tournament_entry:${params.tournamentId}:${params.playerId}`;
      const existingTx = await db
        .prepare('SELECT tx_id FROM coin_transactions WHERE idempotency_key = ? LIMIT 1')
        .bind(idempotencyKey)
        .first<{ tx_id: string }>();
      if (existingTx) {
        return { ok: true, wallet: this.mapWalletSummary(walletRow) };
      }

      const debit = await db
        .prepare(
          `UPDATE player_wallets
           SET balance = balance - ?, total_spent = total_spent + ?, updated_at_ms = ?
           WHERE player_id = ? AND balance >= ?`,
        )
        .bind(fee, fee, now, params.playerId, fee)
        .run();

      if ((debit.meta?.changes ?? 0) === 0) {
        return {
          ok: false,
          status: 402,
          code: 'INSUFFICIENT_FUNDS',
          message: `You need ${fee} POOL COINS to enter ${params.tournamentTitle}.`,
        };
      }

      const updated = (await db
        .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
        .bind(params.playerId)
        .first<WalletDbRow>())!;

      await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, 'tournament_entry', 'tournament', ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          params.playerId,
          -fee,
          Number(updated.balance),
          params.tournamentId,
          idempotencyKey,
          JSON.stringify({ label: `Entry Fee: ${params.tournamentTitle}`, tournamentId: params.tournamentId }),
          now,
        )
        .run();

      return { ok: true, wallet: this.mapWalletSummary(updated) };
    });
  }

  public async refundTournamentEntryFee(params: {
    tournamentId: string;
    tournamentTitle: string;
    playerId: string;
    amount: number;
    reasonLabel?: string;
    nowMs?: number;
  }): Promise<{ refunded: number; wallet: WalletSummary }> {
    const now = params.nowMs ?? Date.now();
    const fee = Math.max(0, Math.floor(params.amount));
    return this.withPlayerLock(params.playerId, async () => {
      const db = await this.ensureSchema();
      const walletRow = await this.ensurePlayerInitialized(db, params.playerId, now);
      if (fee <= 0) {
        return { refunded: 0, wallet: this.mapWalletSummary(walletRow) };
      }
      const entryKey = `tournament_entry:${params.tournamentId}:${params.playerId}`;
      const hadEntryTx = await db
        .prepare('SELECT tx_id FROM coin_transactions WHERE idempotency_key = ? LIMIT 1')
        .bind(entryKey)
        .first<{ tx_id: string }>();
      if (!hadEntryTx) {
        return { refunded: 0, wallet: this.mapWalletSummary(walletRow) };
      }

      const refundKey = `tournament_refund:${params.tournamentId}:${params.playerId}`;
      const nextBalance = Number(walletRow.balance) + fee;
      const tx = await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, 'tournament_refund', 'tournament', ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          params.playerId,
          fee,
          nextBalance,
          params.tournamentId,
          refundKey,
          JSON.stringify({
            label: params.reasonLabel ?? `Entry Refund: ${params.tournamentTitle}`,
            tournamentId: params.tournamentId,
          }),
          now,
        )
        .run();

      if ((tx.meta?.changes ?? 0) === 0) {
        return { refunded: 0, wallet: this.mapWalletSummary(walletRow) };
      }

      await db
        .prepare(
          `UPDATE player_wallets
           SET balance = balance + ?, total_spent = MAX(0, total_spent - ?), updated_at_ms = ?
           WHERE player_id = ?`,
        )
        .bind(fee, fee, now, params.playerId)
        .run();

      const updated = (await db
        .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
        .bind(params.playerId)
        .first<WalletDbRow>())!;
      return { refunded: fee, wallet: this.mapWalletSummary(updated) };
    });
  }

  public async grantExclusiveCosmetic(
    playerId: string,
    itemId: string,
    source = 'tournament_reward',
    nowMs: number = Date.now(),
  ): Promise<boolean> {
    const item = COSMETIC_CATALOG_MAP.get(itemId);
    if (!item) return false;
    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      await this.ensurePlayerInitialized(db, playerId, nowMs);
      const res = await db
        .prepare(
          `INSERT OR IGNORE INTO player_inventory (player_id, item_id, acquired_at_ms, source)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(playerId, itemId, nowMs, source)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    });
  }

  public async creditCoinsWithIdempotency(params: {
    playerId: string;
    amount: number;
    reason: CoinTransactionReason;
    referenceType: string;
    referenceId: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
    nowMs?: number;
  }): Promise<{ awarded: number; alreadyProcessed: boolean; wallet: WalletSummary }> {
    const now = params.nowMs ?? Date.now();
    const safeAmount = Math.max(0, Math.floor(params.amount));
    return this.withPlayerLock(params.playerId, async () => {
      const db = await this.ensureSchema();
      const walletRow = await this.ensurePlayerInitialized(db, params.playerId, now);
      if (safeAmount <= 0) {
        return { awarded: 0, alreadyProcessed: false, wallet: this.mapWalletSummary(walletRow) };
      }

      const nextBalance = Number(walletRow.balance) + safeAmount;
      const tx = await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          params.playerId,
          safeAmount,
          nextBalance,
          params.reason,
          params.referenceType,
          params.referenceId,
          params.idempotencyKey,
          params.metadata ? JSON.stringify(params.metadata) : null,
          now,
        )
        .run();

      if ((tx.meta?.changes ?? 0) === 0) {
        return { awarded: 0, alreadyProcessed: true, wallet: this.mapWalletSummary(walletRow) };
      }

      await db
        .prepare(
          `UPDATE player_wallets
           SET balance = balance + ?, total_earned = total_earned + ?, updated_at_ms = ?
           WHERE player_id = ?`,
        )
        .bind(safeAmount, safeAmount, now, params.playerId)
        .run();

      const updated = (await db
        .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
        .bind(params.playerId)
        .first<WalletDbRow>())!;
      return { awarded: safeAmount, alreadyProcessed: false, wallet: this.mapWalletSummary(updated) };
    });
  }

  public async debitCoinsWithIdempotency(params: {
    playerId: string;
    amount: number;
    reason: CoinTransactionReason;
    referenceType: string;
    referenceId: string;
    idempotencyKey: string;
    insufficientMessage?: string;
    metadata?: Record<string, unknown>;
    nowMs?: number;
  }): Promise<
    | { ok: true; charged: number; alreadyProcessed: boolean; wallet: WalletSummary }
    | EconomyServiceError
  > {
    const now = params.nowMs ?? Date.now();
    const safeAmount = Math.max(0, Math.floor(params.amount));
    return this.withPlayerLock(params.playerId, async () => {
      const db = await this.ensureSchema();
      const walletRow = await this.ensurePlayerInitialized(db, params.playerId, now);

      const existingTx = await db
        .prepare('SELECT tx_id FROM coin_transactions WHERE idempotency_key = ? LIMIT 1')
        .bind(params.idempotencyKey)
        .first<{ tx_id: string }>();
      if (existingTx) {
        return {
          ok: true,
          charged: 0,
          alreadyProcessed: true,
          wallet: this.mapWalletSummary(walletRow),
        };
      }

      if (safeAmount <= 0) {
        return {
          ok: true,
          charged: 0,
          alreadyProcessed: false,
          wallet: this.mapWalletSummary(walletRow),
        };
      }

      const debit = await db
        .prepare(
          `UPDATE player_wallets
           SET balance = balance - ?, total_spent = total_spent + ?, updated_at_ms = ?
           WHERE player_id = ? AND balance >= ?`,
        )
        .bind(safeAmount, safeAmount, now, params.playerId, safeAmount)
        .run();

      if ((debit.meta?.changes ?? 0) === 0) {
        return {
          ok: false,
          status: 402,
          code: 'INSUFFICIENT_FUNDS',
          message:
            params.insufficientMessage ??
            `Insufficient POOL COINS balance (need ${safeAmount}).`,
        };
      }

      const updated = (await db
        .prepare('SELECT * FROM player_wallets WHERE player_id = ? LIMIT 1')
        .bind(params.playerId)
        .first<WalletDbRow>())!;

      await db
        .prepare(
          `INSERT OR IGNORE INTO coin_transactions (
            tx_id, player_id, amount, balance_after, reason, reference_type, reference_id, idempotency_key, metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          generateTxId(),
          params.playerId,
          -safeAmount,
          Number(updated.balance),
          params.reason,
          params.referenceType,
          params.referenceId,
          params.idempotencyKey,
          params.metadata ? JSON.stringify(params.metadata) : null,
          now,
        )
        .run();

      return {
        ok: true,
        charged: safeAmount,
        alreadyProcessed: false,
        wallet: this.mapWalletSummary(updated),
      };
    });
  }
}
