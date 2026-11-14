import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { useGameStore, canLocalPlayerAct, type CueSpin } from '../../store/useGameStore';
import { multiplayerManager } from '../../multiplayer/MultiplayerManager';
import type { OnlineBallFrame } from '../../multiplayer/shared/protocol';
import { CameraController } from '../camera/CameraController';
import { InputManager } from '../controls/InputManager';
import { BilliardBalls } from '../objects/BilliardBalls';
import { CueStick } from '../objects/CueStick';
import { PoolTable } from '../objects/PoolTable';
import { PhysicsWorld, type BallPhysicsSnapshot } from '../physics/PhysicsWorld';
import { AITurnController } from '../ai/AITurnController';
import { ReplayAnalysisOverlay } from '../replay/ReplayAnalysisOverlay';
import { formatCollisionLabel, ReplayController } from '../replay/ReplayController';
import { ShotRecorder } from '../replay/ShotRecorder';
import type { ReplayBallFrame, ReplaySpeed } from '../replay/types';
import { MatchManager } from '../rules/MatchManager';
import { generateOfficialEightBallRack } from '../rules/RackGenerator';
import type { MatchConfig, PocketId } from '../rules/types';
import { BALL_SPECS, CUE_SPECS, POCKET_POSITIONS, TABLE_DIMENSIONS } from '../utils/constants';
import { disposeObject3D } from '../utils/dispose';
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
  private physics!: PhysicsWorld;
  private cameraController!: CameraController;
  private inputManager!: InputManager;
  private keyLight!: THREE.DirectionalLight;

  // Authoritative 8-ball match state machine & AI turn orchestrator
  private matchManager: MatchManager;
  private aiTurnController: AITurnController | null = null;
  private shotSequence = 0;

  // Phase 6: Isolated Shot Recording, Replay & 3D Shot Analysis
  private shotRecorder = new ShotRecorder();
  private replayController = new ReplayController();
  private replayAnalysisOverlay = new ReplayAnalysisOverlay();
  private replayFramesScratch: ReplayBallFrame[] = [];
  private lastReplayUiSyncAt = 0;
  private lastOnlineShotSeqRecorded = -1;

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

  // FPS tracking
  private fpsFrames = 0;
  private fpsTimer = 0;

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
  private lastShadowsEnabled = useGameStore.getState().settings.shadowsEnabled;
  private lastSensitivity = useGameStore.getState().settings.cameraSensitivity;
  private lastScreen = useGameStore.getState().screen;
  private lastMatchConfig = useGameStore.getState().matchConfig;
  private lastSentCueAngle = useGameStore.getState().cueAngle;
  private lastSentSpinX = useGameStore.getState().cueSpin.x;
  private lastSentSpinY = useGameStore.getState().cueSpin.y;
  private lastRemoteShotSeqAnim = -1;
  private wasBallsMoving = false;

  private resizeObserver: ResizeObserver | null = null;
  private resizeRafId = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private onObserverResizeBound: () => void;

  constructor(container: HTMLElement, onToggleFullscreen: () => void) {
    this.container = container;
    this.isSoftwareGl = detectSoftwareWebGL();
    this.matchManager = new MatchManager(useGameStore.getState().matchConfig);
    this.onObserverResizeBound = this.scheduleResize.bind(this);
    this.onCanvasPointerDownBound = this.handleCanvasPointerDown.bind(this);
    this.onCanvasPointerMoveBound = this.handleCanvasPointerMove.bind(this);
    this.onCanvasPointerUpBound = this.handleCanvasPointerUp.bind(this);
    this.init(onToggleFullscreen);
  }

  private async init(onToggleFullscreen: () => void) {
    const store = useGameStore.getState();
    store.setLoading(true);
    store.setLoadError(null);

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
      const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
      const roomEnv = new RoomEnvironment();
      this.envRT = pmremGenerator.fromScene(roomEnv, 0.04);
      this.scene.environment = this.envRT.texture;
      roomEnv.dispose();
      pmremGenerator.dispose();

      // 4. Camera & Controls
      this.cameraController = new CameraController(
        this.renderer.domElement,
        width / height,
        this.isSoftwareGl,
      );
      this.cameraController.setSensitivity(store.settings.cameraSensitivity);

      // 5. Invisible Championship Lighting & Studio Room Floor
      this.setupLighting();
      const maxAnisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.setupStudioRoom(maxAnisotropy);

      // 6. 3D Objects (Table without hanging lamps, 16 Balls, Cue Stick, Match Overlays)
      this.poolTable = new PoolTable(store.settings.feltTheme, maxAnisotropy);
      this.scene.add(this.poolTable.group);

      this.billiardBalls = new BilliardBalls(maxAnisotropy);
      this.scene.add(this.billiardBalls.group);

      this.cueStick = new CueStick(maxAnisotropy);
      this.scene.add(this.cueStick.group);

      this.scene.add(this.replayAnalysisOverlay.group);

      this.setupMatchOverlays();

      // 7. Rapier3D Physics World
      this.physics = new PhysicsWorld();
      await this.physics.init((ballNumber, _pocketId) => {
        const st = useGameStore.getState();
        st.addPocketedBall(ballNumber);
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
          if (this.replayController.isActive()) {
            this.exitReplay();
          }
          if (snapshot.totalMatchShots === 0) {
            this.shotRecorder.clearMatchShots();
            this.lastOnlineShotSeqRecorded = -1;
            useGameStore.getState().setReplayShots([]);
          }
          this.strikeAnim.active = false;
          this.strikeAnim.impulseApplied = false;
          this.wasBallsMoving = false;
          this.lastRemoteShotSeqAnim = -1;
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
        },
        onOnlineShotSettled: (snapshot, balls) => {
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
            });
            if (rec) {
              useGameStore.getState().setReplayShots(this.shotRecorder.getSummariesNewestFirst());
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
          if (this.replayController.isActive()) {
            this.exitReplay();
          }
          this.shotRecorder.clearMatchShots();
          this.lastOnlineShotSeqRecorded = -1;
          this.strikeAnim.active = false;
          this.wasBallsMoving = false;
          this.physics.resetRack(generateOfficialEightBallRack());
        },
      });

      // 9. Store subscription for live UI settings, match config & camera presets
      this.unsubStore = useGameStore.subscribe((state) => {
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
          this.poolTable.setFeltTheme(state.settings.feltTheme);
        }
        if (state.settings.shadowsEnabled !== this.lastShadowsEnabled) {
          this.lastShadowsEnabled = state.settings.shadowsEnabled;
          this.renderer.shadowMap.enabled =
            !this.isSoftwareGl && state.settings.shadowsEnabled;
          this.keyLight.castShadow =
            !this.isSoftwareGl && state.settings.shadowsEnabled;
        }
        if (state.settings.cameraSensitivity !== this.lastSensitivity) {
          this.lastSensitivity = state.settings.cameraSensitivity;
          this.cameraController.setSensitivity(state.settings.cameraSensitivity);
        }
        if (state.screen !== this.lastScreen) {
          this.lastScreen = state.screen;
          if (state.screen === 'menu') {
            if (this.replayController.isActive()) {
              this.exitReplay();
            }
            this.physics.setShotStepObserver(null);
            this.shotRecorder.cancelActiveRecording();
            this.aiTurnController?.cancel();
            this.matchManager.enterMenu();
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
          this.setCalledShot(store.calledShot.targetBall, pocket.id as PocketId);
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
      this.scene.add(softbox);
    }

    const overheadIntensity = this.isSoftwareGl ? 2.1 : 1.42;
    for (const px of [-0.66, 0.66]) {
      const overheadPool = new THREE.PointLight(0xffedd0, overheadIntensity, 6.5, 1.4);
      overheadPool.position.set(px, 2.18, 0);
      this.scene.add(overheadPool);
    }
  }

  private setupStudioRoom(maxAnisotropy: number) {
    const floorTex = createStudioFloorTexture(maxAnisotropy);
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
    store.resetMatchStats();
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

  private syncReplayUi(force = false) {
    const now = performance.now();
    if (!force && now - this.lastReplayUiSyncAt < 32) return;
    this.lastReplayUiSyncAt = now;

    const shot = this.replayController.getShot();
    const activeCol = this.replayController.getActiveCollisionHighlight();
    useGameStore.getState().setReplayUiState({
      replayActive: this.replayController.isActive(),
      replayShotId: shot?.id ?? null,
      replayPlaying: this.replayController.isPlaying(),
      replayTimeSec: this.replayController.getCurrentTimeSec(),
      replayDurationSec: this.replayController.getDurationSec(),
      replaySpeed: this.replayController.getSpeed(),
      replayAutoSlowMo: this.replayController.getAutoSlowMo(),
      replayShowAnalysis: this.replayController.getShowAnalysis(),
      replayActiveCollisionLabel: activeCol ? formatCollisionLabel(activeCol) : null,
    });
  }

  private renderCurrentReplayInstant() {
    if (this.replayController.sampleInterpolatedFrames(this.replayFramesScratch)) {
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
      }
    }
    this.replayAnalysisOverlay.update(
      this.replayController.getShowAnalysis(),
      this.replayController.getCurrentTimeSec(),
    );
  }

  // ==================== PHASE 6: ISOLATED REPLAY API ====================

  public enterReplay(shotId?: string) {
    const store = useGameStore.getState();
    if (
      store.screen !== 'playing' ||
      store.ballsMoving ||
      store.isShotAnimating ||
      this.strikeAnim.active
    ) {
      return;
    }

    const shot = this.shotRecorder.getShotById(shotId ?? null);
    if (!shot) return;

    // Pause AI turn orchestration while player reviews replay; resumed cleanly on exitReplay()
    this.aiTurnController?.cancel();
    store.setIsAiThinking(false);

    const backup = this.captureLiveBallBackup();
    this.replayController.enterReplay(shot, backup);
    this.replayAnalysisOverlay.setShot(shot);
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
  }

  public exitReplay() {
    if (!this.replayController.isActive()) return;
    const backup = this.replayController.exitReplay();
    this.replayAnalysisOverlay.clear();
    this.replayAnalysisOverlay.update(false, 0);

    const store = useGameStore.getState();
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
    const shot = this.shotRecorder.getShotById(shotId);
    if (!shot) return;
    this.replayController.switchShot(shot);
    this.replayAnalysisOverlay.setShot(shot);
    this.renderCurrentReplayInstant();
    this.syncReplayUi(true);
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
    this.replayController.seek(timeSec);
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
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
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

    // 1. FPS meter update (every 0.4s)
    this.fpsFrames++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.4) {
      const currentFps = Math.round(this.fpsFrames / this.fpsTimer);
      if (currentFps !== store.fps) {
        store.setFps(currentFps);
      }
      this.fpsFrames = 0;
      this.fpsTimer = 0;
    }

    // 2. Continuous keyboard aiming input
    this.inputManager.update(dt);

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
      this.replayController.step(dt);
      this.renderCurrentReplayInstant();
      const finishedPlayback = wasPlaying && !this.replayController.isPlaying();
      this.syncReplayUi(finishedPlayback);

      this.placementGroup.visible = false;
      this.calledPocketRing.visible = false;
      this.cueStick.update(_cueBallPos, 0, 0, false, false, null, { x: 0, y: 0 }, dt, false);
      this.cameraController.update(dt, false);
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
            });
            if (rec) {
              store.setReplayShots(this.shotRecorder.getSummariesNewestFirst());
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
        this.wasBallsMoving = movingNow;
        store.setBallsMoving(movingNow);
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
      this.renderer.domElement.removeEventListener(
        'pointerdown',
        this.onCanvasPointerDownBound,
        { capture: true },
      );
    }

    this.inputManager?.dispose();
    this.cameraController?.dispose();
    this.physics?.setShotStepObserver(null);
    this.physics?.dispose();
    this.shotRecorder.clearMatchShots();
    this.replayController.exitReplay();
    this.replayAnalysisOverlay.dispose();

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
}
