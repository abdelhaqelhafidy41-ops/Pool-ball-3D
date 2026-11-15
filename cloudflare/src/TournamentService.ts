import { sanitizeAvatarId, sanitizeDisplayName } from './config';
import { D1ProgressionService, type ProgressionSqlDb } from './D1ProgressionService';
import { EconomyService } from './EconomyService';
import type { OnlineAvatarId } from '../../src/multiplayer/shared/protocol';
import {
  buildSingleEliminationBracket,
  getCurrentSeasonKey,
  sanitizePrizeConfig,
  sanitizeTournamentCapacity,
  TOURNAMENT_LIMITS,
  TOURNAMENT_TROPHY_MAP,
  type CreateTournamentInput,
  type PlayerTournamentHistoryItem,
  type PlayerTournamentStats,
  type TournamentBracketMatchStatus,
  type TournamentCapacity,
  type TournamentDetailPayload,
  type TournamentEventRecord,
  type TournamentLeaderboardEntry,
  type TournamentMatch,
  type TournamentMatchResolutionType,
  type TournamentParticipant,
  type TournamentParticipantStatus,
  type TournamentPayoutRecord,
  type TournamentPrizeConfig,
  type TournamentRecord,
  type TournamentStatus,
  type TournamentTrophyUnlock,
  type TournamentType,
} from '../../src/multiplayer/shared/tournaments';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tournaments (
    tournament_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'registration_open',
    max_players INTEGER NOT NULL DEFAULT 8,
    min_players INTEGER NOT NULL DEFAULT 2,
    rule_profile_id TEXT NOT NULL DEFAULT 'casual',
    called_shots_enabled INTEGER NOT NULL DEFAULT 0,
    entry_fee_coins INTEGER NOT NULL DEFAULT 0,
    min_elo INTEGER NOT NULL DEFAULT 0,
    is_private INTEGER NOT NULL DEFAULT 0,
    invite_code TEXT,
    created_by_player_id TEXT,
    created_by_name TEXT NOT NULL DEFAULT 'Tournament Admin',
    season_key TEXT NOT NULL,
    prizes_json TEXT NOT NULL,
    registration_opens_at_ms INTEGER NOT NULL,
    registration_closes_at_ms INTEGER NOT NULL,
    starts_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    match_deadline_ms INTEGER NOT NULL DEFAULT 300000,
    bracket_size INTEGER NOT NULL DEFAULT 0,
    total_rounds INTEGER NOT NULL DEFAULT 0,
    current_round INTEGER NOT NULL DEFAULT 0,
    champion_player_id TEXT,
    champion_display_name TEXT,
    runner_up_player_id TEXT,
    runner_up_display_name TEXT,
    third_place_player_id TEXT,
    third_place_display_name TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tournament_participants (
    tournament_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_id TEXT NOT NULL DEFAULT 'cue_gold',
    elo INTEGER NOT NULL DEFAULT 1200,
    seed INTEGER,
    status TEXT NOT NULL DEFAULT 'registered',
    placement INTEGER,
    eliminated_round INTEGER,
    joined_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tournament_id, player_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tournament_matches (
    bracket_match_id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    round_label TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    is_third_place_match INTEGER NOT NULL DEFAULT 0,
    player1_id TEXT,
    player1_name TEXT,
    player1_avatar TEXT,
    player1_seed INTEGER,
    player1_joined INTEGER NOT NULL DEFAULT 0,
    player2_id TEXT,
    player2_name TEXT,
    player2_avatar TEXT,
    player2_seed INTEGER,
    player2_joined INTEGER NOT NULL DEFAULT 0,
    winner_id TEXT,
    winner_name TEXT,
    loser_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    room_id TEXT,
    room_code TEXT,
    match_id TEXT,
    resolution_type TEXT,
    reason TEXT,
    next_match_id TEXT,
    next_match_slot INTEGER,
    ready_deadline_ms INTEGER,
    started_at_ms INTEGER,
    completed_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS tournament_payouts (
    payout_id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    placement TEXT NOT NULL,
    coins_awarded INTEGER NOT NULL DEFAULT 0,
    badge_awarded TEXT,
    trophy_awarded TEXT,
    awarded_at_ms INTEGER NOT NULL,
    UNIQUE(tournament_id, player_id, placement)
  )`,
  `CREATE TABLE IF NOT EXISTS tournament_trophies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    trophy_id TEXT NOT NULL,
    tournament_id TEXT NOT NULL,
    tournament_title TEXT NOT NULL,
    unlocked_at_ms INTEGER NOT NULL,
    UNIQUE(player_id, trophy_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tournament_player_stats (
    player_id TEXT PRIMARY KEY,
    season_key TEXT NOT NULL DEFAULT 'ALL',
    championships INTEGER NOT NULL DEFAULT 0,
    finals_appearances INTEGER NOT NULL DEFAULT 0,
    third_place_finishes INTEGER NOT NULL DEFAULT 0,
    tournaments_entered INTEGER NOT NULL DEFAULT 0,
    matches_played INTEGER NOT NULL DEFAULT 0,
    matches_won INTEGER NOT NULL DEFAULT 0,
    matches_lost INTEGER NOT NULL DEFAULT 0,
    total_coins_won INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tournament_events (
    event_id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_player_id TEXT,
    summary TEXT NOT NULL,
    metadata_json TEXT,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tournaments_status_starts ON tournaments (status, starts_at_ms ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_tournaments_invite ON tournaments (invite_code)`,
  `CREATE INDEX IF NOT EXISTS idx_tourn_participants_player ON tournament_participants (player_id, joined_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tourn_matches_tournament ON tournament_matches (tournament_id, round_number ASC, slot_index ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_tourn_matches_room ON tournament_matches (room_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tourn_payouts_player ON tournament_payouts (player_id, awarded_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tourn_trophies_player ON tournament_trophies (player_id, unlocked_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tourn_stats_rank ON tournament_player_stats (championships DESC, finals_appearances DESC, matches_won DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tourn_events_tourn ON tournament_events (tournament_id, created_at_ms DESC)`,
];

const VALID_TYPES = new Set<TournamentType>(['quick', 'daily', 'weekly', 'private', 'scheduled']);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type TournamentServiceError = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

interface TournamentRow {
  tournament_id: string;
  title: string;
  description: string;
  type: string;
  status: string;
  max_players: number;
  min_players: number;
  rule_profile_id: string;
  called_shots_enabled: number;
  entry_fee_coins: number;
  min_elo: number;
  is_private: number;
  invite_code: string | null;
  created_by_player_id: string | null;
  created_by_name: string;
  season_key: string;
  prizes_json: string;
  registration_opens_at_ms: number;
  registration_closes_at_ms: number;
  starts_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  match_deadline_ms: number;
  bracket_size: number;
  total_rounds: number;
  current_round: number;
  champion_player_id: string | null;
  champion_display_name: string | null;
  runner_up_player_id: string | null;
  runner_up_display_name: string | null;
  third_place_player_id: string | null;
  third_place_display_name: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  participant_count?: number;
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

function generateTournamentInviteCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return out;
}

function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .trim()
    .slice(0, TOURNAMENT_LIMITS.maxTitleLen);
}

function sanitizeDescription(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .trim()
    .slice(0, TOURNAMENT_LIMITS.maxDescriptionLen);
}

export class TournamentService {
  private static readonly bootstrappedDbs = new WeakSet<object>();
  private static readonly seededDbs = new WeakSet<object>();
  private static readonly lockChains = new Map<string, Promise<unknown>>();

  constructor(private readonly db: ProgressionSqlDb | D1Database) {}

  private async withTournamentLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = TournamentService.lockChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const next = prev.then(() => gate);
    TournamentService.lockChains.set(key, next);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (TournamentService.lockChains.get(key) === next) {
        TournamentService.lockChains.delete(key);
      }
    }
  }

  public async ensureSchema(): Promise<ProgressionSqlDb> {
    const db = this.db as unknown as ProgressionSqlDb;
    if (!TournamentService.bootstrappedDbs.has(this.db)) {
      for (const stmt of SCHEMA_STATEMENTS) {
        await db.prepare(stmt).run();
      }
      TournamentService.bootstrappedDbs.add(this.db);
    }
    return db;
  }

  public async ensureDefaultTournaments(nowMs: number = Date.now()): Promise<void> {
    const db = await this.ensureSchema();
    if (TournamentService.seededDbs.has(this.db)) return;

    const existing = await db
      .prepare('SELECT COUNT(*) AS c FROM tournaments')
      .first<{ c: number }>();
    if (Number(existing?.c ?? 0) > 0) {
      TournamentService.seededDbs.add(this.db);
      return;
    }

    const seasonKey = getCurrentSeasonKey(nowMs);
    const defaults: CreateTournamentInput[] = [
      {
        title: 'Quick 8-Ball Blitz',
        description: 'Fast 8-player single-elimination knockout. Starts immediately when full.',
        type: 'quick',
        maxPlayers: 8,
        minPlayers: 2,
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
        entryFeeCoins: 0,
        minElo: 0,
        registrationOpensAtMs: nowMs - 60_000,
        registrationClosesAtMs: nowMs + 6 * 3600_000,
        startsAtMs: nowMs + 6 * 3600_000,
        matchDeadlineMs: TOURNAMENT_LIMITS.defaultMatchDeadlineMs,
        status: 'registration_open',
      },
      {
        title: 'Daily Championship Open',
        description: 'Daily 16-player competitive bracket with POOL COINS prizes and ranking points.',
        type: 'daily',
        maxPlayers: 16,
        minPlayers: 4,
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
        entryFeeCoins: 50,
        minElo: 0,
        registrationOpensAtMs: nowMs - 60_000,
        registrationClosesAtMs: nowMs + 12 * 3600_000,
        startsAtMs: nowMs + 12 * 3600_000,
        matchDeadlineMs: TOURNAMENT_LIMITS.defaultMatchDeadlineMs,
        status: 'registration_open',
      },
      {
        title: 'Weekly World Championship',
        description: 'Premier 32-player WPA strict called-shot championship with World Champion badge.',
        type: 'weekly',
        maxPlayers: 32,
        minPlayers: 4,
        ruleProfileId: 'wpa',
        calledShotsEnabled: true,
        entryFeeCoins: 100,
        minElo: 0,
        seasonKey,
        registrationOpensAtMs: nowMs - 60_000,
        registrationClosesAtMs: nowMs + 72 * 3600_000,
        startsAtMs: nowMs + 72 * 3600_000,
        matchDeadlineMs: TOURNAMENT_LIMITS.defaultMatchDeadlineMs,
        status: 'registration_open',
      },
      {
        title: 'Masters Invitational Series',
        description: 'Scheduled global championship bracket for seasoned table contenders.',
        type: 'scheduled',
        maxPlayers: 16,
        minPlayers: 4,
        ruleProfileId: 'wpa',
        calledShotsEnabled: true,
        entryFeeCoins: 75,
        minElo: 1100,
        registrationOpensAtMs: nowMs + 2 * 3600_000,
        registrationClosesAtMs: nowMs + 24 * 3600_000,
        startsAtMs: nowMs + 24 * 3600_000,
        matchDeadlineMs: TOURNAMENT_LIMITS.defaultMatchDeadlineMs,
        status: 'upcoming',
      },
    ];

    for (const def of defaults) {
      await this.createTournament(def, {
        actorPlayerId: null,
        actorName: 'World Pool Federation',
        isAdmin: true,
        nowMs,
        skipSeedCheck: true,
      });
    }
    TournamentService.seededDbs.add(this.db);
  }

  public async createTournament(
    input: Partial<CreateTournamentInput>,
    opts: {
      actorPlayerId: string | null;
      actorName?: string;
      isAdmin?: boolean;
      nowMs?: number;
      skipSeedCheck?: boolean;
    },
  ): Promise<{ ok: true; tournament: TournamentRecord } | TournamentServiceError> {
    const db = await this.ensureSchema();
    const now = opts.nowMs ?? Date.now();
    if (!opts.skipSeedCheck) {
      TournamentService.seededDbs.add(this.db);
    }

    const type: TournamentType =
      typeof input.type === 'string' && VALID_TYPES.has(input.type as TournamentType)
        ? (input.type as TournamentType)
        : opts.isAdmin
          ? 'quick'
          : 'private';

    if (!opts.isAdmin && type !== 'private') {
      return {
        ok: false,
        status: 403,
        code: 'FORBIDDEN',
        message: 'Only tournament administrators can create global official tournaments.',
      };
    }

    const title = sanitizeTitle(input.title);
    if (title.length < 3) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Tournament title must be at least 3 characters.',
      };
    }

    const description = sanitizeDescription(input.description);
    const maxPlayers: TournamentCapacity = sanitizeTournamentCapacity(input.maxPlayers);
    const minPlayersRaw =
      typeof input.minPlayers === 'number' && Number.isFinite(input.minPlayers)
        ? Math.floor(input.minPlayers)
        : 2;
    const minPlayers = Math.max(2, Math.min(maxPlayers, minPlayersRaw));
    const ruleProfileId = input.ruleProfileId === 'wpa' ? 'wpa' : 'casual';
    const calledShotsEnabled =
      input.calledShotsEnabled !== undefined
        ? Boolean(input.calledShotsEnabled)
        : ruleProfileId === 'wpa';

    const entryFeeCoins = Math.max(
      0,
      Math.min(
        TOURNAMENT_LIMITS.maxEntryFeeCoins,
        Math.floor(Number(input.entryFeeCoins ?? 0) || 0),
      ),
    );
    const minElo = Math.max(0, Math.min(3000, Math.floor(Number(input.minElo ?? 0) || 0)));
    const isPrivate = type === 'private' || Boolean(input.isPrivate);
    const matchDeadlineMs = Math.max(
      TOURNAMENT_LIMITS.minMatchDeadlineMs,
      Math.min(
        TOURNAMENT_LIMITS.maxMatchDeadlineMs,
        Math.floor(Number(input.matchDeadlineMs ?? TOURNAMENT_LIMITS.defaultMatchDeadlineMs)),
      ),
    );

    const registrationOpensAtMs =
      typeof input.registrationOpensAtMs === 'number' && Number.isFinite(input.registrationOpensAtMs)
        ? Math.floor(input.registrationOpensAtMs)
        : now;
    const registrationClosesAtMs =
      typeof input.registrationClosesAtMs === 'number' &&
      Number.isFinite(input.registrationClosesAtMs)
        ? Math.max(registrationOpensAtMs + 1000, Math.floor(input.registrationClosesAtMs))
        : now + 24 * 3600_000;
    const startsAtMs =
      typeof input.startsAtMs === 'number' && Number.isFinite(input.startsAtMs)
        ? Math.max(registrationClosesAtMs, Math.floor(input.startsAtMs))
        : registrationClosesAtMs;

    const status: TournamentStatus =
      input.status === 'upcoming' || registrationOpensAtMs > now
        ? 'upcoming'
        : 'registration_open';

    let inviteCode: string | null = null;
    if (isPrivate) {
      const requestedCode =
        typeof input.inviteCode === 'string'
          ? input.inviteCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12)
          : '';
      inviteCode = requestedCode.length >= 4 ? requestedCode : generateTournamentInviteCode();
    }

    const prizes = sanitizePrizeConfig(type, input.prizes);
    const tournamentId = generateId('trn');
    const seasonKey =
      typeof input.seasonKey === 'string' && input.seasonKey.trim()
        ? input.seasonKey.trim().slice(0, 24)
        : getCurrentSeasonKey(now);
    const creatorName = sanitizeDisplayName(opts.actorName ?? 'Tournament Admin');

    await db
      .prepare(
        `INSERT INTO tournaments (
          tournament_id, title, description, type, status, max_players, min_players,
          rule_profile_id, called_shots_enabled, entry_fee_coins, min_elo,
          is_private, invite_code, created_by_player_id, created_by_name, season_key,
          prizes_json, registration_opens_at_ms, registration_closes_at_ms, starts_at_ms,
          match_deadline_ms, bracket_size, total_rounds, current_round, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
      )
      .bind(
        tournamentId,
        title,
        description,
        type,
        status,
        maxPlayers,
        minPlayers,
        ruleProfileId,
        calledShotsEnabled ? 1 : 0,
        entryFeeCoins,
        minElo,
        isPrivate ? 1 : 0,
        inviteCode,
        opts.actorPlayerId,
        creatorName,
        seasonKey,
        JSON.stringify(prizes),
        registrationOpensAtMs,
        registrationClosesAtMs,
        startsAtMs,
        matchDeadlineMs,
        now,
        now,
      )
      .run();

    await this.recordEvent(
      db,
      tournamentId,
      'tournament_created',
      opts.actorPlayerId,
      `${title} (${type.toUpperCase()} · ${maxPlayers}P) created.`,
      { type, maxPlayers, entryFeeCoins },
      now,
    );

    const created = (await this.loadTournamentById(db, tournamentId, {
      viewerId: opts.actorPlayerId,
      includeSecrets: true,
    }))!;
    return { ok: true, tournament: created };
  }

  public async listTournaments(params?: {
    viewerId?: string | null;
    type?: string | null;
    status?: string | null;
    includePrivateForAdmin?: boolean;
  }): Promise<TournamentRecord[]> {
    const db = await this.ensureSchema();
    await this.ensureDefaultTournaments();

    const viewerId = params?.viewerId?.trim() || null;
    const rows = await db
      .prepare(
        `SELECT t.*,
          (SELECT COUNT(*) FROM tournament_participants tp
           WHERE tp.tournament_id = t.tournament_id AND tp.status != 'withdrawn') AS participant_count
         FROM tournaments t
         ORDER BY
           CASE t.status
             WHEN 'in_progress' THEN 1
             WHEN 'registration_open' THEN 2
             WHEN 'upcoming' THEN 3
             WHEN 'completed' THEN 4
             ELSE 5
           END ASC,
           t.starts_at_ms ASC,
           t.created_at_ms DESC
         LIMIT 60`,
      )
      .all<TournamentRow>();

    let viewerJoinedSet = new Set<string>();
    if (viewerId) {
      const joinedRows = await db
        .prepare(
          `SELECT tournament_id FROM tournament_participants
           WHERE player_id = ? AND status != 'withdrawn'`,
        )
        .bind(viewerId)
        .all<{ tournament_id: string }>();
      viewerJoinedSet = new Set((joinedRows.results ?? []).map((r) => String(r.tournament_id)));
    }

    const typeFilter = params?.type && VALID_TYPES.has(params.type as TournamentType) ? params.type : null;
    const statusFilter =
      params?.status &&
      ['upcoming', 'registration_open', 'in_progress', 'completed', 'cancelled'].includes(params.status)
        ? params.status
        : null;

    const results: TournamentRecord[] = [];
    for (const row of rows.results ?? []) {
      if (typeFilter && row.type !== typeFilter) continue;
      if (statusFilter && row.status !== statusFilter) continue;

      const isPrivate = Number(row.is_private) === 1;
      const isJoined = viewerJoinedSet.has(row.tournament_id);
      const isCreator = Boolean(viewerId && row.created_by_player_id === viewerId);

      if (isPrivate && !params?.includePrivateForAdmin && !isJoined && !isCreator) {
        continue;
      }

      results.push(
        this.mapTournamentRow(row, {
          viewerRegistered: isJoined,
          includeInviteCode: Boolean(params?.includePrivateForAdmin || isJoined || isCreator),
        }),
      );
    }

    return results;
  }

  public async getTournamentDetail(
    tournamentId: string,
    opts?: { viewerId?: string | null; isAdmin?: boolean },
  ): Promise<TournamentDetailPayload | null> {
    const db = await this.ensureSchema();
    const viewerId = opts?.viewerId?.trim() || null;

    const row = await db
      .prepare(
        `SELECT t.*,
          (SELECT COUNT(*) FROM tournament_participants tp
           WHERE tp.tournament_id = t.tournament_id AND tp.status != 'withdrawn') AS participant_count
         FROM tournaments t
         WHERE t.tournament_id = ?
         LIMIT 1`,
      )
      .bind(tournamentId)
      .first<TournamentRow>();
    if (!row) return null;

    const [partRows, matchRows, payoutRows, eventRows] = await Promise.all([
      db
        .prepare(
          `SELECT * FROM tournament_participants
           WHERE tournament_id = ? AND status != 'withdrawn'
           ORDER BY COALESCE(seed, 9999) ASC, elo DESC, joined_at_ms ASC`,
        )
        .bind(tournamentId)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT * FROM tournament_matches
           WHERE tournament_id = ?
           ORDER BY is_third_place_match ASC, round_number ASC, slot_index ASC`,
        )
        .bind(tournamentId)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT * FROM tournament_payouts
           WHERE tournament_id = ?
           ORDER BY coins_awarded DESC, awarded_at_ms ASC`,
        )
        .bind(tournamentId)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT * FROM tournament_events
           WHERE tournament_id = ?
           ORDER BY created_at_ms DESC
           LIMIT 30`,
        )
        .bind(tournamentId)
        .all<Record<string, unknown>>(),
    ]);

    const participants = (partRows.results ?? []).map((r) => this.mapParticipantRow(r));
    const matches = (matchRows.results ?? []).map((r) => this.mapMatchRow(r));
    const payouts = (payoutRows.results ?? []).map((r) => this.mapPayoutRow(r));
    const events = (eventRows.results ?? []).map((r) => this.mapEventRow(r));

    const viewerParticipant = viewerId
      ? participants.find((p) => p.playerId === viewerId) ?? null
      : null;
    const isCreator = Boolean(viewerId && row.created_by_player_id === viewerId);
    const activeMatch = viewerId
      ? matches.find(
          (m) =>
            (m.status === 'ready' || m.status === 'in_progress') &&
            (m.player1Id === viewerId || m.player2Id === viewerId),
        ) ?? null
      : null;

    const tournament = this.mapTournamentRow(row, {
      viewerRegistered: Boolean(viewerParticipant),
      includeInviteCode: Boolean(opts?.isAdmin || viewerParticipant || isCreator),
    });

    return {
      tournament,
      participants,
      matches,
      payouts,
      events,
      viewerStatus: {
        isRegistered: Boolean(viewerParticipant),
        participant: viewerParticipant,
        activeMatch,
      },
    };
  }

  public async registerPlayer(params: {
    tournamentId: string;
    playerId: string;
    inviteCode?: string;
    nowMs?: number;
  }): Promise<
    | {
        ok: true;
        tournament: TournamentRecord;
        participant: TournamentParticipant;
        shouldAutoStart: boolean;
      }
    | TournamentServiceError
  > {
    const db = await this.ensureSchema();
    const now = params.nowMs ?? Date.now();

    return this.withTournamentLock(params.tournamentId, async () => {
      const row = await this.loadRawTournamentRow(db, params.tournamentId);
      if (!row) {
        return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Tournament not found.' };
      }

      if (row.status === 'upcoming' && now >= Number(row.registration_opens_at_ms)) {
        await db
          .prepare("UPDATE tournaments SET status = 'registration_open', updated_at_ms = ? WHERE tournament_id = ?")
          .bind(now, row.tournament_id)
          .run();
        row.status = 'registration_open';
      }

      if (row.status !== 'registration_open') {
        return {
          ok: false,
          status: 409,
          code: 'TOURNAMENT_CLOSED',
          message:
            row.status === 'upcoming'
              ? 'Registration has not opened for this tournament yet.'
              : 'Tournament registration is already closed.',
        };
      }

      if (now >= Number(row.registration_closes_at_ms)) {
        return {
          ok: false,
          status: 409,
          code: 'TOURNAMENT_CLOSED',
          message: 'Registration window for this tournament has ended.',
        };
      }

      const isPrivate = Number(row.is_private) === 1;
      if (isPrivate && row.created_by_player_id !== params.playerId) {
        const providedCode = (params.inviteCode ?? '').trim().toUpperCase();
        const expectedCode = (row.invite_code ?? '').trim().toUpperCase();
        if (!providedCode || providedCode !== expectedCode) {
          return {
            ok: false,
            status: 403,
            code: 'UNAUTHORIZED',
            message: 'A valid tournament invitation code is required to join this private event.',
          };
        }
      }

      const existingPart = await db
        .prepare(
          `SELECT * FROM tournament_participants
           WHERE tournament_id = ? AND player_id = ? LIMIT 1`,
        )
        .bind(params.tournamentId, params.playerId)
        .first<Record<string, unknown>>();

      if (existingPart && String(existingPart.status) !== 'withdrawn') {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_REGISTERED',
          message: 'You are already registered for this tournament.',
        };
      }

      const countRow = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM tournament_participants
           WHERE tournament_id = ? AND status != 'withdrawn'`,
        )
        .bind(params.tournamentId)
        .first<{ c: number }>();
      const currentCount = Number(countRow?.c ?? 0);
      if (currentCount >= Number(row.max_players)) {
        return {
          ok: false,
          status: 409,
          code: 'TOURNAMENT_FULL',
          message: `This ${row.max_players}-player tournament is already at full capacity.`,
        };
      }

      const playerRow = await this.resolvePlayerProfileRow(db, params.playerId);
      const minElo = Number(row.min_elo ?? 0);
      if (minElo > 0 && playerRow.elo < minElo) {
        return {
          ok: false,
          status: 403,
          code: 'UNAUTHORIZED',
          message: `Minimum ${minElo} ELO required to enter (your ELO: ${playerRow.elo}).`,
        };
      }

      const entryFee = Number(row.entry_fee_coins ?? 0);
      if (entryFee > 0) {
        const economy = new EconomyService(this.db);
        const debit = await economy.debitTournamentEntryFee({
          tournamentId: params.tournamentId,
          tournamentTitle: row.title,
          playerId: params.playerId,
          amount: entryFee,
          nowMs: now,
        });
        if (!debit.ok) {
          return debit;
        }
      }

      if (existingPart) {
        await db
          .prepare(
            `UPDATE tournament_participants
             SET display_name = ?, avatar_id = ?, elo = ?, seed = NULL, status = 'registered',
                 placement = NULL, eliminated_round = NULL, joined_at_ms = ?
             WHERE tournament_id = ? AND player_id = ?`,
          )
          .bind(
            playerRow.displayName,
            playerRow.avatarId,
            playerRow.elo,
            now,
            params.tournamentId,
            params.playerId,
          )
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO tournament_participants (
              tournament_id, player_id, display_name, avatar_id, elo, seed, status, joined_at_ms
            ) VALUES (?, ?, ?, ?, ?, NULL, 'registered', ?)`,
          )
          .bind(
            params.tournamentId,
            params.playerId,
            playerRow.displayName,
            playerRow.avatarId,
            playerRow.elo,
            now,
          )
          .run();
      }

      await db
        .prepare('UPDATE tournaments SET updated_at_ms = ? WHERE tournament_id = ?')
        .bind(now, params.tournamentId)
        .run();

      await this.recordEvent(
        db,
        params.tournamentId,
        'player_registered',
        params.playerId,
        `${playerRow.displayName} registered (${currentCount + 1}/${row.max_players}).`,
        { elo: playerRow.elo },
        now,
      );

      const updatedTournament = (await this.loadTournamentById(db, params.tournamentId, {
        viewerId: params.playerId,
        includeSecrets: true,
      }))!;
      const participant: TournamentParticipant = {
        tournamentId: params.tournamentId,
        playerId: params.playerId,
        displayName: playerRow.displayName,
        avatarId: playerRow.avatarId,
        elo: playerRow.elo,
        seed: null,
        status: 'registered',
        placement: null,
        eliminatedRound: null,
        joinedAtMs: now,
      };

      const shouldAutoStart =
        row.type === 'quick' && updatedTournament.participantCount >= updatedTournament.maxPlayers;

      return {
        ok: true,
        tournament: updatedTournament,
        participant,
        shouldAutoStart,
      };
    });
  }

  public async registerByInviteCode(params: {
    inviteCode: string;
    playerId: string;
    nowMs?: number;
  }) {
    const db = await this.ensureSchema();
    const cleaned = params.inviteCode.trim().toUpperCase();
    if (!cleaned) {
      return {
        ok: false as const,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Enter a valid tournament invitation code.',
      };
    }

    const row = await db
      .prepare('SELECT tournament_id FROM tournaments WHERE UPPER(invite_code) = ? LIMIT 1')
      .bind(cleaned)
      .first<{ tournament_id: string }>();
    if (!row) {
      return {
        ok: false as const,
        status: 404,
        code: 'NOT_FOUND',
        message: 'Private tournament invitation code not found.',
      };
    }

    return this.registerPlayer({
      tournamentId: row.tournament_id,
      playerId: params.playerId,
      inviteCode: cleaned,
      nowMs: params.nowMs,
    });
  }

  public async withdrawPlayer(params: {
    tournamentId: string;
    playerId: string;
    nowMs?: number;
  }): Promise<
    | {
        ok: true;
        tournament: TournamentRecord;
        refundedCoins: number;
        forfeitedMatch: TournamentMatch | null;
        roomIdsToClose: string[];
        newlyReadyMatches: TournamentMatch[];
        completedTournament: TournamentRecord | null;
      }
    | TournamentServiceError
  > {
    const db = await this.ensureSchema();
    const now = params.nowMs ?? Date.now();

    return this.withTournamentLock(params.tournamentId, async () => {
      const row = await this.loadRawTournamentRow(db, params.tournamentId);
      if (!row) {
        return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Tournament not found.' };
      }

      if (row.status === 'completed' || row.status === 'cancelled') {
        return {
          ok: false,
          status: 409,
          code: 'TOURNAMENT_CLOSED',
          message: 'Cannot withdraw from a completed or cancelled tournament.',
        };
      }

      const part = await db
        .prepare(
          `SELECT * FROM tournament_participants
           WHERE tournament_id = ? AND player_id = ? AND status != 'withdrawn' LIMIT 1`,
        )
        .bind(params.tournamentId, params.playerId)
        .first<Record<string, unknown>>();

      if (!part) {
        return {
          ok: false,
          status: 404,
          code: 'NOT_FOUND',
          message: 'You are not currently registered in this tournament.',
        };
      }

      // Pre-bracket withdrawal: remove cleanly & refund entry fee
      if (row.status === 'upcoming' || row.status === 'registration_open') {
        await db
          .prepare('DELETE FROM tournament_participants WHERE tournament_id = ? AND player_id = ?')
          .bind(params.tournamentId, params.playerId)
          .run();

        let refundedCoins = 0;
        const entryFee = Number(row.entry_fee_coins ?? 0);
        if (entryFee > 0) {
          const economy = new EconomyService(this.db);
          const ref = await economy.refundTournamentEntryFee({
            tournamentId: params.tournamentId,
            tournamentTitle: row.title,
            playerId: params.playerId,
            amount: entryFee,
            reasonLabel: `Registration Cancelled: ${row.title}`,
            nowMs: now,
          });
          refundedCoins = ref.refunded;
        }

        await this.recordEvent(
          db,
          params.tournamentId,
          'player_withdrawn',
          params.playerId,
          `${String(part.display_name)} withdrew before bracket start.`,
          { refundedCoins },
          now,
        );

        const updatedTournament = (await this.loadTournamentById(db, params.tournamentId, {
          viewerId: params.playerId,
          includeSecrets: true,
        }))!;

        return {
          ok: true,
          tournament: updatedTournament,
          refundedCoins,
          forfeitedMatch: null,
          roomIdsToClose: [],
          newlyReadyMatches: [],
          completedTournament: null,
        };
      }

      // Mid-tournament withdrawal: mark withdrawn and forfeit active match
      await db
        .prepare(
          `UPDATE tournament_participants
           SET status = 'withdrawn', eliminated_round = ?
           WHERE tournament_id = ? AND player_id = ?`,
        )
        .bind(Number(row.current_round || 1), params.tournamentId, params.playerId)
        .run();

      await this.recordEvent(
        db,
        params.tournamentId,
        'player_withdrawn',
        params.playerId,
        `${String(part.display_name)} withdrew during active tournament.`,
        null,
        now,
      );

      const activeMatches = await db
        .prepare(
          `SELECT * FROM tournament_matches
           WHERE tournament_id = ?
             AND status IN ('pending', 'ready', 'in_progress')
             AND (player1_id = ? OR player2_id = ?)`,
        )
        .bind(params.tournamentId, params.playerId, params.playerId)
        .all<Record<string, unknown>>();

      const roomIdsToClose: string[] = [];
      let forfeitedMatch: TournamentMatch | null = null;
      const newlyReadyMatches: TournamentMatch[] = [];
      let completedTournament: TournamentRecord | null = null;

      for (const mRow of activeMatches.results ?? []) {
        const m = this.mapMatchRow(mRow);
        if (m.roomId) roomIdsToClose.push(m.roomId);

        const opponentId = m.player1Id === params.playerId ? m.player2Id : m.player1Id;
        if (opponentId) {
          const res = await this.resolveBracketMatchInternal(db, row, m.bracketMatchId, {
            winnerId: opponentId,
            resolutionType: 'forfeit',
            reason: `${String(part.display_name)} withdrew from tournament.`,
            nowMs: now,
          });
          if (res.ok) {
            forfeitedMatch = res.resolvedMatch;
            newlyReadyMatches.push(...res.newlyReadyMatches);
            if (res.completedTournament) {
              completedTournament = res.completedTournament;
            }
          }
        }
      }

      const updatedTournament = (await this.loadTournamentById(db, params.tournamentId, {
        viewerId: params.playerId,
        includeSecrets: true,
      }))!;

      return {
        ok: true,
        tournament: updatedTournament,
        refundedCoins: 0,
        forfeitedMatch,
        roomIdsToClose,
        newlyReadyMatches,
        completedTournament,
      };
    });
  }

  public async startTournamentBracket(
    tournamentId: string,
    opts?: { actorPlayerId?: string | null; isAdmin?: boolean; nowMs?: number },
  ): Promise<
    | {
        ok: true;
        cancelledInsufficient: boolean;
        tournament: TournamentRecord;
        readyMatches: TournamentMatch[];
      }
    | TournamentServiceError
  > {
    const db = await this.ensureSchema();
    const now = opts?.nowMs ?? Date.now();

    return this.withTournamentLock(tournamentId, async () => {
      const row = await this.loadRawTournamentRow(db, tournamentId);
      if (!row) {
        return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Tournament not found.' };
      }

      if (!opts?.isAdmin && opts?.actorPlayerId) {
        const isCreator = row.created_by_player_id === opts.actorPlayerId;
        if (!isCreator || Number(row.is_private) !== 1) {
          return {
            ok: false,
            status: 403,
            code: 'FORBIDDEN',
            message: 'Only the tournament host or administrator can manually start the bracket.',
          };
        }
      }

      if (row.status !== 'upcoming' && row.status !== 'registration_open') {
        return {
          ok: false,
          status: 409,
          code: 'TOURNAMENT_CLOSED',
          message: `Tournament is already ${row.status}.`,
        };
      }

      const partRows = await db
        .prepare(
          `SELECT * FROM tournament_participants
           WHERE tournament_id = ? AND status != 'withdrawn'
           ORDER BY elo DESC, joined_at_ms ASC`,
        )
        .bind(tournamentId)
        .all<Record<string, unknown>>();
      const participants = (partRows.results ?? []).map((r) => this.mapParticipantRow(r));

      if (participants.length < Number(row.min_players)) {
        // Auto-cancel & refund entry fees cleanly
        await this.cancelAndRefundInternal(
          db,
          row,
          opts?.actorPlayerId ?? null,
          `Cancelled: minimum ${row.min_players} participants not met (${participants.length} joined).`,
          now,
        );
        const cancelled = (await this.loadTournamentById(db, tournamentId, { includeSecrets: true }))!;
        return {
          ok: true,
          cancelledInsufficient: true,
          tournament: cancelled,
          readyMatches: [],
        };
      }

      const blueprint = buildSingleEliminationBracket(tournamentId, participants);
      const matchDeadlineDuration = Number(row.match_deadline_ms || TOURNAMENT_LIMITS.defaultMatchDeadlineMs);
      const readyDeadlineMs = now + matchDeadlineDuration;

      for (const p of blueprint.seededParticipants) {
        await db
          .prepare(
            `UPDATE tournament_participants
             SET seed = ?, status = 'active'
             WHERE tournament_id = ? AND player_id = ?`,
          )
          .bind(p.seed, tournamentId, p.playerId)
          .run();
        await this.upsertTournamentPlayerStats(db, p.playerId, row.season_key, {
          tournamentsEnteredInc: 1,
          nowMs: now,
        });
      }

      await db
        .prepare('DELETE FROM tournament_matches WHERE tournament_id = ?')
        .bind(tournamentId)
        .run();

      const readyMatches: TournamentMatch[] = [];
      for (const m of blueprint.matches) {
        const deadline = m.status === 'ready' ? readyDeadlineMs : null;
        const nextMatch = { ...m, readyDeadlineMs: deadline };
        await db
          .prepare(
            `INSERT INTO tournament_matches (
              bracket_match_id, tournament_id, round_number, round_label, slot_index, is_third_place_match,
              player1_id, player1_name, player1_avatar, player1_seed, player1_joined,
              player2_id, player2_name, player2_avatar, player2_seed, player2_joined,
              winner_id, winner_name, loser_id, status, room_id, room_code, match_id,
              resolution_type, reason, next_match_id, next_match_slot,
              ready_deadline_ms, started_at_ms, completed_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
          )
          .bind(
            nextMatch.bracketMatchId,
            nextMatch.tournamentId,
            nextMatch.roundNumber,
            nextMatch.roundLabel,
            nextMatch.slotIndex,
            nextMatch.isThirdPlaceMatch ? 1 : 0,
            nextMatch.player1Id,
            nextMatch.player1Name,
            nextMatch.player1Avatar,
            nextMatch.player1Seed,
            nextMatch.player2Id,
            nextMatch.player2Name,
            nextMatch.player2Avatar,
            nextMatch.player2Seed,
            nextMatch.winnerId,
            nextMatch.winnerName,
            nextMatch.loserId,
            nextMatch.status,
            nextMatch.resolutionType,
            nextMatch.reason,
            nextMatch.nextMatchId,
            nextMatch.nextMatchSlot,
            nextMatch.readyDeadlineMs,
            nextMatch.completedAtMs,
          )
          .run();

        if (nextMatch.status === 'ready') {
          readyMatches.push(nextMatch);
        }
      }

      await db
        .prepare(
          `UPDATE tournaments
           SET status = 'in_progress', bracket_size = ?, total_rounds = ?, current_round = 1,
               started_at_ms = ?, updated_at_ms = ?
           WHERE tournament_id = ?`,
        )
        .bind(blueprint.bracketSize, blueprint.totalRounds, now, now, tournamentId)
        .run();

      await this.recordEvent(
        db,
        tournamentId,
        'bracket_generated',
        opts?.actorPlayerId ?? null,
        `Bracket generated (${participants.length} players, ${blueprint.bracketSize}-slot, ${blueprint.totalRounds} rounds).`,
        {
          participants: participants.length,
          bracketSize: blueprint.bracketSize,
          totalRounds: blueprint.totalRounds,
        },
        now,
      );

      const updatedTournament = (await this.loadTournamentById(db, tournamentId, {
        includeSecrets: true,
      }))!;
      return {
        ok: true,
        cancelledInsufficient: false,
        tournament: updatedTournament,
        readyMatches,
      };
    });
  }

  public async attachRoomToMatch(params: {
    tournamentId: string;
    bracketMatchId: string;
    roomId: string;
    roomCode: string;
    readyDeadlineMs?: number;
  }): Promise<void> {
    const db = await this.ensureSchema();
    await this.withTournamentLock(params.tournamentId, async () => {
      await db
        .prepare(
          `UPDATE tournament_matches
           SET room_id = ?, room_code = ?,
               ready_deadline_ms = COALESCE(?, ready_deadline_ms)
           WHERE tournament_id = ? AND bracket_match_id = ? AND status IN ('ready', 'in_progress')`,
        )
        .bind(
          params.roomId,
          params.roomCode,
          params.readyDeadlineMs ?? null,
          params.tournamentId,
          params.bracketMatchId,
        )
        .run();
    });
  }

  public async markPlayerJoinedMatch(params: {
    tournamentId: string;
    bracketMatchId: string;
    playerId: string;
    nowMs?: number;
  }): Promise<
    | {
        ok: true;
        match: TournamentMatch;
        tournament: TournamentRecord;
        role: 'player1' | 'player2';
        bothJoined: boolean;
      }
    | TournamentServiceError
  > {
    const db = await this.ensureSchema();
    const now = params.nowMs ?? Date.now();

    return this.withTournamentLock(params.tournamentId, async () => {
      const row = await this.loadRawTournamentRow(db, params.tournamentId);
      if (!row) {
        return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Tournament not found.' };
      }
      if (row.status !== 'in_progress') {
        return {
          ok: false,
          status: 409,
          code: 'TOURNAMENT_CLOSED',
          message: 'Tournament is not currently in progress.',
        };
      }

      const mRow = await db
        .prepare(
          `SELECT * FROM tournament_matches
           WHERE tournament_id = ? AND bracket_match_id = ? LIMIT 1`,
        )
        .bind(params.tournamentId, params.bracketMatchId)
        .first<Record<string, unknown>>();
      if (!mRow) {
        return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Bracket match not found.' };
      }

      const match = this.mapMatchRow(mRow);
      if (match.status !== 'ready' && match.status !== 'in_progress') {
        return {
          ok: false,
          status: 409,
          code: 'MATCH_LOCKED',
          message: `This match is already ${match.status}.`,
        };
      }

      const isP1 = match.player1Id === params.playerId;
      const isP2 = match.player2Id === params.playerId;
      if (!isP1 && !isP2) {
        return {
          ok: false,
          status: 403,
          code: 'UNAUTHORIZED',
          message: 'You are not an assigned competitor in this bracket match.',
        };
      }

      // Prevent entering two simultaneous tournament matches across tournaments
      const otherActive = await db
        .prepare(
          `SELECT tm.bracket_match_id, tm.tournament_id
           FROM tournament_matches tm
           JOIN tournaments t ON t.tournament_id = tm.tournament_id
           WHERE t.status = 'in_progress'
             AND tm.status = 'in_progress'
             AND tm.bracket_match_id != ?
             AND (tm.player1_id = ? OR tm.player2_id = ?)
           LIMIT 1`,
        )
        .bind(match.bracketMatchId, params.playerId, params.playerId)
        .first<{ bracket_match_id: string; tournament_id: string }>();
      if (otherActive) {
        return {
          ok: false,
          status: 409,
          code: 'ALREADY_IN_MATCH',
          message: 'Finish your current active tournament match before joining another.',
        };
      }

      if (isP1) {
        await db
          .prepare('UPDATE tournament_matches SET player1_joined = 1 WHERE bracket_match_id = ?')
          .bind(match.bracketMatchId)
          .run();
        match.player1Joined = true;
      } else {
        await db
          .prepare('UPDATE tournament_matches SET player2_joined = 1 WHERE bracket_match_id = ?')
          .bind(match.bracketMatchId)
          .run();
        match.player2Joined = true;
      }

      const bothJoined = match.player1Joined && match.player2Joined;
      if (bothJoined && match.status === 'ready') {
        await db
          .prepare(
            `UPDATE tournament_matches
             SET status = 'in_progress', started_at_ms = COALESCE(started_at_ms, ?)
             WHERE bracket_match_id = ?`,
          )
          .bind(now, match.bracketMatchId)
          .run();
        match.status = 'in_progress';
        match.startedAtMs = match.startedAtMs ?? now;
      }

      const tournament = (await this.loadTournamentById(db, params.tournamentId, {
        viewerId: params.playerId,
        includeSecrets: true,
      }))!;

      return {
        ok: true,
        match,
        tournament,
        role: isP1 ? 'player1' : 'player2',
        bothJoined,
      };
    });
  }

  public async markMatchInProgress(
    tournamentId: string,
    bracketMatchId: string,
    nowMs: number = Date.now(),
  ): Promise<void> {
    const db = await this.ensureSchema();
    await this.withTournamentLock(tournamentId, async () => {
      await db
        .prepare(
          `UPDATE tournament_matches
           SET status = 'in_progress',
               player1_joined = 1,
               player2_joined = 1,
               started_at_ms = COALESCE(started_at_ms, ?)
           WHERE tournament_id = ? AND bracket_match_id = ? AND status = 'ready'`,
        )
        .bind(nowMs, tournamentId, bracketMatchId)
        .run();
    });
  }

  public async completeBracketMatch(params: {
    tournamentId: string;
    bracketMatchId: string;
    winnerId: string;
    matchId?: string | null;
    resolutionType?: TournamentMatchResolutionType;
    reason?: string;
    adminOverride?: boolean;
    nowMs?: number;
  }): Promise<
    | {
        ok: true;
        resolvedMatch: TournamentMatch;
        newlyReadyMatches: TournamentMatch[];
        tournament: TournamentRecord;
        completedTournament: TournamentRecord | null;
        roomIdToClose: string | null;
      }
    | TournamentServiceError
  > {
    const db = await this.ensureSchema();
    const now = params.nowMs ?? Date.now();

    return this.withTournamentLock(params.tournamentId, async () => {
      const row = await this.loadRawTournamentRow(db, params.tournamentId);
      if (!row) {
        return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Tournament not found.' };
      }
      if (row.status !== 'in_progress' && !params.adminOverride) {
        return {
          ok: false,
          status: 409,
          code: 'TOURNAMENT_CLOSED',
          message: 'Tournament is no longer in progress.',
        };
      }
      return this.resolveBracketMatchInternal(db, row, params.bracketMatchId, {
        winnerId: params.winnerId,
        matchId: params.matchId ?? null,
        resolutionType: params.resolutionType ?? 'played',
        reason: params.reason ?? 'Match completed.',
        nowMs: now,
        adminOverride: Boolean(params.adminOverride),
      });
    });
  }

  private async resolveBracketMatchInternal(
    db: ProgressionSqlDb,
    row: TournamentRow,
    bracketMatchId: string,
    opts: {
      winnerId: string;
      matchId?: string | null;
      resolutionType: TournamentMatchResolutionType;
      reason: string;
      nowMs: number;
      adminOverride?: boolean;
    },
  ): Promise<
    | {
        ok: true;
        resolvedMatch: TournamentMatch;
        newlyReadyMatches: TournamentMatch[];
        tournament: TournamentRecord;
        completedTournament: TournamentRecord | null;
        roomIdToClose: string | null;
      }
    | TournamentServiceError
  > {
    const mRow = await db
      .prepare('SELECT * FROM tournament_matches WHERE tournament_id = ? AND bracket_match_id = ? LIMIT 1')
      .bind(row.tournament_id, bracketMatchId)
      .first<Record<string, unknown>>();
    if (!mRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Bracket match not found.' };
    }

    const match = this.mapMatchRow(mRow);
    if (
      (match.status === 'completed' || match.status === 'bye' || match.status === 'forfeited') &&
      !opts.adminOverride
    ) {
      const tCurrent = (await this.loadTournamentById(db, row.tournament_id, { includeSecrets: true }))!;
      return {
        ok: true,
        resolvedMatch: match,
        newlyReadyMatches: [],
        tournament: tCurrent,
        completedTournament: tCurrent.status === 'completed' ? tCurrent : null,
        roomIdToClose: match.roomId,
      };
    }

    const winnerIsP1 = match.player1Id === opts.winnerId;
    const winnerIsP2 = match.player2Id === opts.winnerId;
    if (!winnerIsP1 && !winnerIsP2) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Winner must be one of the two assigned match participants.',
      };
    }

    const winnerName = winnerIsP1 ? match.player1Name : match.player2Name;
    const winnerAvatar = winnerIsP1 ? match.player1Avatar : match.player2Avatar;
    const winnerSeed = winnerIsP1 ? match.player1Seed : match.player2Seed;
    const loserId = winnerIsP1 ? match.player2Id : match.player1Id;
    const loserName = winnerIsP1 ? match.player2Name : match.player1Name;
    const loserAvatar = winnerIsP1 ? match.player2Avatar : match.player1Avatar;
    const loserSeed = winnerIsP1 ? match.player2Seed : match.player1Seed;

    const nextStatus: TournamentBracketMatchStatus =
      opts.resolutionType === 'bye'
        ? 'bye'
        : opts.resolutionType === 'forfeit' || opts.resolutionType === 'no_show'
          ? 'forfeited'
          : 'completed';

    await db
      .prepare(
        `UPDATE tournament_matches
         SET winner_id = ?, winner_name = ?, loser_id = ?, status = ?, match_id = COALESCE(?, match_id),
             resolution_type = ?, reason = ?, completed_at_ms = ?
         WHERE bracket_match_id = ?`,
      )
      .bind(
        opts.winnerId,
        winnerName,
        loserId,
        nextStatus,
        opts.matchId ?? null,
        opts.resolutionType,
        opts.reason,
        opts.nowMs,
        match.bracketMatchId,
      )
      .run();

    match.winnerId = opts.winnerId;
    match.winnerName = winnerName;
    match.loserId = loserId;
    match.status = nextStatus;
    match.resolutionType = opts.resolutionType;
    match.reason = opts.reason;
    match.completedAtMs = opts.nowMs;

    // Update match win/loss stats (skip BYEs)
    if (opts.resolutionType !== 'bye' && opts.winnerId && loserId) {
      await this.upsertTournamentPlayerStats(db, opts.winnerId, row.season_key, {
        matchesPlayedInc: 1,
        matchesWonInc: 1,
        nowMs: opts.nowMs,
      });
      await this.upsertTournamentPlayerStats(db, loserId, row.season_key, {
        matchesPlayedInc: 1,
        matchesLostInc: 1,
        nowMs: opts.nowMs,
      });
    }

    const totalRounds = Number(row.total_rounds || 1);
    const isSemiFinal = !match.isThirdPlaceMatch && match.roundNumber === totalRounds - 1 && totalRounds >= 2;
    const isFinal = !match.isThirdPlaceMatch && match.roundNumber === totalRounds;

    if (loserId && !match.isThirdPlaceMatch && !isSemiFinal && !isFinal) {
      await db
        .prepare(
          `UPDATE tournament_participants
           SET status = CASE WHEN status = 'withdrawn' THEN 'withdrawn' ELSE 'eliminated' END,
               eliminated_round = COALESCE(eliminated_round, ?)
           WHERE tournament_id = ? AND player_id = ?`,
        )
        .bind(match.roundNumber, row.tournament_id, loserId)
        .run();
    }

    const newlyReadyMatches: TournamentMatch[] = [];
    const deadlineMs = opts.nowMs + Number(row.match_deadline_ms || TOURNAMENT_LIMITS.defaultMatchDeadlineMs);

    // Advance Winner into next round match
    if (match.nextMatchId && match.nextMatchSlot) {
      const pCols =
        match.nextMatchSlot === 1
          ? 'player1_id = ?, player1_name = ?, player1_avatar = ?, player1_seed = ?'
          : 'player2_id = ?, player2_name = ?, player2_avatar = ?, player2_seed = ?';
      await db
        .prepare(`UPDATE tournament_matches SET ${pCols} WHERE bracket_match_id = ?`)
        .bind(opts.winnerId, winnerName, winnerAvatar, winnerSeed, match.nextMatchId)
        .run();

      const targetRow = await db
        .prepare('SELECT * FROM tournament_matches WHERE bracket_match_id = ? LIMIT 1')
        .bind(match.nextMatchId)
        .first<Record<string, unknown>>();
      if (targetRow) {
        const target = this.mapMatchRow(targetRow);
        if (target.player1Id && target.player2Id && target.status === 'pending') {
          await db
            .prepare(
              `UPDATE tournament_matches
               SET status = 'ready', ready_deadline_ms = ?
               WHERE bracket_match_id = ?`,
            )
            .bind(deadlineMs, target.bracketMatchId)
            .run();
          target.status = 'ready';
          target.readyDeadlineMs = deadlineMs;
          newlyReadyMatches.push(target);
        }
      }
    }

    // Feed Semi-final loser into Third-Place match
    if (isSemiFinal && loserId) {
      const thirdId = `${row.tournament_id}_third_place`;
      const thirdRow = await db
        .prepare('SELECT * FROM tournament_matches WHERE bracket_match_id = ? LIMIT 1')
        .bind(thirdId)
        .first<Record<string, unknown>>();
      if (thirdRow) {
        const slotCols =
          match.slotIndex === 0
            ? 'player1_id = ?, player1_name = ?, player1_avatar = ?, player1_seed = ?'
            : 'player2_id = ?, player2_name = ?, player2_avatar = ?, player2_seed = ?';
        await db
          .prepare(`UPDATE tournament_matches SET ${slotCols} WHERE bracket_match_id = ?`)
          .bind(loserId, loserName, loserAvatar, loserSeed, thirdId)
          .run();

        const updatedThirdRow = await db
          .prepare('SELECT * FROM tournament_matches WHERE bracket_match_id = ? LIMIT 1')
          .bind(thirdId)
          .first<Record<string, unknown>>();
        if (updatedThirdRow) {
          const third = this.mapMatchRow(updatedThirdRow);
          if (third.player1Id && third.player2Id && third.status === 'pending') {
            await db
              .prepare(
                `UPDATE tournament_matches
                 SET status = 'ready', ready_deadline_ms = ?
                 WHERE bracket_match_id = ?`,
              )
              .bind(deadlineMs, third.bracketMatchId)
              .run();
            third.status = 'ready';
            third.readyDeadlineMs = deadlineMs;
            newlyReadyMatches.push(third);
          }
        }
      }
    }

    // Advance current_round pointer
    const maxStartedRoundRow = await db
      .prepare(
        `SELECT MAX(round_number) AS max_r FROM tournament_matches
         WHERE tournament_id = ? AND status IN ('ready', 'in_progress', 'completed', 'forfeited')`,
      )
      .bind(row.tournament_id)
      .first<{ max_r: number | null }>();
    const currentRound = Math.max(1, Number(maxStartedRoundRow?.max_r ?? row.current_round ?? 1));
    await db
      .prepare('UPDATE tournaments SET current_round = ?, updated_at_ms = ? WHERE tournament_id = ?')
      .bind(currentRound, opts.nowMs, row.tournament_id)
      .run();

    await this.recordEvent(
      db,
      row.tournament_id,
      'match_resolved',
      opts.winnerId,
      `${match.roundLabel}: ${winnerName ?? opts.winnerId} defeated ${loserName ?? 'BYE'} (${opts.resolutionType}).`,
      { bracketMatchId: match.bracketMatchId, resolutionType: opts.resolutionType },
      opts.nowMs,
    );

    // Check Final / Third-Place completion
    const allMatchRows = await db
      .prepare('SELECT * FROM tournament_matches WHERE tournament_id = ?')
      .bind(row.tournament_id)
      .all<Record<string, unknown>>();
    const allMatches = (allMatchRows.results ?? []).map((r) => this.mapMatchRow(r));
    const finalMatch = allMatches.find(
      (m) => !m.isThirdPlaceMatch && m.roundNumber === totalRounds,
    );
    const thirdMatch = allMatches.find((m) => m.isThirdPlaceMatch);

    const isDoneStatus = (s: TournamentBracketMatchStatus) =>
      s === 'completed' || s === 'bye' || s === 'forfeited';

    let completedTournament: TournamentRecord | null = null;
    if (finalMatch && isDoneStatus(finalMatch.status)) {
      if (thirdMatch && !isDoneStatus(thirdMatch.status)) {
        // If third place has 0 or 1 players, auto-resolve BYE; if both semi-finals are done and nobody started 3rd-place room yet, auto-resolve by higher seed so Championship completes smoothly when Final finishes!
        const semisDone = allMatches
          .filter((m) => !m.isThirdPlaceMatch && m.roundNumber === totalRounds - 1)
          .every((m) => isDoneStatus(m.status));

        if (semisDone && thirdMatch.status !== 'in_progress') {
          if (thirdMatch.player1Id && thirdMatch.player2Id) {
            const p1WinsThird =
              (thirdMatch.player1Seed ?? 999) <= (thirdMatch.player2Seed ?? 999);
            const thirdWinId = p1WinsThird ? thirdMatch.player1Id : thirdMatch.player2Id;
            const thirdWinName = p1WinsThird ? thirdMatch.player1Name : thirdMatch.player2Name;
            const thirdLoseId = p1WinsThird ? thirdMatch.player2Id : thirdMatch.player1Id;
            await db
              .prepare(
                `UPDATE tournament_matches
                 SET winner_id = ?, winner_name = ?, loser_id = ?, status = 'bye',
                     resolution_type = 'bye', reason = 'Awarded 3rd place by higher tournament seed after Final completion.',
                     completed_at_ms = ?
                 WHERE bracket_match_id = ?`,
              )
              .bind(thirdWinId, thirdWinName, thirdLoseId, opts.nowMs, thirdMatch.bracketMatchId)
              .run();
            thirdMatch.winnerId = thirdWinId;
            thirdMatch.winnerName = thirdWinName;
            thirdMatch.loserId = thirdLoseId;
            thirdMatch.status = 'bye';
          } else {
            const soleWinnerId = thirdMatch.player1Id ?? thirdMatch.player2Id ?? null;
            const soleWinnerName = thirdMatch.player1Name ?? thirdMatch.player2Name ?? null;
            await db
              .prepare(
                `UPDATE tournament_matches
                 SET winner_id = ?, winner_name = ?, status = 'bye',
                     resolution_type = 'bye', reason = 'Automatic 3rd place BYE.',
                     completed_at_ms = ?
                 WHERE bracket_match_id = ?`,
              )
              .bind(soleWinnerId, soleWinnerName, opts.nowMs, thirdMatch.bracketMatchId)
              .run();
            thirdMatch.winnerId = soleWinnerId;
            thirdMatch.winnerName = soleWinnerName;
            thirdMatch.status = 'bye';
          }
        }
      }

      if (!thirdMatch || isDoneStatus(thirdMatch.status)) {
        completedTournament = await this.finalizeTournamentAndDistributePrizes(
          db,
          row,
          finalMatch,
          thirdMatch ?? null,
          opts.nowMs,
        );
      }
    }

    const updatedTournament =
      completedTournament ??
      (await this.loadTournamentById(db, row.tournament_id, { includeSecrets: true }))!;

    return {
      ok: true,
      resolvedMatch: match,
      newlyReadyMatches,
      tournament: updatedTournament,
      completedTournament,
      roomIdToClose: match.roomId,
    };
  }

  private async finalizeTournamentAndDistributePrizes(
    db: ProgressionSqlDb,
    row: TournamentRow,
    finalMatch: TournamentMatch,
    thirdMatch: TournamentMatch | null,
    nowMs: number,
  ): Promise<TournamentRecord> {
    const championId = finalMatch.winnerId;
    const championName = finalMatch.winnerName;
    const runnerUpId = finalMatch.loserId;
    const runnerUpName =
      runnerUpId && runnerUpId === finalMatch.player1Id
        ? finalMatch.player1Name
        : runnerUpId && runnerUpId === finalMatch.player2Id
          ? finalMatch.player2Name
          : null;
    const thirdId = thirdMatch?.winnerId ?? null;
    const thirdName = thirdMatch?.winnerName ?? null;
    const fourthId = thirdMatch?.loserId ?? null;

    await db
      .prepare(
        `UPDATE tournaments
         SET status = 'completed',
             completed_at_ms = COALESCE(completed_at_ms, ?),
             champion_player_id = ?, champion_display_name = ?,
             runner_up_player_id = ?, runner_up_display_name = ?,
             third_place_player_id = ?, third_place_display_name = ?,
             updated_at_ms = ?
         WHERE tournament_id = ?`,
      )
      .bind(
        nowMs,
        championId,
        championName,
        runnerUpId,
        runnerUpName,
        thirdId,
        thirdName,
        nowMs,
        row.tournament_id,
      )
      .run();

    const partRows = await db
      .prepare(
        `SELECT * FROM tournament_participants
         WHERE tournament_id = ? AND status != 'withdrawn'
         ORDER BY COALESCE(seed, 9999) ASC`,
      )
      .bind(row.tournament_id)
      .all<Record<string, unknown>>();
    const participants = (partRows.results ?? []).map((r) => this.mapParticipantRow(r));
    const prizes = this.parsePrizes(row.type as TournamentType, row.prizes_json);
    const economy = new EconomyService(this.db);

    let rankCursor = 5;
    for (const p of participants) {
      let placementType: 'champion' | 'runner_up' | 'third_place' | 'participant' = 'participant';
      let participantStatus: TournamentParticipantStatus = 'eliminated';
      let placementNum = rankCursor;
      let coinAmount = prizes.participantCoins;
      let badgeAwarded: string | null = null;
      let trophyAwarded: string | null = null;

      if (p.playerId === championId) {
        placementType = 'champion';
        participantStatus = 'champion';
        placementNum = 1;
        coinAmount = prizes.championCoins;
        badgeAwarded = prizes.championBadgeId;
        trophyAwarded = prizes.trophyId;
      } else if (p.playerId === runnerUpId) {
        placementType = 'runner_up';
        participantStatus = 'runner_up';
        placementNum = 2;
        coinAmount = prizes.runnerUpCoins;
        badgeAwarded = prizes.finalistBadgeId;
        trophyAwarded = 'trophy_grand_finalist';
      } else if (p.playerId === thirdId) {
        placementType = 'third_place';
        participantStatus = 'third_place';
        placementNum = 3;
        coinAmount = prizes.thirdPlaceCoins;
        badgeAwarded = 'badge_tournament_contender';
        trophyAwarded = 'trophy_podium_finish';
      } else if (p.playerId === fourthId) {
        placementNum = 4;
      } else {
        rankCursor++;
      }

      await db
        .prepare(
          `UPDATE tournament_participants
           SET status = ?, placement = ?
           WHERE tournament_id = ? AND player_id = ?`,
        )
        .bind(participantStatus, placementNum, row.tournament_id, p.playerId)
        .run();

      // Atomic idempotency guard for payouts
      const payoutId = generateId('pay');
      const payoutInsert = await db
        .prepare(
          `INSERT OR IGNORE INTO tournament_payouts (
            payout_id, tournament_id, player_id, display_name, placement,
            coins_awarded, badge_awarded, trophy_awarded, awarded_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          payoutId,
          row.tournament_id,
          p.playerId,
          p.displayName,
          placementType,
          coinAmount,
          badgeAwarded,
          trophyAwarded,
          nowMs,
        )
        .run();

      if ((payoutInsert.meta?.changes ?? 0) > 0) {
        if (coinAmount > 0) {
          await economy.awardCustomTournamentCoins({
            tournamentId: row.tournament_id,
            tournamentTitle: row.title,
            playerId: p.playerId,
            placement: placementType,
            amount: coinAmount,
            awardedAtMs: nowMs,
          });
        }

        if (badgeAwarded) {
          await economy.grantExclusiveCosmetic(p.playerId, badgeAwarded, 'tournament_reward', nowMs);
        }
        if (placementType === 'champion' && prizes.finalistBadgeId) {
          await economy.grantExclusiveCosmetic(
            p.playerId,
            prizes.finalistBadgeId,
            'tournament_reward',
            nowMs,
          );
        }

        if (trophyAwarded && TOURNAMENT_TROPHY_MAP.has(trophyAwarded)) {
          await this.grantTrophy(db, p.playerId, trophyAwarded, row.tournament_id, row.title, nowMs);
        }
        if (placementType === 'champion') {
          await this.grantTrophy(
            db,
            p.playerId,
            'trophy_first_champion',
            row.tournament_id,
            row.title,
            nowMs,
          );
          if (row.type === 'weekly') {
            await this.grantTrophy(
              db,
              p.playerId,
              'trophy_weekly_championship',
              row.tournament_id,
              row.title,
              nowMs,
            );
          }
          await this.grantTrophy(
            db,
            p.playerId,
            'trophy_podium_finish',
            row.tournament_id,
            row.title,
            nowMs,
          );
        }

        await this.upsertTournamentPlayerStats(db, p.playerId, row.season_key, {
          championshipsInc: placementType === 'champion' ? 1 : 0,
          finalsInc: placementType === 'champion' || placementType === 'runner_up' ? 1 : 0,
          thirdPlaceInc: placementType === 'third_place' ? 1 : 0,
          coinsWonInc: coinAmount,
          nowMs,
        });

        if (placementType === 'champion') {
          const statsRow = await db
            .prepare('SELECT championships FROM tournament_player_stats WHERE player_id = ? LIMIT 1')
            .bind(p.playerId)
            .first<{ championships: number }>();
          if (Number(statsRow?.championships ?? 0) >= 3) {
            await this.grantTrophy(
              db,
              p.playerId,
              'trophy_dynasty_3',
              row.tournament_id,
              row.title,
              nowMs,
            );
          }
        }
      }
    }

    await this.recordEvent(
      db,
      row.tournament_id,
      'tournament_completed',
      championId,
      `${row.title} completed! Champion: ${championName ?? 'Unknown'} (${prizes.championCoins} POOL COINS).`,
      { championId, runnerUpId, thirdId },
      nowMs,
    );

    return (await this.loadTournamentById(db, row.tournament_id, { includeSecrets: true }))!;
  }

  public async cancelTournament(params: {
    tournamentId: string;
    actorPlayerId: string | null;
    isAdmin?: boolean;
    reason?: string;
    nowMs?: number;
  }): Promise<
    | { ok: true; tournament: TournamentRecord; roomIdsToClose: string[]; refundedCount: number }
    | TournamentServiceError
  > {
    const db = await this.ensureSchema();
    const now = params.nowMs ?? Date.now();

    return this.withTournamentLock(params.tournamentId, async () => {
      const row = await this.loadRawTournamentRow(db, params.tournamentId);
      if (!row) {
        return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Tournament not found.' };
      }

      if (!params.isAdmin) {
        const isCreator = Boolean(params.actorPlayerId && row.created_by_player_id === params.actorPlayerId);
        if (!isCreator || Number(row.is_private) !== 1) {
          return {
            ok: false,
            status: 403,
            code: 'FORBIDDEN',
            message: 'Only the host or a tournament administrator can cancel this tournament.',
          };
        }
      }

      if (row.status === 'completed' || row.status === 'cancelled') {
        return {
          ok: false,
          status: 409,
          code: 'TOURNAMENT_CLOSED',
          message: `Tournament is already ${row.status}.`,
        };
      }

      const { roomIdsToClose, refundedCount } = await this.cancelAndRefundInternal(
        db,
        row,
        params.actorPlayerId,
        params.reason?.trim() || 'Tournament cancelled by organizer.',
        now,
      );

      const updated = (await this.loadTournamentById(db, params.tournamentId, {
        includeSecrets: true,
      }))!;
      return { ok: true, tournament: updated, roomIdsToClose, refundedCount };
    });
  }

  private async cancelAndRefundInternal(
    db: ProgressionSqlDb,
    row: TournamentRow,
    actorPlayerId: string | null,
    reason: string,
    nowMs: number,
  ): Promise<{ roomIdsToClose: string[]; refundedCount: number }> {
    const openRooms = await db
      .prepare(
        `SELECT room_id FROM tournament_matches
         WHERE tournament_id = ? AND room_id IS NOT NULL AND status IN ('ready', 'in_progress')`,
      )
      .bind(row.tournament_id)
      .all<{ room_id: string }>();
    const roomIdsToClose = (openRooms.results ?? []).map((r) => String(r.room_id));

    await db
      .prepare(
        `UPDATE tournaments SET status = 'cancelled', updated_at_ms = ? WHERE tournament_id = ?`,
      )
      .bind(nowMs, row.tournament_id)
      .run();

    await db
      .prepare(
        `UPDATE tournament_matches
         SET status = CASE WHEN status IN ('pending', 'ready', 'in_progress') THEN 'forfeited' ELSE status END,
             reason = COALESCE(reason, ?)
         WHERE tournament_id = ?`,
      )
      .bind(reason, row.tournament_id)
      .run();

    let refundedCount = 0;
    const entryFee = Number(row.entry_fee_coins ?? 0);
    if (entryFee > 0) {
      const partRows = await db
        .prepare(
          `SELECT player_id FROM tournament_participants WHERE tournament_id = ? AND status != 'withdrawn'`,
        )
        .bind(row.tournament_id)
        .all<{ player_id: string }>();
      const economy = new EconomyService(this.db);
      for (const p of partRows.results ?? []) {
        const ref = await economy.refundTournamentEntryFee({
          tournamentId: row.tournament_id,
          tournamentTitle: row.title,
          playerId: String(p.player_id),
          amount: entryFee,
          reasonLabel: `Refund (${row.title} cancelled)`,
          nowMs,
        });
        if (ref.refunded > 0) refundedCount++;
      }
    }

    await this.recordEvent(
      db,
      row.tournament_id,
      'tournament_cancelled',
      actorPlayerId,
      reason,
      { refundedCount },
      nowMs,
    );

    return { roomIdsToClose, refundedCount };
  }

  public async processDueTimers(
    nowMs: number = Date.now(),
    targetTournamentId?: string,
  ): Promise<{
    startedTournaments: Array<{ tournament: TournamentRecord; readyMatches: TournamentMatch[] }>;
    resolvedMatches: Array<{
      tournamentId: string;
      resolvedMatch: TournamentMatch;
      newlyReadyMatches: TournamentMatch[];
      roomIdToClose: string | null;
      completedTournament: TournamentRecord | null;
    }>;
  }> {
    const db = await this.ensureSchema();
    const startedTournaments: Array<{ tournament: TournamentRecord; readyMatches: TournamentMatch[] }> =
      [];
    const resolvedMatches: Array<{
      tournamentId: string;
      resolvedMatch: TournamentMatch;
      newlyReadyMatches: TournamentMatch[];
      roomIdToClose: string | null;
      completedTournament: TournamentRecord | null;
    }> = [];

    const scopeWhere = targetTournamentId ? 'AND tournament_id = ?' : '';

    // 1. Open upcoming tournaments whose registrationOpensAtMs has passed
    if (targetTournamentId) {
      await db
        .prepare(
          `UPDATE tournaments SET status = 'registration_open', updated_at_ms = ?
           WHERE status = 'upcoming' AND registration_opens_at_ms <= ? AND tournament_id = ?`,
        )
        .bind(nowMs, nowMs, targetTournamentId)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE tournaments SET status = 'registration_open', updated_at_ms = ?
           WHERE status = 'upcoming' AND registration_opens_at_ms <= ?`,
        )
        .bind(nowMs, nowMs)
        .run();
    }

    // 2. Start registration_open tournaments past registrationClosesAtMs
    const dueToStart = targetTournamentId
      ? await db
          .prepare(
            `SELECT tournament_id FROM tournaments
             WHERE status = 'registration_open' AND registration_closes_at_ms <= ? ${scopeWhere}`,
          )
          .bind(nowMs, targetTournamentId)
          .all<{ tournament_id: string }>()
      : await db
          .prepare(
            `SELECT tournament_id FROM tournaments
             WHERE status = 'registration_open' AND registration_closes_at_ms <= ?`,
          )
          .bind(nowMs)
          .all<{ tournament_id: string }>();

    for (const r of dueToStart.results ?? []) {
      const res = await this.startTournamentBracket(String(r.tournament_id), {
        isAdmin: true,
        nowMs,
      });
      if (res.ok) {
        startedTournaments.push({
          tournament: res.tournament,
          readyMatches: res.readyMatches,
        });
      }
    }

    // 3. Enforce match deadlines (no-show & stalled matches)
    const dueMatches = targetTournamentId
      ? await db
          .prepare(
            `SELECT tm.* FROM tournament_matches tm
             JOIN tournaments t ON t.tournament_id = tm.tournament_id
             WHERE t.status = 'in_progress'
               AND tm.status IN ('ready', 'in_progress')
               AND tm.ready_deadline_ms IS NOT NULL
               AND tm.ready_deadline_ms <= ?
               AND tm.tournament_id = ?`,
          )
          .bind(nowMs, targetTournamentId)
          .all<Record<string, unknown>>()
      : await db
          .prepare(
            `SELECT tm.* FROM tournament_matches tm
             JOIN tournaments t ON t.tournament_id = tm.tournament_id
             WHERE t.status = 'in_progress'
               AND tm.status IN ('ready', 'in_progress')
               AND tm.ready_deadline_ms IS NOT NULL
               AND tm.ready_deadline_ms <= ?`,
          )
          .bind(nowMs)
          .all<Record<string, unknown>>();

    for (const mRow of dueMatches.results ?? []) {
      const m = this.mapMatchRow(mRow);
      if (!m.player1Id && !m.player2Id) continue;

      let winnerId: string;
      let reason: string;
      if (m.player1Joined && !m.player2Joined && m.player1Id) {
        winnerId = m.player1Id;
        reason = `${m.player2Name ?? 'Opponent'} failed to join before the match deadline (No-Show).`;
      } else if (m.player2Joined && !m.player1Joined && m.player2Id) {
        winnerId = m.player2Id;
        reason = `${m.player1Name ?? 'Opponent'} failed to join before the match deadline (No-Show).`;
      } else if (m.player1Id && m.player2Id) {
        const p1BetterSeed = (m.player1Seed ?? 999) <= (m.player2Seed ?? 999);
        winnerId = p1BetterSeed ? m.player1Id : m.player2Id;
        reason = 'Match deadline expired; advanced by higher tournament seed.';
      } else {
        winnerId = (m.player1Id ?? m.player2Id)!;
        reason = 'Match deadline expired; advancing sole available player.';
      }

      const resolved = await this.completeBracketMatch({
        tournamentId: m.tournamentId,
        bracketMatchId: m.bracketMatchId,
        winnerId,
        resolutionType: 'no_show',
        reason,
        nowMs,
      });

      if (resolved.ok) {
        resolvedMatches.push({
          tournamentId: m.tournamentId,
          resolvedMatch: resolved.resolvedMatch,
          newlyReadyMatches: resolved.newlyReadyMatches,
          roomIdToClose: resolved.roomIdToClose,
          completedTournament: resolved.completedTournament,
        });
      }
    }

    return { startedTournaments, resolvedMatches };
  }

  public async getEarliestDueTimestampMs(): Promise<number | null> {
    const db = await this.ensureSchema();
    const tRow = await db
      .prepare(
        `SELECT MIN(ts) AS earliest FROM (
           SELECT MIN(registration_opens_at_ms) AS ts FROM tournaments WHERE status = 'upcoming'
           UNION ALL
           SELECT MIN(registration_closes_at_ms) AS ts FROM tournaments WHERE status = 'registration_open'
           UNION ALL
           SELECT MIN(tm.ready_deadline_ms) AS ts
           FROM tournament_matches tm
           JOIN tournaments t ON t.tournament_id = tm.tournament_id
           WHERE t.status = 'in_progress'
             AND tm.status IN ('ready', 'in_progress')
             AND tm.ready_deadline_ms IS NOT NULL
         )`,
      )
      .first<{ earliest: number | null }>();
    const v = tRow?.earliest;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  public async getTournamentLeaderboard(params?: {
    seasonKey?: string | null;
    limit?: number;
  }): Promise<TournamentLeaderboardEntry[]> {
    const db = await this.ensureSchema();
    const limit = Math.max(1, Math.min(50, Math.floor(params?.limit ?? 25)));
    const seasonFilter = params?.seasonKey?.trim();

    if (seasonFilter && seasonFilter !== 'ALL') {
      // Aggregate per-season directly from tournament records & matches
      const partRows = await db
        .prepare(
          `SELECT
             tp.player_id,
             COALESCE(p.display_name, tp.display_name) AS display_name,
             COALESCE(p.avatar_id, tp.avatar_id) AS avatar_id,
             COALESCE(p.elo, tp.elo) AS elo,
             SUM(CASE WHEN tp.status = 'champion' THEN 1 ELSE 0 END) AS championships,
             SUM(CASE WHEN tp.status IN ('champion', 'runner_up') THEN 1 ELSE 0 END) AS finals_appearances,
             SUM(CASE WHEN tp.status IN ('champion', 'runner_up', 'third_place') THEN 1 ELSE 0 END) AS podiums,
             COUNT(DISTINCT tp.tournament_id) AS tournaments_played
           FROM tournament_participants tp
           JOIN tournaments t ON t.tournament_id = tp.tournament_id
           LEFT JOIN players p ON p.player_id = tp.player_id
           WHERE t.season_key = ? AND tp.status != 'withdrawn' AND t.status IN ('in_progress', 'completed')
           GROUP BY tp.player_id
           ORDER BY championships DESC, finals_appearances DESC, podiums DESC, elo DESC
           LIMIT ?`,
        )
        .bind(seasonFilter, limit)
        .all<Record<string, unknown>>();

      const results: TournamentLeaderboardEntry[] = [];
      let rank = 1;
      for (const r of partRows.results ?? []) {
        const pid = String(r.player_id);
        const matchCounts = await db
          .prepare(
            `SELECT
               SUM(CASE WHEN tm.winner_id = ? THEN 1 ELSE 0 END) AS won,
               SUM(CASE WHEN tm.loser_id = ? THEN 1 ELSE 0 END) AS lost
             FROM tournament_matches tm
             JOIN tournaments t ON t.tournament_id = tm.tournament_id
             WHERE t.season_key = ? AND tm.resolution_type != 'bye' AND (tm.winner_id = ? OR tm.loser_id = ?)`,
          )
          .bind(pid, pid, seasonFilter, pid, pid)
          .first<{ won: number | null; lost: number | null }>();
        const coinRow = await db
          .prepare(
            `SELECT COALESCE(SUM(tp.coins_awarded), 0) AS total_coins
             FROM tournament_payouts tp
             JOIN tournaments t ON t.tournament_id = tp.tournament_id
             WHERE t.season_key = ? AND tp.player_id = ?`,
          )
          .bind(seasonFilter, pid)
          .first<{ total_coins: number | null }>();

        const won = Number(matchCounts?.won ?? 0);
        const lost = Number(matchCounts?.lost ?? 0);
        const played = won + lost;
        results.push({
          rank: rank++,
          playerId: pid,
          displayName: String(r.display_name),
          avatarId: sanitizeAvatarId(r.avatar_id),
          elo: Number(r.elo ?? 1200),
          championships: Number(r.championships ?? 0),
          finalsAppearances: Number(r.finals_appearances ?? 0),
          podiums: Number(r.podiums ?? 0),
          tournamentsPlayed: Number(r.tournaments_played ?? 0),
          matchesWon: won,
          matchesLost: lost,
          winRate: played > 0 ? Math.round((won / played) * 1000) / 10 : 0,
          totalCoinsWon: Number(coinRow?.total_coins ?? 0),
        });
      }
      return results;
    }

    const rows = await db
      .prepare(
        `SELECT s.*,
           COALESCE(p.display_name, 'Player') AS display_name,
           COALESCE(p.avatar_id, 'cue_gold') AS avatar_id,
           COALESCE(p.elo, 1200) AS elo
         FROM tournament_player_stats s
         LEFT JOIN players p ON p.player_id = s.player_id
         ORDER BY s.championships DESC, s.finals_appearances DESC, s.third_place_finishes DESC, s.matches_won DESC, elo DESC
         LIMIT ?`,
      )
      .bind(limit)
      .all<Record<string, unknown>>();

    return (rows.results ?? []).map((r, idx) => {
      const won = Number(r.matches_won ?? 0);
      const lost = Number(r.matches_lost ?? 0);
      const played = won + lost;
      return {
        rank: idx + 1,
        playerId: String(r.player_id),
        displayName: String(r.display_name),
        avatarId: sanitizeAvatarId(r.avatar_id),
        elo: Number(r.elo ?? 1200),
        championships: Number(r.championships ?? 0),
        finalsAppearances: Number(r.finals_appearances ?? 0),
        podiums:
          Number(r.championships ?? 0) +
          Number(r.finals_appearances ?? 0) -
          Number(r.championships ?? 0) +
          Number(r.third_place_finishes ?? 0),
        tournamentsPlayed: Number(r.tournaments_entered ?? 0),
        matchesWon: won,
        matchesLost: lost,
        winRate: played > 0 ? Math.round((won / played) * 1000) / 10 : 0,
        totalCoinsWon: Number(r.total_coins_won ?? 0),
      };
    });
  }

  public async getPlayerTournamentStats(playerId: string): Promise<PlayerTournamentStats> {
    const db = await this.ensureSchema();
    const pRow = await this.resolvePlayerProfileRow(db, playerId);

    const statsRow = await db
      .prepare('SELECT * FROM tournament_player_stats WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<Record<string, unknown>>();

    const trophyRows = await db
      .prepare(
        'SELECT * FROM tournament_trophies WHERE player_id = ? ORDER BY unlocked_at_ms DESC',
      )
      .bind(playerId)
      .all<Record<string, unknown>>();

    const historyRows = await db
      .prepare(
        `SELECT t.tournament_id, t.title, t.type, t.status, t.max_players, t.completed_at_ms,
                tp.placement, tp.status AS participant_status, tp.joined_at_ms,
                COALESCE((SELECT SUM(coins_awarded) FROM tournament_payouts pay
                          WHERE pay.tournament_id = t.tournament_id AND pay.player_id = tp.player_id), 0) AS coins_won
         FROM tournament_participants tp
         JOIN tournaments t ON t.tournament_id = tp.tournament_id
         WHERE tp.player_id = ? AND tp.status != 'withdrawn'
         ORDER BY tp.joined_at_ms DESC
         LIMIT 20`,
      )
      .bind(playerId)
      .all<Record<string, unknown>>();

    const trophies: TournamentTrophyUnlock[] = [];
    for (const r of trophyRows.results ?? []) {
      const def = TOURNAMENT_TROPHY_MAP.get(String(r.trophy_id));
      if (def) {
        trophies.push({
          ...def,
          tournamentId: String(r.tournament_id),
          tournamentTitle: String(r.tournament_title),
          unlockedAtMs: Number(r.unlocked_at_ms),
        });
      }
    }

    const recentTournaments: PlayerTournamentHistoryItem[] = (historyRows.results ?? []).map((r) => ({
      tournamentId: String(r.tournament_id),
      title: String(r.title),
      type: String(r.type) as TournamentType,
      status: String(r.status) as TournamentStatus,
      maxPlayers: sanitizeTournamentCapacity(r.max_players),
      placement: r.placement === null || r.placement === undefined ? null : Number(r.placement),
      participantStatus: String(r.participant_status) as TournamentParticipantStatus,
      coinsWon: Number(r.coins_won ?? 0),
      completedAtMs:
        r.completed_at_ms === null || r.completed_at_ms === undefined
          ? null
          : Number(r.completed_at_ms),
      joinedAtMs: Number(r.joined_at_ms),
    }));

    const won = Number(statsRow?.matches_won ?? 0);
    const lost = Number(statsRow?.matches_lost ?? 0);
    const played = Number(statsRow?.matches_played ?? won + lost);

    return {
      playerId,
      displayName: pRow.displayName,
      avatarId: pRow.avatarId,
      elo: pRow.elo,
      championships: Number(statsRow?.championships ?? 0),
      finalsAppearances: Number(statsRow?.finals_appearances ?? 0),
      thirdPlaceFinishes: Number(statsRow?.third_place_finishes ?? 0),
      tournamentsEntered: Number(statsRow?.tournaments_entered ?? 0),
      matchesPlayed: played,
      matchesWon: won,
      matchesLost: lost,
      winRate: played > 0 ? Math.round((won / played) * 1000) / 10 : 0,
      totalCoinsWon: Number(statsRow?.total_coins_won ?? 0),
      trophies,
      recentTournaments,
    };
  }

  public async getMatchesByTournament(tournamentId: string): Promise<TournamentMatch[]> {
    const db = await this.ensureSchema();
    const rows = await db
      .prepare(
        `SELECT * FROM tournament_matches
         WHERE tournament_id = ?
         ORDER BY is_third_place_match ASC, round_number ASC, slot_index ASC`,
      )
      .bind(tournamentId)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map((r) => this.mapMatchRow(r));
  }

  private async loadRawTournamentRow(
    db: ProgressionSqlDb,
    tournamentId: string,
  ): Promise<TournamentRow | null> {
    return db
      .prepare(
        `SELECT t.*,
          (SELECT COUNT(*) FROM tournament_participants tp
           WHERE tp.tournament_id = t.tournament_id AND tp.status != 'withdrawn') AS participant_count
         FROM tournaments t
         WHERE t.tournament_id = ? LIMIT 1`,
      )
      .bind(tournamentId)
      .first<TournamentRow>();
  }

  private async loadTournamentById(
    db: ProgressionSqlDb,
    tournamentId: string,
    opts?: { viewerId?: string | null; includeSecrets?: boolean },
  ): Promise<TournamentRecord | null> {
    const row = await this.loadRawTournamentRow(db, tournamentId);
    if (!row) return null;
    let viewerRegistered = false;
    if (opts?.viewerId) {
      const reg = await db
        .prepare(
          `SELECT 1 FROM tournament_participants
           WHERE tournament_id = ? AND player_id = ? AND status != 'withdrawn' LIMIT 1`,
        )
        .bind(tournamentId, opts.viewerId)
        .first();
      viewerRegistered = Boolean(reg);
    }
    const isCreator = Boolean(opts?.viewerId && row.created_by_player_id === opts.viewerId);
    return this.mapTournamentRow(row, {
      viewerRegistered,
      includeInviteCode: Boolean(opts?.includeSecrets || viewerRegistered || isCreator),
    });
  }

  private async resolvePlayerProfileRow(
    db: ProgressionSqlDb,
    playerId: string,
  ): Promise<{ playerId: string; displayName: string; avatarId: OnlineAvatarId; elo: number }> {
    const row = await db
      .prepare('SELECT player_id, display_name, avatar_id, elo FROM players WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<{ player_id: string; display_name: string; avatar_id: string; elo: number }>();

    if (row) {
      return {
        playerId: String(row.player_id),
        displayName: sanitizeDisplayName(row.display_name),
        avatarId: sanitizeAvatarId(row.avatar_id),
        elo: Number(row.elo ?? 1200),
      };
    }

    const ensured = await new D1ProgressionService(this.db).ensureRowForExternalId(
      playerId,
      'Player',
      'cue_gold',
    );
    return {
      playerId: ensured.player_id,
      displayName: sanitizeDisplayName(ensured.display_name),
      avatarId: sanitizeAvatarId(ensured.avatar_id),
      elo: Number(ensured.elo ?? 1200),
    };
  }

  private async upsertTournamentPlayerStats(
    db: ProgressionSqlDb,
    playerId: string,
    seasonKey: string,
    inc: {
      championshipsInc?: number;
      finalsInc?: number;
      thirdPlaceInc?: number;
      tournamentsEnteredInc?: number;
      matchesPlayedInc?: number;
      matchesWonInc?: number;
      matchesLostInc?: number;
      coinsWonInc?: number;
      nowMs: number;
    },
  ): Promise<void> {
    await db
      .prepare(
        `INSERT OR IGNORE INTO tournament_player_stats (
          player_id, season_key, championships, finals_appearances, third_place_finishes,
          tournaments_entered, matches_played, matches_won, matches_lost, total_coins_won, updated_at_ms
        ) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)`,
      )
      .bind(playerId, seasonKey, inc.nowMs)
      .run();

    await db
      .prepare(
        `UPDATE tournament_player_stats
         SET season_key = ?,
             championships = championships + ?,
             finals_appearances = finals_appearances + ?,
             third_place_finishes = third_place_finishes + ?,
             tournaments_entered = tournaments_entered + ?,
             matches_played = matches_played + ?,
             matches_won = matches_won + ?,
             matches_lost = matches_lost + ?,
             total_coins_won = total_coins_won + ?,
             updated_at_ms = ?
         WHERE player_id = ?`,
      )
      .bind(
        seasonKey,
        inc.championshipsInc ?? 0,
        inc.finalsInc ?? 0,
        inc.thirdPlaceInc ?? 0,
        inc.tournamentsEnteredInc ?? 0,
        inc.matchesPlayedInc ?? 0,
        inc.matchesWonInc ?? 0,
        inc.matchesLostInc ?? 0,
        inc.coinsWonInc ?? 0,
        inc.nowMs,
        playerId,
      )
      .run();
  }

  private async grantTrophy(
    db: ProgressionSqlDb,
    playerId: string,
    trophyId: string,
    tournamentId: string,
    tournamentTitle: string,
    nowMs: number,
  ): Promise<void> {
    await db
      .prepare(
        `INSERT OR IGNORE INTO tournament_trophies (
          player_id, trophy_id, tournament_id, tournament_title, unlocked_at_ms
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(playerId, trophyId, tournamentId, tournamentTitle, nowMs)
      .run();
  }

  private async recordEvent(
    db: ProgressionSqlDb,
    tournamentId: string,
    eventType: string,
    actorPlayerId: string | null,
    summary: string,
    metadata: Record<string, string | number | boolean | null> | null,
    createdAtMs: number,
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO tournament_events (
          event_id, tournament_id, event_type, actor_player_id, summary, metadata_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        generateId('tev'),
        tournamentId,
        eventType,
        actorPlayerId,
        summary,
        metadata ? JSON.stringify(metadata) : null,
        createdAtMs,
      )
      .run();
  }

  private parsePrizes(type: TournamentType, jsonRaw: string): TournamentPrizeConfig {
    try {
      const parsed = JSON.parse(jsonRaw) as Partial<TournamentPrizeConfig>;
      return sanitizePrizeConfig(type, parsed);
    } catch {
      return sanitizePrizeConfig(type, null);
    }
  }

  private mapTournamentRow(
    row: TournamentRow,
    opts?: { viewerRegistered?: boolean; includeInviteCode?: boolean },
  ): TournamentRecord {
    const type = (VALID_TYPES.has(row.type as TournamentType) ? row.type : 'quick') as TournamentType;
    return {
      tournamentId: String(row.tournament_id),
      title: String(row.title),
      description: String(row.description ?? ''),
      type,
      status: String(row.status) as TournamentStatus,
      maxPlayers: sanitizeTournamentCapacity(row.max_players),
      minPlayers: Number(row.min_players ?? 2),
      ruleProfileId: row.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
      calledShotsEnabled: Number(row.called_shots_enabled) === 1,
      entryFeeCoins: Number(row.entry_fee_coins ?? 0),
      minElo: Number(row.min_elo ?? 0),
      isPrivate: Number(row.is_private) === 1,
      inviteCode: opts?.includeInviteCode && row.invite_code ? String(row.invite_code) : null,
      createdByPlayerId: row.created_by_player_id ? String(row.created_by_player_id) : null,
      createdByName: String(row.created_by_name ?? 'Tournament Admin'),
      seasonKey: String(row.season_key),
      prizes: this.parsePrizes(type, String(row.prizes_json)),
      registrationOpensAtMs: Number(row.registration_opens_at_ms),
      registrationClosesAtMs: Number(row.registration_closes_at_ms),
      startsAtMs: Number(row.starts_at_ms),
      startedAtMs:
        row.started_at_ms === null || row.started_at_ms === undefined
          ? null
          : Number(row.started_at_ms),
      completedAtMs:
        row.completed_at_ms === null || row.completed_at_ms === undefined
          ? null
          : Number(row.completed_at_ms),
      matchDeadlineMs: Number(row.match_deadline_ms ?? TOURNAMENT_LIMITS.defaultMatchDeadlineMs),
      participantCount: Number(row.participant_count ?? 0),
      bracketSize: Number(row.bracket_size ?? 0),
      totalRounds: Number(row.total_rounds ?? 0),
      currentRound: Number(row.current_round ?? 0),
      championPlayerId: row.champion_player_id ? String(row.champion_player_id) : null,
      championDisplayName: row.champion_display_name ? String(row.champion_display_name) : null,
      runnerUpPlayerId: row.runner_up_player_id ? String(row.runner_up_player_id) : null,
      runnerUpDisplayName: row.runner_up_display_name ? String(row.runner_up_display_name) : null,
      thirdPlacePlayerId: row.third_place_player_id ? String(row.third_place_player_id) : null,
      thirdPlaceDisplayName: row.third_place_display_name
        ? String(row.third_place_display_name)
        : null,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      viewerRegistered: opts?.viewerRegistered,
    };
  }

  private mapParticipantRow(r: Record<string, unknown>): TournamentParticipant {
    return {
      tournamentId: String(r.tournament_id),
      playerId: String(r.player_id),
      displayName: String(r.display_name),
      avatarId: sanitizeAvatarId(r.avatar_id),
      elo: Number(r.elo ?? 1200),
      seed: r.seed === null || r.seed === undefined ? null : Number(r.seed),
      status: String(r.status) as TournamentParticipantStatus,
      placement: r.placement === null || r.placement === undefined ? null : Number(r.placement),
      joinedAtMs: Number(r.joined_at_ms),
      eliminatedRound:
        r.eliminated_round === null || r.eliminated_round === undefined
          ? null
          : Number(r.eliminated_round),
    };
  }

  private mapMatchRow(r: Record<string, unknown>): TournamentMatch {
    return {
      bracketMatchId: String(r.bracket_match_id),
      tournamentId: String(r.tournament_id),
      roundNumber: Number(r.round_number),
      roundLabel: String(r.round_label),
      slotIndex: Number(r.slot_index),
      isThirdPlaceMatch: Number(r.is_third_place_match) === 1,
      player1Id: r.player1_id ? String(r.player1_id) : null,
      player1Name: r.player1_name ? String(r.player1_name) : null,
      player1Avatar: r.player1_avatar ? sanitizeAvatarId(r.player1_avatar) : null,
      player1Seed:
        r.player1_seed === null || r.player1_seed === undefined ? null : Number(r.player1_seed),
      player1Joined: Number(r.player1_joined) === 1,
      player2Id: r.player2_id ? String(r.player2_id) : null,
      player2Name: r.player2_name ? String(r.player2_name) : null,
      player2Avatar: r.player2_avatar ? sanitizeAvatarId(r.player2_avatar) : null,
      player2Seed:
        r.player2_seed === null || r.player2_seed === undefined ? null : Number(r.player2_seed),
      player2Joined: Number(r.player2_joined) === 1,
      winnerId: r.winner_id ? String(r.winner_id) : null,
      winnerName: r.winner_name ? String(r.winner_name) : null,
      loserId: r.loser_id ? String(r.loser_id) : null,
      status: String(r.status) as TournamentBracketMatchStatus,
      roomId: r.room_id ? String(r.room_id) : null,
      roomCode: r.room_code ? String(r.room_code) : null,
      matchId: r.match_id ? String(r.match_id) : null,
      resolutionType: r.resolution_type
        ? (String(r.resolution_type) as TournamentMatchResolutionType)
        : null,
      reason: r.reason ? String(r.reason) : null,
      nextMatchId: r.next_match_id ? String(r.next_match_id) : null,
      nextMatchSlot:
        r.next_match_slot === null || r.next_match_slot === undefined
          ? null
          : (Number(r.next_match_slot) as 1 | 2),
      readyDeadlineMs:
        r.ready_deadline_ms === null || r.ready_deadline_ms === undefined
          ? null
          : Number(r.ready_deadline_ms),
      startedAtMs:
        r.started_at_ms === null || r.started_at_ms === undefined ? null : Number(r.started_at_ms),
      completedAtMs:
        r.completed_at_ms === null || r.completed_at_ms === undefined
          ? null
          : Number(r.completed_at_ms),
    };
  }

  private mapPayoutRow(r: Record<string, unknown>): TournamentPayoutRecord {
    return {
      payoutId: String(r.payout_id),
      tournamentId: String(r.tournament_id),
      playerId: String(r.player_id),
      displayName: String(r.display_name),
      placement: String(r.placement) as TournamentPayoutRecord['placement'],
      coinsAwarded: Number(r.coins_awarded ?? 0),
      badgeAwarded: r.badge_awarded ? String(r.badge_awarded) : null,
      trophyAwarded: r.trophy_awarded ? String(r.trophy_awarded) : null,
      awardedAtMs: Number(r.awarded_at_ms),
    };
  }

  private mapEventRow(r: Record<string, unknown>): TournamentEventRecord {
    let metadata: Record<string, string | number | boolean | null> | null = null;
    if (typeof r.metadata_json === 'string' && r.metadata_json.length > 0) {
      try {
        metadata = JSON.parse(r.metadata_json) as Record<string, string | number | boolean | null>;
      } catch {
        metadata = null;
      }
    }
    return {
      eventId: String(r.event_id),
      tournamentId: String(r.tournament_id),
      eventType: String(r.event_type),
      actorPlayerId: r.actor_player_id ? String(r.actor_player_id) : null,
      summary: String(r.summary),
      metadata,
      createdAtMs: Number(r.created_at_ms),
    };
  }
}
