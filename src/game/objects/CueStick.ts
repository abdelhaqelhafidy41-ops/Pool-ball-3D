import * as THREE from 'three';
import type { CueSpin, GameScreen } from '../../store/useGameStore';
import type { AimTrajectoryPrediction } from '../physics/PhysicsWorld';
import type { AiDifficulty, AiStatusState, GameMode, OpponentType } from '../rules/types';
import { BALL_SPECS, CUE_SPECS, TABLE_DIMENSIONS } from '../utils/constants';
import { disposeObject3D } from '../utils/dispose';
import { createCueButtTexture, createCueShaftTexture } from '../utils/ProceduralTextures';

const MAX_CUE_POINTS = 64;
const MAX_TARGET_POINTS = 96;
const MAX_DEFLECT_POINTS = 64;
const SHORT_OBJECT_MAX_LEN = 0.14;

export type AimGuideVisualMode = 'none' | 'short' | 'master_preview';

export interface AimGuideModeParams {
  screen: GameScreen;
  gameMode: GameMode;
  opponentType: OpponentType;
  aiDifficulty: AiDifficulty;
  showAimGuideSetting: boolean;
  showAiAimGuideSetting: boolean;
  isAiThinking: boolean;
  aiPhase: AiStatusState['phase'];
  canLocalAct: boolean;
  canDisplayCue: boolean;
  isStrikeAnimating: boolean;
  ballsMoving: boolean;
  replayActive: boolean;
  onlineSpectating: boolean;
}

/**
 * Pure object-ball trajectory visibility & length rule.
 * The cue ball aiming guide remains full-length whenever this returns !== 'none'.
 * The extended, target-colored object ball trajectory is restricted STRICTLY to
 * local player aiming in an active 8-ball match against AI Master ('pro') difficulty.
 */
export function resolveAimGuideVisualMode(params: AimGuideModeParams): AimGuideVisualMode {
  if (
    !params.canDisplayCue ||
    params.isStrikeAnimating ||
    params.ballsMoving ||
    params.screen !== 'playing' ||
    params.replayActive ||
    params.onlineSpectating
  ) {
    return 'none';
  }

  if (params.isAiThinking) {
    if (
      params.showAiAimGuideSetting &&
      (params.aiPhase === 'aiming' || params.aiPhase === 'pullback')
    ) {
      return 'short';
    }
    return 'none';
  }

  if (!params.canLocalAct || !params.showAimGuideSetting) {
    return 'none';
  }

  if (
    params.gameMode === 'eightBall' &&
    params.opponentType === 'ai' &&
    params.aiDifficulty === 'pro'
  ) {
    return 'master_preview';
  }

  return 'short';
}

export interface PolyPoint2D {
  x: number;
  z: number;
}

/**
 * Trims a predicted polyline strictly to a maximum arc length (in meters)
 * without allocating new point objects when `outScratch` is reused.
 */
export function trimPolylineByMaxLength(
  points: readonly PolyPoint2D[],
  maxLength: number,
  maxPoints: number,
  outScratch: PolyPoint2D[],
): number {
  if (points.length < 2 || maxLength <= 0 || maxPoints < 2) {
    return 0;
  }

  let accumDist = 0;
  let count = 1;
  outScratch[0].x = points[0].x;
  outScratch[0].z = points[0].z;

  for (let i = 1; i < points.length && count < maxPoints; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const segLen = Math.hypot(cur.x - prev.x, cur.z - prev.z);
    if (accumDist + segLen >= maxLength) {
      const remain = Math.max(0, maxLength - accumDist);
      const ratio = segLen > 1e-6 ? remain / segLen : 0;
      outScratch[count].x = prev.x + (cur.x - prev.x) * ratio;
      outScratch[count].z = prev.z + (cur.z - prev.z) * ratio;
      count++;
      break;
    }
    accumDist += segLen;
    outScratch[count].x = cur.x;
    outScratch[count].z = cur.z;
    count++;
  }

  return count >= 2 ? count : 0;
}

