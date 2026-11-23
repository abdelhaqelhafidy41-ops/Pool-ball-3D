import { Crown, LogOut, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { localizeTournamentRoundLabel, useTranslation } from '../i18n';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { getAvatarVisualMeta } from '../multiplayer/shared/economy';
import { useGameStore } from '../store/useGameStore';

export function OnlineMatchBanner() {
  const { t, lang } = useTranslation();
  const screen = useGameStore((s) => s.screen);
  const matchConfig = useGameStore((s) => s.matchConfig);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const onlineRoom = useGameStore((s) => s.onlineRoom);
  const onlineSessionId = useGameStore((s) => s.onlineSessionId);
  const onlineConnectionStatus = useGameStore((s) => s.onlineConnectionStatus);
  const onlineLatencyMs = useGameStore((s) => s.onlineLatencyMs);
  const onlineOpponentStatus = useGameStore((s) => s.onlineOpponentStatus);
  const onlineSpectating = useGameStore((s) => s.onlineSpectating);

  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (onlineOpponentStatus.state !== 'disconnected' || !onlineOpponentStatus.graceDeadlineMs) {
      return;
    }
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 500);
    return () => window.clearInterval(id);
  }, [onlineOpponentStatus.state, onlineOpponentStatus.graceDeadlineMs]);

  if (screen !== 'playing' || matchConfig.opponentType !== 'online' || onlineSpectating) {
    return null;
  }

  const opponentProfile = onlineRoom?.players.find((p) => p.sessionId !== onlineSessionId) ?? null;
  const avatarMeta = opponentProfile
    ? getAvatarVisualMeta(opponentProfile.avatarId)
    : getAvatarVisualMeta('eight_obsidian');

  const graceRemainingSec =
    onlineOpponentStatus.state === 'disconnected' && onlineOpponentStatus.graceDeadlineMs
      ? Math.max(0, Math.ceil((onlineOpponentStatus.graceDeadlineMs - nowMs) / 1000))
      : null;

  const isLocalReconnecting =
    onlineConnectionStatus === 'reconnecting' ||
    onlineConnectionStatus === 'disconnected' ||
    onlineConnectionStatus === 'connecting';

  return (
    <div className="pointer-events-none fixed left-2.5 sm:left-4 top-[54px] sm:top-[58px] z-10 flex flex-col items-start gap-1.5 max-w-[92vw]">
      {onlineRoom?.tournament && (
        <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-[#141109]/92 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-amber-200 shadow-md">
          <Crown className="h-3 w-3 text-amber-400 shrink-0" />
          <span className="truncate max-w-[200px]">{onlineRoom.tournament.tournamentTitle}</span>
          <span className="text-amber-500">·</span>
          <span className="text-amber-300 shrink-0">
            {localizeTournamentRoundLabel(onlineRoom.tournament.roundLabel, lang)}
          </span>
        </div>
      )}
      <div className="pointer-events-auto inline-flex items-center gap-2 rounded-lg border border-white/12 bg-[#0b1017]/88 px-2.5 py-1 shadow-md">
        {opponentProfile && (
          <div className="flex items-center gap-1.5">
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold border border-white/20"
              style={{ backgroundColor: `${avatarMeta.accent}22`, color: avatarMeta.accent }}
            >
              {avatarMeta.glyph}
            </span>
            <span className="text-[11px] font-semibold text-slate-100 max-w-[100px] truncate">
              {opponentProfile.displayName}
            </span>
          </div>
        )}

        <div className="h-3 w-px bg-white/15" />

        {onlineOpponentStatus.state === 'disconnected' ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-300 whitespace-nowrap">
            <WifiOff className="h-3 w-3 text-amber-400" />
            {t('hud.opponentOffline', {
              sec: graceRemainingSec !== null ? ` · ${graceRemainingSec}s` : '',
            })}
          </span>
        ) : onlineOpponentStatus.state === 'reconnected' ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-300 whitespace-nowrap">
            <Wifi className="h-3 w-3 text-emerald-400" />
            {t('hud.opponentReconnected')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono tabular-nums text-slate-300 whitespace-nowrap">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                onlineConnectionStatus === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            {onlineLatencyMs !== null ? t('lobby.latencyMs', { ms: onlineLatencyMs }) : t('hud.onlineLabel')}
          </span>
        )}

        {matchPhase !== 'GAME_OVER' && (
          <>
            <div className="h-3 w-px bg-white/15" />
            <button
              type="button"
              onClick={() => multiplayerManager.leaveMatchOrRoom()}
              title={t('hud.leaveOnlineMatchTooltip')}
              className="inline-flex items-center gap-1 text-[10px] font-semibold text-rose-300 hover:text-rose-200 transition-colors cursor-pointer whitespace-nowrap"
            >
              <LogOut className="h-3 w-3" />
              {t('hud.leaveShort')}
            </button>
          </>
        )}
      </div>

      {isLocalReconnecting && (
        <div className="pointer-events-auto inline-flex items-center gap-2 rounded-lg border border-amber-400/40 bg-[#1a130b]/95 px-2.5 py-1 text-[11px] font-semibold text-amber-200 shadow-lg">
          <RefreshCw className="h-3.5 w-3.5 text-amber-400 animate-spin" />
          <span>
            {onlineConnectionStatus === 'connecting'
              ? t('hud.connectingMatchServer')
              : t('hud.reconnectingMatchServer')}
          </span>
        </div>
      )}
    </div>
  );
}
