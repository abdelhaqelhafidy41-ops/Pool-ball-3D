import { Check, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CLOTH_PHYSICS } from '../game/utils/constants';
import { soundEngine } from '../game/utils/SoundEngine';
import { canLocalPlayerAct, useGameStore } from '../store/useGameStore';

const MAX_R = CLOTH_PHYSICS.maxTipOffsetRatio; // 0.78

// 9 canonical contact points inside the valid cue-ball contact circle
export const PRESET_POINTS: Array<{ x: number; y: number; label: string }> = [
  { x: 0, y: 0, label: 'Center' },
  { x: 0, y: 0.65, label: 'Top' },
  { x: 0, y: -0.65, label: 'Bottom' },
  { x: -0.65, y: 0, label: 'Left' },
  { x: 0.65, y: 0, label: 'Right' },
  { x: -0.46, y: 0.46, label: 'Top-Left' },
  { x: 0.46, y: 0.46, label: 'Top-Right' },
  { x: -0.46, y: -0.46, label: 'Bottom-Left' },
  { x: 0.46, y: -0.46, label: 'Bottom-Right' },
];

export function describeCueSpin(x: number, y: number): string {
  const r = Math.hypot(x, y);
  if (r < 0.12) return 'Center';

  const vPart = y > 0.18 ? 'Top' : y < -0.18 ? 'Bottom' : '';
  const hPart = x < -0.18 ? 'Left' : x > 0.18 ? 'Right' : '';

  if (vPart && hPart) return `${vPart}-${hPart}`;
  if (vPart === 'Top') return 'Top · Follow';
  if (vPart === 'Bottom') return 'Bottom · Draw';
  if (hPart === 'Left') return 'Left English';
  if (hPart === 'Right') return 'Right English';
  return 'Center';
}

