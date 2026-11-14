import { RotateCcw } from 'lucide-react';
import { useRef, useState } from 'react';
import { CLOTH_PHYSICS } from '../game/utils/constants';
import { soundEngine } from '../game/utils/SoundEngine';
import { canLocalPlayerAct, useGameStore, type CueSpin } from '../store/useGameStore';

const MAX_R = CLOTH_PHYSICS.maxTipOffsetRatio; // 0.78
const CENTER_MAGNET_R = 0.065;

export function clampSpinToCircle(nx: number, ny: number): CueSpin {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    return { x: 0, y: 0 };
  }
  const len = Math.hypot(nx, ny);
  if (len < CENTER_MAGNET_R) {
    return { x: 0, y: 0 };
  }
  if (len > MAX_R) {
    const scale = MAX_R / len;
    return { x: nx * scale, y: ny * scale };
  }
  return { x: nx, y: ny };
}

export function mapClientPointToCueSpin(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): CueSpin {
  const radiusX = Math.max(1, rect.width * 0.5);
  const radiusY = Math.max(1, rect.height * 0.5);
  const cx = rect.left + radiusX;
  const cy = rect.top + radiusY;

  const nx = (clientX - cx) / radiusX;
  const ny = -(clientY - cy) / radiusY; // +Y is Top (Follow), -Y is Bottom (Back Spin)
  return clampSpinToCircle(nx, ny);
}

