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
import { COSMETIC_CATALOG_MAP, getAvatarVisualMeta, getBadgeVisualMeta } from '../multiplayer/shared/economy';
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
import type { PresenceStatus, SocialReportReason } from '../multiplayer/shared/social';
import {
  formatLocalizedDuration,
  getActiveRuntimeLanguage,
  localizeAchievement,
  localizeAiDifficulty,
  localizeAvatarLabel,
  localizeCosmeticItem,
  localizeFoulOrReason,
  localizeOnlineMatchType,
  localizePlayerName,
  localizePresence,
  localizeRankTierName,
  localizeReplayError,
  localizeRuleProfile,
  localizeSeasonNameAndTheme,
  localizeServerError,
  tLang,
  useTranslation,
} from '../i18n';
import type { AppLanguage } from '../i18n';
import { type ProgressionTab, useGameStore } from '../store/useGameStore';
import { RankBadge, RankProgressCard } from './RankBadge';
import { presenceDotClass } from './SocialModal';

function localizeSeasonLabel(name: string, lang: AppLanguage, seasonNumHint?: number): string {
  if (lang === 'en') return name;
  if (seasonNumHint) {
    return localizeSeasonNameAndTheme(seasonNumHint, name, '', lang).name;
  }
  const romanMap: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 };
  const romanMatch = name.match(/Season\s+(IV|III|II|I)\b/i);
  if (romanMatch) {
    const num = romanMap[romanMatch[1].toUpperCase()] ?? 1;
    return localizeSeasonNameAndTheme(num, name, '', lang).name;
  }
  const numMatch = name.match(/Season\s+(\d+)/i);
  if (numMatch) {
    return localizeSeasonNameAndTheme(Number(numMatch[1]), name, '', lang).name;
  }
  return name;
}

