import type { AiDifficulty } from '../../src/game/rules/types';
import {
  BATTLE_PASS_CONFIG,
  BATTLE_PASS_TIERS,
  buildDefaultSeasonTheme,
  calculateBattlePassLevelFromXp,
  computeAiMatchSeasonXp,
  computeOnlineMatchSeasonXp,
  getActiveDailyMissionsForDay,
  getActiveWeeklyChallengesForWeek,
  getUtcDayWindow,
  getUtcWeekWindow,
  MISSION_DEF_MAP,
  type AiMatchProgressRequest,
  type AiMatchProgressResponse,
  type BattlePassOverview,
  type BattlePassSeasonRecord,
  type BattlePassTierStatus,
  type BattlePassTrack,
  type ClaimRewardResponse,
  type MissionCadence,
  type MissionProgressRecord,
  type PlayerBattlePassState,
  type UnlockPremiumResponse,
} from '../../src/multiplayer/shared/battlePass';
import { COSMETIC_CATALOG_MAP } from '../../src/multiplayer/shared/economy';
import type { OnlineMatchType } from '../../src/multiplayer/shared/progression';
import type { ProgressionSqlDb } from './D1ProgressionService';
import { EconomyService } from './EconomyService';

interface SeasonDbRow {
  season_id: string;
  season_number: number;
  name: string;
  theme: string;
  status: string;
  starts_at_ms: number;
  ends_at_ms: number;
  duration_days: number;
  premium_price_coins: number;
  max_level: number;
  created_at_ms: number;
  completed_at_ms: number | null;
}

interface PlayerBattlePassDbRow {
  season_id: string;
  player_id: string;
  season_xp: number;
  season_level: number;
  premium_unlocked: number;
  premium_unlocked_at_ms: number | null;
  matches_played: number;
  wins: number;
  losses: number;
  balls_pocketed: number;
  tournaments_played: number;
  daily_missions_completed: number;
  weekly_challenges_completed: number;
  current_win_streak: number;
  best_win_streak: number;
  daily_match_xp_earned: number;
  daily_ai_xp_earned: number;
  daily_xp_day_key: string;
  last_ai_bp_at_ms: number | null;
  updated_at_ms: number;
}

interface PlayerMissionDbRow {
  player_id: string;
  cadence: string;
  period_key: string;
  mission_id: string;
  progress: number;
  required_progress: number;
  completed: number;
  claimed: number;
  completed_at_ms: number | null;
  claimed_at_ms: number | null;
  expires_at_ms: number;
  updated_at_ms: number;
}

interface ClaimDbRow {
  level: number;
  track: string;
}

export type BattlePassServiceError = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

const VALID_AI_DIFFICULTIES = new Set<AiDifficulty>([
  'beginner',
  'intermediate',
  'pro',
  'legend',
]);

