-- ULTIMATE POOL 3D Phase 9: Global Tournaments & Championships System
-- Applies cleanly on top of 0001_progression.sql, 0002_social.sql, and 0003_economy.sql.

CREATE TABLE IF NOT EXISTS tournaments (
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
);

CREATE TABLE IF NOT EXISTS tournament_participants (
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
);

CREATE TABLE IF NOT EXISTS tournament_matches (
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
);

CREATE TABLE IF NOT EXISTS tournament_payouts (
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
);

CREATE TABLE IF NOT EXISTS tournament_trophies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  trophy_id TEXT NOT NULL,
  tournament_id TEXT NOT NULL,
  tournament_title TEXT NOT NULL,
  unlocked_at_ms INTEGER NOT NULL,
  UNIQUE(player_id, trophy_id)
);

CREATE TABLE IF NOT EXISTS tournament_player_stats (
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
);

CREATE TABLE IF NOT EXISTS tournament_events (
  event_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_player_id TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tournaments_status_starts ON tournaments (status, starts_at_ms ASC);
CREATE INDEX IF NOT EXISTS idx_tournaments_invite ON tournaments (invite_code);
CREATE INDEX IF NOT EXISTS idx_tourn_participants_player ON tournament_participants (player_id, joined_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_tourn_matches_tournament ON tournament_matches (tournament_id, round_number ASC, slot_index ASC);
CREATE INDEX IF NOT EXISTS idx_tourn_matches_room ON tournament_matches (room_id);
CREATE INDEX IF NOT EXISTS idx_tourn_payouts_player ON tournament_payouts (player_id, awarded_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_tourn_trophies_player ON tournament_trophies (player_id, unlocked_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_tourn_stats_rank ON tournament_player_stats (championships DESC, finals_appearances DESC, matches_won DESC);
CREATE INDEX IF NOT EXISTS idx_tourn_events_tourn ON tournament_events (tournament_id, created_at_ms DESC);
