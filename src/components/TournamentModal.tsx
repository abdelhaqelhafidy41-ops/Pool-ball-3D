import {
  Award,
  BarChart3,
  Check,
  Clock,
  Coins,
  Copy,
  Crown,
  Eye,
  KeyRound,
  Play,
  PlusCircle,
  RefreshCw,
  Shield,
  Swords,
  Timer,
  Trophy,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RuleProfileId } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { progressionClient } from '../multiplayer/ProgressionClient';
import { tournamentClient } from '../multiplayer/TournamentClient';
import { getAvatarVisualMeta } from '../multiplayer/shared/economy';
import {
  TOURNAMENT_TROPHY_CATALOG,
  getCurrentSeasonKey,
  type TournamentCapacity,
  type TournamentMatch,
  type TournamentMatchResolutionType,
  type TournamentRecord,
  type TournamentStatus,
  type TournamentType,
} from '../multiplayer/shared/tournaments';
import {
  formatLocalizedDateTime,
  localizeRuleProfile,
  localizeServerError,
  localizeTournamentRoundLabel,
  localizeTournamentStatus,
  localizeTournamentTrophy,
  localizeTournamentType,
  tLang,
  type AppLanguage,
  useTranslation,
} from '../i18n';
import { type TournamentTab, useGameStore } from '../store/useGameStore';

