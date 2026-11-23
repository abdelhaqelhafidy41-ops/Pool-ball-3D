import { Award, Coins, Crown, Film, Globe, Home, RotateCcw, Shield, ShoppingBag, Target, Trophy } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { computeAverageBallsPerTurn } from '../game/rules/MatchStatistics';
import { soundEngine } from '../game/utils/SoundEngine';
import {
  localizeAchievement,
  localizeAiDifficulty,
  localizeCoinBreakdownLabel,
  localizeFoulOrReason,
  localizePlayerName,
  localizeRankTierName,
  localizeServerError,
  localizeTournamentRoundLabel,
  useTranslation,
} from '../i18n';
import { battlePassClient } from '../multiplayer/BattlePassClient';
import { economyClient } from '../multiplayer/EconomyClient';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { getRankForElo } from '../multiplayer/shared/ranked';
import { useGameStore } from '../store/useGameStore';
import { RankBadge } from './RankBadge';

interface MatchEndModalProps {
  onPlayAgain: () => void;
  onMainMenu: () => void;
  onWatchReplay: () => void;
}

export function MatchEndModal({ onPlayAgain, onMainMenu, onWatchReplay }: MatchEndModalProps) {
  const { t, lang, formatNumber } = useTranslation();
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
  const onlineRoom = useGameStore((s) => s.onlineRoom);
  const onlineRematchVotes = useGameStore((s) => s.onlineRematchVotes);
  const openOnlineLobby = useGameStore((s) => s.openOnlineLobby);
  const openTournamentModal = useGameStore((s) => s.openTournamentModal);
  const lastOnlineMatchProgression = useGameStore((s) => s.lastOnlineMatchProgression);
  const openProgressionModal = useGameStore((s) => s.openProgressionModal);
  const aiMatchClientId = useGameStore((s) => s.aiMatchClientId);
  const aiMatchStartedAtMs = useGameStore((s) => s.aiMatchStartedAtMs);
  const lastAiRewardClaim = useGameStore((s) => s.lastAiRewardClaim);
  const lastAiBattlePassClaim = useGameStore((s) => s.lastAiBattlePassClaim);
  const matchPlayer1BallsPocketed = useGameStore((s) => s.matchPlayer1BallsPocketed);
  const matchPlayer1Fouls = useGameStore((s) => s.matchPlayer1Fouls);
  const matchPlayer1LegalEightBallWin = useGameStore((s) => s.matchPlayer1LegalEightBallWin);
  const openStoreModal = useGameStore((s) => s.openStoreModal);
  const openBattlePassModal = useGameStore((s) => s.openBattlePassModal);
  const onlineSpectating = useGameStore((s) => s.onlineSpectating);
  const spectateReturnTarget = useGameStore((s) => s.spectateReturnTarget);
  const claimedAiMatchIdsRef = useRef<Set<string>>(new Set());
  const claimingAiMatchIdsRef = useRef<Set<string>>(new Set());
  const reportedAiBpIdsRef = useRef<Set<string>>(new Set());
  const reportingAiBpIdsRef = useRef<Set<string>>(new Set());

  const isCompletedAiEightBall =
    screen === 'playing' &&
    matchPhase === 'GAME_OVER' &&
    winner !== null &&
    !replayActive &&
    matchConfig.opponentType === 'ai' &&
    matchConfig.gameMode === 'eightBall';

  const isEligibleAiWin = isCompletedAiEightBall && winner === 'player1';

  useEffect(() => {
    if (!isCompletedAiEightBall) return;
    if (
      !aiMatchClientId ||
      reportedAiBpIdsRef.current.has(aiMatchClientId) ||
      reportingAiBpIdsRef.current.has(aiMatchClientId)
    ) {
      return;
    }
    reportingAiBpIdsRef.current.add(aiMatchClientId);
    const durationSec = Math.max(0, Math.round((Date.now() - aiMatchStartedAtMs) / 1000));
    void battlePassClient
      .recordAiMatch({
        clientMatchId: aiMatchClientId,
        difficulty: matchConfig.aiDifficulty,
        won: winner === 'player1',
        totalShots: shotCount,
        ballsPocketed: matchPlayer1BallsPocketed,
        foulsCommitted: matchPlayer1Fouls,
        legalEightBallWin: matchPlayer1LegalEightBallWin,
        durationSec,
      })
      .then((res) => {
        reportingAiBpIdsRef.current.delete(aiMatchClientId);
        if (res.ok) {
          reportedAiBpIdsRef.current.add(aiMatchClientId);
        }
      })
      .catch(() => {
        reportingAiBpIdsRef.current.delete(aiMatchClientId);
      });
  }, [
    isCompletedAiEightBall,
    aiMatchClientId,
    aiMatchStartedAtMs,
    matchConfig.aiDifficulty,
    winner,
    shotCount,
    matchPlayer1BallsPocketed,
    matchPlayer1Fouls,
    matchPlayer1LegalEightBallWin,
  ]);

  useEffect(() => {
    if (!isEligibleAiWin) return;
    if (
      !aiMatchClientId ||
      claimedAiMatchIdsRef.current.has(aiMatchClientId) ||
      claimingAiMatchIdsRef.current.has(aiMatchClientId)
    ) {
      return;
    }
    claimingAiMatchIdsRef.current.add(aiMatchClientId);
    const durationSec = Math.max(0, Math.round((Date.now() - aiMatchStartedAtMs) / 1000));
    void economyClient
      .claimAiMatchReward({
        clientMatchId: aiMatchClientId,
        difficulty: matchConfig.aiDifficulty,
        won: true,
        totalShots: shotCount,
        ballsPocketed: pocketedNumbers.length,
        durationSec,
      })
      .then((res) => {
        claimingAiMatchIdsRef.current.delete(aiMatchClientId);
        if (
          res.ok ||
          res.code === 'INVALID_MATCH_SUMMARY' ||
          res.code === 'MATCH_NOT_WON'
        ) {
          claimedAiMatchIdsRef.current.add(aiMatchClientId);
        }
      })
      .catch(() => {
        claimingAiMatchIdsRef.current.delete(aiMatchClientId);
      });
  }, [
    isEligibleAiWin,
    aiMatchClientId,
    aiMatchStartedAtMs,
    matchConfig.aiDifficulty,
    shotCount,
    pocketedNumbers.length,
  ]);

  if (screen !== 'playing' || matchPhase !== 'GAME_OVER' || !winner || replayActive) {
    return null;
  }

  const isOnline = matchConfig.opponentType === 'online';
  const p1Name = localizePlayerName(matchConfig.player1Name, 'player1', lang);
  const p2Name =
    matchConfig.opponentType === 'ai'
      ? localizePlayerName(
          matchConfig.player2Name.trim() || localizeAiDifficulty(matchConfig.aiDifficulty, lang).defaultName,
          'player2',
          lang,
        )
      : localizePlayerName(matchConfig.player2Name, 'player2', lang);

  const winnerName = winner === 'player1' ? p1Name : p2Name;
  const localizedReason = localizeFoulOrReason(gameOverReason, lang) ?? t('matchEnd.officialRackCompleted');

  if (isOnline && onlineSpectating) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('matchEnd.broadcastResultAria')}
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-3 sm:p-4"
      >
        <div
          data-testid="spectator-match-end-card"
          className="modal-scroll-y max-h-[92dvh] w-full max-w-md rounded-2xl border border-amber-400/35 bg-[#0e151e] p-5 sm:p-6 text-slate-100 shadow-2xl"
        >
          <div className="flex flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-amber-400/40 bg-amber-500/15">
              <Trophy className="h-6 w-6 text-amber-400" />
            </div>
            <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.2em] text-amber-400">
              {onlineRoom?.tournament
                ? `${onlineRoom.tournament.tournamentTitle} · ${localizeTournamentRoundLabel(onlineRoom.tournament.roundLabel, lang)}`
                : t('matchEnd.liveBroadcastFinal')}
            </p>
            <h2 className="mt-1 text-2xl font-extrabold tracking-tight text-white">
              {t('matchEnd.winnerBanner', { winner: winnerName })}
            </h2>
            <p className="mt-1.5 text-sm text-slate-300">{localizedReason}</p>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2.5">
            <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {t('matchEnd.rackShotsLabel')}
              </div>
              <div className="mt-0.5 text-lg font-mono font-bold tabular-nums text-white">
                {formatNumber(shotCount)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {t('matchEnd.ballsPocketedLabel')}
              </div>
              <div className="mt-0.5 text-lg font-mono font-bold tabular-nums text-white" dir="ltr">
                {pocketedNumbers.length}/15
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-2.5">
            {replayShots.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  onWatchReplay();
                }}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/15 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-amber-200 hover:bg-amber-500/25 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Film className="h-4 w-4 text-amber-400" />
                {t('matchEnd.watchBroadcastReplay')}
              </button>
            )}

            {spectateReturnTarget === 'tournament' && onlineRoom?.tournament && (
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  multiplayerManager.leaveSpectatorMode('tournament');
                }}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Crown className="h-4 w-4" />
                {t('matchEnd.backToTournamentBracket')}
              </button>
            )}

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  multiplayerManager.leaveSpectatorMode('lobby');
                }}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Globe className="h-4 w-4 text-emerald-400" />
                {t('matchEnd.liveMatchesBtn')}
              </button>
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  multiplayerManager.leaveSpectatorMode('menu');
                }}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Home className="h-4 w-4" />
                {t('matchEnd.returnToMenuButton')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isPlayerDefeat =
    isOnline && onlineLocalRole !== null
      ? winner !== onlineLocalRole
      : matchConfig.opponentType === 'ai'
        ? winner === 'player2'
        : false;
  const avgPerTurn = computeAverageBallsPerTurn(matchStats);
  const hasVotedRematch = Boolean(onlineLocalRole && onlineRematchVotes.includes(onlineLocalRole));
  const opponentVotedRematch = onlineRematchVotes.some((r) => r !== onlineLocalRole);
  const aiDiffLabel = localizeAiDifficulty(matchConfig.aiDifficulty, lang).label;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('matchEnd.matchResultAria')}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-3 sm:p-4"
    >
      <div
        data-testid="match-end-card"
        data-outcome={isPlayerDefeat ? 'defeat' : 'victory'}
        className={`modal-scroll-y max-h-[92dvh] w-full max-w-md rounded-2xl border bg-[#0e151e] p-5 sm:p-6 text-slate-100 shadow-2xl ${
          isPlayerDefeat ? 'border-rose-400/30' : 'border-amber-400/35'
        }`}
      >
        <div className="flex flex-col items-center text-center">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-xl border ${
              isPlayerDefeat
                ? 'border-rose-400/35 bg-rose-500/12'
                : 'border-amber-400/40 bg-amber-500/15'
            }`}
          >
            {isPlayerDefeat ? (
              <Shield className="h-6 w-6 text-rose-300" />
            ) : (
              <Trophy className="h-6 w-6 text-amber-400" />
            )}
          </div>

          <p
            className={`mt-3 text-[11px] font-bold uppercase tracking-[0.2em] ${
              isPlayerDefeat ? 'text-rose-300' : 'text-amber-400'
            }`}
          >
            {onlineRoom?.tournament
              ? `${onlineRoom.tournament.tournamentTitle} · ${localizeTournamentRoundLabel(onlineRoom.tournament.roundLabel, lang)}`
              : isOnline
                ? isPlayerDefeat
                  ? t('matchEnd.onlineMatchDefeat')
                  : t('matchEnd.onlineMatchComplete')
                : isPlayerDefeat
                  ? t('matchEnd.matchCompleteDefeat')
                  : t('matchEnd.matchCompleteTitle')}
          </p>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight text-white">
            {isPlayerDefeat
              ? t('matchEnd.wonThisRack', { winner: winnerName })
              : t('matchEnd.winnerBanner', { winner: winnerName })}
          </h2>
          <p className="mt-1.5 text-sm text-slate-300">{localizedReason}</p>
        </div>

        {/* Match & Career Summary Grid */}
        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {t('matchEnd.rackShotsLabel')}
            </div>
            <div className="mt-0.5 text-lg font-mono font-bold tabular-nums text-white">
              {formatNumber(shotCount)}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {t('matchEnd.ballsPocketedLabel')}
            </div>
            <div className="mt-0.5 text-lg font-mono font-bold tabular-nums text-white" dir="ltr">
              {pocketedNumbers.length}/15
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {t('matchEnd.careerRecordLabel')}
            </div>
            <div className="mt-0.5 text-sm font-mono font-bold tabular-nums text-amber-300">
              {t('matchEnd.careerRecordValue', { wins: matchStats.wins, losses: matchStats.losses })}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {t('matchEnd.avgBallsPerTurnLabel')}
            </div>
            <div className="mt-0.5 text-sm font-mono font-bold tabular-nums text-white" dir="ltr">
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
                      ? t('matchEnd.competitiveRewardsTitle')
                      : t('matchEnd.unrankedAbandonedTitle')}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.playUiClick();
                      openProgressionModal('profile');
                    }}
                    className="text-[11px] font-bold text-amber-200 underline hover:text-white cursor-pointer"
                  >
                    {t('matchEnd.viewCareerBtn')}
                  </button>
                </div>

                {lastOnlineMatchProgression.rankedApplied ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                      <RankBadge
                        tier={myDelta.rankAfter ?? getRankForElo(myDelta.eloAfter)}
                        elo={myDelta.eloAfter}
                        size="sm"
                      />
                      {myDelta.expectedScore !== undefined && myDelta.kFactor !== undefined && (
                        <span className="font-mono tabular-nums text-[10px] text-slate-300">
                          {t('matchEnd.expectedWinKFactor', {
                            pct: Math.round(myDelta.expectedScore * 100),
                            k: myDelta.kFactor,
                          })}
                        </span>
                      )}
                    </div>

                    {myDelta.rankTransition && myDelta.rankTransition.direction !== 'none' && (
                      <div
                        className={`rounded-lg border px-2.5 py-1.5 text-xs font-extrabold ${
                          myDelta.rankTransition.direction === 'promoted'
                            ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
                            : 'border-rose-400/45 bg-rose-500/15 text-rose-200'
                        }`}
                      >
                        {myDelta.rankTransition.direction === 'promoted'
                          ? t('matchEnd.rankPromoted', {
                              from: localizeRankTierName(
                                myDelta.rankTransition.fromTier.id,
                                lang,
                                myDelta.rankTransition.fromTier.name,
                              ),
                              to: localizeRankTierName(
                                myDelta.rankTransition.toTier.id,
                                lang,
                                myDelta.rankTransition.toTier.name,
                              ),
                            })
                          : t('matchEnd.rankDemoted', {
                              from: localizeRankTierName(
                                myDelta.rankTransition.fromTier.id,
                                lang,
                                myDelta.rankTransition.fromTier.name,
                              ),
                              to: localizeRankTierName(
                                myDelta.rankTransition.toTier.id,
                                lang,
                                myDelta.rankTransition.toTier.name,
                              ),
                            })}
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-2 font-mono tabular-nums text-xs">
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[10px] text-slate-400">{t('matchEnd.eloRatingLabel')}</div>
                        <div className="font-extrabold text-white" dir="ltr">
                          {myDelta.eloBefore} → {myDelta.eloAfter}{' '}
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
                        <div className="text-[10px] text-slate-400">{t('matchEnd.xpEarnedLabel')}</div>
                        <div className="font-extrabold text-emerald-300" dir="ltr">+{myDelta.xpGained}</div>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
                        <div className="text-[10px] text-slate-400">{t('matchEnd.levelLabel')}</div>
                        <div className="font-extrabold text-amber-300">
                          {t('matchEnd.levelShortValue', { level: myDelta.levelAfter })}
                          {leveledUp ? ' ↑' : ''}
                        </div>
                      </div>
                    </div>

                    {lastOnlineMatchProgression.matchType === 'ranked' &&
                      myDelta.seasonEloAfter !== undefined &&
                      myDelta.seasonEloAfter !== null && (
                        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] font-mono tabular-nums">
                          <span className="text-slate-300 font-sans font-semibold">
                            {t('matchEnd.rankedSeasonEloLabel')}
                          </span>
                          <span className="font-extrabold text-amber-300" dir="ltr">
                            {myDelta.seasonEloAfter}{' '}
                            {myDelta.seasonEloDelta !== undefined &&
                              myDelta.seasonEloDelta !== null && (
                                <span
                                  className={
                                    myDelta.seasonEloDelta >= 0
                                      ? 'text-emerald-300'
                                      : 'text-rose-300'
                                  }
                                >
                                  ({myDelta.seasonEloDelta >= 0 ? '+' : ''}
                                  {myDelta.seasonEloDelta})
                                </span>
                              )}
                          </span>
                        </div>
                      )}

                    {myDelta.coinsEarned !== undefined && myDelta.coinsEarned > 0 && (
                      <div className="rounded-lg border border-amber-400/35 bg-black/35 px-2.5 py-2 space-y-1">
                        <div className="flex items-center justify-between text-xs font-extrabold text-amber-300">
                          <span className="inline-flex items-center gap-1.5">
                            <Coins className="h-3.5 w-3.5 text-amber-400" />
                            {t('matchEnd.coinsEarnedHeader')}
                          </span>
                          <span className="font-mono tabular-nums" dir="ltr">+{myDelta.coinsEarned}</span>
                        </div>
                        {myDelta.coinBreakdown && myDelta.coinBreakdown.length > 0 && (
                          <div className="space-y-0.5 text-[10px] text-slate-300">
                            {myDelta.coinBreakdown.map((entry, idx) => (
                              <div key={`${entry.label}_${idx}`} className="flex justify-between">
                                <span>{localizeCoinBreakdownLabel(entry.label, lang)}</span>
                                <span className="font-mono tabular-nums text-amber-200" dir="ltr">
                                  +{entry.amount}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {myDelta.unlockedAchievements.length > 0 && (
                      <div className="space-y-1 pt-1">
                        {myDelta.unlockedAchievements.map((ach) => (
                          <div
                            key={ach.id}
                            className="flex items-center justify-between rounded-lg border border-amber-400/40 bg-black/35 px-2.5 py-1.5 text-[11px]"
                          >
                            <span className="inline-flex items-center gap-1.5 font-bold text-amber-200">
                              <Award className="h-3.5 w-3.5 text-amber-400" />
                              {t('matchEnd.achievementUnlockedLine', {
                                name: localizeAchievement(ach.id, ach.name, '', lang).name,
                              })}
                            </span>
                            <span className="font-mono font-bold text-emerald-300" dir="ltr">
                              +{ach.rewardXp} {t('common.xp')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-[11px] text-slate-300">
                    {t('matchEnd.earlyEndNoEloNotice')}
                  </p>
                )}
              </div>
            );
          })()
        )}

        {/* AI Match Pool Coins Reward */}
        {!isOnline &&
          matchConfig.opponentType === 'ai' &&
          matchConfig.gameMode === 'eightBall' &&
          winner === 'player1' &&
          lastAiRewardClaim && (
            <div className="mt-3.5 rounded-xl border border-amber-400/35 bg-amber-500/10 p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-bold text-amber-200">
                  <Coins className="h-3.5 w-3.5 text-amber-400" />
                  {t('matchEnd.aiVictoryRewardHeader', { diff: aiDiffLabel })}
                </span>
                <span className="font-mono font-extrabold tabular-nums text-amber-300">
                  {lastAiRewardClaim.coinsAwarded > 0
                    ? t('matchEnd.coinsAmountUpper', { coins: lastAiRewardClaim.coinsAwarded })
                    : t('matchEnd.zeroCoinsUpper')}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-slate-300 font-mono tabular-nums">
                <span>
                  {lastAiRewardClaim.dailyCapReached
                    ? t('matchEnd.aiRewardDailyCap', {
                        earned: lastAiRewardClaim.dailyEarned,
                        cap: lastAiRewardClaim.dailyCap,
                      })
                    : lastAiRewardClaim.coinsAwarded === 0
                      ? t('matchEnd.minRequirementsNotMet')
                      : t('matchEnd.creditedToWallet')}
                </span>
                <span>
                  {t('matchEnd.dailyProgressRatio', {
                    earned: lastAiRewardClaim.dailyEarned,
                    cap: lastAiRewardClaim.dailyCap,
                  })}
                </span>
              </div>
            </div>
          )}

        {/* AI Match Battle Pass & Missions Progress */}
        {!isOnline &&
          matchConfig.opponentType === 'ai' &&
          matchConfig.gameMode === 'eightBall' &&
          lastAiBattlePassClaim && (
            <div className="mt-3 rounded-xl border border-white/12 bg-white/[0.04] p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-bold text-slate-100">
                  <Crown className="h-3.5 w-3.5 text-amber-400" />
                  {t('matchEnd.battlePassLvRatio', {
                    level: lastAiBattlePassClaim.overview.playerState.seasonLevel,
                    max: lastAiBattlePassClaim.overview.season.maxLevel,
                  })}
                </span>
                <span className="font-mono font-extrabold tabular-nums text-emerald-300">
                  {t('matchEnd.seasonXpAmount', { xp: lastAiBattlePassClaim.seasonXpAwarded })}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-slate-300 font-mono tabular-nums">
                <span>
                  {lastAiBattlePassClaim.rejectedReason
                    ? localizeServerError(lastAiBattlePassClaim.rejectedReason, lang)
                    : lastAiBattlePassClaim.capReached
                      ? t('matchEnd.dailyAiSeasonXpCapReached')
                      : lastAiBattlePassClaim.completedMissionIds.length > 0
                        ? t('matchEnd.missionsCompletedCount', {
                            count: lastAiBattlePassClaim.completedMissionIds.length,
                          })
                        : t('matchEnd.missionsProgressUpdated')}
                </span>
                <span>
                  {lastAiBattlePassClaim.overview.claimableCounts.total > 0
                    ? t('matchEnd.claimableCount', {
                        count: lastAiBattlePassClaim.overview.claimableCounts.total,
                      })
                    : t('matchEnd.dailyAiXpProgress', {
                        cur: lastAiBattlePassClaim.overview.playerState.dailyAiXpEarned,
                        cap: lastAiBattlePassClaim.overview.config.dailyAiMatchXpCap,
                      })}
                </span>
              </div>
            </div>
          )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {replayShots.length > 0 && (
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                onWatchReplay();
              }}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-amber-400/35 bg-amber-500/10 px-4 py-2 text-xs font-bold uppercase tracking-wider text-amber-300 hover:bg-amber-500/20 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Film className="h-4 w-4 text-amber-400" />
              {t('matchEnd.watchReplayButton')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiClick();
              openBattlePassModal('daily');
            }}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold uppercase tracking-wider text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Target className="h-4 w-4 text-amber-400" />
            {t('matchEnd.missionsBtn')}
          </button>
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiClick();
              openStoreModal('store');
            }}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold uppercase tracking-wider text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
          >
            <ShoppingBag className="h-4 w-4 text-amber-400" />
            {t('matchEnd.storeBtn')}
          </button>
        </div>

        {isOnline ? (
          <div className="mt-3 space-y-2.5">
            {onlineRoom?.tournament ? (
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  const tid = onlineRoom.tournament!.tournamentId;
                  multiplayerManager.leaveMatchOrRoom();
                  openTournamentModal('bracket', tid);
                }}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Crown className="h-4 w-4" />
                {t('matchEnd.viewTournamentBracket')}
              </button>
            ) : (
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
                  ? t('matchEnd.waitingOpponentRematch')
                  : opponentVotedRematch
                    ? t('matchEnd.acceptRematch')
                    : t('matchEnd.rematchLabel')}
              </button>
            )}

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
                {t('matchEnd.returnToLobby')}
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
                {t('matchEnd.returnToMenuButton')}
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
              {t('matchEnd.returnToMenuButton')}
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
              {t('matchEnd.playAgainButton')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
