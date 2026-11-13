import {
  Award,
  BarChart3,
  Cpu,
  Globe,
  History,
  KeyRound,
  Maximize2,
  Minimize2,
  Play,
  PlusCircle,
  Search,
  Settings,
  Trophy,
  User,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect } from 'react';
import { AI_DIFFICULTY_PROFILES } from '../game/ai/AIDifficultyConfig';
import { computeAverageBallsPerTurn } from '../game/rules/MatchStatistics';
import type { AiDifficulty } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { progressionClient } from '../multiplayer/ProgressionClient';
import { ONLINE_AVATARS, type OnlineModeIntent } from '../multiplayer/shared/protocol';
import { useGameStore } from '../store/useGameStore';
import { FpsCounter } from './FpsCounter';

interface MainMenuProps {
  onStartMatch: () => void;
  onToggleFullscreen: () => void;
}

export function MainMenu({ onStartMatch, onToggleFullscreen }: MainMenuProps) {
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

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-4 sm:p-8 overflow-y-auto">
      {/* Top Row: Championship Match Setup Lockup + Quick Utility Controls */}
      <div className="flex items-start justify-between gap-4">
        <div className="pointer-events-auto rounded-2xl border border-white/10 bg-[#0b1016]/90 px-5 py-4 shadow-2xl w-full max-w-md">
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
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-400">
                Championship Simulation
              </p>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white leading-tight">
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
              8-Ball Pool
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
              Free Play
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
                  Player vs Player
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
                  Player vs AI
                </button>
              </div>

              {/* AI Difficulty Selector */}
              {matchConfig.opponentType === 'ai' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      AI Difficulty
                    </span>
                    <span className="text-[10px] font-medium text-amber-300 truncate max-w-[220px]">
                      {AI_DIFFICULTY_PROFILES[matchConfig.aiDifficulty].tagline.split(' · ')[0]}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(['beginner', 'intermediate', 'pro', 'legend'] as AiDifficulty[]).map((lvl) => {
                      const active = matchConfig.aiDifficulty === lvl;
                      const prof = AI_DIFFICULTY_PROFILES[lvl];
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
                    Player 1
                  </label>
                  <input
                    type="text"
                    maxLength={16}
                    value={matchConfig.player1Name}
                    onChange={(e) => updateMatchConfig({ player1Name: e.target.value })}
                    className="w-full rounded-lg border border-white/12 bg-black/40 px-2.5 py-1.5 text-xs font-medium text-white focus:border-amber-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                    {matchConfig.opponentType === 'ai' ? 'AI Opponent' : 'Player 2'}
                  </label>
                  <input
                    type="text"
                    maxLength={16}
                    value={matchConfig.player2Name}
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
                  className={`rounded-xl border px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                    matchConfig.ruleProfileId === 'casual'
                      ? 'border-amber-400/70 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-[11px] font-bold">Standard Casual</div>
                  <div className="text-[10px] text-slate-400">Auto pocket · Anywhere BIH</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ ruleProfileId: 'wpa', calledShotsEnabled: true });
                  }}
                  className={`rounded-xl border px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                    matchConfig.ruleProfileId === 'wpa'
                      ? 'border-amber-400/70 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-[11px] font-bold">Strict Called (WPA)</div>
                  <div className="text-[10px] text-slate-400">Call ball+pocket · Kitchen break</div>
                </button>
              </div>
            </div>
          )}

          {/* Compact Career Stats Strip */}
          {matchStats.totalShots > 0 && (
            <div className="mt-3 flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-1.5 text-[10px] font-mono tabular-nums text-slate-300">
              <span className="inline-flex items-center gap-1 text-amber-300 font-bold">
                <Trophy className="h-3 w-3" />
                {matchStats.wins}W–{matchStats.losses}L
              </span>
              <span>SHOTS {matchStats.totalShots}</span>
              <span>POCKETS {matchStats.ballsPocketed}</span>
              <span>AVG {avgBalls.toFixed(1)}</span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handlePlay}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-amber-500 px-6 py-2.5 text-sm font-extrabold tracking-wide text-slate-950 shadow-lg hover:bg-amber-400 active:scale-[0.98] transition-all cursor-pointer whitespace-nowrap"
            >
              <Play className="h-4 w-4 fill-slate-950" />
              {isEightBall ? 'START 8-BALL MATCH' : 'START FREE PLAY'}
            </button>
            <button
              type="button"
              onClick={handleSettings}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Settings className="h-4 w-4 text-amber-400" />
              Settings
            </button>
          </div>

          {/* Online Multiplayer Section */}
          <div className="mt-3.5 pt-3 border-t border-white/10">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">
                Online Multiplayer
              </span>
              <button
                type="button"
                onClick={() => handleOpenOnline('quick')}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-300 hover:text-emerald-200 cursor-pointer"
              >
                <Globe className="h-3 w-3" />
                Play Online
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => handleOpenOnline('quick')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-emerald-400/35 bg-emerald-500/10 px-2.5 py-2 text-[11px] font-bold text-emerald-200 hover:bg-emerald-500/20 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Search className="h-3.5 w-3.5 text-emerald-400" />
                Quick Match
              </button>
              <button
                type="button"
                onClick={() => handleOpenOnline('create')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-2.5 py-2 text-[11px] font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <PlusCircle className="h-3.5 w-3.5 text-amber-400" />
                Create Private Room
              </button>
              <button
                type="button"
                onClick={() => handleOpenOnline('join')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-2.5 py-2 text-[11px] font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <KeyRound className="h-3.5 w-3.5 text-amber-400" />
                Join Room
              </button>
              <button
                type="button"
                onClick={() => handleOpenOnline('friend')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-2.5 py-2 text-[11px] font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <UserPlus className="h-3.5 w-3.5 text-amber-400" />
                Play with a Friend
              </button>
            </div>

            {/* Competitive Identity & Progression Strip */}
            {(() => {
              const activeAvatarId = ownProfile?.avatarId ?? onlineProfile.avatarId;
              const av = ONLINE_AVATARS.find((a) => a.id === activeAvatarId) ?? ONLINE_AVATARS[0];
              const displayName = ownProfile?.displayName ?? onlineProfile.displayName;
              const elo = ownProfile?.elo ?? 1200;
              const level = ownProfile?.level ?? 1;
              const xpRatio = ownProfile ? Math.round(ownProfile.levelProgress.progressRatio * 100) : 0;

              return (
                <div className="mt-2.5 rounded-xl border border-white/10 bg-black/35 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.unlock();
                        soundEngine.playUiClick();
                        openProgressionModal('profile');
                      }}
                      className="flex items-center gap-2 min-w-0 text-left hover:opacity-90 cursor-pointer"
                    >
                      <span
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
                          <span className="rounded border border-amber-400/35 bg-amber-500/12 px-1 py-0.2 text-[9px] font-mono font-bold text-amber-300">
                            Lv {level}
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

                    <div className="text-right font-mono tabular-nums shrink-0">
                      <div className="text-xs font-black text-amber-300">{elo} ELO</div>
                      <div className="text-[10px] text-slate-400">
                        {ownProfile?.rank ? `Rank #${ownProfile.rank}` : 'Unranked'}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-4 gap-1">
                    {(
                      [
                        { id: 'profile', label: 'Profile', icon: User },
                        { id: 'leaderboard', label: 'Ranks', icon: BarChart3 },
                        { id: 'achievements', label: 'Trophies', icon: Award },
                        { id: 'history', label: 'History', icon: History },
                      ] as const
                    ).map((btn) => {
                      const Icon = btn.icon;
                      return (
                        <button
                          key={btn.id}
                          type="button"
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
                </div>
              );
            })()}
          </div>
        </div>

        {/* Top-Right Compact Controls */}
        <div className="pointer-events-auto flex items-center gap-2">
          <FpsCounter />
          <button
            type="button"
            onClick={() => {
              soundEngine.unlock();
              toggleSound();
            }}
            aria-label={soundEnabled ? 'Mute sound' : 'Unmute sound'}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-[#0d131a]/90 text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="h-4 w-4 text-amber-400" /> : <VolumeX className="h-4 w-4 text-slate-400" />}
          </button>
          <button
            type="button"
            onClick={onToggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-[#0d131a]/90 text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Bottom Flat Control Hint Line */}
      <div className="flex justify-center pt-4">
        <div className="rounded-lg border border-white/10 bg-[#0b1016]/85 px-4 py-2 text-xs font-medium tracking-wide text-slate-300">
          Drag Orbit · Scroll/Pinch Zoom · Tap Table or A/D Aim · Pull Cue to Shoot · R Re-Rack · Enter to Play
        </div>
      </div>
    </div>
  );
}
