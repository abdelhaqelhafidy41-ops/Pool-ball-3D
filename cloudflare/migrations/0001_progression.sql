-- ULTIMATE POOL 3D — Phase 5 Competitive Progression Schema (Cloudflare D1)

CREATE TABLE IF NOT EXISTS players (
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
);

CREATE TABLE IF NOT EXISTS matches (
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
);

CREATE TABLE IF NOT EXISTS player_achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  unlocked_at_ms INTEGER NOT NULL,
  match_id TEXT,
  UNIQUE(player_id, achievement_id)
);

CREATE TABLE IF NOT EXISTS rating_events (
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
);

CREATE INDEX IF NOT EXISTS idx_players_leaderboard
  ON players (elo DESC, wins DESC, total_matches ASC, created_at_ms ASC);

CREATE INDEX IF NOT EXISTS idx_players_username_lower
  ON players (username_lower);

CREATE INDEX IF NOT EXISTS idx_players_display_name
  ON players (display_name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_matches_ended_at
  ON matches (ended_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_matches_player1
  ON matches (player1_id, ended_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_matches_player2
  ON matches (player2_id, ended_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_achievements_player
  ON player_achievements (player_id, unlocked_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_rating_events_window
  ON rating_events (created_at_ms, player_id);
