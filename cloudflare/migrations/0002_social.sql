-- ULTIMATE POOL 3D — Phase 7 Social, Presence, Invitations & Chat Schema (Cloudflare D1)

CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_low_id TEXT NOT NULL,
  player_high_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER,
  UNIQUE(player_low_id, player_high_id)
);

CREATE TABLE IF NOT EXISTS player_blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS match_invitations (
  invite_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  room_id TEXT,
  room_code TEXT,
  rule_profile_id TEXT NOT NULL DEFAULT 'casual',
  called_shots_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  responded_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS direct_messages (
  message_id TEXT PRIMARY KEY,
  pair_low_id TEXT NOT NULL,
  pair_high_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  read_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS player_presence (
  player_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'offline',
  manual_status TEXT,
  active_room_id TEXT,
  last_heartbeat_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS player_reports (
  report_id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  reported_id TEXT NOT NULL,
  context_type TEXT NOT NULL,
  context_id TEXT,
  reason TEXT NOT NULL,
  details TEXT,
  excerpt TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friendships_requester
  ON friendships (requester_id, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_friendships_recipient
  ON friendships (recipient_id, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked
  ON player_blocks (blocked_id, blocker_id);

CREATE INDEX IF NOT EXISTS idx_invites_recipient
  ON match_invitations (recipient_id, status, expires_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_invites_sender
  ON match_invitations (sender_id, status, expires_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_invites_room
  ON match_invitations (room_id, status);

CREATE INDEX IF NOT EXISTS idx_dm_pair
  ON direct_messages (pair_low_id, pair_high_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_dm_unread
  ON direct_messages (recipient_id, read_at_ms, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_presence_expiry
  ON player_presence (status, expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_reports_reported
  ON player_reports (reported_id, created_at_ms DESC);
