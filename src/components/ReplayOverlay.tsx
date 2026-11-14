import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { ReplaySpeed } from '../game/replay/types';
import { BALL_DEFINITIONS } from '../game/utils/constants';
import { soundEngine } from '../game/utils/SoundEngine';
import { useGameStore, type CameraPreset } from '../store/useGameStore';
import { describeCueSpin } from './CueBallSpinControl';

const REPLAY_SPEEDS: ReplaySpeed[] = [0.25, 0.5, 1, 2];

const REPLAY_CAMERA_PRESETS: Array<{ id: CameraPreset; label: string }> = [
  { id: 'threeQuarter', label: '3/4' },
  { id: 'topDown', label: 'Top' },
  { id: 'sideView', label: 'Side' },
];

export interface ReplayOverlayProps {
  onExitReplay: () => void;
  onSelectShot: (shotId: string) => void;
  onTogglePlay: () => void;
  onRestart: () => void;
  onSeek: (timeSec: number) => void;
  onSetSpeed: (speed: ReplaySpeed) => void;
  onToggleAutoSlowMo: () => void;
  onToggleAnalysis: () => void;
  onJumpToImpact: () => void;
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
  onTogglePlay,
  onRestart,
  onSeek,
  onSetSpeed,
  onToggleAutoSlowMo,
  onToggleAnalysis,
  onJumpToImpact,
}: ReplayOverlayProps) {
  const screen = useGameStore((s) => s.screen);
  const replayActive = useGameStore((s) => s.replayActive);
  const replayShots = useGameStore((s) => s.replayShots);
  const replayShotId = useGameStore((s) => s.replayShotId);
  const replayPlaying = useGameStore((s) => s.replayPlaying);
  const replayTimeSec = useGameStore((s) => s.replayTimeSec);
  const replayDurationSec = useGameStore((s) => s.replayDurationSec);
  const replaySpeed = useGameStore((s) => s.replaySpeed);
  const replayAutoSlowMo = useGameStore((s) => s.replayAutoSlowMo);
  const replayShowAnalysis = useGameStore((s) => s.replayShowAnalysis);
  const replayActiveCollisionLabel = useGameStore((s) => s.replayActiveCollisionLabel);
  const cameraPreset = useGameStore((s) => s.cameraPreset);
  const requestCameraPreset = useGameStore((s) => s.requestCameraPreset);

  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);

  if (screen !== 'playing' || !replayActive || replayShots.length === 0) {
    return null;
  }

  // replayShots is newest-first: index 0 is latest shot
  const currentIdx = Math.max(
    0,
    replayShots.findIndex((s) => s.id === replayShotId),
  );
  const currentShot = replayShots[currentIdx] ?? replayShots[0];
  const hasOlder = currentIdx < replayShots.length - 1;
  const hasNewer = currentIdx > 0;

  const cueHits = currentShot.collisions.filter((c) => c.kind === 'cue_ball').length;
  const ballHits = currentShot.collisions.filter((c) => c.kind === 'ball_ball').length;
  const railHits = currentShot.collisions.filter((c) => c.kind === 'cushion').length;
  const duration = Math.max(0.02, replayDurationSec || currentShot.durationSec);
  const progressPct = Math.max(0, Math.min(100, (replayTimeSec / duration) * 100));
  const spinLabel = describeCueSpin(currentShot.spin.x, currentShot.spin.y);
  const spinDotLeft = 50 + currentShot.spin.x * 50;
  const spinDotTop = 50 - currentShot.spin.y * 50;

  return (
    <div
      data-testid="replay-overlay"
      className="pointer-events-none fixed inset-0 z-30 flex flex-col justify-between gap-2 p-2.5 sm:p-4 overflow-hidden"
    >
      {/* Top Replay Navigation & Collision Callout Bar */}
      <div className="flex flex-wrap items-start justify-between gap-2 shrink-0">
        {/* Shot Selector & Summary */}
        <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/35 bg-[#0c1219]/94 px-3 py-2 shadow-xl">
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={!hasOlder}
              onClick={() => {
                soundEngine.playUiClick();
                if (hasOlder) onSelectShot(replayShots[currentIdx + 1].id);
              }}
              title="Previous recorded shot"
              aria-label="Previous recorded shot"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 disabled:opacity-35 cursor-pointer"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="px-1.5 text-center">
              <div className="text-[11px] font-extrabold tracking-wide text-amber-400 whitespace-nowrap">
                SHOT REPLAY #{currentShot.shotNumber}
              </div>
              <div className="text-[10px] font-mono tabular-nums text-slate-400 whitespace-nowrap">
                {currentShot.shooterName} · {replayShots.length - currentIdx}/{replayShots.length}
              </div>
            </div>
            <button
              type="button"
              disabled={!hasNewer}
              onClick={() => {
                soundEngine.playUiClick();
                if (hasNewer) onSelectShot(replayShots[currentIdx - 1].id);
              }}
              title="Next recorded shot"
              aria-label="Next recorded shot"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 disabled:opacity-35 cursor-pointer"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="hidden sm:block h-6 w-px bg-white/10" />

          {/* Quick Camera Switcher for Overhead Trajectory Review */}
          <div className="flex items-center rounded-lg border border-white/10 bg-black/35 p-0.5">
            {REPLAY_CAMERA_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  requestCameraPreset(preset.id);
                }}
                className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  cameraPreset === preset.id
                    ? 'bg-amber-500 text-slate-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* Live Collision Moment Banner */}
        {replayActiveCollisionLabel && (
          <div
            data-testid="replay-collision-callout"
            className="pointer-events-none flex items-center gap-2 rounded-xl border border-amber-400/60 bg-[#141d29]/95 px-3 py-1.5 text-xs font-bold text-amber-300 shadow-lg"
          >
            <Activity className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <span className="whitespace-nowrap">{replayActiveCollisionLabel}</span>
          </div>
        )}

        {/* Right Utility: Toggle 3D Analysis + Exit Replay */}
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiClick();
              onToggleAnalysis();
            }}
            className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              replayShowAnalysis
                ? 'border-sky-400/50 bg-sky-500/15 text-sky-200'
                : 'border-white/12 bg-[#0c1219]/94 text-slate-300 hover:text-white'
            }`}
          >
            {replayShowAnalysis ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
            <span>Analysis</span>
          </button>

          <button
            type="button"
            data-testid="exit-replay-btn"
            onClick={() => {
              soundEngine.playUiClick();
              onExitReplay();
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-rose-400/40 bg-[#1c1216]/95 px-3.5 text-xs font-bold text-rose-200 hover:bg-rose-500/20 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <X className="h-4 w-4" />
            <span>Exit Replay</span>
          </button>
        </div>
      </div>

      {/* Compact Collapsible Shot Analysis Card (Bottom-Left) */}
      <div className="pointer-events-auto self-start my-auto sm:my-0 sm:mb-2 w-[264px] max-w-[90vw] max-h-[calc(100vh-195px)] overflow-y-auto rounded-xl border border-white/12 bg-[#0c1219]/94 p-3 text-slate-200 shadow-2xl">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
            Shot Analysis
          </span>
          <button
            type="button"
            onClick={() => setAnalysisCollapsed((v) => !v)}
            className="text-[11px] font-semibold text-slate-400 hover:text-white cursor-pointer whitespace-nowrap"
          >
            {analysisCollapsed ? 'Expand' : 'Minimize'}
          </button>
        </div>

        {!analysisCollapsed && (
          <div className="mt-2.5 space-y-2.5 text-xs">
            {/* Result & Duration */}
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

            {/* Cue-Ball Spin Diagram + Collision Summary */}
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

            {/* Pocketed Balls */}
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

            {/* Jump to Collision Slow-Mo */}
            {currentShot.firstImpactTimeSec !== null && (
              <button
                type="button"
                data-testid="jump-to-impact-btn"
                onClick={() => {
                  soundEngine.playUiClick();
                  onJumpToImpact();
                }}
                className="inline-flex w-full h-8 items-center justify-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 text-[11px] font-bold text-amber-300 hover:bg-amber-500/25 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Crosshair className="h-3.5 w-3.5" />
                <span>
                  Slow-Mo Impact ({currentShot.firstImpactTimeSec.toFixed(2)}s @ 0.25x)
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bottom Playback & Timeline Control Dock */}
      <div className="pointer-events-auto mx-auto w-full max-w-3xl rounded-2xl border border-white/12 bg-[#0c1219]/95 px-3 py-2.5 sm:px-4 shadow-2xl">
        {/* Timeline Track with Collision & Pocket Event Markers */}
        <div className="relative flex items-center gap-3">
          <span className="w-11 text-[11px] font-mono tabular-nums text-amber-300 shrink-0">
            {replayTimeSec.toFixed(2)}s
          </span>

          <div className="relative flex-1 h-7 flex items-center">
            {/* Background progress bar + markers */}
            <div className="pointer-events-none absolute inset-x-0 h-1.5 rounded-full bg-white/12 overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-[width] duration-75"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            {/* Collision & Pocket event markers */}
            {currentShot.collisions.map((col) => {
              if (col.kind === 'cushion') return null;
              const leftPct = Math.max(0, Math.min(100, (col.timeSec / duration) * 100));
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
              const leftPct = Math.max(0, Math.min(100, (p.timeSec / duration) * 100));
              return (
                <span
                  key={`pk-${p.ballNumber}`}
                  title={`Pocketed #${p.ballNumber} (${p.timeSec.toFixed(2)}s)`}
                  className="pointer-events-none absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400"
                  style={{ left: `${leftPct}%` }}
                />
              );
            })}

            <input
              type="range"
              data-testid="replay-timeline-slider"
              aria-label="Replay timeline"
              min={0}
              max={duration}
              step={0.005}
              value={Math.min(duration, replayTimeSec)}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="relative z-10 w-full h-7 appearance-none bg-transparent cursor-pointer accent-amber-400"
            />
          </div>

          <span className="w-11 text-right text-[11px] font-mono tabular-nums text-slate-400 shrink-0">
            {duration.toFixed(2)}s
          </span>
        </div>

        {/* Transport & Speed Controls */}
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="replay-play-pause-btn"
              onClick={() => {
                soundEngine.playUiClick();
                onTogglePlay();
              }}
              aria-label={replayPlaying ? 'Pause Replay' : 'Play Replay'}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer whitespace-nowrap shrink-0"
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
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3 text-xs font-semibold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5 text-amber-400" />
              <span>Restart</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Auto Slow-Mo at Collisions */}
            <button
              type="button"
              data-testid="replay-autoslow-btn"
              onClick={() => {
                soundEngine.playUiClick();
                onToggleAutoSlowMo();
              }}
              title="Automatically slow down to 0.25x during ball collisions"
              className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                replayAutoSlowMo
                  ? 'border-amber-400/60 bg-amber-500/20 text-amber-200'
                  : 'border-white/10 bg-white/5 text-slate-300 hover:text-white'
              }`}
            >
              <Gauge className="h-3.5 w-3.5 text-amber-400" />
              <span>Impact Slow-Mo</span>
            </button>

            {/* Playback Speed Selector: 0.25x, 0.5x, 1x, 2x */}
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
                  className={`h-8 rounded-lg px-2.5 text-xs font-mono font-bold tabular-nums transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
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
