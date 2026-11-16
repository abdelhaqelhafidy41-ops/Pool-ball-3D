import type { AiDifficulty, RuleProfileId } from '../../game/rules/types';
import { ONLINE_AVATARS } from './protocol';

export type CosmeticCategory =
  | 'cue'
  | 'ball'
  | 'table'
  | 'avatar'
  | 'nameplate'
  | 'badge'
  | 'victory'
  | 'decoration';

export type ItemRarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface CosmeticItemDef {
  id: string;
  name: string;
  category: CosmeticCategory;
  subCategory: string;
  rarity: ItemRarity;
  price: number;
  isStarter: boolean;
  description: string;
  previewColors: [string, string, string];
  glyph?: string;
  isRewardExclusive?: boolean;
}

export interface EquippedCosmetics {
  cueId: string;
  ballId: string;
  tableId: string;
  avatarId: string;
  nameplateId: string;
  badgeId: string;
  victoryId: string;
  decorationId: string;
}

export interface WalletSummary {
  playerId: string;
  balance: number;
  totalEarned: number;
  totalSpent: number;
  updatedAtMs: number;
}

export interface DailyRewardTier {
  day: number;
  coins: number;
  label: string;
}

export interface DailyRewardStatus {
  streak: number;
  nextDayIndex: number;
  nextRewardCoins: number;
  canClaim: boolean;
  claimedToday: boolean;
  lastClaimAtMs: number | null;
  nextClaimAtMs: number;
  serverNowMs?: number;
  schedule: DailyRewardTier[];
}

export type CoinTransactionReason =
  | 'online_match_win'
  | 'online_match_play'
  | 'achievement_unlock'
  | 'ai_match_win'
  | 'daily_login'
  | 'tournament_reward'
  | 'tournament_entry'
  | 'tournament_refund'
  | 'season_reward'
  | 'store_purchase'
  | 'purchase_refund';

export interface CoinTransactionRecord {
  txId: string;
  playerId: string;
  amount: number;
  balanceAfter: number;
  reason: CoinTransactionReason;
  referenceType: string;
  referenceId: string;
  metadata: Record<string, string | number | boolean> | null;
  createdAtMs: number;
}

export interface PlayerCosmeticSnapshot {
  wallet: WalletSummary;
  inventoryIds: string[];
  equipped: EquippedCosmetics;
  dailyReward: DailyRewardStatus;
}

export interface AiMatchRewardRequest {
  clientMatchId: string;
  difficulty: AiDifficulty;
  won: boolean;
  totalShots: number;
  ballsPocketed: number;
  durationSec: number;
}

export interface AiMatchRewardResponse {
  ok: true;
  coinsAwarded: number;
  alreadyClaimed: boolean;
  dailyCapReached: boolean;
  dailyEarned: number;
  dailyCap: number;
  nextCooldownAtMs: number | null;
  wallet: WalletSummary;
}

export interface PurchaseItemResponse {
  ok: true;
  item: CosmeticItemDef;
  wallet: WalletSummary;
  inventoryIds: string[];
  equipped: EquippedCosmetics;
}

export interface EquipCosmeticResponse {
  ok: true;
  category: CosmeticCategory;
  itemId: string;
  equipped: EquippedCosmetics;
}

export interface DailyClaimResponse {
  ok: true;
  claimedAmount: number;
  streak: number;
  wallet: WalletSummary;
  dailyReward: DailyRewardStatus;
}

export const COSMETIC_CATEGORY_LABELS: Record<CosmeticCategory, string> = {
  cue: 'Cue Sticks',
  ball: 'Ball Skins',
  table: 'Pool Tables',
  avatar: 'Avatars',
  nameplate: 'Nameplates',
  badge: 'Badges',
  victory: 'Victory FX',
  decoration: 'Table Decor',
};

export const RARITY_META: Record<
  ItemRarity,
  { label: string; accent: string; borderClass: string; textClass: string; barClass: string }
> = {
  common: {
    label: 'Common',
    accent: '#94a3b8',
    borderClass: 'border-slate-500/40',
    textClass: 'text-slate-300',
    barClass: 'bg-slate-400',
  },
  rare: {
    label: 'Rare',
    accent: '#38bdf8',
    borderClass: 'border-sky-400/50',
    textClass: 'text-sky-300',
    barClass: 'bg-sky-400',
  },
  epic: {
    label: 'Epic',
    accent: '#c084fc',
    borderClass: 'border-purple-400/55',
    textClass: 'text-purple-300',
    barClass: 'bg-purple-400',
  },
  legendary: {
    label: 'Legendary',
    accent: '#f59e0b',
    borderClass: 'border-amber-400/70',
    textClass: 'text-amber-300',
    barClass: 'bg-amber-400',
  },
};

