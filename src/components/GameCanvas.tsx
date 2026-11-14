import { useEffect, useRef } from 'react';
import type { ReplaySpeed } from '../game/replay/types';
import type { MatchConfig, PocketId } from '../game/rules/types';
import { PoolScene } from '../game/scene/PoolScene';
import { useGameStore } from '../store/useGameStore';

export interface PoolSceneActions {
  startMatch: (overrideConfig?: Partial<MatchConfig>) => void;
  shoot: (power: number) => void;
  resetRack: () => void;
  confirmCuePlacement: () => void;
  placeCueAtHeadSpot: () => void;
  setCalledShot: (targetBall: number | null, targetPocket: PocketId | null) => void;
  resetAllStats: () => void;
  enterReplay: (shotId?: string) => void;
  exitReplay: () => void;
  selectReplayShot: (shotId: string) => void;
  toggleReplayPlay: () => void;
  restartReplay: () => void;
  seekReplay: (timeSec: number) => void;
  setReplaySpeed: (speed: ReplaySpeed) => void;
  toggleReplayAutoSlowMo: () => void;
  toggleReplayAnalysis: () => void;
  jumpToReplayImpact: () => void;
}

interface GameCanvasProps {
  actionsRef: React.MutableRefObject<PoolSceneActions | null>;
  onToggleFullscreen: () => void;
}

export function GameCanvas({ actionsRef, onToggleFullscreen }: GameCanvasProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const toggleFullscreenRef = useRef(onToggleFullscreen);
  toggleFullscreenRef.current = onToggleFullscreen;

  const isLoading = useGameStore((s) => s.isLoading);
  const loadError = useGameStore((s) => s.loadError);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const scene = new PoolScene(el, () => toggleFullscreenRef.current());
    actionsRef.current = {
      startMatch: (overrideConfig) => scene.startMatch(overrideConfig),
      shoot: (power: number) => scene.triggerDragShot(power),
      resetRack: () => scene.resetRack(),
      confirmCuePlacement: () => scene.confirmCuePlacement(),
      placeCueAtHeadSpot: () => scene.placeCueAtHeadSpot(),
      setCalledShot: (ball, pocket) => scene.setCalledShot(ball, pocket),
      resetAllStats: () => scene.resetAllStats(),
      enterReplay: (shotId) => scene.enterReplay(shotId),
      exitReplay: () => scene.exitReplay(),
      selectReplayShot: (shotId) => scene.selectReplayShot(shotId),
      toggleReplayPlay: () => scene.toggleReplayPlay(),
      restartReplay: () => scene.restartReplay(),
      seekReplay: (timeSec) => scene.seekReplay(timeSec),
      setReplaySpeed: (speed) => scene.setReplaySpeed(speed),
      toggleReplayAutoSlowMo: () => scene.toggleReplayAutoSlowMo(),
      toggleReplayAnalysis: () => scene.toggleReplayAnalysis(),
      jumpToReplayImpact: () => scene.jumpToReplayImpact(),
    };

    return () => {
      actionsRef.current = null;
      scene.dispose();
    };
  }, [actionsRef]);

  return (
    <div className="fixed inset-0 z-0 overflow-hidden bg-[#090d11]">
      <div ref={mountRef} className="h-full w-full" />

      {isLoading && !loadError && (
        <div className="fixed inset-0 z-30 flex flex-col items-center justify-center bg-[#090d11]/95 text-slate-200">
          <div className="h-9 w-9 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
          <p className="mt-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-300">
            Initializing 3D Table & Physics
          </p>
        </div>
      )}

      {loadError && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#090d11] p-6">
          <div className="max-w-md rounded-xl border border-rose-500/30 bg-[#121821] p-6 text-slate-100 shadow-2xl">
            <h2 className="text-base font-bold text-rose-400">Unable to Start 3D Engine</h2>
            <p className="mt-2 text-sm text-slate-300">{loadError}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400 cursor-pointer"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
