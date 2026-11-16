import type { PlayerId } from '../../src/game/rules/types';
import type { MatchCompletionType, OnlineMatchType } from '../../src/multiplayer/shared/progression';
import type {
  PenaltyAppealRecord,
  PenaltyAppealStatus,
  PenaltyType,
  PlayerModerationStatus,
  PlayerPenaltyRecord,
} from '../../src/multiplayer/shared/ranked';
import type { ProgressionSqlDb } from './D1ProgressionService';

export const ANTICHEAT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS match_integrity_audit (
    match_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    match_mode TEXT NOT NULL,
    player1_id TEXT NOT NULL,
    player2_id TEXT NOT NULL,
    winner_id TEXT,
    completion_type TEXT NOT NULL,
    total_shots INTEGER NOT NULL DEFAULT 0,
    duration_sec INTEGER NOT NULL DEFAULT 0,
    p1_rejected_inputs INTEGER NOT NULL DEFAULT 0,
    p2_rejected_inputs INTEGER NOT NULL DEFAULT 0,
    min_shot_interval_ms INTEGER,
    flagged INTEGER NOT NULL DEFAULT 0,
    flag_reasons_json TEXT,
    audited_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS anticheat_flags (
    flag_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    match_id TEXT,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    action_recommended TEXT NOT NULL DEFAULT 'manual_review',
    evidence_summary TEXT NOT NULL,
    metadata_json TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    reviewed_by TEXT,
    reviewed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS player_penalties (
    penalty_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    penalty_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    issued_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    revoked_at_ms INTEGER,
    revoked_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS penalty_appeals (
    appeal_id TEXT PRIMARY KEY,
    penalty_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_notes TEXT,
    reviewed_by TEXT,
    submitted_at_ms INTEGER NOT NULL,
    reviewed_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS moderation_audit_log (
    audit_id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_player_id TEXT NOT NULL,
    reference_id TEXT,
    details_json TEXT,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_anticheat_flags_player_status ON anticheat_flags (player_id, status, created_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_player_penalties_active ON player_penalties (player_id, revoked_at_ms, issued_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_penalty_appeals_player ON penalty_appeals (player_id, submitted_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_moderation_audit_target ON moderation_audit_log (target_player_id, created_at_ms DESC)`,
];

// Strictly private internal thresholds — NEVER return or serialize to public client endpoints.
const INTERNAL_ANTI_CHEAT_THRESHOLDS = {
  winTradeWindowMs: 24 * 60 * 60 * 1000,
  winTradePairMatchCount: 4,
  rapidForfeitWindowMs: 6 * 60 * 60 * 1000,
  rapidForfeitBurstCount: 3,
  rapidForfeitMaxShots: 1,
  ultraShortMatchSec: 8,
  statisticalStreakReviewThreshold: 12,
  tamperInputWarnThreshold: 3,
  tamperInputRestrictThreshold: 6,
  tamperRankedRestrictionDurationMs: 24 * 60 * 60 * 1000,
} as const;

const VALID_PENALTY_TYPES = new Set<PenaltyType>([
  'warning',
  'ranked_restriction',
  'temp_suspension',
  'permanent_suspension',
]);

interface PenaltyDbRow {
  penalty_id: string;
  player_id: string;
  penalty_type: string;
  reason: string;
  issued_by: string;
  issued_at_ms: number;
  expires_at_ms: number | null;
  revoked_at_ms: number | null;
  revoked_by: string | null;
}

interface AppealDbRow {
  appeal_id: string;
  penalty_id: string;
  player_id: string;
  message: string;
  status: string;
  admin_notes: string | null;
  reviewed_by: string | null;
  submitted_at_ms: number;
  reviewed_at_ms: number | null;
}

export interface AntiCheatMatchInspectionInput {
  matchId: string;
  roomId: string;
  matchMode: OnlineMatchType;
  player1Id: string;
  player2Id: string;
  winnerRole: PlayerId;
  winnerId: string;
  completionType: MatchCompletionType;
  totalShots: number;
  durationSec: number;
  p1RejectedInputs: number;
  p2RejectedInputs: number;
  minShotIntervalMs: number | null;
  p1WinStreakAfter: number;
  p2WinStreakAfter: number;
  endedAtMs: number;
}

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export class AntiCheatService {
  private static readonly bootstrappedDbs = new WeakSet<object>();

  constructor(private readonly db: ProgressionSqlDb | D1Database | undefined) {}

  public async ensureSchema(): Promise<ProgressionSqlDb> {
    if (!this.db) {
      throw new Error('Anti-cheat database is not configured.');
    }
    const db = this.db as unknown as ProgressionSqlDb;
    if (!AntiCheatService.bootstrappedDbs.has(this.db)) {
      for (const stmt of ANTICHEAT_SCHEMA_STATEMENTS) {
        await db.prepare(stmt).run();
      }
      AntiCheatService.bootstrappedDbs.add(this.db);
    }
    return db;
  }

  private mapPenalty(row: PenaltyDbRow, nowMs: number): PlayerPenaltyRecord {
    const expired =
      row.expires_at_ms !== null &&
      row.expires_at_ms !== undefined &&
      Number(row.expires_at_ms) <= nowMs;
    const revoked = row.revoked_at_ms !== null && row.revoked_at_ms !== undefined;
    return {
      penaltyId: String(row.penalty_id),
      playerId: String(row.player_id),
      penaltyType: String(row.penalty_type) as PenaltyType,
      reason: String(row.reason),
      issuedBy: String(row.issued_by),
      issuedAtMs: Number(row.issued_at_ms),
      expiresAtMs:
        row.expires_at_ms !== null && row.expires_at_ms !== undefined
          ? Number(row.expires_at_ms)
          : null,
      revokedAtMs: revoked ? Number(row.revoked_at_ms) : null,
      active: !revoked && !expired && row.penalty_type !== 'warning',
    };
  }

  private mapAppeal(row: AppealDbRow): PenaltyAppealRecord {
    return {
      appealId: String(row.appeal_id),
      penaltyId: String(row.penalty_id),
      playerId: String(row.player_id),
      message: String(row.message),
      status: String(row.status) as PenaltyAppealStatus,
      adminNotes: row.admin_notes ? String(row.admin_notes) : null,
      submittedAtMs: Number(row.submitted_at_ms),
      reviewedAtMs:
        row.reviewed_at_ms !== null && row.reviewed_at_ms !== undefined
          ? Number(row.reviewed_at_ms)
          : null,
    };
  }

  private async logAudit(
    db: ProgressionSqlDb,
    actor: string,
    action: string,
    targetPlayerId: string,
    referenceId: string | null,
    details: Record<string, unknown>,
    nowMs: number,
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO moderation_audit_log (
          audit_id, actor, action, target_player_id, reference_id, details_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        genId('aud'),
        actor,
        action,
        targetPlayerId,
        referenceId,
        JSON.stringify(details),
        nowMs,
      )
      .run();
  }

  private async createFlag(
    db: ProgressionSqlDb,
    params: {
      playerId: string;
      matchId: string | null;
      category: string;
      severity: 'low' | 'medium' | 'high';
      actionRecommended: 'manual_review' | 'warning' | 'ranked_restriction';
      evidenceSummary: string;
      metadata?: Record<string, unknown>;
      createdAtMs: number;
    },
  ): Promise<string> {
    const flagId = genId('flg');
    await db
      .prepare(
        `INSERT INTO anticheat_flags (
          flag_id, player_id, match_id, category, severity, action_recommended,
          evidence_summary, metadata_json, status, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .bind(
        flagId,
        params.playerId,
        params.matchId,
        params.category,
        params.severity,
        params.actionRecommended,
        params.evidenceSummary,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.createdAtMs,
      )
      .run();
    return flagId;
  }

  public async getPlayerRestriction(
    playerId: string,
    nowMs: number = Date.now(),
  ): Promise<{
    blockedFromOnline: boolean;
    blockedFromRanked: boolean;
    activePenalties: PlayerPenaltyRecord[];
  }> {
    const db = await this.ensureSchema();
    const rows = await db
      .prepare(
        `SELECT * FROM player_penalties
         WHERE player_id = ? AND revoked_at_ms IS NULL
           AND (expires_at_ms IS NULL OR expires_at_ms > ?)
         ORDER BY issued_at_ms DESC`,
      )
      .bind(playerId, nowMs)
      .all<PenaltyDbRow>();

    const activePenalties = (rows.results ?? [])
      .map((r) => this.mapPenalty(r, nowMs))
      .filter((p) => p.active);

    const blockedFromOnline = activePenalties.some(
      (p) => p.penaltyType === 'temp_suspension' || p.penaltyType === 'permanent_suspension',
    );
    const blockedFromRanked =
      blockedFromOnline || activePenalties.some((p) => p.penaltyType === 'ranked_restriction');

    return {
      blockedFromOnline,
      blockedFromRanked,
      activePenalties,
    };
  }

  public async inspectCompletedMatch(input: AntiCheatMatchInspectionInput): Promise<{
    flagged: boolean;
    reasons: string[];
  }> {
    const db = await this.ensureSchema();
    const now = input.endedAtMs;

    const existingAudit = await db
      .prepare('SELECT match_id, flagged, flag_reasons_json FROM match_integrity_audit WHERE match_id = ? LIMIT 1')
      .bind(input.matchId)
      .first<{ match_id: string; flagged: number; flag_reasons_json: string | null }>();
    if (existingAudit) {
      let reasons: string[] = [];
      try {
        if (existingAudit.flag_reasons_json) reasons = JSON.parse(existingAudit.flag_reasons_json);
      } catch {
        reasons = [];
      }
      return { flagged: Number(existingAudit.flagged) === 1, reasons };
    }

    const flagReasons: string[] = [];

    // 1. Concrete input tamper rejection burst (never permanent ban; capped at warning / temp ranked restriction)
    const tamperChecks: Array<{ pid: string; count: number }> = [
      { pid: input.player1Id, count: Math.max(0, Math.floor(input.p1RejectedInputs)) },
      { pid: input.player2Id, count: Math.max(0, Math.floor(input.p2RejectedInputs)) },
    ];
    for (const check of tamperChecks) {
      if (check.count >= INTERNAL_ANTI_CHEAT_THRESHOLDS.tamperInputWarnThreshold) {
        const highBurst = check.count >= INTERNAL_ANTI_CHEAT_THRESHOLDS.tamperInputRestrictThreshold;
        flagReasons.push(`rejected_tamper_inputs:${check.pid}`);
        await this.createFlag(db, {
          playerId: check.pid,
          matchId: input.matchId,
          category: 'tampered_input_burst',
          severity: highBurst ? 'high' : 'medium',
          actionRecommended: highBurst ? 'ranked_restriction' : 'manual_review',
          evidenceSummary: 'Multiple invalid or out-of-bounds match payloads were rejected by server validation.',
          metadata: { rejectedInputs: check.count, matchMode: input.matchMode },
          createdAtMs: now,
        });
        if (highBurst) {
          await this.issuePenalty({
            playerId: check.pid,
            penaltyType: 'ranked_restriction',
            reason: 'Repeated invalid or tampered match input payloads rejected by server.',
            issuedBy: 'anticheat_system',
            isAdmin: false,
            durationMs: INTERNAL_ANTI_CHEAT_THRESHOLDS.tamperRankedRestrictionDurationMs,
            nowMs: now,
          });
        }
      }
    }

    // 2. Rapid forfeit / match abandonment pattern (manual_review ONLY — never auto-ban)
    if (
      (input.completionType === 'forfeit' ||
        input.completionType === 'disconnect_forfeit' ||
        input.completionType === 'abandoned') &&
      input.totalShots <= INTERNAL_ANTI_CHEAT_THRESHOLDS.rapidForfeitMaxShots
    ) {
      const loserId = input.winnerRole === 'player1' ? input.player2Id : input.player1Id;
      const sinceMs = now - INTERNAL_ANTI_CHEAT_THRESHOLDS.rapidForfeitWindowMs;
      const rapidCountRow = await db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM match_integrity_audit
           WHERE (player1_id = ? OR player2_id = ?)
             AND winner_id != ?
             AND total_shots <= ?
             AND (completion_type = 'forfeit' OR completion_type = 'disconnect_forfeit' OR completion_type = 'abandoned')
             AND audited_at_ms >= ?`,
        )
        .bind(
          loserId,
          loserId,
          loserId,
          INTERNAL_ANTI_CHEAT_THRESHOLDS.rapidForfeitMaxShots,
          sinceMs,
        )
        .first<{ cnt: number }>();

      const recentRapid = Number(rapidCountRow?.cnt ?? 0) + 1;
      if (recentRapid >= INTERNAL_ANTI_CHEAT_THRESHOLDS.rapidForfeitBurstCount) {
        flagReasons.push(`rapid_forfeit_pattern:${loserId}`);
        await this.createFlag(db, {
          playerId: loserId,
          matchId: input.matchId,
          category: 'rapid_forfeit_pattern',
          severity: 'medium',
          actionRecommended: 'manual_review',
          evidenceSummary: 'Repeated low-shot forfeits detected in a short window; queued for moderation review.',
          metadata: { countInWindow: recentRapid },
          createdAtMs: now,
        });
      }
    }

    // 3. Win-trading pair heuristic in 24h window (manual_review ONLY — never auto-ban)
    const pairSinceMs = now - INTERNAL_ANTI_CHEAT_THRESHOLDS.winTradeWindowMs;
    const pairRows = await db
      .prepare(
        `SELECT COUNT(*) AS cnt,
                SUM(CASE WHEN winner_id = ? THEN 1 ELSE 0 END) AS p1_wins,
                SUM(CASE WHEN winner_id = ? THEN 1 ELSE 0 END) AS p2_wins
         FROM match_integrity_audit
         WHERE ((player1_id = ? AND player2_id = ?) OR (player1_id = ? AND player2_id = ?))
           AND audited_at_ms >= ?`,
      )
      .bind(
        input.player1Id,
        input.player2Id,
        input.player1Id,
        input.player2Id,
        input.player2Id,
        input.player1Id,
        pairSinceMs,
      )
      .first<{ cnt: number; p1_wins: number; p2_wins: number }>();

    const pairMatches = Number(pairRows?.cnt ?? 0) + 1;
    if (pairMatches >= INTERNAL_ANTI_CHEAT_THRESHOLDS.winTradePairMatchCount) {
      const suspectPlayer = input.winnerId;
      flagReasons.push(`win_trade_pair_review:${suspectPlayer}`);
      await this.createFlag(db, {
        playerId: suspectPlayer,
        matchId: input.matchId,
        category: 'win_trade_suspect',
        severity: 'medium',
        actionRecommended: 'manual_review',
        evidenceSummary: 'High frequency of matches against the same opponent within 24 hours; queued for review.',
        metadata: { pairMatches, matchMode: input.matchMode },
        createdAtMs: now,
      });
    }

    // 4. Ultra-short match anomaly (manual_review ONLY)
    if (
      input.totalShots >= 2 &&
      input.durationSec > 0 &&
      input.durationSec < INTERNAL_ANTI_CHEAT_THRESHOLDS.ultraShortMatchSec &&
      input.completionType !== 'forfeit'
    ) {
      flagReasons.push(`ultra_short_match:${input.winnerId}`);
      await this.createFlag(db, {
        playerId: input.winnerId,
        matchId: input.matchId,
        category: 'ultra_short_match',
        severity: 'low',
        actionRecommended: 'manual_review',
        evidenceSummary: 'Completed match elapsed unusually quickly relative to shot count.',
        metadata: { durationSec: input.durationSec, totalShots: input.totalShots },
        createdAtMs: now,
      });
    }

    // 5. Statistical high streak anomaly (strictly manual_review ONLY — NEVER auto-ban!)
    let winnerStreak =
      input.winnerRole === 'player1' ? input.p1WinStreakAfter : input.p2WinStreakAfter;
    if (winnerStreak === 0 && input.winnerId) {
      try {
        const streakRow = await db
          .prepare('SELECT current_streak FROM players WHERE player_id = ? LIMIT 1')
          .bind(input.winnerId)
          .first<{ current_streak: number }>();
        if (streakRow) {
          winnerStreak = Number(streakRow.current_streak ?? 0);
        }
      } catch {
        // Safe when players table isn't initialized in isolated unit test
      }
    }
    if (winnerStreak >= INTERNAL_ANTI_CHEAT_THRESHOLDS.statisticalStreakReviewThreshold) {
      flagReasons.push(`statistical_win_streak:${input.winnerId}`);
      await this.createFlag(db, {
        playerId: input.winnerId,
        matchId: input.matchId,
        category: 'statistical_anomaly_streak',
        severity: 'low',
        actionRecommended: 'manual_review',
        evidenceSummary: 'Statistical win streak milestone reached; logged for routine fair-play review only.',
        metadata: { streak: winnerStreak },
        createdAtMs: now,
      });
    }

    const flagged = flagReasons.length > 0 ? 1 : 0;
    await db
      .prepare(
        `INSERT OR IGNORE INTO match_integrity_audit (
          match_id, room_id, match_mode, player1_id, player2_id, winner_id,
          completion_type, total_shots, duration_sec,
          p1_rejected_inputs, p2_rejected_inputs, min_shot_interval_ms,
          flagged, flag_reasons_json, audited_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.matchId,
        input.roomId,
        input.matchMode,
        input.player1Id,
        input.player2Id,
        input.winnerId,
        input.completionType,
        input.totalShots,
        input.durationSec,
        input.p1RejectedInputs,
        input.p2RejectedInputs,
        input.minShotIntervalMs,
        flagged,
        flagReasons.length > 0 ? JSON.stringify(flagReasons) : null,
        now,
      )
      .run();

    return {
      flagged: flagged === 1,
      reasons: flagReasons,
    };
  }

  public async issuePenalty(params: {
    playerId: string;
    penaltyType: PenaltyType;
    reason: string;
    issuedBy: string;
    isAdmin: boolean;
    durationMs?: number | null;
    nowMs?: number;
  }): Promise<
    | { ok: true; penalty: PlayerPenaltyRecord }
    | { ok: false; status: number; code: string; message: string }
  > {
    if (!VALID_PENALTY_TYPES.has(params.penaltyType)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid penalty type.' };
    }
    if (
      (params.penaltyType === 'permanent_suspension' || params.penaltyType === 'temp_suspension') &&
      !params.isAdmin
    ) {
      return {
        ok: false,
        status: 403,
        code: 'ADMIN_REQUIRED',
        message: 'Account suspensions require verified administrator authority.',
      };
    }
    const now = params.nowMs ?? Date.now();
    const reasonClean = String(params.reason ?? '').trim().slice(0, 280) || 'Fair play policy violation.';
    const expiresAtMs =
      params.penaltyType === 'permanent_suspension' || params.penaltyType === 'warning'
        ? null
        : typeof params.durationMs === 'number' && params.durationMs > 0
          ? now + Math.floor(params.durationMs)
          : null;

    const db = await this.ensureSchema();
    const penaltyId = genId('pen');
    await db
      .prepare(
        `INSERT INTO player_penalties (
          penalty_id, player_id, penalty_type, reason, issued_by, issued_at_ms, expires_at_ms, revoked_at_ms, revoked_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .bind(
        penaltyId,
        params.playerId,
        params.penaltyType,
        reasonClean,
        params.issuedBy,
        now,
        expiresAtMs,
      )
      .run();

    await this.logAudit(
      db,
      params.issuedBy,
      'issue_penalty',
      params.playerId,
      penaltyId,
      { penaltyType: params.penaltyType, expiresAtMs, reason: reasonClean },
      now,
    );

    const row = (await db
      .prepare('SELECT * FROM player_penalties WHERE penalty_id = ? LIMIT 1')
      .bind(penaltyId)
      .first<PenaltyDbRow>())!;

    return { ok: true, penalty: this.mapPenalty(row, now) };
  }

  public async revokePenalty(params: {
    penaltyId: string;
    adminActor: string;
    notes?: string;
    nowMs?: number;
  }): Promise<
    | { ok: true; penalty: PlayerPenaltyRecord }
    | { ok: false; status: number; code: string; message: string }
  > {
    const db = await this.ensureSchema();
    const now = params.nowMs ?? Date.now();
    const existing = await db
      .prepare('SELECT * FROM player_penalties WHERE penalty_id = ? LIMIT 1')
      .bind(params.penaltyId)
      .first<PenaltyDbRow>();
    if (!existing) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Penalty record not found.' };
    }

    await db
      .prepare('UPDATE player_penalties SET revoked_at_ms = ?, revoked_by = ? WHERE penalty_id = ?')
      .bind(now, params.adminActor, params.penaltyId)
      .run();

    await this.logAudit(
      db,
      params.adminActor,
      'revoke_penalty',
      String(existing.player_id),
      params.penaltyId,
      { notes: params.notes ?? null },
      now,
    );

    const updated = (await db
      .prepare('SELECT * FROM player_penalties WHERE penalty_id = ? LIMIT 1')
      .bind(params.penaltyId)
      .first<PenaltyDbRow>())!;
    return { ok: true, penalty: this.mapPenalty(updated, now) };
  }

  public async submitAppeal(params: {
    playerId: string;
    penaltyId: string;
    message: string;
    nowMs?: number;
  }): Promise<
    | { ok: true; appeal: PenaltyAppealRecord }
    | { ok: false; status: number; code: string; message: string }
  > {
    const db = await this.ensureSchema();
    const now = params.nowMs ?? Date.now();
    const penalty = await db
      .prepare('SELECT * FROM player_penalties WHERE penalty_id = ? LIMIT 1')
      .bind(params.penaltyId)
      .first<PenaltyDbRow>();
    if (!penalty || String(penalty.player_id) !== params.playerId) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Penalty record not found.' };
    }

    const cleanMessage = String(params.message ?? '').trim().slice(0, 600);
    if (cleanMessage.length < 5) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Appeal message must be at least 5 characters.',
      };
    }

    const existingPending = await db
      .prepare(
        `SELECT * FROM penalty_appeals WHERE penalty_id = ? AND player_id = ? AND status = 'pending' LIMIT 1`,
      )
      .bind(params.penaltyId, params.playerId)
      .first<AppealDbRow>();
    if (existingPending) {
      return {
        ok: false,
        status: 409,
        code: 'DUPLICATE_APPEAL',
        message: 'An appeal for this penalty is already pending review.',
      };
    }

    const appealId = genId('apl');
    await db
      .prepare(
        `INSERT INTO penalty_appeals (
          appeal_id, penalty_id, player_id, message, status, admin_notes, reviewed_by, submitted_at_ms, reviewed_at_ms
        ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
      )
      .bind(appealId, params.penaltyId, params.playerId, cleanMessage, now)
      .run();

    await this.logAudit(
      db,
      params.playerId,
      'submit_appeal',
      params.playerId,
      appealId,
      { penaltyId: params.penaltyId },
      now,
    );

    const created = (await db
      .prepare('SELECT * FROM penalty_appeals WHERE appeal_id = ? LIMIT 1')
      .bind(appealId)
      .first<AppealDbRow>())!;
    return { ok: true, appeal: this.mapAppeal(created) };
  }

  public async reviewAppeal(params: {
    appealId: string;
    adminActor: string;
    decision: 'approved' | 'rejected';
    adminNotes?: string;
    nowMs?: number;
  }): Promise<
    | { ok: true; appeal: PenaltyAppealRecord }
    | { ok: false; status: number; code: string; message: string }
  > {
    if (params.decision !== 'approved' && params.decision !== 'rejected') {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Invalid appeal decision.' };
    }
    const db = await this.ensureSchema();
    const now = params.nowMs ?? Date.now();
    const existing = await db
      .prepare('SELECT * FROM penalty_appeals WHERE appeal_id = ? LIMIT 1')
      .bind(params.appealId)
      .first<AppealDbRow>();
    if (!existing) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Appeal not found.' };
    }

    const notes = params.adminNotes?.trim().slice(0, 400) || null;
    await db
      .prepare(
        `UPDATE penalty_appeals
         SET status = ?, admin_notes = ?, reviewed_by = ?, reviewed_at_ms = ?
         WHERE appeal_id = ?`,
      )
      .bind(params.decision, notes, params.adminActor, now, params.appealId)
      .run();

    if (params.decision === 'approved') {
      await db
        .prepare(
          `UPDATE player_penalties
           SET revoked_at_ms = ?, revoked_by = ?
           WHERE penalty_id = ? AND revoked_at_ms IS NULL`,
        )
        .bind(now, params.adminActor, existing.penalty_id)
        .run();
    }

    await this.logAudit(
      db,
      params.adminActor,
      `appeal_${params.decision}`,
      String(existing.player_id),
      params.appealId,
      { penaltyId: existing.penalty_id, notes },
      now,
    );

    const updated = (await db
      .prepare('SELECT * FROM penalty_appeals WHERE appeal_id = ? LIMIT 1')
      .bind(params.appealId)
      .first<AppealDbRow>())!;
    return { ok: true, appeal: this.mapAppeal(updated) };
  }

  // Strictly sanitized player-facing view: NEVER leaks internal detection thresholds or cross-player intelligence.
  public async getPlayerModerationStatus(
    playerId: string,
    nowMs: number = Date.now(),
  ): Promise<PlayerModerationStatus> {
    const db = await this.ensureSchema();
    const [penaltiesRows, appealRows] = await Promise.all([
      db
        .prepare(
          `SELECT * FROM player_penalties WHERE player_id = ? ORDER BY issued_at_ms DESC LIMIT 20`,
        )
        .bind(playerId)
        .all<PenaltyDbRow>(),
      db
        .prepare(
          `SELECT * FROM penalty_appeals WHERE player_id = ? ORDER BY submitted_at_ms DESC LIMIT 20`,
        )
        .bind(playerId)
        .all<AppealDbRow>(),
    ]);

    const recentPenalties = (penaltiesRows.results ?? []).map((r) => this.mapPenalty(r, nowMs));
    const activePenalties = recentPenalties.filter((p) => p.active);
    const blockedFromOnline = activePenalties.some(
      (p) => p.penaltyType === 'temp_suspension' || p.penaltyType === 'permanent_suspension',
    );
    const blockedFromRanked =
      blockedFromOnline || activePenalties.some((p) => p.penaltyType === 'ranked_restriction');

    return {
      playerId,
      canPlayOnline: !blockedFromOnline,
      canPlayRanked: !blockedFromRanked,
      activePenalties,
      recentPenalties,
      appeals: (appealRows.results ?? []).map((a) => this.mapAppeal(a)),
    };
  }

  public async getAdminModerationQueue(limit = 50): Promise<{
    flags: Array<Record<string, unknown>>;
    penalties: Array<Record<string, unknown>>;
    appeals: Array<Record<string, unknown>>;
    auditLogs: Array<Record<string, unknown>>;
  }> {
    const db = await this.ensureSchema();
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const [flags, penalties, appeals, auditLogs] = await Promise.all([
      db
        .prepare(`SELECT * FROM anticheat_flags ORDER BY created_at_ms DESC LIMIT ?`)
        .bind(safeLimit)
        .all(),
      db
        .prepare(`SELECT * FROM player_penalties ORDER BY issued_at_ms DESC LIMIT ?`)
        .bind(safeLimit)
        .all(),
      db
        .prepare(`SELECT * FROM penalty_appeals ORDER BY submitted_at_ms DESC LIMIT ?`)
        .bind(safeLimit)
        .all(),
      db
        .prepare(`SELECT * FROM moderation_audit_log ORDER BY created_at_ms DESC LIMIT ?`)
        .bind(safeLimit)
        .all(),
    ]);

    return {
      flags: flags.results ?? [],
      penalties: penalties.results ?? [],
      appeals: appeals.results ?? [],
      auditLogs: auditLogs.results ?? [],
    };
  }
}