export const DEFAULT_EQUIPPED_COSMETICS: EquippedCosmetics = {
  cueId: 'cue_classic_maple',
  ballId: 'ball_classic',
  tableId: 'table_classic_green',
  avatarId: 'cue_gold',
  nameplateId: 'nameplate_standard',
  badgeId: 'badge_none',
  victoryId: 'victory_classic_burst',
  decorationId: 'decor_none',
};

const STARTER_AVATAR_ITEMS: CosmeticItemDef[] = ONLINE_AVATARS.map((av) => ({
  id: av.id,
  name: `${av.label} Emblem`,
  category: 'avatar',
  subCategory: 'Starter Avatar',
  rarity: 'common',
  price: 0,
  isStarter: true,
  description: 'Standard championship competitor avatar included with every player profile.',
  previewColors: [av.accent, '#141b26', '#0a0f16'],
  glyph: av.glyph,
}));

export const COSMETIC_CATALOG: CosmeticItemDef[] = [
  // A. Cue Sticks
  {
    id: 'cue_classic_maple',
    name: 'Classic Wood Cue',
    category: 'cue',
    subCategory: 'Classic Wooden',
    rarity: 'common',
    price: 0,
    isStarter: true,
    description: 'Traditional two-piece Canadian maple shaft with linen wrap and brass joint.',
    previewColors: ['#d7a96f', '#3a2214', '#c9a350'],
  },
  {
    id: 'cue_walnut_heritage',
    name: 'Roasted Walnut Heritage',
    category: 'cue',
    subCategory: 'Classic Wooden',
    rarity: 'common',
    price: 250,
    isStarter: false,
    description: 'Deep roasted walnut forearm paired with hand-rubbed mahogany butt sleeves.',
    previewColors: ['#b57b4c', '#4a2614', '#d4a84f'],
  },
  {
    id: 'cue_carbon_stealth',
    name: 'Professional Carbon Cue',
    category: 'cue',
    subCategory: 'Carbon Fiber',
    rarity: 'rare',
    price: 650,
    isStarter: false,
    description: 'Matte woven carbon-composite shaft with precision titanium collar.',
    previewColors: ['#2a313c', '#0f1318', '#38bdf8'],
  },
  {
    id: 'cue_gold_imperial',
    name: 'Golden Cue',
    category: 'cue',
    subCategory: 'Gold & Platinum',
    rarity: 'epic',
    price: 1450,
    isStarter: false,
    description: 'Brushed 24-karat gold hardware, ivory inlays, and black alligator grain grip.',
    previewColors: ['#f6c85f', '#19140e', '#ffe49e'],
  },
  {
    id: 'cue_platinum_apex',
    name: 'Royal Platinum Cue',
    category: 'cue',
    subCategory: 'Gold & Platinum',
    rarity: 'epic',
    price: 1650,
    isStarter: false,
    description: 'Mirror-finished platinum sleeve accented by cold sapphire joint rings.',
    previewColors: ['#e2e8f0', '#1e293b', '#7dd3fc'],
  },
  {
    id: 'cue_neon_cosmic',
    name: 'Neon Cyber Cue',
    category: 'cue',
    subCategory: 'Neon & Futuristic',
    rarity: 'legendary',
    price: 2800,
    isStarter: false,
    description: 'Cosmic magenta-cyan energy conduit inlaid along a dark anodized barrel.',
    previewColors: ['#ec4899', '#22d3ee', '#151226'],
  },
  {
    id: 'cue_dragon_sovereign',
    name: 'Legendary Dragon Cue',
    category: 'cue',
    subCategory: 'Rare & Legendary',
    rarity: 'legendary',
    price: 3600,
    isStarter: false,
    description: 'Hand-engraved imperial crimson lacquer crowned with filigree gold bands.',
    previewColors: ['#dc2626', '#fbbf24', '#16090b'],
  },

  // B. Ball Skins
  {
    id: 'ball_classic',
    name: 'Classic Balls',
    category: 'ball',
    subCategory: 'Classic',
    rarity: 'common',
    price: 0,
    isStarter: true,
    description: 'Official championship phenolic resin set with crisp high-contrast medallions.',
    previewColors: ['#f5f1e6', '#d82b27', '#1a56b8'],
  },
  {
    id: 'ball_brushed_metallic',
    name: 'Metallic Balls',
    category: 'ball',
    subCategory: 'Metallic',
    rarity: 'rare',
    price: 850,
    isStarter: false,
    description: 'Anodized brushed alloy finish with rich metallic sheen under overhead lights.',
    previewColors: ['#cbd5e1', '#475569', '#f59e0b'],
  },
  {
    id: 'ball_neon_pulse',
    name: 'Neon Balls',
    category: 'ball',
    subCategory: 'Neon',
    rarity: 'epic',
    price: 1550,
    isStarter: false,
    description: 'Obsidian carbon core laced with electric neon number rings and edge bands.',
    previewColors: ['#0b1220', '#22d3ee', '#f43f5e'],
  },
  {
    id: 'ball_artisan_marble',
    name: 'Marble Balls',
    category: 'ball',
    subCategory: 'Marble',
    rarity: 'epic',
    price: 1850,
    isStarter: false,
    description: 'Swirled Italian mineral veining fused with gold-rimmed number medallions.',
    previewColors: ['#e7e2d8', '#1f2937', '#d4a84f'],
  },
  {
    id: 'ball_golden',
    name: 'Golden Balls',
    category: 'ball',
    subCategory: '24K Gold',
    rarity: 'epic',
    price: 2400,
    isStarter: false,
    description: 'Polished 24-karat bullion luster with obsidian-trimmed championship medallions.',
    previewColors: ['#f6c85f', '#78350f', '#fef08a'],
  },
  {
    id: 'ball_crystal',
    name: 'Crystal Balls',
    category: 'ball',
    subCategory: 'Prism Crystal',
    rarity: 'legendary',
    price: 2900,
    isStarter: false,
    description: 'Faceted glacier-sapphire sheen with frosted crystalline number cores.',
    previewColors: ['#bae6fd', '#0284c7', '#f0f9ff'],
  },
  {
    id: 'ball_aurora_chroma',
    name: 'Aurora Chroma VFX',
    category: 'ball',
    subCategory: 'Animated VFX',
    rarity: 'legendary',
    price: 3200,
    isStarter: false,
    description: 'Living iridescent emissive shimmer cycling subtly across every ball surface.',
    previewColors: ['#34d399', '#818cf8', '#f472b6'],
  },

  // C. Pool Tables
  {
    id: 'table_classic_green',
    name: 'Classic Green Table',
    category: 'table',
    subCategory: 'Classic Green',
    rarity: 'common',
    price: 0,
    isStarter: true,
    description: 'Traditional worsted emerald baize with solid mahogany rails and brass corners.',
    previewColors: ['#0f6d43', '#4a2515', '#c8a24b'],
  },
  {
    id: 'table_blue_tournament',
    name: 'Tournament Blue Table',
    category: 'table',
    subCategory: 'Blue Tournament',
    rarity: 'rare',
    price: 900,
    isStarter: false,
    description: 'Broadcast-standard tournament blue cloth with satin walnut and brushed steel trim.',
    previewColors: ['#134e84', '#382218', '#cbd5e1'],
  },
  {
    id: 'table_luxury_dark',
    name: 'Luxury Dark Table',
    category: 'table',
    subCategory: 'Luxury Dark',
    rarity: 'epic',
    price: 1900,
    isStarter: false,
    description: 'Charcoal graphite cloth framed by smoked ebony rails and brushed champagne gold.',
    previewColors: ['#222b35', '#0e1116', '#e2b857'],
  },
  {
    id: 'table_royal_crimson',
    name: 'Monte Carlo Burgundy',
    category: 'table',
    subCategory: 'Premium Themed',
    rarity: 'epic',
    price: 2200,
    isStarter: false,
    description: 'Velvet burgundy tournament cloth inside dark rosewood rails and warm brass.',
    previewColors: ['#6f1926', '#281014', '#e5b84b'],
  },
  {
    id: 'table_royal_gold',
    name: 'Royal Gold Table',
    category: 'table',
    subCategory: 'Royal Gold',
    rarity: 'legendary',
    price: 2750,
    isStarter: false,
    description: 'Deep imperial obsidian-gold baize accented with rosewood rails and 24K gold castings.',
    previewColors: ['#2a2315', '#3d1c14', '#fbbf24'],
  },
  {
    id: 'table_neon_arena',
    name: 'Neon Arena Table',
    category: 'table',
    subCategory: 'Neon Arena',
    rarity: 'legendary',
    price: 3400,
    isStarter: false,
    description: 'Sleek matte obsidian chassis illuminated by razor-sharp cyan perimeter neon.',
    previewColors: ['#0c222d', '#090d14', '#22d3ee'],
  },

  // D1. Profile Avatars (starter + premium)
  ...STARTER_AVATAR_ITEMS,
  {
    id: 'avatar_neon_phoenix',
    name: 'Cyber Prism Avatar',
    category: 'avatar',
    subCategory: 'Premium Avatar',
    rarity: 'rare',
    price: 400,
    isStarter: false,
    description: 'Radiant cyan prism crest for your online nameplate and leaderboard card.',
    previewColors: ['#22d3ee', '#0f172a', '#38bdf8'],
    glyph: '✦',
  },
  {
    id: 'avatar_golden_crown',
    name: 'Sovereign Crown Avatar',
    category: 'avatar',
    subCategory: 'Premium Avatar',
    rarity: 'epic',
    price: 950,
    isStarter: false,
    description: 'Royal gold monarch emblem reserved for elite table contenders.',
    previewColors: ['#fbbf24', '#1c1509', '#fef08a'],
    glyph: '♔',
  },
  {
    id: 'avatar_void_samurai',
    name: 'Obsidian Blade Avatar',
    category: 'avatar',
    subCategory: 'Premium Avatar',
    rarity: 'legendary',
    price: 1800,
    isStarter: false,
    description: 'High-contrast violet crest signaling unmatched break discipline.',
    previewColors: ['#c084fc', '#140f24', '#f472b6'],
    glyph: '⚔',
  },

  // D2. Nameplate Designs
  {
    id: 'nameplate_standard',
    name: 'Classic Slate Plate',
    category: 'nameplate',
    subCategory: 'Standard',
    rarity: 'common',
    price: 0,
    isStarter: true,
    description: 'Clean dark obsidian player frame.',
    previewColors: ['#1e293b', '#0f172a', '#64748b'],
  },
  {
    id: 'nameplate_emerald_felt',
    name: 'Emerald Baize Trim',
    category: 'nameplate',
    subCategory: 'Club Frame',
    rarity: 'common',
    price: 220,
    isStarter: false,
    description: 'Tournament emerald edge accent framing your display name.',
    previewColors: ['#10b981', '#062c22', '#34d399'],
  },
  {
    id: 'nameplate_carbon_weave',
    name: 'Carbon Titanium Frame',
    category: 'nameplate',
    subCategory: 'Pro Frame',
    rarity: 'rare',
    price: 550,
    isStarter: false,
    description: 'Steel-blue metallic trim inspired by carbon-composite cue shafts.',
    previewColors: ['#38bdf8', '#0f172a', '#94a3b8'],
  },
  {
    id: 'nameplate_gilded_crest',
    name: '24K Gilded Nameplate',
    category: 'nameplate',
    subCategory: 'Luxury Frame',
    rarity: 'epic',
    price: 1100,
    isStarter: false,
    description: 'Warm champagne gold border with subtle dark amber glow.',
    previewColors: ['#f59e0b', '#261a08', '#fde68a'],
  },
  {
    id: 'nameplate_neon_horizon',
    name: 'Neon Cyber Horizon',
    category: 'nameplate',
    subCategory: 'Animated Frame',
    rarity: 'legendary',
    price: 2100,
    isStarter: false,
    description: 'Dual-tone cyan and magenta futuristic nameplate frame.',
    previewColors: ['#22d3ee', '#ec4899', '#090d16'],
  },

  // D3. Player Badges
  {
    id: 'badge_none',
    name: 'No Badge',
    category: 'badge',
    subCategory: 'None',
    rarity: 'common',
    price: 0,
    isStarter: true,
    description: 'Keep your nameplate minimal without a title badge.',
    previewColors: ['#334155', '#0f172a', '#64748b'],
    glyph: '—',
  },
  {
    id: 'badge_rack_breaker',
    name: 'Rack Breaker',
    category: 'badge',
    subCategory: 'Title Badge',
    rarity: 'common',
    price: 180,
    isStarter: false,
    description: 'Displays the BRK lightning emblem beside your player name.',
    previewColors: ['#fb923c', '#2a1608', '#fed7aa'],
    glyph: '⚡',
  },
  {
    id: 'badge_shark_emblem',
    name: 'Table Shark',
    category: 'badge',
    subCategory: 'Title Badge',
    rarity: 'rare',
    price: 480,
    isStarter: false,
    description: 'Displays the SHARK diamond emblem for sharp positional players.',
    previewColors: ['#38bdf8', '#0c2335', '#bae6fd'],
    glyph: '◆',
  },
  {
    id: 'badge_wpa_tactician',
    name: 'WPA Tactician',
    category: 'badge',
    subCategory: 'Title Badge',
    rarity: 'epic',
    price: 980,
    isStarter: false,
    description: 'Displays the PRO precision badge recognizing strict called-shot mastery.',
    previewColors: ['#c084fc', '#1f1035', '#e9d5ff'],
    glyph: '◎',
  },
  {
    id: 'badge_grand_crown',
    name: 'Grand Crown',
    category: 'badge',
    subCategory: 'Prestige Badge',
    rarity: 'legendary',
    price: 1950,
    isStarter: false,
    description: 'Golden VIP crown crest displayed on menus, lobbies, and scoreboards.',
    previewColors: ['#f59e0b', '#2b1b06', '#fef08a'],
    glyph: '♛',
  },
  {
    id: 'badge_tournament_contender',
    name: 'Tournament Podium',
    category: 'badge',
    subCategory: 'Tournament Reward',
    rarity: 'rare',
    price: 0,
    isStarter: false,
    isRewardExclusive: true,
    description: 'Earned exclusively by finishing on the podium of an official tournament.',
    previewColors: ['#38bdf8', '#0c2335', '#bae6fd'],
    glyph: '🎖',
  },
  {
    id: 'badge_tournament_finalist',
    name: 'Championship Finalist',
    category: 'badge',
    subCategory: 'Tournament Reward',
    rarity: 'epic',
    price: 0,
    isStarter: false,
    isRewardExclusive: true,
    description: 'Earned exclusively by reaching a Grand Final in an official tournament.',
    previewColors: ['#c084fc', '#1f1035', '#e9d5ff'],
    glyph: '🥈',
  },
  {
    id: 'badge_tournament_champion',
    name: 'World Champion',
    category: 'badge',
    subCategory: 'Tournament Reward',
    rarity: 'legendary',
    price: 0,
    isStarter: false,
    isRewardExclusive: true,
    description: 'Prestigious championship trophy badge awarded only to tournament champions.',
    previewColors: ['#fbbf24', '#2b1b06', '#fef08a'],
    glyph: '🏆',
  },

  // D4. Victory Animations
  {
    id: 'victory_classic_burst',
    name: 'Championship Spark',
    category: 'victory',
    subCategory: 'Standard FX',
    rarity: 'common',
    price: 0,
    isStarter: true,
    description: 'Crisp golden victory halo rising cleanly over the winning table.',
    previewColors: ['#f59e0b', '#fef3c7', '#1e293b'],
  },
  {
    id: 'victory_gold_fountain',
    name: '24K Coin Fountain',
    category: 'victory',
    subCategory: 'Celebration FX',
    rarity: 'rare',
    price: 750,
    isStarter: false,
    description: 'A glittering cascade of golden particle embers spiraling above the center spot.',
    previewColors: ['#fbbf24', '#f97316', '#1c1208'],
  },
  {
    id: 'victory_neon_shockwave',
    name: 'Neon Arena Pulse',
    category: 'victory',
    subCategory: 'Cyber FX',
    rarity: 'epic',
    price: 1450,
    isStarter: false,
    description: 'Expanding cyan-magenta shockwave rings sweeping over the table on match win.',
    previewColors: ['#22d3ee', '#ec4899', '#090d16'],
  },
  {
    id: 'victory_championship_spotlight',
    name: 'Grand Finale Beacon',
    category: 'victory',
    subCategory: 'Legendary FX',
    rarity: 'legendary',
    price: 2600,
    isStarter: false,
    description: 'Dual championship spotlights with rising gold-and-platinum starlight pillars.',
    previewColors: ['#fde047', '#e2e8f0', '#0b1019'],
  },

  // D5. Table Decorations
  {
    id: 'decor_none',
    name: 'Clean Rail Finish',
    category: 'decoration',
    subCategory: 'Minimal',
    rarity: 'common',
    price: 0,
    isStarter: true,
    description: 'Pure tournament rail geometry with standard plaques and sights.',
    previewColors: ['#475569', '#1e293b', '#94a3b8'],
  },
  {
    id: 'decor_brass_corners',
    name: 'Heritage Brass Corner Plates',
    category: 'decoration',
    subCategory: 'Rail Trim',
    rarity: 'common',
    price: 300,
    isStarter: false,
    description: 'Polished corner pocket escutcheons and warm brass apron trim rails.',
    previewColors: ['#d4a84f', '#5c3c18', '#f5d78c'],
  },
  {
    id: 'decor_gold_inlays',
    name: '24K Diamond Rail Inlays',
    category: 'decoration',
    subCategory: 'Luxury Trim',
    rarity: 'rare',
    price: 780,
    isStarter: false,
    description: 'Precision metallic apron inlays and raised gold pocket collar accents.',
    previewColors: ['#f59e0b', '#1c150b', '#fef08a'],
  },
  {
    id: 'decor_neon_underflow',
    name: 'Cyan Neon Perimeter Strip',
    category: 'decoration',
    subCategory: 'Neon Trim',
    rarity: 'epic',
    price: 1500,
    isStarter: false,
    description: 'Glowing cyan LED apron contour and matching pedestal floor halo accent.',
    previewColors: ['#22d3ee', '#081822', '#a5f3fc'],
  },
  {
    id: 'decor_championship_crest',
    name: 'World Finals Gold Trim',
    category: 'decoration',
    subCategory: 'Championship Trim',
    rarity: 'legendary',
    price: 2400,
    isStarter: false,
    description: 'Dual-tone gold & obsidian apron filigree with championship floor emblem.',
    previewColors: ['#fbbf24', '#0b1019', '#38bdf8'],
  },
];

