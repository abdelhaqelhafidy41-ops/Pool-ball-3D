import { useGameStore } from '../store/useGameStore';

export function FpsCounter() {
  const fps = useGameStore((s) => s.fps);
  const showFps = useGameStore((s) => s.settings.showFps);

  if (!showFps) return null;

  const tone =
    fps >= 50 ? 'text-emerald-400' : fps >= 30 ? 'text-amber-400' : 'text-rose-400';

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#0d131a]/90 px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-300"
      title="Development FPS Indicator"
    >
      <span className="text-slate-400">FPS</span>
      <span className={`font-bold ${tone}`}>{fps}</span>
    </div>
  );
}
