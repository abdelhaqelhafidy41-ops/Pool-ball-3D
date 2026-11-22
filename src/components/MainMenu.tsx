import {
  Award,
  BarChart3,
  Calendar,
  Coins,
  Cpu,
  Crown,
  Eye,
  Globe,
  History,
  KeyRound,
  Maximize2,
  Minimize2,
  Play,
  PlusCircle,
  Search,
  Settings,
  Shield,
  ShoppingBag,
  Swords,
  Target,
  Trophy,
  User,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect } from 'react';
import { computeAverageBallsPerTurn } from '../game/rules/MatchStatistics';
import type { AiDifficulty } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import {
  localizeAiDifficulty,
  localizePlayerName,
  localizePresence,
  useTranslation,
} from '../i18n';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { progressionClient } from '../multiplayer/ProgressionClient';
import {
  getAvatarVisualMeta,
  getBadgeVisualMeta,
  getNameplateVisualClass,
} from '../multiplayer/shared/economy';
import type { OnlineModeIntent } from '../multiplayer/shared/protocol';
import { useGameStore } from '../store/useGameStore';
import { FpsCounter } from './FpsCounter';
import { RankBadge } from './RankBadge';
import { presenceDotClass } from './SocialModal';

interface MainMenuProps {
  onStartMatch: () => void;
  onToggleFullscreen: () => void;
}