export const COSMETIC_CATALOG_MAP = new Map<string, CosmeticItemDef>(
  COSMETIC_CATALOG.map((item) => [item.id, item]),
);

export const STARTER_COSMETIC_IDS: string[] = COSMETIC_CATALOG.filter((i) => i.isStarter).map(
  (i) => i.id,
);

export const STORE_AVATARS = COSMETIC_CATALOG.filter((i) => i.category === 'avatar');

export const DAILY_LOGIN_SCHEDULE: DailyRewardTier[] = [
  { day: 1, coins: 50, label: 'Day 1' },
  { day: 2, coins: 75, label: 'Day 2' },
  { day: 3, coins: 110, label: 'Day 3' },
  { day: 4, coins: 150, label: 'Day 4' },
  { day: 5, coins: 200, label: 'Day 5' },
  { day: 6, coins: 275, label: 'Day 6' },
  { day: 7, coins: 400, label: 'Day 7 Bonus' },
];

export const ECONOMY_CONFIG = {
  currencyName: 'POOL COINS',
  startingBalance: 100,
  onlineMatch: {
    winBaseCoins: 120,
    winWpaBonusCoins: 30,
    lossParticipationCoins: 25,
    minTotalShotsForReward: 1,
  },
  aiMatch: {
    rewardsByDifficulty: {
      beginner: 25,
      intermediate: 45,
      pro: 75,
      legend: 110,
    } satisfies Record<AiDifficulty, number>,
    dailyCoinCap: 400,
    cooldownMs: 25_000,
    minShotsForReward: 2,
    minDurationSecForReward: 5,
  },
  achievementCoinRewards: {
    first_victory: 100,
    wins_10: 250,
    wins_50: 600,
    wins_100: 1200,
    perfect_break: 75,
    comeback_master: 150,
    streak_5: 300,
    eight_ball_champion: 175,
    online_competitor: 100,
    sharpshooter_25: 150,
  } as Record<string, number>,
  tournament: {
    participationCoins: 60,
    runnerUpCoins: 250,
    championCoins: 600,
  },
};

