import { Cpu, User } from 'lucide-react';
import {
  canTargetEightBall,
  getRemainingBallsForGroup,
  SOLIDS_NUMBERS,
  STRIPES_NUMBERS,
} from '../game/rules/BallGroupManager';
import type { BallGroup, PlayerId } from '../game/rules/types';
import { BALL_DEFINITIONS } from '../game/utils/constants';
import { useGameStore } from '../store/useGameStore';

function MiniBallBadge({
  num,
  pocketed,
  dimmed,
}: {
  num: number;
  pocketed?: boolean;
  dimmed?: boolean;
}) {
  const def = BALL_DEFINITIONS[num];
  if (!def) return null;
  const isCue = num === 0;
  const isEight = num === 8;

  return (
    <span
      title={def.name}
      className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-extrabold transition-opacity ${
        pocketed ? 'opacity-20' : dimmed ? 'opacity-45' : 'opacity-100'
      }`}
      style={{
        backgroundColor: isCue
          ? '#f5f2e8'
          : isEight
            ? '#14151a'
            : def.isStripe
              ? '#f5f1e3'
              : def.color,
        color: isEight ? '#ffffff' : '#111318',
        border: isEight
          ? '1px solid #f59e0b'
          : isCue
            ? '1px solid #cbd5e1'
            : '1px solid rgba(255,255,255,0.28)',
        boxShadow: def.isStripe ? `inset 0 0 0 2.5px ${def.color}` : undefined,
      }}
    >
      {isCue ? '' : num}
    </span>
  );
}

function PlayerScoreCard({
  playerId,
  name,
  isAi,
  isActive,
  group,
  tableOpen,
  pocketedSet,
  align,
}: {
  playerId: PlayerId;
  name: string;
  isAi: boolean;
  isActive: boolean;
  group: BallGroup;
  tableOpen: boolean;
  pocketedSet: Set<number>;
  align: 'left' | 'right';
}) {
  const remaining = group ? getRemainingBallsForGroup(pocketedSet, group) : [];
  const onEight = group ? canTargetEightBall(pocketedSet, group) : false;
  const groupNumbers =
    group === 'solids'
      ? SOLIDS_NUMBERS
      : group === 'stripes'
        ? STRIPES_NUMBERS
        : null;

  const groupTag = tableOpen
    ? 'OPEN'
    : group === 'solids'
      ? 'SOLIDS 1–7'
      : group === 'stripes'
        ? 'STRIPES 9–15'
        : 'OPEN';

  return (
    <div
      data-testid={`player-card-${playerId}`}
      className={`flex flex-col gap-1 rounded-xl border px-2.5 py-1.5 min-w-[140px] sm:min-w-[186px] transition-colors ${
        isActive
          ? 'border-amber-400/80 bg-[#131d29]/95 shadow-[0_0_16px_rgba(245,158,11,0.16)]'
          : 'border-white/10 bg-[#0c1219]/92'
      } ${align === 'right' ? 'items-end text-right' : 'items-start text-left'}`}
    >
      <div
        className={`flex w-full items-center justify-between gap-2 ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {isAi ? (
            <Cpu className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-amber-400' : 'text-slate-400'}`} />
          ) : (
            <User className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-amber-400' : 'text-slate-400'}`} />
          )}
          <span className="truncate text-xs font-bold text-white max-w-[92px] sm:max-w-[120px]">
            {name}
          </span>
        </div>

        <span
          className={`text-[10px] font-mono font-bold tracking-wider uppercase whitespace-nowrap ${
            group === 'solids'
              ? 'text-amber-300'
              : group === 'stripes'
                ? 'text-sky-300'
                : 'text-slate-400'
          }`}
        >
          {groupTag}
        </span>
      </div>

      {/* Ball group progress row */}
      <div
        className={`flex items-center gap-1 ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        {groupNumbers ? (
          <>
            {groupNumbers.map((num) => (
              <MiniBallBadge
                key={num}
                num={num}
                pocketed={pocketedSet.has(num)}
              />
            ))}
            {onEight && !pocketedSet.has(8) && (
              <span className="ml-0.5 flex items-center gap-0.5 border-l border-white/15 pl-1">
                <MiniBallBadge num={8} />
              </span>
            )}
          </>
        ) : (
          <div className="flex items-center gap-1 text-[10px] font-mono tabular-nums text-slate-400">
            <MiniBallBadge num={1} dimmed />
            <MiniBallBadge num={9} dimmed />
            <MiniBallBadge num={8} dimmed />
            <span className="ml-0.5">Awaiting group</span>
          </div>
        )}
      </div>

      <div className="text-[10px] font-mono tabular-nums text-slate-400">
        {group
          ? onEight
            ? 'TARGET: 8-BALL'
            : `REMAINING: ${remaining.length}/7`
          : isActive
            ? 'ACTIVE TURN'
            : 'WAITING'}
      </div>
    </div>
  );
}

export function MatchScoreboard() {
  const screen = useGameStore((s) => s.screen);
  const matchConfig = useGameStore((s) => s.matchConfig);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const activePlayer = useGameStore((s) => s.activePlayer);
  const tableOpen = useGameStore((s) => s.tableOpen);
  const playerGroups = useGameStore((s) => s.playerGroups);
  const pocketedNumbers = useGameStore((s) => s.pocketedNumbers);
  const statusHeadline = useGameStore((s) => s.statusHeadline);
  const shotCount = useGameStore((s) => s.shotCount);
  const isAiThinking = useGameStore((s) => s.isAiThinking);
  const cueBallPocketed = useGameStore((s) => s.cueBallPocketed);
  void isAiThinking;

  if (screen !== 'playing') return null;

  if (matchConfig.gameMode === 'freePlay') {
    return (
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-white/10 bg-[#0c1219]/92 px-3 py-1.5 shadow-lg">
        <div className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
          Free Play Practice
        </div>
        <div className="h-3.5 w-px bg-white/15" />
        <div className="text-[11px] font-mono tabular-nums text-slate-300">
          SHOTS {shotCount} · POCKETED {pocketedNumbers.length}/15
        </div>
      </div>
    );
  }

  const pocketedSet = new Set(pocketedNumbers);
  const p1Name = matchConfig.player1Name.trim() || 'Player 1';
  const p2Name =
    matchConfig.opponentType === 'ai'
      ? matchConfig.player2Name.trim() || 'CPU Pro'
      : matchConfig.player2Name.trim() || 'Player 2';

  const statusText = statusHeadline;

  return (
    <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
      <PlayerScoreCard
        playerId="player1"
        name={p1Name}
        isAi={false}
        isActive={activePlayer === 'player1' && matchPhase !== 'GAME_OVER'}
        group={playerGroups.player1}
        tableOpen={tableOpen}
        pocketedSet={pocketedSet}
        align="left"
      />

      {/* Center Match Status Box */}
      <div className="hidden md:flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#0c1219]/92 px-3 py-1.5 text-center min-w-[164px]">
        <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.16em] text-amber-400">
          <MiniBallBadge num={0} pocketed={cueBallPocketed} />
          <span>8-Ball Pool</span>
          <MiniBallBadge num={8} pocketed={pocketedSet.has(8)} />
        </div>
        <div className="mt-0.5 text-[11px] font-semibold text-white max-w-[190px] truncate">
          {statusText}
        </div>
        <div className="text-[10px] font-mono tabular-nums text-slate-400">
          {matchConfig.calledShotsEnabled ? 'CALLED POCKET · ' : ''}SHOT {shotCount}
        </div>
      </div>

      <PlayerScoreCard
        playerId="player2"
        name={p2Name}
        isAi={matchConfig.opponentType === 'ai'}
        isActive={activePlayer === 'player2' && matchPhase !== 'GAME_OVER'}
        group={playerGroups.player2}
        tableOpen={tableOpen}
        pocketedSet={pocketedSet}
        align="right"
      />
    </div>
  );
}