export function MainMenu({ onStartMatch, onToggleFullscreen }: MainMenuProps) {
  const { t, lang, setLanguage, formatNumber } = useTranslation();

  const screen = useGameStore((s) => s.screen);
  const setSettingsOpen = useGameStore((s) => s.setSettingsOpen);
  const soundEnabled = useGameStore((s) => s.soundEnabled);
  const toggleSound = useGameStore((s) => s.toggleSound);
  const isFullscreen = useGameStore((s) => s.isFullscreen);

  const matchConfig = useGameStore((s) => s.matchConfig);
  const updateMatchConfig = useGameStore((s) => s.updateMatchConfig);
  const matchStats = useGameStore((s) => s.matchStats);
  const openOnlineLobby = useGameStore((s) => s.openOnlineLobby);
  const ownProfile = useGameStore((s) => s.ownProfile);
  const onlineProfile = useGameStore((s) => s.onlineProfile);
  const openProgressionModal = useGameStore((s) => s.openProgressionModal);
  const openSocialModal = useGameStore((s) => s.openSocialModal);
  const selfPresence = useGameStore((s) => s.selfPresence);
  const friends = useGameStore((s) => s.friends);
  const incomingRequests = useGameStore((s) => s.incomingRequests);
  const incomingInvitations = useGameStore((s) => s.incomingInvitations);
  const incomingClubInvitations = useGameStore((s) => s.incomingClubInvitations);
  const unreadNotificationCount = useGameStore((s) => s.unreadNotificationCount);
  const myClub = useGameStore((s) => s.myClub);
  const totalUnreadDmCount = useGameStore((s) => s.totalUnreadDmCount);
  const wallet = useGameStore((s) => s.wallet);
  const equippedCosmetics = useGameStore((s) => s.equippedCosmetics);
  const dailyReward = useGameStore((s) => s.dailyReward);
  const openStoreModal = useGameStore((s) => s.openStoreModal);
  const openTournamentModal = useGameStore((s) => s.openTournamentModal);
  const openClubLeagueModal = useGameStore((s) => s.openClubLeagueModal);
  const battlePassOverview = useGameStore((s) => s.battlePassOverview);
  const openBattlePassModal = useGameStore((s) => s.openBattlePassModal);

  useEffect(() => {
    if (screen === 'menu' && !ownProfile) {
      void progressionClient.ensurePlayerSession();
    }
  }, [screen, ownProfile]);

  if (screen !== 'menu') return null;

  const handlePlay = () => {
    soundEngine.unlock();
    soundEngine.playUiClick();
    if (matchConfig.opponentType === 'online') {
      updateMatchConfig({ opponentType: 'pvp' });
    }
    onStartMatch();
  };

  const handleOpenOnline = (intent: OnlineModeIntent) => {
    soundEngine.unlock();
    soundEngine.playUiClick();
    multiplayerManager.ensureConnected();
    openOnlineLobby(intent);
  };

  const handleSettings = () => {
    soundEngine.unlock();
    soundEngine.playUiClick();
    setSettingsOpen(true);
  };

  const isEightBall = matchConfig.gameMode === 'eightBall';
  const avgBalls = computeAverageBallsPerTurn(matchStats);
  const activeAiMeta = localizeAiDifficulty(matchConfig.aiDifficulty, lang);

  const p1InputDisplay =
    matchConfig.player1Name === 'Player 1' || matchConfig.player1Name === 'اللاعب ١'
      ? localizePlayerName(matchConfig.player1Name, 'player1', lang)
      : matchConfig.player1Name;
  const p2InputDisplay = localizePlayerName(matchConfig.player2Name, 'player2', lang);

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-4 sm:p-8 overflow-y-auto">
      {/* Top Row: Championship Match Setup Lockup + Quick Utility Controls */}
      <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-start justify-between gap-3 sm:gap-4">
        <div className="pointer-events-auto rounded-2xl border border-white/10 bg-[#0b1016]/90 px-4 sm:px-5 py-4 shadow-2xl w-full max-w-md">
          <div className="flex items-center gap-3.5">
            {/* Bespoke inline SVG 8-ball crest */}
            <svg
              width="44"
              height="44"
              viewBox="0 0 44 44"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="shrink-0"
              aria-hidden="true"
            >
              <defs>
                <radialGradient id="ballGrad" cx="35%" cy="30%" r="68%">
                  <stop offset="0%" stopColor="#3c4252" />
                  <stop offset="55%" stopColor="#14171f" />
                  <stop offset="100%" stopColor="#080a0e" />
                </radialGradient>
              </defs>
              <circle cx="22" cy="22" r="20" fill="url(#ballGrad)" stroke="#e2b857" strokeWidth="1.75" />
              <circle cx="22" cy="22" r="9.5" fill="#f5f1e3" />
              <text
                x="22"
                y="26"
                textAnchor="middle"
                fill="#111318"
                fontSize="12.5"
                fontWeight="800"
                fontFamily="system-ui, sans-serif"
              >
                8
              </text>
            </svg>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-400">
                {t('menu.subtitle')}
              </p>
              <h1 dir="ltr" className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white leading-tight text-start">
                ULTIMATE POOL <span className="text-amber-400">3D</span>
              </h1>
            </div>
          </div>

          {/* Game Mode Switcher */}
          <div className="mt-4 grid grid-cols-2 gap-1.5 rounded-xl border border-white/10 bg-black/35 p-1">
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                updateMatchConfig({ gameMode: 'eightBall' });
              }}
              className={`rounded-lg py-1.5 text-xs font-extrabold tracking-wider uppercase transition-colors cursor-pointer whitespace-nowrap ${
                isEightBall
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              {t('menu.formatEightBall')}
            </button>
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                updateMatchConfig({ gameMode: 'freePlay' });
              }}
              className={`rounded-lg py-1.5 text-xs font-extrabold tracking-wider uppercase transition-colors cursor-pointer whitespace-nowrap ${
                !isEightBall
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              {t('menu.formatFreePlay')}
            </button>
          </div>

          {isEightBall && (
            <div className="mt-3 space-y-2.5">
              {/* Opponent Type: Local PvP vs AI */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ opponentType: 'pvp' });
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    matchConfig.opponentType === 'pvp'
                      ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <Users className="h-3.5 w-3.5" />
                  {t('menu.modeLocal')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ opponentType: 'ai' });
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    matchConfig.opponentType === 'ai'
                      ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <Cpu className="h-3.5 w-3.5" />
                  {t('menu.modeAi')}
                </button>
              </div>

              {/* AI Difficulty Selector */}
              {matchConfig.opponentType === 'ai' && (
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 shrink-0">
                      {t('menu.aiDifficultyLabel')}
                    </span>
                    <span className="text-[10px] font-medium text-amber-300 truncate max-w-[220px]">
                      {activeAiMeta.tagline.split(' · ')[0]}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(['beginner', 'intermediate', 'pro', 'legend'] as AiDifficulty[]).map((lvl) => {
                      const active = matchConfig.aiDifficulty === lvl;
                      const prof = localizeAiDifficulty(lvl, lang);
                      return (
                        <button
                          key={lvl}
                          type="button"
                          onClick={() => {
                            soundEngine.playUiClick();
                            updateMatchConfig({ aiDifficulty: lvl });
                          }}
                          className={`rounded-lg border px-1.5 py-1.5 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                            active
                              ? 'border-amber-400 bg-amber-500 text-slate-950'
                              : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                          }`}
                        >
                          {prof.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Player Names */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                    {t('menu.player1NameLabel')}
                  </label>
                  <input
                    type="text"
                    maxLength={16}
                    value={p1InputDisplay}
                    onChange={(e) => updateMatchConfig({ player1Name: e.target.value })}
                    className="w-full rounded-lg border border-white/12 bg-black/40 px-2.5 py-1.5 text-xs font-medium text-white focus:border-amber-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                    {matchConfig.opponentType === 'ai'
                      ? t('menu.aiOpponentNameLabel')
                      : t('menu.player2NameLabel')}
                  </label>
                  <input
                    type="text"
                    maxLength={16}
                    value={p2InputDisplay}
                    onChange={(e) => updateMatchConfig({ player2Name: e.target.value })}
                    className="w-full rounded-lg border border-white/12 bg-black/40 px-2.5 py-1.5 text-xs font-medium text-white focus:border-amber-400 focus:outline-none"
                  />
                </div>
              </div>

              {/* Rule Profile Selector */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ ruleProfileId: 'casual', calledShotsEnabled: false });
                  }}
                  className={`rounded-xl border px-2.5 py-1.5 text-start transition-colors cursor-pointer ${
                    matchConfig.ruleProfileId === 'casual'
                      ? 'border-amber-400/70 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-[11px] font-bold">{t('menu.ruleCasual')}</div>
                  <div className="text-[10px] text-slate-400">{t('menu.ruleCasualShortDesc')}</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ ruleProfileId: 'wpa', calledShotsEnabled: true });
                  }}
                  className={`rounded-xl border px-2.5 py-1.5 text-start transition-colors cursor-pointer ${
                    matchConfig.ruleProfileId === 'wpa'
                      ? 'border-amber-400/70 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-[11px] font-bold">{t('menu.ruleWpa')}</div>
                  <div className="text-[10px] text-slate-400">{t('menu.ruleWpaShortDesc')}</div>
                </button>
              </div>
            </div>
          )}

          {/* Compact Career Stats Strip */}
          {matchStats.totalShots > 0 && (
            <div className="mt-3 flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-1.5 text-[10px] font-mono tabular-nums text-slate-300">
              <span className="inline-flex items-center gap-1 text-amber-300 font-bold">
                <Trophy className="h-3 w-3" />
                {t('menu.statsWinsLosses', {
                  wins: formatNumber(matchStats.wins),
                  losses: formatNumber(matchStats.losses),
                })}
              </span>
              <span>{t('menu.statsShotsShort', { count: formatNumber(matchStats.totalShots) })}</span>
              <span>{t('menu.statsPocketsShort', { count: formatNumber(matchStats.ballsPocketed) })}</span>
              <span>{t('menu.statsAvgShort', { avg: avgBalls.toFixed(1) })}</span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              data-testid="start-match-btn"
              onClick={handlePlay}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-extrabold tracking-wide text-slate-950 shadow-lg hover:bg-amber-400 active:scale-[0.98] transition-all cursor-pointer whitespace-nowrap"
            >
              <Play className="h-4 w-4 fill-slate-950" />
              {isEightBall ? t('menu.startMatchButton') : t('menu.startFreePlayButton')}
            </button>
            <button
              type="button"
              data-testid="open-settings-btn"
              onClick={handleSettings}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Settings className="h-4 w-4 text-amber-400" />
              {t('menu.settingsButton')}
            </button>
          </div>

          {/* Online Multiplayer Section */}
          <div className="mt-3.5 pt-3 border-t border-white/10">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-400">
                {t('menu.onlineSectionTitle')}
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  data-testid="menu-watch-live-btn"
                  onClick={() => handleOpenOnline('spectate')}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-300 hover:text-amber-200 cursor-pointer whitespace-nowrap"
                >
                  <Eye className="h-3 w-3" />
                  {t('menu.watchLiveButton')}
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenOnline('quick')}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-300 hover:text-emerald-200 cursor-pointer whitespace-nowrap"
                >
                  <Globe className="h-3 w-3" />
                  {t('menu.playOnlineButton')}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                data-testid="open-ranked-btn"
                onClick={() => handleOpenOnline('ranked')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-amber-400/45 bg-amber-500/15 px-2.5 py-2 text-[11px] font-extrabold text-amber-200 hover:bg-amber-500/25 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Swords className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                {t('menu.rankedMatchButton')}
              </button>
              <button
                type="button"
                data-testid="open-quick-online-btn"
                onClick={() => handleOpenOnline('quick')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-emerald-400/35 bg-emerald-500/10 px-2.5 py-2 text-[11px] font-bold text-emerald-200 hover:bg-emerald-500/20 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Search className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                {t('menu.quickMatchButton')}
              </button>
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => handleOpenOnline('create')}
                className="inline-flex items-center justify-center gap-1 rounded-xl border border-white/12 bg-white/5 px-2 py-2 text-[11px] font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <PlusCircle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                {t('menu.createRoomButton')}
              </button>
              <button
                type="button"
                onClick={() => handleOpenOnline('join')}
                className="inline-flex items-center justify-center gap-1 rounded-xl border border-white/12 bg-white/5 px-2 py-2 text-[11px] font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <KeyRound className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                {t('menu.joinRoomButton')}
              </button>
              <button
                type="button"
                onClick={() => handleOpenOnline('friend')}
                className="inline-flex items-center justify-center gap-1 rounded-xl border border-white/12 bg-white/5 px-2 py-2 text-[11px] font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <UserPlus className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                {t('menu.playFriendButton')}
              </button>
            </div>

            {/* Competitive Identity, Progression & Economy Strip */}
            {(() => {
              const activeAvatarId =
                ownProfile?.avatarId ?? equippedCosmetics.avatarId ?? onlineProfile.avatarId;
              const av = getAvatarVisualMeta(activeAvatarId);
              const nameplateStyle = getNameplateVisualClass(equippedCosmetics.nameplateId);
              const badgeMeta = getBadgeVisualMeta(equippedCosmetics.badgeId);
              const displayName = ownProfile?.displayName ?? onlineProfile.displayName;
              const elo = ownProfile?.elo ?? 1200;
              const level = ownProfile?.level ?? 1;
              const xpRatio = ownProfile ? Math.round(ownProfile.levelProgress.progressRatio * 100) : 0;
              const coinBalance = wallet?.balance ?? 0;

              return (
                <div
                  className={`mt-2.5 rounded-xl border p-2.5 ${nameplateStyle.borderClass} ${nameplateStyle.bgClass}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.unlock();
                        soundEngine.playUiClick();
                        openProgressionModal('profile');
                      }}
                      className="flex items-center gap-2 min-w-0 text-start hover:opacity-90 cursor-pointer"
                    >
                      <span
                        dir="ltr"
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 text-xs font-bold"
                        style={{ backgroundColor: `${av.accent}22`, color: av.accent }}
                      >
                        {av.glyph}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-extrabold text-white">
                            {displayName}
                          </span>
                          {myClub && (
                            <span
                              dir="ltr"
                              className="rounded border px-1 py-0.2 font-mono text-[9px] font-black shrink-0"
                              style={{
                                borderColor: `${myClub.emblemColor}66`,
                                backgroundColor: `${myClub.emblemColor}20`,
                                color: myClub.emblemColor,
                              }}
                            >
                              [{myClub.tag}]
                            </span>
                          )}
                          {badgeMeta && (
                            <span
                              dir="ltr"
                              className={`inline-flex items-center gap-0.5 rounded border px-1 py-0.2 text-[9px] font-extrabold shrink-0 ${badgeMeta.className}`}
                            >
                              <span>{badgeMeta.glyph}</span>
                              <span>{badgeMeta.shortLabel}</span>
                            </span>
                          )}
                          <span className="rounded border border-amber-400/35 bg-amber-500/12 px-1 py-0.2 text-[9px] font-mono font-bold text-amber-300 shrink-0">
                            {t('common.levelShort')} {formatNumber(level)}
                          </span>
                        </div>
                        <div className="mt-1 h-1 w-24 overflow-hidden rounded bg-white/10">
                          <div
                            className="h-full bg-amber-500 transition-all"
                            style={{ width: `${xpRatio}%` }}
                          />
                        </div>
                      </div>
                    </button>

                    <div className="flex flex-col items-end gap-0.5 text-end font-mono tabular-nums shrink-0">
                      <div className="flex items-center gap-1.5">
                        <RankBadge elo={elo} size="xs" />
                        <span dir="ltr" className="text-xs font-black text-amber-300">
                          {formatNumber(elo)} ELO
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {ownProfile?.rank
                          ? t('menu.globalRankBadge', { rank: formatNumber(ownProfile.rank) })
                          : t('menu.unrankedBadge')}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-4 gap-1">
                    {(
                      [
                        { id: 'profile', label: t('menu.navProfile'), icon: User },
                        { id: 'leaderboard', label: t('menu.navRanks'), icon: BarChart3 },
                        { id: 'achievements', label: t('menu.navTrophies'), icon: Award },
                        { id: 'history', label: t('menu.navHistory'), icon: History },
                      ] as const
                    ).map((btn) => {
                      const Icon = btn.icon;
                      return (
                        <button
                          key={btn.id}
                          type="button"
                          data-testid={`menu-nav-${btn.id}`}
                          onClick={() => {
                            soundEngine.unlock();
                            soundEngine.playUiClick();
                            openProgressionModal(btn.id);
                          }}
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-1.5 py-1 text-[10px] font-bold text-slate-200 hover:bg-white/12 cursor-pointer whitespace-nowrap"
                        >
                          <Icon className="h-3 w-3 text-amber-400 shrink-0" />
                          {btn.label}
                        </button>
                      );
                    })}
                  </div>

                  {(() => {
                    const socialBadge =
                      incomingRequests.length +
                      incomingInvitations.length +
                      incomingClubInvitations.length +
                      totalUnreadDmCount +
                      unreadNotificationCount;
                    return (
                      <button
                        type="button"
                        data-testid="open-social-btn"
                        onClick={() => {
                          soundEngine.unlock();
                          soundEngine.playUiClick();
                          multiplayerManager.ensureConnected();
                          openSocialModal('friends');
                        }}
                        className="mt-1.5 flex w-full items-center justify-between gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
                      >
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <Users className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                          <span className="truncate">{t('menu.friendsSocialButton')}</span>
                          <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-black/40 px-1.5 py-0.2 text-[9px] font-semibold text-slate-300 shrink-0">
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${presenceDotClass(selfPresence)}`}
                            />
                            {localizePresence(selfPresence, lang)}
                          </span>
                        </span>
                        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-slate-400 tabular-nums shrink-0">
                          {myClub && (
                            <span
                              dir="ltr"
                              className="rounded border px-1 py-0.2 text-[9px] font-bold"
                              style={{
                                borderColor: `${myClub.emblemColor}55`,
                                color: myClub.emblemColor,
                              }}
                            >
                              [{myClub.tag}]
                            </span>
                          )}
                          <span>{t('menu.friendsCountLabel', { count: friends.length })}</span>
                          {socialBadge > 0 && (
                            <span className="rounded bg-amber-500 px-1.5 py-0.2 font-black text-slate-950">
                              {formatNumber(socialBadge)}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })()}

                  {/* Store, Inventory & Daily Pool Coins Bar */}
                  <div className="mt-1.5 grid grid-cols-[1fr_auto] gap-1.5">
                    <button
                      type="button"
                      data-testid="open-store-btn"
                      onClick={() => {
                        soundEngine.unlock();
                        soundEngine.playUiClick();
                        openStoreModal('store');
                      }}
                      className="flex items-center justify-between gap-2 rounded-lg border border-amber-400/35 bg-amber-500/12 px-2.5 py-1.5 text-[11px] font-bold text-amber-100 hover:bg-amber-500/20 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <ShoppingBag className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                        <span>{t('menu.storeInventoryButton')}</span>
                      </span>
                      <span dir="ltr" className="inline-flex items-center gap-1 font-mono font-extrabold tabular-nums text-amber-300">
                        <Coins className="h-3 w-3 text-amber-400 shrink-0" />
                        {formatNumber(coinBalance)}
                      </span>
                    </button>

                    <button
                      type="button"
                      data-testid="open-daily-btn"
                      onClick={() => {
                        soundEngine.unlock();
                        soundEngine.playUiClick();
                        openStoreModal('daily');
                      }}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                        dailyReward?.canClaim
                          ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                          : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      <Calendar
                        className={`h-3.5 w-3.5 shrink-0 ${
                          dailyReward?.canClaim ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      />
                      <span>
                        {dailyReward?.canClaim
                          ? t('menu.claimDailyButton')
                          : t('menu.dailyButton')}
                      </span>
                    </button>
                  </div>

                  {/* Global Tournaments & Championships */}
                  <button
                    type="button"
                    data-testid="open-tournaments-btn"
                    onClick={() => {
                      soundEngine.unlock();
                      soundEngine.playUiClick();
                      multiplayerManager.ensureConnected();
                      openTournamentModal('discover');
                    }}
                    className="mt-1.5 flex w-full items-center justify-between gap-2 rounded-lg border border-amber-400/45 bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-extrabold text-amber-100 hover:bg-amber-500/25 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Crown className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      <span>{t('menu.globalTournamentsButton')}</span>
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                      {t('menu.competeBadge')}
                    </span>
                  </button>

                  {/* Clubs & Team Leagues */}
                  <button
                    type="button"
                    data-testid="open-clubs-leagues-btn"
                    onClick={() => {
                      soundEngine.unlock();
                      soundEngine.playUiClick();
                      multiplayerManager.ensureConnected();
                      openClubLeagueModal('club_hq');
                    }}
                    className="mt-1.5 flex w-full items-center justify-between gap-2 rounded-lg border border-emerald-400/35 bg-emerald-500/12 px-2.5 py-1.5 text-[11px] font-extrabold text-emerald-100 hover:bg-emerald-500/20 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Shield className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                      <span>{t('menu.clubsLeaguesButton')}</span>
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                      {myClub ? `[${myClub.tag}]` : t('menu.squadsBadge')}
                    </span>
                  </button>

                  {/* Seasonal Battle Pass & Daily/Weekly Missions */}
                  {(() => {
                    const bpLevel = battlePassOverview?.playerState.seasonLevel ?? 0;
                    const bpMax = battlePassOverview?.season.maxLevel ?? 30;
                    const bpTrackClaimable =
                      (battlePassOverview?.claimableCounts.battlePassFree ?? 0) +
                      (battlePassOverview?.claimableCounts.battlePassPremium ?? 0);
                    const missionClaimable =
                      (battlePassOverview?.claimableCounts.daily ?? 0) +
                      (battlePassOverview?.claimableCounts.weekly ?? 0);
                    return (
                      <div className="mt-1.5 grid grid-cols-[1fr_auto] gap-1.5">
                        <button
                          type="button"
                          data-testid="open-battle-pass-btn"
                          onClick={() => {
                            soundEngine.unlock();
                            soundEngine.playUiClick();
                            openBattlePassModal('pass');
                          }}
                          className="flex items-center justify-between gap-2 rounded-lg border border-amber-400/35 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-bold text-slate-100 hover:bg-amber-500/15 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <span className="inline-flex items-center gap-1.5 truncate">
                            <Award className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                            <span className="truncate">
                              {t('menu.battlePassLevelLabel', {
                                level: formatNumber(bpLevel),
                                max: formatNumber(bpMax),
                              })}
                            </span>
                          </span>
                          {bpTrackClaimable > 0 && (
                            <span dir="ltr" className="rounded bg-emerald-500 px-1.5 py-0.2 font-mono text-[10px] font-black tabular-nums text-slate-950 shrink-0">
                              +{formatNumber(bpTrackClaimable)}
                            </span>
                          )}
                        </button>

                        <button
                          type="button"
                          data-testid="open-missions-btn"
                          onClick={() => {
                            soundEngine.unlock();
                            soundEngine.playUiClick();
                            openBattlePassModal('daily');
                          }}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                            missionClaimable > 0
                              ? 'border-amber-400/60 bg-amber-500/18 text-amber-200 hover:bg-amber-500/28'
                              : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                          }`}
                        >
                          <Target className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                          <span>{t('menu.missionsButton')}</span>
                          {missionClaimable > 0 && (
                            <span className="rounded bg-amber-500 px-1.5 py-0.2 font-mono text-[10px] font-black tabular-nums text-slate-950">
                              {formatNumber(missionClaimable)}
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}
          </div>
        </div>

        {/* Top-Right Compact Controls + Visible Language Selector */}
        <div className="pointer-events-auto self-end sm:self-auto flex items-center gap-2 shrink-0">
          <FpsCounter />
          <div
            data-testid="menu-language-selector"
            role="group"
            aria-label={t('menu.languageSelectorLabel')}
            className="inline-flex h-9 items-center rounded-lg border border-white/15 bg-[#0d131a]/92 p-0.5 text-[11px] font-bold shadow-md"
          >
            <button
              type="button"
              data-testid="menu-lang-ar"
              onClick={() => {
                soundEngine.unlock();
                soundEngine.playUiClick();
                setLanguage('ar');
              }}
              className={`h-full rounded-md px-2.5 transition-colors cursor-pointer whitespace-nowrap ${
                lang === 'ar'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              {t('meta.switchToArabic')}
            </button>
            <button
              type="button"
              data-testid="menu-lang-en"
              onClick={() => {
                soundEngine.unlock();
                soundEngine.playUiClick();
                setLanguage('en');
              }}
              className={`h-full rounded-md px-2.5 transition-colors cursor-pointer whitespace-nowrap ${
                lang === 'en'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              {t('meta.switchToEnglish')}
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              soundEngine.unlock();
              toggleSound();
            }}
            aria-label={soundEnabled ? t('settings.muteAudio') : t('settings.unmuteAudio')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-[#0d131a]/90 text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="h-4 w-4 text-amber-400" /> : <VolumeX className="h-4 w-4 text-slate-400" />}
          </button>
          <button
            type="button"
            onClick={onToggleFullscreen}
            aria-label={isFullscreen ? t('menu.fullscreenExit') : t('menu.fullscreenEnter')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-[#0d131a]/90 text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Bottom Flat Control Hint Line */}
      <div className="flex justify-center pt-4">
        <div className="rounded-lg border border-white/10 bg-[#0b1016]/85 px-4 py-2 text-xs font-medium tracking-wide text-slate-300 text-center">
          {t('menu.controlsHintDesktop')}
        </div>
      </div>
    </div>
  );
}
