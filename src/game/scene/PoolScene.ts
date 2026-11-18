import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { useGameStore, canLocalPlayerAct, type CueSpin } from '../../store/useGameStore';
import { multiplayerManager } from '../../multiplayer/MultiplayerManager';
import { DEFAULT_EQUIPPED_COSMETICS } from '../../multiplayer/shared/economy';
import type { OnlineBallFrame } from '../../multiplayer/shared/protocol';
import { CameraController } from '../camera/CameraController';
import { InputManager } from '../controls/InputManager';
import { BilliardBalls } from '../objects/BilliardBalls';
import { CueStick } from '../objects/CueStick';
import { PoolTable } from '../objects/PoolTable';
import { TableVfxSystem } from '../objects/TableVfxSystem';
import { VictoryEffects } from '../objects/VictoryEffects';
import { PhysicsWorld, type BallPhysicsSnapshot } from '../physics/PhysicsWorld';
import { AITurnController } from '../ai/AITurnController';
import { ReplayAnalysisOverlay } from '../replay/ReplayAnalysisOverlay';
import { formatCollisionLabel, ReplayController } from '../replay/ReplayController';
import {
  downloadTextFile,
  replayStorage,
} from '../replay/ReplayStorage';
import {
  downloadRecordedVideo,
  ReplayVideoRecorder,
} from '../replay/ReplayVideoRecorder';
import { ShotRecorder } from '../replay/ShotRecorder';
import {
  summarizeRecordedShot,
  type MatchReplayRecord,
  type ReplayBallFrame,
  type ReplayCameraMode,
  type ReplaySpeed,
} from '../replay/types';
import { getLegalTargetBalls } from '../rules/BallGroupManager';
import { MatchManager } from '../rules/MatchManager';
import { generateOfficialEightBallRack } from '../rules/RackGenerator';
import type { MatchConfig, PocketId } from '../rules/types';
import { BALL_SPECS, CUE_SPECS, POCKET_POSITIONS, TABLE_DIMENSIONS } from '../utils/constants';
import { disposeObject3D } from '../utils/dispose';
import { getGraphicsProfile, type GraphicsQuality } from '../utils/graphicsQuality';
import { createStudioFloorTexture } from '../utils/ProceduralTextures';
import { soundEngine } from '../utils/SoundEngine';

const _onlineFrames: OnlineBallFrame[] = [];

const _cueBallPos = new THREE.Vector3();
const _snapshots: BallPhysicsSnapshot[] = [];
const _raycaster = new THREE.Raycaster();
const _pointerNdc = new THREE.Vector2();
const _hitPoint = new THREE.Vector3();
const _ballPlane = new THREE.Plane(
  new THREE.Vector3(0, 1, 0),
  -(TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius),
);

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

export class PoolScene {
  private container: HTMLElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private isSoftwareGl: boolean;

  private poolTable!: PoolTable;
  private billiardBalls!: BilliardBalls;
  private cueStick!: CueStick;
  private tableVfx = new TableVfxSystem();
  private victoryEffects = new VictoryEffects();
  private physics!: PhysicsWorld;
  private cameraController!: CameraController;
  private inputManager!: InputManager;
  private keyLight!: THREE.DirectionalLight;
  private softboxLight: THREE.RectAreaLight | null = null;
  private floorTexture: THREE.CanvasTexture | null = null;
  private rendererMaxAnisotropy = 4;

  // Authoritative 8-ball match state machine & AI turn orchestrator
  private matchManager: MatchManager;
  private aiTurnController: AITurnController | null = null;
  private shotSequence = 0;

  // Phase 6 & 13: Isolated Shot & Match Recording, Replay, Camera & Video Capture
  private shotRecorder = new ShotRecorder();
  private replayController = new ReplayController();
  private replayAnalysisOverlay = new ReplayAnalysisOverlay();
  private videoRecorder = new ReplayVideoRecorder();
  private replayFramesScratch: ReplayBallFrame[] = [];
  private replayCueBallPos = new THREE.Vector3();
  private replayFocusBallPos = new THREE.Vector3();
  private lastReplayUiSyncAt = 0;
  private lastReplayAnalysisShotId: string | null = null;
  private lastOnlineShotSeqRecorded = -1;
  private currentMatchId = `match_${Date.now()}`;
  private activeMatchReplayRecord: MatchReplayRecord | null = null;
  private replayReturnScreen: 'menu' | 'playing' = 'playing';
  private replayCameraMode: ReplayCameraMode = 'original';
  private replayElapsedWallSec = 0;
  private lastSavedReplayReqSeq = 0;

  // 3D Ball-in-Hand placement visuals & Called Pocket ring
  private placementGroup = new THREE.Group();
  private placementRing!: THREE.Mesh;
  private placementRingMat!: THREE.MeshBasicMaterial;
  private ghostCueMesh!: THREE.Mesh;
  private kitchenLineMesh!: THREE.Mesh;
  private calledPocketRing!: THREE.Mesh;

  private clock = new THREE.Clock();
  private frameId = 0;
  private disposed = false;

  // FPS & diagnostics tracking
  private fpsFrames = 0;
  private fpsTimer = 0;
  private perfFrameTimeAccumMs = 0;
  private avgFpsEma = 60;

  // Canvas pointer tracking (supports tap-to-aim, 360° drag-to-aim, Ball-in-Hand placement, and OrbitControls separation)
  private pointerDownPos: { x: number; y: number; id: number } | null = null;
  private aimDragState: { active: boolean; id: number; lastX: number; moved: boolean } = {
    active: false,
    id: -1,
    lastX: 0,
    moved: false,
  };
  private placementDragState: { active: boolean; id: number } = {
    active: false,
    id: -1,
  };
  private onCanvasPointerDownBound: (e: PointerEvent) => void;
  private onCanvasPointerMoveBound: (e: PointerEvent) => void;
  private onCanvasPointerUpBound: (e: PointerEvent) => void;

  // Synchronized drag-release strike animation state
  private strikeAnim: {
    active: boolean;
    phase: 'thrust' | 'followThrough';
    progress: number;
    startTipDist: number;
    contactDist: number;
    tipDist: number;
    power: number;
    angle: number;
    spin: CueSpin;
    impulseApplied: boolean;
    visualOnly: boolean;
  } = {
    active: false,
    phase: 'thrust',
    progress: 0,
    startTipDist: BALL_SPECS.radius + CUE_SPECS.idleStandoff,
    contactDist: BALL_SPECS.radius,
    tipDist: BALL_SPECS.radius + CUE_SPECS.idleStandoff,
    power: 0,
    angle: 0,
    spin: { x: 0, y: 0 },
    impulseApplied: false,
    visualOnly: false,
  };

  private unsubStore: (() => void) | null = null;
  private lastCamCounter = 0;
  private lastFeltTheme = useGameStore.getState().settings.feltTheme;
  private lastGraphicsQuality = useGameStore.getState().settings.graphicsQuality;
  private lastShadowsEnabled = useGameStore.getState().settings.shadowsEnabled;
  private lastSensitivity = useGameStore.getState().settings.cameraSensitivity;
  private lastScreen = useGameStore.getState().screen;
  private lastMatchConfig = useGameStore.getState().matchConfig;
  private lastActivePlayer = useGameStore.getState().activePlayer;
  private lastSentCueAngle = useGameStore.getState().cueAngle;
  private lastSentSpinX = useGameStore.getState().cueSpin.x;
  private lastSentSpinY = useGameStore.getState().cueSpin.y;
  private lastRemoteShotSeqAnim = -1;
  private wasBallsMoving = false;
  private lastAppliedCueId = DEFAULT_EQUIPPED_COSMETICS.cueId;
  private lastAppliedBallId = DEFAULT_EQUIPPED_COSMETICS.ballId;
  private lastAppliedTableId = DEFAULT_EQUIPPED_COSMETICS.tableId;
  private lastAppliedDecorId = DEFAULT_EQUIPPED_COSMETICS.decorationId;
  private lastMatchPhaseForVictory = useGameStore.getState().matchPhase;
  private lastSettingsOpen = useGameStore.getState().settingsOpen;

  private resizeObserver: ResizeObserver | null = null;
  private resizeRafId = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private onObserverResizeBound: () => void;
  private onContextLostBound: (e: Event) => void;
  private onContextRestoredBound: () => void;

  constructor(container: HTMLElement, onToggleFullscreen: () => void) {
    this.container = container;
    this.isSoftwareGl = detectSoftwareWebGL();
    this.matchManager = new MatchManager(useGameStore.getState().matchConfig);
    this.onObserverResizeBound = this.scheduleResize.bind(this);
    this.onCanvasPointerDownBound = this.handleCanvasPointerDown.bind(this);
    this.onCanvasPointerMoveBound = this.handleCanvasPointerMove.bind(this);
    this.onCanvasPointerUpBound = this.handleCanvasPointerUp.bind(this);
    this.onContextLostBound = (e: Event) => {
      e.preventDefault();
      useGameStore.getState().setWebglStatus('context_lost');
    };
    this.onContextRestoredBound = () => {
      if (this.disposed) return;
      this.rebuildEnvironmentMap();
      if (!this.isSoftwareGl) {
        this.renderer.compile(this.scene, this.cameraController.camera);
      }
      useGameStore.getState().setWebglStatus(this.isSoftwareGl ? 'software' : 'active');
    };
    this.init(onToggleFullscreen);
  }

  private async init(onToggleFullscreen: () => void) {
    const store = useGameStore.getState();
    store.setLoading(true);
    store.setLoadError(null);
    store.setWebglStatus(this.isSoftwareGl ? 'software' : 'active');

    try {
      const width = Math.max(1, this.container.clientWidth);
      const height = Math.max(1, this.container.clientHeight);

      // 1. Renderer
      this.renderer = new THREE.WebGLRenderer({
        antialias: !this.isSoftwareGl,
        powerPreference: 'high-performance',
      });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.14;
      this.renderer.setPixelRatio(
        this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
      );
      this.lastWidth = width;
      this.lastHeight = height;
      this.renderer.setSize(width, height, false);
      this.renderer.shadowMap.enabled =
        !this.isSoftwareGl && store.settings.shadowsEnabled;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      this.renderer.domElement.style.display = 'block';
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.container.appendChild(this.renderer.domElement);

      // WebGL context recovery safety listeners
      this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLostBound);
      this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestoredBound);

      // Capture-phase listener so drag-to-aim / ball-in-hand can intercept before OrbitControls starts rotating
      this.renderer.domElement.addEventListener(
        'pointerdown',
        this.onCanvasPointerDownBound,
        { capture: true },
      );
      window.addEventListener('pointermove', this.onCanvasPointerMoveBound);
      window.addEventListener('pointerup', this.onCanvasPointerUpBound);
      window.addEventListener('pointercancel', this.onCanvasPointerUpBound);

