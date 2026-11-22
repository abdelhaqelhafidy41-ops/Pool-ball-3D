import type { RuleProfileId } from '../../src/game/rules/types';
import {
  calculateTeamEloUpdate,
  generateRoundRobinFixtures,
  resolveLineupBoardPlayers,
  seedTeamsByElo,
  sortLeagueStandings,
  TEAM_MATCH_FORMAT_SPEC,
  type ClubChampionshipDetailPayload,
  type ClubChampionshipEntryRecord,
  type ClubChampionshipFormat,
  type ClubChampionshipMatchRecord,
  type ClubChampionshipRecord,
  type ClubChampionshipStatus,
  type ClubTeamRecord,
  type LeagueCadence,
  type LeagueScope,
  type LeagueStatus,
  type TeamEloHistoryEntry,
  type TeamEloRankingsPayload,
  type TeamEncounterStatus,
  type TeamLeaderboardEntry,
  type TeamLeagueDetailPayload,
  type TeamLeagueFixtureRecord,
  type TeamLeagueRecord,
  type TeamLeagueStandingRow,
  type TeamLineupSlot,
  type TeamMatchFormat,
  type TeamRosterMember,
  type TeamRosterRole,
  type TeamSubMatchRecord,
  type TeamSubMatchStatus,
} from '../../src/multiplayer/shared/clubLeagues';
import type { MultiplayerErrorCode, OnlineAvatarId } from '../../src/multiplayer/shared/protocol';
import {
  canManageClubTeams,
  isClubOfficerRole,
  normalizeClubRole,
  sanitizeClubText,
  SOCIAL_LIMITS,
  type ClubEmblemIcon,
  type ClubTrophyRecord,
} from '../../src/multiplayer/shared/social';
import { ClubService } from './ClubService';
import { sanitizeAvatarId } from './config';
import { D1ProgressionService, type ProgressionSqlDb } from './D1ProgressionService';
import { EconomyService } from './EconomyService';

export type ClubLeagueServiceError = {
  ok: false;
  status: number;
  code: MultiplayerErrorCode;
  message: string;
};

const TEAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,26}[A-Za-z0-9]$/;
const TEAM_TAG_PATTERN = /^[A-Za-z0-9]{2,5}$/;
const VALID_COLORS = new Set([
  '#f59e0b',
  '#10b981',
  '#38bdf8',
  '#f43f5e',
  '#a78bfa',
  '#fb923c',
  '#eab308',
  '#14b8a6',
]);
const VALID_ICONS = new Set<ClubEmblemIcon>([
  'shield',
  'crown',
  'flame',
  'star',
  'swords',
  'target',
]);

