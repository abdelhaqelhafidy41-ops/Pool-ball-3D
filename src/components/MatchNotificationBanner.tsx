import { AlertTriangle, Award, Info, X } from 'lucide-react';
import { useEffect } from 'react';
import { useGameStore } from '../store/useGameStore';

export function MatchNotificationBanner() {
  const screen = useGameStore((s) => s.screen);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const matchBanner = useGameStore((s) => s.matchBanner);
  const dismissMatchBanner = useGameStore((s) => s.dismissMatchBanner);

  useEffect(() => {
    if (!matchBanner) return;
    const timer = window.setTimeout(() => {
      dismissMatchBanner();
    }, 3800);
    return () => window.clearTimeout(timer);
  }, [matchBanner, dismissMatchBanner]);

  if (
    screen !== 'playing' ||
    !matchBanner ||
    matchPhase === 'BALL_IN_HAND' ||
    matchPhase === 'GAME_OVER'
  ) {
    return null;
  }

  const isFoul = matchBanner.kind === 'foul';
  const isGroup = matchBanner.kind === 'group';

  return (
    <div className="pointer-events-none fixed top-[84px] sm:top-[92px] left-1/2 -translate-x-1/2 z-20 px-3 w-full max-w-md flex justify-center">
      <div
        role="status"
        className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-2 shadow-xl ${
          isFoul
            ? 'border-rose-500/45 bg-[#1b1014]/95 text-rose-100'
            : isGroup
              ? 'border-amber-400/50 bg-[#0f1722]/95 text-slate-100'
              : 'border-white/15 bg-[#0c1219]/94 text-slate-100'
        }`}
      >
        <div className="mt-0.5 shrink-0">
          {isFoul ? (
            <AlertTriangle className="h-4 w-4 text-rose-400" />
          ) : isGroup ? (
            <Award className="h-4 w-4 text-amber-400" />
          ) : (
            <Info className="h-4 w-4 text-amber-400" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-extrabold tracking-wide text-white">
            {matchBanner.title}
          </div>
          <div className="text-[11px] text-slate-300 leading-snug">
            {matchBanner.detail}
          </div>
        </div>
        <button
          type="button"
          onClick={dismissMatchBanner}
          aria-label="Dismiss notification"
          className="text-slate-400 hover:text-white cursor-pointer shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
