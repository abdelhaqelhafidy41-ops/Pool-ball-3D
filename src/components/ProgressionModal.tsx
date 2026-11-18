import {
  AlertTriangle,
  Award,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Compass,
  Copy,
  Crosshair,
  Crown,
  Download,
  Film,
  Flag,
  Flame,
  HardDrive,
  History,
  KeyRound,
  LogIn,
  LogOut,
  MessageSquare,
  Scale,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Star,
  Swords,
  Target,
  Trash2,
  Trophy,
  Upload,
  User,
  UserCheck,
  UserMinus,
  UserPlus,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadTextFile, replayStorage } from '../game/replay/ReplayStorage';
import type { SavedReplaySummary } from '../game/replay/types';
import { soundEngine } from '../game/utils/SoundEngine';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { progressionClient } from '../multiplayer/ProgressionClient';
import { socialClient } from '../multiplayer/SocialClient';
import {
  ACHIEVEMENTS_CATALOG,
  type AchievementIconId,
  type LeaderboardResponse,
  type LeaderboardScope,
  type OnlineMatchType,
  type PublicPlayerProfile,
} from '../multiplayer/shared/progression';
import { getAvatarVisualMeta } from '../multiplayer/shared/economy';
import {
  ONLINE_AVATARS,
  type MatchHistoryRecord,
  type OnlineAvatarId,
} from '../multiplayer/shared/protocol';
import {
  getRankById,
  SEASON_CONFIG,
  type PenaltyType,
} from '../multiplayer/shared/ranked';
import type { SocialReportReason } from '../multiplayer/shared/social';
import { type ProgressionTab, useGameStore } from '../store/useGameStore';
import { RankBadge, RankProgressCard } from './RankBadge';