function formatPenaltyType(t: PenaltyType, lang: AppLanguage = getActiveRuntimeLanguage()): string {
  switch (t) {
    case 'warning':
      return tLang(lang, 'progression.penaltyTypeWarning');
    case 'ranked_restriction':
      return tLang(lang, 'progression.penaltyTypeRankedRestriction');
    case 'temp_suspension':
      return tLang(lang, 'progression.penaltyTypeTempSuspension');
    case 'permanent_suspension':
      return tLang(lang, 'progression.penaltyTypePermanentSuspension');
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

function formatLastSeenCompact(
  lastSeenAtMs: number | null | undefined,
  presence: PresenceStatus | undefined,
  lang: AppLanguage,
): string {
  if (presence && presence !== 'offline') return localizePresence(presence, lang);
  if (!lastSeenAtMs || lastSeenAtMs <= 0) return tLang(lang, 'progression.lastSeenHidden');
  const diffMin = Math.max(0, Math.floor((Date.now() - lastSeenAtMs) / 60_000));
  if (diffMin < 1) return tLang(lang, 'progression.lastSeenJustNow');
  if (diffMin < 60) return tLang(lang, 'progression.lastSeenMinAgo', { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return tLang(lang, 'progression.lastSeenHrAgo', { count: diffHr });
  return tLang(lang, 'progression.lastSeenDayAgo', { count: Math.floor(diffHr / 24) });
}

function ProfileDetailsView({
  profile,
  isOwn,
}: {
  profile: PublicPlayerProfile;
  isOwn: boolean;
}) {
  const { t, language, formatNumber, formatDate } = useTranslation();
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
    setSocialFeedback(
      res.ok ? okText : localizeServerError(res.error, language) || t('common.actionFailed'),
    );
  };

  const presence = profile.presence ?? 'offline';
  const badgeMeta = getBadgeVisualMeta(profile.equippedCosmetics?.badgeId);
  const cueDef = profile.equippedCosmetics?.cueId
    ? COSMETIC_CATALOG_MAP.get(profile.equippedCosmetics.cueId)
    : undefined;
  const ballDef = profile.equippedCosmetics?.ballId
    ? COSMETIC_CATALOG_MAP.get(profile.equippedCosmetics.ballId)
    : undefined;
  const tableDef = profile.equippedCosmetics?.tableId
    ? COSMETIC_CATALOG_MAP.get(profile.equippedCosmetics.tableId)
    : undefined;

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
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className="truncate text-lg font-extrabold text-white">
                  {localizePlayerName(profile.displayName, null, language)}
                </h3>
                {profile.club && (
                  <span
                    dir="ltr"
                    className="rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-black"
                    style={{
                      borderColor: `${profile.club.emblemColor}66`,
                      backgroundColor: `${profile.club.emblemColor}20`,
                      color: profile.club.emblemColor,
                    }}
                  >
                    [{profile.club.tag}] {profile.club.name}
                  </span>
                )}
                {badgeMeta && (
                  <span
                    className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-bold ${badgeMeta.className}`}
                  >
                    <span>{badgeMeta.glyph}</span>
                    <span>{badgeMeta.shortLabel}</span>
                  </span>
                )}
                <span
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                    profile.isGuest
                      ? 'border-white/15 bg-white/5 text-slate-300'
                      : 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                  }`}
                >
                  {profile.isGuest ? t('progression.publicGuestBadge') : `@${profile.username}`}
                </span>
                {isOwn && (
                  <span className="rounded-md border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                    {t('common.you')}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-400">
                <span>{t('progression.idPrefix', { id: profile.playerId })}</span>
                <span>·</span>
                <span className="inline-flex items-center gap-1 font-sans font-semibold text-slate-300">
                  <span className={`h-2 w-2 rounded-full ${presenceDotClass(presence)}`} />
                  {formatLastSeenCompact(profile.lastSeenAtMs, presence, language)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <RankBadge elo={profile.elo} tier={profile.rankTier} size="sm" />
            <div className="rounded-lg border border-white/10 bg-[#0b1017] px-3 py-1.5 text-end">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {t('progression.globalRankLabel')}
              </div>
              <div dir="ltr" className="font-mono text-sm font-extrabold tabular-nums text-white">
                {profile.rank ? `#${profile.rank}` : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-amber-400/35 bg-amber-500/10 px-3 py-1.5 text-end">
              <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                {t('progression.eloRatingLabel')}
              </div>
              <div dir="ltr" className="font-mono text-base font-black tabular-nums text-amber-300">
                {formatNumber(profile.elo)}
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
                      t('progression.playerUnblockedNotice'),
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-400/35 bg-rose-500/12 px-2.5 py-1 text-[11px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer"
                >
                  {t('progression.unblockPlayerBtn')}
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
                            t('progression.inviteSentNotice'),
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                      >
                        <Swords className="h-3 w-3" />
                        {t('progression.invite1v1Btn')}
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
                        {t('social.directMessageBtn')}
                      </button>
                      <button
                        type="button"
                        disabled={socialBusy}
                        onClick={() =>
                          runSocialAction(
                            () => socialClient.removeFriend(profile.playerId),
                            t('progression.removedFriendNotice'),
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:border-rose-400/40 hover:text-rose-200 cursor-pointer"
                      >
                        <UserMinus className="h-3 w-3" />
                        {t('progression.removeFriendBtn')}
                      </button>
                    </>
                  ) : hasIncoming ? (
                    <button
                      type="button"
                      disabled={socialBusy}
                      onClick={() =>
                        runSocialAction(
                          () => socialClient.respondFriendRequest(profile.playerId, 'accept'),
                          t('progression.acceptedFriendNotice'),
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer"
                    >
                      <Check className="h-3 w-3" />
                      {t('progression.acceptFriendBtn')}
                    </button>
                  ) : hasOutgoing ? (
                    <button
                      type="button"
                      disabled={socialBusy}
                      onClick={() =>
                        runSocialAction(
                          () => socialClient.respondFriendRequest(profile.playerId, 'cancel'),
                          t('progression.cancelledRequestNotice'),
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:bg-white/10 cursor-pointer"
                    >
                      {t('progression.cancelRequestBtn')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={socialBusy}
                      onClick={() =>
                        runSocialAction(
                          () => socialClient.sendFriendRequest(profile.playerId),
                          t('progression.friendRequestSentNotice'),
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                    >
                      <UserPlus className="h-3 w-3" />
                      {t('social.addFriendBtn')}
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={socialBusy}
                    onClick={() =>
                      runSocialAction(
                        () => socialClient.blockPlayer(profile.playerId),
                        t('progression.playerBlockedNotice'),
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:border-rose-400/40 hover:text-rose-200 cursor-pointer"
                  >
                    <Ban className="h-3 w-3" />
                    {t('social.blockBtn')}
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => setReportOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:border-rose-400/40 hover:text-rose-200 cursor-pointer"
              >
                <Flag className="h-3 w-3" />
                {t('social.reportBtn')}
              </button>
            </div>

            {reportOpen && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-950/20 p-2">
                <select
                  value={reportReason}
                  onChange={(e) => setReportReason(e.target.value as SocialReportReason)}
                  className="rounded border border-white/15 bg-[#0b1017] px-2 py-1 text-[11px] text-white"
                >
                  <option value="harassment">{t('social.reportReasonHarassment')}</option>
                  <option value="spam">{t('social.reportReasonSpam')}</option>
                  <option value="inappropriate_name">{t('social.reportReasonInappropriateName')}</option>
                  <option value="cheating">{t('social.reportReasonCheating')}</option>
                  <option value="other">{t('social.reportReasonOther')}</option>
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
                      t('progression.reportSubmittedNotice'),
                    );
                    setReportOpen(false);
                  }}
                  className="rounded bg-rose-500 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-rose-400 cursor-pointer"
                >
                  {t('social.submitReportBtn')}
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
              {t('common.level')} {levelProgress.level}
            </span>
            <span className="font-mono tabular-nums text-[11px] text-slate-300">
              {t('progression.totalXpSuffix', {
                cur: formatNumber(levelProgress.currentLevelXp),
                next: formatNumber(levelProgress.xpForNextLevel),
                total: formatNumber(levelProgress.totalXp),
              })}
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
        seasonName={
          profile.seasonStanding?.seasonName
            ? localizeSeasonLabel(profile.seasonStanding.seasonName, language)
            : undefined
        }
        seasonElo={profile.seasonStanding?.seasonElo}
      />

      {profile.seasonStanding && (
        <div className="rounded-xl border border-amber-400/25 bg-amber-500/5 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="font-bold text-amber-300">
              {localizeSeasonLabel(profile.seasonStanding.seasonName, language)}
            </div>
            <div className="font-mono tabular-nums text-[11px] text-slate-300">
              {profile.seasonStanding.leaderboardRank
                ? t('progression.seasonRankHash', { rank: profile.seasonStanding.leaderboardRank })
                : t('progression.unplacedSeason')}
              {' · '}
              {t('menu.statsWinsLosses', {
                wins: profile.seasonStanding.wins,
                losses: profile.seasonStanding.losses,
              })}
              {' · '}
              {t('progression.peakEloValue', {
                elo: formatNumber(profile.seasonStanding.peakSeasonElo),
              })}
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <span>
              {t('progression.highestDivisionLabel')}{' '}
              <span className="font-bold text-slate-200">
                {localizeRankTierName(
                  profile.seasonStanding.highestRankTier,
                  language,
                  getRankById(profile.seasonStanding.highestRankTier).name,
                )}
              </span>
            </span>
            <span className="font-mono tabular-nums text-amber-200">
              {t('progression.seasonTierRewardValue', {
                coins: formatNumber(
                  SEASON_CONFIG.rewardsByTier[profile.seasonStanding.highestRankTier].coins,
                ),
              })}
            </span>
          </div>
        </div>
      )}

      {profile.privacyFiltered ? (
        <div
          data-testid="profile-privacy-filtered-notice"
          className="rounded-xl border border-white/10 bg-black/25 px-4 py-6 text-center space-y-1.5"
        >
          <div className="text-xs font-extrabold text-slate-200">
            {t('progression.statsHiddenTitle')}
          </div>
          <p className="text-[11px] text-slate-400">{t('progression.statsHiddenDesc')}</p>
        </div>
      ) : (
        <>
          {/* Equipped Loadout Preview */}
          {(cueDef || ballDef || tableDef) && (
            <div className="rounded-xl border border-white/10 bg-black/25 p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400 mb-2">
                {t('progression.equippedLoadoutTitle')}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {[
                  { label: t('progression.slotCueStick'), item: cueDef },
                  { label: t('progression.slotBallSet'), item: ballDef },
                  { label: t('progression.slotTableCloth'), item: tableDef },
                ].map((slot) => (
                  <div
                    key={slot.label}
                    className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5"
                  >
                    <div className="min-w-0">
                      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
                        {slot.label}
                      </div>
                      <div className="truncate text-xs font-bold text-white">
                        {slot.item
                          ? localizeCosmeticItem(slot.item, language).name
                          : t('progression.standardIssue')}
                      </div>
                    </div>
                    {slot.item && (
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/25"
                        style={{ backgroundColor: slot.item.previewColors[0] }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Career Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: t('progression.metricTotalMatches'), value: formatNumber(stats.totalMatches) },
              {
                label: t('progression.metricWinsLosses'),
                value: t('menu.statsWinsLosses', { wins: stats.wins, losses: stats.losses }),
              },
              { label: t('progression.statWinRate'), value: `${stats.winRate.toFixed(1)}%` },
              { label: t('progression.metricPeakElo'), value: formatNumber(profile.peakElo) },
              { label: t('progression.statStreak'), value: formatNumber(stats.currentStreak) },
              { label: t('progression.statBestStreak'), value: formatNumber(stats.bestStreak) },
              { label: t('progression.metricTotalShots'), value: formatNumber(stats.totalShots) },
              {
                label: t('progression.metricSuccessfulShots'),
                value: formatNumber(stats.successfulShots),
              },
              { label: t('progression.statPocketed'), value: formatNumber(stats.ballsPocketed) },
              {
                label: t('progression.statBreakSuccess'),
                value: `${stats.breakSuccessRate.toFixed(1)}%`,
              },
              { label: t('progression.metricEightBallWins'), value: formatNumber(stats.eightBallWins) },
              {
                label: t('progression.metricAvgMatchTime'),
                value: formatLocalizedDuration(stats.avgMatchDurationSec),
                ltr: true,
              },
            ].map((metric) => (
              <div
                key={metric.label}
                className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  {metric.label}
                </div>
                <div
                  dir={'ltr' in metric && metric.ltr ? 'ltr' : undefined}
                  className="mt-0.5 font-mono text-sm font-bold tabular-nums text-white"
                >
                  {metric.value}
                </div>
              </div>
            ))}
          </div>

          {/* Mode Breakdown */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {(
              [
                { label: t('lobby.tabRanked'), data: stats.byMatchType.ranked ?? { matches: 0, wins: 0 } },
                { label: t('lobby.tabQuick'), data: stats.byMatchType.quick },
                { label: t('progression.modePrivateRoom'), data: stats.byMatchType.private },
                { label: t('progression.modeStrictWpa'), data: stats.byMatchType.wpa },
                { label: t('progression.modeCasualRules'), data: stats.byMatchType.casual },
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
                  {t('battlePass.pastWinsMatches', {
                    wins: m.data.wins,
                    matches: m.data.matches,
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Recent Verified Matches */}
          {profile.recentMatches && profile.recentMatches.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-black/25 p-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-2">
                {t('progression.recentMatchHistoryCount', { count: profile.recentMatches.length })}
              </div>
              <div className="space-y-1.5">
                {profile.recentMatches.map((m) => {
                  const won = m.winnerId === profile.playerId;
                  const isP1 = m.player1Id === profile.playerId;
                  const opponentName = localizePlayerName(
                    isP1 ? m.player2Name : m.player1Name,
                    null,
                    language,
                  );
                  const eloDelta = isP1 ? m.p1EloDelta : m.p2EloDelta;
                  return (
                    <div
                      key={m.matchId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-black uppercase ${
                            won
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-rose-500/20 text-rose-300'
                          }`}
                        >
                          {won ? t('progression.winBadge') : t('progression.lossBadge')}
                        </span>
                        <span className="truncate font-semibold text-white">
                          {t('progression.vsOpponent', { name: opponentName })}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {localizeOnlineMatchType(m.matchType, language)} ·{' '}
                          {t('common.shotsCount', { count: m.totalShots })}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-slate-400">
                        {typeof eloDelta === 'number' && eloDelta !== 0 && (
                          <span
                            dir="ltr"
                            className={eloDelta > 0 ? 'text-emerald-300' : 'text-rose-300'}
                          >
                            {eloDelta > 0 ? `+${eloDelta}` : eloDelta} {t('common.elo')}
                          </span>
                        )}
                        <span>{formatDate(m.endedAtMs)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Unlocked Trophies Preview */}
          <div className="rounded-xl border border-white/10 bg-black/25 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
                {t('progression.achievementsCountTitle', {
                  unlocked: profile.achievements.length,
                  total: ACHIEVEMENTS_CATALOG.length,
                })}
              </span>
            </div>
            {profile.achievements.length === 0 ? (
              <div className="py-2 text-xs text-slate-400">
                {t('progression.noAchievementsYet')}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {profile.achievements.map((ach) => {
                  const locAch = localizeAchievement(ach.id, ach.name, ach.description, language);
                  return (
                    <div
                      key={ach.id}
                      className="flex items-center gap-2.5 rounded-lg border border-amber-400/25 bg-amber-500/8 px-2.5 py-2"
                    >
                      <div className="shrink-0">{renderAchievementIcon(ach.icon, true)}</div>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-bold text-white">{locAch.name}</div>
                        <div className="text-[10px] text-slate-400">
                          {t('progression.unlockedOnDate', { date: formatDate(ach.unlockedAtMs) })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function ProgressionModal() {
  const { t, language, isRtl, formatNumber, formatDate } = useTranslation();
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
      const rawErr = progressionClient.getLastSessionError();
      setSessionError(
        rawErr ? localizeServerError(rawErr, language) : tLang(language, 'errors.connectionFailed'),
      );
    }
    void progressionClient.fetchRankedSeasons();
    void progressionClient.fetchModerationStatus();
  }, [ownProfile, language]);

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
    const cleanName = displayNameInput.trim().slice(0, 16) || t('common.player1');
    setSavingProfile(true);
    setProfileFeedback(null);
    multiplayerManager.updateProfile(cleanName, selectedAvatar, { syncProgression: false });
    const res = await progressionClient.updateProfile(cleanName, selectedAvatar);
    setSavingProfile(false);
    if (res.ok) {
      setSessionError(null);
      setProfileFeedback({ type: 'ok', text: t('progression.profileUpdatedNotice') });
    } else {
      setProfileFeedback({
        type: 'err',
        text: localizeServerError(res.error, language) || t('progression.profileSaveFailedErr'),
      });
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
          text: t('progression.accountSecuredNotice', {
            username: res.data?.username ?? authUsername,
          }),
        });
        setAuthMode('none');
        setAuthPassword('');
        multiplayerManager.reauthenticateSocketIdentity();
      } else {
        setAuthMessage({
          type: 'err',
          text: localizeServerError(res.error, language) || t('progression.registrationFailedErr'),
        });
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
          text: t('progression.signedInNotice', {
            displayName: res.data?.displayName ?? '',
            username: res.data?.username ?? authUsername,
          }),
        });
        setAuthMode('none');
        setAuthPassword('');
        multiplayerManager.reauthenticateSocketIdentity();
      } else {
        setAuthMessage({
          type: 'err',
          text: localizeServerError(res.error, language) || t('progression.signInFailedErr'),
        });
      }
    }
  };

  const handleSwitchToGuest = async () => {
    soundEngine.playUiClick();
    setAuthBusy(true);
    setAuthMessage(null);
    const prof = await progressionClient.ensurePlayerSession({
      displayName: t('common.player1'),
      avatarId: 'cue_gold',
      forceNewGuest: true,
    });
    setAuthBusy(false);
    if (prof) {
      setAuthMessage({
        type: 'ok',
        text: t('progression.switchedGuestNotice', { playerId: prof.playerId }),
      });
      multiplayerManager.reauthenticateSocketIdentity();
    }
  };

  const unlockedMap = new Map(
    (ownProfile?.achievements ?? []).map((a) => [a.id, a.unlockedAtMs]),
  );

  const tabDefinitions: Array<{ id: ProgressionTab; label: string; icon: typeof User }> = [
    { id: 'profile', label: t('progression.tabProfile'), icon: User },
    { id: 'leaderboard', label: t('progression.tabLeaderboard'), icon: Trophy },
    { id: 'achievements', label: t('progression.tabAchievements'), icon: Award },
    { id: 'history', label: t('progression.tabHistory'), icon: History },
    { id: 'fairplay', label: t('progression.tabFairPlay'), icon: Scale },
  ];

  const activeTabLabel =
    tabDefinitions.find((td) => td.id === progressionTab)?.label ?? t('progression.tabProfile');

  const localizeAchCategory = (cat: 'victories' | 'skill' | 'streaks' | 'competitive') => {
    switch (cat) {
      case 'victories':
        return t('progression.victoriesTab');
      case 'streaks':
        return t('progression.statStreak');
      case 'competitive':
        return t('menu.competeBadge');
      case 'skill':
      default:
        return language === 'ar' ? 'المهارة' : 'Skill';
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('progression.dialogAria')}
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
                {inspectedPlayerId ? t('progression.inspectedHeaderTitle') : t('progression.title')}
              </h2>
              <p className="text-[11px] text-slate-400">{t('progression.subtitle')}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              soundEngine.playUiClick();
              closeProgressionModal();
            }}
            aria-label={t('progression.closeAria')}
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
              {isRtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
              {t('progression.backToTabBtn', { tab: activeTabLabel })}
            </button>
          </div>
        ) : (
          <div className="mt-3.5 grid grid-cols-5 gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
            {tabDefinitions.map((tab) => {
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
                {t('progression.loadingPlayerProfile')}
              </div>
            ) : inspectedProfile ? (
              <ProfileDetailsView
                profile={inspectedProfile}
                isOwn={ownProfile?.playerId === inspectedProfile.playerId}
              />
            ) : (
              <div className="rounded-xl border border-white/10 bg-black/25 py-10 text-center text-xs text-slate-400">
                {t('progression.profileUnavailable')}
              </div>
            )
          ) : progressionTab === 'profile' ? (
            <div className="space-y-4">
              {/* Editable Identity & Avatar Strip */}
              <div className="rounded-xl border border-white/10 bg-black/30 p-3.5 space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div className="flex-1 min-w-[180px]">
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      {t('progression.displayNameLabel')}
                    </label>
                    <input
                      type="text"
                      maxLength={16}
                      value={displayNameInput}
                      onChange={(e) => setDisplayNameInput(e.target.value)}
                      className="w-full rounded-lg border border-white/12 bg-[#0b1017] px-2.5 py-1.5 text-xs font-semibold text-white focus:border-amber-400 focus:outline-none"
                      placeholder={t('lobby.playerNamePlaceholder')}
                    />
                  </div>

                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      {t('lobby.avatarLabel')}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {ONLINE_AVATARS.map((av) => {
                        const selected = selectedAvatar === av.id;
                        return (
                          <button
                            key={av.id}
                            type="button"
                            title={localizeAvatarLabel(av.id, av.label, language)}
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
                          const customAvLabel = localizeAvatarLabel(
                            selectedAvatar,
                            customAv.label,
                            language,
                          );
                          return (
                            <button
                              type="button"
                              title={t('lobby.storeItemTitle', { label: customAvLabel })}
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
                    {savingProfile ? t('common.saving') : t('progression.saveIdentityBtn')}
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
                              {t('common.copied')}
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3 text-amber-400" />
                              {t('progression.copyIdBtn')}
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
                          {t('common.retry')}
                        </button>
                      </div>
                    ) : (
                      <span>
                        {sessionLoading
                          ? t('progression.connectingService')
                          : t('progression.sessionNotInit')}
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
                        {t('progression.claimUsernameBtn')}
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
                      {t('progression.authToggleSignIn')}
                    </button>
                    {ownProfile && !ownProfile.isGuest && (
                      <button
                        type="button"
                        disabled={authBusy}
                        onClick={handleSwitchToGuest}
                        className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                      >
                        <LogOut className="h-3 w-3" />
                        {t('progression.newGuestBtn')}
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
                          ? t('progression.registerUpgradeHeading')
                          : t('progression.signInHeading')}
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
                        placeholder={t('progression.usernameRulesPlaceholder')}
                        className="rounded-lg border border-white/12 bg-black/40 px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                      />
                      <input
                        type="password"
                        required
                        minLength={6}
                        maxLength={72}
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        placeholder={t('progression.passwordPlaceholder')}
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
                          ? t('common.processing')
                          : authMode === 'register'
                            ? t('progression.upgradeAccountBtn')
                            : t('progression.signInSubmitBtn')}
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
                        {t('progression.tournamentPromoTitle')}
                      </span>
                      <span className="ms-2 text-slate-300">
                        {t('progression.tournamentPromoDesc')}
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
                      {t('progression.tournamentCareerBtn')}
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
                    {t('progression.retryConnectionBtn')}
                  </button>
                </div>
              ) : (
                <div className="rounded-xl border border-white/10 bg-black/25 py-8 text-center text-xs text-slate-400">
                  {t('progression.loadingTelemetry')}
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
                      { id: 'global', label: t('progression.leaderboardScopeGlobal') },
                      { id: 'season', label: t('progression.leaderboardScopeSeason') },
                      { id: 'weekly', label: t('progression.leaderboardScopeWeekly') },
                      { id: 'monthly', label: t('progression.leaderboardScopeMonthly') },
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
                        {localizeSeasonLabel(sec.name, language, sec.seasonNumber)} (
                        {sec.status === 'active'
                          ? t('progression.seasonActiveBadge')
                          : t('progression.seasonCompletedBadge')}
                        )
                      </option>
                    ))}
                  </select>
                )}

                <div className="relative flex-1 min-w-[160px] max-w-xs">
                  <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={lbQuery}
                    onChange={(e) => {
                      setLbQuery(e.target.value);
                      setLbPage(1);
                    }}
                    placeholder={t('progression.searchPlayerPlaceholder')}
                    className="w-full rounded-lg border border-white/12 bg-[#0b1017] ps-8 pe-3 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                  />
                </div>
              </div>

              {lbScope === 'season' && lbData?.season && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3.5 py-2 text-[11px]">
                  <span className="font-bold text-amber-300">
                    {localizeSeasonLabel(
                      lbData.season.name,
                      language,
                      lbData.season.seasonNumber,
                    )}
                  </span>
                  <span className="font-mono tabular-nums text-slate-400">
                    {formatDate(lbData.season.startsAtMs)} –{' '}
                    {formatDate(lbData.season.endsAtMs)} ·{' '}
                    {lbData.season.status === 'active'
                      ? t('progression.seasonActiveBadge')
                      : t('progression.seasonCompletedBadge')}
                  </span>
                </div>
              )}

              {/* Current Player Rank Highlight */}
              {lbData?.currentPlayer && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span dir="ltr" className="font-mono font-black text-amber-300">
                      #{lbData.currentPlayer.rank}
                    </span>
                    <RankBadge
                      elo={lbData.currentPlayer.elo}
                      tier={lbData.currentPlayer.rankTier}
                      size="xs"
                    />
                    <span className="font-bold text-white">
                      {localizePlayerName(lbData.currentPlayer.displayName, null, language)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 font-mono tabular-nums text-[11px] text-slate-200">
                    <span>
                      {t('common.levelShort')} {lbData.currentPlayer.level}
                    </span>
                    <span>
                      {t('menu.statsWinsLosses', {
                        wins: lbData.currentPlayer.wins,
                        losses: lbData.currentPlayer.losses,
                      })}
                    </span>
                    <span className="font-extrabold text-amber-300">
                      {formatNumber(lbData.currentPlayer.elo)} {t('common.elo')}
                    </span>
                  </div>
                </div>
              )}

              {/* Leaderboard Table */}
              <div className="overflow-x-auto rounded-xl border border-white/10 bg-black/25">
                <table className="w-full text-start text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <th className="px-3 py-2 text-start">{t('progression.colRank')}</th>
                      <th className="px-3 py-2 text-start">{t('progression.colPlayer')}</th>
                      <th className="px-3 py-2 text-start">{t('progression.colDivision')}</th>
                      <th className="px-3 py-2 text-end">{t('progression.colLv')}</th>
                      <th className="px-3 py-2 text-end">{t('progression.colWl')}</th>
                      <th className="px-3 py-2 text-end">{t('progression.colWinRate')}</th>
                      <th className="px-3 py-2 text-end">
                        {lbScope === 'global' || lbScope === 'season'
                          ? t('common.elo')
                          : t('progression.colPeriodDeltaElo')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {lbLoading ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          {t('progression.loadingRankings')}
                        </td>
                      </tr>
                    ) : !lbData || lbData.items.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          {t('progression.noRankedCompetitors')}
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
                            <td dir="ltr" className="px-3 py-2 font-mono font-bold tabular-nums text-slate-200">
                              #{row.rank}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => {
                                  soundEngine.playUiClick();
                                  setInspectedPlayerId(row.playerId);
                                }}
                                className="flex items-center gap-2 text-start hover:underline cursor-pointer"
                              >
                                <span
                                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/15 text-[11px] font-bold"
                                  style={{ backgroundColor: `${av.accent}20`, color: av.accent }}
                                >
                                  {av.glyph}
                                </span>
                                <span className="font-bold text-white">
                                  {localizePlayerName(row.displayName, null, language)}
                                </span>
                                {row.username && (
                                  <span dir="ltr" className="text-[10px] text-slate-400">
                                    @{row.username}
                                  </span>
                                )}
                              </button>
                            </td>
                            <td className="px-3 py-2">
                              <RankBadge elo={row.elo} tier={row.rankTier} size="xs" />
                            </td>
                            <td className="px-3 py-2 text-end font-mono tabular-nums text-slate-300">
                              {row.level}
                            </td>
                            <td dir="ltr" className="px-3 py-2 text-end font-mono tabular-nums text-slate-300">
                              {row.wins}–{row.losses}
                            </td>
                            <td dir="ltr" className="px-3 py-2 text-end font-mono tabular-nums text-slate-300">
                              {row.winRate.toFixed(1)}%
                            </td>
                            <td dir="ltr" className="px-3 py-2 text-end font-mono font-bold tabular-nums">
                              {lbScope === 'global' || lbScope === 'season' ? (
                                <span className="text-amber-300">{formatNumber(row.elo)}</span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5">
                                  <span
                                    className={
                                      row.periodDelta >= 0 ? 'text-emerald-300' : 'text-rose-300'
                                    }
                                  >
                                    {row.periodDelta >= 0 ? `+${row.periodDelta}` : row.periodDelta}
                                  </span>
                                  <span className="text-slate-400">/ {formatNumber(row.elo)}</span>
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
                    {t('common.pageOf', { page: lbData.page, total: lbData.totalPages })}{' '}
                    {t('progression.playersCountParen', { count: formatNumber(lbData.total) })}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={lbPage <= 1}
                      onClick={() => setLbPage((p) => Math.max(1, p - 1))}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-slate-200 disabled:opacity-40 cursor-pointer"
                    >
                      {isRtl ? (
                        <ChevronRight className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronLeft className="h-3.5 w-3.5" />
                      )}
                      {t('common.prevPage')}
                    </button>
                    <button
                      type="button"
                      disabled={lbPage >= lbData.totalPages}
                      onClick={() => setLbPage((p) => p + 1)}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-slate-200 disabled:opacity-40 cursor-pointer"
                    >
                      {t('common.nextPage')}
                      {isRtl ? (
                        <ChevronLeft className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : progressionTab === 'achievements' ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 text-xs">
                <span className="font-bold text-white">
                  {t('progression.unlockedAchievementsSummary', {
                    unlocked: ownProfile?.achievements.length ?? 0,
                    total: ACHIEVEMENTS_CATALOG.length,
                  })}
                </span>
                <span className="font-mono text-amber-300">
                  {t('progression.bonusXpEarned', {
                    xp: formatNumber(
                      (ownProfile?.achievements ?? []).reduce((acc, a) => acc + a.rewardXp, 0),
                    ),
                  })}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {ACHIEVEMENTS_CATALOG.map((ach) => {
                  const unlockedTs = unlockedMap.get(ach.id);
                  const unlocked = unlockedTs !== undefined;
                  const locAch = localizeAchievement(ach.id, ach.name, ach.description, language);
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
                            <div className="text-xs font-extrabold text-white">{locAch.name}</div>
                            <div className="text-[10px] uppercase tracking-wider text-slate-400">
                              {t('progression.rewardXpSuffix', {
                                category: localizeAchCategory(ach.category),
                                xp: ach.rewardXp,
                              })}
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
                          {unlocked
                            ? t('progression.achievementUnlockedBadge')
                            : t('progression.achievementLockedBadge')}
                        </span>
                      </div>
                      <p className="mt-2 text-[11px] text-slate-300 leading-relaxed">
                        {locAch.description}
                      </p>
                      {unlocked && (
                        <div className="mt-1.5 text-[10px] text-amber-300/90">
                          {t('progression.awardedOnDate', { date: formatDate(unlockedTs) })}
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
                  setHistoryImportNotice({
                    type: 'err',
                    text: t('progression.unableExportReplayErr'),
                  });
                  return;
                }
                const json = replayStorage.exportReplayToJson(full);
                const filename = `replay-${matchId}.json`;
                downloadTextFile(filename, json);
                setHistoryImportNotice({
                  type: 'ok',
                  text: t('progression.exportedReplayNotice', { filename }),
                });
              };

              const handleDeleteSaved = async (replayId: string) => {
                soundEngine.playUiClick();
                await replayStorage.deleteReplay(replayId);
                await refreshSavedReplays();
                setHistoryImportNotice({
                  type: 'ok',
                  text: t('progression.deletedReplayNotice'),
                });
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
                      text: t('progression.importedReplayNotice', {
                        p1: localizePlayerName(res.summary.player1Name, 'player1', language),
                        p2: localizePlayerName(res.summary.player2Name, 'player2', language),
                        shots: res.summary.totalShots,
                      }),
                    });
                  } else {
                    setHistoryImportNotice({
                      type: 'err',
                      text: localizeReplayError(res.error, language),
                    });
                  }
                } catch {
                  setHistoryImportNotice({
                    type: 'err',
                    text: t('progression.failedReadReplayErr'),
                  });
                }
              };

              return (
                <div className="space-y-3" data-testid="match-history-panel">
                  {/* Top Filter Bar: Match Mode + Result Outcome + Refresh & Import */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
                      {(
                        [
                          { id: 'all', label: t('progression.allMatchesTab') },
                          { id: 'ai', label: t('progression.filterAi') },
                          { id: 'online', label: t('progression.filterOnline') },
                          { id: 'local', label: t('progression.filterLocal') },
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
                          { id: 'all', label: t('progression.allResultsTab') },
                          { id: 'won', label: t('progression.victoriesTab') },
                          { id: 'lost', label: t('progression.defeatsTab') },
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
                        <span>{t('progression.importReplayBtn')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.playUiClick();
                          void loadHistory();
                        }}
                        className="rounded-lg border border-white/12 bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                      >
                        {t('common.refresh')}
                      </button>
                    </div>
                  </div>

                  {/* Replay Archive Storage Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-[11px]">
                    <div className="inline-flex items-center gap-2 text-slate-300">
                      <HardDrive className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      <span className="font-semibold text-white">
                        {t('progression.localReplayArchiveTitle')}
                      </span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {t('progression.matchesFraction', {
                          count: replayStorageStats?.count ?? savedReplays.length,
                          max: replayStorageStats?.maxCount ?? 24,
                        })}
                      </span>
                    </div>
                    <span dir="ltr" className="font-mono tabular-nums text-slate-400">
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
                  <div className="space-y-2.5 max-h-[380px] overflow-y-auto pe-0.5">
                    {/* Saved Full-Match Replays */}
                    {filteredSaved.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                          {t('progression.savedFullReplaysTitle', { count: filteredSaved.length })}
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
                                    {localizePlayerName(r.player1Name, 'player1', language)}{' '}
                                    <span className="text-slate-500">{t('common.vs')}</span>{' '}
                                    {localizePlayerName(r.player2Name, 'player2', language)}
                                  </span>
                                  <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-300">
                                    {r.matchType === 'ai'
                                      ? t('progression.aiDifficultyBadge', {
                                          diff: localizeAiDifficulty(
                                            r.aiDifficulty ?? 'pro',
                                            language,
                                          ).label,
                                        })
                                      : r.matchType === 'online'
                                        ? t('progression.onlineTypeBadge', {
                                            type: localizeOnlineMatchType(
                                              r.onlineSubType ?? 'quick',
                                              language,
                                            ),
                                          })
                                        : t('progression.localPvpBadge')}
                                  </span>
                                  {won !== null && (
                                    <span
                                      className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                                        won
                                          ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                                          : 'border-rose-400/40 bg-rose-500/15 text-rose-300'
                                      }`}
                                    >
                                      {won ? t('progression.filterWon') : t('progression.filterLost')}
                                    </span>
                                  )}
                                  {!r.authoritative && r.matchType === 'online' && (
                                    <span className="rounded border border-sky-400/35 bg-sky-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-sky-200">
                                      {t('progression.importedBadge')}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
                                  <span className="text-slate-200">
                                    {localizeFoulOrReason(r.finalResult, language) ?? r.finalResult}
                                  </span>
                                  <span>·</span>
                                  <span className="font-mono tabular-nums">
                                    {t('common.shotsCount', { count: r.totalShots })} ·{' '}
                                    <span dir="ltr">{formatLocalizedDuration(r.durationSec)}</span>
                                  </span>
                                  {r.highlightCount > 0 && (
                                    <>
                                      <span>·</span>
                                      <span className="text-amber-300">
                                        {t('progression.highlightsCount', { count: r.highlightCount })}
                                      </span>
                                    </>
                                  )}
                                  <span>·</span>
                                  <span>{formatDate(r.endedAtMs)}</span>
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
                                  <span>{t('progression.watchReplayBtn')}</span>
                                </button>
                                <button
                                  type="button"
                                  data-testid={`export-saved-replay-${r.replayId}`}
                                  title={t('progression.exportReplayAria')}
                                  aria-label={t('progression.exportReplayAria')}
                                  onClick={() => void handleExportSaved(r.replayId, r.matchId)}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/12 bg-white/5 text-slate-200 hover:bg-white/10 cursor-pointer"
                                >
                                  <Download className="h-3.5 w-3.5 text-amber-400" />
                                </button>
                                <button
                                  type="button"
                                  data-testid={`delete-saved-replay-${r.replayId}`}
                                  title={t('progression.deleteReplayAria')}
                                  aria-label={t('progression.deleteReplayAria')}
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
                            {t('progression.onlineServerLedgerTitle')}
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
                                {t('progression.ledgerGlobal')}
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
                                {t('progression.ledgerMyMatches')}
                              </button>
                            </div>

                            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/35 p-0.5">
                              {(
                                [
                                  { id: 'all', label: t('common.all') },
                                  { id: 'ranked', label: t('lobby.tabRanked') },
                                  { id: 'quick', label: t('lobby.tabShortQuick') },
                                  { id: 'private', label: t('lobby.tabShortPrivate') },
                                  { id: 'tournament', label: t('lobby.tabShortTournament') },
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
                            {t('progression.loadingOnlineLedger')}
                          </div>
                        ) : filteredOnlineLedger.length === 0 ? (
                          <div className="rounded-xl border border-white/10 bg-black/25 py-6 text-center text-xs text-slate-400">
                            {t('progression.noOnlineLedgerMatch')}
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
                                      {localizePlayerName(m.player1Name, 'player1', language)}
                                    </button>
                                    {m.p1RankTier && <RankBadge tier={m.p1RankTier} size="xs" />}
                                    <span className="text-slate-500">{t('common.vs')}</span>
                                    <button
                                      type="button"
                                      disabled={!m.player2Id}
                                      onClick={() => m.player2Id && setInspectedPlayerId(m.player2Id)}
                                      className="hover:underline disabled:no-underline cursor-pointer disabled:cursor-default"
                                    >
                                      {localizePlayerName(m.player2Name, 'player2', language)}
                                    </button>
                                    {m.p2RankTier && <RankBadge tier={m.p2RankTier} size="xs" />}
                                  </div>
                                  <div className="mt-0.5 text-[11px] text-slate-400">
                                    {t('lobby.historyWinnerPrefix')}{' '}
                                    <span className="font-semibold text-amber-300">
                                      {localizePlayerName(m.winnerName, m.winnerRole, language)}
                                    </span>
                                    {' · '}
                                    {localizeRuleProfile(m.ruleProfileId ?? 'casual', language, true)}
                                    {' · '}
                                    {localizeOnlineMatchType(m.matchType, language)}
                                    {' · '}
                                    {localizeFoulOrReason(m.reason, language) ?? m.reason}
                                  </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums text-[11px] shrink-0">
                                  {m.rankedApplied &&
                                    (m.p1EloDelta !== undefined || m.p2EloDelta !== undefined) && (
                                      <span dir="ltr" className="text-slate-300">
                                        {m.p1EloBefore !== undefined && m.p1EloAfter !== undefined
                                          ? `${m.p1EloBefore}→${m.p1EloAfter}`
                                          : m.p1EloDelta !== undefined &&
                                            (m.p1EloDelta >= 0 ? `+${m.p1EloDelta}` : m.p1EloDelta)}
                                        {' / '}
                                        {m.p2EloBefore !== undefined && m.p2EloAfter !== undefined
                                          ? `${m.p2EloBefore}→${m.p2EloAfter}`
                                          : m.p2EloDelta !== undefined &&
                                            (m.p2EloDelta >= 0 ? `+${m.p2EloDelta}` : m.p2EloDelta)}{' '}
                                        {t('common.elo')}
                                      </span>
                                    )}
                                  <span className="inline-flex items-center gap-1 text-slate-400">
                                    <Clock className="h-3 w-3" />
                                    {m.durationSec !== undefined ? (
                                      <span dir="ltr">{formatLocalizedDuration(m.durationSec)}</span>
                                    ) : (
                                      t('common.shotsCount', { count: m.totalShots })
                                    )}
                                  </span>
                                  <span className="text-slate-400">{formatDate(m.endedAtMs)}</span>
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
                                      {t('progression.replayChipBtn')}
                                    </button>
                                  ) : (
                                    <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-sans text-[10px] text-slate-400">
                                      {t('progression.ledgerChipBadge')}
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
                          {t('progression.emptyModeArchiveHint', {
                            mode:
                              historyModeFilter === 'ai'
                                ? t('progression.filterAi')
                                : t('progression.filterLocal'),
                          })}
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
                  {t('progression.fairPlayHeading')}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playUiClick();
                    void loadFairPlay();
                  }}
                  className="rounded-lg border border-white/12 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-200 hover:bg-white/10 cursor-pointer"
                >
                  {t('common.refresh')}
                </button>
              </div>

              {fairPlayLoading && !moderationStatus ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  {t('progression.loadingFairPlay')}
                </div>
              ) : !moderationStatus ? (
                <div className="rounded-xl border border-white/10 bg-black/25 p-5 text-center text-xs text-slate-400">
                  {t('progression.fairPlayAuthPrompt')}
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
                            ? t('progression.standingCleanTitle')
                            : !moderationStatus.canPlayOnline
                              ? t('progression.standingSuspendedTitle')
                              : t('progression.standingRestrictedTitle')}
                        </div>
                        <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                          {moderationStatus.canPlayOnline && moderationStatus.canPlayRanked
                            ? t('progression.standingCleanDesc')
                            : !moderationStatus.canPlayOnline
                              ? t('progression.standingSuspendedDesc')
                              : t('progression.standingRestrictedDesc')}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Active & Recent Penalties */}
                  <div className="rounded-xl border border-white/10 bg-black/25 p-3.5 space-y-2.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                      {t('progression.penaltiesWarningsTitle', {
                        count: moderationStatus.recentPenalties.length,
                      })}
                    </div>

                    {moderationStatus.recentPenalties.length === 0 ? (
                      <div className="py-3 text-xs text-slate-400">
                        {t('progression.noPenaltiesRecorded')}
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
                                {formatPenaltyType(pen.penaltyType, language)}
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
                                  ? t('progression.penaltyRevoked')
                                  : pen.active
                                    ? t('common.active')
                                    : t('progression.penaltyExpired')}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-300">{pen.reason}</p>
                            <div className="text-[10px] text-slate-400">
                              {t('progression.issuedOnBy', {
                                date: formatDate(pen.issuedAtMs),
                                by: pen.issuedBy,
                              })}
                              {' · '}
                              {pen.expiresAtMs
                                ? t('progression.expiresOn', { date: formatDate(pen.expiresAtMs) })
                                : t('progression.noAutomaticExpiry')}
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
                              text: t('progression.appealSubmittedNotice'),
                            });
                          } else {
                            setAppealFeedback({
                              type: 'err',
                              text:
                                localizeServerError(res.error, language) ||
                                t('progression.penaltyAppealFailErr'),
                            });
                          }
                        }}
                        className="rounded-xl border border-amber-400/25 bg-black/25 p-3.5 space-y-2.5"
                      >
                        <div className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
                          {t('progression.submitAppealTitle')}
                        </div>
                        <select
                          value={appealPenaltyId}
                          onChange={(e) => setAppealPenaltyId(e.target.value)}
                          className="w-full rounded-lg border border-white/15 bg-[#0b1017] px-2.5 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
                        >
                          {appealable.map((p) => (
                            <option key={p.penaltyId} value={p.penaltyId}>
                              {formatPenaltyType(p.penaltyType, language)} — {p.reason.slice(0, 48)}
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
                          placeholder={t('progression.appealReasonLongPlaceholder')}
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
                            {appealBusy ? t('common.submitting') : t('progression.submitAppealBtn')}
                          </button>
                        </div>
                      </form>
                    );
                  })()}

                  {/* Submitted Appeals List */}
                  {moderationStatus.appeals.length > 0 && (
                    <div className="rounded-xl border border-white/10 bg-black/25 p-3.5 space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                        {t('progression.yourAppealsCount', {
                          count: moderationStatus.appeals.length,
                        })}
                      </div>
                      <div className="space-y-2 max-h-[160px] overflow-y-auto">
                        {moderationStatus.appeals.map((ap) => (
                          <div
                            key={ap.appealId}
                            className="rounded-lg border border-white/10 bg-[#0b1017] px-3 py-2 text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-[10px] text-slate-400">
                                {formatDate(ap.submittedAtMs)}
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
                                {ap.status === 'approved'
                                  ? t('progression.appealApproved')
                                  : ap.status === 'rejected'
                                    ? t('progression.appealRejected')
                                    : t('progression.appealPending')}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-200">{ap.message}</p>
                            {ap.adminNotes && (
                              <p className="text-[11px] text-slate-400">
                                {t('progression.moderatorNotePrefix', { notes: ap.adminNotes })}
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
