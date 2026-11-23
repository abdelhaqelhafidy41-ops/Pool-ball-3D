import {
  Award,
  BarChart3,
  Check,
  Coins,
  Crown,
  Edit3,
  Eye,
  Flame,
  Globe,
  Languages,
  LogOut,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Shield,
  Star,
  Swords,
  Target,
  Trophy,
  User,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { RuleProfileId } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import {
  type AppLanguage,
  TRANSLATIONS,
  formatLocalizedDate,
  localizeClubRegion,
  localizeServerError,
  localizeTeamBoardLabel,
  localizeTournamentRoundLabel,
  useTranslation,
} from '../i18n';
import { clubLeagueClient } from '../multiplayer/ClubLeagueClient';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { socialClient } from '../multiplayer/SocialClient';
import {
  COMPETITION_REGIONS,
  TEAM_MATCH_FORMAT_SPEC,
  type ClubChampionshipFormat,
  type ClubChampionshipMatchRecord,
  type ClubTeamRecord,
  type LeagueCadence,
  type LeagueScope,
  type TeamEncounterStatus,
  type TeamLeagueFixtureRecord,
  type TeamMatchFormat,
  type TeamRosterRole,
  type TeamSubMatchRecord,
} from '../multiplayer/shared/clubLeagues';
import {
  canManageClubTeams,
  isClubOfficerRole,
  SOCIAL_LIMITS,
  type ClubEmblemIcon,
  type ClubJoinMode,
  type ClubRole,
} from '../multiplayer/shared/social';
import { type ClubLeagueTab, useGameStore } from '../store/useGameStore';

type ClubLeagueCopy = (typeof TRANSLATIONS)['en']['clubLeagues'];

const COLOR_PRESETS = [
  '#f59e0b',
  '#10b981',
  '#38bdf8',
  '#f43f5e',
  '#a78bfa',
  '#fb923c',
  '#eab308',
  '#14b8a6',
];

const EMBLEM_ICONS: Array<{ id: ClubEmblemIcon; labelKey: string }> = [
  { id: 'shield', labelKey: 'social.emblemShield' },
  { id: 'crown', labelKey: 'social.emblemCrown' },
  { id: 'flame', labelKey: 'social.emblemFlame' },
  { id: 'star', labelKey: 'social.emblemStar' },
  { id: 'swords', labelKey: 'social.emblemSwords' },
  { id: 'target', labelKey: 'social.emblemTarget' },
];

function renderEmblemIcon(icon: ClubEmblemIcon, color: string, className = 'h-4 w-4') {
  const style = { color };
  switch (icon) {
    case 'crown':
      return <Crown className={className} style={style} />;
    case 'flame':
      return <Flame className={className} style={style} />;
    case 'star':
      return <Star className={className} style={style} />;
    case 'swords':
      return <Swords className={className} style={style} />;
    case 'target':
      return <Target className={className} style={style} />;
    case 'shield':
    default:
      return <Shield className={className} style={style} />;
  }
}

function presenceDotClass(status: string): string {
  switch (status) {
    case 'online':
      return 'bg-emerald-400';
    case 'in_match':
      return 'bg-sky-400';
    case 'in_tournament':
      return 'bg-amber-400';
    case 'spectating':
      return 'bg-violet-400';
    case 'busy':
      return 'bg-rose-400';
    default:
      return 'bg-slate-500';
  }
}

function formatShortTime(ms: number | null | undefined, lang: AppLanguage): string {
  if (!ms) return '—';
  return formatLocalizedDate(ms, lang) || '—';
}

function getStatusTextClass(status: string): string {
  switch (status) {
    case 'registration_open':
    case 'ready':
    case 'lineup_ready':
      return 'text-emerald-300';
    case 'in_progress':
      return 'text-amber-300';
    case 'completed':
      return 'text-sky-300';
    case 'walkover':
    case 'forfeited':
    case 'disqualified':
    case 'cancelled':
      return 'text-rose-300';
    default:
      return 'text-slate-400';
  }
}

function getLocalizedStatus(copy: ClubLeagueCopy, status: string): string {
  const map = copy.statuses as Record<string, string>;
  return map[status] ?? status.replace(/_/g, ' ');
}

interface EncounterCardProps {
  competitionKind: 'league' | 'club_championship';
  competitionId: string;
  encounterId: string;
  headerLabel: string;
  homeTeamId: string | null;
  homeTeamName: string | null;
  homeTeamTag: string | null;
  homeSeed?: number | null;
  awayTeamId: string | null;
  awayTeamName: string | null;
  awayTeamTag: string | null;
  awaySeed?: number | null;
  homeScore: number;
  awayScore: number;
  status: TeamEncounterStatus;
  winnerTeamId: string | null;
  matchFormat: TeamMatchFormat;
  subMatches: TeamSubMatchRecord[];
  viewerPlayerId: string | null;
  viewerTeamIds: string[];
  clubTeams: ClubTeamRecord[];
  canManage: boolean;
  copy: ClubLeagueCopy;
  onNotice: (notice: { type: 'ok' | 'err'; text: string }) => void;
}

function EncounterCard({
  competitionKind,
  competitionId,
  encounterId,
  headerLabel,
  homeTeamId,
  homeTeamName,
  homeTeamTag,
  homeSeed,
  awayTeamId,
  awayTeamName,
  awayTeamTag,
  awaySeed,
  homeScore,
  awayScore,
  status,
  winnerTeamId,
  matchFormat,
  subMatches,
  viewerPlayerId,
  viewerTeamIds,
  clubTeams,
  canManage,
  copy,
  onNotice,
}: EncounterCardProps) {
  const { t, language } = useTranslation();
  const requiredPlayers = TEAM_MATCH_FORMAT_SPEC[matchFormat].requiredLineupPlayers;
  const viewerHomeTeam = useMemo(
    () => (homeTeamId && viewerTeamIds.includes(homeTeamId) ? clubTeams.find((tm) => tm.teamId === homeTeamId) ?? null : null),
    [clubTeams, homeTeamId, viewerTeamIds],
  );
  const viewerAwayTeam = useMemo(
    () => (awayTeamId && viewerTeamIds.includes(awayTeamId) ? clubTeams.find((tm) => tm.teamId === awayTeamId) ?? null : null),
    [clubTeams, awayTeamId, viewerTeamIds],
  );
  const lineupTeam = viewerHomeTeam ?? viewerAwayTeam;

  const [lineupSlots, setLineupSlots] = useState<string[]>([]);
  const [subSlotTarget, setSubSlotTarget] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (!lineupTeam) {
      setLineupSlots([]);
      return;
    }
    setLineupSlots((prev) => {
      if (prev.length === requiredPlayers && prev.every((id) => lineupTeam.roster.some((r) => r.playerId === id))) {
        return prev;
      }
      const seeded: string[] = [];
      for (let i = 0; i < requiredPlayers; i++) {
        const candidate = lineupTeam.roster[i % Math.max(1, lineupTeam.roster.length)]?.playerId ?? '';
        seeded.push(candidate);
      }
      return seeded;
    });
  }, [lineupTeam, requiredPlayers]);

  const canModifyEncounter =
    status !== 'completed' &&
    status !== 'bye' &&
    status !== 'walkover' &&
    status !== 'forfeited' &&
    status !== 'disqualified';

  const handleSubmitLineup = async () => {
    if (!lineupTeam) return;
    const picked = lineupSlots.filter(Boolean);
    if (picked.length < requiredPlayers) {
      onNotice({ type: 'err', text: `${copy.leagues.submitLineup}: ${requiredPlayers}` });
      return;
    }
    setBusyKey('lineup');
    const res = await clubLeagueClient.submitEncounterLineup({
      competitionKind,
      competitionId,
      encounterId,
      teamId: lineupTeam.teamId,
      playerIds: picked,
    });
    setBusyKey(null);
    if (res.ok) {
      onNotice({ type: 'ok', text: copy.notices.lineupSaved });
    } else {
      onNotice({ type: 'err', text: localizeServerError(res.error, language) });
    }
  };

  const handleSubstitute = async (sm: TeamSubMatchRecord) => {
    if (!lineupTeam) return;
    const newPlayerId = subSlotTarget[sm.subMatchId];
    if (!newPlayerId) return;
    setBusyKey(`sub:${sm.subMatchId}`);
    const res = await clubLeagueClient.substituteLineupSlot({
      subMatchId: sm.subMatchId,
      teamId: lineupTeam.teamId,
      newPlayerId,
    });
    setBusyKey(null);
    if (res.ok) {
      onNotice({ type: 'ok', text: copy.notices.substitutionDone });
    } else {
      onNotice({ type: 'err', text: localizeServerError(res.error, language) });
    }
  };

  const handleResolve = async (winTeamId: string, resolution: 'walkover' | 'disqualified') => {
    setBusyKey(`resolve:${resolution}:${winTeamId}`);
    const res =
      competitionKind === 'league'
        ? await clubLeagueClient.resolveLeagueEncounter(competitionId, encounterId, winTeamId, resolution)
        : await clubLeagueClient.resolveChampionshipEncounter(competitionId, encounterId, winTeamId, resolution);
    setBusyKey(null);
    if (res.ok) {
      onNotice({
        type: 'ok',
        text: resolution === 'walkover' ? copy.notices.walkoverAwarded : copy.notices.teamDisqualified,
      });
    } else {
      onNotice({ type: 'err', text: localizeServerError(res.error, language) });
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-[#0d141d] p-3 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="font-semibold uppercase tracking-wider text-slate-400">{headerLabel}</span>
        <span className={`font-bold uppercase tracking-wider ${getStatusTextClass(status)}`}>
          {getLocalizedStatus(copy, status)}
        </span>
      </div>

      {/* Team Scoreboard Line */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/35 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {homeSeed ? (
            <span className="font-mono text-[10px] text-slate-400 tabular-nums" dir="ltr">
              #{homeSeed}
            </span>
          ) : null}
          <span
            className={`truncate text-xs font-extrabold ${
              winnerTeamId && winnerTeamId === homeTeamId ? 'text-amber-300' : 'text-white'
            }`}
          >
            {homeTeamTag ? <span dir="ltr">[{homeTeamTag}] </span> : null}
            {homeTeamName ?? t('tournaments.tbdSlot')}
          </span>
        </div>

        <div className="font-mono text-sm font-black tracking-wider text-amber-300 tabular-nums shrink-0" dir="ltr">
          {homeScore} : {awayScore}
        </div>

        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`truncate text-xs font-extrabold ${
              winnerTeamId && winnerTeamId === awayTeamId ? 'text-amber-300' : 'text-white'
            }`}
          >
            {awayTeamTag ? <span dir="ltr">[{awayTeamTag}] </span> : null}
            {awayTeamName ?? (status === 'bye' ? t('tournaments.byeSlot') : t('tournaments.tbdSlot'))}
          </span>
          {awaySeed ? (
            <span className="font-mono text-[10px] text-slate-400 tabular-nums" dir="ltr">
              #{awaySeed}
            </span>
          ) : null}
        </div>
      </div>

      {/* Lineup Nomination Bar */}
      {canModifyEncounter && lineupTeam && lineupTeam.roster.length > 0 && (
        <div className="rounded-lg border border-amber-400/25 bg-amber-500/[0.06] p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-amber-300">
              {copy.leagues.submitLineup} · <span dir="ltr">[{lineupTeam.tag}]</span> ({requiredPlayers})
            </span>
            <button
              type="button"
              disabled={busyKey === 'lineup'}
              onClick={() => void handleSubmitLineup()}
              className="min-h-[36px] rounded-lg bg-amber-500 px-3 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              {busyKey === 'lineup' ? '...' : copy.leagues.submitLineup}
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
            {Array.from({ length: requiredPlayers }).map((_, idx) => (
              <select
                key={idx}
                value={lineupSlots[idx] ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setLineupSlots((prev) => {
                    const next = [...prev];
                    next[idx] = val;
                    return next;
                  });
                }}
                className="min-h-[36px] rounded-lg border border-white/15 bg-[#0a0f16] px-2 py-1 text-xs text-white focus:border-amber-400 focus:outline-none"
              >
                <option value="">{t('clubLeagues.leagues.boardSlotPrefix', { num: idx + 1 })}</option>
                {lineupTeam.roster.map((member) => (
                  <option key={member.playerId} value={member.playerId}>
                    {member.displayName} ({member.elo})
                  </option>
                ))}
              </select>
            ))}
          </div>
        </div>
      )}

      {/* Sub-Match Boards */}
      {subMatches.length > 0 && (
        <div className="space-y-1.5">
          {subMatches.map((sm) => {
            const isAssignedPlayer =
              Boolean(viewerPlayerId) &&
              (sm.homePlayerId === viewerPlayerId || sm.awayPlayerId === viewerPlayerId);
            const isBoardPlayable =
              canModifyEncounter &&
              isAssignedPlayer &&
              (sm.status === 'ready' || sm.status === 'pending' || sm.status === 'in_progress') &&
              Boolean(sm.homePlayerId && sm.awayPlayerId);
            const isSpectatable = sm.status === 'in_progress' && Boolean(sm.roomCode);
            const canSubstituteBoard =
              canModifyEncounter &&
              Boolean(lineupTeam) &&
              (sm.status === 'pending' || sm.status === 'ready');

            return (
              <div
                key={sm.subMatchId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-xs"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="font-bold text-amber-300">
                      {localizeTeamBoardLabel(sm.boardLabel, language)}
                    </span>
                    <span className="text-slate-500">·</span>
                    <span className={getStatusTextClass(sm.status)}>
                      {getLocalizedStatus(copy, sm.status)}
                    </span>
                    {sm.roomCode && (
                      <>
                        <span className="text-slate-500">·</span>
                        <span className="font-mono text-[10px] text-slate-400" dir="ltr">
                          {t('clubLeagues.leagues.roomCodeTag', { code: sm.roomCode })}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span
                      className={`font-semibold ${
                        sm.winnerPlayerId && sm.winnerPlayerId === sm.homePlayerId
                          ? 'text-emerald-300 font-extrabold'
                          : 'text-slate-200'
                      }`}
                    >
                      {sm.homePlayerName ?? t('tournaments.tbdSlot')}
                    </span>
                    <span className="text-slate-500">{t('common.vs')}</span>
                    <span
                      className={`font-semibold ${
                        sm.winnerPlayerId && sm.winnerPlayerId === sm.awayPlayerId
                          ? 'text-emerald-300 font-extrabold'
                          : 'text-slate-200'
                      }`}
                    >
                      {sm.awayPlayerName ?? t('tournaments.tbdSlot')}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {canSubstituteBoard && lineupTeam && lineupTeam.roster.length > 1 && (
                    <div className="flex items-center gap-1">
                      <select
                        value={subSlotTarget[sm.subMatchId] ?? ''}
                        onChange={(e) =>
                          setSubSlotTarget((prev) => ({
                            ...prev,
                            [sm.subMatchId]: e.target.value,
                          }))
                        }
                        className="min-h-[36px] max-w-[140px] rounded-lg border border-white/15 bg-[#0a0f16] px-2 py-1 text-[11px] text-white"
                      >
                        <option value="">{copy.leagues.substituteSlot}...</option>
                        {lineupTeam.roster.map((m) => (
                          <option key={m.playerId} value={m.playerId}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                      {subSlotTarget[sm.subMatchId] && (
                        <button
                          type="button"
                          disabled={busyKey === `sub:${sm.subMatchId}`}
                          onClick={() => void handleSubstitute(sm)}
                          className="min-h-[36px] rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-500/25 cursor-pointer whitespace-nowrap"
                        >
                          {copy.leagues.okBadge}
                        </button>
                      )}
                    </div>
                  )}

                  {isBoardPlayable && (
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        void multiplayerManager.joinTeamSubMatch(sm.subMatchId);
                      }}
                      className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer whitespace-nowrap"
                    >
                      <Play className="h-3.5 w-3.5 fill-slate-950" />
                      {copy.leagues.enterMatch}
                    </button>
                  )}

                  {isSpectatable && !isBoardPlayable && (
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        void multiplayerManager.joinSpectate({
                          roomCode: sm.roomCode ?? undefined,
                          returnTarget: 'lobby',
                        });
                      }}
                      className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-sky-400/40 bg-sky-500/15 px-3 py-1.5 text-xs font-bold text-sky-200 hover:bg-sky-500/25 cursor-pointer whitespace-nowrap"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      {copy.leagues.watchLive}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Organizer Walkover / Disqualify Controls */}
      {canManage && canModifyEncounter && homeTeamId && awayTeamId && (
        <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1 border-t border-white/10">
          <button
            type="button"
            disabled={Boolean(busyKey)}
            onClick={() => void handleResolve(homeTeamId, 'walkover')}
            className="min-h-[34px] rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
          >
            {t('clubLeagues.leagues.walkoverArrow', { tag: homeTeamTag ?? '' })}
          </button>
          <button
            type="button"
            disabled={Boolean(busyKey)}
            onClick={() => void handleResolve(awayTeamId, 'walkover')}
            className="min-h-[34px] rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
          >
            {t('clubLeagues.leagues.walkoverArrow', { tag: awayTeamTag ?? '' })}
          </button>
          <button
            type="button"
            disabled={Boolean(busyKey)}
            onClick={() => void handleResolve(awayTeamId, 'disqualified')}
            className="min-h-[34px] rounded-lg border border-rose-500/35 bg-rose-500/10 px-2.5 py-1 text-[10px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap"
          >
            {copy.championships.dqBadge} <span dir="ltr">[{homeTeamTag}]</span>
          </button>
          <button
            type="button"
            disabled={Boolean(busyKey)}
            onClick={() => void handleResolve(homeTeamId, 'disqualified')}
            className="min-h-[34px] rounded-lg border border-rose-500/35 bg-rose-500/10 px-2.5 py-1 text-[10px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap"
          >
            {copy.championships.dqBadge} <span dir="ltr">[{awayTeamTag}]</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function ClubLeagueModal() {
  // ===== ALL HOOKS UNCONDITIONAL BEFORE ANY EARLY RETURN =====
  const clubLeagueModalOpen = useGameStore((s) => s.clubLeagueModalOpen);
  const closeClubLeagueModal = useGameStore((s) => s.closeClubLeagueModal);
  const clubLeagueTab = useGameStore((s) => s.clubLeagueTab);
  const setClubLeagueTab = useGameStore((s) => s.setClubLeagueTab);
  const ownProfile = useGameStore((s) => s.ownProfile);
  const myClub = useGameStore((s) => s.myClub);
  const clubDetail = useGameStore((s) => s.clubDetail);
  const clubsList = useGameStore((s) => s.clubsList);
  const incomingClubInvitations = useGameStore((s) => s.incomingClubInvitations);
  const clubLeaderboard = useGameStore((s) => s.clubLeaderboard);
  const clubTeams = useGameStore((s) => s.clubTeams);
  const clubChatMessages = useGameStore((s) => s.clubChatMessages);
  const clubTrophies = useGameStore((s) => s.clubTrophies);
  const teamLeagues = useGameStore((s) => s.teamLeagues);
  const selectedLeagueId = useGameStore((s) => s.selectedLeagueId);
  const setSelectedLeagueId = useGameStore((s) => s.setSelectedLeagueId);
  const selectedLeagueDetail = useGameStore((s) => s.selectedLeagueDetail);
  const clubChampionships = useGameStore((s) => s.clubChampionships);
  const selectedChampionshipId = useGameStore((s) => s.selectedChampionshipId);
  const setSelectedChampionshipId = useGameStore((s) => s.setSelectedChampionshipId);
  const selectedChampionshipDetail = useGameStore((s) => s.selectedChampionshipDetail);
  const teamEloRankings = useGameStore((s) => s.teamEloRankings);
  const clubLeagueNotice = useGameStore((s) => s.clubLeagueNotice);
  const setClubLeagueNotice = useGameStore((s) => s.setClubLeagueNotice);
  const openProgressionModal = useGameStore((s) => s.openProgressionModal);

  const { t, language, isRtl, setLanguage, formatNumber } = useTranslation();
  const copy = useMemo(() => TRANSLATIONS[language].clubLeagues, [language]);

  const [busyId, setBusyId] = useState<string | null>(null);

  // Club HQ state
  const [clubSearch, setClubSearch] = useState('');
  const [showCreateClub, setShowCreateClub] = useState(false);
  const [newClubName, setNewClubName] = useState('');
  const [newClubTag, setNewClubTag] = useState('');
  const [newClubDesc, setNewClubDesc] = useState('');
  const [newClubColor, setNewClubColor] = useState('#f59e0b');
  const [newClubIcon, setNewClubIcon] = useState<ClubEmblemIcon>('shield');
  const [newClubJoinMode, setNewClubJoinMode] = useState<ClubJoinMode>('public');
  const [newClubRegion, setNewClubRegion] = useState('GLOBAL');
  const [newClubMaxMembers, setNewClubMaxMembers] = useState(50);

  const [editingClub, setEditingClub] = useState(false);
  const [editClubDesc, setEditClubDesc] = useState('');
  const [editClubJoinMode, setEditClubJoinMode] = useState<ClubJoinMode>('public');
  const [editClubRegion, setEditClubRegion] = useState('GLOBAL');
  const [editClubMaxMembers, setEditClubMaxMembers] = useState(50);
  const [announcementDraft, setAnnouncementDraft] = useState('');
  const [chatDraft, setChatDraft] = useState('');
  const [inviteTargetId, setInviteTargetId] = useState('');

  // Teams & Rosters state
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState('');
  const [teamTag, setTeamTag] = useState('');
  const [teamRegion, setTeamRegion] = useState('GLOBAL');
  const [teamColor, setTeamColor] = useState('#10b981');
  const [teamIcon, setTeamIcon] = useState<ClubEmblemIcon>('swords');
  const [teamMinRoster, setTeamMinRoster] = useState(1);
  const [teamMaxRoster, setTeamMaxRoster] = useState(6);
  const [teamCaptainId, setTeamCaptainId] = useState('');
  const [addMemberPlayerId, setAddMemberPlayerId] = useState('');
  const [addMemberRole, setAddMemberRole] = useState<TeamRosterRole>('starter');

  // Leagues state
  const [leagueScopeFilter, setLeagueScopeFilter] = useState<LeagueScope | 'all'>('all');
  const [leagueRegionFilter, setLeagueRegionFilter] = useState<string>('ALL');
  const [showCreateLeague, setShowCreateLeague] = useState(false);
  const [leagueTitle, setLeagueTitle] = useState('');
  const [leagueDesc, setLeagueDesc] = useState('');
  const [leagueScope, setLeagueScope] = useState<LeagueScope>('international');
  const [leagueRegion, setLeagueRegion] = useState('GLOBAL');
  const [leagueCadence, setLeagueCadence] = useState<LeagueCadence>('seasonal');
  const [leagueFormat, setLeagueFormat] = useState<TeamMatchFormat>('team_bo3');
  const [leagueRule, setLeagueRule] = useState<RuleProfileId>('casual');
  const [leagueDoubleRr, setLeagueDoubleRr] = useState(false);
  const [leagueMaxTeams, setLeagueMaxTeams] = useState(8);
  const [leaguePromoSlots, setLeaguePromoSlots] = useState(2);
  const [leagueRelSlots, setLeagueRelSlots] = useState(2);
  const [leagueRegisterTeamId, setLeagueRegisterTeamId] = useState('');

  // Championships state
  const [champFormatFilter, setChampFormatFilter] = useState<ClubChampionshipFormat | 'all'>('all');
  const [champRegionFilter, setChampRegionFilter] = useState<string>('ALL');
  const [showCreateChamp, setShowCreateChamp] = useState(false);
  const [champTitle, setChampTitle] = useState('');
  const [champDesc, setChampDesc] = useState('');
  const [champFormat, setChampFormat] = useState<ClubChampionshipFormat>('single_elimination');
  const [champRegion, setChampRegion] = useState('GLOBAL');
  const [champMatchFormat, setChampMatchFormat] = useState<TeamMatchFormat>('team_bo3');
  const [champRule, setChampRule] = useState<RuleProfileId>('casual');
  const [champMaxTeams, setChampMaxTeams] = useState(8);
  const [champSwissRounds, setChampSwissRounds] = useState(3);
  const [champGroupSize, setChampGroupSize] = useState(4);
  const [champAdvanceCount, setChampAdvanceCount] = useState(2);
  const [champPrizeCoins, setChampPrizeCoins] = useState(1000);
  const [champRegisterTeamId, setChampRegisterTeamId] = useState('');

  // Rankings state
  const [rankingsSubTab, setRankingsSubTab] = useState<'teams' | 'clubs' | 'trophies'>('teams');
  const [rankingsRegionFilter, setRankingsRegionFilter] = useState('ALL');

  const viewerRole: ClubRole | null = clubDetail?.viewerRole ?? myClub?.role ?? null;
  const isOfficer = useMemo(() => isClubOfficerRole(viewerRole), [viewerRole]);
  const canManageTeams = useMemo(() => canManageClubTeams(viewerRole), [viewerRole]);

  const selectedTeam = useMemo(() => {
    if (clubTeams.length === 0) return null;
    if (selectedTeamId) {
      const match = clubTeams.find((tm) => tm.teamId === selectedTeamId);
      if (match) return match;
    }
    return clubTeams[0] ?? null;
  }, [clubTeams, selectedTeamId]);

  const filteredLeagues = useMemo(() => {
    return teamLeagues.filter((l) => {
      if (leagueScopeFilter !== 'all' && l.scope !== leagueScopeFilter) return false;
      if (leagueRegionFilter !== 'ALL' && l.region !== leagueRegionFilter) return false;
      return true;
    });
  }, [teamLeagues, leagueScopeFilter, leagueRegionFilter]);

  const filteredChampionships = useMemo(() => {
    return clubChampionships.filter((c) => {
      if (champFormatFilter !== 'all' && c.format !== champFormatFilter) return false;
      if (champRegionFilter !== 'ALL' && c.region !== champRegionFilter) return false;
      return true;
    });
  }, [clubChampionships, champFormatFilter, champRegionFilter]);

  useEffect(() => {
    if (!clubLeagueModalOpen) return;
    void socialClient.fetchOverview();
    void socialClient.listClubs('', 30);
    void clubLeagueClient.listLeagues();
    void clubLeagueClient.listChampionships();
    void clubLeagueClient.fetchRankings(rankingsRegionFilter, 30);
    void socialClient.fetchClubLeaderboard('global', 30);
  }, [clubLeagueModalOpen, rankingsRegionFilter]);

  useEffect(() => {
    if (!clubLeagueModalOpen || !myClub?.clubId) return;
    void socialClient.getClubDetail(myClub.clubId);
    void clubLeagueClient.listClubTeams(myClub.clubId);
    void socialClient.fetchClubChat(myClub.clubId, 50);
    void socialClient.fetchClubTrophies(myClub.clubId, 30);
  }, [clubLeagueModalOpen, myClub?.clubId]);

  useEffect(() => {
    if (!clubLeagueModalOpen) return;
    if (selectedLeagueId) {
      void clubLeagueClient.getLeagueDetail(selectedLeagueId);
    }
  }, [clubLeagueModalOpen, selectedLeagueId]);

  useEffect(() => {
    if (!clubLeagueModalOpen) return;
    if (selectedChampionshipId) {
      void clubLeagueClient.getChampionshipDetail(selectedChampionshipId);
    }
  }, [clubLeagueModalOpen, selectedChampionshipId]);

  useEffect(() => {
    if (clubTeams.length > 0 && !leagueRegisterTeamId) {
      setLeagueRegisterTeamId(clubTeams[0].teamId);
    }
    if (clubTeams.length > 0 && !champRegisterTeamId) {
      setChampRegisterTeamId(clubTeams[0].teamId);
    }
  }, [clubTeams, leagueRegisterTeamId, champRegisterTeamId]);

  if (!clubLeagueModalOpen) return null;

  const refreshAll = async () => {
    soundEngine.playUiClick();
    setBusyId('refresh');
    await Promise.all([
      socialClient.fetchOverview(),
      socialClient.listClubs(clubSearch, 30),
      clubLeagueClient.listLeagues(),
      clubLeagueClient.listChampionships(),
      clubLeagueClient.fetchRankings(rankingsRegionFilter, 30),
      socialClient.fetchClubLeaderboard('global', 30),
      myClub?.clubId ? socialClient.getClubDetail(myClub.clubId) : Promise.resolve(),
      myClub?.clubId ? clubLeagueClient.listClubTeams(myClub.clubId) : Promise.resolve(),
      myClub?.clubId ? socialClient.fetchClubChat(myClub.clubId, 50) : Promise.resolve(),
      myClub?.clubId ? socialClient.fetchClubTrophies(myClub.clubId, 30) : Promise.resolve(),
      selectedLeagueId ? clubLeagueClient.getLeagueDetail(selectedLeagueId) : Promise.resolve(),
      selectedChampionshipId
        ? clubLeagueClient.getChampionshipDetail(selectedChampionshipId)
        : Promise.resolve(),
    ]);
    setBusyId(null);
  };

  const handleCreateClub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClubName.trim() || !newClubTag.trim()) return;
    setBusyId('create-club');
    const res = await socialClient.createClub({
      name: newClubName.trim(),
      tag: newClubTag.trim().toUpperCase(),
      description: newClubDesc.trim(),
      emblemColor: newClubColor,
      emblemIcon: newClubIcon,
      joinMode: newClubJoinMode,
      region: newClubRegion,
      maxMembers: newClubMaxMembers,
    });
    setBusyId(null);
    if (res.ok && res.data) {
      setShowCreateClub(false);
      setNewClubName('');
      setNewClubTag('');
      setNewClubDesc('');
      setClubLeagueNotice({
        type: 'ok',
        text: t('clubLeagues.notices.foundedClub', {
          tag: res.data.club.tag,
          name: res.data.club.name,
        }),
      });
      void clubLeagueClient.listClubTeams(res.data.club.clubId);
      void socialClient.fetchClubChat(res.data.club.clubId, 50);
    } else {
      setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
    }
  };

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!myClub?.clubId || !teamName.trim() || !teamTag.trim()) return;
    setBusyId('create-team');
    const res = await clubLeagueClient.createTeam(myClub.clubId, {
      name: teamName.trim(),
      tag: teamTag.trim().toUpperCase(),
      badgeColor: teamColor,
      badgeIcon: teamIcon,
      region: teamRegion,
      minRosterSize: teamMinRoster,
      maxRosterSize: teamMaxRoster,
      captainId: teamCaptainId || ownProfile?.playerId,
    });
    setBusyId(null);
    if (res.ok && res.data) {
      setShowCreateTeam(false);
      setTeamName('');
      setTeamTag('');
      setSelectedTeamId(res.data.teamId);
      setClubLeagueNotice({
        type: 'ok',
        text: t('clubLeagues.notices.formedSquad', {
          tag: res.data.tag,
          name: res.data.name,
        }),
      });
    } else {
      setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
    }
  };

  const handleCreateLeague = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leagueTitle.trim()) return;
    setBusyId('create-league');
    const res = await clubLeagueClient.createLeague({
      title: leagueTitle.trim(),
      description: leagueDesc.trim(),
      scope: leagueScope,
      region: leagueRegion,
      cadence: leagueCadence,
      matchFormat: leagueFormat,
      ruleProfileId: leagueRule,
      calledShotsEnabled: leagueRule === 'wpa',
      doubleRoundRobin: leagueDoubleRr,
      maxTeams: leagueMaxTeams,
      promotionSlots: leaguePromoSlots,
      relegationSlots: leagueRelSlots,
    });
    setBusyId(null);
    if (res.ok && res.data) {
      setShowCreateLeague(false);
      setLeagueTitle('');
      setLeagueDesc('');
      setSelectedLeagueId(res.data.league.leagueId);
      setClubLeagueNotice({
        type: 'ok',
        text: t('clubLeagues.notices.createdLeague', { title: res.data.league.title }),
      });
    } else {
      setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
    }
  };

  const handleCreateChampionship = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!champTitle.trim()) return;
    setBusyId('create-champ');
    const res = await clubLeagueClient.createChampionship({
      title: champTitle.trim(),
      description: champDesc.trim(),
      format: champFormat,
      region: champRegion,
      matchFormat: champMatchFormat,
      ruleProfileId: champRule,
      calledShotsEnabled: champRule === 'wpa',
      maxTeams: champMaxTeams,
      swissRounds: champSwissRounds,
      groupSize: champGroupSize,
      groupAdvanceCount: champAdvanceCount,
      prizeCoinsChampion: champPrizeCoins,
    });
    setBusyId(null);
    if (res.ok && res.data) {
      setShowCreateChamp(false);
      setChampTitle('');
      setChampDesc('');
      setSelectedChampionshipId(res.data.championship.championshipId);
      setClubLeagueNotice({
        type: 'ok',
        text: t('clubLeagues.notices.launchedChampionship', {
          title: res.data.championship.title,
        }),
      });
    } else {
      setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
    }
  };

  const tabs: Array<{ id: ClubLeagueTab; label: string; icon: typeof Shield }> = [
    { id: 'club_hq', label: copy.tabs.clubHq, icon: Shield },
    { id: 'teams', label: copy.tabs.teams, icon: Users },
    { id: 'leagues', label: copy.tabs.leagues, icon: Trophy },
    { id: 'championships', label: copy.tabs.championships, icon: Crown },
    { id: 'rankings', label: copy.tabs.rankings, icon: BarChart3 },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-2 sm:p-4">
      <div
        data-testid="club-league-modal"
        dir={isRtl ? 'rtl' : 'ltr'}
        className="relative flex w-full max-w-5xl max-h-[92vh] flex-col rounded-2xl border border-white/15 bg-[#0a0f16]/95 shadow-2xl overflow-hidden text-slate-100"
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#0e1520] px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-400/40 bg-amber-500/15">
              <Crown className="h-5 w-5 text-amber-400" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-base sm:text-lg font-extrabold tracking-tight text-white">
                {copy.title}
              </h2>
              <p className="truncate text-[11px] text-slate-400">{copy.subtitle}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              data-testid="club-league-lang-toggle"
              onClick={() => {
                soundEngine.playUiClick();
                setLanguage(language === 'en' ? 'ar' : 'en');
              }}
              className="min-h-[44px] inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
            >
              <Languages className="h-3.5 w-3.5 text-amber-400" />
              {language === 'en' ? 'العربية' : 'English'}
            </button>

            <button
              type="button"
              disabled={busyId === 'refresh'}
              onClick={() => void refreshAll()}
              aria-label={copy.refresh}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/5 text-slate-200 hover:bg-white/10 cursor-pointer"
            >
              <RefreshCw className={`h-4 w-4 ${busyId === 'refresh' ? 'animate-spin text-amber-400' : ''}`} />
            </button>

            <button
              type="button"
              data-testid="club-league-close-btn"
              onClick={() => {
                soundEngine.playUiClick();
                closeClubLeagueModal();
              }}
              aria-label={copy.close}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Tab Bar */}
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-white/10 bg-[#0b1018] px-3 py-2 sm:px-5 shrink-0">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = clubLeagueTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`club-league-tab-${tab.id}`}
                onClick={() => {
                  soundEngine.playUiClick();
                  setClubLeagueTab(tab.id);
                }}
                className={`min-h-[44px] inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-extrabold transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? 'border-amber-400 bg-amber-500 text-slate-950'
                    : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-slate-950' : 'text-amber-400'}`} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Notice Banner */}
        {clubLeagueNotice && (
          <div
            className={`flex items-center justify-between gap-2 border-b px-4 py-2 text-xs font-bold ${
              clubLeagueNotice.type === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/12 text-emerald-200'
                : 'border-rose-500/30 bg-rose-500/12 text-rose-200'
            }`}
          >
            <span>{clubLeagueNotice.text}</span>
            <button
              type="button"
              onClick={() => setClubLeagueNotice(null)}
              className="text-slate-300 hover:text-white cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-4">
          {/* ================= TAB 1: CLUB HQ ================= */}
          {clubLeagueTab === 'club_hq' && (
            <div className="space-y-4">
              {/* Incoming Club Invitations */}
              {incomingClubInvitations.length > 0 && (
                <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 p-3 space-y-2">
                  <div className="text-[11px] font-extrabold uppercase tracking-wider text-amber-300">
                    {copy.club.clubInvitationsTitle} ({incomingClubInvitations.length})
                  </div>
                  {incomingClubInvitations.map((inv) => (
                    <div
                      key={inv.inviteId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        {renderEmblemIcon(inv.emblemIcon, inv.emblemColor)}
                        <span className="font-extrabold text-white">
                          <span dir="ltr">[{inv.clubTag}]</span> {inv.clubName}
                        </span>
                        <span className="text-slate-400">
                          · {t('clubLeagues.club.invitedBy', { name: inv.inviterName })}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busyId === inv.inviteId}
                          onClick={async () => {
                            setBusyId(inv.inviteId);
                            const r = await socialClient.respondClubInvite(inv.inviteId, 'accept');
                            setBusyId(null);
                            if (r.ok) {
                              setClubLeagueNotice({
                                type: 'ok',
                                text: t('clubLeagues.notices.inviteAccepted', {
                                  tag: inv.clubTag,
                                  name: inv.clubName,
                                }),
                              });
                            } else {
                              setClubLeagueNotice({ type: 'err', text: localizeServerError(r.error, language) });
                            }
                          }}
                          className="min-h-[36px] rounded-lg bg-emerald-500 px-3 py-1 text-xs font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer"
                        >
                          {t('common.accept')}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === inv.inviteId}
                          onClick={async () => {
                            setBusyId(inv.inviteId);
                            await socialClient.respondClubInvite(inv.inviteId, 'reject');
                            setBusyId(null);
                          }}
                          className="min-h-[36px] rounded-lg border border-white/15 bg-white/5 px-3 py-1 text-xs font-bold text-slate-300 hover:bg-white/10 cursor-pointer"
                        >
                          {t('common.decline')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {myClub && clubDetail ? (
                <>
                  {/* Club Overview Header Card */}
                  <div className="rounded-xl border border-white/12 bg-[#0f1620] p-4 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border"
                          style={{
                            borderColor: `${clubDetail.club.emblemColor}66`,
                            backgroundColor: `${clubDetail.club.emblemColor}1c`,
                          }}
                        >
                          {renderEmblemIcon(clubDetail.club.emblemIcon, clubDetail.club.emblemColor, 'h-6 w-6')}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className="font-mono text-xs font-black"
                              style={{ color: clubDetail.club.emblemColor }}
                              dir="ltr"
                            >
                              [{clubDetail.club.tag}]
                            </span>
                            <h3 className="truncate text-base font-extrabold text-white">
                              {clubDetail.club.name}
                            </h3>
                            <span className="text-xs font-bold text-amber-300">
                              {copy.club.levelLabel} {formatNumber(clubDetail.club.level ?? 1)}
                            </span>
                          </div>
                          {clubDetail.club.description && (
                            <p className="mt-1 text-xs text-slate-300">{clubDetail.club.description}</p>
                          )}
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums text-slate-400">
                            <span>
                              {copy.club.regionLabel}: {localizeClubRegion(clubDetail.club.region, language)}
                            </span>
                            <span>·</span>
                            <span>
                              {copy.club.capacityLabel}:{' '}
                              <span dir="ltr">
                                {clubDetail.club.memberCount}/{clubDetail.club.maxMembers ?? 50}
                              </span>
                            </span>
                            <span>·</span>
                            <span>
                              {copy.notices.ratingMetaPrefix} {formatNumber(clubDetail.club.clubRating)}
                            </span>
                            <span>·</span>
                            <span dir="ltr">
                              {clubDetail.club.totalWins}{copy.notices.recordShortW} /{' '}
                              {clubDetail.club.totalMatches}{copy.notices.recordShortM}
                            </span>
                            <span>·</span>
                            <span>
                              {copy.rankings.titles}:{' '}
                              <span dir="ltr">
                                {(clubDetail.club.leagueTitles ?? 0) + (clubDetail.club.championshipTitles ?? 0)}
                              </span>
                            </span>
                          </div>
                          {/* Club XP Bar */}
                          <div className="mt-2 max-w-xs space-y-1">
                            <div className="flex justify-between font-mono text-[10px] text-slate-400 tabular-nums">
                              <span>{copy.club.xpLabel}</span>
                              <span dir="ltr">
                                {clubDetail.club.xpIntoLevel ?? 0} / {clubDetail.club.xpForNextLevel ?? 250}
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded bg-white/10">
                              <div
                                className="h-full bg-amber-500 transition-all"
                                style={{
                                  width: `${Math.min(
                                    100,
                                    Math.round(
                                      ((clubDetail.club.xpIntoLevel ?? 0) /
                                        Math.max(1, clubDetail.club.xpForNextLevel ?? 250)) *
                                        100,
                                    ),
                                  )}%`,
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {isOfficer && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditClubDesc(clubDetail.club.description);
                              setEditClubJoinMode(clubDetail.club.joinMode);
                              setEditClubRegion(clubDetail.club.region ?? 'GLOBAL');
                              setEditClubMaxMembers(clubDetail.club.maxMembers ?? 50);
                              setEditingClub((v) => !v);
                            }}
                            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
                          >
                            <Settings className="h-3.5 w-3.5 text-amber-400" />
                            {copy.club.editClubBtn}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busyId === 'leave-club'}
                          onClick={async () => {
                            setBusyId('leave-club');
                            const res = await socialClient.leaveClub(clubDetail.club.clubId);
                            setBusyId(null);
                            if (res.ok) {
                              setClubLeagueNotice({ type: 'ok', text: copy.notices.leftClub });
                            } else {
                              setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                            }
                          }}
                          className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-500/12 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap"
                        >
                          <LogOut className="h-3.5 w-3.5" />
                          {copy.club.leaveClub}
                        </button>
                      </div>
                    </div>

                    {/* Officer Settings Drawer */}
                    {editingClub && isOfficer && (
                      <div className="rounded-lg border border-white/10 bg-black/35 p-3 space-y-2.5">
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                          <input
                            type="text"
                            maxLength={180}
                            value={editClubDesc}
                            onChange={(e) => setEditClubDesc(e.target.value)}
                            placeholder={copy.club.descPlaceholder}
                            className="sm:col-span-2 min-h-[38px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-1.5 text-xs text-white"
                          />
                          <select
                            value={editClubRegion}
                            onChange={(e) => setEditClubRegion(e.target.value)}
                            className="min-h-[38px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-1.5 text-xs text-white"
                          >
                            {COMPETITION_REGIONS.map((r) => (
                              <option key={r.id} value={r.id}>
                                {localizeClubRegion(r.id, language)}
                              </option>
                            ))}
                          </select>
                          <div className="flex gap-1.5">
                            <input
                              type="number"
                              min={SOCIAL_LIMITS.minClubCapacity}
                              max={SOCIAL_LIMITS.maxClubMembers}
                              value={editClubMaxMembers}
                              onChange={(e) =>
                                setEditClubMaxMembers(
                                  Math.max(
                                    SOCIAL_LIMITS.minClubCapacity,
                                    Math.min(
                                      SOCIAL_LIMITS.maxClubMembers,
                                      Number.parseInt(e.target.value, 10) || 50,
                                    ),
                                  ),
                                )
                              }
                              className="w-20 min-h-[38px] rounded-lg border border-white/15 bg-[#0a0f16] px-2 py-1.5 text-xs text-white"
                            />
                            <select
                              value={editClubJoinMode}
                              onChange={(e) => setEditClubJoinMode(e.target.value as ClubJoinMode)}
                              className="flex-1 min-h-[38px] rounded-lg border border-white/15 bg-[#0a0f16] px-2 py-1.5 text-xs text-white"
                            >
                              <option value="public">{copy.notices.openJoinPolicy}</option>
                              <option value="approval">{copy.notices.approvalJoinPolicy}</option>
                            </select>
                          </div>
                        </div>
                        <div className="flex justify-end">
                          <button
                            type="button"
                            disabled={busyId === 'save-club-edit'}
                            onClick={async () => {
                              setBusyId('save-club-edit');
                              const res = await socialClient.updateClub(clubDetail.club.clubId, {
                                description: editClubDesc,
                                joinMode: editClubJoinMode,
                                region: editClubRegion,
                                maxMembers: editClubMaxMembers,
                              });
                              setBusyId(null);
                              if (res.ok) {
                                setEditingClub(false);
                                setClubLeagueNotice({ type: 'ok', text: copy.notices.clubUpdated });
                              } else {
                                setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                              }
                            }}
                            className="min-h-[38px] rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                          >
                            {copy.club.saveChangesBtn}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Club Announcement Bulletin */}
                    <div className="rounded-lg border border-amber-400/25 bg-amber-500/[0.06] p-3 space-y-2">
                      <div className="text-[11px] font-extrabold uppercase tracking-wider text-amber-300">
                        {copy.club.announcementLabel}
                      </div>
                      <p className="text-xs text-slate-200">
                        {clubDetail.club.announcement || copy.notices.noOfficialBulletin}
                      </p>
                      {isOfficer && (
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (!announcementDraft.trim()) return;
                            setBusyId('post-announcement');
                            const res = await socialClient.updateClubAnnouncement(
                              clubDetail.club.clubId,
                              announcementDraft.trim(),
                            );
                            setBusyId(null);
                            if (res.ok) {
                              setAnnouncementDraft('');
                              setClubLeagueNotice({ type: 'ok', text: copy.club.bulletinUpdatedNotice });
                            } else {
                              setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                            }
                          }}
                          className="flex flex-wrap gap-2"
                        >
                          <input
                            type="text"
                            maxLength={SOCIAL_LIMITS.clubAnnouncementMaxLength}
                            value={announcementDraft}
                            onChange={(e) => setAnnouncementDraft(e.target.value)}
                            placeholder={copy.club.announcementPlaceholder}
                            className="flex-1 min-w-[200px] min-h-[38px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-1.5 text-xs text-white"
                          />
                          <button
                            type="submit"
                            disabled={!announcementDraft.trim() || busyId === 'post-announcement'}
                            className="min-h-[38px] rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                          >
                            <Edit3 className="inline h-3 w-3 me-1" />
                            {copy.club.postAnnouncement}
                          </button>
                        </form>
                      )}
                    </div>
                  </div>

                  {/* Two-Column HQ Body: Members + Applications & Chat + Trophies */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Leadership & Roster */}
                    <div className="rounded-xl border border-white/12 bg-[#0f1620] p-3.5 space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-extrabold uppercase tracking-wider text-amber-400">
                          {copy.club.membersTitle} ({clubDetail.members.length})
                        </h4>
                      </div>

                      {isOfficer && (
                        <div className="flex flex-wrap gap-2">
                          <input
                            type="text"
                            value={inviteTargetId}
                            onChange={(e) => setInviteTargetId(e.target.value)}
                            placeholder={copy.club.invitePlaceholder}
                            className="flex-1 min-w-[140px] min-h-[38px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-1.5 text-xs text-white"
                          />
                          <button
                            type="button"
                            disabled={!inviteTargetId.trim() || busyId === 'club-invite'}
                            onClick={async () => {
                              setBusyId('club-invite');
                              const res = await socialClient.inviteToClub(
                                clubDetail.club.clubId,
                                inviteTargetId.trim(),
                              );
                              setBusyId(null);
                              if (res.ok) {
                                setInviteTargetId('');
                                setClubLeagueNotice({ type: 'ok', text: copy.notices.inviteSent });
                              } else {
                                setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                              }
                            }}
                            className="min-h-[38px] inline-flex items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/25 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                          >
                            <UserPlus className="h-3.5 w-3.5" />
                            {copy.club.invitePlayer}
                          </button>
                        </div>
                      )}

                      {isOfficer && clubDetail.joinRequests.length > 0 && (
                        <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-2.5 space-y-2">
                          <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                            {copy.club.joinRequestsTitle} ({clubDetail.joinRequests.length})
                          </div>
                          {clubDetail.joinRequests.map((jr) => (
                            <div
                              key={jr.requestId}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs"
                            >
                              <div>
                                <span className="font-bold text-white">{jr.displayName}</span>
                                <span className="ms-2 font-mono text-[10px] text-slate-400 tabular-nums">
                                  {formatNumber(jr.elo)} {t('common.elo')}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={async () => {
                                    setBusyId(jr.requestId);
                                    await socialClient.respondClubJoinRequest(
                                      clubDetail.club.clubId,
                                      jr.requestId,
                                      'accept',
                                    );
                                    setBusyId(null);
                                  }}
                                  className="min-h-[34px] rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 cursor-pointer"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    setBusyId(jr.requestId);
                                    await socialClient.respondClubJoinRequest(
                                      clubDetail.club.clubId,
                                      jr.requestId,
                                      'reject',
                                    );
                                    setBusyId(null);
                                  }}
                                  className="min-h-[34px] rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200 cursor-pointer"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="space-y-1.5 max-h-[340px] overflow-y-auto">
                        {clubDetail.members.map((m) => {
                          const isSelf = ownProfile?.playerId === m.playerId;
                          const canChangeRole =
                            !isSelf &&
                            (viewerRole === 'owner' ||
                              (viewerRole === 'president' &&
                                m.role !== 'owner' &&
                                m.role !== 'president'));
                          const canKick =
                            !isSelf &&
                            (viewerRole === 'owner' ||
                              (viewerRole === 'president' && m.role !== 'owner' && m.role !== 'president') ||
                              ((viewerRole === 'vice_president' || viewerRole === 'admin') &&
                                (m.role === 'member' || m.role === 'captain')));

                          return (
                            <div
                              key={m.playerId}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-xs"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className={`h-2 w-2 shrink-0 rounded-full ${presenceDotClass(m.presence)}`} />
                                <span className="truncate font-bold text-white">{m.displayName}</span>
                                <span className="text-[10px] font-bold uppercase text-amber-300">
                                  {copy.roles[m.role] ?? m.role}
                                </span>
                                <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                                  {formatNumber(m.elo)} {t('common.elo')}
                                </span>
                              </div>

                              <div className="flex flex-wrap items-center gap-1">
                                {canChangeRole && (
                                  <select
                                    value={m.role === 'admin' ? 'vice_president' : m.role}
                                    disabled={busyId === `role:${m.playerId}`}
                                    onChange={async (e) => {
                                      const nextRole = e.target.value as ClubRole;
                                      setBusyId(`role:${m.playerId}`);
                                      const res = await socialClient.updateClubMemberRole(
                                        clubDetail.club.clubId,
                                        m.playerId,
                                        nextRole,
                                      );
                                      setBusyId(null);
                                      if (!res.ok) {
                                        setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                                      }
                                    }}
                                    aria-label={copy.club.promoteRole}
                                    className="min-h-[34px] rounded-md border border-white/15 bg-[#0a0f16] px-2 py-1 text-[10px] font-bold text-slate-200"
                                  >
                                    {viewerRole === 'owner' && <option value="owner">{copy.roles.owner}</option>}
                                    {viewerRole === 'owner' && (
                                      <option value="president">{copy.roles.president}</option>
                                    )}
                                    <option value="vice_president">{copy.roles.vice_president}</option>
                                    <option value="captain">{copy.roles.captain}</option>
                                    <option value="member">{copy.roles.member}</option>
                                  </select>
                                )}
                                {canKick && (
                                  <button
                                    type="button"
                                    disabled={busyId === `kick:${m.playerId}`}
                                    onClick={async () => {
                                      setBusyId(`kick:${m.playerId}`);
                                      await socialClient.kickClubMember(clubDetail.club.clubId, m.playerId);
                                      setBusyId(null);
                                    }}
                                    title={copy.club.kickMember}
                                    className="min-h-[34px] rounded-md border border-rose-500/35 bg-rose-500/12 px-2 py-1 text-[10px] font-bold text-rose-200 hover:bg-rose-500/20 cursor-pointer"
                                  >
                                    <UserMinus className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => openProgressionModal('profile', m.playerId)}
                                  title={t('common.viewProfile')}
                                  className="min-h-[34px] min-w-[34px] inline-flex items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 cursor-pointer"
                                >
                                  <User className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Club Hall Chat & Trophy Case */}
                    <div className="space-y-4">
                      {/* Club Hall Chat */}
                      <div className="rounded-xl border border-white/12 bg-[#0f1620] p-3.5 space-y-2.5">
                        <div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-amber-400">
                          <MessageSquare className="h-3.5 w-3.5" />
                          {copy.club.clubChatTitle}
                        </div>
                        <div className="max-h-[200px] min-h-[120px] overflow-y-auto space-y-1.5 rounded-lg border border-white/10 bg-black/35 p-2.5">
                          {clubChatMessages.length === 0 ? (
                            <p className="text-xs text-slate-500">{copy.club.noChatYet}</p>
                          ) : (
                            clubChatMessages.map((msg) => (
                              <div key={msg.messageId} className="text-xs leading-relaxed">
                                <span className="font-bold text-amber-300">{msg.senderName}</span>
                                <span className="mx-1 text-[10px] text-slate-500">
                                  ({copy.roles[msg.senderRole] ?? msg.senderRole})
                                </span>
                                <span className="text-slate-200">{msg.body}</span>
                              </div>
                            ))
                          )}
                        </div>
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (!chatDraft.trim()) return;
                            setBusyId('send-club-chat');
                            const res = await socialClient.sendClubChat(
                              clubDetail.club.clubId,
                              chatDraft.trim(),
                            );
                            setBusyId(null);
                            if (res.ok) {
                              setChatDraft('');
                            } else {
                              setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                            }
                          }}
                          className="flex gap-2"
                        >
                          <input
                            type="text"
                            maxLength={SOCIAL_LIMITS.clubChatMaxLength}
                            value={chatDraft}
                            onChange={(e) => setChatDraft(e.target.value)}
                            placeholder={copy.club.chatPlaceholder}
                            className="flex-1 min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-3 py-1.5 text-xs text-white"
                          />
                          <button
                            type="submit"
                            disabled={!chatDraft.trim() || busyId === 'send-club-chat'}
                            className="min-h-[40px] inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
                          >
                            <Send className="h-3.5 w-3.5" />
                            {copy.club.sendMessage}
                          </button>
                        </form>
                      </div>

                      {/* Club Trophies */}
                      <div className="rounded-xl border border-white/12 bg-[#0f1620] p-3.5 space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-amber-400">
                          <Award className="h-3.5 w-3.5" />
                          {copy.club.trophiesTitle}
                        </div>
                        {clubTrophies.length === 0 ? (
                          <p className="text-xs text-slate-400">{copy.club.noTrophies}</p>
                        ) : (
                          <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
                            {clubTrophies.map((tr) => (
                              <div
                                key={tr.trophyId}
                                className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs"
                              >
                                <div className="min-w-0">
                                  <div className="truncate font-bold text-amber-300">{tr.title}</div>
                                  <div className="text-[10px] text-slate-400">
                                    {tr.tier} · {tr.seasonLabel}
                                    {tr.teamName ? ` · ${tr.teamName}` : ''}
                                  </div>
                                </div>
                                <span className="font-mono text-[10px] text-slate-500 shrink-0 tabular-nums">
                                  {formatShortTime(tr.awardedAtMs, language)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                /* No Club Joined Yet: Create Club or Browse Directory */
                <div className="space-y-4">
                  <div className="rounded-xl border border-white/12 bg-[#0f1620] p-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-extrabold text-white">{copy.club.noClubTitle}</h3>
                      <p className="mt-0.5 text-xs text-slate-400">{copy.club.noClubDesc}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowCreateClub((v) => !v)}
                      className="min-h-[44px] inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                    >
                      <Plus className="h-4 w-4" />
                      {copy.club.createClub}
                    </button>
                  </div>

                  {showCreateClub && (
                    <form
                      onSubmit={handleCreateClub}
                      className="rounded-xl border border-amber-400/35 bg-[#0f1620] p-4 space-y-3"
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                        <input
                          type="text"
                          required
                          minLength={3}
                          maxLength={28}
                          value={newClubName}
                          onChange={(e) => setNewClubName(e.target.value)}
                          placeholder={copy.club.clubNamePlaceholder}
                          className="sm:col-span-2 min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-3 py-2 text-xs text-white"
                        />
                        <input
                          type="text"
                          required
                          minLength={2}
                          maxLength={5}
                          value={newClubTag}
                          onChange={(e) => setNewClubTag(e.target.value.toUpperCase())}
                          placeholder={copy.club.clubTagPlaceholder}
                          className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-3 py-2 font-mono text-xs font-bold uppercase text-white"
                        />
                      </div>
                      <input
                        type="text"
                        maxLength={180}
                        value={newClubDesc}
                        onChange={(e) => setNewClubDesc(e.target.value)}
                        placeholder={copy.club.descPlaceholder}
                        className="w-full min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-3 py-2 text-xs text-white"
                      />
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                        <select
                          value={newClubRegion}
                          onChange={(e) => setNewClubRegion(e.target.value)}
                          className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                        >
                          {COMPETITION_REGIONS.map((r) => (
                            <option key={r.id} value={r.id}>
                              {localizeClubRegion(r.id, language)}
                            </option>
                          ))}
                        </select>
                        <select
                          value={newClubJoinMode}
                          onChange={(e) => setNewClubJoinMode(e.target.value as ClubJoinMode)}
                          className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                        >
                          <option value="public">{copy.club.publicModeLabel}</option>
                          <option value="approval">{copy.club.approvalModeLabel}</option>
                        </select>
                        <input
                          type="number"
                          min={SOCIAL_LIMITS.minClubCapacity}
                          max={SOCIAL_LIMITS.maxClubMembers}
                          value={newClubMaxMembers}
                          onChange={(e) =>
                            setNewClubMaxMembers(
                              Math.max(
                                SOCIAL_LIMITS.minClubCapacity,
                                Math.min(
                                  SOCIAL_LIMITS.maxClubMembers,
                                  Number.parseInt(e.target.value, 10) || 50,
                                ),
                              ),
                            )
                          }
                          aria-label={copy.club.capacityLabel}
                          className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                        />
                        <div className="flex items-center gap-1 flex-wrap">
                          {COLOR_PRESETS.slice(0, 5).map((c) => (
                            <button
                              key={c}
                              type="button"
                              aria-label={t('social.selectColorAria', { color: c })}
                              onClick={() => setNewClubColor(c)}
                              className={`h-7 w-7 rounded border-2 cursor-pointer ${
                                newClubColor === c ? 'border-white' : 'border-transparent'
                              }`}
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          {EMBLEM_ICONS.map((ic) => (
                            <button
                              key={ic.id}
                              type="button"
                              aria-label={t(ic.labelKey)}
                              onClick={() => setNewClubIcon(ic.id)}
                              className={`h-8 w-8 inline-flex items-center justify-center rounded-lg border cursor-pointer ${
                                newClubIcon === ic.id
                                  ? 'border-amber-400 bg-amber-500/15'
                                  : 'border-white/10 bg-white/5'
                              }`}
                            >
                              {renderEmblemIcon(ic.id, newClubColor)}
                            </button>
                          ))}
                        </div>
                        <button
                          type="submit"
                          disabled={busyId === 'create-club' || !newClubName.trim() || !newClubTag.trim()}
                          className="min-h-[40px] rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
                        >
                          {copy.club.createClub}
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Clubs Directory */}
                  <div className="rounded-xl border border-white/12 bg-[#0f1620] p-3.5 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-extrabold uppercase tracking-wider text-amber-400">
                        {copy.club.clubDirectory} ({clubsList.length})
                      </span>
                      <input
                        type="text"
                        value={clubSearch}
                        onChange={(e) => {
                          setClubSearch(e.target.value);
                          void socialClient.listClubs(e.target.value, 30);
                        }}
                        placeholder={copy.club.searchClubsPlaceholder}
                        className="min-h-[38px] rounded-lg border border-white/15 bg-[#0a0f16] px-3 py-1.5 text-xs text-white"
                      />
                    </div>
                    <div className="space-y-2 max-h-[340px] overflow-y-auto">
                      {clubsList.map((c) => (
                        <div
                          key={c.clubId}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-xs"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            {renderEmblemIcon(c.emblemIcon, c.emblemColor, 'h-5 w-5 shrink-0')}
                            <div className="min-w-0">
                              <div className="truncate font-extrabold text-white">
                                <span className="font-mono me-1.5" style={{ color: c.emblemColor }} dir="ltr">
                                  [{c.tag}]
                                </span>
                                {c.name}
                              </div>
                              <div className="font-mono text-[10px] text-slate-400 tabular-nums">
                                {t('common.levelShort')} {formatNumber(c.level ?? 1)} ·{' '}
                                {localizeClubRegion(c.region, language)} ·{' '}
                                <span dir="ltr">
                                  {c.memberCount}/{c.maxMembers ?? 50}
                                </span>{' '}
                                · {copy.notices.ratingMetaPrefix} {formatNumber(c.clubRating)}
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={busyId === `join:${c.clubId}`}
                            onClick={async () => {
                              setBusyId(`join:${c.clubId}`);
                              const res = await socialClient.joinClub(c.clubId);
                              setBusyId(null);
                              if (res.ok) {
                                setClubLeagueNotice({
                                  type: 'ok',
                                  text:
                                    res.data?.outcome === 'requested'
                                      ? copy.club.pendingRequest
                                      : t('clubLeagues.notices.inviteAccepted', {
                                          tag: c.tag,
                                          name: c.name,
                                        }),
                                });
                              } else {
                                setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                              }
                            }}
                            className="min-h-[40px] rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                          >
                            {c.joinMode === 'public' ? copy.club.joinPublic : copy.club.requestJoin}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================= TAB 2: TEAMS & ROSTERS ================= */}
          {clubLeagueTab === 'teams' && (
            <div className="space-y-4">
              {!myClub ? (
                <div className="rounded-xl border border-white/12 bg-[#0f1620] p-6 text-center space-y-2">
                  <p className="text-sm font-bold text-white">{copy.club.noClubTitle}</p>
                  <button
                    type="button"
                    onClick={() => setClubLeagueTab('club_hq')}
                    className="min-h-[44px] rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 cursor-pointer"
                  >
                    {copy.tabs.clubHq}
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-extrabold text-white">
                      {copy.teams.title} · <span dir="ltr">[{myClub.tag}]</span>
                    </h3>
                    {canManageTeams && (
                      <button
                        type="button"
                        onClick={() => setShowCreateTeam((v) => !v)}
                        className="min-h-[44px] inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                      >
                        <Plus className="h-4 w-4" />
                        {copy.teams.createTeam}
                      </button>
                    )}
                  </div>

                  {showCreateTeam && canManageTeams && (
                    <form
                      onSubmit={handleCreateTeam}
                      className="rounded-xl border border-amber-400/35 bg-[#0f1620] p-4 space-y-3"
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                        <input
                          type="text"
                          required
                          minLength={3}
                          maxLength={28}
                          value={teamName}
                          onChange={(e) => setTeamName(e.target.value)}
                          placeholder={copy.teams.teamName}
                          className="sm:col-span-2 min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-3 py-2 text-xs text-white"
                        />
                        <input
                          type="text"
                          required
                          minLength={2}
                          maxLength={5}
                          value={teamTag}
                          onChange={(e) => setTeamTag(e.target.value.toUpperCase())}
                          placeholder={copy.teams.teamTag}
                          className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-3 py-2 font-mono text-xs font-bold uppercase text-white"
                        />
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                        <select
                          value={teamRegion}
                          onChange={(e) => setTeamRegion(e.target.value)}
                          className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                        >
                          {COMPETITION_REGIONS.map((r) => (
                            <option key={r.id} value={r.id}>
                              {localizeClubRegion(r.id, language)}
                            </option>
                          ))}
                        </select>
                        <select
                          value={teamCaptainId || ownProfile?.playerId || ''}
                          onChange={(e) => setTeamCaptainId(e.target.value)}
                          className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                        >
                          {(clubDetail?.members ?? []).map((m) => (
                            <option key={m.playerId} value={m.playerId}>
                              {copy.teams.captainLabel}: {m.displayName}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min={1}
                          max={5}
                          value={teamMinRoster}
                          onChange={(e) => setTeamMinRoster(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
                          aria-label={copy.teams.minRoster}
                          className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                        />
                        <input
                          type="number"
                          min={teamMinRoster}
                          max={SOCIAL_LIMITS.maxTeamRoster}
                          value={teamMaxRoster}
                          onChange={(e) =>
                            setTeamMaxRoster(
                              Math.max(teamMinRoster, Number.parseInt(e.target.value, 10) || 6),
                            )
                          }
                          aria-label={copy.teams.maxRoster}
                          className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                        />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          {COLOR_PRESETS.slice(0, 5).map((c) => (
                            <button
                              key={c}
                              type="button"
                              aria-label={t('social.selectColorAria', { color: c })}
                              onClick={() => setTeamColor(c)}
                              className={`h-6 w-6 rounded border-2 cursor-pointer ${
                                teamColor === c ? 'border-white' : 'border-transparent'
                              }`}
                              style={{ backgroundColor: c }}
                            />
                          ))}
                          {EMBLEM_ICONS.slice(0, 4).map((ic) => (
                            <button
                              key={ic.id}
                              type="button"
                              aria-label={t(ic.labelKey)}
                              onClick={() => setTeamIcon(ic.id)}
                              className={`h-7 w-7 inline-flex items-center justify-center rounded border cursor-pointer ${
                                teamIcon === ic.id
                                  ? 'border-amber-400 bg-amber-500/15'
                                  : 'border-white/10 bg-white/5'
                              }`}
                            >
                              {renderEmblemIcon(ic.id, teamColor)}
                            </button>
                          ))}
                        </div>
                        <button
                          type="submit"
                          disabled={busyId === 'create-team' || !teamName.trim() || !teamTag.trim()}
                          className="min-h-[40px] rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
                        >
                          {copy.teams.createTeam}
                        </button>
                      </div>
                    </form>
                  )}

                  {clubTeams.length === 0 ? (
                    <div className="rounded-xl border border-white/10 bg-[#0f1620] p-6 text-center text-xs text-slate-400">
                      {copy.teams.noTeams}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-[290px_1fr] gap-4">
                      {/* Teams Selector List */}
                      <div className="space-y-2">
                        {clubTeams.map((tm) => {
                          const active = selectedTeam?.teamId === tm.teamId;
                          return (
                            <button
                              key={tm.teamId}
                              type="button"
                              onClick={() => setSelectedTeamId(tm.teamId)}
                              className={`w-full min-h-[56px] flex items-center justify-between gap-2 rounded-xl border p-3 text-start transition-colors cursor-pointer ${
                                active
                                  ? 'border-amber-400 bg-amber-500/12'
                                  : 'border-white/10 bg-[#0f1620] hover:bg-white/[0.06]'
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                {renderEmblemIcon(tm.badgeIcon, tm.badgeColor, 'h-5 w-5 shrink-0')}
                                <div className="min-w-0">
                                  <div className="truncate text-xs font-extrabold text-white">
                                    <span className="font-mono me-1" style={{ color: tm.badgeColor }} dir="ltr">
                                      [{tm.tag}]
                                    </span>
                                    {tm.name}
                                  </div>
                                  <div className="font-mono text-[10px] text-slate-400 tabular-nums">
                                    {formatNumber(tm.elo)} {t('common.elo')} ·{' '}
                                    <span dir="ltr">
                                      {tm.rosterCount}/{tm.maxRosterSize}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <span className="font-mono text-[11px] font-bold text-amber-300 tabular-nums shrink-0" dir="ltr">
                                {tm.wins}-{tm.losses}-{tm.draws}
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Selected Team Roster Management */}
                      {selectedTeam && (
                        <div className="rounded-xl border border-white/12 bg-[#0f1620] p-4 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                            <div>
                              <h4 className="text-sm font-extrabold text-white">
                                <span dir="ltr">[{selectedTeam.tag}]</span> {selectedTeam.name}
                              </h4>
                              <div className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
                                {copy.teams.eloLabel}: {formatNumber(selectedTeam.elo)} ·{' '}
                                {localizeClubRegion(selectedTeam.region, language)} ·{' '}
                                {formatNumber(selectedTeam.titlesCount)} {copy.rankings.titles}
                              </div>
                            </div>
                            <span className="font-mono text-xs font-bold text-emerald-300 tabular-nums">
                              {copy.teams.teamRosterLabel}{' '}
                              <span dir="ltr">
                                {selectedTeam.rosterCount}/{selectedTeam.maxRosterSize}
                              </span>
                            </span>
                          </div>

                          {/* Add Member to Roster */}
                          {(canManageTeams || selectedTeam.captainId === ownProfile?.playerId) &&
                            clubDetail && (
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  value={addMemberPlayerId}
                                  onChange={(e) => setAddMemberPlayerId(e.target.value)}
                                  className="flex-1 min-w-[160px] min-h-[38px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-1.5 text-xs text-white"
                                >
                                  <option value="">{copy.teams.addMember}...</option>
                                  {clubDetail.members
                                    .filter((m) => !selectedTeam.roster.some((r) => r.playerId === m.playerId))
                                    .map((m) => (
                                      <option key={m.playerId} value={m.playerId}>
                                        {m.displayName} ({m.elo} {t('common.elo')})
                                      </option>
                                    ))}
                                </select>
                                <select
                                  value={addMemberRole}
                                  onChange={(e) => setAddMemberRole(e.target.value as TeamRosterRole)}
                                  className="min-h-[38px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-1.5 text-xs text-white"
                                >
                                  <option value="starter">{copy.teams.starter}</option>
                                  <option value="substitute">{copy.teams.substitute}</option>
                                </select>
                                <button
                                  type="button"
                                  disabled={!addMemberPlayerId || busyId === 'add-team-member'}
                                  onClick={async () => {
                                    setBusyId('add-team-member');
                                    const res = await clubLeagueClient.addTeamMember(
                                      selectedTeam.teamId,
                                      addMemberPlayerId,
                                      addMemberRole,
                                    );
                                    setBusyId(null);
                                    if (res.ok) {
                                      setAddMemberPlayerId('');
                                      setClubLeagueNotice({ type: 'ok', text: copy.notices.memberAdded });
                                    } else {
                                      setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                                    }
                                  }}
                                  className="min-h-[38px] rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                                >
                                  {copy.teams.addMember}
                                </button>
                              </div>
                            )}

                          {/* Roster Members */}
                          <div className="space-y-1.5">
                            {selectedTeam.roster.map((rm) => {
                              const canEditTeam =
                                canManageTeams || selectedTeam.captainId === ownProfile?.playerId;
                              return (
                                <div
                                  key={rm.playerId}
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs"
                                >
                                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                                    <span className="font-bold text-white">{rm.displayName}</span>
                                    <span className="text-[10px] font-extrabold uppercase text-amber-300">
                                      {rm.role === 'captain'
                                        ? copy.teams.captainLabel
                                        : rm.role === 'substitute'
                                          ? copy.teams.substitute
                                          : copy.teams.starter}
                                    </span>
                                    <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                                      {formatNumber(rm.elo)} {t('common.elo')} ·{' '}
                                      <span dir="ltr">
                                        {rm.wins}{copy.notices.recordShortW}-{rm.losses}{copy.notices.recordShortL}
                                      </span>
                                    </span>
                                  </div>

                                  {canEditTeam && (
                                    <div className="flex items-center gap-1.5">
                                      {rm.role !== 'captain' && (
                                        <button
                                          type="button"
                                          disabled={busyId === `trole:${rm.playerId}`}
                                          onClick={async () => {
                                            setBusyId(`trole:${rm.playerId}`);
                                            await clubLeagueClient.setTeamMemberRole(
                                              selectedTeam.teamId,
                                              rm.playerId,
                                              'captain',
                                            );
                                            setBusyId(null);
                                          }}
                                          className="min-h-[34px] rounded-md border border-amber-400/35 bg-amber-500/12 px-2 py-1 text-[10px] font-bold text-amber-200 cursor-pointer"
                                        >
                                          {copy.teams.makeCaptain}
                                        </button>
                                      )}
                                      {rm.role !== 'captain' && (
                                        <button
                                          type="button"
                                          disabled={busyId === `trole:${rm.playerId}`}
                                          onClick={async () => {
                                            setBusyId(`trole:${rm.playerId}`);
                                            await clubLeagueClient.setTeamMemberRole(
                                              selectedTeam.teamId,
                                              rm.playerId,
                                              rm.role === 'starter' ? 'substitute' : 'starter',
                                            );
                                            setBusyId(null);
                                          }}
                                          className="min-h-[34px] rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[10px] font-bold text-slate-200 cursor-pointer"
                                        >
                                          {rm.role === 'starter' ? copy.teams.substitute : copy.teams.starter}
                                        </button>
                                      )}
                                      {rm.playerId !== selectedTeam.captainId && (
                                        <button
                                          type="button"
                                          disabled={busyId === `trm:${rm.playerId}`}
                                          onClick={async () => {
                                            setBusyId(`trm:${rm.playerId}`);
                                            const res = await clubLeagueClient.removeTeamMember(
                                              selectedTeam.teamId,
                                              rm.playerId,
                                            );
                                            setBusyId(null);
                                            if (!res.ok) {
                                              setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                                            }
                                          }}
                                          className="min-h-[34px] rounded-md border border-rose-500/35 bg-rose-500/12 px-2 py-1 text-[10px] font-bold text-rose-200 cursor-pointer"
                                        >
                                          {copy.teams.removeMember}
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
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ================= TAB 3: TEAM LEAGUES ================= */}
          {clubLeagueTab === 'leagues' && (
            <div className="space-y-4">
              {/* Filter + Create Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={leagueScopeFilter}
                    onChange={(e) => setLeagueScopeFilter(e.target.value as LeagueScope | 'all')}
                    className="min-h-[40px] rounded-lg border border-white/15 bg-[#0f1620] px-2.5 py-1.5 text-xs text-white"
                  >
                    <option value="all">{copy.leagues.scopeAll}</option>
                    <option value="regional">{copy.leagues.regional}</option>
                    <option value="national">{copy.leagues.national}</option>
                    <option value="international">{copy.leagues.international}</option>
                  </select>
                  <select
                    value={leagueRegionFilter}
                    onChange={(e) => setLeagueRegionFilter(e.target.value)}
                    className="min-h-[40px] rounded-lg border border-white/15 bg-[#0f1620] px-2.5 py-1.5 text-xs text-white"
                  >
                    <option value="ALL">{copy.rankings.allRegions}</option>
                    {COMPETITION_REGIONS.map((r) => (
                      <option key={r.id} value={r.id}>
                        {localizeClubRegion(r.id, language)}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="button"
                  onClick={() => setShowCreateLeague((v) => !v)}
                  className="min-h-[44px] inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="h-4 w-4" />
                  {copy.leagues.createLeague}
                </button>
              </div>

              {showCreateLeague && (
                <form
                  onSubmit={handleCreateLeague}
                  className="rounded-xl border border-amber-400/35 bg-[#0f1620] p-4 space-y-3"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <input
                      type="text"
                      required
                      minLength={3}
                      maxLength={60}
                      value={leagueTitle}
                      onChange={(e) => setLeagueTitle(e.target.value)}
                      placeholder={copy.leagues.leagueTitlePlaceholder}
                      className="sm:col-span-2 min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-3 py-2 text-xs text-white"
                    />
                    <select
                      value={leagueCadence}
                      onChange={(e) => setLeagueCadence(e.target.value as LeagueCadence)}
                      className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                    >
                      <option value="weekly">{copy.leagues.weekly}</option>
                      <option value="seasonal">{copy.leagues.seasonal}</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <select
                      value={leagueScope}
                      onChange={(e) => setLeagueScope(e.target.value as LeagueScope)}
                      className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                    >
                      <option value="regional">{copy.leagues.regional}</option>
                      <option value="national">{copy.leagues.national}</option>
                      <option value="international">{copy.leagues.international}</option>
                    </select>
                    <select
                      value={leagueRegion}
                      onChange={(e) => setLeagueRegion(e.target.value)}
                      className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                    >
                      {COMPETITION_REGIONS.map((r) => (
                        <option key={r.id} value={r.id}>
                          {localizeClubRegion(r.id, language)}
                        </option>
                      ))}
                    </select>
                    <select
                      value={leagueFormat}
                      onChange={(e) => setLeagueFormat(e.target.value as TeamMatchFormat)}
                      className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                    >
                      <option value="singles">{copy.formats.singles}</option>
                      <option value="doubles">{copy.formats.doubles}</option>
                      <option value="team_bo3">{copy.formats.team_bo3}</option>
                      <option value="team_bo5">{copy.formats.team_bo5}</option>
                    </select>
                    <select
                      value={leagueRule}
                      onChange={(e) => setLeagueRule(e.target.value as RuleProfileId)}
                      className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                    >
                      <option value="casual">{t('menu.ruleCasual')}</option>
                      <option value="wpa">{t('menu.ruleWpa')}</option>
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={leagueDoubleRr}
                          onChange={(e) => setLeagueDoubleRr(e.target.checked)}
                        />
                        {copy.leagues.doubleRoundRobinLabel}
                      </label>
                      <label className="inline-flex items-center gap-1">
                        {copy.leagues.maxTeamsLabel}:
                        <input
                          type="number"
                          min={2}
                          max={24}
                          value={leagueMaxTeams}
                          onChange={(e) => setLeagueMaxTeams(Math.max(2, Number.parseInt(e.target.value, 10) || 8))}
                          className="w-14 rounded border border-white/15 bg-[#0a0f16] px-1.5 py-1 text-xs text-white"
                        />
                      </label>
                      <label className="inline-flex items-center gap-1">
                        {copy.leagues.promoSlotsLabel}:
                        <input
                          type="number"
                          min={0}
                          max={6}
                          value={leaguePromoSlots}
                          onChange={(e) => setLeaguePromoSlots(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                          className="w-12 rounded border border-white/15 bg-[#0a0f16] px-1.5 py-1 text-xs text-white"
                        />
                      </label>
                      <label className="inline-flex items-center gap-1">
                        {copy.leagues.relegationSlotsLabel}:
                        <input
                          type="number"
                          min={0}
                          max={6}
                          value={leagueRelSlots}
                          onChange={(e) => setLeagueRelSlots(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                          className="w-12 rounded border border-white/15 bg-[#0a0f16] px-1.5 py-1 text-xs text-white"
                        />
                      </label>
                    </div>
                    <button
                      type="submit"
                      disabled={busyId === 'create-league' || !leagueTitle.trim()}
                      className="min-h-[40px] rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                    >
                      {copy.leagues.createLeague}
                    </button>
                  </div>
                </form>
              )}

              {/* Leagues Directory & Selected League View */}
              <div className="grid grid-cols-1 lg:grid-cols-[290px_1fr] gap-4">
                <div className="space-y-2">
                  {filteredLeagues.length === 0 ? (
                    <div className="rounded-xl border border-white/10 bg-[#0f1620] p-4 text-xs text-slate-400">
                      {copy.leagues.noLeagues}
                    </div>
                  ) : (
                    filteredLeagues.map((l) => {
                      const active = selectedLeagueId === l.leagueId;
                      return (
                        <button
                          key={l.leagueId}
                          type="button"
                          onClick={() => setSelectedLeagueId(l.leagueId)}
                          className={`w-full min-h-[60px] rounded-xl border p-3 text-start transition-colors cursor-pointer ${
                            active
                              ? 'border-amber-400 bg-amber-500/12'
                              : 'border-white/10 bg-[#0f1620] hover:bg-white/[0.06]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-extrabold text-white">{l.title}</span>
                            <span className={`text-[10px] font-bold uppercase ${getStatusTextClass(l.status)}`}>
                              {getLocalizedStatus(copy, l.status)}
                            </span>
                          </div>
                          <div className="mt-1 font-mono text-[10px] text-slate-400 tabular-nums">
                            {localizeClubRegion(l.region, language)} · {copy.formats[l.matchFormat]} ·{' '}
                            <span dir="ltr">
                              {formatNumber(l.registeredCount)}/{formatNumber(l.maxTeams)}
                            </span>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>

                {selectedLeagueDetail ? (
                  <div className="space-y-4">
                    {/* League Header + Actions */}
                    <div className="rounded-xl border border-white/12 bg-[#0f1620] p-4 space-y-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-base font-extrabold text-white">
                              {selectedLeagueDetail.league.title}
                            </h3>
                            <span className={`text-[11px] font-bold uppercase ${getStatusTextClass(selectedLeagueDetail.league.status)}`}>
                              {getLocalizedStatus(copy, selectedLeagueDetail.league.status)}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-slate-400">
                            {localizeClubRegion(selectedLeagueDetail.league.region, language)} ·{' '}
                            {copy.formats[selectedLeagueDetail.league.matchFormat]} ·{' '}
                            {selectedLeagueDetail.league.seasonLabel}
                          </div>
                        </div>

                        {selectedLeagueDetail.league.championTeamName && (
                          <div className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-extrabold text-amber-200">
                            <Trophy className="inline h-3.5 w-3.5 me-1 text-amber-400" />
                            {selectedLeagueDetail.league.championTeamName}
                          </div>
                        )}
                      </div>

                      {selectedLeagueDetail.league.status === 'registration_open' && (
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/10">
                          {clubTeams.length > 0 && (
                            <>
                              <select
                                value={leagueRegisterTeamId}
                                onChange={(e) => setLeagueRegisterTeamId(e.target.value)}
                                className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-1.5 text-xs text-white"
                              >
                                {clubTeams.map((tm) => (
                                  <option key={tm.teamId} value={tm.teamId}>
                                    [{tm.tag}] {tm.name}
                                  </option>
                                ))}
                              </select>
                              {selectedLeagueDetail.viewerTeamIds.includes(leagueRegisterTeamId) ? (
                                <button
                                  type="button"
                                  disabled={busyId === 'withdraw-league'}
                                  onClick={async () => {
                                    setBusyId('withdraw-league');
                                    const res = await clubLeagueClient.withdrawTeamFromLeague(
                                      selectedLeagueDetail.league.leagueId,
                                      leagueRegisterTeamId,
                                    );
                                    setBusyId(null);
                                    if (!res.ok) {
                                      setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                                    }
                                  }}
                                  className="min-h-[40px] rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-bold text-rose-200 cursor-pointer"
                                >
                                  {copy.notices.withdrawTeamBtn}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={!leagueRegisterTeamId || busyId === 'reg-league'}
                                  onClick={async () => {
                                    setBusyId('reg-league');
                                    const res = await clubLeagueClient.registerTeamForLeague(
                                      selectedLeagueDetail.league.leagueId,
                                      leagueRegisterTeamId,
                                    );
                                    setBusyId(null);
                                    if (res.ok) {
                                      setClubLeagueNotice({ type: 'ok', text: copy.notices.teamRegistered });
                                    } else {
                                      setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                                    }
                                  }}
                                  className="min-h-[40px] rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer whitespace-nowrap"
                                >
                                  {copy.leagues.registerTeam}
                                </button>
                              )}
                            </>
                          )}

                          {selectedLeagueDetail.canManage && (
                            <button
                              type="button"
                              disabled={
                                selectedLeagueDetail.standings.length < 2 || busyId === 'start-league'
                              }
                              onClick={async () => {
                                setBusyId('start-league');
                                const res = await clubLeagueClient.startLeague(
                                  selectedLeagueDetail.league.leagueId,
                                );
                                setBusyId(null);
                                if (res.ok) {
                                  setClubLeagueNotice({ type: 'ok', text: copy.notices.seasonStarted });
                                } else {
                                  setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                                }
                              }}
                              className="min-h-[40px] ms-auto rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                            >
                              {copy.leagues.startLeague}
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Standings Table */}
                    <div className="rounded-xl border border-white/12 bg-[#0f1620] p-3.5 space-y-2 overflow-x-auto">
                      <h4 className="text-xs font-extrabold uppercase tracking-wider text-amber-400">
                        {copy.leagues.standingsTitle}
                      </h4>
                      <table className="w-full text-start text-xs font-mono tabular-nums">
                        <thead>
                          <tr className="border-b border-white/10 text-[10px] text-slate-400">
                            <th className="py-1.5 pe-2">#</th>
                            <th className="py-1.5 pe-2 font-sans">{copy.championships.colTeam}</th>
                            <th className="py-1.5 px-1.5">{copy.leagues.played}</th>
                            <th className="py-1.5 px-1.5">{copy.leagues.won}</th>
                            <th className="py-1.5 px-1.5">{copy.leagues.drawn}</th>
                            <th className="py-1.5 px-1.5">{copy.leagues.lost}</th>
                            <th className="py-1.5 px-1.5">{copy.leagues.diff}</th>
                            <th className="py-1.5 ps-1.5 text-end">{copy.leagues.points}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedLeagueDetail.standings.map((row) => (
                            <tr key={row.teamId} className="border-b border-white/5">
                              <td
                                className={`py-2 pe-2 font-bold ${
                                  row.zone === 'champion' || row.zone === 'promotion'
                                    ? 'text-emerald-300'
                                    : row.zone === 'relegation'
                                      ? 'text-rose-300'
                                      : 'text-slate-300'
                                }`}
                              >
                                {formatNumber(row.rank)}
                              </td>
                              <td className="py-2 pe-2 font-sans">
                                <span className="font-bold text-white">
                                  <span dir="ltr">[{row.teamTag}]</span> {row.teamName}
                                </span>
                                {row.outcomeTag && (
                                  <span
                                    className={`ms-2 text-[10px] font-bold uppercase ${
                                      row.outcomeTag === 'promoted'
                                        ? 'text-emerald-300'
                                        : row.outcomeTag === 'relegated'
                                          ? 'text-rose-300'
                                          : 'text-slate-400'
                                    }`}
                                  >
                                    ·{' '}
                                    {row.outcomeTag === 'promoted'
                                      ? copy.leagues.promotedBadge
                                      : row.outcomeTag === 'relegated'
                                        ? copy.leagues.relegatedBadge
                                        : copy.leagues.stayedBadge}
                                  </span>
                                )}
                              </td>
                              <td className="py-2 px-1.5">{formatNumber(row.played)}</td>
                              <td className="py-2 px-1.5 text-emerald-300">{formatNumber(row.won)}</td>
                              <td className="py-2 px-1.5 text-slate-400">{formatNumber(row.drawn)}</td>
                              <td className="py-2 px-1.5 text-rose-300">{formatNumber(row.lost)}</td>
                              <td dir="ltr" className="py-2 px-1.5">
                                {row.frameDiff >= 0 ? `+${row.frameDiff}` : row.frameDiff}
                              </td>
                              <td className="py-2 ps-1.5 text-end font-black text-amber-300">
                                {formatNumber(row.points)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* League Fixtures */}
                    <div className="space-y-2.5">
                      <h4 className="text-xs font-extrabold uppercase tracking-wider text-amber-400">
                        {copy.leagues.fixturesTitle} ({formatNumber(selectedLeagueDetail.fixtures.length)})
                      </h4>
                      {selectedLeagueDetail.fixtures.map((f: TeamLeagueFixtureRecord) => (
                        <EncounterCard
                          key={f.fixtureId}
                          competitionKind="league"
                          competitionId={selectedLeagueDetail.league.leagueId}
                          encounterId={f.fixtureId}
                          headerLabel={t('clubLeagues.leagues.roundLegHeader', {
                            round: f.roundNumber,
                            leg: f.legNumber,
                          })}
                          homeTeamId={f.homeTeamId}
                          homeTeamName={f.homeTeamName}
                          homeTeamTag={f.homeTeamTag}
                          awayTeamId={f.awayTeamId}
                          awayTeamName={f.awayTeamName}
                          awayTeamTag={f.awayTeamTag}
                          homeScore={f.homeScore}
                          awayScore={f.awayScore}
                          status={f.status}
                          winnerTeamId={f.winnerTeamId}
                          matchFormat={selectedLeagueDetail.league.matchFormat}
                          subMatches={f.subMatches}
                          viewerPlayerId={ownProfile?.playerId ?? null}
                          viewerTeamIds={selectedLeagueDetail.viewerTeamIds}
                          clubTeams={clubTeams}
                          canManage={selectedLeagueDetail.canManage}
                          copy={copy}
                          onNotice={setClubLeagueNotice}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-white/10 bg-[#0f1620] p-6 text-center text-xs text-slate-400">
                    {copy.leagues.selectLeaguePrompt}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ================= TAB 4: CLUB CHAMPIONSHIPS ================= */}
          {clubLeagueTab === 'championships' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={champFormatFilter}
                    onChange={(e) =>
                      setChampFormatFilter(e.target.value as ClubChampionshipFormat | 'all')
                    }
                    className="min-h-[40px] rounded-lg border border-white/15 bg-[#0f1620] px-2.5 py-1.5 text-xs text-white"
                  >
                    <option value="all">{copy.notices.allFormatsFilter}</option>
                    <option value="single_elimination">{copy.championships.single_elimination}</option>
                    <option value="double_elimination">{copy.championships.double_elimination}</option>
                    <option value="group_knockout">{copy.championships.group_knockout}</option>
                    <option value="swiss">{copy.championships.swiss}</option>
                  </select>
                  <select
                    value={champRegionFilter}
                    onChange={(e) => setChampRegionFilter(e.target.value)}
                    className="min-h-[40px] rounded-lg border border-white/15 bg-[#0f1620] px-2.5 py-1.5 text-xs text-white"
                  >
                    <option value="ALL">{copy.rankings.allRegions}</option>
                    {COMPETITION_REGIONS.map((r) => (
                      <option key={r.id} value={r.id}>
                        {localizeClubRegion(r.id, language)}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="button"
                  onClick={() => setShowCreateChamp((v) => !v)}
                  className="min-h-[44px] inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="h-4 w-4" />
                  {copy.championships.createChampionship}
                </button>
              </div>

              {showCreateChamp && (
                <form
                  onSubmit={handleCreateChampionship}
                  className="rounded-xl border border-amber-400/35 bg-[#0f1620] p-4 space-y-3"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <input
                      type="text"
                      required
                      minLength={3}
                      maxLength={60}
                      value={champTitle}
                      onChange={(e) => setChampTitle(e.target.value)}
                      placeholder={copy.championships.championshipTitlePlaceholder}
                      className="sm:col-span-2 min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-3 py-2 text-xs text-white"
                    />
                    <select
                      value={champFormat}
                      onChange={(e) => setChampFormat(e.target.value as ClubChampionshipFormat)}
                      className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                    >
                      <option value="single_elimination">{copy.championships.single_elimination}</option>
                      <option value="double_elimination">{copy.championships.double_elimination}</option>
                      <option value="group_knockout">{copy.championships.group_knockout}</option>
                      <option value="swiss">{copy.championships.swiss}</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <select
                      value={champRegion}
                      onChange={(e) => setChampRegion(e.target.value)}
                      className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                    >
                      {COMPETITION_REGIONS.map((r) => (
                        <option key={r.id} value={r.id}>
                          {localizeClubRegion(r.id, language)}
                        </option>
                      ))}
                    </select>
                    <select
                      value={champMatchFormat}
                      onChange={(e) => setChampMatchFormat(e.target.value as TeamMatchFormat)}
                      className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                    >
                      <option value="singles">{copy.formats.singles}</option>
                      <option value="doubles">{copy.formats.doubles}</option>
                      <option value="team_bo3">{copy.formats.team_bo3}</option>
                      <option value="team_bo5">{copy.formats.team_bo5}</option>
                    </select>
                    <select
                      value={champRule}
                      onChange={(e) => setChampRule(e.target.value as RuleProfileId)}
                      className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                    >
                      <option value="casual">{t('menu.ruleCasual')}</option>
                      <option value="wpa">{t('menu.ruleWpa')}</option>
                    </select>
                    <input
                      type="number"
                      min={0}
                      max={25000}
                      step={100}
                      value={champPrizeCoins}
                      onChange={(e) => setChampPrizeCoins(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                      placeholder={t('tournaments.adminFirstPrizeLabel')}
                      className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-2 text-xs text-white"
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="inline-flex items-center gap-1">
                        {copy.leagues.maxTeamsLabel}:
                        <input
                          type="number"
                          min={2}
                          max={32}
                          value={champMaxTeams}
                          onChange={(e) => setChampMaxTeams(Math.max(2, Number.parseInt(e.target.value, 10) || 8))}
                          className="w-14 rounded border border-white/15 bg-[#0a0f16] px-1.5 py-1 text-white"
                        />
                      </label>
                      {champFormat === 'swiss' && (
                        <label className="inline-flex items-center gap-1">
                          {copy.championships.swissRoundsLabel}:
                          <input
                            type="number"
                            min={2}
                            max={7}
                            value={champSwissRounds}
                            onChange={(e) =>
                              setChampSwissRounds(Math.max(2, Number.parseInt(e.target.value, 10) || 3))
                            }
                            className="w-14 rounded border border-white/15 bg-[#0a0f16] px-1.5 py-1 text-white"
                          />
                        </label>
                      )}
                      {champFormat === 'group_knockout' && (
                        <>
                          <label className="inline-flex items-center gap-1">
                            {copy.championships.groupSizeLabel}:
                            <input
                              type="number"
                              min={3}
                              max={8}
                              value={champGroupSize}
                              onChange={(e) =>
                                setChampGroupSize(Math.max(3, Number.parseInt(e.target.value, 10) || 4))
                              }
                              className="w-12 rounded border border-white/15 bg-[#0a0f16] px-1.5 py-1 text-white"
                            />
                          </label>
                          <label className="inline-flex items-center gap-1">
                            {copy.championships.groupAdvanceLabel}:
                            <input
                              type="number"
                              min={1}
                              max={4}
                              value={champAdvanceCount}
                              onChange={(e) =>
                                setChampAdvanceCount(Math.max(1, Number.parseInt(e.target.value, 10) || 2))
                              }
                              className="w-12 rounded border border-white/15 bg-[#0a0f16] px-1.5 py-1 text-white"
                            />
                          </label>
                        </>
                      )}
                    </div>
                    <button
                      type="submit"
                      disabled={busyId === 'create-champ' || !champTitle.trim()}
                      className="min-h-[40px] rounded-lg bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-400 cursor-pointer"
                    >
                      {copy.championships.createChampionship}
                    </button>
                  </div>
                </form>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-[290px_1fr] gap-4">
                <div className="space-y-2">
                  {filteredChampionships.length === 0 ? (
                    <div className="rounded-xl border border-white/10 bg-[#0f1620] p-4 text-xs text-slate-400">
                      {copy.championships.noChampionships}
                    </div>
                  ) : (
                    filteredChampionships.map((c) => {
                      const active = selectedChampionshipId === c.championshipId;
                      return (
                        <button
                          key={c.championshipId}
                          type="button"
                          onClick={() => setSelectedChampionshipId(c.championshipId)}
                          className={`w-full min-h-[60px] rounded-xl border p-3 text-start transition-colors cursor-pointer ${
                            active
                              ? 'border-amber-400 bg-amber-500/12'
                              : 'border-white/10 bg-[#0f1620] hover:bg-white/[0.06]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-extrabold text-white">{c.title}</span>
                            <span className={`text-[10px] font-bold uppercase ${getStatusTextClass(c.status)}`}>
                              {getLocalizedStatus(copy, c.status)}
                            </span>
                          </div>
                          <div className="mt-1 font-mono text-[10px] text-slate-400 tabular-nums">
                            {copy.championships[c.format]} ·{' '}
                            <span dir="ltr">
                              {formatNumber(c.registeredCount)}/{formatNumber(c.maxTeams)}
                            </span>{' '}
                            · {t('clubLeagues.notices.prizeCoinsUpper', { amount: formatNumber(c.prizeCoinsChampion) })}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>

                {selectedChampionshipDetail ? (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-white/12 bg-[#0f1620] p-4 space-y-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-base font-extrabold text-white">
                              {selectedChampionshipDetail.championship.title}
                            </h3>
                            <span
                              className={`text-[11px] font-bold uppercase ${getStatusTextClass(
                                selectedChampionshipDetail.championship.status,
                              )}`}
                            >
                              {getLocalizedStatus(copy, selectedChampionshipDetail.championship.status)}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-slate-400">
                            {copy.championships[selectedChampionshipDetail.championship.format]} ·{' '}
                            {copy.formats[selectedChampionshipDetail.championship.matchFormat]} ·{' '}
                            {localizeClubRegion(selectedChampionshipDetail.championship.region, language)} ·{' '}
                            <Coins className="inline h-3 w-3 text-amber-400" />{' '}
                            {formatNumber(selectedChampionshipDetail.championship.prizeCoinsChampion)}
                          </div>
                        </div>

                        {selectedChampionshipDetail.championship.championTeamName && (
                          <div className="rounded-lg border border-amber-400/45 bg-amber-500/15 px-3 py-1.5 text-xs font-extrabold text-amber-200">
                            <Crown className="inline h-3.5 w-3.5 me-1 text-amber-400" />
                            {copy.championships.championBanner}:{' '}
                            {selectedChampionshipDetail.championship.championTeamName}
                          </div>
                        )}
                      </div>

                      {selectedChampionshipDetail.championship.status === 'registration_open' && (
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/10">
                          {clubTeams.length > 0 && (
                            <>
                              <select
                                value={champRegisterTeamId}
                                onChange={(e) => setChampRegisterTeamId(e.target.value)}
                                className="min-h-[40px] rounded-lg border border-white/15 bg-[#0a0f16] px-2.5 py-1.5 text-xs text-white"
                              >
                                {clubTeams.map((tm) => (
                                  <option key={tm.teamId} value={tm.teamId}>
                                    [{tm.tag}] {tm.name}
                                  </option>
                                ))}
                              </select>
                              {selectedChampionshipDetail.viewerTeamIds.includes(champRegisterTeamId) ? (
                                <button
                                  type="button"
                                  disabled={busyId === 'withdraw-champ'}
                                  onClick={async () => {
                                    setBusyId('withdraw-champ');
                                    const res = await clubLeagueClient.withdrawTeamFromChampionship(
                                      selectedChampionshipDetail.championship.championshipId,
                                      champRegisterTeamId,
                                    );
                                    setBusyId(null);
                                    if (!res.ok) {
                                      setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                                    }
                                  }}
                                  className="min-h-[40px] rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-bold text-rose-200 cursor-pointer"
                                >
                                  {copy.notices.withdrawTeamBtn}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={!champRegisterTeamId || busyId === 'reg-champ'}
                                  onClick={async () => {
                                    setBusyId('reg-champ');
                                    const res = await clubLeagueClient.registerTeamForChampionship(
                                      selectedChampionshipDetail.championship.championshipId,
                                      champRegisterTeamId,
                                    );
                                    setBusyId(null);
                                    if (res.ok) {
                                      setClubLeagueNotice({
                                        type: 'ok',
                                        text: copy.notices.teamRegistered,
                                      });
                                    } else {
                                      setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                                    }
                                  }}
                                  className="min-h-[40px] rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-emerald-400 cursor-pointer whitespace-nowrap"
                                >
                                  {copy.championships.registerTeam}
                                </button>
                              )}
                            </>
                          )}

                          {selectedChampionshipDetail.canManage && (
                            <button
                              type="button"
                              disabled={
                                selectedChampionshipDetail.entries.length < 2 ||
                                busyId === 'start-champ'
                              }
                              onClick={async () => {
                                setBusyId('start-champ');
                                const res = await clubLeagueClient.startChampionship(
                                  selectedChampionshipDetail.championship.championshipId,
                                );
                                setBusyId(null);
                                if (res.ok) {
                                  setClubLeagueNotice({ type: 'ok', text: copy.notices.championshipStarted });
                                } else {
                                  setClubLeagueNotice({ type: 'err', text: localizeServerError(res.error, language) });
                                }
                              }}
                              className="min-h-[40px] ms-auto rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                            >
                              {copy.championships.startChampionship}
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Seeded Entries / Group / Swiss Table */}
                    {selectedChampionshipDetail.entries.length > 0 && (
                      <div className="rounded-xl border border-white/12 bg-[#0f1620] p-3.5 space-y-2 overflow-x-auto">
                        <h4 className="text-xs font-extrabold uppercase tracking-wider text-amber-400">
                          {selectedChampionshipDetail.championship.format === 'swiss'
                            ? copy.championships.swissTitle
                            : selectedChampionshipDetail.championship.format === 'group_knockout'
                              ? copy.championships.groupsTitle
                              : copy.championships.seededTeamsTitle}{' '}
                          ({formatNumber(selectedChampionshipDetail.entries.length)})
                        </h4>
                        <table className="w-full text-start text-xs font-mono tabular-nums">
                          <thead>
                            <tr className="border-b border-white/10 text-[10px] text-slate-400">
                              <th className="py-1.5 pe-2">{copy.championships.colSeed}</th>
                              <th className="py-1.5 pe-2 font-sans">{copy.championships.colTeam}</th>
                              <th className="py-1.5 px-1.5">{copy.championships.colWL}</th>
                              <th className="py-1.5 px-1.5">{copy.championships.colPts}</th>
                              <th className="py-1.5 px-1.5">{copy.championships.colBh}</th>
                              <th className="py-1.5 ps-1.5 text-end">{copy.championships.colDiff}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedChampionshipDetail.entries.map((entry) => (
                              <tr key={entry.teamId} className="border-b border-white/5">
                                <td dir="ltr" className="py-1.5 pe-2 text-amber-300 font-bold">
                                  {entry.seed ? `#${entry.seed}` : '—'}
                                  {entry.groupIndex !== null ? ` · G${entry.groupIndex + 1}` : ''}
                                </td>
                                <td className="py-1.5 pe-2 font-sans">
                                  <span className="font-bold text-white">
                                    <span dir="ltr">[{entry.teamTag}]</span> {entry.teamName}
                                  </span>
                                  {entry.disqualified && (
                                    <span className="ms-2 text-[10px] font-bold text-rose-400">
                                      {copy.championships.dqBadge}
                                    </span>
                                  )}
                                </td>
                                <td dir="ltr" className="py-1.5 px-1.5">
                                  {entry.wins}-{entry.losses}
                                </td>
                                <td className="py-1.5 px-1.5 font-bold text-amber-300">{formatNumber(entry.points)}</td>
                                <td className="py-1.5 px-1.5 text-slate-400">{formatNumber(entry.buchholz)}</td>
                                <td dir="ltr" className="py-1.5 ps-1.5 text-end">
                                  {entry.frameDiff >= 0 ? `+${entry.frameDiff}` : entry.frameDiff}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Championship Matches */}
                    <div className="space-y-2.5">
                      <h4 className="text-xs font-extrabold uppercase tracking-wider text-amber-400">
                        {copy.championships.bracketTitle} ({formatNumber(selectedChampionshipDetail.matches.length)})
                      </h4>
                      {selectedChampionshipDetail.matches.map((m: ClubChampionshipMatchRecord) => {
                        const stageLabel =
                          m.stageType === 'group'
                            ? copy.championships.stageGroups
                            : m.stageType === 'knockout' ||
                                m.stageType === 'winners' ||
                                m.stageType === 'losers' ||
                                m.stageType === 'grand_final'
                              ? copy.championships.stageKnockout
                              : m.stageType === 'swiss'
                                ? copy.championships.stageSwiss
                                : String(m.stageType).replace(/_/g, ' ');
                        return (
                          <EncounterCard
                            key={m.matchNodeId}
                            competitionKind="club_championship"
                            competitionId={selectedChampionshipDetail.championship.championshipId}
                            encounterId={m.matchNodeId}
                            headerLabel={`${localizeTournamentRoundLabel(m.roundLabel, language)} · ${stageLabel}`}
                            homeTeamId={m.homeTeamId}
                            homeTeamName={m.homeTeamName}
                            homeTeamTag={m.homeTeamTag}
                            homeSeed={m.homeSeed}
                            awayTeamId={m.awayTeamId}
                            awayTeamName={m.awayTeamName}
                            awayTeamTag={m.awayTeamTag}
                            awaySeed={m.awaySeed}
                            homeScore={m.homeScore}
                            awayScore={m.awayScore}
                            status={m.status}
                            winnerTeamId={m.winnerTeamId}
                            matchFormat={selectedChampionshipDetail.championship.matchFormat}
                            subMatches={m.subMatches}
                            viewerPlayerId={ownProfile?.playerId ?? null}
                            viewerTeamIds={selectedChampionshipDetail.viewerTeamIds}
                            clubTeams={clubTeams}
                            canManage={selectedChampionshipDetail.canManage}
                            copy={copy}
                            onNotice={setClubLeagueNotice}
                          />
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-white/10 bg-[#0f1620] p-6 text-center text-xs text-slate-400">
                    {copy.championships.selectChampionshipPrompt}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ================= TAB 5: RANKINGS & HONORS ================= */}
          {clubLeagueTab === 'rankings' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      { id: 'teams', label: copy.rankings.teamEloRankings },
                      { id: 'clubs', label: copy.rankings.clubRankings },
                      { id: 'trophies', label: copy.rankings.trophyShowcase },
                    ] as const
                  ).map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => setRankingsSubTab(sub.id)}
                      className={`min-h-[40px] rounded-lg border px-3 py-1.5 text-xs font-bold cursor-pointer whitespace-nowrap ${
                        rankingsSubTab === sub.id
                          ? 'border-amber-400 bg-amber-500 text-slate-950'
                          : 'border-white/10 bg-[#0f1620] text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      {sub.label}
                    </button>
                  ))}
                </div>

                {rankingsSubTab === 'teams' && (
                  <select
                    value={rankingsRegionFilter}
                    onChange={(e) => {
                      setRankingsRegionFilter(e.target.value);
                      void clubLeagueClient.fetchRankings(e.target.value, 30);
                    }}
                    className="min-h-[40px] rounded-lg border border-white/15 bg-[#0f1620] px-3 py-1.5 text-xs text-white"
                  >
                    <option value="ALL">{copy.rankings.allRegions}</option>
                    {COMPETITION_REGIONS.map((r) => (
                      <option key={r.id} value={r.id}>
                        {localizeClubRegion(r.id, language)}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {rankingsSubTab === 'teams' && (
                <div className="rounded-xl border border-white/12 bg-[#0f1620] p-3.5 overflow-x-auto">
                  <table className="w-full text-start text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="border-b border-white/10 text-[10px] text-slate-400">
                        <th className="py-2 pe-2">{copy.rankings.rank}</th>
                        <th className="py-2 pe-2 font-sans">{copy.championships.colTeam}</th>
                        <th className="py-2 px-2">{copy.rankings.colRegion}</th>
                        <th className="py-2 px-2">{copy.rankings.record}</th>
                        <th className="py-2 px-2">{copy.rankings.titles}</th>
                        <th className="py-2 ps-2 text-end">{copy.rankings.rating}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(teamEloRankings?.teams ?? []).map((team) => (
                        <tr key={team.teamId} className="border-b border-white/5">
                          <td dir="ltr" className="py-2 pe-2 font-black text-amber-300">
                            #{team.rank}
                          </td>
                          <td className="py-2 pe-2 font-sans">
                            <span className="font-extrabold text-white">
                              <span dir="ltr">[{team.tag}]</span> {team.name}
                            </span>
                            <span className="ms-2 text-[10px] text-slate-400">
                              · <span dir="ltr">[{team.clubTag}]</span>
                            </span>
                          </td>
                          <td className="py-2 px-2 text-slate-400">
                            {localizeClubRegion(team.region, language)}
                          </td>
                          <td dir="ltr" className="py-2 px-2">
                            {team.wins}-{team.losses}-{team.draws}
                          </td>
                          <td className="py-2 px-2 text-amber-300">{formatNumber(team.titlesCount)}</td>
                          <td className="py-2 ps-2 text-end font-black text-emerald-300">
                            {formatNumber(team.elo)}
                          </td>
                        </tr>
                      ))}
                      {(teamEloRankings?.teams ?? []).length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-6 text-center font-sans text-slate-400">
                            {copy.rankings.noRankedTeams}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {rankingsSubTab === 'clubs' && (
                <div className="rounded-xl border border-white/12 bg-[#0f1620] p-3.5 overflow-x-auto">
                  <table className="w-full text-start text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="border-b border-white/10 text-[10px] text-slate-400">
                        <th className="py-2 pe-2">{copy.rankings.rank}</th>
                        <th className="py-2 pe-2 font-sans">{copy.rankings.clubRankings}</th>
                        <th className="py-2 px-2">{copy.rankings.colMembers}</th>
                        <th className="py-2 px-2">{copy.rankings.colWins}</th>
                        <th className="py-2 ps-2 text-end">{copy.rankings.rating}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clubLeaderboard.map((c) => (
                        <tr key={c.clubId} className="border-b border-white/5">
                          <td dir="ltr" className="py-2 pe-2 font-black text-amber-300">
                            #{c.rank}
                          </td>
                          <td className="py-2 pe-2 font-sans font-bold text-white">
                            <span dir="ltr">[{c.tag}]</span> {c.name}
                          </td>
                          <td className="py-2 px-2 text-slate-300">{formatNumber(c.memberCount)}</td>
                          <td className="py-2 px-2 text-emerald-300">{formatNumber(c.totalWins)}</td>
                          <td className="py-2 ps-2 text-end font-black text-amber-300">
                            {formatNumber(c.clubRating)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {rankingsSubTab === 'trophies' && (
                <div className="rounded-xl border border-white/12 bg-[#0f1620] p-3.5 space-y-2">
                  {(teamEloRankings?.trophies ?? []).length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-400">
                      <Globe className="mx-auto mb-2 h-5 w-5 text-slate-500" />
                      {copy.club.noTrophies}
                    </div>
                  ) : (
                    (teamEloRankings?.trophies ?? []).map((tr) => (
                      <div
                        key={tr.trophyId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs"
                      >
                        <div>
                          <span className="font-extrabold text-amber-300">{tr.title}</span>
                          <span className="ms-2 text-slate-300">
                            · {tr.teamName ?? tr.clubId} · {tr.seasonLabel}
                          </span>
                        </div>
                        <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                          {formatShortTime(tr.awardedAtMs, language)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
