import {
  Award,
  Ban,
  Bell,
  Check,
  CheckCheck,
  Clock,
  Crown,
  Edit3,
  Eye,
  Flag,
  Flame,
  LogOut,
  MessageSquare,
  Plus,
  Search,
  Send,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Star,
  Swords,
  Target,
  Trash2,
  Trophy,
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
import { getAvatarVisualMeta } from '../multiplayer/shared/economy';
import {
  getClubRoleLabel,
  isClubOfficerRole,
  SOCIAL_LIMITS,
  type ClubEmblemIcon,
  type ClubJoinMode,
  type ClubLeaderboardScope,
  type ClubRole,
  type FriendRequestPolicy,
  type InviteOrMessagePolicy,
  type NotificationType,
  type PresenceStatus,
  type PrivacySettings,
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
    case 'in_tournament':
      return 'In Tournament';
    case 'spectating':
      return 'Spectating';
    case 'busy':
      return 'Busy';
    case 'offline':
    default:
      return 'Offline';
  }
}

export function presenceDotClass(status: PresenceStatus): string {
  switch (status) {
    case 'online':
      return 'bg-emerald-400';
    case 'in_match':
      return 'bg-sky-400';
    case 'in_tournament':
      return 'bg-amber-300';
    case 'spectating':
      return 'bg-violet-400';
    case 'busy':
      return 'bg-amber-400';
    case 'offline':
    default:
      return 'bg-slate-500';
  }
}

