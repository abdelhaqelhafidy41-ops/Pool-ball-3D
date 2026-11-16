import {
  Calendar,
  Check,
  Clock,
  Coins,
  Filter,
  Info,
  Package,
  Search,
  ShoppingBag,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { soundEngine } from '../game/utils/SoundEngine';
import { economyClient } from '../multiplayer/EconomyClient';
import {
  COSMETIC_CATEGORY_LABELS,
  DAILY_LOGIN_SCHEDULE,
  RARITY_META,
  categorySlotKey,
  getCategoryDefaultItemId,
  type CoinTransactionReason,
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

export function formatCountdown(targetMs: number, nowMs: number): string {
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
    case 'tournament_entry':
      return 'Tournament Entry Fee';
    case 'tournament_refund':
      return 'Tournament Entry Refund';
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
  const hClass = size === 'inspector' ? 'h-28 w-full' : 'h-16 sm:h-20 w-full';

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
          className="flex h-12 w-12 sm:h-14 sm:w-14 items-center justify-center rounded-xl border-2 text-xl sm:text-2xl font-black shadow-inner"
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
  const [mobileInspectOpen, setMobileInspectOpen] = useState(false);
  const [confirmPurchaseItem, setConfirmPurchaseItem] = useState<CosmeticItemDef | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [nowMs, setNowMs] = useState(() => economyClient.getTrustedNowMs());
  const rolloverRefreshTriggeredRef = useRef<number | null>(null);

  useEffect(() => {
    if (!storeModalOpen) {
      setMobileInspectOpen(false);
      return;
    }
    void economyClient.fetchCatalog(true);
    void economyClient.refreshWallet();
  }, [storeModalOpen]);

  useEffect(() => {
    if (!storeModalOpen || storeTab !== 'ledger') return;
    void economyClient.fetchTransactions(50);
  }, [storeModalOpen, storeTab]);

  useEffect(() => {
    if (!storeModalOpen || storeTab !== 'daily') return;
    const syncTick = () => {
      const trustedNow = economyClient.getTrustedNowMs();
      setNowMs(trustedNow);
      if (
        dailyReward &&
        !dailyReward.canClaim &&
        trustedNow >= dailyReward.nextClaimAtMs &&
        rolloverRefreshTriggeredRef.current !== dailyReward.nextClaimAtMs
      ) {
        rolloverRefreshTriggeredRef.current = dailyReward.nextClaimAtMs;
        void economyClient.refreshWallet();
      }
    };
    syncTick();
    const id = window.setInterval(syncTick, 1000);
    return () => window.clearInterval(id);
  }, [storeModalOpen, storeTab, dailyReward]);

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
    if (busyAction) return;
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
    if (!confirmPurchaseItem || busyAction) return;
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
    if (busyAction) return;
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

  const renderInspectorDetails = (item: CosmeticItemDef) => {
    const owned = ownedSet.has(item.id);
    const equipped = isEquipped(item);
    const rarity = RARITY_META[item.rarity];
    const canAfford = balance >= item.price;
    const isDefault = getCategoryDefaultItemId(item.category) === item.id;

    return (
      <div className="space-y-4">
        <div>
          <div className={`h-0.5 w-full mb-3 ${rarity.barClass}`} />
          <div className="rounded-lg border border-white/10 bg-[#0e151f] p-3">
            <CosmeticArtwork item={item} size="inspector" />
          </div>
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            <span className={rarity.textClass}>{rarity.label}</span>
            {' · '}
            {COSMETIC_CATEGORY_LABELS[item.category]}
            {' · '}
            {item.subCategory}
          </div>
          <h3 className="mt-1 text-base font-extrabold text-white">{item.name}</h3>
          <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">{item.description}</p>
        </div>

        <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-slate-400">
          <div className="flex items-center justify-between">
            <span>Gameplay Stat Bonus</span>
            <span className="font-mono font-bold text-slate-200">Cosmetic Only</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span>Status</span>
            <span
              className={`font-bold ${
                equipped ? 'text-emerald-300' : owned ? 'text-sky-300' : 'text-amber-300'
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
              onClick={() => void handleEquipOrUnequip(item)}
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
          ) : item.isRewardExclusive ? (
            <div className="rounded-lg border border-amber-400/35 bg-amber-500/10 px-3 py-2.5 text-center text-xs font-bold text-amber-200">
              Unlocked exclusively through Championship &amp; Tournament placements.
            </div>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                data-testid="inspector-buy-btn"
                disabled={busyAction || !canAfford}
                onClick={() => {
                  soundEngine.playUiClick();
                  setConfirmPurchaseItem(item);
                }}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
              >
                <Coins className="h-4 w-4" />
                Buy for {item.price.toLocaleString()} POOL COINS
              </button>
              {!canAfford && (
                <p className="text-center text-[11px] font-semibold text-rose-300">
                  Need {(item.price - balance).toLocaleString()} more POOL COINS
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pool Coins Store and Cosmetic Inventory"
      data-testid="store-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-1.5 sm:p-4 pt-[max(0.375rem,env(safe-area-inset-top))] pb-[max(0.375rem,env(safe-area-inset-bottom))]"
    >
      <div
        data-testid="store-modal-shell"
        className="relative flex h-[94dvh] max-h-[94dvh] sm:h-[90dvh] sm:max-h-[90dvh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-amber-400/25 bg-[#0c1219] text-slate-100 shadow-2xl"
      >
        {/* Top Armory Bar (compact on mobile, single bar on desktop) */}
        <div className="shrink-0 border-b border-white/10 bg-[#090e14] px-3 py-2.5 sm:px-6 sm:py-3 space-y-2 lg:space-y-0 lg:flex lg:items-center lg:justify-between lg:gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-lg border border-amber-400/40 bg-amber-500/12">
                <ShoppingBag className="h-4 w-4 text-amber-400" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm sm:text-lg font-extrabold tracking-tight text-white truncate">
                  COSMETIC ARMORY &amp; STORE
                </h2>
                <p className="hidden sm:block text-[11px] text-slate-400">
                  Visual customizations only · Zero gameplay advantages
                </p>
              </div>
            </div>

            {/* Balance & Close on mobile top-right (mirrors on desktop right via order) */}
            <div className="flex items-center gap-2 shrink-0 lg:hidden">
              <div
                data-testid="store-coin-balance-mobile"
                className="flex items-center gap-1.5 rounded-lg border border-amber-400/45 bg-amber-500/12 px-2.5 py-1"
              >
                <Coins className="h-3.5 w-3.5 text-amber-400" />
                <span className="font-mono text-xs font-black tabular-nums text-amber-300">
                  {balance.toLocaleString()}
                </span>
              </div>
              <button
                type="button"
                aria-label="Close Store"
                onClick={() => {
                  soundEngine.playUiClick();
                  closeStoreModal();
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Primary Tabs (horizontally scrollable on narrow screens) */}
          <div className="modal-scroll-x flex items-center gap-1 rounded-lg border border-white/10 bg-black/40 p-1">
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
                  data-testid={`store-tab-${t.id}`}
                  onClick={() => {
                    soundEngine.playUiClick();
                    setStoreTab(t.id);
                  }}
                  className={`relative inline-flex items-center gap-1.5 rounded-md px-2.5 sm:px-3 py-1.5 text-[11px] sm:text-xs font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
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

          {/* Desktop Wallet Balance & Close */}
          <div className="hidden lg:flex items-center gap-2.5 shrink-0">
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
            className={`mx-3 mt-2 sm:mx-6 sm:mt-3 shrink-0 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ${
              storeNotice.type === 'ok'
                ? 'border-emerald-400/40 bg-emerald-500/12 text-emerald-200'
                : 'border-rose-500/40 bg-rose-500/12 text-rose-200'
            }`}
          >
            <span className="min-w-0 break-words">{storeNotice.text}</span>
            <button
              type="button"
              onClick={() => setStoreNotice(null)}
              className="shrink-0 text-current opacity-70 hover:opacity-100 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Store / Inventory Body: single primary vertical scroller on mobile, split pane on desktop */}
        {(storeTab === 'store' || storeTab === 'inventory') && (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row overflow-hidden">
            {/* Catalog Pane: single vertical scroll on <lg, fixed filter + scrolling grid on lg+ */}
            <div
              data-testid="store-scroll-region"
              className="modal-scroll-y flex min-h-0 flex-1 flex-col lg:overflow-hidden p-3 sm:p-5 pb-6"
            >
              {/* Filter & Search Toolbar */}
              <div className="shrink-0 space-y-2 pb-3 border-b border-white/10">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <div className="relative flex-1 min-w-0">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search cues, ball skins, tables, badges..."
                      className="w-full rounded-lg border border-white/12 bg-[#080d13] pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
                    />
                  </div>

                  <div className="modal-scroll-x flex items-center gap-1 rounded-lg border border-white/10 bg-[#080d13] p-1">
                    <Filter className="ml-1.5 h-3 w-3 shrink-0 text-slate-400" />
                    {RARITY_FILTERS.map((rf) => (
                      <button
                        key={rf.id}
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          setRarityFilter(rf.id);
                        }}
                        className={`rounded px-2 py-1 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
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
                <div className="modal-scroll-x flex items-center gap-1 pb-0.5">
                  {CATEGORY_TABS.map((cat) => {
                    const active = storeCategory === cat.id;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        data-testid={`store-category-${cat.id}`}
                        onClick={() => {
                          soundEngine.playUiClick();
                          setStoreCategory(cat.id);
                        }}
                        className={`rounded-md border px-2.5 py-1 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
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

              {/* Card Grid (scrolls inside lg:flex-1 on desktop, flows inside single pane on <lg) */}
              <div className="mt-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1 lg:overscroll-contain">
                {filteredItems.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/25 py-12 text-center text-xs text-slate-400">
                    No cosmetic items match the current filters.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5 pb-4">
                    {filteredItems.map((item) => {
                      const owned = ownedSet.has(item.id);
                      const equipped = isEquipped(item);
                      const selected = selectedItem?.id === item.id;
                      const rarity = RARITY_META[item.rarity];
                      const canAfford = balance >= item.price;
                      const isDefault = getCategoryDefaultItemId(item.category) === item.id;

                      return (
                        <div
                          key={item.id}
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

                          <div className="px-3 pt-2.5 pb-1 relative">
                            <CosmeticArtwork item={item} size="card" />
                            <button
                              type="button"
                              aria-label={`Inspect ${item.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                soundEngine.playUiClick();
                                setSelectedItemId(item.id);
                                setMobileInspectOpen(true);
                              }}
                              className="lg:hidden absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/12 bg-black/50 text-slate-300 hover:text-white cursor-pointer"
                            >
                              <Info className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          <div className="flex flex-1 flex-col justify-between px-3 pb-3 pt-1 gap-2">
                            <div>
                              <div className="text-xs font-extrabold text-white leading-snug">
                                {item.name}
                              </div>
                              <div className="mt-0.5 text-[10px] text-slate-400">
                                <span className={`font-bold ${rarity.textClass}`}>
                                  {rarity.label}
                                </span>
                                {' · '}
                                <span>{item.subCategory}</span>
                              </div>
                            </div>

                            <div className="flex items-center justify-between gap-2 border-t border-white/8 pt-2">
                              {equipped ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wider text-emerald-300 whitespace-nowrap">
                                  <Check className="h-3 w-3" />
                                  Equipped
                                </span>
                              ) : owned ? (
                                <span className="text-[11px] font-bold uppercase tracking-wider text-sky-300 whitespace-nowrap">
                                  Owned
                                </span>
                              ) : item.isRewardExclusive ? (
                                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300 whitespace-nowrap">
                                  Tournament Prize
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 font-mono text-xs font-black tabular-nums text-amber-300 whitespace-nowrap">
                                  <Coins className="h-3.5 w-3.5 text-amber-400" />
                                  {item.price.toLocaleString()}
                                </span>
                              )}

                              {owned ? (
                                <button
                                  type="button"
                                  data-testid={`card-equip-btn-${item.id}`}
                                  disabled={busyAction || (equipped && isDefault)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedItemId(item.id);
                                    void handleEquipOrUnequip(item);
                                  }}
                                  className={`rounded-md px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider transition-colors cursor-pointer whitespace-nowrap disabled:opacity-45 ${
                                    equipped
                                      ? isDefault
                                        ? 'border border-white/10 bg-white/5 text-slate-400'
                                        : 'border border-white/15 bg-white/10 text-slate-200 hover:bg-white/18'
                                      : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                                  }`}
                                >
                                  {equipped ? (isDefault ? 'Default' : 'Unequip') : 'Equip'}
                                </button>
                              ) : item.isRewardExclusive ? (
                                <span className="text-[10px] font-semibold text-slate-400 whitespace-nowrap">
                                  Locked
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  data-testid={`card-buy-btn-${item.id}`}
                                  disabled={busyAction || !canAfford}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    soundEngine.playUiClick();
                                    setSelectedItemId(item.id);
                                    setConfirmPurchaseItem(item);
                                  }}
                                  className="rounded-md bg-amber-500 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
                                >
                                  Buy
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Desktop Sticky Right Inspector Panel */}
            <div className="hidden lg:flex lg:w-80 lg:shrink-0 lg:flex-col lg:justify-between border-l border-white/10 bg-[#090e14] p-5 modal-scroll-y">
              {selectedItem ? (
                renderInspectorDetails(selectedItem)
              ) : (
                <div className="text-xs text-slate-400">Select an item to inspect details.</div>
              )}

              <div className="mt-4 border-t border-white/10 pt-3 text-[10px] text-slate-400">
                Earn POOL COINS via Online Wins (+120/+150), AI Wins (+25–110), Achievements, Tournaments, and Daily Login Streaks.
              </div>
            </div>
          </div>
        )}

        {/* Daily Rewards Tab */}
        {storeTab === 'daily' && (
          <div
            data-testid="daily-rewards-scroll"
            className="modal-scroll-y flex-1 min-h-0 p-3 sm:p-6 pb-8 space-y-4 sm:space-y-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/35 bg-[#101824] p-3.5 sm:p-4">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
                  7-Day Check-In Streak
                </div>
                <h3 className="mt-0.5 text-base sm:text-lg font-extrabold text-white">
                  Current Streak: {dailyReward?.streak ?? 0} Day
                  {(dailyReward?.streak ?? 0) === 1 ? '' : 's'}
                </h3>
                <p className="mt-0.5 text-xs text-slate-300">
                  Log in daily to escalate rewards up to +400 POOL COINS on Day 7. Resets if a UTC day is missed.
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {dailyReward?.canClaim ? (
                  <button
                    type="button"
                    data-testid="claim-daily-btn"
                    disabled={busyAction}
                    onClick={() => void handleClaimDaily()}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 sm:px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-emerald-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    <Sparkles className="h-4 w-4" />
                    Claim +{dailyReward.nextRewardCoins} POOL COINS
                  </button>
                ) : (
                  <div
                    data-testid="daily-countdown-box"
                    className="rounded-lg border border-white/12 bg-black/35 px-4 py-2 text-right"
                  >
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Next Reward Available In
                    </div>
                    <div
                      data-testid="daily-countdown-timer"
                      className="font-mono text-sm font-black tabular-nums text-amber-300"
                    >
                      {dailyReward
                        ? formatCountdown(dailyReward.nextClaimAtMs, nowMs)
                        : 'Syncing...'}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 pb-4">
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
                    data-testid={`daily-tier-${tier.day}`}
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
                    <div className="my-2.5 flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-lg border border-amber-400/35 bg-amber-500/12">
                      <Coins className="h-4 w-4 sm:h-5 sm:w-5 text-amber-400" />
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
          <div
            data-testid="ledger-scroll"
            className="modal-scroll-y flex-1 min-h-0 p-3 sm:p-6 pb-8 space-y-3"
          >
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
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-400">
                          <Clock className="h-3 w-3 shrink-0" />
                          <span>{formatTxTime(tx.createdAtMs)}</span>
                          {' · '}
                          <span className="font-mono break-all">{tx.referenceId}</span>
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

        {/* Mobile Item Inspector Modal Drawer (<lg only) */}
        {mobileInspectOpen && selectedItem && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Inspect ${selectedItem.name}`}
            className="lg:hidden absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-3"
          >
            <div className="modal-scroll-y relative w-full max-w-sm max-h-[85dvh] rounded-xl border border-amber-400/40 bg-[#090e14] p-4 shadow-2xl">
              <button
                type="button"
                aria-label="Close Details"
                onClick={() => setMobileInspectOpen(false)}
                className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="pr-8">{renderInspectorDetails(selectedItem)}</div>
            </div>
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
