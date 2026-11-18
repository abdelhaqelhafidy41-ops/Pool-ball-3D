import {
  Activity,
  Camera,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  Flame,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Square,
  Video,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ReplayVideoRecorder } from '../game/replay/ReplayVideoRecorder';
import type {
  ReplayCameraMode,
  ReplayHighlightCategory,
  ReplaySpeed,
} from '../game/replay/types';
import { BALL_DEFINITIONS } from '../game/utils/constants';
import { soundEngine } from '../game/utils/SoundEngine';
import { useGameStore } from '../store/useGameStore';
import { describeCueSpin } from './CueBallSpinControl';

const REPLAY_SPEEDS: ReplaySpeed[] = [0.25, 0.5, 1, 2, 4];

const REPLAY_CAMERA_MODES: Array<{ id: ReplayCameraMode; label: string; title: string }> = [
  { id: 'original', label: '3/4', title: 'Standard 3/4 table angle' },
  { id: 'topDown', label: 'Top', title: 'Overhead tactical view' },
  { id: 'free', label: 'Free', title: 'Free orbit & zoom camera' },
  { id: 'cinematic', label: 'Cinema', title: 'Broadcast sweeping orbit' },
  { id: 'ballFollow', label: 'Follow', title: 'Dynamic ball-follow camera' },
  { id: 'shotFocused', label: 'Shot', title: 'Low-angle cue alignment camera' },
];

export interface ReplayOverlayProps {
  onExitReplay: () => void;
  onSelectShot: (shotId: string) => void;
  onPrevShot?: () => void;
  onNextShot?: () => void;
  onJumpToStart?: () => void;
  onJumpToEnd?: () => void;
  onJumpToHighlight?: (highlightId: string) => void;
  onTogglePlay: () => void;
  onRestart: () => void;
  onSeek: (timeSec: number) => void;
  onSetSpeed: (speed: ReplaySpeed) => void;
  onSetCameraMode?: (mode: ReplayCameraMode) => void;
  onToggleAutoSlowMo: () => void;
  onToggleAnalysis: () => void;
  onJumpToImpact: () => void;
  onExportJson?: () => void;
  onStartVideoRecording?: () => void;
  onStopVideoRecording?: () => void;
}

