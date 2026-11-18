import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';
import { FpsCounter } from '../src/components/FpsCounter';
import { MatchEndModal } from '../src/components/MatchEndModal';
import { MatchScoreboard } from '../src/components/MatchScoreboard';
import { SettingsModal } from '../src/components/SettingsModal';
import { BilliardBalls } from '../src/game/objects/BilliardBalls';
import { PoolTable } from '../src/game/objects/PoolTable';
import { MAX_VFX_PARTICLES, TableVfxSystem } from '../src/game/objects/TableVfxSystem';
import {
  BALL_SPECS,
  CLOTH_PHYSICS,
  POCKET_POSITIONS,
  TABLE_DIMENSIONS,
} from '../src/game/utils/constants';
import {
  GRAPHICS_QUALITY_PROFILES,
  detectRecommendedQuality,
  getGraphicsProfile,
  sanitizeGraphicsQuality,
} from '../src/game/utils/graphicsQuality';
import { computeAudioBusGains, soundEngine } from '../src/game/utils/SoundEngine';
import { useGameStore } from '../src/store/useGameStore';

function installHeadlessCanvasMock() {
  const noopGrad = { addColorStop: () => {} };
  const makeCtx = () => ({
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    shadowColor: 'transparent',
    shadowBlur: 0,
    createLinearGradient: () => noopGrad,
    createRadialGradient: () => noopGrad,
    createPattern: () => null,
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    rect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    bezierCurveTo: () => {},
    arcTo: () => {},
    arc: () => {},
    ellipse: () => {},
    clip: () => {},
    fill: () => {},
    stroke: () => {},
    fillText: () => {},
    strokeText: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    setTransform: () => {},
    setLineDash: () => {},
  });

  Object.defineProperty(globalThis, 'document', {
    value: {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 512,
            height: 512,
            getContext: () => makeCtx(),
          };
        }
        return {};
      },
    },
    configurable: true,
  });
}

function runPhysicsImmutabilityChecks() {
  assert.equal(BALL_SPECS.radius, 0.028575, 'Ball radius must remain regulation 0.028575m');
  assert.equal(BALL_SPECS.mass, 0.17, 'Ball mass must remain 0.17kg');
  assert.equal(BALL_SPECS.restitution, 0.92, 'Ball restitution unchanged');
  assert.equal(BALL_SPECS.friction, 0.055, 'Ball friction unchanged');
  assert.equal(BALL_SPECS.linearDamping, 0.0);
  assert.equal(BALL_SPECS.angularDamping, 0.0);

  assert.equal(CLOTH_PHYSICS.slideMu, 0.21);
  assert.equal(CLOTH_PHYSICS.rollMu, 0.014);
  assert.equal(CLOTH_PHYSICS.gravity, 9.81);
  assert.equal(CLOTH_PHYSICS.cushionRestitution, 0.84);

  assert.equal(TABLE_DIMENSIONS.playLength, 2.54);
  assert.equal(TABLE_DIMENSIONS.playWidth, 1.27);
  assert.equal(POCKET_POSITIONS.length, 6);
}

