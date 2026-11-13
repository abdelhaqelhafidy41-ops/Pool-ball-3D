import { Crosshair, RotateCcw, Target } from 'lucide-react';
import { useState } from 'react';
import { getLegalTargetBalls } from '../game/rules/BallGroupManager';
import type { PocketId } from '../game/rules/types';
import { BALL_DEFINITIONS } from '../game/utils/constants';
import { soundEngine } from '../game/utils/SoundEngine';
import { canLocalPlayerAct, useGameStore } from '../store/useGameStore';

interface CalledShotPanelProps {
  onSelectCalledShot: (targetBall: number | null, targetPocket: PocketId | null) => void;
}

const POCKET_BUTTONS: Array<{ id: PocketId; label: string; posClass: string }> = [
  { id: 'corner-tl', label: 'TL', posClass: 'top-1 left-1' },
  { id: 'side-top', label: 'TOP', posClass: 'top-1 left-1/2 -translate-x-1/2' },
  { id: 'corner-tr', label: 'TR', posClass: 'top-1 right-1' },
  { id: 'corner-bl', label: 'BL', posClass: 'bottom-1 left-1' },
  { id: 'side-bottom', label: 'BOT', posClass: 'bottom-1 left-1/2 -translate-x-1/2' },
  { id: 'corner-br', label: 'BR', posClass: 'bottom-1 right-1' },
];

export function CalledShotPanel({ onSelectCalledShot }: CalledShotPanelProps) {
  const screen = useGameStore((s) => s.screen);
  const matchConfig = useGameStore((s) => s.matchConfig);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const activePlayer = useGameStore((s) => s.activePlayer);
  const tableOpen = useGameStore((s) => s.tableOpen);
  const playerGroups = useGameStore((s) => s.playerGroups);
  const pocketedNumbers = useGameStore((s) => s.pocketedNumbers);
  const calledShot = useGameStore((s) => s.calledShot);
  const ballsMoving = useGameStore((s) => s.ballsMoving);
  const isAiThinking = useGameStore((s) => s.isAiThinking);
  const canAct = useGameStore(canLocalPlayerAct);

  const [expanded, setExpanded] = useState(false);

  if (
    screen !== 'playing' ||
    matchConfig.gameMode !== 'eightBall' ||
    matchPhase === 'BREAK' ||
    matchPhase === 'GAME_OVER' ||
    matchPhase === 'BALL_IN_HAND' ||
    !canAct
  ) {
    return null;
  }

  const activeGroup = playerGroups[activePlayer];
  const legalBalls = getLegalTargetBalls(pocketedNumbers, tableOpen, activeGroup);
  const shootingEight = legalBalls.length === 1 && legalBalls[0] === 8;
  const required = matchConfig.calledShotsEnabled;
  const locked = ballsMoving || isAiThinking || !canAct;

  const isComplete = calledShot.targetBall !== null && calledShot.targetPocket !== null;

  return (
    <div className="pointer-events-auto fixed left-2.5 sm:left-4 bottom-20 sm:bottom-24 z-20 flex flex-col items-start gap-1.5">
      {expanded && (
        <div className="w-[228px] rounded-xl border border-white/12 bg-[#0c1219]/95 p-2.5 shadow-2xl">
          <div className="flex items-center justify-between pb-2 border-b border-white/10">
            <span className="text-[11px] font-bold uppercase tracking-wider text-white">
              Call Ball & Pocket
            </span>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                soundEngine.playUiClick();
                onSelectCalledShot(null, null);
              }}
              className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400 hover:text-amber-400 disabled:opacity-40 cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              Clear
            </button>
          </div>

          {/* Target Ball Picker */}
          <div className="mt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
              1. Target Ball
            </div>
            <div className="flex flex-wrap gap-1">
              {legalBalls.map((num) => {
                const def = BALL_DEFINITIONS[num];
                const selected = calledShot.targetBall === num;
                return (
                  <button
                    key={num}
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      soundEngine.playUiClick();
                      onSelectCalledShot(num, calledShot.targetPocket);
                    }}
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-extrabold transition-transform cursor-pointer ${
                      selected
                        ? 'ring-2 ring-amber-400 scale-110'
                        : 'opacity-80 hover:opacity-100'
                    }`}
                    style={{
                      backgroundColor:
                        num === 8
                          ? '#14151a'
                          : def.isStripe
                            ? '#f5f1e3'
                            : def.color,
                      color: num === 8 ? '#ffffff' : '#111318',
                      border:
                        num === 8
                          ? '1px solid #f59e0b'
                          : '1px solid rgba(255,255,255,0.25)',
                      boxShadow: def.isStripe
                        ? `inset 0 0 0 3px ${def.color}`
                        : undefined,
                    }}
                  >
                    {num}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 6-Pocket Mini Table Selector */}
          <div className="mt-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
              2. Intended Pocket
            </div>
            <div className="relative h-[86px] w-full rounded-lg border-2 border-[#5a3b24] bg-[#0f5c3a] shadow-inner">
              {POCKET_BUTTONS.map((p) => {
                const active = calledShot.targetPocket === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      soundEngine.playUiClick();
                      onSelectCalledShot(
                        calledShot.targetBall ?? (shootingEight ? 8 : legalBalls[0] ?? null),
                        p.id,
                      );
                    }}
                    className={`absolute ${p.posClass} rounded-md px-1.5 py-0.5 text-[9px] font-mono font-bold transition-colors cursor-pointer ${
                      active
                        ? 'bg-amber-500 text-slate-950 shadow'
                        : 'bg-[#091017]/85 text-slate-200 border border-white/20 hover:border-amber-400'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Compact Trigger Button */}
      <button
        type="button"
        onClick={() => {
          soundEngine.playUiClick();
          setExpanded((v) => !v);
        }}
        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[11px] font-semibold shadow-lg transition-colors cursor-pointer whitespace-nowrap ${
          isComplete
            ? 'border-amber-400/70 bg-amber-500/20 text-amber-200'
            : required && shootingEight
              ? 'border-amber-400 bg-[#0c1219]/95 text-amber-300'
              : 'border-white/12 bg-[#0c1219]/92 text-slate-200 hover:bg-white/10'
        }`}
      >
        {isComplete ? (
          <Target className="h-3.5 w-3.5 text-amber-400" />
        ) : (
          <Crosshair className="h-3.5 w-3.5 text-amber-400" />
        )}
        <span>
          {isComplete
            ? `Called: #${calledShot.targetBall} → ${POCKET_BUTTONS.find((p) => p.id === calledShot.targetPocket)?.label}`
            : required
              ? shootingEight
                ? 'Call 8-Ball Pocket'
                : 'Call Shot (Required)'
              : 'Call Shot (Optional)'}
        </span>
      </button>
    </div>
  );
}
