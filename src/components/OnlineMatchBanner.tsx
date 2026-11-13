import { LogOut, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { ONLINE_AVATARS } from '../multiplayer/shared/protocol';
import { useGameStore } from '../store/useGameStore';

export function OnlineMatchBanner() {
  const screen = useGameStore((s) => s.screen);
  const matchConfig = useGameStore((s) => s.matchConfig);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const onlineRoom = useGameStore((s) => s.onlineRoom);
  const onlineSessionId = useGameStore((s) => s.onlineSessionId);
  const onlineConnectionStatus = useGameStore((s) => s.onlineConnectionStatus);
  const onlineLatencyMs = useGameStore((s) => s.onlineLatencyMs);
  const onlineOpponentStatus = useGameStore((s) => s.onlineOpponentStatus);

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

  if (screen !== 'playing' || matchConfig.opponentType !== 'online') {
    return null;
  }

  const opponentProfile = onlineRoom?.players.find((p) => p.sessionId !== onlineSessionId) ?? null;
  const avatarMeta =
    ONLINE_AVATARS.find((a) => a.id === opponentProfile?.avatarId) ?? ONLINE_AVATARS[1];

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
            Opponent offline{graceRemainingSec !== null ? ` · ${graceRemainingSec}s` : ''}
          </span>
        ) : onlineOpponentStatus.state === 'reconnected' ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-300 whitespace-nowrap">
            <Wifi className="h-3 w-3 text-emerald-400" />
            Opponent reconnected
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono tabular-nums text-slate-300 whitespace-nowrap">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                onlineConnectionStatus === 'connected' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
              }`}
            />
            {onlineLatencyMs !== null ? `${onlineLatencyMs}ms` : 'Online'}
          </span>
        )}

        {matchPhase !== 'GAME_OVER' && (
          <>
            <div className="h-3 w-px bg-white/15" />
            <button
              type="button"
              onClick={() => multiplayerManager.leaveMatchOrRoom()}
              title="Leave Online Match"
              className="inline-flex items-center gap-1 text-[10px] font-semibold text-rose-300 hover:text-rose-200 transition-colors cursor-pointer whitespace-nowrap"
            >
              <LogOut className="h-3 w-3" />
              Leave
            </button>
          </>
        )}
      </div>

      {isLocalReconnecting && (
        <div className="pointer-events-auto inline-flex items-center gap-2 rounded-lg border border-amber-400/40 bg-[#1a130b]/95 px-2.5 py-1 text-[11px] font-semibold text-amber-200 shadow-lg">
          <RefreshCw className="h-3.5 w-3.5 text-amber-400 animate-spin" />
          <span>
            {onlineConnectionStatus === 'connecting'
              ? 'Connecting to match server...'
              : 'Connection interrupted · Reconnecting...'}
          </span>
        </div>
      )}
    </div>
  );
}