const _neutralObjectColor = new THREE.Color(0xe2e8f0);
const _trimmedObjectScratch: PolyPoint2D[] = Array.from(
  { length: MAX_TARGET_POINTS },
  () => ({ x: 0, z: 0 }),
);

export class CueStick {
  public readonly group = new THREE.Group();
  public readonly stickPivot = new THREE.Group();
  public readonly stickBody = new THREE.Group();

  private readonly aimLine: THREE.Line;
  private readonly aimLinePos: Float32Array;
  private readonly aimMat: THREE.LineDashedMaterial;

  private readonly objectLine: THREE.Line;
  private readonly objectLinePos: Float32Array;
  private readonly objectMat: THREE.LineBasicMaterial;
  private readonly objectContrastLine: THREE.Line;
  private readonly objectContrastPos: Float32Array;
  private readonly objectContrastMat: THREE.LineBasicMaterial;

  private readonly deflectLine: THREE.Line;
  private readonly deflectLinePos: Float32Array;
  private readonly deflectMat: THREE.LineDashedMaterial;

  private readonly ghostRing: THREE.Mesh;
  private readonly ghostRingMat: THREE.MeshBasicMaterial;
  private readonly ghostBall: THREE.Mesh;

  private readonly maxAnisotropy: number;
  private currentSkinId = 'cue_classic_maple';
  private tipMat!: THREE.MeshStandardMaterial;
  private ferruleMat!: THREE.MeshPhysicalMaterial;
  private shaftMat!: THREE.MeshPhysicalMaterial;
  private jointMat!: THREE.MeshPhysicalMaterial;
  private ringMat!: THREE.MeshPhysicalMaterial;
  private buttMat!: THREE.MeshPhysicalMaterial;
  private buttRingMat!: THREE.MeshPhysicalMaterial;
  private bumperMat!: THREE.MeshStandardMaterial;
  private buttTex: THREE.CanvasTexture | null = null;
  private shaftTex: THREE.CanvasTexture | null = null;

  private currentElevation: number = CUE_SPECS.baseElevationRad;

