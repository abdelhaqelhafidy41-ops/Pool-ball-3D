import {
  Award,
  Calendar,
  Check,
  Clock,
  Coins,
  Crown,
  Flame,
  Lock,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { soundEngine } from '../game/utils/SoundEngine';
import { battlePassClient } from '../multiplayer/BattlePassClient';
import { RARITY_META } from '../multiplayer/shared/economy';
import type {
  BattlePassTierStatus,
  BattlePassTrack,
  MissionProgressRecord,
} from '../multiplayer/shared/battlePass';
import { type BattlePassTab, useGameStore } from '../store/useGameStore';
import { formatCountdown } from './StoreModal';

function formatLongCountdown(targetMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const d = Math.floor(diffSec / 86400);
  const h = Math.floor((diffSec % 86400) / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  if (d > 0) {
    return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function MissionCard({
  mission,
  busyId,
  onClaim,
}: {
  mission: MissionProgressRecord;
  busyId: string | null;
  onClaim: (m: MissionProgressRecord) => void;
}) {
  const pct =
    mission.requiredProgress > 0
      ? Math.min(100, Math.round((mission.progress / mission.requiredProgress) * 100))
      : 0;
  const isBusy = busyId === `${mission.cadence}:${mission.missionId}`;

  return (
    <div
      data-testid={`mission-card-${mission.missionId}`}
      className={`rounded-xl border p-3.5 transition-colors ${
        mission.claimed
          ? 'border-white/10 bg-black/25 opacity-80'
          : mission.completed
            ? 'border-amber-400/55 bg-amber-500/10'
            : 'border-white/10 bg-white/[0.03]'
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h4 className="text-sm font-extrabold text-white">{mission.title}</h4>
            <span className="text-[11px] font-medium text-slate-400">
              {mission.cadence === 'daily' ? 'Daily UTC' : 'Weekly UTC'}
            </span>
            <span aria-hidden="true" className="text-slate-600">
              ·
            </span>
            <span
              className={`text-[11px] font-bold ${
                mission.claimed
                  ? 'text-slate-400'
                  : mission.completed
                    ? 'text-emerald-300'
                    : 'text-amber-300'
              }`}
            >
              {mission.claimed ? 'Claimed' : mission.completed ? 'Completed' : 'In Progress'}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-300 leading-relaxed">{mission.description}</p>

          <div className="mt-2.5 flex items-center gap-2.5">
            <div className="h-2 flex-1 overflow-hidden rounded bg-black/50 border border-white/10">
              <div
                className={`h-full transition-all ${
                  mission.completed ? 'bg-emerald-400' : 'bg-amber-500'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono text-xs font-bold tabular-nums text-slate-200 shrink-0">
              {mission.progress}/{mission.requiredProgress}
            </span>
          </div>
        </div>

        <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 shrink-0 sm:min-w-[152px]">
          <div className="text-left sm:text-right font-mono text-xs tabular-nums">
            <div className="font-extrabold text-amber-300">+{mission.rewardCoins} POOL COINS</div>
            <div className="text-[11px] font-semibold text-emerald-300">
              +{mission.rewardSeasonXp} Season XP
            </div>
          </div>

          {mission.completed && !mission.claimed ? (
            <button
              type="button"
              disabled={isBusy || busyId !== null}
              onClick={() => onClaim(mission)}
              data-testid={`claim-mission-${mission.missionId}`}
              className="inline-flex min-h-[44px] sm:min-h-0 items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Check className="h-3.5 w-3.5" />
              {isBusy ? 'Claiming...' : 'Claim Reward'}
            </button>
          ) : mission.claimed ? (
            <span className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-400 whitespace-nowrap">
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              Claimed
            </span>
          ) : (
            <span className="text-[11px] font-semibold text-slate-400 whitespace-nowrap">
              {mission.requiredProgress - mission.progress} remaining
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function TierTrackCell({
  level,
  track,
  spec,
  unlocked,
  busyKey,
  onClaim,
}: {
  level: number;
  track: BattlePassTrack;
  spec: BattlePassTierStatus['free'] | BattlePassTierStatus['premium'];
  unlocked: boolean;
  busyKey: string | null;
  onClaim: (level: number, track: BattlePassTrack) => void;
}) {
  const isPremiumTrack = track === 'premium';
  const lockedByPremium = 'lockedByPremium' in spec && spec.lockedByPremium;
  const cellKey = `tier:${level}:${track}`;
  const isBusy = busyKey === cellKey;
  const rarity = spec.item ? RARITY_META[spec.item.rarity] : null;

  if (!spec.hasReward) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-white/8 bg-black/25 px-3 py-2.5 text-xs text-slate-500">
        <span>{isPremiumTrack ? 'Premium' : 'Free'} Track</span>
        <span>No reward at this tier</span>
      </div>
    );
  }

  return (
    <div
      data-testid={`bp-tier-${level}-${track}`}
      className={`flex flex-col justify-between gap-2 rounded-lg border p-3 ${
        spec.claimed
          ? 'border-white/10 bg-black/30 opacity-80'
          : spec.canClaim
            ? 'border-amber-400/60 bg-amber-500/12'
            : isPremiumTrack && lockedByPremium
              ? 'border-white/10 bg-black/40'
              : 'border-white/12 bg-white/[0.03]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-bold">
            <span className={isPremiumTrack ? 'text-amber-300' : 'text-slate-300'}>
              {isPremiumTrack ? 'Premium' : 'Free'}
            </span>
            {rarity && spec.item && (
              <>
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <span className={rarity.textClass}>{rarity.label}</span>
              </>
            )}
          </div>

          {spec.item ? (
            <div className="mt-1 flex items-center gap-2">
              <span
                className="inline-block h-3.5 w-3.5 shrink-0 rounded border border-white/20"
                style={{ backgroundColor: spec.item.previewColors[0] }}
                aria-hidden="true"
              />
              <span className="text-xs font-extrabold text-white truncate">{spec.item.name}</span>
            </div>
          ) : null}

          {spec.coins > 0 && (
            <div className="mt-1 flex items-center gap-1 font-mono text-xs font-extrabold tabular-nums text-amber-300">
              <Coins className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span>+{spec.coins} POOL COINS</span>
            </div>
          )}
        </div>

        <div className="shrink-0">
          {spec.claimed ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-bold text-emerald-300">
              <Check className="h-3 w-3" />
              Claimed
            </span>
          ) : spec.canClaim ? (
            <button
              type="button"
              disabled={isBusy || busyKey !== null}
              onClick={() => onClaim(level, track)}
              data-testid={`claim-tier-${level}-${track}`}
              className="inline-flex min-h-[40px] sm:min-h-0 items-center justify-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              {isBusy ? 'Claiming...' : 'Claim'}
            </button>
          ) : lockedByPremium ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400">
              <Lock className="h-3 w-3 text-amber-400/80" />
              Premium Locked
            </span>
          ) : !unlocked ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500">
              <Lock className="h-3 w-3" />
              Lv {level}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function BattlePassModal() {
  const open = useGameStore((s) => s.battlePassModalOpen);
  const closeBattlePassModal = useGameStore((s) => s.closeBattlePassModal);
  const tab = useGameStore((s) => s.battlePassTab);
  const setTab = useGameStore((s) => s.setBattlePassTab);
  const overview = useGameStore((s) => s.battlePassOverview);
  const notice = useGameStore((s) => s.battlePassNotice);
  const setNotice = useGameStore((s) => s.setBattlePassNotice);
  const wallet = useGameStore((s) => s.wallet);

  const [tierFilter, setTierFilter] = useState<'all' | 'unlocked' | 'claimable' | 'cosmetics'>('all');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmPremiumOpen, setConfirmPremiumOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => battlePassClient.getTrustedNowMs());
  const rolloverRefreshRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirmPremiumOpen(false);
      return;
    }
    void battlePassClient.refreshOverview({ skipTransitionToasts: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const tick = () => {
      const trustedNow = battlePassClient.getTrustedNowMs();
      setNowMs(trustedNow);
      if (overview) {
        const nextReset = Math.min(
          overview.dailyResetAtMs,
          overview.weeklyResetAtMs,
          overview.season.endsAtMs,
        );
        if (trustedNow >= nextReset && rolloverRefreshRef.current !== nextReset) {
          rolloverRefreshRef.current = nextReset;
          void battlePassClient.refreshOverview();
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [open, overview]);

  const filteredTiers = useMemo(() => {
    if (!overview) return [];
    return overview.tiers.filter((t) => {
      if (tierFilter === 'unlocked') return t.unlocked;
      if (tierFilter === 'claimable') return t.free.canClaim || t.premium.canClaim;
      if (tierFilter === 'cosmetics') return Boolean(t.free.item || t.premium.item);
      return true;
    });
  }, [overview, tierFilter]);

  if (!open) return null;

  const coinBalance = wallet?.balance ?? 0;

  const handleClaimMission = async (mission: MissionProgressRecord) => {
    soundEngine.unlock();
    soundEngine.playUiClick();
    setNotice(null);
    setBusyKey(`${mission.cadence}:${mission.missionId}`);
    const res = await battlePassClient.claimMission(
      mission.missionId,
      mission.cadence,
      mission.periodKey,
    );
    setBusyKey(null);
    if (!res.ok || !res.data) {
      setNotice({ type: 'err', text: res.error ?? 'Could not claim mission reward.' });
      return;
    }
    setNotice({
      type: 'ok',
      text: res.data.alreadyClaimed
        ? 'Reward already claimed.'
        : `Claimed +${res.data.coinsAwarded} POOL COINS and +${res.data.seasonXpAwarded} Season XP.`,
    });
  };

  const handleClaimTier = async (level: number, track: BattlePassTrack) => {
    soundEngine.unlock();
    soundEngine.playUiClick();
    setNotice(null);
    setBusyKey(`tier:${level}:${track}`);
    const res = await battlePassClient.claimTierReward(level, track);
    setBusyKey(null);
    if (!res.ok || !res.data) {
      setNotice({ type: 'err', text: res.error ?? 'Could not claim tier reward.' });
      return;
    }
    setNotice({
      type: 'ok',
      text: res.data.alreadyClaimed
        ? 'Tier reward already claimed.'
        : `Tier ${level} (${track}) reward delivered to your account.`,
    });
  };

  const handleClaimAll = async () => {
    soundEngine.unlock();
    soundEngine.playUiClick();
    setNotice(null);
    setBusyKey('claim_all');
    const res = await battlePassClient.claimAllAvailable();
    setBusyKey(null);
    if (!res.ok || !res.data) {
      setNotice({ type: 'err', text: res.error ?? 'Could not claim pending rewards.' });
      return;
    }
    setNotice({
      type: 'ok',
      text: res.data.alreadyClaimed
        ? 'All unlocked rewards have already been claimed.'
        : `Claimed +${res.data.coinsAwarded} POOL COINS, +${res.data.seasonXpAwarded} Season XP, and ${res.data.grantedItemIds.length} cosmetic item(s).`,
    });
  };

  const handleUnlockPremium = async () => {
    soundEngine.unlock();
    soundEngine.playUiClick();
    setNotice(null);
    setBusyKey('unlock_premium');
    const res = await battlePassClient.unlockPremium();
    setBusyKey(null);
    setConfirmPremiumOpen(false);
    if (!res.ok || !res.data) {
      setNotice({ type: 'err', text: res.error ?? 'Unable to unlock Premium Battle Pass.' });
      return;
    }
    setNotice({
      type: 'ok',
      text: 'Premium Battle Pass unlocked! Claim your unlocked Premium tier rewards below.',
    });
  };

  const tabs: Array<{
    id: BattlePassTab;
    label: string;
    badge: number;
    icon: typeof Crown;
  }> = [
    {
      id: 'pass',
      label: 'Battle Pass',
      badge:
        (overview?.claimableCounts.battlePassFree ?? 0) +
        (overview?.claimableCounts.battlePassPremium ?? 0),
      icon: Crown,
    },
    {
      id: 'daily',
      label: 'Daily Missions',
      badge: overview?.claimableCounts.daily ?? 0,
      icon: Target,
    },
    {
      id: 'weekly',
      label: 'Weekly Challenges',
      badge: overview?.claimableCounts.weekly ?? 0,
      icon: Flame,
    },
    {
      id: 'stats',
      label: 'Season Stats',
      badge: 0,
      icon: Trophy,
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Seasonal Battle Pass and Daily Missions"
      data-testid="battle-pass-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-1.5 sm:p-4 pt-[max(0.375rem,env(safe-area-inset-top))] pb-[max(0.375rem,env(safe-area-inset-bottom))]"
    >
      <div
        data-testid="battle-pass-modal-shell"
        className="relative flex h-[94dvh] max-h-[94dvh] sm:h-[90dvh] sm:max-h-[90dvh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-amber-400/25 bg-[#0c1219] text-slate-100 shadow-2xl"
      >
        {/* Top Header */}
        <div className="shrink-0 border-b border-white/10 bg-[#090e14] px-3 py-2.5 sm:px-6 sm:py-3.5 space-y-2.5 lg:space-y-0 lg:flex lg:items-center lg:justify-between lg:gap-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-400/40 bg-amber-500/12">
                <Crown className="h-4.5 w-4.5 text-amber-400" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm sm:text-lg font-extrabold tracking-tight text-white truncate">
                  {overview?.season.name ?? 'SEASONAL BATTLE PASS'}
                </h2>
                <p className="text-[11px] text-slate-400 truncate">
                  {overview?.season.theme ?? 'Missions, Weekly Challenges & 30-Tier Progression'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 lg:hidden shrink-0">
              <div className="flex items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/12 px-2.5 py-1">
                <Coins className="h-3.5 w-3.5 text-amber-400" />
                <span className="font-mono text-xs font-black tabular-nums text-amber-300">
                  {coinBalance.toLocaleString()}
                </span>
              </div>
              <button
                type="button"
                aria-label="Close Battle Pass"
                onClick={() => {
                  soundEngine.playUiClick();
                  closeBattlePassModal();
                }}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="modal-scroll-x flex items-center gap-1 rounded-lg border border-white/10 bg-black/40 p-1">
            {tabs.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`bp-tab-${t.id}`}
                  onClick={() => {
                    soundEngine.playUiClick();
                    setTab(t.id);
                  }}
                  className={`inline-flex min-h-[40px] sm:min-h-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-amber-500 text-slate-950'
                      : 'text-slate-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <Icon className={`h-3.5 w-3.5 ${active ? 'text-slate-950' : 'text-amber-400'}`} />
                  <span>{t.label}</span>
                  {t.badge > 0 && (
                    <span
                      className={`rounded px-1.5 py-0.2 font-mono text-[10px] font-black tabular-nums ${
                        active ? 'bg-slate-950/20 text-slate-950' : 'bg-amber-500 text-slate-950'
                      }`}
                    >
                      {t.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Desktop Right Controls */}
          <div className="hidden lg:flex items-center gap-2 shrink-0">
            {overview && overview.claimableCounts.total > 0 && (
              <button
                type="button"
                disabled={busyKey !== null}
                onClick={handleClaimAll}
                data-testid="bp-claim-all-btn"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-emerald-400 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {busyKey === 'claim_all'
                  ? 'Claiming...'
                  : `Claim All (${overview.claimableCounts.total})`}
              </button>
            )}
            <div className="flex items-center gap-1.5 rounded-lg border border-amber-400/45 bg-amber-500/12 px-3 py-1.5">
              <Coins className="h-3.5 w-3.5 text-amber-400" />
              <span className="font-mono text-xs font-black tabular-nums text-amber-300">
                {coinBalance.toLocaleString()}
              </span>
            </div>
            <button
              type="button"
              aria-label="Close Battle Pass"
              onClick={() => {
                soundEngine.playUiClick();
                closeBattlePassModal();
              }}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mobile Claim All Bar if pending rewards exist */}
        {overview && overview.claimableCounts.total > 0 && (
          <div className="lg:hidden shrink-0 border-b border-white/10 bg-[#0d1620] px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-emerald-300">
              {overview.claimableCounts.total} reward(s) ready to claim
            </span>
            <button
              type="button"
              disabled={busyKey !== null}
              onClick={handleClaimAll}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-emerald-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {busyKey === 'claim_all' ? 'Claiming...' : 'Claim All'}
            </button>
          </div>
        )}

        {/* Inline Notice Banner */}
        {notice && (
          <div
            className={`shrink-0 mx-3 sm:mx-6 mt-3 rounded-lg border px-3.5 py-2 text-xs font-semibold flex items-center justify-between gap-2 ${
              notice.type === 'ok'
                ? 'border-emerald-400/40 bg-emerald-500/12 text-emerald-200'
                : 'border-rose-400/40 bg-rose-500/12 text-rose-200'
            }`}
          >
            <span>{notice.text}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-current/70 hover:text-current cursor-pointer"
              aria-label="Dismiss notice"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Main Scrollable Content */}
        <div className="modal-scroll-y flex-1 p-3 sm:p-6 space-y-5">
          {!overview ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-sm text-slate-400">
              Loading seasonal Battle Pass and mission objectives...
            </div>
          ) : tab === 'pass' ? (
            <>
              {/* Season Summary & Level Progress Card */}
              <div className="rounded-xl border border-amber-400/30 bg-gradient-to-br from-[#141c27] to-[#0d131b] p-4 sm:p-5">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-300">
                      <span className="font-extrabold text-amber-300">
                        Tier {overview.playerState.seasonLevel} / {overview.season.maxLevel}
                      </span>
                      <span aria-hidden="true" className="text-slate-600">
                        ·
                      </span>
                      <span className="font-mono tabular-nums">
                        {overview.playerState.seasonXp.toLocaleString()} Season XP
                      </span>
                      <span aria-hidden="true" className="text-slate-600">
                        ·
                      </span>
                      <span className="inline-flex items-center gap-1 font-mono tabular-nums text-slate-300">
                        <Clock className="h-3 w-3 text-amber-400" />
                        Season ends in {formatLongCountdown(overview.season.endsAtMs, nowMs)}
                      </span>
                    </div>

                    <div className="h-2.5 w-full overflow-hidden rounded bg-black/55 border border-white/10">
                      <div
                        className="h-full bg-amber-500 transition-all"
                        style={{
                          width: `${Math.round(overview.playerState.levelProgressRatio * 100)}%`,
                        }}
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-400">
                      <span>
                        {overview.playerState.xpForNextLevel !== null
                          ? `Next Tier: ${overview.playerState.xpIntoCurrentLevel} / ${overview.playerState.xpForNextLevel} XP`
                          : 'Maximum Season Tier Reached'}
                      </span>
                      <span>
                        Daily Match XP: {overview.playerState.dailyMatchXpEarned} /{' '}
                        {overview.config.dailyMatchXpCap} · AI XP:{' '}
                        {overview.playerState.dailyAiXpEarned} /{' '}
                        {overview.config.dailyAiMatchXpCap}
                      </span>
                    </div>
                  </div>

                  {/* Premium Pass Action */}
                  <div className="shrink-0">
                    {overview.playerState.premiumUnlocked ? (
                      <div className="inline-flex items-center gap-2 rounded-lg border border-amber-400/50 bg-amber-500/15 px-4 py-2.5 text-xs font-extrabold text-amber-200">
                        <ShieldCheck className="h-4 w-4 text-amber-400" />
                        Premium Battle Pass Active
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busyKey !== null}
                        onClick={() => {
                          soundEngine.playUiClick();
                          setConfirmPremiumOpen(true);
                        }}
                        data-testid="bp-unlock-premium-btn"
                        className="inline-flex w-full lg:w-auto min-h-[44px] items-center justify-center gap-2 rounded-lg bg-amber-500 px-5 py-2.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                      >
                        <Crown className="h-4 w-4" />
                        Unlock Premium · {overview.season.premiumPriceCoins.toLocaleString()} POOL COINS
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Tier Filters */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      { id: 'all', label: 'All 30 Tiers' },
                      { id: 'unlocked', label: 'Unlocked' },
                      { id: 'claimable', label: 'Claimable' },
                      { id: 'cosmetics', label: 'Exclusive Cosmetics' },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        setTierFilter(f.id);
                      }}
                      className={`min-h-[36px] rounded-md px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap ${
                        tierFilter === f.id
                          ? 'bg-amber-500 text-slate-950'
                          : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-slate-400">
                  Earn Season XP from Online Matches, Tournaments, Validated AI Matches &amp; Missions
                </span>
              </div>

              {/* 30-Tier Track List */}
              {filteredTiers.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-slate-400">
                  No tiers match the selected filter yet.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredTiers.map((tier) => (
                    <div
                      key={tier.level}
                      className={`grid grid-cols-1 md:grid-cols-[110px_1fr_1fr] gap-2.5 rounded-xl border p-3 ${
                        tier.unlocked
                          ? 'border-amber-400/35 bg-[#121a24]'
                          : 'border-white/10 bg-[#0e141c]'
                      }`}
                    >
                      <div className="flex md:flex-col items-center md:items-start justify-between md:justify-center gap-1 px-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-black tabular-nums border ${
                              tier.unlocked
                                ? 'border-amber-400/60 bg-amber-500 text-slate-950'
                                : 'border-white/15 bg-black/40 text-slate-300'
                            }`}
                          >
                            {tier.level}
                          </span>
                          <span className="text-xs font-bold text-slate-200 md:hidden">
                            Tier {tier.level}
                          </span>
                        </div>
                        <span className="font-mono text-[11px] tabular-nums text-slate-400">
                          {tier.cumulativeXpRequired.toLocaleString()} XP
                        </span>
                      </div>

                      <TierTrackCell
                        level={tier.level}
                        track="free"
                        spec={tier.free}
                        unlocked={tier.unlocked}
                        busyKey={busyKey}
                        onClaim={handleClaimTier}
                      />

                      <TierTrackCell
                        level={tier.level}
                        track="premium"
                        spec={tier.premium}
                        unlocked={tier.unlocked}
                        busyKey={busyKey}
                        onClaim={handleClaimTier}
                      />
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : tab === 'daily' ? (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-xl border border-white/10 bg-[#101822] px-4 py-3">
                <div>
                  <h3 className="text-sm font-extrabold text-white">Daily Missions</h3>
                  <p className="text-xs text-slate-400">
                    Objectives rotate daily at 00:00 UTC. Progress is verified automatically by the server.
                  </p>
                </div>
                <div className="inline-flex items-center gap-1.5 font-mono text-xs font-bold tabular-nums text-amber-300 shrink-0">
                  <Calendar className="h-3.5 w-3.5 text-amber-400" />
                  Resets in {formatCountdown(overview.dailyResetAtMs, nowMs)} UTC
                </div>
              </div>

              <div className="space-y-3">
                {overview.dailyMissions.map((m) => (
                  <MissionCard
                    key={`${m.periodKey}:${m.missionId}`}
                    mission={m}
                    busyId={busyKey}
                    onClaim={handleClaimMission}
                  />
                ))}
              </div>
            </>
          ) : tab === 'weekly' ? (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-xl border border-white/10 bg-[#101822] px-4 py-3">
                <div>
                  <h3 className="text-sm font-extrabold text-white">Weekly Challenges</h3>
                  <p className="text-xs text-slate-400">
                    High-value competitive objectives reset every Monday at 00:00 UTC.
                  </p>
                </div>
                <div className="inline-flex items-center gap-1.5 font-mono text-xs font-bold tabular-nums text-amber-300 shrink-0">
                  <Clock className="h-3.5 w-3.5 text-amber-400" />
                  Resets in {formatLongCountdown(overview.weeklyResetAtMs, nowMs)}
                </div>
              </div>

              <div className="space-y-3">
                {overview.weeklyChallenges.map((w) => (
                  <MissionCard
                    key={`${w.periodKey}:${w.missionId}`}
                    mission={w}
                    busyId={busyKey}
                    onClaim={handleClaimMission}
                  />
                ))}
              </div>
            </>
          ) : (
            /* Season Stats & Archive */
            <div className="space-y-5">
              <div className="rounded-xl border border-white/10 bg-[#101822] p-4 sm:p-5">
                <h3 className="text-sm font-extrabold text-white">
                  Current Season Summary · {overview.season.name}
                </h3>
                <p className="mt-1 text-xs text-slate-400">
                  Seasonal Battle Pass progress resets on season rollover. Your lifetime XP, level, ELO ranking, achievements, POOL COINS, and cosmetics are always preserved.
                </p>

                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono tabular-nums">
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">Battle Pass Level</div>
                    <div className="mt-1 text-lg font-black text-amber-300">
                      {overview.playerState.seasonLevel} / {overview.season.maxLevel}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">Season XP</div>
                    <div className="mt-1 text-lg font-black text-white">
                      {overview.playerState.seasonXp.toLocaleString()}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">Matches (W–L)</div>
                    <div className="mt-1 text-lg font-black text-white">
                      {overview.playerState.wins}W–{overview.playerState.losses}L
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">Best Win Streak</div>
                    <div className="mt-1 text-lg font-black text-emerald-300">
                      {overview.playerState.bestWinStreak}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">Balls Pocketed</div>
                    <div className="mt-1 text-lg font-black text-white">
                      {overview.playerState.ballsPocketed}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">Daily Missions</div>
                    <div className="mt-1 text-lg font-black text-amber-300">
                      {overview.playerState.dailyMissionsCompleted}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">Weekly Challenges</div>
                    <div className="mt-1 text-lg font-black text-amber-300">
                      {overview.playerState.weeklyChallengesCompleted}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">Tournaments</div>
                    <div className="mt-1 text-lg font-black text-white">
                      {overview.playerState.tournamentsPlayed}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#101822] p-4 sm:p-5">
                <div className="flex items-center gap-2">
                  <Award className="h-4 w-4 text-amber-400" />
                  <h3 className="text-sm font-extrabold text-white">Past Seasons Archive</h3>
                </div>
                {overview.pastSeasons.length === 0 ? (
                  <p className="mt-3 text-xs text-slate-400">
                    No completed Battle Pass seasons yet. Your record from {overview.season.name} will be archived here when the season concludes.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2.5">
                    {overview.pastSeasons.map((past) => (
                      <div
                        key={past.season.seasonId}
                        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3.5 py-2.5"
                      >
                        <div>
                          <div className="text-xs font-extrabold text-white">{past.season.name}</div>
                          <div className="text-[11px] text-slate-400">{past.season.theme}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-slate-300">
                          <span className="text-amber-300 font-bold">
                            Tier {past.seasonLevel}/{past.season.maxLevel}
                          </span>
                          <span>{past.seasonXp.toLocaleString()} XP</span>
                          <span>
                            {past.wins}W / {past.matchesPlayed}M
                          </span>
                          {past.premiumUnlocked && (
                            <span className="text-emerald-300 font-semibold">Premium</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Premium Unlock Confirmation Overlay */}
        {confirmPremiumOpen && overview && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/75 p-4">
            <div className="w-full max-w-md rounded-xl border border-amber-400/45 bg-[#101822] p-5 shadow-2xl space-y-4">
              <div className="flex items-center gap-2.5">
                <Crown className="h-5 w-5 text-amber-400" />
                <h3 className="text-base font-extrabold text-white">
                  Unlock Premium Battle Pass
                </h3>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Unlock every Premium Track cosmetic and POOL COINS reward for{' '}
                <strong className="text-white">{overview.season.name}</strong> using your in-game virtual balance. All already-earned tiers up to Level{' '}
                {overview.playerState.seasonLevel} become immediately claimable.
              </p>
              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/35 px-3.5 py-2.5 text-xs font-mono tabular-nums">
                <span className="font-sans text-slate-300">Price</span>
                <span className="font-extrabold text-amber-300">
                  {overview.season.premiumPriceCoins.toLocaleString()} POOL COINS
                </span>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={busyKey === 'unlock_premium'}
                  onClick={() => setConfirmPremiumOpen(false)}
                  className="min-h-[40px] rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busyKey === 'unlock_premium'}
                  onClick={handleUnlockPremium}
                  data-testid="bp-confirm-premium-btn"
                  className="min-h-[40px] rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
                >
                  {busyKey === 'unlock_premium' ? 'Unlocking...' : 'Confirm Unlock'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