export function getCosmeticItem(itemId: string | null | undefined): CosmeticItemDef | null {
  if (!itemId) return null;
  return COSMETIC_CATALOG_MAP.get(itemId) ?? null;
}

export function getCategoryDefaultItemId(category: CosmeticCategory): string {
  switch (category) {
    case 'cue':
      return DEFAULT_EQUIPPED_COSMETICS.cueId;
    case 'ball':
      return DEFAULT_EQUIPPED_COSMETICS.ballId;
    case 'table':
      return DEFAULT_EQUIPPED_COSMETICS.tableId;
    case 'avatar':
      return DEFAULT_EQUIPPED_COSMETICS.avatarId;
    case 'nameplate':
      return DEFAULT_EQUIPPED_COSMETICS.nameplateId;
    case 'badge':
      return DEFAULT_EQUIPPED_COSMETICS.badgeId;
    case 'victory':
      return DEFAULT_EQUIPPED_COSMETICS.victoryId;
    case 'decoration':
      return DEFAULT_EQUIPPED_COSMETICS.decorationId;
  }
}

export function categorySlotKey(category: CosmeticCategory): keyof EquippedCosmetics {
  switch (category) {
    case 'cue':
      return 'cueId';
    case 'ball':
      return 'ballId';
    case 'table':
      return 'tableId';
    case 'avatar':
      return 'avatarId';
    case 'nameplate':
      return 'nameplateId';
    case 'badge':
      return 'badgeId';
    case 'victory':
      return 'victoryId';
    case 'decoration':
      return 'decorationId';
  }
}