  constructor(maxAnisotropy: number) {
    this.maxAnisotropy = maxAnisotropy;
    this.group.name = 'CueSystem';
    this.stickPivot.name = 'CueStickPivot';
    this.stickBody.name = 'CueStickBody';

    this.buildStickParts(maxAnisotropy);
    this.stickPivot.add(this.stickBody);
    this.group.add(this.stickPivot);

    // 1. Primary cue trajectory polyline (original crisp dashed white full-length guide)
    this.aimLinePos = new Float32Array(MAX_CUE_POINTS * 3);
    const aimGeo = new THREE.BufferGeometry();
    aimGeo.setAttribute('position', new THREE.BufferAttribute(this.aimLinePos, 3));
    aimGeo.setDrawRange(0, 0);
    this.aimMat = new THREE.LineDashedMaterial({
      color: 0xf8fafc,
      dashSize: 0.032,
      gapSize: 0.018,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    this.aimLine = new THREE.Line(aimGeo, this.aimMat);
    this.aimLine.name = 'AimGuideCueLine';
    this.aimLine.frustumCulled = false;
    this.group.add(this.aimLine);

    // 2. Struck object ball trajectory polyline (short subtle stub in normal modes; full target-colored path in AI Master)
    this.objectLinePos = new Float32Array(MAX_TARGET_POINTS * 3);
    const objGeo = new THREE.BufferGeometry();
    objGeo.setAttribute('position', new THREE.BufferAttribute(this.objectLinePos, 3));
    objGeo.setDrawRange(0, 0);
    this.objectMat = new THREE.LineBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
    });
    this.objectLine = new THREE.Line(objGeo, this.objectMat);
    this.objectLine.name = 'AimGuideObjectLine';
    this.objectLine.frustumCulled = false;
    this.objectLine.visible = false;
    this.group.add(this.objectLine);

    this.objectContrastPos = new Float32Array(MAX_TARGET_POINTS * 3);
    const objContrastGeo = new THREE.BufferGeometry();
    objContrastGeo.setAttribute('position', new THREE.BufferAttribute(this.objectContrastPos, 3));
    objContrastGeo.setDrawRange(0, 0);
    this.objectContrastMat = new THREE.LineBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.objectContrastLine = new THREE.Line(objContrastGeo, this.objectContrastMat);
    this.objectContrastLine.name = 'AimGuideObjectContrastLine';
    this.objectContrastLine.frustumCulled = false;
    this.objectContrastLine.visible = false;
    this.group.add(this.objectContrastLine);

    // 3. Cue ball post-impact deflection trajectory polyline (original cool sky tint, full path)
    this.deflectLinePos = new Float32Array(MAX_DEFLECT_POINTS * 3);
    const defGeo = new THREE.BufferGeometry();
    defGeo.setAttribute('position', new THREE.BufferAttribute(this.deflectLinePos, 3));
    defGeo.setDrawRange(0, 0);
    this.deflectMat = new THREE.LineDashedMaterial({
      color: 0x7dd3fc,
      dashSize: 0.022,
      gapSize: 0.016,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
    });
    this.deflectLine = new THREE.Line(defGeo, this.deflectMat);
    this.deflectLine.name = 'AimGuideDeflectLine';
    this.deflectLine.frustumCulled = false;
    this.deflectLine.visible = false;
    this.group.add(this.deflectLine);

    // 4. Ghost contact ring on felt + subtle translucent ghost cue sphere (original appearance)
    const ringGeo = new THREE.RingGeometry(
      BALL_SPECS.radius * 0.78,
      BALL_SPECS.radius * 1.0,
      36,
    );
    ringGeo.rotateX(-Math.PI / 2);
    this.ghostRingMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.76,
      depthWrite: false,
    });
    this.ghostRing = new THREE.Mesh(ringGeo, this.ghostRingMat);
    this.ghostRing.name = 'AimGuideGhostRing';
    this.ghostRing.position.y = TABLE_DIMENSIONS.surfaceY + 0.002;
    this.ghostRing.visible = false;
    this.group.add(this.ghostRing);

    const ghostSphereGeo = new THREE.SphereGeometry(BALL_SPECS.radius * 0.98, 24, 18);
    const ghostSphereMat = new THREE.MeshBasicMaterial({
      color: 0xf8fafc,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    this.ghostBall = new THREE.Mesh(ghostSphereGeo, ghostSphereMat);
    this.ghostBall.name = 'AimGuideGhostBall';
    this.ghostBall.position.y = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;
    this.ghostBall.visible = false;
    this.group.add(this.ghostBall);
  }

  private buildStickParts(maxAnisotropy: number) {
    // Built along -X: tip at x = 0, butt end at x = -CUE_SPECS.length
    this.tipMat = new THREE.MeshStandardMaterial({
      color: 0x1b5299,
      roughness: 0.9,
      metalness: 0.0,
    });

    this.ferruleMat = new THREE.MeshPhysicalMaterial({
      color: 0xf7f4eb,
      roughness: 0.2,
      clearcoat: 0.65,
    });

    this.shaftMat = new THREE.MeshPhysicalMaterial({
      color: 0xe0bd8b,
      roughness: 0.26,
      clearcoat: 0.55,
      clearcoatRoughness: 0.18,
    });

    this.jointMat = new THREE.MeshPhysicalMaterial({
      color: 0xd9b35c,
      metalness: 0.94,
      roughness: 0.18,
      anisotropy: 0.7,
    });

    this.ringMat = new THREE.MeshPhysicalMaterial({
      color: 0xd8dde6,
      metalness: 0.95,
      roughness: 0.14,
    });

    this.buttTex = createCueButtTexture(maxAnisotropy, this.currentSkinId);
    this.buttMat = new THREE.MeshPhysicalMaterial({
      map: this.buttTex,
      roughness: 0.22,
      clearcoat: 0.82,
      clearcoatRoughness: 0.1,
    });

    this.buttRingMat = new THREE.MeshPhysicalMaterial({
      color: 0xd9b35c,
      metalness: 0.94,
      roughness: 0.18,
      anisotropy: 0.7,
    });

    this.bumperMat = new THREE.MeshStandardMaterial({
      color: 0x111215,
      roughness: 0.85,
    });

    const tipGeo = new THREE.CylinderGeometry(
      CUE_SPECS.tipRadius * 0.86,
      CUE_SPECS.tipRadius,
      0.007,
      24,
    );
    tipGeo.rotateZ(-Math.PI / 2);
    const tipMesh = new THREE.Mesh(tipGeo, this.tipMat);
    tipMesh.position.x = -0.0035;
    tipMesh.castShadow = true;
    this.stickBody.add(tipMesh);

    const tipDomeGeo = new THREE.SphereGeometry(
      CUE_SPECS.tipRadius * 0.86,
      16,
      10,
      0,
      Math.PI * 2,
      0,
      Math.PI * 0.5,
    );
    tipDomeGeo.rotateZ(-Math.PI / 2);
    const tipDome = new THREE.Mesh(tipDomeGeo, this.tipMat);
    tipDome.position.x = -0.0005;
    this.stickBody.add(tipDome);

    const ferruleGeo = new THREE.CylinderGeometry(
      CUE_SPECS.tipRadius,
      CUE_SPECS.tipRadius * 1.04,
      0.025,
      24,
    );
    ferruleGeo.rotateZ(-Math.PI / 2);
    const ferruleMesh = new THREE.Mesh(ferruleGeo, this.ferruleMat);
    ferruleMesh.position.x = -0.0195;
    ferruleMesh.castShadow = true;
    this.stickBody.add(ferruleMesh);

    const shaftPts = [
      new THREE.Vector2(CUE_SPECS.tipRadius * 1.04, 0),
      new THREE.Vector2(0.0072, 0.24),
      new THREE.Vector2(0.009, 0.48),
      new THREE.Vector2(0.0108, 0.703),
    ];
    const shaftGeo = new THREE.LatheGeometry(shaftPts, 24);
    shaftGeo.rotateZ(Math.PI / 2);
    const shaftMesh = new THREE.Mesh(shaftGeo, this.shaftMat);
    shaftMesh.position.x = -0.032;
    shaftMesh.castShadow = true;
    this.stickBody.add(shaftMesh);

    const jointGeo = new THREE.CylinderGeometry(0.011, 0.0113, 0.026, 24);
    jointGeo.rotateZ(-Math.PI / 2);
    const jointMesh = new THREE.Mesh(jointGeo, this.jointMat);
    jointMesh.position.x = -0.748;
    jointMesh.castShadow = true;
    this.stickBody.add(jointMesh);

    const ringGeo = new THREE.CylinderGeometry(0.0114, 0.0114, 0.006, 24);
    ringGeo.rotateZ(-Math.PI / 2);
    const ringMesh = new THREE.Mesh(ringGeo, this.ringMat);
    ringMesh.position.x = -0.764;
    this.stickBody.add(ringMesh);

    const buttPts = [
      new THREE.Vector2(0.0114, 0),
      new THREE.Vector2(0.0135, 0.34),
      new THREE.Vector2(CUE_SPECS.buttRadius, 0.681),
    ];
    const buttGeo = new THREE.LatheGeometry(buttPts, 28);
    buttGeo.rotateZ(Math.PI / 2);
    const buttMesh = new THREE.Mesh(buttGeo, this.buttMat);
    buttMesh.position.x = -0.767;
    buttMesh.castShadow = true;
    this.stickBody.add(buttMesh);

    const buttRingGeo = new THREE.CylinderGeometry(
      CUE_SPECS.buttRadius * 1.01,
      CUE_SPECS.buttRadius * 1.01,
      0.008,
      24,
    );
    buttRingGeo.rotateZ(-Math.PI / 2);
    const buttRing = new THREE.Mesh(buttRingGeo, this.buttRingMat);
    buttRing.position.x = -1.448;
    this.stickBody.add(buttRing);

    const bumperGeo = new THREE.CylinderGeometry(
      CUE_SPECS.buttRadius * 0.96,
      CUE_SPECS.buttRadius * 0.85,
      0.02,
      20,
    );
    bumperGeo.rotateZ(-Math.PI / 2);
    const bumperMesh = new THREE.Mesh(bumperGeo, this.bumperMat);
    bumperMesh.position.x = -1.462;
    this.stickBody.add(bumperMesh);

    this.stickBody.rotation.z = -CUE_SPECS.baseElevationRad;
  }

  public applyCueSkin(cueSkinId: string) {
    const targetId = cueSkinId || 'cue_classic_maple';
    if (this.currentSkinId === targetId && this.buttTex) return;
    this.currentSkinId = targetId;

    const oldButtTex = this.buttTex;
    const oldShaftTex = this.shaftTex;
    this.buttTex = createCueButtTexture(this.maxAnisotropy, targetId);
    this.shaftTex = createCueShaftTexture(this.maxAnisotropy, targetId);

    this.buttMat.map = this.buttTex;
    this.buttMat.emissive.setHex(0x000000);
    this.buttMat.emissiveIntensity = 0;

    this.shaftMat.map = this.shaftTex;
    this.shaftMat.emissive.setHex(0x000000);
    this.shaftMat.emissiveIntensity = 0;

    switch (targetId) {
      case 'cue_walnut_heritage':
        this.tipMat.color.setHex(0x1f4b82);
        this.ferruleMat.color.setHex(0xf3ece0);
        this.shaftMat.color.setHex(0xc99c6b);
        this.shaftMat.metalness = 0.0;
        this.shaftMat.roughness = 0.24;
        this.jointMat.color.setHex(0xd4a84f);
        this.ringMat.color.setHex(0xe2d4b0);
        this.buttRingMat.color.setHex(0xd4a84f);
        break;
      case 'cue_carbon_stealth':
        this.tipMat.color.setHex(0x0284c7);
        this.ferruleMat.color.setHex(0x181e28);
        this.shaftMat.color.setHex(0xffffff);
        this.shaftMat.metalness = 0.25;
        this.shaftMat.roughness = 0.3;
        this.jointMat.color.setHex(0x64748b);
        this.ringMat.color.setHex(0x38bdf8);
        this.buttRingMat.color.setHex(0x64748b);
        break;
      case 'cue_gold_imperial':
        this.tipMat.color.setHex(0x1d4ed8);
        this.ferruleMat.color.setHex(0xfef9e7);
        this.shaftMat.color.setHex(0xebd29e);
        this.shaftMat.metalness = 0.12;
        this.shaftMat.roughness = 0.18;
        this.jointMat.color.setHex(0xf6c85f);
        this.ringMat.color.setHex(0xffe49e);
        this.buttRingMat.color.setHex(0xf6c85f);
        break;
      case 'cue_platinum_apex':
        this.tipMat.color.setHex(0x0ea5e9);
        this.ferruleMat.color.setHex(0xf1f5f9);
        this.shaftMat.color.setHex(0xdbe3ec);
        this.shaftMat.metalness = 0.32;
        this.shaftMat.roughness = 0.16;
        this.jointMat.color.setHex(0xe2e8f0);
        this.ringMat.color.setHex(0x38bdf8);
        this.buttRingMat.color.setHex(0xe2e8f0);
        break;
      case 'cue_neon_cosmic':
        this.tipMat.color.setHex(0x22d3ee);
        this.ferruleMat.color.setHex(0x14172a);
        this.shaftMat.color.setHex(0xffffff);
        this.shaftMat.metalness = 0.22;
        this.shaftMat.roughness = 0.2;
        this.shaftMat.emissive.setHex(0x4c1d95);
        this.shaftMat.emissiveIntensity = 0.32;
        this.buttMat.emissive.setHex(0x22d3ee);
        this.buttMat.emissiveIntensity = 0.14;
        this.jointMat.color.setHex(0x22d3ee);
        this.ringMat.color.setHex(0xec4899);
        this.buttRingMat.color.setHex(0xec4899);
        break;
      case 'cue_dragon_sovereign':
        this.tipMat.color.setHex(0xb91c1c);
        this.ferruleMat.color.setHex(0xfdf5e6);
        this.shaftMat.color.setHex(0xe6be8a);
        this.shaftMat.metalness = 0.08;
        this.shaftMat.roughness = 0.2;
        this.jointMat.color.setHex(0xfbbf24);
        this.ringMat.color.setHex(0xfef08a);
        this.buttRingMat.color.setHex(0xfbbf24);
        break;
      case 'cue_season1_eclipse':
      case 'cue_season1_solar_apex':
        this.tipMat.color.setHex(0xd97706);
        this.ferruleMat.color.setHex(0xfef3c7);
        this.shaftMat.color.setHex(targetId === 'cue_season1_solar_apex' ? 0xf3d48a : 0xdfe4ee);
        this.shaftMat.metalness = 0.22;
        this.shaftMat.roughness = 0.17;
        this.jointMat.color.setHex(0xfbbf24);
        this.ringMat.color.setHex(0xfde68a);
        this.buttRingMat.color.setHex(0xfbbf24);
        break;
      case 'cue_classic_maple':
      default:
        this.tipMat.color.setHex(0x1b5299);
        this.ferruleMat.color.setHex(0xf7f4eb);
        this.shaftMat.color.setHex(0xe0bd8b);
        this.shaftMat.metalness = 0.0;
        this.shaftMat.roughness = 0.26;
        this.jointMat.color.setHex(0xd9b35c);
        this.ringMat.color.setHex(0xd8dde6);
        this.buttRingMat.color.setHex(0xd9b35c);
        break;
    }

    this.buttMat.needsUpdate = true;
    this.shaftMat.needsUpdate = true;
    this.jointMat.needsUpdate = true;
    this.ringMat.needsUpdate = true;
    this.buttRingMat.needsUpdate = true;
    this.ferruleMat.needsUpdate = true;
    this.tipMat.needsUpdate = true;

    oldButtTex?.dispose();
    oldShaftTex?.dispose();
  }

  public dispose() {
    this.buttTex?.dispose();
    this.shaftTex?.dispose();
    this.buttTex = null;
    this.shaftTex = null;
    disposeObject3D(this.group);
  }

  /**
   * Computes exact spherical contact offset on the cue ball surface matching PhysicsWorld.
   */
  public static computeSurfaceContactOffsets(spin: CueSpin): {
    surfaceDistanceX: number;
    offsetY: number;
    offsetZ: number;
  } {
    const R = BALL_SPECS.radius;
    const rawR = Math.hypot(spin.x, spin.y);
    const maxR = 0.78;
    const sx = rawR > maxR ? (spin.x / rawR) * maxR : spin.x;
    const sy = rawR > maxR ? (spin.y / rawR) * maxR : spin.y;

    const offsetY = sy * R * 0.76;
    const offsetZ = sx * R * 0.72;
    const surfaceDistanceX = Math.sqrt(
      Math.max(1e-6, R * R - offsetY * offsetY - offsetZ * offsetZ),
    );
    return { surfaceDistanceX, offsetY, offsetZ };
  }

  private computeClearanceElevation(
    cueBallPos: THREE.Vector3,
    aimAngle: number,
    tipDistanceBehindCenter: number,
  ): number {
    const D = TABLE_DIMENSIONS;
    const backX = -Math.cos(aimAngle);
    const backZ = -Math.sin(aimAngle);

    let distToCushion = 2.6;
    if (Math.abs(backX) > 1e-4) {
      const targetX = backX > 0 ? D.halfLength : -D.halfLength;
      const tx = (targetX - cueBallPos.x) / backX;
      if (tx > 0 && tx < distToCushion) distToCushion = tx;
    }
    if (Math.abs(backZ) > 1e-4) {
      const targetZ = backZ > 0 ? D.halfWidth : -D.halfWidth;
      const tz = (targetZ - cueBallPos.z) / backZ;
      if (tz > 0 && tz < distToCushion) distToCushion = tz;
    }

    const railTopClearY = D.surfaceY + D.railHeight + 0.026;
    const requiredRise = Math.max(0, railTopClearY - cueBallPos.y);
    const spanAfterTip = Math.max(0.16, distToCushion - tipDistanceBehindCenter);
    const minAngle = Math.atan2(requiredRise, spanAfterTip);

    return Math.min(0.28, Math.max(CUE_SPECS.baseElevationRad, minAngle));
  }

  private setPolyline(
    line: THREE.Line,
    arr: Float32Array,
    maxPts: number,
    points: readonly { x: number; z: number }[],
    y: number,
    dashed: boolean,
    explicitCount?: number,
  ): boolean {
    const count = Math.min(maxPts, explicitCount ?? points.length);
    if (count < 2) {
      line.visible = false;
      line.geometry.setDrawRange(0, 0);
      return false;
    }

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      arr[idx] = points[i].x;
      arr[idx + 1] = y;
      arr[idx + 2] = points[i].z;
    }

    // Pad trailing slots with the final vertex so computeLineDistances() never measures a jump to origin
    const last = points[count - 1];
    for (let i = count; i < maxPts; i++) {
      const idx = i * 3;
      arr[idx] = last.x;
      arr[idx + 1] = y;
      arr[idx + 2] = last.z;
    }

    const attr = line.geometry.attributes.position as THREE.BufferAttribute;
    attr.needsUpdate = true;
    line.geometry.setDrawRange(0, count);
    if (dashed) {
      line.computeLineDistances();
    }
    line.visible = true;
    return true;
  }

  private hideAllGuides() {
    this.aimLine.visible = false;
    this.aimLine.geometry.setDrawRange(0, 0);
    this.objectLine.visible = false;
    this.objectLine.geometry.setDrawRange(0, 0);
    this.objectContrastLine.visible = false;
    this.objectContrastLine.geometry.setDrawRange(0, 0);
    this.deflectLine.visible = false;
    this.deflectLine.geometry.setDrawRange(0, 0);
    this.ghostRing.visible = false;
    this.ghostBall.visible = false;
  }

  public update(
    cueBallPos: THREE.Vector3,
    aimAngle: number,
    tipDistanceBehindCenter: number,
    visible: boolean,
    guideMode: AimGuideVisualMode,
    trajectory: AimTrajectoryPrediction | null,
    targetColor: THREE.Color | null,
    needsContrastHalo: boolean,
    spin: CueSpin,
    delta = 0.016,
    isShotLocked = false,
  ) {
    this.group.visible = visible;
    if (!visible) {
      this.hideAllGuides();
      return;
    }

    this.stickPivot.position.copy(cueBallPos);
    this.stickPivot.rotation.y = -aimAngle;

    if (!isShotLocked) {
      const targetElev = this.computeClearanceElevation(
        cueBallPos,
        aimAngle,
        tipDistanceBehindCenter,
      );
      this.currentElevation = THREE.MathUtils.damp(
        this.currentElevation,
        targetElev,
        12,
        delta,
      );
    }

    this.stickBody.rotation.z = -this.currentElevation;

    // Align cue tip strictly along the aiming axis pointing directly at the spherical contact point
    const { offsetY, offsetZ } = CueStick.computeSurfaceContactOffsets(spin);
    this.stickBody.position.set(
      -tipDistanceBehindCenter,
      offsetY,
      offsetZ,
    );

    if (guideMode === 'none' || !trajectory) {
      this.hideAllGuides();
      return;
    }

    const guideY = TABLE_DIMENSIONS.surfaceY + 0.0026;
    const ballCenterY = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;

    // 1. CUE BALL TRAJECTORY — Restored exactly to original full-length white guide, ghost contact & deflection
    this.setPolyline(
      this.aimLine,
      this.aimLinePos,
      MAX_CUE_POINTS,
      trajectory.cuePath,
      guideY,
      true,
    );

    if (trajectory.ghostBallX !== null && trajectory.ghostBallZ !== null) {
      this.ghostRing.visible = true;
      this.ghostRing.position.set(
        trajectory.ghostBallX,
        TABLE_DIMENSIONS.surfaceY + 0.002,
        trajectory.ghostBallZ,
      );
      this.ghostBall.visible = trajectory.hitType === 'ball';
      this.ghostBall.position.set(
        trajectory.ghostBallX,
        ballCenterY,
        trajectory.ghostBallZ,
      );
    } else {
      this.ghostRing.visible = false;
      this.ghostBall.visible = false;
    }

    this.setPolyline(
      this.deflectLine,
      this.deflectLinePos,
      MAX_DEFLECT_POINTS,
      trajectory.cuePostPath,
      guideY + 0.0002,
      true,
    );

    // 2. OBJECT BALL TRAJECTORY — Separate visualization:
    //    - Normal modes ('short'): short subtle segment immediately after predicted collision
    //    - AI Master ('master_preview'): full outgoing predicted path dynamically colored to target ball
    if (trajectory.targetPath.length < 2) {
      this.objectLine.visible = false;
      this.objectLine.geometry.setDrawRange(0, 0);
      this.objectContrastLine.visible = false;
      this.objectContrastLine.geometry.setDrawRange(0, 0);
      return;
    }

    if (guideMode === 'master_preview') {
      const hasBallTarget = trajectory.targetBallNumber !== null && targetColor !== null;
      const activeColor = hasBallTarget ? targetColor : _neutralObjectColor;
      const useHalo = hasBallTarget && needsContrastHalo;

      this.objectMat.color.copy(activeColor);
      this.objectMat.opacity = useHalo ? 0.94 : 0.88;
      const objShown = this.setPolyline(
        this.objectLine,
        this.objectLinePos,
        MAX_TARGET_POINTS,
        trajectory.targetPath,
        guideY + 0.0005,
        false,
      );
      if (useHalo && objShown) {
        this.setPolyline(
          this.objectContrastLine,
          this.objectContrastPos,
          MAX_TARGET_POINTS,
          trajectory.targetPath,
          guideY + 0.00025,
          false,
        );
      } else {
        this.objectContrastLine.visible = false;
        this.objectContrastLine.geometry.setDrawRange(0, 0);
      }
      return;
    }

    // Normal gameplay ('short'): short, subtle outgoing segment only (never reveals full pocket route)
    const shortCount = trimPolylineByMaxLength(
      trajectory.targetPath,
      SHORT_OBJECT_MAX_LEN,
      MAX_TARGET_POINTS,
      _trimmedObjectScratch,
    );
    this.objectContrastLine.visible = false;
    this.objectContrastLine.geometry.setDrawRange(0, 0);

    if (shortCount >= 2) {
      this.objectMat.color.copy(_neutralObjectColor);
      this.objectMat.opacity = 0.68;
      this.setPolyline(
        this.objectLine,
        this.objectLinePos,
        MAX_TARGET_POINTS,
        _trimmedObjectScratch,
        guideY + 0.0005,
        false,
        shortCount,
      );
    } else {
      this.objectLine.visible = false;
      this.objectLine.geometry.setDrawRange(0, 0);
    }
  }
}
