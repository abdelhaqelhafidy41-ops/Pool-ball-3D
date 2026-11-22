import { Cpu, Globe, Music, RotateCcw, Sparkles, Trash2, Users, Volume2, VolumeX, X } from 'lucide-react';
import { computeAverageBallsPerTurn } from '../game/rules/MatchStatistics';
import type { AiDifficulty, AiThinkingSpeed } from '../game/rules/types';
import { FELT_PALETTES } from '../game/utils/constants';
import type { GraphicsQuality } from '../game/utils/graphicsQuality';
import { soundEngine } from '../game/utils/SoundEngine';
import { localizeAiDifficulty, useTranslation } from '../i18n';
import { useGameStore, type FeltTheme } from '../store/useGameStore';

interface SettingsModalProps {
  onRestartMatch: () => void;
  onResetAllStats: () => void;
}

export function SettingsModal({ onRestartMatch, onResetAllStats }: SettingsModalProps) {
  const { t, lang, setLanguage, formatNumber } = useTranslation();

  const settingsOpen = useGameStore((s) => s.settingsOpen);
  const setSettingsOpen = useGameStore((s) => s.setSettingsOpen);
  const soundEnabled = useGameStore((s) => s.soundEnabled);
  const soundVolume = useGameStore((s) => s.soundVolume);
  const sfxVolume = useGameStore((s) => s.sfxVolume);
  const sfxMuted = useGameStore((s) => s.sfxMuted);
  const musicVolume = useGameStore((s) => s.musicVolume);
  const musicMuted = useGameStore((s) => s.musicMuted);
  const toggleSound = useGameStore((s) => s.toggleSound);
  const setSoundVolume = useGameStore((s) => s.setSoundVolume);
  const setSfxVolume = useGameStore((s) => s.setSfxVolume);
  const toggleSfxMuted = useGameStore((s) => s.toggleSfxMuted);
  const setMusicVolume = useGameStore((s) => s.setMusicVolume);
  const toggleMusicMuted = useGameStore((s) => s.toggleMusicMuted);
  const settings = useGameStore((s) => s.settings);
  const autoRecommendedQuality = useGameStore((s) => s.autoRecommendedQuality);
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

  const getGraphicsShortLabel = (tier: GraphicsQuality) => {
    if (tier === 'low') return t('settings.graphicsTierLowShort');
    if (tier === 'high') return t('settings.graphicsTierHighShort');
    return t('settings.graphicsTierMediumShort');
  };

  const getGraphicsDesc = (tier: GraphicsQuality) => {
    if (tier === 'low') return t('settings.graphicsTierLowDesc');
    if (tier === 'high') return t('settings.graphicsTierHighDesc');
    return t('settings.graphicsTierMediumDesc');
  };

  const getFeltLabel = (key: FeltTheme) => {
    if (key === 'championshipBlue') return t('settings.feltTournamentBlue');
    if (key === 'burgundyClub') return t('settings.feltRoyalBurgundy');
    return t('settings.feltEmerald');
  };

  const activeAi = localizeAiDifficulty(matchConfig.aiDifficulty, lang);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/65 p-4">
      <div className="w-full max-w-md max-h-[92dvh] modal-scroll-y rounded-2xl border border-white/15 bg-[#0f161f] p-5 sm:p-6 shadow-2xl text-slate-100">
        <div className="flex items-center justify-between border-b border-white/10 pb-3.5">
          <div>
            <h2 className="text-lg font-bold tracking-wide text-white">{t('settings.title')}</h2>
            <p className="text-xs text-slate-400">{t('settings.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={t('common.close')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-5">
          {/* Language Selector Section */}
          <div
            className="space-y-2 rounded-xl border border-amber-400/25 bg-amber-500/[0.06] p-3.5"
            data-testid="settings-language-selector"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-300">
                <Globe className="h-3.5 w-3.5 text-amber-400" />
                {t('settings.languageSectionTitle')}
              </span>
            </div>
            <p className="text-[11px] text-slate-400">{t('settings.languageSectionDesc')}</p>
            <div className="grid grid-cols-2 gap-2 pt-0.5">
              <button
                type="button"
                data-testid="settings-lang-ar"
                onClick={() => {
                  soundEngine.playUiClick();
                  setLanguage('ar');
                }}
                className={`min-h-[40px] rounded-xl border px-3 py-2 text-xs font-bold transition-colors cursor-pointer ${
                  lang === 'ar'
                    ? 'border-amber-400 bg-amber-500 text-slate-950'
                    : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                }`}
              >
                {t('meta.switchToArabic')}
              </button>
              <button
                type="button"
                data-testid="settings-lang-en"
                onClick={() => {
                  soundEngine.playUiClick();
                  setLanguage('en');
                }}
                className={`min-h-[40px] rounded-xl border px-3 py-2 text-xs font-bold transition-colors cursor-pointer ${
                  lang === 'en'
                    ? 'border-amber-400 bg-amber-500 text-slate-950'
                    : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                }`}
              >
                {t('meta.switchToEnglish')}
              </button>
            </div>
          </div>

          {/* Match Rules Section (locked during active online match) */}
          {!(screen === 'playing' && matchConfig.opponentType === 'online') && (
            <div className="space-y-2.5">
              <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                {t('settings.rulesSectionTitle')}
              </span>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ ruleProfileId: 'casual', calledShotsEnabled: false });
                  }}
                  className={`rounded-xl border px-3 py-2 text-start transition-colors cursor-pointer ${
                    matchConfig.ruleProfileId === 'casual'
                      ? 'border-amber-400 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <div className="text-xs font-bold">{t('menu.ruleCasual')}</div>
                  <div className="text-[10px] text-slate-400">{t('menu.ruleCasualShortDesc')}</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    updateMatchConfig({ ruleProfileId: 'wpa', calledShotsEnabled: true });
                  }}
                  className={`rounded-xl border px-3 py-2 text-start transition-colors cursor-pointer ${
                    matchConfig.ruleProfileId === 'wpa'
                      ? 'border-amber-400 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <div className="text-xs font-bold">{t('menu.ruleWpa')}</div>
                  <div className="text-[10px] text-slate-400">{t('menu.ruleWpaShortDesc')}</div>
                </button>
              </div>

              <label className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
                <div>
                  <span className="block text-sm text-slate-200">
                    {t('settings.requireCalledShotsLabel')}
                  </span>
                  <span className="block text-[11px] text-slate-400">
                    {t('settings.requireCalledShotsDesc')}
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={matchConfig.calledShotsEnabled}
                  onChange={(e) =>
                    updateMatchConfig({ calledShotsEnabled: e.target.checked })
                  }
                  className="h-4 w-4 accent-amber-500 cursor-pointer shrink-0"
                />
              </label>

              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2">
                <span className="text-xs font-semibold text-slate-300">
                  {t('settings.startingBreakerLabel')}
                </span>
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
                      {pid === 'player1'
                        ? t('common.player1')
                        : matchConfig.opponentType === 'ai'
                          ? t('settings.cpuShort')
                          : t('common.player2')}
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
                  {t('settings.applyRulesRestartButton')}
                </button>
              )}
            </div>
          )}

          {/* AI Opponent Settings Section */}
          {!(screen === 'playing' && matchConfig.opponentType === 'online') && (
            <div className="space-y-2.5">
              <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                {t('settings.opponentAiSectionTitle')}
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
                  {t('menu.modeLocal')}
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
                  {t('settings.aiSettingsTitle')}
                </button>
              </div>

              {/* AI Difficulty */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-semibold text-slate-300">
                    {t('settings.aiDifficultyTitle')}
                  </span>
                  <span className="text-[10px] text-amber-300">{activeAi.label}</span>
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
                        className={`rounded-lg border px-2 py-1.5 text-[11px] font-bold transition-colors cursor-pointer ${
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
                <p className="mt-1 text-[10px] text-slate-400">{activeAi.tagline}</p>
              </div>

              {/* AI Thinking Time */}
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2">
                <span className="text-xs font-semibold text-slate-300">
                  {t('settings.aiThinkingSpeedTitle')}
                </span>
                <div className="flex items-center gap-1">
                  {(
                    [
                      { id: 'fast', label: t('settings.aiSpeedFast') },
                      { id: 'normal', label: t('settings.aiSpeedNormal') },
                      { id: 'realistic', label: t('settings.aiSpeedDeliberate') },
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

              <label className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
                <div>
                  <span className="block text-sm text-slate-200">
                    {t('settings.aiAimGuideLabel')}
                  </span>
                  <span className="block text-[11px] text-slate-400">
                    {t('settings.aiAimGuideDesc')}
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={matchConfig.showAiAimGuide}
                  onChange={(e) =>
                    updateMatchConfig({ showAiAimGuide: e.target.checked })
                  }
                  className="h-4 w-4 accent-amber-500 cursor-pointer shrink-0"
                />
              </label>
            </div>
          )}

          {/* Felt Theme */}
          <div>
            <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
              {t('settings.tableFeltLabel')}
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
                      {getFeltLabel(key)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Graphics Quality Tier */}
          <div className="space-y-2" data-testid="graphics-quality-section">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                {t('settings.graphicsQualityTitle')}
              </span>
              <span className="text-[10px] text-slate-400">
                {t('settings.graphicsRecommendedFormat', {
                  tier: getGraphicsShortLabel(autoRecommendedQuality),
                })}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(['low', 'medium', 'high'] as GraphicsQuality[]).map((tier) => {
                const active = settings.graphicsQuality === tier;
                const isRecommended = autoRecommendedQuality === tier;
                return (
                  <button
                    key={tier}
                    type="button"
                    data-testid={`graphics-tier-${tier}`}
                    onClick={() => {
                      soundEngine.playUiClick();
                      updateSettings({
                        graphicsQuality: tier,
                        shadowsEnabled: tier !== 'low',
                      });
                    }}
                    className={`min-h-[44px] flex flex-col items-center justify-center rounded-xl border px-2 py-2 text-center transition-colors cursor-pointer ${
                      active
                        ? 'border-amber-400 bg-amber-500/15 text-white'
                        : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    <span className="text-xs font-bold">{getGraphicsShortLabel(tier)}</span>
                    {isRecommended && (
                      <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300">
                        {t('settings.graphicsRecommendedBadge')}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-400">
              {t('settings.graphicsPhysicsNote', {
                desc: getGraphicsDesc(settings.graphicsQuality),
              })}
            </p>
          </div>

          {/* Sound Controls: Master, SFX, Music */}
          <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-3.5" data-testid="audio-controls-section">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                {t('settings.audioSectionTitle')}
              </span>
              <button
                type="button"
                onClick={() => {
                  soundEngine.unlock();
                  toggleSound();
                }}
                className="min-h-[36px] inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-white/10 cursor-pointer"
              >
                {soundEnabled ? (
                  <>
                    <Volume2 className="h-3.5 w-3.5 text-amber-400" />
                    {t('settings.masterOn')}
                  </>
                ) : (
                  <>
                    <VolumeX className="h-3.5 w-3.5 text-slate-400" />
                    {t('settings.masterMuted')}
                  </>
                )}
              </button>
            </div>

            {/* Master Volume */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-300 font-medium">{t('settings.masterVolume')}</span>
                <span dir="ltr" className="font-mono tabular-nums text-amber-300">
                  {Math.round(soundVolume * 100)}%
                </span>
              </div>
              <input
                type="range"
                aria-label={t('settings.masterVolume')}
                min={0}
                max={1}
                step={0.05}
                value={soundVolume}
                disabled={!soundEnabled}
                onChange={(e) => {
                  soundEngine.unlock();
                  setSoundVolume(parseFloat(e.target.value));
                }}
                className="pool-slider w-full disabled:opacity-40"
              />
            </div>

            {/* SFX Volume & Mute */}
            <div className="space-y-1 pt-1 border-t border-white/10">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-300 font-medium">{t('settings.sfxVolumeLabel')}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono tabular-nums text-slate-300">
                    {sfxMuted ? t('settings.mutedLabel') : `${Math.round(sfxVolume * 100)}%`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.unlock();
                      toggleSfxMuted();
                    }}
                    className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-slate-200 hover:bg-white/10 cursor-pointer"
                  >
                    {sfxMuted ? t('settings.unmuteShort') : t('settings.muteShort')}
                  </button>
                </div>
              </div>
              <input
                type="range"
                aria-label={t('settings.sfxVolume')}
                min={0}
                max={1}
                step={0.05}
                value={sfxVolume}
                disabled={!soundEnabled || sfxMuted}
                onChange={(e) => {
                  soundEngine.unlock();
                  setSfxVolume(parseFloat(e.target.value));
                }}
                className="pool-slider w-full disabled:opacity-40"
              />
            </div>

            {/* Music / Ambient Volume & Mute */}
            <div className="space-y-1 pt-1 border-t border-white/10">
              <div className="flex items-center justify-between text-[11px]">
                <span className="inline-flex items-center gap-1 text-slate-300 font-medium">
                  <Music className="h-3 w-3 text-amber-300" />
                  {t('settings.musicVolumeLabel')}
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono tabular-nums text-slate-300">
                    {musicMuted ? t('settings.mutedLabel') : `${Math.round(musicVolume * 100)}%`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.unlock();
                      toggleMusicMuted();
                    }}
                    className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-slate-200 hover:bg-white/10 cursor-pointer"
                  >
                    {musicMuted ? t('settings.unmuteShort') : t('settings.muteShort')}
                  </button>
                </div>
              </div>
              <input
                type="range"
                aria-label={t('settings.musicVolume')}
                min={0}
                max={1}
                step={0.05}
                value={musicVolume}
                disabled={!soundEnabled || musicMuted}
                onChange={(e) => {
                  soundEngine.unlock();
                  setMusicVolume(parseFloat(e.target.value));
                }}
                className="pool-slider w-full disabled:opacity-40"
              />
            </div>
          </div>

          {/* Camera Sensitivity */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                {t('settings.cameraSensitivityLabel')}
              </span>
              <span dir="ltr" className="text-xs font-mono tabular-nums text-amber-400">
                {settings.cameraSensitivity.toFixed(1)}x
              </span>
            </div>
            <input
              type="range"
              aria-label={t('settings.cameraSensitivityLabel')}
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

          {/* Visual & Diagnostics Toggles */}
          <div className="grid grid-cols-1 gap-2.5 pt-1">
            <label className="flex min-h-[44px] items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
              <span className="text-sm text-slate-200">{t('settings.dynamicShadowsLabel')}</span>
              <input
                type="checkbox"
                checked={settings.shadowsEnabled}
                onChange={(e) => updateSettings({ shadowsEnabled: e.target.checked })}
                className="h-4 w-4 accent-amber-500 cursor-pointer"
              />
            </label>
            <label className="flex min-h-[44px] items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
              <span className="text-sm text-slate-200">{t('settings.aimGuideLabel')}</span>
              <input
                type="checkbox"
                checked={settings.showAimGuide}
                onChange={(e) => updateSettings({ showAimGuide: e.target.checked })}
                className="h-4 w-4 accent-amber-500 cursor-pointer"
              />
            </label>
            <label className="flex min-h-[44px] items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
              <span className="text-sm text-slate-200">{t('settings.showFpsLabel')}</span>
              <input
                type="checkbox"
                checked={settings.showFps}
                onChange={(e) => updateSettings({ showFps: e.target.checked })}
                className="h-4 w-4 accent-amber-500 cursor-pointer"
              />
            </label>
            <label className="flex min-h-[44px] items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 cursor-pointer">
              <div>
                <span className="block text-sm text-slate-200">
                  {t('settings.perfOverlayLabel')}
                </span>
                <span className="block text-[11px] text-slate-400">
                  {t('settings.perfOverlayDesc')}
                </span>
              </div>
              <input
                type="checkbox"
                checked={settings.showDiagnostics}
                onChange={(e) => updateSettings({ showDiagnostics: e.target.checked })}
                className="h-4 w-4 accent-amber-500 cursor-pointer shrink-0"
              />
            </label>
          </div>

          {/* Match Statistics Summary */}
          <div className="rounded-xl border border-white/10 bg-black/30 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                {t('settings.careerStatsTitle')}
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
                {t('settings.careerResetBtn')}
              </button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center font-mono tabular-nums">
              <div>
                <div className="text-xs font-bold text-white">
                  {formatNumber(matchStats.totalShots)}
                </div>
                <div className="text-[10px] text-slate-400">{t('hud.shotsLabel')}</div>
              </div>
              <div>
                <div className="text-xs font-bold text-white">
                  {formatNumber(matchStats.ballsPocketed)}
                </div>
                <div className="text-[10px] text-slate-400">{t('matchEnd.ballsPocketedLabel')}</div>
              </div>
              <div>
                <div className="text-xs font-bold text-amber-300">
                  {formatNumber(matchStats.successfulBreaks)}
                </div>
                <div className="text-[10px] text-slate-400">{t('settings.statBreaks')}</div>
              </div>
              <div>
                <div className="text-xs font-bold text-rose-400">
                  {formatNumber(matchStats.fouls)}
                </div>
                <div className="text-[10px] text-slate-400">{t('hud.foulsLabel')}</div>
              </div>
              <div>
                <div className="text-xs font-bold text-emerald-400">
                  {t('menu.statsWinsLosses', {
                    wins: formatNumber(matchStats.wins),
                    losses: formatNumber(matchStats.losses),
                  })}
                </div>
                <div className="text-[10px] text-slate-400">{t('settings.statMatches')}</div>
              </div>
              <div>
                <div className="text-xs font-bold text-white">
                  {computeAverageBallsPerTurn(matchStats).toFixed(2)}
                </div>
                <div className="text-[10px] text-slate-400">{t('settings.statAvgTurn')}</div>
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
            {t('settings.doneButton')}
          </button>
        </div>
      </div>
    </div>
  );
}