function runGraphicsQualityChecks() {
  const low = getGraphicsProfile('low');
  const med = getGraphicsProfile('medium');
  const high = getGraphicsProfile('high');

  assert.ok(low.dprCap < med.dprCap && med.dprCap < high.dprCap, 'DPR caps scale monotonically');
  assert.ok(
    low.shadowMapSize < med.shadowMapSize && med.shadowMapSize < high.shadowMapSize,
    'Shadow map sizes scale monotonically',
  );
  assert.ok(
    low.ballWidthSegments < med.ballWidthSegments && med.ballWidthSegments < high.ballWidthSegments,
    'Ball LOD segments scale monotonically',
  );
  assert.ok(
    low.maxVfxParticles < med.maxVfxParticles && med.maxVfxParticles <= MAX_VFX_PARTICLES,
    'VFX particle limits scale cleanly',
  );
  assert.equal(high.maxVfxParticles, MAX_VFX_PARTICLES);
  assert.equal(low.shadowsAllowed, false);
  assert.equal(med.shadowsAllowed, true);
  assert.equal(high.useRectAreaLight, true);
  assert.equal(med.useRectAreaLight, false);

  assert.equal(
    detectRecommendedQuality({ isSoftwareGl: true, deviceMemoryGb: 16, hardwareConcurrency: 12 }),
    'low',
    'Software GL always recommends low preset',
  );
  assert.equal(
    detectRecommendedQuality({ isMobileViewport: true, deviceMemoryGb: 2, hardwareConcurrency: 4 }),
    'low',
    'Low-RAM mobile recommends low preset',
  );
  assert.equal(
    detectRecommendedQuality({ isMobileViewport: true, deviceMemoryGb: 6, hardwareConcurrency: 8 }),
    'medium',
    'Mid/high mobile recommends medium preset',
  );
  assert.equal(
    detectRecommendedQuality({ isMobileViewport: false, deviceMemoryGb: 16, hardwareConcurrency: 8 }),
    'high',
    'Desktop with 16GB/8 cores recommends high preset',
  );

  assert.equal(sanitizeGraphicsQuality('low'), 'low');
  assert.equal(sanitizeGraphicsQuality('medium'), 'medium');
  assert.equal(sanitizeGraphicsQuality('high'), 'high');
  assert.equal(sanitizeGraphicsQuality('ultra'), null);
}

function runAudioBusAndSoundEngineChecks() {
  const mutedAll = computeAudioBusGains({
    soundEnabled: false,
    soundVolume: 0.8,
    sfxVolume: 0.9,
    sfxMuted: false,
    musicVolume: 0.5,
    musicMuted: false,
  });
  assert.deepEqual(mutedAll, { master: 0, sfx: 0, music: 0 });

  const sfxMutedOnly = computeAudioBusGains({
    soundEnabled: true,
    soundVolume: 0.8,
    sfxVolume: 0.9,
    sfxMuted: true,
    musicVolume: 0.5,
    musicMuted: false,
  });
  assert.equal(sfxMutedOnly.master, 0.8);
  assert.equal(sfxMutedOnly.sfx, 0);
  assert.ok(Math.abs(sfxMutedOnly.music - 0.4) < 1e-6);

  const musicMutedOnly = computeAudioBusGains({
    soundEnabled: true,
    soundVolume: 0.5,
    sfxVolume: 0.8,
    sfxMuted: false,
    musicVolume: 0.6,
    musicMuted: true,
  });
  assert.ok(Math.abs(musicMutedOnly.sfx - 0.4) < 1e-6);
  assert.equal(musicMutedOnly.music, 0);

  const clamped = computeAudioBusGains({
    soundEnabled: true,
    soundVolume: Number.NaN,
    sfxVolume: 4,
    sfxMuted: false,
    musicVolume: -1,
    musicMuted: false,
  });
  assert.deepEqual(clamped, { master: 0, sfx: 0, music: 0 });

  // Headless Node safety: triggering all audio cues must never throw without AudioContext
  soundEngine.unlock();
  soundEngine.playCueStrike(0.75);
  soundEngine.playBallClack(3.8);
  soundEngine.playCushionBounce(2.4);
  soundEngine.playPocketDrop();
  soundEngine.playTurnChange(true);
  soundEngine.playTurnChange(false);
  soundEngine.playVictoryFanfare();
  soundEngine.playDefeatCue();
  soundEngine.playUiClick();
  soundEngine.dispose();
}

