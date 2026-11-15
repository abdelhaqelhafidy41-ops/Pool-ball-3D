-- Phase 8: In-Game Currency (POOL COINS), Store Inventory, Equipped Cosmetics & Transaction Ledger

CREATE TABLE IF NOT EXISTS player_wallets (
  player_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 100,
  total_earned INTEGER NOT NULL DEFAULT 100,
  total_spent INTEGER NOT NULL DEFAULT 0,
  daily_streak INTEGER NOT NULL DEFAULT 0,
  last_daily_claim_ms INTEGER,
  ai_daily_day_key TEXT,
  ai_daily_coins INTEGER NOT NULL DEFAULT 0,
  last_ai_claim_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS player_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'store_purchase',
  UNIQUE(player_id, item_id)
);

CREATE TABLE IF NOT EXISTS player_equipped_cosmetics (
  player_id TEXT PRIMARY KEY,
  cue_id TEXT NOT NULL DEFAULT 'cue_classic_maple',
  ball_id TEXT NOT NULL DEFAULT 'ball_classic',
  table_id TEXT NOT NULL DEFAULT 'table_classic_green',
  avatar_id TEXT NOT NULL DEFAULT 'cue_gold',
  nameplate_id TEXT NOT NULL DEFAULT 'nameplate_standard',
  badge_id TEXT NOT NULL DEFAULT 'badge_none',
  victory_id TEXT NOT NULL DEFAULT 'victory_classic_burst',
  decoration_id TEXT NOT NULL DEFAULT 'decor_none',
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_transactions (
  tx_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_match_claims (
  client_match_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  coins_awarded INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_player_inventory_player
  ON player_inventory (player_id, acquired_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_player_time
  ON coin_transactions (player_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_ai_match_claims_player_time
  ON ai_match_claims (player_id, created_at_ms DESC);