function formatCountdownMs(targetMs: number, nowMs: number, lang: AppLanguage): string {
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const d = Math.floor(diffSec / 86400);
  const h = Math.floor((diffSec % 86400) / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  if (d > 0) return tLang(lang, 'common.countdownDaysHours', { d, h });
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDateTime(ms: number | null, lang: AppLanguage): string {
  if (!ms) return '—';
  return formatLocalizedDateTime(ms, lang) || '—';
}

function statusTextClass(status: TournamentStatus): string {
  switch (status) {
    case 'registration_open':
      return 'text-emerald-300';
    case 'in_progress':
      return 'text-amber-300';
    case 'completed':
      return 'text-sky-300';
    case 'cancelled':
      return 'text-rose-300';
    case 'upcoming':
    default:
      return 'text-slate-300';
  }
}

function placementLabel(placement: number | null, lang: AppLanguage): string {
  if (!placement) return '—';
  if (placement === 1) return tLang(lang, 'tournaments.placementChampion');
  if (placement === 2) return tLang(lang, 'tournaments.placementRunnerUp');
  if (placement === 3) return tLang(lang, 'tournaments.placementThirdPlace');
  return tLang(lang, 'tournaments.placementOrdinal', { place: placement });
}

function localizeParticipantStatus(status: string, lang: AppLanguage): string {
  switch (status) {
    case 'champion':
      return tLang(lang, 'tournaments.placementChampion');
    case 'registered':
      return tLang(lang, 'tournaments.enteredBadge');
    case 'active':
    case 'checked_in':
      return tLang(lang, 'common.active');
    case 'eliminated':
      return tLang(lang, 'tournaments.statusCompletedCard');
    case 'withdrawn':
      return tLang(lang, 'tournaments.withdrawBtn');
    default:
      return status;
  }
}

function localizePayoutPlacement(placement: string, lang: AppLanguage): string {
  switch (placement) {
    case 'champion':
      return tLang(lang, 'tournaments.placementChampion');
    case 'runner_up':
      return tLang(lang, 'tournaments.placementRunnerUp');
    case 'third_place':
      return tLang(lang, 'tournaments.placementThirdPlace');
    default:
      return placement.replace(/_/g, ' ');
  }
}

function BracketMatchCard({
  match,
  viewerPlayerId,
  nowMs,
  busyMatchId,
  isPrivateTournament,
  onEnterMatch,
  onSpectateMatch,
}: {
  match: TournamentMatch;
  viewerPlayerId: string | null;
  nowMs: number;
  busyMatchId: string | null;
  isPrivateTournament?: boolean;
  onEnterMatch: (matchId: string) => void;
  onSpectateMatch?: (roomId: string) => void;
}) {
  const { t, language } = useTranslation();
  const isParticipant = Boolean(
    viewerPlayerId && (match.player1Id === viewerPlayerId || match.player2Id === viewerPlayerId),
  );
  const canJoin =
    isParticipant && (match.status === 'ready' || match.status === 'in_progress');
  const canWatchLive = Boolean(
    !isParticipant &&
      !isPrivateTournament &&
      match.status === 'in_progress' &&
      match.roomId &&
      onSpectateMatch,
  );
  const p1Av = match.player1Avatar ? getAvatarVisualMeta(match.player1Avatar) : null;
  const p2Av = match.player2Avatar ? getAvatarVisualMeta(match.player2Avatar) : null;
  const p1Won = Boolean(match.winnerId && match.winnerId === match.player1Id);
  const p2Won = Boolean(match.winnerId && match.winnerId === match.player2Id);
  const localizedRound = localizeTournamentRoundLabel(match.roundLabel, language);
  const matchStatusLabel =
    match.status === 'ready' && match.readyDeadlineMs
      ? t('tournaments.readyCountdown', { time: formatCountdownMs(match.readyDeadlineMs, nowMs, language) })
      : match.status === 'ready'
        ? t('tournaments.statusReady')
        : match.status === 'in_progress'
          ? t('tournaments.statusInProgressCard')
          : match.status === 'completed'
            ? t('tournaments.statusCompletedCard')
            : match.status === 'bye'
              ? t('tournaments.statusBye')
              : match.status === 'forfeited'
                ? t('tournaments.statusForfeited')
                : t('tournaments.statusPending');

  return (
    <div
      className={`rounded-xl border p-2.5 text-xs transition-colors ${
        canJoin
          ? 'border-amber-400/70 bg-amber-500/10'
          : match.status === 'in_progress'
            ? 'border-emerald-400/40 bg-[#101924]'
            : 'border-white/10 bg-[#101924]'
      }`}
    >
      <div className="flex items-center justify-between gap-2 pb-1.5 mb-1.5 border-b border-white/10 text-[10px]">
        <span className="font-bold uppercase tracking-wider text-slate-400 truncate">
          {match.isThirdPlaceMatch
            ? t('tournaments.thirdPlace')
            : t('tournaments.bracketSlotLabel', { round: localizedRound, slot: match.slotIndex + 1 })}
        </span>
        <span
          dir={match.status === 'ready' && match.readyDeadlineMs ? 'ltr' : undefined}
          className={`font-bold uppercase tracking-wider shrink-0 tabular-nums ${
            match.status === 'ready'
              ? 'text-amber-300'
              : match.status === 'in_progress'
                ? 'text-emerald-300'
                : match.status === 'completed'
                  ? 'text-sky-300'
                  : match.status === 'bye'
                    ? 'text-slate-400'
                    : match.status === 'forfeited'
                      ? 'text-rose-300'
                      : 'text-slate-500'
          }`}
        >
          {matchStatusLabel}
        </span>
      </div>

      {/* Player 1 */}
      <div
        className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1 ${
          p1Won ? 'bg-amber-500/15 text-amber-200 font-extrabold' : 'text-slate-200'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span dir="ltr" className="w-5 text-[10px] font-mono tabular-nums text-slate-400 shrink-0">
            {match.player1Seed ? `#${match.player1Seed}` : '—'}
          </span>
          {p1Av && (
            <span
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold"
              style={{ backgroundColor: `${p1Av.accent}22`, color: p1Av.accent }}
            >
              {p1Av.glyph}
            </span>
          )}
          <span className="truncate">
            {match.player1Name ?? (match.status === 'bye' ? t('tournaments.byeSlot') : t('tournaments.tbdSlot'))}
          </span>
        </div>
        <span className="text-[10px] font-mono tabular-nums shrink-0 text-slate-400">
          {p1Won ? t('tournaments.winBadge') : match.player1Joined && match.status === 'ready' ? t('tournaments.inBadge') : ''}
        </span>
      </div>

      {/* Player 2 */}
      <div
        className={`mt-1 flex items-center justify-between gap-2 rounded-lg px-2 py-1 ${
          p2Won ? 'bg-amber-500/15 text-amber-200 font-extrabold' : 'text-slate-200'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span dir="ltr" className="w-5 text-[10px] font-mono tabular-nums text-slate-400 shrink-0">
            {match.player2Seed ? `#${match.player2Seed}` : '—'}
          </span>
          {p2Av && (
            <span
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold"
              style={{ backgroundColor: `${p2Av.accent}22`, color: p2Av.accent }}
            >
              {p2Av.glyph}
            </span>
          )}
          <span className="truncate">
            {match.player2Name ?? (match.status === 'bye' ? t('tournaments.byeSlot') : t('tournaments.tbdSlot'))}
          </span>
        </div>
        <span className="text-[10px] font-mono tabular-nums shrink-0 text-slate-400">
          {p2Won ? t('tournaments.winBadge') : match.player2Joined && match.status === 'ready' ? t('tournaments.inBadge') : ''}
        </span>
      </div>

      {canJoin && (
        <button
          type="button"
          disabled={busyMatchId === match.bracketMatchId}
          onClick={() => onEnterMatch(match.bracketMatchId)}
          className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
        >
          <Swords className="h-3.5 w-3.5 shrink-0" />
          {busyMatchId === match.bracketMatchId ? t('common.connecting') : t('tournaments.enterMatchBtn')}
        </button>
      )}
      {canWatchLive && match.roomId && (
        <button
          type="button"
          data-testid={`watch-bracket-match-${match.bracketMatchId}`}
          onClick={() => onSpectateMatch?.(match.roomId!)}
          className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-400/45 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider text-emerald-200 hover:bg-emerald-500/25 cursor-pointer whitespace-nowrap"
        >
          <Eye className="h-3.5 w-3.5 shrink-0" />
          {t('tournaments.watchLiveBtn')}
        </button>
      )}
    </div>
  );
}

export function TournamentModal() {
  const { t, language, formatNumber } = useTranslation();
  const tournamentModalOpen = useGameStore((s) => s.tournamentModalOpen);
  const closeTournamentModal = useGameStore((s) => s.closeTournamentModal);
  const tournamentTab = useGameStore((s) => s.tournamentTab);
  const setTournamentTab = useGameStore((s) => s.setTournamentTab);
  const tournamentsList = useGameStore((s) => s.tournamentsList);
  const selectedTournamentId = useGameStore((s) => s.selectedTournamentId);
  const activeTournamentDetail = useGameStore((s) => s.activeTournamentDetail);
  const tournamentLeaderboard = useGameStore((s) => s.tournamentLeaderboard);
  const playerTournamentStats = useGameStore((s) => s.playerTournamentStats);
  const tournamentNotice = useGameStore((s) => s.tournamentNotice);
  const setTournamentNotice = useGameStore((s) => s.setTournamentNotice);
  const ownProfile = useGameStore((s) => s.ownProfile);
  const wallet = useGameStore((s) => s.wallet);
  const openProgressionModal = useGameStore((s) => s.openProgressionModal);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(false);
  const [loadingCareer, setLoadingCareer] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [careerError, setCareerError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [busyMatchId, setBusyMatchId] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Discover filters & join/create private
  const [typeFilter, setTypeFilter] = useState<TournamentType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<TournamentStatus | 'all'>('all');
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [createPrivateOpen, setCreatePrivateOpen] = useState(false);
  const [privTitle, setPrivTitle] = useState('');
  const [privCapacity, setPrivCapacity] = useState<TournamentCapacity>(8);
  const [privRules, setPrivRules] = useState<RuleProfileId>('casual');
  const [privEntryFee, setPrivEntryFee] = useState(0);
  const [privMinPlayers, setPrivMinPlayers] = useState(2);

  // Leaderboard scope
  const [lbSeasonFilter, setLbSeasonFilter] = useState<'ALL' | string>('ALL');
  const currentSeasonKey = useMemo(() => getCurrentSeasonKey(), []);

  // Admin state — NEVER hardcoded or stored in localStorage
  const [adminSecretInput, setAdminSecretInput] = useState('');
  const [adminTitle, setAdminTitle] = useState('');
  const [adminType, setAdminType] = useState<TournamentType>('quick');
  const [adminCapacity, setAdminCapacity] = useState<TournamentCapacity>(8);
  const [adminRules, setAdminRules] = useState<RuleProfileId>('casual');
  const [adminEntryFee, setAdminEntryFee] = useState(50);
  const [adminMinElo, setAdminMinElo] = useState(0);
  const [adminRegMinutes, setAdminRegMinutes] = useState(20);
  const [adminChampCoins, setAdminChampCoins] = useState(800);
  const [adminResolveMatchId, setAdminResolveMatchId] = useState('');
  const [adminResolveWinnerId, setAdminResolveWinnerId] = useState('');
  const [adminResolveType, setAdminResolveType] =
    useState<TournamentMatchResolutionType>('admin_resolved');
  const [adminResolveReason, setAdminResolveReason] = useState('');

  const refreshDiscover = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    const res = await tournamentClient.fetchTournaments({
      type: typeFilter,
      status: statusFilter,
      adminKey: adminSecretInput || undefined,
    });
    setListError(res.error ? localizeServerError(res.error, language) : null);
    setLoadingList(false);
  }, [typeFilter, statusFilter, adminSecretInput, language]);

  const refreshLeaderboard = useCallback(async () => {
    setLoadingLeaderboard(true);
    setLeaderboardError(null);
    const res = await tournamentClient.fetchLeaderboardSafe(lbSeasonFilter);
    if (!res.ok) {
      setLeaderboardError(
        res.error ? localizeServerError(res.error, language) : t('tournaments.noticeLeaderboardFail'),
      );
    }
    setLoadingLeaderboard(false);
  }, [lbSeasonFilter, language, t]);

  const refreshCareer = useCallback(async () => {
    setLoadingCareer(true);
    setCareerError(null);
    const res = await tournamentClient.fetchPlayerStatsSafe();
    if (!res.ok) {
      setCareerError(
        res.error ? localizeServerError(res.error, language) : t('tournaments.noticeCareerFail'),
      );
    }
    setLoadingCareer(false);
  }, [language, t]);

  const refreshSelectedDetail = useCallback(
    async (tournamentId: string) => {
      setLoadingDetail(true);
      setDetailError(null);
      const res = await tournamentClient.fetchTournamentDetail(
        tournamentId,
        adminSecretInput || undefined,
      );
      if (!res.ok) {
        setDetailError(
          res.error ? localizeServerError(res.error, language) : t('tournaments.noticeBracketFail'),
        );
      }
      setLoadingDetail(false);
    },
    [adminSecretInput, language, t],
  );

  useEffect(() => {
    if (!tournamentModalOpen) return;
    if (!ownProfile) {
      void progressionClient.ensurePlayerSession();
    }
    void refreshDiscover();
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [tournamentModalOpen, ownProfile, refreshDiscover]);

  useEffect(() => {
    if (!tournamentModalOpen) return;
    if (tournamentTab === 'leaderboard') {
      void refreshLeaderboard();
    } else if (tournamentTab === 'career') {
      void refreshCareer();
    }
  }, [tournamentModalOpen, tournamentTab, refreshLeaderboard, refreshCareer]);

  useEffect(() => {
    if (!tournamentModalOpen || !selectedTournamentId) return;
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(null);
    void tournamentClient
      .fetchTournamentDetail(selectedTournamentId, adminSecretInput || undefined)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setDetailError(
            res.error
              ? localizeServerError(res.error, language)
              : t('tournaments.noticeBracketFail'),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDetail(false);
        }
      });
    multiplayerManager.subscribeTournamentWs(selectedTournamentId);
    return () => {
      cancelled = true;
      multiplayerManager.unsubscribeTournamentWs(selectedTournamentId);
    };
  }, [tournamentModalOpen, selectedTournamentId, adminSecretInput, language, t]);

  useEffect(() => {
    if (
      tournamentModalOpen &&
      tournamentTab === 'bracket' &&
      !selectedTournamentId &&
      tournamentsList.length > 0
    ) {
      useGameStore.getState().setSelectedTournamentId(tournamentsList[0].tournamentId);
    }
  }, [tournamentModalOpen, tournamentTab, selectedTournamentId, tournamentsList]);

  const detail = activeTournamentDetail;

  // Bracket round grouping (unconditional hook call — must stay before any early return)
  const roundColumns = useMemo(() => {
    const emptyCols: Array<{ roundNumber: number; roundLabel: string; matches: TournamentMatch[] }> =
      [];
    if (!detail || !Array.isArray(detail.matches)) {
      return { cols: emptyCols, thirdPlace: null as TournamentMatch | null };
    }
    const grouped = new Map<number, TournamentMatch[]>();
    let thirdPlace: TournamentMatch | null = null;
    for (const m of detail.matches) {
      if (!m) continue;
      if (m.isThirdPlaceMatch) {
        thirdPlace = m;
        continue;
      }
      const arr = grouped.get(m.roundNumber) ?? [];
      arr.push(m);
      grouped.set(m.roundNumber, arr);
    }
    const cols = [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([roundNumber, matches]) => ({
        roundNumber,
        roundLabel: matches[0]?.roundLabel ?? `Round ${roundNumber}`,
        matches: matches.slice().sort((a, b) => a.slotIndex - b.slotIndex),
      }));
    return { cols, thirdPlace };
  }, [detail]);

  const unresolvedMatches = useMemo(() => {
    if (!detail || !Array.isArray(detail.matches)) return [];
    return detail.matches.filter(
      (m) =>
        Boolean(m) &&
        (m.status === 'ready' || m.status === 'in_progress') &&
        m.player1Id &&
        m.player2Id,
    );
  }, [detail]);

  if (!tournamentModalOpen) return null;

  const selfPlayerId = ownProfile?.playerId ?? null;
  const detailTournament = detail?.tournament ?? null;

  const handleSelectTournament = (tournamentId: string) => {
    soundEngine.playUiClick();
    if (tournamentId === selectedTournamentId) {
      void refreshSelectedDetail(tournamentId);
    } else {
      useGameStore.getState().setSelectedTournamentId(tournamentId);
    }
    setTournamentTab('bracket');
  };

  const handleRegister = async (tr: TournamentRecord) => {
    soundEngine.playUiClick();
    setBusyAction(`reg_${tr.tournamentId}`);
    setTournamentNotice(null);
    const res = await tournamentClient.register(tr.tournamentId);
    setBusyAction(null);
    if (!res.ok) {
      setTournamentNotice({
        type: 'err',
        text: res.error ? localizeServerError(res.error, language) : t('common.actionFailed'),
      });
      return;
    }
    setTournamentNotice({
      type: 'ok',
      text: res.data?.autoStarted
        ? t('tournaments.noticeRegAutoStarted', { title: tr.title })
        : t('tournaments.noticeRegistered', { title: tr.title }),
    });
    useGameStore.getState().setSelectedTournamentId(tr.tournamentId);
  };

  const handleWithdraw = async (tournamentId: string) => {
    soundEngine.playUiClick();
    setBusyAction(`wd_${tournamentId}`);
    setTournamentNotice(null);
    const res = await tournamentClient.withdraw(tournamentId);
    setBusyAction(null);
    if (!res.ok) {
      setTournamentNotice({
        type: 'err',
        text: res.error ? localizeServerError(res.error, language) : t('common.actionFailed'),
      });
      return;
    }
    const refunded = res.data?.refundedCoins ?? 0;
    setTournamentNotice({
      type: 'ok',
      text:
        refunded > 0
          ? t('tournaments.noticeWithdrawnRefunded', { coins: formatNumber(refunded) })
          : t('tournaments.noticeWithdrawn'),
    });
  };

  const handleJoinByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteCodeInput.trim()) return;
    soundEngine.playUiClick();
    setBusyAction('join_code');
    setTournamentNotice(null);
    const res = await tournamentClient.joinByInviteCode(inviteCodeInput);
    setBusyAction(null);
    if (!res.ok || !res.data) {
      setTournamentNotice({
        type: 'err',
        text: res.error ? localizeServerError(res.error, language) : t('common.actionFailed'),
      });
      return;
    }
    setInviteCodeInput('');
    setTournamentNotice({
      type: 'ok',
      text: t('tournaments.noticeJoinedTournament', { title: res.data.tournament.title }),
    });
    useGameStore.getState().setSelectedTournamentId(res.data.tournament.tournamentId);
    setTournamentTab('bracket');
  };

  const handleCreatePrivate = async (e: React.FormEvent) => {
    e.preventDefault();
    soundEngine.playUiClick();
    setBusyAction('create_private');
    setTournamentNotice(null);
    const res = await tournamentClient.createPrivateTournament({
      title: privTitle.trim() || t('tournaments.privateDefaultTitle'),
      maxPlayers: privCapacity,
      minPlayers: Math.max(2, Math.min(privCapacity, privMinPlayers)),
      ruleProfileId: privRules,
      calledShotsEnabled: privRules === 'wpa',
      entryFeeCoins: Math.max(0, privEntryFee),
      isPrivate: true,
      type: 'private',
    });
    setBusyAction(null);
    if (!res.ok || !res.data) {
      setTournamentNotice({
        type: 'err',
        text: res.error ? localizeServerError(res.error, language) : t('common.actionFailed'),
      });
      return;
    }
    setCreatePrivateOpen(false);
    setTournamentNotice({
      type: 'ok',
      text: `${t('tournaments.noticeCreatedPrivate', { title: res.data.tournament.title })} (${res.data.tournament.inviteCode})`,
    });
    useGameStore.getState().setSelectedTournamentId(res.data.tournament.tournamentId);
    setTournamentTab('bracket');
  };

  const handleEnterMatch = async (tournamentId: string, bracketMatchId: string) => {
    soundEngine.playUiClick();
    setBusyMatchId(bracketMatchId);
    setTournamentNotice(null);
    await multiplayerManager.joinTournamentMatch(tournamentId, bracketMatchId);
    setBusyMatchId(null);
  };

  const handleCopyInviteCode = async (code: string) => {
    soundEngine.playUiClick();
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      setCopiedCode(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('tournaments.dialogAria')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4"
    >
      <div className="w-full max-w-5xl max-h-[92dvh] modal-scroll-y rounded-2xl border border-white/15 bg-[#0c1219] p-4 sm:p-6 text-slate-100 shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/10">
              <Crown className="h-4.5 w-4.5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-extrabold tracking-tight text-white">
                {t('tournaments.headerTitle')}
              </h2>
              <p className="text-[11px] text-slate-400">
                {t('tournaments.headerSubtitle')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {wallet && (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-amber-500/10 px-2.5 py-1 font-mono text-xs font-extrabold tabular-nums text-amber-300">
                <Coins className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                <span>{formatNumber(wallet.balance)}</span>
                <span>{t('tournaments.poolCoinsUpper')}</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                if (tournamentTab === 'discover') {
                  void refreshDiscover();
                } else if (tournamentTab === 'leaderboard') {
                  void refreshLeaderboard();
                } else if (tournamentTab === 'career') {
                  void refreshCareer();
                } else {
                  void refreshDiscover();
                  if (selectedTournamentId) {
                    void refreshSelectedDetail(selectedTournamentId);
                  }
                }
              }}
              aria-label={t('tournaments.refreshAria')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingList ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                closeTournamentModal();
              }}
              aria-label={t('tournaments.closeAria')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="mt-3.5 flex flex-wrap gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
          {(
            [
              { id: 'discover', label: t('tournaments.tabDiscover'), icon: Trophy },
              { id: 'bracket', label: t('tournaments.tabBracket'), icon: Swords },
              { id: 'leaderboard', label: t('tournaments.tabLeaderboard'), icon: BarChart3 },
              { id: 'career', label: t('tournaments.tabMyTrophies'), icon: Award },
              { id: 'admin', label: t('tournaments.tabAdmin'), icon: Shield },
            ] as Array<{ id: TournamentTab; label: string; icon: typeof Trophy }>
          ).map((tab) => {
            const Icon = tab.icon;
            const active = tournamentTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  setTournamentTab(tab.id);
                }}
                className={`flex flex-1 min-w-[100px] items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  active ? 'bg-amber-500 text-slate-950' : 'text-slate-300 hover:text-white'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Notice Feedback */}
        {tournamentNotice && (
          <div
            className={`mt-3 flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
              tournamentNotice.type === 'ok'
                ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
            }`}
          >
            <span>{localizeServerError(tournamentNotice.text, language)}</span>
            <button
              type="button"
              onClick={() => setTournamentNotice(null)}
              className="text-slate-300 hover:text-white cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Body */}
        <div className="mt-4">
          {tournamentTab === 'discover' && (
            <div className="space-y-4">
              {/* Join by Code & Create Private Row */}
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2.5 rounded-xl border border-white/10 bg-black/30 p-3">
                <form onSubmit={handleJoinByCode} className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[180px]">
                    <KeyRound className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-amber-400" />
                    <input
                      type="text"
                      maxLength={12}
                      value={inviteCodeInput}
                      onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())}
                      placeholder={t('tournaments.joinByCodePlaceholder')}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] ps-8 pe-3 py-1.5 font-mono text-xs uppercase text-white placeholder:normal-case placeholder:font-sans placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busyAction === 'join_code' || inviteCodeInput.trim().length < 4}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/45 bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {t('tournaments.joinByCodeBtn')}
                  </button>
                </form>

                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    setCreatePrivateOpen((v) => !v);
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <PlusCircle className="h-3.5 w-3.5 shrink-0" />
                  {t('tournaments.createPrivateBtn')}
                </button>
              </div>

              {/* Create Private Tournament Drawer */}
              {createPrivateOpen && (
                <form
                  onSubmit={handleCreatePrivate}
                  className="rounded-xl border border-amber-400/35 bg-[#101924] p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-extrabold uppercase tracking-wider text-amber-300">
                      {t('tournaments.hostPrivateTitle')}
                    </h3>
                    <button
                      type="button"
                      onClick={() => setCreatePrivateOpen(false)}
                      className="text-slate-400 hover:text-white cursor-pointer"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                    <div className="sm:col-span-2">
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        {t('tournaments.tournamentNameLabel')}
                      </label>
                      <input
                        type="text"
                        maxLength={64}
                        value={privTitle}
                        onChange={(e) => setPrivTitle(e.target.value)}
                        placeholder={t('tournaments.privateDefaultTitle')}
                        className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        {t('tournaments.capacityLabel')}
                      </label>
                      <select
                        value={privCapacity}
                        onChange={(e) => setPrivCapacity(Number(e.target.value) as TournamentCapacity)}
                        className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      >
                        <option value={8}>{t('tournaments.playersCountOption', { count: 8 })}</option>
                        <option value={16}>{t('tournaments.playersCountOption', { count: 16 })}</option>
                        <option value={32}>{t('tournaments.playersCountOption', { count: 32 })}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        {t('tournaments.rulesetLabel')}
                      </label>
                      <select
                        value={privRules}
                        onChange={(e) => setPrivRules(e.target.value as RuleProfileId)}
                        className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      >
                        <option value="casual">{t('menu.ruleCasual')}</option>
                        <option value="wpa">{t('menu.ruleWpa')}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        {t('tournaments.entryFeeCoinsLabel')}
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={2000}
                        step={25}
                        value={privEntryFee}
                        onChange={(e) => setPrivEntryFee(Number(e.target.value) || 0)}
                        className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 font-mono text-xs text-white focus:border-amber-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        {t('tournaments.minPlayersLabel')}
                      </label>
                      <input
                        type="number"
                        min={2}
                        max={privCapacity}
                        value={privMinPlayers}
                        onChange={(e) => setPrivMinPlayers(Number(e.target.value) || 2)}
                        className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 font-mono text-xs text-white focus:border-amber-400 focus:outline-none"
                      />
                    </div>
                    <div className="sm:col-span-2 flex items-end justify-end">
                      <button
                        type="submit"
                        disabled={busyAction === 'create_private'}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <PlusCircle className="h-3.5 w-3.5" />
                        {busyAction === 'create_private' ? t('common.creating') : t('tournaments.launchPrivateBtn')}
                      </button>
                    </div>
                  </div>
                </form>
              )}

              {/* Filters */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
                  {(
                    [
                      { id: 'all', label: t('tournaments.allTypesFilter') },
                      { id: 'quick', label: t('tournaments.typeQuick') },
                      { id: 'daily', label: t('tournaments.typeDaily') },
                      { id: 'weekly', label: t('tournaments.typeWeekly') },
                      { id: 'scheduled', label: t('tournaments.typeScheduled') },
                      { id: 'private', label: t('tournaments.typePrivate') },
                    ] as Array<{ id: TournamentType | 'all'; label: string }>
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        setTypeFilter(item.id);
                      }}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-bold cursor-pointer whitespace-nowrap shrink-0 ${
                        typeFilter === item.id
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as TournamentStatus | 'all')}
                  aria-label={t('tournaments.allStatusesFilter')}
                  className="rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs font-semibold text-slate-200 focus:border-amber-400 focus:outline-none"
                >
                  <option value="all">{t('tournaments.allStatusesFilter')}</option>
                  <option value="registration_open">{t('tournaments.statusRegistrationOpen')}</option>
                  <option value="in_progress">{t('tournaments.statusInProgress')}</option>
                  <option value="upcoming">{t('tournaments.statusUpcoming')}</option>
                  <option value="completed">{t('tournaments.statusCompleted')}</option>
                  <option value="cancelled">{t('tournaments.statusCancelled')}</option>
                </select>
              </div>

              {/* Tournament Grid */}
              {listError && (
                <div
                  data-testid="tournament-list-error"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
                >
                  <span>{listError}</span>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.playUiClick();
                      void refreshDiscover();
                    }}
                    className="rounded-lg border border-rose-400/40 bg-rose-500/15 px-2.5 py-1 text-[11px] font-bold text-rose-100 hover:bg-rose-500/25 cursor-pointer"
                  >
                    {t('common.retry')}
                  </button>
                </div>
              )}

              {loadingList && tournamentsList.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  {t('tournaments.loadingTournaments')}
                </div>
              ) : tournamentsList.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-black/25 py-12 text-center text-xs text-slate-400 space-y-2">
                  <div>
                    {listError
                      ? t('tournaments.noticeBracketFail')
                      : t('tournaments.noTournamentsFound')}
                  </div>
                  {listError && (
                    <button
                      type="button"
                      onClick={() => void refreshDiscover()}
                      className="inline-flex items-center rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                    >
                      {t('tournaments.tryAgainBtn')}
                    </button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {tournamentsList.map((tr) => {
                    const isRegOpen =
                      tr.status === 'registration_open' && nowMs <= tr.registrationClosesAtMs;
                    const isFull = tr.participantCount >= tr.maxPlayers;
                    const isBusy = busyAction === `reg_${tr.tournamentId}` || busyAction === `wd_${tr.tournamentId}`;
                    const countdownTarget =
                      tr.status === 'upcoming'
                        ? tr.registrationOpensAtMs
                        : tr.status === 'registration_open'
                          ? tr.registrationClosesAtMs
                          : tr.startsAtMs;

                    return (
                      <div
                        key={tr.tournamentId}
                        className="flex flex-col justify-between rounded-xl border border-white/12 bg-[#101924] p-4 shadow-lg"
                      >
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider">
                                <span className={statusTextClass(tr.status)}>
                                  {localizeTournamentStatus(tr.status, language)}
                                </span>
                                <span className="text-slate-600">·</span>
                                <span className="text-amber-300">{localizeTournamentType(tr.type, language)}</span>
                                <span className="text-slate-600">·</span>
                                <span className="text-slate-400">
                                  {tr.calledShotsEnabled ? t('tournaments.strictWpaBadge') : t('tournaments.casualBadge')}
                                </span>
                              </div>
                              <h3 className="mt-1 truncate text-sm font-extrabold text-white">
                                {tr.title}
                              </h3>
                            </div>
                            <span className="font-mono text-xs font-black tabular-nums text-amber-300 shrink-0">
                              {formatNumber(tr.prizes.championCoins)} {t('tournaments.poolCoinsUpper')}
                            </span>
                          </div>

                          {tr.description && (
                            <p className="mt-1.5 line-clamp-2 text-xs text-slate-400">
                              {tr.description}
                            </p>
                          )}

                          <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] font-mono tabular-nums">
                            <div>
                              <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                                {t('tournaments.playersMetric')}
                              </div>
                              <div dir="ltr" className="font-bold text-white inline-block">
                                {tr.participantCount}/{tr.maxPlayers}
                              </div>
                            </div>
                            <div>
                              <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                                {t('tournaments.entryFeeLabel')}
                              </div>
                              <div className="font-bold text-amber-200">
                                {tr.entryFeeCoins > 0 ? formatNumber(tr.entryFeeCoins) : t('common.free')}
                              </div>
                            </div>
                            <div>
                              <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                                {tr.status === 'in_progress'
                                  ? t('tournaments.roundMetric')
                                  : tr.status === 'completed'
                                    ? t('tournaments.championMetric')
                                    : tr.status === 'upcoming'
                                      ? t('tournaments.opensInMetric')
                                      : t('tournaments.closesInMetric')}
                              </div>
                              <div className="truncate font-bold text-slate-200">
                                {tr.status === 'in_progress'
                                  ? <span dir="ltr">{tr.currentRound}/{tr.totalRounds}</span>
                                  : tr.status === 'completed'
                                    ? tr.championDisplayName ?? t('tournaments.awardedMetric')
                                    : tr.status === 'cancelled'
                                      ? t('tournaments.closedMetric')
                                      : <span dir="ltr">{formatCountdownMs(countdownTarget, nowMs, language)}</span>}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleSelectTournament(tr.tournamentId)}
                            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap shrink-0"
                          >
                            {t('tournaments.viewBracketBtn')}
                          </button>

                          {tr.viewerRegistered ? (
                            isRegOpen ? (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleWithdraw(tr.tournamentId)}
                                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-400/40 bg-rose-500/12 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-500/20 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                {t('tournaments.withdrawBtn')}
                              </button>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300 whitespace-nowrap shrink-0">
                                <UserCheck className="h-3.5 w-3.5" />
                                {t('tournaments.enteredBadge')}
                              </span>
                            )
                          ) : (
                            isRegOpen && (
                              <button
                                type="button"
                                disabled={isBusy || isFull}
                                onClick={() => void handleRegister(tr)}
                                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                {isFull ? t('tournaments.fullBadge') : isBusy ? t('common.joining') : t('tournaments.registerBtn')}
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tournamentTab === 'bracket' && (
            <div className="space-y-4">
              {detailError && (
                <div
                  data-testid="tournament-detail-error"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
                >
                  <span>{detailError}</span>
                  <div className="flex items-center gap-2">
                    {selectedTournamentId && (
                      <button
                        type="button"
                        onClick={() => void refreshSelectedDetail(selectedTournamentId)}
                        className="rounded-lg border border-rose-400/40 bg-rose-500/15 px-2.5 py-1 text-[11px] font-bold text-rose-100 hover:bg-rose-500/25 cursor-pointer"
                      >
                        {t('common.retry')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setTournamentTab('discover')}
                      className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer"
                    >
                      {t('tournaments.tabDiscover')}
                    </button>
                  </div>
                </div>
              )}

              {loadingDetail && !detail ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  {t('tournaments.loadingBracket')}
                </div>
              ) : !detail || !detailTournament ? (
                <div className="rounded-xl border border-white/10 bg-black/25 py-12 text-center text-xs text-slate-400 space-y-3">
                  <div>
                    {detailError
                      ? t('tournaments.noticeBracketFail')
                      : t('tournaments.selectTournamentPrompt')}
                  </div>
                  <button
                    type="button"
                    onClick={() => setTournamentTab('discover')}
                    className="inline-flex items-center rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                  >
                    {t('tournaments.browseTournamentsBtn')}
                  </button>
                </div>
              ) : (
                <>
                  {/* Tournament Header Card */}
                  <div className="rounded-xl border border-amber-400/30 bg-[#101924] p-4 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider">
                          <span className={statusTextClass(detailTournament.status)}>
                            {localizeTournamentStatus(detailTournament.status, language)}
                          </span>
                          <span className="text-slate-600">·</span>
                          <span className="text-amber-300">
                            {localizeTournamentType(detailTournament.type, language)}
                          </span>
                          <span className="text-slate-600">·</span>
                          <span className="text-slate-300">
                            {localizeRuleProfile(detailTournament.calledShotsEnabled ? 'wpa' : 'casual', language)}
                          </span>
                          <span className="text-slate-600">·</span>
                          <span dir="ltr" className="font-mono text-slate-400">{detailTournament.seasonKey}</span>
                        </div>
                        <h3 className="mt-1 text-lg font-extrabold text-white">
                          {detailTournament.title}
                        </h3>
                        {detailTournament.description && (
                          <p className="mt-0.5 text-xs text-slate-300">
                            {detailTournament.description}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {detailTournament.inviteCode && (
                          <button
                            type="button"
                            onClick={() => void handleCopyInviteCode(detailTournament.inviteCode!)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/35 px-3 py-1.5 font-mono text-xs font-bold text-amber-200 hover:bg-black/55 cursor-pointer whitespace-nowrap shrink-0"
                          >
                            {copiedCode ? (
                              <>
                                <Check className="h-3.5 w-3.5 text-emerald-400" />
                                <span>{t('common.copied')}</span>
                                <span dir="ltr">{detailTournament.inviteCode}</span>
                              </>
                            ) : (
                              <>
                                <Copy className="h-3.5 w-3.5 text-amber-400" />
                                <span>{t('tournaments.inviteCodePrefix')}</span>
                                <span dir="ltr">{detailTournament.inviteCode}</span>
                              </>
                            )}
                          </button>
                        )}

                        {detail.viewerStatus.activeMatch && (
                          <button
                            type="button"
                            disabled={busyMatchId === detail.viewerStatus.activeMatch.bracketMatchId}
                            onClick={() =>
                              void handleEnterMatch(
                                detailTournament.tournamentId,
                                detail.viewerStatus.activeMatch!.bracketMatchId,
                              )
                            }
                            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap shrink-0"
                          >
                            <Swords className="h-3.5 w-3.5" />
                            {t('tournaments.enterActiveMatchBtn')}
                          </button>
                        )}

                        {!detail.viewerStatus.isRegistered &&
                          detailTournament.status === 'registration_open' &&
                          detailTournament.participantCount < detailTournament.maxPlayers && (
                            <button
                              type="button"
                              disabled={busyAction === `reg_${detailTournament.tournamentId}`}
                              onClick={() => void handleRegister(detailTournament)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap shrink-0"
                            >
                              {t('tournaments.registerNowBtn')}
                            </button>
                          )}

                        {detail.viewerStatus.isRegistered &&
                          (detailTournament.status === 'registration_open' ||
                            detailTournament.status === 'in_progress') &&
                          detail.viewerStatus.participant?.status !== 'eliminated' &&
                          detail.viewerStatus.participant?.status !== 'withdrawn' && (
                            <button
                              type="button"
                              disabled={busyAction === `wd_${detailTournament.tournamentId}`}
                              onClick={() => void handleWithdraw(detailTournament.tournamentId)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/40 bg-rose-500/12 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap shrink-0"
                            >
                              {t('tournaments.withdrawBtn')}
                            </button>
                          )}

                        {selfPlayerId &&
                          detailTournament.createdByPlayerId === selfPlayerId &&
                          (detailTournament.status === 'registration_open' ||
                            detailTournament.status === 'upcoming') && (
                            <>
                              <button
                                type="button"
                                disabled={
                                  busyAction === 'host_start' ||
                                  detailTournament.participantCount < detailTournament.minPlayers
                                }
                                onClick={async () => {
                                  soundEngine.playUiClick();
                                  setBusyAction('host_start');
                                  const res = await tournamentClient.startTournament(
                                    detailTournament.tournamentId,
                                  );
                                  setBusyAction(null);
                                  if (!res.ok) {
                                    setTournamentNotice({
                                      type: 'err',
                                      text: localizeServerError(res.error, language),
                                    });
                                  }
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/45 bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                <Play className="h-3.5 w-3.5" />
                                {t('tournaments.startBracketBtn')}
                              </button>
                              <button
                                type="button"
                                disabled={busyAction === 'host_cancel'}
                                onClick={async () => {
                                  soundEngine.playUiClick();
                                  setBusyAction('host_cancel');
                                  await tournamentClient.cancelTournament(
                                    detailTournament.tournamentId,
                                    t('tournaments.cancelEventBtn'),
                                  );
                                  setBusyAction(null);
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/12 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                {t('tournaments.cancelEventBtn')}
                              </button>
                            </>
                          )}
                      </div>
                    </div>

                    {/* Key Metrics Strip */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-white/10 font-mono tabular-nums text-xs">
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                          {t('tournaments.metricCapacity')}
                        </div>
                        <div className="font-bold text-white" dir="ltr">
                          {detailTournament.participantCount}/{detailTournament.maxPlayers}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                          {t('tournaments.metricEntryMinElo')}
                        </div>
                        <div className="font-bold text-slate-200">
                          {detailTournament.entryFeeCoins > 0
                            ? `${formatNumber(detailTournament.entryFeeCoins)} ${t('tournaments.poolCoinsUpper')}`
                            : t('common.free')}
                          {detailTournament.minElo > 0 ? ` · ${detailTournament.minElo}+` : ''}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                          {t('tournaments.metricPodiumPrizes')}
                        </div>
                        <div className="font-bold text-amber-300" dir="ltr">
                          {detailTournament.prizes.championCoins} / {detailTournament.prizes.runnerUpCoins} /{' '}
                          {detailTournament.prizes.thirdPlaceCoins}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                          {t('tournaments.metricRegCloses')}
                        </div>
                        <div className="font-bold text-slate-200">
                          {detailTournament.status === 'registration_open'
                            ? formatCountdownMs(detailTournament.registrationClosesAtMs, nowMs, language)
                            : formatDateTime(detailTournament.registrationClosesAtMs, language)}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                          {t('tournaments.metricChampion')}
                        </div>
                        <div className="truncate font-sans font-bold text-amber-300">
                          {detailTournament.championDisplayName ?? t('common.pending')}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Champion Podium Banner */}
                  {detailTournament.status === 'completed' &&
                    detailTournament.championDisplayName && (
                      <div className="rounded-xl border border-amber-400/50 bg-amber-500/10 p-3.5 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <Trophy className="h-6 w-6 text-amber-400 shrink-0" />
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                              {t('tournaments.podiumTitle')}
                            </div>
                            <div className="text-sm font-extrabold text-white">
                              {t('tournaments.podiumFirst')} {detailTournament.championDisplayName}
                              {detailTournament.runnerUpDisplayName
                                ? ` · ${t('tournaments.podiumSecond')} ${detailTournament.runnerUpDisplayName}`
                                : ''}
                              {detailTournament.thirdPlaceDisplayName
                                ? ` · ${t('tournaments.podiumThird')} ${detailTournament.thirdPlaceDisplayName}`
                                : ''}
                            </div>
                          </div>
                        </div>
                        <span className="font-mono text-xs font-extrabold tabular-nums text-amber-300">
                          +{formatNumber(detailTournament.prizes.championCoins)} {t('tournaments.poolCoinsUpper')}
                        </span>
                      </div>
                    )}

                  {/* Ongoing Live Matches Broadcast Strip */}
                  {!detailTournament.isPrivate && (() => {
                    const liveMatches = detail.matches.filter(
                      (m) =>
                        m.status === 'in_progress' &&
                        m.roomId &&
                        (!selfPlayerId ||
                          (m.player1Id !== selfPlayerId && m.player2Id !== selfPlayerId)),
                    );
                    if (liveMatches.length === 0) return null;
                    return (
                      <div className="rounded-xl border border-emerald-400/35 bg-emerald-500/8 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-300">
                            <Eye className="h-3.5 w-3.5" />
                            {t('tournaments.ongoingLiveMatches', { count: liveMatches.length })}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {liveMatches.map((m) => (
                            <div
                              key={m.bracketMatchId}
                              className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-[#101924] px-3 py-1.5 text-xs"
                            >
                              <div className="min-w-0">
                                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                                  {localizeTournamentRoundLabel(m.roundLabel, language)}
                                </div>
                                <div className="font-bold text-white truncate max-w-[200px]">
                                  {m.player1Name ?? t('tournaments.tbdSlot')} {t('common.vs')}{' '}
                                  {m.player2Name ?? t('tournaments.tbdSlot')}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  soundEngine.playUiClick();
                                  void multiplayerManager.joinSpectate({
                                    roomId: m.roomId!,
                                    returnTarget: 'tournament',
                                    tournamentId: detailTournament.tournamentId,
                                  });
                                }}
                                className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                <Eye className="h-3 w-3" />
                                {t('tournaments.watchLiveBtn')}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Single-Elimination Bracket Tree */}
                  {detail.matches.length === 0 ? (
                    <div className="rounded-xl border border-white/10 bg-black/25 py-8 px-4 text-center text-xs text-slate-400">
                      {t('tournaments.bracketPendingNotice')}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
                          {t('tournaments.singleElimTreeTitle', { size: detailTournament.bracketSize })}
                        </span>
                        <span className="text-[11px] font-mono tabular-nums text-slate-400">
                          {t('tournaments.roundRatio', {
                            cur: detailTournament.currentRound,
                            total: detailTournament.totalRounds,
                          })}
                        </span>
                      </div>

                      <div className="flex gap-3 overflow-x-auto pb-2">
                        {roundColumns.cols.map((col) => (
                          <div
                            key={col.roundNumber}
                            className="min-w-[235px] flex-1 space-y-2.5"
                          >
                            <div className="rounded-lg border border-white/10 bg-[#0b1017] px-2.5 py-1.5 text-center text-[11px] font-extrabold uppercase tracking-wider text-amber-300">
                              {localizeTournamentRoundLabel(col.roundLabel, language)}
                            </div>
                            <div className="space-y-2.5">
                              {col.matches.map((m) => (
                                <BracketMatchCard
                                  key={m.bracketMatchId}
                                  match={m}
                                  viewerPlayerId={selfPlayerId}
                                  nowMs={nowMs}
                                  busyMatchId={busyMatchId}
                                  isPrivateTournament={detailTournament.isPrivate}
                                  onEnterMatch={(mid) =>
                                    void handleEnterMatch(detailTournament.tournamentId, mid)
                                  }
                                  onSpectateMatch={(rid) =>
                                    void multiplayerManager.joinSpectate({
                                      roomId: rid,
                                      returnTarget: 'tournament',
                                      tournamentId: detailTournament.tournamentId,
                                    })
                                  }
                                />
                              ))}
                            </div>
                          </div>
                        ))}

                        {roundColumns.thirdPlace && (
                          <div className="min-w-[235px] flex-1 space-y-2.5">
                            <div className="rounded-lg border border-white/10 bg-[#0b1017] px-2.5 py-1.5 text-center text-[11px] font-extrabold uppercase tracking-wider text-slate-300">
                              {t('tournaments.thirdPlace')}
                            </div>
                            <BracketMatchCard
                              match={roundColumns.thirdPlace}
                              viewerPlayerId={selfPlayerId}
                              nowMs={nowMs}
                              busyMatchId={busyMatchId}
                              isPrivateTournament={detailTournament.isPrivate}
                              onEnterMatch={(mid) =>
                                void handleEnterMatch(detailTournament.tournamentId, mid)
                              }
                              onSpectateMatch={(rid) =>
                                void multiplayerManager.joinSpectate({
                                  roomId: rid,
                                  returnTarget: 'tournament',
                                  tournamentId: detailTournament.tournamentId,
                                })
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Participants & Recent Events */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-400">
                          <Users className="h-3.5 w-3.5" />
                          {t('tournaments.participantsRatio', {
                            cur: detail.participants.length,
                            max: detailTournament.maxPlayers,
                          })}
                        </span>
                      </div>
                      <div className="max-h-56 overflow-y-auto space-y-1.5">
                        {detail.participants.length === 0 ? (
                          <div className="py-4 text-center text-xs text-slate-400">
                            {t('tournaments.noParticipantsYet')}
                          </div>
                        ) : (
                          detail.participants.map((p) => {
                            const av = getAvatarVisualMeta(p.avatarId);
                            return (
                              <div
                                key={p.playerId}
                                className="flex items-center justify-between gap-2 rounded-lg border border-white/8 bg-[#101924] px-2.5 py-1.5 text-xs"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="w-6 font-mono text-[10px] tabular-nums text-slate-400 shrink-0" dir="ltr">
                                    {p.seed ? `#${p.seed}` : '—'}
                                  </span>
                                  <span
                                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold"
                                    style={{ backgroundColor: `${av.accent}22`, color: av.accent }}
                                  >
                                    {av.glyph}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      soundEngine.playUiClick();
                                      openProgressionModal('profile', p.playerId);
                                    }}
                                    className="truncate font-bold text-white hover:underline cursor-pointer"
                                  >
                                    {p.displayName}
                                  </button>
                                </div>
                                <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums shrink-0">
                                  <span className="text-slate-400">
                                    {formatNumber(p.elo)} {t('common.elo')}
                                  </span>
                                  <span
                                    className={`uppercase font-bold ${
                                      p.status === 'champion'
                                        ? 'text-amber-300'
                                        : p.status === 'withdrawn' || p.status === 'eliminated'
                                          ? 'text-slate-500'
                                          : 'text-emerald-300'
                                    }`}
                                  >
                                    {p.placement
                                      ? placementLabel(p.placement, language)
                                      : localizeParticipantStatus(p.status, language)}
                                  </span>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-400">
                          <Timer className="h-3.5 w-3.5" />
                          {t('tournaments.payoutsLogTitle')}
                        </span>
                      </div>
                      <div className="max-h-56 overflow-y-auto space-y-1.5 text-xs">
                        {detail.payouts.map((pay) => (
                          <div
                            key={pay.payoutId}
                            className="flex items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-500/8 px-2.5 py-1.5"
                          >
                            <span className="truncate font-semibold text-amber-200">
                              {pay.displayName} · {localizePayoutPlacement(pay.placement, language)}
                            </span>
                            <span className="font-mono font-bold tabular-nums text-amber-300 shrink-0">
                              +{formatNumber(pay.coinsAwarded)} {t('tournaments.poolCoinsUpper')}
                            </span>
                          </div>
                        ))}
                        {detail.events.slice(0, 14).map((ev) => (
                          <div
                            key={ev.eventId}
                            className="flex items-center justify-between gap-2 rounded-lg border border-white/8 bg-[#101924] px-2.5 py-1.5 text-[11px]"
                          >
                            <span className="text-slate-300 truncate">{ev.summary}</span>
                            <span className="font-mono text-[10px] text-slate-500 shrink-0">
                              {formatDateTime(ev.createdAtMs, language)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {tournamentTab === 'leaderboard' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.playUiClick();
                      setLbSeasonFilter('ALL');
                    }}
                    className={`rounded-lg px-3 py-1 text-xs font-bold cursor-pointer whitespace-nowrap ${
                      lbSeasonFilter === 'ALL'
                        ? 'bg-amber-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    {t('tournaments.globalAllTimeOption')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.playUiClick();
                      setLbSeasonFilter(currentSeasonKey);
                    }}
                    className={`rounded-lg px-3 py-1 text-xs font-bold cursor-pointer whitespace-nowrap ${
                      lbSeasonFilter === currentSeasonKey
                        ? 'bg-amber-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    {t('tournaments.seasonOption', { season: currentSeasonKey })}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    void refreshLeaderboard();
                  }}
                  className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                >
                  {t('common.refresh')}
                </button>
              </div>

              {leaderboardError && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                  <span>{leaderboardError}</span>
                  <button
                    type="button"
                    onClick={() => void refreshLeaderboard()}
                    className="rounded-lg border border-rose-400/40 bg-rose-500/15 px-2.5 py-1 text-[11px] font-bold text-rose-100 hover:bg-rose-500/25 cursor-pointer"
                  >
                    {t('common.retry')}
                  </button>
                </div>
              )}

              <div className="overflow-x-auto rounded-xl border border-white/10 bg-black/25">
                <table className="w-full text-start text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <th className="px-3 py-2">{t('tournaments.colRank')}</th>
                      <th className="px-3 py-2">{t('tournaments.colCompetitor')}</th>
                      <th className="px-3 py-2 text-end">{t('tournaments.colTitles')}</th>
                      <th className="px-3 py-2 text-end">{t('tournaments.colFinals')}</th>
                      <th className="px-3 py-2 text-end">{t('tournaments.colMatchWl')}</th>
                      <th className="px-3 py-2 text-end">{t('tournaments.colWinPct')}</th>
                      <th className="px-3 py-2 text-end">{t('tournaments.colPrizeCoins')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {loadingLeaderboard && tournamentLeaderboard.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          {t('tournaments.loadingLeaderboard')}
                        </td>
                      </tr>
                    ) : tournamentLeaderboard.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          {leaderboardError ?? t('tournaments.noLeaderboardData')}
                        </td>
                      </tr>
                    ) : (
                      tournamentLeaderboard.map((row) => {
                        const av = getAvatarVisualMeta(row.avatarId);
                        const isSelf = row.playerId === selfPlayerId;
                        return (
                          <tr
                            key={row.playerId}
                            className={isSelf ? 'bg-amber-500/10' : 'hover:bg-white/[0.03]'}
                          >
                            <td className="px-3 py-2 font-mono font-bold tabular-nums text-amber-300" dir="ltr">
                              #{row.rank}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => {
                                  soundEngine.playUiClick();
                                  openProgressionModal('profile', row.playerId);
                                }}
                                className="flex items-center gap-2 text-start hover:underline cursor-pointer"
                              >
                                <span
                                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-bold"
                                  style={{ backgroundColor: `${av.accent}22`, color: av.accent }}
                                >
                                  {av.glyph}
                                </span>
                                <span className="font-bold text-white">{row.displayName}</span>
                                <span className="font-mono text-[10px] text-slate-400" dir="ltr">
                                  {row.elo}
                                </span>
                              </button>
                            </td>
                            <td className="px-3 py-2 text-end font-mono font-extrabold tabular-nums text-amber-300">
                              {formatNumber(row.championships)}
                            </td>
                            <td className="px-3 py-2 text-end font-mono tabular-nums text-slate-200">
                              {formatNumber(row.finalsAppearances)}
                            </td>
                            <td className="px-3 py-2 text-end font-mono tabular-nums text-slate-200" dir="ltr">
                              {row.matchesWon}–{row.matchesLost}
                            </td>
                            <td className="px-3 py-2 text-end font-mono tabular-nums text-slate-200" dir="ltr">
                              {row.winRate.toFixed(1)}%
                            </td>
                            <td className="px-3 py-2 text-end font-mono font-bold tabular-nums text-amber-200">
                              {formatNumber(row.totalCoinsWon)}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tournamentTab === 'career' && (
            <div className="space-y-4">
              {loadingCareer && !playerTournamentStats ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  {t('tournaments.loadingCareer')}
                </div>
              ) : !playerTournamentStats ? (
                <div className="rounded-xl border border-white/10 bg-black/25 py-10 text-center text-xs text-slate-400 space-y-3">
                  <div>{careerError ?? t('tournaments.noticeCareerFail')}</div>
                  <button
                    type="button"
                    onClick={() => void refreshCareer()}
                    className="inline-flex items-center rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                  >
                    {t('common.retry')}
                  </button>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      {
                        label: t('tournaments.statChampionships'),
                        value: formatNumber(playerTournamentStats.championships),
                      },
                      {
                        label: t('tournaments.statFinalsReached'),
                        value: formatNumber(playerTournamentStats.finalsAppearances),
                      },
                      {
                        label: t('tournaments.statBracketRecord'),
                        value: `${playerTournamentStats.matchesWon}–${playerTournamentStats.matchesLost}`,
                        ltr: true,
                      },
                      {
                        label: t('tournaments.statMatchWinRate'),
                        value: `${playerTournamentStats.winRate.toFixed(1)}%`,
                        ltr: true,
                      },
                      {
                        label: t('tournaments.statEventsEntered'),
                        value: formatNumber(playerTournamentStats.tournamentsEntered),
                      },
                      {
                        label: t('tournaments.statThirdPlace'),
                        value: formatNumber(playerTournamentStats.thirdPlaceFinishes),
                      },
                      {
                        label: t('tournaments.statPrizeCoinsWon'),
                        value: formatNumber(playerTournamentStats.totalCoinsWon),
                      },
                      {
                        label: t('tournaments.statTrophiesEarned'),
                        value: `${playerTournamentStats.trophies.length}/${TOURNAMENT_TROPHY_CATALOG.length}`,
                        ltr: true,
                      },
                    ].map((stat) => (
                      <div
                        key={stat.label}
                        className="rounded-xl border border-white/10 bg-[#101924] px-3 py-2.5"
                      >
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          {stat.label}
                        </div>
                        <div
                          className="mt-0.5 font-mono text-sm font-extrabold tabular-nums text-white"
                          dir={stat.ltr ? 'ltr' : undefined}
                        >
                          {stat.value}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Trophy Cabinet */}
                  <div className="rounded-xl border border-white/10 bg-black/25 p-3.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-2.5">
                      {t('tournaments.trophyCaseTitle')}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {TOURNAMENT_TROPHY_CATALOG.map((def) => {
                        const unlocked = playerTournamentStats.trophies.find(
                          (tr) => tr.id === def.id,
                        );
                        const trophyMeta = localizeTournamentTrophy(
                          def.id,
                          def.name,
                          def.description,
                          language,
                        );
                        return (
                          <div
                            key={def.id}
                            className={`rounded-xl border p-3 ${
                              unlocked
                                ? 'border-amber-400/45 bg-amber-500/10'
                                : 'border-white/10 bg-[#101924] opacity-70'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-lg">{def.glyph}</span>
                              <span
                                className={`text-[10px] font-bold uppercase tracking-wider ${
                                  unlocked ? 'text-emerald-300' : 'text-slate-500'
                                }`}
                              >
                                {unlocked ? t('tournaments.awardedBadge') : t('common.locked')}
                              </span>
                            </div>
                            <div className="mt-1 text-xs font-extrabold text-white">
                              {trophyMeta.name}
                            </div>
                            <p className="mt-0.5 text-[11px] text-slate-400">
                              {trophyMeta.description}
                            </p>
                            {unlocked && (
                              <div className="mt-1.5 text-[10px] text-amber-300 truncate">
                                {unlocked.tournamentTitle} · {formatDateTime(unlocked.unlockedAtMs, language)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Recent Tournament History */}
                  <div className="rounded-xl border border-white/10 bg-black/25 p-3.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-2">
                      {t('tournaments.recentTournamentsTitle')}
                    </div>
                    {playerTournamentStats.recentTournaments.length === 0 ? (
                      <div className="py-4 text-xs text-slate-400">
                        {t('tournaments.noTrophiesYet')}
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {playerTournamentStats.recentTournaments.map((item) => (
                          <div
                            key={item.tournamentId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/8 bg-[#101924] px-3 py-2 text-xs"
                          >
                            <button
                              type="button"
                              onClick={() => handleSelectTournament(item.tournamentId)}
                              className="font-bold text-white hover:underline cursor-pointer text-start"
                            >
                              {item.title}
                            </button>
                            <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums">
                              <span className="text-slate-300">
                                {item.placement
                                  ? placementLabel(item.placement, language)
                                  : localizeParticipantStatus(item.participantStatus, language)}
                              </span>
                              {item.coinsWon > 0 && (
                                <span className="font-bold text-amber-300">
                                  +{formatNumber(item.coinsWon)} {t('tournaments.poolCoinsUpper')}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {tournamentTab === 'admin' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-white/12 bg-black/30 p-3.5 space-y-2">
                <label className="block text-[10px] font-bold uppercase tracking-wider text-amber-300">
                  {t('tournaments.adminSecretLabel')}
                </label>
                <input
                  type="password"
                  value={adminSecretInput}
                  onChange={(e) => setAdminSecretInput(e.target.value)}
                  placeholder={t('tournaments.adminKeyPlaceholder')}
                  className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-3 py-2 font-mono text-xs text-white focus:border-amber-400 focus:outline-none"
                />
              </div>

              {/* Create Global Tournament */}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  soundEngine.playUiClick();
                  setBusyAction('admin_create');
                  const regMs = Math.max(1, adminRegMinutes) * 60_000;
                  const res = await tournamentClient.adminCreateTournament(adminSecretInput, {
                    title: adminTitle.trim() || t('tournaments.typeWeekly'),
                    type: adminType,
                    maxPlayers: adminCapacity,
                    ruleProfileId: adminRules,
                    calledShotsEnabled: adminRules === 'wpa',
                    entryFeeCoins: Math.max(0, adminEntryFee),
                    minElo: Math.max(0, adminMinElo),
                    registrationClosesAtMs: Date.now() + regMs,
                    startsAtMs: Date.now() + regMs,
                    prizes: {
                      championCoins: Math.max(0, adminChampCoins),
                    },
                  });
                  setBusyAction(null);
                  if (!res.ok || !res.data) {
                    setTournamentNotice({
                      type: 'err',
                      text: localizeServerError(res.error, language),
                    });
                    return;
                  }
                  setTournamentNotice({
                    type: 'ok',
                    text: t('tournaments.adminSuccessCreated', {
                      title: res.data.tournament.title,
                    }),
                  });
                  useGameStore.getState().setSelectedTournamentId(res.data.tournament.tournamentId);
                }}
                className="rounded-xl border border-white/12 bg-[#101924] p-4 space-y-3"
              >
                <div className="text-xs font-extrabold uppercase tracking-wider text-amber-300">
                  {t('tournaments.adminCreateGlobalTitle')}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                  <div className="sm:col-span-2">
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      {t('tournaments.adminTitleLabel')}
                    </label>
                    <input
                      type="text"
                      required
                      value={adminTitle}
                      placeholder={t('tournaments.tournamentTitlePlaceholder')}
                      onChange={(e) => setAdminTitle(e.target.value)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      {t('tournaments.adminTypeLabel')}
                    </label>
                    <select
                      value={adminType}
                      onChange={(e) => setAdminType(e.target.value as TournamentType)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="quick">{t('tournaments.typeQuick')}</option>
                      <option value="daily">{t('tournaments.typeDaily')}</option>
                      <option value="weekly">{t('tournaments.typeWeekly')}</option>
                      <option value="scheduled">{t('tournaments.typeScheduled')}</option>
                      <option value="private">{t('tournaments.typePrivate')}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      {t('tournaments.adminMaxPlayersLabel')}
                    </label>
                    <select
                      value={adminCapacity}
                      onChange={(e) =>
                        setAdminCapacity(Number(e.target.value) as TournamentCapacity)
                      }
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value={8}>{t('tournaments.playersCountOption', { count: 8 })}</option>
                      <option value={16}>{t('tournaments.playersCountOption', { count: 16 })}</option>
                      <option value={32}>{t('tournaments.playersCountOption', { count: 32 })}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      {t('tournaments.adminRulesetLabel')}
                    </label>
                    <select
                      value={adminRules}
                      onChange={(e) => setAdminRules(e.target.value as RuleProfileId)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="casual">{t('menu.ruleCasual')}</option>
                      <option value="wpa">{t('menu.ruleWpa')}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      {t('tournaments.adminEntryFeeLabel')}
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={adminEntryFee}
                      onChange={(e) => setAdminEntryFee(Number(e.target.value) || 0)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 font-mono text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      {t('tournaments.adminMinEloLabel')}
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={adminMinElo}
                      onChange={(e) => setAdminMinElo(Number(e.target.value) || 0)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 font-mono text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      {t('tournaments.adminRegWindowLabel')}
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={adminRegMinutes}
                      onChange={(e) => setAdminRegMinutes(Number(e.target.value) || 10)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 font-mono text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      {t('tournaments.adminFirstPrizeLabel')}
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={adminChampCoins}
                      onChange={(e) => setAdminChampCoins(Number(e.target.value) || 0)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 font-mono text-xs text-white"
                    />
                  </div>
                  <div className="sm:col-span-3 flex items-end justify-end">
                    <button
                      type="submit"
                      disabled={!adminSecretInput.trim() || busyAction === 'admin_create'}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                    >
                      <PlusCircle className="h-3.5 w-3.5" />
                      {t('tournaments.adminPublishBtn')}
                    </button>
                  </div>
                </div>
              </form>

              {/* Selected Tournament Controls & Dispute Resolution */}
              {detailTournament && (
                <div className="rounded-xl border border-white/12 bg-[#101924] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        {t('tournaments.adminManagingSelected', { title: '' })}
                      </div>
                      <div className="text-sm font-extrabold text-white">
                        {detailTournament.title} ({localizeTournamentStatus(detailTournament.status, language)})
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={!adminSecretInput.trim() || busyAction === 'admin_start'}
                        onClick={async () => {
                          setBusyAction('admin_start');
                          const res = await tournamentClient.adminStartTournament(
                            adminSecretInput,
                            detailTournament.tournamentId,
                          );
                          setBusyAction(null);
                          setTournamentNotice(
                            res.ok
                              ? { type: 'ok', text: t('tournaments.adminSuccessStarted') }
                              : { type: 'err', text: localizeServerError(res.error, language) },
                          );
                        }}
                        className="rounded-lg border border-emerald-400/45 bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                      >
                        {t('tournaments.adminForceStartBtn')}
                      </button>
                      <button
                        type="button"
                        disabled={!adminSecretInput.trim() || busyAction === 'admin_timers'}
                        onClick={async () => {
                          setBusyAction('admin_timers');
                          const res = await tournamentClient.adminProcessTimers(
                            adminSecretInput,
                            detailTournament.tournamentId,
                          );
                          setBusyAction(null);
                          setTournamentNotice(
                            res.ok
                              ? {
                                  type: 'ok',
                                  text: t('tournaments.adminSuccessTimers', {
                                    forfeits: (res.data as { forfeits?: number } | undefined)?.forfeits ?? 0,
                                  }),
                                }
                              : { type: 'err', text: localizeServerError(res.error, language) },
                          );
                        }}
                        className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                      >
                        {t('tournaments.adminProcessTimersShort')}
                      </button>
                      <button
                        type="button"
                        disabled={!adminSecretInput.trim() || busyAction === 'admin_cancel'}
                        onClick={async () => {
                          setBusyAction('admin_cancel');
                          const res = await tournamentClient.adminCancelTournament(
                            adminSecretInput,
                            detailTournament.tournamentId,
                            t('tournaments.cancelTournamentBtn'),
                          );
                          setBusyAction(null);
                          setTournamentNotice(
                            res.ok
                              ? { type: 'ok', text: t('tournaments.adminSuccessCancelled') }
                              : { type: 'err', text: localizeServerError(res.error, language) },
                          );
                        }}
                        className="rounded-lg border border-rose-400/45 bg-rose-500/15 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                      >
                        {t('tournaments.adminCancelRefundBtn')}
                      </button>
                    </div>
                  </div>

                  {unresolvedMatches.length > 0 && (
                    <div className="pt-3 border-t border-white/10 space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
                        {t('tournaments.adminResolveActiveTitle')}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                        <select
                          value={adminResolveMatchId}
                          onChange={(e) => {
                            const mid = e.target.value;
                            setAdminResolveMatchId(mid);
                            const m = unresolvedMatches.find((x) => x.bracketMatchId === mid);
                            if (m?.player1Id) setAdminResolveWinnerId(m.player1Id);
                          }}
                          className="rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                        >
                          <option value="">{t('tournaments.adminSelectMatchPlaceholder')}</option>
                          {unresolvedMatches.map((m) => (
                            <option key={m.bracketMatchId} value={m.bracketMatchId}>
                              {localizeTournamentRoundLabel(m.roundLabel, language)}: {m.player1Name} {t('common.vs')} {m.player2Name}
                            </option>
                          ))}
                        </select>

                        <select
                          value={adminResolveWinnerId}
                          onChange={(e) => setAdminResolveWinnerId(e.target.value)}
                          className="rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                        >
                          <option value="">{t('tournaments.adminSelectWinnerPlaceholder')}</option>
                          {(() => {
                            const m = unresolvedMatches.find(
                              (x) => x.bracketMatchId === adminResolveMatchId,
                            );
                            if (!m) return null;
                            return (
                              <>
                                {m.player1Id && <option value={m.player1Id}>{m.player1Name}</option>}
                                {m.player2Id && <option value={m.player2Id}>{m.player2Name}</option>}
                              </>
                            );
                          })()}
                        </select>

                        <select
                          value={adminResolveType}
                          onChange={(e) =>
                            setAdminResolveType(e.target.value as TournamentMatchResolutionType)
                          }
                          className="rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                        >
                          <option value="admin_resolved">{t('tournaments.adminOverrideOption')}</option>
                          <option value="forfeit">{t('tournaments.adminForfeitOption')}</option>
                          <option value="no_show">{t('tournaments.adminNoShowOption')}</option>
                        </select>

                        <button
                          type="button"
                          disabled={
                            !adminSecretInput.trim() ||
                            !adminResolveMatchId ||
                            !adminResolveWinnerId ||
                            busyAction === 'admin_resolve'
                          }
                          onClick={async () => {
                            setBusyAction('admin_resolve');
                            const res = await tournamentClient.adminResolveMatch(
                              adminSecretInput,
                              detailTournament.tournamentId,
                              adminResolveMatchId,
                              {
                                winnerId: adminResolveWinnerId,
                                resolutionType: adminResolveType,
                                reason: adminResolveReason.trim() || t('tournaments.adminOverrideOption'),
                              },
                            );
                            setBusyAction(null);
                            if (!res.ok) {
                              setTournamentNotice({
                                type: 'err',
                                text: localizeServerError(res.error, language),
                              });
                            } else {
                              setAdminResolveMatchId('');
                              setAdminResolveWinnerId('');
                              setTournamentNotice({
                                type: 'ok',
                                text: t('tournaments.adminSuccessResolved'),
                              });
                            }
                          }}
                          className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                        >
                          {t('tournaments.adminConfirmWinnerBtn')}
                        </button>
                      </div>
                      <input
                        type="text"
                        value={adminResolveReason}
                        onChange={(e) => setAdminResolveReason(e.target.value)}
                        placeholder={t('tournaments.adminAuditNotePlaceholder')}
                        className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-slate-200"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
