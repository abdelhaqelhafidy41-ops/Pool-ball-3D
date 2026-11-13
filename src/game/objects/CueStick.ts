import * as THREE from 'three';
import type { CueSpin } from '../../store/useGameStore';
import type { AimTrajectoryPrediction } from '../physics/PhysicsWorld';
import { BALL_SPECS, CUE_SPECS, TABLE_DIMENSIONS } from '../utils/constants';
import { createCueButtTexture } from '../utils/ProceduralTextures';

const MAX_CUE_POINTS = 64;
const MAX_TARGET_POINTS = 96;
const MAX_DEFLECT_POINTS = 64;

export class CueStick {
  public readonly group = new THREE.Group();
  public readonly stickPivot = new THREE.Group();
  public readonly stickBody = new THREE.Group();

  private readonly aimLine: THREE.Line;
  private readonly aimLinePos: Float32Array;
  private readonly objectLine: THREE.Line;
  private readonly objectLinePos: Float32Array;
  private readonly objectMat: THREE.LineBasicMaterial;
  private readonly deflectLine: THREE.Line;
  private readonly deflectLinePos: Float32Array;

  private readonly ghostRing: THREE.Mesh;
  private readonly ghostRingMat: THREE.MeshBasicMaterial;
  private readonly ghostBall: THREE.Mesh;

  private currentElevation: number = CUE_SPECS.baseElevationRad;