const BATTLE_PASS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS battle_pass_seasons (
    season_id TEXT PRIMARY KEY,
    season_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    theme TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    starts_at_ms INTEGER NOT NULL,
    ends_at_ms INTEGER NOT NULL,
    duration_days INTEGER NOT NULL DEFAULT 30,
    premium_price_coins INTEGER NOT NULL DEFAULT 1200,
    max_level INTEGER NOT NULL DEFAULT 30,
    created_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bp_seasons_status ON battle_pass_seasons (status, season_number DESC)`,
  `CREATE TABLE IF NOT EXISTS player_battle_pass (
    season_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    season_xp INTEGER NOT NULL DEFAULT 0,
    season_level INTEGER NOT NULL DEFAULT 0,
    premium_unlocked INTEGER NOT NULL DEFAULT 0,
    premium_unlocked_at_ms INTEGER,
    matches_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    balls_pocketed INTEGER NOT NULL DEFAULT 0,
    tournaments_played INTEGER NOT NULL DEFAULT 0,
    daily_missions_completed INTEGER NOT NULL DEFAULT 0,
    weekly_challenges_completed INTEGER NOT NULL DEFAULT 0,
    current_win_streak INTEGER NOT NULL DEFAULT 0,
    best_win_streak INTEGER NOT NULL DEFAULT 0,
    daily_match_xp_earned INTEGER NOT NULL DEFAULT 0,
    daily_ai_xp_earned INTEGER NOT NULL DEFAULT 0,
    daily_xp_day_key TEXT NOT NULL DEFAULT '',
    last_ai_bp_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (season_id, player_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_player_bp_player ON player_battle_pass (player_id, updated_at_ms DESC)`,
  `CREATE TABLE IF NOT EXISTS player_missions (
    player_id TEXT NOT NULL,
    cadence TEXT NOT NULL,
    period_key TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    required_progress INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    claimed INTEGER NOT NULL DEFAULT 0,
    completed_at_ms INTEGER,
    claimed_at_ms INTEGER,
    expires_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (player_id, cadence, period_key, mission_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_player_missions_lookup ON player_missions (player_id, cadence, period_key)`,
  `CREATE TABLE IF NOT EXISTS battle_pass_claims (
    season_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    track TEXT NOT NULL,
    coins_awarded INTEGER NOT NULL DEFAULT 0,
    item_id TEXT,
    claimed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (season_id, player_id, level, track)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bp_claims_player ON battle_pass_claims (player_id, season_id)`,
  `CREATE TABLE IF NOT EXISTS xp_events (
    event_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    season_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    idempotency_key TEXT UNIQUE NOT NULL,
    xp_amount INTEGER NOT NULL,
    metadata_json TEXT,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_xp_events_player ON xp_events (player_id, created_at_ms DESC)`,
  `CREATE TABLE IF NOT EXISTS validated_ai_bp_matches (
    client_match_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    won INTEGER NOT NULL DEFAULT 0,
    xp_awarded INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_bp_matches_player ON validated_ai_bp_matches (player_id, created_at_ms DESC)`,
];

function generateEventId(prefix = 'xp'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export class BattlePassService {
  private static readonly bootstrappedDbs = new WeakSet<object>();
  private static readonly playerLocks = new Map<string, Promise<unknown>>();
  private static readonly seasonLock = new Map<string, Promise<unknown>>();

  constructor(private readonly db: ProgressionSqlDb | D1Database | undefined) {}

  private async ensureSchema(): Promise<ProgressionSqlDb> {
    if (!this.db) {
      throw new Error('Battle Pass database is not configured.');
    }
    const db = this.db as unknown as ProgressionSqlDb;
    if (!BattlePassService.bootstrappedDbs.has(this.db)) {
      for (const stmt of BATTLE_PASS_SCHEMA_STATEMENTS) {
        await db.prepare(stmt).run();
      }
      BattlePassService.bootstrappedDbs.add(this.db);
    }
    return db;
  }

  private async withPlayerLock<T>(playerId: string, task: () => Promise<T>): Promise<T> {
    const prev = BattlePassService.playerLocks.get(playerId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    BattlePassService.playerLocks.set(playerId, run);
    try {
      return await run;
    } finally {
      if (BattlePassService.playerLocks.get(playerId) === run) {
        BattlePassService.playerLocks.delete(playerId);
      }
    }
  }

  private async withSeasonLock<T>(task: () => Promise<T>): Promise<T> {
    const key = '__global__';
    const prev = BattlePassService.seasonLock.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    BattlePassService.seasonLock.set(key, run);
    try {
      return await run;
    } finally {
      if (BattlePassService.seasonLock.get(key) === run) {
        BattlePassService.seasonLock.delete(key);
      }
    }
  }

  private mapSeasonRow(row: SeasonDbRow): BattlePassSeasonRecord {
    return {
      seasonId: String(row.season_id),
      seasonNumber: Number(row.season_number),
      name: String(row.name),
      theme: String(row.theme),
      status: row.status === 'completed' ? 'completed' : 'active',
      startsAtMs: Number(row.starts_at_ms),
      endsAtMs: Number(row.ends_at_ms),
      durationDays: Number(row.duration_days),
      premiumPriceCoins: Number(row.premium_price_coins),
      maxLevel: Number(row.max_level),
    };
  }

  private mapPlayerBattlePassState(
    row: PlayerBattlePassDbRow,
    currentDayKey: string,
  ): PlayerBattlePassState {
    const seasonXp = Math.max(0, Number(row.season_xp));
    const levelInfo = calculateBattlePassLevelFromXp(seasonXp);
    const sameDay = row.daily_xp_day_key === currentDayKey;
    return {
      seasonId: String(row.season_id),
      playerId: String(row.player_id),
      seasonXp,
      seasonLevel: levelInfo.level,
      xpIntoCurrentLevel: levelInfo.xpIntoCurrentLevel,
      xpForNextLevel: levelInfo.xpForNextLevel,
      levelProgressRatio: levelInfo.progressRatio,
      premiumUnlocked: Number(row.premium_unlocked) === 1,
      premiumUnlockedAtMs:
        row.premium_unlocked_at_ms !== null && row.premium_unlocked_at_ms !== undefined
          ? Number(row.premium_unlocked_at_ms)
          : null,
      matchesPlayed: Number(row.matches_played),
      wins: Number(row.wins),
      losses: Number(row.losses),
      ballsPocketed: Number(row.balls_pocketed),
      tournamentsPlayed: Number(row.tournaments_played),
      dailyMissionsCompleted: Number(row.daily_missions_completed),
      weeklyChallengesCompleted: Number(row.weekly_challenges_completed),
      currentWinStreak: Number(row.current_win_streak),
      bestWinStreak: Number(row.best_win_streak),
      dailyMatchXpEarned: sameDay ? Number(row.daily_match_xp_earned) : 0,
      dailyAiXpEarned: sameDay ? Number(row.daily_ai_xp_earned) : 0,
      dailyXpDayKey: currentDayKey,
    };
  }

  private async ensureActiveSeasonInternal(
    db: ProgressionSqlDb,
    nowMs: number,
  ): Promise<BattlePassSeasonRecord> {
    return this.withSeasonLock(async () => {
      // Close any expired active seasons without deleting historical data
      await db
        .prepare(
          `UPDATE battle_pass_seasons
           SET status = 'completed', completed_at_ms = ?
           WHERE status = 'active' AND ends_at_ms <= ?`,
        )
        .bind(nowMs, nowMs)
        .run();

      const existing = await db
        .prepare(
          `SELECT * FROM battle_pass_seasons
           WHERE status = 'active'
           ORDER BY season_number DESC
           LIMIT 1`,
        )
        .first<SeasonDbRow>();

      if (existing) {
        return this.mapSeasonRow(existing);
      }

      const maxRow = await db
        .prepare('SELECT MAX(season_number) AS max_num FROM battle_pass_seasons')
        .first<{ max_num: number | null }>();

      const nextNum = Math.max(0, Number(maxRow?.max_num ?? 0)) + 1;
      const themeInfo = buildDefaultSeasonTheme(nextNum);
      const durationDays = BATTLE_PASS_CONFIG.defaultDurationDays;
      const seasonId = `bp_season_${nextNum}`;
      const endsAtMs = nowMs + durationDays * 86_400_000;

      await db
        .prepare(
          `INSERT OR IGNORE INTO battle_pass_seasons (
            season_id, season_number, name, theme, status,
            starts_at_ms, ends_at_ms, duration_days, premium_price_coins, max_level, created_at_ms, completed_at_ms
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          seasonId,
          nextNum,
          themeInfo.name,
          themeInfo.theme,
          nowMs,
          endsAtMs,
          durationDays,
          BATTLE_PASS_CONFIG.premiumPriceCoins,
          BATTLE_PASS_CONFIG.maxLevel,
          nowMs,
        )
        .run();

      const created = (await db
        .prepare('SELECT * FROM battle_pass_seasons WHERE season_id = ? LIMIT 1')
        .bind(seasonId)
        .first<SeasonDbRow>())!;
      return this.mapSeasonRow(created);
    });
  }

  public async adminRolloverSeason(options?: {
    nowMs?: number;
    newSeasonName?: string;
    newSeasonTheme?: string;
    durationDays?: number;
    premiumPriceCoins?: number;
  }): Promise<{
    closedSeason: BattlePassSeasonRecord | null;
    newSeason: BattlePassSeasonRecord;
  }> {
    const nowMs = options?.nowMs ?? Date.now();
    const db = await this.ensureSchema();

    return this.withSeasonLock(async () => {
      const active = await db
        .prepare(
          `SELECT * FROM battle_pass_seasons
           WHERE status = 'active'
           ORDER BY season_number DESC
           LIMIT 1`,
        )
        .first<SeasonDbRow>();

      let closedSeason: BattlePassSeasonRecord | null = null;
      if (active) {
        await db
          .prepare(
            `UPDATE battle_pass_seasons
             SET status = 'completed', completed_at_ms = ?
             WHERE status = 'active'`,
          )
          .bind(nowMs)
          .run();
        const closedRow = await db
          .prepare('SELECT * FROM battle_pass_seasons WHERE season_id = ? LIMIT 1')
          .bind(active.season_id)
          .first<SeasonDbRow>();
        if (closedRow) {
          closedSeason = this.mapSeasonRow(closedRow);
        }
      }

      const maxRow = await db
        .prepare('SELECT MAX(season_number) AS max_num FROM battle_pass_seasons')
        .first<{ max_num: number | null }>();
      const nextNum = Math.max(0, Number(maxRow?.max_num ?? 0)) + 1;
      const defaults = buildDefaultSeasonTheme(nextNum);
      const seasonName =
        typeof options?.newSeasonName === 'string' && options.newSeasonName.trim().length > 0
          ? options.newSeasonName.trim()
          : defaults.name;
      const seasonTheme =
        typeof options?.newSeasonTheme === 'string' && options.newSeasonTheme.trim().length > 0
          ? options.newSeasonTheme.trim()
          : defaults.theme;
      const durationDays = Math.max(
        1,
        Math.min(180, Math.floor(options?.durationDays ?? BATTLE_PASS_CONFIG.defaultDurationDays)),
      );
      const premiumPriceCoins = Math.max(
        100,
        Math.floor(options?.premiumPriceCoins ?? BATTLE_PASS_CONFIG.premiumPriceCoins),
      );
      const seasonId = `bp_season_${nextNum}_${nowMs.toString(36)}`;
      const endsAtMs = nowMs + durationDays * 86_400_000;

      await db
        .prepare(
          `INSERT INTO battle_pass_seasons (
            season_id, season_number, name, theme, status,
            starts_at_ms, ends_at_ms, duration_days, premium_price_coins, max_level, created_at_ms, completed_at_ms
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          seasonId,
          nextNum,
          seasonName,
          seasonTheme,
          nowMs,
          endsAtMs,
          durationDays,
          premiumPriceCoins,
          BATTLE_PASS_CONFIG.maxLevel,
          nowMs,
        )
        .run();

      const created = (await db
        .prepare('SELECT * FROM battle_pass_seasons WHERE season_id = ? LIMIT 1')
        .bind(seasonId)
        .first<SeasonDbRow>())!;

      return {
        closedSeason,
        newSeason: this.mapSeasonRow(created),
      };
    });
  }

  private async ensurePlayerRowInternal(
    db: ProgressionSqlDb,
    seasonId: string,
    playerId: string,
    currentDayKey: string,
    nowMs: number,
  ): Promise<PlayerBattlePassDbRow> {
    await db
      .prepare(
        `INSERT OR IGNORE INTO player_battle_pass (
          season_id, player_id, season_xp, season_level, premium_unlocked, premium_unlocked_at_ms,
          matches_played, wins, losses, balls_pocketed, tournaments_played,
          daily_missions_completed, weekly_challenges_completed,
          current_win_streak, best_win_streak,
          daily_match_xp_earned, daily_ai_xp_earned, daily_xp_day_key, last_ai_bp_at_ms, updated_at_ms
        ) VALUES (?, ?, 0, 0, 0, NULL, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, NULL, ?)`,
      )
      .bind(seasonId, playerId, currentDayKey, nowMs)
      .run();

    let row = (await db
      .prepare('SELECT * FROM player_battle_pass WHERE season_id = ? AND player_id = ? LIMIT 1')
      .bind(seasonId, playerId)
      .first<PlayerBattlePassDbRow>())!;

    if (row.daily_xp_day_key !== currentDayKey) {
      await db
        .prepare(
          `UPDATE player_battle_pass
           SET daily_match_xp_earned = 0, daily_ai_xp_earned = 0, daily_xp_day_key = ?, updated_at_ms = ?
           WHERE season_id = ? AND player_id = ?`,
        )
        .bind(currentDayKey, nowMs, seasonId, playerId)
        .run();
      row = (await db
        .prepare('SELECT * FROM player_battle_pass WHERE season_id = ? AND player_id = ? LIMIT 1')
        .bind(seasonId, playerId)
        .first<PlayerBattlePassDbRow>())!;
    }

    return row;
  }

  private async ensureActiveMissionsInternal(
    db: ProgressionSqlDb,
    playerId: string,
    nowMs: number,
  ): Promise<{
    dailyMissions: MissionProgressRecord[];
    weeklyChallenges: MissionProgressRecord[];
    dailyResetAtMs: number;
    weeklyResetAtMs: number;
  }> {
    const dayWin = getUtcDayWindow(nowMs);
    const weekWin = getUtcWeekWindow(nowMs);

    const dailyDefs = getActiveDailyMissionsForDay(dayWin.dayKey);
    const weeklyDefs = getActiveWeeklyChallengesForWeek(weekWin.weekKey);

    for (const def of dailyDefs) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO player_missions (
            player_id, cadence, period_key, mission_id, progress, required_progress,
            completed, claimed, completed_at_ms, claimed_at_ms, expires_at_ms, updated_at_ms
          ) VALUES (?, 'daily', ?, ?, 0, ?, 0, 0, NULL, NULL, ?, ?)`,
        )
        .bind(playerId, dayWin.dayKey, def.id, def.requiredProgress, dayWin.expiresAtMs, nowMs)
        .run();
    }

    for (const def of weeklyDefs) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO player_missions (
            player_id, cadence, period_key, mission_id, progress, required_progress,
            completed, claimed, completed_at_ms, claimed_at_ms, expires_at_ms, updated_at_ms
          ) VALUES (?, 'weekly', ?, ?, 0, ?, 0, 0, NULL, NULL, ?, ?)`,
        )
        .bind(playerId, weekWin.weekKey, def.id, def.requiredProgress, weekWin.expiresAtMs, nowMs)
        .run();
    }

    const dailyRowsRes = await db
      .prepare(
        `SELECT * FROM player_missions
         WHERE player_id = ? AND cadence = 'daily' AND period_key = ?`,
      )
      .bind(playerId, dayWin.dayKey)
      .all<PlayerMissionDbRow>();

    const weeklyRowsRes = await db
      .prepare(
        `SELECT * FROM player_missions
         WHERE player_id = ? AND cadence = 'weekly' AND period_key = ?`,
      )
      .bind(playerId, weekWin.weekKey)
      .all<PlayerMissionDbRow>();

    const dailyMap = new Map((dailyRowsRes.results ?? []).map((r) => [r.mission_id, r]));
    const weeklyMap = new Map((weeklyRowsRes.results ?? []).map((r) => [r.mission_id, r]));

    const mapRow = (
      def: (typeof dailyDefs)[number],
      row: PlayerMissionDbRow | undefined,
      periodKey: string,
      expiresAtMs: number,
    ): MissionProgressRecord => ({
      missionId: def.id,
      cadence: def.cadence,
      periodKey,
      title: def.title,
      description: def.description,
      metric: def.metric,
      progress: row ? Math.min(def.requiredProgress, Number(row.progress)) : 0,
      requiredProgress: def.requiredProgress,
      completed: row ? Number(row.completed) === 1 : false,
      claimed: row ? Number(row.claimed) === 1 : false,
      rewardCoins: def.rewardCoins,
      rewardSeasonXp: def.rewardSeasonXp,
      expiresAtMs: row ? Number(row.expires_at_ms) : expiresAtMs,
      completedAtMs:
        row?.completed_at_ms !== null && row?.completed_at_ms !== undefined
          ? Number(row.completed_at_ms)
          : null,
      claimedAtMs:
        row?.claimed_at_ms !== null && row?.claimed_at_ms !== undefined
          ? Number(row.claimed_at_ms)
          : null,
    });

    return {
      dailyMissions: dailyDefs.map((d) =>
        mapRow(d, dailyMap.get(d.id), dayWin.dayKey, dayWin.expiresAtMs),
      ),
      weeklyChallenges: weeklyDefs.map((w) =>
        mapRow(w, weeklyMap.get(w.id), weekWin.weekKey, weekWin.expiresAtMs),
      ),
      dailyResetAtMs: dayWin.expiresAtMs,
      weeklyResetAtMs: weekWin.expiresAtMs,
    };
  }

  private async buildOverviewUnlocked(
    db: ProgressionSqlDb,
    playerId: string,
    nowMs: number,
  ): Promise<BattlePassOverview> {
    const dayWin = getUtcDayWindow(nowMs);
    const season = await this.ensureActiveSeasonInternal(db, nowMs);
    const bpRow = await this.ensurePlayerRowInternal(db, season.seasonId, playerId, dayWin.dayKey, nowMs);
    const playerState = this.mapPlayerBattlePassState(bpRow, dayWin.dayKey);
    const missionsBundle = await this.ensureActiveMissionsInternal(db, playerId, nowMs);

    const claimsRes = await db
      .prepare(
        `SELECT level, track FROM battle_pass_claims
         WHERE season_id = ? AND player_id = ?`,
      )
      .bind(season.seasonId, playerId)
      .all<ClaimDbRow>();

    const claimKeys = new Set(
      (claimsRes.results ?? []).map((r) => `${Number(r.level)}:${r.track}`),
    );

    const tiers: BattlePassTierStatus[] = BATTLE_PASS_TIERS.map((tier) => {
      const unlocked = playerState.seasonLevel >= tier.level;
      const freeHasReward = tier.free.coins > 0 || tier.free.itemId !== null;
      const freeClaimed = claimKeys.has(`${tier.level}:free`);
      const premHasReward = tier.premium.coins > 0 || tier.premium.itemId !== null;
      const premClaimed = claimKeys.has(`${tier.level}:premium`);
      return {
        level: tier.level,
        xpRequiredForLevel: tier.xpRequiredForLevel,
        cumulativeXpRequired: tier.cumulativeXpRequired,
        unlocked,
        free: {
          coins: tier.free.coins,
          itemId: tier.free.itemId,
          item: tier.free.itemId ? COSMETIC_CATALOG_MAP.get(tier.free.itemId) ?? null : null,
          hasReward: freeHasReward,
          claimed: freeClaimed,
          canClaim: unlocked && freeHasReward && !freeClaimed,
        },
        premium: {
          coins: tier.premium.coins,
          itemId: tier.premium.itemId,
          item: tier.premium.itemId ? COSMETIC_CATALOG_MAP.get(tier.premium.itemId) ?? null : null,
          hasReward: premHasReward,
          claimed: premClaimed,
          canClaim: unlocked && playerState.premiumUnlocked && premHasReward && !premClaimed,
          lockedByPremium: !playerState.premiumUnlocked,
        },
      };
    });

    const dailyClaimable = missionsBundle.dailyMissions.filter((m) => m.completed && !m.claimed).length;
    const weeklyClaimable = missionsBundle.weeklyChallenges.filter((m) => m.completed && !m.claimed).length;
    const bpFreeClaimable = tiers.filter((t) => t.free.canClaim).length;
    const bpPremClaimable = tiers.filter((t) => t.premium.canClaim).length;

    const pastRowsRes = await db
      .prepare(
        `SELECT s.*, p.season_xp, p.season_level, p.premium_unlocked,
                p.matches_played, p.wins, p.daily_missions_completed, p.weekly_challenges_completed
         FROM battle_pass_seasons s
         LEFT JOIN player_battle_pass p
           ON p.season_id = s.season_id AND p.player_id = ?
         WHERE s.status = 'completed'
         ORDER BY s.season_number DESC
         LIMIT 12`,
      )
      .bind(playerId)
      .all<
        SeasonDbRow & {
          season_xp: number | null;
          season_level: number | null;
          premium_unlocked: number | null;
          matches_played: number | null;
          wins: number | null;
          daily_missions_completed: number | null;
          weekly_challenges_completed: number | null;
        }
      >();

    const pastSeasons = (pastRowsRes.results ?? []).map((r) => ({
      season: this.mapSeasonRow(r),
      seasonXp: Number(r.season_xp ?? 0),
      seasonLevel: Number(r.season_level ?? 0),
      premiumUnlocked: Number(r.premium_unlocked ?? 0) === 1,
      matchesPlayed: Number(r.matches_played ?? 0),
      wins: Number(r.wins ?? 0),
      dailyMissionsCompleted: Number(r.daily_missions_completed ?? 0),
      weeklyChallengesCompleted: Number(r.weekly_challenges_completed ?? 0),
    }));

    return {
      serverNowMs: nowMs,
      season,
      playerState,
      tiers,
      dailyMissions: missionsBundle.dailyMissions,
      weeklyChallenges: missionsBundle.weeklyChallenges,
      dailyResetAtMs: missionsBundle.dailyResetAtMs,
      weeklyResetAtMs: missionsBundle.weeklyResetAtMs,
      claimableCounts: {
        daily: dailyClaimable,
        weekly: weeklyClaimable,
        battlePassFree: bpFreeClaimable,
        battlePassPremium: bpPremClaimable,
        total: dailyClaimable + weeklyClaimable + bpFreeClaimable + bpPremClaimable,
      },
      pastSeasons,
      config: {
        dailyMatchXpCap: BATTLE_PASS_CONFIG.dailyMatchXpCap,
        dailyAiMatchXpCap: BATTLE_PASS_CONFIG.dailyAiMatchXpCap,
        premiumPriceCoins: season.premiumPriceCoins,
        maxLevel: season.maxLevel,
        aiMinShots: BATTLE_PASS_CONFIG.antiAbuse.aiMinShots,
        aiMinDurationSec: BATTLE_PASS_CONFIG.antiAbuse.aiMinDurationSec,
        aiCooldownMs: BATTLE_PASS_CONFIG.antiAbuse.aiCooldownMs,
      },
    };
  }

  public async getOverview(
    playerId: string,
    nowMs: number = Date.now(),
  ): Promise<BattlePassOverview> {
    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      return this.buildOverviewUnlocked(db, playerId, nowMs);
    });
  }

  private async awardSeasonXpUnlocked(params: {
    db: ProgressionSqlDb;
    seasonId: string;
    playerId: string;
    xpRequested: number;
    sourceType: 'online_match' | 'ai_match' | 'daily_mission' | 'weekly_challenge' | 'tournament_bonus';
    idempotencyKey: string;
    respectDailyMatchCap: boolean;
    isAiMatch: boolean;
    metadata?: Record<string, unknown>;
    nowMs: number;
  }): Promise<{
    alreadyProcessed: boolean;
    xpAwarded: number;
    capReached: boolean;
    levelBefore: number;
    levelAfter: number;
  }> {
    const dayWin = getUtcDayWindow(params.nowMs);
    const rowBefore = await this.ensurePlayerRowInternal(
      params.db,
      params.seasonId,
      params.playerId,
      dayWin.dayKey,
      params.nowMs,
    );
    const levelBefore = calculateBattlePassLevelFromXp(rowBefore.season_xp).level;

    let grantXp = Math.max(0, Math.floor(params.xpRequested));
    let capReached = false;

    if (params.respectDailyMatchCap && grantXp > 0) {
      const matchCapRemaining = Math.max(
        0,
        BATTLE_PASS_CONFIG.dailyMatchXpCap - Number(rowBefore.daily_match_xp_earned),
      );
      if (params.isAiMatch) {
        const aiCapRemaining = Math.max(
          0,
          BATTLE_PASS_CONFIG.dailyAiMatchXpCap - Number(rowBefore.daily_ai_xp_earned),
        );
        const allowed = Math.min(grantXp, matchCapRemaining, aiCapRemaining);
        capReached = allowed < grantXp;
        grantXp = allowed;
      } else {
        const allowed = Math.min(grantXp, matchCapRemaining);
        capReached = allowed < grantXp;
        grantXp = allowed;
      }
    }

    const eventInsert = await params.db
      .prepare(
        `INSERT OR IGNORE INTO xp_events (
          event_id, player_id, season_id, source_type, idempotency_key, xp_amount, metadata_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        generateEventId(),
        params.playerId,
        params.seasonId,
        params.sourceType,
        params.idempotencyKey,
        grantXp,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.nowMs,
      )
      .run();

    if ((eventInsert.meta?.changes ?? 0) === 0) {
      return {
        alreadyProcessed: true,
        xpAwarded: 0,
        capReached: false,
        levelBefore,
        levelAfter: levelBefore,
      };
    }

    const nextXp = Math.max(0, Number(rowBefore.season_xp) + grantXp);
    const levelAfter = calculateBattlePassLevelFromXp(nextXp).level;
    const nextDailyMatchXp =
      Number(rowBefore.daily_match_xp_earned) + (params.respectDailyMatchCap ? grantXp : 0);
    const nextDailyAiXp =
      Number(rowBefore.daily_ai_xp_earned) +
      (params.respectDailyMatchCap && params.isAiMatch ? grantXp : 0);

    await params.db
      .prepare(
        `UPDATE player_battle_pass
         SET season_xp = ?, season_level = ?,
             daily_match_xp_earned = ?, daily_ai_xp_earned = ?,
             daily_xp_day_key = ?, updated_at_ms = ?
         WHERE season_id = ? AND player_id = ?`,
      )
      .bind(
        nextXp,
        levelAfter,
        nextDailyMatchXp,
        nextDailyAiXp,
        dayWin.dayKey,
        params.nowMs,
        params.seasonId,
        params.playerId,
      )
      .run();

    return {
      alreadyProcessed: false,
      xpAwarded: grantXp,
      capReached,
      levelBefore,
      levelAfter,
    };
  }

  private async updateMissionsForMatchUnlocked(params: {
    db: ProgressionSqlDb;
    playerId: string;
    isOnline: boolean;
    won: boolean;
    shotsTaken: number;
    ballsPocketed: number;
    foulsCommitted: number;
    legalEightBallWin: boolean;
    validForCleanMatch: boolean;
    upsetHigherElo: boolean;
    newCurrentWinStreak: number;
    nowMs: number;
  }): Promise<string[]> {
    const dayWin = getUtcDayWindow(params.nowMs);
    const weekWin = getUtcWeekWindow(params.nowMs);
    await this.ensureActiveMissionsInternal(params.db, params.playerId, params.nowMs);

    const rowsRes = await params.db
      .prepare(
        `SELECT * FROM player_missions
         WHERE player_id = ?
           AND ((cadence = 'daily' AND period_key = ?) OR (cadence = 'weekly' AND period_key = ?))`,
      )
      .bind(params.playerId, dayWin.dayKey, weekWin.weekKey)
      .all<PlayerMissionDbRow>();

    const completedNow: string[] = [];

    for (const row of rowsRes.results ?? []) {
      const def = MISSION_DEF_MAP.get(row.mission_id);
      if (!def) continue;

      const prevProgress = Number(row.progress);
      const wasCompleted = Number(row.completed) === 1;
      let nextProgress = prevProgress;

      switch (def.metric) {
        case 'matches_played':
          nextProgress = Math.min(def.requiredProgress, prevProgress + 1);
          break;
        case 'matches_won':
          if (params.won) nextProgress = Math.min(def.requiredProgress, prevProgress + 1);
          break;
        case 'online_wins':
          if (params.isOnline && params.won) {
            nextProgress = Math.min(def.requiredProgress, prevProgress + 1);
          }
          break;
        case 'ai_wins':
          if (!params.isOnline && params.won) {
            nextProgress = Math.min(def.requiredProgress, prevProgress + 1);
          }
          break;
        case 'balls_pocketed':
          if (params.ballsPocketed > 0) {
            nextProgress = Math.min(def.requiredProgress, prevProgress + params.ballsPocketed);
          }
          break;
        case 'balls_3_in_match':
          if (params.ballsPocketed >= 3) {
            nextProgress = Math.min(def.requiredProgress, prevProgress + 1);
          }
          break;
        case 'clean_match':
          if (params.validForCleanMatch && params.shotsTaken >= 1 && params.foulsCommitted === 0) {
            nextProgress = Math.min(def.requiredProgress, prevProgress + 1);
          }
          break;
        case 'legal_eight_ball_win':
          if (params.won && params.legalEightBallWin) {
            nextProgress = Math.min(def.requiredProgress, prevProgress + 1);
          }
          break;
        case 'win_streak_3':
          nextProgress = Math.min(
            def.requiredProgress,
            Math.max(prevProgress, params.newCurrentWinStreak),
          );
          break;
        case 'upset_higher_elo':
          if (params.isOnline && params.won && params.upsetHigherElo) {
            nextProgress = Math.min(def.requiredProgress, prevProgress + 1);
          }
          break;
      }

      if (nextProgress === prevProgress) continue;

      const isNowCompleted = nextProgress >= def.requiredProgress;
      const completedFlag = wasCompleted || isNowCompleted ? 1 : 0;
      const completedAtMs = wasCompleted
        ? row.completed_at_ms
        : isNowCompleted
          ? params.nowMs
          : null;

      await params.db
        .prepare(
          `UPDATE player_missions
           SET progress = ?, completed = ?, completed_at_ms = ?, updated_at_ms = ?
           WHERE player_id = ? AND cadence = ? AND period_key = ? AND mission_id = ?`,
        )
        .bind(
          nextProgress,
          completedFlag,
          completedAtMs,
          params.nowMs,
          params.playerId,
          row.cadence,
          row.period_key,
          row.mission_id,
        )
        .run();

      if (!wasCompleted && isNowCompleted) {
        completedNow.push(def.id);
      }
    }

    return completedNow;
  }

  public async recordOnlineMatchProgress(params: {
    matchId: string;
    playerId: string;
    matchType: OnlineMatchType;
    won: boolean;
    rankedValid: boolean;
    totalShotsInMatch: number;
    playerShotsTaken: number;
    ballsPocketed: number;
    foulsCommitted: number;
    legalEightBallWin: boolean;
    durationSec: number;
    playerEloBefore: number;
    opponentEloBefore: number;
    nowMs?: number;
  }): Promise<{
    alreadyRecorded: boolean;
    xpAwarded: number;
    completedMissionIds: string[];
  }> {
    const nowMs = params.nowMs ?? Date.now();
    return this.withPlayerLock(params.playerId, async () => {
      const db = await this.ensureSchema();
      const season = await this.ensureActiveSeasonInternal(db, nowMs);
      const dayWin = getUtcDayWindow(nowMs);
      const rowBefore = await this.ensurePlayerRowInternal(
        db,
        season.seasonId,
        params.playerId,
        dayWin.dayKey,
        nowMs,
      );

      const xpCandidate = computeOnlineMatchSeasonXp({
        matchType: params.matchType,
        won: params.won,
        totalShots: params.totalShotsInMatch,
        durationSec: params.durationSec,
        rankedValid: params.rankedValid,
      });

      const xpRes = await this.awardSeasonXpUnlocked({
        db,
        seasonId: season.seasonId,
        playerId: params.playerId,
        xpRequested: xpCandidate,
        sourceType: 'online_match',
        idempotencyKey: `online_match:${params.matchId}:${params.playerId}`,
        respectDailyMatchCap: true,
        isAiMatch: false,
        metadata: {
          matchId: params.matchId,
          matchType: params.matchType,
          won: params.won,
        },
        nowMs,
      });

      if (xpRes.alreadyProcessed) {
        return { alreadyRecorded: true, xpAwarded: 0, completedMissionIds: [] };
      }

      const validCompetitive =
        params.rankedValid &&
        params.totalShotsInMatch >= BATTLE_PASS_CONFIG.antiAbuse.onlineMinShots;

      if (!validCompetitive) {
        return { alreadyRecorded: false, xpAwarded: xpRes.xpAwarded, completedMissionIds: [] };
      }

      const nextMatches = Number(rowBefore.matches_played) + 1;
      const nextWins = Number(rowBefore.wins) + (params.won ? 1 : 0);
      const nextLosses = Number(rowBefore.losses) + (params.won ? 0 : 1);
      const nextBalls = Number(rowBefore.balls_pocketed) + Math.max(0, Math.floor(params.ballsPocketed));
      const nextStreak = params.won ? Number(rowBefore.current_win_streak) + 1 : 0;
      const nextBestStreak = Math.max(Number(rowBefore.best_win_streak), nextStreak);

      await db
        .prepare(
          `UPDATE player_battle_pass
           SET matches_played = ?, wins = ?, losses = ?, balls_pocketed = ?,
               current_win_streak = ?, best_win_streak = ?, updated_at_ms = ?
           WHERE season_id = ? AND player_id = ?`,
        )
        .bind(
          nextMatches,
          nextWins,
          nextLosses,
          nextBalls,
          nextStreak,
          nextBestStreak,
          nowMs,
          season.seasonId,
          params.playerId,
        )
        .run();

      const completedMissionIds = await this.updateMissionsForMatchUnlocked({
        db,
        playerId: params.playerId,
        isOnline: true,
        won: params.won,
        shotsTaken: Math.max(0, Math.floor(params.playerShotsTaken)),
        ballsPocketed: Math.max(0, Math.floor(params.ballsPocketed)),
        foulsCommitted: Math.max(0, Math.floor(params.foulsCommitted)),
        legalEightBallWin: params.legalEightBallWin,
        validForCleanMatch: true,
        upsetHigherElo: params.opponentEloBefore > params.playerEloBefore,
        newCurrentWinStreak: nextStreak,
        nowMs,
      });

      return {
        alreadyRecorded: false,
        xpAwarded: xpRes.xpAwarded,
        completedMissionIds,
      };
    });
  }

  public async recordTournamentFinish(params: {
    tournamentId: string;
    playerId: string;
    placement: 'champion' | 'runner_up' | 'third_place' | 'participant';
    nowMs?: number;
  }): Promise<{ alreadyRecorded: boolean; xpAwarded: number }> {
    const nowMs = params.nowMs ?? Date.now();
    return this.withPlayerLock(params.playerId, async () => {
      const db = await this.ensureSchema();
      const season = await this.ensureActiveSeasonInternal(db, nowMs);
      const dayWin = getUtcDayWindow(nowMs);
      await this.ensurePlayerRowInternal(db, season.seasonId, params.playerId, dayWin.dayKey, nowMs);

      const bonusXp = BATTLE_PASS_CONFIG.xpRewards.tournamentFinishBonus[params.placement];
      const xpRes = await this.awardSeasonXpUnlocked({
        db,
        seasonId: season.seasonId,
        playerId: params.playerId,
        xpRequested: bonusXp,
        sourceType: 'tournament_bonus',
        idempotencyKey: `tournament_finish:${params.tournamentId}:${params.playerId}`,
        respectDailyMatchCap: false,
        isAiMatch: false,
        metadata: {
          tournamentId: params.tournamentId,
          placement: params.placement,
        },
        nowMs,
      });

      if (!xpRes.alreadyProcessed) {
        await db
          .prepare(
            `UPDATE player_battle_pass
             SET tournaments_played = tournaments_played + 1, updated_at_ms = ?
             WHERE season_id = ? AND player_id = ?`,
          )
          .bind(nowMs, season.seasonId, params.playerId)
          .run();
      }

      return { alreadyRecorded: xpRes.alreadyProcessed, xpAwarded: xpRes.xpAwarded };
    });
  }

  public async recordAiMatchProgress(
    playerId: string,
    req: Partial<AiMatchProgressRequest>,
    nowMs: number = Date.now(),
  ): Promise<AiMatchProgressResponse | BattlePassServiceError> {
    const clientMatchId = typeof req.clientMatchId === 'string' ? req.clientMatchId.trim() : '';
    const difficulty = req.difficulty;
    const won = Boolean(req.won);
    const totalShots = Math.max(0, Math.floor(Number(req.totalShots ?? 0)));
    const ballsPocketed = Math.max(0, Math.min(8, Math.floor(Number(req.ballsPocketed ?? 0))));
    const foulsCommitted = Math.max(0, Math.floor(Number(req.foulsCommitted ?? 0)));
    const legalEightBallWin = Boolean(req.legalEightBallWin) && won;
    const durationSec = Math.max(0, Math.floor(Number(req.durationSec ?? 0)));

    if (!clientMatchId || clientMatchId.length < 6 || clientMatchId.length > 80) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_MATCH_ID',
        message: 'Valid clientMatchId is required.',
      };
    }
    if (!difficulty || !VALID_AI_DIFFICULTIES.has(difficulty)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_DIFFICULTY',
        message: 'Valid AI difficulty is required.',
      };
    }

    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      const season = await this.ensureActiveSeasonInternal(db, nowMs);
      const dayWin = getUtcDayWindow(nowMs);
      const rowBefore = await this.ensurePlayerRowInternal(
        db,
        season.seasonId,
        playerId,
        dayWin.dayKey,
        nowMs,
      );

      // Idempotency check
      const existing = await db
        .prepare('SELECT client_match_id FROM validated_ai_bp_matches WHERE client_match_id = ? LIMIT 1')
        .bind(clientMatchId)
        .first<{ client_match_id: string }>();

      if (existing) {
        const overview = await this.buildOverviewUnlocked(db, playerId, nowMs);
        return {
          ok: true,
          alreadyRecorded: true,
          seasonXpAwarded: 0,
          capReached: false,
          rejectedReason: null,
          completedMissionIds: [],
          leveledUpTo: null,
          overview,
        };
      }

      // Server-authoritative anti-abuse checks
      if (
        totalShots < BATTLE_PASS_CONFIG.antiAbuse.aiMinShots ||
        durationSec < BATTLE_PASS_CONFIG.antiAbuse.aiMinDurationSec
      ) {
        const overview = await this.buildOverviewUnlocked(db, playerId, nowMs);
        return {
          ok: true,
          alreadyRecorded: false,
          seasonXpAwarded: 0,
          capReached: false,
          rejectedReason: 'Match did not meet minimum shot count or duration for progression.',
          completedMissionIds: [],
          leveledUpTo: null,
          overview,
        };
      }

      if (
        rowBefore.last_ai_bp_at_ms !== null &&
        rowBefore.last_ai_bp_at_ms !== undefined &&
        nowMs - Number(rowBefore.last_ai_bp_at_ms) < BATTLE_PASS_CONFIG.antiAbuse.aiCooldownMs
      ) {
        const overview = await this.buildOverviewUnlocked(db, playerId, nowMs);
        return {
          ok: true,
          alreadyRecorded: false,
          seasonXpAwarded: 0,
          capReached: false,
          rejectedReason: 'AI match progression cooldown active. Play full games at normal pace.',
          completedMissionIds: [],
          leveledUpTo: null,
          overview,
        };
      }

      const xpCandidate = computeAiMatchSeasonXp({ difficulty, won });
      const xpRes = await this.awardSeasonXpUnlocked({
        db,
        seasonId: season.seasonId,
        playerId,
        xpRequested: xpCandidate,
        sourceType: 'ai_match',
        idempotencyKey: `ai_match:${clientMatchId}:${playerId}`,
        respectDailyMatchCap: true,
        isAiMatch: true,
        metadata: { clientMatchId, difficulty, won, totalShots, durationSec },
        nowMs,
      });

      await db
        .prepare(
          `INSERT OR IGNORE INTO validated_ai_bp_matches (
            client_match_id, player_id, difficulty, won, xp_awarded, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(clientMatchId, playerId, difficulty, won ? 1 : 0, xpRes.xpAwarded, nowMs)
        .run();

      const nextMatches = Number(rowBefore.matches_played) + 1;
      const nextWins = Number(rowBefore.wins) + (won ? 1 : 0);
      const nextLosses = Number(rowBefore.losses) + (won ? 0 : 1);
      const nextBalls = Number(rowBefore.balls_pocketed) + ballsPocketed;
      const nextStreak = won ? Number(rowBefore.current_win_streak) + 1 : 0;
      const nextBestStreak = Math.max(Number(rowBefore.best_win_streak), nextStreak);

      await db
        .prepare(
          `UPDATE player_battle_pass
           SET matches_played = ?, wins = ?, losses = ?, balls_pocketed = ?,
               current_win_streak = ?, best_win_streak = ?,
               last_ai_bp_at_ms = ?, updated_at_ms = ?
           WHERE season_id = ? AND player_id = ?`,
        )
        .bind(
          nextMatches,
          nextWins,
          nextLosses,
          nextBalls,
          nextStreak,
          nextBestStreak,
          nowMs,
          nowMs,
          season.seasonId,
          playerId,
        )
        .run();

      const completedMissionIds = await this.updateMissionsForMatchUnlocked({
        db,
        playerId,
        isOnline: false,
        won,
        shotsTaken: totalShots,
        ballsPocketed,
        foulsCommitted,
        legalEightBallWin,
        validForCleanMatch: true,
        upsetHigherElo: false,
        newCurrentWinStreak: nextStreak,
        nowMs,
      });

      const overview = await this.buildOverviewUnlocked(db, playerId, nowMs);
      return {
        ok: true,
        alreadyRecorded: false,
        seasonXpAwarded: xpRes.xpAwarded,
        capReached: xpRes.capReached,
        rejectedReason: null,
        completedMissionIds,
        leveledUpTo: xpRes.levelAfter > xpRes.levelBefore ? xpRes.levelAfter : null,
        overview,
      };
    });
  }

  public async claimMission(
    playerId: string,
    input: {
      missionId: string;
      cadence?: MissionCadence;
      periodKey?: string;
    },
    nowMs: number = Date.now(),
  ): Promise<ClaimRewardResponse | BattlePassServiceError> {
    const def = MISSION_DEF_MAP.get(input.missionId);
    if (!def) {
      return {
        ok: false,
        status: 404,
        code: 'MISSION_NOT_FOUND',
        message: 'Unknown mission or challenge ID.',
      };
    }

    const cadence = input.cadence ?? def.cadence;
    if (cadence !== def.cadence) {
      return {
        ok: false,
        status: 400,
        code: 'CADENCE_MISMATCH',
        message: 'Mission cadence mismatch.',
      };
    }

    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      const economy = new EconomyService(this.db);
      const season = await this.ensureActiveSeasonInternal(db, nowMs);
      const dayWin = getUtcDayWindow(nowMs);
      const weekWin = getUtcWeekWindow(nowMs);
      await this.ensurePlayerRowInternal(db, season.seasonId, playerId, dayWin.dayKey, nowMs);
      await this.ensureActiveMissionsInternal(db, playerId, nowMs);

      const expectedPeriodKey = cadence === 'daily' ? dayWin.dayKey : weekWin.weekKey;
      const periodKey =
        typeof input.periodKey === 'string' && input.periodKey.trim()
          ? input.periodKey.trim()
          : expectedPeriodKey;

      const row = await db
        .prepare(
          `SELECT * FROM player_missions
           WHERE player_id = ? AND cadence = ? AND period_key = ? AND mission_id = ?
           LIMIT 1`,
        )
        .bind(playerId, cadence, periodKey, def.id)
        .first<PlayerMissionDbRow>();

      if (!row) {
        return {
          ok: false,
          status: 404,
          code: 'MISSION_NOT_ACTIVE',
          message: 'This mission is not active in the selected period.',
        };
      }

      if (Number(row.completed) !== 1) {
        return {
          ok: false,
          status: 400,
          code: 'MISSION_NOT_COMPLETED',
          message: 'Complete this objective before claiming its reward.',
        };
      }

      const claimUpdate = await db
        .prepare(
          `UPDATE player_missions
           SET claimed = 1, claimed_at_ms = ?, updated_at_ms = ?
           WHERE player_id = ? AND cadence = ? AND period_key = ? AND mission_id = ?
             AND completed = 1 AND claimed = 0`,
        )
        .bind(nowMs, nowMs, playerId, cadence, periodKey, def.id)
        .run();

      if ((claimUpdate.meta?.changes ?? 0) === 0) {
        const [econSnapshot, overview] = await Promise.all([
          economy.getOverview(playerId, nowMs),
          this.buildOverviewUnlocked(db, playerId, nowMs),
        ]);
        return {
          ok: true,
          coinsAwarded: 0,
          seasonXpAwarded: 0,
          grantedItemIds: [],
          alreadyClaimed: true,
          wallet: econSnapshot.wallet,
          inventoryIds: econSnapshot.inventoryIds,
          equipped: econSnapshot.equipped,
          overview,
        };
      }

      const coinRes = await economy.creditCoinsWithIdempotency({
        playerId,
        amount: def.rewardCoins,
        reason: cadence === 'daily' ? 'mission_reward' : 'weekly_challenge_reward',
        referenceType: cadence === 'daily' ? 'daily_mission' : 'weekly_challenge',
        referenceId: `${periodKey}:${def.id}`,
        idempotencyKey: `mission_coins:${cadence}:${periodKey}:${def.id}:${playerId}`,
        metadata: { label: `${def.title} Reward`, missionId: def.id, cadence, periodKey },
        nowMs,
      });

      const xpRes = await this.awardSeasonXpUnlocked({
        db,
        seasonId: season.seasonId,
        playerId,
        xpRequested: def.rewardSeasonXp,
        sourceType: cadence === 'daily' ? 'daily_mission' : 'weekly_challenge',
        idempotencyKey: `mission_xp:${cadence}:${periodKey}:${def.id}:${playerId}`,
        respectDailyMatchCap: false,
        isAiMatch: false,
        metadata: { missionId: def.id, cadence, periodKey },
        nowMs,
      });

      if (cadence === 'daily') {
        await db
          .prepare(
            `UPDATE player_battle_pass
             SET daily_missions_completed = daily_missions_completed + 1, updated_at_ms = ?
             WHERE season_id = ? AND player_id = ?`,
          )
          .bind(nowMs, season.seasonId, playerId)
          .run();
      } else {
        await db
          .prepare(
            `UPDATE player_battle_pass
             SET weekly_challenges_completed = weekly_challenges_completed + 1, updated_at_ms = ?
             WHERE season_id = ? AND player_id = ?`,
          )
          .bind(nowMs, season.seasonId, playerId)
          .run();
      }

      const [econSnapshot, overview] = await Promise.all([
        economy.getOverview(playerId, nowMs),
        this.buildOverviewUnlocked(db, playerId, nowMs),
      ]);

      return {
        ok: true,
        coinsAwarded: coinRes.awarded,
        seasonXpAwarded: xpRes.xpAwarded,
        grantedItemIds: [],
        alreadyClaimed: false,
        wallet: coinRes.wallet,
        inventoryIds: econSnapshot.inventoryIds,
        equipped: econSnapshot.equipped,
        overview,
      };
    });
  }

  public async unlockPremium(
    playerId: string,
    nowMs: number = Date.now(),
  ): Promise<UnlockPremiumResponse | BattlePassServiceError> {
    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      const economy = new EconomyService(this.db);
      const season = await this.ensureActiveSeasonInternal(db, nowMs);
      const dayWin = getUtcDayWindow(nowMs);
      const bpRow = await this.ensurePlayerRowInternal(
        db,
        season.seasonId,
        playerId,
        dayWin.dayKey,
        nowMs,
      );

      if (Number(bpRow.premium_unlocked) === 1) {
        const [econSnapshot, overview] = await Promise.all([
          economy.getOverview(playerId, nowMs),
          this.buildOverviewUnlocked(db, playerId, nowMs),
        ]);
        return {
          ok: true,
          alreadyUnlocked: true,
          pricePaid: 0,
          wallet: econSnapshot.wallet,
          overview,
        };
      }

      const debit = await economy.debitCoinsWithIdempotency({
        playerId,
        amount: season.premiumPriceCoins,
        reason: 'battle_pass_premium',
        referenceType: 'battle_pass',
        referenceId: season.seasonId,
        idempotencyKey: `bp_premium:${season.seasonId}:${playerId}`,
        insufficientMessage: `You need ${season.premiumPriceCoins} POOL COINS to unlock the Premium Battle Pass.`,
        metadata: { label: `${season.name} — Premium Pass`, seasonId: season.seasonId },
        nowMs,
      });

      if (!debit.ok) {
        return debit;
      }

      await db
        .prepare(
          `UPDATE player_battle_pass
           SET premium_unlocked = 1, premium_unlocked_at_ms = ?, updated_at_ms = ?
           WHERE season_id = ? AND player_id = ?`,
        )
        .bind(nowMs, nowMs, season.seasonId, playerId)
        .run();

      const overview = await this.buildOverviewUnlocked(db, playerId, nowMs);
      return {
        ok: true,
        alreadyUnlocked: false,
        pricePaid: debit.charged,
        wallet: debit.wallet,
        overview,
      };
    });
  }

  private async claimTierInternal(params: {
    db: ProgressionSqlDb;
    economy: EconomyService;
    season: BattlePassSeasonRecord;
    bpRow: PlayerBattlePassDbRow;
    playerId: string;
    level: number;
    track: BattlePassTrack;
    nowMs: number;
  }): Promise<
    | {
        ok: true;
        alreadyClaimed: boolean;
        coinsAwarded: number;
        grantedItemId: string | null;
      }
    | BattlePassServiceError
  > {
    if (!Number.isInteger(params.level) || params.level < 1 || params.level > params.season.maxLevel) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_TIER',
        message: 'Invalid Battle Pass tier level.',
      };
    }

    const tierDef = BATTLE_PASS_TIERS[params.level - 1];
    const rewardSpec = tierDef[params.track];
    if (rewardSpec.coins <= 0 && !rewardSpec.itemId) {
      return {
        ok: false,
        status: 400,
        code: 'NO_REWARD_AT_TIER',
        message: 'This tier slot has no reward.',
      };
    }

    const currentLevel = calculateBattlePassLevelFromXp(params.bpRow.season_xp).level;
    if (currentLevel < params.level) {
      return {
        ok: false,
        status: 400,
        code: 'TIER_LOCKED',
        message: `Reach Battle Pass Level ${params.level} to unlock this reward.`,
      };
    }

    if (params.track === 'premium' && Number(params.bpRow.premium_unlocked) !== 1) {
      return {
        ok: false,
        status: 403,
        code: 'PREMIUM_REQUIRED',
        message: 'Unlock the Premium Battle Pass to claim Premium track rewards.',
      };
    }

    const insertRes = await params.db
      .prepare(
        `INSERT OR IGNORE INTO battle_pass_claims (
          season_id, player_id, level, track, coins_awarded, item_id, claimed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.season.seasonId,
        params.playerId,
        params.level,
        params.track,
        rewardSpec.coins,
        rewardSpec.itemId,
        params.nowMs,
      )
      .run();

    if ((insertRes.meta?.changes ?? 0) === 0) {
      return { ok: true, alreadyClaimed: true, coinsAwarded: 0, grantedItemId: null };
    }

    let coinsAwarded = 0;
    if (rewardSpec.coins > 0) {
      const coinRes = await params.economy.creditCoinsWithIdempotency({
        playerId: params.playerId,
        amount: rewardSpec.coins,
        reason: 'battle_pass_reward',
        referenceType: 'battle_pass_tier',
        referenceId: `${params.season.seasonId}:L${params.level}:${params.track}`,
        idempotencyKey: `bp_tier_coins:${params.season.seasonId}:${params.level}:${params.track}:${params.playerId}`,
        metadata: {
          label: `${params.season.name} Tier ${params.level} (${params.track})`,
          seasonId: params.season.seasonId,
          level: params.level,
          track: params.track,
        },
        nowMs: params.nowMs,
      });
      coinsAwarded = coinRes.awarded;
    }

    let grantedItemId: string | null = null;
    if (rewardSpec.itemId) {
      await params.economy.grantExclusiveCosmetic(
        params.playerId,
        rewardSpec.itemId,
        'battle_pass_reward',
        params.nowMs,
      );
      grantedItemId = rewardSpec.itemId;
    }

    return {
      ok: true,
      alreadyClaimed: false,
      coinsAwarded,
      grantedItemId,
    };
  }

  public async claimTierReward(
    playerId: string,
    input: { level: number; track: BattlePassTrack },
    nowMs: number = Date.now(),
  ): Promise<ClaimRewardResponse | BattlePassServiceError> {
    if (input.track !== 'free' && input.track !== 'premium') {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_TRACK',
        message: 'Track must be free or premium.',
      };
    }

    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      const economy = new EconomyService(this.db);
      const season = await this.ensureActiveSeasonInternal(db, nowMs);
      const dayWin = getUtcDayWindow(nowMs);
      const bpRow = await this.ensurePlayerRowInternal(
        db,
        season.seasonId,
        playerId,
        dayWin.dayKey,
        nowMs,
      );

      const res = await this.claimTierInternal({
        db,
        economy,
        season,
        bpRow,
        playerId,
        level: Number(input.level),
        track: input.track,
        nowMs,
      });
      if (!res.ok) return res;

      const [econSnapshot, overview] = await Promise.all([
        economy.getOverview(playerId, nowMs),
        this.buildOverviewUnlocked(db, playerId, nowMs),
      ]);

      return {
        ok: true,
        coinsAwarded: res.coinsAwarded,
        seasonXpAwarded: 0,
        grantedItemIds: res.grantedItemId ? [res.grantedItemId] : [],
        alreadyClaimed: res.alreadyClaimed,
        wallet: econSnapshot.wallet,
        inventoryIds: econSnapshot.inventoryIds,
        equipped: econSnapshot.equipped,
        overview,
      };
    });
  }

  public async claimAllAvailable(
    playerId: string,
    nowMs: number = Date.now(),
  ): Promise<ClaimRewardResponse> {
    return this.withPlayerLock(playerId, async () => {
      const db = await this.ensureSchema();
      const economy = new EconomyService(this.db);
      const initialOverview = await this.buildOverviewUnlocked(db, playerId, nowMs);

      let totalCoins = 0;
      let totalSeasonXp = 0;
      const grantedItemIds: string[] = [];

      // 1. Claim completed daily missions & weekly challenges first (their XP can unlock more Battle Pass tiers!)
      const pendingMissions = [
        ...initialOverview.dailyMissions,
        ...initialOverview.weeklyChallenges,
      ].filter((m) => m.completed && !m.claimed);

      for (const m of pendingMissions) {
        const claimUpdate = await db
          .prepare(
            `UPDATE player_missions
             SET claimed = 1, claimed_at_ms = ?, updated_at_ms = ?
             WHERE player_id = ? AND cadence = ? AND period_key = ? AND mission_id = ?
               AND completed = 1 AND claimed = 0`,
          )
          .bind(nowMs, nowMs, playerId, m.cadence, m.periodKey, m.missionId)
          .run();

        if ((claimUpdate.meta?.changes ?? 0) === 1) {
          const coinRes = await economy.creditCoinsWithIdempotency({
            playerId,
            amount: m.rewardCoins,
            reason: m.cadence === 'daily' ? 'mission_reward' : 'weekly_challenge_reward',
            referenceType: m.cadence === 'daily' ? 'daily_mission' : 'weekly_challenge',
            referenceId: `${m.periodKey}:${m.missionId}`,
            idempotencyKey: `mission_coins:${m.cadence}:${m.periodKey}:${m.missionId}:${playerId}`,
            metadata: { label: `${m.title} Reward`, missionId: m.missionId, cadence: m.cadence },
            nowMs,
          });
          totalCoins += coinRes.awarded;

          const xpRes = await this.awardSeasonXpUnlocked({
            db,
            seasonId: initialOverview.season.seasonId,
            playerId,
            xpRequested: m.rewardSeasonXp,
            sourceType: m.cadence === 'daily' ? 'daily_mission' : 'weekly_challenge',
            idempotencyKey: `mission_xp:${m.cadence}:${m.periodKey}:${m.missionId}:${playerId}`,
            respectDailyMatchCap: false,
            isAiMatch: false,
            metadata: { missionId: m.missionId, cadence: m.cadence },
            nowMs,
          });
          totalSeasonXp += xpRes.xpAwarded;

          await db
            .prepare(
              m.cadence === 'daily'
                ? `UPDATE player_battle_pass
                   SET daily_missions_completed = daily_missions_completed + 1, updated_at_ms = ?
                   WHERE season_id = ? AND player_id = ?`
                : `UPDATE player_battle_pass
                   SET weekly_challenges_completed = weekly_challenges_completed + 1, updated_at_ms = ?
                   WHERE season_id = ? AND player_id = ?`,
            )
            .bind(nowMs, initialOverview.season.seasonId, playerId)
            .run();
        }
      }

      // 2. Refresh overview so newly unlocked tiers from mission XP are included
      const refreshedOverview = await this.buildOverviewUnlocked(db, playerId, nowMs);
      const dayWin = getUtcDayWindow(nowMs);
      const bpRow = await this.ensurePlayerRowInternal(
        db,
        refreshedOverview.season.seasonId,
        playerId,
        dayWin.dayKey,
        nowMs,
      );

      for (const tier of refreshedOverview.tiers) {
        if (tier.free.canClaim) {
          const r = await this.claimTierInternal({
            db,
            economy,
            season: refreshedOverview.season,
            bpRow,
            playerId,
            level: tier.level,
            track: 'free',
            nowMs,
          });
          if (r.ok && !r.alreadyClaimed) {
            totalCoins += r.coinsAwarded;
            if (r.grantedItemId) grantedItemIds.push(r.grantedItemId);
          }
        }
        if (tier.premium.canClaim) {
          const r = await this.claimTierInternal({
            db,
            economy,
            season: refreshedOverview.season,
            bpRow,
            playerId,
            level: tier.level,
            track: 'premium',
            nowMs,
          });
          if (r.ok && !r.alreadyClaimed) {
            totalCoins += r.coinsAwarded;
            if (r.grantedItemId) grantedItemIds.push(r.grantedItemId);
          }
        }
      }

      const [econSnapshot, finalOverview] = await Promise.all([
        economy.getOverview(playerId, nowMs),
        this.buildOverviewUnlocked(db, playerId, nowMs),
      ]);

      return {
        ok: true,
        coinsAwarded: totalCoins,
        seasonXpAwarded: totalSeasonXp,
        grantedItemIds,
        alreadyClaimed: totalCoins === 0 && totalSeasonXp === 0 && grantedItemIds.length === 0,
        wallet: econSnapshot.wallet,
        inventoryIds: econSnapshot.inventoryIds,
        equipped: econSnapshot.equipped,
        overview: finalOverview,
      };
    });
  }
}
