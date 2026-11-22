import type { RuleProfileId } from '../../src/game/rules/types';
import { isValidPlayerIdFormat, sanitizeAvatarId } from '../../src/multiplayer/shared/authCrypto';
import type { MultiplayerErrorCode } from '../../src/multiplayer/shared/protocol';
import {
  calculateClubLevelFromXp,
  CLUB_ROLE_RANK,
  isClubOfficerRole,
  normalizeClubRole,
  sanitizeChatText,
  sanitizeClubText,
  SOCIAL_LIMITS,
  type ClubActivityRecord,
  type ClubChallengeRecord,
  type ClubChallengeStatus,
  type ClubChatMessageRecord,
  type ClubDetailPayload,
  type ClubEmblemIcon,
  type ClubInvitationRecord,
  type ClubJoinMode,
  type ClubJoinRequestRecord,
  type ClubLeaderboardEntry,
  type ClubLeaderboardScope,
  type ClubMemberRecord,
  type ClubRecord,
  type ClubRole,
  type ClubTrophyRecord,
  type PlayerClubBadgeSummary,
  type PresenceStatus,
} from '../../src/multiplayer/shared/social';
import { D1ProgressionService, type ProgressionSqlDb } from './D1ProgressionService';
import { SocialService } from './SocialService';

export type ClubServiceError = {
  ok: false;
  status: number;
  code: MultiplayerErrorCode;
  message: string;
};

const CLUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,26}[A-Za-z0-9]$/;
const CLUB_TAG_PATTERN = /^[A-Za-z0-9]{2,5}$/;
const EMBLEM_COLORS = new Set([
  '#f59e0b',
  '#10b981',
  '#38bdf8',
  '#f43f5e',
  '#a78bfa',
  '#fb923c',
  '#eab308',
  '#14b8a6',
]);
const EMBLEM_ICONS = new Set<ClubEmblemIcon>([
  'shield',
  'crown',
  'flame',
  'star',
  'swords',
  'target',
]);

