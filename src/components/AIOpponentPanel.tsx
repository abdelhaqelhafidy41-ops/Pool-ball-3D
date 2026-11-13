import { Cpu } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';

export function AIOpponentPanel() {
  const screen = useGameStore((s) => s.screen);
  const matchConfig = useGameStore((s) => s.matchConfig);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const isAiThinking = useGameStore((s) => s.isAiThinking);

  if (
    screen !== 'playing' ||
    matchConfig.gameMode !== 'eightBall' ||
    matchConfig.opponentType !== 'ai' ||
    matchPhase === 'GAME_OVER' ||
    !isAiThinking
  ) {
    return null;
  }

  return (
    <div
      data-testid="ai-opponent-panel"
      aria-live="polite"
      aria-label="AI thinking"
      className="pointer-events-none fixed left-2.5 sm:left-4 top-[54px] sm:top-[58px] z-10 inline-flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-[#0b1017]/82 px-2 py-1 shadow-md"
    >
      <Cpu className="h-3 w-3 shrink-0 text-amber-400" />
      <span className="text-[10px] font-semibold tracking-wide text-slate-200 whitespace-nowrap">
        AI Thinking
      </span>
      <span className="flex items-center gap-0.5 shrink-0" aria-hidden="true">
        <span className="h-1 w-1 rounded-full bg-amber-400 animate-pulse" />
        <span
          className="h-1 w-1 rounded-full bg-amber-400 animate-pulse"
          style={{ animationDelay: '160ms' }}
        />
        <span
          className="h-1 w-1 rounded-full bg-amber-400 animate-pulse"
          style={{ animationDelay: '320ms' }}
        />
      </span>
    </div>
  );
}
