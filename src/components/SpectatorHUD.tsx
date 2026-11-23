import {
  Camera,
  ChevronDown,
  ChevronUp,
  Crown,
  Eye,
  Film,
  LogOut,
  Maximize2,
  Minimize2,
  RotateCcw,
  Trophy,
  Users,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  canTargetEightBall,
  getRemainingBallsForGroup,
  SOLIDS_NUMBERS,
  STRIPES_NUMBERS,
} from '../game/rules/BallGroupManager';
import type { BallGroup, PlayerId } from '../game/rules/types';
import { BALL_DEFINITIONS } from '../game/utils/constants';
import { soundEngine } from '../game/utils/SoundEngine';
import {
  localizeBallName,
  localizeFoulOrReason,
  localizeMatchHeadline,
  localizePlayerName,
  localizeRuleProfile,
  localizeServerError,
  localizeTournamentRoundLabel,
  useTranslation,
} from '../i18n';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { getAvatarVisualMeta, getNameplateVisualClass } from '../multiplayer/shared/economy';
import type { SpectatorCameraMode } from '../multiplayer/shared/protocol';
import { useGameStore } from '../store/useGameStore';
import { FpsCounter } from './FpsCounter';
import { RankBadge } from './RankBadge';

interface SpectatorHUDProps {
  onToggleFullscreen: () => void;
  onEnterReplay: (shotId?: string) => void;
}

const SPECTATOR_CAMERAS: Array<{ id: SpectatorCameraMode; labelKey: string }> = [
  { id: 'overview', labelKey: 'spectator.cameraOverview' },
  { id: 'topDown', labelKey: 'spectator.cameraTopDown' },
  { id: 'ballFollow', labelKey: 'spectator.cameraBallFollow' },
  { id: 'activeShot', labelKey: 'spectator.cameraActiveShot' },
  { id: 'cinematic', labelKey: 'spectator.cameraCinematic' },
  { id: 'free', labelKey: 'spectator.cameraFree' },
];