function runSceneObjectsInstancingAndVfxChecks() {
  installHeadlessCanvasMock();

  const table = new PoolTable('tournamentGreen', 4);
  const sights = table.getDiamondSightsMesh();
  assert.ok(sights instanceof THREE.InstancedMesh, 'Diamond sights use InstancedMesh');
  assert.equal(sights.count, 18, 'PoolTable renders 18 instanced diamond sights');
  table.setQualityProfile(GRAPHICS_QUALITY_PROFILES.low, 8);
  table.setQualityProfile(GRAPHICS_QUALITY_PROFILES.high, 8);
  table.applyTableCosmetics('table_blue_tournament', 'decor_trophy', 'championshipBlue');
  table.dispose();

  const balls = new BilliardBalls(4);
  const shadows = balls.getShadowInstancedMesh();
  assert.ok(shadows instanceof THREE.InstancedMesh, 'Ball contact shadows use InstancedMesh');
  assert.equal(shadows.count, 16, '16 ball contact shadow instances allocated');

  assert.deepEqual(balls.getGeometrySegmentCounts(), { widthSegments: 48, heightSegments: 32 });
  balls.setQualityProfile(GRAPHICS_QUALITY_PROFILES.low, 8);
  assert.deepEqual(balls.getGeometrySegmentCounts(), { widthSegments: 24, heightSegments: 16 });
  balls.setQualityProfile(GRAPHICS_QUALITY_PROFILES.medium, 8);
  assert.deepEqual(balls.getGeometrySegmentCounts(), { widthSegments: 36, heightSegments: 24 });

  // Verify smooth pocket sink scaling and full snap-back on reset/unpocket
  const cueInst = balls.balls.get(1);
  assert.ok(cueInst);
  balls.syncFromTransform(1, 1.2, TABLE_DIMENSIONS.surfaceY - 0.1, 0.6, 0, 0, 0, 1, true);
  for (let i = 0; i < 12; i++) {
    balls.update(i * 0.03, 0.03);
  }
  assert.equal(cueInst.mesh.visible, false, 'Pocketed ball fades out cleanly');
  balls.syncFromTransform(1, 0.5, TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius, 0, 0, 0, 0, 1, false);
  assert.equal(cueInst.mesh.visible, true, 'Respotted/reset ball becomes visible immediately');
  assert.equal(cueInst.visualScale, 1, 'Respotted/reset ball snaps back to full scale');
  balls.dispose();

  const vfx = new TableVfxSystem();
  vfx.setMaxParticles(24);
  assert.equal(vfx.getMaxParticles(), 24);

  vfx.emitCueStrike(0, TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius, 0, 0.25, 0.9);
  vfx.emitBallCollision(0.2, 0.1, 5.5, true);
  vfx.emitCushionImpact(0, 0.6, 3.2);
  vfx.emitPocketBurst(POCKET_POSITIONS[0].x, POCKET_POSITIONS[0].z, POCKET_POSITIONS[0].id, false);
  vfx.emitTurnPulse(0, 0, true);
  vfx.update(0.016);

  assert.ok(
    vfx.getActiveParticleCount() > 0 && vfx.getActiveParticleCount() <= 24,
    'Active particles stay strictly bounded by quality cap',
  );

  // Advance simulation beyond max particle lifetime so pool drains completely
  for (let i = 0; i < 40; i++) {
    vfx.update(0.05);
  }
  assert.equal(vfx.getActiveParticleCount(), 0, 'All pooled VFX particles expire cleanly');

  vfx.emitBallCollision(0, 0, 4.0, true);
  vfx.update(0.016);
  assert.ok(vfx.getActiveParticleCount() > 0);
  vfx.reset();
  assert.equal(vfx.getActiveParticleCount(), 0, 'Reset clears active pooled VFX immediately');
  vfx.dispose();
}

function syncTestStoreState(patch: Partial<ReturnType<typeof useGameStore.getState>>) {
  useGameStore.setState(patch);
  Object.assign(useGameStore.getInitialState(), useGameStore.getState());
}

