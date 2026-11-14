import {
  Award,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Compass,
  Copy,
  Crosshair,
  Crown,
  Flame,
  History,
  KeyRound,
  LogIn,
  LogOut,
  Search,
  Shield,
  Star,
  Target,
  Trophy,
  User,
  UserCheck,
  UserPlus,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { soundEngine } from '../game/utils/SoundEngine';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { progressionClient } from '../multiplayer/ProgressionClient';
import {
  ACHIEVEMENTS_CATALOG,
  type AchievementIconId,
  type LeaderboardResponse,
  type LeaderboardScope,
  type PublicPlayerProfile,
} from '../multiplayer/shared/progression';
import {
  ONLINE_AVATARS,
  type MatchHistoryRecord,
  type OnlineAvatarId,
} from '../multiplayer/shared/protocol';
import { type ProgressionTab, useGameStore } from '../store/useGameStore';

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
  const avatar = ONLINE_AVATARS.find((a) => a.id === profile.avatarId) ?? ONLINE_AVATARS[0];
  const { stats, levelProgress } = profile;

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

          <div className="flex items-center gap-2.5">
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {(
          [
            { label: 'Casual Rules', data: stats.byMatchType.casual },
            { label: 'Strict WPA', data: stats.byMatchType.wpa },
            { label: 'Quick Match', data: stats.byMatchType.quick },
            { label: 'Private Room', data: stats.byMatchType.private },
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
  const [lbPage, setLbPage] = useState(1);
  const [lbQuery, setLbQuery] = useState('');
  const [lbData, setLbData] = useState<LeaderboardResponse | null>(null);
  const [lbLoading, setLbLoading] = useState(false);

  // History state
  const [historyFilterOwn, setHistoryFilterOwn] = useState(false);
  const [historyItems, setHistoryItems] = useState<MatchHistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

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
      page: lbPage,
      limit: 15,
      query: lbQuery,
    });
    setLbData(data);
    setLbLoading(false);
  }, [lbScope, lbPage, lbQuery]);

  useEffect(() => {
    if (!progressionModalOpen || inspectedPlayerId || progressionTab !== 'leaderboard') return;
    const handle = window.setTimeout(() => {
      void loadLeaderboard();
    }, 150);
    return () => window.clearTimeout(handle);
  }, [progressionModalOpen, inspectedPlayerId, progressionTab, loadLeaderboard]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const matches = await progressionClient.fetchMatchHistory({
      playerId: historyFilterOwn && ownProfile ? ownProfile.playerId : null,
      limit: 30,
    });
    setHistoryItems(matches);
    setHistoryLoading(false);
  }, [historyFilterOwn, ownProfile]);

  useEffect(() => {
    if (!progressionModalOpen || inspectedPlayerId || progressionTab !== 'history') return;
    void loadHistory();
  }, [progressionModalOpen, inspectedPlayerId, progressionTab, loadHistory]);

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
      <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-2xl border border-white/15 bg-[#0c1219] p-4 sm:p-6 text-slate-100 shadow-2xl">
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
          <div className="mt-3.5 grid grid-cols-4 gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
            {(
              [
                { id: 'profile', label: 'My Profile', icon: User },
                { id: 'leaderboard', label: 'Leaderboard', icon: Trophy },
                { id: 'achievements', label: 'Achievements', icon: Award },
                { id: 'history', label: 'Match History', icon: History },
              ] as Array<{ id: ProgressionTab; label: string; icon: typeof User }>
            ).map((tab) => {
              const Icon = tab.icon;
              const active = progressionTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    setProgressionTab(tab.id);
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap ${
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
                <ProfileDetailsView profile={ownProfile} isOwn />
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
                      { id: 'weekly', label: 'Weekly (7d)' },
                      { id: 'monthly', label: 'Monthly (30d)' },
                    ] as Array<{ id: LeaderboardScope; label: string }>
                  ).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        setLbScope(s.id);
                        setLbPage(1);
                      }}
                      className={`rounded-lg px-3 py-1 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap ${
                        lbScope === s.id
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                <div className="relative flex-1 min-w-[180px] max-w-xs">
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

              {/* Current Player Rank Highlight */}
              {lbData?.currentPlayer && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-black text-amber-300">
                      #{lbData.currentPlayer.rank}
                    </span>
                    <span className="font-bold text-white">
                      Your Standing ({lbData.currentPlayer.displayName})
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
                      <th className="px-3 py-2 text-right">Lv</th>
                      <th className="px-3 py-2 text-right">W–L</th>
                      <th className="px-3 py-2 text-right">Win %</th>
                      <th className="px-3 py-2 text-right">
                        {lbScope === 'global' ? 'ELO' : 'Period Δ / ELO'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {lbLoading ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-400">
                          Loading rankings...
                        </td>
                      </tr>
                    ) : !lbData || lbData.items.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-400">
                          No ranked competitors found for this filter.
                        </td>
                      </tr>
                    ) : (
                      lbData.items.map((row) => {
                        const av =
                          ONLINE_AVATARS.find((a) => a.id === row.avatarId) ?? ONLINE_AVATARS[0];
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
                              {lbScope === 'global' ? (
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
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.playUiClick();
                      setHistoryFilterOwn(false);
                    }}
                    className={`rounded-lg px-3 py-1 text-xs font-bold cursor-pointer whitespace-nowrap ${
                      !historyFilterOwn
                        ? 'bg-amber-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    Global Matches
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.playUiClick();
                      setHistoryFilterOwn(true);
                    }}
                    className={`rounded-lg px-3 py-1 text-xs font-bold cursor-pointer whitespace-nowrap ${
                      historyFilterOwn
                        ? 'bg-amber-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    My Matches
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    void loadHistory();
                  }}
                  className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                >
                  Refresh
                </button>
              </div>

              <div className="space-y-2 max-h-[380px] overflow-y-auto">
                {historyLoading ? (
                  <div className="py-10 text-center text-xs text-slate-400">
                    Loading match history...
                  </div>
                ) : historyItems.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/25 py-10 text-center text-xs text-slate-400">
                    No recorded online matches found.
                  </div>
                ) : (
                  historyItems.map((m) => (
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
                          <span className="text-slate-500">vs</span>
                          <button
                            type="button"
                            disabled={!m.player2Id}
                            onClick={() => m.player2Id && setInspectedPlayerId(m.player2Id)}
                            className="hover:underline disabled:no-underline cursor-pointer disabled:cursor-default"
                          >
                            {m.player2Name}
                          </button>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-400">
                          Winner: <span className="font-semibold text-amber-300">{m.winnerName}</span>
                          {' · '}
                          {m.ruleProfileId === 'wpa' ? 'Strict WPA' : 'Casual'}
                          {' · '}
                          {m.matchType === 'private' ? 'Private' : 'Quick'}
                          {' · '}
                          {m.reason}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 font-mono tabular-nums text-[11px] shrink-0">
                        {m.rankedApplied && (m.p1EloDelta !== undefined || m.p2EloDelta !== undefined) && (
                          <span className="text-slate-300">
                            {m.p1EloDelta !== undefined &&
                              (m.p1EloDelta >= 0 ? `+${m.p1EloDelta}` : m.p1EloDelta)}
                            {' / '}
                            {m.p2EloDelta !== undefined &&
                              (m.p2EloDelta >= 0 ? `+${m.p2EloDelta}` : m.p2EloDelta)}{' '}
                            ELO
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1 text-slate-400">
                          <Clock className="h-3 w-3" />
                          {m.durationSec !== undefined ? formatDuration(m.durationSec) : `${m.totalShots}s`}
                        </span>
                        <span className="text-slate-400">{formatShortDate(m.endedAtMs)}</span>
                      </div>
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