function formatDuration(sec: number): string {
  const safe = Math.max(0, Math.round(sec));
  if (safe < 60) return `${safe}s`;
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function formatShortDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

function formatPenaltyType(t: PenaltyType): string {
  switch (t) {
    case 'warning':
      return 'Fair Play Warning';
    case 'ranked_restriction':
      return 'Ranked Queue Restriction';
    case 'temp_suspension':
      return 'Temporary Suspension';
    case 'permanent_suspension':
      return 'Permanent Suspension';
  }
}

function formatMatchTypeLabel(t?: OnlineMatchType): string {
  switch (t) {
    case 'ranked':
      return 'Ranked';
    case 'tournament':
      return 'Tournament';
    case 'private':
      return 'Private';
    default:
      return 'Quick';
  }
}

function formatBytesCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function didPlayerWinSavedReplay(
  r: SavedReplaySummary,
  ownProfile: PublicPlayerProfile | null,
  onlineDisplayName: string,
): boolean | null {
  if (!r.winner) return null;
  if (r.matchType === 'online') {
    const myName = (ownProfile?.displayName ?? onlineDisplayName).trim().toLowerCase();
    const p1Match = r.player1Name.trim().toLowerCase() === myName;
    const p2Match = r.player2Name.trim().toLowerCase() === myName;
    if (p1Match && !p2Match) return r.winner === 'player1';
    if (p2Match && !p1Match) return r.winner === 'player2';
  }
  return r.winner === 'player1';
}

function renderAchievementIcon(icon: AchievementIconId, unlocked: boolean) {
  const cls = `h-4.5 w-4.5 ${unlocked ? 'text-amber-400' : 'text-slate-500'}`;
  switch (icon) {
    case 'trophy':
      return <Trophy className={cls} />;
    case 'flame':
      return <Flame className={cls} />;
    case 'crown':
      return <Crown className={cls} />;
    case 'target':
      return <Target className={cls} />;
    case 'zap':
      return <Zap className={cls} />;
    case 'shield':
      return <Shield className={cls} />;
    case 'award':
      return <Award className={cls} />;
    case 'star':
      return <Star className={cls} />;
    case 'compass':
      return <Compass className={cls} />;
    case 'crosshair':
      return <Crosshair className={cls} />;
  }
}

function ProfileDetailsView({
  profile,
  isOwn,
}: {
  profile: PublicPlayerProfile;
  isOwn: boolean;
}) {
  const avatar = getAvatarVisualMeta(profile.avatarId);
  const { stats, levelProgress } = profile;

  const friends = useGameStore((s) => s.friends);
  const incomingRequests = useGameStore((s) => s.incomingRequests);
  const outgoingRequests = useGameStore((s) => s.outgoingRequests);
  const blockedPlayers = useGameStore((s) => s.blockedPlayers);
  const openSocialModal = useGameStore((s) => s.openSocialModal);
  const closeProgressionModal = useGameStore((s) => s.closeProgressionModal);

  const [socialBusy, setSocialBusy] = useState(false);
  const [socialFeedback, setSocialFeedback] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState<SocialReportReason>('harassment');
  const [reportOpen, setReportOpen] = useState(false);

  const isFriend = friends.some((f) => f.playerId === profile.playerId);
  const isBlocked = blockedPlayers.some((b) => b.playerId === profile.playerId);
  const hasIncoming = incomingRequests.some((r) => r.playerId === profile.playerId);
  const hasOutgoing = outgoingRequests.some((r) => r.playerId === profile.playerId);

  const runSocialAction = async (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    soundEngine.playUiClick();
    setSocialBusy(true);
    setSocialFeedback(null);
    const res = await fn();
    setSocialBusy(false);
    setSocialFeedback(res.ok ? okText : res.error ?? 'Action failed.');
  };

  return (
    <div className="space-y-4">
      {/* Header Summary */}
      <div className="rounded-xl border border-white/10 bg-black/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-white/15 text-xl font-black"
              style={{ backgroundColor: `${avatar.accent}20`, color: avatar.accent }}
            >
              {avatar.glyph}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-lg font-extrabold text-white">
                  {profile.displayName}
                </h3>
                <span
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                    profile.isGuest
                      ? 'border-white/15 bg-white/5 text-slate-300'
                      : 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                  }`}
                >
                  {profile.isGuest ? 'Guest' : `@${profile.username}`}
                </span>
                {isOwn && (
                  <span className="rounded-md border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                    You
                  </span>
                )}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                ID: {profile.playerId}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <RankBadge elo={profile.elo} tier={profile.rankTier} size="sm" />
            <div className="rounded-lg border border-white/10 bg-[#0b1017] px-3 py-1.5 text-right">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Global Rank
              </div>
              <div className="font-mono text-sm font-extrabold tabular-nums text-white">
                {profile.rank ? `#${profile.rank}` : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-amber-400/35 bg-amber-500/10 px-3 py-1.5 text-right">
              <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                ELO Rating
              </div>
              <div className="font-mono text-base font-black tabular-nums text-amber-300">
                {profile.elo}
              </div>
            </div>
          </div>
        </div>

        {/* Social Actions when viewing another player */}
        {!isOwn && (
          <div className="mt-3 pt-3 border-t border-white/10 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {isBlocked ? (
                <button
                  type="button"
                  disabled={socialBusy}
                  onClick={() =>
                    runSocialAction(
                      () => socialClient.unblockPlayer(profile.playerId),
                      'Player unblocked.',
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-400/35 bg-rose-500/12 px-2.5 py-1 text-[11px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer"
                >
                  Unblock Player
                </button>
              ) : (
                <>
                  {isFriend ? (
                    <>
                      <button
                        type="button"
                        disabled={socialBusy}
                        onClick={() =>
                          runSocialAction(
                            () =>
                              socialClient.sendInvite({
                                targetPlayerId: profile.playerId,
                                ruleProfileId: 'casual',
                                calledShotsEnabled: false,
                              }),
                            'Match invitation sent!',
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                      >
                        <Swords className="h-3 w-3" />
                        Invite 1v1
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          closeProgressionModal();
                          openSocialModal('messages', profile.playerId);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer"
                      >
                        <MessageSquare className="h-3 w-3 text-amber-400" />
                        Message
                      </button>
                      <button
                        type="button"
                        disabled={socialBusy}
                        onClick={() =>
                          runSocialAction(
                            () => socialClient.removeFriend(profile.playerId),
                            'Removed from friends.',
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:border-rose-400/40 hover:text-rose-200 cursor-pointer"
                      >
                        <UserMinus className="h-3 w-3" />
                        Remove Friend
                      </button>
                    </>
                  ) : hasIncoming ? (
                    <button
                      type="button"
                      disabled={socialBusy}
                      onClick={() =>
                        runSocialAction(
                          () => socialClient.respondFriendRequest(profile.playerId, 'accept'),
                          'Friend request accepted!',
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer"
                    >
                      <Check className="h-3 w-3" />
                      Accept Friend Request
                    </button>
                  ) : hasOutgoing ? (
                    <button
                      type="button"
                      disabled={socialBusy}
                      onClick={() =>
                        runSocialAction(
                          () => socialClient.respondFriendRequest(profile.playerId, 'cancel'),
                          'Friend request cancelled.',
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:bg-white/10 cursor-pointer"
                    >
                      Cancel Friend Request
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={socialBusy}
                      onClick={() =>
                        runSocialAction(
                          () => socialClient.sendFriendRequest(profile.playerId),
                          'Friend request sent!',
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                    >
                      <UserPlus className="h-3 w-3" />
                      Add Friend
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={socialBusy}
                    onClick={() =>
                      runSocialAction(
                        () => socialClient.blockPlayer(profile.playerId),
                        'Player blocked.',
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:border-rose-400/40 hover:text-rose-200 cursor-pointer"
                  >
                    <Ban className="h-3 w-3" />
                    Block
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => setReportOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:border-rose-400/40 hover:text-rose-200 cursor-pointer"
              >
                <Flag className="h-3 w-3" />
                Report
              </button>
            </div>

            {reportOpen && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-950/20 p-2">
                <select
                  value={reportReason}
                  onChange={(e) => setReportReason(e.target.value as SocialReportReason)}
                  className="rounded border border-white/15 bg-[#0b1017] px-2 py-1 text-[11px] text-white"
                >
                  <option value="harassment">Harassment</option>
                  <option value="spam">Spam</option>
                  <option value="inappropriate_name">Inappropriate Name</option>
                  <option value="cheating">Cheating</option>
                  <option value="other">Other</option>
                </select>
                <button
                  type="button"
                  disabled={socialBusy}
                  onClick={async () => {
                    await runSocialAction(
                      () =>
                        socialClient.submitReport({
                          reportedId: profile.playerId,
                          contextType: 'profile',
                          reason: reportReason,
                        }),
                      'Player report submitted.',
                    );
                    setReportOpen(false);
                  }}
                  className="rounded bg-rose-500 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-rose-400 cursor-pointer"
                >
                  Submit Report
                </button>
              </div>
            )}

            {socialFeedback && (
              <div className="text-[11px] font-semibold text-amber-300">{socialFeedback}</div>
            )}
          </div>
        )}

        {/* Competitive Level & XP Progress */}
        <div className="mt-4 pt-3 border-t border-white/10">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="font-extrabold text-white">
              Level {levelProgress.level}
            </span>
            <span className="font-mono tabular-nums text-[11px] text-slate-300">
              {levelProgress.currentLevelXp} / {levelProgress.xpForNextLevel} XP (Total{' '}
              {levelProgress.totalXp.toLocaleString()} XP)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-md bg-white/10">
            <div
              className="h-full bg-amber-500 transition-all duration-300"
              style={{ width: `${Math.round(levelProgress.progressRatio * 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Competitive Division & Season Standing */}
      <RankProgressCard
        elo={profile.elo}
        peakElo={profile.peakElo}
        seasonName={profile.seasonStanding?.seasonName}
        seasonElo={profile.seasonStanding?.seasonElo}
      />

      {profile.seasonStanding && (
        <div className="rounded-xl border border-amber-400/25 bg-amber-500/5 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="font-bold text-amber-300">
              {profile.seasonStanding.seasonName}
            </div>
            <div className="font-mono tabular-nums text-[11px] text-slate-300">
              {profile.seasonStanding.leaderboardRank
                ? `Season Rank #${profile.seasonStanding.leaderboardRank}`
                : 'Unplaced this season'}
              {' · '}
              {profile.seasonStanding.wins}W–{profile.seasonStanding.losses}L
              {' · '}
              Peak {profile.seasonStanding.peakSeasonElo} ELO
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <span>
              Highest Division:{' '}
              <span className="font-bold text-slate-200">
                {getRankById(profile.seasonStanding.highestRankTier).name}
              </span>
            </span>
            <span className="font-mono tabular-nums text-amber-200">
              Season Tier Reward: +
              {SEASON_CONFIG.rewardsByTier[profile.seasonStanding.highestRankTier].coins}{' '}
              POOL COINS
            </span>
          </div>
        </div>
      )}

      {/* Career Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Total Matches', value: String(stats.totalMatches) },
          { label: 'Wins / Losses', value: `${stats.wins}W – ${stats.losses}L` },
          { label: 'Win Rate', value: `${stats.winRate.toFixed(1)}%` },
          { label: 'Peak ELO', value: String(profile.peakElo) },
          { label: 'Current Streak', value: `${stats.currentStreak}` },
          { label: 'Best Streak', value: `${stats.bestStreak}` },
          { label: 'Total Shots', value: `${stats.totalShots}` },
          { label: 'Successful Shots', value: `${stats.successfulShots}` },
          { label: 'Balls Pocketed', value: `${stats.ballsPocketed}` },
          { label: 'Break Success', value: `${stats.breakSuccessRate.toFixed(1)}%` },
          { label: '8-Ball Wins', value: `${stats.eightBallWins}` },
          { label: 'Avg Match Time', value: formatDuration(stats.avgMatchDurationSec) },
        ].map((metric) => (
          <div
            key={metric.label}
            className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {metric.label}
            </div>
            <div className="mt-0.5 font-mono text-sm font-bold tabular-nums text-white">
              {metric.value}
            </div>
          </div>
        ))}
      </div>

      {/* Mode Breakdown */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {(
          [
            { label: 'Ranked', data: stats.byMatchType.ranked ?? { matches: 0, wins: 0 } },
            { label: 'Quick Match', data: stats.byMatchType.quick },
            { label: 'Private Room', data: stats.byMatchType.private },
            { label: 'Strict WPA', data: stats.byMatchType.wpa },
            { label: 'Casual Rules', data: stats.byMatchType.casual },
          ] as const
        ).map((m) => (
          <div
            key={m.label}
            className="rounded-xl border border-white/10 bg-black/25 px-3 py-2"
          >
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              {m.label}
            </div>
            <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-slate-200">
              {m.data.wins}W / {m.data.matches}M
            </div>
          </div>
        ))}
      </div>

      {/* Unlocked Trophies Preview */}
      <div className="rounded-xl border border-white/10 bg-black/25 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
            Achievements & Trophies ({profile.achievements.length} / {ACHIEVEMENTS_CATALOG.length})
          </span>
        </div>
        {profile.achievements.length === 0 ? (
          <div className="py-2 text-xs text-slate-400">
            No competitive achievements unlocked yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {profile.achievements.map((ach) => (
              <div
                key={ach.id}
                className="flex items-center gap-2.5 rounded-lg border border-amber-400/25 bg-amber-500/8 px-2.5 py-2"
              >
                <div className="shrink-0">{renderAchievementIcon(ach.icon, true)}</div>
                <div className="min-w-0">
                  <div className="truncate text-xs font-bold text-white">{ach.name}</div>
                  <div className="text-[10px] text-slate-400">
                    Unlocked {formatShortDate(ach.unlockedAtMs)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProgressionModal() {
  const progressionModalOpen = useGameStore((s) => s.progressionModalOpen);
  const closeProgressionModal = useGameStore((s) => s.closeProgressionModal);
  const progressionTab = useGameStore((s) => s.progressionTab);
  const setProgressionTab = useGameStore((s) => s.setProgressionTab);
  const inspectedPlayerId = useGameStore((s) => s.inspectedPlayerId);
  const setInspectedPlayerId = useGameStore((s) => s.setInspectedPlayerId);
  const ownProfile = useGameStore((s) => s.ownProfile);
  const onlineProfile = useGameStore((s) => s.onlineProfile);
  const activeSeason = useGameStore((s) => s.activeSeason);
  const seasonsList = useGameStore((s) => s.seasonsList);
  const moderationStatus = useGameStore((s) => s.moderationStatus);
  const savedReplays = useGameStore((s) => s.savedReplays);
  const replayStorageStats = useGameStore((s) => s.replayStorageStats);
  const setSavedReplays = useGameStore((s) => s.setSavedReplays);
  const requestWatchSavedReplay = useGameStore((s) => s.requestWatchSavedReplay);

  const [displayNameInput, setDisplayNameInput] = useState(onlineProfile.displayName);
  const [selectedAvatar, setSelectedAvatar] = useState<OnlineAvatarId>(onlineProfile.avatarId);
  const [copiedId, setCopiedId] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<{
    type: 'ok' | 'err';
    text: string;
  } | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  // Account auth panel state
  const [authMode, setAuthMode] = useState<'none' | 'register' | 'login'>('none');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null,
  );

  // Inspected other player state
  const [inspectedProfile, setInspectedProfile] = useState<PublicPlayerProfile | null>(null);
  const [inspectedLoading, setInspectedLoading] = useState(false);

  // Leaderboard state
  const [lbScope, setLbScope] = useState<LeaderboardScope>('global');
  const [lbSeasonId, setLbSeasonId] = useState<string>('');
  const [lbPage, setLbPage] = useState(1);
  const [lbQuery, setLbQuery] = useState('');
  const [lbData, setLbData] = useState<LeaderboardResponse | null>(null);
  const [lbLoading, setLbLoading] = useState(false);

  // History & Replay archive state
  const [historyModeFilter, setHistoryModeFilter] = useState<'all' | 'ai' | 'local' | 'online'>('all');
  const [historyResultFilter, setHistoryResultFilter] = useState<'all' | 'won' | 'lost'>('all');
  const [historyFilterOwn, setHistoryFilterOwn] = useState(false);
  const [historyMatchType, setHistoryMatchType] = useState<OnlineMatchType | 'all'>('all');
  const [historyItems, setHistoryItems] = useState<MatchHistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyImportNotice, setHistoryImportNotice] = useState<{
    type: 'ok' | 'err';
    text: string;
  } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Fair Play & Appeals state
  const [fairPlayLoading, setFairPlayLoading] = useState(false);
  const [appealPenaltyId, setAppealPenaltyId] = useState<string>('');
  const [appealMessage, setAppealMessage] = useState<string>('');
  const [appealBusy, setAppealBusy] = useState(false);
  const [appealFeedback, setAppealFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null,
  );

  const syncOwnSession = useCallback(async () => {
    setSessionLoading(true);
    setSessionError(null);
    const prof = ownProfile
      ? await progressionClient.refreshOwnProfile()
      : await progressionClient.ensurePlayerSession();
    setSessionLoading(false);
    if (!prof) {
      setSessionError(
        progressionClient.getLastSessionError() ?? 'Unable to reach competitive profile service.',
      );
    }
    void progressionClient.fetchRankedSeasons();
    void progressionClient.fetchModerationStatus();
  }, [ownProfile]);

  useEffect(() => {
    if (!progressionModalOpen) return;
    void syncOwnSession();
  }, [progressionModalOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ownProfile) {
      setDisplayNameInput(ownProfile.displayName);
      setSelectedAvatar((ownProfile.avatarId as OnlineAvatarId) || 'cue_gold');
    } else {
      setDisplayNameInput(onlineProfile.displayName);
      setSelectedAvatar(onlineProfile.avatarId);
    }
  }, [ownProfile, onlineProfile.displayName, onlineProfile.avatarId]);

  useEffect(() => {
    if (!lbSeasonId && activeSeason?.seasonId) {
      setLbSeasonId(activeSeason.seasonId);
    }
  }, [lbSeasonId, activeSeason?.seasonId]);

  useEffect(() => {
    if (!progressionModalOpen || !inspectedPlayerId) {
      setInspectedProfile(null);
      return;
    }
    let cancelled = false;
    setInspectedLoading(true);
    void progressionClient.fetchPublicProfile(inspectedPlayerId).then((prof) => {
      if (!cancelled) {
        setInspectedProfile(prof);
        setInspectedLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [progressionModalOpen, inspectedPlayerId]);

  const loadLeaderboard = useCallback(async () => {
    setLbLoading(true);
    const data = await progressionClient.fetchLeaderboard({
      scope: lbScope,
      seasonId: lbScope === 'season' ? lbSeasonId || activeSeason?.seasonId || null : null,
      page: lbPage,
      limit: 15,
      query: lbQuery,
    });
    setLbData(data);
    setLbLoading(false);
  }, [lbScope, lbSeasonId, activeSeason?.seasonId, lbPage, lbQuery]);

  useEffect(() => {
    if (!progressionModalOpen || inspectedPlayerId || progressionTab !== 'leaderboard') return;
    const handle = window.setTimeout(() => {
      void loadLeaderboard();
    }, 150);
    return () => window.clearTimeout(handle);
  }, [progressionModalOpen, inspectedPlayerId, progressionTab, loadLeaderboard]);

  const refreshSavedReplays = useCallback(async () => {
    try {
      const [list, stats] = await Promise.all([
        replayStorage.listSavedReplays(),
        replayStorage.getStorageStats(),
      ]);
      setSavedReplays(list, stats);
    } catch {
      // Ignore storage error
    }
  }, [setSavedReplays]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const [matches] = await Promise.all([
      progressionClient.fetchMatchHistory({
        playerId: historyFilterOwn && ownProfile ? ownProfile.playerId : null,
        matchType: historyMatchType,
        limit: 30,
      }),
      refreshSavedReplays(),
    ]);
    setHistoryItems(matches);
    setHistoryLoading(false);
  }, [historyFilterOwn, historyMatchType, ownProfile, refreshSavedReplays]);

  useEffect(() => {
    if (!progressionModalOpen || inspectedPlayerId || progressionTab !== 'history') return;
    void loadHistory();
  }, [progressionModalOpen, inspectedPlayerId, progressionTab, loadHistory]);

  const loadFairPlay = useCallback(async () => {
    setFairPlayLoading(true);
    await progressionClient.fetchModerationStatus();
    setFairPlayLoading(false);
  }, []);

  useEffect(() => {
    if (!progressionModalOpen || inspectedPlayerId || progressionTab !== 'fairplay') return;
    void loadFairPlay();
  }, [progressionModalOpen, inspectedPlayerId, progressionTab, loadFairPlay]);

  useEffect(() => {
    if (!moderationStatus) return;
    const pendingPenaltyIds = new Set(
      moderationStatus.appeals.filter((a) => a.status === 'pending').map((a) => a.penaltyId),
    );
    const appealable = moderationStatus.recentPenalties.filter(
      (p) => !p.revokedAtMs && !pendingPenaltyIds.has(p.penaltyId),
    );
    if (appealable.length > 0 && !appealable.some((p) => p.penaltyId === appealPenaltyId)) {
      setAppealPenaltyId(appealable[0].penaltyId);
    }
  }, [moderationStatus, appealPenaltyId]);

  if (!progressionModalOpen) return null;

  const handleSaveProfile = async () => {
    soundEngine.playUiClick();
    const cleanName = displayNameInput.trim().slice(0, 16) || 'Player';
    setSavingProfile(true);
    setProfileFeedback(null);
    multiplayerManager.updateProfile(cleanName, selectedAvatar, { syncProgression: false });
    const res = await progressionClient.updateProfile(cleanName, selectedAvatar);
    setSavingProfile(false);
    if (res.ok) {
      setSessionError(null);
      setProfileFeedback({ type: 'ok', text: 'Profile updated.' });
    } else {
      setProfileFeedback({ type: 'err', text: res.error ?? 'Unable to save profile.' });
    }
  };

  const handleCopyPlayerId = async (id: string) => {
    soundEngine.playUiClick();
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(true);
      window.setTimeout(() => setCopiedId(false), 1800);
    } catch {
      setCopiedId(false);
    }
  };

  const handleAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    soundEngine.playUiClick();
    setAuthBusy(true);
    setAuthMessage(null);

    if (authMode === 'register') {
      const res = await progressionClient.registerAccount({
        username: authUsername,
        password: authPassword,
        displayName: displayNameInput.trim() || undefined,
        avatarId: selectedAvatar,
      });
      setAuthBusy(false);
      if (res.ok) {
        setAuthMessage({
          type: 'ok',
          text: `Account @${res.data?.username} secured and linked.`,
        });
        setAuthMode('none');
        setAuthPassword('');
        multiplayerManager.reauthenticateSocketIdentity();
      } else {
        setAuthMessage({ type: 'err', text: res.error ?? 'Registration failed.' });
      }
    } else if (authMode === 'login') {
      const res = await progressionClient.loginAccount({
        username: authUsername,
        password: authPassword,
      });
      setAuthBusy(false);
      if (res.ok) {
        setAuthMessage({
          type: 'ok',
          text: `Signed in as ${res.data?.displayName} (@${res.data?.username}).`,
        });
        setAuthMode('none');
        setAuthPassword('');
        multiplayerManager.reauthenticateSocketIdentity();
      } else {
        setAuthMessage({ type: 'err', text: res.error ?? 'Sign in failed.' });
      }
    }
  };

  const handleSwitchToGuest = async () => {
    soundEngine.playUiClick();
    setAuthBusy(true);
    setAuthMessage(null);
    const prof = await progressionClient.ensurePlayerSession({
      displayName: 'Player',
      avatarId: 'cue_gold',
      forceNewGuest: true,
    });
    setAuthBusy(false);
    if (prof) {
      setAuthMessage({ type: 'ok', text: `Switched to fresh guest identity (${prof.playerId}).` });
      multiplayerManager.reauthenticateSocketIdentity();
    }
  };

  const unlockedMap = new Map(
    (ownProfile?.achievements ?? []).map((a) => [a.id, a.unlockedAtMs]),
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Competitive Profile & Leaderboard"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4"
    >
      <div className="w-full max-w-3xl max-h-[92dvh] modal-scroll-y rounded-2xl border border-white/15 bg-[#0c1219] p-4 sm:p-6 text-slate-100 shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/10">
              <Trophy className="h-4.5 w-4.5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-extrabold tracking-tight text-white">
                {inspectedPlayerId ? 'Competitor Public Profile' : 'Competitive Career & Rankings'}
              </h2>
              <p className="text-[11px] text-slate-400">
                Authoritative online ELO, XP levels, achievements & match ledger
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              soundEngine.playUiClick();
              closeProgressionModal();
            }}
            aria-label="Close competitive hub"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/12 hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Navigation Tabs or Back Button */}
        {inspectedPlayerId ? (
          <div className="mt-3.5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                setInspectedPlayerId(null);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
            >
              <ChevronLeft className="h-4 w-4" />
              Back to {progressionTab.charAt(0).toUpperCase() + progressionTab.slice(1)}
            </button>
          </div>
        ) : (
          <div className="mt-3.5 grid grid-cols-5 gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
            {(
              [
                { id: 'profile', label: 'My Profile', icon: User },
                { id: 'leaderboard', label: 'Leaderboard', icon: Trophy },
                { id: 'achievements', label: 'Achievements', icon: Award },
                { id: 'history', label: 'History', icon: History },
                { id: 'fairplay', label: 'Fair Play', icon: Scale },
              ] as Array<{ id: ProgressionTab; label: string; icon: typeof User }>
            ).map((tab) => {
              const Icon = tab.icon;
              const active = progressionTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`progression-tab-${tab.id}`}
                  onClick={() => {
                    soundEngine.playUiClick();
                    setProgressionTab(tab.id);
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
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
        )}

        {/* Body */}
        <div className="mt-4">
          {/* Inspecting another player */}
          {inspectedPlayerId ? (
            inspectedLoading ? (
              <div className="py-12 text-center text-xs text-slate-400">
                Loading player profile...
              </div>
            ) : inspectedProfile ? (
              <ProfileDetailsView
                profile={inspectedProfile}
                isOwn={ownProfile?.playerId === inspectedProfile.playerId}
              />
            ) : (
              <div className="rounded-xl border border-white/10 bg-black/25 py-10 text-center text-xs text-slate-400">
                Competitor profile unavailable or not yet ranked.
              </div>
            )
          ) : progressionTab === 'profile' ? (
            <div className="space-y-4">
              {/* Editable Identity & Avatar Strip */}
              <div className="rounded-xl border border-white/10 bg-black/30 p-3.5 space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div className="flex-1 min-w-[180px]">
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Display Name
                    </label>
                    <input
                      type="text"
                      maxLength={16}
                      value={displayNameInput}
                      onChange={(e) => setDisplayNameInput(e.target.value)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs font-semibold text-white focus:border-amber-400 focus:outline-none"
                      placeholder="Player Name"
                    />
                  </div>

                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Avatar
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {ONLINE_AVATARS.map((av) => {
                        const selected = selectedAvatar === av.id;
                        return (
                          <button
                            key={av.id}
                            type="button"
                            title={av.label}
                            onClick={() => {
                              soundEngine.playUiClick();
                              setSelectedAvatar(av.id);
                            }}
                            className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                              selected
                                ? 'border-amber-400 bg-amber-500/15 scale-105'
                                : 'border-white/10 bg-white/5 opacity-75 hover:opacity-100'
                            }`}
                            style={{ color: av.accent }}
                          >
                            {av.glyph}
                          </button>
                        );
                      })}
                      {!ONLINE_AVATARS.some((a) => a.id === selectedAvatar) &&
                        (() => {
                          const customAv = getAvatarVisualMeta(selectedAvatar);
                          return (
                            <button
                              type="button"
                              title={`${customAv.label} (Store)`}
                              onClick={() => {
                                soundEngine.playUiClick();
                                setSelectedAvatar(selectedAvatar);
                              }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-amber-400 bg-amber-500/15 scale-105 text-xs font-bold cursor-pointer"
                              style={{ color: customAv.accent }}
                            >
                              {customAv.glyph}
                            </button>
                          );
                        })()}
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={savingProfile}
                    onClick={handleSaveProfile}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                    {savingProfile ? 'Saving...' : 'Save Identity'}
                  </button>
                </div>

                {profileFeedback && (
                  <div
                    className={`text-[11px] font-semibold ${
                      profileFeedback.type === 'ok' ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                  >
                    {profileFeedback.text}
                  </div>
                )}

                {/* Account Actions Bar */}
                <div className="pt-2.5 border-t border-white/10 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[11px] text-slate-400">
                    {ownProfile ? (
                      <>
                        <span className="font-mono">{ownProfile.playerId}</span>
                        <button
                          type="button"
                          onClick={() => handleCopyPlayerId(ownProfile.playerId)}
                          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-slate-200 hover:bg-white/10 cursor-pointer"
                        >
                          {copiedId ? (
                            <>
                              <Check className="h-3 w-3 text-emerald-400" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3 text-amber-400" />
                              Copy ID
                            </>
                          )}
                        </button>
                      </>
                    ) : sessionError ? (
                      <div className="flex flex-wrap items-center gap-2 text-rose-300">
                        <span>{sessionError}</span>
                        <button
                          type="button"
                          onClick={() => {
                            soundEngine.playUiClick();
                            void syncOwnSession();
                          }}
                          className="rounded-md border border-rose-400/40 bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-200 hover:bg-rose-500/25 cursor-pointer"
                        >
                          Retry
                        </button>
                      </div>
                    ) : (
                      <span>
                        {sessionLoading
                          ? 'Connecting to competitive account service...'
                          : 'Competitive session not initialized.'}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {(!ownProfile || ownProfile.isGuest) && (
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          setAuthMode(authMode === 'register' ? 'none' : 'register');
                          setAuthMessage(null);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/12 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-500/20 cursor-pointer whitespace-nowrap"
                      >
                        <UserPlus className="h-3 w-3" />
                        Claim Username
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        setAuthMode(authMode === 'login' ? 'none' : 'login');
                        setAuthMessage(null);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                    >
                      <LogIn className="h-3 w-3" />
                      Sign In
                    </button>
                    {ownProfile && !ownProfile.isGuest && (
                      <button
                        type="button"
                        disabled={authBusy}
                        onClick={handleSwitchToGuest}
                        className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                      >
                        <LogOut className="h-3 w-3" />
                        New Guest
                      </button>
                    )}
                  </div>
                </div>

                {authMessage && (
                  <div
                    className={`rounded-lg border px-3 py-1.5 text-xs ${
                      authMessage.type === 'ok'
                        ? 'border-emerald-400/35 bg-emerald-500/10 text-emerald-200'
                        : 'border-rose-500/35 bg-rose-500/10 text-rose-200'
                    }`}
                  >
                    {authMessage.text}
                  </div>
                )}

                {authMode !== 'none' && (
                  <form
                    onSubmit={handleAccountSubmit}
                    className="rounded-xl border border-white/10 bg-[#0b1017] p-3 space-y-2.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-extrabold text-white">
                        {authMode === 'register'
                          ? 'Register Username & Password (Keeps Current Stats)'
                          : 'Sign In to Registered Account'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setAuthMode('none')}
                        className="text-slate-400 hover:text-white cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        type="text"
                        required
                        minLength={3}
                        maxLength={18}
                        value={authUsername}
                        onChange={(e) => setAuthUsername(e.target.value)}
                        placeholder="Username (3-18 chars, A-Z 0-9 _)"
                        className="rounded-lg border border-white/12 bg-black/40 px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      />
                      <input
                        type="password"
                        required
                        minLength={6}
                        maxLength={72}
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        placeholder="Password (min 6 chars)"
                        className="rounded-lg border border-white/12 bg-black/40 px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      />
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={authBusy}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        {authBusy
                          ? 'Processing...'
                          : authMode === 'register'
                            ? 'Upgrade Account'
                            : 'Sign In'}
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {ownProfile ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/30 bg-amber-500/8 px-3.5 py-2.5">
                    <div className="text-xs">
                      <span className="font-extrabold text-amber-200">
                        Global Tournaments & Trophy Case
                      </span>
                      <span className="ml-2 text-slate-300">
                        View your championship wins, brackets & seasonal standings
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        closeProgressionModal();
                        useGameStore.getState().openTournamentModal('career');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                    >
                      <Crown className="h-3.5 w-3.5" />
                      Tournament Career
                    </button>
                  </div>
                  <ProfileDetailsView profile={ownProfile} isOwn />
                </>
              ) : sessionError ? (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 py-6 px-4 text-center text-xs text-rose-200 space-y-2">
                  <div>{sessionError}</div>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.playUiClick();
                      void syncOwnSession();
                    }}
                    className="inline-flex items-center rounded-lg border border-rose-400/40 bg-rose-500/20 px-3 py-1 text-[11px] font-bold text-rose-100 hover:bg-rose-500/30 cursor-pointer"
                  >
                    Retry Connection
                  </button>
                </div>
              ) : (
                <div className="rounded-xl border border-white/10 bg-black/25 py-8 text-center text-xs text-slate-400">
                  Loading player career telemetry...
                </div>
              )}
            </div>
          ) : progressionTab === 'leaderboard' ? (
            <div className="space-y-3">
              {/* Leaderboard Controls */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
                  {(
                    [
                      { id: 'global', label: 'Global' },
                      { id: 'season', label: 'Season' },
                      { id: 'weekly', label: 'Weekly' },
                      { id: 'monthly', label: 'Monthly' },
                    ] as Array<{ id: LeaderboardScope; label: string }>
                  ).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      data-testid={`lb-scope-${s.id}`}
                      onClick={() => {
                        soundEngine.playUiClick();
                        setLbScope(s.id);
                        setLbPage(1);
                      }}
                      className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap ${
                        lbScope === s.id
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                {lbScope === 'season' && seasonsList.length > 0 && (
                  <select
                    value={lbSeasonId || activeSeason?.seasonId || seasonsList[0].seasonId}
                    onChange={(e) => {
                      setLbSeasonId(e.target.value);
                      setLbPage(1);
                    }}
                    className="rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs font-semibold text-white focus:border-amber-400 focus:outline-none"
                  >
                    {seasonsList.map((sec) => (
                      <option key={sec.seasonId} value={sec.seasonId}>
                        {sec.name} ({sec.status === 'active' ? 'Active' : 'Completed'})
                      </option>
                    ))}
                  </select>
                )}

                <div className="relative flex-1 min-w-[160px] max-w-xs">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={lbQuery}
                    onChange={(e) => {
                      setLbQuery(e.target.value);
                      setLbPage(1);
                    }}
                    placeholder="Search player or @username..."
                    className="w-full rounded-lg border border-white/12 bg-[#0b1017] pl-8 pr-3 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                  />
                </div>
              </div>

              {lbScope === 'season' && lbData?.season && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3.5 py-2 text-[11px]">
                  <span className="font-bold text-amber-300">{lbData.season.name}</span>
                  <span className="font-mono tabular-nums text-slate-400">
                    {formatShortDate(lbData.season.startsAtMs)} –{' '}
                    {formatShortDate(lbData.season.endsAtMs)} ·{' '}
                    {lbData.season.status === 'active' ? 'Active Season' : 'Completed'}
                  </span>
                </div>
              )}

              {/* Current Player Rank Highlight */}
              {lbData?.currentPlayer && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-black text-amber-300">
                      #{lbData.currentPlayer.rank}
                    </span>
                    <RankBadge
                      elo={lbData.currentPlayer.elo}
                      tier={lbData.currentPlayer.rankTier}
                      size="xs"
                    />
                    <span className="font-bold text-white">
                      {lbData.currentPlayer.displayName}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 font-mono tabular-nums text-[11px] text-slate-200">
                    <span>Lv {lbData.currentPlayer.level}</span>
                    <span>
                      {lbData.currentPlayer.wins}W–{lbData.currentPlayer.losses}L
                    </span>
                    <span className="font-extrabold text-amber-300">
                      {lbData.currentPlayer.elo} ELO
                    </span>
                  </div>
                </div>
              )}

              {/* Leaderboard Table */}
              <div className="overflow-x-auto rounded-xl border border-white/10 bg-black/25">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <th className="px-3 py-2">Rank</th>
                      <th className="px-3 py-2">Player</th>
                      <th className="px-3 py-2">Division</th>
                      <th className="px-3 py-2 text-right">Lv</th>
                      <th className="px-3 py-2 text-right">W–L</th>
                      <th className="px-3 py-2 text-right">Win %</th>
                      <th className="px-3 py-2 text-right">
                        {lbScope === 'global' || lbScope === 'season' ? 'ELO' : 'Period Δ / ELO'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {lbLoading ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          Loading rankings...
                        </td>
                      </tr>
                    ) : !lbData || lbData.items.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          No ranked competitors found for this filter.
                        </td>
                      </tr>
                    ) : (
                      lbData.items.map((row) => {
                        const av = getAvatarVisualMeta(row.avatarId);
                        const isSelf = ownProfile?.playerId === row.playerId;
                        return (
                          <tr
                            key={row.playerId}
                            className={
                              isSelf
                                ? 'bg-amber-500/10'
                                : 'hover:bg-white/[0.03] transition-colors'
                            }
                          >
                            <td className="px-3 py-2 font-mono font-bold tabular-nums text-slate-200">
                              #{row.rank}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => {
                                  soundEngine.playUiClick();
                                  setInspectedPlayerId(row.playerId);
                                }}
                                className="flex items-center gap-2 text-left hover:underline cursor-pointer"
                              >
                                <span
                                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/15 text-[11px] font-bold"
                                  style={{ backgroundColor: `${av.accent}20`, color: av.accent }}
                                >
                                  {av.glyph}
                                </span>
                                <span className="font-bold text-white">{row.displayName}</span>
                                {row.username && (
                                  <span className="text-[10px] text-slate-400">
                                    @{row.username}
                                  </span>
                                )}
                              </button>
                            </td>
                            <td className="px-3 py-2">
                              <RankBadge elo={row.elo} tier={row.rankTier} size="xs" />
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-300">
                              {row.level}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-300">
                              {row.wins}–{row.losses}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-300">
                              {row.winRate.toFixed(1)}%
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-bold tabular-nums">
                              {lbScope === 'global' || lbScope === 'season' ? (
                                <span className="text-amber-300">{row.elo}</span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5">
                                  <span
                                    className={
                                      row.periodDelta >= 0 ? 'text-emerald-300' : 'text-rose-300'
                                    }
                                  >
                                    {row.periodDelta >= 0 ? `+${row.periodDelta}` : row.periodDelta}
                                  </span>
                                  <span className="text-slate-400">/ {row.elo}</span>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {lbData && lbData.totalPages > 1 && (
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>
                    Page {lbData.page} of {lbData.totalPages} ({lbData.total} players)
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={lbPage <= 1}
                      onClick={() => setLbPage((p) => Math.max(1, p - 1))}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-slate-200 disabled:opacity-40 cursor-pointer"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      Prev
                    </button>
                    <button
                      type="button"
                      disabled={lbPage >= lbData.totalPages}
                      onClick={() => setLbPage((p) => p + 1)}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-slate-200 disabled:opacity-40 cursor-pointer"
                    >
                      Next
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : progressionTab === 'achievements' ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 text-xs">
                <span className="font-bold text-white">
                  Unlocked {ownProfile?.achievements.length ?? 0} / {ACHIEVEMENTS_CATALOG.length}{' '}
                  Achievements
                </span>
                <span className="font-mono text-amber-300">
                  +
                  {(ownProfile?.achievements ?? []).reduce((acc, a) => acc + a.rewardXp, 0)}{' '}
                  Bonus XP Earned
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {ACHIEVEMENTS_CATALOG.map((ach) => {
                  const unlockedTs = unlockedMap.get(ach.id);
                  const unlocked = unlockedTs !== undefined;
                  return (
                    <div
                      key={ach.id}
                      className={`rounded-xl border p-3 transition-colors ${
                        unlocked
                          ? 'border-amber-400/40 bg-amber-500/10'
                          : 'border-white/10 bg-black/25 opacity-75'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          <div
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
                              unlocked
                                ? 'border-amber-400/40 bg-amber-500/15'
                                : 'border-white/10 bg-white/5'
                            }`}
                          >
                            {renderAchievementIcon(ach.icon, unlocked)}
                          </div>
                          <div>
                            <div className="text-xs font-extrabold text-white">{ach.name}</div>
                            <div className="text-[10px] uppercase tracking-wider text-slate-400">
                              {ach.category} · +{ach.rewardXp} XP
                            </div>
                          </div>
                        </div>
                        <span
                          className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                            unlocked
                              ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                              : 'border-white/10 bg-white/5 text-slate-400'
                          }`}
                        >
                          {unlocked ? 'Unlocked' : 'Locked'}
                        </span>
                      </div>
                      <p className="mt-2 text-[11px] text-slate-300 leading-relaxed">
                        {ach.description}
                      </p>
                      {unlocked && (
                        <div className="mt-1.5 text-[10px] text-amber-300/90">
                          Awarded {formatShortDate(unlockedTs)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : progressionTab === 'history' ? (
            (() => {
              const savedByMatchId = new Map(savedReplays.map((r) => [r.matchId, r]));
              const filteredSaved = savedReplays.filter((r) => {
                if (historyModeFilter !== 'all' && r.matchType !== historyModeFilter) return false;
                const won = didPlayerWinSavedReplay(r, ownProfile, onlineProfile.displayName);
                if (historyResultFilter === 'won' && won !== true) return false;
                if (historyResultFilter === 'lost' && won !== false) return false;
                return true;
              });

              const filteredOnlineLedger = historyItems.filter((m) => {
                if (historyModeFilter !== 'all' && historyModeFilter !== 'online') return false;
                if (historyResultFilter === 'all' || !ownProfile) return true;
                const isSelfP1 = m.player1Id === ownProfile.playerId;
                const isSelfP2 = m.player2Id === ownProfile.playerId;
                if (!isSelfP1 && !isSelfP2) return false;
                const won = isSelfP1 ? m.winnerRole === 'player1' : m.winnerRole === 'player2';
                return historyResultFilter === 'won' ? won : !won;
              });

              const handleExportSaved = async (replayId: string, matchId: string) => {
                soundEngine.playUiClick();
                const full = await replayStorage.loadReplay(replayId);
                if (!full) {
                  setHistoryImportNotice({ type: 'err', text: 'Unable to load replay data for export.' });
                  return;
                }
                const json = replayStorage.exportReplayToJson(full);
                downloadTextFile(`replay-${matchId}.json`, json);
                setHistoryImportNotice({ type: 'ok', text: `Exported replay-${matchId}.json` });
              };

              const handleDeleteSaved = async (replayId: string) => {
                soundEngine.playUiClick();
                await replayStorage.deleteReplay(replayId);
                await refreshSavedReplays();
                setHistoryImportNotice({ type: 'ok', text: 'Replay removed from local archive.' });
              };

              const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                  const text = await file.text();
                  const res = await replayStorage.importReplayFromJson(text);
                  if (res.ok) {
                    await refreshSavedReplays();
                    setHistoryImportNotice({
                      type: 'ok',
                      text: `Imported "${res.summary.player1Name} vs ${res.summary.player2Name}" (${res.summary.totalShots} shots).`,
                    });
                  } else {
                    setHistoryImportNotice({ type: 'err', text: res.error });
                  }
                } catch {
                  setHistoryImportNotice({ type: 'err', text: 'Failed to read selected replay file.' });
                }
              };

              return (
                <div className="space-y-3" data-testid="match-history-panel">
                  {/* Top Filter Bar: Match Mode + Result Outcome + Refresh & Import */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
                      {(
                        [
                          { id: 'all', label: 'All Matches' },
                          { id: 'ai', label: 'AI' },
                          { id: 'online', label: 'Online' },
                          { id: 'local', label: 'Local' },
                        ] as const
                      ).map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          data-testid={`history-mode-${mode.id}`}
                          onClick={() => {
                            soundEngine.playUiClick();
                            setHistoryModeFilter(mode.id);
                          }}
                          className={`rounded-lg px-2.5 py-1 text-xs font-bold cursor-pointer whitespace-nowrap ${
                            historyModeFilter === mode.id
                              ? 'bg-amber-500 text-slate-950'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
                      {(
                        [
                          { id: 'all', label: 'All Results' },
                          { id: 'won', label: 'Victories' },
                          { id: 'lost', label: 'Defeats' },
                        ] as const
                      ).map((res) => (
                        <button
                          key={res.id}
                          type="button"
                          data-testid={`history-result-${res.id}`}
                          onClick={() => {
                            soundEngine.playUiClick();
                            setHistoryResultFilter(res.id);
                          }}
                          className={`rounded-lg px-2 py-1 text-[11px] font-bold cursor-pointer whitespace-nowrap ${
                            historyResultFilter === res.id
                              ? 'bg-amber-500 text-slate-950'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          {res.label}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <input
                        ref={importInputRef}
                        type="file"
                        accept=".json,application/json"
                        onChange={handleImportFile}
                        className="hidden"
                      />
                      <button
                        type="button"
                        data-testid="import-replay-btn"
                        onClick={() => {
                          soundEngine.playUiClick();
                          importInputRef.current?.click();
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-amber-500/12 px-2.5 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/20 cursor-pointer whitespace-nowrap"
                      >
                        <Upload className="h-3.5 w-3.5 text-amber-400" />
                        <span>Import Replay</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          void loadHistory();
                        }}
                        className="rounded-lg border border-white/12 bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                      >
                        Refresh
                      </button>
                    </div>
                  </div>

                  {/* Replay Archive Storage Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-[11px]">
                    <div className="inline-flex items-center gap-2 text-slate-300">
                      <HardDrive className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      <span className="font-semibold text-white">Local Replay Archive</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {replayStorageStats?.count ?? savedReplays.length}/
                        {replayStorageStats?.maxCount ?? 24} matches
                      </span>
                    </div>
                    <span className="font-mono tabular-nums text-slate-400">
                      {formatBytesCompact(replayStorageStats?.totalBytes ?? 0)} /{' '}
                      {formatBytesCompact(replayStorageStats?.maxBytes ?? 40 * 1024 * 1024)}
                    </span>
                  </div>

                  {historyImportNotice && (
                    <div
                      data-testid="import-replay-feedback"
                      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                        historyImportNotice.type === 'ok'
                          ? 'border-emerald-400/40 bg-emerald-500/12 text-emerald-200'
                          : 'border-rose-400/40 bg-rose-500/12 text-rose-200'
                      }`}
                    >
                      {historyImportNotice.text}
                    </div>
                  )}

                  {/* Unified Scrollable Archive + Online Server Ledger */}
                  <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-0.5">
                    {/* Saved Full-Match Replays */}
                    {filteredSaved.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                          Saved Full-Match Replays ({filteredSaved.length})
                        </div>
                        {filteredSaved.map((r) => {
                          const won = didPlayerWinSavedReplay(r, ownProfile, onlineProfile.displayName);
                          return (
                            <div
                              key={r.replayId}
                              data-testid={`saved-replay-card-${r.replayId}`}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/25 bg-[#101823] px-3.5 py-2.5 text-xs"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5 font-bold text-white">
                                  <span>
                                    {r.player1Name} <span className="text-slate-500">vs</span>{' '}
                                    {r.player2Name}
                                  </span>
                                  <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-300">
                                    {r.matchType === 'ai'
                                      ? `AI · ${r.aiDifficulty ?? 'pro'}`
                                      : r.matchType === 'online'
                                        ? `Online · ${r.onlineSubType ?? 'quick'}`
                                        : 'Local PvP'}
                                  </span>
                                  {won !== null && (
                                    <span
                                      className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                                        won
                                          ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                                          : 'border-rose-400/40 bg-rose-500/15 text-rose-300'
                                      }`}
                                    >
                                      {won ? 'Victory' : 'Defeat'}
                                    </span>
                                  )}
                                  {!r.authoritative && r.matchType === 'online' && (
                                    <span className="rounded border border-sky-400/35 bg-sky-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-sky-200">
                                      Imported
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
                                  <span className="text-slate-200">{r.finalResult}</span>
                                  <span>·</span>
                                  <span className="font-mono tabular-nums">
                                    {r.totalShots} shots · {formatDuration(r.durationSec)}
                                  </span>
                                  {r.highlightCount > 0 && (
                                    <>
                                      <span>·</span>
                                      <span className="text-amber-300">
                                        {r.highlightCount} highlights
                                      </span>
                                    </>
                                  )}
                                  <span>·</span>
                                  <span>{formatShortDate(r.endedAtMs)}</span>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  data-testid={`watch-saved-replay-${r.replayId}`}
                                  onClick={() => {
                                    soundEngine.playUiClick();
                                    requestWatchSavedReplay(r.replayId);
                                  }}
                                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-amber-500 px-2.5 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                                >
                                  <Film className="h-3.5 w-3.5" />
                                  <span>Watch Replay</span>
                                </button>
                                <button
                                  type="button"
                                  data-testid={`export-saved-replay-${r.replayId}`}
                                  title="Export replay JSON"
                                  aria-label="Export replay JSON"
                                  onClick={() => void handleExportSaved(r.replayId, r.matchId)}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/12 bg-white/5 text-slate-200 hover:bg-white/10 cursor-pointer"
                                >
                                  <Download className="h-3.5 w-3.5 text-amber-400" />
                                </button>
                                <button
                                  type="button"
                                  data-testid={`delete-saved-replay-${r.replayId}`}
                                  title="Delete saved replay"
                                  aria-label="Delete saved replay"
                                  onClick={() => void handleDeleteSaved(r.replayId)}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/12 bg-white/5 text-slate-300 hover:border-rose-400/50 hover:text-rose-300 cursor-pointer"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Server Online Competitive Match Ledger */}
                    {(historyModeFilter === 'all' || historyModeFilter === 'online') && (
                      <div className="space-y-2 pt-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            Online Server Match Ledger
                          </span>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/35 p-0.5">
                              <button
                                type="button"
                                onClick={() => {
                                  soundEngine.playUiClick();
                                  setHistoryFilterOwn(false);
                                }}
                                className={`rounded px-2 py-0.5 text-[10px] font-bold cursor-pointer whitespace-nowrap ${
                                  !historyFilterOwn
                                    ? 'bg-amber-500 text-slate-950'
                                    : 'text-slate-300 hover:text-white'
                                }`}
                              >
                                Global
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  soundEngine.playUiClick();
                                  setHistoryFilterOwn(true);
                                }}
                                className={`rounded px-2 py-0.5 text-[10px] font-bold cursor-pointer whitespace-nowrap ${
                                  historyFilterOwn
                                    ? 'bg-amber-500 text-slate-950'
                                    : 'text-slate-300 hover:text-white'
                                }`}
                              >
                                My Matches
                              </button>
                            </div>

                            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/35 p-0.5">
                              {(
                                [
                                  { id: 'all', label: 'All' },
                                  { id: 'ranked', label: 'Ranked' },
                                  { id: 'quick', label: 'Quick' },
                                  { id: 'private', label: 'Private' },
                                  { id: 'tournament', label: 'Tournament' },
                                ] as Array<{ id: OnlineMatchType | 'all'; label: string }>
                              ).map((mt) => (
                                <button
                                  key={mt.id}
                                  type="button"
                                  data-testid={`history-type-${mt.id}`}
                                  onClick={() => {
                                    soundEngine.playUiClick();
                                    setHistoryMatchType(mt.id);
                                  }}
                                  className={`rounded px-2 py-0.5 text-[10px] font-bold cursor-pointer whitespace-nowrap ${
                                    historyMatchType === mt.id
                                      ? 'bg-amber-500 text-slate-950'
                                      : 'text-slate-300 hover:text-white'
                                  }`}
                                >
                                  {mt.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        {historyLoading ? (
                          <div className="py-6 text-center text-xs text-slate-400">
                            Loading online match ledger...
                          </div>
                        ) : filteredOnlineLedger.length === 0 ? (
                          <div className="rounded-xl border border-white/10 bg-black/25 py-6 text-center text-xs text-slate-400">
                            No online ledger records matching this filter.
                          </div>
                        ) : (
                          filteredOnlineLedger.map((m) => {
                            const saved = savedByMatchId.get(m.matchId);
                            return (
                              <div
                                key={m.matchId}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 text-xs"
                              >
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5 font-bold text-white">
                                    <button
                                      type="button"
                                      disabled={!m.player1Id}
                                      onClick={() => m.player1Id && setInspectedPlayerId(m.player1Id)}
                                      className="hover:underline disabled:no-underline cursor-pointer disabled:cursor-default"
                                    >
                                      {m.player1Name}
                                    </button>
                                    {m.p1RankTier && <RankBadge tier={m.p1RankTier} size="xs" />}
                                    <span className="text-slate-500">vs</span>
                                    <button
                                      type="button"
                                      disabled={!m.player2Id}
                                      onClick={() => m.player2Id && setInspectedPlayerId(m.player2Id)}
                                      className="hover:underline disabled:no-underline cursor-pointer disabled:cursor-default"
                                    >
                                      {m.player2Name}
                                    </button>
                                    {m.p2RankTier && <RankBadge tier={m.p2RankTier} size="xs" />}
                                  </div>
                                  <div className="mt-0.5 text-[11px] text-slate-400">
                                    Winner:{' '}
                                    <span className="font-semibold text-amber-300">
                                      {m.winnerName}
                                    </span>
                                    {' · '}
                                    {m.ruleProfileId === 'wpa' ? 'Strict WPA' : 'Casual'}
                                    {' · '}
                                    {formatMatchTypeLabel(m.matchType)}
                                    {' · '}
                                    {m.reason}
                                  </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums text-[11px] shrink-0">
                                  {m.rankedApplied &&
                                    (m.p1EloDelta !== undefined || m.p2EloDelta !== undefined) && (
                                      <span className="text-slate-300">
                                        {m.p1EloBefore !== undefined && m.p1EloAfter !== undefined
                                          ? `${m.p1EloBefore}→${m.p1EloAfter}`
                                          : m.p1EloDelta !== undefined &&
                                            (m.p1EloDelta >= 0 ? `+${m.p1EloDelta}` : m.p1EloDelta)}
                                        {' / '}
                                        {m.p2EloBefore !== undefined && m.p2EloAfter !== undefined
                                          ? `${m.p2EloBefore}→${m.p2EloAfter}`
                                          : m.p2EloDelta !== undefined &&
                                            (m.p2EloDelta >= 0 ? `+${m.p2EloDelta}` : m.p2EloDelta)}{' '}
                                        ELO
                                      </span>
                                    )}
                                  <span className="inline-flex items-center gap-1 text-slate-400">
                                    <Clock className="h-3 w-3" />
                                    {m.durationSec !== undefined
                                      ? formatDuration(m.durationSec)
                                      : `${m.totalShots} shots`}
                                  </span>
                                  <span className="text-slate-400">
                                    {formatShortDate(m.endedAtMs)}
                                  </span>
                                  {saved ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        soundEngine.playUiClick();
                                        requestWatchSavedReplay(saved.replayId);
                                      }}
                                      className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-1 font-sans text-[10px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                                    >
                                      <Film className="h-3 w-3" />
                                      Replay
                                    </button>
                                  ) : (
                                    <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-sans text-[10px] text-slate-400">
                                      Ledger
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}

                    {filteredSaved.length === 0 &&
                      (historyModeFilter === 'ai' || historyModeFilter === 'local') && (
                        <div className="rounded-xl border border-white/10 bg-black/25 py-8 text-center text-xs text-slate-400">
                          Complete a {historyModeFilter.toUpperCase()} match or import a replay JSON file to watch recorded matches here.
                        </div>
                      )}
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-bold uppercase tracking-wider text-amber-400">
                  Fair Play Standing &amp; Penalty Appeals
                </div>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    void loadFairPlay();
                  }}
                  className="rounded-lg border border-white/12 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-200 hover:bg-white/10 cursor-pointer"
                >
                  Refresh
                </button>
              </div>

              {fairPlayLoading && !moderationStatus ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  Loading Fair Play standing...
                </div>
              ) : !moderationStatus ? (
                <div className="rounded-xl border border-white/10 bg-black/25 p-5 text-center text-xs text-slate-400">
                  Sign in or establish your competitive session to review Fair Play standing.
                </div>
              ) : (
                <>
                  {/* Account Standing Card */}
                  <div
                    className={`rounded-xl border p-4 ${
                      moderationStatus.canPlayOnline && moderationStatus.canPlayRanked
                        ? 'border-emerald-400/35 bg-emerald-500/8'
                        : 'border-rose-500/40 bg-rose-500/10'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {moderationStatus.canPlayOnline && moderationStatus.canPlayRanked ? (
                        <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <ShieldAlert className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-extrabold text-white">
                          {moderationStatus.canPlayOnline && moderationStatus.canPlayRanked
                            ? 'Account in Good Standing'
                            : !moderationStatus.canPlayOnline
                              ? 'Online Play Suspended'
                              : 'Ranked Queue Restricted'}
                        </div>
                        <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                          {moderationStatus.canPlayOnline && moderationStatus.canPlayRanked
                            ? 'Your account is eligible for Ranked Matchmaking, Quick Match, Private Rooms, and Official Tournaments.'
                            : !moderationStatus.canPlayOnline
                              ? 'Online rooms and matchmaking are temporarily paused while an active suspension is in effect.'
                              : 'Ranked Matchmaking is restricted while an active Ranked restriction applies. Casual Quick Match and Private Rooms remain available.'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Active & Recent Penalties */}
                  <div className="rounded-xl border border-white/10 bg-black/25 p-3.5 space-y-2.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                      Penalties &amp; Warnings ({moderationStatus.recentPenalties.length})
                    </div>

                    {moderationStatus.recentPenalties.length === 0 ? (
                      <div className="py-3 text-xs text-slate-400">
                        No warnings, restrictions, or suspensions recorded on this account.
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-[190px] overflow-y-auto">
                        {moderationStatus.recentPenalties.map((pen) => (
                          <div
                            key={pen.penaltyId}
                            className="rounded-lg border border-white/10 bg-[#0b1017] px-3 py-2 text-xs space-y-1"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-1.5 font-extrabold text-white">
                                <AlertTriangle
                                  className={`h-3.5 w-3.5 ${
                                    pen.active ? 'text-rose-400' : 'text-slate-400'
                                  }`}
                                />
                                {formatPenaltyType(pen.penaltyType)}
                              </span>
                              <span
                                className={`font-mono text-[10px] font-bold uppercase ${
                                  pen.revokedAtMs
                                    ? 'text-emerald-300'
                                    : pen.active
                                      ? 'text-rose-300'
                                      : 'text-slate-400'
                                }`}
                              >
                                {pen.revokedAtMs
                                  ? 'Revoked'
                                  : pen.active
                                    ? 'Active'
                                    : 'Expired'}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-300">{pen.reason}</p>
                            <div className="text-[10px] text-slate-400">
                              Issued {formatShortDate(pen.issuedAtMs)}
                              {' · '}
                              By {pen.issuedBy}
                              {' · '}
                              {pen.expiresAtMs
                                ? `Expires ${formatShortDate(pen.expiresAtMs)}`
                                : 'No automatic expiry'}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Submit Appeal Form (when appealable penalty exists) */}
                  {(() => {
                    const pendingIds = new Set(
                      moderationStatus.appeals
                        .filter((a) => a.status === 'pending')
                        .map((a) => a.penaltyId),
                    );
                    const appealable = moderationStatus.recentPenalties.filter(
                      (p) => !p.revokedAtMs && !pendingIds.has(p.penaltyId),
                    );
                    if (appealable.length === 0) return null;

                    return (
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!appealPenaltyId || appealMessage.trim().length < 5) return;
                          soundEngine.playUiClick();
                          setAppealBusy(true);
                          setAppealFeedback(null);
                          const res = await progressionClient.submitPenaltyAppeal(
                            appealPenaltyId,
                            appealMessage.trim(),
                          );
                          setAppealBusy(false);
                          if (res.ok) {
                            setAppealMessage('');
                            setAppealFeedback({
                              type: 'ok',
                              text: 'Appeal submitted for moderation review.',
                            });
                          } else {
                            setAppealFeedback({
                              type: 'err',
                              text: res.error ?? 'Failed to submit appeal.',
                            });
                          }
                        }}
                        className="rounded-xl border border-amber-400/25 bg-black/25 p-3.5 space-y-2.5"
                      >
                        <div className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
                          Submit Moderation Appeal
                        </div>
                        <select
                          value={appealPenaltyId}
                          onChange={(e) => setAppealPenaltyId(e.target.value)}
                          className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                        >
                          {appealable.map((p) => (
                            <option key={p.penaltyId} value={p.penaltyId}>
                              {formatPenaltyType(p.penaltyType)} — {p.reason.slice(0, 48)}
                            </option>
                          ))}
                        </select>
                        <textarea
                          rows={2}
                          required
                          minLength={5}
                          maxLength={500}
                          value={appealMessage}
                          onChange={(e) => setAppealMessage(e.target.value)}
                          placeholder="Explain why this penalty should be reviewed or lifted (5–500 chars)..."
                          className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                        />
                        {appealFeedback && (
                          <div
                            className={`text-[11px] font-semibold ${
                              appealFeedback.type === 'ok' ? 'text-emerald-300' : 'text-rose-300'
                            }`}
                          >
                            {appealFeedback.text}
                          </div>
                        )}
                        <div className="flex justify-end">
                          <button
                            type="submit"
                            data-testid="submit-appeal-btn"
                            disabled={appealBusy || appealMessage.trim().length < 5}
                            className="rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer"
                          >
                            {appealBusy ? 'Submitting...' : 'Submit Appeal'}
                          </button>
                        </div>
                      </form>
                    );
                  })()}

                  {/* Submitted Appeals List */}
                  {moderationStatus.appeals.length > 0 && (
                    <div className="rounded-xl border border-white/10 bg-black/25 p-3.5 space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                        Your Appeals ({moderationStatus.appeals.length})
                      </div>
                      <div className="space-y-2 max-h-[160px] overflow-y-auto">
                        {moderationStatus.appeals.map((ap) => (
                          <div
                            key={ap.appealId}
                            className="rounded-lg border border-white/10 bg-[#0b1017] px-3 py-2 text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-[10px] text-slate-400">
                                {formatShortDate(ap.submittedAtMs)}
                              </span>
                              <span
                                className={`font-bold uppercase text-[10px] ${
                                  ap.status === 'approved'
                                    ? 'text-emerald-300'
                                    : ap.status === 'rejected'
                                      ? 'text-rose-300'
                                      : 'text-amber-300'
                                }`}
                              >
                                {ap.status}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-200">{ap.message}</p>
                            {ap.adminNotes && (
                              <p className="text-[11px] text-slate-400">
                                Moderator Note: {ap.adminNotes}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