export function describeCueSpin(x: number, y: number): string {
  const r = Math.hypot(x, y);
  if (r < 0.1) return 'Center';

  const vPart = y > 0.16 ? 'Top' : y < -0.16 ? 'Back' : '';
  const hPart = x < -0.16 ? 'Left' : x > 0.16 ? 'Right' : '';

  if (vPart && hPart) return `${vPart}-${hPart}`;
  if (vPart === 'Top') return 'Top Spin';
  if (vPart === 'Back') return 'Back Spin';
  if (hPart === 'Left') return 'Left Spin';
  if (hPart === 'Right') return 'Right Spin';

  if (Math.abs(y) >= Math.abs(x)) {
    return y >= 0 ? 'Top Spin' : 'Back Spin';
  }
  return x >= 0 ? 'Right Spin' : 'Left Spin';
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

  const disabled =
    ballsMoving ||
    isShotAnimating ||
    isAiThinking ||
    !canAct ||
    matchPhase === 'BALL_IN_HAND' ||
    matchPhase === 'BALLS_MOVING' ||
    matchPhase === 'GAME_OVER';

  const [isDragging, setIsDragging] = useState(false);
  const ballRef = useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  const updateSpinFromPointer = (clientX: number, clientY: number) => {
    const el = ballRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mapped = mapClientPointToCueSpin(clientX, clientY, rect);
    setCueSpin(mapped.x, mapped.y);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || (e.button !== 0 && e.pointerType === 'mouse')) return;
    e.preventDefault();
    e.stopPropagation();
    soundEngine.unlock();

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if pointer capture is unsupported
    }

    activePointerIdRef.current = e.pointerId;
    setIsDragging(true);
    updateSpinFromPointer(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId || disabled) return;
    e.preventDefault();
    e.stopPropagation();
    updateSpinFromPointer(e.clientX, e.clientY);
  };

  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }
    activePointerIdRef.current = null;
    setIsDragging(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = 0.12;
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
        setCueSpin(cueSpin.x, cueSpin.y + step);
        break;
      case 'ArrowDown':
        setCueSpin(cueSpin.x, cueSpin.y - step);
        break;
      case 'ArrowLeft':
        setCueSpin(cueSpin.x - step, cueSpin.y);
        break;
      case 'ArrowRight':
        setCueSpin(cueSpin.x + step, cueSpin.y);
        break;
      case '0':
      case 'Home':
        resetCueSpin();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
    }
  };

  const spinLabel = describeCueSpin(cueSpin.x, cueSpin.y);
  const isCentered = Math.hypot(cueSpin.x, cueSpin.y) < 0.05;

  const dotLeftPct = 50 + cueSpin.x * 50;
  const dotTopPct = 50 - cueSpin.y * 50;

  return (
    <div
      data-testid="cue-ball-spin-selector"
      className={`pointer-events-auto fixed z-20 left-2.5 bottom-[136px] sm:left-4 sm:bottom-[82px] lg:left-auto lg:right-4 lg:bottom-4 aspect-square w-[100px] h-[100px] sm:w-[108px] sm:h-[108px] lg:w-[116px] lg:h-[116px] rounded-2xl border bg-[#0c1219]/88 backdrop-blur-md p-2 flex flex-col items-center justify-between shadow-[0_8px_24px_rgba(0,0,0,0.58)] select-none transition-opacity ${
        disabled
          ? 'border-white/10 opacity-45'
          : isDragging || !isCentered
            ? 'border-amber-400/55 opacity-100'
            : 'border-amber-400/28 opacity-95 hover:border-amber-400/45'
      }`}
      style={{ touchAction: 'none' }}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {/* Compact Header: Spin Label + Optional Reset Button */}
      <div className="flex w-full items-center justify-between gap-1 px-0.5 leading-none shrink-0">
        <span
          data-testid="cue-spin-label"
          className={`truncate text-[10px] font-bold tracking-tight ${
            isCentered ? 'text-slate-300' : 'text-amber-300'
          }`}
        >
          {spinLabel}
        </span>
        {!isCentered && !disabled && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              soundEngine.unlock();
              soundEngine.playUiClick();
              resetCueSpin();
            }}
            title="Reset spin to center"
            aria-label="Reset spin to center"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 hover:text-amber-300 cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Interactive Circular White Cue Ball Face */}
      <div className="flex flex-1 w-full items-center justify-center">
        <div
          ref={ballRef}
          data-testid="cue-ball-spin-surface"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={`Cue ball impact point: ${spinLabel}`}
          aria-valuetext={spinLabel}
          aria-disabled={disabled}
          onKeyDown={handleKeyDown}
          onDoubleClick={() => {
            if (!disabled) {
              soundEngine.playUiClick();
              resetCueSpin();
            }
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onLostPointerCapture={() => {
            activePointerIdRef.current = null;
            setIsDragging(false);
          }}
          className={`relative h-[68px] w-[68px] sm:h-[74px] sm:w-[74px] lg:h-[80px] lg:w-[80px] rounded-full select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
            disabled
              ? 'cursor-not-allowed'
              : isDragging
                ? 'cursor-grabbing'
                : 'cursor-crosshair'
          }`}
          style={{
            touchAction: 'none',
            background:
              'radial-gradient(circle at 34% 28%, #ffffff 0%, #f5f1e4 56%, #cfc6b0 88%, #9a907a 100%)',
            boxShadow: isDragging
              ? 'inset -4px -6px 12px rgba(20, 18, 14, 0.42), 0 0 0 1.5px rgba(245, 158, 11, 0.55), 0 6px 16px rgba(0, 0, 0, 0.55)'
              : 'inset -4px -6px 12px rgba(20, 18, 14, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.16), 0 4px 12px rgba(0, 0, 0, 0.5)',
          }}
        >
          {/* Subtle Center Horizontal & Vertical Crosshair Reference Lines */}
          <div className="pointer-events-none absolute left-1/2 top-[11%] bottom-[11%] w-px -translate-x-1/2 bg-slate-900/18" />
          <div className="pointer-events-none absolute top-1/2 left-[11%] right-[11%] h-px -translate-y-1/2 bg-slate-900/18" />

          {/* Valid Circular Spin Boundary Ring */}
          <div
            className="pointer-events-none absolute rounded-full border border-dashed border-slate-800/22"
            style={{ inset: `${(1 - MAX_R) * 50}%` }}
          />

          {/* Draggable Red Impact Point Dot */}
          <span
            data-testid="cue-spin-dot"
            className={`pointer-events-none absolute h-3 w-3 sm:h-3.5 sm:w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-white bg-red-600 transition-transform duration-100 ${
              isDragging ? 'scale-125' : 'scale-100'
            }`}
            style={{
              left: `${dotLeftPct}%`,
              top: `${dotTopPct}%`,
              boxShadow: isDragging
                ? '0 0 0 4px rgba(239, 68, 68, 0.28), 0 0 10px rgba(239, 68, 68, 0.85)'
                : '0 1px 3px rgba(0, 0, 0, 0.55)',
            }}
          />
        </div>
      </div>
    </div>
  );
}
