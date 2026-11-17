-- Phase 11: Daily Missions, Weekly Challenges, Seasonal Progression & Battle Pass
-- Non-destructive migration reusing existing players, player_wallets, player_inventory, and coin_transactions.

CREATE TABLE IF NOT EXISTS battle_pass_seasons (
  season_id TEXT PRIMARY KEY,
  season_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  theme TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | completed
  starts_at_ms INTEGER NOT NULL,
  ends_at_ms INTEGER NOT NULL,
  duration_days INTEGER NOT NULL DEFAULT 30,
  premium_price_coins INTEGER NOT NULL DEFAULT 1200,
  max_level INTEGER NOT NULL DEFAULT 30,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bp_seasons_status ON battle_pass_seasons (status, season_number DESC);

CREATE TABLE IF NOT EXISTS player_battle_pass (
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
);

CREATE INDEX IF NOT EXISTS idx_player_bp_player ON player_battle_pass (player_id, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS player_missions (
  player_id TEXT NOT NULL,
  cadence TEXT NOT NULL, -- daily | weekly
  period_key TEXT NOT NULL, -- YYYY-MM-DD (UTC) or YYYY-WNN (ISO UTC)
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
);

CREATE INDEX IF NOT EXISTS idx_player_missions_lookup ON player_missions (player_id, cadence, period_key);

CREATE TABLE IF NOT EXISTS battle_pass_claims (
  season_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  track TEXT NOT NULL, -- free | premium
  coins_awarded INTEGER NOT NULL DEFAULT 0,
  item_id TEXT,
  claimed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (season_id, player_id, level, track)
);

CREATE INDEX IF NOT EXISTS idx_bp_claims_player ON battle_pass_claims (player_id, season_id);

CREATE TABLE IF NOT EXISTS xp_events (
  event_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  xp_amount INTEGER NOT NULL,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_xp_events_player ON xp_events (player_id, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS validated_ai_bp_matches (
  client_match_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  won INTEGER NOT NULL DEFAULT 0,
  xp_awarded INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_bp_matches_player ON validated_ai_bp_matches (player_id, created_at_ms DESC);
