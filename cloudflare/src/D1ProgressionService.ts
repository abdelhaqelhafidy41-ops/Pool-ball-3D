import type { PlayerId, RuleProfileId } from '../../src/game/rules/types';
import {
  constantTimeEqual,
  generatePlayerId,
  generateRandomHexToken,
  hashPasswordPBKDF2,
  isValidPlayerIdFormat,
  sanitizeAvatarId,
  sanitizeDisplayName,
  sha256Hex,
  validatePassword,
  validateUsername,
  verifyPasswordPBKDF2,
} from '../../src/multiplayer/shared/authCrypto';
import {
  ACHIEVEMENT_MAP,
  calculateEloUpdate,
  calculateLevelFromXp,
  computeBaseMatchXp,
  ELO_CONFIG,
  evaluateUnlockedAchievements,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type LeaderboardScope,
  type MatchProgressionRewardSummary,
  type MatchTelemetrySummaryForProgression,
  type OnlineMatchType,
  type PlayerProgressionDelta,
  type PlayerSearchResult,
  type PublicPlayerProfile,
  type UnlockedAchievement,
} from '../../src/multiplayer/shared/progression';
import type { MatchHistoryRecord, OnlineAvatarId } from '../../src/multiplayer/shared/protocol';

interface PlayerDbRow {
  player_id: string;
  username: string | null;
  username_lower: string | null;
  display_name: string;
  avatar_id: string;
  password_hash: string | null;
  auth_token_hash: string;
  is_guest: number;
  elo: number;
  peak_elo: number;
  xp: number;
  level: number;
  total_matches: number;
  wins: number;
  losses: number;
  current_streak: number;
  best_streak: number;
  total_shots: number;
  successful_shots: number;
  balls_pocketed: number;
  fouls: number;
  breaks_attempted: number;
  breaks_successful: number;
  eight_ball_wins: number;
  total_match_duration_sec: number;
  casual_matches: number;
  casual_wins: number;
  wpa_matches: number;
  wpa_wins: number;
  quick_matches: number;
  quick_wins: number;
  private_matches: number;
  private_wins: number;
  created_at_ms: number;
  updated_at_ms: number;
  last_match_at_ms: number | null;
}

interface UnlockedAchievementRow {
  achievement_id: string;
  unlocked_at_ms: number;
}

export interface AuthSessionResult {
  ok: true;
  playerId: string;
  playerToken: string;
  profile: PublicPlayerProfile;
}

