import {
  Calendar,
  Check,
  Clock,
  Coins,
  Filter,
  Package,
  Search,
  ShoppingBag,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { soundEngine } from '../game/utils/SoundEngine';
import { economyClient } from '../multiplayer/EconomyClient';
import {
  COSMETIC_CATEGORY_LABELS,
  DAILY_LOGIN_SCHEDULE,
  RARITY_META,
  categorySlotKey,
  getCategoryDefaultItemId,
  type CoinTransactionReason,
  type CosmeticCategory,
  type CosmeticItemDef,
  type ItemRarity,
} from '../multiplayer/shared/economy';
import { type StoreCategoryFilter, type StoreTab, useGameStore } from '../store/useGameStore';

const CATEGORY_TABS: Array<{ id: StoreCategoryFilter; label: string }> = [
  { id: 'all', label: 'All Items' },
  { id: 'cue', label: COSMETIC_CATEGORY_LABELS.cue },
  { id: 'ball', label: COSMETIC_CATEGORY_LABELS.ball },
  { id: 'table', label: COSMETIC_CATEGORY_LABELS.table },
  { id: 'avatar', label: COSMETIC_CATEGORY_LABELS.avatar },
  { id: 'nameplate', label: COSMETIC_CATEGORY_LABELS.nameplate },
  { id: 'badge', label: COSMETIC_CATEGORY_LABELS.badge },
  { id: 'victory', label: COSMETIC_CATEGORY_LABELS.victory },
  { id: 'decoration', label: COSMETIC_CATEGORY_LABELS.decoration },
];

const RARITY_FILTERS: Array<{ id: 'all' | ItemRarity; label: string }> = [
  { id: 'all', label: 'All Rarities' },
  { id: 'common', label: 'Common' },
  { id: 'rare', label: 'Rare' },
  { id: 'epic', label: 'Epic' },
  { id: 'legendary', label: 'Legendary' },
];

function formatCountdown(targetMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const h = Math.floor(diffSec / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTxReason(reason: CoinTransactionReason): string {
  switch (reason) {
    case 'online_match_win':
      return 'Online Match Victory';
    case 'online_match_play':
      return 'Online Match Completion';
    case 'achievement_unlock':
      return 'Achievement Bonus';
    case 'ai_match_win':
      return 'AI Match Victory';
    case 'daily_login':
      return 'Daily Login Streak';
    case 'tournament_reward':
      return 'Tournament Payout';
    case 'store_purchase':
      return 'Store Purchase';
    case 'purchase_refund':
      return 'Purchase Refund';
    default:
      return reason;
  }
}

function formatTxTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function CosmeticArtwork({
  item,
  size = 'card',
}: {
  item: CosmeticItemDef;
  size?: 'card' | 'inspector';
}) {
  const [c1, c2, c3] = item.previewColors;
  const hClass = size === 'inspector' ? 'h-32 w-full' : 'h-20 w-full';

  if (item.category === 'cue') {
    return (
      <svg viewBox="0 0 180 72" className={hClass} aria-hidden="true">
        <defs>
          <linearGradient id={`cue_${item.id}_${size}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={c2} />
            <stop offset="48%" stopColor={c3} />
            <stop offset="56%" stopColor={c1} />
            <stop offset="100%" stopColor="#f5f1e3" />
          </linearGradient>
        </defs>
        <g transform="rotate(-10 90 36)">
          <rect x="14" y="31" width="150" height="8" rx="4" fill={`url(#cue_${item.id}_${size})`} />
          <rect x="86" y="31" width="6" height="8" fill={c3} />
          <rect x="160" y="32" width="6" height="6" rx="1" fill="#f8fafc" />
          <rect x="166" y="32.5" width="3" height="5" rx="1" fill="#0ea5e9" />
          <line x1="20" y1="33" x2="156" y2="33" stroke="rgba(255,255,255,0.28)" strokeWidth="1" />
        </g>
      </svg>
    );
  }

  if (item.category === 'ball') {
    return (
      <svg viewBox="0 0 180 72" className={hClass} aria-hidden="true">
        <circle cx="58" cy="38" r="19" fill={c1} stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
        <circle cx="58" cy="38" r="7.5" fill="#f8f5ec" />
        <text x="58" y="41" textAnchor="middle" fontSize="9" fontWeight="800" fill="#0f172a">
          1
        </text>

        <circle cx="90" cy="34" r="20" fill={c2} stroke={c3} strokeWidth="1.5" />
        <circle cx="90" cy="34" r="8" fill="#f8f5ec" />
        <text x="90" y="37.5" textAnchor="middle" fontSize="9.5" fontWeight="900" fill="#0f172a">
          8
        </text>

        <circle cx="122" cy="38" r="19" fill="#f5f1e3" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
        <rect x="104" y="31" width="36" height="14" rx="4" fill={c3} opacity="0.92" />
        <circle cx="122" cy="38" r="7.5" fill="#f8f5ec" />
        <text x="122" y="41" textAnchor="middle" fontSize="9" fontWeight="800" fill="#0f172a">
          9
        </text>
      </svg>
    );
  }

  if (item.category === 'table') {
    return (
      <svg viewBox="0 0 180 72" className={hClass} aria-hidden="true">
        <rect x="24" y="12" width="132" height="48" rx="8" fill={c2} stroke={c3} strokeWidth="2.5" />
        <rect x="33" y="19" width="114" height="34" rx="4" fill={c1} />
        <circle cx="35" cy="21" r="3.5" fill="#090d12" />
        <circle cx="90" cy="19" r="3.2" fill="#090d12" />
        <circle cx="145" cy="21" r="3.5" fill="#090d12" />
        <circle cx="35" cy="51" r="3.5" fill="#090d12" />
        <circle cx="90" cy="53" r="3.2" fill="#090d12" />
        <circle cx="145" cy="51" r="3.5" fill="#090d12" />
        <line x1="60" y1="20" x2="60" y2="52" stroke="rgba(255,255,255,0.32)" strokeWidth="1" />
        <circle cx="118" cy="36" r="2.2" fill="#f8fafc" />
      </svg>
    );
  }

  if (item.category === 'avatar') {
    return (
      <div className={`${hClass} flex items-center justify-center`}>
        <div
          className="flex h-14 w-14 items-center justify-center rounded-xl border-2 text-2xl font-black shadow-inner"
          style={{
            backgroundColor: `${c1}1f`,
            borderColor: c1,
            color: c1,
          }}
        >
          {item.glyph ?? '★'}
        </div>
      </div>
    );
  }

  if (item.category === 'nameplate') {
    return (
      <div className={`${hClass} flex items-center justify-center px-3`}>
        <div
          className="w-full max-w-[146px] rounded-lg border-2 px-3 py-2 text-left"
          style={{
            backgroundColor: c2,
            borderColor: c1,
          }}
        >
          <div className="text-[11px] font-extrabold text-white tracking-tight">PLAYER</div>
          <div className="mt-0.5 text-[9px] font-mono uppercase" style={{ color: c3 }}>
            SOLIDS · TURN
          </div>
        </div>
      </div>
    );
  }

  if (item.category === 'badge') {
    return (
      <div className={`${hClass} flex items-center justify-center`}>
        <div
          className="inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-extrabold uppercase tracking-wider"
          style={{
            backgroundColor: `${c1}20`,
            borderColor: `${c1}88`,
            color: c3,
          }}
        >
          <span>{item.glyph ?? '★'}</span>
          <span>{item.name.split(' ')[0]}</span>
        </div>
      </div>
    );
  }

  if (item.category === 'victory') {
    return (
      <svg viewBox="0 0 180 72" className={hClass} aria-hidden="true">
        <ellipse cx="90" cy="48" rx="46" ry="12" fill="none" stroke={c1} strokeWidth="2" opacity="0.8" />
        <ellipse cx="90" cy="40" rx="30" ry="8" fill="none" stroke={c2} strokeWidth="1.6" opacity="0.65" />
        <polygon points="90,12 94,25 107,25 97,33 101,46 90,38 79,46 83,33 73,25 86,25" fill={c1} />
        <circle cx="52" cy="24" r="2.2" fill={c2} />
        <circle cx="128" cy="22" r="2.6" fill={c1} />
        <circle cx="136" cy="40" r="1.8" fill={c2} />
      </svg>
    );
  }

  // Table Decoration
  return (
    <svg viewBox="0 0 180 72" className={hClass} aria-hidden="true">
      <rect x="28" y="18" width="124" height="36" rx="6" fill={c2} stroke={c1} strokeWidth="2.5" />
      <rect x="24" y="14" width="12" height="12" rx="2" fill={c1} />
      <rect x="144" y="14" width="12" height="12" rx="2" fill={c1} />
      <rect x="24" y="46" width="12" height="12" rx="2" fill={c1} />
      <rect x="144" y="46" width="12" height="12" rx="2" fill={c1} />
      <line x1="42" y1="54" x2="138" y2="54" stroke={c3} strokeWidth="2" opacity="0.85" />
    </svg>
  );
}

export function StoreModal() {
  const storeModalOpen = useGameStore((s) => s.storeModalOpen);
  const closeStoreModal = useGameStore((s) => s.closeStoreModal);
  const storeTab = useGameStore((s) => s.storeTab);
  const setStoreTab = useGameStore((s) => s.setStoreTab);
  const storeCategory = useGameStore((s) => s.storeCategory);
  const setStoreCategory = useGameStore((s) => s.setStoreCategory);
  const storeCatalog = useGameStore((s) => s.storeCatalog);
  const wallet = useGameStore((s) => s.wallet);
  const inventoryIds = useGameStore((s) => s.inventoryIds);
  const equippedCosmetics = useGameStore((s) => s.equippedCosmetics);
  const dailyReward = useGameStore((s) => s.dailyReward);
  const coinTransactions = useGameStore((s) => s.coinTransactions);
  const storeNotice = useGameStore((s) => s.storeNotice);
  const setStoreNotice = useGameStore((s) => s.setStoreNotice);

  const [rarityFilter, setRarityFilter] = useState<'all' | ItemRarity>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedItemId, setSelectedItemId] = useState<string>('cue_classic_maple');
  const [confirmPurchaseItem, setConfirmPurchaseItem] = useState<CosmeticItemDef | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!storeModalOpen) return;
    void economyClient.fetchCatalog();
    void economyClient.refreshWallet();
  }, [storeModalOpen]);

  useEffect(() => {
    if (!storeModalOpen || storeTab !== 'ledger') return;
    void economyClient.fetchTransactions(50);
  }, [storeModalOpen, storeTab]);

  useEffect(() => {
    if (!storeModalOpen || storeTab !== 'daily') return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [storeModalOpen, storeTab]);

  const ownedSet = useMemo(() => new Set(inventoryIds), [inventoryIds]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return storeCatalog.filter((item) => {
      if (storeTab === 'inventory' && !ownedSet.has(item.id)) return false;
      if (storeCategory !== 'all' && item.category !== storeCategory) return false;
      if (rarityFilter !== 'all' && item.rarity !== rarityFilter) return false;
      if (q) {
        const hay = `${item.name} ${item.subCategory} ${item.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [storeCatalog, storeTab, ownedSet, storeCategory, rarityFilter, searchQuery]);

  const selectedItem = useMemo(() => {
    return (
      storeCatalog.find((i) => i.id === selectedItemId) ??
      filteredItems[0] ??
      storeCatalog[0] ??
      null
    );
  }, [storeCatalog, selectedItemId, filteredItems]);

  if (!storeModalOpen) return null;

  const balance = wallet?.balance ?? 0;

  const isEquipped = (item: CosmeticItemDef): boolean => {
    const slotKey = categorySlotKey(item.category);
    return equippedCosmetics[slotKey] === item.id;
  };

  const handleEquipOrUnequip = async (item: CosmeticItemDef) => {
    soundEngine.playUiClick();
    setBusyAction(true);
    setStoreNotice(null);

    const currentlyEquipped = isEquipped(item);
    const defaultId = getCategoryDefaultItemId(item.category);
    const targetId = currentlyEquipped && item.id !== defaultId ? defaultId : item.id;

    const res = await economyClient.equipItem(item.category, targetId);
    setBusyAction(false);

    if (res.ok) {
      setStoreNotice({
        type: 'ok',
        text:
          targetId === item.id
            ? `Equipped ${item.name}.`
            : `Unequipped ${item.name}; reverted to default.`,
      });
    } else {
      setStoreNotice({ type: 'err', text: res.error ?? 'Failed to update equipment.' });
    }
  };

  const handleConfirmPurchase = async () => {
    if (!confirmPurchaseItem) return;
    soundEngine.playUiClick();
    setBusyAction(true);
    setStoreNotice(null);
    const item = confirmPurchaseItem;
    const res = await economyClient.purchaseItem(item.id);
    setBusyAction(false);
    setConfirmPurchaseItem(null);

    if (res.ok) {
      setStoreNotice({
        type: 'ok',
        text: `Purchased ${item.name} for ${item.price.toLocaleString()} POOL COINS.`,
      });
    } else {
      setStoreNotice({ type: 'err', text: res.error ?? 'Purchase failed.' });
    }
  };

  const handleClaimDaily = async () => {
    soundEngine.playUiClick();
    setBusyAction(true);
    setStoreNotice(null);
    const res = await economyClient.claimDailyReward();
    setBusyAction(false);

    if (res.ok && res.data) {
      setStoreNotice({
        type: 'ok',
        text: `Claimed Day ${res.data.streak} Daily Reward: +${res.data.claimedAmount} POOL COINS!`,
      });
    } else {
      setStoreNotice({ type: 'err', text: res.error ?? 'Unable to claim daily reward.' });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pool Coins Store and Cosmetic Inventory"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 sm:p-4"
    >
      <div className="relative flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-amber-400/25 bg-[#0c1219] text-slate-100 shadow-2xl">
        {/* Top Armory Bar (obsidian + gold) */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#090e14] px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-400/40 bg-amber-500/12">
              <ShoppingBag className="h-4.5 w-4.5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-extrabold tracking-tight text-white">
                COSMETIC ARMORY & STORE
              </h2>
              <p className="text-[11px] text-slate-400">
                Visual customizations only · Zero gameplay advantages
              </p>
            </div>
          </div>

          {/* Primary Tabs */}
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/40 p-1">
            {(
              [
                { id: 'store', label: 'Store', icon: ShoppingBag },
                { id: 'inventory', label: 'Inventory', icon: Package },
                { id: 'daily', label: 'Daily Rewards', icon: Calendar },
                { id: 'ledger', label: 'Coin Ledger', icon: Coins },
              ] as Array<{ id: StoreTab; label: string; icon: typeof ShoppingBag }>
            ).map((t) => {
              const Icon = t.icon;
              const active = storeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    setStoreTab(t.id);
                  }}
                  className={`relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? 'bg-amber-500 text-slate-950'
                      : 'text-slate-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{t.label}</span>
                  {t.id === 'daily' && dailyReward?.canClaim && (
                    <span className="ml-0.5 h-2 w-2 rounded-full bg-emerald-400" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Wallet Balance & Close */}
          <div className="flex items-center gap-2.5">
            <div
              data-testid="store-coin-balance"
              className="flex items-center gap-2 rounded-lg border border-amber-400/45 bg-amber-500/12 px-3 py-1.5"
            >
              <Coins className="h-4 w-4 text-amber-400" />
              <div className="text-right">
                <div className="text-[9px] font-bold uppercase tracking-wider text-amber-300/80">
                  POOL COINS
                </div>
                <div className="font-mono text-sm font-black tabular-nums leading-none text-amber-300">
                  {balance.toLocaleString()}
                </div>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close Store"
              onClick={() => {
                soundEngine.playUiClick();
                closeStoreModal();
              }}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Status Notice Banner */}
        {storeNotice && (
          <div
            className={`mx-4 mt-3 flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-semibold sm:mx-6 ${
              storeNotice.type === 'ok'
                ? 'border-emerald-400/40 bg-emerald-500/12 text-emerald-200'
                : 'border-rose-500/40 bg-rose-500/12 text-rose-200'
            }`}
          >
            <span>{storeNotice.text}</span>
            <button
              type="button"
              onClick={() => setStoreNotice(null)}
              className="text-current opacity-70 hover:opacity-100 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Body Content */}
        {(storeTab === 'store' || storeTab === 'inventory') && (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row overflow-hidden">
            {/* Left Catalog Browser */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-5">
              {/* Filter & Search Toolbar */}
              <div className="space-y-2.5 pb-3 border-b border-white/10">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[180px]">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search cues, ball skins, tables, badges..."
                      className="w-full rounded-lg border border-white/12 bg-[#080d13] pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
                    />
                  </div>

                  <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#080d13] p-1">
                    <Filter className="ml-1.5 h-3 w-3 text-slate-400" />
                    {RARITY_FILTERS.map((rf) => (
                      <button
                        key={rf.id}
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          setRarityFilter(rf.id);
                        }}
                        className={`rounded px-2 py-1 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                          rarityFilter === rf.id
                            ? 'bg-amber-500 text-slate-950'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {rf.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Category Tabs */}
                <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
                  {CATEGORY_TABS.map((cat) => {
                    const active = storeCategory === cat.id;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          setStoreCategory(cat.id);
                        }}
                        className={`rounded-md border px-2.5 py-1 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                          active
                            ? 'border-amber-400 bg-amber-500/18 text-amber-200'
                            : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        {cat.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Card Grid */}
              <div className="mt-3 flex-1 overflow-y-auto pr-1">
                {filteredItems.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/25 py-12 text-center text-xs text-slate-400">
                    No cosmetic items match the current filters.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
                    {filteredItems.map((item) => {
                      const owned = ownedSet.has(item.id);
                      const equipped = isEquipped(item);
                      const selected = selectedItem?.id === item.id;
                      const rarity = RARITY_META[item.rarity];

                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-testid={`store-item-${item.id}`}
                          onClick={() => {
                            soundEngine.playUiClick();
                            setSelectedItemId(item.id);
                          }}
                          className={`group relative flex flex-col overflow-hidden rounded-lg border text-left transition-colors cursor-pointer ${
                            selected
                              ? 'border-amber-400 bg-[#151e2a]'
                              : equipped
                                ? 'border-emerald-400/50 bg-[#101822]'
                                : 'border-white/10 bg-[#101620] hover:border-white/25'
                          }`}
                        >
                          {/* Top 2px Rarity Bar */}
                          <div className={`h-0.5 w-full ${rarity.barClass}`} />

                          <div className="px-3 pt-2.5 pb-1">
                            <CosmeticArtwork item={item} size="card" />
                          </div>

                          <div className="flex flex-1 flex-col justify-between px-3 pb-3 pt-1">
                            <div>
                              <div className="flex items-start justify-between gap-2">
                                <div className="text-xs font-extrabold text-white leading-snug">
                                  {item.name}
                                </div>
                              </div>
                              <div className="mt-0.5 text-[10px] text-slate-400">
                                <span className={`font-bold ${rarity.textClass}`}>
                                  {rarity.label}
                                </span>
                                {' · '}
                                <span>{item.subCategory}</span>
                              </div>
                            </div>

                            <div className="mt-2.5 flex items-center justify-between border-t border-white/8 pt-2">
                              {equipped ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wider text-emerald-300">
                                  <Check className="h-3 w-3" />
                                  Equipped
                                </span>
                              ) : owned ? (
                                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                                  Owned
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 font-mono text-xs font-black tabular-nums text-amber-300">
                                  <Coins className="h-3.5 w-3.5 text-amber-400" />
                                  {item.price.toLocaleString()}
                                </span>
                              )}

                              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                                {COSMETIC_CATEGORY_LABELS[item.category]}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Right Sticky Inspector Panel */}
            <div className="w-full shrink-0 border-t lg:border-t-0 lg:border-l border-white/10 bg-[#090e14] p-4 sm:p-5 lg:w-80 flex flex-col justify-between">
              {selectedItem ? (
                (() => {
                  const owned = ownedSet.has(selectedItem.id);
                  const equipped = isEquipped(selectedItem);
                  const rarity = RARITY_META[selectedItem.rarity];
                  const canAfford = balance >= selectedItem.price;
                  const isDefault =
                    getCategoryDefaultItemId(selectedItem.category) === selectedItem.id;

                  return (
                    <div className="space-y-4">
                      <div>
                        <div className={`h-0.5 w-full mb-3 ${rarity.barClass}`} />
                        <div className="rounded-lg border border-white/10 bg-[#0e151f] p-3">
                          <CosmeticArtwork item={selectedItem} size="inspector" />
                        </div>
                      </div>

                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          <span className={rarity.textClass}>{rarity.label}</span>
                          {' · '}
                          {COSMETIC_CATEGORY_LABELS[selectedItem.category]}
                          {' · '}
                          {selectedItem.subCategory}
                        </div>
                        <h3 className="mt-1 text-base font-extrabold text-white">
                          {selectedItem.name}
                        </h3>
                        <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
                          {selectedItem.description}
                        </p>
                      </div>

                      <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-slate-400">
                        <div className="flex items-center justify-between">
                          <span>Gameplay Stat Bonus</span>
                          <span className="font-mono font-bold text-slate-200">
                            Cosmetic Only
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between">
                          <span>Status</span>
                          <span
                            className={`font-bold ${
                              equipped
                                ? 'text-emerald-300'
                                : owned
                                  ? 'text-sky-300'
                                  : 'text-amber-300'
                            }`}
                          >
                            {equipped ? 'Equipped' : owned ? 'In Inventory' : 'Available'}
                          </span>
                        </div>
                      </div>

                      <div className="pt-1">
                        {owned ? (
                          <button
                            type="button"
                            disabled={busyAction || (equipped && isDefault)}
                            onClick={() => void handleEquipOrUnequip(selectedItem)}
                            className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${
                              equipped
                                ? 'border border-white/15 bg-white/8 text-slate-200 hover:bg-white/15'
                                : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                            }`}
                          >
                            <Check className="h-4 w-4" />
                            {equipped
                              ? isDefault
                                ? 'Default Equipped'
                                : 'Unequip to Default'
                              : 'Equip Cosmetic'}
                          </button>
                        ) : (
                          <div className="space-y-2">
                            <button
                              type="button"
                              data-testid="inspector-buy-btn"
                              disabled={busyAction || !canAfford}
                              onClick={() => {
                                soundEngine.playUiClick();
                                setConfirmPurchaseItem(selectedItem);
                              }}
                              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
                            >
                              <Coins className="h-4 w-4" />
                              Buy for {selectedItem.price.toLocaleString()} POOL COINS
                            </button>
                            {!canAfford && (
                              <p className="text-center text-[11px] font-semibold text-rose-300">
                                Need {(selectedItem.price - balance).toLocaleString()} more POOL COINS
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div className="text-xs text-slate-400">Select an item to inspect details.</div>
              )}

              <div className="mt-4 border-t border-white/10 pt-3 text-[10px] text-slate-400">
                Earn POOL COINS via Online Wins (+120/+150), AI Wins (+25–110), Achievements, and Daily Login Streaks.
              </div>
            </div>
          </div>
        )}

        {/* Daily Rewards Tab */}
        {storeTab === 'daily' && (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/35 bg-[#101824] p-4">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
                  7-Day Check-In Streak
                </div>
                <h3 className="mt-0.5 text-lg font-extrabold text-white">
                  Current Streak: {dailyReward?.streak ?? 0} Day
                  {(dailyReward?.streak ?? 0) === 1 ? '' : 's'}
                </h3>
                <p className="mt-0.5 text-xs text-slate-300">
                  Log in daily to escalate rewards up to +400 POOL COINS on Day 7. Resets if a UTC day is missed.
                </p>
              </div>

              <div className="flex items-center gap-3">
                {dailyReward?.canClaim ? (
                  <button
                    type="button"
                    data-testid="claim-daily-btn"
                    disabled={busyAction}
                    onClick={() => void handleClaimDaily()}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-emerald-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    <Sparkles className="h-4 w-4" />
                    Claim +{dailyReward.nextRewardCoins} POOL COINS
                  </button>
                ) : (
                  <div className="rounded-lg border border-white/12 bg-black/35 px-4 py-2 text-right">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Next Reward Available In
                    </div>
                    <div className="font-mono text-sm font-black tabular-nums text-amber-300">
                      {dailyReward ? formatCountdown(dailyReward.nextClaimAtMs, nowMs) : '00:00:00'}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5">
              {(dailyReward?.schedule ?? DAILY_LOGIN_SCHEDULE).map((tier) => {
                const currentDay = dailyReward?.nextDayIndex ?? 1;
                const claimedToday = dailyReward?.claimedToday ?? false;
                const isClaimedPast = claimedToday
                  ? tier.day <= currentDay
                  : tier.day < currentDay;
                const isNextReady = !claimedToday && tier.day === currentDay;

                return (
                  <div
                    key={tier.day}
                    className={`flex flex-col items-center justify-between rounded-xl border p-3.5 text-center ${
                      isNextReady
                        ? 'border-emerald-400 bg-emerald-500/12'
                        : isClaimedPast
                          ? 'border-amber-400/40 bg-amber-500/10'
                          : 'border-white/10 bg-[#101620]'
                    }`}
                  >
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      {tier.label}
                    </div>
                    <div className="my-3 flex h-10 w-10 items-center justify-center rounded-lg border border-amber-400/35 bg-amber-500/12">
                      <Coins className="h-5 w-5 text-amber-400" />
                    </div>
                    <div className="font-mono text-sm font-black tabular-nums text-amber-300">
                      +{tier.coins}
                    </div>
                    <div className="mt-1.5 text-[10px] font-bold uppercase tracking-wider">
                      {isNextReady ? (
                        <span className="text-emerald-300">Ready</span>
                      ) : isClaimedPast ? (
                        <span className="text-amber-300">Claimed</span>
                      ) : (
                        <span className="text-slate-500">Locked</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Coin Ledger Tab */}
        {storeTab === 'ledger' && (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-xs">
              <div className="font-mono tabular-nums text-slate-300">
                Total Earned:{' '}
                <span className="font-bold text-emerald-300">
                  +{(wallet?.totalEarned ?? 0).toLocaleString()}
                </span>
                {' · '}
                Total Spent:{' '}
                <span className="font-bold text-rose-300">
                  -{(wallet?.totalSpent ?? 0).toLocaleString()}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  void economyClient.fetchTransactions(50);
                }}
                className="rounded-lg border border-white/12 bg-white/5 px-3 py-1 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer"
              >
                Refresh
              </button>
            </div>

            {coinTransactions.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/25 py-12 text-center text-xs text-slate-400">
                No coin transactions recorded yet. Claim your daily login reward or complete a match!
              </div>
            ) : (
              <div className="divide-y divide-white/8 rounded-xl border border-white/10 bg-[#0a1017]">
                {coinTransactions.map((tx) => {
                  const isCredit = tx.amount >= 0;
                  return (
                    <div
                      key={tx.txId}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-white">{formatTxReason(tx.reason)}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400">
                          <Clock className="h-3 w-3" />
                          <span>{formatTxTime(tx.createdAtMs)}</span>
                          {' · '}
                          <span className="font-mono">{tx.referenceId}</span>
                        </div>
                      </div>
                      <div className="text-right font-mono tabular-nums">
                        <div
                          className={`text-sm font-black ${
                            isCredit ? 'text-emerald-300' : 'text-rose-300'
                          }`}
                        >
                          {isCredit ? `+${tx.amount.toLocaleString()}` : tx.amount.toLocaleString()}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Bal: {tx.balanceAfter.toLocaleString()}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Purchase Confirmation Dialog */}
        {confirmPurchaseItem && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm Purchase"
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 p-4"
          >
            <div className="w-full max-w-sm rounded-xl border border-amber-400/50 bg-[#0e151e] p-5 shadow-2xl">
              <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                Confirm Cosmetic Purchase
              </div>
              <h3 className="mt-1 text-base font-extrabold text-white">
                {confirmPurchaseItem.name}
              </h3>
              <p className="mt-1 text-xs text-slate-300">
                {COSMETIC_CATEGORY_LABELS[confirmPurchaseItem.category]} ·{' '}
                {RARITY_META[confirmPurchaseItem.rarity].label}
              </p>

              <div className="mt-4 space-y-1.5 rounded-lg border border-white/10 bg-black/35 p-3 font-mono text-xs tabular-nums">
                <div className="flex justify-between text-slate-300">
                  <span>Current Balance</span>
                  <span>{balance.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-amber-300">
                  <span>Item Price</span>
                  <span>-{confirmPurchaseItem.price.toLocaleString()}</span>
                </div>
                <div className="flex justify-between border-t border-white/10 pt-1.5 font-extrabold text-white">
                  <span>Balance After</span>
                  <span>{Math.max(0, balance - confirmPurchaseItem.price).toLocaleString()}</span>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() => setConfirmPurchaseItem(null)}
                  className="flex-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="confirm-purchase-btn"
                  disabled={busyAction || balance < confirmPurchaseItem.price}
                  onClick={() => void handleConfirmPurchase()}
                  className="flex-1 rounded-lg bg-amber-500 px-3 py-2 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
                >
                  {busyAction ? 'Processing...' : 'Confirm Buy'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
