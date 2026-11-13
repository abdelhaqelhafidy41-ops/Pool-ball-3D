import { Cpu, RotateCcw, Trash2, Users, Volume2, VolumeX, X } from 'lucide-react';
import { AI_DIFFICULTY_PROFILES } from '../game/ai/AIDifficultyConfig';
import { computeAverageBallsPerTurn } from '../game/rules/MatchStatistics';
import type { AiDifficulty, AiThinkingSpeed } from '../game/rules/types';
import { FELT_PALETTES } from '../game/utils/constants';
import { soundEngine } from '../game/utils/SoundEngine';
import { useGameStore, type FeltTheme } from '../store/useGameStore';

interface SettingsModalProps {
  onRestartMatch: () => void;
  onResetAllStats: () => void;
}

export function SettingsModal({ onRestartMatch, onResetAllStats }: SettingsModalProps) {
  const settingsOpen = useGameStore((s) => s.settingsOpen);
  const setSettingsOpen = useGameStore((s) => s.setSettingsOpen);
  const soundEnabled = useGameStore((s) => s.soundEnabled);
  const soundVolume = useGameStore((s) => s.soundVolume);
  const toggleSound = useGameStore((s) => s.toggleSound);
  const setSoundVolume = useGameStore((s) => s.setSoundVolume);
  const settings = useGameStore((s) => s.settings);
  const updateSettings = useGameStore((s) => s.updateSettings);

  const screen = useGameStore((s) => s.screen);
  const matchConfig = useGameStore((s) => s.matchConfig);
  const updateMatchConfig = useGameStore((s) => s.updateMatchConfig);
  const matchStats = useGameStore((s) => s.matchStats);

  if (!settingsOpen) return null;

  const close = () => {
    soundEngine.playUiClick();
    setSettingsOpen(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/65 p-4">
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-white/15 bg-[#0f161f] p-5 sm:p-6 shadow-2xl text-slate-100">
        <div className="flex items-center justify-between border-b border-white/10 pb-3.5">
          <div>
            <h2 className="text-lg font-bold tracking-wide text-white">Game & Match Settings</h2>
            <p className="text-xs text-slate-400">Rules, table finish, camera & audio</p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close settings"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-5">
          {/* Match Rules Section (locked during active online match) */}
          {!(screen === 'playing' && matchConfig.opponentType === 'online') && (
            <div className="space-y-2.5">
              <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                8-Ball Match Rules
              </span>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ ruleProfileId: 'casual', calledShotsEnabled: false });
                  }}
                  className={`rounded-xl border px-3 py-2 text-left transition-colors cursor-pointer ${
                    matchConfig.ruleProfileId === 'casual'
                      ? 'border-amber-400 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <div className="text-xs font-bold">Standard Casual</div>
                  <div className="text-[10px] text-slate-400">Auto group · Anywhere BIH</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ ruleProfileId: 'wpa', calledShotsEnabled: true });
                  }}
                  className={`rounded-xl border px-3 py-2 text-left transition-colors cursor-pointer ${
                    matchConfig.ruleProfileId === 'wpa'
                      ? 'border-amber-400 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <div className="text-xs font-bold">Strict Called (WPA)</div>
                  <div className="text-[10px] text-slate-400">Call pocket · Kitchen break</div>
                </button>
              </div>

              <label className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
                <div>
                  <span className="block text-sm text-slate-200">Require Called Shots & Pockets</span>
                  <span className="block text-[11px] text-slate-400">
                    Target ball & pocket must match on open/group/8-ball shots
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={matchConfig.calledShotsEnabled}
                  onChange={(e) =>
                    updateMatchConfig({ calledShotsEnabled: e.target.checked })
                  }
                  className="h-4 w-4 accent-amber-500 cursor-pointer shrink-0 ml-2"
                />
              </label>

              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2">
                <span className="text-xs font-semibold text-slate-300">Starting Breaker</span>
                <div className="flex items-center gap-1">
                  {(['player1', 'player2'] as const).map((pid) => (
                    <button
                      key={pid}
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        updateMatchConfig({ startingBreaker: pid });
                      }}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors cursor-pointer ${
                        matchConfig.startingBreaker === pid
                          ? 'bg-amber-500 text-slate-950'
                          : 'bg-black/30 text-slate-300 hover:text-white'
                      }`}
                    >
                      {pid === 'player1' ? 'Player 1' : matchConfig.opponentType === 'ai' ? 'CPU' : 'Player 2'}
                    </button>
                  ))}
                </div>
              </div>

              {screen === 'playing' && (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    setSettingsOpen(false);
                    onRestartMatch();
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/12 px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-amber-300 hover:bg-amber-500/20 transition-colors cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Apply Rules & Restart Match
                </button>
              )}
            </div>
          )}

          {/* AI Opponent Settings Section */}
          {!(screen === 'playing' && matchConfig.opponentType === 'online') && (
            <div className="space-y-2.5">
              <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Opponent & AI Settings
              </span>

              {/* Opponent Type: Human / AI */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ opponentType: 'pvp' });
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                    matchConfig.opponentType === 'pvp'
                      ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <Users className="h-3.5 w-3.5" />
                  Human (Local PvP)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ opponentType: 'ai' });
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                    matchConfig.opponentType === 'ai'
                      ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <Cpu className="h-3.5 w-3.5" />
                  AI Opponent
                </button>
              </div>

              {/* AI Difficulty */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-semibold text-slate-300">AI Difficulty</span>
                  <span className="text-[10px] text-amber-300">
                    {AI_DIFFICULTY_PROFILES[matchConfig.aiDifficulty].label}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {(['beginner', 'intermediate', 'pro', 'legend'] as AiDifficulty[]).map((lvl) => {
                    const active = matchConfig.aiDifficulty === lvl;
                    return (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          updateMatchConfig({ aiDifficulty: lvl });
                        }}
                        className={`rounded-lg border px-2 py-1.5 text-[11px] font-bold transition-colors cursor-pointer ${
                          active
                            ? 'border-amber-400 bg-amber-500 text-slate-950'
                            : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        {AI_DIFFICULTY_PROFILES[lvl].label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 text-[10px] text-slate-400">
                  {AI_DIFFICULTY_PROFILES[matchConfig.aiDifficulty].tagline}
                </p>
              </div>

              {/* AI Thinking Time */}
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2">
                <span className="text-xs font-semibold text-slate-300">AI Thinking Time</span>
                <div className="flex items-center gap-1">
                  {(
                    [
                      { id: 'fast', label: 'Fast' },
                      { id: 'normal', label: 'Normal' },
                      { id: 'realistic', label: 'Realistic' },
                    ] as Array<{ id: AiThinkingSpeed; label: string }>
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        updateMatchConfig({ aiThinkingSpeed: opt.id });
                      }}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors cursor-pointer ${
                        matchConfig.aiThinkingSpeed === opt.id
                          ? 'bg-amber-500 text-slate-950'
                          : 'bg-black/30 text-slate-300 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
                <div>
                  <span className="block text-sm text-slate-200">AI Aiming Guide</span>
                  <span className="block text-[11px] text-slate-400">
                    Show predicted shot path while AI lines up
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={matchConfig.showAiAimGuide}
                  onChange={(e) =>
                    updateMatchConfig({ showAiAimGuide: e.target.checked })
                  }
                  className="h-4 w-4 accent-amber-500 cursor-pointer shrink-0 ml-2"
                />
              </label>
            </div>
          )}

          {/* Felt Theme */}
          <div>
            <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
              Billiards Cloth Finish
            </span>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(FELT_PALETTES) as FeltTheme[]).map((key) => {
                const palette = FELT_PALETTES[key];
                const active = settings.feltTheme === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      soundEngine.playUiClick();
                      updateSettings({ feltTheme: key });
                    }}
                    className={`flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-center transition-colors cursor-pointer ${
                      active
                        ? 'border-amber-400 bg-amber-500/12 text-white'
                        : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    <span
                      className="h-5 w-8 rounded border border-white/25"
                      style={{ backgroundColor: palette.base }}
                    />
                    <span className="text-[11px] font-medium leading-tight">
                      {palette.label.replace(' ', '\n')}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Sound Controls */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Audio Volume
              </span>
              <button
                type="button"
                onClick={() => {
                  soundEngine.unlock();
                  toggleSound();
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-white/10 cursor-pointer"
              >
                {soundEnabled ? (
                  <>
                    <Volume2 className="h-3.5 w-3.5 text-amber-400" />
                    On
                  </>
                ) : (
                  <>
                    <VolumeX className="h-3.5 w-3.5 text-slate-400" />
                    Muted
                  </>
                )}
              </button>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={soundVolume}
              disabled={!soundEnabled}
              onChange={(e) => setSoundVolume(parseFloat(e.target.value))}
              className="pool-slider w-full disabled:opacity-40"
            />
          </div>

          {/* Camera Sensitivity */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Camera Sensitivity
              </span>
              <span className="text-xs font-mono tabular-nums text-amber-400">
                {settings.cameraSensitivity.toFixed(1)}x
              </span>
            </div>
            <input
              type="range"
              min={0.4}
              max={2.0}
              step={0.1}
              value={settings.cameraSensitivity}
              onChange={(e) =>
                updateSettings({ cameraSensitivity: parseFloat(e.target.value) })
              }
              className="pool-slider w-full"
            />
          </div>

          {/* Visual Toggles */}
          <div className="grid grid-cols-1 gap-2.5 pt-1">
            <label className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
              <span className="text-sm text-slate-200">Dynamic Table & Ball Shadows</span>
              <input
                type="checkbox"
                checked={settings.shadowsEnabled}
                onChange={(e) => updateSettings({ shadowsEnabled: e.target.checked })}
                className="h-4 w-4 accent-amber-500 cursor-pointer"
              />
            </label>
            <label className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
              <span className="text-sm text-slate-200">Cue Aim Trajectory Guide</span>
              <input
                type="checkbox"
                checked={settings.showAimGuide}
                onChange={(e) => updateSettings({ showAimGuide: e.target.checked })}
                className="h-4 w-4 accent-amber-500 cursor-pointer"
              />
            </label>
            <label className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
              <span className="text-sm text-slate-200">Show FPS Indicator</span>
              <input
                type="checkbox"
                checked={settings.showFps}
                onChange={(e) => updateSettings({ showFps: e.target.checked })}
                className="h-4 w-4 accent-amber-500 cursor-pointer"
              />
            </label>
          </div>

          {/* Match Statistics Summary */}
          <div className="rounded-xl border border-white/10 bg-black/30 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Career Statistics
              </span>
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  onResetAllStats();
                }}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400 hover:text-rose-400 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
                Reset
              </button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center font-mono tabular-nums">
              <div>
                <div className="text-xs font-bold text-white">{matchStats.totalShots}</div>
                <div className="text-[10px] text-slate-400">Shots</div>
              </div>
              <div>
                <div className="text-xs font-bold text-white">{matchStats.ballsPocketed}</div>
                <div className="text-[10px] text-slate-400">Pocketed</div>
              </div>
              <div>
                <div className="text-xs font-bold text-amber-300">{matchStats.successfulBreaks}</div>
                <div className="text-[10px] text-slate-400">Breaks</div>
              </div>
              <div>
                <div className="text-xs font-bold text-rose-400">{matchStats.fouls}</div>
                <div className="text-[10px] text-slate-400">Fouls</div>
              </div>
              <div>
                <div className="text-xs font-bold text-emerald-400">
                  {matchStats.wins}W–{matchStats.losses}L
                </div>
                <div className="text-[10px] text-slate-400">Matches</div>
              </div>
              <div>
                <div className="text-xs font-bold text-white">
                  {computeAverageBallsPerTurn(matchStats).toFixed(2)}
                </div>
                <div className="text-[10px] text-slate-400">Avg/Turn</div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={close}
            className="rounded-xl bg-amber-500 px-5 py-2 text-sm font-bold text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