function formatClock(sec: number): string {
  const safe = Math.max(0, sec);
  const m = Math.floor(safe / 60);
  const rem = safe - m * 60;
  if (m === 0) {
    return `${rem.toFixed(1)}s`;
  }
  const s = Math.floor(rem);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatHighlightCategoryLabel(cat: ReplayHighlightCategory): string {
  switch (cat) {
    case 'break':
      return 'Break';
    case 'long_pocket':
      return 'Long Pot';
    case 'multi_pocket':
      return 'Multi-Ball';
    case 'bank_or_combo':
      return 'Bank / Carom';
    case 'defensive':
      return 'Safety';
    case 'foul':
      return 'Foul';
    case 'eight_ball':
      return '8-Ball';
    case 'winning_moment':
      return 'Victory';
  }
}

function highlightBadgeClass(cat: ReplayHighlightCategory): string {
  switch (cat) {
    case 'winning_moment':
    case 'eight_ball':
      return 'border-amber-400/50 bg-amber-500/20 text-amber-200';
    case 'foul':
      return 'border-rose-400/45 bg-rose-500/18 text-rose-200';
    case 'multi_pocket':
    case 'long_pocket':
    case 'bank_or_combo':
      return 'border-emerald-400/45 bg-emerald-500/18 text-emerald-200';
    default:
      return 'border-sky-400/40 bg-sky-500/15 text-sky-200';
  }
}

function MiniBallIcon({ num }: { num: number }) {
  const def = BALL_DEFINITIONS[num];
  if (!def) return null;
  const isCue = num === 0;
  const isEight = num === 8;

  return (
    <span
      title={def.name}
      className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-extrabold shrink-0"
      style={{
        backgroundColor: isCue
          ? '#f5f2e8'
          : isEight
            ? '#14151a'
            : def.isStripe
              ? '#f5f1e3'
              : def.color,
        color: isEight ? '#ffffff' : '#111318',
        border: isEight
          ? '1px solid #f59e0b'
          : isCue
            ? '1px solid #cbd5e1'
            : '1px solid rgba(255,255,255,0.28)',
        boxShadow: def.isStripe ? `inset 0 0 0 2.5px ${def.color}` : undefined,
      }}
    >
      {isCue ? '' : num}
    </span>
  );
}

export function ReplayOverlay({
  onExitReplay,
  onSelectShot,
  onPrevShot,
  onNextShot,
  onJumpToStart,
  onJumpToEnd,
  onJumpToHighlight,
  onTogglePlay,
  onRestart,
  onSeek,
  onSetSpeed,
  onSetCameraMode,
  onToggleAutoSlowMo,
  onToggleAnalysis,
  onJumpToImpact,
  onExportJson,
  onStartVideoRecording,
  onStopVideoRecording,
}: ReplayOverlayProps) {
  const screen = useGameStore((s) => s.screen);
  const replayActive = useGameStore((s) => s.replayActive);
  const replayMode = useGameStore((s) => s.replayMode);
  const replayShots = useGameStore((s) => s.replayShots);
  const replayShotId = useGameStore((s) => s.replayShotId);
  const replayShotIndex = useGameStore((s) => s.replayShotIndex);
  const replayTotalShots = useGameStore((s) => s.replayTotalShots);
  const replayPlaying = useGameStore((s) => s.replayPlaying);
  const replayTimeSec = useGameStore((s) => s.replayTimeSec);
  const replayDurationSec = useGameStore((s) => s.replayDurationSec);
  const replayMatchTimeSec = useGameStore((s) => s.replayMatchTimeSec);
  const replayMatchDurationSec = useGameStore((s) => s.replayMatchDurationSec);
  const replaySpeed = useGameStore((s) => s.replaySpeed);
  const replayCameraMode = useGameStore((s) => s.replayCameraMode);
  const replayAutoSlowMo = useGameStore((s) => s.replayAutoSlowMo);
  const replayShowAnalysis = useGameStore((s) => s.replayShowAnalysis);
  const replayActiveCollisionLabel = useGameStore((s) => s.replayActiveCollisionLabel);
  const replayHighlights = useGameStore((s) => s.replayHighlights);
  const replayMatchMeta = useGameStore((s) => s.replayMatchMeta);
  const replayIsRecordingVideo = useGameStore((s) => s.replayIsRecordingVideo);
  const replayVideoNotice = useGameStore((s) => s.replayVideoNotice);

  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'shot' | 'highlights' | 'shots'>('shot');
  const [videoSupported, setVideoSupported] = useState(false);

  useEffect(() => {
    setVideoSupported(ReplayVideoRecorder.isSupported());
  }, []);

  if (screen !== 'playing' || !replayActive || replayShots.length === 0) {
    return null;
  }

  const isMatchMode = replayMode === 'match';
  // replayShots is newest-first
  const currentIdx = Math.max(
    0,
    replayShots.findIndex((s) => s.id === replayShotId),
  );
  const currentShot = replayShots[currentIdx] ?? replayShots[0];
  const chronoShots = [...replayShots].reverse();
  const displayShotOrder = isMatchMode
    ? replayShotIndex + 1
    : replayShots.length - currentIdx;
  const displayShotTotal = isMatchMode
    ? Math.max(replayTotalShots, chronoShots.length)
    : replayShots.length;

  const hasPrevShot = isMatchMode
    ? replayShotIndex > 0
    : currentIdx < replayShots.length - 1;
  const hasNextShot = isMatchMode
    ? replayShotIndex < displayShotTotal - 1
    : currentIdx > 0;

  const cueHits = currentShot.collisions.filter((c) => c.kind === 'cue_ball').length;
  const ballHits = currentShot.collisions.filter((c) => c.kind === 'ball_ball').length;
  const railHits = currentShot.collisions.filter((c) => c.kind === 'cushion').length;

  const timelineValue = isMatchMode ? replayMatchTimeSec : replayTimeSec;
  const timelineMax = Math.max(
    0.02,
    isMatchMode
      ? replayMatchDurationSec || currentShot.durationSec
      : replayDurationSec || currentShot.durationSec,
  );
  const progressPct = Math.max(0, Math.min(100, (timelineValue / timelineMax) * 100));
  const spinLabel = describeCueSpin(currentShot.spin.x, currentShot.spin.y);
  const spinDotLeft = 50 + currentShot.spin.x * 50;
  const spinDotTop = 50 - currentShot.spin.y * 50;

  const handlePrev = () => {
    soundEngine.playUiClick();
    if (!hasPrevShot) return;
    if (isMatchMode && onPrevShot) {
      onPrevShot();
    } else if (currentIdx < replayShots.length - 1) {
      onSelectShot(replayShots[currentIdx + 1].id);
    }
  };

  const handleNext = () => {
    soundEngine.playUiClick();
    if (!hasNextShot) return;
    if (isMatchMode && onNextShot) {
      onNextShot();
    } else if (currentIdx > 0) {
      onSelectShot(replayShots[currentIdx - 1].id);
    }
  };

  return (
    <div
      data-testid="replay-overlay"
      className="pointer-events-none fixed inset-0 z-30 flex flex-col justify-between gap-2 p-2.5 sm:p-4 overflow-hidden"
    >
      {/* Top Broadcast Header: Shot Nav, Camera Modes, Match Scoreboard, Exit */}
      <div className="flex flex-wrap items-start justify-between gap-2 shrink-0">
        {/* Left: Shot Navigation & Camera Modes */}
        <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/35 bg-[#0c1219]/95 px-2.5 py-1.5 shadow-xl">
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="replay-prev-shot-btn"
              disabled={!hasPrevShot}
              onClick={handlePrev}
              title="Previous shot"
              aria-label="Previous recorded shot"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 disabled:opacity-35 cursor-pointer"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="px-1.5 text-center">
              <div className="text-[11px] font-extrabold tracking-wide text-amber-400 whitespace-nowrap">
                {isMatchMode ? 'MATCH REPLAY' : 'SHOT REPLAY'} #{currentShot.shotNumber}
              </div>
              <div className="text-[10px] font-mono tabular-nums text-slate-300 whitespace-nowrap">
                {currentShot.shooterName} · {displayShotOrder}/{displayShotTotal}
              </div>
            </div>
            <button
              type="button"
              data-testid="replay-next-shot-btn"
              disabled={!hasNextShot}
              onClick={handleNext}
              title="Next shot"
              aria-label="Next recorded shot"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 disabled:opacity-35 cursor-pointer"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="hidden md:block h-6 w-px bg-white/10" />

          {/* 6 Independent Replay Camera Modes */}
          <div
            role="group"
            aria-label="Replay camera mode"
            className="flex flex-wrap items-center gap-0.5 rounded-lg border border-white/10 bg-black/40 p-0.5"
          >
            <Camera className="mx-1 h-3.5 w-3.5 text-amber-400 shrink-0 hidden sm:block" />
            {REPLAY_CAMERA_MODES.map((cam) => (
              <button
                key={cam.id}
                type="button"
                data-testid={`replay-cam-${cam.id}`}
                title={cam.title}
                onClick={() => {
                  soundEngine.playUiClick();
                  onSetCameraMode?.(cam.id);
                }}
                className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  replayCameraMode === cam.id
                    ? 'bg-amber-500 text-slate-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {cam.label}
              </button>
            ))}
          </div>
        </div>

        {/* Center: Sports Broadcast Scoreboard & Match Clock (Match Replay mode) */}
        {isMatchMode && replayMatchMeta && (
          <div
            data-testid="replay-match-scoreboard"
            className="pointer-events-auto hidden lg:flex items-center gap-3 rounded-xl border border-white/12 bg-[#0c1219]/95 px-3.5 py-1.5 text-xs shadow-xl"
          >
            <div className="flex items-center gap-2">
              <span
                className={`font-bold ${
                  currentShot.shooter === 'player1' ? 'text-amber-300' : 'text-white'
                }`}
              >
                {replayMatchMeta.player1Name}
              </span>
              {replayMatchMeta.player1Group && (
                <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-300">
                  {replayMatchMeta.player1Group}
                </span>
              )}
              <span className="font-mono font-extrabold tabular-nums text-amber-400">
                {replayMatchMeta.player1PocketedCount}
              </span>
            </div>

            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              VS
            </span>

            <div className="flex items-center gap-2">
              <span className="font-mono font-extrabold tabular-nums text-amber-400">
                {replayMatchMeta.player2PocketedCount}
              </span>
              {replayMatchMeta.player2Group && (
                <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-300">
                  {replayMatchMeta.player2Group}
                </span>
              )}
              <span
                className={`font-bold ${
                  currentShot.shooter === 'player2' ? 'text-amber-300' : 'text-white'
                }`}
              >
                {replayMatchMeta.player2Name}
              </span>
            </div>

            <div className="h-4 w-px bg-white/10" />

            <span className="rounded border border-amber-400/35 bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-300 whitespace-nowrap">
              {replayMatchMeta.matchType.toUpperCase()} · {replayMatchMeta.ruleProfileId.toUpperCase()}
            </span>
          </div>
        )}

        {/* Live Collision Callout */}
        {replayActiveCollisionLabel && (
          <div
            data-testid="replay-collision-callout"
            className="pointer-events-none flex items-center gap-2 rounded-xl border border-amber-400/60 bg-[#141d29]/95 px-3 py-1.5 text-xs font-bold text-amber-300 shadow-lg"
          >
            <Activity className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <span className="whitespace-nowrap">{replayActiveCollisionLabel}</span>
          </div>
        )}

        {/* Right Utility: Export + Video + Analysis + Exit */}
        <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
          {isMatchMode && onExportJson && (
            <button
              type="button"
              data-testid="replay-export-json-btn"
              onClick={() => {
                soundEngine.playUiClick();
                onExportJson();
              }}
              title="Export full match replay JSON"
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/12 bg-[#0c1219]/95 px-2.5 text-xs font-semibold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden sm:inline">Export</span>
            </button>
          )}

          {(onStartVideoRecording || onStopVideoRecording) && (
            <button
              type="button"
              data-testid="replay-record-video-btn"
              disabled={!videoSupported && !replayIsRecordingVideo}
              title={
                !videoSupported
                  ? 'Browser canvas video capture unavailable'
                  : replayIsRecordingVideo
                    ? 'Stop & download viewport recording'
                    : 'Record 3D viewport video'
              }
              onClick={() => {
                soundEngine.playUiClick();
                if (replayIsRecordingVideo) {
                  onStopVideoRecording?.();
                } else {
                  onStartVideoRecording?.();
                }
              }}
              className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${
                replayIsRecordingVideo
                  ? 'border-rose-400/70 bg-rose-500/25 text-rose-200'
                  : 'border-white/12 bg-[#0c1219]/95 text-slate-200 hover:bg-white/10'
              }`}
            >
              {replayIsRecordingVideo ? (
                <>
                  <Square className="h-3 w-3 fill-rose-300 text-rose-300" />
                  <span>Stop Rec</span>
                </>
              ) : (
                <>
                  <Video className="h-3.5 w-3.5 text-amber-400" />
                  <span className="hidden sm:inline">Capture</span>
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              soundEngine.playUiClick();
              onToggleAnalysis();
            }}
            className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              replayShowAnalysis
                ? 'border-sky-400/50 bg-sky-500/15 text-sky-200'
                : 'border-white/12 bg-[#0c1219]/95 text-slate-300 hover:text-white'
            }`}
          >
            {replayShowAnalysis ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">Trails</span>
          </button>

          <button
            type="button"
            data-testid="exit-replay-btn"
            onClick={() => {
              soundEngine.playUiClick();
              onExitReplay();
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-rose-400/40 bg-[#1c1216]/95 px-3 text-xs font-bold text-rose-200 hover:bg-rose-500/20 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <X className="h-4 w-4" />
            <span>Exit Replay</span>
          </button>
        </div>
      </div>

      {/* Collapsible Left Perimeter Drawer: Shot Info / Highlights / Shot Timeline */}
      <div className="pointer-events-auto self-start my-auto sm:my-0 sm:mb-1 w-[276px] max-w-[90vw] max-h-[calc(100vh-205px)] overflow-y-auto rounded-xl border border-white/12 bg-[#0c1219]/95 p-3 text-slate-200 shadow-2xl">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="replay-tab-analysis"
              onClick={() => setDrawerTab('shot')}
              className={`rounded-md px-2 py-1 text-[11px] font-bold cursor-pointer whitespace-nowrap ${
                drawerTab === 'shot'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Shot Info
            </button>
            {replayHighlights.length > 0 && (
              <button
                type="button"
                data-testid="replay-tab-highlights"
                onClick={() => setDrawerTab('highlights')}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold cursor-pointer whitespace-nowrap ${
                  drawerTab === 'highlights'
                    ? 'bg-amber-500 text-slate-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Flame className="h-3 w-3" />
                <span>Highlights ({replayHighlights.length})</span>
              </button>
            )}
            {isMatchMode && chronoShots.length > 1 && (
              <button
                type="button"
                data-testid="replay-tab-shots"
                onClick={() => setDrawerTab('shots')}
                className={`rounded-md px-2 py-1 text-[11px] font-bold cursor-pointer whitespace-nowrap ${
                  drawerTab === 'shots'
                    ? 'bg-amber-500 text-slate-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Shots ({chronoShots.length})
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setAnalysisCollapsed((v) => !v)}
            className="text-[11px] font-semibold text-slate-400 hover:text-white cursor-pointer whitespace-nowrap"
          >
            {analysisCollapsed ? 'Open' : 'Hide'}
          </button>
        </div>

        {!analysisCollapsed && drawerTab === 'shot' && (
          <div className="mt-2.5 space-y-2.5 text-xs">
            <div className="border-b border-white/10 pb-2">
              <div
                className={`font-bold leading-snug ${
                  currentShot.isFoul ? 'text-rose-300' : 'text-white'
                }`}
              >
                {currentShot.resultLabel}
              </div>
              <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-400">
                {currentShot.durationSec.toFixed(2)}s · Power {Math.round(currentShot.power * 100)}%
                {currentShot.isBreakShot ? ' · Break' : ''}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div
                title={`Spin: ${spinLabel}`}
                className="relative h-10 w-10 shrink-0 rounded-full border border-white/20"
                style={{
                  background:
                    'radial-gradient(circle at 35% 30%, #ffffff 0%, #f1ede0 65%, #b8af99 100%)',
                }}
              >
                <div className="absolute left-1/2 top-1 bottom-1 w-px -translate-x-1/2 bg-slate-900/20" />
                <div className="absolute top-1/2 left-1 right-1 h-px -translate-y-1/2 bg-slate-900/20" />
                <span
                  className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-red-600"
                  style={{ left: `${spinDotLeft}%`, top: `${spinDotTop}%` }}
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-bold text-white truncate">{spinLabel}</div>
                <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-400">
                  {cueHits} Cue · {ballHits} Ball · {railHits} Rail
                </div>
                <div className="text-[10px] text-slate-400">
                  {currentShot.trajectoriesCount} ball paths tracked
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-white/10 pt-2">
              <span className="text-[11px] font-semibold text-slate-400 shrink-0">
                Pocketed
              </span>
              {currentShot.pocketedBalls.length > 0 ? (
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {currentShot.pocketedBalls.map((p) => (
                    <MiniBallIcon key={`${p.ballNumber}-${p.pocketId}`} num={p.ballNumber} />
                  ))}
                </div>
              ) : (
                <span className="text-[11px] text-slate-500">None</span>
              )}
            </div>

            {currentShot.firstImpactTimeSec !== null && (
              <button
                type="button"
                data-testid="jump-to-impact-btn"
                onClick={() => {
                  soundEngine.playUiClick();
                  onJumpToImpact();
                }}
                className="inline-flex w-full h-9 items-center justify-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 text-[11px] font-bold text-amber-300 hover:bg-amber-500/25 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Crosshair className="h-3.5 w-3.5" />
                <span>
                  Slow-Mo Impact ({currentShot.firstImpactTimeSec.toFixed(2)}s @ 0.25x)
                </span>
              </button>
            )}
          </div>
        )}

        {!analysisCollapsed && drawerTab === 'highlights' && (
          <div className="mt-2.5 space-y-1.5 max-h-[240px] overflow-y-auto pr-0.5">
            {replayHighlights.map((hl) => (
              <button
                key={hl.id}
                type="button"
                data-testid={`replay-highlight-${hl.id}`}
                onClick={() => {
                  soundEngine.playUiClick();
                  onJumpToHighlight?.(hl.id);
                }}
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-left hover:border-amber-400/45 hover:bg-amber-500/10 transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase ${highlightBadgeClass(hl.category)}`}
                  >
                    {formatHighlightCategoryLabel(hl.category)}
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-amber-300">
                    Shot #{hl.shotNumber} · {formatClock(hl.matchTimeSec)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] font-bold text-white">{hl.title}</div>
                <div className="mt-0.5 text-[10px] leading-snug text-slate-400">
                  {hl.description}
                </div>
              </button>
            ))}
          </div>
        )}

        {!analysisCollapsed && drawerTab === 'shots' && (
          <div className="mt-2.5 space-y-1 max-h-[240px] overflow-y-auto pr-0.5">
            {chronoShots.map((s) => {
              const active = s.id === currentShot.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  data-testid={`replay-shot-item-${s.id}`}
                  onClick={() => {
                    soundEngine.playUiClick();
                    onSelectShot(s.id);
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[11px] cursor-pointer ${
                    active
                      ? 'border-amber-400/60 bg-amber-500/18 text-white'
                      : 'border-white/8 bg-white/[0.02] text-slate-300 hover:bg-white/8'
                  }`}
                >
                  <span className="min-w-0 truncate font-semibold">
                    #{s.shotNumber} {s.shooterName} — {s.resultLabel}
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-slate-400 shrink-0">
                    {formatClock(s.startMatchTimeSec)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom Transport & Timeline Control Dock */}
      <div className="pointer-events-auto mx-auto w-full max-w-4xl rounded-2xl border border-white/12 bg-[#0c1219]/95 px-3 py-2.5 sm:px-4 shadow-2xl">
        {replayVideoNotice && (
          <div className="mb-1 text-center text-[11px] font-semibold text-amber-300">
            {replayVideoNotice}
          </div>
        )}

        {/* Timeline Scrubber with Highlight / Collision / Pocket Markers */}
        <div className="relative flex items-center gap-3">
          <span className="w-12 text-[11px] font-mono tabular-nums text-amber-300 shrink-0">
            {isMatchMode ? formatClock(timelineValue) : `${timelineValue.toFixed(2)}s`}
          </span>

          <div className="relative flex-1 h-7 flex items-center">
            <div className="pointer-events-none absolute inset-x-0 h-1.5 rounded-full bg-white/12 overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-[width] duration-75"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            {isMatchMode ? (
              replayHighlights.map((hl) => {
                const leftPct = Math.max(0, Math.min(100, (hl.matchTimeSec / timelineMax) * 100));
                return (
                  <span
                    key={hl.id}
                    title={`${hl.title} (Shot #${hl.shotNumber})`}
                    className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                      hl.category === 'foul'
                        ? 'h-3 w-1.5 bg-rose-400'
                        : hl.category === 'winning_moment' || hl.category === 'eight_ball'
                          ? 'h-3.5 w-1.5 bg-amber-300'
                          : 'h-3 w-1.5 bg-emerald-400'
                    }`}
                    style={{ left: `${leftPct}%` }}
                  />
                );
              })
            ) : (
              <>
                {currentShot.collisions.map((col) => {
                  if (col.kind === 'cushion') return null;
                  const leftPct = Math.max(0, Math.min(100, (col.timeSec / timelineMax) * 100));
                  return (
                    <span
                      key={col.id}
                      title={`${col.kind === 'cue_ball' ? 'Cue Impact' : 'Ball Collision'} (${col.timeSec.toFixed(2)}s)`}
                      className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                        col.kind === 'cue_ball'
                          ? 'h-3 w-1 bg-amber-300'
                          : 'h-2.5 w-1 bg-sky-400'
                      }`}
                      style={{ left: `${leftPct}%` }}
                    />
                  );
                })}
                {currentShot.pocketedBalls.map((p) => {
                  const leftPct = Math.max(0, Math.min(100, (p.timeSec / timelineMax) * 100));
                  return (
                    <span
                      key={`pk-${p.ballNumber}`}
                      title={`Pocketed #${p.ballNumber} (${p.timeSec.toFixed(2)}s)`}
                      className="pointer-events-none absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400"
                      style={{ left: `${leftPct}%` }}
                    />
                  );
                })}
              </>
            )}

            <input
              type="range"
              data-testid="replay-timeline-slider"
              aria-label="Replay timeline"
              min={0}
              max={timelineMax}
              step={0.01}
              value={Math.min(timelineMax, timelineValue)}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="relative z-10 w-full h-7 appearance-none bg-transparent cursor-pointer accent-amber-400"
            />
          </div>

          <span className="w-12 text-right text-[11px] font-mono tabular-nums text-slate-400 shrink-0">
            {isMatchMode ? formatClock(timelineMax) : `${timelineMax.toFixed(2)}s`}
          </span>
        </div>

        {/* Transport & Speed Controls */}
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {onJumpToStart && (
              <button
                type="button"
                data-testid="replay-jump-start-btn"
                onClick={() => {
                  soundEngine.playUiClick();
                  onJumpToStart();
                }}
                title="Jump to beginning"
                aria-label="Jump to beginning"
                className="inline-flex h-10 w-9 items-center justify-center rounded-xl border border-white/12 bg-white/5 text-slate-200 hover:bg-white/10 cursor-pointer shrink-0"
              >
                <SkipBack className="h-4 w-4" />
              </button>
            )}

            <button
              type="button"
              data-testid="replay-play-pause-btn"
              onClick={() => {
                soundEngine.playUiClick();
                onTogglePlay();
              }}
              aria-label={replayPlaying ? 'Pause Replay' : 'Play Replay'}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {replayPlaying ? (
                <>
                  <Pause className="h-3.5 w-3.5" />
                  <span>Pause</span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  <span>Play</span>
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="replay-restart-btn"
              onClick={() => {
                soundEngine.playUiClick();
                onRestart();
              }}
              aria-label="Restart Replay"
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3 text-xs font-semibold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5 text-amber-400" />
              <span>Restart</span>
            </button>

            {onJumpToEnd && (
              <button
                type="button"
                data-testid="replay-jump-end-btn"
                onClick={() => {
                  soundEngine.playUiClick();
                  onJumpToEnd();
                }}
                title="Jump to end"
                aria-label="Jump to end"
                className="inline-flex h-10 w-9 items-center justify-center rounded-xl border border-white/12 bg-white/5 text-slate-200 hover:bg-white/10 cursor-pointer shrink-0"
              >
                <SkipForward className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="replay-autoslow-btn"
              onClick={() => {
                soundEngine.playUiClick();
                onToggleAutoSlowMo();
              }}
              title="Automatically slow down to 0.25x during ball collisions"
              className={`inline-flex h-10 items-center gap-1.5 rounded-xl border px-2.5 text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                replayAutoSlowMo
                  ? 'border-amber-400/60 bg-amber-500/20 text-amber-200'
                  : 'border-white/10 bg-white/5 text-slate-300 hover:text-white'
              }`}
            >
              <Gauge className="h-3.5 w-3.5 text-amber-400" />
              <span>Impact Slow-Mo</span>
            </button>

            <div
              role="group"
              aria-label="Replay speed"
              className="flex items-center rounded-xl border border-white/10 bg-black/40 p-0.5"
            >
              {REPLAY_SPEEDS.map((spd) => (
                <button
                  key={spd}
                  type="button"
                  data-testid={`replay-speed-${spd}`}
                  onClick={() => {
                    soundEngine.playUiClick();
                    onSetSpeed(spd);
                  }}
                  className={`h-9 rounded-lg px-2 sm:px-2.5 text-xs font-mono font-bold tabular-nums transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    replaySpeed === spd
                      ? 'bg-amber-500 text-slate-950'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {spd}x
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
