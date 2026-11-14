import {
  Ban,
  Check,
  Clock,
  Flag,
  MessageSquare,
  Search,
  Send,
  ShieldAlert,
  Swords,
  User,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuleProfileId } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { socialClient } from '../multiplayer/SocialClient';
import { ONLINE_AVATARS } from '../multiplayer/shared/protocol';
import {
  SOCIAL_LIMITS,
  type PresenceStatus,
  type SocialReportReason,
  type SocialSearchPlayerItem,
} from '../multiplayer/shared/social';
import { type SocialTab, useGameStore } from '../store/useGameStore';

export function presenceLabel(status: PresenceStatus): string {
  switch (status) {
    case 'online':
      return 'Online';
    case 'in_match':
      return 'In Match';
    case 'busy':
      return 'Busy';
    case 'offline':
      return 'Offline';
  }
}

export function presenceDotClass(status: PresenceStatus): string {
  switch (status) {
    case 'online':
      return 'bg-emerald-400';
    case 'in_match':
      return 'bg-sky-400';
    case 'busy':
      return 'bg-amber-400';
    case 'offline':
      return 'bg-slate-500';
  }
}

function formatMessageTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function SocialModal() {
  const socialModalOpen = useGameStore((s) => s.socialModalOpen);
  const closeSocialModal = useGameStore((s) => s.closeSocialModal);
  const socialTab = useGameStore((s) => s.socialTab);
  const setSocialTab = useGameStore((s) => s.setSocialTab);
  const activeDmPeerId = useGameStore((s) => s.activeDmPeerId);
  const setActiveDmPeerId = useGameStore((s) => s.setActiveDmPeerId);
  const selfPresence = useGameStore((s) => s.selfPresence);
  const friends = useGameStore((s) => s.friends);
  const incomingRequests = useGameStore((s) => s.incomingRequests);
  const outgoingRequests = useGameStore((s) => s.outgoingRequests);
  const blockedPlayers = useGameStore((s) => s.blockedPlayers);
  const outgoingInvitations = useGameStore((s) => s.outgoingInvitations);
  const dmThreads = useGameStore((s) => s.dmThreads);
  const totalUnreadDmCount = useGameStore((s) => s.totalUnreadDmCount);
  const socialNotice = useGameStore((s) => s.socialNotice);
  const setSocialNotice = useGameStore((s) => s.setSocialNotice);
  const ownProfile = useGameStore((s) => s.ownProfile);
  const openProgressionModal = useGameStore((s) => s.openProgressionModal);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SocialSearchPlayerItem[]>([]);
  const [searching, setSearching] = useState(false);

  const [inviteRule, setInviteRule] = useState<RuleProfileId>('casual');
  const [busyActionId, setBusyActionId] = useState<string | null>(null);

  const [dmInput, setDmInput] = useState('');
  const [dmLoading, setDmLoading] = useState(false);
  const [dmSending, setDmSending] = useState(false);
  const dmScrollRef = useRef<HTMLDivElement | null>(null);

  const [reportTarget, setReportTarget] = useState<{
    playerId: string;
    displayName: string;
    contextType: 'dm' | 'profile';
    excerpt?: string;
  } | null>(null);
  const [reportReason, setReportReason] = useState<SocialReportReason>('harassment');
  const [reportDetails, setReportDetails] = useState('');
  const [reportBusy, setReportBusy] = useState(false);

  const refreshOverview = useCallback(async () => {
    await socialClient.fetchOverview();
  }, []);

  useEffect(() => {
    if (!socialModalOpen) return;
    multiplayerManager.ensureConnected();
    void refreshOverview();
  }, [socialModalOpen, refreshOverview]);

  useEffect(() => {
    if (!socialModalOpen || socialTab !== 'search') return;
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void socialClient.searchPlayers(searchQuery, 20).then((list) => {
        if (!cancelled) {
          setSearchResults(list);
          setSearching(false);
        }
      });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [socialModalOpen, socialTab, searchQuery, friends, incomingRequests, outgoingRequests, blockedPlayers]);

  useEffect(() => {
    if (!socialModalOpen || socialTab !== 'messages') return;
    const targetPeer = activeDmPeerId ?? friends[0]?.playerId ?? null;
    if (!targetPeer) return;
    if (activeDmPeerId !== targetPeer) {
      setActiveDmPeerId(targetPeer);
      return;
    }
    let cancelled = false;
    setDmLoading(true);
    void socialClient.fetchDirectMessages(targetPeer).finally(() => {
      if (!cancelled) setDmLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [socialModalOpen, socialTab, activeDmPeerId, friends, setActiveDmPeerId]);

  const currentMessages = activeDmPeerId ? dmThreads[activeDmPeerId] ?? [] : [];
  useEffect(() => {
    const el = dmScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [currentMessages.length, activeDmPeerId]);

  if (!socialModalOpen) return null;

  const activeDmFriend = friends.find((f) => f.playerId === activeDmPeerId) ?? null;

  const handleSetPresence = async (next: 'online' | 'busy') => {
    soundEngine.playUiClick();
    multiplayerManager.setManualPresence(next);
    const res = await socialClient.setPresence(next);
    if (!res.ok) {
      setSocialNotice({ type: 'err', text: res.error ?? 'Failed to update status.' });
    }
  };

  const handleAddFriend = async (targetPlayerId: string) => {
    soundEngine.playUiClick();
    setBusyActionId(targetPlayerId);
    const res = await socialClient.sendFriendRequest(targetPlayerId);
    setBusyActionId(null);
    if (res.ok) {
      setSocialNotice({
        type: 'ok',
        text:
          res.data?.outcome === 'accepted'
            ? 'Mutual friend request accepted!'
            : 'Friend request sent.',
      });
    } else {
      setSocialNotice({ type: 'err', text: res.error ?? 'Unable to send friend request.' });
    }
  };

  const handleRespondRequest = async (
    targetPlayerId: string,
    action: 'accept' | 'reject' | 'cancel',
  ) => {
    soundEngine.playUiClick();
    setBusyActionId(targetPlayerId);
    const res = await socialClient.respondFriendRequest(targetPlayerId, action);
    setBusyActionId(null);
    if (!res.ok) {
      setSocialNotice({ type: 'err', text: res.error ?? 'Action failed.' });
    }
  };

  const handleRemoveFriend = async (targetPlayerId: string) => {
    soundEngine.playUiClick();
    setBusyActionId(targetPlayerId);
    const res = await socialClient.removeFriend(targetPlayerId);
    setBusyActionId(null);
    if (res.ok) {
      setSocialNotice({ type: 'ok', text: 'Friend removed.' });
    } else {
      setSocialNotice({ type: 'err', text: res.error ?? 'Unable to remove friend.' });
    }
  };

  const handleBlock = async (targetPlayerId: string) => {
    soundEngine.playUiClick();
    setBusyActionId(targetPlayerId);
    const res = await socialClient.blockPlayer(targetPlayerId);
    setBusyActionId(null);
    if (res.ok) {
      setSocialNotice({ type: 'ok', text: 'Player blocked.' });
    } else {
      setSocialNotice({ type: 'err', text: res.error ?? 'Unable to block player.' });
    }
  };

  const handleUnblock = async (targetPlayerId: string) => {
    soundEngine.playUiClick();
    setBusyActionId(targetPlayerId);
    const res = await socialClient.unblockPlayer(targetPlayerId);
    setBusyActionId(null);
    if (res.ok) {
      setSocialNotice({ type: 'ok', text: 'Player unblocked.' });
    } else {
      setSocialNotice({ type: 'err', text: res.error ?? 'Unable to unblock player.' });
    }
  };

  const handleInviteFriend = async (targetPlayerId: string) => {
    soundEngine.playUiClick();
    setBusyActionId(`inv:${targetPlayerId}`);
    multiplayerManager.ensureConnected();
    const res = await socialClient.sendInvite({
      targetPlayerId,
      ruleProfileId: inviteRule,
      calledShotsEnabled: inviteRule === 'wpa',
    });
    setBusyActionId(null);
    if (res.ok) {
      setSocialNotice({ type: 'ok', text: 'Match invitation sent!' });
    } else {
      setSocialNotice({ type: 'err', text: res.error ?? 'Failed to send invitation.' });
    }
  };

  const handleCancelInvite = async (inviteId: string) => {
    soundEngine.playUiClick();
    setBusyActionId(inviteId);
    const res = await socialClient.respondInvite(inviteId, 'cancel');
    setBusyActionId(null);
    if (!res.ok) {
      setSocialNotice({ type: 'err', text: res.error ?? 'Unable to cancel invitation.' });
    }
  };

  const handleSendDm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDmPeerId || dmSending) return;
    const trimmed = dmInput.trim();
    if (!trimmed) return;
    if (trimmed.length > SOCIAL_LIMITS.chatMaxLength) {
      setSocialNotice({
        type: 'err',
        text: `Message cannot exceed ${SOCIAL_LIMITS.chatMaxLength} characters.`,
      });
      return;
    }
    setDmSending(true);
    setSocialNotice(null);
    const res = await socialClient.sendDirectMessage(activeDmPeerId, trimmed);
    setDmSending(false);
    if (res.ok) {
      setDmInput('');
    } else {
      setSocialNotice({ type: 'err', text: res.error ?? 'Message failed to send.' });
    }
  };

  const handleSubmitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportTarget || reportBusy) return;
    setReportBusy(true);
    const res = await socialClient.submitReport({
      reportedId: reportTarget.playerId,
      contextType: reportTarget.contextType,
      reason: reportReason,
      details: reportDetails,
      excerpt: reportTarget.excerpt,
    });
    setReportBusy(false);
    if (res.ok) {
      setSocialNotice({
        type: 'ok',
        text: `Report submitted for ${reportTarget.displayName}.`,
      });
      setReportTarget(null);
      setReportDetails('');
    } else {
      setSocialNotice({ type: 'err', text: res.error ?? 'Unable to submit report.' });
    }
  };

  const pendingReqCount = incomingRequests.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Friends, Invitations & Social Chat"
      data-testid="social-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4"
    >
      <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-2xl border border-white/15 bg-[#0c1219] p-4 sm:p-6 text-slate-100 shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/10">
              <Users className="h-4.5 w-4.5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-extrabold tracking-tight text-white">
                Friends & Social Lounge
              </h2>
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <span className="inline-flex items-center gap-1.5 font-semibold text-slate-200">
                  <span className={`h-2 w-2 rounded-full ${presenceDotClass(selfPresence)}`} />
                  {presenceLabel(selfPresence)}
                </span>
                {ownProfile && (
                  <span className="font-mono text-slate-400">· ID {ownProfile.playerId}</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Presence Toggle */}
            {selfPresence !== 'in_match' && (
              <div className="flex items-center rounded-lg border border-white/10 bg-black/35 p-0.5 text-[11px] font-bold">
                <button
                  type="button"
                  onClick={() => handleSetPresence('online')}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 cursor-pointer ${
                    selfPresence === 'online'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Online
                </button>
                <button
                  type="button"
                  onClick={() => handleSetPresence('busy')}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 cursor-pointer ${
                    selfPresence === 'busy'
                      ? 'bg-amber-500/20 text-amber-300'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  Busy
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                closeSocialModal();
              }}
              aria-label="Close social lounge"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Notice Alert */}
        {socialNotice && (
          <div
            className={`mt-3 flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs ${
              socialNotice.type === 'ok'
                ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
            }`}
          >
            <span>{socialNotice.text}</span>
            <button
              type="button"
              onClick={() => setSocialNotice(null)}
              className="text-current opacity-75 hover:opacity-100 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className="mt-3.5 grid grid-cols-5 gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
          {(
            [
              { id: 'friends', label: `Friends (${friends.length})`, icon: Users },
              { id: 'search', label: 'Find Players', icon: Search },
              {
                id: 'requests',
                label: pendingReqCount > 0 ? `Requests (${pendingReqCount})` : 'Requests',
                icon: UserPlus,
              },
              {
                id: 'messages',
                label: totalUnreadDmCount > 0 ? `Chat (${totalUnreadDmCount})` : 'Chat',
                icon: MessageSquare,
              },
              { id: 'blocked', label: `Blocked (${blockedPlayers.length})`, icon: Ban },
            ] as Array<{ id: SocialTab; label: string; icon: typeof Users }>
          ).map((tab) => {
            const Icon = tab.icon;
            const active = socialTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  setSocialTab(tab.id);
                }}
                className={`flex items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
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

        {/* Report Inline Form */}
        {reportTarget && (
          <form
            onSubmit={handleSubmitReport}
            className="mt-3 rounded-xl border border-rose-500/35 bg-rose-950/25 p-3 space-y-2.5"
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-extrabold text-rose-200">
                <ShieldAlert className="h-4 w-4 text-rose-400" />
                Report {reportTarget.displayName}
              </span>
              <button
                type="button"
                onClick={() => setReportTarget(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value as SocialReportReason)}
                className="rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
              >
                <option value="harassment">Harassment / Abuse</option>
                <option value="spam">Spam / Flooding</option>
                <option value="inappropriate_name">Inappropriate Name</option>
                <option value="cheating">Cheating / Exploits</option>
                <option value="other">Other</option>
              </select>
              <input
                type="text"
                maxLength={240}
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                placeholder="Optional details..."
                className="rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReportTarget(null)}
                className="rounded-lg border border-white/12 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300 hover:bg-white/10 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={reportBusy}
                className="rounded-lg bg-rose-500 px-3 py-1 text-xs font-extrabold text-white hover:bg-rose-400 disabled:opacity-50 cursor-pointer"
              >
                {reportBusy ? 'Submitting...' : 'Submit Report'}
              </button>
            </div>
          </form>
        )}

        {/* Body Panels */}
        <div className="mt-4">
          {socialTab === 'friends' && (
            <div className="space-y-3">
              {/* Rule Selector for Direct Invitations */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  1v1 Invite Ruleset
                </span>
                <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0b1017] p-0.5 text-[11px] font-bold">
                  <button
                    type="button"
                    onClick={() => setInviteRule('casual')}
                    className={`rounded-md px-2.5 py-1 cursor-pointer ${
                      inviteRule === 'casual'
                        ? 'bg-amber-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    Standard Casual
                  </button>
                  <button
                    type="button"
                    onClick={() => setInviteRule('wpa')}
                    className={`rounded-md px-2.5 py-1 cursor-pointer ${
                      inviteRule === 'wpa'
                        ? 'bg-amber-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    Strict WPA
                  </button>
                </div>
              </div>

              {/* Outgoing Pending Invitations */}
              {outgoingInvitations.length > 0 && (
                <div className="space-y-1.5 rounded-xl border border-amber-400/25 bg-amber-500/8 p-2.5">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                    Pending Sent Invitations
                  </div>
                  {outgoingInvitations.map((inv) => (
                    <div
                      key={inv.inviteId}
                      className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs"
                    >
                      <div className="min-w-0 truncate">
                        <span className="font-bold text-white">{inv.recipientName}</span>
                        <span className="ml-2 text-[10px] text-slate-400">
                          {inv.ruleProfileId === 'wpa' ? 'Strict WPA' : 'Casual'} · Waiting...
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={busyActionId === inv.inviteId}
                        onClick={() => handleCancelInvite(inv.inviteId)}
                        className="rounded-md border border-rose-500/35 bg-rose-500/12 px-2 py-0.5 text-[10px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {friends.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-black/25 py-10 text-center space-y-2">
                  <p className="text-xs text-slate-400">
                    You have not added any friends yet.
                  </p>
                  <button
                    type="button"
                    onClick={() => setSocialTab('search')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                  >
                    <Search className="h-3.5 w-3.5" />
                    Find Players
                  </button>
                </div>
              ) : (
                <div className="space-y-2 max-h-[360px] overflow-y-auto">
                  {friends.map((f) => {
                    const av = ONLINE_AVATARS.find((a) => a.id === f.avatarId) ?? ONLINE_AVATARS[0];
                    const alreadyInvited = outgoingInvitations.some(
                      (i) => i.recipientId === f.playerId && i.status === 'pending',
                    );
                    return (
                      <div
                        key={f.playerId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/15 text-sm font-bold"
                            style={{ backgroundColor: `${av.accent}22`, color: av.accent }}
                          >
                            {av.glyph}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-extrabold text-white">
                                {f.displayName}
                              </span>
                              {f.username && (
                                <span className="text-[10px] text-slate-400">@{f.username}</span>
                              )}
                              <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-slate-200">
                                <span className={`h-1.5 w-1.5 rounded-full ${presenceDotClass(f.presence)}`} />
                                {presenceLabel(f.presence)}
                              </span>
                            </div>
                            <div className="text-[10px] font-mono text-slate-400">
                              Lv {f.level} · {f.elo} ELO · {f.playerId}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={alreadyInvited || busyActionId === `inv:${f.playerId}`}
                            onClick={() => handleInviteFriend(f.playerId)}
                            className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                          >
                            <Swords className="h-3 w-3" />
                            {alreadyInvited ? 'Invited' : 'Invite'}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              soundEngine.playUiClick();
                              setActiveDmPeerId(f.playerId);
                              setSocialTab('messages');
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                          >
                            <MessageSquare className="h-3 w-3 text-amber-400" />
                            Chat{f.unreadDmCount > 0 ? ` (${f.unreadDmCount})` : ''}
                          </button>

                          <button
                            type="button"
                            title="View Public Profile"
                            onClick={() => {
                              soundEngine.playUiClick();
                              openProgressionModal('profile', f.playerId);
                            }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 cursor-pointer"
                          >
                            <User className="h-3.5 w-3.5" />
                          </button>

                          <button
                            type="button"
                            title="Remove Friend"
                            disabled={busyActionId === f.playerId}
                            onClick={() => handleRemoveFriend(f.playerId)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:border-rose-400/40 hover:text-rose-300 cursor-pointer"
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                          </button>

                          <button
                            type="button"
                            title="Block Player"
                            disabled={busyActionId === f.playerId}
                            onClick={() => handleBlock(f.playerId)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:border-rose-400/40 hover:text-rose-300 cursor-pointer"
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {socialTab === 'search' && (
            <div className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by display name, @username, or unique player ID (ply_...)..."
                  className="w-full rounded-xl border border-white/15 bg-[#0b1017] pl-9 pr-3.5 py-2 text-xs text-white focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div className="space-y-2 max-h-[340px] overflow-y-auto">
                {searching ? (
                  <div className="py-8 text-center text-xs text-slate-400">Searching players...</div>
                ) : searchResults.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/25 py-8 text-center text-xs text-slate-400">
                    No matching players found.
                  </div>
                ) : (
                  searchResults.map((p) => {
                    const av = ONLINE_AVATARS.find((a) => a.id === p.avatarId) ?? ONLINE_AVATARS[0];
                    return (
                      <div
                        key={p.playerId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 text-xs font-bold"
                            style={{ backgroundColor: `${av.accent}22`, color: av.accent }}
                          >
                            {av.glyph}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-bold text-white">
                                {p.displayName}
                              </span>
                              {p.username && (
                                <span className="text-[10px] text-slate-400">@{p.username}</span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono text-slate-400">
                              Lv {p.level} · {p.elo} ELO · {p.playerId}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5">
                          {p.relationship === 'none' && (
                            <button
                              type="button"
                              disabled={busyActionId === p.playerId}
                              onClick={() => handleAddFriend(p.playerId)}
                              className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
                            >
                              <UserPlus className="h-3 w-3" />
                              Add Friend
                            </button>
                          )}
                          {p.relationship === 'outgoing_request' && (
                            <span className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-300">
                              Request Sent
                            </span>
                          )}
                          {p.relationship === 'incoming_request' && (
                            <button
                              type="button"
                              disabled={busyActionId === p.playerId}
                              onClick={() => handleRespondRequest(p.playerId, 'accept')}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer"
                            >
                              <Check className="h-3 w-3" />
                              Accept Request
                            </button>
                          )}
                          {p.relationship === 'friend' && (
                            <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/35 bg-emerald-500/12 px-2 py-1 text-[10px] font-bold text-emerald-300">
                              <UserCheck className="h-3 w-3" />
                              Friend
                            </span>
                          )}
                          {p.relationship === 'blocked' && (
                            <button
                              type="button"
                              disabled={busyActionId === p.playerId}
                              onClick={() => handleUnblock(p.playerId)}
                              className="rounded-lg border border-rose-400/35 bg-rose-500/12 px-2.5 py-1 text-[10px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer"
                            >
                              Unblock
                            </button>
                          )}

                          <button
                            type="button"
                            title="View Profile"
                            onClick={() => {
                              soundEngine.playUiClick();
                              openProgressionModal('profile', p.playerId);
                            }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 cursor-pointer"
                          >
                            <User className="h-3.5 w-3.5" />
                          </button>

                          {p.relationship !== 'self' && p.relationship !== 'blocked' && (
                            <button
                              type="button"
                              title="Block Player"
                              disabled={busyActionId === p.playerId}
                              onClick={() => handleBlock(p.playerId)}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:border-rose-400/40 hover:text-rose-300 cursor-pointer"
                            >
                              <Ban className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {socialTab === 'requests' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-2">
                  Incoming Friend Requests ({incomingRequests.length})
                </h3>
                {incomingRequests.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/25 py-6 text-center text-xs text-slate-400">
                    No incoming friend requests.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {incomingRequests.map((req) => (
                      <div
                        key={req.requestId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2"
                      >
                        <div>
                          <div className="text-xs font-bold text-white">{req.displayName}</div>
                          <div className="text-[10px] font-mono text-slate-400">
                            Lv {req.level} · {req.elo} ELO · {req.playerId}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busyActionId === req.playerId}
                            onClick={() => handleRespondRequest(req.playerId, 'accept')}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer"
                          >
                            <Check className="h-3 w-3" />
                            Accept
                          </button>
                          <button
                            type="button"
                            disabled={busyActionId === req.playerId}
                            onClick={() => handleRespondRequest(req.playerId, 'reject')}
                            className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer"
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                  Outgoing Friend Requests ({outgoingRequests.length})
                </h3>
                {outgoingRequests.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/25 py-6 text-center text-xs text-slate-400">
                    No pending outgoing requests.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {outgoingRequests.map((req) => (
                      <div
                        key={req.requestId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2"
                      >
                        <div>
                          <div className="text-xs font-bold text-white">{req.displayName}</div>
                          <div className="text-[10px] font-mono text-slate-400">
                            Lv {req.level} · {req.elo} ELO · {req.playerId}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busyActionId === req.playerId}
                          onClick={() => handleRespondRequest(req.playerId, 'cancel')}
                          className="rounded-lg border border-rose-500/35 bg-rose-500/12 px-2.5 py-1 text-[11px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer"
                        >
                          Cancel Request
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {socialTab === 'messages' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 min-h-[320px]">
              {/* Conversation List */}
              <div className="rounded-xl border border-white/10 bg-black/25 p-2 space-y-1 max-h-[360px] overflow-y-auto">
                <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Friends
                </div>
                {friends.length === 0 ? (
                  <div className="px-2 py-6 text-center text-[11px] text-slate-500">
                    Add friends to start messaging.
                  </div>
                ) : (
                  friends.map((f) => {
                    const active = activeDmPeerId === f.playerId;
                    return (
                      <button
                        key={f.playerId}
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          setActiveDmPeerId(f.playerId);
                        }}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors cursor-pointer ${
                          active
                            ? 'bg-amber-500/18 border border-amber-400/40 text-white'
                            : 'hover:bg-white/5 text-slate-300 border border-transparent'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${presenceDotClass(f.presence)}`} />
                          <span className="truncate font-bold">{f.displayName}</span>
                        </div>
                        {f.unreadDmCount > 0 && (
                          <span className="rounded-md bg-amber-500 px-1.5 py-0.2 font-mono text-[10px] font-black text-slate-950">
                            {f.unreadDmCount}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>

              {/* Active DM Thread */}
              <div className="sm:col-span-2 flex flex-col rounded-xl border border-white/10 bg-black/25 overflow-hidden">
                {activeDmFriend ? (
                  <>
                    <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-black/30 px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`h-2 w-2 rounded-full ${presenceDotClass(activeDmFriend.presence)}`}
                        />
                        <span className="truncate text-xs font-extrabold text-white">
                          {activeDmFriend.displayName}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {presenceLabel(activeDmFriend.presence)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleInviteFriend(activeDmFriend.playerId)}
                          className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-1 text-[10px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                        >
                          <Swords className="h-3 w-3" />
                          Invite
                        </button>
                        <button
                          type="button"
                          title="Report Abuse"
                          onClick={() =>
                            setReportTarget({
                              playerId: activeDmFriend.playerId,
                              displayName: activeDmFriend.displayName,
                              contextType: 'dm',
                              excerpt: currentMessages[currentMessages.length - 1]?.body,
                            })
                          }
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-300 hover:text-rose-300 cursor-pointer"
                        >
                          <Flag className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          title="Block Player"
                          onClick={() => handleBlock(activeDmFriend.playerId)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-300 hover:text-rose-300 cursor-pointer"
                        >
                          <Ban className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <div
                      ref={dmScrollRef}
                      className="flex-1 space-y-2 p-3 max-h-[240px] min-h-[190px] overflow-y-auto"
                    >
                      {dmLoading && currentMessages.length === 0 ? (
                        <div className="py-10 text-center text-xs text-slate-400">
                          Loading conversation...
                        </div>
                      ) : currentMessages.length === 0 ? (
                        <div className="py-10 text-center text-xs text-slate-400">
                          No messages yet. Say hello or challenge {activeDmFriend.displayName} to a rack!
                        </div>
                      ) : (
                        currentMessages.map((m) => {
                          const isMine = ownProfile?.playerId === m.senderId;
                          return (
                            <div
                              key={m.messageId}
                              className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                            >
                              <div
                                className={`max-w-[82%] rounded-xl px-3 py-1.5 text-xs break-words ${
                                  isMine
                                    ? 'bg-amber-500/20 border border-amber-400/35 text-amber-50'
                                    : 'bg-white/8 border border-white/10 text-slate-100'
                                }`}
                              >
                                {m.body}
                              </div>
                              <div className="mt-0.5 flex items-center gap-1 text-[9px] text-slate-500">
                                <Clock className="h-2.5 w-2.5" />
                                <span>{formatMessageTime(m.createdAtMs)}</span>
                                {isMine && m.readAtMs && <span>· Read</span>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <form
                      onSubmit={handleSendDm}
                      className="flex items-center gap-2 border-t border-white/10 bg-black/35 p-2.5"
                    >
                      <input
                        type="text"
                        maxLength={SOCIAL_LIMITS.chatMaxLength}
                        value={dmInput}
                        onChange={(e) => setDmInput(e.target.value)}
                        placeholder={`Message ${activeDmFriend.displayName}...`}
                        className="flex-1 rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      />
                      <span className="font-mono text-[10px] text-slate-500 tabular-nums">
                        {dmInput.length}/{SOCIAL_LIMITS.chatMaxLength}
                      </span>
                      <button
                        type="submit"
                        disabled={dmSending || !dmInput.trim()}
                        className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer"
                      >
                        <Send className="h-3.5 w-3.5" />
                        Send
                      </button>
                    </form>
                  </>
                ) : (
                  <div className="flex flex-1 items-center justify-center p-6 text-xs text-slate-400">
                    Select a friend to open private chat.
                  </div>
                )}
              </div>
            </div>
          )}

          {socialTab === 'blocked' && (
            <div className="space-y-2 max-h-[340px] overflow-y-auto">
              {blockedPlayers.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-black/25 py-10 text-center text-xs text-slate-400">
                  No blocked players.
                </div>
              ) : (
                blockedPlayers.map((b) => (
                  <div
                    key={b.playerId}
                    className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5"
                  >
                    <div>
                      <div className="text-xs font-bold text-white">{b.displayName}</div>
                      <div className="text-[10px] font-mono text-slate-400">{b.playerId}</div>
                    </div>
                    <button
                      type="button"
                      disabled={busyActionId === b.playerId}
                      onClick={() => handleUnblock(b.playerId)}
                      className="rounded-lg border border-white/15 bg-white/5 px-3 py-1 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer"
                    >
                      Unblock
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
