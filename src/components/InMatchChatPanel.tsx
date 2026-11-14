import { Ban, Flag, MessageSquare, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { soundEngine } from '../game/utils/SoundEngine';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { socialClient } from '../multiplayer/SocialClient';
import { SOCIAL_LIMITS, type SocialReportReason } from '../multiplayer/shared/social';
import { useGameStore } from '../store/useGameStore';

function formatClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function InMatchChatPanel() {
  const screen = useGameStore((s) => s.screen);
  const opponentType = useGameStore((s) => s.matchConfig.opponentType);
  const replayActive = useGameStore((s) => s.replayActive);
  const onlineRoom = useGameStore((s) => s.onlineRoom);
  const onlineSessionId = useGameStore((s) => s.onlineSessionId);
  const ownProfile = useGameStore((s) => s.ownProfile);
  const roomChatMessages = useGameStore((s) => s.roomChatMessages);
  const roomChatOpen = useGameStore((s) => s.roomChatOpen);
  const roomChatUnreadCount = useGameStore((s) => s.roomChatUnreadCount);
  const setRoomChatOpen = useGameStore((s) => s.setRoomChatOpen);
  const onlineError = useGameStore((s) => s.onlineError);

  const [input, setInput] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<SocialReportReason>('harassment');
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el && roomChatOpen) {
      el.scrollTop = el.scrollHeight;
    }
  }, [roomChatMessages.length, roomChatOpen]);

  useEffect(() => {
    if (
      onlineError &&
      (onlineError.code === 'RATE_LIMITED' ||
        onlineError.code === 'BLOCKED_PLAYER' ||
        onlineError.code === 'MESSAGE_TOO_LONG')
    ) {
      setLocalError(onlineError.message);
    }
  }, [onlineError]);

  if (screen !== 'playing' || opponentType !== 'online' || replayActive || !onlineRoom) {
    return null;
  }

  const opponent = onlineRoom.players.find((p) => p.sessionId !== onlineSessionId) ?? null;
  const selfPlayerId = ownProfile?.playerId ?? onlineSessionId;

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    if (trimmed.length > SOCIAL_LIMITS.chatMaxLength) {
      setLocalError(`Max ${SOCIAL_LIMITS.chatMaxLength} characters.`);
      return;
    }
    setLocalError(null);
    const sent = multiplayerManager.sendRoomChatMessage(trimmed);
    if (sent) {
      setInput('');
    } else {
      setLocalError('Room chat is connecting...');
    }
  };

  const handleBlockOpponent = async () => {
    if (!opponent?.playerId) return;
    soundEngine.playUiClick();
    const res = await socialClient.blockPlayer(opponent.playerId);
    setActionMsg(res.ok ? `${opponent.displayName} blocked.` : res.error ?? 'Failed to block.');
  };

  const handleReportOpponent = async () => {
    if (!opponent?.playerId) return;
    soundEngine.playUiClick();
    const lastOpponentMsg = [...roomChatMessages]
      .reverse()
      .find((m) => m.senderPlayerId === opponent.playerId)?.body;
    const res = await socialClient.submitReport({
      reportedId: opponent.playerId,
      contextType: 'room_chat',
      contextId: onlineRoom.roomId,
      reason: reportReason,
      excerpt: lastOpponentMsg,
    });
    setReportOpen(false);
    setActionMsg(res.ok ? 'Report submitted.' : res.error ?? 'Failed to report.');
  };

  return (
    <div
      data-testid="in-match-chat"
      className="pointer-events-auto fixed right-2.5 sm:right-4 top-[54px] sm:top-[58px] z-20 flex flex-col items-end gap-1.5"
    >
      <button
        type="button"
        data-testid="in-match-chat-toggle"
        onClick={() => {
          soundEngine.playUiClick();
          setRoomChatOpen(!roomChatOpen);
        }}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-bold shadow-md transition-colors cursor-pointer whitespace-nowrap ${
          roomChatOpen
            ? 'border-amber-400/60 bg-amber-500/20 text-amber-200'
            : 'border-white/12 bg-[#0b1017]/90 text-slate-200 hover:bg-white/10'
        }`}
      >
        <MessageSquare className="h-3.5 w-3.5 text-amber-400" />
        <span>Chat</span>
        {roomChatUnreadCount > 0 && (
          <span className="rounded bg-amber-500 px-1.5 py-0.2 font-mono text-[10px] font-black text-slate-950">
            {roomChatUnreadCount}
          </span>
        )}
      </button>

      {roomChatOpen && (
        <div className="w-[min(86vw,290px)] rounded-xl border border-white/15 bg-[#0c1219]/95 shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2.5 py-1.5 bg-black/30">
            <span className="text-[11px] font-extrabold text-white truncate">
              Match Chat {opponent ? `· ${opponent.displayName}` : ''}
            </span>
            <div className="flex items-center gap-1">
              {opponent?.playerId && (
                <>
                  <button
                    type="button"
                    title="Report Opponent"
                    onClick={() => setReportOpen((v) => !v)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-white/5 text-slate-300 hover:text-rose-300 cursor-pointer"
                  >
                    <Flag className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="Block Opponent"
                    onClick={handleBlockOpponent}
                    className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-white/5 text-slate-300 hover:text-rose-300 cursor-pointer"
                  >
                    <Ban className="h-3 w-3" />
                  </button>
                </>
              )}
              <button
                type="button"
                aria-label="Close match chat"
                onClick={() => setRoomChatOpen(false)}
                className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-white/5 text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>

          {reportOpen && opponent?.playerId && (
            <div className="flex items-center gap-1.5 border-b border-rose-500/25 bg-rose-950/30 px-2.5 py-1.5 text-[11px]">
              <select
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value as SocialReportReason)}
                className="flex-1 rounded border border-white/15 bg-[#0b1017] px-1.5 py-1 text-[10px] text-white"
              >
                <option value="harassment">Abuse</option>
                <option value="spam">Spam</option>
                <option value="cheating">Cheating</option>
                <option value="other">Other</option>
              </select>
              <button
                type="button"
                onClick={handleReportOpponent}
                className="rounded bg-rose-500 px-2 py-1 text-[10px] font-bold text-white hover:bg-rose-400 cursor-pointer"
              >
                Report
              </button>
            </div>
          )}

          {(localError || actionMsg) && (
            <div className="border-b border-white/10 bg-black/40 px-2.5 py-1 text-[10px] text-amber-300">
              {localError ?? actionMsg}
            </div>
          )}

          <div
            ref={listRef}
            className="max-h-[168px] min-h-[96px] overflow-y-auto space-y-1.5 p-2.5"
          >
            {roomChatMessages.length === 0 ? (
              <div className="py-5 text-center text-[11px] text-slate-400">
                No match messages yet. Good luck!
              </div>
            ) : (
              roomChatMessages.map((m) => {
                const mine = m.senderPlayerId === selfPlayerId;
                return (
                  <div
                    key={m.messageId}
                    className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-lg px-2 py-1 text-[11px] break-words ${
                        mine
                          ? 'bg-amber-500/20 border border-amber-400/35 text-amber-50'
                          : 'bg-white/8 border border-white/10 text-slate-100'
                      }`}
                    >
                      {!mine && (
                        <span className="mr-1 font-bold text-amber-300">{m.senderName}:</span>
                      )}
                      <span>{m.body}</span>
                    </div>
                    <span className="text-[9px] text-slate-500">{formatClock(m.createdAtMs)}</span>
                  </div>
                );
              })
            )}
          </div>

          <form
            onSubmit={handleSend}
            className="flex items-center gap-1.5 border-t border-white/10 bg-black/30 p-2"
          >
            <input
              type="text"
              maxLength={SOCIAL_LIMITS.chatMaxLength}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Send quick chat..."
              className="min-w-0 flex-1 rounded-lg border border-white/12 bg-[#0b1017] px-2 py-1 text-[11px] text-white focus:border-amber-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Send match chat"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
