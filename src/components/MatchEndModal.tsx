import { Award, Film, Globe, Home, RotateCcw, Trophy } from 'lucide-react';
import { computeAverageBallsPerTurn } from '../game/rules/MatchStatistics';
import { soundEngine } from '../game/utils/SoundEngine';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { useGameStore } from '../store/useGameStore';

interface MatchEndModalProps {
  onPlayAgain: () => void;
  onMainMenu: () => void;
  onWatchReplay: () => void;
}

export function MatchEndModal({ onPlayAgain, onMainMenu, onWatchReplay }: MatchEndModalProps) {
  const screen = useGameStore((s) => s.screen);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const replayActive = useGameStore((s) => s.replayActive);
  const replayShots = useGameStore((s) => s.replayShots);
  const winner = useGameStore((s) => s.winner);
  const gameOverReason = useGameStore((s) => s.gameOverReason);
  const matchConfig = useGameStore((s) => s.matchConfig);
  const shotCount = useGameStore((s) => s.shotCount);
  const pocketedNumbers = useGameStore((s) => s.pocketedNumbers);
  const matchStats = useGameStore((s) => s.matchStats);
  const onlineLocalRole = useGameStore((s) => s.onlineLocalRole);
  const onlineRematchVotes = useGameStore((s) => s.onlineRematchVotes);
  const openOnlineLobby = useGameStore((s) => s.openOnlineLobby);
  const lastOnlineMatchProgression = useGameStore((s) => s.lastOnlineMatchProgression);
  const openProgressionModal = useGameStore((s) => s.openProgressionModal);

  if (screen !== 'playing' || matchPhase !== 'GAME_OVER' || !winner || replayActive) {
    return null;
  }

  const isOnline = matchConfig.opponentType === 'online';
  const p1Name = matchConfig.player1Name.trim() || 'Player 1';
  const p2Name =
    matchConfig.opponentType === 'ai'
      ? matchConfig.player2Name.trim() || 'CPU Pro'
      : matchConfig.player2Name.trim() || 'Player 2';

  const winnerName = winner === 'player1' ? p1Name : p2Name;
  const avgPerTurn = computeAverageBallsPerTurn(matchStats);
  const hasVotedRematch = Boolean(onlineLocalRole && onlineRematchVotes.includes(onlineLocalRole));
  const opponentVotedRematch = onlineRematchVotes.some((r) => r !== onlineLocalRole);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Match Result"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
    >
      <div className="w-full max-w-md rounded-2xl border border-amber-400/35 bg-[#0e151e] p-6 text-slate-100 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-amber-400/40 bg-amber-500/15">
            <Trophy className="h-6 w-6 text-amber-400" />
          </div>

          <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.2em] text-amber-400">
            {isOnline ? 'Online Match Complete' : 'Match Complete'}
          </p>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight text-white">
            {winnerName} Wins!
          </h2>
          <p className="mt-1.5 text-sm text-slate-300">
            {gameOverReason ?? 'Official 8-Ball rack completed.'}
          </p>
        </div>

        {/* Match & Career Summary Grid */}
        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Rack Shots
            </div>
            <div className="mt-0.5 text-lg font-mono font-bold tabular-nums text-white">
              {shotCount}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Balls Pocketed
            </div>
            <div className="mt-0.5 text-lg font-mono font-bold tabular-nums text-white">
              {pocketedNumbers.length}/15
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Career Record
            </div>
            <div className="mt-0.5 text-sm font-mono font-bold tabular-nums text-amber-300">
              {matchStats.wins}W – {matchStats.losses}L
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Avg Balls / Turn
            </div>
            <div className="mt-0.5 text-sm font-mono font-bold tabular-nums text-white">
              {avgPerTurn.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Online Competitive ELO / XP / Achievement Rewards */}
        {isOnline && lastOnlineMatchProgression && onlineLocalRole && (
          (() => {
            const myDelta = lastOnlineMatchProgression.players[onlineLocalRole];
            if (!myDelta) return null;
            const leveledUp = myDelta.levelAfter > myDelta.levelBefore;
            return (
              <div className="mt-3.5 rounded-xl border border-amber-400/35 bg-amber-500/10 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold uppercase tracking-wider text-amber-300">
                    {lastOnlineMatchProgression.rankedApplied
                      ? 'Competitive Rewards'
                      : 'Unranked / Abandoned Match'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.playUiClick();
                      openProgressionModal('profile');
                    }}
                    className="text-[11px] font-bold text-amber-200 underline hover:text-white cursor-pointer"
                  >
                    View Career
                  </button>
                </div>

                {lastOnlineMatchProgression.rankedApplied ? (
                  <>
                    <div className="grid grid-cols-3 gap-2 font-mono tabular-nums text-xs">
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[10px] text-slate-400">ELO Rating</div>
                        <div className="font-extrabold text-white">
                          {myDelta.eloAfter}{' '}
                          <span
                            className={
                              myDelta.eloDelta >= 0 ? 'text-emerald-300' : 'text-rose-300'
                            }
                          >
                            ({myDelta.eloDelta >= 0 ? `+${myDelta.eloDelta}` : myDelta.eloDelta})
                          </span>
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[10px] text-slate-400">XP Earned</div>
                        <div className="font-extrabold text-emerald-300">+{myDelta.xpGained}</div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[10px] text-slate-400">Level</div>
                        <div className="font-extrabold text-amber-300">
                          Lv {myDelta.levelAfter}
                          {leveledUp ? ' ↑' : ''}
                        </div>
                      </div>
                    </div>

                    {myDelta.unlockedAchievements.length > 0 && (
                      <div className="space-y-1 pt-1">
                        {myDelta.unlockedAchievements.map((ach) => (
                          <div
                            key={ach.id}
                            className="flex items-center justify-between rounded-lg border border-amber-400/40 bg-black/35 px-2.5 py-1.5 text-[11px]"
                          >
                            <span className="inline-flex items-center gap-1.5 font-bold text-amber-200">
                              <Award className="h-3.5 w-3.5 text-amber-400" />
                              Achievement Unlocked: {ach.name}
                            </span>
                            <span className="font-mono font-bold text-emerald-300">
                              +{ach.rewardXp} XP
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-[11px] text-slate-300">
                    Matches ended before any shot is played do not affect ELO or competitive streaks.
                  </p>
                )}
              </div>
            );
          })()
        )}

        {replayShots.length > 0 && (
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiClick();
              onWatchReplay();
            }}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400/35 bg-amber-500/10 px-4 py-2 text-xs font-bold uppercase tracking-wider text-amber-300 hover:bg-amber-500/20 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Film className="h-4 w-4 text-amber-400" />
            Watch Last Shot Replay
          </button>
        )}

        {isOnline ? (
          <div className="mt-3 space-y-2.5">
            <button
              type="button"
              disabled={hasVotedRematch}
              onClick={() => {
                soundEngine.playUiClick();
                multiplayerManager.requestRematch();
              }}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-60 transition-colors cursor-pointer whitespace-nowrap"
            >
              <RotateCcw className="h-4 w-4" />
              {hasVotedRematch
                ? 'Waiting for Opponent (1/2)'
                : opponentVotedRematch
                  ? 'Accept Rematch (1/2)'
                  : 'Rematch'}
            </button>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  multiplayerManager.leaveMatchOrRoom();
                  openOnlineLobby('quick');
                }}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Globe className="h-4 w-4 text-emerald-400" />
                Return to Lobby
              </button>
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  onMainMenu();
                }}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Home className="h-4 w-4" />
                Main Menu
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                onMainMenu();
              }}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Home className="h-4 w-4" />
              Main Menu
            </button>
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                onPlayAgain();
              }}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer whitespace-nowrap"
            >
              <RotateCcw className="h-4 w-4" />
              Play Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