function formatLastSeen(lastSeenAtMs: number | null, status: PresenceStatus): string {
  if (status !== 'offline') return presenceLabel(status);
  if (!lastSeenAtMs || lastSeenAtMs <= 0) return 'Offline';
  const diffMin = Math.max(0, Math.floor((Date.now() - lastSeenAtMs) / 60_000));
  if (diffMin < 1) return 'Seen just now';
  if (diffMin < 60) return `Seen ${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `Seen ${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `Seen ${diffDay}d ago`;
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

function renderClubEmblem(icon: ClubEmblemIcon, color: string, sizeClass = 'h-4 w-4') {
  const style = { color };
  switch (icon) {
    case 'crown':
      return <Crown className={sizeClass} style={style} />;
    case 'flame':
      return <Flame className={sizeClass} style={style} />;
    case 'star':
      return <Star className={sizeClass} style={style} />;
    case 'swords':
      return <Swords className={sizeClass} style={style} />;
    case 'target':
      return <Target className={sizeClass} style={style} />;
    case 'shield':
    default:
      return <Shield className={sizeClass} style={style} />;
  }
}

function notificationMeta(type: NotificationType): { label: string; tab?: SocialTab } {
  switch (type) {
    case 'friend_request':
      return { label: 'Friend Request', tab: 'requests' };
    case 'friend_response':
      return { label: 'Friend Update', tab: 'friends' };
    case 'match_invite':
      return { label: 'Match Invite', tab: 'friends' };
    case 'club_invite':
      return { label: 'Club Invite', tab: 'requests' };
    case 'club_join_request':
      return { label: 'Club Membership', tab: 'clubs' };
    case 'private_message':
      return { label: 'Direct Message', tab: 'messages' };
    case 'club_challenge':
      return { label: 'Club Challenge', tab: 'clubs' };
    case 'tournament_event':
    default:
      return { label: 'Tournament' };
  }
}

const CLUB_COLOR_PRESETS = ['#f59e0b', '#10b981', '#38bdf8', '#f43f5e', '#a78bfa', '#fb923c'];
const CLUB_ICONS: Array<{ id: ClubEmblemIcon; label: string }> = [
  { id: 'shield', label: 'Shield' },
  { id: 'crown', label: 'Crown' },
  { id: 'flame', label: 'Flame' },
  { id: 'star', label: 'Star' },
  { id: 'swords', label: 'Swords' },
  { id: 'target', label: 'Target' },
];

export function SocialModal() {
  const socialModalOpen = useGameStore((s) => s.socialModalOpen);
  const closeSocialModal = useGameStore((s) => s.closeSocialModal);
  const socialTab = useGameStore((s) => s.socialTab);
  const setSocialTab = useGameStore((s) => s.setSocialTab);
  const activeDmPeerId = useGameStore((s) => s.activeDmPeerId);
  const setActiveDmPeerId = useGameStore((s) => s.setActiveDmPeerId);
  const selfPresence = useGameStore((s) => s.selfPresence);
  const friends = useGameStore((s) => s.friends);
  const friendsTotal = useGameStore((s) => s.friendsTotal);
  const incomingRequests = useGameStore((s) => s.incomingRequests);
  const outgoingRequests = useGameStore((s) => s.outgoingRequests);
  const blockedPlayers = useGameStore((s) => s.blockedPlayers);
  const outgoingInvitations = useGameStore((s) => s.outgoingInvitations);
  const dmThreads = useGameStore((s) => s.dmThreads);
  const totalUnreadDmCount = useGameStore((s) => s.totalUnreadDmCount);
  const socialNotice = useGameStore((s) => s.socialNotice);
  const setSocialNotice = useGameStore((s) => s.setSocialNotice);
  const ownProfile = useGameStore((s) => s.ownProfile);
  const onlineRoom = useGameStore((s) => s.onlineRoom);
  const openProgressionModal = useGameStore((s) => s.openProgressionModal);
  const openClubLeagueModal = useGameStore((s) => s.openClubLeagueModal);

  const privacySettings = useGameStore((s) => s.privacySettings);
  const notifications = useGameStore((s) => s.notifications);
  const unreadNotificationCount = useGameStore((s) => s.unreadNotificationCount);
  const myClub = useGameStore((s) => s.myClub);
  const clubDetail = useGameStore((s) => s.clubDetail);
  const clubsList = useGameStore((s) => s.clubsList);
  const incomingClubInvitations = useGameStore((s) => s.incomingClubInvitations);
  const clubLeaderboard = useGameStore((s) => s.clubLeaderboard);
  const clubLeaderboardScope = useGameStore((s) => s.clubLeaderboardScope);

  const [friendFilter, setFriendFilter] = useState('');
  const [loadingMoreFriends, setLoadingMoreFriends] = useState(false);

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

  // Clubs tab UI state
  const [clubSubView, setClubSubView] = useState<'my_club' | 'directory' | 'create'>('my_club');
  const [clubSearch, setClubSearch] = useState('');
  const [newClubName, setNewClubName] = useState('');
  const [newClubTag, setNewClubTag] = useState('');
  const [newClubDesc, setNewClubDesc] = useState('');
  const [newClubColor, setNewClubColor] = useState('#f59e0b');
  const [newClubIcon, setNewClubIcon] = useState<ClubEmblemIcon>('shield');
  const [newClubJoinMode, setNewClubJoinMode] = useState<ClubJoinMode>('public');
  const [editingClub, setEditingClub] = useState(false);
  const [editClubDesc, setEditClubDesc] = useState('');
  const [editClubColor, setEditClubColor] = useState('#f59e0b');
  const [editClubIcon, setEditClubIcon] = useState<ClubEmblemIcon>('shield');
  const [editClubJoinMode, setEditClubJoinMode] = useState<ClubJoinMode>('public');
  const [clubInviteTargetId, setClubInviteTargetId] = useState('');
  const [challengeModalOpen, setChallengeModalOpen] = useState(false);
  const [challengeTargetClubId, setChallengeTargetClubId] = useState('');
  const [challengeTargetWins, setChallengeTargetWins] = useState(3);
  const [challengeRule, setChallengeRule] = useState<RuleProfileId>('casual');
  const [challengeNotes, setChallengeNotes] = useState('');

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

  useEffect(() => {
    if (!socialModalOpen || socialTab !== 'clubs') return;
    void socialClient.listClubs(clubSearch, 30);
    if (myClub?.clubId && (!clubDetail || clubDetail.club.clubId !== myClub.clubId)) {
      void socialClient.getClubDetail(myClub.clubId);
    }
  }, [socialModalOpen, socialTab, clubSearch, myClub?.clubId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!socialModalOpen || socialTab !== 'club_rankings') return;
    void socialClient.fetchClubLeaderboard(clubLeaderboardScope, 30);
  }, [socialModalOpen, socialTab, clubLeaderboardScope]);

  useEffect(() => {
    if (!socialModalOpen || socialTab !== 'notifications') return;
    void socialClient.fetchNotifications({ limit: 40 });
  }, [socialModalOpen, socialTab]);

  useEffect(() => {
    if (!socialModalOpen || socialTab !== 'privacy') return;
    void socialClient.fetchPrivacySettings();
  }, [socialModalOpen, socialTab]);

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

  const handleInviteFriend = async (
    targetPlayerId: string,
    inviteKind: 'match' | 'spectate' = 'match',
    roomId?: string,
  ) => {
    soundEngine.playUiClick();
    setBusyActionId(`inv:${inviteKind}:${targetPlayerId}`);
    multiplayerManager.ensureConnected();
    const res = await socialClient.sendInvite({
      targetPlayerId,
      ruleProfileId: inviteRule,
      calledShotsEnabled: inviteRule === 'wpa',
      inviteKind,
      roomId,
    });
    setBusyActionId(null);
    if (res.ok) {
      setSocialNotice({
        type: 'ok',
        text: inviteKind === 'spectate' ? 'Spectate invite sent!' : 'Match invitation sent!',
      });
    } else {
      setSocialNotice({ type: 'err', text: res.error ?? 'Failed to send invitation.' });
    }
  };

  const handleJoinFriendRoom = async (friendPlayerId: string) => {
    soundEngine.playUiClick();
    setBusyActionId(`joinroom:${friendPlayerId}`);
    await multiplayerManager.joinFriendRoom(friendPlayerId);
    setBusyActionId(null);
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

  const handleCreateClub = async (e: React.FormEvent) => {
    e.preventDefault();
    soundEngine.playUiClick();
    setBusyActionId('create-club');
    const res = await socialClient.createClub({
      name: newClubName,
      tag: newClubTag,
      description: newClubDesc,
      emblemColor: newClubColor,
      emblemIcon: newClubIcon,
      joinMode: newClubJoinMode,
    });
    setBusyActionId(null);
    if (res.ok) {
      setNewClubName('');
      setNewClubTag('');
      setNewClubDesc('');
      setClubSubView('my_club');
      setSocialNotice({ type: 'ok', text: `Club [${res.data?.club.tag}] created!` });
    } else {
      setSocialNotice({ type: 'err', text: res.error ?? 'Unable to create club.' });
    }
  };

  const handleUpdatePrivacy = async (partial: Partial<PrivacySettings>) => {
    soundEngine.playUiClick();
    setBusyActionId('privacy-save');
    const res = await socialClient.updatePrivacySettings(partial);
    setBusyActionId(null);
    if (res.ok) {
      setSocialNotice({ type: 'ok', text: 'Privacy settings saved.' });
    } else {
      setSocialNotice({ type: 'err', text: res.error ?? 'Failed to save privacy settings.' });
    }
  };

  const pendingReqCount = incomingRequests.length + incomingClubInvitations.length;
  const filteredFriends = friendFilter.trim()
    ? friends.filter((f) => {
        const q = friendFilter.trim().toLowerCase();
        return (
          f.displayName.toLowerCase().includes(q) ||
          (f.username && f.username.toLowerCase().includes(q)) ||
          f.playerId.toLowerCase().includes(q) ||
          (f.club && f.club.tag.toLowerCase().includes(q))
        );
      })
    : friends;

  const canSendSpectateInvite = Boolean(onlineRoom && onlineRoom.allowSpectators !== false);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Friends, Clubs, Notifications & Social Community"
      data-testid="social-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4"
    >
      <div className="w-full max-w-4xl max-h-[92dvh] modal-scroll-y rounded-2xl border border-white/15 bg-[#0c1219] p-4 sm:p-6 text-slate-100 shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/10">
              <Users className="h-4.5 w-4.5 text-amber-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-extrabold tracking-tight text-white">
                  Social, Clubs & Community
                </h2>
                {myClub && (
                  <span
                    className="rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-black"
                    style={{
                      borderColor: `${myClub.emblemColor}66`,
                      backgroundColor: `${myClub.emblemColor}20`,
                      color: myClub.emblemColor,
                    }}
                  >
                    [{myClub.tag}]
                  </span>
                )}
              </div>
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
            {selfPresence !== 'in_match' && selfPresence !== 'in_tournament' && (
              <div className="flex items-center rounded-lg border border-white/10 bg-black/35 p-0.5 text-[11px] font-bold">
                <button
                  type="button"
                  onClick={() => handleSetPresence('online')}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 cursor-pointer whitespace-nowrap ${
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
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 cursor-pointer whitespace-nowrap ${
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

        {/* Navigation Tabs */}
        <div className="mt-3.5 grid grid-cols-4 sm:grid-cols-8 gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
          {(
            [
              { id: 'friends', label: `Friends (${friends.length})`, icon: Users },
              { id: 'search', label: 'Find', icon: Search },
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
              { id: 'clubs', label: myClub ? `[${myClub.tag}]` : 'Clubs', icon: Shield },
              { id: 'club_rankings', label: 'Club Ranks', icon: Trophy },
              {
                id: 'notifications',
                label: unreadNotificationCount > 0 ? `Alerts (${unreadNotificationCount})` : 'Alerts',
                icon: Bell,
              },
              { id: 'privacy', label: 'Safety', icon: ShieldCheck },
            ] as Array<{ id: SocialTab; label: string; icon: typeof Users }>
          ).map((tab) => {
            const Icon = tab.icon;
            const active = socialTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`social-tab-${tab.id}`}
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
                <span className="truncate">{tab.label}</span>
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
                className="rounded-lg border border-white/12 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300 hover:bg-white/10 cursor-pointer whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={reportBusy}
                className="rounded-lg bg-rose-500 px-3 py-1 text-xs font-extrabold text-white hover:bg-rose-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                {reportBusy ? 'Submitting...' : 'Submit Report'}
              </button>
            </div>
          </form>
        )}

        {/* Body Panels */}
        <div className="mt-4">
          {/* 1. FRIENDS TAB */}
          {socialTab === 'friends' && (
            <div className="space-y-3">
              {/* Rule Selector + Filter */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2">
                <div className="relative flex-1 min-w-[160px] max-w-xs">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={friendFilter}
                    onChange={(e) => setFriendFilter(e.target.value)}
                    placeholder="Filter friends or [TAG]..."
                    className="w-full rounded-lg border border-white/10 bg-[#0b1017] pl-8 pr-2.5 py-1 text-xs text-white focus:border-amber-400 focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    1v1 Rules
                  </span>
                  <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0b1017] p-0.5 text-[11px] font-bold">
                    <button
                      type="button"
                      onClick={() => setInviteRule('casual')}
                      className={`rounded-md px-2 py-1 cursor-pointer whitespace-nowrap ${
                        inviteRule === 'casual'
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      Casual
                    </button>
                    <button
                      type="button"
                      onClick={() => setInviteRule('wpa')}
                      className={`rounded-md px-2 py-1 cursor-pointer whitespace-nowrap ${
                        inviteRule === 'wpa'
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      WPA
                    </button>
                  </div>
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
                          {inv.inviteKind === 'spectate' ? 'Spectate Invite' : inv.ruleProfileId === 'wpa' ? 'Strict WPA' : 'Casual'} · Waiting...
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={busyActionId === inv.inviteId}
                        onClick={() => handleCancelInvite(inv.inviteId)}
                        className="rounded-md border border-rose-500/35 bg-rose-500/12 px-2 py-0.5 text-[10px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap"
                      >
                        Cancel
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {friends.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-black/25 py-10 text-center space-y-2">
                  <p className="text-xs text-slate-400">You have not added any friends yet.</p>
                  <button
                    type="button"
                    onClick={() => setSocialTab('search')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                  >
                    <Search className="h-3.5 w-3.5" />
                    Find Players
                  </button>
                </div>
              ) : (
                <div className="space-y-2 max-h-[360px] overflow-y-auto">
                  {filteredFriends.map((f) => {
                    const av = getAvatarVisualMeta(f.avatarId);
                    const alreadyInvited = outgoingInvitations.some(
                      (i) => i.recipientId === f.playerId && i.status === 'pending',
                    );
                    const canSpectateFriend =
                      f.presence === 'in_match' || Boolean(f.activeRoom?.spectatable);
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
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-xs font-extrabold text-white">
                                {f.displayName}
                              </span>
                              {f.club && (
                                <span
                                  className="rounded border px-1 py-0.2 font-mono text-[9px] font-black"
                                  style={{
                                    borderColor: `${f.club.emblemColor}66`,
                                    backgroundColor: `${f.club.emblemColor}18`,
                                    color: f.club.emblemColor,
                                  }}
                                >
                                  [{f.club.tag}]
                                </span>
                              )}
                              {f.username && (
                                <span className="text-[10px] text-slate-400">@{f.username}</span>
                              )}
                              <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-slate-200">
                                <span className={`h-1.5 w-1.5 rounded-full ${presenceDotClass(f.presence)}`} />
                                {formatLastSeen(f.lastSeenAtMs, f.presence)}
                              </span>
                            </div>
                            <div className="text-[10px] font-mono tabular-nums text-slate-400">
                              Lv {f.level} · {f.elo} ELO · {f.playerId}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {f.activeRoom?.joinable && (
                            <button
                              type="button"
                              disabled={busyActionId === `joinroom:${f.playerId}`}
                              onClick={() => handleJoinFriendRoom(f.playerId)}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-emerald-400 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                            >
                              <Swords className="h-3 w-3" />
                              Join Room
                            </button>
                          )}

                          {canSpectateFriend && (
                            <button
                              type="button"
                              disabled={busyActionId === `watch:${f.playerId}`}
                              onClick={() => {
                                soundEngine.playUiClick();
                                setBusyActionId(`watch:${f.playerId}`);
                                void multiplayerManager
                                  .joinSpectate({
                                    roomId: f.activeRoom?.roomId,
                                    targetPlayerId: f.playerId,
                                    returnTarget: 'menu',
                                  })
                                  .then((res) => {
                                    if (res.ok) {
                                      closeSocialModal();
                                    } else {
                                      setSocialNotice({
                                        type: 'err',
                                        text:
                                          res.error ??
                                          'Friend match cannot be spectated (private or ended).',
                                      });
                                    }
                                  })
                                  .finally(() => setBusyActionId(null));
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-amber-400/45 bg-amber-500/15 px-2.5 py-1 text-[11px] font-extrabold text-amber-200 hover:bg-amber-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                            >
                              <Eye className="h-3 w-3 text-amber-400" />
                              Watch
                            </button>
                          )}

                          {canSendSpectateInvite && onlineRoom && (
                            <button
                              type="button"
                              disabled={alreadyInvited || busyActionId === `inv:spectate:${f.playerId}`}
                              onClick={() =>
                                handleInviteFriend(f.playerId, 'spectate', onlineRoom.roomId)
                              }
                              className="inline-flex items-center gap-1 rounded-lg border border-violet-400/40 bg-violet-500/15 px-2 py-1 text-[11px] font-bold text-violet-200 hover:bg-violet-500/25 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                            >
                              <Eye className="h-3 w-3" />
                              Invite Watch
                            </button>
                          )}

                          <button
                            type="button"
                            disabled={alreadyInvited || busyActionId === `inv:match:${f.playerId}`}
                            onClick={() => handleInviteFriend(f.playerId, 'match')}
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

                  {friends.length < friendsTotal && (
                    <div className="pt-1 flex justify-center">
                      <button
                        type="button"
                        disabled={loadingMoreFriends}
                        onClick={async () => {
                          setLoadingMoreFriends(true);
                          await socialClient.fetchFriendsPaginated({
                            limit: 25,
                            offset: friends.length,
                          });
                          setLoadingMoreFriends(false);
                        }}
                        className="rounded-lg border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                      >
                        {loadingMoreFriends
                          ? 'Loading...'
                          : `Load More Friends (${friends.length}/${friendsTotal})`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 2. FIND PLAYERS TAB */}
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
                    const av = getAvatarVisualMeta(p.avatarId);
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
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-xs font-bold text-white">
                                {p.displayName}
                              </span>
                              {p.club && (
                                <span
                                  className="rounded border px-1 py-0.2 font-mono text-[9px] font-black"
                                  style={{
                                    borderColor: `${p.club.emblemColor}66`,
                                    backgroundColor: `${p.club.emblemColor}18`,
                                    color: p.club.emblemColor,
                                  }}
                                >
                                  [{p.club.tag}]
                                </span>
                              )}
                              {p.username && (
                                <span className="text-[10px] text-slate-400">@{p.username}</span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono tabular-nums text-slate-400">
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
                              className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                            >
                              <UserPlus className="h-3 w-3" />
                              Add Friend
                            </button>
                          )}
                          {p.relationship === 'outgoing_request' && (
                            <span className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-300 whitespace-nowrap">
                              Request Sent
                            </span>
                          )}
                          {p.relationship === 'incoming_request' && (
                            <button
                              type="button"
                              disabled={busyActionId === p.playerId}
                              onClick={() => handleRespondRequest(p.playerId, 'accept')}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer whitespace-nowrap"
                            >
                              <Check className="h-3 w-3" />
                              Accept Request
                            </button>
                          )}
                          {p.relationship === 'friend' && (
                            <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/35 bg-emerald-500/12 px-2 py-1 text-[10px] font-bold text-emerald-300 whitespace-nowrap">
                              <UserCheck className="h-3 w-3" />
                              Friend
                            </span>
                          )}
                          {p.relationship === 'blocked' && (
                            <button
                              type="button"
                              disabled={busyActionId === p.playerId}
                              onClick={() => handleUnblock(p.playerId)}
                              className="rounded-lg border border-rose-400/35 bg-rose-500/12 px-2.5 py-1 text-[10px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap"
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

          {/* 3. REQUESTS & CLUB INVITES TAB */}
          {socialTab === 'requests' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-2">
                  Incoming Friend Requests ({incomingRequests.length})
                </h3>
                {incomingRequests.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/25 py-5 text-center text-xs text-slate-400">
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
                          <div className="text-[10px] font-mono tabular-nums text-slate-400">
                            Lv {req.level} · {req.elo} ELO · {req.playerId}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busyActionId === req.playerId}
                            onClick={() => handleRespondRequest(req.playerId, 'accept')}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer whitespace-nowrap"
                          >
                            <Check className="h-3 w-3" />
                            Accept
                          </button>
                          <button
                            type="button"
                            disabled={busyActionId === req.playerId}
                            onClick={() => handleRespondRequest(req.playerId, 'reject')}
                            className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
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
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-2">
                  Incoming Club Invitations ({incomingClubInvitations.length})
                </h3>
                {incomingClubInvitations.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/25 py-5 text-center text-xs text-slate-400">
                    No pending club invitations.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {incomingClubInvitations.map((cinv) => (
                      <div
                        key={cinv.inviteId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-black/40">
                            {renderClubEmblem(cinv.emblemIcon, cinv.emblemColor)}
                          </div>
                          <div className="min-w-0">
                            <div className="text-xs font-extrabold text-white truncate">
                              [{cinv.clubTag}] {cinv.clubName}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              Invited by {cinv.inviterName}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busyActionId === cinv.inviteId}
                            onClick={async () => {
                              soundEngine.playUiClick();
                              setBusyActionId(cinv.inviteId);
                              const res = await socialClient.respondClubInvite(
                                cinv.inviteId,
                                'accept',
                              );
                              setBusyActionId(null);
                              if (res.ok) {
                                setSocialNotice({
                                  type: 'ok',
                                  text: `Joined [${cinv.clubTag}] ${cinv.clubName}!`,
                                });
                                setSocialTab('clubs');
                              } else {
                                setSocialNotice({
                                  type: 'err',
                                  text: res.error ?? 'Unable to accept club invite.',
                                });
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer whitespace-nowrap"
                          >
                            <Check className="h-3 w-3" />
                            Join Club
                          </button>
                          <button
                            type="button"
                            disabled={busyActionId === cinv.inviteId}
                            onClick={async () => {
                              soundEngine.playUiClick();
                              setBusyActionId(cinv.inviteId);
                              await socialClient.respondClubInvite(cinv.inviteId, 'reject');
                              setBusyActionId(null);
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
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
                  <div className="rounded-xl border border-white/10 bg-black/25 py-5 text-center text-xs text-slate-400">
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
                          <div className="text-[10px] font-mono tabular-nums text-slate-400">
                            Lv {req.level} · {req.elo} ELO · {req.playerId}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busyActionId === req.playerId}
                          onClick={() => handleRespondRequest(req.playerId, 'cancel')}
                          className="rounded-lg border border-rose-500/35 bg-rose-500/12 px-2.5 py-1 text-[11px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap"
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

          {/* 4. MESSAGES TAB */}
          {socialTab === 'messages' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 min-h-[320px]">
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
                          onClick={() => handleInviteFriend(activeDmFriend.playerId, 'match')}
                          className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-1 text-[10px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
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
                        className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer whitespace-nowrap"
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

          {/* 5. CLUBS TAB */}
          {socialTab === 'clubs' && (
            <div className="space-y-3">
              {/* Sub-view Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(clubDetail || myClub) && (
                    <button
                      type="button"
                      onClick={() => {
                        setClubSubView('my_club');
                        if (myClub) void socialClient.getClubDetail(myClub.clubId);
                      }}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-bold cursor-pointer whitespace-nowrap ${
                        clubSubView === 'my_club'
                          ? 'bg-amber-500 text-slate-950'
                          : 'bg-white/5 text-slate-300 hover:text-white'
                      }`}
                    >
                      {myClub ? `My Club [${myClub.tag}]` : 'Club Details'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setClubSubView('directory');
                      void socialClient.listClubs(clubSearch, 30);
                    }}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-bold cursor-pointer whitespace-nowrap ${
                      clubSubView === 'directory' || (!myClub && !clubDetail && clubSubView === 'my_club')
                        ? 'bg-amber-500 text-slate-950'
                        : 'bg-white/5 text-slate-300 hover:text-white'
                    }`}
                  >
                    Browse Clubs ({clubsList.length})
                  </button>
                  {!myClub && (
                    <button
                      type="button"
                      onClick={() => setClubSubView('create')}
                      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-bold cursor-pointer whitespace-nowrap ${
                        clubSubView === 'create'
                          ? 'bg-amber-500 text-slate-950'
                          : 'bg-white/5 text-slate-300 hover:text-white'
                      }`}
                    >
                      <Plus className="h-3 w-3" />
                      Create Club
                    </button>
                  )}
                </div>

                {myClub && (
                  <button
                    type="button"
                    onClick={() => setSocialTab('club_rankings')}
                    className="inline-flex items-center gap-1 rounded-lg border border-amber-400/35 bg-amber-500/12 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-500/20 cursor-pointer whitespace-nowrap"
                  >
                    <Trophy className="h-3 w-3 text-amber-400" />
                    Club Leaderboard
                  </button>
                )}
              </div>

              {/* Create Club View */}
              {clubSubView === 'create' && !myClub ? (
                <form
                  onSubmit={handleCreateClub}
                  className="rounded-xl border border-white/10 bg-black/25 p-4 space-y-3"
                >
                  <h3 className="text-xs font-extrabold uppercase tracking-wider text-amber-400">
                    Establish a New Pool Club
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div className="sm:col-span-2">
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        Club Name (3–28 chars)
                      </label>
                      <input
                        type="text"
                        required
                        minLength={3}
                        maxLength={28}
                        value={newClubName}
                        onChange={(e) => setNewClubName(e.target.value)}
                        placeholder="e.g. Emerald Cue Syndicate"
                        className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-3 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        Tag (2–5 chars)
                      </label>
                      <input
                        type="text"
                        required
                        minLength={2}
                        maxLength={5}
                        value={newClubTag}
                        onChange={(e) => setNewClubTag(e.target.value.toUpperCase())}
                        placeholder="ECS"
                        className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-3 py-1.5 font-mono text-xs font-bold uppercase text-white focus:border-amber-400 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Club Motto / Description
                    </label>
                    <input
                      type="text"
                      maxLength={180}
                      value={newClubDesc}
                      onChange={(e) => setNewClubDesc(e.target.value)}
                      placeholder="Competitive 8-ball cueists striving for precision..."
                      className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-3 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        Emblem Color
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {CLUB_COLOR_PRESETS.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setNewClubColor(c)}
                            className={`h-6 w-6 rounded-lg border-2 cursor-pointer ${
                              newClubColor === c ? 'border-white scale-105' : 'border-transparent'
                            }`}
                            style={{ backgroundColor: c }}
                            aria-label={`Select color ${c}`}
                          />
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        Emblem Icon
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {CLUB_ICONS.map((ic) => (
                          <button
                            key={ic.id}
                            type="button"
                            title={ic.label}
                            onClick={() => setNewClubIcon(ic.id)}
                            className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border cursor-pointer ${
                              newClubIcon === ic.id
                                ? 'border-amber-400 bg-amber-500/15'
                                : 'border-white/10 bg-white/5'
                            }`}
                          >
                            {renderClubEmblem(ic.id, newClubColor, 'h-3.5 w-3.5')}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        Membership Policy
                      </div>
                      <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-[#0b1017] p-0.5 text-[11px] font-bold">
                        <button
                          type="button"
                          onClick={() => setNewClubJoinMode('public')}
                          className={`rounded-md py-1 cursor-pointer ${
                            newClubJoinMode === 'public'
                              ? 'bg-amber-500 text-slate-950'
                              : 'text-slate-300'
                          }`}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          onClick={() => setNewClubJoinMode('approval')}
                          className={`rounded-md py-1 cursor-pointer ${
                            newClubJoinMode === 'approval'
                              ? 'bg-amber-500 text-slate-950'
                              : 'text-slate-300'
                          }`}
                        >
                          Approval
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="submit"
                      disabled={busyActionId === 'create-club' || !newClubName.trim() || !newClubTag.trim()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {busyActionId === 'create-club' ? 'Creating...' : 'Create Club'}
                    </button>
                  </div>
                </form>
              ) : clubSubView === 'my_club' && clubDetail ? (
                <div className="space-y-3 max-h-[420px] overflow-y-auto pr-0.5">
                  {/* Club Banner Card */}
                  <div className="rounded-xl border border-white/10 bg-black/30 p-3.5 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border"
                          style={{
                            borderColor: `${clubDetail.club.emblemColor}66`,
                            backgroundColor: `${clubDetail.club.emblemColor}1a`,
                          }}
                        >
                          {renderClubEmblem(
                            clubDetail.club.emblemIcon,
                            clubDetail.club.emblemColor,
                            'h-5 w-5',
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className="rounded border px-1.5 py-0.5 font-mono text-[10px] font-black"
                              style={{
                                borderColor: `${clubDetail.club.emblemColor}66`,
                                color: clubDetail.club.emblemColor,
                              }}
                            >
                              [{clubDetail.club.tag}]
                            </span>
                            <h3 className="truncate text-sm font-extrabold text-white">
                              {clubDetail.club.name}
                            </h3>
                            <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold text-slate-300">
                              {clubDetail.club.joinMode === 'public' ? 'Open Club' : 'Approval Required'}
                            </span>
                          </div>
                          {clubDetail.club.description && (
                            <p className="mt-1 text-xs text-slate-300">
                              {clubDetail.club.description}
                            </p>
                          )}
                          <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10px] tabular-nums text-slate-400">
                            <span>{clubDetail.club.memberCount} Members</span>
                            <span>·</span>
                            <span>Rating {clubDetail.club.clubRating}</span>
                            <span>·</span>
                            <span>
                              {clubDetail.club.totalWins}W / {clubDetail.club.totalMatches}M
                            </span>
                            <span>·</span>
                            <span>{clubDetail.club.challengeWins} Challenge Wins</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            soundEngine.playUiClick();
                            closeSocialModal();
                            openClubLeagueModal('teams');
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-extrabold text-emerald-200 hover:bg-emerald-500/25 cursor-pointer whitespace-nowrap"
                        >
                          <Trophy className="h-3 w-3 text-emerald-400" />
                          Teams & Leagues
                        </button>
                        {isClubOfficerRole(clubDetail.viewerRole) && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setChallengeTargetClubId(
                                  clubsList.find((c) => c.clubId !== clubDetail.club.clubId)
                                    ?.clubId ?? '',
                                );
                                setChallengeModalOpen((v) => !v);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                            >
                              <Swords className="h-3 w-3" />
                              Challenge Club
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditClubDesc(clubDetail.club.description);
                                setEditClubColor(clubDetail.club.emblemColor);
                                setEditClubIcon(clubDetail.club.emblemIcon);
                                setEditClubJoinMode(clubDetail.club.joinMode);
                                setEditingClub((v) => !v);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                            >
                              <Edit3 className="h-3 w-3" />
                              Settings
                            </button>
                          </>
                        )}
                        {clubDetail.viewerRole ? (
                          <button
                            type="button"
                            disabled={busyActionId === 'leave-club'}
                            onClick={async () => {
                              soundEngine.playUiClick();
                              setBusyActionId('leave-club');
                              const res = await socialClient.leaveClub(clubDetail.club.clubId);
                              setBusyActionId(null);
                              if (res.ok) {
                                setClubSubView('directory');
                                setSocialNotice({ type: 'ok', text: 'Left club.' });
                              } else {
                                setSocialNotice({
                                  type: 'err',
                                  text: res.error ?? 'Unable to leave club.',
                                });
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-rose-500/35 bg-rose-500/12 px-2.5 py-1 text-[11px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap"
                          >
                            <LogOut className="h-3 w-3" />
                            Leave
                          </button>
                        ) : !myClub ? (
                          <button
                            type="button"
                            disabled={
                              clubDetail.viewerHasPendingRequest ||
                              busyActionId === `join:${clubDetail.club.clubId}`
                            }
                            onClick={async () => {
                              soundEngine.playUiClick();
                              setBusyActionId(`join:${clubDetail.club.clubId}`);
                              const res = await socialClient.joinClub(clubDetail.club.clubId);
                              setBusyActionId(null);
                              if (res.ok) {
                                setSocialNotice({
                                  type: 'ok',
                                  text:
                                    res.data?.outcome === 'requested'
                                      ? 'Join request sent to club officers.'
                                      : `Joined [${clubDetail.club.tag}]!`,
                                });
                                void socialClient.getClubDetail(clubDetail.club.clubId);
                              } else {
                                setSocialNotice({
                                  type: 'err',
                                  text: res.error ?? 'Unable to join club.',
                                });
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                          >
                            {clubDetail.viewerHasPendingRequest
                              ? 'Request Pending'
                              : clubDetail.club.joinMode === 'public'
                                ? 'Join Club'
                                : 'Request to Join'}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* Officer Settings Drawer */}
                    {editingClub && isClubOfficerRole(clubDetail.viewerRole) && (
                        <div className="rounded-xl border border-white/10 bg-[#0b1017] p-3 space-y-2.5">
                          <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                            Update Club Settings
                          </div>
                          <input
                            type="text"
                            maxLength={180}
                            value={editClubDesc}
                            onChange={(e) => setEditClubDesc(e.target.value)}
                            placeholder="Club description..."
                            className="w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-xs text-white"
                          />
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="flex gap-1">
                              {CLUB_COLOR_PRESETS.map((c) => (
                                <button
                                  key={c}
                                  type="button"
                                  onClick={() => setEditClubColor(c)}
                                  className={`h-5 w-5 rounded border-2 cursor-pointer ${
                                    editClubColor === c ? 'border-white' : 'border-transparent'
                                  }`}
                                  style={{ backgroundColor: c }}
                                />
                              ))}
                            </div>
                            <div className="flex gap-1">
                              {CLUB_ICONS.map((ic) => (
                                <button
                                  key={ic.id}
                                  type="button"
                                  onClick={() => setEditClubIcon(ic.id)}
                                  className={`h-6 w-6 inline-flex items-center justify-center rounded border cursor-pointer ${
                                    editClubIcon === ic.id
                                      ? 'border-amber-400 bg-amber-500/15'
                                      : 'border-white/10'
                                  }`}
                                >
                                  {renderClubEmblem(ic.id, editClubColor, 'h-3 w-3')}
                                </button>
                              ))}
                            </div>
                            <select
                              value={editClubJoinMode}
                              onChange={(e) => setEditClubJoinMode(e.target.value as ClubJoinMode)}
                              className="rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-xs text-white"
                            >
                              <option value="public">Open Join</option>
                              <option value="approval">Approval Required</option>
                            </select>
                            <button
                              type="button"
                              disabled={busyActionId === 'update-club'}
                              onClick={async () => {
                                setBusyActionId('update-club');
                                const res = await socialClient.updateClub(
                                  clubDetail.club.clubId,
                                  {
                                    description: editClubDesc,
                                    emblemColor: editClubColor,
                                    emblemIcon: editClubIcon,
                                    joinMode: editClubJoinMode,
                                  },
                                );
                                setBusyActionId(null);
                                if (res.ok) {
                                  setEditingClub(false);
                                  setSocialNotice({ type: 'ok', text: 'Club settings updated.' });
                                } else {
                                  setSocialNotice({
                                    type: 'err',
                                    text: res.error ?? 'Unable to update club.',
                                  });
                                }
                              }}
                              className="ml-auto rounded-lg bg-amber-500 px-3 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                            >
                              Save Changes
                            </button>
                          </div>
                        </div>
                      )}

                    {/* Club Challenge Creator */}
                    {challengeModalOpen && isClubOfficerRole(clubDetail.viewerRole) && (
                        <div className="rounded-xl border border-amber-400/35 bg-amber-500/8 p-3 space-y-2.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-extrabold uppercase tracking-wider text-amber-300">
                              Issue Inter-Club Challenge
                            </span>
                            <button
                              type="button"
                              onClick={() => setChallengeModalOpen(false)}
                              className="text-slate-400 hover:text-white cursor-pointer"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <select
                              value={challengeTargetClubId}
                              onChange={(e) => setChallengeTargetClubId(e.target.value)}
                              className="rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                            >
                              <option value="">Select Opponent Club...</option>
                              {clubsList
                                .filter((c) => c.clubId !== clubDetail.club.clubId)
                                .map((c) => (
                                  <option key={c.clubId} value={c.clubId}>
                                    [{c.tag}] {c.name} ({c.clubRating})
                                  </option>
                                ))}
                            </select>
                            <select
                              value={challengeTargetWins}
                              onChange={(e) =>
                                setChallengeTargetWins(Number.parseInt(e.target.value, 10) || 3)
                              }
                              className="rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                            >
                              <option value={1}>First to 1 Win (Bo1)</option>
                              <option value={2}>First to 2 Wins (Bo3)</option>
                              <option value={3}>First to 3 Wins (Bo5)</option>
                              <option value={5}>First to 5 Wins (Bo9)</option>
                            </select>
                            <select
                              value={challengeRule}
                              onChange={(e) => setChallengeRule(e.target.value as RuleProfileId)}
                              className="rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                            >
                              <option value="casual">Standard Casual</option>
                              <option value="wpa">Strict Called (WPA)</option>
                            </select>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              maxLength={120}
                              value={challengeNotes}
                              onChange={(e) => setChallengeNotes(e.target.value)}
                              placeholder="Optional challenge message..."
                              className="flex-1 rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                            />
                            <button
                              type="button"
                              disabled={!challengeTargetClubId || busyActionId === 'send-challenge'}
                              onClick={async () => {
                                setBusyActionId('send-challenge');
                                const res = await socialClient.createClubChallenge({
                                  challengerClubId: clubDetail.club.clubId,
                                  targetClubId: challengeTargetClubId,
                                  ruleProfileId: challengeRule,
                                  calledShotsEnabled: challengeRule === 'wpa',
                                  targetWins: challengeTargetWins,
                                  notes: challengeNotes,
                                });
                                setBusyActionId(null);
                                if (res.ok) {
                                  setChallengeModalOpen(false);
                                  setChallengeNotes('');
                                  setSocialNotice({
                                    type: 'ok',
                                    text: 'Club challenge issued!',
                                  });
                                } else {
                                  setSocialNotice({
                                    type: 'err',
                                    text: res.error ?? 'Failed to issue challenge.',
                                  });
                                }
                              }}
                              className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                            >
                              Send Challenge
                            </button>
                          </div>
                        </div>
                      )}

                    {/* Officer Invite Bar */}
                    {isClubOfficerRole(clubDetail.viewerRole) && (
                      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-white/10">
                        <input
                          type="text"
                          value={clubInviteTargetId}
                          onChange={(e) => setClubInviteTargetId(e.target.value)}
                          placeholder="Invite player by ID (ply_...) or pick friend..."
                          list="club-friend-invite-list"
                          className="flex-1 min-w-[180px] rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                        />
                        <datalist id="club-friend-invite-list">
                          {friends.map((f) => (
                            <option key={f.playerId} value={f.playerId}>
                              {f.displayName} ({f.elo} ELO)
                            </option>
                          ))}
                        </datalist>
                        <button
                          type="button"
                          disabled={!clubInviteTargetId.trim() || busyActionId === 'club-invite'}
                          onClick={async () => {
                            setBusyActionId('club-invite');
                            const res = await socialClient.inviteToClub(
                              clubDetail.club.clubId,
                              clubInviteTargetId.trim(),
                            );
                            setBusyActionId(null);
                            if (res.ok) {
                              setClubInviteTargetId('');
                              setSocialNotice({ type: 'ok', text: 'Club invitation sent!' });
                            } else {
                              setSocialNotice({
                                type: 'err',
                                text: res.error ?? 'Unable to invite player.',
                              });
                            }
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/25 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                        >
                          <UserPlus className="h-3.5 w-3.5" />
                          Invite to Club
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Pending Join Requests (Officers) */}
                  {isClubOfficerRole(clubDetail.viewerRole) &&
                    clubDetail.joinRequests.length > 0 && (
                      <div className="rounded-xl border border-amber-400/30 bg-amber-500/8 p-3 space-y-2">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                          Pending Membership Applications ({clubDetail.joinRequests.length})
                        </div>
                        {clubDetail.joinRequests.map((jr) => (
                          <div
                            key={jr.requestId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs"
                          >
                            <div>
                              <span className="font-bold text-white">{jr.displayName}</span>
                              <span className="ml-2 font-mono text-[10px] text-slate-400">
                                Lv {jr.level} · {jr.elo} ELO
                              </span>
                              {jr.message && (
                                <div className="text-[11px] text-slate-300">{jr.message}</div>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={busyActionId === jr.requestId}
                                onClick={async () => {
                                  setBusyActionId(jr.requestId);
                                  await socialClient.respondClubJoinRequest(
                                    clubDetail.club.clubId,
                                    jr.requestId,
                                    'accept',
                                  );
                                  setBusyActionId(null);
                                }}
                                className="rounded-md bg-emerald-500 px-2.5 py-1 text-[10px] font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer whitespace-nowrap"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={busyActionId === jr.requestId}
                                onClick={async () => {
                                  setBusyActionId(jr.requestId);
                                  await socialClient.respondClubJoinRequest(
                                    clubDetail.club.clubId,
                                    jr.requestId,
                                    'reject',
                                  );
                                  setBusyActionId(null);
                                }}
                                className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                  {/* Club Challenges */}
                  {clubDetail.challenges.length > 0 && (
                    <div className="rounded-xl border border-white/10 bg-black/25 p-3 space-y-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                        Club Challenges ({clubDetail.challenges.length})
                      </div>
                      <div className="space-y-1.5">
                        {clubDetail.challenges.map((ch) => {
                          const isTarget = ch.targetClubId === clubDetail.club.clubId;
                          const isOfficer = isClubOfficerRole(clubDetail.viewerRole);
                          return (
                            <div
                              key={ch.challengeId}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs"
                            >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-extrabold text-white">
                                    [{ch.challengerClubTag}] vs [{ch.targetClubTag}]
                                  </span>
                                  <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-amber-300 tabular-nums">
                                    {ch.challengerScore} – {ch.targetScore} (First to {ch.targetWins})
                                  </span>
                                  <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase text-slate-300">
                                    {ch.status}
                                  </span>
                                </div>
                                <div className="text-[10px] text-slate-400 mt-0.5">
                                  {ch.ruleProfileId === 'wpa' ? 'Strict WPA' : 'Casual'} ·{' '}
                                  {ch.linkedMatchIds.length} verified match(es) recorded
                                  {ch.notes ? ` · ${ch.notes}` : ''}
                                </div>
                              </div>

                              {isOfficer && ch.status === 'pending' && (
                                <div className="flex items-center gap-1.5">
                                  {isTarget ? (
                                    <>
                                      <button
                                        type="button"
                                        disabled={busyActionId === ch.challengeId}
                                        onClick={async () => {
                                          setBusyActionId(ch.challengeId);
                                          await socialClient.respondClubChallenge(
                                            ch.challengeId,
                                            'accept',
                                          );
                                          setBusyActionId(null);
                                        }}
                                        className="rounded-md bg-emerald-500 px-2.5 py-1 text-[10px] font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer whitespace-nowrap"
                                      >
                                        Accept
                                      </button>
                                      <button
                                        type="button"
                                        disabled={busyActionId === ch.challengeId}
                                        onClick={async () => {
                                          setBusyActionId(ch.challengeId);
                                          await socialClient.respondClubChallenge(
                                            ch.challengeId,
                                            'decline',
                                          );
                                          setBusyActionId(null);
                                        }}
                                        className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-200 cursor-pointer whitespace-nowrap"
                                      >
                                        Decline
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="button"
                                      disabled={busyActionId === ch.challengeId}
                                      onClick={async () => {
                                        setBusyActionId(ch.challengeId);
                                        await socialClient.respondClubChallenge(
                                          ch.challengeId,
                                          'cancel',
                                        );
                                        setBusyActionId(null);
                                      }}
                                      className="rounded-md border border-rose-500/35 bg-rose-500/12 px-2.5 py-1 text-[10px] font-bold text-rose-200 cursor-pointer whitespace-nowrap"
                                    >
                                      Cancel
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Member Roster */}
                  <div className="rounded-xl border border-white/10 bg-black/25 p-3 space-y-2">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Roster ({clubDetail.members.length})
                    </div>
                    <div className="space-y-1.5">
                      {clubDetail.members.map((m) => {
                        const isSelf = ownProfile?.playerId === m.playerId;
                        const canManageRole =
                          !isSelf &&
                          (clubDetail.viewerRole === 'owner' ||
                            (clubDetail.viewerRole === 'president' &&
                              m.role !== 'owner' &&
                              m.role !== 'president'));
                        const canKick =
                          !isSelf &&
                          (clubDetail.viewerRole === 'owner' ||
                            (clubDetail.viewerRole === 'president' &&
                              m.role !== 'owner' &&
                              m.role !== 'president') ||
                            ((clubDetail.viewerRole === 'vice_president' ||
                              clubDetail.viewerRole === 'admin') &&
                              (m.role === 'member' || m.role === 'captain')));
                        return (
                          <div
                            key={m.playerId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-xs"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`h-2 w-2 shrink-0 rounded-full ${presenceDotClass(m.presence)}`}
                              />
                              <span className="truncate font-bold text-white">{m.displayName}</span>
                              <span
                                className={`rounded px-1.5 py-0.2 text-[9px] font-black uppercase ${
                                  m.role === 'owner'
                                    ? 'bg-amber-500/25 text-amber-300'
                                    : isClubOfficerRole(m.role)
                                      ? 'bg-sky-500/20 text-sky-300'
                                      : m.role === 'captain'
                                        ? 'bg-emerald-500/20 text-emerald-300'
                                        : 'bg-white/10 text-slate-300'
                                }`}
                              >
                                {getClubRoleLabel(m.role)}
                              </span>
                              <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                                {m.elo} ELO · {m.wins}W
                              </span>
                            </div>

                            <div className="flex items-center gap-1">
                              {canManageRole && (
                                <>
                                  <select
                                    value={m.role === 'admin' ? 'vice_president' : m.role}
                                    disabled={busyActionId === `role:${m.playerId}`}
                                    onChange={async (e) => {
                                      setBusyActionId(`role:${m.playerId}`);
                                      await socialClient.updateClubMemberRole(
                                        clubDetail.club.clubId,
                                        m.playerId,
                                        e.target.value as ClubRole,
                                      );
                                      setBusyActionId(null);
                                    }}
                                    className="rounded border border-white/15 bg-[#0b1017] px-1.5 py-0.5 text-[10px] font-bold text-slate-200 cursor-pointer"
                                  >
                                    {clubDetail.viewerRole === 'owner' && (
                                      <option value="president">President</option>
                                    )}
                                    <option value="vice_president">Vice President</option>
                                    <option value="captain">Captain</option>
                                    <option value="member">Member</option>
                                  </select>
                                  {clubDetail.viewerRole === 'owner' && (
                                    <button
                                      type="button"
                                      disabled={busyActionId === `owner:${m.playerId}`}
                                      onClick={async () => {
                                        setBusyActionId(`owner:${m.playerId}`);
                                        await socialClient.updateClubMemberRole(
                                          clubDetail.club.clubId,
                                          m.playerId,
                                          'owner',
                                        );
                                        setBusyActionId(null);
                                      }}
                                      className="rounded border border-amber-400/35 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-200 hover:bg-amber-500/20 cursor-pointer whitespace-nowrap"
                                    >
                                      Make Owner
                                    </button>
                                  )}
                                </>
                              )}
                              {canKick && (
                                <button
                                  type="button"
                                  disabled={busyActionId === `kick:${m.playerId}`}
                                  onClick={async () => {
                                    setBusyActionId(`kick:${m.playerId}`);
                                    await socialClient.kickClubMember(
                                      clubDetail.club.clubId,
                                      m.playerId,
                                    );
                                    setBusyActionId(null);
                                  }}
                                  className="rounded border border-rose-500/35 bg-rose-500/12 px-2 py-0.5 text-[10px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap"
                                >
                                  Kick
                                </button>
                              )}
                              <button
                                type="button"
                                title="View Profile"
                                onClick={() => openProgressionModal('profile', m.playerId)}
                                className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 cursor-pointer"
                              >
                                <User className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Club Activity Log */}
                  {clubDetail.recentActivity.length > 0 && (
                    <div className="rounded-xl border border-white/10 bg-black/25 p-3 space-y-1.5">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Recent Club Activity
                      </div>
                      {clubDetail.recentActivity.slice(0, 8).map((act) => (
                        <div
                          key={act.activityId}
                          className="flex items-center justify-between gap-2 text-[11px] text-slate-300"
                        >
                          <span className="truncate">{act.summary}</span>
                          <span className="font-mono text-[10px] text-slate-500 shrink-0">
                            {formatMessageTime(act.createdAtMs)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                /* Browse Clubs Directory */
                <div className="space-y-2.5">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={clubSearch}
                      onChange={(e) => setClubSearch(e.target.value)}
                      placeholder="Search clubs by name or tag..."
                      className="w-full rounded-xl border border-white/15 bg-[#0b1017] pl-9 pr-3 py-2 text-xs text-white focus:border-amber-400 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-2 max-h-[340px] overflow-y-auto">
                    {clubsList.length === 0 ? (
                      <div className="rounded-xl border border-white/10 bg-black/25 py-8 text-center text-xs text-slate-400">
                        No clubs found yet. Be the first to establish one!
                      </div>
                    ) : (
                      clubsList.map((c) => {
                        const isMine = myClub?.clubId === c.clubId;
                        return (
                          <div
                            key={c.clubId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                                style={{
                                  borderColor: `${c.emblemColor}66`,
                                  backgroundColor: `${c.emblemColor}1a`,
                                }}
                              >
                                {renderClubEmblem(c.emblemIcon, c.emblemColor)}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span
                                    className="font-mono text-[10px] font-black"
                                    style={{ color: c.emblemColor }}
                                  >
                                    [{c.tag}]
                                  </span>
                                  <span className="truncate text-xs font-extrabold text-white">
                                    {c.name}
                                  </span>
                                  <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.2 text-[9px] font-bold text-slate-300">
                                    {c.joinMode === 'public' ? 'Open' : 'Approval'}
                                  </span>
                                </div>
                                <div className="text-[10px] font-mono tabular-nums text-slate-400">
                                  {c.memberCount} Members · {c.clubRating} Rating · {c.totalWins}W
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={async () => {
                                  await socialClient.getClubDetail(c.clubId);
                                  setClubSubView('my_club');
                                }}
                                className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                              >
                                {isMine ? 'Open Club' : 'Inspect'}
                              </button>
                              {!myClub && (
                                <button
                                  type="button"
                                  disabled={busyActionId === `join:${c.clubId}`}
                                  onClick={async () => {
                                    setBusyActionId(`join:${c.clubId}`);
                                    const res = await socialClient.joinClub(c.clubId);
                                    setBusyActionId(null);
                                    if (res.ok) {
                                      setSocialNotice({
                                        type: 'ok',
                                        text:
                                          res.data?.outcome === 'requested'
                                            ? `Join request sent to [${c.tag}].`
                                            : `Joined [${c.tag}] ${c.name}!`,
                                      });
                                      if (res.data?.outcome === 'joined') {
                                        setClubSubView('my_club');
                                      }
                                    } else {
                                      setSocialNotice({
                                        type: 'err',
                                        text: res.error ?? 'Unable to join club.',
                                      });
                                    }
                                  }}
                                  className="rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                                >
                                  {c.joinMode === 'public' ? 'Join' : 'Apply'}
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
            </div>
          )}

          {/* 6. CLUB RANKINGS TAB */}
          {socialTab === 'club_rankings' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
                  Club Leaderboards (Verified Matches)
                </span>
                <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0b1017] p-0.5 text-[11px] font-bold">
                  {(
                    [
                      { id: 'global', label: 'Global' },
                      { id: 'weekly', label: 'Weekly' },
                      { id: 'seasonal', label: 'Seasonal' },
                    ] as Array<{ id: ClubLeaderboardScope; label: string }>
                  ).map((sc) => (
                    <button
                      key={sc.id}
                      type="button"
                      onClick={() => void socialClient.fetchClubLeaderboard(sc.id, 30)}
                      className={`rounded-md px-2.5 py-1 cursor-pointer whitespace-nowrap ${
                        clubLeaderboardScope === sc.id
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {sc.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5 max-h-[360px] overflow-y-auto">
                {clubLeaderboard.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/25 py-10 text-center text-xs text-slate-400">
                    No ranked clubs yet.
                  </div>
                ) : (
                  clubLeaderboard.map((entry) => {
                    const canChallenge =
                      myClub &&
                      myClub.clubId !== entry.clubId &&
                      (myClub.role === 'owner' || myClub.role === 'admin');
                    return (
                      <div
                        key={entry.clubId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="w-7 text-center font-mono text-xs font-black tabular-nums text-amber-300">
                            #{entry.rank}
                          </span>
                          <div
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
                            style={{
                              borderColor: `${entry.emblemColor}66`,
                              backgroundColor: `${entry.emblemColor}1a`,
                            }}
                          >
                            {renderClubEmblem(entry.emblemIcon, entry.emblemColor, 'h-4 w-4')}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span
                                className="font-mono text-[10px] font-black"
                                style={{ color: entry.emblemColor }}
                              >
                                [{entry.tag}]
                              </span>
                              <span className="truncate text-xs font-extrabold text-white">
                                {entry.name}
                              </span>
                            </div>
                            <div className="text-[10px] font-mono tabular-nums text-slate-400">
                              {entry.memberCount} Members · {entry.periodWins} Period Wins ·{' '}
                              {entry.challengeWins} Challenge Wins
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <div className="text-right font-mono tabular-nums">
                            <div className="text-xs font-black text-amber-300">
                              {entry.clubRating}
                            </div>
                            <div className="text-[9px] uppercase text-slate-400">Club Rating</div>
                          </div>
                          {canChallenge && (
                            <button
                              type="button"
                              onClick={() => {
                                setChallengeTargetClubId(entry.clubId);
                                setChallengeModalOpen(true);
                                setClubSubView('my_club');
                                setSocialTab('clubs');
                                if (myClub) void socialClient.getClubDetail(myClub.clubId);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[10px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                            >
                              <Swords className="h-3 w-3" />
                              Challenge
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

          {/* 7. NOTIFICATIONS CENTER TAB */}
          {socialTab === 'notifications' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2">
                <span className="text-xs font-bold text-slate-200">
                  Notifications ({unreadNotificationCount} unread)
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={unreadNotificationCount === 0}
                    onClick={() => void socialClient.markNotificationsRead()}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    <CheckCheck className="h-3.5 w-3.5 text-emerald-400" />
                    Mark All Read
                  </button>
                  <button
                    type="button"
                    disabled={notifications.length === 0}
                    onClick={() => void socialClient.clearNotifications()}
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-500/35 bg-rose-500/12 px-2.5 py-1 text-[11px] font-bold text-rose-200 hover:bg-rose-500/20 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear All
                  </button>
                </div>
              </div>

              <div className="space-y-2 max-h-[360px] overflow-y-auto">
                {notifications.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/25 py-10 text-center text-xs text-slate-400">
                    No notifications right now.
                  </div>
                ) : (
                  notifications.map((n) => {
                    const meta = notificationMeta(n.type);
                    const unread = n.readAtMs === null;
                    return (
                      <div
                        key={n.notificationId}
                        className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 ${
                          unread
                            ? 'border-amber-400/45 bg-amber-500/10'
                            : 'border-white/10 bg-black/25'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.2 text-[9px] font-bold uppercase tracking-wider text-amber-300">
                              {meta.label}
                            </span>
                            <span className="text-xs font-extrabold text-white">{n.title}</span>
                            <span className="font-mono text-[10px] text-slate-500">
                              {formatMessageTime(n.createdAtMs)}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-slate-300">{n.body}</p>
                        </div>

                        <div className="flex items-center gap-1.5">
                          {meta.tab && (
                            <button
                              type="button"
                              onClick={() => {
                                if (unread) {
                                  void socialClient.markNotificationsRead(n.notificationId);
                                }
                                setSocialTab(meta.tab!);
                              }}
                              className="rounded-lg bg-amber-500 px-2.5 py-1 text-[10px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                            >
                              View
                            </button>
                          )}
                          {unread && (
                            <button
                              type="button"
                              onClick={() => void socialClient.markNotificationsRead(n.notificationId)}
                              className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[10px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                            >
                              Mark Read
                            </button>
                          )}
                          <button
                            type="button"
                            title="Dismiss notification"
                            onClick={() => void socialClient.clearNotifications(n.notificationId)}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-400 hover:text-white cursor-pointer"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* 8. PRIVACY & SAFETY TAB */}
          {socialTab === 'privacy' && (
            <div className="space-y-4 max-h-[420px] overflow-y-auto pr-0.5">
              {/* Server-Enforced Privacy Controls */}
              <div className="rounded-xl border border-white/10 bg-black/25 p-3.5 space-y-3">
                <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-amber-400">
                  <Settings className="h-3.5 w-3.5" />
                  Privacy Preferences
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Friend Requests
                    </label>
                    <select
                      data-testid="privacy-friend-requests"
                      disabled={busyActionId === 'privacy-save'}
                      value={privacySettings.allowFriendRequests}
                      onChange={(e) =>
                        handleUpdatePrivacy({
                          allowFriendRequests: e.target.value as FriendRequestPolicy,
                        })
                      }
                      className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="everyone">Everyone</option>
                      <option value="nobody">No One</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Match Invites
                    </label>
                    <select
                      data-testid="privacy-match-invites"
                      disabled={busyActionId === 'privacy-save'}
                      value={privacySettings.allowMatchInvites}
                      onChange={(e) =>
                        handleUpdatePrivacy({
                          allowMatchInvites: e.target.value as InviteOrMessagePolicy,
                        })
                      }
                      className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="everyone">Everyone</option>
                      <option value="friends">Friends Only</option>
                      <option value="nobody">No One</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Direct Messages
                    </label>
                    <select
                      data-testid="privacy-direct-messages"
                      disabled={busyActionId === 'privacy-save'}
                      value={privacySettings.allowDirectMessages}
                      onChange={(e) =>
                        handleUpdatePrivacy({
                          allowDirectMessages: e.target.value as InviteOrMessagePolicy,
                        })
                      }
                      className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="everyone">Everyone</option>
                      <option value="friends">Friends Only</option>
                      <option value="nobody">No One</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                  <label className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 cursor-pointer">
                    <div>
                      <div className="text-xs font-bold text-white">Show Online Status</div>
                      <div className="text-[10px] text-slate-400">
                        Allow friends to see live presence & open rooms
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      data-testid="privacy-show-online"
                      checked={privacySettings.showOnlineStatus}
                      onChange={(e) =>
                        handleUpdatePrivacy({ showOnlineStatus: e.target.checked })
                      }
                      className="h-4 w-4 accent-amber-500"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 cursor-pointer">
                    <div>
                      <div className="text-xs font-bold text-white">Show Detailed Stats</div>
                      <div className="text-[10px] text-slate-400">
                        Share detailed match breakdown & recent matches publicly
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      data-testid="privacy-show-stats"
                      checked={privacySettings.showPublicStats}
                      onChange={(e) =>
                        handleUpdatePrivacy({ showPublicStats: e.target.checked })
                      }
                      className="h-4 w-4 accent-amber-500"
                    />
                  </label>
                </div>
              </div>

              {/* Blocked Players List */}
              <div className="rounded-xl border border-white/10 bg-black/25 p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
                    Blocked Players ({blockedPlayers.length})
                  </span>
                  <Award className="h-3.5 w-3.5 text-slate-500" />
                </div>
                {blockedPlayers.length === 0 ? (
                  <div className="py-5 text-center text-xs text-slate-400">
                    No blocked players.
                  </div>
                ) : (
                  blockedPlayers.map((b) => (
                    <div
                      key={b.playerId}
                      className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2"
                    >
                      <div>
                        <div className="text-xs font-bold text-white">{b.displayName}</div>
                        <div className="text-[10px] font-mono text-slate-400">{b.playerId}</div>
                      </div>
                      <button
                        type="button"
                        disabled={busyActionId === b.playerId}
                        onClick={() => handleUnblock(b.playerId)}
                        className="rounded-lg border border-white/15 bg-white/5 px-3 py-1 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                      >
                        Unblock
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