  constructor(maxAnisotropy: number) {
    this.group.name = 'CueSystem';
    this.stickPivot.name = 'CueStickPivot';
    this.stickBody.name = 'CueStickBody';

    this.buildStickParts(maxAnisotropy);
    this.stickPivot.add(this.stickBody);
    this.group.add(this.stickPivot);

    // 1. Primary cue trajectory polyline (dashed crisp white)
    this.aimLinePos = new Float32Array(MAX_CUE_POINTS * 3);
    const aimGeo = new THREE.BufferGeometry();
    aimGeo.setAttribute('position', new THREE.BufferAttribute(this.aimLinePos, 3));
    aimGeo.setDrawRange(0, 0);
    const aimMat = new THREE.LineDashedMaterial({
      color: 0xf8fafc,
      dashSize: 0.032,
      gapSize: 0.018,
      transparent: true,
      opacity: 0.72,
    });
    this.aimLine = new THREE.Line(aimGeo, aimMat);
    this.aimLine.frustumCulled = false;
    this.group.add(this.aimLine);

    // 2. Struck object ball trajectory polyline (amber-gold, turns emerald when pocketed)
    this.objectLinePos = new Float32Array(MAX_TARGET_POINTS * 3);
    const objGeo = new THREE.BufferGeometry();
    objGeo.setAttribute('position', new THREE.BufferAttribute(this.objectLinePos, 3));
    objGeo.setDrawRange(0, 0);
    this.objectMat = new THREE.LineBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.9,
    });
    this.objectLine = new THREE.Line(objGeo, this.objectMat);
    this.objectLine.frustumCulled = false;
    this.group.add(this.objectLine);

    // 3. Cue ball post-impact deflection trajectory polyline (cool sky tint)
    this.deflectLinePos = new Float32Array(MAX_DEFLECT_POINTS * 3);
    const defGeo = new THREE.BufferGeometry();
    defGeo.setAttribute('position', new THREE.BufferAttribute(this.deflectLinePos, 3));
    defGeo.setDrawRange(0, 0);
    const defMat = new THREE.LineDashedMaterial({
      color: 0x7dd3fc,
      dashSize: 0.022,
      gapSize: 0.016,
      transparent: true,
      opacity: 0.68,
    });
    this.deflectLine = new THREE.Line(defGeo, defMat);
    this.deflectLine.frustumCulled = false;
    this.group.add(this.deflectLine);

    // 4. Ghost contact ring on felt + subtle translucent ghost cue sphere
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
    this.ghostRing.position.y = TABLE_DIMENSIONS.surfaceY + 0.002;
    this.group.add(this.ghostRing);

    const ghostSphereGeo = new THREE.SphereGeometry(BALL_SPECS.radius * 0.98, 24, 18);
    const ghostSphereMat = new THREE.MeshBasicMaterial({
      color: 0xf8fafc,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    this.ghostBall = new THREE.Mesh(ghostSphereGeo, ghostSphereMat);
    this.ghostBall.position.y = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;
    this.group.add(this.ghostBall);
  }

  private buildStickParts(maxAnisotropy: number) {
    // Built along -X: tip at x = 0, butt end at x = -CUE_SPECS.length
    const tipMat = new THREE.MeshStandardMaterial({
      color: 0x1b5299,
      roughness: 0.9,
      metalness: 0.0,
    });

    const ferruleMat = new THREE.MeshPhysicalMaterial({
      color: 0xf7f4eb,
      roughness: 0.2,
      clearcoat: 0.65,
    });

    const mapleMat = new THREE.MeshPhysicalMaterial({
      color: 0xe0bd8b,
      roughness: 0.26,
      clearcoat: 0.55,
      clearcoatRoughness: 0.18,
    });

    const brassMat = new THREE.MeshPhysicalMaterial({
      color: 0xd9b35c,
      metalness: 0.94,
      roughness: 0.18,
      anisotropy: 0.7,
    });

    const chromeMat = new THREE.MeshPhysicalMaterial({
      color: 0xd8dde6,
      metalness: 0.95,
      roughness: 0.14,
    });

    const buttTex = createCueButtTexture(maxAnisotropy);
    const buttMat = new THREE.MeshPhysicalMaterial({
      map: buttTex,
      roughness: 0.22,
      clearcoat: 0.82,
      clearcoatRoughness: 0.1,
    });

    const rubberMat = new THREE.MeshStandardMaterial({
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
    const tipMesh = new THREE.Mesh(tipGeo, tipMat);
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
    const tipDome = new THREE.Mesh(tipDomeGeo, tipMat);
    tipDome.position.x = -0.0005;
    this.stickBody.add(tipDome);

    const ferruleGeo = new THREE.CylinderGeometry(
      CUE_SPECS.tipRadius,
      CUE_SPECS.tipRadius * 1.04,
      0.025,
      24,
    );
    ferruleGeo.rotateZ(-Math.PI / 2);
    const ferruleMesh = new THREE.Mesh(ferruleGeo, ferruleMat);
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
    const shaftMesh = new THREE.Mesh(shaftGeo, mapleMat);
    shaftMesh.position.x = -0.032;
    shaftMesh.castShadow = true;
    this.stickBody.add(shaftMesh);

    const jointGeo = new THREE.CylinderGeometry(0.011, 0.0113, 0.026, 24);
    jointGeo.rotateZ(-Math.PI / 2);
    const jointMesh = new THREE.Mesh(jointGeo, brassMat);
    jointMesh.position.x = -0.748;
    jointMesh.castShadow = true;
    this.stickBody.add(jointMesh);

    const ringGeo = new THREE.CylinderGeometry(0.0114, 0.0114, 0.006, 24);
    ringGeo.rotateZ(-Math.PI / 2);
    const ringMesh = new THREE.Mesh(ringGeo, chromeMat);
    ringMesh.position.x = -0.764;
    this.stickBody.add(ringMesh);

    const buttPts = [
      new THREE.Vector2(0.0114, 0),
      new THREE.Vector2(0.0135, 0.34),
      new THREE.Vector2(CUE_SPECS.buttRadius, 0.681),
    ];
    const buttGeo = new THREE.LatheGeometry(buttPts, 28);
    buttGeo.rotateZ(Math.PI / 2);
    const buttMesh = new THREE.Mesh(buttGeo, buttMat);
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
    const buttRing = new THREE.Mesh(buttRingGeo, brassMat);
    buttRing.position.x = -1.448;
    this.stickBody.add(buttRing);

    const bumperGeo = new THREE.CylinderGeometry(
      CUE_SPECS.buttRadius * 0.96,
      CUE_SPECS.buttRadius * 0.85,
      0.02,
      20,
    );
    bumperGeo.rotateZ(-Math.PI / 2);
    const bumperMesh = new THREE.Mesh(bumperGeo, rubberMat);
    bumperMesh.position.x = -1.462;
    this.stickBody.add(bumperMesh);

    this.stickBody.rotation.z = -CUE_SPECS.baseElevationRad;
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
    points: Array<{ x: number; z: number }>,
    y: number,
    dashed: boolean,
  ): boolean {
    const count = Math.min(maxPts, points.length);
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

  public update(
    cueBallPos: THREE.Vector3,
    aimAngle: number,
    tipDistanceBehindCenter: number,
    visible: boolean,
    showGuide: boolean,
    trajectory: AimTrajectoryPrediction | null,
    spin: CueSpin,
    delta = 0.016,
    isShotLocked = false,
  ) {
    this.group.visible = visible;
    if (!visible) return;

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

    const guideY = TABLE_DIMENSIONS.surfaceY + 0.0026;
    const ballCenterY = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;

    if (!showGuide || !trajectory) {
      this.aimLine.visible = false;
      this.objectLine.visible = false;
      this.deflectLine.visible = false;
      this.ghostRing.visible = false;
      this.ghostBall.visible = false;
      return;
    }

    // 1. Primary Cue Trajectory Polyline
    this.setPolyline(
      this.aimLine,
      this.aimLinePos,
      MAX_CUE_POINTS,
      trajectory.cuePath,
      guideY,
      true,
    );

    // 2. Ghost Cue Ball & Impact Ring (emerald tint when shot pockets the target ball)
    if (trajectory.ghostBallX !== null && trajectory.ghostBallZ !== null) {
      this.ghostRingMat.color.setHex(
        trajectory.targetPocketed ? 0x34d399 : 0xfbbf24,
      );
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

    // 3. Struck Object Ball Trajectory Polyline
    this.objectMat.color.setHex(
      trajectory.targetPocketed ? 0x22c55e : 0xf59e0b,
    );
    this.setPolyline(
      this.objectLine,
      this.objectLinePos,
      MAX_TARGET_POINTS,
      trajectory.targetPath,
      guideY + 0.0005,
      false,
    );

    // 4. Cue Post-Impact Deflection Polyline
    this.setPolyline(
      this.deflectLine,
      this.deflectLinePos,
      MAX_DEFLECT_POINTS,
      trajectory.cuePostPath,
      guideY + 0.0002,
      true,
    );
  }
}