export function sanitizeEquippedCosmetics(
  raw?: Partial<EquippedCosmetics> | null,
): EquippedCosmetics {
  const validFor = (cat: CosmeticCategory, candidate: unknown, fallback: string): string => {
    if (typeof candidate !== 'string') return fallback;
    const item = COSMETIC_CATALOG_MAP.get(candidate);
    return item && item.category === cat ? item.id : fallback;
  };
  return {
    cueId: validFor('cue', raw?.cueId, DEFAULT_EQUIPPED_COSMETICS.cueId),
    ballId: validFor('ball', raw?.ballId, DEFAULT_EQUIPPED_COSMETICS.ballId),
    tableId: validFor('table', raw?.tableId, DEFAULT_EQUIPPED_COSMETICS.tableId),
    avatarId: validFor('avatar', raw?.avatarId, DEFAULT_EQUIPPED_COSMETICS.avatarId),
    nameplateId: validFor('nameplate', raw?.nameplateId, DEFAULT_EQUIPPED_COSMETICS.nameplateId),
    badgeId: validFor('badge', raw?.badgeId, DEFAULT_EQUIPPED_COSMETICS.badgeId),
    victoryId: validFor('victory', raw?.victoryId, DEFAULT_EQUIPPED_COSMETICS.victoryId),
    decorationId: validFor('decoration', raw?.decorationId, DEFAULT_EQUIPPED_COSMETICS.decorationId),
  };
}

