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
import { type TournamentTab, useGameStore } from '../store/useGameStore';

function formatCountdownMs(targetMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const d = Math.floor(diffSec / 86400);
  const h = Math.floor((diffSec % 86400) / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDateTime(ms: number | null): string {
  if (!ms) return '—';
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

function formatTournamentType(type: TournamentType): string {
  switch (type) {
    case 'quick':
      return 'Quick';
    case 'daily':
      return 'Daily';
    case 'weekly':
      return 'Weekly Championship';
    case 'private':
      return 'Private';
    case 'scheduled':
      return 'Scheduled Global';
  }
}

function formatTournamentStatus(status: TournamentStatus): string {
  switch (status) {
    case 'upcoming':
      return 'Upcoming';
    case 'registration_open':
      return 'Registration Open';
    case 'in_progress':
      return 'In Progress';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
  }
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

function placementLabel(placement: number | null): string {
  if (!placement) return '—';
  if (placement === 1) return '1st · Champion';
  if (placement === 2) return '2nd · Finalist';
  if (placement === 3) return '3rd · Podium';
  return `${placement}th Place`;
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
          {match.isThirdPlaceMatch ? 'Third Place' : `${match.roundLabel} #${match.slotIndex + 1}`}
        </span>
        <span
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
          {match.status === 'ready' && match.readyDeadlineMs
            ? `Ready · ${formatCountdownMs(match.readyDeadlineMs, nowMs)}`
            : match.status.replace('_', ' ')}
        </span>
      </div>

      {/* Player 1 */}
      <div
        className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1 ${
          p1Won ? 'bg-amber-500/15 text-amber-200 font-extrabold' : 'text-slate-200'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-5 text-[10px] font-mono tabular-nums text-slate-400 shrink-0">
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
            {match.player1Name ?? (match.status === 'bye' ? 'BYE' : 'TBD')}
          </span>
        </div>
        <span className="text-[10px] font-mono tabular-nums shrink-0 text-slate-400">
          {p1Won ? 'WIN' : match.player1Joined && match.status === 'ready' ? 'IN' : ''}
        </span>
      </div>

      {/* Player 2 */}
      <div
        className={`mt-1 flex items-center justify-between gap-2 rounded-lg px-2 py-1 ${
          p2Won ? 'bg-amber-500/15 text-amber-200 font-extrabold' : 'text-slate-200'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-5 text-[10px] font-mono tabular-nums text-slate-400 shrink-0">
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
            {match.player2Name ?? (match.status === 'bye' ? 'BYE' : 'TBD')}
          </span>
        </div>
        <span className="text-[10px] font-mono tabular-nums shrink-0 text-slate-400">
          {p2Won ? 'WIN' : match.player2Joined && match.status === 'ready' ? 'IN' : ''}
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
          {busyMatchId === match.bracketMatchId ? 'Connecting...' : 'Enter Match'}
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
          Watch Live
        </button>
      )}
    </div>
  );
}

export function TournamentModal() {
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
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [busyMatchId, setBusyMatchId] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Discover filters & join/create private
  const [typeFilter, setTypeFilter] = useState<TournamentType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<TournamentStatus | 'all'>('all');
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [createPrivateOpen, setCreatePrivateOpen] = useState(false);
  const [privTitle, setPrivTitle] = useState('Private Club Knockout');
  const [privCapacity, setPrivCapacity] = useState<TournamentCapacity>(8);
  const [privRules, setPrivRules] = useState<RuleProfileId>('casual');
  const [privEntryFee, setPrivEntryFee] = useState(0);
  const [privMinPlayers, setPrivMinPlayers] = useState(2);

  // Leaderboard scope
  const [lbSeasonFilter, setLbSeasonFilter] = useState<'ALL' | string>('ALL');
  const currentSeasonKey = useMemo(() => getCurrentSeasonKey(), []);

  // Admin state — NEVER hardcoded or stored in localStorage
  const [adminSecretInput, setAdminSecretInput] = useState('');
  const [adminTitle, setAdminTitle] = useState('Global Masters Cup');
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
  const [adminResolveReason, setAdminResolveReason] = useState('Administrator resolution');

  const refreshDiscover = useCallback(async () => {
    setLoadingList(true);
    await tournamentClient.fetchTournaments({
      type: typeFilter,
      status: statusFilter,
      adminKey: adminSecretInput || undefined,
    });
    setLoadingList(false);
  }, [typeFilter, statusFilter, adminSecretInput]);

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
      void tournamentClient.fetchLeaderboard(lbSeasonFilter);
    } else if (tournamentTab === 'career') {
      void tournamentClient.fetchPlayerStats();
    }
  }, [tournamentModalOpen, tournamentTab, lbSeasonFilter]);

  useEffect(() => {
    if (!tournamentModalOpen || !selectedTournamentId) return;
    setLoadingDetail(true);
    void tournamentClient
      .fetchTournamentDetail(selectedTournamentId, adminSecretInput || undefined)
      .finally(() => setLoadingDetail(false));
    multiplayerManager.subscribeTournamentWs(selectedTournamentId);
    return () => {
      multiplayerManager.unsubscribeTournamentWs(selectedTournamentId);
    };
  }, [tournamentModalOpen, selectedTournamentId, adminSecretInput]);

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

  if (!tournamentModalOpen) return null;

  const selfPlayerId = ownProfile?.playerId ?? null;
  const detail = activeTournamentDetail;
  const detailTournament = detail?.tournament ?? null;

  const handleSelectTournament = (tournamentId: string) => {
    soundEngine.playUiClick();
    useGameStore.getState().setSelectedTournamentId(tournamentId);
    setTournamentTab('bracket');
  };

  const handleRegister = async (t: TournamentRecord) => {
    soundEngine.playUiClick();
    setBusyAction(`reg_${t.tournamentId}`);
    setTournamentNotice(null);
    const res = await tournamentClient.register(t.tournamentId);
    setBusyAction(null);
    if (!res.ok) {
      setTournamentNotice({ type: 'err', text: res.error ?? 'Registration failed.' });
      return;
    }
    setTournamentNotice({
      type: 'ok',
      text: res.data?.autoStarted
        ? `Registered & ${t.title} bracket is now live!`
        : `Registered for ${t.title}.`,
    });
    useGameStore.getState().setSelectedTournamentId(t.tournamentId);
  };

  const handleWithdraw = async (tournamentId: string) => {
    soundEngine.playUiClick();
    setBusyAction(`wd_${tournamentId}`);
    setTournamentNotice(null);
    const res = await tournamentClient.withdraw(tournamentId);
    setBusyAction(null);
    if (!res.ok) {
      setTournamentNotice({ type: 'err', text: res.error ?? 'Withdrawal failed.' });
      return;
    }
    const refunded = res.data?.refundedCoins ?? 0;
    setTournamentNotice({
      type: 'ok',
      text:
        refunded > 0
          ? `Withdrawn cleanly. Refunded ${refunded} POOL COINS.`
          : 'Withdrawn from tournament.',
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
      setTournamentNotice({ type: 'err', text: res.error ?? 'Invalid invite code.' });
      return;
    }
    setInviteCodeInput('');
    setTournamentNotice({
      type: 'ok',
      text: `Joined ${res.data.tournament.title}.`,
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
      title: privTitle.trim() || 'Private Club Knockout',
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
      setTournamentNotice({ type: 'err', text: res.error ?? 'Failed to create private event.' });
      return;
    }
    setCreatePrivateOpen(false);
    setTournamentNotice({
      type: 'ok',
      text: `Private tournament created! Invite Code: ${res.data.tournament.inviteCode}`,
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

  // Bracket round grouping
  const roundColumns = useMemo(() => {
    if (!detail) return [];
    const grouped = new Map<number, TournamentMatch[]>();
    let thirdPlace: TournamentMatch | null = null;
    for (const m of detail.matches) {
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
        matches: matches.sort((a, b) => a.slotIndex - b.slotIndex),
      }));
    return { cols, thirdPlace };
  }, [detail]);

  const unresolvedMatches = useMemo(() => {
    if (!detail) return [];
    return detail.matches.filter(
      (m) =>
        (m.status === 'ready' || m.status === 'in_progress') &&
        m.player1Id &&
        m.player2Id,
    );
  }, [detail]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Global Tournaments & Championships"
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
                Global Tournaments & Championships
              </h2>
              <p className="text-[11px] text-slate-400">
                Single-elimination brackets · Real-time match rooms · Authoritative POOL COINS & trophies
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {wallet && (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-amber-500/10 px-2.5 py-1 font-mono text-xs font-extrabold tabular-nums text-amber-300">
                <Coins className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                {wallet.balance.toLocaleString()} COINS
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                void refreshDiscover();
                if (selectedTournamentId) {
                  void tournamentClient.fetchTournamentDetail(
                    selectedTournamentId,
                    adminSecretInput || undefined,
                  );
                }
              }}
              aria-label="Refresh tournaments"
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
              aria-label="Close tournaments hub"
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
              { id: 'discover', label: 'Discover', icon: Trophy },
              { id: 'bracket', label: 'Live Bracket', icon: Swords },
              { id: 'leaderboard', label: 'Leaderboard', icon: BarChart3 },
              { id: 'career', label: 'My Trophies', icon: Award },
              { id: 'admin', label: 'Admin', icon: Shield },
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
            <span>{tournamentNotice.text}</span>
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
                    <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-amber-400" />
                    <input
                      type="text"
                      maxLength={12}
                      value={inviteCodeInput}
                      onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())}
                      placeholder="Enter private tournament invite code..."
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] pl-8 pr-3 py-1.5 font-mono text-xs uppercase text-white placeholder:normal-case placeholder:font-sans placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busyAction === 'join_code' || inviteCodeInput.trim().length < 4}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/45 bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    Join Invite Code
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
                  Create Private Tournament
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
                      Host Private Bracket Tournament
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
                        Tournament Name
                      </label>
                      <input
                        type="text"
                        required
                        maxLength={64}
                        value={privTitle}
                        onChange={(e) => setPrivTitle(e.target.value)}
                        className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        Capacity
                      </label>
                      <select
                        value={privCapacity}
                        onChange={(e) => setPrivCapacity(Number(e.target.value) as TournamentCapacity)}
                        className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      >
                        <option value={8}>8 Players</option>
                        <option value={16}>16 Players</option>
                        <option value={32}>32 Players</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        Ruleset
                      </label>
                      <select
                        value={privRules}
                        onChange={(e) => setPrivRules(e.target.value as RuleProfileId)}
                        className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      >
                        <option value="casual">Standard Casual</option>
                        <option value="wpa">Strict Called (WPA)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        Entry Fee (Coins)
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
                        Min Players
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
                        {busyAction === 'create_private' ? 'Creating...' : 'Launch Private Bracket'}
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
                      { id: 'all', label: 'All Types' },
                      { id: 'quick', label: 'Quick' },
                      { id: 'daily', label: 'Daily' },
                      { id: 'weekly', label: 'Weekly' },
                      { id: 'scheduled', label: 'Scheduled' },
                      { id: 'private', label: 'Private' },
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
                  aria-label="Filter tournament status"
                  className="rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs font-semibold text-slate-200 focus:border-amber-400 focus:outline-none"
                >
                  <option value="all">All Statuses</option>
                  <option value="registration_open">Registration Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="upcoming">Upcoming</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>

              {/* Tournament Grid */}
              {loadingList && tournamentsList.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  Loading global tournaments...
                </div>
              ) : tournamentsList.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-black/25 py-12 text-center text-xs text-slate-400">
                  No tournaments match the selected filters.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {tournamentsList.map((t) => {
                    const isRegOpen =
                      t.status === 'registration_open' && nowMs <= t.registrationClosesAtMs;
                    const isFull = t.participantCount >= t.maxPlayers;
                    const isBusy = busyAction === `reg_${t.tournamentId}` || busyAction === `wd_${t.tournamentId}`;
                    const countdownTarget =
                      t.status === 'upcoming'
                        ? t.registrationOpensAtMs
                        : t.status === 'registration_open'
                          ? t.registrationClosesAtMs
                          : t.startsAtMs;

                    return (
                      <div
                        key={t.tournamentId}
                        className="flex flex-col justify-between rounded-xl border border-white/12 bg-[#101924] p-4 shadow-lg"
                      >
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider">
                                <span className={statusTextClass(t.status)}>
                                  {formatTournamentStatus(t.status)}
                                </span>
                                <span className="text-slate-600">·</span>
                                <span className="text-amber-300">{formatTournamentType(t.type)}</span>
                                <span className="text-slate-600">·</span>
                                <span className="text-slate-400">
                                  {t.calledShotsEnabled ? 'Strict WPA' : 'Casual'}
                                </span>
                              </div>
                              <h3 className="mt-1 truncate text-sm font-extrabold text-white">
                                {t.title}
                              </h3>
                            </div>
                            <span className="font-mono text-xs font-black tabular-nums text-amber-300 shrink-0">
                              {t.prizes.championCoins.toLocaleString()} COINS
                            </span>
                          </div>

                          <p className="mt-1.5 line-clamp-2 text-xs text-slate-400">
                            {t.description || 'Official single-elimination 8-Ball championship bracket.'}
                          </p>

                          <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] font-mono tabular-nums">
                            <div>
                              <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                                Players
                              </div>
                              <div className="font-bold text-white">
                                {t.participantCount}/{t.maxPlayers}
                              </div>
                            </div>
                            <div>
                              <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                                Entry Fee
                              </div>
                              <div className="font-bold text-amber-200">
                                {t.entryFeeCoins > 0 ? `${t.entryFeeCoins}` : 'Free'}
                              </div>
                            </div>
                            <div>
                              <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                                {t.status === 'in_progress'
                                  ? 'Round'
                                  : t.status === 'completed'
                                    ? 'Champion'
                                    : t.status === 'upcoming'
                                      ? 'Opens In'
                                      : 'Closes In'}
                              </div>
                              <div className="truncate font-bold text-slate-200">
                                {t.status === 'in_progress'
                                  ? `${t.currentRound}/${t.totalRounds}`
                                  : t.status === 'completed'
                                    ? t.championDisplayName ?? 'Awarded'
                                    : t.status === 'cancelled'
                                      ? 'Closed'
                                      : formatCountdownMs(countdownTarget, nowMs)}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleSelectTournament(t.tournamentId)}
                            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap shrink-0"
                          >
                            View Bracket
                          </button>

                          {t.viewerRegistered ? (
                            isRegOpen ? (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleWithdraw(t.tournamentId)}
                                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-400/40 bg-rose-500/12 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-500/20 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                Withdraw
                              </button>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300 whitespace-nowrap shrink-0">
                                <UserCheck className="h-3.5 w-3.5" />
                                Entered
                              </span>
                            )
                          ) : (
                            isRegOpen && (
                              <button
                                type="button"
                                disabled={isBusy || isFull}
                                onClick={() => void handleRegister(t)}
                                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                {isFull ? 'Full' : isBusy ? 'Joining...' : 'Register'}
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
              {loadingDetail && !detail ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  Loading tournament bracket...
                </div>
              ) : !detail || !detailTournament ? (
                <div className="rounded-xl border border-white/10 bg-black/25 py-12 text-center text-xs text-slate-400 space-y-3">
                  <div>Select a tournament from the Discover feed to inspect its live bracket.</div>
                  <button
                    type="button"
                    onClick={() => setTournamentTab('discover')}
                    className="inline-flex items-center rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                  >
                    Browse Tournaments
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
                            {formatTournamentStatus(detailTournament.status)}
                          </span>
                          <span className="text-slate-600">·</span>
                          <span className="text-amber-300">
                            {formatTournamentType(detailTournament.type)}
                          </span>
                          <span className="text-slate-600">·</span>
                          <span className="text-slate-300">
                            {detailTournament.calledShotsEnabled ? 'Strict WPA' : 'Standard Casual'}
                          </span>
                          <span className="text-slate-600">·</span>
                          <span className="font-mono text-slate-400">{detailTournament.seasonKey}</span>
                        </div>
                        <h3 className="mt-1 text-lg font-extrabold text-white">
                          {detailTournament.title}
                        </h3>
                        <p className="mt-0.5 text-xs text-slate-300">
                          {detailTournament.description}
                        </p>
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
                                Copied {detailTournament.inviteCode}
                              </>
                            ) : (
                              <>
                                <Copy className="h-3.5 w-3.5 text-amber-400" />
                                Code: {detailTournament.inviteCode}
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
                            Enter Active Match
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
                              Register Now
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
                              Withdraw
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
                                      text: res.error ?? 'Unable to start tournament.',
                                    });
                                  }
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/45 bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                <Play className="h-3.5 w-3.5" />
                                Start Bracket
                              </button>
                              <button
                                type="button"
                                disabled={busyAction === 'host_cancel'}
                                onClick={async () => {
                                  soundEngine.playUiClick();
                                  setBusyAction('host_cancel');
                                  await tournamentClient.cancelTournament(
                                    detailTournament.tournamentId,
                                    'Cancelled by tournament host.',
                                  );
                                  setBusyAction(null);
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/12 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap shrink-0"
                              >
                                Cancel Event
                              </button>
                            </>
                          )}
                      </div>
                    </div>

                    {/* Key Metrics Strip */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-white/10 font-mono tabular-nums text-xs">
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                          Capacity
                        </div>
                        <div className="font-bold text-white">
                          {detailTournament.participantCount}/{detailTournament.maxPlayers}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                          Entry / Min ELO
                        </div>
                        <div className="font-bold text-slate-200">
                          {detailTournament.entryFeeCoins > 0
                            ? `${detailTournament.entryFeeCoins} COINS`
                            : 'Free'}
                          {detailTournament.minElo > 0 ? ` · ${detailTournament.minElo}+` : ''}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                          1st · 2nd · 3rd
                        </div>
                        <div className="font-bold text-amber-300">
                          {detailTournament.prizes.championCoins} / {detailTournament.prizes.runnerUpCoins} /{' '}
                          {detailTournament.prizes.thirdPlaceCoins}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                          Registration Closes
                        </div>
                        <div className="font-bold text-slate-200">
                          {detailTournament.status === 'registration_open'
                            ? formatCountdownMs(detailTournament.registrationClosesAtMs, nowMs)
                            : formatDateTime(detailTournament.registrationClosesAtMs)}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[9px] font-sans uppercase tracking-wider text-slate-400">
                          Champion
                        </div>
                        <div className="truncate font-sans font-bold text-amber-300">
                          {detailTournament.championDisplayName ?? 'Pending'}
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
                              Official Championship Podium
                            </div>
                            <div className="text-sm font-extrabold text-white">
                              1st: {detailTournament.championDisplayName}
                              {detailTournament.runnerUpDisplayName
                                ? ` · 2nd: ${detailTournament.runnerUpDisplayName}`
                                : ''}
                              {detailTournament.thirdPlaceDisplayName
                                ? ` · 3rd: ${detailTournament.thirdPlaceDisplayName}`
                                : ''}
                            </div>
                          </div>
                        </div>
                        <span className="font-mono text-xs font-extrabold tabular-nums text-amber-300">
                          +{detailTournament.prizes.championCoins.toLocaleString()} COINS
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
                            Ongoing Live Matches ({liveMatches.length})
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
                                  {m.roundLabel}
                                </div>
                                <div className="font-bold text-white truncate max-w-[200px]">
                                  {m.player1Name ?? 'Player 1'} vs {m.player2Name ?? 'Player 2'}
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
                                Watch Live
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
                      Bracket pairings will be generated automatically by ELO seeding once registration closes or capacity is reached.
                    </div>
                  ) : (
                    <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
                          Single-Elimination Bracket ({detailTournament.bracketSize}-Slot Tree)
                        </span>
                        <span className="text-[11px] font-mono tabular-nums text-slate-400">
                          Round {detailTournament.currentRound} / {detailTournament.totalRounds}
                        </span>
                      </div>

                      <div className="flex gap-3 overflow-x-auto pb-2">
                        {!Array.isArray(roundColumns) &&
                          roundColumns.cols.map((col) => (
                            <div
                              key={col.roundNumber}
                              className="min-w-[235px] flex-1 space-y-2.5"
                            >
                              <div className="rounded-lg border border-white/10 bg-[#0b1017] px-2.5 py-1.5 text-center text-[11px] font-extrabold uppercase tracking-wider text-amber-300">
                                {col.roundLabel}
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

                        {!Array.isArray(roundColumns) && roundColumns.thirdPlace && (
                          <div className="min-w-[235px] flex-1 space-y-2.5">
                            <div className="rounded-lg border border-white/10 bg-[#0b1017] px-2.5 py-1.5 text-center text-[11px] font-extrabold uppercase tracking-wider text-slate-300">
                              Third Place Match
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
                          Participants ({detail.participants.length}/{detailTournament.maxPlayers})
                        </span>
                      </div>
                      <div className="max-h-56 overflow-y-auto space-y-1.5">
                        {detail.participants.length === 0 ? (
                          <div className="py-4 text-center text-xs text-slate-400">
                            No competitors registered yet.
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
                                  <span className="w-6 font-mono text-[10px] tabular-nums text-slate-400 shrink-0">
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
                                  <span className="text-slate-400">{p.elo} ELO</span>
                                  <span
                                    className={`uppercase font-bold ${
                                      p.status === 'champion'
                                        ? 'text-amber-300'
                                        : p.status === 'withdrawn' || p.status === 'eliminated'
                                          ? 'text-slate-500'
                                          : 'text-emerald-300'
                                    }`}
                                  >
                                    {p.placement ? placementLabel(p.placement) : p.status}
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
                          Tournament Log & Payouts
                        </span>
                      </div>
                      <div className="max-h-56 overflow-y-auto space-y-1.5 text-xs">
                        {detail.payouts.map((pay) => (
                          <div
                            key={pay.payoutId}
                            className="flex items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-500/8 px-2.5 py-1.5"
                          >
                            <span className="truncate font-semibold text-amber-200">
                              {pay.displayName} · {pay.placement.replace('_', ' ')}
                            </span>
                            <span className="font-mono font-bold tabular-nums text-amber-300 shrink-0">
                              +{pay.coinsAwarded} COINS
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
                              {formatDateTime(ev.createdAtMs)}
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
                    Global All-Time
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
                    Season {currentSeasonKey}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    void tournamentClient.fetchLeaderboard(lbSeasonFilter);
                  }}
                  className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                >
                  Refresh
                </button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-white/10 bg-black/25">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <th className="px-3 py-2">Rank</th>
                      <th className="px-3 py-2">Competitor</th>
                      <th className="px-3 py-2 text-right">Titles</th>
                      <th className="px-3 py-2 text-right">Finals</th>
                      <th className="px-3 py-2 text-right">Match W–L</th>
                      <th className="px-3 py-2 text-right">Win %</th>
                      <th className="px-3 py-2 text-right">Prize Coins</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {tournamentLeaderboard.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          No tournament champions or bracket results recorded yet for this season.
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
                            <td className="px-3 py-2 font-mono font-bold tabular-nums text-amber-300">
                              #{row.rank}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => {
                                  soundEngine.playUiClick();
                                  openProgressionModal('profile', row.playerId);
                                }}
                                className="flex items-center gap-2 text-left hover:underline cursor-pointer"
                              >
                                <span
                                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-bold"
                                  style={{ backgroundColor: `${av.accent}22`, color: av.accent }}
                                >
                                  {av.glyph}
                                </span>
                                <span className="font-bold text-white">{row.displayName}</span>
                                <span className="font-mono text-[10px] text-slate-400">
                                  {row.elo}
                                </span>
                              </button>
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-extrabold tabular-nums text-amber-300">
                              {row.championships}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-200">
                              {row.finalsAppearances}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-200">
                              {row.matchesWon}–{row.matchesLost}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-200">
                              {row.winRate.toFixed(1)}%
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-bold tabular-nums text-amber-200">
                              {row.totalCoinsWon.toLocaleString()}
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
              {!playerTournamentStats ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  Loading tournament career telemetry...
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { label: 'Championships', value: String(playerTournamentStats.championships) },
                      { label: 'Finals Reached', value: String(playerTournamentStats.finalsAppearances) },
                      {
                        label: 'Bracket Record',
                        value: `${playerTournamentStats.matchesWon}W – ${playerTournamentStats.matchesLost}L`,
                      },
                      {
                        label: 'Match Win Rate',
                        value: `${playerTournamentStats.winRate.toFixed(1)}%`,
                      },
                      { label: 'Events Entered', value: String(playerTournamentStats.tournamentsEntered) },
                      {
                        label: '3rd Place Finishes',
                        value: String(playerTournamentStats.thirdPlaceFinishes),
                      },
                      {
                        label: 'Prize Coins Won',
                        value: playerTournamentStats.totalCoinsWon.toLocaleString(),
                      },
                      {
                        label: 'Trophies Earned',
                        value: `${playerTournamentStats.trophies.length}/${TOURNAMENT_TROPHY_CATALOG.length}`,
                      },
                    ].map((stat) => (
                      <div
                        key={stat.label}
                        className="rounded-xl border border-white/10 bg-[#101924] px-3 py-2.5"
                      >
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          {stat.label}
                        </div>
                        <div className="mt-0.5 font-mono text-sm font-extrabold tabular-nums text-white">
                          {stat.value}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Trophy Cabinet */}
                  <div className="rounded-xl border border-white/10 bg-black/25 p-3.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-2.5">
                      Championship Trophy Case
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {TOURNAMENT_TROPHY_CATALOG.map((def) => {
                        const unlocked = playerTournamentStats.trophies.find(
                          (t) => t.id === def.id,
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
                                {unlocked ? 'Awarded' : 'Locked'}
                              </span>
                            </div>
                            <div className="mt-1 text-xs font-extrabold text-white">{def.name}</div>
                            <p className="mt-0.5 text-[11px] text-slate-400">{def.description}</p>
                            {unlocked && (
                              <div className="mt-1.5 text-[10px] text-amber-300 truncate">
                                {unlocked.tournamentTitle} · {formatDateTime(unlocked.unlockedAtMs)}
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
                      Recent Tournament Placements
                    </div>
                    {playerTournamentStats.recentTournaments.length === 0 ? (
                      <div className="py-4 text-xs text-slate-400">
                        Enter a tournament in the Discover tab to build your championship record.
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
                              className="font-bold text-white hover:underline cursor-pointer text-left"
                            >
                              {item.title}
                            </button>
                            <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums">
                              <span className="text-slate-300">
                                {item.placement ? placementLabel(item.placement) : item.participantStatus}
                              </span>
                              {item.coinsWon > 0 && (
                                <span className="font-bold text-amber-300">+{item.coinsWon} COINS</span>
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
                  Server-Verified Operator Secret (Session Only)
                </label>
                <input
                  type="password"
                  value={adminSecretInput}
                  onChange={(e) => setAdminSecretInput(e.target.value)}
                  placeholder="Enter operator TOURNAMENT_ADMIN_SECRET..."
                  className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-3 py-2 font-mono text-xs text-white focus:border-amber-400 focus:outline-none"
                />
                <p className="text-[11px] text-slate-400">
                  Admin actions are verified server-side on every request and are never stored in browser storage.
                </p>
              </div>

              {/* Create Global Tournament */}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  soundEngine.playUiClick();
                  setBusyAction('admin_create');
                  const regMs = Math.max(1, adminRegMinutes) * 60_000;
                  const res = await tournamentClient.adminCreateTournament(adminSecretInput, {
                    title: adminTitle.trim() || 'Global Masters Cup',
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
                      text: res.error ?? 'Admin tournament creation rejected.',
                    });
                    return;
                  }
                  setTournamentNotice({
                    type: 'ok',
                    text: `Global tournament "${res.data.tournament.title}" published.`,
                  });
                  useGameStore.getState().setSelectedTournamentId(res.data.tournament.tournamentId);
                }}
                className="rounded-xl border border-white/12 bg-[#101924] p-4 space-y-3"
              >
                <div className="text-xs font-extrabold uppercase tracking-wider text-amber-300">
                  Create Global / Scheduled Tournament
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                  <div className="sm:col-span-2">
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      Title
                    </label>
                    <input
                      type="text"
                      required
                      value={adminTitle}
                      onChange={(e) => setAdminTitle(e.target.value)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      Type
                    </label>
                    <select
                      value={adminType}
                      onChange={(e) => setAdminType(e.target.value as TournamentType)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="quick">Quick</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly Championship</option>
                      <option value="scheduled">Scheduled Global</option>
                      <option value="private">Private</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      Max Players
                    </label>
                    <select
                      value={adminCapacity}
                      onChange={(e) =>
                        setAdminCapacity(Number(e.target.value) as TournamentCapacity)
                      }
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value={8}>8</option>
                      <option value={16}>16</option>
                      <option value={32}>32</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      Ruleset
                    </label>
                    <select
                      value={adminRules}
                      onChange={(e) => setAdminRules(e.target.value as RuleProfileId)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="casual">Standard Casual</option>
                      <option value="wpa">Strict WPA</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                      Entry Fee
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
                      Min ELO
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
                      Reg Window (Min)
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
                      1st Prize Coins
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
                      Publish Tournament
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
                        Managing Selected Event
                      </div>
                      <div className="text-sm font-extrabold text-white">
                        {detailTournament.title} ({detailTournament.status})
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
                              ? { type: 'ok', text: 'Tournament bracket started.' }
                              : { type: 'err', text: res.error ?? 'Failed to start.' },
                          );
                        }}
                        className="rounded-lg border border-emerald-400/45 bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                      >
                        Force Start
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
                              ? { type: 'ok', text: 'Processed due tournament timers.' }
                              : { type: 'err', text: res.error ?? 'Timer sync failed.' },
                          );
                        }}
                        className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                      >
                        Process Timers
                      </button>
                      <button
                        type="button"
                        disabled={!adminSecretInput.trim() || busyAction === 'admin_cancel'}
                        onClick={async () => {
                          setBusyAction('admin_cancel');
                          const res = await tournamentClient.adminCancelTournament(
                            adminSecretInput,
                            detailTournament.tournamentId,
                            'Cancelled by tournament administrator.',
                          );
                          setBusyAction(null);
                          setTournamentNotice(
                            res.ok
                              ? {
                                  type: 'ok',
                                  text: `Cancelled & refunded ${res.data?.refundedCount ?? 0} entries.`,
                                }
                              : { type: 'err', text: res.error ?? 'Cancel failed.' },
                          );
                        }}
                        className="rounded-lg border border-rose-400/45 bg-rose-500/15 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                      >
                        Cancel & Refund
                      </button>
                    </div>
                  </div>

                  {unresolvedMatches.length > 0 && (
                    <div className="pt-3 border-t border-white/10 space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
                        Resolve Active Bracket Match
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
                          <option value="">Select match...</option>
                          {unresolvedMatches.map((m) => (
                            <option key={m.bracketMatchId} value={m.bracketMatchId}>
                              {m.roundLabel}: {m.player1Name} vs {m.player2Name}
                            </option>
                          ))}
                        </select>

                        <select
                          value={adminResolveWinnerId}
                          onChange={(e) => setAdminResolveWinnerId(e.target.value)}
                          className="rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                        >
                          <option value="">Select winner...</option>
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
                          <option value="admin_resolved">Admin Override</option>
                          <option value="forfeit">Forfeit</option>
                          <option value="no_show">No-Show</option>
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
                                reason: adminResolveReason.trim() || 'Admin resolution',
                              },
                            );
                            setBusyAction(null);
                            if (!res.ok) {
                              setTournamentNotice({
                                type: 'err',
                                text: res.error ?? 'Failed to resolve match.',
                              });
                            } else {
                              setAdminResolveMatchId('');
                              setAdminResolveWinnerId('');
                              setTournamentNotice({
                                type: 'ok',
                                text: 'Bracket match resolved and winner advanced.',
                              });
                            }
                          }}
                          className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                        >
                          Confirm Winner
                        </button>
                      </div>
                      <input
                        type="text"
                        value={adminResolveReason}
                        onChange={(e) => setAdminResolveReason(e.target.value)}
                        placeholder="Resolution audit note..."
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
