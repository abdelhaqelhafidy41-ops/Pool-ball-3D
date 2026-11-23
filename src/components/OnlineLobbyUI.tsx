import {
  Check,
  Copy,
  Crown,
  Eye,
  Globe,
  History,
  KeyRound,
  Loader2,
  Play,
  PlusCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  Swords,
  Trophy,
  UserCheck,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RuleProfileId } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import {
  formatLocalizedNumber,
  localizeAvatarLabel,
  localizeFoulOrReason,
  localizeOnlineMatchType,
  localizePlayerName,
  localizeRankTierName,
  localizeRuleProfile,
  localizeSeasonNameAndTheme,
  localizeServerError,
  localizeTeamBoardLabel,
  localizeTournamentRoundLabel,
  tLang,
  useTranslation,
} from '../i18n';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { progressionClient } from '../multiplayer/ProgressionClient';
import {
  getAvatarVisualMeta,
  getBadgeVisualMeta,
  getNameplateVisualClass,
} from '../multiplayer/shared/economy';
import {
  ONLINE_AVATARS,
  type OnlineAvatarId,
  type OnlineModeIntent,
} from '../multiplayer/shared/protocol';
import { getRankForElo, RANKED_MATCHMAKING_CONFIG } from '../multiplayer/shared/ranked';
import { useGameStore } from '../store/useGameStore';
import { RankBadge, RankProgressCard } from './RankBadge';

type LobbyTab = OnlineModeIntent | 'history';

function formatSeasonRemaining(
  endsAtMs: number,
  nowMs: number,
  lang: 'ar' | 'en',
): string {
  const diffSec = Math.max(0, Math.floor((endsAtMs - nowMs) / 1000));
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  if (days > 0) {
    return tLang(lang, 'common.countdownDaysHoursLeft', { days, hours });
  }
  const mins = Math.floor((diffSec % 3600) / 60);
  return tLang(lang, 'common.countdownHoursMinsLeft', { hours, mins });
}