export function getUtcDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getNextUtcMidnightMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export function getUtcDayIndex(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

export function computeDailyRewardState(
  storedStreak: number,
  lastClaimMs: number | null,
  nowMs: number = Date.now(),
): DailyRewardStatus {
  const todayIndex = getUtcDayIndex(nowMs);
  const lastIndex = lastClaimMs !== null ? getUtcDayIndex(lastClaimMs) : null;
  const claimedToday = lastIndex !== null && lastIndex >= todayIndex;

  let effectiveStreak = Math.max(0, Math.floor(storedStreak));
  if (lastIndex === null) {
    effectiveStreak = 0;
  } else if (todayIndex - lastIndex > 1) {
    // Missed at least one full UTC day — streak resets cleanly
    effectiveStreak = 0;
  }

  const nextDayIndex = claimedToday
    ? ((effectiveStreak - 1) % DAILY_LOGIN_SCHEDULE.length) + 1
    : (effectiveStreak % DAILY_LOGIN_SCHEDULE.length) + 1;

  const tier =
    DAILY_LOGIN_SCHEDULE[
      Math.max(0, Math.min(DAILY_LOGIN_SCHEDULE.length - 1, nextDayIndex - 1))
    ];

  return {
    streak: effectiveStreak,
    nextDayIndex,
    nextRewardCoins: tier.coins,
    canClaim: !claimedToday,
    claimedToday,
    lastClaimAtMs: lastClaimMs,
    nextClaimAtMs: claimedToday ? getNextUtcMidnightMs(nowMs) : nowMs,
    serverNowMs: nowMs,
    schedule: DAILY_LOGIN_SCHEDULE,
  };
}

export function computeOnlineMatchCoinBreakdown(params: {
  won: boolean;
  ruleProfileId: RuleProfileId;
  validCompetitiveMatch: boolean;
  unlockedAchievementIds: string[];
}): { totalCoins: number; breakdown: Array<{ label: string; amount: number }> } {
  const breakdown: Array<{ label: string; amount: number }> = [];
  if (!params.validCompetitiveMatch) {
    return { totalCoins: 0, breakdown };
  }

  if (params.won) {
    breakdown.push({
      label: 'Online Match Victory',
      amount: ECONOMY_CONFIG.onlineMatch.winBaseCoins,
    });
    if (params.ruleProfileId === 'wpa') {
      breakdown.push({
        label: 'Strict Called (WPA) Bonus',
        amount: ECONOMY_CONFIG.onlineMatch.winWpaBonusCoins,
      });
    }
  } else {
    breakdown.push({
      label: 'Match Completion',
      amount: ECONOMY_CONFIG.onlineMatch.lossParticipationCoins,
    });
  }

  for (const achId of params.unlockedAchievementIds) {
    const bonus = ECONOMY_CONFIG.achievementCoinRewards[achId] ?? 0;
    if (bonus > 0) {
      breakdown.push({
        label: `Achievement (${achId})`,
        amount: bonus,
      });
    }
  }

  const totalCoins = breakdown.reduce((sum, item) => sum + item.amount, 0);
  return { totalCoins, breakdown };
}

export function getAvatarVisualMeta(avatarId: string | null | undefined): {
  id: string;
  label: string;
  accent: string;
  glyph: string;
} {
  const starter = ONLINE_AVATARS.find((a) => a.id === avatarId);
  if (starter) return starter;
  const item = avatarId ? COSMETIC_CATALOG_MAP.get(avatarId) : null;
  if (item && item.category === 'avatar') {
    return {
      id: item.id,
      label: item.name,
      accent: item.previewColors[0],
      glyph: item.glyph ?? '★',
    };
  }
  return ONLINE_AVATARS[0];
}

export function getNameplateVisualClass(nameplateId: string | null | undefined): {
  borderClass: string;
  bgClass: string;
  accentHex: string;
} {
  switch (nameplateId) {
    case 'nameplate_emerald_felt':
      return {
        borderClass: 'border-emerald-400/55',
        bgClass: 'bg-emerald-950/35',
        accentHex: '#10b981',
      };
    case 'nameplate_carbon_weave':
      return {
        borderClass: 'border-sky-400/55',
        bgClass: 'bg-slate-900/75',
        accentHex: '#38bdf8',
      };
    case 'nameplate_gilded_crest':
      return {
        borderClass: 'border-amber-400/75 shadow-[0_0_16px_-6px_rgba(245,158,11,0.55)]',
        bgClass: 'bg-amber-950/25',
        accentHex: '#f59e0b',
      };
    case 'nameplate_neon_horizon':
      return {
        borderClass: 'border-cyan-400/75 shadow-[0_0_18px_-5px_rgba(34,211,238,0.55)]',
        bgClass: 'bg-[#0b1526]/85',
        accentHex: '#22d3ee',
      };
    default:
      return {
        borderClass: 'border-white/12',
        bgClass: 'bg-black/35',
        accentHex: '#64748b',
      };
  }
}

export function getBadgeVisualMeta(badgeId: string | null | undefined): {
  id: string;
  shortLabel: string;
  glyph: string;
  className: string;
} | null {
  switch (badgeId) {
    case 'badge_rack_breaker':
      return {
        id: badgeId,
        shortLabel: 'BRK',
        glyph: '⚡',
        className: 'border-orange-400/45 bg-orange-500/15 text-orange-200',
      };
    case 'badge_shark_emblem':
      return {
        id: badgeId,
        shortLabel: 'SHARK',
        glyph: '◆',
        className: 'border-sky-400/45 bg-sky-500/15 text-sky-200',
      };
    case 'badge_wpa_tactician':
      return {
        id: badgeId,
        shortLabel: 'WPA',
        glyph: '◎',
        className: 'border-purple-400/50 bg-purple-500/15 text-purple-200',
      };
    case 'badge_grand_crown':
      return {
        id: badgeId,
        shortLabel: 'VIP',
        glyph: '♛',
        className: 'border-amber-400/65 bg-amber-500/20 text-amber-200',
      };
    case 'badge_tournament_contender':
      return {
        id: badgeId,
        shortLabel: 'PODIUM',
        glyph: '🎖',
        className: 'border-sky-400/55 bg-sky-500/15 text-sky-200',
      };
    case 'badge_tournament_finalist':
      return {
        id: badgeId,
        shortLabel: 'FINALIST',
        glyph: '🥈',
        className: 'border-purple-400/60 bg-purple-500/20 text-purple-200',
      };
    case 'badge_tournament_champion':
      return {
        id: badgeId,
        shortLabel: 'CHAMP',
        glyph: '🏆',
        className: 'border-amber-400/80 bg-amber-500/25 text-amber-200',
      };
    default:
      return null;
  }
}