function SpectatorBallPill({ num, pocketed }: { num: number; pocketed: boolean }) {
  const { lang } = useTranslation();
  const def = BALL_DEFINITIONS[num];
  if (!def) return null;
  const isEight = num === 8;
  return (
    <span
      title={localizeBallName(num, lang)}
      className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-extrabold transition-opacity ${
        pocketed ? 'opacity-20' : 'opacity-100'
      }`}
      style={{
        backgroundColor: isEight ? '#14151a' : def.isStripe ? '#f5f1e3' : def.color,
        color: isEight ? '#ffffff' : '#111318',
        border: isEight ? '1px solid #f59e0b' : '1px solid rgba(255,255,255,0.28)',
        boxShadow: def.isStripe ? `inset 0 0 0 2.5px ${def.color}` : undefined,
      }}
    >
      {num}
    </span>
  );
}

function BroadcastPlayerPanel({
  playerId,
  name,
  elo,
  avatarId,
  nameplateId,
  group,
  tableOpen,
  pocketedSet,
  isActive,
  align,
}: {
  playerId: PlayerId;
  name: string;
  elo?: number;
  avatarId?: string | null;
  nameplateId?: string | null;
  group: BallGroup;
  tableOpen: boolean;
  pocketedSet: Set<number>;
  isActive: boolean;
  align: 'left' | 'right';
}) {
  const { t, formatNumber } = useTranslation();
  const remaining = group ? getRemainingBallsForGroup(pocketedSet, group) : [];
  const onEight = group ? canTargetEightBall(pocketedSet, group) : false;
  const groupNumbers =
    group === 'solids' ? SOLIDS_NUMBERS : group === 'stripes' ? STRIPES_NUMBERS : null;
  const avatarMeta = getAvatarVisualMeta(avatarId ?? 'cue_gold');
  const nameplate = getNameplateVisualClass(nameplateId);

  return (
    <div
      data-testid={`spectator-player-${playerId}`}
      className={`flex flex-col gap-1 rounded-xl border px-3 py-1.5 min-w-[155px] sm:min-w-[210px] transition-colors ${
        isActive
          ? 'border-amber-400/80 bg-[#131d29]/95'
          : nameplateId && nameplateId !== 'nameplate_standard'
            ? `${nameplate.borderClass} ${nameplate.bgClass}`
            : 'border-white/12 bg-[#0c1219]/92'
      } ${align === 'right' ? 'items-end text-right' : 'items-start text-left'}`}
    >
      <div
        className={`flex w-full items-center justify-between gap-2 ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        <div
          className={`flex items-center gap-1.5 min-w-0 ${
            align === 'right' ? 'flex-row-reverse' : ''
          }`}
        >
          <span
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-white/15 text-[11px] font-bold"
            style={{ backgroundColor: `${avatarMeta.accent}22`, color: avatarMeta.accent }}
          >
            {avatarMeta.glyph}
          </span>
          <span className="truncate text-xs font-bold text-white max-w-[96px] sm:max-w-[128px]">
            {name}
          </span>
          {typeof elo === 'number' && <RankBadge elo={elo} size="xs" />}
        </div>
        {isActive && (
          <span className="rounded bg-amber-500/20 border border-amber-400/40 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-amber-300 whitespace-nowrap">
            {t('spectator.shootingBadge')}
          </span>
        )}
      </div>

      <div
        className={`flex items-center gap-1 ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        {groupNumbers ? (
          <>
            {groupNumbers.map((num) => (
              <SpectatorBallPill key={num} num={num} pocketed={pocketedSet.has(num)} />
            ))}
            {onEight && !pocketedSet.has(8) && (
              <span className="ml-0.5 flex items-center border-l border-white/15 pl-1">
                <SpectatorBallPill num={8} pocketed={false} />
              </span>
            )}
          </>
        ) : (
          <span className="text-[10px] font-mono text-slate-400">
            {tableOpen ? t('hud.openTableBadge') : t('spectator.awaitingGroup')}
          </span>
        )}
      </div>

      <div
        className={`flex w-full items-center justify-between gap-2 text-[10px] font-mono tabular-nums text-slate-300 ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        <span>
          {group === 'solids'
            ? t('hud.solidsTag')
            : group === 'stripes'
              ? t('hud.stripesTag')
              : t('hud.unassignedLabel')}
        </span>
        <span className="text-slate-400" dir="ltr">
          {group
            ? onEight
              ? t('hud.eightBallReadyLabel')
              : t('hud.remainingLabel', { count: formatNumber(remaining.length) })
            : typeof elo === 'number'
              ? t('spectator.eloBadge', { elo })
              : t('spectator.liveStatus')}
        </span>
      </div>
    </div>
  );
}

export function SpectatorHUD({ onToggleFullscreen, onEnterReplay }: SpectatorHUDProps) {
  const { t, lang } = useTranslation();
  const onlineRoom = useGameStore((s) => s.onlineRoom);
  const matchConfig = useGameStore((s) => s.matchConfig);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const activePlayer = useGameStore((s) => s.activePlayer);
  const tableOpen = useGameStore((s) => s.tableOpen);
  const playerGroups = useGameStore((s) => s.playerGroups);
  const pocketedNumbers = useGameStore((s) => s.pocketedNumbers);
  const statusHeadline = useGameStore((s) => s.statusHeadline);
  const lastFoulMessage = useGameStore((s) => s.lastFoulMessage);
  const shotCount = useGameStore((s) => s.shotCount);
  const onlineConnectionStatus = useGameStore((s) => s.onlineConnectionStatus);
  const onlineLatencyMs = useGameStore((s) => s.onlineLatencyMs);
  const onlineError = useGameStore((s) => s.onlineError);
  const spectatorCameraMode = useGameStore((s) => s.spectatorCameraMode);
  const spectatorZoomOffset = useGameStore((s) => s.spectatorZoomOffset);
  const spectateReturnTarget = useGameStore((s) => s.spectateReturnTarget);
  const setSpectatorCameraMode = useGameStore((s) => s.setSpectatorCameraMode);
  const adjustSpectatorZoom = useGameStore((s) => s.adjustSpectatorZoom);
  const resetSpectatorZoom = useGameStore((s) => s.resetSpectatorZoom);
  const hudCollapsed = useGameStore((s) => s.hudCollapsed);
  const toggleHudCollapsed = useGameStore((s) => s.toggleHudCollapsed);
  const soundEnabled = useGameStore((s) => s.soundEnabled);
  const toggleSound = useGameStore((s) => s.toggleSound);
  const isFullscreen = useGameStore((s) => s.isFullscreen);
  const replayShots = useGameStore((s) => s.replayShots);
  const ballsMoving = useGameStore((s) => s.ballsMoving);
  const isShotAnimating = useGameStore((s) => s.isShotAnimating);

  const pocketedSet = new Set(pocketedNumbers);
  const p1Rec = onlineRoom?.players.find((p) => p.role === 'player1') ?? onlineRoom?.players[0];
  const p2Rec = onlineRoom?.players.find((p) => p.role === 'player2') ?? onlineRoom?.players[1];
  const p1Name = localizePlayerName(p1Rec?.displayName ?? matchConfig.player1Name, 'player1', lang);
  const p2Name = localizePlayerName(p2Rec?.displayName ?? matchConfig.player2Name, 'player2', lang);
  const viewerCount = Math.max(
    1,
    onlineRoom?.spectators?.length ?? onlineRoom?.spectatorCount ?? 1,
  );
  const zoomPct = Math.round((1 - spectatorZoomOffset) * 100);
  const localizedFoul = localizeFoulOrReason(lastFoulMessage, lang);
  const localizedHeadline = localizeMatchHeadline(statusHeadline, lang);
  const ruleLabel = localizeRuleProfile(
    matchConfig.calledShotsEnabled ? 'wpa' : 'casual',
    lang,
    true,
  );

  return (
    <div
      data-testid="spectator-hud"
      className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-2.5 sm:p-4"
    >
      {/* Top Broadcast Row */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        {/* Left Navigation & Broadcast Tag */}
        <div className="pointer-events-auto flex flex-col items-start gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/12 bg-[#0c1219]/92 px-2.5 py-1.5 shadow-lg">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-emerald-300 whitespace-nowrap">
              <Eye className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              {t('spectator.modeBadge')}
            </span>
            <span className="text-slate-600" aria-hidden="true">·</span>
            <button
              type="button"
              data-testid="leave-spectator-btn"
              onClick={() => {
                soundEngine.playUiClick();
                multiplayerManager.leaveSpectatorMode();
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-rose-400/40 bg-rose-500/15 px-2.5 py-1 text-[11px] font-bold text-rose-200 hover:bg-rose-500/25 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <LogOut className="h-3 w-3 shrink-0" />
              {t('spectator.leaveSpectator')}
            </button>
            {spectateReturnTarget === 'tournament' && onlineRoom?.tournament && (
              <button
                type="button"
                data-testid="back-to-bracket-btn"
                onClick={() => {
                  soundEngine.playUiClick();
                  multiplayerManager.leaveSpectatorMode('tournament');
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-500/25 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Trophy className="h-3 w-3 shrink-0" />
                {t('spectator.returnToTournament')}
              </button>
            )}
          </div>

          {onlineRoom?.tournament && (
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-[#12161d]/92 px-2.5 py-1 text-[11px] font-bold text-amber-200">
              <Crown className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span className="truncate max-w-[200px]">{onlineRoom.tournament.tournamentTitle}</span>
              <span className="text-amber-500" aria-hidden="true">·</span>
              <span className="text-amber-300 shrink-0">
                {localizeTournamentRoundLabel(onlineRoom.tournament.roundLabel, lang)}
              </span>
            </div>
          )}

          {onlineError && (
            <div className="rounded-lg border border-rose-400/40 bg-[#1a1014]/95 px-2.5 py-1 text-[11px] font-semibold text-rose-200">
              {localizeServerError(onlineError, lang)}
            </div>
          )}
        </div>

        {/* Center Live Match Scoreboard */}
        <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
          <BroadcastPlayerPanel
            playerId="player1"
            name={p1Name}
            elo={p1Rec?.elo}
            avatarId={p1Rec?.avatarId}
            nameplateId={p1Rec?.equippedCosmetics?.nameplateId}
            group={playerGroups.player1}
            tableOpen={tableOpen}
            pocketedSet={pocketedSet}
            isActive={activePlayer === 'player1' && matchPhase !== 'GAME_OVER'}
            align="left"
          />

          <div className="hidden md:flex flex-col items-center justify-center rounded-xl border border-white/12 bg-[#0c1219]/92 px-3 py-1.5 text-center min-w-[168px]">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-amber-400 whitespace-nowrap">
              {onlineRoom?.matchType === 'tournament'
                ? t('spectator.tournamentLive')
                : onlineRoom?.matchType === 'ranked'
                  ? t('spectator.rankedBroadcast')
                  : t('spectator.liveMatch')}
            </div>
            <div className="mt-0.5 text-[11px] font-semibold text-white max-w-[190px] truncate">
              {localizedFoul || localizedHeadline || t('spectator.rackInProgress')}
            </div>
            <div className="text-[10px] font-mono tabular-nums text-slate-400">
              {t('spectator.shotRulesSummary', { shot: shotCount, rules: ruleLabel })}
            </div>
          </div>

          <BroadcastPlayerPanel
            playerId="player2"
            name={p2Name}
            elo={p2Rec?.elo}
            avatarId={p2Rec?.avatarId}
            nameplateId={p2Rec?.equippedCosmetics?.nameplateId}
            group={playerGroups.player2}
            tableOpen={tableOpen}
            pocketedSet={pocketedSet}
            isActive={activePlayer === 'player2' && matchPhase !== 'GAME_OVER'}
            align="right"
          />
        </div>

        {/* Top-Right Broadcast Telemetry & Utilities */}
        <div className="pointer-events-auto flex items-start gap-1.5">
          <div className="flex flex-col items-end gap-1">
            <div className="inline-flex h-8 items-center gap-2 rounded-lg border border-white/12 bg-[#0c1219]/92 px-2.5 text-[11px] font-mono tabular-nums text-slate-200 whitespace-nowrap">
              <Users className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <span data-testid="spectator-viewer-count">
                {t('spectator.watchingCount', { count: viewerCount })}
              </span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className={onlineConnectionStatus === 'connected' ? 'text-emerald-300' : 'text-amber-300'}>
                {onlineConnectionStatus === 'connected'
                  ? onlineLatencyMs !== null
                    ? t('lobby.latencyMs', { ms: onlineLatencyMs })
                    : t('spectator.liveStatus')
                  : t('spectator.syncingStatus')}
              </span>
            </div>

            {replayShots.length > 0 && !ballsMoving && !isShotAnimating && (
              <button
                type="button"
                data-testid="spectator-replay-btn"
                onClick={() => {
                  soundEngine.unlock();
                  soundEngine.playUiClick();
                  onEnterReplay();
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-400/40 bg-[#0c1219]/92 px-2.5 text-[11px] font-bold text-amber-300 hover:bg-amber-500/15 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Film className="h-3.5 w-3.5 text-amber-400" />
                <span>{t('spectator.replayCount', { count: replayShots.length })}</span>
              </button>
            )}
          </div>

          <div className="flex flex-col items-end gap-1.5">
            <FpsCounter />
            <button
              type="button"
              onClick={() => {
                soundEngine.unlock();
                toggleSound();
              }}
              title={soundEnabled ? t('hud.muteTooltip') : t('hud.unmuteTooltip')}
              aria-label={soundEnabled ? t('hud.muteAria') : t('hud.unmuteAria')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#0c1219]/92 text-slate-200 hover:bg-white/10 transition-colors cursor-pointer shrink-0"
            >
              {soundEnabled ? (
                <Volume2 className="h-4 w-4 text-amber-400" />
              ) : (
                <VolumeX className="h-4 w-4 text-slate-400" />
              )}
            </button>
            <button
              type="button"
              onClick={onToggleFullscreen}
              title={isFullscreen ? t('common.exitFullscreen') : t('common.enterFullscreen')}
              aria-label={isFullscreen ? t('common.exitFullscreen') : t('common.enterFullscreen')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#0c1219]/92 text-slate-200 hover:bg-white/10 transition-colors cursor-pointer shrink-0"
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Bottom Broadcast Camera & Zoom Bar */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={toggleHudCollapsed}
          className="pointer-events-auto mb-1.5 inline-flex items-center gap-1 rounded-lg border border-white/10 bg-[#0c1219]/92 px-3 py-1 text-[11px] font-medium text-slate-300 hover:text-white transition-colors cursor-pointer whitespace-nowrap"
        >
          {hudCollapsed ? (
            <>
              <ChevronUp className="h-3.5 w-3.5 text-amber-400" />
              {t('spectator.showBroadcastControls')}
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5 text-amber-400" />
              {t('spectator.hideBroadcastControls')}
            </>
          )}
        </button>

        {!hudCollapsed && (
          <div className="pointer-events-auto flex max-w-[96vw] flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/12 bg-[#0c1219]/94 px-3 py-2 shadow-2xl">
            <div className="flex flex-wrap items-center gap-1">
              <Camera className="h-3.5 w-3.5 text-amber-400 mr-1 hidden sm:block shrink-0" />
              {SPECTATOR_CAMERAS.map((cam) => {
                const active = spectatorCameraMode === cam.id;
                return (
                  <button
                    key={cam.id}
                    type="button"
                    data-testid={`spectator-cam-${cam.id}`}
                    onClick={() => {
                      soundEngine.playUiClick();
                      setSpectatorCameraMode(cam.id);
                    }}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-amber-500 text-slate-950'
                        : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {t(cam.labelKey)}
                  </button>
                );
              })}
            </div>

            <div className="hidden sm:block h-5 w-px bg-white/10" />

            <div className="flex items-center gap-1" dir="ltr">
              <button
                type="button"
                aria-label={t('spectator.zoomOutAria')}
                onClick={() => {
                  soundEngine.playUiClick();
                  adjustSpectatorZoom(-0.12);
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 cursor-pointer"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-[44px] text-center font-mono text-[11px] font-bold tabular-nums text-slate-300">
                {zoomPct}%
              </span>
              <button
                type="button"
                aria-label={t('spectator.zoomInAria')}
                onClick={() => {
                  soundEngine.playUiClick();
                  adjustSpectatorZoom(0.12);
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 cursor-pointer"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={t('spectator.resetZoomAria')}
                onClick={() => {
                  soundEngine.playUiClick();
                  resetSpectatorZoom();
                }}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 text-[11px] font-semibold text-slate-300 hover:bg-white/10 hover:text-white cursor-pointer whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3 w-3 text-amber-400" />
                {t('spectator.resetZoom')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
