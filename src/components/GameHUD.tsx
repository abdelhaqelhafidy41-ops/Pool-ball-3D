import {
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Compass,
  Crosshair,
  Eye,
  EyeOff,
  Film,
  Home,
  Maximize2,
  Minimize2,
  RotateCcw,
  Settings,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useRef } from 'react';
import type { PocketId } from '../game/rules/types';
import { soundEngine } from '../game/utils/SoundEngine';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { canLocalPlayerAct, useGameStore, type CameraPreset } from '../store/useGameStore';
import { AIOpponentPanel } from './AIOpponentPanel';
import { BallInHandOverlay } from './BallInHandOverlay';
import { CalledShotPanel } from './CalledShotPanel';
import { CueBallSpinControl } from './CueBallSpinControl';
import { FpsCounter } from './FpsCounter';
import { MatchNotificationBanner } from './MatchNotificationBanner';
import { MatchScoreboard } from './MatchScoreboard';
import { MiniatureCueController } from './MiniatureCueController';
import { OnlineMatchBanner } from './OnlineMatchBanner';

interface GameHUDProps {
  onShoot: (power: number) => void;
  onResetRack: () => void;
  onConfirmPlacement: () => void;
  onPlaceAtHeadSpot: () => void;
  onSelectCalledShot: (targetBall: number | null, targetPocket: PocketId | null) => void;
  onToggleFullscreen: () => void;
  onEnterReplay: (shotId?: string) => void;
}

const CAMERA_PRESETS: Array<{ id: CameraPreset; label: string }> = [
  { id: 'threeQuarter', label: '3/4 View' },
  { id: 'topDown', label: 'Top' },
  { id: 'cueAim', label: 'Cue Cam' },
  { id: 'sideView', label: 'Side' },
];

