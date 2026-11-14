import {
  Check,
  Copy,
  Globe,
  History,
  KeyRound,
  Play,
  PlusCircle,
  Search,
  Swords,
  Trophy,
  User,
  UserCheck,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RuleProfileId } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import {
  ONLINE_AVATARS,
  type OnlineAvatarId,
  type OnlineModeIntent,
} from '../multiplayer/shared/protocol';
import { useGameStore } from '../store/useGameStore';

type LobbyTab = OnlineModeIntent | 'history';

export function OnlineLobbyUI() {
  const onlineLobbyOpen = useGameStore((s) => s.onlineLobbyOpen);
  const closeOnlineLobby = useGameStore((s) => s.closeOnlineLobby);
  const onlineModeIntent = useGameStore((s) => s.onlineModeIntent);
  const setOnlineModeIntent = useGameStore((s) => s.setOnlineModeIntent);
  const onlineProfile = useGameStore((s) => s.onlineProfile);
  const onlineConnectionStatus = useGameStore((s) => s.onlineConnectionStatus);
  const onlineSessionId = useGameStore((s) => s.onlineSessionId);
  const onlineLatencyMs = useGameStore((s) => s.onlineLatencyMs);
  const onlineRoom = useGameStore((s) => s.onlineRoom);
  const onlineMatchmaking = useGameStore((s) => s.onlineMatchmaking);
  const onlineError = useGameStore((s) => s.onlineError);
  const setOnlineError = useGameStore((s) => s.setOnlineError);
  const onlineHistory = useGameStore((s) => s.onlineHistory);
  const ownProfile = useGameStore((s) => s.ownProfile);
  const openProgressionModal = useGameStore((s) => s.openProgressionModal);
  const openSocialModal = useGameStore((s) => s.openSocialModal);
  const friends = useGameStore((s) => s.friends);
  const incomingRequests = useGameStore((s) => s.incomingRequests);
  const incomingInvitations = useGameStore((s) => s.incomingInvitations);
  const totalUnreadDmCount = useGameStore((s) => s.totalUnreadDmCount);

  const [activeTab, setActiveTab] = useState<LobbyTab>(onlineModeIntent);
  const [nameInput, setNameInput] = useState(onlineProfile.displayName);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [ruleProfileId, setRuleProfileId] = useState<RuleProfileId>('casual');
  const [copiedCode, setCopiedCode] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setActiveTab(onlineModeIntent);
  }, [onlineModeIntent]);

  useEffect(() => {
    setNameInput(onlineProfile.displayName);
  }, [onlineProfile.displayName]);

  useEffect(() => {
    if (!onlineLobbyOpen) return;
    multiplayerManager.ensureConnected();
  }, [onlineLobbyOpen]);

  useEffect(() => {
    if (!onlineLobbyOpen || !onlineMatchmaking.active) return;
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 500);
    return () => window.clearInterval(id);
  }, [onlineLobbyOpen, onlineMatchmaking.active]);

  useEffect(() => {
    if (onlineLobbyOpen && activeTab === 'history') {
      void multiplayerManager.fetchOnlineHistory();
    }
  }, [onlineLobbyOpen, activeTab]);

  if (!onlineLobbyOpen) return null;

  const commitProfile = (nextName: string, nextAvatar: OnlineAvatarId = onlineProfile.avatarId) => {
    const clean = nextName.trim().slice(0, 16) || 'Player';
    setNameInput(clean);
    multiplayerManager.updateProfile(clean, nextAvatar);
  };

  const handleCopyCode = async () => {
    if (!onlineRoom) return;
    soundEngine.playUiClick();
    try {
      await navigator.clipboard.writeText(onlineRoom.roomCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      setCopiedCode(false);
    }
  };

  const isConnected = onlineConnectionStatus === 'connected' && Boolean(onlineSessionId);
  const calledShotsEnabled = ruleProfileId === 'wpa';

  const localRoomPlayer =
    onlineRoom?.players.find((p) => p.sessionId === onlineSessionId) ?? null;
  const isHost = Boolean(onlineRoom && onlineSessionId && onlineRoom.hostSessionId === onlineSessionId);
  const connectedRoomPlayers = onlineRoom?.players.filter((p) => p.connected) ?? [];
  const bothReady =
    connectedRoomPlayers.length === 2 && connectedRoomPlayers.every((p) => p.ready);

  const searchElapsedSec = onlineMatchmaking.active
    ? Math.max(0, Math.floor((nowMs - onlineMatchmaking.startedAtMs) / 1000))
    : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Online Multiplayer Lobby"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4"
    >
      <div className="w-full max-w-xl max-h-[92vh] overflow-y-auto rounded-2xl border border-white/15 bg-[#0c1219] p-4 sm:p-6 text-slate-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/10">
              <Globe className="h-4.5 w-4.5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-extrabold tracking-tight text-white">
                Online Multiplayer
              </h2>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      onlineConnectionStatus === 'connected'
                        ? 'bg-emerald-400 animate-pulse'
                        : onlineConnectionStatus === 'connecting' ||
                            onlineConnectionStatus === 'reconnecting'
                          ? 'bg-amber-400 animate-pulse'
                          : 'bg-rose-400'
                    }`}
                  />
                  <span className="font-semibold capitalize text-slate-300">
                    {onlineConnectionStatus}
                  </span>
                </span>
                {onlineLatencyMs !== null && isConnected && (
                  <span className="font-mono tabular-nums text-slate-400">
                    {onlineLatencyMs}ms
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {ownProfile && (
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  openProgressionModal('profile');
                }}
                className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-500/20 cursor-pointer whitespace-nowrap"
              >
                <User className="h-3.5 w-3.5 text-amber-400" />
                <span>Lv {ownProfile.level}</span>
                <span className="font-mono">{ownProfile.elo} ELO</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                openSocialModal('friends');
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
            >
              <Users className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden sm:inline">Friends</span>
              {incomingRequests.length + incomingInvitations.length + totalUnreadDmCount > 0 && (
                <span className="rounded bg-amber-500 px-1 py-0.2 font-mono text-[9px] font-black text-slate-950">
                  {incomingRequests.length + incomingInvitations.length + totalUnreadDmCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                openProgressionModal('leaderboard');
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
            >
              <Trophy className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden sm:inline">Leaderboard</span>
            </button>
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                closeOnlineLobby();
              }}
              aria-label="Close online lobby"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Player Identity Strip */}
        <div className="mt-3.5 rounded-xl border border-white/10 bg-black/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex-1 min-w-[160px]">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                Your Player Name
              </label>
              <input
                type="text"
                maxLength={16}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={() => commitProfile(nameInput)}
                className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs font-semibold text-white focus:border-amber-400 focus:outline-none"
                placeholder="Player Name"
              />
            </div>

            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                Avatar
              </div>
              <div className="flex items-center gap-1">
                {ONLINE_AVATARS.map((av) => {
                  const selected = onlineProfile.avatarId === av.id;
                  return (
                    <button
                      key={av.id}
                      type="button"
                      title={av.label}
                      onClick={() => {
                        soundEngine.playUiClick();
                        commitProfile(nameInput, av.id);
                      }}
                      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                        selected
                          ? 'border-amber-400 scale-105 bg-amber-500/15'
                          : 'border-white/10 bg-white/5 opacity-75 hover:opacity-100'
                      }`}
                      style={{ color: av.accent }}
                    >
                      {av.glyph}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Error Alert */}
        {onlineError && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            <span className="min-w-0 break-words">{onlineError.message}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              {!isConnected && (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    multiplayerManager.retryConnection();
                  }}
                  className="rounded-lg border border-rose-400/40 bg-rose-500/20 px-2 py-1 text-[11px] font-bold text-rose-100 hover:bg-rose-500/30 cursor-pointer"
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                onClick={() => setOnlineError(null)}
                className="text-rose-300 hover:text-white cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Active Room Lobby View (Private or Matched) */}
        {onlineRoom ? (
          <div className="mt-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2.5">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                  {onlineRoom.isPrivate ? 'Private Room Code' : 'Matched Room'}
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span
                    data-testid="online-room-code"
                    className="font-mono text-xl font-black tracking-[0.22em] text-white"
                  >
                    {onlineRoom.roomCode}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyCode}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-black/35 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-black/55 cursor-pointer"
                  >
                    {copiedCode ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3 text-amber-400" />
                        Invite / Copy
                      </>
                    )}
                  </button>
                </div>
              </div>

              <div className="text-right">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Status
                </div>
                <div className="text-xs font-bold capitalize text-white">
                  {onlineRoom.players.length < 2
                    ? 'Waiting for opponent...'
                    : bothReady
                      ? 'Both Players Ready'
                      : 'Confirm Readiness'}
                </div>
                <div className="text-[10px] text-slate-400">
                  {onlineRoom.calledShotsEnabled ? 'Strict Called (WPA)' : 'Standard Casual'}
                </div>
              </div>
            </div>

            {/* Player Slots */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {[0, 1].map((slotIdx) => {
                const p = onlineRoom.players[slotIdx] ?? null;
                if (!p) {
                  return (
                    <div
                      key={slotIdx}
                      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-black/25 p-3.5 text-xs font-medium text-slate-400"
                    >
                      <span>Waiting for opponent to join...</span>
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          openSocialModal('friends');
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-amber-400/35 bg-amber-500/12 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-500/20 cursor-pointer"
                      >
                        <Swords className="h-3 w-3" />
                        Invite Friend ({friends.length})
                      </button>
                    </div>
                  );
                }
                const av = ONLINE_AVATARS.find((a) => a.id === p.avatarId) ?? ONLINE_AVATARS[0];
                const isYou = p.sessionId === onlineSessionId;
                return (
                  <div
                    key={p.sessionId}
                    className={`rounded-xl border p-3 ${
                      p.ready
                        ? 'border-emerald-400/50 bg-emerald-500/8'
                        : 'border-white/12 bg-white/5'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 text-sm font-bold"
                          style={{ backgroundColor: `${av.accent}22`, color: av.accent }}
                        >
                          {av.glyph}
                        </span>
                        <div className="min-w-0">
                          <button
                            type="button"
                            disabled={!p.playerId}
                            onClick={() => {
                              if (p.playerId) {
                                soundEngine.playUiClick();
                                openProgressionModal('profile', p.playerId);
                              }
                            }}
                            className="truncate text-left text-xs font-bold text-white hover:underline disabled:no-underline cursor-pointer disabled:cursor-default"
                          >
                            {p.displayName} {isYou ? '(You)' : ''}
                          </button>
                          <div className="text-[10px] text-slate-400">
                            {p.sessionId === onlineRoom.hostSessionId ? 'Host' : 'Challenger'} ·{' '}
                            {p.connected ? `${p.latencyMs}ms` : 'Offline'}
                            {p.playerId ? ' · View Stats' : ''}
                          </div>
                        </div>
                      </div>

                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${
                          p.ready
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                            : 'bg-white/5 text-slate-400 border border-white/10'
                        }`}
                      >
                        {p.ready ? 'Ready' : 'Not Ready'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Room Controls */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {localRoomPlayer && (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    multiplayerManager.setReady(!localRoomPlayer.ready);
                  }}
                  className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider transition-colors cursor-pointer whitespace-nowrap ${
                    localRoomPlayer.ready
                      ? 'border border-emerald-400/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                      : 'border border-amber-400/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                  }`}
                >
                  <UserCheck className="h-4 w-4" />
                  {localRoomPlayer.ready ? 'Ready (Click to Cancel)' : 'Confirm Ready'}
                </button>
              )}

              {isHost && (
                <button
                  type="button"
                  disabled={!bothReady}
                  onClick={() => {
                    soundEngine.playUiClick();
                    multiplayerManager.startRoomMatch();
                  }}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Play className="h-4 w-4 fill-slate-950" />
                  Start Match
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  if (isHost) {
                    multiplayerManager.cancelRoom();
                  } else {
                    multiplayerManager.leaveMatchOrRoom();
                  }
                }}
                className="inline-flex items-center justify-center rounded-xl border border-rose-500/35 bg-rose-500/10 px-3.5 py-2.5 text-xs font-bold text-rose-200 hover:bg-rose-500/20 transition-colors cursor-pointer whitespace-nowrap"
              >
                {isHost ? 'Cancel Room' : 'Leave Room'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Navigation Tabs */}
            <div className="mt-4 grid grid-cols-4 gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
              {(
                [
                  { id: 'quick', label: 'Quick Match', icon: Search },
                  { id: 'create', label: 'Private Room', icon: PlusCircle },
                  { id: 'join', label: 'Join Code', icon: KeyRound },
                  { id: 'history', label: 'History', icon: History },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id || (tab.id === 'create' && activeTab === 'friend');
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      soundEngine.playUiClick();
                      setActiveTab(tab.id);
                      if (tab.id !== 'history') {
                        setOnlineModeIntent(tab.id);
                      }
                    }}
                    className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                      active
                        ? 'bg-amber-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="hidden sm:inline">{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Rule Profile Selector for Quick Match & Create Room */}
            {(activeTab === 'quick' || activeTab === 'create' || activeTab === 'friend') && (
              <div className="mt-3.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={onlineMatchmaking.active}
                  onClick={() => {
                    soundEngine.playUiClick();
                    setRuleProfileId('casual');
                  }}
                  className={`rounded-xl border px-3 py-2 text-left transition-colors cursor-pointer disabled:opacity-50 ${
                    ruleProfileId === 'casual'
                      ? 'border-amber-400/70 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs font-bold">Standard Casual</div>
                  <div className="text-[10px] text-slate-400">Auto pocket · Anywhere BIH</div>
                </button>
                <button
                  type="button"
                  disabled={onlineMatchmaking.active}
                  onClick={() => {
                    soundEngine.playUiClick();
                    setRuleProfileId('wpa');
                  }}
                  className={`rounded-xl border px-3 py-2 text-left transition-colors cursor-pointer disabled:opacity-50 ${
                    ruleProfileId === 'wpa'
                      ? 'border-amber-400/70 bg-amber-500/12 text-white'
                      : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs font-bold">Strict Called (WPA)</div>
                  <div className="text-[10px] text-slate-400">Call ball+pocket · Kitchen break</div>
                </button>
              </div>
            )}

            {/* Tab Panels */}
            {activeTab === 'quick' && (
              <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/25 p-4">
                {onlineMatchmaking.active ? (
                  <div className="flex flex-col items-center text-center gap-2.5 py-2">
                    <div className="inline-flex items-center gap-2 text-xs font-bold text-amber-300">
                      <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                      Searching for an online opponent... ({searchElapsedSec}s)
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Matching players with compatible rule settings and connection quality.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        multiplayerManager.cancelQuickMatch();
                      }}
                      className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer"
                    >
                      Cancel Search
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {onlineMatchmaking.timedOutMessage && (
                      <div className="rounded-lg border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        {onlineMatchmaking.timedOutMessage}
                      </div>
                    )}
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Enter the real-time matchmaking queue to pair with another live player. No bots or simulated opponents.
                    </p>
                    <button
                      type="button"
                      disabled={!isConnected}
                      onClick={() => {
                        soundEngine.playUiClick();
                        commitProfile(nameInput);
                        multiplayerManager.startQuickMatch(ruleProfileId, calledShotsEnabled);
                      }}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-45 transition-colors cursor-pointer"
                    >
                      {isConnected ? (
                        <>
                          <Wifi className="h-4 w-4" />
                          Find Quick Match
                        </>
                      ) : (
                        <>
                          <WifiOff className="h-4 w-4" />
                          Connecting to Server...
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}

            {(activeTab === 'create' || activeTab === 'friend') && (
              <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/25 p-4">
                <div className="flex items-start gap-2.5 text-xs text-slate-300">
                  <Users className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">
                    Create a private room with a unique shareable code. Send the code to a friend and start once both players confirm ready.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!isConnected}
                  onClick={() => {
                    soundEngine.playUiClick();
                    commitProfile(nameInput);
                    multiplayerManager.createPrivateRoom(ruleProfileId, calledShotsEnabled);
                  }}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {isConnected ? (
                    <>
                      <PlusCircle className="h-4 w-4" />
                      Create Private Room
                    </>
                  ) : (
                    <>
                      <WifiOff className="h-4 w-4" />
                      Connecting to Server...
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    openSocialModal('friends');
                  }}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-bold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
                >
                  <Swords className="h-3.5 w-3.5 text-amber-400" />
                  Invite a Friend Directly ({friends.length})
                </button>
              </div>
            )}

            {activeTab === 'join' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  soundEngine.playUiClick();
                  commitProfile(nameInput);
                  multiplayerManager.joinRoom(joinCodeInput);
                }}
                className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/25 p-4"
              >
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                    Enter 6-Character Room Code
                  </label>
                  <input
                    type="text"
                    maxLength={8}
                    value={joinCodeInput}
                    onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                    placeholder="e.g. A7K9P2"
                    className="w-full rounded-xl border border-white/15 bg-[#0b1017] px-3.5 py-2.5 font-mono text-base font-extrabold tracking-[0.25em] text-white uppercase placeholder:tracking-normal placeholder:font-sans placeholder:text-xs placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!isConnected || joinCodeInput.trim().length < 4}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {isConnected ? (
                    <>
                      <KeyRound className="h-4 w-4" />
                      Join Private Room
                    </>
                  ) : (
                    <>
                      <WifiOff className="h-4 w-4" />
                      Connecting to Server...
                    </>
                  )}
                </button>
              </form>
            )}

            {activeTab === 'history' && (
              <div className="mt-4 space-y-2 rounded-xl border border-white/10 bg-black/25 p-3 max-h-[260px] overflow-y-auto">
                {onlineHistory.length === 0 ? (
                  <div className="py-6 text-center text-xs text-slate-400">
                    No completed online matches recorded yet.
                  </div>
                ) : (
                  onlineHistory.map((rec) => (
                    <div
                      key={rec.matchId}
                      className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-white truncate">
                          {rec.player1Name} vs {rec.player2Name}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          Winner: <span className="text-amber-300 font-semibold">{rec.winnerName}</span> · {rec.reason}
                        </div>
                      </div>
                      <span className="font-mono text-[10px] text-slate-400 shrink-0">
                        {rec.totalShots} shots
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