function runSsrUiVerification() {
  // 1. FpsCounter compact vs diagnostics mode + contract check
  syncTestStoreState({
    fps: 60,
    webglStatus: 'active',
    perfStats: {
      fps: 59,
      avgFps: 58,
      frameTimeMs: 16.7,
      drawCalls: 42,
      triangles: 28500,
      geometries: 19,
      textures: 22,
      activeParticles: 11,
    },
    settings: {
      ...useGameStore.getState().settings,
      graphicsQuality: 'high',
      showFps: true,
      showDiagnostics: false,
    },
  });

  const compactHtml = renderToStaticMarkup(React.createElement(FpsCounter));
  assert.ok(compactHtml.includes('title="Development FPS Indicator"'));
  assert.ok(compactHtml.includes('FPS'));
  assert.ok(!compactHtml.includes('data-testid="perf-diagnostics-overlay"'));

  syncTestStoreState({
    settings: {
      ...useGameStore.getState().settings,
      showDiagnostics: true,
    },
  });
  const diagHtml = renderToStaticMarkup(React.createElement(FpsCounter));
  assert.ok(diagHtml.includes('title="Development FPS Indicator"'));
  assert.ok(diagHtml.includes('data-testid="perf-diagnostics-overlay"'));
  assert.ok(diagHtml.includes('16.7ms'));
  assert.ok(diagHtml.includes('28500'));
  assert.ok(diagHtml.includes('GL:OK'));

  // 2. SettingsModal Graphics Quality + Audio + Diagnostics UI
  syncTestStoreState({
    settingsOpen: true,
    autoRecommendedQuality: 'medium',
  });
  const settingsHtml = renderToStaticMarkup(
    React.createElement(SettingsModal, {
      onRestartMatch: () => {},
      onResetAllStats: () => {},
    }),
  );
  assert.ok(settingsHtml.includes('data-testid="graphics-quality-section"'));
  assert.ok(settingsHtml.includes('data-testid="graphics-tier-low"'));
  assert.ok(settingsHtml.includes('data-testid="graphics-tier-medium"'));
  assert.ok(settingsHtml.includes('data-testid="graphics-tier-high"'));
  assert.ok(settingsHtml.includes('data-testid="audio-controls-section"'));
  assert.ok(settingsHtml.includes('Master Volume'));
  assert.ok(settingsHtml.includes('SFX Volume'));
  assert.ok(settingsHtml.includes('Music Volume'));
  assert.ok(settingsHtml.includes('Performance Diagnostics Overlay'));

  // 3. MatchScoreboard turn badge without forbidden AI phrases
  syncTestStoreState({
    screen: 'playing',
    matchPhase: 'OPEN_TABLE',
    activePlayer: 'player1',
    matchConfig: {
      ...useGameStore.getState().matchConfig,
      gameMode: 'eightBall',
      opponentType: 'ai',
    },
  });
  const scoreboardHtml = renderToStaticMarkup(React.createElement(MatchScoreboard));
  assert.ok(scoreboardHtml.includes('data-testid="player-card-player1"'));
  assert.ok(scoreboardHtml.includes('data-testid="player-card-player2"'));
  assert.ok(scoreboardHtml.includes('data-testid="turn-badge-player1"'));
  assert.ok(!scoreboardHtml.includes('data-testid="turn-badge-player2"'));
  assert.ok(!scoreboardHtml.includes('is lining up'));
  assert.ok(!scoreboardHtml.includes('preparing to shoot'));

  // 4. MatchEndModal Victory vs Defeat differentiation
  syncTestStoreState({
    screen: 'playing',
    matchPhase: 'GAME_OVER',
    replayActive: false,
    winner: 'player1',
    loser: 'player2',
  });
  const winHtml = renderToStaticMarkup(
    React.createElement(MatchEndModal, {
      onPlayAgain: () => {},
      onMainMenu: () => {},
      onWatchReplay: () => {},
    }),
  );
  assert.ok(winHtml.includes('data-outcome="victory"'));
  assert.ok(winHtml.includes('Wins!'));

  syncTestStoreState({
    winner: 'player2',
    loser: 'player1',
  });
  const lossHtml = renderToStaticMarkup(
    React.createElement(MatchEndModal, {
      onPlayAgain: () => {},
      onMainMenu: () => {},
      onWatchReplay: () => {},
    }),
  );
  assert.ok(lossHtml.includes('data-outcome="defeat"'));
  assert.ok(lossHtml.includes('Defeat'));
  assert.ok(lossHtml.includes('Won This Rack'));
}

async function main() {
  runPhysicsImmutabilityChecks();
  runGraphicsQualityChecks();
  runAudioBusAndSoundEngineChecks();
  runSceneObjectsInstancingAndVfxChecks();
  runSsrUiVerification();
  console.log('verify-phase12-graphics-audio: ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
