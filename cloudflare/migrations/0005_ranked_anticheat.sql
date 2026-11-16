-- ULTIMATE POOL 3D — Phase 10: Global ELO Ranking, Seasons, Ranked Matchmaking & Anti-Cheat
-- Applies cleanly on top of 0001_progression.sql .. 0004_tournaments.sql.

ALTER TABLE players ADD COLUMN ranked_matches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN ranked_wins INTEGER NOT NULL DEFAULT 0;

ALTER TABLE matches ADD COLUMN season_id TEXT;

ALTER TABLE rating_events ADD COLUMN season_id TEXT;
ALTER TABLE rating_events ADD COLUMN k_factor INTEGER NOT NULL DEFAULT 24;
ALTER TABLE rating_events ADD COLUMN expected_score REAL NOT NULL DEFAULT 0.5;
ALTER TABLE rating_events ADD COLUMN opponent_id TEXT;
ALTER TABLE rating_events ADD COLUMN opponent_elo_before INTEGER;
ALTER TABLE rating_events ADD COLUMN rank_before TEXT;
ALTER TABLE rating_events ADD COLUMN rank_after TEXT;
ALTER TABLE rating_events ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'quick';

CREATE TABLE IF NOT EXISTS competitive_seasons (
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
);

CREATE TABLE IF NOT EXISTS player_season_stats (
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
);

CREATE TABLE IF NOT EXISTS ranked_matchmaking_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'global',
  wait_ms INTEGER NOT NULL,
  elo_gap INTEGER NOT NULL DEFAULT 0,
  matched_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS match_integrity_audit (
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
);

CREATE TABLE IF NOT EXISTS anticheat_flags (
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
);

CREATE TABLE IF NOT EXISTS player_penalties (
  penalty_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  penalty_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER,
  revoked_by TEXT
);

CREATE TABLE IF NOT EXISTS penalty_appeals (
  appeal_id TEXT PRIMARY KEY,
  penalty_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_notes TEXT,
  reviewed_by TEXT,
  submitted_at_ms INTEGER NOT NULL,
  reviewed_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS moderation_audit_log (
  audit_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_player_id TEXT NOT NULL,
  reference_id TEXT,
  details_json TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_competitive_seasons_status ON competitive_seasons (status, season_number DESC);
CREATE INDEX IF NOT EXISTS idx_player_season_stats_lb ON player_season_stats (season_id, season_elo DESC, wins DESC, matches_played ASC);
CREATE INDEX IF NOT EXISTS idx_ranked_metrics_mode_time ON ranked_matchmaking_metrics (mode, matched_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_anticheat_flags_player_status ON anticheat_flags (player_id, status, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_player_penalties_active ON player_penalties (player_id, revoked_at_ms, issued_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_penalty_appeals_player ON penalty_appeals (player_id, submitted_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_moderation_audit_target ON moderation_audit_log (target_player_id, created_at_ms DESC);
