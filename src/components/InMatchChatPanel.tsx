import { Ban, EyeOff, Flag, MessageSquare, Send, VolumeX, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  const onlineSpectating = useGameStore((s) => s.onlineSpectating);
  const spectatorSessionId = useGameStore((s) => s.spectatorSessionId);
  const spectatorMutedPlayerIds = useGameStore((s) => s.spectatorMutedPlayerIds);
  const toggleMuteSpectatorChatUser = useGameStore((s) => s.toggleMuteSpectatorChatUser);
  const ownProfile = useGameStore((s) => s.ownProfile);
  const roomChatMessages = useGameStore((s) => s.roomChatMessages);
  const roomChatOpen = useGameStore((s) => s.roomChatOpen);
  const roomChatUnreadCount = useGameStore((s) => s.roomChatUnreadCount);
  const setRoomChatOpen = useGameStore((s) => s.setRoomChatOpen);
  const onlineError = useGameStore((s) => s.onlineError);

  const [activeChannel, setActiveChannel] = useState<'match' | 'spectator'>(
    onlineSpectating ? 'spectator' : 'match',
  );
  const [input, setInput] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<{ playerId: string; name: string; excerpt?: string } | null>(null);
  const [reportReason, setReportReason] = useState<SocialReportReason>('harassment');
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setActiveChannel(onlineSpectating ? 'spectator' : 'match');
  }, [onlineSpectating]);

  const mutedSet = useMemo(() => new Set(spectatorMutedPlayerIds), [spectatorMutedPlayerIds]);

  const matchMessages = useMemo(
    () =>
      roomChatMessages.filter(
        (m) => (m.channel ?? 'match') === 'match' && !mutedSet.has(m.senderPlayerId),
      ),
    [roomChatMessages, mutedSet],
  );
  const spectatorMessages = useMemo(
    () =>
      roomChatMessages.filter(
        (m) => m.channel === 'spectator' && !mutedSet.has(m.senderPlayerId),
      ),
    [roomChatMessages, mutedSet],
  );

  const visibleMessages = activeChannel === 'spectator' ? spectatorMessages : matchMessages;

  useEffect(() => {
    const el = listRef.current;
    if (el && roomChatOpen) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visibleMessages.length, roomChatOpen, activeChannel]);

  useEffect(() => {
    if (
      onlineError &&
      (onlineError.code === 'RATE_LIMITED' ||
        onlineError.code === 'BLOCKED_PLAYER' ||
        onlineError.code === 'MESSAGE_TOO_LONG' ||
        onlineError.code === 'SPECTATOR_CHAT_DISABLED')
    ) {
      setLocalError(onlineError.message);
    }
  }, [onlineError]);

  if (screen !== 'playing' || opponentType !== 'online' || replayActive || !onlineRoom) {
    return null;
  }

  const opponent = !onlineSpectating
    ? onlineRoom.players.find((p) => p.sessionId !== onlineSessionId) ?? null
    : null;
  const selfPlayerId = ownProfile?.playerId ?? (onlineSpectating ? spectatorSessionId : onlineSessionId);
  const spectatorChatEnabled = onlineRoom.allowSpectatorChat !== false;
  const canComposeInActiveTab = onlineSpectating
    ? activeChannel === 'spectator' && spectatorChatEnabled
    : activeChannel === 'match';

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canComposeInActiveTab) return;
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

  const handleBlockPlayer = async (playerId: string, name: string) => {
    soundEngine.playUiClick();
    const res = await socialClient.blockPlayer(playerId);
    setActionMsg(res.ok ? `${name} blocked.` : res.error ?? 'Failed to block.');
  };

  const handleReportSubmit = async () => {
    if (!reportTarget) return;
    soundEngine.playUiClick();
    const res = await socialClient.submitReport({
      reportedId: reportTarget.playerId,
      contextType: 'room_chat',
      contextId: onlineRoom.roomId,
      reason: reportReason,
      excerpt: reportTarget.excerpt,
    });
    setReportTarget(null);
    setActionMsg(res.ok ? 'Report submitted.' : res.error ?? 'Failed to report.');
  };

  return (
    <div
      data-testid="in-match-chat"
      className={`pointer-events-auto fixed z-20 flex flex-col items-end gap-1.5 ${
        onlineSpectating
          ? 'right-[52px] sm:right-[60px] top-[96px] sm:top-[64px]'
          : 'right-2.5 sm:right-4 top-[54px] sm:top-[58px]'
      }`}
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
        <span>{onlineSpectating ? 'Broadcast Chat' : 'Chat'}</span>
        {roomChatUnreadCount > 0 && (
          <span className="rounded bg-amber-500 px-1.5 py-0.2 font-mono text-[10px] font-black text-slate-950 tabular-nums">
            {roomChatUnreadCount}
          </span>
        )}
      </button>

      {roomChatOpen && (
        <div className="w-[min(86vw,305px)] rounded-xl border border-white/15 bg-[#0c1219]/95 shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2.5 py-1.5 bg-black/30">
            <span className="text-[11px] font-extrabold text-white truncate">
              {activeChannel === 'spectator'
                ? 'Spectator Chat'
                : opponent
                  ? `Match Chat · ${opponent.displayName}`
                  : 'Match Chat'}
            </span>
            <div className="flex items-center gap-1">
              {opponent?.playerId && (
                <>
                  <button
                    type="button"
                    title="Report Opponent"
                    onClick={() => {
                      const lastMsg = [...matchMessages]
                        .reverse()
                        .find((m) => m.senderPlayerId === opponent.playerId)?.body;
                      setReportTarget((prev) =>
                        prev?.playerId === opponent.playerId
                          ? null
                          : { playerId: opponent.playerId!, name: opponent.displayName, excerpt: lastMsg },
                      );
                    }}
                    className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-white/5 text-slate-300 hover:text-rose-300 cursor-pointer"
                  >
                    <Flag className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="Block Opponent"
                    onClick={() => void handleBlockPlayer(opponent.playerId!, opponent.displayName)}
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

          {/* Separated Channel Tabs */}
          <div className="grid grid-cols-2 gap-1 border-b border-white/10 bg-black/25 p-1">
            <button
              type="button"
              data-testid="chat-channel-match"
              onClick={() => setActiveChannel('match')}
              className={`rounded-md px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                activeChannel === 'match'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Match ({matchMessages.length})
            </button>
            <button
              type="button"
              data-testid="chat-channel-spectator"
              onClick={() => setActiveChannel('spectator')}
              className={`rounded-md px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                activeChannel === 'spectator'
                  ? 'bg-emerald-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Spectators ({spectatorMessages.length})
            </button>
          </div>

          {reportTarget && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-rose-500/25 bg-rose-950/30 px-2.5 py-1.5 text-[11px]">
              <span className="text-[10px] font-semibold text-rose-200 truncate max-w-[110px]">
                Report {reportTarget.name}
              </span>
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
                onClick={() => void handleReportSubmit()}
                className="rounded bg-rose-500 px-2 py-1 text-[10px] font-bold text-white hover:bg-rose-400 cursor-pointer"
              >
                Submit
              </button>
            </div>
          )}

          {(localError || actionMsg) && (
            <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-black/40 px-2.5 py-1 text-[10px] text-amber-300">
              <span>{localError ?? actionMsg}</span>
              <button
                type="button"
                onClick={() => {
                  setLocalError(null);
                  setActionMsg(null);
                }}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {spectatorMutedPlayerIds.length > 0 && (
            <div className="flex items-center justify-between border-b border-white/10 bg-black/25 px-2.5 py-1 text-[10px] text-slate-400">
              <span className="inline-flex items-center gap-1">
                <VolumeX className="h-3 w-3 text-slate-400" />
                {spectatorMutedPlayerIds.length} muted user(s)
              </span>
              <button
                type="button"
                onClick={() => {
                  spectatorMutedPlayerIds.forEach((id) => toggleMuteSpectatorChatUser(id));
                }}
                className="text-amber-300 hover:underline cursor-pointer"
              >
                Unmute All
              </button>
            </div>
          )}

          <div
            ref={listRef}
            className="max-h-[168px] min-h-[96px] overflow-y-auto space-y-1.5 p-2.5"
          >
            {visibleMessages.length === 0 ? (
              <div className="py-5 text-center text-[11px] text-slate-400">
                {activeChannel === 'spectator'
                  ? 'No spectator messages yet.'
                  : 'No match messages yet.'}
              </div>
            ) : (
              visibleMessages.map((m) => {
                const mine = Boolean(selfPlayerId && m.senderPlayerId === selfPlayerId);
                const roleLabel =
                  m.senderRole === 'spectator'
                    ? 'Spec'
                    : m.senderRole === 'player1'
                      ? 'P1'
                      : 'P2';
                return (
                  <div
                    key={m.messageId}
                    className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[92%] rounded-lg px-2 py-1 text-[11px] break-words ${
                        mine
                          ? 'bg-amber-500/20 border border-amber-400/35 text-amber-50'
                          : 'bg-white/8 border border-white/10 text-slate-100'
                      }`}
                    >
                      {!mine && (
                        <span className="mr-1 inline-flex items-center gap-1">
                          <span className="text-[9px] font-mono uppercase text-slate-400">
                            [{roleLabel}]
                          </span>
                          <span className="font-bold text-amber-300">{m.senderName}:</span>
                        </span>
                      )}
                      <span>{m.body}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-slate-500">
                      <span>{formatClock(m.createdAtMs)}</span>
                      {!mine && m.senderPlayerId && (
                        <>
                          <button
                            type="button"
                            title={`Mute ${m.senderName} locally`}
                            onClick={() => toggleMuteSpectatorChatUser(m.senderPlayerId)}
                            className="inline-flex items-center gap-0.5 text-slate-400 hover:text-amber-300 cursor-pointer"
                          >
                            <EyeOff className="h-2.5 w-2.5" />
                            Mute
                          </button>
                          <button
                            type="button"
                            title={`Report ${m.senderName}`}
                            onClick={() =>
                              setReportTarget({
                                playerId: m.senderPlayerId,
                                name: m.senderName,
                                excerpt: m.body,
                              })
                            }
                            className="text-slate-400 hover:text-rose-300 cursor-pointer"
                          >
                            Report
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {canComposeInActiveTab ? (
            <form
              onSubmit={handleSend}
              className="flex items-center gap-1.5 border-t border-white/10 bg-black/30 p-2"
            >
              <input
                type="text"
                data-testid="in-match-chat-input"
                maxLength={SOCIAL_LIMITS.chatMaxLength}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  onlineSpectating ? 'Send spectator chat...' : 'Send match chat...'
                }
                className="min-w-0 flex-1 rounded-lg border border-white/12 bg-[#0b1017] px-2 py-1 text-[11px] text-white focus:border-amber-400 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!input.trim()}
                aria-label="Send chat message"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </form>
          ) : (
            <div className="border-t border-white/10 bg-black/30 px-2.5 py-2 text-center text-[10px] text-slate-400">
              {onlineSpectating && activeChannel === 'spectator' && !spectatorChatEnabled
                ? 'Spectator chat is disabled by the room host.'
                : onlineSpectating
                  ? 'Match chat is read-only for spectators.'
                  : 'Spectator chat is read-only for active players.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

