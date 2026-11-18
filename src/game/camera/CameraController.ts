import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraPreset } from '../../store/useGameStore';
import type { ReplayCameraMode } from '../replay/types';
import { TABLE_DIMENSIONS } from '../utils/constants';

const _desiredPos = new THREE.Vector3();
const _desiredTarget = new THREE.Vector3();

export interface ReplayCameraFocusParams {
  cueBallPos: THREE.Vector3;
  focusBallPos: THREE.Vector3;
  cueAngle: number;
  elapsedSec: number;
}

export class CameraController {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls;

  private isTransitioning = false;
  private isSoftwareGl: boolean;
  private sensitivity = 1.0;

  private savedGameplayPos = new THREE.Vector3(-2.28, 1.84, 1.98);
  private savedGameplayTarget = new THREE.Vector3(0.05, TABLE_DIMENSIONS.surfaceY + 0.02, 0);
  private hasSavedGameplayPose = false;

  constructor(domElement: HTMLElement, aspect: number, isSoftwareGl: boolean) {
    this.isSoftwareGl = isSoftwareGl;
    this.camera = new THREE.PerspectiveCamera(44, aspect, 0.05, 50);

    // Attractive initial three-quarter view showcasing full table, 6 pockets, rack, and cue stick
    this.camera.position.set(-2.28, 1.84, 1.98);

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.target.set(0.05, TABLE_DIMENSIONS.surfaceY + 0.02, 0);
    this.controls.enableDamping = !isSoftwareGl;
    this.controls.dampingFactor = 0.07;
    this.controls.rotateSpeed = 0.78;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.65;
    this.controls.minDistance = 0.78;
    this.controls.maxDistance = 5.4;
    this.controls.minPolarAngle = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.46;

    // Cancel scripted camera transition immediately when user grabs the camera
    this.controls.addEventListener('start', () => {
      this.isTransitioning = false;
    });

    this.controls.update();
  }

  public setSensitivity(sensitivity: number) {
    this.sensitivity = sensitivity;
    this.controls.rotateSpeed = 0.78 * sensitivity;
    this.controls.zoomSpeed = 0.9 * sensitivity;
  }

  public setOrbitRotateEnabled(enabled: boolean) {
    this.controls.enableRotate = enabled;
  }

  public saveBeforeReplay() {
    this.savedGameplayPos.copy(this.camera.position);
    this.savedGameplayTarget.copy(this.controls.target);
    this.hasSavedGameplayPose = true;
  }

  public restoreAfterReplay() {
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    this.controls.autoRotate = false;
    if (this.hasSavedGameplayPose) {
      _desiredPos.copy(this.savedGameplayPos);
      _desiredTarget.copy(this.savedGameplayTarget);
      if (this.isSoftwareGl) {
        this.camera.position.copy(_desiredPos);
        this.controls.target.copy(_desiredTarget);
        this.isTransitioning = false;
      } else {
        this.isTransitioning = true;
      }
      this.hasSavedGameplayPose = false;
    }
  }

  public updateReplayCamera(
    mode: ReplayCameraMode,
    focus: ReplayCameraFocusParams,
    delta: number,
  ) {
    const surfaceY = TABLE_DIMENSIONS.surfaceY;
    this.controls.autoRotate = false;

    if (mode === 'free') {
      // Unlock OrbitControls freely for user drag & zoom inspection without fighting input
      this.controls.enableRotate = true;
      this.controls.enableZoom = true;
      this.isTransitioning = false;
      this.controls.update();
      this.enforceTableBoundary();
      return;
    }

    switch (mode) {
      case 'topDown':
        _desiredPos.set(0, 3.65, 0.04);
        _desiredTarget.set(0, surfaceY, 0);
        break;

      case 'cinematic': {
        const orbitAngle = focus.elapsedSec * 0.24 - 2.35;
        const radius = 2.45;
        _desiredTarget.set(
          THREE.MathUtils.clamp(focus.focusBallPos.x * 0.45, -0.7, 0.7),
          surfaceY + 0.04,
          THREE.MathUtils.clamp(focus.focusBallPos.z * 0.45, -0.4, 0.4),
        );
        _desiredPos.set(
          _desiredTarget.x + Math.cos(orbitAngle) * radius,
          1.62 + Math.sin(focus.elapsedSec * 0.4) * 0.14,
          _desiredTarget.z + Math.sin(orbitAngle) * radius,
        );
        break;
      }

      case 'ballFollow': {
        const fx = focus.focusBallPos.x;
        const fz = focus.focusBallPos.z;
        const backX = Math.cos(focus.cueAngle);
        const backZ = Math.sin(focus.cueAngle);
        _desiredTarget.set(fx, surfaceY + 0.04, fz);
        _desiredPos.set(
          THREE.MathUtils.clamp(fx - backX * 1.15, -2.6, 2.6),
          surfaceY + 0.72,
          THREE.MathUtils.clamp(fz - backZ * 1.15, -2.0, 2.0),
        );
        break;
      }

      case 'shotFocused': {
        const cx = focus.cueBallPos.x;
        const cz = focus.cueBallPos.z;
        const dirX = Math.cos(focus.cueAngle);
        const dirZ = Math.sin(focus.cueAngle);
        _desiredPos.set(cx - dirX * 1.08, surfaceY + 0.39, cz - dirZ * 1.08);
        _desiredTarget.set(cx + dirX * 0.6, surfaceY + 0.03, cz + dirZ * 0.6);
        break;
      }

      case 'original':
      default:
        _desiredPos.set(-2.28, 1.84, 1.98);
        _desiredTarget.set(0.05, surfaceY + 0.02, 0);
        break;
    }

    if (this.isSoftwareGl) {
      this.camera.position.copy(_desiredPos);
      this.controls.target.copy(_desiredTarget);
    } else {
      const lambda = mode === 'ballFollow' ? 5.2 : 6.0;
      this.camera.position.x = THREE.MathUtils.damp(this.camera.position.x, _desiredPos.x, lambda, delta);
      this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, _desiredPos.y, lambda, delta);
      this.camera.position.z = THREE.MathUtils.damp(this.camera.position.z, _desiredPos.z, lambda, delta);

      this.controls.target.x = THREE.MathUtils.damp(this.controls.target.x, _desiredTarget.x, lambda, delta);
      this.controls.target.y = THREE.MathUtils.damp(this.controls.target.y, _desiredTarget.y, lambda, delta);
      this.controls.target.z = THREE.MathUtils.damp(this.controls.target.z, _desiredTarget.z, lambda, delta);
    }

