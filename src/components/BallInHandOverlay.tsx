import { Check, LocateFixed } from 'lucide-react';
import { localizePlacementReason, localizePlayerName, useTranslation } from '../i18n';
import { canLocalPlayerAct, useGameStore } from '../store/useGameStore';

interface BallInHandOverlayProps {
  onConfirmPlacement: () => void;
  onPlaceAtHeadSpot: () => void;
}

export function BallInHandOverlay({
  onConfirmPlacement,
  onPlaceAtHeadSpot,
}: BallInHandOverlayProps) {
  const { t, lang } = useTranslation();
  const screen = useGameStore((s) => s.screen);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const ballInHandZone = useGameStore((s) => s.ballInHandZone);
  const cuePlacementValid = useGameStore((s) => s.cuePlacementValid);
  const cuePlacementReason = useGameStore((s) => s.cuePlacementReason);
  const activePlayer = useGameStore((s) => s.activePlayer);
  const matchConfig = useGameStore((s) => s.matchConfig);
  const isAiThinking = useGameStore((s) => s.isAiThinking);
  const canAct = useGameStore(canLocalPlayerAct);

  if (screen !== 'playing' || matchPhase !== 'BALL_IN_HAND' || isAiThinking || !canAct) {
    return null;
  }

  const playerName =
    activePlayer === 'player1'
      ? localizePlayerName(matchConfig.player1Name, 'player1', lang)
      : matchConfig.opponentType === 'ai'
        ? localizePlayerName(matchConfig.player2Name || 'CPU Pro', 'player2', lang)
        : localizePlayerName(matchConfig.player2Name, 'player2', lang);

  const zoneText =
    ballInHandZone === 'kitchen'
      ? t('ballInHand.kitchenBannerDesc')
      : t('ballInHand.anywhereBannerDesc');

  const invalidReason =
    localizePlacementReason(cuePlacementReason, lang) ?? t('ballInHand.invalidDefault');

  return (
    <div className="pointer-events-none fixed top-[84px] sm:top-[92px] left-1/2 -translate-x-1/2 z-20 flex justify-center px-3 w-full max-w-xl">
      <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-emerald-400/45 bg-[#0c1219]/95 px-3.5 py-2 shadow-2xl w-full">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-extrabold uppercase tracking-wider text-emerald-400">
              {t('ballInHand.playerBallInHandTitle', { player: playerName })}
            </span>
          </div>
          <p
            className={`text-[11px] leading-snug ${
              cuePlacementValid ? 'text-slate-300' : 'text-rose-400 font-medium'
            }`}
          >
            {cuePlacementValid ? zoneText : invalidReason}
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onPlaceAtHeadSpot}
            className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <LocateFixed className="h-3.5 w-3.5 text-amber-400" />
            {t('ballInHand.resetHeadSpot')}
          </button>

          <button
            type="button"
            disabled={!cuePlacementValid}
            onClick={onConfirmPlacement}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider text-slate-950 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Check className="h-3.5 w-3.5" />
            {t('ballInHand.confirmPlacement')}
          </button>
        </div>
      </div>
    </div>
  );
}