export type ServiceMutationError = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS players (
    player_id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    username_lower TEXT UNIQUE,
    display_name TEXT NOT NULL,
    avatar_id TEXT NOT NULL DEFAULT 'cue_gold',
    password_hash TEXT,
    auth_token_hash TEXT NOT NULL,
    is_guest INTEGER NOT NULL DEFAULT 1,
    elo INTEGER NOT NULL DEFAULT 1200,
    peak_elo INTEGER NOT NULL DEFAULT 1200,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    total_matches INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    current_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    total_shots INTEGER NOT NULL DEFAULT 0,
    successful_shots INTEGER NOT NULL DEFAULT 0,
    balls_pocketed INTEGER NOT NULL DEFAULT 0,
    fouls INTEGER NOT NULL DEFAULT 0,
    breaks_attempted INTEGER NOT NULL DEFAULT 0,
    breaks_successful INTEGER NOT NULL DEFAULT 0,
    eight_ball_wins INTEGER NOT NULL DEFAULT 0,
    total_match_duration_sec INTEGER NOT NULL DEFAULT 0,
    casual_matches INTEGER NOT NULL DEFAULT 0,
    casual_wins INTEGER NOT NULL DEFAULT 0,
    wpa_matches INTEGER NOT NULL DEFAULT 0,
    wpa_wins INTEGER NOT NULL DEFAULT 0,
    quick_matches INTEGER NOT NULL DEFAULT 0,
    quick_wins INTEGER NOT NULL DEFAULT 0,
    private_matches INTEGER NOT NULL DEFAULT 0,
    private_wins INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    last_match_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS matches (
    match_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    room_code TEXT NOT NULL,
    player1_id TEXT NOT NULL,
    player2_id TEXT NOT NULL,
    player1_name TEXT NOT NULL,
    player2_name TEXT NOT NULL,
    player1_avatar TEXT NOT NULL DEFAULT 'cue_gold',
    player2_avatar TEXT NOT NULL DEFAULT 'cue_gold',
    winner_id TEXT,
    winner_name TEXT NOT NULL,
    winner_role TEXT NOT NULL,
    rule_profile_id TEXT NOT NULL,
    match_type TEXT NOT NULL,
    completion_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    ranked_applied INTEGER NOT NULL DEFAULT 1,
    total_shots INTEGER NOT NULL DEFAULT 0,
    duration_sec INTEGER NOT NULL DEFAULT 0,
    p1_elo_before INTEGER NOT NULL DEFAULT 1200,
    p1_elo_after INTEGER NOT NULL DEFAULT 1200,
    p1_elo_delta INTEGER NOT NULL DEFAULT 0,
    p2_elo_before INTEGER NOT NULL DEFAULT 1200,
    p2_elo_after INTEGER NOT NULL DEFAULT 1200,
    p2_elo_delta INTEGER NOT NULL DEFAULT 0,
    p1_xp_gained INTEGER NOT NULL DEFAULT 0,
    p2_xp_gained INTEGER NOT NULL DEFAULT 0,
    ended_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS player_achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_at_ms INTEGER NOT NULL,
    match_id TEXT,
    UNIQUE(player_id, achievement_id)
  )`,
  `CREATE TABLE IF NOT EXISTS rating_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    elo_before INTEGER NOT NULL,
    elo_after INTEGER NOT NULL,
    elo_delta INTEGER NOT NULL,
    xp_gained INTEGER NOT NULL DEFAULT 0,
    won INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    UNIQUE(match_id, player_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_players_leaderboard ON players (elo DESC, wins DESC, total_matches ASC, created_at_ms ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_players_username_lower ON players (username_lower)`,
  `CREATE INDEX IF NOT EXISTS idx_players_display_name ON players (display_name COLLATE NOCASE)`,
  `CREATE INDEX IF NOT EXISTS idx_matches_ended_at ON matches (ended_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_matches_player1 ON matches (player1_id, ended_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_matches_player2 ON matches (player2_id, ended_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_achievements_player ON player_achievements (player_id, unlocked_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rating_events_window ON rating_events (created_at_ms, player_id)`,
];

export interface ProgressionPreparedStatement {
  bind(...values: unknown[]): ProgressionPreparedStatement;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

export interface ProgressionSqlDb {
  prepare(sql: string): ProgressionPreparedStatement;
}

export function createDurableObjectSqlDb(sqlStorage: SqlStorage): ProgressionSqlDb {
  const buildStmt = (query: string, params: unknown[] = []): ProgressionPreparedStatement => ({
    bind(...values: unknown[]) {
      return buildStmt(query, values);
    },
    async run() {
      const cursor = sqlStorage.exec(query, ...params);
      cursor.toArray();
      return { meta: { changes: cursor.rowsWritten } };
    },
    async first<T = Record<string, unknown>>() {
      const cursor = sqlStorage.exec<Record<string, SqlStorageValue>>(query, ...params);
      const rows = cursor.toArray();
      return (rows[0] as T | undefined) ?? null;
    },
    async all<T = Record<string, unknown>>() {
      const cursor = sqlStorage.exec<Record<string, SqlStorageValue>>(query, ...params);
      return { results: cursor.toArray() as T[] };
    },
  });

  return {
    prepare(query: string) {
      return buildStmt(query);
    },
  };
}

export class D1ProgressionService {
  private static readonly bootstrappedDbs = new WeakSet<object>();

  constructor(private readonly db: ProgressionSqlDb | D1Database | undefined) {}

  public isAvailable(): boolean {
    return Boolean(this.db);
  }

  private async ensureSchema(): Promise<ProgressionSqlDb> {
    if (!this.db) {
      throw new Error('Progression database is not configured.');
    }
    const db = this.db as unknown as ProgressionSqlDb;
    if (!D1ProgressionService.bootstrappedDbs.has(this.db)) {
      for (const stmt of SCHEMA_STATEMENTS) {
        await db.prepare(stmt).run();
      }
      D1ProgressionService.bootstrappedDbs.add(this.db);
    }
    return db;
  }

  public async authenticateOrCreatePlayer(input: {
    playerId?: string | null;
    playerToken?: string | null;
    displayName?: string | null;
    avatarId?: string | null;
    forceNewGuest?: boolean;
  }): Promise<AuthSessionResult | ServiceMutationError> {
    const db = await this.ensureSchema();
    const safeName = sanitizeDisplayName(input.displayName);
    const safeAvatar = sanitizeAvatarId(input.avatarId);

    if (
      !input.forceNewGuest &&
      isValidPlayerIdFormat(input.playerId) &&
      typeof input.playerToken === 'string' &&
      input.playerToken.length >= 16
    ) {
      const existing = await db
        .prepare('SELECT * FROM players WHERE player_id = ? LIMIT 1')
        .bind(input.playerId.trim())
        .first<PlayerDbRow>();

      if (existing) {
        const providedHash = await sha256Hex(input.playerToken.trim());
        if (constantTimeEqual(providedHash, existing.auth_token_hash)) {
          if (
            (input.displayName && safeName !== existing.display_name) ||
            (input.avatarId && safeAvatar !== existing.avatar_id)
          ) {
            await db
              .prepare(
                'UPDATE players SET display_name = ?, avatar_id = ?, updated_at_ms = ? WHERE player_id = ?',
              )
              .bind(
                input.displayName ? safeName : existing.display_name,
                input.avatarId ? safeAvatar : existing.avatar_id,
                Date.now(),
                existing.player_id,
              )
              .run();
          }
          const profile = await this.getPublicProfile(existing.player_id);
          if (profile) {
            return {
              ok: true,
              playerId: existing.player_id,
              playerToken: input.playerToken.trim(),
              profile,
            };
          }
        }
      }
    }

    const now = Date.now();
    const playerId = generatePlayerId();
    const playerToken = generateRandomHexToken(24);
    const tokenHash = await sha256Hex(playerToken);

    await db
      .prepare(
        `INSERT INTO players (
          player_id, display_name, avatar_id, auth_token_hash, is_guest,
          elo, peak_elo, xp, level, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 1, ?, ?, 0, 1, ?, ?)`,
      )
      .bind(
        playerId,
        safeName,
        safeAvatar,
        tokenHash,
        ELO_CONFIG.initialElo,
        ELO_CONFIG.initialElo,
        now,
        now,
      )
      .run();

    const profile = (await this.getPublicProfile(playerId))!;
    return {
      ok: true,
      playerId,
      playerToken,
      profile,
    };
  }

  public async ensureRowForExternalId(
    playerId: string,
    displayName: string,
    avatarId: OnlineAvatarId,
  ): Promise<PlayerDbRow> {
    const db = await this.ensureSchema();
    const existing = await db
      .prepare('SELECT * FROM players WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<PlayerDbRow>();
    if (existing) return existing;

    const now = Date.now();
    const tokenHash = await sha256Hex(generateRandomHexToken(24));
    await db
      .prepare(
        `INSERT OR IGNORE INTO players (
          player_id, display_name, avatar_id, auth_token_hash, is_guest,
          elo, peak_elo, xp, level, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 1, ?, ?, 0, 1, ?, ?)`,
      )
      .bind(
        playerId,
        sanitizeDisplayName(displayName),
        sanitizeAvatarId(avatarId),
        tokenHash,
        ELO_CONFIG.initialElo,
        ELO_CONFIG.initialElo,
        now,
        now,
      )
      .run();

    return (await db
      .prepare('SELECT * FROM players WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<PlayerDbRow>())!;
  }

  public async verifyPlayerToken(playerId: string, playerToken: string): Promise<boolean> {
    if (!isValidPlayerIdFormat(playerId) || typeof playerToken !== 'string' || playerToken.length < 16) {
      return false;
    }
    const db = await this.ensureSchema();
    const row = await db
      .prepare('SELECT auth_token_hash FROM players WHERE player_id = ? LIMIT 1')
      .bind(playerId.trim())
      .first<{ auth_token_hash: string }>();
    if (!row) return false;
    const providedHash = await sha256Hex(playerToken.trim());
    return constantTimeEqual(providedHash, row.auth_token_hash);
  }

  public async updatePlayerProfile(
    playerId: string,
    playerToken: string,
    updates: { displayName?: unknown; avatarId?: unknown },
  ): Promise<{ ok: true; profile: PublicPlayerProfile } | ServiceMutationError> {
    const db = await this.ensureSchema();
    const authorized = await this.verifyPlayerToken(playerId, playerToken);
    if (!authorized) {
      return {
        ok: false,
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing player credentials.',
      };
    }

    const existing = await db
      .prepare('SELECT * FROM players WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<PlayerDbRow>();
    if (!existing) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Player profile not found.' };
    }

    const nextName =
      updates.displayName !== undefined
        ? sanitizeDisplayName(updates.displayName)
        : existing.display_name;
    const nextAvatar =
      updates.avatarId !== undefined ? sanitizeAvatarId(updates.avatarId) : existing.avatar_id;

    await db
      .prepare(
        'UPDATE players SET display_name = ?, avatar_id = ?, updated_at_ms = ? WHERE player_id = ?',
      )
      .bind(nextName, nextAvatar, Date.now(), playerId)
      .run();

    const profile = (await this.getPublicProfile(playerId))!;
    return { ok: true, profile };
  }

  public async registerAccount(
    playerId: string,
    playerToken: string,
    input: {
      username: unknown;
      password: unknown;
      displayName?: unknown;
      avatarId?: unknown;
    },
  ): Promise<AuthSessionResult | ServiceMutationError> {
    const db = await this.ensureSchema();
    const authorized = await this.verifyPlayerToken(playerId, playerToken);
    if (!authorized) {
      return {
        ok: false,
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authenticate your active session before claiming a username.',
      };
    }

    const userCheck = validateUsername(input.username);
    if (!userCheck.valid) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: userCheck.error };
    }
    const passCheck = validatePassword(input.password);
    if (!passCheck.valid) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: passCheck.error };
    }

    const taken = await db
      .prepare('SELECT player_id FROM players WHERE username_lower = ? LIMIT 1')
      .bind(userCheck.usernameLower)
      .first<{ player_id: string }>();
    if (taken && taken.player_id !== playerId) {
      return {
        ok: false,
        status: 409,
        code: 'USERNAME_TAKEN',
        message: 'That username is already registered to another competitor.',
      };
    }

    const existing = await db
      .prepare('SELECT * FROM players WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<PlayerDbRow>();
    if (!existing) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Player profile not found.' };
    }
    if (existing.is_guest === 0 && existing.username_lower && existing.username_lower !== userCheck.usernameLower) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_REGISTERED',
        message: 'This account already has a registered username.',
      };
    }

    const passwordHash = await hashPasswordPBKDF2(passCheck.password);
    const nextToken = generateRandomHexToken(24);
    const nextTokenHash = await sha256Hex(nextToken);
    const nextDisplayName =
      input.displayName !== undefined
        ? sanitizeDisplayName(input.displayName)
        : existing.display_name === 'Player'
          ? sanitizeDisplayName(userCheck.username)
          : existing.display_name;
    const nextAvatar =
      input.avatarId !== undefined ? sanitizeAvatarId(input.avatarId) : existing.avatar_id;

    try {
      await db
        .prepare(
          `UPDATE players
           SET username = ?, username_lower = ?, display_name = ?, avatar_id = ?,
               password_hash = ?, auth_token_hash = ?, is_guest = 0, updated_at_ms = ?
           WHERE player_id = ?`,
        )
        .bind(
          userCheck.username,
          userCheck.usernameLower,
          nextDisplayName,
          nextAvatar,
          passwordHash,
          nextTokenHash,
          Date.now(),
          playerId,
        )
        .run();
    } catch {
      return {
        ok: false,
        status: 409,
        code: 'USERNAME_TAKEN',
        message: 'That username is already registered.',
      };
    }

    const profile = (await this.getPublicProfile(playerId))!;
    return {
      ok: true,
      playerId,
      playerToken: nextToken,
      profile,
    };
  }

  public async loginAccount(input: {
    username: unknown;
    password: unknown;
  }): Promise<AuthSessionResult | ServiceMutationError> {
    const db = await this.ensureSchema();
    const userCheck = validateUsername(input.username);
    if (!userCheck.valid) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: userCheck.error };
    }
    if (typeof input.password !== 'string' || input.password.length === 0) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Password is required.' };
    }

    const row = await db
      .prepare('SELECT * FROM players WHERE username_lower = ? LIMIT 1')
      .bind(userCheck.usernameLower)
      .first<PlayerDbRow>();
    if (!row || !row.password_hash) {
      return {
        ok: false,
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password.',
      };
    }

    const validPass = await verifyPasswordPBKDF2(input.password, row.password_hash);
    if (!validPass) {
      return {
        ok: false,
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password.',
      };
    }

    const freshToken = generateRandomHexToken(24);
    const freshHash = await sha256Hex(freshToken);
    await db
      .prepare('UPDATE players SET auth_token_hash = ?, updated_at_ms = ? WHERE player_id = ?')
      .bind(freshHash, Date.now(), row.player_id)
      .run();

    const profile = (await this.getPublicProfile(row.player_id))!;
    return {
      ok: true,
      playerId: row.player_id,
      playerToken: freshToken,
      profile,
    };
  }

  public async getPublicProfile(playerId: string): Promise<PublicPlayerProfile | null> {
    if (!isValidPlayerIdFormat(playerId)) return null;
    const db = await this.ensureSchema();
    const row = await db
      .prepare('SELECT * FROM players WHERE player_id = ? LIMIT 1')
      .bind(playerId.trim())
      .first<PlayerDbRow>();
    if (!row) return null;

    const rankRow = await db
      .prepare(
        `SELECT COUNT(*) AS higher_count FROM players
         WHERE elo > ?
            OR (elo = ? AND wins > ?)
            OR (elo = ? AND wins = ? AND total_matches < ?)
            OR (elo = ? AND wins = ? AND total_matches = ? AND created_at_ms < ?)`,
      )
      .bind(
        row.elo,
        row.elo,
        row.wins,
        row.elo,
        row.wins,
        row.total_matches,
        row.elo,
        row.wins,
        row.total_matches,
        row.created_at_ms,
      )
      .first<{ higher_count: number }>();

    const achRows = await db
      .prepare(
        'SELECT achievement_id, unlocked_at_ms FROM player_achievements WHERE player_id = ? ORDER BY unlocked_at_ms DESC',
      )
      .bind(row.player_id)
      .all<UnlockedAchievementRow>();

    const achievements: UnlockedAchievement[] = [];
    for (const a of achRows.results ?? []) {
      const def = ACHIEVEMENT_MAP.get(a.achievement_id);
      if (def) {
        achievements.push({
          ...def,
          unlockedAtMs: Number(a.unlocked_at_ms),
        });
      }
    }

    return this.mapRowToPublicProfile(row, Number(rankRow?.higher_count ?? 0) + 1, achievements);
  }

  public async searchPlayers(query: string, limit = 15): Promise<PlayerSearchResult[]> {
    const db = await this.ensureSchema();
    const cleaned = query.trim().toLowerCase().slice(0, 32);
    const safeLimit = Math.max(1, Math.min(30, limit));

    if (!cleaned) {
      const top = await db
        .prepare(
          `SELECT player_id, username, display_name, avatar_id, elo, level, wins, total_matches
           FROM players ORDER BY elo DESC, wins DESC LIMIT ?`,
        )
        .bind(safeLimit)
        .all<Record<string, unknown>>();
      return (top.results ?? []).map((r) => ({
        playerId: String(r.player_id),
        username: r.username ? String(r.username) : null,
        displayName: String(r.display_name),
        avatarId: String(r.avatar_id),
        elo: Number(r.elo),
        level: Number(r.level),
        wins: Number(r.wins),
        totalMatches: Number(r.total_matches),
      }));
    }

    const likePattern = `%${cleaned.replace(/[%_]/g, '')}%`;
    const rows = await db
      .prepare(
        `SELECT player_id, username, display_name, avatar_id, elo, level, wins, total_matches
         FROM players
         WHERE username_lower LIKE ? OR LOWER(display_name) LIKE ? OR player_id = ?
         ORDER BY elo DESC, wins DESC
         LIMIT ?`,
      )
      .bind(likePattern, likePattern, query.trim(), safeLimit)
      .all<Record<string, unknown>>();

    return (rows.results ?? []).map((r) => ({
      playerId: String(r.player_id),
      username: r.username ? String(r.username) : null,
      displayName: String(r.display_name),
      avatarId: String(r.avatar_id),
      elo: Number(r.elo),
      level: Number(r.level),
      wins: Number(r.wins),
      totalMatches: Number(r.total_matches),
    }));
  }

  public async getLeaderboard(params: {
    scope: LeaderboardScope;
    page?: number;
    limit?: number;
    query?: string;
    currentPlayerId?: string | null;
  }): Promise<LeaderboardResponse> {
    const db = await this.ensureSchema();
    const page = Math.max(1, Math.floor(params.page ?? 1));
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 20)));
    const offset = (page - 1) * limit;
    const searchClean = (params.query ?? '').trim().toLowerCase().replace(/[%_]/g, '');
    const hasSearch = searchClean.length > 0;
    const likePattern = `%${searchClean}%`;

    if (params.scope === 'global') {
      const whereClause = hasSearch
        ? 'WHERE username_lower LIKE ? OR LOWER(display_name) LIKE ?'
        : '';
      const countRes = hasSearch
        ? await db
            .prepare(`SELECT COUNT(*) AS c FROM players ${whereClause}`)
            .bind(likePattern, likePattern)
            .first<{ c: number }>()
        : await db.prepare('SELECT COUNT(*) AS c FROM players').first<{ c: number }>();
      const total = Number(countRes?.c ?? 0);
      const totalPages = Math.max(1, Math.ceil(total / limit));

      const sql = `
        SELECT player_id, username, display_name, avatar_id, is_guest, elo, level, wins, losses, total_matches
        FROM players
        ${whereClause}
        ORDER BY elo DESC, wins DESC, total_matches ASC, created_at_ms ASC
        LIMIT ? OFFSET ?`;

      const rows = hasSearch
        ? await db.prepare(sql).bind(likePattern, likePattern, limit, offset).all<Record<string, unknown>>()
        : await db.prepare(sql).bind(limit, offset).all<Record<string, unknown>>();

      const items: LeaderboardEntry[] = (rows.results ?? []).map((r, idx) => {
        const totalMatches = Number(r.total_matches);
        const wins = Number(r.wins);
        return {
          rank: offset + idx + 1,
          playerId: String(r.player_id),
          username: r.username ? String(r.username) : null,
          displayName: String(r.display_name),
          avatarId: String(r.avatar_id),
          isGuest: Number(r.is_guest) === 1,
          elo: Number(r.elo),
          periodDelta: 0,
          level: Number(r.level),
          wins,
          losses: Number(r.losses),
          totalMatches,
          winRate: totalMatches > 0 ? Math.round((wins / totalMatches) * 1000) / 10 : 0,
        };
      });

      let currentPlayer: LeaderboardEntry | null = null;
      if (params.currentPlayerId && isValidPlayerIdFormat(params.currentPlayerId)) {
        const curProfile = await this.getPublicProfile(params.currentPlayerId);
        if (curProfile && curProfile.rank !== null) {
          currentPlayer = {
            rank: curProfile.rank,
            playerId: curProfile.playerId,
            username: curProfile.username,
            displayName: curProfile.displayName,
            avatarId: curProfile.avatarId,
            isGuest: curProfile.isGuest,
            elo: curProfile.elo,
            periodDelta: 0,
            level: curProfile.level,
            wins: curProfile.stats.wins,
            losses: curProfile.stats.losses,
            totalMatches: curProfile.stats.totalMatches,
            winRate: curProfile.stats.winRate,
          };
        }
      }

      return { scope: params.scope, page, limit, total, totalPages, items, currentPlayer };
    }

    // Weekly (7d) or Monthly (30d) based on rating_events window
    const windowMs = params.scope === 'weekly' ? 7 * 86400_000 : 30 * 86400_000;
    const cutoffMs = Date.now() - windowMs;
    const searchCond = hasSearch
      ? 'AND (p.username_lower LIKE ? OR LOWER(p.display_name) LIKE ?)'
      : '';

    const countSql = `
      SELECT COUNT(DISTINCT p.player_id) AS c
      FROM rating_events re
      JOIN players p ON p.player_id = re.player_id
      WHERE re.created_at_ms >= ? ${searchCond}`;

    const countRes = hasSearch
      ? await db.prepare(countSql).bind(cutoffMs, likePattern, likePattern).first<{ c: number }>()
      : await db.prepare(countSql).bind(cutoffMs).first<{ c: number }>();

    const total = Number(countRes?.c ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const dataSql = `
      SELECT
        p.player_id, p.username, p.display_name, p.avatar_id, p.is_guest, p.elo, p.level,
        SUM(re.elo_delta) AS period_delta,
        SUM(re.won) AS period_wins,
        COUNT(*) AS period_matches
      FROM rating_events re
      JOIN players p ON p.player_id = re.player_id
      WHERE re.created_at_ms >= ? ${searchCond}
      GROUP BY p.player_id
      ORDER BY period_delta DESC, period_wins DESC, p.elo DESC
      LIMIT ? OFFSET ?`;

    const rows = hasSearch
      ? await db
          .prepare(dataSql)
          .bind(cutoffMs, likePattern, likePattern, limit, offset)
          .all<Record<string, unknown>>()
      : await db.prepare(dataSql).bind(cutoffMs, limit, offset).all<Record<string, unknown>>();

    const items: LeaderboardEntry[] = (rows.results ?? []).map((r, idx) => {
      const periodMatches = Number(r.period_matches);
      const periodWins = Number(r.period_wins);
      return {
        rank: offset + idx + 1,
        playerId: String(r.player_id),
        username: r.username ? String(r.username) : null,
        displayName: String(r.display_name),
        avatarId: String(r.avatar_id),
        isGuest: Number(r.is_guest) === 1,
        elo: Number(r.elo),
        periodDelta: Number(r.period_delta),
        level: Number(r.level),
        wins: periodWins,
        losses: Math.max(0, periodMatches - periodWins),
        totalMatches: periodMatches,
        winRate: periodMatches > 0 ? Math.round((periodWins / periodMatches) * 1000) / 10 : 0,
      };
    });

    let currentPlayer: LeaderboardEntry | null = null;
    if (params.currentPlayerId && isValidPlayerIdFormat(params.currentPlayerId)) {
      const existingInList = items.find((i) => i.playerId === params.currentPlayerId);
      if (existingInList) {
        currentPlayer = existingInList;
      } else {
        const curRow = await db
          .prepare(
            `SELECT
              p.player_id, p.username, p.display_name, p.avatar_id, p.is_guest, p.elo, p.level,
              COALESCE(SUM(re.elo_delta), 0) AS period_delta,
              COALESCE(SUM(re.won), 0) AS period_wins,
              COUNT(re.id) AS period_matches
             FROM players p
             LEFT JOIN rating_events re ON re.player_id = p.player_id AND re.created_at_ms >= ?
             WHERE p.player_id = ?
             GROUP BY p.player_id`,
          )
          .bind(cutoffMs, params.currentPlayerId)
          .first<Record<string, unknown>>();

        if (curRow && Number(curRow.period_matches) > 0) {
          const periodDelta = Number(curRow.period_delta);
          const periodWins = Number(curRow.period_wins);
          const periodMatches = Number(curRow.period_matches);
          const curElo = Number(curRow.elo);
          const higher = await db
            .prepare(
              `SELECT COUNT(*) AS c FROM (
                 SELECT p2.player_id, SUM(re2.elo_delta) AS pd, SUM(re2.won) AS pw, p2.elo AS pe
                 FROM rating_events re2
                 JOIN players p2 ON p2.player_id = re2.player_id
                 WHERE re2.created_at_ms >= ?
                 GROUP BY p2.player_id
                 HAVING pd > ? OR (pd = ? AND pw > ?) OR (pd = ? AND pw = ? AND pe > ?)
               )`,
            )
            .bind(cutoffMs, periodDelta, periodDelta, periodWins, periodDelta, periodWins, curElo)
            .first<{ c: number }>();
          currentPlayer = {
            rank: Number(higher?.c ?? 0) + 1,
            playerId: String(curRow.player_id),
            username: curRow.username ? String(curRow.username) : null,
            displayName: String(curRow.display_name),
            avatarId: String(curRow.avatar_id),
            isGuest: Number(curRow.is_guest) === 1,
            elo: curElo,
            periodDelta,
            level: Number(curRow.level),
            wins: periodWins,
            losses: Math.max(0, periodMatches - periodWins),
            totalMatches: periodMatches,
            winRate: periodMatches > 0 ? Math.round((periodWins / periodMatches) * 1000) / 10 : 0,
          };
        }
      }
    }

    return { scope: params.scope, page, limit, total, totalPages, items, currentPlayer };
  }

  public async getMatchHistory(params: {
    playerId?: string | null;
    limit?: number;
  }): Promise<MatchHistoryRecord[]> {
    const db = await this.ensureSchema();
    const safeLimit = Math.max(1, Math.min(100, Math.floor(params.limit ?? 30)));
    const hasPlayer = Boolean(params.playerId && isValidPlayerIdFormat(params.playerId));

    const sql = hasPlayer
      ? `SELECT * FROM matches WHERE player1_id = ? OR player2_id = ? ORDER BY ended_at_ms DESC LIMIT ?`
      : `SELECT * FROM matches ORDER BY ended_at_ms DESC LIMIT ?`;

    const rows = hasPlayer
      ? await db
          .prepare(sql)
          .bind(params.playerId!.trim(), params.playerId!.trim(), safeLimit)
          .all<Record<string, unknown>>()
      : await db.prepare(sql).bind(safeLimit).all<Record<string, unknown>>();

    return (rows.results ?? []).map((r) => ({
      matchId: String(r.match_id),
      roomId: String(r.room_id),
      player1Id: String(r.player1_id),
      player2Id: String(r.player2_id),
      player1Name: String(r.player1_name),
      player2Name: String(r.player2_name),
      player1Avatar: sanitizeAvatarId(r.player1_avatar),
      player2Avatar: sanitizeAvatarId(r.player2_avatar),
      winnerId: r.winner_id ? String(r.winner_id) : null,
      winnerName: String(r.winner_name),
      winnerRole: r.winner_role === 'player2' ? 'player2' : 'player1',
      ruleProfileId: r.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
      matchType: r.match_type === 'private' ? 'private' : 'quick',
      completionType: String(r.completion_type) as MatchHistoryRecord['completionType'],
      rankedApplied: Number(r.ranked_applied) === 1,
      p1EloDelta: Number(r.p1_elo_delta),
      p2EloDelta: Number(r.p2_elo_delta),
      durationSec: Number(r.duration_sec),
      reason: String(r.reason),
      totalShots: Number(r.total_shots),
      endedAtMs: Number(r.ended_at_ms),
    }));
  }

  public async recordCompletedMatch(input: {
    matchId: string;
    roomId: string;
    roomCode: string;
    ruleProfileId: RuleProfileId;
    matchType: OnlineMatchType;
    winnerRole: PlayerId;
    reason: string;
    totalShots: number;
    endedAtMs: number;
    player1: { playerId: string; displayName: string; avatarId: OnlineAvatarId };
    player2: { playerId: string; displayName: string; avatarId: OnlineAvatarId };
    telemetry: MatchTelemetrySummaryForProgression;
  }): Promise<{
    alreadyRecorded: boolean;
    summary: MatchProgressionRewardSummary;
  }> {
    const db = await this.ensureSchema();

    const p1Row = await this.ensureRowForExternalId(
      input.player1.playerId,
      input.player1.displayName,
      input.player1.avatarId,
    );
    const p2Row = await this.ensureRowForExternalId(
      input.player2.playerId,
      input.player2.displayName,
      input.player2.avatarId,
    );

    const sameAccount = p1Row.player_id === p2Row.player_id;
    const rankedApplied = input.telemetry.rankedValid && !sameAccount;
    const winnerId =
      input.winnerRole === 'player1' ? p1Row.player_id : p2Row.player_id;
    const winnerName =
      input.winnerRole === 'player1' ? p1Row.display_name : p2Row.display_name;

    const eloCalc = rankedApplied
      ? calculateEloUpdate({
          player1Elo: p1Row.elo,
          player2Elo: p2Row.elo,
          player1Matches: p1Row.total_matches,
          player2Matches: p2Row.total_matches,
          winnerRole: input.winnerRole,
        })
      : {
          player1After: p1Row.elo,
          player2After: p2Row.elo,
          player1Delta: 0,
          player2Delta: 0,
        };

    // Atomic idempotency guard: INSERT OR IGNORE on PRIMARY KEY match_id
    const insertMatch = await db
      .prepare(
        `INSERT OR IGNORE INTO matches (
          match_id, room_id, room_code, player1_id, player2_id,
          player1_name, player2_name, player1_avatar, player2_avatar,
          winner_id, winner_name, winner_role, rule_profile_id, match_type,
          completion_type, reason, ranked_applied, total_shots, duration_sec,
          p1_elo_before, p1_elo_after, p1_elo_delta,
          p2_elo_before, p2_elo_after, p2_elo_delta,
          p1_xp_gained, p2_xp_gained, ended_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      )
      .bind(
        input.matchId,
        input.roomId,
        input.roomCode,
        p1Row.player_id,
        p2Row.player_id,
        sanitizeDisplayName(input.player1.displayName),
        sanitizeDisplayName(input.player2.displayName),
        sanitizeAvatarId(input.player1.avatarId),
        sanitizeAvatarId(input.player2.avatarId),
        winnerId,
        winnerName,
        input.winnerRole,
        input.ruleProfileId,
        input.matchType,
        input.telemetry.completionType,
        input.reason,
        rankedApplied ? 1 : 0,
        input.totalShots,
        input.telemetry.durationSec,
        p1Row.elo,
        eloCalc.player1After,
        eloCalc.player1Delta,
        p2Row.elo,
        eloCalc.player2After,
        eloCalc.player2Delta,
        input.endedAtMs,
      )
      .run();

    if ((insertMatch.meta?.changes ?? 0) === 0) {
      // Match already persisted by a concurrent or earlier call
      return {
        alreadyRecorded: true,
        summary: {
          matchId: input.matchId,
          rankedApplied,
          durationSec: input.telemetry.durationSec,
          players: {
            player1: {
              playerId: p1Row.player_id,
              role: 'player1',
              eloBefore: p1Row.elo,
              eloAfter: p1Row.elo,
              eloDelta: 0,
              xpBefore: p1Row.xp,
              xpAfter: p1Row.xp,
              xpGained: 0,
              levelBefore: p1Row.level,
              levelAfter: p1Row.level,
              unlockedAchievements: [],
            },
            player2: {
              playerId: p2Row.player_id,
              role: 'player2',
              eloBefore: p2Row.elo,
              eloAfter: p2Row.elo,
              eloDelta: 0,
              xpBefore: p2Row.xp,
              xpAfter: p2Row.xp,
              xpGained: 0,
              levelBefore: p2Row.level,
              levelAfter: p2Row.level,
              unlockedAchievements: [],
            },
          },
        },
      };
    }

    const applySide = async (
      role: PlayerId,
      row: PlayerDbRow,
      eloAfter: number,
      eloDelta: number,
    ): Promise<PlayerProgressionDelta> => {
      const won = input.winnerRole === role;
      const sideTel = role === 'player1' ? input.telemetry.player1 : input.telemetry.player2;

      if (!rankedApplied) {
        return {
          playerId: row.player_id,
          role,
          eloBefore: row.elo,
          eloAfter: row.elo,
          eloDelta: 0,
          xpBefore: row.xp,
          xpAfter: row.xp,
          xpGained: 0,
          levelBefore: row.level,
          levelAfter: row.level,
          unlockedAchievements: [],
        };
      }

      const nextMatches = row.total_matches + 1;
      const nextWins = row.wins + (won ? 1 : 0);
      const nextLosses = row.losses + (won ? 0 : 1);
      const nextStreak = won ? row.current_streak + 1 : 0;
      const nextBestStreak = Math.max(row.best_streak, nextStreak);
      const nextTotalShots = row.total_shots + sideTel.shotsTaken;
      const nextSuccessfulShots = row.successful_shots + sideTel.successfulShots;
      const nextBallsPocketed = row.balls_pocketed + sideTel.ballsPocketed;
      const nextFouls = row.fouls + sideTel.fouls;
      const nextBreaksAttempted = row.breaks_attempted + sideTel.breaksAttempted;
      const nextBreaksSuccessful = row.breaks_successful + sideTel.breaksSuccessful;
      const nextEightBallWins = row.eight_ball_wins + (sideTel.legalEightBallWin ? 1 : 0);
      const nextTotalDuration = row.total_match_duration_sec + input.telemetry.durationSec;

      const existingAch = await db
        .prepare('SELECT achievement_id FROM player_achievements WHERE player_id = ?')
        .bind(row.player_id)
        .all<{ achievement_id: string }>();
      const unlockedSet = new Set<string>(
        (existingAch.results ?? []).map((a) => String(a.achievement_id)),
      );

      const newAchievements = evaluateUnlockedAchievements({
        totalMatches: nextMatches,
        wins: nextWins,
        bestStreak: nextBestStreak,
        ballsPocketed: nextBallsPocketed,
        breaksSuccessful: nextBreaksSuccessful,
        eightBallWins: nextEightBallWins,
        comebackWinInMatch: sideTel.comebackWin,
        alreadyUnlockedIds: unlockedSet,
      });

      const unlockedList: UnlockedAchievement[] = [];
      let achievementBonusXp = 0;
      for (const ach of newAchievements) {
        const achInsert = await db
          .prepare(
            `INSERT OR IGNORE INTO player_achievements (player_id, achievement_id, unlocked_at_ms, match_id)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(row.player_id, ach.id, input.endedAtMs, input.matchId)
          .run();
        if ((achInsert.meta?.changes ?? 0) > 0) {
          achievementBonusXp += ach.rewardXp;
          unlockedList.push({ ...ach, unlockedAtMs: input.endedAtMs });
        }
      }

      const baseXp = computeBaseMatchXp({
        won,
        shotsTaken: sideTel.shotsTaken,
        successfulShots: sideTel.successfulShots,
        ballsPocketed: sideTel.ballsPocketed,
        fouls: sideTel.fouls,
        breaksAttempted: sideTel.breaksAttempted,
        breaksSuccessful: sideTel.breaksSuccessful,
        legalEightBallWin: sideTel.legalEightBallWin,
        comebackWin: sideTel.comebackWin,
        newWinStreak: nextStreak,
        ruleProfileId: input.ruleProfileId,
        validCompetitiveMatch: true,
      });

      const xpGained = baseXp + achievementBonusXp;
      const xpAfter = row.xp + xpGained;
      const levelBefore = calculateLevelFromXp(row.xp).level;
      const levelAfter = calculateLevelFromXp(xpAfter).level;
      const peakElo = Math.max(row.peak_elo, eloAfter);

      const casualMatchesInc = input.ruleProfileId === 'casual' ? 1 : 0;
      const casualWinsInc = input.ruleProfileId === 'casual' && won ? 1 : 0;
      const wpaMatchesInc = input.ruleProfileId === 'wpa' ? 1 : 0;
      const wpaWinsInc = input.ruleProfileId === 'wpa' && won ? 1 : 0;
      const quickMatchesInc = input.matchType === 'quick' ? 1 : 0;
      const quickWinsInc = input.matchType === 'quick' && won ? 1 : 0;
      const privateMatchesInc = input.matchType === 'private' ? 1 : 0;
      const privateWinsInc = input.matchType === 'private' && won ? 1 : 0;

      await db
        .prepare(
          `UPDATE players SET
            elo = ?, peak_elo = ?, xp = ?, level = ?,
            total_matches = ?, wins = ?, losses = ?,
            current_streak = ?, best_streak = ?,
            total_shots = ?, successful_shots = ?, balls_pocketed = ?, fouls = ?,
            breaks_attempted = ?, breaks_successful = ?, eight_ball_wins = ?,
            total_match_duration_sec = ?,
            casual_matches = casual_matches + ?, casual_wins = casual_wins + ?,
            wpa_matches = wpa_matches + ?, wpa_wins = wpa_wins + ?,
            quick_matches = quick_matches + ?, quick_wins = quick_wins + ?,
            private_matches = private_matches + ?, private_wins = private_wins + ?,
            updated_at_ms = ?, last_match_at_ms = ?
           WHERE player_id = ?`,
        )
        .bind(
          eloAfter,
          peakElo,
          xpAfter,
          levelAfter,
          nextMatches,
          nextWins,
          nextLosses,
          nextStreak,
          nextBestStreak,
          nextTotalShots,
          nextSuccessfulShots,
          nextBallsPocketed,
          nextFouls,
          nextBreaksAttempted,
          nextBreaksSuccessful,
          nextEightBallWins,
          nextTotalDuration,
          casualMatchesInc,
          casualWinsInc,
          wpaMatchesInc,
          wpaWinsInc,
          quickMatchesInc,
          quickWinsInc,
          privateMatchesInc,
          privateWinsInc,
          input.endedAtMs,
          input.endedAtMs,
          row.player_id,
        )
        .run();

      await db
        .prepare(
          `INSERT OR IGNORE INTO rating_events (
            match_id, player_id, elo_before, elo_after, elo_delta, xp_gained, won, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.matchId,
          row.player_id,
          row.elo,
          eloAfter,
          eloDelta,
          xpGained,
          won ? 1 : 0,
          input.endedAtMs,
        )
        .run();

      return {
        playerId: row.player_id,
        role,
        eloBefore: row.elo,
        eloAfter,
        eloDelta,
        xpBefore: row.xp,
        xpAfter,
        xpGained,
        levelBefore,
        levelAfter,
        unlockedAchievements: unlockedList,
      };
    };

    const p1Delta = await applySide('player1', p1Row, eloCalc.player1After, eloCalc.player1Delta);
    const p2Delta = await applySide('player2', p2Row, eloCalc.player2After, eloCalc.player2Delta);

    await db
      .prepare('UPDATE matches SET p1_xp_gained = ?, p2_xp_gained = ? WHERE match_id = ?')
      .bind(p1Delta.xpGained, p2Delta.xpGained, input.matchId)
      .run();

    return {
      alreadyRecorded: false,
      summary: {
        matchId: input.matchId,
        rankedApplied,
        durationSec: input.telemetry.durationSec,
        players: {
          player1: p1Delta,
          player2: p2Delta,
        },
      },
    };
  }

  private mapRowToPublicProfile(
    row: PlayerDbRow,
    rank: number | null,
    achievements: UnlockedAchievement[],
  ): PublicPlayerProfile {
    const levelProgress = calculateLevelFromXp(row.xp);
    const totalMatches = Number(row.total_matches);
    const wins = Number(row.wins);
    const breaksAttempted = Number(row.breaks_attempted);
    const breaksSuccessful = Number(row.breaks_successful);
    const totalDuration = Number(row.total_match_duration_sec);

    return {
      playerId: row.player_id,
      username: row.username ?? null,
      displayName: row.display_name,
      avatarId: row.avatar_id,
      isGuest: Number(row.is_guest) === 1,
      elo: Number(row.elo),
      peakElo: Number(row.peak_elo),
      xp: Number(row.xp),
      level: levelProgress.level,
      levelProgress,
      rank,
      stats: {
        totalMatches,
        wins,
        losses: Number(row.losses),
        winRate: totalMatches > 0 ? Math.round((wins / totalMatches) * 1000) / 10 : 0,
        currentStreak: Number(row.current_streak),
        bestStreak: Number(row.best_streak),
        totalShots: Number(row.total_shots),
        successfulShots: Number(row.successful_shots),
        ballsPocketed: Number(row.balls_pocketed),
        fouls: Number(row.fouls),
        breaksAttempted,
        breaksSuccessful,
        breakSuccessRate:
          breaksAttempted > 0 ? Math.round((breaksSuccessful / breaksAttempted) * 1000) / 10 : 0,
        eightBallWins: Number(row.eight_ball_wins),
        avgMatchDurationSec: totalMatches > 0 ? Math.round(totalDuration / totalMatches) : 0,
        byMatchType: {
          casual: { matches: Number(row.casual_matches), wins: Number(row.casual_wins) },
          wpa: { matches: Number(row.wpa_matches), wins: Number(row.wpa_wins) },
          quick: { matches: Number(row.quick_matches), wins: Number(row.quick_wins) },
          private: { matches: Number(row.private_matches), wins: Number(row.private_wins) },
        },
      },
      achievements,
      createdAtMs: Number(row.created_at_ms),
      lastMatchAtMs: row.last_match_at_ms ? Number(row.last_match_at_ms) : null,
    };
  }
}