      // 2. Scene & Fog
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x090d11);
      this.scene.fog = new THREE.FogExp2(0x090d11, 0.064);

      // 3. Procedural Studio Environment Map (RoomEnvironment)
      this.rebuildEnvironmentMap();

      // 4. Camera & Controls
      this.cameraController = new CameraController(
        this.renderer.domElement,
        width / height,
        this.isSoftwareGl,
      );
      this.cameraController.setSensitivity(store.settings.cameraSensitivity);

      // 5. Invisible Championship Lighting & Studio Room Floor
      this.setupLighting();
      this.rendererMaxAnisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      const initialProfile = getGraphicsProfile(store.settings.graphicsQuality);
      const initialAniso = Math.min(this.rendererMaxAnisotropy, initialProfile.maxAnisotropyCap);
      this.setupStudioRoom(initialAniso);

      // 6. 3D Objects (Table without hanging lamps, 16 Balls, Cue Stick, Pooled VFX, Match Overlays)
      this.poolTable = new PoolTable(store.settings.feltTheme, initialAniso);
      this.scene.add(this.poolTable.group);

      this.billiardBalls = new BilliardBalls(initialAniso);
      this.scene.add(this.billiardBalls.group);

      this.cueStick = new CueStick(initialAniso);
      this.scene.add(this.cueStick.group);

      this.scene.add(this.tableVfx.group);
      this.scene.add(this.victoryEffects.group);
      this.syncCosmeticsFromStore(store, true);
      this.applyQualityProfile(store.settings.graphicsQuality, store.settings.shadowsEnabled);

      this.scene.add(this.replayAnalysisOverlay.group);

      this.setupMatchOverlays();

      // 7. Rapier3D Physics World
      this.physics = new PhysicsWorld();
      await this.physics.init((ballNumber, _pocketId) => {
        const st = useGameStore.getState();
        st.addPocketedBall(ballNumber);
      });
      this.physics.setVisualEventListener({
        onCollision: (kind, _ballA, _ballB, x, z, impactSpeed) => {
          if (this.disposed) return;
          if (kind === 'cushion') {
            this.tableVfx.emitCushionImpact(x, z, impactSpeed);
          } else {
            this.tableVfx.emitBallCollision(x, z, impactSpeed, kind === 'cue_ball');
          }
        },
        onPocket: (ballNumber, pocketId, x, z) => {
          if (this.disposed) return;
          this.tableVfx.emitPocketBurst(x, z, pocketId, ballNumber === 8);
        },
      });

      if (this.disposed) return;

      this.aiTurnController = new AITurnController(this.matchManager, this.physics, {
        isDisposed: () => this.disposed,
        onExecuteStrike: (power, angle, spin) => this.executeStrike(power, angle, spin),
      });

      // Sync initial menu snapshot
      useGameStore.getState().syncFromMatchSnapshot(this.matchManager.getSnapshot());

      // 8. Input Manager
      this.inputManager = new InputManager({
        onStartMatch: () => this.startMatch(),
        onResetRack: () => this.resetRack(),
        onConfirmCuePlacement: () => this.confirmCuePlacement(),
        onToggleFullscreen,
        onToggleReplayPlay: () => this.toggleReplayPlay(),
        onRestartReplay: () => this.restartReplay(),
        onExitReplay: () => this.exitReplay(),
      });

      // 8b. Attach online multiplayer bridge
      multiplayerManager.attachSceneBridge({
        onApplyAuthoritativeBalls: (balls) => {
          this.physics.syncAllFromServerFrames(balls);
          if (this.replayController.isActive()) return;
          for (const b of balls) {
            this.billiardBalls.syncFromTransform(
              b.number,
              b.x,
              b.y,
              b.z,
              b.qx,
              b.qy,
              b.qz,
              b.qw,
              b.pocketed,
            );
          }
        },
        onOnlineMatchEntered: (snapshot, balls) => {
          this.aiTurnController?.cancel();
          this.victoryEffects.stop();
          this.tableVfx.reset();
          this.lastActivePlayer = snapshot.activePlayer;
          if (this.replayController.isActive()) {
            this.exitReplay();
          }
          if (snapshot.totalMatchShots === 0) {
            this.currentMatchId = snapshot.matchId;
            this.activeMatchReplayRecord = null;
            this.shotRecorder.clearMatchShots();
            const stNow = useGameStore.getState();
            const onlineRoom = stNow.onlineRoom;
            const p1Rec = onlineRoom?.players.find((p) => p.role === 'player1');
            const p2Rec = onlineRoom?.players.find((p) => p.role === 'player2');
            this.shotRecorder.beginMatch({
              matchId: snapshot.matchId,
              createdAtMs: Date.now(),
              matchType: 'online',
              onlineSubType: onlineRoom?.matchType,
              gameMode: 'eightBall',
              ruleProfileId: snapshot.ruleProfileId,
              calledShotsEnabled: snapshot.calledShotsEnabled,
              authoritative: true,
              player1Id: p1Rec?.playerId ?? null,
              player1Name: snapshot.player1Name,
              player2Id: p2Rec?.playerId ?? null,
              player2Name: snapshot.player2Name,
            });
            this.lastOnlineShotSeqRecorded = -1;
            stNow.setReplayShots([]);
          }
          this.strikeAnim.active = false;
          this.strikeAnim.impulseApplied = false;
          this.wasBallsMoving = false;
          this.lastRemoteShotSeqAnim = -1;
          this.syncCosmeticsFromStore(useGameStore.getState());
          this.physics.syncAllFromServerFrames(balls);
          for (const b of balls) {
            this.billiardBalls.syncFromTransform(
              b.number,
              b.x,
              b.y,
              b.z,
              b.qx,
              b.qy,
              b.qz,
              b.qw,
              b.pocketed,
            );
          }
        },
        onRemoteShotStarted: (payload) => {
          const st = useGameStore.getState();
          if (payload.shotSeq !== this.lastOnlineShotSeqRecorded) {
            this.lastOnlineShotSeqRecorded = payload.shotSeq;
            const shooterName =
              payload.shooter === 'player1'
                ? st.matchConfig.player1Name || 'Player 1'
                : st.matchConfig.player2Name || 'Player 2';
            this.shotRecorder.beginShot({
              shotNumber: st.shotCount + 1,
              mode: 'online',
              shooter: payload.shooter,
              shooterName,
              isBreakShot: st.isBreakShot,
              cueAngle: payload.cueAngle,
              power: payload.power,
              spin: { x: payload.spinX, y: payload.spinY },
              calledShot: st.calledShot,
            });
            const preShotBalls = multiplayerManager.synchronizer.getLatestSettledBalls();
            if (preShotBalls && preShotBalls.length > 0) {
              this.shotRecorder.pushOnlineSample(preShotBalls);
            }
          }

          if (
            !this.replayController.isActive() &&
            payload.shooter !== st.onlineLocalRole &&
            payload.shotSeq !== this.lastRemoteShotSeqAnim
          ) {
            this.lastRemoteShotSeqAnim = payload.shotSeq;
            st.setCueAngle(payload.cueAngle);
            st.setCueSpin(payload.spinX, payload.spinY);
            this.startStrikeVisualOnly(payload.power, payload.cueAngle, {
              x: payload.spinX,
              y: payload.spinY,
            });
          }
        },
        onOnlineShotFrame: (balls) => {
          this.shotRecorder.pushOnlineSample(balls);
        },
        onOnlinePocketEvent: (ballNumber, pocketId) => {
          this.shotRecorder.recordPocket(ballNumber, pocketId);
          soundEngine.playPocketDrop();
          const pPos = POCKET_POSITIONS.find((p) => p.id === pocketId);
          if (pPos) {
            this.tableVfx.emitPocketBurst(pPos.x, pPos.z, pocketId, ballNumber === 8);
          }
        },
        onOnlineShotSettled: (snapshot, balls) => {
          const st = useGameStore.getState();
          if (this.shotRecorder.isRecording() && this.shotRecorder.getActiveMode() === 'online') {
            const isFoul = Boolean(snapshot.lastFoulMessage);
            const resultLabel = snapshot.winner
              ? `${snapshot.winner === 'player1' ? snapshot.player1Name : snapshot.player2Name} Wins`
              : isFoul
                ? snapshot.lastFoulMessage ?? 'Foul'
                : snapshot.statusHeadline || 'Shot Complete';
            const rec = this.shotRecorder.finalizeShot({
              resultLabel,
              isFoul,
              foulReason: snapshot.lastFoulMessage,
              finalOnlineBalls: balls,
              tableOpenAfter: snapshot.tableOpen,
              playerGroupsAfter: snapshot.playerGroups,
              pocketedNumbersAfter: snapshot.pocketedNumbers,
              activePlayerAfter: snapshot.activePlayer,
              ballInHandNext: snapshot.phase === 'BALL_IN_HAND',
            });
            if (rec) {
              if (snapshot.phase === 'BALL_IN_HAND') {
                const nextName =
                  snapshot.activePlayer === 'player1'
                    ? snapshot.player1Name
                    : snapshot.player2Name;
                this.shotRecorder.recordBallInHand(
                  snapshot.activePlayer,
                  nextName,
                  snapshot.lastFoulMessage,
                );
              }
              st.setReplayShots(this.shotRecorder.getSummariesNewestFirst());
            }
          }
          if (
            snapshot.phase === 'GAME_OVER' &&
            !this.shotRecorder.hasMatchBeenSaved(snapshot.matchId)
          ) {
            this.shotRecorder.markMatchSaved(snapshot.matchId);
            const built = this.shotRecorder.buildMatchReplayRecord({
              matchId: snapshot.matchId,
              winner: snapshot.winner,
              loser: snapshot.loser,
              finalResult: snapshot.gameOverReason ?? snapshot.statusHeadline ?? 'Online Match Complete',
              playerGroups: snapshot.playerGroups,
              pocketedNumbers: snapshot.pocketedNumbers,
              player1Name: snapshot.player1Name,
              player2Name: snapshot.player2Name,
              authoritative: true,
              localPlayerPerspective: st.onlineLocalRole,
            });
            if (built) {
              this.activeMatchReplayRecord = built;
              void replayStorage
                .saveReplay(built)
                .then(() => this.refreshSavedReplaysIndex())
                .catch(() => {});
            }
          }
        },
        onRemoteAimPreview: (cueAngle) => {
          const st = useGameStore.getState();
          if (
            !this.replayController.isActive() &&
            st.matchConfig.opponentType === 'online' &&
            !canLocalPlayerAct(st) &&
            !this.strikeAnim.active
          ) {
            st.setCueAngle(cueAngle);
          }
        },
        onRemoteSpinPreview: (x, y) => {
          const st = useGameStore.getState();
          if (
            !this.replayController.isActive() &&
            st.matchConfig.opponentType === 'online' &&
            !canLocalPlayerAct(st)
          ) {
            st.setCueSpin(x, y);
          }
        },
        onOnlineMatchExited: () => {
          this.victoryEffects.stop();
          this.tableVfx.reset();
          if (this.replayController.isActive()) {
            this.exitReplay();
          }
          this.shotRecorder.clearMatchShots();
          this.lastOnlineShotSeqRecorded = -1;
          this.strikeAnim.active = false;
          this.wasBallsMoving = false;
          this.physics.resetRack(generateOfficialEightBallRack());
          this.syncCosmeticsFromStore(useGameStore.getState());
        },
      });

      // 9. Store subscription for live UI settings, match config & camera presets
      this.unsubStore = useGameStore.subscribe((state) => {
        if (
          state.pendingSavedReplayRequest &&
          state.pendingSavedReplayRequest.seq !== this.lastSavedReplayReqSeq
        ) {
          this.lastSavedReplayReqSeq = state.pendingSavedReplayRequest.seq;
          const reqId = state.pendingSavedReplayRequest.replayId;
          state.clearWatchSavedReplayRequest();
          void this.enterSavedMatchReplayById(reqId);
        }
        if (state.cameraRequestCounter !== this.lastCamCounter) {
          this.lastCamCounter = state.cameraRequestCounter;
          this.physics.getCueBallPosition(_cueBallPos);
          this.cameraController.setPreset(
            state.cameraPreset,
            _cueBallPos,
            state.cueAngle,
          );
        }
        if (state.settings.feltTheme !== this.lastFeltTheme) {
          this.lastFeltTheme = state.settings.feltTheme;
          this.syncCosmeticsFromStore(state, true);
        } else {
          this.syncCosmeticsFromStore(state);
        }
        if (
          state.settings.graphicsQuality !== this.lastGraphicsQuality ||
          state.settings.shadowsEnabled !== this.lastShadowsEnabled
        ) {
          this.lastGraphicsQuality = state.settings.graphicsQuality;
          this.lastShadowsEnabled = state.settings.shadowsEnabled;
          this.applyQualityProfile(state.settings.graphicsQuality, state.settings.shadowsEnabled);
        }
        if (state.settings.cameraSensitivity !== this.lastSensitivity) {
          this.lastSensitivity = state.settings.cameraSensitivity;
          this.cameraController.setSensitivity(state.settings.cameraSensitivity);
        }
        if (state.screen !== this.lastScreen) {
          this.lastScreen = state.screen;
          if (state.screen === 'menu') {
            this.victoryEffects.stop();
            this.tableVfx.reset();
            if (this.replayController.isActive()) {
              this.exitReplay();
            }
            this.physics.setShotStepObserver(null);
            this.shotRecorder.cancelActiveRecording();
            this.aiTurnController?.cancel();
            this.matchManager.enterMenu();
          }
        }
        if (state.activePlayer !== this.lastActivePlayer) {
          const prevPlayer = this.lastActivePlayer;
          this.lastActivePlayer = state.activePlayer;
          if (
            prevPlayer &&
            state.screen === 'playing' &&
            state.matchConfig.gameMode === 'eightBall' &&
            state.matchPhase !== 'GAME_OVER' &&
            state.matchPhase !== 'MENU' &&
            !this.replayController.isActive()
          ) {
            const isLocalTurn =
              state.matchConfig.opponentType === 'online'
                ? state.activePlayer === state.onlineLocalRole
                : state.matchConfig.opponentType === 'ai'
                  ? state.activePlayer === 'player1'
                  : true;
            soundEngine.playTurnChange(isLocalTurn);
            if (this.physics.isCueBallAvailable()) {
              this.physics.getCueBallPosition(_cueBallPos);
              this.tableVfx.emitTurnPulse(_cueBallPos.x, _cueBallPos.z, isLocalTurn);
            }
          }
        }
        if (state.matchPhase !== this.lastMatchPhaseForVictory) {
          const prevPhase = this.lastMatchPhaseForVictory;
          this.lastMatchPhaseForVictory = state.matchPhase;
          if (
            state.matchPhase === 'GAME_OVER' &&
            state.screen === 'playing' &&
            prevPhase !== 'GAME_OVER'
          ) {
            const isVictory =
              state.matchConfig.opponentType === 'online'
                ? state.winner === state.onlineLocalRole
                : state.matchConfig.opponentType === 'ai'
                  ? state.winner === 'player1'
                  : true;

            if (isVictory) {
              let victoryId = state.equippedCosmetics.victoryId;
              if (state.matchConfig.opponentType === 'online' && state.onlineRoom && state.winner) {
                const winnerPlayer = state.onlineRoom.players.find((p) => p.role === state.winner);
                victoryId = winnerPlayer?.equippedCosmetics?.victoryId ?? victoryId;
              }
              this.victoryEffects.play(victoryId);
              soundEngine.playVictoryFanfare();
            } else {
              this.victoryEffects.stop();
              soundEngine.playDefeatCue();
            }
          } else if (state.matchPhase !== 'GAME_OVER') {
            this.victoryEffects.stop();
          }
        }
        if (state.matchConfig !== this.lastMatchConfig) {
          const prevOpponent = this.lastMatchConfig.opponentType;
          this.lastMatchConfig = state.matchConfig;
          if (state.matchConfig.opponentType !== 'online') {
            this.matchManager.updateConfig(state.matchConfig);
          }

          if (
            state.screen === 'playing' &&
            state.matchConfig.opponentType !== 'online' &&
            prevOpponent !== state.matchConfig.opponentType
          ) {
            if (state.matchConfig.opponentType === 'pvp') {
              this.aiTurnController?.cancel();
            } else if (!this.physics.areAnyBallsMoving() && !this.strikeAnim.active) {
              this.scheduleAiTurnIfNeeded();
            }
          }
        }

        if (state.settingsOpen !== this.lastSettingsOpen) {
          this.lastSettingsOpen = state.settingsOpen;
          if (state.settingsOpen) {
            this.aiTurnController?.cancel();
          } else if (
            state.screen === 'playing' &&
            state.matchConfig.opponentType === 'ai' &&
            !this.physics.areAnyBallsMoving() &&
            !this.strikeAnim.active
          ) {
            this.scheduleAiTurnIfNeeded();
          }
        }

        // Throttled aim & spin sync during local player's online turn
        if (
          state.screen === 'playing' &&
          state.matchConfig.opponentType === 'online' &&
          canLocalPlayerAct(state) &&
          !state.ballsMoving &&
          !this.strikeAnim.active
        ) {
          if (Math.abs(state.cueAngle - this.lastSentCueAngle) > 0.002) {
            this.lastSentCueAngle = state.cueAngle;
            multiplayerManager.sendAimPreview(state.cueAngle);
          }
          if (
            Math.abs(state.cueSpin.x - this.lastSentSpinX) > 0.01 ||
            Math.abs(state.cueSpin.y - this.lastSentSpinY) > 0.01
          ) {
            this.lastSentSpinX = state.cueSpin.x;
            this.lastSentSpinY = state.cueSpin.y;
            multiplayerManager.sendSpinPreview(state.cueSpin.x, state.cueSpin.y);
          }
        }
      });

      // 10. Pre-compile shaders on hardware WebGL
      if (!this.isSoftwareGl) {
        this.renderer.compile(this.scene, this.cameraController.camera);
      }

      // 11. Resize listeners (ResizeObserver deferred to rAF to avoid resize-loop notifications)
      window.addEventListener('resize', this.onObserverResizeBound);
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(this.onObserverResizeBound);
        this.resizeObserver.observe(this.container);
      }

      useGameStore.getState().setLoading(false);
      void this.refreshSavedReplaysIndex();
      this.clock.start();
      this.startLoop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to initialize 3D WebGL / Physics engine';
      useGameStore.getState().setLoadError(msg);
      useGameStore.getState().setLoading(false);
    }
  }

  private setupMatchOverlays() {
    const D = TABLE_DIMENSIONS;
    const R = BALL_SPECS.radius;

    // Placement ring around cue ball
    const ringGeo = new THREE.RingGeometry(R * 1.18, R * 1.68, 36);
    ringGeo.rotateX(-Math.PI / 2);
    this.placementRingMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.placementRing = new THREE.Mesh(ringGeo, this.placementRingMat);
    this.placementRing.position.y = D.surfaceY + 0.0022;
    this.placementGroup.add(this.placementRing);

    // Translucent ghost indicator when hovering invalid zone
    const ghostGeo = new THREE.SphereGeometry(R, 24, 16);
    const ghostMat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    this.ghostCueMesh = new THREE.Mesh(ghostGeo, ghostMat);
    this.ghostCueMesh.visible = false;
    this.placementGroup.add(this.ghostCueMesh);

    // Kitchen head string line (visible when Ball-in-Hand zone is 'kitchen')
    const lineGeo = new THREE.PlaneGeometry(0.008, D.playWidth - 0.02);
    lineGeo.rotateX(-Math.PI / 2);
    const lineMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.52,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.kitchenLineMesh = new THREE.Mesh(lineGeo, lineMat);
    this.kitchenLineMesh.position.set(D.headSpotX, D.surfaceY + 0.0018, 0);
    this.kitchenLineMesh.visible = false;
    this.placementGroup.add(this.kitchenLineMesh);

    this.placementGroup.visible = false;
    this.scene.add(this.placementGroup);

    // Subtle 3D Called-Pocket Highlight Ring
    const pocketRingGeo = new THREE.RingGeometry(0.068, 0.084, 36);
    pocketRingGeo.rotateX(-Math.PI / 2);
    const pocketRingMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.calledPocketRing = new THREE.Mesh(pocketRingGeo, pocketRingMat);
    this.calledPocketRing.position.y = D.surfaceY + 0.0025;
    this.calledPocketRing.visible = false;
    this.scene.add(this.calledPocketRing);
  }

  private raycastBallPlane(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    _pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    _pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    _raycaster.setFromCamera(_pointerNdc, this.cameraController.camera);
    return _raycaster.ray.intersectPlane(_ballPlane, _hitPoint);
  }

  private isNearCueCorridor(hit: THREE.Vector3, cuePos: THREE.Vector3, aimAngle: number): boolean {
    const dx = hit.x - cuePos.x;
    const dz = hit.z - cuePos.z;
    const distToCue = Math.hypot(dx, dz);
    if (distToCue < 0.24) return true;

    const fx = Math.cos(aimAngle);
    const fz = Math.sin(aimAngle);
    const along = dx * fx + dz * fz;
    const perp = Math.abs(-dx * fz + dz * fx);
    return along >= -1.5 && along <= 1.25 && perp <= 0.14;
  }

  private updateBallInHandHover(hitX: number, hitZ: number) {
    const store = useGameStore.getState();
    const zone = store.ballInHandZone;
    const check = this.physics.validateCueBallPlacement(hitX, hitZ, zone);
    store.setCuePlacementPreview(
      check.valid ? check.clampedX : hitX,
      check.valid ? check.clampedZ : hitZ,
      check.valid,
      check.reason ?? null,
    );
    if (check.valid) {
      this.physics.setCueBallPlacement(check.clampedX, check.clampedZ);
      if (store.matchConfig.opponentType === 'online' && canLocalPlayerAct(store)) {
        multiplayerManager.sendCuePlacement(check.clampedX, check.clampedZ, false);
      }
    }
  }

  private canShootCurrentMode(): boolean {
    const store = useGameStore.getState();
    if (store.matchConfig.opponentType === 'online') {
      if (!canLocalPlayerAct(store)) return false;
      return (
        store.matchPhase === 'BREAK' ||
        store.matchPhase === 'OPEN_TABLE' ||
        store.matchPhase === 'GROUPS_ASSIGNED'
      );
    }
    return this.matchManager.canShoot();
  }

  private handleCanvasPointerDown(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    const store = useGameStore.getState();
    this.pointerDownPos = { x: e.clientX, y: e.clientY, id: e.pointerId };

    if (
      store.screen !== 'playing' ||
      store.settingsOpen ||
      store.replayActive ||
      this.replayController.isActive() ||
      store.ballsMoving ||
      store.isDraggingCue ||
      store.isShotAnimating ||
      store.isAiThinking ||
      !canLocalPlayerAct(store) ||
      store.matchPhase === 'GAME_OVER' ||
      this.strikeAnim.active
    ) {
      return;
    }

    const hit = this.raycastBallPlane(e.clientX, e.clientY);

    // Ball-in-Hand drag placement near cue ball or on felt
    if (store.matchPhase === 'BALL_IN_HAND' && hit) {
      const D = TABLE_DIMENSIONS;
      if (Math.abs(hit.x) <= D.halfLength + 0.08 && Math.abs(hit.z) <= D.halfWidth + 0.08) {
        const distToCurrent = Math.hypot(
          hit.x - store.cuePlacementPos.x,
          hit.z - store.cuePlacementPos.z,
        );
        if (distToCurrent < 0.38 || store.canvasInteractionMode === 'aim') {
          this.placementDragState = { active: true, id: e.pointerId };
          this.cameraController.setOrbitRotateEnabled(false);
          this.updateBallInHandHover(hit.x, hit.z);
          return;
        }
      }
      return;
    }

    if (!this.canShootCurrentMode()) return;

    this.physics.getCueBallPosition(_cueBallPos);

    const shouldEngageAimDrag =
      store.canvasInteractionMode === 'aim' ||
      (hit !== null && this.isNearCueCorridor(hit, _cueBallPos, store.cueAngle));

    if (shouldEngageAimDrag) {
      this.aimDragState = {
        active: true,
        id: e.pointerId,
        lastX: e.clientX,
        moved: false,
      };
      this.cameraController.setOrbitRotateEnabled(false);
    }
  }

  private handleCanvasPointerMove(e: PointerEvent) {
    const store = useGameStore.getState();

    if (this.placementDragState.active && this.placementDragState.id === e.pointerId) {
      if (store.matchPhase !== 'BALL_IN_HAND') return;
      const hit = this.raycastBallPlane(e.clientX, e.clientY);
      if (hit) {
        this.updateBallInHandHover(hit.x, hit.z);
      }
      return;
    }

    if (!this.aimDragState.active || this.aimDragState.id !== e.pointerId) return;

    if (
      store.screen !== 'playing' ||
      store.ballsMoving ||
      store.isDraggingCue ||
      store.isShotAnimating ||
      store.isAiThinking ||
      !canLocalPlayerAct(store) ||
      !this.canShootCurrentMode() ||
      this.strikeAnim.active
    ) {
      return;
    }

    const dxPx = e.clientX - this.aimDragState.lastX;
    this.aimDragState.lastX = e.clientX;
    if (
      Math.hypot(
        e.clientX - (this.pointerDownPos?.x ?? e.clientX),
        e.clientY - (this.pointerDownPos?.y ?? e.clientY),
      ) > 4
    ) {
      this.aimDragState.moved = true;
    }

    const hit = this.raycastBallPlane(e.clientX, e.clientY);
    this.physics.getCueBallPosition(_cueBallPos);

    if (
      hit &&
      Math.abs(hit.x) <= 2.6 &&
      Math.abs(hit.z) <= 1.8 &&
      this.cameraController.camera.position.y > TABLE_DIMENSIONS.surfaceY + 0.55
    ) {
      const aimDx = hit.x - _cueBallPos.x;
      const aimDz = hit.z - _cueBallPos.z;
      if (Math.hypot(aimDx, aimDz) > 0.04) {
        store.setCueAngle(Math.atan2(aimDz, aimDx));
        return;
      }
    }

    store.adjustCueAngle(dxPx * 0.0075);
  }

  private handleCanvasPointerUp(e: PointerEvent) {
    if (this.placementDragState.active && this.placementDragState.id === e.pointerId) {
      this.placementDragState.active = false;
      this.placementDragState.id = -1;
      this.cameraController.setOrbitRotateEnabled(true);
      this.pointerDownPos = null;
      return;
    }

    if (this.aimDragState.active && this.aimDragState.id === e.pointerId) {
      const wasDrag = this.aimDragState.moved;
      this.aimDragState.active = false;
      this.aimDragState.id = -1;
      this.cameraController.setOrbitRotateEnabled(true);
      if (wasDrag) {
        this.pointerDownPos = null;
        return;
      }
    }

    if (!this.pointerDownPos || this.pointerDownPos.id !== e.pointerId) return;
    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    this.pointerDownPos = null;

    if (Math.hypot(dx, dy) > 7) return;

    const store = useGameStore.getState();
    if (
      store.screen !== 'playing' ||
      store.settingsOpen ||
      store.ballsMoving ||
      store.isDraggingCue ||
      store.isShotAnimating ||
      store.isAiThinking ||
      !canLocalPlayerAct(store) ||
      store.matchPhase === 'GAME_OVER' ||
      this.strikeAnim.active
    ) {
      return;
    }

    const hit = this.raycastBallPlane(e.clientX, e.clientY);
    if (!hit) return;

    // Tap table felt during Ball-in-Hand to place cue ball cleanly
    if (store.matchPhase === 'BALL_IN_HAND') {
      const D = TABLE_DIMENSIONS;
      if (Math.abs(hit.x) <= D.halfLength + 0.05 && Math.abs(hit.z) <= D.halfWidth + 0.05) {
        soundEngine.unlock();
        soundEngine.playUiClick();
        this.updateBallInHandHover(hit.x, hit.z);
      }
      return;
    }

    if (!this.canShootCurrentMode()) return;

    // Optional: tap directly on a pocket mouth when calledShotsEnabled to select intended pocket
    if (store.matchConfig.calledShotsEnabled) {
      for (const pocket of POCKET_POSITIONS) {
        if (Math.hypot(hit.x - pocket.x, hit.z - pocket.z) <= pocket.radius * 1.15) {
          soundEngine.unlock();
          soundEngine.playUiClick();
          const legalBalls = getLegalTargetBalls(
            store.pocketedNumbers,
            store.tableOpen,
            store.playerGroups[store.activePlayer],
          );
          const autoTargetBall =
            store.calledShot.targetBall ?? (legalBalls.length === 1 ? legalBalls[0] : null);
          this.setCalledShot(autoTargetBall, pocket.id as PocketId);
          return;
        }
      }
    }

    const maxBoundX = TABLE_DIMENSIONS.halfLength + 0.14;
    const maxBoundZ = TABLE_DIMENSIONS.halfWidth + 0.14;
    if (Math.abs(hit.x) > maxBoundX || Math.abs(hit.z) > maxBoundZ) return;

    this.physics.getCueBallPosition(_cueBallPos);
    const aimDx = hit.x - _cueBallPos.x;
    const aimDz = hit.z - _cueBallPos.z;
    if (Math.hypot(aimDx, aimDz) < 0.025) return;

    soundEngine.unlock();
    store.setCueAngle(Math.atan2(aimDz, aimDx));
  }

  /**
   * Clean invisible studio lighting rig replacing visible hanging lamps
   * while maintaining bright, natural illumination and shadows from all angles.
   */
  private setupLighting() {
    const hemiLight = new THREE.HemisphereLight(0xc2d6f0, 0x261f19, 0.85);
    this.scene.add(hemiLight);

    this.keyLight = new THREE.DirectionalLight(0xfff1dc, 2.3);
    this.keyLight.position.set(1.15, 3.65, 0.9);
    this.keyLight.castShadow =
      !this.isSoftwareGl && useGameStore.getState().settings.shadowsEnabled;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 8.5;
    this.keyLight.shadow.camera.left = -2.2;
    this.keyLight.shadow.camera.right = 2.2;
    this.keyLight.shadow.camera.top = 1.6;
    this.keyLight.shadow.camera.bottom = -1.6;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.015;
    this.keyLight.shadow.radius = 2.5;
    this.scene.add(this.keyLight);

    const fillLight = new THREE.DirectionalLight(0xb8d4f4, 0.78);
    fillLight.position.set(-2.4, 2.25, -1.8);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffe8c8, 0.56);
    rimLight.position.set(2.3, 2.15, -1.9);
    this.scene.add(rimLight);

    if (!this.isSoftwareGl) {
      RectAreaLightUniformsLib.init();
      const softbox = new THREE.RectAreaLight(0xfff3de, 3.0, 2.35, 1.05);
      softbox.position.set(0, 2.42, 0);
      softbox.lookAt(0, TABLE_DIMENSIONS.surfaceY, 0);
      this.softboxLight = softbox;
      this.scene.add(softbox);
    }

    const overheadIntensity = this.isSoftwareGl ? 2.1 : 1.42;
    for (const px of [-0.66, 0.66]) {
      const overheadPool = new THREE.PointLight(0xffedd0, overheadIntensity, 6.5, 1.4);
      overheadPool.position.set(px, 2.18, 0);
      this.scene.add(overheadPool);
    }
  }

  private rebuildEnvironmentMap() {
    if (!this.renderer || !this.scene) return;
    const prevEnv = this.envRT;
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    const roomEnv = new RoomEnvironment();
    this.envRT = pmremGenerator.fromScene(roomEnv, 0.04);
    this.scene.environment = this.envRT.texture;
    roomEnv.dispose();
    pmremGenerator.dispose();
    prevEnv?.dispose();
  }

  private applyQualityProfile(quality: GraphicsQuality, shadowsEnabled: boolean) {
    if (!this.renderer) return;
    const profile = getGraphicsProfile(quality);
    const effectiveShadows = !this.isSoftwareGl && shadowsEnabled && profile.shadowsAllowed;
    const effectiveDprCap = this.isSoftwareGl ? 1 : profile.dprCap;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, effectiveDprCap));
    this.renderer.shadowMap.enabled = effectiveShadows;

    if (this.keyLight) {
      this.keyLight.castShadow = effectiveShadows;
      if (this.keyLight.shadow.mapSize.x !== profile.shadowMapSize) {
        this.keyLight.shadow.map?.dispose();
        this.keyLight.shadow.map = null;
        this.keyLight.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
      }
    }

    if (this.softboxLight) {
      this.softboxLight.visible = !this.isSoftwareGl && profile.useRectAreaLight;
    }

    const aniso = Math.min(this.rendererMaxAnisotropy, profile.maxAnisotropyCap);
    if (this.floorTexture && this.floorTexture.anisotropy !== aniso) {
      this.floorTexture.anisotropy = aniso;
      this.floorTexture.needsUpdate = true;
    }

    this.poolTable?.setQualityProfile(profile, this.rendererMaxAnisotropy);
    this.billiardBalls?.setQualityProfile(profile, this.rendererMaxAnisotropy);
    this.tableVfx.setMaxParticles(profile.maxVfxParticles);
  }

  private setupStudioRoom(maxAnisotropy: number) {
    const floorTex = createStudioFloorTexture(maxAnisotropy);
    this.floorTexture = floorTex;
    const floorGeo = new THREE.CircleGeometry(14, 48);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.72,
      metalness: 0.08,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = 0;
    floor.receiveShadow = true;
    floor.name = 'StudioFloor';
    this.scene.add(floor);
  }

  // ==================== MATCH LIFECYCLE API ====================

  public startMatch(overrideConfig?: Partial<MatchConfig>) {
    const store = useGameStore.getState();
    const effectiveOpponent =
      overrideConfig?.opponentType ??
      (store.matchConfig.opponentType === 'online' ? 'pvp' : store.matchConfig.opponentType);
    if (store.matchConfig.opponentType === 'online' && overrideConfig?.opponentType !== 'online') {
      multiplayerManager.leaveMatchOrRoom();
    }

    this.aiTurnController?.cancel();
    this.victoryEffects.stop();
    this.tableVfx.reset();
    if (this.replayController.isActive()) {
      this.replayController.exitReplay();
      this.replayAnalysisOverlay.clear();
      this.replayAnalysisOverlay.update(false, 0);
    }
    this.physics.setShotStepObserver(null);
    this.shotRecorder.clearMatchShots();

    const mergedConfig: Partial<MatchConfig> = {
      ...store.matchConfig,
      ...overrideConfig,
      opponentType: effectiveOpponent,
    };

    this.strikeAnim.active = false;
    this.strikeAnim.impulseApplied = false;
    this.strikeAnim.visualOnly = false;
    this.wasBallsMoving = false;

    const rack = generateOfficialEightBallRack();
    this.physics.resetRack(rack);

    const snapshot = this.matchManager.startMatch(mergedConfig);
    this.lastActivePlayer = snapshot.activePlayer;
    store.resetMatchStats();
    const postResetStore = useGameStore.getState();
    this.currentMatchId =
      effectiveOpponent === 'ai'
        ? postResetStore.aiMatchClientId
        : `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.activeMatchReplayRecord = null;
    this.shotRecorder.beginMatch({
      matchId: this.currentMatchId,
      createdAtMs: Date.now(),
      matchType: effectiveOpponent === 'ai' ? 'ai' : 'local',
      aiDifficulty: snapshot.config.aiDifficulty,
      gameMode: snapshot.config.gameMode,
      ruleProfileId: snapshot.config.ruleProfileId,
      calledShotsEnabled: snapshot.config.calledShotsEnabled,
      authoritative: false,
      player1Id: postResetStore.ownProfile?.playerId ?? null,
      player1Name: this.matchManager.getPlayerName('player1'),
      player2Name: this.matchManager.getPlayerName('player2'),
    });
    store.setBallsMoving(false);
    store.setIsAiThinking(false);
    store.setScreen('playing');
    store.syncFromMatchSnapshot(snapshot);

    this.scheduleAiTurnIfNeeded();
  }

  public resetRack() {
    const store = useGameStore.getState();
    if (store.matchConfig.opponentType === 'online') {
      return; // Re-Rack disabled in authoritative online matches
    }
    soundEngine.unlock();
    soundEngine.playUiClick();
    this.startMatch(store.matchConfig);
  }

  public setCalledShot(targetBall: number | null, targetPocket: PocketId | null) {
    const store = useGameStore.getState();
    if (store.matchConfig.opponentType === 'online') {
      if (!canLocalPlayerAct(store)) return;
      store.setCalledShotSelection(targetBall, targetPocket);
      multiplayerManager.sendCalledShot(targetBall, targetPocket);
      return;
    }
    const snapshot = this.matchManager.setCalledShot(targetBall, targetPocket);
    store.syncFromMatchSnapshot(snapshot);
  }

  public placeCueAtHeadSpot() {
    const store = useGameStore.getState();
    if (
      store.matchPhase !== 'BALL_IN_HAND' ||
      store.isAiThinking ||
      !canLocalPlayerAct(store) ||
      this.matchManager.isActivePlayerAi()
    ) {
      return;
    }
    soundEngine.unlock();
    soundEngine.playUiClick();
    const spot = this.physics.findNearestValidCuePlacement(store.ballInHandZone);
    this.physics.setCueBallPlacement(spot.x, spot.z);
    store.setCuePlacementPreview(spot.x, spot.z, true, null);
    if (store.matchConfig.opponentType === 'online') {
      multiplayerManager.sendCuePlacement(spot.x, spot.z, false);
    }
  }

  public confirmCuePlacement() {
    const store = useGameStore.getState();
    if (
      store.matchPhase !== 'BALL_IN_HAND' ||
      store.isAiThinking ||
      !canLocalPlayerAct(store) ||
      this.matchManager.isActivePlayerAi()
    ) {
      return;
    }
    if (!store.cuePlacementValid) return;

    soundEngine.unlock();
    soundEngine.playUiClick();
    this.physics.setCueBallPlacement(store.cuePlacementPos.x, store.cuePlacementPos.z);
    if (store.matchConfig.opponentType === 'online') {
      multiplayerManager.sendCuePlacement(
        store.cuePlacementPos.x,
        store.cuePlacementPos.z,
        true,
      );
      return;
    }
    const snapshot = this.matchManager.confirmBallInHandPlacement();
    store.syncFromMatchSnapshot(snapshot);
  }

  public resetAllStats() {
    const snapshot = this.matchManager.resetAllTimeStats();
    useGameStore.getState().syncFromMatchSnapshot(snapshot);
  }

  public triggerDragShot(power: number) {
    const store = useGameStore.getState();
    if (
      power <= 0 ||
      store.replayActive ||
      this.replayController.isActive() ||
      this.strikeAnim.active ||
      store.isShotAnimating ||
      store.ballsMoving ||
      store.isAiThinking ||
      !canLocalPlayerAct(store)
    ) {
      return;
    }

    if (store.matchConfig.opponentType === 'online') {
      if (!this.canShootCurrentMode()) return;
      const sent = multiplayerManager.sendShot({
        cueAngle: store.cueAngle,
        power,
        spinX: store.cueSpin.x,
        spinY: store.cueSpin.y,
        calledBall: store.calledShot.targetBall,
        calledPocket: store.calledShot.targetPocket,
      });
      if (sent) {
        this.startStrikeVisualOnly(power, store.cueAngle, store.cueSpin);
      }
      return;
    }

    if (!this.matchManager.canShoot() || this.matchManager.isActivePlayerAi()) {
      return;
    }

    this.executeStrike(power, store.cueAngle, store.cueSpin);
  }

  private startStrikeVisualOnly(power: number, angle: number, spin: CueSpin) {
    const store = useGameStore.getState();
    soundEngine.unlock();
    const clampedPower = Math.max(0.02, Math.min(1, power));
    const { surfaceDistanceX } = CueStick.computeSurfaceContactOffsets(spin);
    const pulledTipDist =
      surfaceDistanceX + CUE_SPECS.idleStandoff + clampedPower * CUE_SPECS.maxPullback;

    store.setIsShotAnimating(true);

    this.strikeAnim.active = true;
    this.strikeAnim.phase = 'thrust';
    this.strikeAnim.progress = 0;
    this.strikeAnim.startTipDist = pulledTipDist;
    this.strikeAnim.contactDist = surfaceDistanceX;
    this.strikeAnim.tipDist = pulledTipDist;
    this.strikeAnim.power = clampedPower;
    this.strikeAnim.angle = angle;
    this.strikeAnim.spin = { ...spin };
    this.strikeAnim.impulseApplied = false;
    this.strikeAnim.visualOnly = true;
  }

  private executeStrike(power: number, angle: number, spin: CueSpin) {
    const store = useGameStore.getState();
    if (!this.matchManager.canShoot()) return;

    if (!this.physics.isCueBallAvailable()) {
      this.physics.respotCueBall();
    }

    soundEngine.unlock();
    const clampedPower = Math.max(0.02, Math.min(1, power));
    const { surfaceDistanceX } = CueStick.computeSurfaceContactOffsets(spin);
    const pulledTipDist =
      surfaceDistanceX + CUE_SPECS.idleStandoff + clampedPower * CUE_SPECS.maxPullback;

    store.setIsShotAnimating(true);

    this.strikeAnim.active = true;
    this.strikeAnim.phase = 'thrust';
    this.strikeAnim.progress = 0;
    this.strikeAnim.startTipDist = pulledTipDist;
    this.strikeAnim.contactDist = surfaceDistanceX;
    this.strikeAnim.tipDist = pulledTipDist;
    this.strikeAnim.power = clampedPower;
    this.strikeAnim.angle = angle;
    this.strikeAnim.spin = { ...spin };
    this.strikeAnim.impulseApplied = false;
    this.strikeAnim.visualOnly = false;
  }

  public respotCueBall() {
    soundEngine.unlock();
    soundEngine.playUiClick();
    this.physics.respotCueBall();
    useGameStore.setState({ cueBallPocketed: false });
  }

  private scheduleAiTurnIfNeeded() {
    if (this.replayController.isActive()) return;
    this.aiTurnController?.scheduleTurnIfNeeded();
  }

  private captureLocalReplayFrame() {
    this.physics.forEachBallKinematics(
      (num, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed) => {
        this.shotRecorder.writeBallSample(num, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed);
      },
    );
    this.shotRecorder.commitFrame();
  }

  private captureLiveBallBackup(): ReplayBallFrame[] {
    const out: ReplayBallFrame[] = [];
    const store = useGameStore.getState();
    if (store.matchConfig.opponentType === 'online') {
      const online = multiplayerManager.synchronizer.getLatestSettledBalls();
      if (online && online.length > 0) {
        return online.map((b) => ({ ...b }));
      }
    }
    this.physics.forEachBallKinematics(
      (number, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed) => {
        out.push({ number, x, y, z, qx, qy, qz, qw, vx, vy, vz, pocketed });
      },
    );
    return out;
  }

  private async refreshSavedReplaysIndex() {
    try {
      const [list, stats] = await Promise.all([
        replayStorage.listSavedReplays(),
        replayStorage.getStorageStats(),
      ]);
      if (!this.disposed) {
        useGameStore.getState().setSavedReplays(list, stats);
      }
    } catch {
      // Ignore storage read failure
    }
  }

  private syncReplayUi(force = false) {
    const now = performance.now();
    if (!force && now - this.lastReplayUiSyncAt < 32) return;
    this.lastReplayUiSyncAt = now;

    const shot = this.replayController.getShot();
    const matchReplay = this.replayController.getMatchReplay();
    const dynamicState = this.replayController.getMatchStateAtCurrentTime();
    const activeCol = this.replayController.getActiveCollisionHighlight();

    const p1Pocketed = matchReplay
      ? (dynamicState
          ? matchReplay.shots
              .slice(0, this.replayController.getCurrentShotIndex() + 1)
              .filter((s) => s.shooter === 'player1' && !s.isFoul)
              .reduce((a, s) => a + s.pocketedBalls.filter((p) => p.ballNumber !== 0).length, 0)
          : matchReplay.player1.pocketedCount)
      : 0;
    const p2Pocketed = matchReplay
      ? (dynamicState
          ? matchReplay.shots
              .slice(0, this.replayController.getCurrentShotIndex() + 1)
              .filter((s) => s.shooter === 'player2' && !s.isFoul)
              .reduce((a, s) => a + s.pocketedBalls.filter((p) => p.ballNumber !== 0).length, 0)
          : matchReplay.player2.pocketedCount)
      : 0;

    useGameStore.getState().setReplayUiState({
      replayActive: this.replayController.isActive(),
      replayMode: this.replayController.getMode(),
      replayMatchId: matchReplay?.matchId ?? null,
      replayShotId: shot?.id ?? null,
      replayShotIndex: this.replayController.getCurrentShotIndex(),
      replayTotalShots: this.replayController.getTotalShots(),
      replayPlaying: this.replayController.isPlaying(),
      replayTimeSec: this.replayController.getCurrentTimeSec(),
      replayDurationSec: this.replayController.getDurationSec(),
      replayMatchTimeSec: this.replayController.getMatchTimeSec(),
      replayMatchDurationSec: this.replayController.getMatchDurationSec(),
      replaySpeed: this.replayController.getSpeed(),
      replayCameraMode: this.replayCameraMode,
      replayAutoSlowMo: this.replayController.getAutoSlowMo(),
      replayShowAnalysis: this.replayController.getShowAnalysis(),
      replayActiveCollisionLabel: activeCol ? formatCollisionLabel(activeCol) : null,
      replayHighlights: matchReplay?.highlights ?? [],
      replayTimelineEvents: matchReplay?.timelineEvents ?? [],
      replayIsRecordingVideo: this.videoRecorder.isRecording(),
      replayMatchMeta: matchReplay
        ? {
            matchId: matchReplay.matchId,
            replayId: matchReplay.replayId,
            matchType: matchReplay.matchType,
            ruleProfileId: matchReplay.ruleProfileId,
            player1Name: matchReplay.player1.name,
            player2Name: matchReplay.player2.name,
            player1Group: dynamicState?.player1Group ?? matchReplay.player1.group,
            player2Group: dynamicState?.player2Group ?? matchReplay.player2.group,
            player1PocketedCount: p1Pocketed,
            player2PocketedCount: p2Pocketed,
            winner: matchReplay.winner,
            finalResult: matchReplay.finalResult,
            authoritative: matchReplay.authoritative,
          }
        : null,
    });
  }

  private renderCurrentReplayInstant() {
    const activeShot = this.replayController.getShot();
    if (activeShot && activeShot.id !== this.lastReplayAnalysisShotId) {
      this.lastReplayAnalysisShotId = activeShot.id;
      this.replayAnalysisOverlay.setShot(activeShot);
    }

    if (this.replayController.sampleInterpolatedFrames(this.replayFramesScratch)) {
      let fastestSpeedSq = -1;
      let hasCue = false;
      for (let i = 0; i < this.replayFramesScratch.length; i++) {
        const b = this.replayFramesScratch[i];
        this.billiardBalls.syncFromTransform(
          b.number,
          b.x,
          b.y,
          b.z,
          b.qx,
          b.qy,
          b.qz,
          b.qw,
          b.pocketed,
        );
        if (b.number === 0 && !b.pocketed) {
          this.replayCueBallPos.set(b.x, b.y, b.z);
          hasCue = true;
        }
        if (!b.pocketed) {
          const spSq = b.vx * b.vx + b.vz * b.vz;
          if (spSq > fastestSpeedSq) {
            fastestSpeedSq = spSq;
            this.replayFocusBallPos.set(b.x, b.y, b.z);
          }
        }
      }
      if (!hasCue) {
        this.replayCueBallPos.set(0, TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius, 0);
      }
      if (fastestSpeedSq <= 0.002 && hasCue) {
        this.replayFocusBallPos.copy(this.replayCueBallPos);
      }
    }
    this.replayAnalysisOverlay.update(
      this.replayController.getShowAnalysis(),
      this.replayController.getCurrentTimeSec(),
    );
  }

  // ==================== PHASE 6 & 13: ISOLATED REPLAY API ====================

  public enterReplay(shotId?: string) {
    const store = useGameStore.getState();
    if (
      store.ballsMoving ||
      store.isShotAnimating ||
      this.strikeAnim.active
    ) {
      return;
    }
    // If launched with no explicit shotId when a full match record is ready, enter Match Replay mode
    if (!shotId && (store.matchPhase === 'GAME_OVER' || this.activeMatchReplayRecord)) {
      this.enterMatchReplay();
      return;
    }
    if (store.screen !== 'playing') return;

    const shot = this.shotRecorder.getShotById(shotId ?? null);
    if (!shot) return;

    this.aiTurnController?.cancel();
    store.setIsAiThinking(false);
    this.replayReturnScreen = 'playing';
    this.cameraController.saveBeforeReplay();
    this.replayCameraMode = 'original';
    this.replayElapsedWallSec = 0;

    const backup = this.captureLiveBallBackup();
    this.replayController.enterReplay(shot, backup);
    this.lastReplayAnalysisShotId = shot.id;
    this.replayAnalysisOverlay.setShot(shot);
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
  }

  public enterMatchReplay(initialShotId?: string) {
    const store = useGameStore.getState();
    if (store.ballsMoving || store.isShotAnimating || this.strikeAnim.active) {
      return;
    }

    let record = this.activeMatchReplayRecord;
    if (!record) {
      const snap =
        store.matchConfig.opponentType === 'online' ? null : this.matchManager.getSnapshot();
      record = this.shotRecorder.buildMatchReplayRecord({
        matchId: this.currentMatchId,
        winner: store.winner,
        loser: store.loser,
        finalResult: store.gameOverReason ?? store.statusHeadline ?? 'Match Replay',
        playerGroups: snap ? snap.playerGroups : store.playerGroups,
        pocketedNumbers: snap ? snap.pocketedNumbers : store.pocketedNumbers,
        player1Name: store.matchConfig.player1Name,
        player2Name: store.matchConfig.player2Name,
        authoritative: store.matchConfig.opponentType === 'online',
        localPlayerPerspective: store.onlineLocalRole,
      });
    }
    if (!record || record.shots.length === 0) return;

    this.startMatchReplaySession(record, 'playing', initialShotId);
  }

  public async enterSavedMatchReplayById(replayId: string) {
    const record = await replayStorage.loadReplay(replayId);
    if (!record || this.disposed) return;
    this.enterSavedMatchReplay(record);
  }

  public enterSavedMatchReplay(record: MatchReplayRecord) {
    if (!record || record.shots.length === 0) return;
    const store = useGameStore.getState();
    if (store.ballsMoving || store.isShotAnimating || this.strikeAnim.active) return;

    const returnTo: 'menu' | 'playing' = store.screen === 'menu' ? 'menu' : 'playing';
    store.closeProgressionModal();
    if (returnTo === 'menu') {
      store.setScreen('playing');
    }
    store.setReplayShots(record.shots.map(summarizeRecordedShot).reverse());
    this.startMatchReplaySession(record, returnTo);
  }

  private startMatchReplaySession(
    record: MatchReplayRecord,
    returnTo: 'menu' | 'playing',
    initialShotId?: string,
  ) {
    const store = useGameStore.getState();
    this.aiTurnController?.cancel();
    store.setIsAiThinking(false);
    this.replayReturnScreen = returnTo;
    this.cameraController.saveBeforeReplay();
    this.replayCameraMode = 'original';
    this.replayElapsedWallSec = 0;

    const backup = this.captureLiveBallBackup();
    this.replayController.enterMatchReplay(record, backup, initialShotId);
    const activeShot = this.replayController.getShot();
    this.lastReplayAnalysisShotId = activeShot?.id ?? null;
    this.replayAnalysisOverlay.setShot(activeShot);
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
  }

  public exitReplay() {
    if (!this.replayController.isActive()) return;
    if (this.videoRecorder.isRecording()) {
      void this.stopReplayVideoRecording();
    }
    const backup = this.replayController.exitReplay();
    this.lastReplayAnalysisShotId = null;
    this.replayAnalysisOverlay.clear();
    this.replayAnalysisOverlay.update(false, 0);
    this.cameraController.restoreAfterReplay();

    const store = useGameStore.getState();
    if (this.replayReturnScreen === 'menu') {
      this.physics.resetRack(generateOfficialEightBallRack());
      this.physics.getSnapshots(_snapshots);
      for (const s of _snapshots) {
        this.billiardBalls.syncFromTransform(
          s.number,
          s.x,
          s.y,
          s.z,
          s.qx,
          s.qy,
          s.qz,
          s.qw,
          s.pocketed,
        );
      }
      store.resetReplayUiState();
      store.setScreen('menu');
      this.replayReturnScreen = 'playing';
      return;
    }

    if (store.matchConfig.opponentType === 'online') {
      const hasLive = multiplayerManager.synchronizer.sampleRenderFrames(_onlineFrames);
      const liveBalls = hasLive
        ? _onlineFrames
        : multiplayerManager.synchronizer.getLatestSettledBalls();
      if (liveBalls && liveBalls.length > 0) {
        this.physics.syncAllFromServerFrames(liveBalls);
        for (const b of liveBalls) {
          this.billiardBalls.syncFromTransform(
            b.number,
            b.x,
            b.y,
            b.z,
            b.qx,
            b.qy,
            b.qz,
            b.qw,
            b.pocketed,
          );
        }
      } else {
        for (const b of backup) {
          this.billiardBalls.syncFromTransform(
            b.number,
            b.x,
            b.y,
            b.z,
            b.qx,
            b.qy,
            b.qz,
            b.qw,
            b.pocketed,
          );
        }
      }
    } else {
      this.physics.getSnapshots(_snapshots);
      if (_snapshots.length > 0) {
        for (const s of _snapshots) {
          this.billiardBalls.syncFromTransform(
            s.number,
            s.x,
            s.y,
            s.z,
            s.qx,
            s.qy,
            s.qz,
            s.qw,
            s.pocketed,
          );
        }
      } else {
        for (const b of backup) {
          this.billiardBalls.syncFromTransform(
            b.number,
            b.x,
            b.y,
            b.z,
            b.qx,
            b.qy,
            b.qz,
            b.qw,
            b.pocketed,
          );
        }
      }
    }

    store.resetReplayUiState();
    this.scheduleAiTurnIfNeeded();
  }

  public selectReplayShot(shotId: string) {
    if (!this.replayController.isActive()) {
      this.enterReplay(shotId);
      return;
    }
    const activeMatch = this.replayController.getMatchReplay();
    const shot = activeMatch
      ? activeMatch.shots.find((s) => s.id === shotId) ?? null
      : this.shotRecorder.getShotById(shotId);
    if (!shot) return;
    this.replayController.switchShot(shot);
    this.lastReplayAnalysisShotId = shot.id;
    this.replayAnalysisOverlay.setShot(shot);
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
  }

  public prevReplayShot() {
    if (!this.replayController.isActive()) return;
    if (this.replayController.prevShot()) {
      this.renderCurrentReplayInstant();
      this.syncReplayUi(true);
    }
  }

  public nextReplayShot() {
    if (!this.replayController.isActive()) return;
    if (this.replayController.nextShot()) {
      this.renderCurrentReplayInstant();
      this.syncReplayUi(true);
    }
  }

  public jumpToReplayStart() {
    if (!this.replayController.isActive()) return;
    this.replayController.jumpToBeginning();
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
  }

  public jumpToReplayEnd() {
    if (!this.replayController.isActive()) return;
    this.replayController.jumpToEnd();
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
  }

  public jumpToReplayHighlight(highlightId: string) {
    if (!this.replayController.isActive()) return;
    this.replayController.jumpToHighlight(highlightId);
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
  }

  public setReplayCameraMode(mode: ReplayCameraMode) {
    this.replayCameraMode = mode;
    useGameStore.getState().setReplayUiState({ replayCameraMode: mode });
  }

  public exportActiveReplayJson() {
    const matchRec =
      this.replayController.getMatchReplay() ?? this.activeMatchReplayRecord;
    if (!matchRec) return;
    const json = replayStorage.exportReplayToJson(matchRec);
    downloadTextFile(`replay-${matchRec.matchId}.json`, json);
  }

  public startReplayVideoRecording() {
    if (!this.replayController.isActive() || !this.renderer?.domElement) return;
    if (!ReplayVideoRecorder.isSupported()) {
      useGameStore.getState().setReplayUiState({
        replayVideoNotice: 'Video capture is unavailable in this browser.',
      });
      return;
    }
    const ok = this.videoRecorder.startRecording(this.renderer.domElement);
    useGameStore.getState().setReplayUiState({
      replayIsRecordingVideo: ok,
      replayVideoNotice: ok ? 'Recording viewport video...' : 'Unable to start video capture.',
    });
  }

  public async stopReplayVideoRecording() {
    if (!this.videoRecorder.isRecording()) return;
    const res = await this.videoRecorder.stopRecording();
    if (res) {
      downloadRecordedVideo(res);
    }
    useGameStore.getState().setReplayUiState({
      replayIsRecordingVideo: false,
      replayVideoNotice: res ? `Saved ${res.filename}` : null,
    });
  }

  public toggleReplayPlay() {
    if (!this.replayController.isActive()) return;
    this.replayController.togglePlay();
    this.syncReplayUi(true);
  }

  public restartReplay() {
    if (!this.replayController.isActive()) return;
    this.replayController.restart();
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
  }

  public seekReplay(timeSec: number) {
    if (!this.replayController.isActive()) return;
    if (this.replayController.getMode() === 'match') {
      this.replayController.seekMatch(timeSec);
    } else {
      this.replayController.seek(timeSec);
    }
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
  }

  public setReplaySpeed(speed: ReplaySpeed) {
    if (!this.replayController.isActive()) return;
    this.replayController.setSpeed(speed);
    this.syncReplayUi(true);
  }

  public toggleReplayAutoSlowMo() {
    if (!this.replayController.isActive()) return;
    this.replayController.setAutoSlowMo(!this.replayController.getAutoSlowMo());
    this.syncReplayUi(true);
  }

  public toggleReplayAnalysis() {
    if (!this.replayController.isActive()) return;
    this.replayController.setShowAnalysis(!this.replayController.getShowAnalysis());
    this.replayAnalysisOverlay.update(
      this.replayController.getShowAnalysis(),
      this.replayController.getCurrentTimeSec(),
    );
    this.syncReplayUi(true);
  }

  public jumpToReplayImpact() {
    if (!this.replayController.isActive()) return;
    this.replayController.jumpToFirstImpact();
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
  }

  private scheduleResize() {
    if (this.disposed) return;
    if (this.resizeRafId) {
      cancelAnimationFrame(this.resizeRafId);
    }
    this.resizeRafId = requestAnimationFrame(() => {
      this.resizeRafId = 0;
      this.handleResize();
    });
  }

  private handleResize() {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.cameraController.resize(width / height);
    this.renderer.setSize(width, height, false);
    const profile = getGraphicsProfile(useGameStore.getState().settings.graphicsQuality);
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, profile.dprCap),
    );
  }

  private startLoop() {
    const tick = () => {
      if (this.disposed) return;
      const rawDt = this.clock.getDelta();
      const dt = Math.min(rawDt, 0.05);

      this.update(dt);
      this.renderer.render(this.scene, this.cameraController.camera);

      if (this.isSoftwareGl) {
        this.afterDraw(tick);
      } else {
        this.frameId = requestAnimationFrame(tick);
      }
    };

    if (this.isSoftwareGl) {
      this.afterDraw(tick);
    } else {
      this.frameId = requestAnimationFrame(tick);
    }
  }

  private afterDraw(cb: () => void) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const status = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
      if (status === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private update(dt: number) {
    const store = useGameStore.getState();

    // 1. FPS & Performance Diagnostics update (every 0.4s, zero per-frame allocations)
    this.fpsFrames++;
    this.fpsTimer += dt;
    this.perfFrameTimeAccumMs += dt * 1000;
    if (this.fpsTimer >= 0.4) {
      const currentFps = Math.max(1, Math.round(this.fpsFrames / this.fpsTimer));
      const avgFrameTimeMs = Number((this.perfFrameTimeAccumMs / this.fpsFrames).toFixed(1));
      this.avgFpsEma = this.avgFpsEma * 0.75 + currentFps * 0.25;
      store.setPerfStats({
        fps: currentFps,
        avgFps: Math.round(this.avgFpsEma),
        frameTimeMs: avgFrameTimeMs,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        activeParticles: this.tableVfx.getActiveParticleCount(),
      });
      this.fpsFrames = 0;
      this.fpsTimer = 0;
      this.perfFrameTimeAccumMs = 0;
    }

    // 2. Continuous keyboard aiming input & animated cosmetics
    this.inputManager.update(dt);
    this.billiardBalls.update(this.clock.elapsedTime, dt);
    this.tableVfx.update(dt);
    this.victoryEffects.update(dt);

    // 3. Synchronized forward cue strike animation & exact-contact physics impulse with spin
    if (this.strikeAnim.active) {
      if (this.strikeAnim.phase === 'thrust') {
        const thrustSpeed = 8.5 + this.strikeAnim.power * 6.5;
        this.strikeAnim.progress += dt * thrustSpeed;
        const t = Math.min(1, this.strikeAnim.progress);
        const eased = t * t;
        this.strikeAnim.tipDist = THREE.MathUtils.lerp(
          this.strikeAnim.startTipDist,
          this.strikeAnim.contactDist,
          eased,
        );

        if (t >= 1) {
          if (!this.strikeAnim.impulseApplied) {
            this.strikeAnim.impulseApplied = true;
            this.physics.getCueBallPosition(_cueBallPos);
            this.tableVfx.emitCueStrike(
              _cueBallPos.x,
              _cueBallPos.y,
              _cueBallPos.z,
              this.strikeAnim.angle,
              this.strikeAnim.power,
            );
            if (!this.strikeAnim.visualOnly) {
              const snap = this.matchManager.getSnapshot();
              this.matchManager.beginShot();
              this.shotSequence++;
              this.physics.beginShotTelemetry(
                this.shotSequence,
                snap.isBreakShot,
                snap.activePlayer,
                snap.calledShot,
              );

              soundEngine.playCueStrike(this.strikeAnim.power);
              this.shotRecorder.beginShot({
                shotNumber: store.shotCount + 1,
                mode: store.matchConfig.opponentType === 'ai' ? 'ai' : 'local',
                shooter: snap.activePlayer,
                shooterName: this.matchManager.getPlayerName(snap.activePlayer),
                isBreakShot: snap.isBreakShot,
                cueAngle: this.strikeAnim.angle,
                power: this.strikeAnim.power,
                spin: this.strikeAnim.spin,
                calledShot: snap.calledShot,
              });
              this.physics.setShotStepObserver({
                onFixedSample: () => this.captureLocalReplayFrame(),
                onCollision: (kind, ballA, ballB, x, z, impactSpeed) =>
                  this.shotRecorder.recordCollision({
                    kind,
                    ballA,
                    ballB,
                    x,
                    z,
                    impactSpeed,
                  }),
                onPocket: (ballNumber, pocketId, x, z) =>
                  this.shotRecorder.recordPocket(ballNumber, pocketId, x, z),
              });
              this.physics.strikeCueBall(
                this.strikeAnim.angle,
                this.strikeAnim.power,
                this.strikeAnim.spin,
              );
              this.captureLocalReplayFrame();
              this.wasBallsMoving = true;
              store.setBallsMoving(true);
              store.syncFromMatchSnapshot(this.matchManager.getSnapshot());
            } else {
              soundEngine.playCueStrike(this.strikeAnim.power);
            }
          }
          this.strikeAnim.phase = 'followThrough';
          this.strikeAnim.progress = 0;
        }
      } else {
        this.strikeAnim.progress += dt * 7.5;
        const t = Math.min(1, this.strikeAnim.progress);
        const followDepth = this.strikeAnim.contactDist - 0.009;
        const idleDist = this.strikeAnim.contactDist + CUE_SPECS.idleStandoff;
        if (t < 0.35) {
          const ft = t / 0.35;
          this.strikeAnim.tipDist = THREE.MathUtils.lerp(
            this.strikeAnim.contactDist,
            followDepth,
            ft,
          );
        } else {
          const rt = (t - 0.35) / 0.65;
          this.strikeAnim.tipDist = THREE.MathUtils.lerp(
            followDepth,
            idleDist,
            rt,
          );
        }

        if (t >= 1) {
          this.strikeAnim.active = false;
          store.setIsShotAnimating(false);
        }
      }
    }

    // 2b. Isolated Replay Mode: advance only ReplayController & visual overlay without stepping live physics
    if (this.replayController.isActive()) {
      const wasPlaying = this.replayController.isPlaying();
      this.replayElapsedWallSec += dt;
      this.replayController.step(dt);
      this.renderCurrentReplayInstant();
      const finishedPlayback = wasPlaying && !this.replayController.isPlaying();
      this.syncReplayUi(finishedPlayback);

      this.placementGroup.visible = false;
      this.calledPocketRing.visible = false;
      this.cueStick.update(_cueBallPos, 0, 0, false, false, null, { x: 0, y: 0 }, dt, false);
      const activeShot = this.replayController.getShot();
      this.cameraController.updateReplayCamera(
        this.replayCameraMode,
        {
          cueBallPos: this.replayCueBallPos,
          focusBallPos: this.replayFocusBallPos,
          cueAngle: activeShot?.cueAngle ?? 0,
          elapsedSec: this.replayElapsedWallSec,
        },
        dt,
      );
      return;
    }

    const isOnlinePlaying =
      store.screen === 'playing' && store.matchConfig.opponentType === 'online';

    // 4. Step Rapier3D physics locally OR render server-authoritative interpolated ball frames
    let movingNow = false;
    if (isOnlinePlaying) {
      if (multiplayerManager.synchronizer.sampleRenderFrames(_onlineFrames)) {
        for (let i = 0; i < _onlineFrames.length; i++) {
          const b = _onlineFrames[i];
          this.billiardBalls.syncFromTransform(
            b.number,
            b.x,
            b.y,
            b.z,
            b.qx,
            b.qy,
            b.qz,
            b.qw,
            b.pocketed,
          );
          if (b.number === 0) {
            _cueBallPos.set(b.x, b.y, b.z);
          }
        }
      }
      movingNow = store.ballsMoving || store.matchPhase === 'BALLS_MOVING';
    } else {
      this.physics.step(dt);
      this.physics.getSnapshots(_snapshots);
      for (let i = 0; i < _snapshots.length; i++) {
        const s = _snapshots[i];
        this.billiardBalls.syncFromTransform(
          s.number,
          s.x,
          s.y,
          s.z,
          s.qx,
          s.qy,
          s.qz,
          s.qw,
          s.pocketed,
        );
      }

      movingNow = this.physics.areAnyBallsMoving();

      // Evaluate shot ONCE strictly when all balls come to rest and strike animation finishes
      if (!movingNow && !this.strikeAnim.active && this.wasBallsMoving) {
        this.wasBallsMoving = false;
        store.setBallsMoving(false);

        if (this.shotRecorder.isRecording() && this.shotRecorder.getActiveMode() !== 'online') {
          this.captureLocalReplayFrame();
        }
        this.physics.setShotStepObserver(null);

        if (this.matchManager.getPhase() === 'BALLS_MOVING') {
          const telemetry = this.physics.finalizeShotTelemetry();
          const { snapshot, evaluation } = this.matchManager.settleShot(telemetry);

          if (this.shotRecorder.isRecording() && this.shotRecorder.getActiveMode() !== 'online') {
            const pocketedObj = telemetry.pocketEvents.filter((p) => p.ballNumber !== 0);
            const resultLabel = evaluation?.winner
              ? `${this.matchManager.getPlayerName(evaluation.winner)} Wins`
              : evaluation && !evaluation.isLegal
                ? `Foul · ${evaluation.foulReason ?? 'Illegal Shot'}`
                : pocketedObj.length > 0
                  ? `Pocketed ${pocketedObj.map((p) => `#${p.ballNumber}`).join(', ')}`
                  : snapshot.config.gameMode === 'freePlay'
                    ? 'Free Play Shot'
                    : 'No Ball Pocketed';
            const rec = this.shotRecorder.finalizeShot({
              resultLabel,
              isFoul: Boolean(evaluation && !evaluation.isLegal),
              foulReason: evaluation?.foulReason ?? null,
              tableOpenAfter: snapshot.tableOpen,
              playerGroupsAfter: snapshot.playerGroups,
              pocketedNumbersAfter: snapshot.pocketedNumbers,
              activePlayerAfter: snapshot.activePlayer,
              ballInHandNext: snapshot.phase === 'BALL_IN_HAND',
            });
            if (rec) {
              if (snapshot.phase === 'BALL_IN_HAND') {
                this.shotRecorder.recordBallInHand(
                  snapshot.activePlayer,
                  this.matchManager.getPlayerName(snapshot.activePlayer),
                  evaluation?.foulReason ?? null,
                );
              }
              if (snapshot.phase !== 'GAME_OVER' && snapshot.activePlayer !== telemetry.shooter) {
                this.shotRecorder.recordTurnChange(
                  snapshot.activePlayer,
                  this.matchManager.getPlayerName(snapshot.activePlayer),
                );
              }
              store.setReplayShots(this.shotRecorder.getSummariesNewestFirst());
            }
          }

          if (
            snapshot.phase === 'GAME_OVER' &&
            !this.shotRecorder.hasMatchBeenSaved(this.currentMatchId)
          ) {
            this.shotRecorder.markMatchSaved(this.currentMatchId);
            const built = this.shotRecorder.buildMatchReplayRecord({
              matchId: this.currentMatchId,
              winner: snapshot.winner,
              loser: snapshot.loser,
              finalResult: snapshot.gameOverReason ?? snapshot.statusHeadline ?? 'Match Complete',
              playerGroups: snapshot.playerGroups,
              pocketedNumbers: snapshot.pocketedNumbers,
              player1Name: this.matchManager.getPlayerName('player1'),
              player2Name: this.matchManager.getPlayerName('player2'),
              authoritative: false,
            });
            if (built) {
              this.activeMatchReplayRecord = built;
              void replayStorage
                .saveReplay(built)
                .then(() => this.refreshSavedReplaysIndex())
                .catch(() => {});
            }
          }

          if (evaluation?.respotEightBall) {
            this.physics.respotEightBall();
          }

          if (snapshot.phase === 'BALL_IN_HAND') {
            const validSpot = this.physics.findNearestValidCuePlacement(snapshot.ballInHandZone);
            this.physics.setCueBallPlacement(validSpot.x, validSpot.z);
            store.setCuePlacementPreview(validSpot.x, validSpot.z, true, null);
            store.setCueAngle(0);
          } else if (
            (!this.physics.isCueBallAvailable() || telemetry.cueBallPocketed) &&
            snapshot.phase !== 'GAME_OVER'
          ) {
            this.physics.respotCueBall();
          }

          useGameStore.setState({ cueBallPocketed: false });
          store.syncFromMatchSnapshot(snapshot);
          this.scheduleAiTurnIfNeeded();
        } else {
          this.shotRecorder.cancelActiveRecording();
        }
      } else if (movingNow !== this.wasBallsMoving) {
        if (movingNow || (!this.strikeAnim.active && this.matchManager.getPhase() !== 'BALLS_MOVING')) {
          this.wasBallsMoving = movingNow;
          store.setBallsMoving(movingNow);
        }
      }

      // Safety respot in Free Play if cue ball was pocketed without moving state
      if (
        !movingNow &&
        !this.strikeAnim.active &&
        this.matchManager.getGameMode() === 'freePlay' &&
        (store.cueBallPocketed || !this.physics.isCueBallAvailable())
      ) {
        this.physics.respotCueBall();
        useGameStore.setState({ cueBallPocketed: false });
      }
    }

    // 5. Update 3D Ball-in-Hand placement ring & Called Pocket highlight ring
    const latestStore = useGameStore.getState();
    const showPlacementOverlay =
      latestStore.screen === 'playing' &&
      latestStore.matchPhase === 'BALL_IN_HAND' &&
      canLocalPlayerAct(latestStore) &&
      (!latestStore.isAiThinking || latestStore.aiStatus.phase === 'placing');

    if (showPlacementOverlay) {
      this.placementGroup.visible = true;
      this.placementRing.position.x = latestStore.cuePlacementPos.x;
      this.placementRing.position.z = latestStore.cuePlacementPos.z;
      this.placementRingMat.color.setHex(
        latestStore.cuePlacementValid ? 0x10b981 : 0xef4444,
      );
      this.ghostCueMesh.visible = !latestStore.cuePlacementValid;
      if (this.ghostCueMesh.visible) {
        this.ghostCueMesh.position.set(
          latestStore.cuePlacementPos.x,
          TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius,
          latestStore.cuePlacementPos.z,
        );
      }
      this.kitchenLineMesh.visible = latestStore.ballInHandZone === 'kitchen';
    } else {
      this.placementGroup.visible = false;
    }

    const calledPocketId = latestStore.calledShot.targetPocket;
    if (
      latestStore.screen === 'playing' &&
      calledPocketId &&
      latestStore.matchPhase !== 'GAME_OVER'
    ) {
      const pPos = POCKET_POSITIONS.find((p) => p.id === calledPocketId);
      if (pPos) {
        this.calledPocketRing.visible = true;
        this.calledPocketRing.position.x = pPos.x;
        this.calledPocketRing.position.z = pPos.z;
      } else {
        this.calledPocketRing.visible = false;
      }
    } else {
      this.calledPocketRing.visible = false;
    }

    // 6. Update Cue Stick & Multi-Segment Trajectory Prediction
    if (!isOnlinePlaying) {
      this.physics.getCueBallPosition(_cueBallPos);
    } else if (_onlineFrames.length === 0) {
      this.physics.getCueBallPosition(_cueBallPos);
    }
    const cueAvailable = this.physics.isCueBallAvailable();
    const canDisplayCue =
      cueAvailable &&
      latestStore.matchPhase !== 'BALL_IN_HAND' &&
      latestStore.matchPhase !== 'GAME_OVER' &&
      (this.strikeAnim.active || !movingNow) &&
      (latestStore.screen === 'playing' || latestStore.screen === 'menu');

    const activeSpin = this.strikeAnim.active ? this.strikeAnim.spin : latestStore.cueSpin;
    const { surfaceDistanceX } = CueStick.computeSurfaceContactOffsets(activeSpin);
    const pullbackRatio = latestStore.isDraggingCue
      ? latestStore.dragPower
      : latestStore.isAiThinking
        ? latestStore.aiPullbackPower
        : 0;
    const tipDist = this.strikeAnim.active
      ? this.strikeAnim.tipDist
      : surfaceDistanceX +
        CUE_SPECS.idleStandoff +
        pullbackRatio * CUE_SPECS.maxPullback;

    const previewPower = latestStore.isDraggingCue
      ? Math.max(0.22, latestStore.dragPower)
      : latestStore.isAiThinking && latestStore.aiPullbackPower > 0.05
        ? Math.max(0.22, latestStore.aiPullbackPower)
        : 0.58;

    const showAiGuideNow =
      latestStore.isAiThinking &&
      latestStore.matchConfig.showAiAimGuide &&
      (latestStore.aiStatus.phase === 'aiming' || latestStore.aiStatus.phase === 'pullback');
    const showPlayerGuideNow =
      !latestStore.isAiThinking &&
      latestStore.settings.showAimGuide &&
      (!isOnlinePlaying || canLocalPlayerAct(latestStore));
    const shouldShowGuide =
      canDisplayCue &&
      !this.strikeAnim.active &&
      latestStore.screen === 'playing' &&
      !movingNow &&
      (showPlayerGuideNow || showAiGuideNow);

    const trajectory = shouldShowGuide
      ? this.physics.predictAimTrajectory(
          latestStore.cueAngle,
          latestStore.cueSpin,
          previewPower,
        )
      : null;

    this.cueStick.update(
      _cueBallPos,
      this.strikeAnim.active ? this.strikeAnim.angle : latestStore.cueAngle,
      tipDist,
      canDisplayCue,
      shouldShowGuide,
      trajectory,
      activeSpin,
      dt,
      this.strikeAnim.active,
    );

    // 7. Camera update (OrbitControls + smooth transitions + table boundary guard)
    this.cameraController.update(dt, latestStore.screen === 'menu');
  }

  public dispose() {
    if (this.disposed) return;
    this.disposed = true;
    multiplayerManager.attachSceneBridge(null);
    this.aiTurnController?.dispose();

    cancelAnimationFrame(this.frameId);
    cancelAnimationFrame(this.resizeRafId);
    clearTimeout(this.frameId);

    window.removeEventListener('resize', this.onObserverResizeBound);
    window.removeEventListener('pointermove', this.onCanvasPointerMoveBound);
    window.removeEventListener('pointerup', this.onCanvasPointerUpBound);
    window.removeEventListener('pointercancel', this.onCanvasPointerUpBound);
    this.resizeObserver?.disconnect();
    this.unsubStore?.();

    if (this.renderer?.domElement) {
      this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLostBound);
      this.renderer.domElement.removeEventListener(
        'webglcontextrestored',
        this.onContextRestoredBound,
      );
      this.renderer.domElement.removeEventListener(
        'pointerdown',
        this.onCanvasPointerDownBound,
        { capture: true },
      );
    }

    this.inputManager?.dispose();
    this.cameraController?.dispose();
    this.physics?.setShotStepObserver(null);
    this.physics?.setVisualEventListener(null);
    this.physics?.dispose();
    this.shotRecorder.clearMatchShots();
    this.videoRecorder.dispose();
    this.replayController.exitReplay();
    this.replayAnalysisOverlay.dispose();
    this.tableVfx?.dispose();
    this.cueStick?.dispose();
    this.billiardBalls?.dispose();
    this.poolTable?.dispose();
    this.victoryEffects?.dispose();

    if (this.scene) {
      disposeObject3D(this.scene);
    }
    this.envRT?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement.parentElement === this.container) {
        this.container.removeChild(this.renderer.domElement);
      }
    }
  }

  private syncCosmeticsFromStore(
    state = useGameStore.getState(),
    forceTableRefresh = false,
  ) {
    if (!this.cueStick || !this.billiardBalls || !this.poolTable) return;

    let cueId = state.equippedCosmetics.cueId;
    let ballId = state.equippedCosmetics.ballId;
    let tableId = state.equippedCosmetics.tableId;
    let decorId = state.equippedCosmetics.decorationId;

    if (state.screen === 'playing' && state.matchConfig.opponentType === 'online' && state.onlineRoom) {
      const hostPlayer =
        state.onlineRoom.players.find((p) => p.sessionId === state.onlineRoom?.hostSessionId) ??
        state.onlineRoom.players[0];
      const hostCosmetics = hostPlayer?.equippedCosmetics;
      if (hostCosmetics) {
        tableId = hostCosmetics.tableId;
        ballId = hostCosmetics.ballId;
        decorId = hostCosmetics.decorationId;
      }

      const activePlayer = state.onlineRoom.players.find((p) => p.role === state.activePlayer);
      if (activePlayer?.equippedCosmetics?.cueId) {
        cueId = activePlayer.equippedCosmetics.cueId;
      }
    }

    if (cueId !== this.lastAppliedCueId) {
      this.lastAppliedCueId = cueId;
      this.cueStick.applyCueSkin(cueId);
    }
    if (ballId !== this.lastAppliedBallId) {
      this.lastAppliedBallId = ballId;
      this.billiardBalls.applyBallSkin(ballId);
    }
    if (
      forceTableRefresh ||
      tableId !== this.lastAppliedTableId ||
      decorId !== this.lastAppliedDecorId
    ) {
      this.lastAppliedTableId = tableId;
      this.lastAppliedDecorId = decorId;
      this.poolTable.applyTableCosmetics(tableId, decorId, state.settings.feltTheme);
    }
  }
}
