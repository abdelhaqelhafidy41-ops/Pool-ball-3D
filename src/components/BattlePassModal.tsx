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
import {
  getActiveRuntimeLanguage,
  localizeCosmeticItem,
  localizeMission,
  localizeRarity,
  localizeSeasonNameAndTheme,
  localizeServerError,
  tLang,
  useTranslation,
} from '../i18n';
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

function formatLongCountdown(
  targetMs: number,
  nowMs: number,
  lang = getActiveRuntimeLanguage(),
): string {
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const d = Math.floor(diffSec / 86400);
  const h = Math.floor((diffSec % 86400) / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  if (d > 0) {
    return tLang(lang, 'common.countdownDaysHoursMins', {
      d,
      h: String(h).padStart(2, '0'),
      m: String(m).padStart(2, '0'),
    });
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
  const { t, language, formatNumber } = useTranslation();
  const locMission = localizeMission(mission.missionId, mission.title, mission.description, language);
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
            <h4 className="text-sm font-extrabold text-white">{locMission.title}</h4>
            <span className="text-[11px] font-medium text-slate-400">
              {mission.cadence === 'daily' ? t('battlePass.dailyUtc') : t('battlePass.weeklyUtc')}
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
              {mission.claimed
                ? t('battlePass.statusClaimed')
                : mission.completed
                  ? t('battlePass.statusCompleted')
                  : t('battlePass.statusInProgress')}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-300 leading-relaxed">{locMission.description}</p>

          <div className="mt-2.5 flex items-center gap-2.5">
            <div className="h-2 flex-1 overflow-hidden rounded bg-black/50 border border-white/10">
              <div
                className={`h-full transition-all ${
                  mission.completed ? 'bg-emerald-400' : 'bg-amber-500'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span
              dir="ltr"
              className="font-mono text-xs font-bold tabular-nums text-slate-200 shrink-0"
            >
              {mission.progress}/{mission.requiredProgress}
            </span>
          </div>
        </div>

        <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 shrink-0 sm:min-w-[152px]">
          <div className="text-start sm:text-end font-mono text-xs tabular-nums">
            <div className="font-extrabold text-amber-300">
              {t('battlePass.rewardCoins', { coins: formatNumber(mission.rewardCoins) })}
            </div>
            <div className="text-[11px] font-semibold text-emerald-300">
              {t('battlePass.rewardSeasonXp', { xp: formatNumber(mission.rewardSeasonXp) })}
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
              {isBusy ? t('common.claiming') : t('battlePass.claimRewardBtn')}
            </button>
          ) : mission.claimed ? (
            <span className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-400 whitespace-nowrap">
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              {t('battlePass.statusClaimed')}
            </span>
          ) : (
            <span className="text-[11px] font-semibold text-slate-400 whitespace-nowrap">
              {t('battlePass.remainingProgress', {
                count: Math.max(0, mission.requiredProgress - mission.progress),
              })}
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
  const { t, language, formatNumber } = useTranslation();
  const isPremiumTrack = track === 'premium';
  const lockedByPremium = 'lockedByPremium' in spec && spec.lockedByPremium;
  const cellKey = `tier:${level}:${track}`;
  const isBusy = busyKey === cellKey;
  const rarity = spec.item ? RARITY_META[spec.item.rarity] : null;
  const locItem = spec.item ? localizeCosmeticItem(spec.item, language) : null;

  if (!spec.hasReward) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-white/8 bg-black/25 px-3 py-2.5 text-xs text-slate-500">
        <span>{isPremiumTrack ? t('battlePass.premiumTrackLabel') : t('battlePass.freeTrackLabel')}</span>
        <span>{t('battlePass.noRewardAtTier')}</span>
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
              {isPremiumTrack ? t('battlePass.trackPremium') : t('battlePass.trackFree')}
            </span>
            {rarity && spec.item && (
              <>
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <span className={rarity.textClass}>{localizeRarity(spec.item.rarity, language)}</span>
              </>
            )}
          </div>

          {spec.item && locItem ? (
            <div className="mt-1 flex items-center gap-2">
              <span
                className="inline-block h-3.5 w-3.5 shrink-0 rounded border border-white/20"
                style={{ backgroundColor: spec.item.previewColors[0] }}
                aria-hidden="true"
              />
              <span className="text-xs font-extrabold text-white truncate">{locItem.name}</span>
            </div>
          ) : null}

          {spec.coins > 0 && (
            <div className="mt-1 flex items-center gap-1 font-mono text-xs font-extrabold tabular-nums text-amber-300">
              <Coins className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span>{t('battlePass.rewardCoins', { coins: formatNumber(spec.coins) })}</span>
            </div>
          )}
        </div>

        <div className="shrink-0">
          {spec.claimed ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-bold text-emerald-300">
              <Check className="h-3 w-3" />
              {t('battlePass.claimedBadge')}
            </span>
          ) : spec.canClaim ? (
            <button
              type="button"
              disabled={isBusy || busyKey !== null}
              onClick={() => onClaim(level, track)}
              data-testid={`claim-tier-${level}-${track}`}
              className="inline-flex min-h-[40px] sm:min-h-0 items-center justify-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              {isBusy ? t('common.claiming') : t('battlePass.claimBtn')}
            </button>
          ) : lockedByPremium ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400">
              <Lock className="h-3 w-3 text-amber-400/80" />
              {t('battlePass.premiumLocked')}
            </span>
          ) : !unlocked ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500">
              <Lock className="h-3 w-3" />
              {t('battlePass.levelShortValue', { level })}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function BattlePassModal() {
  const { t, language, formatNumber } = useTranslation();
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
    return overview.tiers.filter((tier) => {
      if (tierFilter === 'unlocked') return tier.unlocked;
      if (tierFilter === 'claimable') return tier.free.canClaim || tier.premium.canClaim;
      if (tierFilter === 'cosmetics') return Boolean(tier.free.item || tier.premium.item);
      return true;
    });
  }, [overview, tierFilter]);

  if (!open) return null;

  const coinBalance = wallet?.balance ?? 0;
  const seasonMeta = overview
    ? localizeSeasonNameAndTheme(
        overview.season.seasonNumber,
        overview.season.name,
        overview.season.theme,
        language,
      )
    : null;

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
      setNotice({
        type: 'err',
        text: localizeServerError(res.error, language) || t('common.actionFailed'),
      });
      return;
    }
    setNotice({
      type: 'ok',
      text: res.data.alreadyClaimed
        ? t('battlePass.noticeAlreadyClaimed')
        : t('battlePass.noticeMissionClaimed', {
            coins: formatNumber(res.data.coinsAwarded),
            xp: formatNumber(res.data.seasonXpAwarded),
          }),
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
      setNotice({
        type: 'err',
        text: localizeServerError(res.error, language) || t('common.actionFailed'),
      });
      return;
    }
    setNotice({
      type: 'ok',
      text: res.data.alreadyClaimed
        ? t('battlePass.noticeAlreadyClaimed')
        : t('battlePass.noticeTierClaimed', {
            level,
            track: track === 'premium' ? t('battlePass.trackPremium') : t('battlePass.trackFree'),
          }),
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
      setNotice({
        type: 'err',
        text: localizeServerError(res.error, language) || t('common.actionFailed'),
      });
      return;
    }
    setNotice({
      type: 'ok',
      text: res.data.alreadyClaimed
        ? t('battlePass.noticeAllClaimed')
        : t('battlePass.noticeClaimAllSuccess', {
            coins: formatNumber(res.data.coinsAwarded),
            xp: formatNumber(res.data.seasonXpAwarded),
            items: formatNumber(res.data.grantedItemIds.length),
          }),
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
      setNotice({
        type: 'err',
        text: localizeServerError(res.error, language) || t('common.actionFailed'),
      });
      return;
    }
    setNotice({
      type: 'ok',
      text: t('battlePass.noticePremiumUnlocked'),
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
      label: t('battlePass.tabShortPass'),
      badge:
        (overview?.claimableCounts.battlePassFree ?? 0) +
        (overview?.claimableCounts.battlePassPremium ?? 0),
      icon: Crown,
    },
    {
      id: 'daily',
      label: t('battlePass.tabDailyMissions'),
      badge: overview?.claimableCounts.daily ?? 0,
      icon: Target,
    },
    {
      id: 'weekly',
      label: t('battlePass.tabWeeklyChallenges'),
      badge: overview?.claimableCounts.weekly ?? 0,
      icon: Flame,
    },
    {
      id: 'stats',
      label: t('battlePass.tabShortStats'),
      badge: 0,
      icon: Trophy,
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('battlePass.dialogAria')}
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
                  {seasonMeta?.name ?? t('battlePass.defaultTitle')}
                </h2>
                <p className="text-[11px] text-slate-400 truncate">
                  {seasonMeta?.theme ?? t('battlePass.defaultSubtitle')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 lg:hidden shrink-0">
              <div className="flex items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/12 px-2.5 py-1">
                <Coins className="h-3.5 w-3.5 text-amber-400" />
                <span className="font-mono text-xs font-black tabular-nums text-amber-300">
                  {formatNumber(coinBalance)}
                </span>
              </div>
              <button
                type="button"
                aria-label={t('battlePass.closeAria')}
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
            {tabs.map((tabItem) => {
              const Icon = tabItem.icon;
              const active = tab === tabItem.id;
              return (
                <button
                  key={tabItem.id}
                  type="button"
                  data-testid={`bp-tab-${tabItem.id}`}
                  onClick={() => {
                    soundEngine.playUiClick();
                    setTab(tabItem.id);
                  }}
                  className={`inline-flex min-h-[40px] sm:min-h-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-amber-500 text-slate-950'
                      : 'text-slate-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <Icon className={`h-3.5 w-3.5 ${active ? 'text-slate-950' : 'text-amber-400'}`} />
                  <span>{tabItem.label}</span>
                  {tabItem.badge > 0 && (
                    <span
                      className={`rounded px-1.5 py-0.2 font-mono text-[10px] font-black tabular-nums ${
                        active ? 'bg-slate-950/20 text-slate-950' : 'bg-amber-500 text-slate-950'
                      }`}
                    >
                      {tabItem.badge}
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
                  ? t('common.claiming')
                  : t('battlePass.claimAllBtn', { count: overview.claimableCounts.total })}
              </button>
            )}
            <div className="flex items-center gap-1.5 rounded-lg border border-amber-400/45 bg-amber-500/12 px-3 py-1.5">
              <Coins className="h-3.5 w-3.5 text-amber-400" />
              <span className="font-mono text-xs font-black tabular-nums text-amber-300">
                {formatNumber(coinBalance)}
              </span>
            </div>
            <button
              type="button"
              aria-label={t('battlePass.closeAria')}
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
              {t('battlePass.rewardsReadyToClaim', { count: overview.claimableCounts.total })}
            </span>
            <button
              type="button"
              disabled={busyKey !== null}
              onClick={handleClaimAll}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-emerald-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {busyKey === 'claim_all' ? t('common.claiming') : t('battlePass.claimAllShort')}
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
              aria-label={t('battlePass.dismissNoticeAria')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Main Scrollable Content */}
        <div className="modal-scroll-y flex-1 p-3 sm:p-6 space-y-5">
          {!overview ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-sm text-slate-400">
              {t('battlePass.loadingOverview')}
            </div>
          ) : tab === 'pass' ? (
            <>
              {/* Season Summary & Level Progress Card */}
              <div className="rounded-xl border border-amber-400/30 bg-gradient-to-br from-[#141c27] to-[#0d131b] p-4 sm:p-5">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-300">
                      <span className="font-extrabold text-amber-300">
                        {t('battlePass.tierOfMax', {
                          level: overview.playerState.seasonLevel,
                          max: overview.season.maxLevel,
                        })}
                      </span>
                      <span aria-hidden="true" className="text-slate-600">
                        ·
                      </span>
                      <span className="font-mono tabular-nums">
                        {t('battlePass.seasonXpTotal', {
                          xp: formatNumber(overview.playerState.seasonXp),
                        })}
                      </span>
                      <span aria-hidden="true" className="text-slate-600">
                        ·
                      </span>
                      <span className="inline-flex items-center gap-1 font-mono tabular-nums text-slate-300">
                        <Clock className="h-3 w-3 text-amber-400" />
                        {t('battlePass.seasonEndsIn', {
                          time: formatLongCountdown(overview.season.endsAtMs, nowMs, language),
                        })}
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
                          ? t('battlePass.nextTierProgress', {
                              into: formatNumber(overview.playerState.xpIntoCurrentLevel),
                              next: formatNumber(overview.playerState.xpForNextLevel),
                            })
                          : t('battlePass.maxSeasonTierReached')}
                      </span>
                      <span>
                        {t('battlePass.dailyXpSummary', {
                          earned: overview.playerState.dailyMatchXpEarned,
                          cap: overview.config.dailyMatchXpCap,
                          aiEarned: overview.playerState.dailyAiXpEarned,
                          aiCap: overview.config.dailyAiMatchXpCap,
                        })}
                      </span>
                    </div>
                  </div>

                  {/* Premium Pass Action */}
                  <div className="shrink-0">
                    {overview.playerState.premiumUnlocked ? (
                      <div className="inline-flex items-center gap-2 rounded-lg border border-amber-400/50 bg-amber-500/15 px-4 py-2.5 text-xs font-extrabold text-amber-200">
                        <ShieldCheck className="h-4 w-4 text-amber-400" />
                        {t('battlePass.premiumActiveBadge')}
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
                        {t('battlePass.unlockPremiumCta', {
                          price: formatNumber(overview.season.premiumPriceCoins),
                        })}
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
                      { id: 'all', label: t('battlePass.filterAllTiers') },
                      { id: 'unlocked', label: t('battlePass.filterUnlocked') },
                      { id: 'claimable', label: t('battlePass.filterClaimable') },
                      { id: 'cosmetics', label: t('battlePass.filterCosmetics') },
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
                <span className="text-xs text-slate-400">{t('battlePass.earnXpHint')}</span>
              </div>

              {/* 30-Tier Track List */}
              {filteredTiers.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-slate-400">
                  {t('battlePass.noTiersMatch')}
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
                            {t('battlePass.tierNumberLabel', { level: tier.level })}
                          </span>
                        </div>
                        <span className="font-mono text-[11px] tabular-nums text-slate-400">
                          {t('common.xpAmount', { count: formatNumber(tier.cumulativeXpRequired) })}
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
                  <h3 className="text-sm font-extrabold text-white">
                    {t('battlePass.dailyMissionsTitle')}
                  </h3>
                  <p className="text-xs text-slate-400">{t('battlePass.dailyMissionsDesc')}</p>
                </div>
                <div className="inline-flex items-center gap-1.5 font-mono text-xs font-bold tabular-nums text-amber-300 shrink-0">
                  <Calendar className="h-3.5 w-3.5 text-amber-400" />
                  <span dir="ltr">{t('battlePass.resetsInUtc', { time: formatCountdown(overview.dailyResetAtMs, nowMs) })}</span>
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
                  <h3 className="text-sm font-extrabold text-white">
                    {t('battlePass.weeklyChallengesTitle')}
                  </h3>
                  <p className="text-xs text-slate-400">{t('battlePass.weeklyChallengesDesc')}</p>
                </div>
                <div className="inline-flex items-center gap-1.5 font-mono text-xs font-bold tabular-nums text-amber-300 shrink-0">
                  <Clock className="h-3.5 w-3.5 text-amber-400" />
                  {t('battlePass.resetsIn', {
                    time: formatLongCountdown(overview.weeklyResetAtMs, nowMs, language),
                  })}
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
                  {t('battlePass.currentSeasonSummaryTitle', {
                    season: seasonMeta?.name ?? overview.season.name,
                  })}
                </h3>
                <p className="mt-1 text-xs text-slate-400">{t('battlePass.seasonResetNote')}</p>

                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono tabular-nums">
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      {t('battlePass.statBpLevel')}
                    </div>
                    <div dir="ltr" className="mt-1 text-lg font-black text-amber-300">
                      {overview.playerState.seasonLevel} / {overview.season.maxLevel}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      {t('battlePass.statSeasonXp')}
                    </div>
                    <div className="mt-1 text-lg font-black text-white">
                      {formatNumber(overview.playerState.seasonXp)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      {t('battlePass.statMatchesWl')}
                    </div>
                    <div className="mt-1 text-lg font-black text-white">
                      {t('menu.statsWinsLosses', {
                        wins: overview.playerState.wins,
                        losses: overview.playerState.losses,
                      })}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      {t('battlePass.statBestWinStreak')}
                    </div>
                    <div className="mt-1 text-lg font-black text-emerald-300">
                      {formatNumber(overview.playerState.bestWinStreak)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      {t('battlePass.statBallsPocketed')}
                    </div>
                    <div className="mt-1 text-lg font-black text-white">
                      {formatNumber(overview.playerState.ballsPocketed)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      {t('battlePass.statDailyMissions')}
                    </div>
                    <div className="mt-1 text-lg font-black text-amber-300">
                      {formatNumber(overview.playerState.dailyMissionsCompleted)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      {t('battlePass.statWeeklyChallenges')}
                    </div>
                    <div className="mt-1 text-lg font-black text-amber-300">
                      {formatNumber(overview.playerState.weeklyChallengesCompleted)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      {t('battlePass.statTournaments')}
                    </div>
                    <div className="mt-1 text-lg font-black text-white">
                      {formatNumber(overview.playerState.tournamentsPlayed)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#101822] p-4 sm:p-5">
                <div className="flex items-center gap-2">
                  <Award className="h-4 w-4 text-amber-400" />
                  <h3 className="text-sm font-extrabold text-white">
                    {t('battlePass.pastSeasonsArchiveTitle')}
                  </h3>
                </div>
                {overview.pastSeasons.length === 0 ? (
                  <p className="mt-3 text-xs text-slate-400">
                    {t('battlePass.noPastSeasonsLong', {
                      season: seasonMeta?.name ?? overview.season.name,
                    })}
                  </p>
                ) : (
                  <div className="mt-3 space-y-2.5">
                    {overview.pastSeasons.map((past) => {
                      const pastMeta = localizeSeasonNameAndTheme(
                        past.season.seasonNumber,
                        past.season.name,
                        past.season.theme,
                        language,
                      );
                      return (
                        <div
                          key={past.season.seasonId}
                          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3.5 py-2.5"
                        >
                          <div>
                            <div className="text-xs font-extrabold text-white">{pastMeta.name}</div>
                            <div className="text-[11px] text-slate-400">{pastMeta.theme}</div>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-slate-300">
                            <span className="text-amber-300 font-bold">
                              {t('battlePass.tierOfMax', {
                                level: past.seasonLevel,
                                max: past.season.maxLevel,
                              })}
                            </span>
                            <span>
                              {t('common.xpAmount', { count: formatNumber(past.seasonXp) })}
                            </span>
                            <span>
                              {t('battlePass.pastWinsMatches', {
                                wins: past.wins,
                                matches: past.matchesPlayed,
                              })}
                            </span>
                            {past.premiumUnlocked && (
                              <span className="text-emerald-300 font-semibold">
                                {t('battlePass.pastPremium')}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
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
                  {t('battlePass.confirmPremiumTitle')}
                </h3>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {t('battlePass.confirmPremiumBody', {
                  season: seasonMeta?.name ?? overview.season.name,
                  level: overview.playerState.seasonLevel,
                })}
              </p>
              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/35 px-3.5 py-2.5 text-xs font-mono tabular-nums">
                <span className="font-sans text-slate-300">{t('battlePass.priceLabel')}</span>
                <span className="font-extrabold text-amber-300">
                  {formatNumber(overview.season.premiumPriceCoins)}
                </span>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={busyKey === 'unlock_premium'}
                  onClick={() => setConfirmPremiumOpen(false)}
                  className="min-h-[40px] rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={busyKey === 'unlock_premium'}
                  onClick={handleUnlockPremium}
                  data-testid="bp-confirm-premium-btn"
                  className="min-h-[40px] rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
                >
                  {busyKey === 'unlock_premium'
                    ? t('battlePass.unlockingBtn')
                    : t('battlePass.confirmUnlockBtn')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