export function OnlineLobbyUI() {
  const { t, language } = useTranslation();
  const onlineLobbyOpen = useGameStore((s) => s.onlineLobbyOpen);
  const closeOnlineLobby = useGameStore((s) => s.closeOnlineLobby);
  const onlineModeIntent = useGameStore((s) => s.onlineModeIntent);
  const setOnlineModeIntent = useGameStore((s) => s.setOnlineModeIntent);
  const onlineProfile = useGameStore((s) => s.onlineProfile);
  const onlineConnectionStatus = useGameStore((s) => s.onlineConnectionStatus);
  const onlineSessionId = useGameStore((s) => s.onlineSessionId);
  const onlineLatencyMs = useGameStore((s) => s.onlineLatencyMs);
  const onlineRoom = useGameStore((s) => s.onlineRoom);
  const onlineMatchmaking = useGameStore((s) => s.onlineMatchmaking);
  const onlineError = useGameStore((s) => s.onlineError);
  const setOnlineError = useGameStore((s) => s.setOnlineError);
  const onlineHistory = useGameStore((s) => s.onlineHistory);
  const ownProfile = useGameStore((s) => s.ownProfile);
  const activeSeason = useGameStore((s) => s.activeSeason);
  const moderationStatus = useGameStore((s) => s.moderationStatus);
  const openProgressionModal = useGameStore((s) => s.openProgressionModal);
  const openSocialModal = useGameStore((s) => s.openSocialModal);
  const openTournamentModal = useGameStore((s) => s.openTournamentModal);
  const friends = useGameStore((s) => s.friends);
  const incomingRequests = useGameStore((s) => s.incomingRequests);
  const incomingInvitations = useGameStore((s) => s.incomingInvitations);
  const totalUnreadDmCount = useGameStore((s) => s.totalUnreadDmCount);
  const spectatableMatches = useGameStore((s) => s.spectatableMatches);
  const spectatableMatchesLoading = useGameStore((s) => s.spectatableMatchesLoading);

  const [activeTab, setActiveTab] = useState<LobbyTab>(onlineModeIntent);
  const [nameInput, setNameInput] = useState(onlineProfile.displayName);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [spectateCodeInput, setSpectateCodeInput] = useState('');
  const [spectateMatchFilter, setSpectateMatchFilter] = useState<'all' | 'quick' | 'ranked' | 'tournament'>('all');
  const [copiedWatchLink, setCopiedWatchLink] = useState(false);
  const [ruleProfileId, setRuleProfileId] = useState<RuleProfileId>(
    onlineModeIntent === 'ranked' ? RANKED_MATCHMAKING_CONFIG.defaultRuleProfile : 'casual',
  );
  const [copiedCode, setCopiedCode] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setActiveTab(onlineModeIntent);
    if (onlineModeIntent === 'ranked' && !onlineMatchmaking.active) {
      setRuleProfileId(RANKED_MATCHMAKING_CONFIG.defaultRuleProfile);
    }
  }, [onlineModeIntent, onlineMatchmaking.active]);

  useEffect(() => {
    setNameInput(onlineProfile.displayName);
  }, [onlineProfile.displayName]);

  useEffect(() => {
    if (!onlineLobbyOpen) return;
    multiplayerManager.ensureConnected();
    void progressionClient.fetchRankedSeasons();
    void progressionClient.fetchModerationStatus();
  }, [onlineLobbyOpen]);

  useEffect(() => {
    if (!onlineLobbyOpen || !onlineMatchmaking.active) return;
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 500);
    return () => window.clearInterval(id);
  }, [onlineLobbyOpen, onlineMatchmaking.active]);

  useEffect(() => {
    if (onlineLobbyOpen && activeTab === 'history') {
      void multiplayerManager.fetchOnlineHistory();
    } else if (onlineLobbyOpen && activeTab === 'spectate') {
      void multiplayerManager.fetchSpectatableMatches({ matchType: spectateMatchFilter });
    }
  }, [onlineLobbyOpen, activeTab, spectateMatchFilter]);

  if (!onlineLobbyOpen) return null;

  const commitProfile = (nextName: string, nextAvatar: OnlineAvatarId = onlineProfile.avatarId) => {
    const clean = nextName.trim().slice(0, 16) || t('menu.defaultPlayer1Name');
    setNameInput(clean);
    multiplayerManager.updateProfile(clean, nextAvatar);
  };

  const handleCopyCode = async () => {
    if (!onlineRoom) return;
    soundEngine.playUiClick();
    try {
      await navigator.clipboard.writeText(onlineRoom.roomCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      setCopiedCode(false);
    }
  };

  const isConnected = onlineConnectionStatus === 'connected' && Boolean(onlineSessionId);
  const calledShotsEnabled = ruleProfileId === 'wpa';

  const localRoomPlayer =
    onlineRoom?.players.find((p) => p.sessionId === onlineSessionId) ?? null;
  const isHost = Boolean(onlineRoom && onlineSessionId && onlineRoom.hostSessionId === onlineSessionId);
  const connectedRoomPlayers = onlineRoom?.players.filter((p) => p.connected) ?? [];
  const bothReady =
    connectedRoomPlayers.length === 2 && connectedRoomPlayers.every((p) => p.ready);

  const searchElapsedSec = onlineMatchmaking.active
    ? Math.max(0, Math.floor((nowMs - onlineMatchmaking.startedAtMs) / 1000))
    : 0;

  const connectionStatusLabel =
    onlineConnectionStatus === 'connected'
      ? t('lobby.connConnected')
      : onlineConnectionStatus === 'connecting'
        ? t('lobby.connConnecting')
        : onlineConnectionStatus === 'reconnecting'
          ? t('lobby.connReconnecting')
          : t('lobby.connDisconnected');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('lobby.dialogAria')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4"
    >
      <div className="w-full max-w-xl max-h-[92dvh] modal-scroll-y rounded-2xl border border-white/15 bg-[#0c1219] p-4 sm:p-6 text-slate-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/10">
              <Globe className="h-4.5 w-4.5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-extrabold tracking-tight text-white">
                {t('lobby.headerTitle')}
              </h2>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      onlineConnectionStatus === 'connected'
                        ? 'bg-emerald-400'
                        : onlineConnectionStatus === 'connecting' ||
                            onlineConnectionStatus === 'reconnecting'
                          ? 'bg-amber-400'
                          : 'bg-rose-400'
                    }`}
                  />
                  <span className="font-semibold text-slate-300">
                    {connectionStatusLabel}
                  </span>
                </span>
                {onlineLatencyMs !== null && isConnected && (
                  <span dir="ltr" className="font-mono tabular-nums text-slate-400">
                    {t('lobby.latencyMs', { ms: onlineLatencyMs })}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {ownProfile && (
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  openProgressionModal('profile');
                }}
                className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-500/20 cursor-pointer whitespace-nowrap"
              >
                <RankBadge elo={ownProfile.elo} size="xs" />
                <span>{t('common.levelShort', { level: ownProfile.level })}</span>
                <span className="font-mono tabular-nums">
                  {formatLocalizedNumber(ownProfile.elo, language)} {t('common.elo')}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                openSocialModal('friends');
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
            >
              <Users className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden sm:inline">{t('lobby.friendsBtn')}</span>
              {incomingRequests.length + incomingInvitations.length + totalUnreadDmCount > 0 && (
                <span className="rounded bg-amber-500 px-1 py-0.2 font-mono text-[9px] font-black text-slate-950">
                  {incomingRequests.length + incomingInvitations.length + totalUnreadDmCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                closeOnlineLobby();
                openTournamentModal('discover');
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-400/35 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-500/20 cursor-pointer whitespace-nowrap"
            >
              <Crown className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden sm:inline">{t('lobby.tournamentsBtn')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                openProgressionModal('leaderboard');
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
            >
              <Trophy className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden sm:inline">{t('lobby.leaderboardBtn')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                closeOnlineLobby();
              }}
              aria-label={t('lobby.closeAria')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Player Identity Strip */}
        <div className="mt-3.5 rounded-xl border border-white/10 bg-black/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex-1 min-w-[160px]">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                {t('lobby.yourPlayerName')}
              </label>
              <input
                type="text"
                maxLength={16}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={() => commitProfile(nameInput)}
                className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs font-semibold text-white focus:border-amber-400 focus:outline-none"
                placeholder={t('lobby.playerNamePlaceholder')}
              />
            </div>

            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                {t('lobby.avatarLabel')}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {ONLINE_AVATARS.map((av) => {
                  const selected = onlineProfile.avatarId === av.id;
                  const avLabel = localizeAvatarLabel(av.id, av.label, language);
                  return (
                    <button
                      key={av.id}
                      type="button"
                      title={avLabel}
                      onClick={() => {
                        soundEngine.playUiClick();
                        commitProfile(nameInput, av.id);
                      }}
                      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                        selected
                          ? 'border-amber-400 scale-105 bg-amber-500/15'
                          : 'border-white/10 bg-white/5 opacity-75 hover:opacity-100'
                      }`}
                      style={{ color: av.accent }}
                    >
                      {av.glyph}
                    </button>
                  );
                })}
                {!ONLINE_AVATARS.some((a) => a.id === onlineProfile.avatarId) &&
                  (() => {
                    const customAv = getAvatarVisualMeta(onlineProfile.avatarId);
                    const customLabel = localizeAvatarLabel(
                      onlineProfile.avatarId,
                      customAv.label,
                      language,
                    );
                    return (
                      <button
                        type="button"
                        title={t('lobby.storeItemTitle', { label: customLabel })}
                        onClick={() => {
                          soundEngine.playUiClick();
                          commitProfile(nameInput, onlineProfile.avatarId);
                        }}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-amber-400 scale-105 bg-amber-500/15 text-xs font-bold cursor-pointer"
                        style={{ color: customAv.accent }}
                      >
                        {customAv.glyph}
                      </button>
                    );
                  })()}
              </div>
            </div>
          </div>
        </div>

        {/* Error Alert */}
        {onlineError && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            <span className="min-w-0 break-words">
              {localizeServerError(onlineError, language)}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              {!isConnected && (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    multiplayerManager.retryConnection();
                  }}
                  className="rounded-lg border border-rose-400/40 bg-rose-500/20 px-2 py-1 text-[11px] font-bold text-rose-100 hover:bg-rose-500/30 cursor-pointer"
                >
                  {t('common.retry')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOnlineError(null)}
                aria-label={t('common.dismissNotification')}
                className="text-rose-300 hover:text-white cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Active Room Lobby View (Private or Matched) */}
        {onlineRoom ? (
          <div className="mt-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2.5">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                  {onlineRoom.tournament
                    ? `${onlineRoom.tournament.tournamentTitle} · ${localizeTournamentRoundLabel(onlineRoom.tournament.roundLabel, language)}`
                    : onlineRoom.clubLeague
                      ? `${onlineRoom.clubLeague.competitionTitle} · ${localizeTeamBoardLabel(onlineRoom.clubLeague.boardLabel, language)}`
                      : onlineRoom.matchType === 'ranked'
                        ? t('lobby.roomRanked')
                        : onlineRoom.isPrivate
                          ? t('lobby.roomPrivateCode')
                          : t('lobby.roomMatchedQuick')}
                </div>
                {onlineRoom.tournament ? (
                  <div className="mt-0.5 text-xs font-extrabold text-white">
                    {t('lobby.officialTournamentBanner')}
                  </div>
                ) : onlineRoom.clubLeague ? (
                  <div className="mt-0.5 text-xs font-extrabold text-white">
                    {t('lobby.clubLeagueBanner', {
                      homeTag: onlineRoom.clubLeague.homeTeamTag,
                      homeName: onlineRoom.clubLeague.homeTeamName,
                      awayTag: onlineRoom.clubLeague.awayTeamTag,
                      awayName: onlineRoom.clubLeague.awayTeamName,
                    })}
                  </div>
                ) : (
                  <div className="mt-0.5 flex items-center gap-2">
                    <span
                      dir="ltr"
                      data-testid="online-room-code"
                      className="font-mono text-xl font-black tracking-[0.22em] text-white"
                    >
                      {onlineRoom.roomCode}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyCode}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-black/35 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-black/55 cursor-pointer"
                    >
                      {copiedCode ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-400" />
                          {t('common.copied')}
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3 text-amber-400" />
                          {t('lobby.inviteCopyBtn')}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>

              <div className="text-end">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  {t('lobby.statusLabel')}
                </div>
                <div className="text-xs font-bold text-white">
                  {onlineRoom.players.length < 2
                    ? t('lobby.waitingForOpponent')
                    : bothReady
                      ? t('lobby.bothPlayersReady')
                      : t('lobby.confirmReadiness')}
                </div>
                <div className="text-[10px] text-slate-400">
                  {localizeRuleProfile(onlineRoom.calledShotsEnabled ? 'wpa' : 'casual', language)}
                </div>
              </div>
            </div>

            {/* Player Slots */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {[0, 1].map((slotIdx) => {
                const p = onlineRoom.players[slotIdx] ?? null;
                if (!p) {
                  return (
                    <div
                      key={slotIdx}
                      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-black/25 p-3.5 text-xs font-medium text-slate-400"
                    >
                      <span>{t('lobby.waitingForOpponent')}</span>
                      {!onlineRoom.tournament && !onlineRoom.clubLeague && (
                        <button
                          type="button"
                          onClick={() => {
                            soundEngine.playUiClick();
                            openSocialModal('friends');
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-amber-400/35 bg-amber-500/12 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-500/20 cursor-pointer"
                        >
                          <Swords className="h-3 w-3" />
                          {t('lobby.inviteFriendCount', { count: friends.length })}
                        </button>
                      )}
                    </div>
                  );
                }
                const av = getAvatarVisualMeta(p.avatarId);
                const np = getNameplateVisualClass(p.equippedCosmetics?.nameplateId);
                const badge = getBadgeVisualMeta(p.equippedCosmetics?.badgeId);
                const isYou = p.sessionId === onlineSessionId;
                return (
                  <div
                    key={p.sessionId}
                    className={`rounded-xl border p-3 ${
                      p.ready
                        ? 'border-emerald-400/50 bg-emerald-500/8'
                        : `${np.borderClass} ${np.bgClass}`
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 text-sm font-bold"
                          style={{ backgroundColor: `${av.accent}22`, color: av.accent }}
                        >
                          {av.glyph}
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <button
                              type="button"
                              disabled={!p.playerId}
                              onClick={() => {
                                if (p.playerId) {
                                  soundEngine.playUiClick();
                                  openProgressionModal('profile', p.playerId);
                                }
                              }}
                              className="truncate text-start text-xs font-bold text-white hover:underline disabled:no-underline cursor-pointer disabled:cursor-default"
                            >
                              {p.displayName} {isYou ? `(${t('common.you')})` : ''}
                            </button>
                            {badge && (
                              <span
                                className={`inline-flex items-center gap-0.5 rounded border px-1 py-0.2 text-[9px] font-extrabold shrink-0 ${badge.className}`}
                              >
                                {badge.glyph} {badge.shortLabel}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {p.sessionId === onlineRoom.hostSessionId
                              ? t('common.host')
                              : t('common.challenger')}{' '}
                            ·{' '}
                            {p.connected
                              ? t('lobby.latencyMs', { ms: p.latencyMs })
                              : t('common.offline')}
                            {p.playerId ? ` · ${t('lobby.viewStats')}` : ''}
                          </div>
                        </div>
                      </div>

                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider shrink-0 ${
                          p.ready
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                            : 'bg-white/5 text-slate-400 border border-white/10'
                        }`}
                      >
                        {p.ready ? t('common.ready') : t('common.notReady')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Host Spectator Privacy & Share Link Controls */}
            {isHost && !onlineRoom.tournament && (
              <div className="rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 font-bold text-slate-200">
                    <Eye className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                    <span>{t('lobby.spectatorAccess')}</span>
                    <span dir="ltr" className="font-mono text-[10px] tabular-nums text-slate-400">
                      ({onlineRoom.spectators?.length ?? onlineRoom.spectatorCount ?? 0}/
                      {onlineRoom.maxSpectators ?? 16})
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid="toggle-allow-spectators"
                      onClick={() => {
                        soundEngine.playUiClick();
                        multiplayerManager.setRoomSpectatorSettings(
                          !onlineRoom.allowSpectators,
                          onlineRoom.allowSpectatorChat ?? true,
                        );
                      }}
                      className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                        onlineRoom.allowSpectators
                          ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
                          : 'border-white/15 bg-white/5 text-slate-400 hover:text-white'
                      }`}
                    >
                      {onlineRoom.allowSpectators
                        ? t('lobby.spectatorsAllowed')
                        : t('lobby.spectatorsOff')}
                    </button>
                    {onlineRoom.allowSpectators && (
                      <>
                        <button
                          type="button"
                          data-testid="toggle-allow-spectator-chat"
                          onClick={() => {
                            soundEngine.playUiClick();
                            multiplayerManager.setRoomSpectatorSettings(
                              true,
                              !(onlineRoom.allowSpectatorChat ?? true),
                            );
                          }}
                          className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                            onlineRoom.allowSpectatorChat !== false
                              ? 'border-amber-400/50 bg-amber-500/15 text-amber-200'
                              : 'border-white/15 bg-white/5 text-slate-400 hover:text-white'
                          }`}
                        >
                          {onlineRoom.allowSpectatorChat !== false
                            ? t('lobby.specChatOn')
                            : t('lobby.specChatOff')}
                        </button>
                        {onlineRoom.spectatorShareToken && (
                          <button
                            type="button"
                            onClick={() => {
                              soundEngine.playUiClick();
                              const url = `${window.location.origin}${window.location.pathname}?spectate=${encodeURIComponent(onlineRoom.roomCode)}&token=${encodeURIComponent(onlineRoom.spectatorShareToken!)}`;
                              navigator.clipboard
                                ?.writeText(url)
                                .then(() => {
                                  setCopiedWatchLink(true);
                                  window.setTimeout(() => setCopiedWatchLink(false), 1800);
                                })
                                .catch(() => {});
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                          >
                            {copiedWatchLink ? (
                              <>
                                <Check className="h-3 w-3 text-emerald-400" />
                                {t('lobby.linkCopied')}
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3 text-amber-400" />
                                {t('lobby.copyWatchLink')}
                              </>
                            )}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Room Controls */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {localRoomPlayer && (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    multiplayerManager.setReady(!localRoomPlayer.ready);
                  }}
                  className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider transition-colors cursor-pointer whitespace-nowrap ${
                    localRoomPlayer.ready
                      ? 'border border-emerald-400/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                      : 'border border-amber-400/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                  }`}
                >
                  <UserCheck className="h-4 w-4" />
                  {localRoomPlayer.ready ? t('lobby.readyCancel') : t('lobby.confirmReady')}
                </button>
              )}

              {isHost && !onlineRoom.tournament && !onlineRoom.clubLeague && (
                <button
                  type="button"
                  disabled={!bothReady}
                  onClick={() => {
                    soundEngine.playUiClick();
                    multiplayerManager.startRoomMatch();
                  }}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Play className="h-4 w-4 fill-slate-950" />
                  {t('lobby.startMatchBtn')}
                </button>
              )}

              {onlineRoom.tournament ? (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    const tid = onlineRoom.tournament!.tournamentId;
                    multiplayerManager.leaveMatchOrRoom();
                    closeOnlineLobby();
                    openTournamentModal('bracket', tid);
                  }}
                  className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/5 px-3.5 py-2.5 text-xs font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {t('lobby.backToBracket')}
                </button>
              ) : onlineRoom.clubLeague ? (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    const kind = onlineRoom.clubLeague!.competitionKind;
                    multiplayerManager.leaveMatchOrRoom();
                    closeOnlineLobby();
                    useGameStore
                      .getState()
                      .openClubLeagueModal(kind === 'league' ? 'leagues' : 'championships');
                  }}
                  className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/5 px-3.5 py-2.5 text-xs font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {t('lobby.backToClubComp')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    if (isHost) {
                      multiplayerManager.cancelRoom();
                    } else {
                      multiplayerManager.leaveMatchOrRoom();
                    }
                  }}
                  className="inline-flex items-center justify-center rounded-xl border border-rose-500/35 bg-rose-500/10 px-3.5 py-2.5 text-xs font-bold text-rose-200 hover:bg-rose-500/20 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {isHost ? t('lobby.cancelRoom') : t('lobby.leaveRoomBtn')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Navigation Tabs */}
            <div className="mt-4 grid grid-cols-3 sm:grid-cols-6 gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
              {(
                [
                  { id: 'ranked', label: t('lobby.tabRanked'), icon: Swords },
                  { id: 'quick', label: t('lobby.tabShortQuick'), icon: Search },
                  { id: 'create', label: t('lobby.tabShortPrivate'), icon: PlusCircle },
                  { id: 'join', label: t('lobby.tabShortJoinCode'), icon: KeyRound },
                  { id: 'spectate', label: t('lobby.tabSpectate'), icon: Eye },
                  { id: 'history', label: t('lobby.tabHistory'), icon: History },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id || (tab.id === 'create' && activeTab === 'friend');
                return (
                  <button
                    key={tab.id}
                    type="button"
                    data-testid={`lobby-tab-${tab.id}`}
                    onClick={() => {
                      soundEngine.playUiClick();
                      setActiveTab(tab.id);
                      if (tab.id !== 'history') {
                        setOnlineModeIntent(tab.id);
                      }
                      if (tab.id === 'ranked' && !onlineMatchmaking.active) {
                        setRuleProfileId(RANKED_MATCHMAKING_CONFIG.defaultRuleProfile);
                      }
                    }}
                    className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-amber-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="hidden sm:inline">{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Fair Play Account Restriction Notice */}
            {moderationStatus && (!moderationStatus.canPlayOnline || !moderationStatus.canPlayRanked) && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
                <div className="flex items-center gap-2 min-w-0">
                  <ShieldAlert className="h-4 w-4 text-rose-400 shrink-0" />
                  <span className="min-w-0">
                    {!moderationStatus.canPlayOnline
                      ? t('lobby.accountSuspensionNotice')
                      : t('lobby.rankedRestrictedNotice')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    closeOnlineLobby();
                    openProgressionModal('fairplay');
                  }}
                  className="rounded-lg border border-rose-400/40 bg-rose-500/20 px-2.5 py-1 text-[11px] font-bold text-rose-100 hover:bg-rose-500/30 cursor-pointer whitespace-nowrap"
                >
                  {t('lobby.fairPlayAppealBtn')}
                </button>
              </div>
            )}

            {/* Rule Profile Selector for Ranked, Quick Match & Create Room */}
            {(activeTab === 'ranked' || activeTab === 'quick' || activeTab === 'create' || activeTab === 'friend') && (
              <div className="mt-3.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={onlineMatchmaking.active}
                  onClick={() => {
                    soundEngine.playUiClick();
                    setRuleProfileId('casual');
                  }}
                  className={`rounded-xl border px-3 py-2 text-start transition-colors cursor-pointer disabled:opacity-50 ${
                    ruleProfileId === 'casual'
                      ? 'border-amber-400/70 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs font-bold">{t('lobby.ruleCasualShortTitle')}</div>
                  <div className="text-[10px] text-slate-400">{t('lobby.ruleCasualSub')}</div>
                </button>
                <button
                  type="button"
                  disabled={onlineMatchmaking.active}
                  onClick={() => {
                    soundEngine.playUiClick();
                    setRuleProfileId('wpa');
                  }}
                  className={`rounded-xl border px-3 py-2 text-start transition-colors cursor-pointer disabled:opacity-50 ${
                    ruleProfileId === 'wpa'
                      ? 'border-amber-400/70 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs font-bold">{t('lobby.ruleWpaShortTitle')}</div>
                  <div className="text-[10px] text-slate-400">{t('lobby.ruleWpaSub')}</div>
                </button>
              </div>
            )}

            {/* Ranked Competitive Queue Panel */}
            {activeTab === 'ranked' && (
              <div className="mt-4 space-y-3 rounded-xl border border-amber-400/25 bg-black/25 p-4">
                {activeSeason && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2.5 text-[11px]">
                    <div className="font-bold text-amber-300">
                      {
                        localizeSeasonNameAndTheme(
                          activeSeason.seasonNumber,
                          activeSeason.name,
                          '',
                          language,
                        ).name
                      }
                    </div>
                    <div className="font-mono tabular-nums text-slate-400">
                      {formatSeasonRemaining(activeSeason.endsAtMs, nowMs, language)}
                    </div>
                  </div>
                )}

                {ownProfile && (
                  <RankProgressCard
                    elo={ownProfile.elo}
                    peakElo={ownProfile.peakElo}
                    seasonName={ownProfile.seasonStanding?.seasonName}
                    seasonElo={ownProfile.seasonStanding?.seasonElo}
                  />
                )}

                {onlineMatchmaking.active && onlineMatchmaking.mode === 'ranked' ? (
                  <div className="flex flex-col items-center text-center gap-2.5 py-2">
                    <div className="inline-flex items-center gap-2 text-xs font-bold text-amber-300">
                      <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                      {t('lobby.searchingRankedSec', { sec: searchElapsedSec })}
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2 font-mono tabular-nums text-[11px] text-slate-300">
                      <span>
                        {localizeRankTierName(
                          getRankForElo(onlineMatchmaking.elo ?? ownProfile?.elo ?? 1200).id,
                          language,
                          getRankForElo(onlineMatchmaking.elo ?? ownProfile?.elo ?? 1200).name,
                        )}{' '}
                        ({formatLocalizedNumber(onlineMatchmaking.elo ?? ownProfile?.elo ?? 1200, language)}{' '}
                        {t('common.elo')})
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {t('lobby.eloSpreadLabel', {
                          spread: onlineMatchmaking.eloSpread ?? RANKED_MATCHMAKING_CONFIG.initialEloSpread,
                        })}
                      </span>
                      {onlineMatchmaking.region && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{t('lobby.regionLabel', { region: onlineMatchmaking.region })}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>
                        {t('lobby.estWaitValue', {
                          wait:
                            onlineMatchmaking.estimatedWaitSec !== null
                              ? `~${onlineMatchmaking.estimatedWaitSec}s`
                              : t('lobby.calculating'),
                        })}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      {t('lobby.rankedProgressionHint')}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        multiplayerManager.cancelMatchmaking();
                      }}
                      className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer"
                    >
                      {t('lobby.cancelSearchBtn')}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {onlineMatchmaking.timedOutMessage && (
                      <div className="rounded-lg border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        {localizeServerError(onlineMatchmaking.timedOutMessage, language)}
                      </div>
                    )}
                    <p className="text-xs text-slate-300 leading-relaxed">
                      {t('lobby.rankedQueueLongDesc')}
                    </p>
                    <button
                      type="button"
                      data-testid="find-ranked-match-btn"
                      disabled={
                        !isConnected ||
                        (moderationStatus !== null &&
                          (!moderationStatus.canPlayOnline || !moderationStatus.canPlayRanked))
                      }
                      onClick={() => {
                        soundEngine.playUiClick();
                        commitProfile(nameInput);
                        multiplayerManager.startRankedMatch(ruleProfileId, calledShotsEnabled);
                      }}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      {isConnected ? (
                        <>
                          <Swords className="h-4 w-4" />
                          {t('lobby.findRankedMatchBtn')}
                        </>
                      ) : (
                        <>
                          <WifiOff className="h-4 w-4" />
                          {t('lobby.connectingToServer')}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Quick Match Panel */}
            {activeTab === 'quick' && (
              <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/25 p-4">
                {onlineMatchmaking.active && onlineMatchmaking.mode === 'quick' ? (
                  <div className="flex flex-col items-center text-center gap-2.5 py-2">
                    <div className="inline-flex items-center gap-2 text-xs font-bold text-amber-300">
                      <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                      {t('lobby.searchingQuickSec', { sec: searchElapsedSec })}
                    </div>
                    <p className="text-[11px] text-slate-400">
                      {t('lobby.searchingQuickDesc')}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        multiplayerManager.cancelQuickMatch();
                      }}
                      className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer"
                    >
                      {t('lobby.cancelSearchBtn')}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {onlineMatchmaking.timedOutMessage && (
                      <div className="rounded-lg border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        {localizeServerError(onlineMatchmaking.timedOutMessage, language)}
                      </div>
                    )}
                    <p className="text-xs text-slate-300 leading-relaxed">
                      {t('lobby.quickQueueLongDesc')}
                    </p>
                    <button
                      type="button"
                      disabled={
                        !isConnected ||
                        (moderationStatus !== null && !moderationStatus.canPlayOnline)
                      }
                      onClick={() => {
                        soundEngine.playUiClick();
                        commitProfile(nameInput);
                        multiplayerManager.startQuickMatch(ruleProfileId, calledShotsEnabled);
                      }}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-45 transition-colors cursor-pointer"
                    >
                      {isConnected ? (
                        <>
                          <Wifi className="h-4 w-4" />
                          {t('lobby.findQuickMatchBtn')}
                        </>
                      ) : (
                        <>
                          <WifiOff className="h-4 w-4" />
                          {t('lobby.connectingToServer')}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}

            {(activeTab === 'create' || activeTab === 'friend') && (
              <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/25 p-4">
                <div className="flex items-start gap-2.5 text-xs text-slate-300">
                  <Users className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">
                    {t('lobby.privateRoomLongDesc')}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!isConnected}
                  onClick={() => {
                    soundEngine.playUiClick();
                    commitProfile(nameInput);
                    multiplayerManager.createPrivateRoom(ruleProfileId, calledShotsEnabled);
                  }}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {isConnected ? (
                    <>
                      <PlusCircle className="h-4 w-4" />
                      {t('lobby.createRoomBtn')}
                    </>
                  ) : (
                    <>
                      <WifiOff className="h-4 w-4" />
                      {t('lobby.connectingToServer')}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    openSocialModal('friends');
                  }}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
                >
                  <Swords className="h-3.5 w-3.5 text-amber-400" />
                  {t('lobby.inviteFriendDirectly', { count: friends.length })}
                </button>
              </div>
            )}

            {activeTab === 'join' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  soundEngine.playUiClick();
                  commitProfile(nameInput);
                  multiplayerManager.joinRoom(joinCodeInput);
                }}
                className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/25 p-4"
              >
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                    {t('lobby.enterCodeLabel')}
                  </label>
                  <input
                    dir="ltr"
                    type="text"
                    maxLength={8}
                    value={joinCodeInput}
                    onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                    placeholder={t('lobby.joinCodePlaceholder')}
                    className="w-full rounded-xl border border-white/15 bg-[#0b1017] px-3.5 py-2.5 font-mono text-base font-extrabold tracking-[0.25em] text-white uppercase placeholder:tracking-normal placeholder:font-sans placeholder:text-xs placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!isConnected || joinCodeInput.trim().length < 4}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {isConnected ? (
                    <>
                      <KeyRound className="h-4 w-4" />
                      {t('lobby.joinPrivateBtn')}
                    </>
                  ) : (
                    <>
                      <WifiOff className="h-4 w-4" />
                      {t('lobby.connectingToServer')}
                    </>
                  )}
                </button>
              </form>
            )}

            {activeTab === 'spectate' && (
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
                    {(
                      [
                        { id: 'all', label: t('lobby.spectateFilterAll') },
                        { id: 'quick', label: t('lobby.tabShortQuick') },
                        { id: 'ranked', label: t('lobby.spectateFilterRanked') },
                        { id: 'tournament', label: t('lobby.tabShortTournament') },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          setSpectateMatchFilter(f.id);
                        }}
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                          spectateMatchFilter === f.id
                            ? 'bg-amber-500 text-slate-950'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    data-testid="refresh-spectate-btn"
                    onClick={() => {
                      soundEngine.playUiClick();
                      void multiplayerManager.fetchSpectatableMatches({
                        matchType: spectateMatchFilter,
                      });
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${spectatableMatchesLoading ? 'animate-spin' : ''}`}
                    />
                    {t('common.refresh')}
                  </button>
                </div>

                {/* Watch by Room Code */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!spectateCodeInput.trim()) return;
                    soundEngine.playUiClick();
                    void multiplayerManager.joinSpectate({
                      roomCode: spectateCodeInput.trim().toUpperCase(),
                      returnTarget: 'lobby',
                    });
                  }}
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/25 p-2.5"
                >
                  <input
                    dir="ltr"
                    type="text"
                    maxLength={8}
                    value={spectateCodeInput}
                    onChange={(e) => setSpectateCodeInput(e.target.value.toUpperCase())}
                    placeholder={t('lobby.spectateCodePlaceholder')}
                    className="min-w-0 flex-1 rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 font-mono text-xs uppercase text-white placeholder:normal-case placeholder:font-sans placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={spectateCodeInput.trim().length < 4}
                    className="inline-flex items-center gap-1 rounded-lg border border-amber-400/45 bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {t('lobby.spectateWatchCodeBtn')}
                  </button>
                </form>

                {/* Public Live Matches List */}
                <div className="space-y-2 rounded-xl border border-white/10 bg-black/25 p-3 max-h-[260px] overflow-y-auto">
                  {spectatableMatchesLoading && spectatableMatches.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-400">
                      {t('lobby.scanningBroadcasts')}
                    </div>
                  ) : spectatableMatches.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-400">
                      {t('lobby.spectateEmptyLong')}
                    </div>
                  ) : (
                    spectatableMatches.map((m) => {
                      const p1 = m.players[0];
                      const p2 = m.players[1];
                      const p1Av = p1 ? getAvatarVisualMeta(p1.avatarId) : null;
                      const p2Av = p2 ? getAvatarVisualMeta(p2.avatarId) : null;
                      return (
                        <div
                          key={m.roomId}
                          data-testid={`spectatable-match-${m.roomId}`}
                          className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-white/10 bg-[#101924] px-3 py-2.5 text-xs"
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider">
                              <span className="text-emerald-300">
                                {m.status === 'playing'
                                  ? t('lobby.statusLiveBroadcast')
                                  : m.status === 'ready'
                                    ? t('lobby.statusMatchReady')
                                    : t('lobby.statusWaitingLobby')}
                              </span>
                              <span className="text-slate-600" aria-hidden="true">·</span>
                              <span className="text-amber-300">
                                {localizeOnlineMatchType(m.matchType, language)}
                              </span>
                              <span className="text-slate-600" aria-hidden="true">·</span>
                              <span className="text-slate-400">
                                {localizeRuleProfile(m.calledShotsEnabled ? 'wpa' : 'casual', language, true)}
                              </span>
                              {m.tournament && (
                                <>
                                  <span className="text-slate-600" aria-hidden="true">·</span>
                                  <span className="text-amber-200 truncate max-w-[160px]">
                                    {m.tournament.tournamentTitle} (
                                    {localizeTournamentRoundLabel(m.tournament.roundLabel, language)})
                                  </span>
                                </>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-white">
                              <span className="inline-flex items-center gap-1.5 min-w-0">
                                {p1Av && (
                                  <span
                                    className="inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold"
                                    style={{ backgroundColor: `${p1Av.accent}22`, color: p1Av.accent }}
                                  >
                                    {p1Av.glyph}
                                  </span>
                                )}
                                <span className="truncate max-w-[110px]">
                                  {p1?.displayName
                                    ? localizePlayerName(p1.displayName, 'player1', language)
                                    : t('common.player1')}
                                </span>
                                {p1 && (
                                  <span className="font-mono text-[10px] tabular-nums text-slate-400">
                                    {p1.elo}
                                  </span>
                                )}
                              </span>
                              <span className="text-slate-500 text-[10px]">{t('common.vs')}</span>
                              <span className="inline-flex items-center gap-1.5 min-w-0">
                                {p2Av && (
                                  <span
                                    className="inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold"
                                    style={{ backgroundColor: `${p2Av.accent}22`, color: p2Av.accent }}
                                  >
                                    {p2Av.glyph}
                                  </span>
                                )}
                                <span className="truncate max-w-[110px]">
                                  {p2?.displayName
                                    ? localizePlayerName(p2.displayName, 'player2', language)
                                    : t('common.waiting')}
                                </span>
                                {p2 && (
                                  <span className="font-mono text-[10px] tabular-nums text-slate-400">
                                    {p2.elo}
                                  </span>
                                )}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-mono text-[10px] tabular-nums text-slate-400">
                              {t('lobby.watchingRatio', {
                                count: m.spectatorCount,
                                max: m.maxSpectators,
                              })}
                            </span>
                            <button
                              type="button"
                              data-testid={`watch-match-btn-${m.roomId}`}
                              onClick={() => {
                                soundEngine.playUiClick();
                                void multiplayerManager.joinSpectate({
                                  roomId: m.roomId,
                                  returnTarget: 'lobby',
                                });
                              }}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              {t('lobby.spectateWatchLiveBtn')}
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {activeTab === 'history' && (
              <div className="mt-4 space-y-2 rounded-xl border border-white/10 bg-black/25 p-3 max-h-[260px] overflow-y-auto">
                {onlineHistory.length === 0 ? (
                  <div className="py-6 text-center text-xs text-slate-400">
                    {t('lobby.historyEmpty')}
                  </div>
                ) : (
                  onlineHistory.map((rec) => (
                    <div
                      key={rec.matchId}
                      className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-white truncate">
                          {localizePlayerName(rec.player1Name, 'player1', language)} {t('common.vs')}{' '}
                          {localizePlayerName(rec.player2Name, 'player2', language)}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          {t('lobby.historyWinnerPrefix')}{' '}
                          <span className="text-amber-300 font-semibold">
                            {localizePlayerName(rec.winnerName, null, language)}
                          </span>{' '}
                          · {localizeFoulOrReason(rec.reason, language) ?? rec.reason}
                        </div>
                      </div>
                      <span className="font-mono text-[10px] text-slate-400 shrink-0">
                        {t('lobby.historyShotsShort', { count: rec.totalShots })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
