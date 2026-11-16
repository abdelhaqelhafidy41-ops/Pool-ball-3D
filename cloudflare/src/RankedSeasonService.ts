import type { PlayerId } from '../../src/game/rules/types';
import {
  calculateEloUpdate,
  type LeaderboardEntry,
  type LeaderboardResponse,
} from '../../src/multiplayer/shared/progression';
import {
  calculateSoftResetElo,
  detectRankTransition,
  getRankById,
  getRankForElo,
  getRankProgress,
  SEASON_CONFIG,
  type CompetitiveSeasonRecord,
  type CompetitiveSeasonStatus,
  type PlayerSeasonStanding,
  type RankTierId,
  type RankTransitionInfo,
} from '../../src/multiplayer/shared/ranked';
import type { ProgressionSqlDb } from './D1ProgressionService';
import { EconomyService } from './EconomyService';

export const RANKED_SEASON_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS competitive_seasons (
    season_id TEXT PRIMARY KEY,
    season_number INTEGER UNIQUE NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    starts_at_ms INTEGER NOT NULL,
    ends_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    soft_reset_anchor INTEGER NOT NULL DEFAULT 1200,
    soft_reset_factor REAL NOT NULL DEFAULT 0.5,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS player_season_stats (
    season_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    season_elo INTEGER NOT NULL DEFAULT 1200,
    peak_season_elo INTEGER NOT NULL DEFAULT 1200,
    highest_rank_tier TEXT NOT NULL DEFAULT 'silver',
    matches_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    current_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    reward_claimed INTEGER NOT NULL DEFAULT 0,
    reward_coins INTEGER NOT NULL DEFAULT 0,
    reward_badge_title TEXT,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (season_id, player_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ranked_matchmaking_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT 'global',
    wait_ms INTEGER NOT NULL,
    elo_gap INTEGER NOT NULL DEFAULT 0,
    matched_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_competitive_seasons_status ON competitive_seasons (status, season_number DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_player_season_stats_lb ON player_season_stats (season_id, season_elo DESC, wins DESC, matches_played ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_ranked_metrics_mode_time ON ranked_matchmaking_metrics (mode, matched_at_ms DESC)`,
];

interface SeasonDbRow {
  season_id: string;
  season_number: number;
  name: string;
  status: string;
  starts_at_ms: number;
  ends_at_ms: number;
  completed_at_ms: number | null;
  soft_reset_anchor: number;
  soft_reset_factor: number;
  created_at_ms: number;
}

interface PlayerSeasonDbRow {
  season_id: string;
  player_id: string;
  season_elo: number;
  peak_season_elo: number;
  highest_rank_tier: string;
  matches_played: number;
  wins: number;
  losses: number;
  current_streak: number;
  best_streak: number;
  reward_claimed: number;
  reward_coins: number;
  reward_badge_title: string | null;
  updated_at_ms: number;
}

const DEFAULT_SEASON_NAMES = [
  'Season 1 — Proving Grounds',
  'Season 2 — Diamond Circuit',
  'Season 3 — Emerald Crown',
  'Season 4 — Grandmaster Invitational',
];

function defaultSeasonName(num: number): string {
  return DEFAULT_SEASON_NAMES[num - 1] ?? `Season ${num} — Championship`;
}

export class RankedSeasonService {
  private static readonly bootstrappedDbs = new WeakSet<object>();
  private readonly economy: EconomyService;

  constructor(private readonly db: ProgressionSqlDb | D1Database | undefined) {
    this.economy = new EconomyService(db);
  }

  public async ensureSchema(): Promise<ProgressionSqlDb> {
    if (!this.db) {
      throw new Error('Ranked season database is not configured.');
    }
    const db = this.db as unknown as ProgressionSqlDb;
    if (!RankedSeasonService.bootstrappedDbs.has(this.db)) {
      for (const stmt of RANKED_SEASON_SCHEMA_STATEMENTS) {
        await db.prepare(stmt).run();
      }
      RankedSeasonService.bootstrappedDbs.add(this.db);
    }
    return db;
  }

  private mapSeason(row: SeasonDbRow, participantCount?: number): CompetitiveSeasonRecord {
    return {
      seasonId: String(row.season_id),
      seasonNumber: Number(row.season_number),
      name: String(row.name),
      status: String(row.status) as CompetitiveSeasonStatus,
      startsAtMs: Number(row.starts_at_ms),
      endsAtMs: Number(row.ends_at_ms),
      completedAtMs: row.completed_at_ms !== null && row.completed_at_ms !== undefined
        ? Number(row.completed_at_ms)
        : null,
      softResetAnchor: Number(row.soft_reset_anchor),
      softResetFactor: Number(row.soft_reset_factor),
      participantCount,
    };
  }

  public async ensureActiveSeason(nowMs: number = Date.now()): Promise<CompetitiveSeasonRecord> {
    const db = await this.ensureSchema();
    const existing = await db
      .prepare(`SELECT * FROM competitive_seasons WHERE status = 'active' ORDER BY season_number DESC LIMIT 1`)
      .first<SeasonDbRow>();

    if (existing) {
      if (Number(existing.ends_at_ms) <= nowMs) {
        const rolled = await this.rolloverSeason({ nowMs });
        return rolled.newSeason;
      }
      return this.mapSeason(existing);
    }

    const latest = await db
      .prepare(`SELECT * FROM competitive_seasons ORDER BY season_number DESC LIMIT 1`)
      .first<SeasonDbRow>();

    const nextNum = latest ? Number(latest.season_number) + 1 : 1;
    const seasonId = `season_${nextNum}`;
    const durationMs = SEASON_CONFIG.defaultDurationDays * 86_400_000;
    await db
      .prepare(
        `INSERT OR IGNORE INTO competitive_seasons (
          season_id, season_number, name, status, starts_at_ms, ends_at_ms,
          completed_at_ms, soft_reset_anchor, soft_reset_factor, created_at_ms
        ) VALUES (?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?)`,
      )
      .bind(
        seasonId,
        nextNum,
        defaultSeasonName(nextNum),
        nowMs,
        nowMs + durationMs,
        SEASON_CONFIG.softResetAnchor,
        SEASON_CONFIG.softResetFactor,
        nowMs,
      )
      .run();

    const created = (await db
      .prepare(`SELECT * FROM competitive_seasons WHERE status = 'active' ORDER BY season_number DESC LIMIT 1`)
      .first<SeasonDbRow>())!;
    return this.mapSeason(created);
  }

  public async listSeasons(nowMs: number = Date.now()): Promise<{
    activeSeason: CompetitiveSeasonRecord;
    seasons: CompetitiveSeasonRecord[];
  }> {
    const db = await this.ensureSchema();
    const active = await this.ensureActiveSeason(nowMs);
    const rows = await db
      .prepare(
        `SELECT s.*, (
           SELECT COUNT(*) FROM player_season_stats p WHERE p.season_id = s.season_id
         ) AS participant_count
         FROM competitive_seasons s
         ORDER BY s.season_number DESC
         LIMIT 24`,
      )
      .all<SeasonDbRow & { participant_count: number }>();

    const seasons = (rows.results ?? []).map((r) =>
      this.mapSeason(r, Number(r.participant_count ?? 0)),
    );
    return { activeSeason: active, seasons };
  }

  public async ensurePlayerSeasonRow(
    db: ProgressionSqlDb,
    seasonId: string,
    playerId: string,
    initialElo: number = SEASON_CONFIG.softResetAnchor,
    nowMs: number = Date.now(),
  ): Promise<PlayerSeasonDbRow> {
    const existing = await db
      .prepare('SELECT * FROM player_season_stats WHERE season_id = ? AND player_id = ? LIMIT 1')
      .bind(seasonId, playerId)
      .first<PlayerSeasonDbRow>();
    if (existing) return existing;

    const safeElo = Math.max(SEASON_CONFIG.minElo, Math.round(initialElo));
    const tier = getRankForElo(safeElo).id;
    await db
      .prepare(
        `INSERT OR IGNORE INTO player_season_stats (
          season_id, player_id, season_elo, peak_season_elo, highest_rank_tier,
          matches_played, wins, losses, current_streak, best_streak,
          reward_claimed, reward_coins, reward_badge_title, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, NULL, ?)`,
      )
      .bind(seasonId, playerId, safeElo, safeElo, tier, nowMs)
      .run();

    return (await db
      .prepare('SELECT * FROM player_season_stats WHERE season_id = ? AND player_id = ? LIMIT 1')
      .bind(seasonId, playerId)
      .first<PlayerSeasonDbRow>())!;
  }

  public async recordRankedMatchForSeason(params: {
    player1Id: string;
    player2Id: string;
    winnerRole: PlayerId;
    endedAtMs: number;
  }): Promise<{
    season: CompetitiveSeasonRecord;
    player1Before: number;
    player1After: number;
    player1Delta: number;
    player1Transition: RankTransitionInfo;
    player2Before: number;
    player2After: number;
    player2Delta: number;
    player2Transition: RankTransitionInfo;
  }> {
    const db = await this.ensureSchema();
    const season = await this.ensureActiveSeason(params.endedAtMs);

    const p1Season = await this.ensurePlayerSeasonRow(
      db,
      season.seasonId,
      params.player1Id,
      SEASON_CONFIG.softResetAnchor,
      params.endedAtMs,
    );
    const p2Season = await this.ensurePlayerSeasonRow(
      db,
      season.seasonId,
      params.player2Id,
      SEASON_CONFIG.softResetAnchor,
      params.endedAtMs,
    );

    const p1Before = Number(p1Season.season_elo);
    const p2Before = Number(p2Season.season_elo);

    const eloRes = calculateEloUpdate({
      player1Elo: p1Before,
      player2Elo: p2Before,
      player1Matches: Number(p1Season.matches_played),
      player2Matches: Number(p2Season.matches_played),
      winnerRole: params.winnerRole,
    });

    const p1Won = params.winnerRole === 'player1';
    const p2Won = params.winnerRole === 'player2';

    const p1Peak = Math.max(Number(p1Season.peak_season_elo), eloRes.player1After);
    const p2Peak = Math.max(Number(p2Season.peak_season_elo), eloRes.player2After);

    const p1PrevHighest = getRankById(p1Season.highest_rank_tier);
    const p1CurrTier = getRankForElo(eloRes.player1After);
    const p1HighestTier: RankTierId =
      p1CurrTier.tierIndex > p1PrevHighest.tierIndex ? p1CurrTier.id : p1PrevHighest.id;

    const p2PrevHighest = getRankById(p2Season.highest_rank_tier);
    const p2CurrTier = getRankForElo(eloRes.player2After);
    const p2HighestTier: RankTierId =
      p2CurrTier.tierIndex > p2PrevHighest.tierIndex ? p2CurrTier.id : p2PrevHighest.id;

    const p1Streak = p1Won ? Number(p1Season.current_streak) + 1 : 0;
    const p2Streak = p2Won ? Number(p2Season.current_streak) + 1 : 0;
    const p1Best = Math.max(Number(p1Season.best_streak), p1Streak);
    const p2Best = Math.max(Number(p2Season.best_streak), p2Streak);

    await db
      .prepare(
        `UPDATE player_season_stats
         SET season_elo = ?, peak_season_elo = ?, highest_rank_tier = ?,
             matches_played = matches_played + 1,
             wins = wins + ?, losses = losses + ?,
             current_streak = ?, best_streak = ?, updated_at_ms = ?
         WHERE season_id = ? AND player_id = ?`,
      )
      .bind(
        eloRes.player1After,
        p1Peak,
        p1HighestTier,
        p1Won ? 1 : 0,
        p1Won ? 0 : 1,
        p1Streak,
        p1Best,
        params.endedAtMs,
        season.seasonId,
        params.player1Id,
      )
      .run();

    await db
      .prepare(
        `UPDATE player_season_stats
         SET season_elo = ?, peak_season_elo = ?, highest_rank_tier = ?,
             matches_played = matches_played + 1,
             wins = wins + ?, losses = losses + ?,
             current_streak = ?, best_streak = ?, updated_at_ms = ?
         WHERE season_id = ? AND player_id = ?`,
      )
      .bind(
        eloRes.player2After,
        p2Peak,
        p2HighestTier,
        p2Won ? 1 : 0,
        p2Won ? 0 : 1,
        p2Streak,
        p2Best,
        params.endedAtMs,
        season.seasonId,
        params.player2Id,
      )
      .run();

    return {
      season,
      player1Before: p1Before,
      player1After: eloRes.player1After,
      player1Delta: eloRes.player1Delta,
      player1Transition: detectRankTransition(p1Before, eloRes.player1After),
      player2Before: p2Before,
      player2After: eloRes.player2After,
      player2Delta: eloRes.player2Delta,
      player2Transition: detectRankTransition(p2Before, eloRes.player2After),
    };
  }

  public async rolloverSeason(options?: {
    nowMs?: number;
    newSeasonName?: string;
    newDurationDays?: number;
    softResetAnchor?: number;
    softResetFactor?: number;
  }): Promise<{
    previousSeason: CompetitiveSeasonRecord;
    newSeason: CompetitiveSeasonRecord;
    rewardsDistributedCount: number;
    playersResetCount: number;
  }> {
    const db = await this.ensureSchema();
    const now = options?.nowMs ?? Date.now();
    const anchor = options?.softResetAnchor ?? SEASON_CONFIG.softResetAnchor;
    const factor = options?.softResetFactor ?? SEASON_CONFIG.softResetFactor;
    const durationDays = Math.max(1, options?.newDurationDays ?? SEASON_CONFIG.defaultDurationDays);

    const activeRow = await db
      .prepare(`SELECT * FROM competitive_seasons WHERE status = 'active' ORDER BY season_number DESC LIMIT 1`)
      .first<SeasonDbRow>();

    let previousSeason: CompetitiveSeasonRecord;
    let nextSeasonNum = 1;
    let prevRows: PlayerSeasonDbRow[] = [];
    let rewardsDistributedCount = 0;

    if (activeRow) {
      previousSeason = this.mapSeason(activeRow);
      nextSeasonNum = previousSeason.seasonNumber + 1;

      await db
        .prepare(
          `UPDATE competitive_seasons
           SET status = 'completed', completed_at_ms = ?
           WHERE season_id = ?`,
        )
        .bind(now, previousSeason.seasonId)
        .run();

      const statsResult = await db
        .prepare(`SELECT * FROM player_season_stats WHERE season_id = ?`)
        .bind(previousSeason.seasonId)
        .all<PlayerSeasonDbRow>();
      prevRows = statsResult.results ?? [];

      for (const row of prevRows) {
        if (Number(row.matches_played) > 0 && Number(row.reward_claimed) === 0) {
          const tier = getRankById(row.highest_rank_tier);
          const reward = SEASON_CONFIG.rewardsByTier[tier.id];
          const awardRes = await this.economy.awardSeasonCoins({
            seasonId: previousSeason.seasonId,
            seasonName: previousSeason.name,
            playerId: String(row.player_id),
            highestTier: tier.id,
            badgeTitle: reward.badgeTitle,
            amount: reward.coins,
            awardedAtMs: now,
          });
          await db
            .prepare(
              `UPDATE player_season_stats
               SET reward_claimed = 1, reward_coins = ?, reward_badge_title = ?, updated_at_ms = ?
               WHERE season_id = ? AND player_id = ?`,
            )
            .bind(
              awardRes.coinsAwarded > 0 ? awardRes.coinsAwarded : reward.coins,
              reward.badgeTitle,
              now,
              previousSeason.seasonId,
              row.player_id,
            )
            .run();
          if (awardRes.coinsAwarded > 0) {
            rewardsDistributedCount++;
          }
        }
      }
      previousSeason.status = 'completed';
      previousSeason.completedAtMs = now;
    } else {
      const dummy = await this.ensureActiveSeason(now);
      previousSeason = dummy;
      nextSeasonNum = dummy.seasonNumber + 1;
    }

    const newSeasonId = `season_${nextSeasonNum}`;
    const newSeasonName = options?.newSeasonName?.trim() || defaultSeasonName(nextSeasonNum);
    const endsAtMs = now + durationDays * 86_400_000;

    await db
      .prepare(
        `INSERT OR REPLACE INTO competitive_seasons (
          season_id, season_number, name, status, starts_at_ms, ends_at_ms,
          completed_at_ms, soft_reset_anchor, soft_reset_factor, created_at_ms
        ) VALUES (?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?)`,
      )
      .bind(newSeasonId, nextSeasonNum, newSeasonName, now, endsAtMs, anchor, factor, now)
      .run();

    let playersResetCount = 0;
    for (const prev of prevRows) {
      const resetElo = calculateSoftResetElo(Number(prev.season_elo), anchor, factor);
      const resetTier = getRankForElo(resetElo).id;
      await db
        .prepare(
          `INSERT OR IGNORE INTO player_season_stats (
            season_id, player_id, season_elo, peak_season_elo, highest_rank_tier,
            matches_played, wins, losses, current_streak, best_streak,
            reward_claimed, reward_coins, reward_badge_title, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, NULL, ?)`,
        )
        .bind(newSeasonId, prev.player_id, resetElo, resetElo, resetTier, now)
        .run();
      playersResetCount++;
    }

    const newRow = (await db
      .prepare('SELECT * FROM competitive_seasons WHERE season_id = ? LIMIT 1')
      .bind(newSeasonId)
      .first<SeasonDbRow>())!;

    return {
      previousSeason,
      newSeason: this.mapSeason(newRow),
      rewardsDistributedCount,
      playersResetCount,
    };
  }

  public async getPlayerSeasonStanding(
    playerId: string,
    seasonId?: string | null,
    nowMs: number = Date.now(),
  ): Promise<PlayerSeasonStanding | null> {
    const db = await this.ensureSchema();
    const active = await this.ensureActiveSeason(nowMs);
    const targetSeasonId = seasonId || active.seasonId;

    const seasonRow = await db
      .prepare('SELECT * FROM competitive_seasons WHERE season_id = ? LIMIT 1')
      .bind(targetSeasonId)
      .first<SeasonDbRow>();
    if (!seasonRow) return null;

    let statsRow = await db
      .prepare('SELECT * FROM player_season_stats WHERE season_id = ? AND player_id = ? LIMIT 1')
      .bind(targetSeasonId, playerId)
      .first<PlayerSeasonDbRow>();

    if (!statsRow && targetSeasonId === active.seasonId) {
      statsRow = await this.ensurePlayerSeasonRow(
        db,
        targetSeasonId,
        playerId,
        SEASON_CONFIG.softResetAnchor,
        nowMs,
      );
    }
    if (!statsRow) return null;

    const rankRow = await db
      .prepare(
        `SELECT COUNT(*) + 1 AS rank_pos
         FROM player_season_stats
         WHERE season_id = ? AND (
           season_elo > ?
           OR (season_elo = ? AND wins > ?)
         )`,
      )
      .bind(targetSeasonId, statsRow.season_elo, statsRow.season_elo, statsRow.wins)
      .first<{ rank_pos: number }>();

    const elo = Number(statsRow.season_elo);
    const matches = Number(statsRow.matches_played);
    const wins = Number(statsRow.wins);

    return {
      seasonId: String(seasonRow.season_id),
      seasonNumber: Number(seasonRow.season_number),
      seasonName: String(seasonRow.name),
      playerId,
      seasonElo: elo,
      peakSeasonElo: Number(statsRow.peak_season_elo),
      highestRankTier: getRankById(statsRow.highest_rank_tier).id,
      currentRankTier: getRankForElo(elo),
      rankProgress: getRankProgress(elo),
      matchesPlayed: matches,
      wins,
      losses: Number(statsRow.losses),
      winRate: matches > 0 ? Math.round((wins / matches) * 1000) / 10 : 0,
      currentStreak: Number(statsRow.current_streak),
      bestStreak: Number(statsRow.best_streak),
      leaderboardRank: matches > 0 ? Number(rankRow?.rank_pos ?? 1) : null,
      rewardClaimed: Number(statsRow.reward_claimed) === 1,
      rewardCoins: Number(statsRow.reward_coins ?? 0),
      rewardBadgeTitle: statsRow.reward_badge_title ? String(statsRow.reward_badge_title) : null,
    };
  }

  public async getSeasonLeaderboard(params: {
    seasonId?: string | null;
    page?: number;
    limit?: number;
    query?: string;
    currentPlayerId?: string | null;
    nowMs?: number;
  }): Promise<LeaderboardResponse> {
    const db = await this.ensureSchema();
    const now = params.nowMs ?? Date.now();
    const active = await this.ensureActiveSeason(now);
    const targetSeasonId = params.seasonId || active.seasonId;

    const seasonRow = await db
      .prepare('SELECT * FROM competitive_seasons WHERE season_id = ? LIMIT 1')
      .bind(targetSeasonId)
      .first<SeasonDbRow>();
    const seasonRecord = seasonRow ? this.mapSeason(seasonRow) : active;

    const page = Math.max(1, Math.floor(params.page ?? 1));
    const limit = Math.max(5, Math.min(50, Math.floor(params.limit ?? 20)));
    const offset = (page - 1) * limit;
    const search = params.query?.trim().toLowerCase() ?? '';
    const like = search ? `%${search}%` : '';

    const whereClause = search
      ? `WHERE s.season_id = ? AND (LOWER(p.display_name) LIKE ? OR LOWER(COALESCE(p.username, '')) LIKE ? OR LOWER(p.player_id) LIKE ?)`
      : `WHERE s.season_id = ?`;
    const binds = search ? [targetSeasonId, like, like, like] : [targetSeasonId];

    const countRow = await db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM player_season_stats s
         JOIN players p ON p.player_id = s.player_id
         ${whereClause}`,
      )
      .bind(...binds)
      .first<{ total: number }>();

    const total = Number(countRow?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const rows = await db
      .prepare(
        `SELECT s.*, p.username, p.display_name, p.avatar_id, p.is_guest, p.level
         FROM player_season_stats s
         JOIN players p ON p.player_id = s.player_id
         ${whereClause}
         ORDER BY s.season_elo DESC, s.wins DESC, s.matches_played ASC, s.updated_at_ms ASC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all<
        PlayerSeasonDbRow & {
          username: string | null;
          display_name: string;
          avatar_id: string;
          is_guest: number;
          level: number;
        }
      >();

    const items: LeaderboardEntry[] = (rows.results ?? []).map((r, idx) => {
      const elo = Number(r.season_elo);
      const matches = Number(r.matches_played);
      const wins = Number(r.wins);
      return {
        rank: offset + idx + 1,
        playerId: String(r.player_id),
        username: r.username ? String(r.username) : null,
        displayName: String(r.display_name),
        avatarId: String(r.avatar_id),
        isGuest: Number(r.is_guest) === 1,
        elo,
        rankTier: getRankForElo(elo),
        periodDelta: elo - SEASON_CONFIG.softResetAnchor,
        level: Number(r.level ?? 1),
        wins,
        losses: Number(r.losses),
        totalMatches: matches,
        winRate: matches > 0 ? Math.round((wins / matches) * 1000) / 10 : 0,
        currentStreak: Number(r.current_streak ?? 0),
      };
    });

    let currentPlayer: LeaderboardEntry | null = null;
    if (params.currentPlayerId) {
      const meRow = await db
        .prepare(
          `SELECT s.*, p.username, p.display_name, p.avatar_id, p.is_guest, p.level
           FROM player_season_stats s
           JOIN players p ON p.player_id = s.player_id
           WHERE s.season_id = ? AND s.player_id = ?
           LIMIT 1`,
        )
        .bind(targetSeasonId, params.currentPlayerId)
        .first<
          PlayerSeasonDbRow & {
            username: string | null;
            display_name: string;
            avatar_id: string;
            is_guest: number;
            level: number;
          }
        >();

      if (meRow) {
        const rankRow = await db
          .prepare(
            `SELECT COUNT(*) + 1 AS rank_pos
             FROM player_season_stats
             WHERE season_id = ? AND (season_elo > ? OR (season_elo = ? AND wins > ?))`,
          )
          .bind(targetSeasonId, meRow.season_elo, meRow.season_elo, meRow.wins)
          .first<{ rank_pos: number }>();

        const elo = Number(meRow.season_elo);
        const matches = Number(meRow.matches_played);
        const wins = Number(meRow.wins);
        currentPlayer = {
          rank: Number(rankRow?.rank_pos ?? 1),
          playerId: String(meRow.player_id),
          username: meRow.username ? String(meRow.username) : null,
          displayName: String(meRow.display_name),
          avatarId: String(meRow.avatar_id),
          isGuest: Number(meRow.is_guest) === 1,
          elo,
          rankTier: getRankForElo(elo),
          periodDelta: elo - SEASON_CONFIG.softResetAnchor,
          level: Number(meRow.level ?? 1),
          wins,
          losses: Number(meRow.losses),
          totalMatches: matches,
          winRate: matches > 0 ? Math.round((wins / matches) * 1000) / 10 : 0,
          currentStreak: Number(meRow.current_streak ?? 0),
        };
      }
    }

    return {
      scope: 'season',
      page,
      limit,
      total,
      totalPages,
      items,
      currentPlayer,
      season: seasonRecord,
    };
  }
}