export function CueBallSpinControl() {
  const cueSpin = useGameStore((s) => s.cueSpin);
  const setCueSpin = useGameStore((s) => s.setCueSpin);
  const resetCueSpin = useGameStore((s) => s.resetCueSpin);
  const ballsMoving = useGameStore((s) => s.ballsMoving);
  const isShotAnimating = useGameStore((s) => s.isShotAnimating);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const isAiThinking = useGameStore((s) => s.isAiThinking);
  const canAct = useGameStore(canLocalPlayerAct);

  const [isOpen, setIsOpen] = useState(false);

  const disabled =
    ballsMoving ||
    isShotAnimating ||
    isAiThinking ||
    !canAct ||
    matchPhase === 'BALL_IN_HAND' ||
    matchPhase === 'BALLS_MOVING' ||
    matchPhase === 'GAME_OVER';
  const ballRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ active: boolean; id: number; moved: boolean }>({
    active: false,
    id: -1,
    moved: false,
  });

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  const applyFromClientXY = (clientX: number, clientY: number, snapNearestPreset: boolean) => {
    const el = ballRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    const radius = rect.width * 0.5;

    let nx = (clientX - cx) / radius;
    let ny = -(clientY - cy) / radius; // +Y is Top (upward on screen)

    const len = Math.hypot(nx, ny);
    if (len > MAX_R) {
      const s = MAX_R / len;
      nx *= s;
      ny *= s;
    }

    if (snapNearestPreset) {
      let bestDist = 0.22;
      for (const p of PRESET_POINTS) {
        const d = Math.hypot(nx - p.x, ny - p.y);
        if (d < bestDist) {
          bestDist = d;
          nx = p.x;
          ny = p.y;
        }
      }
    } else if (Math.hypot(nx, ny) < 0.08) {
      nx = 0;
      ny = 0;
    }

    setCueSpin(nx, ny);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || (e.button !== 0 && e.pointerType === 'mouse')) return;
    e.preventDefault();
    e.stopPropagation();
    soundEngine.unlock();

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if unsupported
    }

    dragRef.current = { active: true, id: e.pointerId, moved: false };
    applyFromClientXY(e.clientX, e.clientY, true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active || d.id !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    d.moved = true;
    applyFromClientXY(e.clientX, e.clientY, false);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active || d.id !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }
    dragRef.current.active = false;
    dragRef.current.id = -1;
  };

  const spinLabel = describeCueSpin(cueSpin.x, cueSpin.y);
  const isCentered = Math.hypot(cueSpin.x, cueSpin.y) < 0.05;

  const dotLeftPct = 50 + cueSpin.x * 50;
  const dotTopPct = 50 - cueSpin.y * 50;

  return (
    <>
      {/* Main HUD Icon: Only a compact clickable white billiard ball with subtle spin dot */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          soundEngine.unlock();
          soundEngine.playUiClick();
          setIsOpen(true);
        }}
        title={`Cue Ball Spin: ${spinLabel}`}
        aria-label={`Open cue ball spin selector (${spinLabel})`}
        className={`pointer-events-auto relative h-11 w-11 rounded-full transition-transform active:scale-95 focus:outline-none focus:ring-2 focus:ring-amber-400/70 ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'hover:scale-105 cursor-pointer'
        }`}
        style={{
          background:
            'radial-gradient(circle at 34% 28%, #ffffff 0%, #f1ecde 56%, #c5bca7 88%, #8f8672 100%)',
          boxShadow: isCentered
            ? 'inset -3px -4px 8px rgba(20, 18, 14, 0.42), 0 4px 12px rgba(0, 0, 0, 0.55)'
            : 'inset -3px -4px 8px rgba(20, 18, 14, 0.42), 0 0 0 2px rgba(245, 158, 11, 0.85), 0 4px 12px rgba(0, 0, 0, 0.55)',
        }}
      >
        <span
          className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/90 shadow-sm"
          style={{
            left: `${dotLeftPct}%`,
            top: `${dotTopPct}%`,
            backgroundColor: isCentered ? '#dc2626' : '#f59e0b',
          }}
        />
      </button>

      {/* Floating Modal Popup for Precision Cue Contact Point Selection */}
      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Cue Ball Spin Selector"
          onClick={() => setIsOpen(false)}
          className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[272px] rounded-2xl border border-amber-400/30 bg-[#0c1219]/94 p-4 shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between pb-2.5 border-b border-white/10">
              <div>
                <h3 className="text-xs font-extrabold uppercase tracking-wider text-white">
                  Cue Ball Contact
                </h3>
                <p className="text-[11px] font-semibold text-amber-400">{spinLabel}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  setIsOpen(false);
                }}
                aria-label="Close spin selector"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Large Interactive White Cue Ball Diagram */}
            <div className="my-4 flex justify-center">
              <div
                ref={ballRef}
                role="application"
                aria-label={`Interactive cue ball contact diagram: ${spinLabel}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                className="relative h-[168px] w-[168px] rounded-full select-none cursor-crosshair"
                style={{
                  touchAction: 'none',
                  background:
                    'radial-gradient(circle at 34% 28%, #ffffff 0%, #f1ecde 55%, #c5bca7 88%, #8f8672 100%)',
                  boxShadow:
                    'inset -6px -10px 18px rgba(20, 18, 14, 0.45), 0 10px 24px rgba(0, 0, 0, 0.65)',
                }}
              >
                {/* Safe miscue limit ring */}
                <div
                  className="pointer-events-none absolute rounded-full border border-dashed border-slate-700/40"
                  style={{ inset: `${(1 - MAX_R) * 50}%` }}
                />

                {/* Axis crosshairs */}
                <div className="pointer-events-none absolute left-1/2 top-[11%] bottom-[11%] w-px -translate-x-1/2 bg-slate-700/20" />
                <div className="pointer-events-none absolute top-1/2 left-[11%] right-[11%] h-px -translate-y-1/2 bg-slate-700/20" />

                {/* 9 Canonical Contact Markers */}
                {PRESET_POINTS.map((pt) => (
                  <button
                    key={pt.label}
                    type="button"
                    aria-label={`Select ${pt.label} spin`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      soundEngine.unlock();
                      soundEngine.playUiClick();
                      setCueSpin(pt.x, pt.y);
                    }}
                    className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full flex items-center justify-center cursor-pointer"
                    style={{
                      left: `${50 + pt.x * 50}%`,
                      top: `${50 - pt.y * 50}%`,
                    }}
                  >
                    <span className="h-2 w-2 rounded-full bg-slate-700/45" />
                  </button>
                ))}

                {/* Active Cue Tip Contact Target Indicator */}
                <div
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
                  style={{
                    left: `${dotLeftPct}%`,
                    top: `${dotTopPct}%`,
                  }}
                >
                  <span className="h-5 w-5 rounded-full border-2 border-amber-500 bg-sky-600/90 shadow-md" />
                  <span className="absolute h-1.5 w-1.5 rounded-full bg-white" />
                </div>
              </div>
            </div>

            {/* Footer Actions */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isCentered}
                onClick={() => {
                  soundEngine.playUiClick();
                  resetCueSpin();
                }}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3 text-xs font-semibold text-slate-200 hover:bg-white/10 hover:text-amber-400 disabled:opacity-40 cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Center
              </button>
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  setIsOpen(false);
                }}
                className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-3 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer"
              >
                <Check className="h-3.5 w-3.5" />
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