const CLUB_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS clubs (
    club_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_lower TEXT UNIQUE NOT NULL,
    tag TEXT NOT NULL,
    tag_lower TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    emblem_color TEXT NOT NULL DEFAULT '#f59e0b',
    emblem_icon TEXT NOT NULL DEFAULT 'shield',
    join_mode TEXT NOT NULL DEFAULT 'public',
    owner_id TEXT NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 1,
    challenge_wins INTEGER NOT NULL DEFAULT 0,
    club_rating INTEGER NOT NULL DEFAULT 1200,
    region TEXT NOT NULL DEFAULT 'GLOBAL',
    max_members INTEGER NOT NULL DEFAULT 50,
    level INTEGER NOT NULL DEFAULT 1,
    xp INTEGER NOT NULL DEFAULT 0,
    announcement TEXT NOT NULL DEFAULT '',
    announcement_updated_at_ms INTEGER,
    league_titles INTEGER NOT NULL DEFAULT 0,
    championship_titles INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS club_members (
    club_id TEXT NOT NULL,
    player_id TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (club_id, player_id)
  )`,
  `CREATE TABLE IF NOT EXISTS club_join_requests (
    request_id TEXT PRIMARY KEY,
    club_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at_ms INTEGER NOT NULL,
    responded_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS club_invitations (
    invite_id TEXT PRIMARY KEY,
    club_id TEXT NOT NULL,
    inviter_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    responded_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS club_challenges (
    challenge_id TEXT PRIMARY KEY,
    challenger_club_id TEXT NOT NULL,
    target_club_id TEXT NOT NULL,
    created_by_player_id TEXT NOT NULL,
    rule_profile_id TEXT NOT NULL DEFAULT 'casual',
    called_shots_enabled INTEGER NOT NULL DEFAULT 0,
    target_wins INTEGER NOT NULL DEFAULT 3,
    challenger_score INTEGER NOT NULL DEFAULT 0,
    target_score INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    winner_club_id TEXT,
    active_room_id TEXT,
    active_room_code TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    responded_at_ms INTEGER,
    completed_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS club_challenge_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_id TEXT NOT NULL,
    match_id TEXT UNIQUE NOT NULL,
    winner_club_id TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS club_activity_logs (
    activity_id TEXT PRIMARY KEY,
    club_id TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS club_chat_messages (
    message_id TEXT PRIMARY KEY,
    club_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    sender_avatar TEXT NOT NULL,
    sender_role TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS club_trophies (
    trophy_id TEXT PRIMARY KEY,
    club_id TEXT NOT NULL,
    team_id TEXT,
    team_name TEXT,
    competition_kind TEXT NOT NULL,
    competition_id TEXT NOT NULL,
    title TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'champion',
    season_label TEXT NOT NULL DEFAULT 'Season 1',
    awarded_at_ms INTEGER NOT NULL,
    UNIQUE(club_id, competition_kind, competition_id, tier)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_club_members_club ON club_members (club_id, role, joined_at_ms ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_club_members_player ON club_members (player_id)`,
  `CREATE INDEX IF NOT EXISTS idx_club_req_club ON club_join_requests (club_id, status, created_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_club_req_player ON club_join_requests (player_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_club_inv_rec ON club_invitations (recipient_id, status, expires_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_club_chal_clubs ON club_challenges (challenger_club_id, target_club_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_club_chal_status ON club_challenges (status, expires_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_club_activity_club ON club_activity_logs (club_id, created_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_club_chat_club ON club_chat_messages (club_id, created_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_club_trophies_club ON club_trophies (club_id, awarded_at_ms DESC)`,
];

const CLUB_ALTER_STATEMENTS = [
  `ALTER TABLE clubs ADD COLUMN region TEXT NOT NULL DEFAULT 'GLOBAL'`,
  `ALTER TABLE clubs ADD COLUMN max_members INTEGER NOT NULL DEFAULT 50`,
  `ALTER TABLE clubs ADD COLUMN level INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE clubs ADD COLUMN xp INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE clubs ADD COLUMN announcement TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE clubs ADD COLUMN announcement_updated_at_ms INTEGER`,
  `ALTER TABLE clubs ADD COLUMN league_titles INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE clubs ADD COLUMN championship_titles INTEGER NOT NULL DEFAULT 0`,
];

function sanitizeColor(raw: unknown): string {
  if (typeof raw === 'string' && EMBLEM_COLORS.has(raw.trim().toLowerCase())) {
    return raw.trim().toLowerCase();
  }
  return '#f59e0b';
}

function sanitizeIcon(raw: unknown): ClubEmblemIcon {
  if (typeof raw === 'string' && EMBLEM_ICONS.has(raw as ClubEmblemIcon)) {
    return raw as ClubEmblemIcon;
  }
  return 'shield';
}

function sanitizeJoinMode(raw: unknown): ClubJoinMode {
  return raw === 'approval' ? 'approval' : 'public';
}

function sanitizeRegion(raw: unknown): string {
  if (typeof raw !== 'string') return 'GLOBAL';
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 10);
  return cleaned || 'GLOBAL';
}

function sanitizeMaxMembers(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return SOCIAL_LIMITS.defaultClubCapacity;
  return Math.max(
    SOCIAL_LIMITS.minClubCapacity,
    Math.min(SOCIAL_LIMITS.maxClubMembers, Math.floor(num)),
  );
}

function sanitizeRole(raw: unknown): ClubRole {
  return normalizeClubRole(raw);
}

export class ClubService {
  private static readonly bootstrappedDbs = new WeakSet<object>();
  private static readonly clubChatCooldowns = new Map<string, number>();

  constructor(private readonly db: ProgressionSqlDb | D1Database | undefined) {}

  public async ensureSchema(): Promise<ProgressionSqlDb> {
    if (!this.db) {
      throw new Error('Club database is not configured.');
    }
    const db = this.db as unknown as ProgressionSqlDb;
    if (!ClubService.bootstrappedDbs.has(this.db)) {
      await new D1ProgressionService(this.db).searchPlayers('', 1);
      await new SocialService(this.db).ensureSchema();
      for (const stmt of CLUB_SCHEMA_STATEMENTS) {
        await db.prepare(stmt).run();
      }
      for (const stmt of CLUB_ALTER_STATEMENTS) {
        try {
          await db.prepare(stmt).run();
        } catch {
          // Column already exists
        }
      }
      ClubService.bootstrappedDbs.add(this.db);
    }
    return db;
  }

  private async getPlayerRow(db: ProgressionSqlDb, playerId: string) {
    if (!isValidPlayerIdFormat(playerId)) return null;
    return db
      .prepare(
        'SELECT player_id, username, display_name, avatar_id, elo, level, wins, total_matches FROM players WHERE player_id = ? LIMIT 1',
      )
      .bind(playerId.trim())
      .first<Record<string, unknown>>();
  }

  private async logActivity(
    db: ProgressionSqlDb,
    clubId: string,
    actorId: string | null,
    actorName: string | null,
    eventType: string,
    summary: string,
    now = Date.now(),
  ): Promise<void> {
    const activityId = `cact_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    await db
      .prepare(
        `INSERT INTO club_activity_logs (
          activity_id, club_id, actor_id, actor_name, event_type, summary, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(activityId, clubId, actorId, actorName, eventType, sanitizeClubText(summary, 220), now)
      .run();

    await db
      .prepare(
        `DELETE FROM club_activity_logs
         WHERE club_id = ?
           AND activity_id NOT IN (
             SELECT activity_id FROM club_activity_logs
             WHERE club_id = ?
             ORDER BY created_at_ms DESC
             LIMIT 40
           )`,
      )
      .bind(clubId, clubId)
      .run();
  }

  private async recomputeClubAggregates(db: ProgressionSqlDb, clubId: string): Promise<void> {
    const agg = await db
      .prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(AVG(p.elo), 1200) AS avg_elo
         FROM club_members cm
         JOIN players p ON p.player_id = cm.player_id
         WHERE cm.club_id = ?`,
      )
      .bind(clubId)
      .first<{ cnt: number; avg_elo: number }>();

    const chalRow = await db
      .prepare(
        `SELECT COUNT(*) AS cw FROM club_challenges
         WHERE winner_club_id = ? AND status = 'completed'`,
      )
      .bind(clubId)
      .first<{ cw: number }>();

    const memberCount = Number(agg?.cnt ?? 0);
    const challengeWins = Number(chalRow?.cw ?? 0);
    const clubRating = Math.round(Number(agg?.avg_elo ?? 1200) + challengeWins * 15);

    await db
      .prepare(
        `UPDATE clubs
         SET member_count = ?, challenge_wins = ?, club_rating = ?, updated_at_ms = ?
         WHERE club_id = ?`,
      )
      .bind(memberCount, challengeWins, clubRating, Date.now(), clubId)
      .run();
  }

  private async hydrateClubRecord(db: ProgressionSqlDb, row: Record<string, unknown>): Promise<ClubRecord> {
    const clubId = String(row.club_id);
    const now = Date.now();
    const weekCutoff = now - 7 * 86400_000;

    const totals = await db
      .prepare(
        `SELECT COUNT(*) AS member_count,
                COALESCE(SUM(p.wins), 0) AS total_wins,
                COALESCE(SUM(p.total_matches), 0) AS total_matches
         FROM club_members cm
         JOIN players p ON p.player_id = cm.player_id
         WHERE cm.club_id = ?`,
      )
      .bind(clubId)
      .first<{ member_count: number; total_wins: number; total_matches: number }>();

    const weekly = await db
      .prepare(
        `SELECT COALESCE(SUM(re.won), 0) AS ww
         FROM club_members cm
         JOIN rating_events re ON re.player_id = cm.player_id AND re.created_at_ms >= ?
         WHERE cm.club_id = ?`,
      )
      .bind(weekCutoff, clubId)
      .first<{ ww: number }>();

    let seasonalWins = 0;
    try {
      const seasonRow = await db
        .prepare(
          `SELECT COALESCE(SUM(sps.wins), 0) AS sw
           FROM club_members cm
           JOIN season_player_standings sps ON sps.player_id = cm.player_id
           JOIN competitive_seasons cs ON cs.season_id = sps.season_id AND cs.status = 'active'
           WHERE cm.club_id = ?`,
        )
        .bind(clubId)
        .first<{ sw: number }>();
      seasonalWins = Number(seasonRow?.sw ?? 0);
    } catch {
      seasonalWins = 0;
    }

    const xpCalc = calculateClubLevelFromXp(Number(row.xp ?? 0));
    const maxMembers = sanitizeMaxMembers(row.max_members ?? SOCIAL_LIMITS.defaultClubCapacity);

    return {
      clubId,
      name: String(row.name),
      tag: String(row.tag),
      description: String(row.description ?? ''),
      emblemColor: sanitizeColor(row.emblem_color),
      emblemIcon: sanitizeIcon(row.emblem_icon),
      joinMode: sanitizeJoinMode(row.join_mode),
      ownerId: String(row.owner_id),
      region: sanitizeRegion(row.region),
      maxMembers,
      level: xpCalc.level,
      xp: xpCalc.xp,
      xpIntoLevel: xpCalc.xpIntoLevel,
      xpForNextLevel: xpCalc.xpForNextLevel,
      announcement: String(row.announcement ?? ''),
      announcementUpdatedAtMs:
        row.announcement_updated_at_ms !== null && row.announcement_updated_at_ms !== undefined
          ? Number(row.announcement_updated_at_ms)
          : null,
      leagueTitles: Number(row.league_titles ?? 0),
      championshipTitles: Number(row.championship_titles ?? 0),
      memberCount: Number(totals?.member_count ?? row.member_count ?? 0),
      totalWins: Number(totals?.total_wins ?? 0),
      totalMatches: Number(totals?.total_matches ?? 0),
      weeklyWins: Number(weekly?.ww ?? 0),
      seasonalWins,
      challengeWins: Number(row.challenge_wins ?? 0),
      clubRating: Number(row.club_rating ?? 1200),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  public async getPlayerClubSummary(playerId: string): Promise<PlayerClubBadgeSummary | null> {
    if (!isValidPlayerIdFormat(playerId)) return null;
    const db = await this.ensureSchema();
    const row = await db
      .prepare(
        `SELECT c.club_id, c.name, c.tag, c.emblem_color, c.emblem_icon, cm.role
         FROM club_members cm
         JOIN clubs c ON c.club_id = cm.club_id
         WHERE cm.player_id = ?
         LIMIT 1`,
      )
      .bind(playerId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      clubId: String(row.club_id),
      name: String(row.name),
      tag: String(row.tag),
      emblemColor: sanitizeColor(row.emblem_color),
      emblemIcon: sanitizeIcon(row.emblem_icon),
      role: sanitizeRole(row.role),
    };
  }

  public async getClubBadgesForPlayers(playerIds: string[]): Promise<Map<string, PlayerClubBadgeSummary>> {
    const out = new Map<string, PlayerClubBadgeSummary>();
    const clean = [...new Set(playerIds.filter((id) => isValidPlayerIdFormat(id)))];
    if (clean.length === 0) return out;
    const db = await this.ensureSchema();
    const placeholders = clean.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT cm.player_id, c.club_id, c.name, c.tag, c.emblem_color, c.emblem_icon, cm.role
         FROM club_members cm
         JOIN clubs c ON c.club_id = cm.club_id
         WHERE cm.player_id IN (${placeholders})`,
      )
      .bind(...clean)
      .all<Record<string, unknown>>();
    for (const r of rows.results ?? []) {
      out.set(String(r.player_id), {
        clubId: String(r.club_id),
        name: String(r.name),
        tag: String(r.tag),
        emblemColor: sanitizeColor(r.emblem_color),
        emblemIcon: sanitizeIcon(r.emblem_icon),
        role: sanitizeRole(r.role),
      });
    }
    return out;
  }

  public async getOfficerPlayerIds(clubId: string): Promise<string[]> {
    const db = await this.ensureSchema();
    const rows = await db
      .prepare(
        `SELECT player_id FROM club_members WHERE club_id = ? AND role IN ('owner', 'president', 'vice_president', 'admin')`,
      )
      .bind(clubId)
      .all<{ player_id: string }>();
    return (rows.results ?? []).map((r) => String(r.player_id));
  }

  public async getClubMemberPlayerIds(clubId: string): Promise<string[]> {
    const db = await this.ensureSchema();
    const rows = await db
      .prepare(`SELECT player_id FROM club_members WHERE club_id = ?`)
      .bind(clubId)
      .all<{ player_id: string }>();
    return (rows.results ?? []).map((r) => String(r.player_id));
  }

  public async createClub(
    creatorId: string,
    input: {
      name: unknown;
      tag: unknown;
      description?: unknown;
      emblemColor?: unknown;
      emblemIcon?: unknown;
      joinMode?: unknown;
      region?: unknown;
      maxMembers?: unknown;
    },
  ): Promise<{ ok: true; detail: ClubDetailPayload } | ClubServiceError> {
    const db = await this.ensureSchema();
    const creatorRow = await this.getPlayerRow(db, creatorId);
    if (!creatorRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Player profile not found.' };
    }

    const existingMembership = await db
      .prepare('SELECT club_id FROM club_members WHERE player_id = ? LIMIT 1')
      .bind(creatorId)
      .first<{ club_id: string }>();
    if (existingMembership) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Leave your current club before creating a new club.',
      };
    }

    const name = sanitizeClubText(input.name, 28);
    if (!CLUB_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Club name must be 3-28 characters using letters, numbers, spaces, . _ or -.',
      };
    }
    const rawTag = sanitizeClubText(input.tag, 5).toUpperCase();
    if (!CLUB_TAG_PATTERN.test(rawTag)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Club tag must be 2-5 alphanumeric characters.',
      };
    }

    const nameLower = name.toLowerCase();
    const tagLower = rawTag.toLowerCase();
    const dup = await db
      .prepare(
        'SELECT name_lower, tag_lower FROM clubs WHERE name_lower = ? OR tag_lower = ? LIMIT 1',
      )
      .bind(nameLower, tagLower)
      .first<{ name_lower: string; tag_lower: string }>();
    if (dup) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message:
          dup.tag_lower === tagLower
            ? `Club tag [${rawTag}] is already taken.`
            : `Club name "${name}" is already taken.`,
      };
    }

    const now = Date.now();
    const clubId = `club_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const description = sanitizeClubText(input.description ?? '', 180);
    const emblemColor = sanitizeColor(input.emblemColor);
    const emblemIcon = sanitizeIcon(input.emblemIcon);
    const joinMode = sanitizeJoinMode(input.joinMode);
    const region = sanitizeRegion(input.region);
    const maxMembers = sanitizeMaxMembers(input.maxMembers);
    const initialRating = Math.round(Number(creatorRow.elo ?? 1200));

    await db
      .prepare(
        `INSERT INTO clubs (
          club_id, name, name_lower, tag, tag_lower, description,
          emblem_color, emblem_icon, join_mode, owner_id,
          region, max_members, level, xp, announcement,
          member_count, challenge_wins, club_rating, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, '', 1, 0, ?, ?, ?)`,
      )
      .bind(
        clubId,
        name,
        nameLower,
        rawTag,
        tagLower,
        description,
        emblemColor,
        emblemIcon,
        joinMode,
        creatorId,
        region,
        maxMembers,
        initialRating,
        now,
        now,
      )
      .run();

    await db
      .prepare(
        `INSERT INTO club_members (club_id, player_id, role, joined_at_ms, updated_at_ms)
         VALUES (?, ?, 'owner', ?, ?)`,
      )
      .bind(clubId, creatorId, now, now)
      .run();

    await this.logActivity(
      db,
      clubId,
      creatorId,
      String(creatorRow.display_name),
      'club_created',
      `${String(creatorRow.display_name)} founded [${rawTag}] ${name}.`,
      now,
    );

    const detail = (await this.getClubDetail(clubId, creatorId))!;
    return { ok: true, detail };
  }

  public async updateClub(
    actorId: string,
    clubId: string,
    input: {
      description?: unknown;
      emblemColor?: unknown;
      emblemIcon?: unknown;
      joinMode?: unknown;
      region?: unknown;
      maxMembers?: unknown;
      announcement?: unknown;
    },
  ): Promise<{ ok: true; detail: ClubDetailPayload } | ClubServiceError> {
    const db = await this.ensureSchema();
    const membership = await db
      .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
      .bind(clubId, actorId)
      .first<{ role: string }>();
    const actorRole = membership ? sanitizeRole(membership.role) : null;
    if (!isClubOfficerRole(actorRole)) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club officers can update club settings.',
      };
    }

    const existing = await db
      .prepare('SELECT * FROM clubs WHERE club_id = ? LIMIT 1')
      .bind(clubId)
      .first<Record<string, unknown>>();
    if (!existing) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Club not found.' };
    }

    const nextDesc =
      input.description !== undefined
        ? sanitizeClubText(input.description, 180)
        : String(existing.description ?? '');
    const nextColor =
      input.emblemColor !== undefined
        ? sanitizeColor(input.emblemColor)
        : sanitizeColor(existing.emblem_color);
    const nextIcon =
      input.emblemIcon !== undefined
        ? sanitizeIcon(input.emblemIcon)
        : sanitizeIcon(existing.emblem_icon);
    const nextJoinMode =
      input.joinMode !== undefined
        ? sanitizeJoinMode(input.joinMode)
        : sanitizeJoinMode(existing.join_mode);
    const nextRegion =
      input.region !== undefined
        ? sanitizeRegion(input.region)
        : sanitizeRegion(existing.region);
    let nextMaxMembers = sanitizeMaxMembers(existing.max_members);
    if (input.maxMembers !== undefined) {
      const requestedCap = sanitizeMaxMembers(input.maxMembers);
      const countRow = await db
        .prepare('SELECT COUNT(*) AS c FROM club_members WHERE club_id = ?')
        .bind(clubId)
        .first<{ c: number }>();
      if (requestedCap < Number(countRow?.c ?? 0)) {
        return {
          ok: false,
          status: 400,
          code: 'INVALID_INPUT',
          message: 'Club capacity cannot be lower than current member count.',
        };
      }
      nextMaxMembers = requestedCap;
    }
    const now = Date.now();
    const nextAnnouncement =
      input.announcement !== undefined
        ? sanitizeClubText(input.announcement, SOCIAL_LIMITS.clubAnnouncementMaxLength)
        : String(existing.announcement ?? '');
    const nextAnnouncementTs =
      input.announcement !== undefined
        ? now
        : existing.announcement_updated_at_ms !== null && existing.announcement_updated_at_ms !== undefined
          ? Number(existing.announcement_updated_at_ms)
          : null;

    await db
      .prepare(
        `UPDATE clubs
         SET description = ?, emblem_color = ?, emblem_icon = ?, join_mode = ?,
             region = ?, max_members = ?, announcement = ?, announcement_updated_at_ms = ?, updated_at_ms = ?
         WHERE club_id = ?`,
      )
      .bind(
        nextDesc,
        nextColor,
        nextIcon,
        nextJoinMode,
        nextRegion,
        nextMaxMembers,
        nextAnnouncement,
        nextAnnouncementTs,
        now,
        clubId,
      )
      .run();

    const actor = await this.getPlayerRow(db, actorId);
    await this.logActivity(
      db,
      clubId,
      actorId,
      actor ? String(actor.display_name) : 'Officer',
      input.announcement !== undefined ? 'announcement_posted' : 'club_updated',
      input.announcement !== undefined
        ? `${actor ? String(actor.display_name) : 'An officer'} updated the club bulletin.`
        : `${actor ? String(actor.display_name) : 'An officer'} updated club settings.`,
      now,
    );

    const detail = (await this.getClubDetail(clubId, actorId))!;
    return { ok: true, detail };
  }

  public async listClubs(params?: {
    query?: string;
    joinMode?: ClubJoinMode | 'all';
    limit?: number;
  }): Promise<ClubRecord[]> {
    const db = await this.ensureSchema();
    const cleaned = (params?.query ?? '').trim().toLowerCase().replace(/[%_]/g, '');
    const safeLimit = Math.max(1, Math.min(50, params?.limit ?? 24));
    const clauses: string[] = [];
    const binds: unknown[] = [];

    if (cleaned) {
      const pattern = `%${cleaned}%`;
      clauses.push('(name_lower LIKE ? OR tag_lower LIKE ?)');
      binds.push(pattern, pattern);
    }
    if (params?.joinMode === 'public' || params?.joinMode === 'approval') {
      clauses.push('join_mode = ?');
      binds.push(params.joinMode);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    binds.push(safeLimit);

    const rows = await db
      .prepare(
        `SELECT * FROM clubs ${where}
         ORDER BY club_rating DESC, member_count DESC, created_at_ms ASC
         LIMIT ?`,
      )
      .bind(...binds)
      .all<Record<string, unknown>>();

    const out: ClubRecord[] = [];
    for (const r of rows.results ?? []) {
      out.push(await this.hydrateClubRecord(db, r));
    }
    return out;
  }

  public async getClubDetail(
    clubId: string,
    viewerId?: string | null,
  ): Promise<ClubDetailPayload | null> {
    const db = await this.ensureSchema();
    const now = Date.now();
    await this.expirePendingData(db, now);

    const clubRow = await db
      .prepare('SELECT * FROM clubs WHERE club_id = ? LIMIT 1')
      .bind(clubId.trim())
      .first<Record<string, unknown>>();
    if (!clubRow) return null;

    const club = await this.hydrateClubRecord(db, clubRow);
    const social = new SocialService(this.db);
    const privacySvcRows = await db
      .prepare(
        `SELECT cm.club_id, cm.player_id, cm.role, cm.joined_at_ms,
                p.username, p.display_name, p.avatar_id, p.elo, p.level, p.wins, p.total_matches,
                pr.status AS presence_status, pr.expires_at_ms
         FROM club_members cm
         JOIN players p ON p.player_id = cm.player_id
         LEFT JOIN player_presence pr ON pr.player_id = cm.player_id
         WHERE cm.club_id = ?
         ORDER BY CASE cm.role
                    WHEN 'owner' THEN 0
                    WHEN 'president' THEN 1
                    WHEN 'vice_president' THEN 2
                    WHEN 'admin' THEN 2
                    WHEN 'captain' THEN 3
                    ELSE 4
                  END, p.elo DESC`,
      )
      .bind(club.clubId)
      .all<Record<string, unknown>>();

    const memberIds = (privacySvcRows.results ?? []).map((m) => String(m.player_id));
    const privacyMap = await social.getPrivacySettingsMap(memberIds);

    const members: ClubMemberRecord[] = (privacySvcRows.results ?? []).map((r) => {
      const pid = String(r.player_id);
      const rawStatus = r.presence_status ? String(r.presence_status) : 'offline';
      const exp = r.expires_at_ms !== null && r.expires_at_ms !== undefined ? Number(r.expires_at_ms) : 0;
      const showOnline = viewerId === pid || (privacyMap.get(pid)?.showOnlineStatus ?? true);
      const presence: PresenceStatus =
        showOnline && rawStatus !== 'offline' && exp > now
          ? social.normalizePresencePublic(rawStatus)
          : 'offline';
      return {
        clubId: club.clubId,
        playerId: pid,
        username: r.username ? String(r.username) : null,
        displayName: String(r.display_name),
        avatarId: sanitizeAvatarId(r.avatar_id),
        role: sanitizeRole(r.role),
        elo: Number(r.elo),
        level: Number(r.level),
        wins: Number(r.wins),
        totalMatches: Number(r.total_matches),
        presence,
        joinedAtMs: Number(r.joined_at_ms),
      };
    });

    const viewerMembership = viewerId
      ? members.find((m) => m.playerId === viewerId)?.role ?? null
      : null;

    let joinRequests: ClubJoinRequestRecord[] = [];
    if (isClubOfficerRole(viewerMembership)) {
      const reqRows = await db
        .prepare(
          `SELECT r.*, p.username, p.display_name, p.avatar_id, p.elo, p.level
           FROM club_join_requests r
           JOIN players p ON p.player_id = r.player_id
           WHERE r.club_id = ? AND r.status = 'pending'
           ORDER BY r.created_at_ms ASC`,
        )
        .bind(club.clubId)
        .all<Record<string, unknown>>();
      joinRequests = (reqRows.results ?? []).map((r) => ({
        requestId: String(r.request_id),
        clubId: String(r.club_id),
        playerId: String(r.player_id),
        username: r.username ? String(r.username) : null,
        displayName: String(r.display_name),
        avatarId: sanitizeAvatarId(r.avatar_id),
        elo: Number(r.elo),
        level: Number(r.level),
        message: String(r.message ?? ''),
        status: 'pending',
        createdAtMs: Number(r.created_at_ms),
      }));
    }

    let viewerHasPendingRequest = false;
    if (viewerId && !viewerMembership) {
      const pend = await db
        .prepare(
          `SELECT 1 AS ok FROM club_join_requests WHERE club_id = ? AND player_id = ? AND status = 'pending' LIMIT 1`,
        )
        .bind(club.clubId, viewerId)
        .first<{ ok: number }>();
      viewerHasPendingRequest = Boolean(pend);
    }

    const actRows = await db
      .prepare(
        `SELECT * FROM club_activity_logs WHERE club_id = ? ORDER BY created_at_ms DESC LIMIT 20`,
      )
      .bind(club.clubId)
      .all<Record<string, unknown>>();
    const recentActivity: ClubActivityRecord[] = (actRows.results ?? []).map((r) => ({
      activityId: String(r.activity_id),
      clubId: String(r.club_id),
      actorId: r.actor_id ? String(r.actor_id) : null,
      actorName: r.actor_name ? String(r.actor_name) : null,
      eventType: String(r.event_type),
      summary: String(r.summary),
      createdAtMs: Number(r.created_at_ms),
    }));

    const challenges = await this.getChallengesForClub(club.clubId);
    const trophies = await this.getClubTrophies(club.clubId);
    const chatMessages = viewerMembership ? await this.getClubChatMessages(club.clubId, 50) : [];

    return {
      club,
      members,
      recentActivity,
      joinRequests,
      challenges,
      trophies,
      chatMessages,
      viewerRole: viewerMembership,
      viewerHasPendingRequest,
    };
  }

  public async joinOrRequestClub(
    playerId: string,
    clubId: string,
    message?: unknown,
  ): Promise<
    | { ok: true; outcome: 'joined' | 'requested'; detail: ClubDetailPayload; requestId?: string }
    | ClubServiceError
  > {
    const db = await this.ensureSchema();
    const playerRow = await this.getPlayerRow(db, playerId);
    if (!playerRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Player profile not found.' };
    }

    const existingMember = await db
      .prepare('SELECT club_id FROM club_members WHERE player_id = ? LIMIT 1')
      .bind(playerId)
      .first<{ club_id: string }>();
    if (existingMember) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Leave your current club before joining another club.',
      };
    }

    const clubRow = await db
      .prepare('SELECT * FROM clubs WHERE club_id = ? LIMIT 1')
      .bind(clubId.trim())
      .first<Record<string, unknown>>();
    if (!clubRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Club not found.' };
    }

    const clubCap = sanitizeMaxMembers(clubRow.max_members ?? SOCIAL_LIMITS.defaultClubCapacity);
    const countRow = await db
      .prepare('SELECT COUNT(*) AS c FROM club_members WHERE club_id = ?')
      .bind(clubId)
      .first<{ c: number }>();
    if (Number(countRow?.c ?? 0) >= clubCap) {
      return {
        ok: false,
        status: 409,
        code: 'CLUB_ERROR',
        message: `This club has reached its maximum capacity (${clubCap} members).`,
      };
    }

    const now = Date.now();
    if (clubRow.join_mode === 'public') {
      await db
        .prepare(
          `INSERT INTO club_members (club_id, player_id, role, joined_at_ms, updated_at_ms)
           VALUES (?, ?, 'member', ?, ?)`,
        )
        .bind(clubId, playerId, now, now)
        .run();
      await db
        .prepare(
          `UPDATE club_join_requests SET status = 'cancelled', responded_at_ms = ?
           WHERE player_id = ? AND status = 'pending'`,
        )
        .bind(now, playerId)
        .run();
      await db
        .prepare(
          `UPDATE club_invitations SET status = 'cancelled', responded_at_ms = ?
           WHERE recipient_id = ? AND status = 'pending'`,
        )
        .bind(now, playerId)
        .run();
      await this.recomputeClubAggregates(db, clubId);
      await this.logActivity(
        db,
        clubId,
        playerId,
        String(playerRow.display_name),
        'member_joined',
        `${String(playerRow.display_name)} joined the club.`,
        now,
      );
      const detail = (await this.getClubDetail(clubId, playerId))!;
      return { ok: true, outcome: 'joined', detail };
    }

    const dupReq = await db
      .prepare(
        `SELECT request_id FROM club_join_requests WHERE club_id = ? AND player_id = ? AND status = 'pending' LIMIT 1`,
      )
      .bind(clubId, playerId)
      .first<{ request_id: string }>();
    if (dupReq) {
      return {
        ok: false,
        status: 409,
        code: 'DUPLICATE_REQUEST',
        message: 'You already have a pending join request for this club.',
      };
    }

    const requestId = `creq_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    await db
      .prepare(
        `INSERT INTO club_join_requests (
          request_id, club_id, player_id, message, status, created_at_ms
        ) VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(requestId, clubId, playerId, sanitizeClubText(message ?? '', 140), now)
      .run();

    const detail = (await this.getClubDetail(clubId, playerId))!;
    return { ok: true, outcome: 'requested', detail, requestId };
  }

  public async respondJoinRequest(
    actorId: string,
    clubId: string,
    requestId: string,
    action: 'accept' | 'reject',
  ): Promise<{ ok: true; detail: ClubDetailPayload; targetPlayerId: string } | ClubServiceError> {
    const db = await this.ensureSchema();
    const actorMembership = await db
      .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
      .bind(clubId, actorId)
      .first<{ role: string }>();
    if (!actorMembership || !isClubOfficerRole(sanitizeRole(actorMembership.role))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club officers can review join requests.',
      };
    }

    const reqRow = await db
      .prepare('SELECT * FROM club_join_requests WHERE request_id = ? AND club_id = ? LIMIT 1')
      .bind(requestId, clubId)
      .first<Record<string, unknown>>();
    if (!reqRow || reqRow.status !== 'pending') {
      return {
        ok: false,
        status: 404,
        code: 'NOT_FOUND',
        message: 'Pending join request not found.',
      };
    }

    const targetPlayerId = String(reqRow.player_id);
    const now = Date.now();

    if (action === 'reject') {
      await db
        .prepare(
          `UPDATE club_join_requests SET status = 'rejected', responded_at_ms = ? WHERE request_id = ?`,
        )
        .bind(now, requestId)
        .run();
      const detail = (await this.getClubDetail(clubId, actorId))!;
      return { ok: true, detail, targetPlayerId };
    }

    const existingMem = await db
      .prepare('SELECT club_id FROM club_members WHERE player_id = ? LIMIT 1')
      .bind(targetPlayerId)
      .first<{ club_id: string }>();
    if (existingMem) {
      await db
        .prepare(
          `UPDATE club_join_requests SET status = 'cancelled', responded_at_ms = ? WHERE request_id = ?`,
        )
        .bind(now, requestId)
        .run();
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'That player has already joined another club.',
      };
    }

    const clubMeta = await db
      .prepare('SELECT max_members FROM clubs WHERE club_id = ? LIMIT 1')
      .bind(clubId)
      .first<{ max_members: number | null }>();
    const clubCap = sanitizeMaxMembers(clubMeta?.max_members ?? SOCIAL_LIMITS.defaultClubCapacity);
    const countRow = await db
      .prepare('SELECT COUNT(*) AS c FROM club_members WHERE club_id = ?')
      .bind(clubId)
      .first<{ c: number }>();
    if (Number(countRow?.c ?? 0) >= clubCap) {
      return {
        ok: false,
        status: 409,
        code: 'CLUB_ERROR',
        message: 'Club roster is full.',
      };
    }

    await db
      .prepare(
        `UPDATE club_join_requests SET status = 'accepted', responded_at_ms = ? WHERE request_id = ?`,
      )
      .bind(now, requestId)
      .run();
    await db
      .prepare(
        `INSERT INTO club_members (club_id, player_id, role, joined_at_ms, updated_at_ms)
         VALUES (?, ?, 'member', ?, ?)`,
      )
      .bind(clubId, targetPlayerId, now, now)
      .run();
    await db
      .prepare(
        `UPDATE club_join_requests SET status = 'cancelled', responded_at_ms = ?
         WHERE player_id = ? AND status = 'pending'`,
      )
      .bind(now, targetPlayerId)
      .run();

    await this.recomputeClubAggregates(db, clubId);
    const targetRow = await this.getPlayerRow(db, targetPlayerId);
    await this.logActivity(
      db,
      clubId,
      actorId,
      targetRow ? String(targetRow.display_name) : 'Player',
      'member_joined',
      `${targetRow ? String(targetRow.display_name) : 'New member'} was accepted into the club.`,
      now,
    );

    const detail = (await this.getClubDetail(clubId, actorId))!;
    return { ok: true, detail, targetPlayerId };
  }

  public async invitePlayerToClub(
    actorId: string,
    clubId: string,
    targetPlayerIdRaw: string,
  ): Promise<{ ok: true; invitation: ClubInvitationRecord } | ClubServiceError> {
    const db = await this.ensureSchema();
    const targetPlayerId = targetPlayerIdRaw.trim();
    if (!isValidPlayerIdFormat(targetPlayerId)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid player ID.' };
    }
    if (actorId === targetPlayerId) {
      return {
        ok: false,
        status: 400,
        code: 'SELF_ACTION_FORBIDDEN',
        message: 'You cannot invite yourself.',
      };
    }

    const membership = await db
      .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
      .bind(clubId, actorId)
      .first<{ role: string }>();
    if (!membership || !isClubOfficerRole(sanitizeRole(membership.role))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club officers can send club invitations.',
      };
    }

    const [inviterRow, targetRow, clubRow] = await Promise.all([
      this.getPlayerRow(db, actorId),
      this.getPlayerRow(db, targetPlayerId),
      db.prepare('SELECT * FROM clubs WHERE club_id = ? LIMIT 1').bind(clubId).first<Record<string, unknown>>(),
    ]);
    if (!clubRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Club not found.' };
    }
    if (!targetRow || !inviterRow) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Player not found.' };
    }

    const social = new SocialService(this.db);
    if (await social.isBlockedBetween(actorId, targetPlayerId)) {
      return {
        ok: false,
        status: 403,
        code: 'BLOCKED_PLAYER',
        message: 'Cannot invite a blocked player.',
      };
    }

    const targetInClub = await db
      .prepare('SELECT club_id FROM club_members WHERE player_id = ? LIMIT 1')
      .bind(targetPlayerId)
      .first<{ club_id: string }>();
    if (targetInClub) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message:
          targetInClub.club_id === clubId
            ? 'That player is already a member of this club.'
            : 'That player is already a member of another club.',
      };
    }

    const now = Date.now();
    await this.expirePendingData(db, now);
    const dup = await db
      .prepare(
        `SELECT invite_id FROM club_invitations
         WHERE club_id = ? AND recipient_id = ? AND status = 'pending' AND expires_at_ms > ?
         LIMIT 1`,
      )
      .bind(clubId, targetPlayerId, now)
      .first<{ invite_id: string }>();
    if (dup) {
      return {
        ok: false,
        status: 409,
        code: 'INVITE_ALREADY_EXISTS',
        message: 'A club invitation is already pending for this player.',
      };
    }

    const inviteId = `cinv_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const expiresAtMs = now + 7 * 24 * 60 * 60 * 1000;

    await db
      .prepare(
        `INSERT INTO club_invitations (
          invite_id, club_id, inviter_id, recipient_id, status, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(inviteId, clubId, actorId, targetPlayerId, now, expiresAtMs)
      .run();

    const invitation: ClubInvitationRecord = {
      inviteId,
      clubId,
      clubName: String(clubRow.name),
      clubTag: String(clubRow.tag),
      emblemColor: sanitizeColor(clubRow.emblem_color),
      emblemIcon: sanitizeIcon(clubRow.emblem_icon),
      inviterId: actorId,
      inviterName: String(inviterRow.display_name),
      recipientId: targetPlayerId,
      recipientName: String(targetRow.display_name),
      status: 'pending',
      createdAtMs: now,
      expiresAtMs,
    };

    return { ok: true, invitation };
  }

  public async respondClubInvite(
    actorId: string,
    inviteId: string,
    action: 'accept' | 'reject' | 'cancel',
  ): Promise<
    { ok: true; clubId: string; status: 'accepted' | 'rejected' | 'cancelled'; detail?: ClubDetailPayload }
    | ClubServiceError
  > {
    const db = await this.ensureSchema();
    const now = Date.now();
    await this.expirePendingData(db, now);

    const row = await db
      .prepare('SELECT * FROM club_invitations WHERE invite_id = ? LIMIT 1')
      .bind(inviteId.trim())
      .first<Record<string, unknown>>();
    if (!row || row.status !== 'pending') {
      return {
        ok: false,
        status: 404,
        code: 'INVITE_EXPIRED',
        message: 'Pending club invitation not found.',
      };
    }

    const clubId = String(row.club_id);
    if (action === 'cancel') {
      if (String(row.inviter_id) !== actorId) {
        return { ok: false, status: 403, code: 'UNAUTHORIZED', message: 'Cannot cancel this invitation.' };
      }
      await db
        .prepare(`UPDATE club_invitations SET status = 'cancelled', responded_at_ms = ? WHERE invite_id = ?`)
        .bind(now, inviteId)
        .run();
      return { ok: true, clubId, status: 'cancelled' };
    }

    if (String(row.recipient_id) !== actorId) {
      return { ok: false, status: 403, code: 'UNAUTHORIZED', message: 'Only the recipient can respond.' };
    }

    if (action === 'reject') {
      await db
        .prepare(`UPDATE club_invitations SET status = 'rejected', responded_at_ms = ? WHERE invite_id = ?`)
        .bind(now, inviteId)
        .run();
      return { ok: true, clubId, status: 'rejected' };
    }

    const already = await db
      .prepare('SELECT club_id FROM club_members WHERE player_id = ? LIMIT 1')
      .bind(actorId)
      .first<{ club_id: string }>();
    if (already) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Leave your current club before accepting another club invitation.',
      };
    }

    const clubMeta = await db
      .prepare('SELECT max_members FROM clubs WHERE club_id = ? LIMIT 1')
      .bind(clubId)
      .first<{ max_members: number | null }>();
    const clubCap = sanitizeMaxMembers(clubMeta?.max_members ?? SOCIAL_LIMITS.defaultClubCapacity);
    const countRow = await db
      .prepare('SELECT COUNT(*) AS c FROM club_members WHERE club_id = ?')
      .bind(clubId)
      .first<{ c: number }>();
    if (Number(countRow?.c ?? 0) >= clubCap) {
      return { ok: false, status: 409, code: 'CLUB_ERROR', message: 'This club is currently full.' };
    }

    await db
      .prepare(`UPDATE club_invitations SET status = 'accepted', responded_at_ms = ? WHERE invite_id = ?`)
      .bind(now, inviteId)
      .run();
    await db
      .prepare(
        `INSERT INTO club_members (club_id, player_id, role, joined_at_ms, updated_at_ms)
         VALUES (?, ?, 'member', ?, ?)`,
      )
      .bind(clubId, actorId, now, now)
      .run();
    await this.recomputeClubAggregates(db, clubId);
    const actorRow = await this.getPlayerRow(db, actorId);
    await this.logActivity(
      db,
      clubId,
      actorId,
      actorRow ? String(actorRow.display_name) : 'Player',
      'member_joined',
      `${actorRow ? String(actorRow.display_name) : 'A player'} accepted a club invite and joined.`,
      now,
    );
    const detail = (await this.getClubDetail(clubId, actorId)) ?? undefined;
    return { ok: true, clubId, status: 'accepted', detail };
  }

  public async getIncomingClubInvitations(playerId: string): Promise<ClubInvitationRecord[]> {
    if (!isValidPlayerIdFormat(playerId)) return [];
    const db = await this.ensureSchema();
    const now = Date.now();
    await this.expirePendingData(db, now);

    const rows = await db
      .prepare(
        `SELECT ci.*, c.name AS club_name, c.tag AS club_tag, c.emblem_color, c.emblem_icon,
                inv.display_name AS inviter_name, rec.display_name AS recipient_name
         FROM club_invitations ci
         JOIN clubs c ON c.club_id = ci.club_id
         LEFT JOIN players inv ON inv.player_id = ci.inviter_id
         LEFT JOIN players rec ON rec.player_id = ci.recipient_id
         WHERE ci.recipient_id = ? AND ci.status = 'pending' AND ci.expires_at_ms > ?
         ORDER BY ci.created_at_ms DESC`,
      )
      .bind(playerId, now)
      .all<Record<string, unknown>>();

    return (rows.results ?? []).map((r) => ({
      inviteId: String(r.invite_id),
      clubId: String(r.club_id),
      clubName: String(r.club_name ?? 'Club'),
      clubTag: String(r.club_tag ?? 'CLUB'),
      emblemColor: sanitizeColor(r.emblem_color),
      emblemIcon: sanitizeIcon(r.emblem_icon),
      inviterId: String(r.inviter_id),
      inviterName: String(r.inviter_name ?? 'Officer'),
      recipientId: String(r.recipient_id),
      recipientName: String(r.recipient_name ?? 'Player'),
      status: 'pending',
      createdAtMs: Number(r.created_at_ms),
      expiresAtMs: Number(r.expires_at_ms),
    }));
  }

  public async leaveClub(
    actorId: string,
    clubId: string,
  ): Promise<{ ok: true; disbanded: boolean } | ClubServiceError> {
    const db = await this.ensureSchema();
    const membership = await db
      .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
      .bind(clubId, actorId)
      .first<{ role: string }>();
    if (!membership) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'You are not a member of this club.' };
    }

    const others = await db
      .prepare('SELECT player_id, role FROM club_members WHERE club_id = ? AND player_id != ?')
      .bind(clubId, actorId)
      .all<{ player_id: string; role: string }>();
    const remainingMembers = others.results ?? [];

    if (membership.role === 'owner' && remainingMembers.length > 0) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Transfer club ownership to another member before leaving.',
      };
    }

    const now = Date.now();
    await db
      .prepare('DELETE FROM club_members WHERE club_id = ? AND player_id = ?')
      .bind(clubId, actorId)
      .run();

    if (remainingMembers.length === 0) {
      await db
        .prepare(
          `UPDATE club_challenges SET status = 'cancelled', completed_at_ms = ?
           WHERE (challenger_club_id = ? OR target_club_id = ?) AND status IN ('pending', 'accepted', 'in_progress')`,
        )
        .bind(now, clubId, clubId)
        .run();
      await db.prepare('DELETE FROM club_join_requests WHERE club_id = ?').bind(clubId).run();
      await db.prepare('DELETE FROM club_invitations WHERE club_id = ?').bind(clubId).run();
      await db.prepare('DELETE FROM club_activity_logs WHERE club_id = ?').bind(clubId).run();
      await db.prepare('DELETE FROM clubs WHERE club_id = ?').bind(clubId).run();
      return { ok: true, disbanded: true };
    }

    await this.recomputeClubAggregates(db, clubId);
    const actorRow = await this.getPlayerRow(db, actorId);
    await this.logActivity(
      db,
      clubId,
      actorId,
      actorRow ? String(actorRow.display_name) : 'Member',
      'member_left',
      `${actorRow ? String(actorRow.display_name) : 'A member'} left the club.`,
      now,
    );
    return { ok: true, disbanded: false };
  }

  public async updateMemberRole(
    actorId: string,
    clubId: string,
    targetPlayerId: string,
    nextRole: ClubRole,
  ): Promise<{ ok: true; detail: ClubDetailPayload } | ClubServiceError> {
    const db = await this.ensureSchema();
    if (actorId === targetPlayerId) {
      return {
        ok: false,
        status: 400,
        code: 'SELF_ACTION_FORBIDDEN',
        message: 'You cannot change your own role directly.',
      };
    }

    const [actorMem, targetMem] = await Promise.all([
      db
        .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
        .bind(clubId, actorId)
        .first<{ role: string }>(),
      db
        .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
        .bind(clubId, targetPlayerId)
        .first<{ role: string }>(),
    ]);

    if (!actorMem) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'You are not a member of this club.',
      };
    }
    const actorRole = sanitizeRole(actorMem.role);
    if (actorRole !== 'owner' && actorRole !== 'president') {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only the club owner or president can promote or demote members.',
      };
    }
    if (!targetMem) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Target member not found.' };
    }

    const targetCurrentRole = sanitizeRole(targetMem.role);
    const safeNextRole = sanitizeRole(nextRole);

    if (safeNextRole === 'owner' && actorRole !== 'owner') {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only the current owner can transfer club ownership.',
      };
    }

    if (
      actorRole === 'president' &&
      (CLUB_ROLE_RANK[targetCurrentRole] >= CLUB_ROLE_RANK['president'] ||
        CLUB_ROLE_RANK[safeNextRole] >= CLUB_ROLE_RANK['president'])
    ) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Presidents cannot alter Owners or assign President rank.',
      };
    }

    const now = Date.now();
    const targetRow = await this.getPlayerRow(db, targetPlayerId);
    const targetName = targetRow ? String(targetRow.display_name) : 'Member';

    if (safeNextRole === 'owner') {
      await db
        .prepare(`UPDATE club_members SET role = 'president', updated_at_ms = ? WHERE club_id = ? AND player_id = ?`)
        .bind(now, clubId, actorId)
        .run();
      await db
        .prepare(`UPDATE club_members SET role = 'owner', updated_at_ms = ? WHERE club_id = ? AND player_id = ?`)
        .bind(now, clubId, targetPlayerId)
        .run();
      await this.prepareOwnerUpdate(db, clubId, targetPlayerId, now);
      await this.logActivity(
        db,
        clubId,
        actorId,
        targetName,
        'ownership_transferred',
        `Ownership transferred to ${targetName}.`,
        now,
      );
    } else {
      await db
        .prepare(`UPDATE club_members SET role = ?, updated_at_ms = ? WHERE club_id = ? AND player_id = ?`)
        .bind(safeNextRole, now, clubId, targetPlayerId)
        .run();
      await this.logActivity(
        db,
        clubId,
        actorId,
        targetName,
        'role_updated',
        `${targetName} role updated to ${safeNextRole.replace('_', ' ')}.`,
        now,
      );
    }

    const detail = (await this.getClubDetail(clubId, actorId))!;
    return { ok: true, detail };
  }

  private async prepareOwnerUpdate(
    db: ProgressionSqlDb,
    clubId: string,
    newOwnerId: string,
    now: number,
  ): Promise<void> {
    await db
      .prepare('UPDATE clubs SET owner_id = ?, updated_at_ms = ? WHERE club_id = ?')
      .bind(newOwnerId, now, clubId)
      .run();
  }

  public async kickMember(
    actorId: string,
    clubId: string,
    targetPlayerId: string,
  ): Promise<{ ok: true; detail: ClubDetailPayload } | ClubServiceError> {
    const db = await this.ensureSchema();
    if (actorId === targetPlayerId) {
      return { ok: false, status: 400, code: 'SELF_ACTION_FORBIDDEN', message: 'Use Leave Club instead.' };
    }
    const [actorMem, targetMem] = await Promise.all([
      db
        .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
        .bind(clubId, actorId)
        .first<{ role: string }>(),
      db
        .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
        .bind(clubId, targetPlayerId)
        .first<{ role: string }>(),
    ]);

    const actorRole = actorMem ? sanitizeRole(actorMem.role) : null;
    if (!actorRole || !isClubOfficerRole(actorRole)) {
      return { ok: false, status: 403, code: 'UNAUTHORIZED', message: 'Insufficient club permissions.' };
    }
    if (!targetMem) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Member not found.' };
    }
    const targetRole = sanitizeRole(targetMem.role);
    if (targetRole === 'owner' || CLUB_ROLE_RANK[actorRole] <= CLUB_ROLE_RANK[targetRole]) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'You do not have permission to remove this member.',
      };
    }

    const now = Date.now();
    await db
      .prepare('DELETE FROM club_members WHERE club_id = ? AND player_id = ?')
      .bind(clubId, targetPlayerId)
      .run();
    await this.recomputeClubAggregates(db, clubId);
    const targetRow = await this.getPlayerRow(db, targetPlayerId);
    await this.logActivity(
      db,
      clubId,
      actorId,
      targetRow ? String(targetRow.display_name) : 'Member',
      'member_kicked',
      `${targetRow ? String(targetRow.display_name) : 'A member'} was removed from the club.`,
      now,
    );
    const detail = (await this.getClubDetail(clubId, actorId))!;
    return { ok: true, detail };
  }

  public async awardClubXp(
    clubId: string,
    xpDelta: number,
    summary?: string,
  ): Promise<{ level: number; xp: number; leveledUp: boolean } | null>;
  public async awardClubXp(input: {
    clubId: string;
    xpAmount: number;
    actorId?: string | null;
    eventType?: string;
    summary?: string;
  }): Promise<{ level: number; xp: number; leveledUp: boolean } | null>;
  public async awardClubXp(
    clubIdOrInput:
      | string
      | {
          clubId: string;
          xpAmount: number;
          actorId?: string | null;
          eventType?: string;
          summary?: string;
        },
    xpDeltaArg?: number,
    summaryArg?: string,
  ): Promise<{ level: number; xp: number; leveledUp: boolean } | null> {
    const clubId = typeof clubIdOrInput === 'string' ? clubIdOrInput : clubIdOrInput.clubId;
    const xpDelta =
      typeof clubIdOrInput === 'string' ? (xpDeltaArg ?? 0) : clubIdOrInput.xpAmount;
    const summary = typeof clubIdOrInput === 'string' ? summaryArg : clubIdOrInput.summary;
    const actorId = typeof clubIdOrInput === 'string' ? null : (clubIdOrInput.actorId ?? null);
    const eventType =
      typeof clubIdOrInput === 'string' ? 'club_xp' : (clubIdOrInput.eventType ?? 'club_xp');

    const db = await this.ensureSchema();
    const row = await db
      .prepare('SELECT xp, level FROM clubs WHERE club_id = ? LIMIT 1')
      .bind(clubId)
      .first<{ xp: number | null; level: number | null }>();
    if (!row) return null;
    const prevLevel = Number(row.level ?? 1);
    const nextXp = Math.max(0, Number(row.xp ?? 0) + Math.max(0, Math.round(xpDelta)));
    const calc = calculateClubLevelFromXp(nextXp);
    const now = Date.now();
    await db
      .prepare('UPDATE clubs SET xp = ?, level = ?, updated_at_ms = ? WHERE club_id = ?')
      .bind(calc.xp, calc.level, now, clubId)
      .run();
    if (summary) {
      await this.logActivity(db, clubId, actorId, null, eventType, summary, now);
    }
    return {
      level: calc.level,
      xp: calc.xp,
      leveledUp: calc.level > prevLevel,
    };
  }

  public async awardClubTrophy(params: {
    clubId: string;
    teamId?: string | null;
    teamName?: string | null;
    competitionKind: 'league' | 'club_championship' | 'challenge';
    competitionId: string;
    title: string;
    tier: 'champion' | 'runner_up' | 'promoted' | 'milestone';
    seasonLabel?: string;
  }): Promise<ClubTrophyRecord | null> {
    const db = await this.ensureSchema();
    const now = Date.now();
    const trophyId = `ctrophy_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const seasonLabel = sanitizeClubText(params.seasonLabel ?? 'Season 1', 24) || 'Season 1';
    const title = sanitizeClubText(params.title, 64) || 'Club Honor';
    await db
      .prepare(
        `INSERT OR IGNORE INTO club_trophies (
          trophy_id, club_id, team_id, team_name, competition_kind, competition_id,
          title, tier, season_label, awarded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        trophyId,
        params.clubId,
        params.teamId ?? null,
        params.teamName ?? null,
        params.competitionKind,
        params.competitionId,
        title,
        params.tier,
        seasonLabel,
        now,
      )
      .run();

    const row = await db
      .prepare(
        `SELECT * FROM club_trophies
         WHERE club_id = ? AND competition_kind = ? AND competition_id = ? AND tier = ?
         LIMIT 1`,
      )
      .bind(params.clubId, params.competitionKind, params.competitionId, params.tier)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      trophyId: String(row.trophy_id),
      clubId: String(row.club_id),
      teamId: row.team_id ? String(row.team_id) : null,
      teamName: row.team_name ? String(row.team_name) : null,
      competitionKind:
        row.competition_kind === 'league'
          ? 'league'
          : row.competition_kind === 'challenge'
            ? 'challenge'
            : 'club_championship',
      competitionId: String(row.competition_id),
      title: String(row.title),
      tier:
        row.tier === 'runner_up' || row.tier === 'promoted' || row.tier === 'milestone'
          ? row.tier
          : 'champion',
      seasonLabel: String(row.season_label ?? 'Season 1'),
      awardedAtMs: Number(row.awarded_at_ms),
    };
  }

  public async getClubChatMessages(clubId: string, limit = 50): Promise<ClubChatMessageRecord[]> {
    const db = await this.ensureSchema();
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await db
      .prepare(
        `SELECT * FROM club_chat_messages WHERE club_id = ? ORDER BY created_at_ms DESC LIMIT ?`,
      )
      .bind(clubId, safeLimit)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).reverse().map((r) => ({
      messageId: String(r.message_id),
      clubId: String(r.club_id),
      senderId: String(r.sender_id),
      senderName: String(r.sender_name),
      senderAvatar: sanitizeAvatarId(r.sender_avatar),
      senderRole: sanitizeRole(r.sender_role),
      body: String(r.body),
      createdAtMs: Number(r.created_at_ms),
    }));
  }

  public async sendClubChatMessage(
    senderId: string,
    clubId: string,
    rawBody: unknown,
  ): Promise<{ ok: true; message: ClubChatMessageRecord } | ClubServiceError> {
    const db = await this.ensureSchema();
    const mem = await db
      .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
      .bind(clubId, senderId)
      .first<{ role: string }>();
    if (!mem) {
      return { ok: false, status: 403, code: 'UNAUTHORIZED', message: 'Join this club to send chat messages.' };
    }

    const sanitized = sanitizeChatText(rawBody, SOCIAL_LIMITS.clubChatMaxLength);
    if (!sanitized.ok) {
      return { ok: false, status: 400, code: sanitized.code, message: sanitized.message };
    }

    const now = Date.now();
    const cooldownKey = `${clubId}:${senderId}`;
    const lastAt = ClubService.clubChatCooldowns.get(cooldownKey) ?? 0;
    if (now - lastAt < SOCIAL_LIMITS.chatMinIntervalMs) {
      return {
        ok: false,
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Slow down slightly before sending another club message.',
      };
    }
    ClubService.clubChatCooldowns.set(cooldownKey, now);

    const playerRow = await this.getPlayerRow(db, senderId);
    const messageId = `cmsg_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const role = sanitizeRole(mem.role);
    const senderName = playerRow ? String(playerRow.display_name) : 'Member';
    const senderAvatar = sanitizeAvatarId(playerRow?.avatar_id);

    await db
      .prepare(
        `INSERT INTO club_chat_messages (
          message_id, club_id, sender_id, sender_name, sender_avatar, sender_role, body, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(messageId, clubId, senderId, senderName, senderAvatar, role, sanitized.text, now)
      .run();

    await db
      .prepare(
        `DELETE FROM club_chat_messages
         WHERE club_id = ?
           AND message_id NOT IN (
             SELECT message_id FROM club_chat_messages
             WHERE club_id = ?
             ORDER BY created_at_ms DESC
             LIMIT 100
           )`,
      )
      .bind(clubId, clubId)
      .run();

    return {
      ok: true,
      message: {
        messageId,
        clubId,
        senderId,
        senderName,
        senderAvatar,
        senderRole: role,
        body: sanitized.text,
        createdAtMs: now,
      },
    };
  }

  public async getClubTrophies(clubId: string, limit = 30): Promise<ClubTrophyRecord[]> {
    const db = await this.ensureSchema();
    const rows = await db
      .prepare(
        `SELECT * FROM club_trophies WHERE club_id = ? ORDER BY awarded_at_ms DESC LIMIT ?`,
      )
      .bind(clubId, Math.max(1, Math.min(50, limit)))
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map((r) => ({
      trophyId: String(r.trophy_id),
      clubId: String(r.club_id),
      teamId: r.team_id ? String(r.team_id) : null,
      teamName: r.team_name ? String(r.team_name) : null,
      competitionKind:
        r.competition_kind === 'league'
          ? 'league'
          : r.competition_kind === 'challenge'
            ? 'challenge'
            : 'club_championship',
      competitionId: String(r.competition_id),
      title: String(r.title),
      tier:
        r.tier === 'runner_up' || r.tier === 'promoted' || r.tier === 'milestone'
          ? r.tier
          : 'champion',
      seasonLabel: String(r.season_label ?? 'Season 1'),
      awardedAtMs: Number(r.awarded_at_ms),
    }));
  }

  public async getClubLeaderboard(params: {
    scope: ClubLeaderboardScope;
    page?: number;
    limit?: number;
    query?: string;
  }): Promise<{
    scope: ClubLeaderboardScope;
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    items: ClubLeaderboardEntry[];
  }> {
    const db = await this.ensureSchema();
    const page = Math.max(1, Math.floor(params.page ?? 1));
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 20)));
    const cleaned = (params.query ?? '').trim().toLowerCase();

    const clubRows = await db
      .prepare('SELECT * FROM clubs')
      .all<Record<string, unknown>>();

    const allEntries: ClubLeaderboardEntry[] = [];
    for (const r of clubRows.results ?? []) {
      const hydrated = await this.hydrateClubRecord(db, r);
      if (
        cleaned &&
        !hydrated.name.toLowerCase().includes(cleaned) &&
        !hydrated.tag.toLowerCase().includes(cleaned)
      ) {
        continue;
      }

      const periodWins =
        params.scope === 'weekly'
          ? hydrated.weeklyWins
          : params.scope === 'seasonal'
            ? hydrated.seasonalWins
            : hydrated.totalWins;
      const periodScore =
        params.scope === 'weekly'
          ? hydrated.weeklyWins * 25 + hydrated.challengeWins * 15
          : params.scope === 'seasonal'
            ? hydrated.seasonalWins * 25 + hydrated.challengeWins * 20
            : hydrated.clubRating;

      allEntries.push({
        rank: 0,
        clubId: hydrated.clubId,
        name: hydrated.name,
        tag: hydrated.tag,
        emblemColor: hydrated.emblemColor,
        emblemIcon: hydrated.emblemIcon,
        memberCount: hydrated.memberCount,
        totalWins: hydrated.totalWins,
        totalMatches: hydrated.totalMatches,
        challengeWins: hydrated.challengeWins,
        clubRating: hydrated.clubRating,
        periodWins,
        periodScore,
      });
    }

    allEntries.sort((a, b) => {
      if (b.periodScore !== a.periodScore) return b.periodScore - a.periodScore;
      if (b.periodWins !== a.periodWins) return b.periodWins - a.periodWins;
      if (b.challengeWins !== a.challengeWins) return b.challengeWins - a.challengeWins;
      return b.clubRating - a.clubRating;
    });

    const ranked = allEntries.map((item, idx) => ({ ...item, rank: idx + 1 }));
    const total = ranked.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;
    return {
      scope: params.scope,
      page,
      limit,
      total,
      totalPages,
      items: ranked.slice(offset, offset + limit),
    };
  }

  public async createChallenge(
    actorId: string,
    challengerClubId: string,
    input: {
      targetClubId: string;
      ruleProfileId?: RuleProfileId;
      calledShotsEnabled?: boolean;
      targetWins?: number;
      notes?: unknown;
    },
  ): Promise<{ ok: true; challenge: ClubChallengeRecord } | ClubServiceError> {
    const db = await this.ensureSchema();
    const targetClubId = (input.targetClubId ?? '').trim();
    if (!targetClubId || targetClubId === challengerClubId) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Select another club to challenge.',
      };
    }

    const actorMem = await db
      .prepare('SELECT role FROM club_members WHERE club_id = ? AND player_id = ? LIMIT 1')
      .bind(challengerClubId, actorId)
      .first<{ role: string }>();
    if (!actorMem || !isClubOfficerRole(sanitizeRole(actorMem.role))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club officers can issue club challenges.',
      };
    }

    const [cClub, tClub] = await Promise.all([
      db.prepare('SELECT * FROM clubs WHERE club_id = ? LIMIT 1').bind(challengerClubId).first<Record<string, unknown>>(),
      db.prepare('SELECT * FROM clubs WHERE club_id = ? LIMIT 1').bind(targetClubId).first<Record<string, unknown>>(),
    ]);
    if (!cClub || !tClub) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Target club not found.' };
    }

    const now = Date.now();
    await this.expirePendingData(db, now);

    const activeDup = await db
      .prepare(
        `SELECT challenge_id FROM club_challenges
         WHERE status IN ('pending', 'accepted', 'in_progress')
           AND ((challenger_club_id = ? AND target_club_id = ?) OR (challenger_club_id = ? AND target_club_id = ?))
         LIMIT 1`,
      )
      .bind(challengerClubId, targetClubId, targetClubId, challengerClubId)
      .first<{ challenge_id: string }>();
    if (activeDup) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'An active or pending challenge already exists between these clubs.',
      };
    }

    const challengeId = `cchal_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const targetWins = Math.max(1, Math.min(7, Math.floor(Number(input.targetWins ?? 3) || 3)));
    const ruleProfileId: RuleProfileId = input.ruleProfileId === 'wpa' ? 'wpa' : 'casual';
    const calledShotsEnabled = Boolean(input.calledShotsEnabled);
    const notes = sanitizeClubText(input.notes ?? '', 140);
    const expiresAtMs = now + 72 * 60 * 60 * 1000;

    await db
      .prepare(
        `INSERT INTO club_challenges (
          challenge_id, challenger_club_id, target_club_id, created_by_player_id,
          rule_profile_id, called_shots_enabled, target_wins,
          challenger_score, target_score, status, notes, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', ?, ?, ?)`,
      )
      .bind(
        challengeId,
        challengerClubId,
        targetClubId,
        actorId,
        ruleProfileId,
        calledShotsEnabled ? 1 : 0,
        targetWins,
        notes,
        now,
        expiresAtMs,
      )
      .run();

    await this.logActivity(
      db,
      challengerClubId,
      actorId,
      null,
      'challenge_sent',
      `Challenged [${String(tClub.tag)}] ${String(tClub.name)} (First to ${targetWins}).`,
      now,
    );

    const challenge = (await this.getChallengeById(challengeId))!;
    return { ok: true, challenge };
  }

  public async respondChallenge(
    actorId: string,
    challengeId: string,
    action: 'accept' | 'decline' | 'cancel',
  ): Promise<{ ok: true; challenge: ClubChallengeRecord } | ClubServiceError> {
    const db = await this.ensureSchema();
    const now = Date.now();
    await this.expirePendingData(db, now);

    const row = await db
      .prepare('SELECT * FROM club_challenges WHERE challenge_id = ? LIMIT 1')
      .bind(challengeId)
      .first<Record<string, unknown>>();
    if (!row) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Club challenge not found.' };
    }

    const challengerClubId = String(row.challenger_club_id);
    const targetClubId = String(row.target_club_id);
    const actorClub = await db
      .prepare('SELECT club_id, role FROM club_members WHERE player_id = ? LIMIT 1')
      .bind(actorId)
      .first<{ club_id: string; role: string }>();

    if (!actorClub || !isClubOfficerRole(sanitizeRole(actorClub.role))) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only club officers can respond to club challenges.',
      };
    }

    if (action === 'cancel') {
      if (actorClub.club_id !== challengerClubId) {
        return {
          ok: false,
          status: 403,
          code: 'UNAUTHORIZED',
          message: 'Only officers from the challenging club can cancel.',
        };
      }
      if (row.status !== 'pending' && row.status !== 'accepted') {
        return { ok: false, status: 409, code: 'CONFLICT', message: 'Challenge cannot be cancelled now.' };
      }
      await db
        .prepare(
          `UPDATE club_challenges SET status = 'cancelled', responded_at_ms = ?, completed_at_ms = ? WHERE challenge_id = ?`,
        )
        .bind(now, now, challengeId)
        .run();
      return { ok: true, challenge: (await this.getChallengeById(challengeId))! };
    }

    if (actorClub.club_id !== targetClubId) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED',
        message: 'Only officers from the challenged club can accept or decline.',
      };
    }
    if (row.status !== 'pending') {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: `Challenge is already ${String(row.status)}.`,
      };
    }

    const nextStatus: ClubChallengeStatus = action === 'accept' ? 'accepted' : 'declined';
    await db
      .prepare(
        `UPDATE club_challenges SET status = ?, responded_at_ms = ?, completed_at_ms = ? WHERE challenge_id = ?`,
      )
      .bind(nextStatus, now, action === 'decline' ? now : null, challengeId)
      .run();

    const updated = (await this.getChallengeById(challengeId))!;
    if (action === 'accept') {
      await this.logActivity(
        db,
        targetClubId,
        actorId,
        null,
        'challenge_accepted',
        `Accepted club challenge vs [${updated.challengerClubTag}] ${updated.challengerClubName}.`,
        now,
      );
      await this.logActivity(
        db,
        challengerClubId,
        actorId,
        null,
        'challenge_accepted',
        `[${updated.targetClubTag}] ${updated.targetClubName} accepted the club challenge.`,
        now,
      );
    }

    return { ok: true, challenge: updated };
  }

  public async recordVerifiedMatchForChallenge(params: {
    challengeId: string;
    matchId: string;
    actorId?: string | null;
  }): Promise<{ ok: true; challenge: ClubChallengeRecord; newlyCompleted: boolean } | ClubServiceError> {
    const db = await this.ensureSchema();
    const chal = await db
      .prepare('SELECT * FROM club_challenges WHERE challenge_id = ? LIMIT 1')
      .bind(params.challengeId)
      .first<Record<string, unknown>>();
    if (!chal) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Club challenge not found.' };
    }
    if (chal.status !== 'accepted' && chal.status !== 'in_progress') {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: 'Challenge is not currently active.',
      };
    }

    const matchRow = await db
      .prepare('SELECT * FROM matches WHERE match_id = ? LIMIT 1')
      .bind(params.matchId.trim())
      .first<Record<string, unknown>>();
    if (!matchRow || matchRow.completion_type === 'abandoned' || !matchRow.winner_id) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Verified completed match record not found.',
      };
    }

    const p1Id = String(matchRow.player1_id);
    const p2Id = String(matchRow.player2_id);
    const winnerId = String(matchRow.winner_id);

    if (params.actorId && params.actorId !== p1Id && params.actorId !== p2Id) {
      const actorMem = await db
        .prepare('SELECT club_id, role FROM club_members WHERE player_id = ? LIMIT 1')
        .bind(params.actorId)
        .first<{ club_id: string; role: string }>();
      const validClub =
        actorMem &&
        (actorMem.club_id === String(chal.challenger_club_id) ||
          actorMem.club_id === String(chal.target_club_id));
      if (!validClub) {
        return { ok: false, status: 403, code: 'UNAUTHORIZED', message: 'Not authorized for this challenge.' };
      }
    }

    const [m1, m2] = await Promise.all([
      db.prepare('SELECT club_id FROM club_members WHERE player_id = ? LIMIT 1').bind(p1Id).first<{ club_id: string }>(),
      db.prepare('SELECT club_id FROM club_members WHERE player_id = ? LIMIT 1').bind(p2Id).first<{ club_id: string }>(),
    ]);

    const cClubId = String(chal.challenger_club_id);
    const tClubId = String(chal.target_club_id);
    const validOpposingPair =
      (m1?.club_id === cClubId && m2?.club_id === tClubId) ||
      (m1?.club_id === tClubId && m2?.club_id === cClubId);

    if (!validOpposingPair) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Match must be played between members of the two challenged clubs.',
      };
    }

    const winnerClubId = winnerId === p1Id ? m1!.club_id : m2!.club_id;
    const now = Date.now();
    const insertRes = await db
      .prepare(
        `INSERT OR IGNORE INTO club_challenge_matches (challenge_id, match_id, winner_club_id, recorded_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(params.challengeId, params.matchId.trim(), winnerClubId, now)
      .run();

    if ((insertRes.meta?.changes ?? 0) === 0) {
      return {
        ok: true,
        challenge: (await this.getChallengeById(params.challengeId))!,
        newlyCompleted: false,
      };
    }

    const nextC = Number(chal.challenger_score) + (winnerClubId === cClubId ? 1 : 0);
    const nextT = Number(chal.target_score) + (winnerClubId === tClubId ? 1 : 0);
    const targetWins = Number(chal.target_wins);

    const reachedWinner =
      nextC >= targetWins ? cClubId : nextT >= targetWins ? tClubId : null;
    const nextStatus: ClubChallengeStatus = reachedWinner ? 'completed' : 'in_progress';

    await db
      .prepare(
        `UPDATE club_challenges
         SET challenger_score = ?, target_score = ?, status = ?, winner_club_id = ?, completed_at_ms = ?
         WHERE challenge_id = ?`,
      )
      .bind(
        nextC,
        nextT,
        nextStatus,
        reachedWinner,
        reachedWinner ? now : null,
        params.challengeId,
      )
      .run();

    if (reachedWinner) {
      await Promise.all([
        this.recomputeClubAggregates(db, cClubId),
        this.recomputeClubAggregates(db, tClubId),
      ]);
      const hydrated = (await this.getChallengeById(params.challengeId))!;
      const winLabel =
        reachedWinner === cClubId
          ? `[${hydrated.challengerClubTag}] ${hydrated.challengerClubName}`
          : `[${hydrated.targetClubTag}] ${hydrated.targetClubName}`;
      await this.logActivity(
        db,
        cClubId,
        winnerId,
        null,
        'challenge_completed',
        `${winLabel} won the club challenge (${nextC}-${nextT}).`,
        now,
      );
      await this.logActivity(
        db,
        tClubId,
        winnerId,
        null,
        'challenge_completed',
        `${winLabel} won the club challenge (${nextC}-${nextT}).`,
        now,
      );
      return { ok: true, challenge: hydrated, newlyCompleted: true };
    }

    return {
      ok: true,
      challenge: (await this.getChallengeById(params.challengeId))!,
      newlyCompleted: false,
    };
  }

  public async autoLinkMatchToActiveChallenge(params: {
    matchId: string;
    player1Id: string;
    player2Id: string;
  }): Promise<ClubChallengeRecord | null> {
    const db = await this.ensureSchema();
    const [m1, m2] = await Promise.all([
      db.prepare('SELECT club_id FROM club_members WHERE player_id = ? LIMIT 1').bind(params.player1Id).first<{ club_id: string }>(),
      db.prepare('SELECT club_id FROM club_members WHERE player_id = ? LIMIT 1').bind(params.player2Id).first<{ club_id: string }>(),
    ]);
    if (!m1 || !m2 || m1.club_id === m2.club_id) return null;

    const chal = await db
      .prepare(
        `SELECT challenge_id FROM club_challenges
         WHERE status IN ('accepted', 'in_progress')
           AND ((challenger_club_id = ? AND target_club_id = ?) OR (challenger_club_id = ? AND target_club_id = ?))
         ORDER BY created_at_ms DESC
         LIMIT 1`,
      )
      .bind(m1.club_id, m2.club_id, m2.club_id, m1.club_id)
      .first<{ challenge_id: string }>();

    if (!chal) return null;
    const res = await this.recordVerifiedMatchForChallenge({
      challengeId: chal.challenge_id,
      matchId: params.matchId,
    });
    return res.ok ? res.challenge : null;
  }

  public async getChallengeById(challengeId: string): Promise<ClubChallengeRecord | null> {
    const db = await this.ensureSchema();
    const row = await db
      .prepare(
        `SELECT ch.*,
                cc.name AS c_name, cc.tag AS c_tag,
                tc.name AS t_name, tc.tag AS t_tag
         FROM club_challenges ch
         JOIN clubs cc ON cc.club_id = ch.challenger_club_id
         JOIN clubs tc ON tc.club_id = ch.target_club_id
         WHERE ch.challenge_id = ?
         LIMIT 1`,
      )
      .bind(challengeId)
      .first<Record<string, unknown>>();
    if (!row) return null;

    const mRows = await db
      .prepare('SELECT match_id FROM club_challenge_matches WHERE challenge_id = ? ORDER BY recorded_at_ms ASC')
      .bind(challengeId)
      .all<{ match_id: string }>();

    return {
      challengeId: String(row.challenge_id),
      challengerClubId: String(row.challenger_club_id),
      challengerClubName: String(row.c_name),
      challengerClubTag: String(row.c_tag),
      targetClubId: String(row.target_club_id),
      targetClubName: String(row.t_name),
      targetClubTag: String(row.t_tag),
      createdByPlayerId: String(row.created_by_player_id),
      ruleProfileId: row.rule_profile_id === 'wpa' ? 'wpa' : 'casual',
      calledShotsEnabled: Number(row.called_shots_enabled) === 1,
      targetWins: Number(row.target_wins),
      challengerScore: Number(row.challenger_score),
      targetScore: Number(row.target_score),
      status: String(row.status) as ClubChallengeStatus,
      winnerClubId: row.winner_club_id ? String(row.winner_club_id) : null,
      activeRoomId: row.active_room_id ? String(row.active_room_id) : null,
      activeRoomCode: row.active_room_code ? String(row.active_room_code) : null,
      linkedMatchIds: (mRows.results ?? []).map((m) => String(m.match_id)),
      notes: String(row.notes ?? ''),
      createdAtMs: Number(row.created_at_ms),
      expiresAtMs: Number(row.expires_at_ms),
      respondedAtMs:
        row.responded_at_ms !== null && row.responded_at_ms !== undefined
          ? Number(row.responded_at_ms)
          : null,
      completedAtMs:
        row.completed_at_ms !== null && row.completed_at_ms !== undefined
          ? Number(row.completed_at_ms)
          : null,
    };
  }

  public async getChallengesForClub(clubId: string): Promise<ClubChallengeRecord[]> {
    const db = await this.ensureSchema();
    const now = Date.now();
    await this.expirePendingData(db, now);

    const rows = await db
      .prepare(
        `SELECT challenge_id FROM club_challenges
         WHERE challenger_club_id = ? OR target_club_id = ?
         ORDER BY created_at_ms DESC
         LIMIT 25`,
      )
      .bind(clubId, clubId)
      .all<{ challenge_id: string }>();

    const out: ClubChallengeRecord[] = [];
    for (const r of rows.results ?? []) {
      const ch = await this.getChallengeById(String(r.challenge_id));
      if (ch) out.push(ch);
    }
    return out;
  }

  private async expirePendingData(db: ProgressionSqlDb, now: number): Promise<void> {
    await db
      .prepare(
        `UPDATE club_invitations SET status = 'expired', responded_at_ms = ?
         WHERE status = 'pending' AND expires_at_ms <= ?`,
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        `UPDATE club_challenges SET status = 'expired', completed_at_ms = ?
         WHERE status = 'pending' AND expires_at_ms <= ?`,
      )
      .bind(now, now)
      .run();
  }
}