export function GameHUD({
  onShoot,
  onResetRack,
  onConfirmPlacement,
  onPlaceAtHeadSpot,
  onSelectCalledShot,
  onToggleFullscreen,
  onEnterReplay,
}: GameHUDProps) {
  const screen = useGameStore((s) => s.screen);
  const setScreen = useGameStore((s) => s.setScreen);
  const setSettingsOpen = useGameStore((s) => s.setSettingsOpen);
  const cameraPreset = useGameStore((s) => s.cameraPreset);
  const requestCameraPreset = useGameStore((s) => s.requestCameraPreset);
  const soundEnabled = useGameStore((s) => s.soundEnabled);
  const toggleSound = useGameStore((s) => s.toggleSound);
  const isFullscreen = useGameStore((s) => s.isFullscreen);
  const hudCollapsed = useGameStore((s) => s.hudCollapsed);
  const toggleHudCollapsed = useGameStore((s) => s.toggleHudCollapsed);
  const replayActive = useGameStore((s) => s.replayActive);
  const replayShots = useGameStore((s) => s.replayShots);

  const cueAngle = useGameStore((s) => s.cueAngle);
  const adjustCueAngle = useGameStore((s) => s.adjustCueAngle);
  const resetCueAngle = useGameStore((s) => s.resetCueAngle);
  const showAimGuide = useGameStore((s) => s.settings.showAimGuide);
  const toggleShowAimGuide = useGameStore((s) => s.toggleShowAimGuide);
  const canvasInteractionMode = useGameStore((s) => s.canvasInteractionMode);
  const setCanvasInteractionMode = useGameStore((s) => s.setCanvasInteractionMode);
  const ballsMoving = useGameStore((s) => s.ballsMoving);
  const isShotAnimating = useGameStore((s) => s.isShotAnimating);
  const isDraggingCue = useGameStore((s) => s.isDraggingCue);
  const isAiThinking = useGameStore((s) => s.isAiThinking);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const opponentType = useGameStore((s) => s.matchConfig.opponentType);
  const canAct = useGameStore(canLocalPlayerAct);

  const aimDragRef = useRef<{ active: boolean; id: number; lastX: number }>({
    active: false,
    id: -1,
    lastX: 0,
  });

  if (screen !== 'playing' || replayActive) return null;

  const isOnline = opponentType === 'online';
  const aimLocked =
    ballsMoving ||
    isShotAnimating ||
    isDraggingCue ||
    isAiThinking ||
    !canAct ||
    matchPhase === 'BALL_IN_HAND' ||
    matchPhase === 'BALLS_MOVING' ||
    matchPhase === 'GAME_OVER';
  const angleDeg = Math.round((((cueAngle * 180) / Math.PI) % 360 + 360) % 360);

  const onAimScrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (aimLocked || (e.button !== 0 && e.pointerType === 'mouse')) return;
    e.preventDefault();
    e.stopPropagation();
    soundEngine.unlock();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    aimDragRef.current = { active: true, id: e.pointerId, lastX: e.clientX };
  };

  const onAimScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = aimDragRef.current;
    if (!d.active || d.id !== e.pointerId || aimLocked) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = e.clientX - d.lastX;
    d.lastX = e.clientX;
    adjustCueAngle(dx * 0.011);
  };

  const onAimScrubUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = aimDragRef.current;
    if (!d.active || d.id !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }
    aimDragRef.current.active = false;
    aimDragRef.current.id = -1;
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-2.5 sm:p-4">
      {/* Top Perimeter Bar: Home/Menu + Authoritative 8-Ball Scoreboard + Utilities */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        {/* Top-Left Brand & Menu Return */}
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-white/10 bg-[#0c1219]/92 px-2.5 py-1.5 shadow-lg">
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiClick();
              if (isOnline) {
                multiplayerManager.leaveMatchOrRoom();
              } else {
                setScreen('menu');
              }
            }}
            title={isOnline ? 'Leave Match & Return to Menu' : 'Back to Main Menu'}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            <Home className="h-3.5 w-3.5" />
          </button>

          <div className="hidden sm:block pr-1">
            <div className="text-[11px] font-extrabold tracking-wider text-white whitespace-nowrap">
              ULTIMATE POOL <span className="text-amber-400">3D</span>
            </div>
          </div>
        </div>

        {/* Center Match Scoreboard */}
        <MatchScoreboard />

        {/* Top-Right Utility Cluster */}
        <div className="pointer-events-auto flex items-center gap-1.5">
          {replayShots.length > 0 && !ballsMoving && !isShotAnimating && (
            <button
              type="button"
              data-testid="open-replay-btn"
              onClick={() => {
                soundEngine.unlock();
                soundEngine.playUiClick();
                onEnterReplay();
              }}
              title="Watch Shot Replay & Analysis"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-400/40 bg-[#0c1219]/92 px-2.5 text-[11px] font-bold text-amber-300 hover:bg-amber-500/15 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Film className="h-3.5 w-3.5 text-amber-400" />
              <span>Replay</span>
            </button>
          )}
          <FpsCounter />
          <button
            type="button"
            onClick={() => {
              soundEngine.unlock();
              toggleSound();
            }}
            title={soundEnabled ? 'Mute Audio (M)' : 'Unmute Audio (M)'}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#0c1219]/92 text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
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
            title="Toggle Fullscreen (F)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#0c1219]/92 text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiClick();
              setSettingsOpen(true);
            }}
            title="Settings (Esc)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#0c1219]/92 text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Turn / Foul / Group Banner, AI Indicator, Online Status & Ball-in-Hand Overlay */}
      <AIOpponentPanel />
      <OnlineMatchBanner />
      <MatchNotificationBanner />
      <BallInHandOverlay
        onConfirmPlacement={onConfirmPlacement}
        onPlaceAtHeadSpot={onPlaceAtHeadSpot}
      />

      {/* Called Shot & Pocket Selector */}
      <CalledShotPanel onSelectCalledShot={onSelectCalledShot} />

      {/* Compact Square Cue Ball Spin Selector */}
      <CueBallSpinControl />

      {/* Right Perimeter Control: Frameless Miniature Cue Stick */}
      <div className="pointer-events-none fixed right-2 sm:right-4 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center">
        <MiniatureCueController onShoot={onShoot} />
      </div>

      {/* Bottom Compact Aiming, Camera & Table Action Bar */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={toggleHudCollapsed}
          className="pointer-events-auto mb-1.5 inline-flex items-center gap-1 rounded-lg border border-white/10 bg-[#0c1219]/92 px-3 py-1 text-[11px] font-medium text-slate-300 hover:text-white transition-colors cursor-pointer"
        >
          {hudCollapsed ? (
            <>
              <ChevronUp className="h-3.5 w-3.5 text-amber-400" />
              Show Controls (H)
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5 text-amber-400" />
              Hide Controls (H)
            </>
          )}
        </button>

        {!hudCollapsed && (
          <div className="pointer-events-auto flex max-w-[96vw] flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/12 bg-[#0c1219]/94 px-2.5 py-2 sm:px-3 shadow-2xl">
            {/* Aiming Direction Group */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={aimLocked}
                onClick={() => {
                  soundEngine.unlock();
                  adjustCueAngle(-0.045);
                }}
                title="Rotate Aim Left"
                aria-label="Rotate Aim Left"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/12 disabled:opacity-40 cursor-pointer"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>

              {/* Endless 360-degree Touch & Mouse Aim Scrubber */}
              <div
                role="slider"
                aria-label="Drag left or right to rotate aiming direction 360 degrees"
                aria-valuemin={0}
                aria-valuemax={359}
                aria-valuenow={angleDeg}
                onPointerDown={onAimScrubDown}
                onPointerMove={onAimScrubMove}
                onPointerUp={onAimScrubUp}
                onPointerCancel={onAimScrubUp}
                className={`relative flex h-7 w-[112px] sm:w-[136px] items-center justify-between rounded-lg border px-2 select-none transition-colors ${
                  aimLocked
                    ? 'border-white/5 bg-black/35 opacity-45 cursor-not-allowed'
                    : 'border-white/12 bg-black/40 hover:border-amber-400/50 cursor-ew-resize'
                }`}
                style={{ touchAction: 'none' }}
                title="Drag left/right to aim 360°"
              >
                <Compass className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
                  Aim
                </span>
                <span className="text-[11px] font-mono tabular-nums font-bold text-amber-400">
                  {angleDeg}°
                </span>
              </div>

              <button
                type="button"
                disabled={aimLocked}
                onClick={() => {
                  soundEngine.unlock();
                  adjustCueAngle(0.045);
                }}
                title="Rotate Aim Right"
                aria-label="Rotate Aim Right"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/12 disabled:opacity-40 cursor-pointer"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                disabled={aimLocked}
                onClick={() => {
                  soundEngine.playUiClick();
                  resetCueAngle();
                }}
                title="Reset Aiming Direction"
                aria-label="Reset Aiming Direction"
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 text-[11px] font-semibold text-slate-200 hover:bg-white/12 hover:text-amber-400 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Crosshair className="h-3.5 w-3.5 text-amber-400" />
                <span className="hidden sm:inline">Reset</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  toggleShowAimGuide();
                }}
                title={showAimGuide ? 'Hide Trajectory Guide' : 'Show Trajectory Guide'}
                aria-label="Toggle Trajectory Guide"
                className={`inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  showAimGuide
                    ? 'border-amber-400/50 bg-amber-500/15 text-amber-300'
                    : 'border-white/10 bg-white/5 text-slate-400 hover:text-white'
                }`}
              >
                {showAimGuide ? (
                  <Eye className="h-3.5 w-3.5" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5" />
                )}
                <span className="hidden md:inline">Guide</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  setCanvasInteractionMode(
                    canvasInteractionMode === 'smart' ? 'aim' : 'smart',
                  );
                }}
                title="Switch table drag between Smart Orbit and 360° Aim Lock"
                className={`inline-flex h-7 items-center rounded-lg border px-2 text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  canvasInteractionMode === 'aim'
                    ? 'border-amber-400 bg-amber-500 text-slate-950'
                    : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/12'
                }`}
              >
                {canvasInteractionMode === 'aim' ? 'Table: Aim' : 'Table: Smart'}
              </button>
            </div>

            <div className="hidden sm:block h-5 w-px bg-white/10" />

            {/* Camera View Presets */}
            <div className="flex items-center gap-1.5">
              <Camera className="h-3.5 w-3.5 text-amber-400 shrink-0 hidden md:block" />
              <div className="flex items-center rounded-lg border border-white/10 bg-black/30 p-0.5">
                {CAMERA_PRESETS.map((preset) => {
                  const active = cameraPreset === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        soundEngine.playUiClick();
                        requestCameraPreset(preset.id);
                      }}
                      className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        active
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {!isOnline && (
              <button
                type="button"
                onClick={onResetRack}
                title="Restart Match / Re-Rack (R)"
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/12 bg-white/5 px-2.5 text-[11px] font-semibold text-slate-200 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5 text-amber-400" />
                <span>Re-Rack</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