const CLUB_LEAGUE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS club_teams (
    team_id TEXT PRIMARY KEY,
    club_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_lower TEXT NOT NULL,
    tag TEXT NOT NULL,
    tag_lower TEXT NOT NULL,
    badge_color TEXT NOT NULL DEFAULT '#f59e0b',
    badge_icon TEXT NOT NULL DEFAULT 'shield',
    region TEXT NOT NULL DEFAULT 'GLOBAL',
    captain_id TEXT NOT NULL,
    elo INTEGER NOT NULL DEFAULT 1200,
    peak_elo INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    matches_played INTEGER NOT NULL DEFAULT 0,
    titles_count INTEGER NOT NULL DEFAULT 0,
    min_roster_size INTEGER NOT NULL DEFAULT 1,
    max_roster_size INTEGER NOT NULL DEFAULT 8,
    status TEXT NOT NULL DEFAULT 'active',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE(club_id, name_lower),
    UNIQUE(club_id, tag_lower)
  )`,
  `CREATE TABLE IF NOT EXISTS club_team_members (
    team_id TEXT NOT NULL,
    club_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'starter',
    matches_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    mvp_count INTEGER NOT NULL DEFAULT 0,
    joined_at_ms INTEGER NOT NULL,
    PRIMARY KEY (team_id, player_id)
  )`,
  `CREATE TABLE IF NOT EXISTS team_elo_history (
    event_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    competition_kind TEXT NOT NULL,
    competition_id TEXT NOT NULL,
    competition_title TEXT NOT NULL,
    opponent_team_id TEXT,
    opponent_team_name TEXT,
    elo_before INTEGER NOT NULL,
    elo_after INTEGER NOT NULL,
    elo_delta INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_leagues (
    league_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT 'international',
    region TEXT NOT NULL DEFAULT 'GLOBAL',
    cadence TEXT NOT NULL DEFAULT 'seasonal',
    division_tier INTEGER NOT NULL DEFAULT 1,
    season_label TEXT NOT NULL DEFAULT 'Season 1',
    match_format TEXT NOT NULL DEFAULT 'team_bo3',
    rule_profile_id TEXT NOT NULL DEFAULT 'casual',
    called_shots_enabled INTEGER NOT NULL DEFAULT 0,
    double_round_robin INTEGER NOT NULL DEFAULT 1,
    max_teams INTEGER NOT NULL DEFAULT 12,
    promotion_slots INTEGER NOT NULL DEFAULT 2,
    relegation_slots INTEGER NOT NULL DEFAULT 2,
    match_duration_minutes INTEGER NOT NULL DEFAULT 1440,
    status TEXT NOT NULL DEFAULT 'registration_open',
    created_by_player_id TEXT,
    champion_team_id TEXT,
    champion_team_name TEXT,
    starts_at_ms INTEGER,
    completed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_league_entries (
    league_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    club_id TEXT NOT NULL,
    played INTEGER NOT NULL DEFAULT 0,
    won INTEGER NOT NULL DEFAULT 0,
    drawn INTEGER NOT NULL DEFAULT 0,
    lost INTEGER NOT NULL DEFAULT 0,
    match_wins INTEGER NOT NULL DEFAULT 0,
    match_losses INTEGER NOT NULL DEFAULT 0,
    frame_diff INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    outcome_tag TEXT,
    joined_at_ms INTEGER NOT NULL,
    PRIMARY KEY (league_id, team_id)
  )`,
  `CREATE TABLE IF NOT EXISTS team_league_fixtures (
    fixture_id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    leg_number INTEGER NOT NULL DEFAULT 1,
    home_team_id TEXT NOT NULL,
    away_team_id TEXT NOT NULL,
    home_lineup_json TEXT NOT NULL DEFAULT '[]',
    away_lineup_json TEXT NOT NULL DEFAULT '[]',
    home_score INTEGER NOT NULL DEFAULT 0,
    away_score INTEGER NOT NULL DEFAULT 0,
    winner_team_id TEXT,
    is_draw INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'scheduled',
    scheduled_at_ms INTEGER,
    deadline_at_ms INTEGER,
    completed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS club_championships (
    championship_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'single_elimination',
    region TEXT NOT NULL DEFAULT 'GLOBAL',
    season_label TEXT NOT NULL DEFAULT 'Season 1',
    match_format TEXT NOT NULL DEFAULT 'team_bo3',
    rule_profile_id TEXT NOT NULL DEFAULT 'casual',
    called_shots_enabled INTEGER NOT NULL DEFAULT 0,
    max_teams INTEGER NOT NULL DEFAULT 16,
    current_round INTEGER NOT NULL DEFAULT 0,
    total_rounds INTEGER NOT NULL DEFAULT 0,
    swiss_rounds INTEGER NOT NULL DEFAULT 3,
    group_size INTEGER NOT NULL DEFAULT 4,
    group_advance_count INTEGER NOT NULL DEFAULT 2,
    stage TEXT NOT NULL DEFAULT 'registration',
    status TEXT NOT NULL DEFAULT 'registration_open',
    created_by_player_id TEXT,
    champion_team_id TEXT,
    champion_team_name TEXT,
    champion_club_id TEXT,
    champion_club_name TEXT,
    runner_up_team_id TEXT,
    runner_up_team_name TEXT,
    prize_coins_champion INTEGER NOT NULL DEFAULT 1000,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS club_championship_entries (
    championship_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    club_id TEXT NOT NULL,
    seed INTEGER,
    group_index INTEGER,
    team_elo_at_entry INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    buchholz INTEGER NOT NULL DEFAULT 0,
    frame_diff INTEGER NOT NULL DEFAULT 0,
    eliminated INTEGER NOT NULL DEFAULT 0,
    disqualified INTEGER NOT NULL DEFAULT 0,
    placement INTEGER,
    joined_at_ms INTEGER NOT NULL,
    PRIMARY KEY (championship_id, team_id)
  )`,
  `CREATE TABLE IF NOT EXISTS club_championship_matches (
    match_node_id TEXT PRIMARY KEY,
    championship_id TEXT NOT NULL,
    stage_type TEXT NOT NULL,
    group_index INTEGER,
    round_number INTEGER NOT NULL,
    round_label TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    home_team_id TEXT,
    away_team_id TEXT,
    home_lineup_json TEXT NOT NULL DEFAULT '[]',
    away_lineup_json TEXT NOT NULL DEFAULT '[]',
    home_score INTEGER NOT NULL DEFAULT 0,
    away_score INTEGER NOT NULL DEFAULT 0,
    winner_team_id TEXT,
    next_winner_node_id TEXT,
    next_winner_slot TEXT,
    next_loser_node_id TEXT,
    next_loser_slot TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    resolution_note TEXT,
    deadline_at_ms INTEGER,
    completed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_match_submatches (
    sub_match_id TEXT PRIMARY KEY,
    competition_kind TEXT NOT NULL,
    competition_id TEXT NOT NULL,
    encounter_id TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    board_label TEXT NOT NULL,
    home_team_id TEXT NOT NULL,
    away_team_id TEXT NOT NULL,
    home_player_id TEXT,
    away_player_id TEXT,
    winner_team_id TEXT,
    winner_player_id TEXT,
    room_id TEXT,
    room_code TEXT,
    verified_match_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    completion_reason TEXT,
    completed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_match_processed_results (
    sub_match_id TEXT PRIMARY KEY,
    match_id TEXT NOT NULL,
    winner_player_id TEXT,
    processed_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_club_teams_club ON club_teams (club_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_club_teams_elo ON club_teams (status, region, elo DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_team_members_player ON club_team_members (player_id)`,
  `CREATE INDEX IF NOT EXISTS idx_team_elo_hist ON team_elo_history (team_id, created_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_league_fixtures_league ON team_league_fixtures (league_id, round_number ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_champ_matches_champ ON club_championship_matches (championship_id, round_number ASC, slot_index ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_submatches_enc ON team_match_submatches (encounter_id, slot_index ASC)`,
];

const initializedDbs = new WeakSet<object>();

function sanitizeBadgeColor(raw: unknown): string {
  if (typeof raw === 'string' && VALID_COLORS.has(raw.trim().toLowerCase())) {
    return raw.trim().toLowerCase();
  }
  return '#f59e0b';
}

function sanitizeBadgeIcon(raw: unknown): ClubEmblemIcon {
  if (typeof raw === 'string' && VALID_ICONS.has(raw as ClubEmblemIcon)) {
    return raw as ClubEmblemIcon;
  }
  return 'shield';
}

function sanitizeMatchFormat(raw: unknown): TeamMatchFormat {
  if (raw === 'singles' || raw === 'doubles' || raw === 'team_bo3' || raw === 'team_bo5') {
    return raw;
  }
  return 'team_bo3';
}

function sanitizeRosterRole(raw: unknown): TeamRosterRole {
  if (raw === 'captain' || raw === 'starter' || raw === 'substitute') {
    return raw;
  }
  return 'starter';
}

function sanitizeRegion(raw: unknown): string {
  if (typeof raw !== 'string') return 'GLOBAL';
  const clean = raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
  return clean || 'GLOBAL';
}

function parseLineupJson(raw: unknown): TeamLineupSlot[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TeamLineupSlot[]) : [];
  } catch {
    return [];
  }
}

function nextPowerOf2(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

function generateBracketSeedPositions(bracketSize: number): number[] {
  let order = [1, 2];
  while (order.length < bracketSize) {
    const sum = order.length * 2 + 1;
    const next: number[] = [];
    for (const s of order) {
      next.push(s);
      next.push(sum - s);
    }
    order = next;
  }
  return order;
}

export class ClubLeagueService {
  private readonly db: ProgressionSqlDb;
  private readonly progression: D1ProgressionService;
  private readonly clubService: ClubService;
  private readonly economy: EconomyService;

  constructor(db: ProgressionSqlDb) {
    this.db = db;
    this.progression = new D1ProgressionService(db);
    this.clubService = new ClubService(db);
    this.economy = new EconomyService(db);
  }

  public async ensureSchema(): Promise<ProgressionSqlDb> {
    await this.clubService.ensureSchema();
    if (!initializedDbs.has(this.db as object)) {
      for (const stmt of CLUB_LEAGUE_SCHEMA_STATEMENTS) {
        await this.db.prepare(stmt).run();
      }
      initializedDbs.add(this.db as object);
    }
    return this.db;
  }

  private async getClubMemberRole(
    db: ProgressionSqlDb,
    clubId: string,
    playerId: string,
  ): Promise<string | null> {
    const row = await db
      .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
      .bind(clubId, playerId)
      .first<{ role: string }>();
    return row ? row.role : null;
  }

  private async loadTeamMembersMap(
    db: ProgressionSqlDb,
    teamIds: string[],
  ): Promise<Map<string, TeamRosterMember[]>> {
    const out = new Map<string, TeamRosterMember[]>();
    if (teamIds.length === 0) return out;
    const placeholders = teamIds.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT m.*, p.display_name, p.avatar_id, p.elo
         FROM club_team_members m
         LEFT JOIN players p ON p.player_id = m.player_id
         WHERE m.team_id IN (${placeholders})
         ORDER BY CASE WHEN m.role = 'captain' THEN 0 WHEN m.role = 'starter' THEN 1 ELSE 2 END,
                  COALESCE(p.elo, 1200) DESC, m.joined_at_ms ASC`,
      )
      .bind(...teamIds)
      .all<Record<string, unknown>>();
    for (const r of rows.results ?? []) {
      const tid = String(r.team_id);
      const list = out.get(tid) ?? [];
      list.push({
        teamId: tid,
        clubId: String(r.club_id),
        playerId: String(r.player_id),
        displayName: r.display_name ? String(r.display_name) : 'Player',
        avatarId: sanitizeAvatarId(r.avatar_id),
        elo: Number(r.elo ?? 1200),
        role: sanitizeRosterRole(r.role),
        matchesPlayed: Number(r.matches_played ?? 0),
        wins: Number(r.wins ?? 0),
        losses: Number(r.losses ?? 0),
        mvpCount: Number(r.mvp_count ?? 0),
        joinedAtMs: Number(r.joined_at_ms),
      });
      out.set(tid, list);
    }
    return out;
  }

  private mapTeamRow(
    r: Record<string, unknown>,
    roster: TeamRosterMember[],
  ): ClubTeamRecord {
    const captainMember = roster.find((m) => m.playerId === String(r.captain_id));
    return {
      teamId: String(r.team_id),
      clubId: String(r.club_id),
      clubName: String(r.club_name ?? ''),
      clubTag: String(r.club_tag ?? ''),
      name: String(r.name),
      tag: String(r.tag),
      badgeColor: String(r.badge_color ?? '#f59e0b'),
      badgeIcon: sanitizeBadgeIcon(r.badge_icon),
      region: String(r.region ?? 'GLOBAL'),
      captainId: String(r.captain_id),
      captainName: captainMember?.displayName ?? String(r.captain_name ?? 'Captain'),
      elo: Number(r.elo ?? 1200),
      peakElo: Number(r.peak_elo ?? 1200),
      wins: Number(r.wins ?? 0),
      losses: Number(r.losses ?? 0),
      draws: Number(r.draws ?? 0),
      matchesPlayed: Number(r.matches_played ?? 0),
      titlesCount: Number(r.titles_count ?? 0),
      minRosterSize: Number(r.min_roster_size ?? 1),
      maxRosterSize: Number(r.max_roster_size ?? 8),
      rosterCount: roster.length,
      roster,
      status: r.status === 'archived' ? 'archived' : 'active',
      createdAtMs: Number(r.created_at_ms),
      updatedAtMs: Number(r.updated_at_ms),
    };
  }

  public async listClubTeams(clubId: string): Promise<ClubTeamRecord[]> {
    const db = await this.ensureSchema();
    const rows = await db
      .prepare(
        `SELECT t.*, c.name AS club_name, c.tag AS club_tag, p.display_name AS captain_name
         FROM club_teams t
         JOIN clubs c ON c.club_id = t.club_id
         LEFT JOIN players p ON p.player_id = t.captain_id
         WHERE t.club_id = ? AND t.status = 'active'
         ORDER BY t.elo DESC, t.created_at_ms ASC`,
      )
      .bind(clubId)
      .all<Record<string, unknown>>();
    const list = rows.results ?? [];
    const membersMap = await this.loadTeamMembersMap(
      db,
      list.map((r) => String(r.team_id)),
    );
    return list.map((r) => this.mapTeamRow(r, membersMap.get(String(r.team_id)) ?? []));
  }

  public async getTeamById(teamId: string): Promise<{
    team: ClubTeamRecord;
    eloHistory: TeamEloHistoryEntry[];
  } | null> {
    const db = await this.ensureSchema();
    const row = await db
      .prepare(
        `SELECT t.*, c.name AS club_name, c.tag AS club_tag, p.display_name AS captain_name
         FROM club_teams t
         JOIN clubs c ON c.club_id = t.club_id
         LEFT JOIN players p ON p.player_id = t.captain_id
         WHERE t.team_id = ? LIMIT 1`,
      )
      .bind(teamId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    const membersMap = await this.loadTeamMembersMap(db, [teamId]);
    const histRows = await db
      .prepare(
        `SELECT * FROM team_elo_history WHERE team_id = ? ORDER BY created_at_ms DESC LIMIT 30`,
      )
      .bind(teamId)
      .all<Record<string, unknown>>();

    const eloHistory: TeamEloHistoryEntry[] = (histRows.results ?? []).map((h) => ({
      eventId: String(h.event_id),
      teamId: String(h.team_id),
      competitionKind:
        h.competition_kind === 'club_championship' || h.competition_kind === 'season_reset'
          ? h.competition_kind
          : 'league',
      competitionId: String(h.competition_id),
      competitionTitle: String(h.competition_title),
      opponentTeamId: h.opponent_team_id ? String(h.opponent_team_id) : null,
      opponentTeamName: h.opponent_team_name ? String(h.opponent_team_name) : null,
      eloBefore: Number(h.elo_before),
      eloAfter: Number(h.elo_after),
      eloDelta: Number(h.elo_delta),
      outcome:
        h.outcome === 'loss' || h.outcome === 'draw' || h.outcome === 'reset' ? h.outcome : 'win',
      createdAtMs: Number(h.created_at_ms),
    }));

    return {
      team: this.mapTeamRow(row, membersMap.get(teamId) ?? []),
      eloHistory,
    };
  }

  public async createTeam(
    actorId: string,
    clubId: string,
    input: {
      name: unknown;
      tag: unknown;
      badgeColor?: unknown;
      badgeIcon?: unknown;
      region?: unknown;
      minRosterSize?: unknown;
      maxRosterSize?: unknown;
      captainId?: unknown;
      memberIds?: unknown;
    },
  ): Promise<{ ok: true; team: ClubTeamRecord } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const clubRow = await db
      .prepare('SELECT * FROM clubs WHERE club_id = ? LIMIT 1')
      .bind(clubId)
      .first<Record<string, unknown>>();
    if (!clubRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Club not found.' };
    }

    const rawRole = await this.getClubMemberRole(db, clubId, actorId);
    if (!rawRole || !canManageClubTeams(normalizeClubRole(rawRole))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only Club Owners, Presidents, Vice Presidents, or Captains can create teams.',
      };
    }

    const existingCount = await db
      .prepare("SELECT COUNT(*) AS c FROM club_teams WHERE club_id = ? AND status = 'active'")
      .bind(clubId)
      .first<{ c: number }>();
    if (Number(existingCount?.c ?? 0) >= SOCIAL_LIMITS.maxTeamsPerClub) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: `Clubs can maintain at most ${SOCIAL_LIMITS.maxTeamsPerClub} active competitive teams.`,
      };
    }

    const name = sanitizeClubText(input.name, 28);
    const tag = sanitizeClubText(input.tag, 5).toUpperCase();
    if (!TEAM_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Team name must be 3–28 characters (letters, numbers, spaces, . _ -).',
      };
    }
    if (!TEAM_TAG_PATTERN.test(tag)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Team tag must be 2–5 alphanumeric characters.',
      };
    }

    const dup = await db
      .prepare('SELECT team_id FROM club_teams WHERE club_id = ? AND (name_lower = ? OR tag_lower = ?) LIMIT 1')
      .bind(clubId, name.toLowerCase(), tag.toLowerCase())
      .first<{ team_id: string }>();
    if (dup) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Your club already has a team with that name or tag.',
      };
    }

    const minRosterSize = Math.max(
      SOCIAL_LIMITS.minTeamRoster,
      Math.min(5, Math.floor(Number(input.minRosterSize ?? 1) || 1)),
    );
    const maxRosterSize = Math.max(
      minRosterSize,
      Math.min(SOCIAL_LIMITS.maxTeamRoster, Math.floor(Number(input.maxRosterSize ?? 8) || 8)),
    );

    const captainId =
      typeof input.captainId === 'string' && input.captainId.trim()
        ? input.captainId.trim()
        : actorId;
    const captainClubRole = await this.getClubMemberRole(db, clubId, captainId);
    if (!captainClubRole) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Team captain must be a current member of the club.',
      };
    }

    const initialMembers = new Set<string>([captainId]);
    if (Array.isArray(input.memberIds)) {
      for (const id of input.memberIds) {
        if (typeof id === 'string' && id.trim() && initialMembers.size < maxRosterSize) {
          const r = await this.getClubMemberRole(db, clubId, id.trim());
          if (r) initialMembers.add(id.trim());
        }
      }
    }

    const now = Date.now();
    const teamId = `team_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const region = input.region ? sanitizeRegion(input.region) : sanitizeRegion(clubRow.region);
    const badgeColor = sanitizeBadgeColor(input.badgeColor ?? clubRow.emblem_color);
    const badgeIcon = sanitizeBadgeIcon(input.badgeIcon ?? clubRow.emblem_icon);

    await db
      .prepare(
        `INSERT INTO club_teams (
          team_id, club_id, name, name_lower, tag, tag_lower, badge_color, badge_icon, region,
          captain_id, elo, peak_elo, wins, losses, draws, matches_played, titles_count,
          min_roster_size, max_roster_size, status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1200, 1200, 0, 0, 0, 0, 0, ?, ?, 'active', ?, ?)`,
      )
      .bind(
        teamId,
        clubId,
        name,
        name.toLowerCase(),
        tag,
        tag.toLowerCase(),
        badgeColor,
        badgeIcon,
        region,
        captainId,
        minRosterSize,
        maxRosterSize,
        now,
        now,
      )
      .run();

    for (const pid of initialMembers) {
      await db
        .prepare(
          `INSERT INTO club_team_members (team_id, club_id, player_id, role, joined_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(teamId, clubId, pid, pid === captainId ? 'captain' : 'starter', now)
        .run();
    }

    await this.clubService.awardClubXp({
      clubId,
      xpAmount: 25,
      actorId,
      eventType: 'team_created',
      summary: `Formed competitive team [${tag}] ${name}.`,
    });

    const detail = await this.getTeamById(teamId);
    return { ok: true, team: detail!.team };
  }

  private async canManageSpecificTeam(
    db: ProgressionSqlDb,
    actorId: string,
    teamRow: Record<string, unknown>,
  ): Promise<boolean> {
    const clubId = String(teamRow.club_id);
    const rawRole = await this.getClubMemberRole(db, clubId, actorId);
    if (!rawRole) return false;
    const role = normalizeClubRole(rawRole);
    return isClubOfficerRole(role) || String(teamRow.captain_id) === actorId || role === 'captain';
  }

  private async checkPlayerActiveCompetitionConflict(
    db: ProgressionSqlDb,
    playerId: string,
    teamId: string,
  ): Promise<string | null> {
    const leagueConflict = await db
      .prepare(
        `SELECT l.title
         FROM team_league_entries e1
         JOIN team_leagues l ON l.league_id = e1.league_id
         JOIN team_league_entries e2 ON e2.league_id = e1.league_id AND e2.team_id != e1.team_id
         JOIN club_team_members m ON m.team_id = e2.team_id
         WHERE e1.team_id = ?
           AND m.player_id = ?
           AND l.status IN ('registration_open', 'in_progress')
         LIMIT 1`,
      )
      .bind(teamId, playerId)
      .first<{ title: string }>();
    if (leagueConflict) {
      return `Player is already registered on another team in league "${leagueConflict.title}".`;
    }

    const champConflict = await db
      .prepare(
        `SELECT c.title
         FROM club_championship_entries e1
         JOIN club_championships c ON c.championship_id = e1.championship_id
         JOIN club_championship_entries e2 ON e2.championship_id = e1.championship_id AND e2.team_id != e1.team_id
         JOIN club_team_members m ON m.team_id = e2.team_id
         WHERE e1.team_id = ?
           AND m.player_id = ?
           AND c.status IN ('registration_open', 'in_progress')
         LIMIT 1`,
      )
      .bind(teamId, playerId)
      .first<{ title: string }>();
    if (champConflict) {
      return `Player is already registered on another team in championship "${champConflict.title}".`;
    }

    return null;
  }

  public async addTeamMember(
    actorId: string,
    teamId: string,
    targetPlayerId: string,
    roleInput?: unknown,
  ): Promise<{ ok: true; team: ClubTeamRecord } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const teamRow = await db
      .prepare('SELECT * FROM club_teams WHERE team_id = ? LIMIT 1')
      .bind(teamId)
      .first<Record<string, unknown>>();
    if (!teamRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Team not found.' };
    }
    if (!(await this.canManageSpecificTeam(db, actorId, teamRow))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club leadership or the team captain can manage this roster.',
      };
    }

    const clubId = String(teamRow.club_id);
    const targetClubRole = await this.getClubMemberRole(db, clubId, targetPlayerId.trim());
    if (!targetClubRole) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Player must belong to your club before joining a club team roster.',
      };
    }

    const existing = await db
      .prepare('SELECT player_id FROM club_team_members WHERE team_id = ? AND player_id = ? LIMIT 1')
      .bind(teamId, targetPlayerId.trim())
      .first<{ player_id: string }>();
    if (existing) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Player is already on this team roster.',
      };
    }

    const rosterCountRow = await db
      .prepare('SELECT COUNT(*) AS c FROM club_team_members WHERE team_id = ?')
      .bind(teamId)
      .first<{ c: number }>();
    const maxRoster = Number(teamRow.max_roster_size ?? SOCIAL_LIMITS.maxTeamRoster);
    if (Number(rosterCountRow?.c ?? 0) >= maxRoster) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: `Team roster is full (${maxRoster}/${maxRoster}).`,
      };
    }

    const conflictMsg = await this.checkPlayerActiveCompetitionConflict(
      db,
      targetPlayerId.trim(),
      teamId,
    );
    if (conflictMsg) {
      return { ok: false, status: 409, code: 'CONFLICT', message: conflictMsg };
    }

    const desiredRole = sanitizeRosterRole(roleInput);
    const role: TeamRosterRole = desiredRole === 'captain' ? 'starter' : desiredRole;
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO club_team_members (team_id, club_id, player_id, role, joined_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(teamId, clubId, targetPlayerId.trim(), role, now)
      .run();

    await db
      .prepare('UPDATE club_teams SET updated_at_ms = ? WHERE team_id = ?')
      .bind(now, teamId)
      .run();

    const detail = await this.getTeamById(teamId);
    return { ok: true, team: detail!.team };
  }

  public async removeTeamMember(
    actorId: string,
    teamId: string,
    targetPlayerId: string,
  ): Promise<{ ok: true; team: ClubTeamRecord } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const teamRow = await db
      .prepare('SELECT * FROM club_teams WHERE team_id = ? LIMIT 1')
      .bind(teamId)
      .first<Record<string, unknown>>();
    if (!teamRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Team not found.' };
    }
    if (
      actorId !== targetPlayerId &&
      !(await this.canManageSpecificTeam(db, actorId, teamRow))
    ) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club leadership or the team captain can remove roster members.',
      };
    }

    if (String(teamRow.captain_id) === targetPlayerId) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Transfer team captaincy to another roster member before removing the captain.',
      };
    }

    const activeBoard = await db
      .prepare(
        `SELECT sub_match_id FROM team_match_submatches
         WHERE encounter_id IS NOT NULL
           AND (home_team_id = ? OR away_team_id = ?)
           AND (home_player_id = ? OR away_player_id = ?)
           AND status = 'in_progress'
         LIMIT 1`,
      )
      .bind(teamId, teamId, targetPlayerId, targetPlayerId)
      .first<{ sub_match_id: string }>();
    if (activeBoard) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Cannot remove a player currently playing a live board.',
      };
    }

    await db
      .prepare('DELETE FROM club_team_members WHERE team_id = ? AND player_id = ?')
      .bind(teamId, targetPlayerId)
      .run();
    await db
      .prepare('UPDATE club_teams SET updated_at_ms = ? WHERE team_id = ?')
      .bind(Date.now(), teamId)
      .run();

    const detail = await this.getTeamById(teamId);
    return { ok: true, team: detail!.team };
  }

  public async setTeamMemberRole(
    actorId: string,
    teamId: string,
    targetPlayerId: string,
    roleInput: unknown,
  ): Promise<{ ok: true; team: ClubTeamRecord } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const teamRow = await db
      .prepare('SELECT * FROM club_teams WHERE team_id = ? LIMIT 1')
      .bind(teamId)
      .first<Record<string, unknown>>();
    if (!teamRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Team not found.' };
    }
    if (!(await this.canManageSpecificTeam(db, actorId, teamRow))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club leadership or the team captain can update roster roles.',
      };
    }

    const memberRow = await db
      .prepare('SELECT role FROM club_team_members WHERE team_id = ? AND player_id = ? LIMIT 1')
      .bind(teamId, targetPlayerId)
      .first<{ role: string }>();
    if (!memberRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Player is not on this roster.' };
    }

    const nextRole = sanitizeRosterRole(roleInput);
    const now = Date.now();
    if (nextRole === 'captain') {
      await db
        .prepare("UPDATE club_team_members SET role = 'starter' WHERE team_id = ? AND role = 'captain'")
        .bind(teamId)
        .run();
      await db
        .prepare("UPDATE club_team_members SET role = 'captain' WHERE team_id = ? AND player_id = ?")
        .bind(teamId, targetPlayerId)
        .run();
      await db
        .prepare('UPDATE club_teams SET captain_id = ?, updated_at_ms = ? WHERE team_id = ?')
        .bind(targetPlayerId, now, teamId)
        .run();
    } else {
      if (String(teamRow.captain_id) === targetPlayerId) {
        return {
          ok: false,
          status: 400,
          code: 'INVALID_INPUT',
          message: 'Promote another player to captain before demoting the current captain.',
        };
      }
      await db
        .prepare('UPDATE club_team_members SET role = ? WHERE team_id = ? AND player_id = ?')
        .bind(nextRole, teamId, targetPlayerId)
        .run();
      await db
        .prepare('UPDATE club_teams SET updated_at_ms = ? WHERE team_id = ?')
        .bind(now, teamId)
        .run();
    }

    const detail = await this.getTeamById(teamId);
    return { ok: true, team: detail!.team };
  }

  private async checkTeamCompetitionEligibility(
    db: ProgressionSqlDb,
    teamId: string,
    matchFormat: TeamMatchFormat,
    competitionKind: 'league' | 'club_championship',
    competitionId: string,
  ): Promise<{ ok: true; team: ClubTeamRecord } | ClubLeagueServiceError> {
    const teamDetail = await this.getTeamById(teamId);
    if (!teamDetail || teamDetail.team.status !== 'active') {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Team not found.' };
    }
    const team = teamDetail.team;
    const minRequired = Math.max(
      team.minRosterSize,
      TEAM_MATCH_FORMAT_SPEC[matchFormat].requiredLineupPlayers,
    );
    if (team.roster.length < minRequired) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: `Team [${team.tag}] needs at least ${minRequired} roster players for ${TEAM_MATCH_FORMAT_SPEC[matchFormat].label}.`,
      };
    }

    const playerIds = team.roster.map((m) => m.playerId);
    const placeholders = playerIds.map(() => '?').join(', ');
    if (competitionKind === 'league') {
      const conflict = await db
        .prepare(
          `SELECT m.player_id, t.tag
           FROM team_league_entries e
           JOIN club_team_members m ON m.team_id = e.team_id
           JOIN club_teams t ON t.team_id = e.team_id
           WHERE e.league_id = ? AND e.team_id != ? AND m.player_id IN (${placeholders})
           LIMIT 1`,
        )
        .bind(competitionId, teamId, ...playerIds)
        .first<{ player_id: string; tag: string }>();
      if (conflict) {
        return {
          ok: false,
          status: 409,
          code: 'CONFLICT',
          message: `Eligibility conflict: a player on [${team.tag}] is already registered with [${conflict.tag}] in this league.`,
        };
      }
    } else {
      const conflict = await db
        .prepare(
          `SELECT m.player_id, t.tag
           FROM club_championship_entries e
           JOIN club_team_members m ON m.team_id = e.team_id
           JOIN club_teams t ON t.team_id = e.team_id
           WHERE e.championship_id = ? AND e.team_id != ? AND m.player_id IN (${placeholders})
           LIMIT 1`,
        )
        .bind(competitionId, teamId, ...playerIds)
        .first<{ player_id: string; tag: string }>();
      if (conflict) {
        return {
          ok: false,
          status: 409,
          code: 'CONFLICT',
          message: `Eligibility conflict: a player on [${team.tag}] is already registered with [${conflict.tag}] in this championship.`,
        };
      }
    }

    return { ok: true, team };
  }

  // ===== Team Leagues (Regional / National / International, Weekly & Seasonal) =====

  private mapLeagueRow(r: Record<string, unknown>, registeredCount: number): TeamLeagueRecord {
    const rawScope = String(r.scope ?? 'international');
    const scope: LeagueScope =
      rawScope === 'regional' || rawScope === 'national' ? rawScope : 'international';
    const rawCadence = String(r.cadence ?? 'seasonal');
    const cadence: LeagueCadence = rawCadence === 'weekly' ? 'weekly' : 'seasonal';
    const rawStatus = String(r.status ?? 'registration_open');
    const status: LeagueStatus =
      rawStatus === 'in_progress' || rawStatus === 'completed' || rawStatus === 'cancelled'
        ? rawStatus
        : 'registration_open';

    return {
      leagueId: String(r.league_id),
      title: String(r.title),
      description: String(r.description ?? ''),
      scope,
      region: String(r.region ?? 'GLOBAL'),
      cadence,
      divisionTier: Number(r.division_tier ?? 1),
      seasonLabel: String(r.season_label ?? 'Season 1'),
      matchFormat: sanitizeMatchFormat(r.match_format),
      ruleProfileId: r.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
      calledShotsEnabled: Number(r.called_shots_enabled) === 1,
      doubleRoundRobin: Number(r.double_round_robin) === 1,
      maxTeams: Number(r.max_teams ?? 12),
      registeredCount,
      promotionSlots: Number(r.promotion_slots ?? 2),
      relegationSlots: Number(r.relegation_slots ?? 2),
      matchDurationMinutes: Number(r.match_duration_minutes ?? 1440),
      status,
      createdByPlayerId: r.created_by_player_id ? String(r.created_by_player_id) : null,
      championTeamId: r.champion_team_id ? String(r.champion_team_id) : null,
      championTeamName: r.champion_team_name ? String(r.champion_team_name) : null,
      startsAtMs: r.starts_at_ms !== null && r.starts_at_ms !== undefined ? Number(r.starts_at_ms) : null,
      completedAtMs:
        r.completed_at_ms !== null && r.completed_at_ms !== undefined
          ? Number(r.completed_at_ms)
          : null,
      createdAtMs: Number(r.created_at_ms),
    };
  }

  public async createLeague(
    actorId: string,
    input: {
      title: unknown;
      description?: unknown;
      scope?: unknown;
      region?: unknown;
      cadence?: unknown;
      divisionTier?: unknown;
      seasonLabel?: unknown;
      matchFormat?: unknown;
      ruleProfileId?: unknown;
      calledShotsEnabled?: unknown;
      doubleRoundRobin?: unknown;
      maxTeams?: unknown;
      promotionSlots?: unknown;
      relegationSlots?: unknown;
      matchDurationMinutes?: unknown;
    },
  ): Promise<{ ok: true; detail: TeamLeagueDetailPayload } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const title = sanitizeClubText(input.title, 48);
    if (title.length < 4) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'League title must be at least 4 characters.',
      };
    }

    const scope: LeagueScope =
      input.scope === 'regional' || input.scope === 'national' ? input.scope : 'international';
    const region = scope === 'international' ? 'GLOBAL' : sanitizeRegion(input.region ?? 'MENA');
    const cadence: LeagueCadence = input.cadence === 'weekly' ? 'weekly' : 'seasonal';
    const divisionTier = Math.max(1, Math.min(5, Math.floor(Number(input.divisionTier ?? 1) || 1)));
    const seasonLabel = sanitizeClubText(input.seasonLabel ?? 'Season 1', 24) || 'Season 1';
    const matchFormat = sanitizeMatchFormat(input.matchFormat);
    const ruleProfileId: RuleProfileId = input.ruleProfileId === 'wpa' ? 'wpa' : 'casual';
    const calledShotsEnabled =
      input.calledShotsEnabled !== undefined
        ? Boolean(input.calledShotsEnabled)
        : ruleProfileId === 'wpa';
    const doubleRoundRobin = input.doubleRoundRobin !== false;
    const maxTeams = Math.max(4, Math.min(20, Math.floor(Number(input.maxTeams ?? 12) || 12)));
    const promotionSlots = Math.max(0, Math.min(4, Math.floor(Number(input.promotionSlots ?? 2) || 0)));
    const relegationSlots = Math.max(0, Math.min(4, Math.floor(Number(input.relegationSlots ?? 2) || 0)));
    const matchDurationMinutes = Math.max(
      15,
      Math.min(10080, Math.floor(Number(input.matchDurationMinutes ?? 1440) || 1440)),
    );
    const description = sanitizeClubText(input.description ?? '', 220);
    const now = Date.now();
    const leagueId = `league_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

    await db
      .prepare(
        `INSERT INTO team_leagues (
          league_id, title, description, scope, region, cadence, division_tier, season_label,
          match_format, rule_profile_id, called_shots_enabled, double_round_robin, max_teams,
          promotion_slots, relegation_slots, match_duration_minutes, status, created_by_player_id,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registration_open', ?, ?, ?)`,
      )
      .bind(
        leagueId,
        title,
        description,
        scope,
        region,
        cadence,
        divisionTier,
        seasonLabel,
        matchFormat,
        ruleProfileId,
        calledShotsEnabled ? 1 : 0,
        doubleRoundRobin ? 1 : 0,
        maxTeams,
        promotionSlots,
        relegationSlots,
        matchDurationMinutes,
        actorId,
        now,
        now,
      )
      .run();

    const detail = (await this.getLeagueDetail(leagueId, actorId))!;
    return { ok: true, detail };
  }

  public async listLeagues(opts?: {
    scope?: string | null;
    region?: string | null;
    status?: string | null;
  }): Promise<TeamLeagueRecord[]> {
    const db = await this.ensureSchema();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.scope && (opts.scope === 'regional' || opts.scope === 'national' || opts.scope === 'international')) {
      clauses.push('l.scope = ?');
      params.push(opts.scope);
    }
    if (opts?.region && opts.region !== 'ALL') {
      clauses.push('l.region = ?');
      params.push(sanitizeRegion(opts.region));
    }
    if (opts?.status && opts.status !== 'all') {
      clauses.push('l.status = ?');
      params.push(opts.status);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await db
      .prepare(
        `SELECT l.*, COUNT(e.team_id) AS reg_count
         FROM team_leagues l
         LEFT JOIN team_league_entries e ON e.league_id = l.league_id
         ${whereSql}
         GROUP BY l.league_id
         ORDER BY CASE WHEN l.status = 'in_progress' THEN 0 WHEN l.status = 'registration_open' THEN 1 ELSE 2 END,
                  l.created_at_ms DESC
         LIMIT 40`,
      )
      .bind(...params)
      .all<Record<string, unknown>>();

    return (rows.results ?? []).map((r) => this.mapLeagueRow(r, Number(r.reg_count ?? 0)));
  }

  private async loadSubMatchesMap(
    db: ProgressionSqlDb,
    encounterIds: string[],
  ): Promise<Map<string, TeamSubMatchRecord[]>> {
    const out = new Map<string, TeamSubMatchRecord[]>();
    if (encounterIds.length === 0) return out;
    const placeholders = encounterIds.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT s.*,
                hp.display_name AS hp_name, hp.avatar_id AS hp_avatar,
                ap.display_name AS ap_name, ap.avatar_id AS ap_avatar
         FROM team_match_submatches s
         LEFT JOIN players hp ON hp.player_id = s.home_player_id
         LEFT JOIN players ap ON ap.player_id = s.away_player_id
         WHERE s.encounter_id IN (${placeholders})
         ORDER BY s.slot_index ASC`,
      )
      .bind(...encounterIds)
      .all<Record<string, unknown>>();

    for (const r of rows.results ?? []) {
      const encId = String(r.encounter_id);
      const list = out.get(encId) ?? [];
      list.push({
        subMatchId: String(r.sub_match_id),
        competitionKind:
          r.competition_kind === 'club_championship' ? 'club_championship' : 'league',
        competitionId: String(r.competition_id),
        encounterId: encId,
        slotIndex: Number(r.slot_index),
        boardLabel: String(r.board_label),
        homeTeamId: String(r.home_team_id),
        awayTeamId: String(r.away_team_id),
        homePlayerId: r.home_player_id ? String(r.home_player_id) : null,
        homePlayerName: r.hp_name ? String(r.hp_name) : null,
        homePlayerAvatar: r.hp_avatar ? sanitizeAvatarId(r.hp_avatar) : null,
        awayPlayerId: r.away_player_id ? String(r.away_player_id) : null,
        awayPlayerName: r.ap_name ? String(r.ap_name) : null,
        awayPlayerAvatar: r.ap_avatar ? sanitizeAvatarId(r.ap_avatar) : null,
        winnerTeamId: r.winner_team_id ? String(r.winner_team_id) : null,
        winnerPlayerId: r.winner_player_id ? String(r.winner_player_id) : null,
        roomId: r.room_id ? String(r.room_id) : null,
        roomCode: r.room_code ? String(r.room_code) : null,
        verifiedMatchId: r.verified_match_id ? String(r.verified_match_id) : null,
        status: (String(r.status) as TeamSubMatchStatus) || 'pending',
        completionReason: r.completion_reason ? String(r.completion_reason) : null,
        completedAtMs:
          r.completed_at_ms !== null && r.completed_at_ms !== undefined
            ? Number(r.completed_at_ms)
            : null,
      });
      out.set(encId, list);
    }
    return out;
  }

  public async getLeagueDetail(
    leagueId: string,
    viewerId?: string | null,
  ): Promise<TeamLeagueDetailPayload | null> {
    const db = await this.ensureSchema();
    const row = await db
      .prepare(
        `SELECT l.*, COUNT(e.team_id) AS reg_count
         FROM team_leagues l
         LEFT JOIN team_league_entries e ON e.league_id = l.league_id
         WHERE l.league_id = ?
         GROUP BY l.league_id LIMIT 1`,
      )
      .bind(leagueId)
      .first<Record<string, unknown>>();
    if (!row) return null;

    const league = this.mapLeagueRow(row, Number(row.reg_count ?? 0));

    const entryRows = await db
      .prepare(
        `SELECT e.*, t.name AS team_name, t.tag AS team_tag, t.badge_color, t.badge_icon, t.elo AS team_elo,
                c.tag AS club_tag
         FROM team_league_entries e
         JOIN club_teams t ON t.team_id = e.team_id
         JOIN clubs c ON c.club_id = e.club_id
         WHERE e.league_id = ?`,
      )
      .bind(leagueId)
      .all<Record<string, unknown>>();

    const fixtureRows = await db
      .prepare(
        `SELECT f.*,
                ht.name AS home_name, ht.tag AS home_tag, hc.tag AS home_club_tag,
                at.name AS away_name, at.tag AS away_tag, ac.tag AS away_club_tag
         FROM team_league_fixtures f
         JOIN club_teams ht ON ht.team_id = f.home_team_id
         JOIN clubs hc ON hc.club_id = ht.club_id
         JOIN club_teams at ON at.team_id = f.away_team_id
         JOIN clubs ac ON ac.club_id = at.club_id
         WHERE f.league_id = ?
         ORDER BY f.round_number ASC, f.created_at_ms ASC`,
      )
      .bind(leagueId)
      .all<Record<string, unknown>>();

    const fList = fixtureRows.results ?? [];
    const subMap = await this.loadSubMatchesMap(
      db,
      fList.map((f) => String(f.fixture_id)),
    );

    const fixtures: TeamLeagueFixtureRecord[] = fList.map((f) => {
      const fixtureId = String(f.fixture_id);
      return {
        fixtureId,
        leagueId,
        roundNumber: Number(f.round_number),
        legNumber: Number(f.leg_number ?? 1),
        homeTeamId: String(f.home_team_id),
        homeTeamName: String(f.home_name),
        homeTeamTag: String(f.home_tag),
        homeClubTag: String(f.home_club_tag),
        awayTeamId: String(f.away_team_id),
        awayTeamName: String(f.away_name),
        awayTeamTag: String(f.away_tag),
        awayClubTag: String(f.away_club_tag),
        homeLineup: parseLineupJson(f.home_lineup_json),
        awayLineup: parseLineupJson(f.away_lineup_json),
        homeScore: Number(f.home_score ?? 0),
        awayScore: Number(f.away_score ?? 0),
        winnerTeamId: f.winner_team_id ? String(f.winner_team_id) : null,
        isDraw: Number(f.is_draw) === 1,
        status: (String(f.status) as TeamEncounterStatus) || 'scheduled',
        scheduledAtMs:
          f.scheduled_at_ms !== null && f.scheduled_at_ms !== undefined
            ? Number(f.scheduled_at_ms)
            : null,
        deadlineAtMs:
          f.deadline_at_ms !== null && f.deadline_at_ms !== undefined
            ? Number(f.deadline_at_ms)
            : null,
        completedAtMs:
          f.completed_at_ms !== null && f.completed_at_ms !== undefined
            ? Number(f.completed_at_ms)
            : null,
        subMatches: subMap.get(fixtureId) ?? [],
      };
    });

    const rawStandings: TeamLeagueStandingRow[] = (entryRows.results ?? []).map((e) => ({
      leagueId,
      teamId: String(e.team_id),
      clubId: String(e.club_id),
      clubTag: String(e.club_tag),
      teamName: String(e.team_name),
      teamTag: String(e.team_tag),
      badgeColor: String(e.badge_color ?? '#f59e0b'),
      badgeIcon: sanitizeBadgeIcon(e.badge_icon),
      teamElo: Number(e.team_elo ?? 1200),
      rank: 0,
      played: Number(e.played ?? 0),
      won: Number(e.won ?? 0),
      drawn: Number(e.drawn ?? 0),
      lost: Number(e.lost ?? 0),
      matchWins: Number(e.match_wins ?? 0),
      matchLosses: Number(e.match_losses ?? 0),
      frameDiff: Number(e.frame_diff ?? 0),
      points: Number(e.points ?? 0),
      streak: Number(e.streak ?? 0),
      zone: 'safe',
      outcomeTag:
        e.outcome_tag === 'promoted' || e.outcome_tag === 'relegated' || e.outcome_tag === 'stayed'
          ? e.outcome_tag
          : null,
    }));

    const sorted = sortLeagueStandings(
      rawStandings,
      fixtures.map((f) => ({
        homeTeamId: f.homeTeamId,
        awayTeamId: f.awayTeamId,
        homeScore: f.homeScore,
        awayScore: f.awayScore,
        winnerTeamId: f.winnerTeamId,
        isDraw: f.isDraw,
        status: f.status,
      })),
    );

    const totalTeams = sorted.length;
    const standings: TeamLeagueStandingRow[] = sorted.map((s, idx) => {
      let zone: TeamLeagueStandingRow['zone'] = 'safe';
      if (idx === 0) zone = 'champion';
      else if (idx < league.promotionSlots) zone = 'promotion';
      else if (totalTeams > league.promotionSlots + league.relegationSlots && idx >= totalTeams - league.relegationSlots) {
        zone = 'relegation';
      }
      return { ...s, zone };
    });

    let viewerTeamIds: string[] = [];
    let canManage = false;
    if (viewerId) {
      const vtRows = await db
        .prepare(
          `SELECT DISTINCT t.team_id
           FROM club_teams t
           JOIN club_members cm ON cm.club_id = t.club_id
           JOIN team_league_entries e ON e.team_id = t.team_id
           WHERE e.league_id = ? AND cm.player_id = ?`,
        )
        .bind(leagueId, viewerId)
        .all<{ team_id: string }>();
      viewerTeamIds = (vtRows.results ?? []).map((x) => String(x.team_id));
      canManage = league.createdByPlayerId === viewerId;
    }

    return { league, standings, fixtures, viewerTeamIds, canManage };
  }

  public async registerTeamForLeague(
    actorId: string,
    leagueId: string,
    teamId: string,
  ): Promise<{ ok: true; detail: TeamLeagueDetailPayload } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const lRow = await db
      .prepare('SELECT * FROM team_leagues WHERE league_id = ? LIMIT 1')
      .bind(leagueId)
      .first<Record<string, unknown>>();
    if (!lRow) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'League not found.' };
    if (lRow.status !== 'registration_open') {
      return {
        ok: false,
        status: 409,
        code: 'TOURNAMENT_CLOSED',
        message: 'League registration is closed.',
      };
    }

    const teamRow = await db
      .prepare('SELECT * FROM club_teams WHERE team_id = ? LIMIT 1')
      .bind(teamId)
      .first<Record<string, unknown>>();
    if (!teamRow) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Team not found.' };
    if (!(await this.canManageSpecificTeam(db, actorId, teamRow))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club officers or team captains can enroll teams in leagues.',
      };
    }

    const already = await db
      .prepare('SELECT team_id FROM team_league_entries WHERE league_id = ? AND team_id = ? LIMIT 1')
      .bind(leagueId, teamId)
      .first<{ team_id: string }>();
    if (already) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_REGISTERED',
        message: 'This team is already registered in the league.',
      };
    }

    const countRow = await db
      .prepare('SELECT COUNT(*) AS c FROM team_league_entries WHERE league_id = ?')
      .bind(leagueId)
      .first<{ c: number }>();
    if (Number(countRow?.c ?? 0) >= Number(lRow.max_teams ?? 12)) {
      return { ok: false, status: 409, code: 'TOURNAMENT_FULL', message: 'League is full.' };
    }

    const format = sanitizeMatchFormat(lRow.match_format);
    const elig = await this.checkTeamCompetitionEligibility(db, teamId, format, 'league', leagueId);
    if (!elig.ok) return elig;

    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO team_league_entries (league_id, team_id, club_id, joined_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(leagueId, teamId, elig.team.clubId, now)
      .run();

    await db
      .prepare('UPDATE team_leagues SET updated_at_ms = ? WHERE league_id = ?')
      .bind(now, leagueId)
      .run();

    return { ok: true, detail: (await this.getLeagueDetail(leagueId, actorId))! };
  }

  public async withdrawTeamFromLeague(
    actorId: string,
    leagueId: string,
    teamId: string,
  ): Promise<{ ok: true; detail: TeamLeagueDetailPayload } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const lRow = await db
      .prepare('SELECT * FROM team_leagues WHERE league_id = ? LIMIT 1')
      .bind(leagueId)
      .first<Record<string, unknown>>();
    if (!lRow) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'League not found.' };
    if (lRow.status !== 'registration_open') {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Teams can only withdraw before the league starts.',
      };
    }
    const teamRow = await db
      .prepare('SELECT * FROM club_teams WHERE team_id = ? LIMIT 1')
      .bind(teamId)
      .first<Record<string, unknown>>();
    if (!teamRow || !(await this.canManageSpecificTeam(db, actorId, teamRow))) {
      return { ok: false, status: 403, code: 'UNAUTHORIZED', message: 'Not authorized to withdraw this team.' };
    }

    await db
      .prepare('DELETE FROM team_league_entries WHERE league_id = ? AND team_id = ?')
      .bind(leagueId, teamId)
      .run();

    return { ok: true, detail: (await this.getLeagueDetail(leagueId, actorId))! };
  }

  public async startLeague(
    actorId: string,
    leagueId: string,
  ): Promise<{ ok: true; detail: TeamLeagueDetailPayload } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const lRow = await db
      .prepare('SELECT * FROM team_leagues WHERE league_id = ? LIMIT 1')
      .bind(leagueId)
      .first<Record<string, unknown>>();
    if (!lRow) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'League not found.' };
    if (lRow.created_by_player_id && String(lRow.created_by_player_id) !== actorId) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only the league organizer can start the season.',
      };
    }
    if (lRow.status !== 'registration_open') {
      return { ok: false, status: 409, code: 'CONFLICT', message: 'League already started or ended.' };
    }

    const entries = await db
      .prepare(
        `SELECT e.team_id, t.elo, t.name
         FROM team_league_entries e
         JOIN club_teams t ON t.team_id = e.team_id
         WHERE e.league_id = ?
         ORDER BY t.elo DESC, t.name ASC`,
      )
      .bind(leagueId)
      .all<{ team_id: string; elo: number; name: string }>();

    const teamIds = (entries.results ?? []).map((x) => String(x.team_id));
    if (teamIds.length < 2) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'At least 2 teams must be registered to start a team league.',
      };
    }

    const fixtures = generateRoundRobinFixtures(teamIds, Number(lRow.double_round_robin) === 1);
    const now = Date.now();
    const roundStepMs = Math.max(15, Number(lRow.match_duration_minutes ?? 1440)) * 60_000;

    for (const f of fixtures) {
      const fixtureId = `lfix_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
      const scheduledAt = now + (f.roundNumber - 1) * 60_000;
      const deadlineAt = scheduledAt + roundStepMs * f.roundNumber;
      await db
        .prepare(
          `INSERT INTO team_league_fixtures (
            fixture_id, league_id, round_number, leg_number, home_team_id, away_team_id,
            status, scheduled_at_ms, deadline_at_ms, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
        )
        .bind(
          fixtureId,
          leagueId,
          f.roundNumber,
          f.legNumber,
          f.homeTeamId,
          f.awayTeamId,
          scheduledAt,
          deadlineAt,
          now,
        )
        .run();
    }

    await db
      .prepare(
        `UPDATE team_leagues
         SET status = 'in_progress', starts_at_ms = ?, updated_at_ms = ?
         WHERE league_id = ?`,
      )
      .bind(now, now, leagueId)
      .run();

    return { ok: true, detail: (await this.getLeagueDetail(leagueId, actorId))! };
  }

  // ===== Club Championships (Single Elim, Double Elim, Group+KO, Swiss) =====

  private mapChampionshipRow(
    r: Record<string, unknown>,
    registeredCount: number,
  ): ClubChampionshipRecord {
    const rawFormat = String(r.format ?? 'single_elimination');
    const format: ClubChampionshipFormat =
      rawFormat === 'double_elimination' ||
      rawFormat === 'group_knockout' ||
      rawFormat === 'swiss'
        ? rawFormat
        : 'single_elimination';
    const rawStatus = String(r.status ?? 'registration_open');
    const status: ClubChampionshipStatus =
      rawStatus === 'in_progress' || rawStatus === 'completed' || rawStatus === 'cancelled'
        ? rawStatus
        : 'registration_open';
    const rawStage = String(r.stage ?? 'registration');
    const stage: ClubChampionshipRecord['stage'] =
      rawStage === 'groups' ||
      rawStage === 'knockout' ||
      rawStage === 'swiss' ||
      rawStage === 'completed'
        ? rawStage
        : 'registration';

    return {
      championshipId: String(r.championship_id),
      title: String(r.title),
      description: String(r.description ?? ''),
      format,
      region: String(r.region ?? 'GLOBAL'),
      seasonLabel: String(r.season_label ?? 'Season 1'),
      matchFormat: sanitizeMatchFormat(r.match_format),
      ruleProfileId: r.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
      calledShotsEnabled: Number(r.called_shots_enabled) === 1,
      maxTeams: Number(r.max_teams ?? 16),
      registeredCount,
      currentRound: Number(r.current_round ?? 0),
      totalRounds: Number(r.total_rounds ?? 0),
      swissRounds: Number(r.swiss_rounds ?? 3),
      groupSize: Number(r.group_size ?? 4),
      groupAdvanceCount: Number(r.group_advance_count ?? 2),
      stage,
      status,
      createdByPlayerId: r.created_by_player_id ? String(r.created_by_player_id) : null,
      championTeamId: r.champion_team_id ? String(r.champion_team_id) : null,
      championTeamName: r.champion_team_name ? String(r.champion_team_name) : null,
      championClubId: r.champion_club_id ? String(r.champion_club_id) : null,
      championClubName: r.champion_club_name ? String(r.champion_club_name) : null,
      runnerUpTeamId: r.runner_up_team_id ? String(r.runner_up_team_id) : null,
      runnerUpTeamName: r.runner_up_team_name ? String(r.runner_up_team_name) : null,
      prizeCoinsChampion: Number(r.prize_coins_champion ?? 1000),
      createdAtMs: Number(r.created_at_ms),
      startedAtMs:
        r.started_at_ms !== null && r.started_at_ms !== undefined ? Number(r.started_at_ms) : null,
      completedAtMs:
        r.completed_at_ms !== null && r.completed_at_ms !== undefined
          ? Number(r.completed_at_ms)
          : null,
    };
  }

  public async createChampionship(
    actorId: string,
    input: {
      title: unknown;
      description?: unknown;
      format?: unknown;
      region?: unknown;
      seasonLabel?: unknown;
      matchFormat?: unknown;
      ruleProfileId?: unknown;
      calledShotsEnabled?: unknown;
      maxTeams?: unknown;
      swissRounds?: unknown;
      groupSize?: unknown;
      groupAdvanceCount?: unknown;
      prizeCoinsChampion?: unknown;
    },
  ): Promise<{ ok: true; detail: ClubChampionshipDetailPayload } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const title = sanitizeClubText(input.title, 48);
    if (title.length < 4) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Championship title must be at least 4 characters.',
      };
    }

    const format: ClubChampionshipFormat =
      input.format === 'double_elimination' ||
      input.format === 'group_knockout' ||
      input.format === 'swiss'
        ? input.format
        : 'single_elimination';
    const region = sanitizeRegion(input.region ?? 'GLOBAL');
    const seasonLabel = sanitizeClubText(input.seasonLabel ?? 'Season 1', 24) || 'Season 1';
    const matchFormat = sanitizeMatchFormat(input.matchFormat);
    const ruleProfileId: RuleProfileId = input.ruleProfileId === 'wpa' ? 'wpa' : 'casual';
    const calledShotsEnabled =
      input.calledShotsEnabled !== undefined
        ? Boolean(input.calledShotsEnabled)
        : ruleProfileId === 'wpa';
    const maxTeams = Math.max(2, Math.min(32, Math.floor(Number(input.maxTeams ?? 16) || 16)));
    const swissRounds = Math.max(2, Math.min(7, Math.floor(Number(input.swissRounds ?? 3) || 3)));
    const groupSize = Math.max(3, Math.min(6, Math.floor(Number(input.groupSize ?? 4) || 4)));
    const groupAdvanceCount = Math.max(
      1,
      Math.min(groupSize - 1, Math.floor(Number(input.groupAdvanceCount ?? 2) || 2)),
    );
    const prizeCoinsChampion = Math.max(
      0,
      Math.min(25_000, Math.floor(Number(input.prizeCoinsChampion ?? 1200) || 1200)),
    );
    const description = sanitizeClubText(input.description ?? '', 220);
    const now = Date.now();
    const championshipId = `cchamp_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

    await db
      .prepare(
        `INSERT INTO club_championships (
          championship_id, title, description, format, region, season_label, match_format,
          rule_profile_id, called_shots_enabled, max_teams, current_round, total_rounds,
          swiss_rounds, group_size, group_advance_count, stage, status, created_by_player_id,
          prize_coins_champion, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'registration', 'registration_open', ?, ?, ?, ?)`,
      )
      .bind(
        championshipId,
        title,
        description,
        format,
        region,
        seasonLabel,
        matchFormat,
        ruleProfileId,
        calledShotsEnabled ? 1 : 0,
        maxTeams,
        swissRounds,
        groupSize,
        groupAdvanceCount,
        actorId,
        prizeCoinsChampion,
        now,
        now,
      )
      .run();

    return { ok: true, detail: (await this.getChampionshipDetail(championshipId, actorId))! };
  }

  public async listChampionships(opts?: {
    format?: string | null;
    region?: string | null;
    status?: string | null;
  }): Promise<ClubChampionshipRecord[]> {
    const db = await this.ensureSchema();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (
      opts?.format &&
      (opts.format === 'single_elimination' ||
        opts.format === 'double_elimination' ||
        opts.format === 'group_knockout' ||
        opts.format === 'swiss')
    ) {
      clauses.push('c.format = ?');
      params.push(opts.format);
    }
    if (opts?.region && opts.region !== 'ALL') {
      clauses.push('c.region = ?');
      params.push(sanitizeRegion(opts.region));
    }
    if (opts?.status && opts.status !== 'all') {
      clauses.push('c.status = ?');
      params.push(opts.status);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await db
      .prepare(
        `SELECT c.*, COUNT(e.team_id) AS reg_count
         FROM club_championships c
         LEFT JOIN club_championship_entries e ON e.championship_id = c.championship_id
         ${whereSql}
         GROUP BY c.championship_id
         ORDER BY CASE WHEN c.status = 'in_progress' THEN 0 WHEN c.status = 'registration_open' THEN 1 ELSE 2 END,
                  c.created_at_ms DESC
         LIMIT 40`,
      )
      .bind(...params)
      .all<Record<string, unknown>>();

    return (rows.results ?? []).map((r) => this.mapChampionshipRow(r, Number(r.reg_count ?? 0)));
  }

  public async getChampionshipDetail(
    championshipId: string,
    viewerId?: string | null,
  ): Promise<ClubChampionshipDetailPayload | null> {
    const db = await this.ensureSchema();
    const row = await db
      .prepare(
        `SELECT c.*, COUNT(e.team_id) AS reg_count
         FROM club_championships c
         LEFT JOIN club_championship_entries e ON e.championship_id = c.championship_id
         WHERE c.championship_id = ?
         GROUP BY c.championship_id LIMIT 1`,
      )
      .bind(championshipId)
      .first<Record<string, unknown>>();
    if (!row) return null;

    const championship = this.mapChampionshipRow(row, Number(row.reg_count ?? 0));
    const entryRows = await db
      .prepare(
        `SELECT e.*, t.name AS team_name, t.tag AS team_tag, t.badge_color, t.badge_icon,
                c.tag AS club_tag
         FROM club_championship_entries e
         JOIN club_teams t ON t.team_id = e.team_id
         JOIN clubs c ON c.club_id = e.club_id
         WHERE e.championship_id = ?
         ORDER BY COALESCE(e.placement, 999) ASC, e.points DESC, e.buchholz DESC, e.frame_diff DESC,
                  COALESCE(e.seed, 999) ASC, e.team_elo_at_entry DESC`,
      )
      .bind(championshipId)
      .all<Record<string, unknown>>();

    const seedByTeam = new Map<string, number | null>();
    const entries: ClubChampionshipEntryRecord[] = (entryRows.results ?? []).map((e) => {
      const seed = e.seed !== null && e.seed !== undefined ? Number(e.seed) : null;
      seedByTeam.set(String(e.team_id), seed);
      return {
        championshipId,
        teamId: String(e.team_id),
        clubId: String(e.club_id),
        clubTag: String(e.club_tag),
        teamName: String(e.team_name),
        teamTag: String(e.team_tag),
        badgeColor: String(e.badge_color ?? '#f59e0b'),
        badgeIcon: sanitizeBadgeIcon(e.badge_icon),
        seed,
        groupIndex:
          e.group_index !== null && e.group_index !== undefined ? Number(e.group_index) : null,
        teamEloAtEntry: Number(e.team_elo_at_entry ?? 1200),
        wins: Number(e.wins ?? 0),
        losses: Number(e.losses ?? 0),
        points: Number(e.points ?? 0),
        buchholz: Number(e.buchholz ?? 0),
        frameDiff: Number(e.frame_diff ?? 0),
        eliminated: Number(e.eliminated ?? 0) === 1,
        disqualified: Number(e.disqualified ?? 0) === 1,
        placement:
          e.placement !== null && e.placement !== undefined ? Number(e.placement) : null,
      };
    });

    const matchRows = await db
      .prepare(
        `SELECT m.*,
                ht.name AS home_name, ht.tag AS home_tag,
                at.name AS away_name, at.tag AS away_tag
         FROM club_championship_matches m
         LEFT JOIN club_teams ht ON ht.team_id = m.home_team_id
         LEFT JOIN club_teams at ON at.team_id = m.away_team_id
         WHERE m.championship_id = ?
         ORDER BY CASE m.stage_type
                    WHEN 'group' THEN 0
                    WHEN 'swiss' THEN 1
                    WHEN 'winners' THEN 2
                    WHEN 'knockout' THEN 3
                    WHEN 'losers' THEN 4
                    ELSE 5
                  END,
                  m.round_number ASC, m.slot_index ASC`,
      )
      .bind(championshipId)
      .all<Record<string, unknown>>();

    const mList = matchRows.results ?? [];
    const subMap = await this.loadSubMatchesMap(
      db,
      mList.map((m) => String(m.match_node_id)),
    );

    const matches: ClubChampionshipMatchRecord[] = mList.map((m) => {
      const nodeId = String(m.match_node_id);
      const hId = m.home_team_id ? String(m.home_team_id) : null;
      const aId = m.away_team_id ? String(m.away_team_id) : null;
      return {
        matchNodeId: nodeId,
        championshipId,
        stageType: String(m.stage_type) as ClubChampionshipMatchRecord['stageType'],
        groupIndex:
          m.group_index !== null && m.group_index !== undefined ? Number(m.group_index) : null,
        roundNumber: Number(m.round_number),
        roundLabel: String(m.round_label),
        slotIndex: Number(m.slot_index),
        homeTeamId: hId,
        homeTeamName: m.home_name ? String(m.home_name) : null,
        homeTeamTag: m.home_tag ? String(m.home_tag) : null,
        homeSeed: hId ? seedByTeam.get(hId) ?? null : null,
        awayTeamId: aId,
        awayTeamName: m.away_name ? String(m.away_name) : null,
        awayTeamTag: m.away_tag ? String(m.away_tag) : null,
        awaySeed: aId ? seedByTeam.get(aId) ?? null : null,
        homeLineup: parseLineupJson(m.home_lineup_json),
        awayLineup: parseLineupJson(m.away_lineup_json),
        homeScore: Number(m.home_score ?? 0),
        awayScore: Number(m.away_score ?? 0),
        winnerTeamId: m.winner_team_id ? String(m.winner_team_id) : null,
        nextWinnerNodeId: m.next_winner_node_id ? String(m.next_winner_node_id) : null,
        nextWinnerSlot:
          m.next_winner_slot === 'home' || m.next_winner_slot === 'away'
            ? m.next_winner_slot
            : null,
        nextLoserNodeId: m.next_loser_node_id ? String(m.next_loser_node_id) : null,
        nextLoserSlot:
          m.next_loser_slot === 'home' || m.next_loser_slot === 'away'
            ? m.next_loser_slot
            : null,
        status: (String(m.status) as TeamEncounterStatus) || 'pending',
        resolutionNote: m.resolution_note ? String(m.resolution_note) : null,
        deadlineAtMs:
          m.deadline_at_ms !== null && m.deadline_at_ms !== undefined
            ? Number(m.deadline_at_ms)
            : null,
        completedAtMs:
          m.completed_at_ms !== null && m.completed_at_ms !== undefined
            ? Number(m.completed_at_ms)
            : null,
        subMatches: subMap.get(nodeId) ?? [],
      };
    });

    let viewerTeamIds: string[] = [];
    let canManage = false;
    if (viewerId) {
      const vtRows = await db
        .prepare(
          `SELECT DISTINCT t.team_id
           FROM club_teams t
           JOIN club_members cm ON cm.club_id = t.club_id
           JOIN club_championship_entries e ON e.team_id = t.team_id
           WHERE e.championship_id = ? AND cm.player_id = ?`,
        )
        .bind(championshipId, viewerId)
        .all<{ team_id: string }>();
      viewerTeamIds = (vtRows.results ?? []).map((x) => String(x.team_id));
      canManage = championship.createdByPlayerId === viewerId;
    }

    return { championship, entries, matches, viewerTeamIds, canManage };
  }

  public async registerTeamForChampionship(
    actorId: string,
    championshipId: string,
    teamId: string,
  ): Promise<{ ok: true; detail: ClubChampionshipDetailPayload } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const cRow = await db
      .prepare('SELECT * FROM club_championships WHERE championship_id = ? LIMIT 1')
      .bind(championshipId)
      .first<Record<string, unknown>>();
    if (!cRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Championship not found.' };
    }
    if (cRow.status !== 'registration_open') {
      return {
        ok: false,
        status: 409,
        code: 'TOURNAMENT_CLOSED',
        message: 'Championship registration is closed.',
      };
    }

    const teamRow = await db
      .prepare('SELECT * FROM club_teams WHERE team_id = ? LIMIT 1')
      .bind(teamId)
      .first<Record<string, unknown>>();
    if (!teamRow) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Team not found.' };
    if (!(await this.canManageSpecificTeam(db, actorId, teamRow))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club leadership or the team captain can register a team.',
      };
    }

    const already = await db
      .prepare(
        'SELECT team_id FROM club_championship_entries WHERE championship_id = ? AND team_id = ? LIMIT 1',
      )
      .bind(championshipId, teamId)
      .first<{ team_id: string }>();
    if (already) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_REGISTERED',
        message: 'This team is already registered in this championship.',
      };
    }

    const countRow = await db
      .prepare('SELECT COUNT(*) AS c FROM club_championship_entries WHERE championship_id = ?')
      .bind(championshipId)
      .first<{ c: number }>();
    if (Number(countRow?.c ?? 0) >= Number(cRow.max_teams ?? 16)) {
      return { ok: false, status: 409, code: 'TOURNAMENT_FULL', message: 'Championship is full.' };
    }

    const format = sanitizeMatchFormat(cRow.match_format);
    const elig = await this.checkTeamCompetitionEligibility(
      db,
      teamId,
      format,
      'club_championship',
      championshipId,
    );
    if (!elig.ok) return elig;

    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO club_championship_entries (
          championship_id, team_id, club_id, team_elo_at_entry, joined_at_ms
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(championshipId, teamId, elig.team.clubId, elig.team.elo, now)
      .run();

    await db
      .prepare('UPDATE club_championships SET updated_at_ms = ? WHERE championship_id = ?')
      .bind(now, championshipId)
      .run();

    return { ok: true, detail: (await this.getChampionshipDetail(championshipId, actorId))! };
  }

  public async withdrawTeamFromChampionship(
    actorId: string,
    championshipId: string,
    teamId: string,
  ): Promise<{ ok: true; detail: ClubChampionshipDetailPayload } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const cRow = await db
      .prepare('SELECT * FROM club_championships WHERE championship_id = ? LIMIT 1')
      .bind(championshipId)
      .first<Record<string, unknown>>();
    if (!cRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Championship not found.' };
    }
    if (cRow.status !== 'registration_open') {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Cannot withdraw once the championship bracket has started.',
      };
    }
    const teamRow = await db
      .prepare('SELECT * FROM club_teams WHERE team_id = ? LIMIT 1')
      .bind(teamId)
      .first<Record<string, unknown>>();
    if (!teamRow || !(await this.canManageSpecificTeam(db, actorId, teamRow))) {
      return { ok: false, status: 403, code: 'UNAUTHORIZED', message: 'Not authorized to withdraw this team.' };
    }

    await db
      .prepare('DELETE FROM club_championship_entries WHERE championship_id = ? AND team_id = ?')
      .bind(championshipId, teamId)
      .run();

    return { ok: true, detail: (await this.getChampionshipDetail(championshipId, actorId))! };
  }

  public async startChampionship(
    actorId: string,
    championshipId: string,
  ): Promise<{ ok: true; detail: ClubChampionshipDetailPayload } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const cRow = await db
      .prepare('SELECT * FROM club_championships WHERE championship_id = ? LIMIT 1')
      .bind(championshipId)
      .first<Record<string, unknown>>();
    if (!cRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Championship not found.' };
    }
    if (cRow.created_by_player_id && String(cRow.created_by_player_id) !== actorId) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only the championship organizer can launch the tournament.',
      };
    }
    if (cRow.status !== 'registration_open') {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Championship is already started or finished.',
      };
    }

    const entryRows = await db
      .prepare(
        `SELECT e.team_id, e.club_id, t.elo, t.name
         FROM club_championship_entries e
         JOIN club_teams t ON t.team_id = e.team_id
         WHERE e.championship_id = ?`,
      )
      .bind(championshipId)
      .all<{ team_id: string; club_id: string; elo: number; name: string }>();

    const rawTeams = entryRows.results ?? [];
    if (rawTeams.length < 2) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'At least 2 teams are required to start a club championship.',
      };
    }

    const seeded = seedTeamsByElo(
      rawTeams.map((t) => ({
        teamId: String(t.team_id),
        clubId: String(t.club_id),
        elo: Number(t.elo ?? 1200),
        name: String(t.name),
      })),
    );

    const now = Date.now();
    for (let i = 0; i < seeded.length; i++) {
      await db
        .prepare(
          'UPDATE club_championship_entries SET seed = ?, team_elo_at_entry = ? WHERE championship_id = ? AND team_id = ?',
        )
        .bind(i + 1, seeded[i].elo, championshipId, seeded[i].teamId)
        .run();
    }

    const format = String(cRow.format);
    let stage = 'knockout';
    let totalRounds = 1;

    if (format === 'single_elimination') {
      const rounds = await this.buildSingleEliminationNodes(
        db,
        championshipId,
        seeded.map((s) => s.teamId),
        'knockout',
        now,
      );
      totalRounds = rounds;
      stage = 'knockout';
    } else if (format === 'double_elimination') {
      const rounds = await this.buildDoubleEliminationNodes(
        db,
        championshipId,
        seeded.map((s) => s.teamId),
        now,
      );
      totalRounds = rounds;
      stage = 'knockout';
    } else if (format === 'group_knockout') {
      const groupSize = Math.max(3, Number(cRow.group_size ?? 4));
      const numGroups = Math.max(1, Math.ceil(seeded.length / groupSize));
      const groups: string[][] = Array.from({ length: numGroups }, () => []);
      seeded.forEach((s, idx) => {
        const gIdx = idx % numGroups;
        groups[gIdx].push(s.teamId);
      });
      let maxGroupRound = 1;
      for (let gIdx = 0; gIdx < groups.length; gIdx++) {
        for (const tid of groups[gIdx]) {
          await db
            .prepare(
              'UPDATE club_championship_entries SET group_index = ? WHERE championship_id = ? AND team_id = ?',
            )
            .bind(gIdx + 1, championshipId, tid)
            .run();
        }
        const fixtures = generateRoundRobinFixtures(groups[gIdx], false);
        for (let i = 0; i < fixtures.length; i++) {
          const f = fixtures[i];
          maxGroupRound = Math.max(maxGroupRound, f.roundNumber);
          const nodeId = `cn_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
          await db
            .prepare(
              `INSERT INTO club_championship_matches (
                match_node_id, championship_id, stage_type, group_index, round_number, round_label,
                slot_index, home_team_id, away_team_id, status, deadline_at_ms, created_at_ms
              ) VALUES (?, ?, 'group', ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
            )
            .bind(
              nodeId,
              championshipId,
              gIdx + 1,
              f.roundNumber,
              `Group ${String.fromCharCode(65 + gIdx)} · R${f.roundNumber}`,
              i,
              f.homeTeamId,
              f.awayTeamId,
              now + 24 * 60 * 60 * 1000,
              now,
            )
            .run();
        }
      }
      stage = 'groups';
      totalRounds = maxGroupRound;
    } else if (format === 'swiss') {
      const swissRounds = Math.min(
        Math.max(2, Number(cRow.swiss_rounds ?? 3)),
        Math.max(2, seeded.length - 1),
      );
      await db
        .prepare('UPDATE club_championships SET swiss_rounds = ? WHERE championship_id = ?')
        .bind(swissRounds, championshipId)
        .run();
      await this.generateNextSwissRound(db, championshipId, 1, now);
      stage = 'swiss';
      totalRounds = swissRounds;
    }

    await db
      .prepare(
        `UPDATE club_championships
         SET status = 'in_progress', stage = ?, current_round = 1, total_rounds = ?, started_at_ms = ?, updated_at_ms = ?
         WHERE championship_id = ?`,
      )
      .bind(stage, totalRounds, now, now, championshipId)
      .run();

    await this.propagateBracketByes(db, championshipId, now);

    return { ok: true, detail: (await this.getChampionshipDetail(championshipId, actorId))! };
  }

  private async buildSingleEliminationNodes(
    db: ProgressionSqlDb,
    championshipId: string,
    orderedTeamIds: string[],
    stageType: 'knockout',
    now: number,
  ): Promise<number> {
    const bracketSize = nextPowerOf2(orderedTeamIds.length);
    const totalRounds = Math.round(Math.log2(bracketSize));
    const seedPos = generateBracketSeedPositions(bracketSize);
    const nodesByRound: string[][] = [];

    for (let r = 1; r <= totalRounds; r++) {
      const matchCount = bracketSize / Math.pow(2, r);
      const ids: string[] = [];
      for (let i = 0; i < matchCount; i++) {
        ids.push(`cn_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`);
      }
      nodesByRound.push(ids);
    }

    const roundLabelFor = (r: number) => {
      if (r === totalRounds) return 'Grand Final';
      if (r === totalRounds - 1) return 'Semifinals';
      if (r === totalRounds - 2) return 'Quarterfinals';
      return `Round ${r}`;
    };

    for (let r = 1; r <= totalRounds; r++) {
      const rIds = nodesByRound[r - 1];
      for (let i = 0; i < rIds.length; i++) {
        const nodeId = rIds[i];
        const nextWinnerNodeId = r < totalRounds ? nodesByRound[r][Math.floor(i / 2)] : null;
        const nextWinnerSlot = r < totalRounds ? (i % 2 === 0 ? 'home' : 'away') : null;
        let homeTeamId: string | null = null;
        let awayTeamId: string | null = null;
        if (r === 1) {
          const sHome = seedPos[i * 2];
          const sAway = seedPos[i * 2 + 1];
          homeTeamId = sHome <= orderedTeamIds.length ? orderedTeamIds[sHome - 1] : null;
          awayTeamId = sAway <= orderedTeamIds.length ? orderedTeamIds[sAway - 1] : null;
        }
        const status: TeamEncounterStatus =
          homeTeamId && awayTeamId ? 'scheduled' : 'pending';
        await db
          .prepare(
            `INSERT INTO club_championship_matches (
              match_node_id, championship_id, stage_type, round_number, round_label, slot_index,
              home_team_id, away_team_id, next_winner_node_id, next_winner_slot, status, deadline_at_ms, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            nodeId,
            championshipId,
            stageType,
            r,
            roundLabelFor(r),
            i,
            homeTeamId,
            awayTeamId,
            nextWinnerNodeId,
            nextWinnerSlot,
            status,
            now + r * 24 * 60 * 60 * 1000,
            now,
          )
          .run();
      }
    }
    return totalRounds;
  }

  private async buildDoubleEliminationNodes(
    db: ProgressionSqlDb,
    championshipId: string,
    orderedTeamIds: string[],
    now: number,
  ): Promise<number> {
    if (orderedTeamIds.length <= 2) {
      return this.buildSingleEliminationNodes(db, championshipId, orderedTeamIds, 'knockout', now);
    }

    const bracketSize = nextPowerOf2(orderedTeamIds.length);
    const k = Math.round(Math.log2(bracketSize));
    const seedPos = generateBracketSeedPositions(bracketSize);

    const wb: string[][] = [];
    for (let r = 1; r <= k; r++) {
      const count = bracketSize / Math.pow(2, r);
      wb.push(
        Array.from({ length: count }, () => `cn_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`),
      );
    }

    const lbRounds = 2 * (k - 1);
    const lb: string[][] = [];
    for (let lr = 1; lr <= lbRounds; lr++) {
      const pairStep = Math.ceil(lr / 2);
      const count = Math.max(1, bracketSize / Math.pow(2, pairStep + 1));
      lb.push(
        Array.from({ length: count }, () => `cn_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`),
      );
    }

    const gfNodeId = `cn_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

    // Insert Grand Final
    await db
      .prepare(
        `INSERT INTO club_championship_matches (
          match_node_id, championship_id, stage_type, round_number, round_label, slot_index,
          status, deadline_at_ms, created_at_ms
        ) VALUES (?, ?, 'grand_final', ?, 'Grand Final', 0, 'pending', ?, ?)`,
      )
      .bind(gfNodeId, championshipId, k + 1, now + (lbRounds + 2) * 24 * 60 * 60 * 1000, now)
      .run();

    // Insert Losers Bracket
    for (let lr = 1; lr <= lbRounds; lr++) {
      const ids = lb[lr - 1];
      for (let i = 0; i < ids.length; i++) {
        let nextWinnerNodeId: string;
        let nextWinnerSlot: 'home' | 'away';
        if (lr === lbRounds) {
          nextWinnerNodeId = gfNodeId;
          nextWinnerSlot = 'away';
        } else if (lr % 2 === 1) {
          // Feeds major round same slot index home
          nextWinnerNodeId = lb[lr][i];
          nextWinnerSlot = 'home';
        } else {
          // Feeds minor consolidation round
          nextWinnerNodeId = lb[lr][Math.floor(i / 2)];
          nextWinnerSlot = i % 2 === 0 ? 'home' : 'away';
        }
        const label = lr === lbRounds ? 'Losers Final' : `Losers R${lr}`;
        await db
          .prepare(
            `INSERT INTO club_championship_matches (
              match_node_id, championship_id, stage_type, round_number, round_label, slot_index,
              next_winner_node_id, next_winner_slot, status, deadline_at_ms, created_at_ms
            ) VALUES (?, ?, 'losers', ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .bind(
            ids[i],
            championshipId,
            lr,
            label,
            i,
            nextWinnerNodeId,
            nextWinnerSlot,
            now + (lr + 1) * 24 * 60 * 60 * 1000,
            now,
          )
          .run();
      }
    }

    // Insert Winners Bracket
    for (let r = 1; r <= k; r++) {
      const ids = wb[r - 1];
      for (let i = 0; i < ids.length; i++) {
        const nextWinnerNodeId = r < k ? wb[r][Math.floor(i / 2)] : gfNodeId;
        const nextWinnerSlot: 'home' | 'away' = r < k ? (i % 2 === 0 ? 'home' : 'away') : 'home';

        let nextLoserNodeId: string;
        let nextLoserSlot: 'home' | 'away';
        if (r === 1) {
          nextLoserNodeId = lb[0][Math.floor(i / 2)];
          nextLoserSlot = i % 2 === 0 ? 'home' : 'away';
        } else {
          const targetLbIdx = 2 * (r - 1) - 1;
          const targetCount = lb[targetLbIdx].length;
          const reversedIdx = targetCount - 1 - i;
          nextLoserNodeId = lb[targetLbIdx][reversedIdx];
          nextLoserSlot = 'away';
        }

        let homeTeamId: string | null = null;
        let awayTeamId: string | null = null;
        if (r === 1) {
          const sHome = seedPos[i * 2];
          const sAway = seedPos[i * 2 + 1];
          homeTeamId = sHome <= orderedTeamIds.length ? orderedTeamIds[sHome - 1] : null;
          awayTeamId = sAway <= orderedTeamIds.length ? orderedTeamIds[sAway - 1] : null;
        }
        const status: TeamEncounterStatus =
          homeTeamId && awayTeamId ? 'scheduled' : 'pending';
        const label = r === k ? 'Winners Final' : `Winners R${r}`;
        await db
          .prepare(
            `INSERT INTO club_championship_matches (
              match_node_id, championship_id, stage_type, round_number, round_label, slot_index,
              home_team_id, away_team_id, next_winner_node_id, next_winner_slot,
              next_loser_node_id, next_loser_slot, status, deadline_at_ms, created_at_ms
            ) VALUES (?, ?, 'winners', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            ids[i],
            championshipId,
            r,
            label,
            i,
            homeTeamId,
            awayTeamId,
            nextWinnerNodeId,
            nextWinnerSlot,
            nextLoserNodeId,
            nextLoserSlot,
            status,
            now + r * 24 * 60 * 60 * 1000,
            now,
          )
          .run();
      }
    }

    return k + 1;
  }

  private async propagateBracketByes(
    db: ProgressionSqlDb,
    championshipId: string,
    now: number,
  ): Promise<void> {
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      const rows = await db
        .prepare('SELECT * FROM club_championship_matches WHERE championship_id = ?')
        .bind(championshipId)
        .all<Record<string, unknown>>();
      const all = rows.results ?? [];
      const incomingCount = new Map<string, number>();
      for (const m of all) {
        if (m.next_winner_node_id && m.status !== 'completed' && m.status !== 'bye' && m.status !== 'walkover') {
          const id = String(m.next_winner_node_id);
          incomingCount.set(id, (incomingCount.get(id) ?? 0) + 1);
        }
        if (m.next_loser_node_id && m.status !== 'completed' && m.status !== 'bye' && m.status !== 'walkover') {
          const id = String(m.next_loser_node_id);
          incomingCount.set(id, (incomingCount.get(id) ?? 0) + 1);
        }
      }

      for (const m of all) {
        const nodeId = String(m.match_node_id);
        const hId = m.home_team_id ? String(m.home_team_id) : null;
        const aId = m.away_team_id ? String(m.away_team_id) : null;
        if (m.status !== 'pending') continue;

        if (hId && aId) {
          await db
            .prepare("UPDATE club_championship_matches SET status = 'scheduled' WHERE match_node_id = ?")
            .bind(nodeId)
            .run();
          changed = true;
          continue;
        }

        const feedersRemaining = incomingCount.get(nodeId) ?? 0;
        if (m.round_number === 1 && m.stage_type !== 'losers') {
          const solo = hId ?? aId;
          await db
            .prepare(
              `UPDATE club_championship_matches
               SET winner_team_id = ?, status = 'bye', resolution_note = 'Automatic bye advance', completed_at_ms = ?
               WHERE match_node_id = ?`,
            )
            .bind(solo, now, nodeId)
            .run();
          if (solo && m.next_winner_node_id && m.next_winner_slot) {
            const col = m.next_winner_slot === 'home' ? 'home_team_id' : 'away_team_id';
            await db
              .prepare(`UPDATE club_championship_matches SET ${col} = ? WHERE match_node_id = ?`)
              .bind(solo, String(m.next_winner_node_id))
              .run();
          }
          changed = true;
        } else if (feedersRemaining === 0 && (!hId || !aId)) {
          const solo = hId ?? aId ?? null;
          await db
            .prepare(
              `UPDATE club_championship_matches
               SET winner_team_id = ?, status = 'bye', resolution_note = 'Automatic bye advance', completed_at_ms = ?
               WHERE match_node_id = ?`,
            )
            .bind(solo, now, nodeId)
            .run();
          if (solo && m.next_winner_node_id && m.next_winner_slot) {
            const col = m.next_winner_slot === 'home' ? 'home_team_id' : 'away_team_id';
            await db
              .prepare(`UPDATE club_championship_matches SET ${col} = ? WHERE match_node_id = ?`)
              .bind(solo, String(m.next_winner_node_id))
              .run();
          }
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  private async generateNextSwissRound(
    db: ProgressionSqlDb,
    championshipId: string,
    roundNumber: number,
    now: number,
  ): Promise<void> {
    const entryRows = await db
      .prepare(
        `SELECT team_id, points, buchholz, frame_diff, team_elo_at_entry, disqualified
         FROM club_championship_entries
         WHERE championship_id = ? AND disqualified = 0
         ORDER BY points DESC, buchholz DESC, frame_diff DESC, team_elo_at_entry DESC`,
      )
      .bind(championshipId)
      .all<Record<string, unknown>>();
    const active = (entryRows.results ?? []).map((e) => String(e.team_id));
    if (active.length < 2) return;

    const prevRows = await db
      .prepare(
        `SELECT home_team_id, away_team_id, status
         FROM club_championship_matches
         WHERE championship_id = ? AND stage_type = 'swiss'`,
      )
      .bind(championshipId)
      .all<{ home_team_id: string | null; away_team_id: string | null; status: string }>();

    const playedPairs = new Set<string>();
    const hadBye = new Set<string>();
    for (const p of prevRows.results ?? []) {
      if (p.home_team_id && p.away_team_id) {
        const pair = [p.home_team_id, p.away_team_id].sort().join(':');
        playedPairs.add(pair);
      } else if (p.status === 'bye' && (p.home_team_id || p.away_team_id)) {
        hadBye.add((p.home_team_id ?? p.away_team_id)!);
      }
    }

    const pool = [...active];
    let byeTeamId: string | null = null;
    if (pool.length % 2 === 1) {
      let byeIdx = -1;
      for (let i = pool.length - 1; i >= 0; i--) {
        if (!hadBye.has(pool[i])) {
          byeIdx = i;
          break;
        }
      }
      if (byeIdx < 0) byeIdx = pool.length - 1;
      byeTeamId = pool.splice(byeIdx, 1)[0];
    }

    const pairs: Array<[string, string]> = [];
    if (roundNumber === 1) {
      const half = pool.length / 2;
      for (let i = 0; i < half; i++) {
        pairs.push([pool[i], pool[i + half]]);
      }
    } else {
      const used = new Set<string>();
      for (let i = 0; i < pool.length; i++) {
        const t1 = pool[i];
        if (used.has(t1)) continue;
        let oppIdx = -1;
        for (let j = i + 1; j < pool.length; j++) {
          const t2 = pool[j];
          if (used.has(t2)) continue;
          const key = [t1, t2].sort().join(':');
          if (!playedPairs.has(key)) {
            oppIdx = j;
            break;
          }
        }
        if (oppIdx < 0) {
          for (let j = i + 1; j < pool.length; j++) {
            if (!used.has(pool[j])) {
              oppIdx = j;
              break;
            }
          }
        }
        if (oppIdx >= 0) {
          used.add(t1);
          used.add(pool[oppIdx]);
          pairs.push([t1, pool[oppIdx]]);
        }
      }
    }

    for (let i = 0; i < pairs.length; i++) {
      const [h, a] = pairs[i];
      const nodeId = `cn_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
      await db
        .prepare(
          `INSERT INTO club_championship_matches (
            match_node_id, championship_id, stage_type, round_number, round_label, slot_index,
            home_team_id, away_team_id, status, deadline_at_ms, created_at_ms
          ) VALUES (?, ?, 'swiss', ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        )
        .bind(
          nodeId,
          championshipId,
          roundNumber,
          `Swiss Round ${roundNumber}`,
          i,
          h,
          a,
          now + 24 * 60 * 60 * 1000,
          now,
        )
        .run();
    }

    if (byeTeamId) {
      const nodeId = `cn_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
      await db
        .prepare(
          `INSERT INTO club_championship_matches (
            match_node_id, championship_id, stage_type, round_number, round_label, slot_index,
            home_team_id, winner_team_id, status, resolution_note, completed_at_ms, created_at_ms
          ) VALUES (?, ?, 'swiss', ?, ?, ?, ?, ?, 'bye', 'Swiss round bye (1 pt)', ?, ?)`,
        )
        .bind(
          nodeId,
          championshipId,
          roundNumber,
          `Swiss Round ${roundNumber}`,
          pairs.length,
          byeTeamId,
          byeTeamId,
          now,
          now,
        )
        .run();
      await db
        .prepare(
          'UPDATE club_championship_entries SET wins = wins + 1, points = points + 3 WHERE championship_id = ? AND team_id = ?',
        )
        .bind(championshipId, byeTeamId)
        .run();
    }
  }

  // ===== Shared Lineup, Substitution & Sub-Match Room Execution =====

  public async submitEncounterLineup(
    actorId: string,
    params: {
      competitionKind: 'league' | 'club_championship';
      competitionId: string;
      encounterId: string;
      teamId: string;
      playerIds: string[];
    },
  ): Promise<{ ok: true; subMatches: TeamSubMatchRecord[] } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const enc = await this.loadEncounterMeta(
      db,
      params.competitionKind,
      params.competitionId,
      params.encounterId,
    );
    if (!enc) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Encounter not found.' };
    }
    if (
      enc.status === 'completed' ||
      enc.status === 'bye' ||
      enc.status === 'walkover' ||
      enc.status === 'disqualified'
    ) {
      return { ok: false, status: 409, code: 'CONFLICT', message: 'Encounter is already finalized.' };
    }
    if (params.teamId !== enc.homeTeamId && params.teamId !== enc.awayTeamId) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Team is not a participant in this encounter.',
      };
    }

    const teamDetail = await this.getTeamById(params.teamId);
    if (!teamDetail) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Team not found.' };
    }
    const teamRow = await db
      .prepare('SELECT * FROM club_teams WHERE team_id = ? LIMIT 1')
      .bind(params.teamId)
      .first<Record<string, unknown>>();
    if (!teamRow || !(await this.canManageSpecificTeam(db, actorId, teamRow))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club leadership or the team captain can submit lineups.',
      };
    }

    const spec = TEAM_MATCH_FORMAT_SPEC[enc.matchFormat];
    const cleanIds = params.playerIds.map((p) => p.trim()).filter(Boolean);
    if (cleanIds.length !== spec.requiredLineupPlayers) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: `${spec.label} requires exactly ${spec.requiredLineupPlayers} nominated player(s).`,
      };
    }
    if (new Set(cleanIds).size !== cleanIds.length) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Lineup slots cannot assign the same player twice.',
      };
    }

    const rosterMap = new Map(teamDetail.team.roster.map((m) => [m.playerId, m]));
    const lineup: TeamLineupSlot[] = [];
    for (let i = 0; i < cleanIds.length; i++) {
      const member = rosterMap.get(cleanIds[i]);
      if (!member) {
        return {
          ok: false,
          status: 400,
          code: 'INVALID_INPUT',
          message: 'All lineup players must belong to this team roster.',
        };
      }
      lineup.push({
        slotIndex: i,
        playerId: member.playerId,
        displayName: member.displayName,
        avatarId: member.avatarId,
        elo: member.elo,
      });
    }

    const isHome = params.teamId === enc.homeTeamId;
    const col = isHome ? 'home_lineup_json' : 'away_lineup_json';
    const table =
      params.competitionKind === 'league' ? 'team_league_fixtures' : 'club_championship_matches';
    const pkCol = params.competitionKind === 'league' ? 'fixture_id' : 'match_node_id';

    await db
      .prepare(`UPDATE ${table} SET ${col} = ? WHERE ${pkCol} = ?`)
      .bind(JSON.stringify(lineup), params.encounterId)
      .run();

    const homeLineup = isHome ? lineup : enc.homeLineup;
    const awayLineup = isHome ? enc.awayLineup : lineup;
    await this.syncEncounterSubMatches(db, {
      ...enc,
      homeLineup,
      awayLineup,
    });

    const subMap = await this.loadSubMatchesMap(db, [params.encounterId]);
    return { ok: true, subMatches: subMap.get(params.encounterId) ?? [] };
  }

  public async substituteLineupSlot(
    actorId: string,
    params: {
      subMatchId: string;
      teamId: string;
      newPlayerId: string;
    },
  ): Promise<
    | { ok: true; subMatch: TeamSubMatchRecord; closedRoomId: string | null }
    | ClubLeagueServiceError
  > {
    const db = await this.ensureSchema();
    const smRow = await db
      .prepare('SELECT * FROM team_match_submatches WHERE sub_match_id = ? LIMIT 1')
      .bind(params.subMatchId)
      .first<Record<string, unknown>>();
    if (!smRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Match board not found.' };
    }
    if (smRow.status !== 'pending' && smRow.status !== 'ready') {
      return {
        ok: false,
        status: 409,
        code: 'MATCH_LOCKED',
        message: 'Substitutions are only allowed before a board match starts.',
      };
    }

    const teamRow = await db
      .prepare('SELECT * FROM club_teams WHERE team_id = ? LIMIT 1')
      .bind(params.teamId)
      .first<Record<string, unknown>>();
    if (!teamRow || !(await this.canManageSpecificTeam(db, actorId, teamRow))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club leadership or the team captain can make substitutions.',
      };
    }

    const isHome = params.teamId === String(smRow.home_team_id);
    const isAway = params.teamId === String(smRow.away_team_id);
    if (!isHome && !isAway) {
      return { ok: false, status: 403, code: 'UNAUTHORIZED', message: 'Team is not in this match.' };
    }

    const teamDetail = await this.getTeamById(params.teamId);
    const replacement = teamDetail?.team.roster.find((m) => m.playerId === params.newPlayerId.trim());
    if (!replacement) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Substitute must be an active member of your team roster.',
      };
    }

    const playerCol = isHome ? 'home_player_id' : 'away_player_id';
    const closedRoomId = smRow.room_id ? String(smRow.room_id) : null;
    await db
      .prepare(
        `UPDATE team_match_submatches
         SET ${playerCol} = ?, room_id = NULL, room_code = NULL, status = 'ready'
         WHERE sub_match_id = ?`,
      )
      .bind(replacement.playerId, params.subMatchId)
      .run();

    const subMap = await this.loadSubMatchesMap(db, [String(smRow.encounter_id)]);
    const updated = subMap
      .get(String(smRow.encounter_id))!
      .find((s) => s.subMatchId === params.subMatchId)!;
    return { ok: true, subMatch: updated, closedRoomId };
  }

  private async loadEncounterMeta(
    db: ProgressionSqlDb,
    competitionKind: 'league' | 'club_championship',
    competitionId: string,
    encounterId: string,
  ): Promise<{
    competitionKind: 'league' | 'club_championship';
    competitionId: string;
    competitionTitle: string;
    matchFormat: TeamMatchFormat;
    ruleProfileId: RuleProfileId;
    calledShotsEnabled: boolean;
    encounterId: string;
    homeTeamId: string;
    awayTeamId: string;
    homeLineup: TeamLineupSlot[];
    awayLineup: TeamLineupSlot[];
    homeScore: number;
    awayScore: number;
    status: string;
  } | null> {
    if (competitionKind === 'league') {
      const row = await db
        .prepare(
          `SELECT f.*, l.title, l.match_format, l.rule_profile_id, l.called_shots_enabled
           FROM team_league_fixtures f
           JOIN team_leagues l ON l.league_id = f.league_id
           WHERE f.fixture_id = ? AND f.league_id = ? LIMIT 1`,
        )
        .bind(encounterId, competitionId)
        .first<Record<string, unknown>>();
      if (!row) return null;
      return {
        competitionKind: 'league',
        competitionId,
        competitionTitle: String(row.title),
        matchFormat: sanitizeMatchFormat(row.match_format),
        ruleProfileId: row.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
        calledShotsEnabled: Number(row.called_shots_enabled) === 1,
        encounterId,
        homeTeamId: String(row.home_team_id),
        awayTeamId: String(row.away_team_id),
        homeLineup: parseLineupJson(row.home_lineup_json),
        awayLineup: parseLineupJson(row.away_lineup_json),
        homeScore: Number(row.home_score ?? 0),
        awayScore: Number(row.away_score ?? 0),
        status: String(row.status),
      };
    }

    const row = await db
      .prepare(
        `SELECT m.*, c.title, c.match_format, c.rule_profile_id, c.called_shots_enabled
         FROM club_championship_matches m
         JOIN club_championships c ON c.championship_id = m.championship_id
         WHERE m.match_node_id = ? AND m.championship_id = ? LIMIT 1`,
      )
      .bind(encounterId, competitionId)
      .first<Record<string, unknown>>();
    if (!row || !row.home_team_id || !row.away_team_id) return null;
    return {
      competitionKind: 'club_championship',
      competitionId,
      competitionTitle: String(row.title),
      matchFormat: sanitizeMatchFormat(row.match_format),
      ruleProfileId: row.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
      calledShotsEnabled: Number(row.called_shots_enabled) === 1,
      encounterId,
      homeTeamId: String(row.home_team_id),
      awayTeamId: String(row.away_team_id),
      homeLineup: parseLineupJson(row.home_lineup_json),
      awayLineup: parseLineupJson(row.away_lineup_json),
      homeScore: Number(row.home_score ?? 0),
      awayScore: Number(row.away_score ?? 0),
      status: String(row.status),
    };
  }

  private async syncEncounterSubMatches(
    db: ProgressionSqlDb,
    enc: NonNullable<Awaited<ReturnType<ClubLeagueService['loadEncounterMeta']>>>,
  ): Promise<void> {
    const spec = TEAM_MATCH_FORMAT_SPEC[enc.matchFormat];
    if (
      enc.homeLineup.length < spec.requiredLineupPlayers ||
      enc.awayLineup.length < spec.requiredLineupPlayers
    ) {
      return;
    }

    const existingRows = await db
      .prepare('SELECT * FROM team_match_submatches WHERE encounter_id = ? ORDER BY slot_index ASC')
      .bind(enc.encounterId)
      .all<Record<string, unknown>>();
    const existingBySlot = new Map<number, Record<string, unknown>>();
    for (const r of existingRows.results ?? []) {
      existingBySlot.set(Number(r.slot_index), r);
    }

    const now = Date.now();
    for (let slotIdx = 0; slotIdx < spec.boards; slotIdx++) {
      const assigned = resolveLineupBoardPlayers(
        enc.matchFormat,
        enc.homeLineup,
        enc.awayLineup,
        slotIdx,
      );
      const ex = existingBySlot.get(slotIdx);
      if (!ex) {
        const subId = `tsm_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
        await db
          .prepare(
            `INSERT INTO team_match_submatches (
              sub_match_id, competition_kind, competition_id, encounter_id, slot_index, board_label,
              home_team_id, away_team_id, home_player_id, away_player_id, status, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
          )
          .bind(
            subId,
            enc.competitionKind,
            enc.competitionId,
            enc.encounterId,
            slotIdx,
            assigned.label,
            enc.homeTeamId,
            enc.awayTeamId,
            assigned.home?.playerId ?? null,
            assigned.away?.playerId ?? null,
            now,
          )
          .run();
      } else if (ex.status === 'pending' || ex.status === 'ready') {
        await db
          .prepare(
            `UPDATE team_match_submatches
             SET home_player_id = ?, away_player_id = ?, status = 'ready'
             WHERE sub_match_id = ?`,
          )
          .bind(
            assigned.home?.playerId ?? null,
            assigned.away?.playerId ?? null,
            String(ex.sub_match_id),
          )
          .run();
      }
    }

    if (enc.status === 'scheduled') {
      const table =
        enc.competitionKind === 'league' ? 'team_league_fixtures' : 'club_championship_matches';
      const pkCol = enc.competitionKind === 'league' ? 'fixture_id' : 'match_node_id';
      await db
        .prepare(`UPDATE ${table} SET status = 'lineup_ready' WHERE ${pkCol} = ? AND status = 'scheduled'`)
        .bind(enc.encounterId)
        .run();
    }
  }

  public async prepareSubMatchForRoom(
    playerId: string,
    subMatchId: string,
  ): Promise<
    | {
        ok: true;
        subMatch: TeamSubMatchRecord;
        competitionTitle: string;
        ruleProfileId: RuleProfileId;
        calledShotsEnabled: boolean;
        homeTeam: { teamId: string; name: string; tag: string };
        awayTeam: { teamId: string; name: string; tag: string };
      }
    | ClubLeagueServiceError
  > {
    const db = await this.ensureSchema();
    const smRow = await db
      .prepare('SELECT * FROM team_match_submatches WHERE sub_match_id = ? LIMIT 1')
      .bind(subMatchId)
      .first<Record<string, unknown>>();
    if (!smRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Board sub-match not found.' };
    }
    if (smRow.status !== 'ready' && smRow.status !== 'in_progress' && smRow.status !== 'pending') {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'This board match is already finished or forfeited.',
      };
    }
    if (smRow.home_player_id !== playerId && smRow.away_player_id !== playerId) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'You are not assigned to play this team board.',
      };
    }

    const kind =
      smRow.competition_kind === 'club_championship' ? 'club_championship' : 'league';
    const enc = await this.loadEncounterMeta(
      db,
      kind,
      String(smRow.competition_id),
      String(smRow.encounter_id),
    );
    if (!enc) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Encounter metadata missing.' };
    }

    const [ht, at] = await Promise.all([
      db
        .prepare('SELECT team_id, name, tag FROM club_teams WHERE team_id = ? LIMIT 1')
        .bind(enc.homeTeamId)
        .first<{ team_id: string; name: string; tag: string }>(),
      db
        .prepare('SELECT team_id, name, tag FROM club_teams WHERE team_id = ? LIMIT 1')
        .bind(enc.awayTeamId)
        .first<{ team_id: string; name: string; tag: string }>(),
    ]);
    if (!ht || !at) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Competing team missing.' };
    }

    const subMap = await this.loadSubMatchesMap(db, [enc.encounterId]);
    const subMatch = subMap.get(enc.encounterId)!.find((s) => s.subMatchId === subMatchId)!;

    return {
      ok: true,
      subMatch,
      competitionTitle: enc.competitionTitle,
      ruleProfileId: enc.ruleProfileId,
      calledShotsEnabled: enc.calledShotsEnabled,
      homeTeam: { teamId: ht.team_id, name: ht.name, tag: ht.tag },
      awayTeam: { teamId: at.team_id, name: at.name, tag: at.tag },
    };
  }

  public async attachRoomToSubMatch(
    subMatchId: string,
    roomId: string,
    roomCode: string,
  ): Promise<void> {
    const db = await this.ensureSchema();
    await db
      .prepare('UPDATE team_match_submatches SET room_id = ?, room_code = ? WHERE sub_match_id = ?')
      .bind(roomId, roomCode, subMatchId)
      .run();
  }

  public async markSubMatchInProgress(subMatchId: string): Promise<{
    competitionKind: 'league' | 'club_championship';
    competitionId: string;
  } | null> {
    const db = await this.ensureSchema();
    const sm = await db
      .prepare('SELECT competition_kind, competition_id, encounter_id FROM team_match_submatches WHERE sub_match_id = ? LIMIT 1')
      .bind(subMatchId)
      .first<{ competition_kind: string; competition_id: string; encounter_id: string }>();
    if (!sm) return null;

    await db
      .prepare("UPDATE team_match_submatches SET status = 'in_progress' WHERE sub_match_id = ? AND status IN ('pending', 'ready')")
      .bind(subMatchId)
      .run();

    const kind = sm.competition_kind === 'club_championship' ? 'club_championship' : 'league';
    const table = kind === 'league' ? 'team_league_fixtures' : 'club_championship_matches';
    const pk = kind === 'league' ? 'fixture_id' : 'match_node_id';
    await db
      .prepare(`UPDATE ${table} SET status = 'in_progress' WHERE ${pk} = ? AND status IN ('scheduled', 'lineup_ready')`)
      .bind(sm.encounter_id)
      .run();

    return { competitionKind: kind, competitionId: sm.competition_id };
  }

  public async settleSubMatchResult(params: {
    subMatchId: string;
    matchId: string;
    winnerPlayerId: string;
    reason: string;
    nowMs?: number;
  }): Promise<
    | {
        ok: true;
        alreadyProcessed: boolean;
        competitionKind: 'league' | 'club_championship';
        competitionId: string;
        encounterCompleted: boolean;
        roomsToClose: string[];
      }
    | ClubLeagueServiceError
  > {
    const db = await this.ensureSchema();
    const now = params.nowMs ?? Date.now();
    const smRow = await db
      .prepare('SELECT * FROM team_match_submatches WHERE sub_match_id = ? LIMIT 1')
      .bind(params.subMatchId)
      .first<Record<string, unknown>>();
    if (!smRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Board sub-match not found.' };
    }

    const kind: 'league' | 'club_championship' =
      smRow.competition_kind === 'club_championship' ? 'club_championship' : 'league';
    const competitionId = String(smRow.competition_id);
    const encounterId = String(smRow.encounter_id);

    const ins = await db
      .prepare(
        `INSERT OR IGNORE INTO team_match_processed_results (sub_match_id, match_id, winner_player_id, processed_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(params.subMatchId, params.matchId, params.winnerPlayerId, now)
      .run();
    if ((ins.meta?.changes ?? 0) === 0) {
      return {
        ok: true,
        alreadyProcessed: true,
        competitionKind: kind,
        competitionId,
        encounterCompleted: false,
        roomsToClose: [],
      };
    }

    const homePlayerId = smRow.home_player_id ? String(smRow.home_player_id) : null;
    const awayPlayerId = smRow.away_player_id ? String(smRow.away_player_id) : null;
    const homeTeamId = String(smRow.home_team_id);
    const awayTeamId = String(smRow.away_team_id);

    const winnerIsHome = params.winnerPlayerId === homePlayerId;
    const winnerTeamId = winnerIsHome ? homeTeamId : awayTeamId;
    const loserPlayerId = winnerIsHome ? awayPlayerId : homePlayerId;
    const loserTeamId = winnerIsHome ? awayTeamId : homeTeamId;

    await db
      .prepare(
        `UPDATE team_match_submatches
         SET winner_team_id = ?, winner_player_id = ?, verified_match_id = ?,
             status = 'completed', completion_reason = ?, completed_at_ms = ?
         WHERE sub_match_id = ?`,
      )
      .bind(
        winnerTeamId,
        params.winnerPlayerId,
        params.matchId,
        params.reason,
        now,
        params.subMatchId,
      )
      .run();

    // Update individual player team roster stats
    await db
      .prepare(
        `UPDATE club_team_members
         SET matches_played = matches_played + 1, wins = wins + 1
         WHERE team_id = ? AND player_id = ?`,
      )
      .bind(winnerTeamId, params.winnerPlayerId)
      .run();
    if (loserPlayerId) {
      await db
        .prepare(
          `UPDATE club_team_members
           SET matches_played = matches_played + 1, losses = losses + 1
           WHERE team_id = ? AND player_id = ?`,
        )
        .bind(loserTeamId, loserPlayerId)
        .run();
    }

    // Recompute encounter score
    const allBoards = await db
      .prepare('SELECT * FROM team_match_submatches WHERE encounter_id = ? ORDER BY slot_index ASC')
      .bind(encounterId)
      .all<Record<string, unknown>>();
    const boards = allBoards.results ?? [];
    let homeScore = 0;
    let awayScore = 0;
    let unplayedCount = 0;
    const roomsToClose: string[] = [];

    for (const b of boards) {
      if (b.status === 'completed' || b.status === 'forfeited') {
        if (b.winner_team_id === homeTeamId) homeScore += 1;
        else if (b.winner_team_id === awayTeamId) awayScore += 1;
      } else {
        unplayedCount += 1;
      }
    }

    const enc = await this.loadEncounterMeta(db, kind, competitionId, encounterId);
    const targetWins = enc ? TEAM_MATCH_FORMAT_SPEC[enc.matchFormat].targetWins : 1;
    const table = kind === 'league' ? 'team_league_fixtures' : 'club_championship_matches';
    const pkCol = kind === 'league' ? 'fixture_id' : 'match_node_id';

    const seriesWinner =
      homeScore >= targetWins ? homeTeamId : awayScore >= targetWins ? awayTeamId : null;
    const encounterDone = Boolean(seriesWinner) || unplayedCount === 0;

    if (!encounterDone) {
      await db
        .prepare(`UPDATE ${table} SET home_score = ?, away_score = ?, status = 'in_progress' WHERE ${pkCol} = ?`)
        .bind(homeScore, awayScore, encounterId)
        .run();
      return {
        ok: true,
        alreadyProcessed: false,
        competitionKind: kind,
        competitionId,
        encounterCompleted: false,
        roomsToClose,
      };
    }

    // Series clinched — close remaining unplayed boards and award MVP to clinching player
    await db
      .prepare(
        `UPDATE club_team_members SET mvp_count = mvp_count + 1 WHERE team_id = ? AND player_id = ?`,
      )
      .bind(winnerTeamId, params.winnerPlayerId)
      .run();

    for (const b of boards) {
      if (b.status !== 'completed' && b.status !== 'forfeited') {
        if (b.room_id) roomsToClose.push(String(b.room_id));
        await db
          .prepare(
            `UPDATE team_match_submatches
             SET status = 'forfeited', completion_reason = 'Series already decided', completed_at_ms = ?
             WHERE sub_match_id = ?`,
          )
          .bind(now, String(b.sub_match_id))
          .run();
      }
    }

    const finalWinner =
      seriesWinner ?? (homeScore > awayScore ? homeTeamId : awayScore > homeScore ? awayTeamId : null);

    await this.finalizeEncounterOutcome(db, {
      competitionKind: kind,
      competitionId,
      encounterId,
      homeTeamId,
      awayTeamId,
      homeScore,
      awayScore,
      winnerTeamId: finalWinner,
      status: 'completed',
      resolutionNote: finalWinner ? 'Series completed' : 'Series drawn',
      nowMs: now,
    });

    return {
      ok: true,
      alreadyProcessed: false,
      competitionKind: kind,
      competitionId,
      encounterCompleted: true,
      roomsToClose,
    };
  }

  public async resolveEncounterWalkoverOrDq(
    actorId: string,
    params: {
      competitionKind: 'league' | 'club_championship';
      competitionId: string;
      encounterId: string;
      winnerTeamId: string;
      resolution: 'walkover' | 'disqualified';
      reason?: string;
    },
  ): Promise<{ ok: true; roomsToClose: string[] } | ClubLeagueServiceError> {
    const db = await this.ensureSchema();
    const now = Date.now();
    const enc = await this.loadEncounterMeta(
      db,
      params.competitionKind,
      params.competitionId,
      params.encounterId,
    );
    if (!enc) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Encounter not found.' };

    // Verify organizer permission
    const compTable =
      params.competitionKind === 'league' ? 'team_leagues' : 'club_championships';
    const compPk = params.competitionKind === 'league' ? 'league_id' : 'championship_id';
    const compRow = await db
      .prepare(`SELECT created_by_player_id FROM ${compTable} WHERE ${compPk} = ? LIMIT 1`)
      .bind(params.competitionId)
      .first<{ created_by_player_id: string | null }>();
    if (compRow?.created_by_player_id && compRow.created_by_player_id !== actorId) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only the competition organizer can declare a walkover or disqualification.',
      };
    }

    if (params.winnerTeamId !== enc.homeTeamId && params.winnerTeamId !== enc.awayTeamId) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid winnerTeamId.' };
    }
    if (
      enc.status === 'completed' ||
      enc.status === 'walkover' ||
      enc.status === 'disqualified' ||
      enc.status === 'bye'
    ) {
      return { ok: false, status: 409, code: 'CONFLICT', message: 'Encounter is already finalized.' };
    }

    const spec = TEAM_MATCH_FORMAT_SPEC[enc.matchFormat];
    const winnerIsHome = params.winnerTeamId === enc.homeTeamId;
    const loserTeamId = winnerIsHome ? enc.awayTeamId : enc.homeTeamId;

    const subRows = await db
      .prepare('SELECT room_id FROM team_match_submatches WHERE encounter_id = ? AND room_id IS NOT NULL')
      .bind(params.encounterId)
      .all<{ room_id: string }>();
    const roomsToClose = (subRows.results ?? []).map((r) => String(r.room_id));

    await db
      .prepare(
        `UPDATE team_match_submatches
         SET status = 'forfeited', completion_reason = ?, completed_at_ms = ?
         WHERE encounter_id = ? AND status NOT IN ('completed', 'forfeited')`,
      )
      .bind(params.reason ?? 'Encounter walkover/DQ', now, params.encounterId)
      .run();

    if (params.resolution === 'disqualified' && params.competitionKind === 'club_championship') {
      await db
        .prepare(
          'UPDATE club_championship_entries SET disqualified = 1, eliminated = 1 WHERE championship_id = ? AND team_id = ?',
        )
        .bind(params.competitionId, loserTeamId)
        .run();
    }

    await this.finalizeEncounterOutcome(db, {
      competitionKind: params.competitionKind,
      competitionId: params.competitionId,
      encounterId: params.encounterId,
      homeTeamId: enc.homeTeamId,
      awayTeamId: enc.awayTeamId,
      homeScore: winnerIsHome ? spec.targetWins : 0,
      awayScore: winnerIsHome ? 0 : spec.targetWins,
      winnerTeamId: params.winnerTeamId,
      status: params.resolution,
      resolutionNote:
        params.reason ??
        (params.resolution === 'disqualified' ? 'Opponent disqualified' : 'Walkover awarded'),
      nowMs: now,
    });

    return { ok: true, roomsToClose };
  }

  private async finalizeEncounterOutcome(
    db: ProgressionSqlDb,
    input: {
      competitionKind: 'league' | 'club_championship';
      competitionId: string;
      encounterId: string;
      homeTeamId: string;
      awayTeamId: string;
      homeScore: number;
      awayScore: number;
      winnerTeamId: string | null;
      status: TeamEncounterStatus;
      resolutionNote: string;
      nowMs: number;
    },
  ): Promise<void> {
    const isDraw = !input.winnerTeamId;
    const table =
      input.competitionKind === 'league' ? 'team_league_fixtures' : 'club_championship_matches';
    const pkCol = input.competitionKind === 'league' ? 'fixture_id' : 'match_node_id';

    if (input.competitionKind === 'league') {
      await db
        .prepare(
          `UPDATE ${table}
           SET home_score = ?, away_score = ?, winner_team_id = ?, is_draw = ?, status = ?, completed_at_ms = ?
           WHERE ${pkCol} = ?`,
        )
        .bind(
          input.homeScore,
          input.awayScore,
          input.winnerTeamId,
          isDraw ? 1 : 0,
          input.status,
          input.nowMs,
          input.encounterId,
        )
        .run();
    } else {
      await db
        .prepare(
          `UPDATE ${table}
           SET home_score = ?, away_score = ?, winner_team_id = ?, status = ?, resolution_note = ?, completed_at_ms = ?
           WHERE ${pkCol} = ?`,
        )
        .bind(
          input.homeScore,
          input.awayScore,
          input.winnerTeamId,
          input.status,
          input.resolutionNote,
          input.nowMs,
          input.encounterId,
        )
        .run();
    }

    // Update Team ELO + Career Totals + Club XP
    const [hTeam, aTeam] = await Promise.all([
      db.prepare('SELECT team_id, club_id, name, elo, peak_elo FROM club_teams WHERE team_id = ? LIMIT 1').bind(input.homeTeamId).first<{ team_id: string; club_id: string; name: string; elo: number; peak_elo: number }>(),
      db.prepare('SELECT team_id, club_id, name, elo, peak_elo FROM club_teams WHERE team_id = ? LIMIT 1').bind(input.awayTeamId).first<{ team_id: string; club_id: string; name: string; elo: number; peak_elo: number }>(),
    ]);

    if (hTeam && aTeam) {
      const scoreHome = isDraw ? 0.5 : input.winnerTeamId === hTeam.team_id ? 1 : 0;
      const eloRes = calculateTeamEloUpdate(Number(hTeam.elo), Number(aTeam.elo), scoreHome);
      const compRow = await db
        .prepare(
          input.competitionKind === 'league'
            ? 'SELECT title FROM team_leagues WHERE league_id = ? LIMIT 1'
            : 'SELECT title FROM club_championships WHERE championship_id = ? LIMIT 1',
        )
        .bind(input.competitionId)
        .first<{ title: string }>();
      const compTitle = compRow?.title ?? 'Team Competition';

      await db
        .prepare(
          `UPDATE club_teams
           SET elo = ?, peak_elo = MAX(peak_elo, ?),
               wins = wins + ?, losses = losses + ?, draws = draws + ?,
               matches_played = matches_played + 1, updated_at_ms = ?
           WHERE team_id = ?`,
        )
        .bind(
          eloRes.newA,
          eloRes.newA,
          scoreHome === 1 ? 1 : 0,
          scoreHome === 0 ? 1 : 0,
          scoreHome === 0.5 ? 1 : 0,
          input.nowMs,
          hTeam.team_id,
        )
        .run();
      await db
        .prepare(
          `UPDATE club_teams
           SET elo = ?, peak_elo = MAX(peak_elo, ?),
               wins = wins + ?, losses = losses + ?, draws = draws + ?,
               matches_played = matches_played + 1, updated_at_ms = ?
           WHERE team_id = ?`,
        )
        .bind(
          eloRes.newB,
          eloRes.newB,
          scoreHome === 0 ? 1 : 0,
          scoreHome === 1 ? 1 : 0,
          scoreHome === 0.5 ? 1 : 0,
          input.nowMs,
          aTeam.team_id,
        )
        .run();

      const hOutcome = scoreHome === 1 ? 'win' : scoreHome === 0 ? 'loss' : 'draw';
      const aOutcome = scoreHome === 0 ? 'win' : scoreHome === 1 ? 'loss' : 'draw';
      await db
        .prepare(
          `INSERT INTO team_elo_history (
            event_id, team_id, competition_kind, competition_id, competition_title,
            opponent_team_id, opponent_team_name, elo_before, elo_after, elo_delta, outcome, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `teh_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`,
          hTeam.team_id,
          input.competitionKind,
          input.competitionId,
          compTitle,
          aTeam.team_id,
          aTeam.name,
          hTeam.elo,
          eloRes.newA,
          eloRes.deltaA,
          hOutcome,
          input.nowMs,
        )
        .run();
      await db
        .prepare(
          `INSERT INTO team_elo_history (
            event_id, team_id, competition_kind, competition_id, competition_title,
            opponent_team_id, opponent_team_name, elo_before, elo_after, elo_delta, outcome, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `teh_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`,
          aTeam.team_id,
          input.competitionKind,
          input.competitionId,
          compTitle,
          hTeam.team_id,
          hTeam.name,
          aTeam.elo,
          eloRes.newB,
          eloRes.deltaB,
          aOutcome,
          input.nowMs,
        )
        .run();

      // Grant Club XP
      await this.clubService.awardClubXp({
        clubId: hTeam.club_id,
        xpAmount: scoreHome === 1 ? 50 : 20,
        eventType: 'team_match_completed',
        summary: `${hTeam.name} ${scoreHome === 1 ? 'defeated' : 'played'} ${aTeam.name} (${input.homeScore}-${input.awayScore}) in ${compTitle}.`,
      });
      if (aTeam.club_id !== hTeam.club_id) {
        await this.clubService.awardClubXp({
          clubId: aTeam.club_id,
          xpAmount: scoreHome === 0 ? 50 : 20,
          eventType: 'team_match_completed',
          summary: `${aTeam.name} ${scoreHome === 0 ? 'defeated' : 'played'} ${hTeam.name} (${input.awayScore}-${input.homeScore}) in ${compTitle}.`,
        });
      }
    }

    if (input.competitionKind === 'league') {
      await this.applyLeagueEncounterStanding(db, input);
    } else {
      await this.applyChampionshipEncounterProgression(db, input);
    }
  }

  private async applyLeagueEncounterStanding(
    db: ProgressionSqlDb,
    input: {
      competitionId: string;
      homeTeamId: string;
      awayTeamId: string;
      homeScore: number;
      awayScore: number;
      winnerTeamId: string | null;
      nowMs: number;
    },
  ): Promise<void> {
    const isDraw = !input.winnerTeamId;
    const hWin = input.winnerTeamId === input.homeTeamId;
    const diff = input.homeScore - input.awayScore;

    await db
      .prepare(
        `UPDATE team_league_entries
         SET played = played + 1,
             won = won + ?, drawn = drawn + ?, lost = lost + ?,
             match_wins = match_wins + ?, match_losses = match_losses + ?,
             frame_diff = frame_diff + ?,
             points = points + ?,
             streak = CASE WHEN ? = 1 THEN CASE WHEN streak >= 0 THEN streak + 1 ELSE 1 END
                           WHEN ? = 1 THEN 0
                           ELSE CASE WHEN streak <= 0 THEN streak - 1 ELSE -1 END END
         WHERE league_id = ? AND team_id = ?`,
      )
      .bind(
        hWin ? 1 : 0,
        isDraw ? 1 : 0,
        !isDraw && !hWin ? 1 : 0,
        input.homeScore,
        input.awayScore,
        diff,
        hWin ? 3 : isDraw ? 1 : 0,
        hWin ? 1 : 0,
        isDraw ? 1 : 0,
        input.competitionId,
        input.homeTeamId,
      )
      .run();

    await db
      .prepare(
        `UPDATE team_league_entries
         SET played = played + 1,
             won = won + ?, drawn = drawn + ?, lost = lost + ?,
             match_wins = match_wins + ?, match_losses = match_losses + ?,
             frame_diff = frame_diff + ?,
             points = points + ?,
             streak = CASE WHEN ? = 1 THEN CASE WHEN streak >= 0 THEN streak + 1 ELSE 1 END
                           WHEN ? = 1 THEN 0
                           ELSE CASE WHEN streak <= 0 THEN streak - 1 ELSE -1 END END
         WHERE league_id = ? AND team_id = ?`,
      )
      .bind(
        !isDraw && !hWin ? 1 : 0,
        isDraw ? 1 : 0,
        hWin ? 1 : 0,
        input.awayScore,
        input.homeScore,
        -diff,
        !isDraw && !hWin ? 3 : isDraw ? 1 : 0,
        !isDraw && !hWin ? 1 : 0,
        isDraw ? 1 : 0,
        input.competitionId,
        input.awayTeamId,
      )
      .run();

    const rem = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM team_league_fixtures
         WHERE league_id = ? AND status IN ('pending', 'scheduled', 'lineup_ready', 'in_progress')`,
      )
      .bind(input.competitionId)
      .first<{ c: number }>();

    if (Number(rem?.c ?? 0) === 0) {
      const detail = await this.getLeagueDetail(input.competitionId);
      if (!detail || detail.standings.length === 0) return;

      const champ = detail.standings[0];
      await db
        .prepare(
          `UPDATE team_leagues
           SET status = 'completed', champion_team_id = ?, champion_team_name = ?, completed_at_ms = ?, updated_at_ms = ?
           WHERE league_id = ?`,
        )
        .bind(champ.teamId, champ.teamName, input.nowMs, input.nowMs, input.competitionId)
        .run();

      for (const s of detail.standings) {
        const tag =
          s.zone === 'champion' || s.zone === 'promotion'
            ? 'promoted'
            : s.zone === 'relegation'
              ? 'relegated'
              : 'stayed';
        await db
          .prepare('UPDATE team_league_entries SET outcome_tag = ? WHERE league_id = ? AND team_id = ?')
          .bind(tag, input.competitionId, s.teamId)
          .run();
      }

      await db
        .prepare('UPDATE club_teams SET titles_count = titles_count + 1 WHERE team_id = ?')
        .bind(champ.teamId)
        .run();
      await db
        .prepare('UPDATE clubs SET league_titles = league_titles + 1 WHERE club_id = ?')
        .bind(champ.clubId)
        .run();

      await this.clubService.awardClubTrophy({
        clubId: champ.clubId,
        teamId: champ.teamId,
        teamName: champ.teamName,
        competitionKind: 'league',
        competitionId: input.competitionId,
        title: `${detail.league.title} Champion`,
        tier: 'champion',
        seasonLabel: detail.league.seasonLabel,
      });
      await this.clubService.awardClubXp({
        clubId: champ.clubId,
        xpAmount: 180,
        eventType: 'league_champion',
        summary: `Team [${champ.teamTag}] ${champ.teamName} won ${detail.league.title}!`,
      });
    }
  }

  private async applyChampionshipEncounterProgression(
    db: ProgressionSqlDb,
    input: {
      competitionId: string;
      encounterId: string;
      homeTeamId: string;
      awayTeamId: string;
      homeScore: number;
      awayScore: number;
      winnerTeamId: string | null;
      nowMs: number;
    },
  ): Promise<void> {
    const node = await db
      .prepare('SELECT * FROM club_championship_matches WHERE match_node_id = ? LIMIT 1')
      .bind(input.encounterId)
      .first<Record<string, unknown>>();
    const cRow = await db
      .prepare('SELECT * FROM club_championships WHERE championship_id = ? LIMIT 1')
      .bind(input.competitionId)
      .first<Record<string, unknown>>();
    if (!node || !cRow) return;

    const winnerId = input.winnerTeamId ?? input.homeTeamId;
    const loserId = winnerId === input.homeTeamId ? input.awayTeamId : input.homeTeamId;
    const winFrames = winnerId === input.homeTeamId ? input.homeScore : input.awayScore;
    const loseFrames = winnerId === input.homeTeamId ? input.awayScore : input.homeScore;
    const diff = winFrames - loseFrames;

    await db
      .prepare(
        `UPDATE club_championship_entries
         SET wins = wins + 1, points = points + 3, frame_diff = frame_diff + ?
         WHERE championship_id = ? AND team_id = ?`,
      )
      .bind(diff, input.competitionId, winnerId)
      .run();
    await db
      .prepare(
        `UPDATE club_championship_entries
         SET losses = losses + 1, frame_diff = frame_diff - ?
         WHERE championship_id = ? AND team_id = ?`,
      )
      .bind(diff, input.competitionId, loserId)
      .run();

    // Knockout routing
    if (node.next_winner_node_id && node.next_winner_slot) {
      const col = node.next_winner_slot === 'home' ? 'home_team_id' : 'away_team_id';
      await db
        .prepare(`UPDATE club_championship_matches SET ${col} = ? WHERE match_node_id = ?`)
        .bind(winnerId, String(node.next_winner_node_id))
        .run();
    }
    if (node.next_loser_node_id && node.next_loser_slot) {
      const col = node.next_loser_slot === 'home' ? 'home_team_id' : 'away_team_id';
      await db
        .prepare(`UPDATE club_championship_matches SET ${col} = ? WHERE match_node_id = ?`)
        .bind(loserId, String(node.next_loser_node_id))
        .run();
    } else if (
      node.stage_type === 'knockout' ||
      node.stage_type === 'losers' ||
      node.stage_type === 'grand_final'
    ) {
      await db
        .prepare('UPDATE club_championship_entries SET eliminated = 1 WHERE championship_id = ? AND team_id = ?')
        .bind(input.competitionId, loserId)
        .run();
    }

    await this.propagateBracketByes(db, input.competitionId, input.nowMs);

    const stage = String(cRow.stage);
    const format = String(cRow.format);

    if (format === 'group_knockout' && stage === 'groups') {
      const remGroup = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM club_championship_matches
           WHERE championship_id = ? AND stage_type = 'group'
             AND status IN ('pending', 'scheduled', 'lineup_ready', 'in_progress')`,
        )
        .bind(input.competitionId)
        .first<{ c: number }>();
      if (Number(remGroup?.c ?? 0) === 0) {
        const groupAdv = Math.max(1, Number(cRow.group_advance_count ?? 2));
        const eRows = await db
          .prepare(
            `SELECT team_id, group_index, points, frame_diff, wins, team_elo_at_entry
             FROM club_championship_entries
             WHERE championship_id = ? AND disqualified = 0
             ORDER BY group_index ASC, points DESC, frame_diff DESC, wins DESC, team_elo_at_entry DESC`,
          )
          .bind(input.competitionId)
          .all<Record<string, unknown>>();
        const byGroup = new Map<number, string[]>();
        for (const e of eRows.results ?? []) {
          const g = Number(e.group_index ?? 1);
          const list = byGroup.get(g) ?? [];
          if (list.length < groupAdv) {
            list.push(String(e.team_id));
            byGroup.set(g, list);
          } else {
            await db
              .prepare('UPDATE club_championship_entries SET eliminated = 1 WHERE championship_id = ? AND team_id = ?')
              .bind(input.competitionId, String(e.team_id))
              .run();
          }
        }
        const qualifiers: string[] = [];
        for (const [, list] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
          qualifiers.push(...list);
        }
        if (qualifiers.length >= 2) {
          const koRounds = await this.buildSingleEliminationNodes(
            db,
            input.competitionId,
            qualifiers,
            'knockout',
            input.nowMs,
          );
          await db
            .prepare(
              `UPDATE club_championships SET stage = 'knockout', current_round = 1, total_rounds = ?, updated_at_ms = ? WHERE championship_id = ?`,
            )
            .bind(koRounds, input.nowMs, input.competitionId)
            .run();
          await this.propagateBracketByes(db, input.competitionId, input.nowMs);
        }
      }
      return;
    }

    if (format === 'swiss' && stage === 'swiss') {
      // Recompute Buchholz scores
      const allEntries = await db
        .prepare('SELECT team_id, points FROM club_championship_entries WHERE championship_id = ?')
        .bind(input.competitionId)
        .all<{ team_id: string; points: number }>();
      const ptsByTeam = new Map<string, number>();
      for (const e of allEntries.results ?? []) {
        ptsByTeam.set(String(e.team_id), Number(e.points ?? 0));
      }
      const swissMatches = await db
        .prepare(
          `SELECT home_team_id, away_team_id FROM club_championship_matches
           WHERE championship_id = ? AND stage_type = 'swiss' AND status IN ('completed', 'walkover', 'disqualified')`,
        )
        .bind(input.competitionId)
        .all<{ home_team_id: string | null; away_team_id: string | null }>();
      const buchholzMap = new Map<string, number>();
      for (const sm of swissMatches.results ?? []) {
        if (sm.home_team_id && sm.away_team_id) {
          buchholzMap.set(
            sm.home_team_id,
            (buchholzMap.get(sm.home_team_id) ?? 0) + (ptsByTeam.get(sm.away_team_id) ?? 0),
          );
          buchholzMap.set(
            sm.away_team_id,
            (buchholzMap.get(sm.away_team_id) ?? 0) + (ptsByTeam.get(sm.home_team_id) ?? 0),
          );
        }
      }
      for (const [tid, bh] of buchholzMap.entries()) {
        await db
          .prepare('UPDATE club_championship_entries SET buchholz = ? WHERE championship_id = ? AND team_id = ?')
          .bind(bh, input.competitionId, tid)
          .run();
      }

      const remSwiss = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM club_championship_matches
           WHERE championship_id = ? AND stage_type = 'swiss'
             AND status IN ('pending', 'scheduled', 'lineup_ready', 'in_progress')`,
        )
        .bind(input.competitionId)
        .first<{ c: number }>();

      if (Number(remSwiss?.c ?? 0) === 0) {
        const curRound = Number(cRow.current_round ?? 1);
        const totalSwiss = Number(cRow.swiss_rounds ?? 3);
        if (curRound < totalSwiss) {
          const nextRound = curRound + 1;
          await this.generateNextSwissRound(db, input.competitionId, nextRound, input.nowMs);
          await db
            .prepare('UPDATE club_championships SET current_round = ?, updated_at_ms = ? WHERE championship_id = ?')
            .bind(nextRound, input.nowMs, input.competitionId)
            .run();
        } else {
          const ranked = await db
            .prepare(
              `SELECT team_id FROM club_championship_entries
               WHERE championship_id = ? AND disqualified = 0
               ORDER BY points DESC, buchholz DESC, frame_diff DESC, wins DESC, team_elo_at_entry DESC`,
            )
            .bind(input.competitionId)
            .all<{ team_id: string }>();
          const rList = ranked.results ?? [];
          for (let i = 0; i < rList.length; i++) {
            await db
              .prepare('UPDATE club_championship_entries SET placement = ? WHERE championship_id = ? AND team_id = ?')
              .bind(i + 1, input.competitionId, String(rList[i].team_id))
              .run();
          }
          if (rList.length > 0) {
            await this.finalizeChampionshipAwards(
              db,
              input.competitionId,
              String(rList[0].team_id),
              rList[1] ? String(rList[1].team_id) : null,
              input.nowMs,
            );
          }
        }
      }
      return;
    }

    // Single / Double Elimination completion check
    const remKo = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM club_championship_matches
         WHERE championship_id = ? AND status IN ('pending', 'scheduled', 'lineup_ready', 'in_progress')`,
      )
      .bind(input.competitionId)
      .first<{ c: number }>();

    if (Number(remKo?.c ?? 0) === 0 && !node.next_winner_node_id) {
      await db
        .prepare('UPDATE club_championship_entries SET placement = 1 WHERE championship_id = ? AND team_id = ?')
        .bind(input.competitionId, winnerId)
        .run();
      await db
        .prepare('UPDATE club_championship_entries SET placement = 2 WHERE championship_id = ? AND team_id = ?')
        .bind(input.competitionId, loserId)
        .run();
      await this.finalizeChampionshipAwards(db, input.competitionId, winnerId, loserId, input.nowMs);
    }
  }

  private async finalizeChampionshipAwards(
    db: ProgressionSqlDb,
    championshipId: string,
    championTeamId: string,
    runnerUpTeamId: string | null,
    nowMs: number,
  ): Promise<void> {
    const cRow = await db
      .prepare('SELECT * FROM club_championships WHERE championship_id = ? LIMIT 1')
      .bind(championshipId)
      .first<Record<string, unknown>>();
    if (!cRow || cRow.status === 'completed') return;

    const champTeam = await db
      .prepare(
        `SELECT t.team_id, t.name, t.tag, t.club_id, c.name AS club_name
         FROM club_teams t JOIN clubs c ON c.club_id = t.club_id
         WHERE t.team_id = ? LIMIT 1`,
      )
      .bind(championTeamId)
      .first<{ team_id: string; name: string; tag: string; club_id: string; club_name: string }>();

    const runnerTeam = runnerUpTeamId
      ? await db
          .prepare('SELECT team_id, name, tag, club_id FROM club_teams WHERE team_id = ? LIMIT 1')
          .bind(runnerUpTeamId)
          .first<{ team_id: string; name: string; tag: string; club_id: string }>()
      : null;

    if (!champTeam) return;

    await db
      .prepare(
        `UPDATE club_championships
         SET status = 'completed', stage = 'completed',
             champion_team_id = ?, champion_team_name = ?, champion_club_id = ?, champion_club_name = ?,
             runner_up_team_id = ?, runner_up_team_name = ?, completed_at_ms = ?, updated_at_ms = ?
         WHERE championship_id = ?`,
      )
      .bind(
        champTeam.team_id,
        champTeam.name,
        champTeam.club_id,
        champTeam.club_name,
        runnerTeam?.team_id ?? null,
        runnerTeam?.name ?? null,
        nowMs,
        nowMs,
        championshipId,
      )
      .run();

    await db
      .prepare('UPDATE club_teams SET titles_count = titles_count + 1 WHERE team_id = ?')
      .bind(champTeam.team_id)
      .run();
    await db
      .prepare('UPDATE clubs SET championship_titles = championship_titles + 1 WHERE club_id = ?')
      .bind(champTeam.club_id)
      .run();

    const champTitle = String(cRow.title);
    const seasonLabel = String(cRow.season_label ?? 'Season 1');

    await this.clubService.awardClubTrophy({
      clubId: champTeam.club_id,
      teamId: champTeam.team_id,
      teamName: champTeam.name,
      competitionKind: 'club_championship',
      competitionId: championshipId,
      title: `${champTitle} Champion`,
      tier: 'champion',
      seasonLabel,
    });
    await this.clubService.awardClubXp({
      clubId: champTeam.club_id,
      xpAmount: 250,
      eventType: 'championship_won',
      summary: `Team [${champTeam.tag}] ${champTeam.name} captured ${champTitle}!`,
    });

    if (runnerTeam) {
      await this.clubService.awardClubTrophy({
        clubId: runnerTeam.club_id,
        teamId: runnerTeam.team_id,
        teamName: runnerTeam.name,
        competitionKind: 'club_championship',
        competitionId: championshipId,
        title: `${champTitle} Finalist`,
        tier: 'runner_up',
        seasonLabel,
      });
    }

    const totalPrize = Math.max(0, Number(cRow.prize_coins_champion ?? 0));
    if (totalPrize > 0) {
      const roster = await db
        .prepare('SELECT player_id FROM club_team_members WHERE team_id = ?')
        .bind(champTeam.team_id)
        .all<{ player_id: string }>();
      const players = (roster.results ?? []).map((p) => String(p.player_id));
      const perPlayer = players.length > 0 ? Math.max(50, Math.floor(totalPrize / players.length)) : 0;
      for (const pid of players) {
        await this.economy.awardCustomTournamentCoins({
          tournamentId: `cchamp:${championshipId}`,
          tournamentTitle: champTitle,
          playerId: pid,
          placement: 'champion',
          amount: perPlayer,
          awardedAtMs: nowMs,
        });
      }
    }
  }

  // ===== Rankings, Seasonal ELO Soft Reset & Automated Deadline Checks =====

  public async getTeamRankings(opts?: {
    region?: string | null;
    limit?: number;
  }): Promise<TeamEloRankingsPayload> {
    const db = await this.ensureSchema();
    const region = opts?.region && opts.region !== 'ALL' ? sanitizeRegion(opts.region) : 'ALL';
    const limit = Math.max(5, Math.min(100, Math.floor(Number(opts?.limit ?? 30) || 30)));

    const where = region !== 'ALL' ? "WHERE t.status = 'active' AND t.region = ?" : "WHERE t.status = 'active'";
    const rows = await db
      .prepare(
        `SELECT t.*, c.name AS club_name, c.tag AS club_tag, COUNT(m.player_id) AS roster_count
         FROM club_teams t
         JOIN clubs c ON c.club_id = t.club_id
         LEFT JOIN club_team_members m ON m.team_id = t.team_id
         ${where}
         GROUP BY t.team_id
         ORDER BY t.elo DESC, t.titles_count DESC, t.wins DESC, t.name ASC
         LIMIT ?`,
      )
      .bind(...(region !== 'ALL' ? [region, limit] : [limit]))
      .all<Record<string, unknown>>();

    const teams: TeamLeaderboardEntry[] = (rows.results ?? []).map((r, idx) => ({
      rank: idx + 1,
      teamId: String(r.team_id),
      clubId: String(r.club_id),
      clubName: String(r.club_name),
      clubTag: String(r.club_tag),
      name: String(r.name),
      tag: String(r.tag),
      badgeColor: String(r.badge_color ?? '#f59e0b'),
      badgeIcon: sanitizeBadgeIcon(r.badge_icon),
      region: String(r.region ?? 'GLOBAL'),
      elo: Number(r.elo ?? 1200),
      peakElo: Number(r.peak_elo ?? 1200),
      wins: Number(r.wins ?? 0),
      losses: Number(r.losses ?? 0),
      draws: Number(r.draws ?? 0),
      matchesPlayed: Number(r.matches_played ?? 0),
      titlesCount: Number(r.titles_count ?? 0),
      rosterCount: Number(r.roster_count ?? 0),
    }));

    const trophyRows = await db
      .prepare(
        `SELECT tr.*, c.tag AS club_tag
         FROM club_trophies tr
         JOIN clubs c ON c.club_id = tr.club_id
         ORDER BY tr.awarded_at_ms DESC LIMIT 25`,
      )
      .all<Record<string, unknown>>();

    const trophies: ClubTrophyRecord[] = (trophyRows.results ?? []).map((r) => ({
      trophyId: String(r.trophy_id),
      clubId: String(r.club_id),
      teamId: r.team_id ? String(r.team_id) : null,
      teamName: r.team_name ? String(r.team_name) : null,
      competitionKind:
        r.competition_kind === 'club_championship'
          ? 'club_championship'
          : r.competition_kind === 'challenge'
            ? 'challenge'
            : 'league',
      competitionId: String(r.competition_id),
      title: String(r.title),
      tier:
        r.tier === 'runner_up' || r.tier === 'promoted' || r.tier === 'milestone'
          ? r.tier
          : 'champion',
      seasonLabel: String(r.season_label ?? 'Season 1'),
      awardedAtMs: Number(r.awarded_at_ms),
    }));

    return { region, teams, trophies };
  }

  public async getEarliestDueTimestampMs(): Promise<number | null> {
    const db = await this.ensureSchema();
    const [lDue, cDue] = await Promise.all([
      db
        .prepare(
          `SELECT MIN(deadline_at_ms) AS d FROM team_league_fixtures
           WHERE status IN ('scheduled', 'lineup_ready') AND deadline_at_ms IS NOT NULL`,
        )
        .first<{ d: number | null }>(),
      db
        .prepare(
          `SELECT MIN(deadline_at_ms) AS d FROM club_championship_matches
           WHERE status IN ('scheduled', 'lineup_ready') AND deadline_at_ms IS NOT NULL`,
        )
        .first<{ d: number | null }>(),
    ]);
    const vals = [lDue?.d, cDue?.d].filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    );
    return vals.length > 0 ? Math.min(...vals) : null;
  }

  public async processDueDeadlines(nowMs = Date.now()): Promise<{
    resolvedEncounters: number;
    roomsToClose: string[];
  }> {
    const db = await this.ensureSchema();
    const roomsToClose: string[] = [];
    let resolvedEncounters = 0;

    // Resolve overdue unplayed league fixtures where one team submitted lineup or higher seed advances
    const dueLeague = await db
      .prepare(
        `SELECT * FROM team_league_fixtures
         WHERE status IN ('scheduled', 'lineup_ready')
           AND deadline_at_ms IS NOT NULL AND deadline_at_ms <= ?
         LIMIT 10`,
      )
      .bind(nowMs)
      .all<Record<string, unknown>>();

    for (const f of dueLeague.results ?? []) {
      const hLineup = parseLineupJson(f.home_lineup_json);
      const aLineup = parseLineupJson(f.away_lineup_json);
      let winnerId: string | null = null;
      if (hLineup.length > aLineup.length) winnerId = String(f.home_team_id);
      else if (aLineup.length > hLineup.length) winnerId = String(f.away_team_id);
      await this.finalizeEncounterOutcome(db, {
        competitionKind: 'league',
        competitionId: String(f.league_id),
        encounterId: String(f.fixture_id),
        homeTeamId: String(f.home_team_id),
        awayTeamId: String(f.away_team_id),
        homeScore: winnerId === f.home_team_id ? 1 : 0,
        awayScore: winnerId === f.away_team_id ? 1 : 0,
        winnerTeamId: winnerId,
        status: 'walkover',
        resolutionNote: 'Match deadline expired',
        nowMs,
      });
      resolvedEncounters += 1;
    }

    const dueChamp = await db
      .prepare(
        `SELECT * FROM club_championship_matches
         WHERE status IN ('scheduled', 'lineup_ready')
           AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
           AND deadline_at_ms IS NOT NULL AND deadline_at_ms <= ?
         LIMIT 10`,
      )
      .bind(nowMs)
      .all<Record<string, unknown>>();

    for (const m of dueChamp.results ?? []) {
      const hLineup = parseLineupJson(m.home_lineup_json);
      const aLineup = parseLineupJson(m.away_lineup_json);
      const winnerId =
        aLineup.length > hLineup.length ? String(m.away_team_id) : String(m.home_team_id);
      await this.finalizeEncounterOutcome(db, {
        competitionKind: 'club_championship',
        competitionId: String(m.championship_id),
        encounterId: String(m.match_node_id),
        homeTeamId: String(m.home_team_id),
        awayTeamId: String(m.away_team_id),
        homeScore: winnerId === m.home_team_id ? 1 : 0,
        awayScore: winnerId === m.away_team_id ? 1 : 0,
        winnerTeamId: winnerId,
        status: 'walkover',
        resolutionNote: 'Match deadline expired — walkover awarded',
        nowMs,
      });
      resolvedEncounters += 1;
    }

    return { resolvedEncounters, roomsToClose };
  }
}
