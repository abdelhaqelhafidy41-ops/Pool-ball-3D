import { useTranslation } from '../i18n';
import { useGameStore } from '../store/useGameStore';

export function FpsCounter() {
  const { t } = useTranslation();
  const fps = useGameStore((s) => s.fps);
  const showFps = useGameStore((s) => s.settings.showFps);
  const showDiagnostics = useGameStore((s) => s.settings.showDiagnostics);
  const perfStats = useGameStore((s) => s.perfStats);
  const graphicsQuality = useGameStore((s) => s.settings.graphicsQuality);
  const webglStatus = useGameStore((s) => s.webglStatus);

  if (!showFps && !showDiagnostics) return null;

  const activeFps = perfStats.fps > 0 ? perfStats.fps : fps;
  const tone =
    activeFps >= 50 ? 'text-emerald-400' : activeFps >= 30 ? 'text-amber-400' : 'text-rose-400';

  if (!showDiagnostics) {
    return (
      <div
        dir="ltr"
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#0d131a]/90 px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-300"
        title={t('settings.fpsTooltip')}
      >
        <span className="text-slate-400">FPS</span>
        <span className={`font-bold ${tone}`}>{activeFps}</span>
      </div>
    );
  }

  const glLabel =
    webglStatus === 'context_lost'
      ? t('settings.fpsWebglLost')
      : webglStatus === 'software'
        ? t('settings.fpsWebglSw')
        : t('settings.fpsWebglOk');
  const glTone =
    webglStatus === 'context_lost'
      ? 'text-rose-400'
      : webglStatus === 'software'
        ? 'text-amber-300'
        : 'text-emerald-400';

  const tierLabel =
    graphicsQuality === 'low'
      ? t('settings.graphicsTierLowShort')
      : graphicsQuality === 'high'
        ? t('settings.graphicsTierHighShort')
        : t('settings.graphicsTierMediumShort');

  return (
    <div
      dir="ltr"
      className="flex flex-col gap-0.5 rounded-lg border border-white/12 bg-[#0d131a]/92 px-2.5 py-1.5 text-[10px] font-mono tabular-nums text-slate-300 shadow-md"
      title={t('settings.fpsTooltip')}
      data-testid="perf-diagnostics-overlay"
    >
      <div className="flex items-center justify-between gap-2.5">
        <span>
          <span className="text-slate-400">FPS </span>
          <span className={`font-bold ${tone}`}>{activeFps}</span>
          <span className="text-slate-500">/{perfStats.avgFps || activeFps}</span>
        </span>
        <span>
          <span className="text-slate-400">FT </span>
          <span className="font-semibold text-slate-100">
            {perfStats.frameTimeMs.toFixed(1)}ms
          </span>
        </span>
      </div>
      <div className="flex items-center justify-between gap-2.5 text-slate-400">
        <span>
          {t('settings.fpsDrawCalls')}{' '}
          <span className="text-slate-200 font-semibold">{perfStats.drawCalls}</span>
        </span>
        <span>
          {t('settings.fpsTriangles')}{' '}
          <span className="text-slate-200 font-semibold">{perfStats.triangles}</span>
        </span>
      </div>
      <div className="flex items-center justify-between gap-2.5 text-slate-400">
        <span>
          G/T{' '}
          <span className="text-slate-200 font-semibold">
            {perfStats.geometries}/{perfStats.textures}
          </span>
        </span>
        <span>
          VFX <span className="text-amber-300 font-semibold">{perfStats.activeParticles}</span>
        </span>
      </div>
      <div className="flex items-center justify-between gap-2.5 text-slate-400 border-t border-white/10 pt-0.5 mt-0.5">
        <span className="uppercase text-amber-300 font-semibold">{tierLabel}</span>
        <span className={glTone}>GL:{glLabel}</span>
      </div>
    </div>
  );
}