    this.controls.update();
    this.enforceTableBoundary();
  }

  public setPreset(
    preset: CameraPreset,
    cueBallPos?: THREE.Vector3,
    aimAngle = 0,
  ) {
    const surfaceY = TABLE_DIMENSIONS.surfaceY;

    switch (preset) {
      case 'topDown':
        _desiredPos.set(0, 3.65, 0.04);
        _desiredTarget.set(0, surfaceY, 0);
        break;
      case 'sideView':
        _desiredPos.set(0, 1.72, 2.55);
        _desiredTarget.set(0, surfaceY + 0.02, 0);
        break;
      case 'cueAim': {
        const cx = cueBallPos ? cueBallPos.x : TABLE_DIMENSIONS.headSpotX;
        const cz = cueBallPos ? cueBallPos.z : 0;
        const backDist = 1.18;
        _desiredPos.set(
          cx - Math.cos(aimAngle) * backDist,
          surfaceY + 0.42,
          cz - Math.sin(aimAngle) * backDist,
        );
        _desiredTarget.set(
          cx + Math.cos(aimAngle) * 0.45,
          surfaceY + 0.03,
          cz + Math.sin(aimAngle) * 0.45,
        );
        break;
      }
      case 'threeQuarter':
      default:
        _desiredPos.set(-2.28, 1.84, 1.98);
        _desiredTarget.set(0.05, surfaceY + 0.02, 0);
        break;
    }

    if (this.isSoftwareGl) {
      this.camera.position.copy(_desiredPos);
      this.controls.target.copy(_desiredTarget);
      this.isTransitioning = false;
    } else {
      this.isTransitioning = true;
    }
  }

  public update(delta: number, isMenuIdle: boolean) {
    if (isMenuIdle && !this.isTransitioning && !this.isSoftwareGl) {
      this.controls.autoRotate = true;
      this.controls.autoRotateSpeed = 0.42;
    } else {
      this.controls.autoRotate = false;
    }

    if (this.isTransitioning) {
      const lambda = 7.0;
      this.camera.position.x = THREE.MathUtils.damp(this.camera.position.x, _desiredPos.x, lambda, delta);
      this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, _desiredPos.y, lambda, delta);
      this.camera.position.z = THREE.MathUtils.damp(this.camera.position.z, _desiredPos.z, lambda, delta);

      this.controls.target.x = THREE.MathUtils.damp(this.controls.target.x, _desiredTarget.x, lambda, delta);
      this.controls.target.y = THREE.MathUtils.damp(this.controls.target.y, _desiredTarget.y, lambda, delta);
      this.controls.target.z = THREE.MathUtils.damp(this.controls.target.z, _desiredTarget.z, lambda, delta);

      if (
        this.camera.position.distanceToSquared(_desiredPos) < 0.0004 &&
        this.controls.target.distanceToSquared(_desiredTarget) < 0.0004
      ) {
        this.camera.position.copy(_desiredPos);
        this.controls.target.copy(_desiredTarget);
        this.isTransitioning = false;
      }
    }

    this.controls.update();
    this.enforceTableBoundary();
  }

  /**
   * Prevents the camera from entering the pool table volume or clipping beneath the floor.
   */
  private enforceTableBoundary() {
    const D = TABLE_DIMENSIONS;

    // Clamp orbit target to stay near the playing surface
    this.controls.target.x = THREE.MathUtils.clamp(this.controls.target.x, -D.halfLength - 0.15, D.halfLength + 0.15);
    this.controls.target.y = THREE.MathUtils.clamp(this.controls.target.y, D.surfaceY - 0.04, D.surfaceY + 0.4);
    this.controls.target.z = THREE.MathUtils.clamp(this.controls.target.z, -D.halfWidth - 0.15, D.halfWidth + 0.15);

    // Table outer physical bounds
    const tableOuterX = D.halfLength + D.cushionDepth + D.railWidth + 0.08;
    const tableOuterZ = D.halfWidth + D.cushionDepth + D.railWidth + 0.08;
    const minSafeTopY = D.surfaceY + D.railHeight + 0.09;

    // Never clip below the studio floor
    if (this.camera.position.y < 0.32) {
      this.camera.position.y = 0.32;
    }

    // Never enter the table prism (or stay above rails when over the table footprint)
    const inTableFootprint =
      Math.abs(this.camera.position.x) < tableOuterX &&
      Math.abs(this.camera.position.z) < tableOuterZ;

    if (inTableFootprint && this.camera.position.y < minSafeTopY) {
      this.camera.position.y = minSafeTopY;
    }

    void this.sensitivity;
  }

  public resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  public dispose() {
    this.controls.dispose();
  }
}
