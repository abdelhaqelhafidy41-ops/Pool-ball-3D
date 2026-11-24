import * as THREE from 'three';
import {
  BALL_DEFINITIONS,
  BALL_SPECS,
  RACK_ORDER,
  TABLE_DIMENSIONS,
} from '../utils/constants';
import { disposeObject3D } from '../utils/dispose';
import type { GraphicsQualityProfile } from '../utils/graphicsQuality';
import {
  createAllBallTextures,
  createContactShadowTexture,
} from '../utils/ProceduralTextures';

export interface BallInstance {
  number: number;
  mesh: THREE.Mesh;
  pocketed: boolean;
  visualScale: number;
}

export function computeInitialBallPositions(): Array<{ number: number; x: number; y: number; z: number }> {
  const y = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;
  const positions: Array<{ number: number; x: number; y: number; z: number }> = [];

  // 0: Cue Ball at Head Spot
  positions.push({
    number: 0,
    x: TABLE_DIMENSIONS.headSpotX,
    y,
    z: 0,
  });

  // 1..15: Triangular rack at Foot Spot
  const spacing = BALL_SPECS.radius * 2.012; // tiny clearance for clean physics rest
  const rowStepX = spacing * Math.sqrt(3) * 0.5;
  let rackIdx = 0;

  for (let row = 0; row < 5; row++) {
    const rowX = TABLE_DIMENSIONS.footSpotX + row * rowStepX;
    for (let col = 0; col <= row; col++) {
      const ballNumber = RACK_ORDER[rackIdx++];
      const z = (col - row * 0.5) * spacing;
      positions.push({
        number: ballNumber,
        x: rowX,
        y,
        z,
      });
    }
  }

  return positions;
}

const _auroraEmissiveColor = new THREE.Color();
const _clothColorScratch = new THREE.Color();
const _hslBallScratch = { h: 0, s: 0, l: 0 };
const _hslClothScratch = { h: 0, s: 0, l: 0 };
const _shadowMatrix = new THREE.Matrix4();
const _shadowPos = new THREE.Vector3();
const _shadowQuat = new THREE.Quaternion();
const _shadowScale = new THREE.Vector3();

/**
 * Resolves the display color for an object ball's aiming trajectory (never cue ball #0),
 * reading from BALL_DEFINITIONS and active ball skin while preserving readability against
 * the current table cloth color.
 */
export function resolveObjectBallAimColor(
  ballNumber: number,
  ballSkinId: string,
  clothHex: string,
  outColor: THREE.Color,
): { needsContrastHalo: boolean } {
  const def = BALL_DEFINITIONS.find((b) => b.number === ballNumber && b.number !== 0);
  if (!def) {
    outColor.setHex(0xe2e8f0);
    return { needsContrastHalo: false };
  }

  let baseHex = def.color;
  if (ballSkinId === 'ball_golden' && ballNumber === 8) {
    baseHex = '#1c1710';
  }

  outColor.set(baseHex);
  _clothColorScratch.set(clothHex || '#124e78');

  outColor.getHSL(_hslBallScratch);
  _clothColorScratch.getHSL(_hslClothScratch);

  // 8-ball (black): preserve genuine dark black hue and signal subtle light contrast halo
  if (ballNumber === 8 || _hslBallScratch.l < 0.12) {
    outColor.setHex(0x111318);
    return { needsContrastHalo: true };
  }

  // Boost luminance gently if ball hue is close to cloth hue (e.g. #2/#10 blue on blue cloth,
  // #6/#14 green on green cloth, #7/#15 maroon on crimson/dark cloth)
  let hueDiff = Math.abs(_hslBallScratch.h - _hslClothScratch.h);
  if (hueDiff > 0.5) hueDiff = 1 - hueDiff;

  if (hueDiff < 0.11) {
    const targetL = Math.max(_hslBallScratch.l, 0.62);
    outColor.setHSL(_hslBallScratch.h, Math.min(1, _hslBallScratch.s * 1.05), targetL);
    return { needsContrastHalo: true };
  }

  if (_hslBallScratch.l < 0.38) {
    outColor.setHSL(_hslBallScratch.h, Math.min(1, _hslBallScratch.s * 1.05), 0.52);
  }

  return { needsContrastHalo: false };
}

export class BilliardBalls {
  public readonly group = new THREE.Group();
  public readonly balls = new Map<number, BallInstance>();

  private maxAnisotropy: number;
  private currentSkinId = 'ball_classic';
  private sphereGeo!: THREE.SphereGeometry;
  private currentWidthSegs = 48;
  private currentHeightSegs = 32;
  private envMapScale = 1.0;

  private textures: THREE.CanvasTexture[] = [];
  private materials: THREE.MeshPhysicalMaterial[] = [];
  private baseEnvIntensities: number[] = [];
  private shadowInstancedMesh!: THREE.InstancedMesh;

  constructor(maxAnisotropy: number) {
    this.maxAnisotropy = maxAnisotropy;
    this.group.name = 'BilliardBalls';
    this.buildBalls(maxAnisotropy);
  }

  private buildBalls(maxAnisotropy: number) {
    this.sphereGeo = new THREE.SphereGeometry(
      BALL_SPECS.radius,
      this.currentWidthSegs,
      this.currentHeightSegs,
    );
    this.textures = createAllBallTextures(maxAnisotropy, this.currentSkinId);

    const shadowTex = createContactShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(BALL_SPECS.radius * 2.5, BALL_SPECS.radius * 2.5);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.58,
    });
    this.shadowInstancedMesh = new THREE.InstancedMesh(shadowGeo, shadowMat, 16);
    this.shadowInstancedMesh.name = 'BallContactShadows';
    this.shadowInstancedMesh.frustumCulled = false;
    this.group.add(this.shadowInstancedMesh);

    const initialPositions = computeInitialBallPositions();
    const shadowY = TABLE_DIMENSIONS.surfaceY + 0.0007;

    for (const pos of initialPositions) {
      const def = BALL_DEFINITIONS[pos.number];
      const tex = this.textures[pos.number];

      const mat = new THREE.MeshPhysicalMaterial({
        map: tex,
        roughness: 0.13,
        metalness: 0.02,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        reflectivity: 0.9,
        envMapIntensity: 1.15 * this.envMapScale,
      });
      this.materials[def.number] = mat;
      this.baseEnvIntensities[def.number] = 1.15;

      const mesh = new THREE.Mesh(this.sphereGeo, mat);
      mesh.position.set(pos.x, pos.y, pos.z);
      // Orient numbers so they face nicely upward/outward on rack
      mesh.rotation.set(0.25, -Math.PI * 0.5, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `Ball_${def.number}`;

      this.group.add(mesh);

      _shadowPos.set(pos.x, shadowY, pos.z);
      _shadowScale.set(1, 1, 1);
      _shadowMatrix.compose(_shadowPos, _shadowQuat, _shadowScale);
      this.shadowInstancedMesh.setMatrixAt(def.number, _shadowMatrix);

      this.balls.set(def.number, {
        number: def.number,
        mesh,
        pocketed: false,
        visualScale: 1,
      });
    }
    this.shadowInstancedMesh.instanceMatrix.needsUpdate = true;
  }

  public applyBallSkin(ballSkinId: string) {
    const targetId = ballSkinId || 'ball_classic';
    if (this.currentSkinId === targetId && this.textures.length > 0) return;
    this.currentSkinId = targetId;

    const oldTextures = this.textures;
    const nextTextures = createAllBallTextures(this.maxAnisotropy, targetId);
    this.textures = nextTextures;

    for (const def of BALL_DEFINITIONS) {
      const mat = this.materials[def.number];
      if (!mat) continue;

      mat.map = nextTextures[def.number];
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;

      let baseEnv = 1.15;

      switch (targetId) {
        case 'ball_brushed_metallic':
          mat.metalness = 0.72;
          mat.roughness = 0.22;
          mat.clearcoat = 0.65;
          mat.clearcoatRoughness = 0.14;
          baseEnv = 1.45;
          break;
        case 'ball_golden':
          mat.metalness = 0.88;
          mat.roughness = 0.14;
          mat.clearcoat = 0.9;
          mat.clearcoatRoughness = 0.06;
          baseEnv = 1.55;
          mat.emissive.setHex(0x78350f);
          mat.emissiveIntensity = 0.08;
          break;
        case 'ball_crystal':
          mat.metalness = 0.15;
          mat.roughness = 0.06;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.02;
          mat.reflectivity = 1.0;
          baseEnv = 1.6;
          mat.emissive.set(def.number === 0 ? '#7dd3fc' : '#38bdf8');
          mat.emissiveIntensity = 0.14;
          break;
        case 'ball_neon_pulse':
          mat.metalness = 0.12;
          mat.roughness = 0.14;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.04;
          baseEnv = 1.2;
          mat.emissive.set(def.number === 0 ? '#22d3ee' : def.color);
          mat.emissiveIntensity = def.number === 8 ? 0.12 : 0.22;
          break;
        case 'ball_artisan_marble':
          mat.metalness = 0.04;
          mat.roughness = 0.1;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.03;
          baseEnv = 1.25;
          break;
        case 'ball_aurora_chroma':
          mat.metalness = 0.28;
          mat.roughness = 0.11;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.04;
          baseEnv = 1.35;
          mat.emissive.setHex(0x38bdf8);
          mat.emissiveIntensity = 0.16;
          break;
        case 'ball_season1_eclipse':
          mat.metalness = 0.45;
          mat.roughness = 0.15;
          mat.clearcoat = 0.95;
          mat.clearcoatRoughness = 0.06;
          baseEnv = 1.45;
          mat.emissive.setHex(0xf59e0b);
          mat.emissiveIntensity = def.number === 8 ? 0.12 : 0.07;
          break;
        case 'ball_classic':
        default:
          mat.metalness = 0.02;
          mat.roughness = 0.13;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.05;
          baseEnv = 1.15;
          break;
      }

      this.baseEnvIntensities[def.number] = baseEnv;
      mat.envMapIntensity = baseEnv * this.envMapScale;
      mat.needsUpdate = true;
    }

    for (const tex of oldTextures) {
      tex.dispose();
    }
  }

  public setQualityProfile(profile: GraphicsQualityProfile, rendererMaxAnisotropy: number) {
    const aniso = Math.min(rendererMaxAnisotropy, profile.maxAnisotropyCap);
    this.maxAnisotropy = aniso;
    this.envMapScale = profile.envMapIntensityScale;

    for (const tex of this.textures) {
      if (tex && tex.anisotropy !== aniso) {
        tex.anisotropy = aniso;
        tex.needsUpdate = true;
      }
    }

    for (let i = 0; i < this.materials.length; i++) {
      const mat = this.materials[i];
      if (!mat) continue;
      const baseEnv = this.baseEnvIntensities[i] ?? 1.15;
      mat.envMapIntensity = baseEnv * this.envMapScale;
    }

    if (
      profile.ballWidthSegments !== this.currentWidthSegs ||
      profile.ballHeightSegments !== this.currentHeightSegs
    ) {
      this.currentWidthSegs = profile.ballWidthSegments;
      this.currentHeightSegs = profile.ballHeightSegments;
      const oldGeo = this.sphereGeo;
      const nextGeo = new THREE.SphereGeometry(
        BALL_SPECS.radius,
        this.currentWidthSegs,
        this.currentHeightSegs,
      );
      this.sphereGeo = nextGeo;
      for (const inst of this.balls.values()) {
        inst.mesh.geometry = nextGeo;
      }
      oldGeo.dispose();
    }
  }

  public update(elapsedSec: number, dt = 0.016) {
    const safeDt = Math.max(0, Math.min(0.05, dt));

    for (const inst of this.balls.values()) {
      if (inst.pocketed) {
        if (inst.mesh.visible) {
          inst.visualScale = Math.max(0, inst.visualScale - safeDt * 5.5);
          if (inst.visualScale <= 0.04) {
            inst.visualScale = 0;
            inst.mesh.scale.setScalar(0.001);
            inst.mesh.visible = false;
          } else {
            inst.mesh.scale.setScalar(inst.visualScale);
          }
        }
      } else if (inst.visualScale < 1) {
        inst.visualScale = 1;
        inst.mesh.visible = true;
        inst.mesh.scale.setScalar(1);
      }
    }

    if (this.currentSkinId === 'ball_aurora_chroma') {
      const baseHue = (elapsedSec * 0.14) % 1;
      for (let i = 0; i < this.materials.length; i++) {
        const mat = this.materials[i];
        if (!mat) continue;
        _auroraEmissiveColor.setHSL((baseHue + i * 0.04) % 1, 0.72, 0.52);
        mat.emissive.copy(_auroraEmissiveColor);
        mat.emissiveIntensity = 0.14 + 0.06 * Math.sin(elapsedSec * 2.2 + i * 0.45);
      }
    } else if (this.currentSkinId === 'ball_neon_pulse') {
      const pulse = 0.18 + 0.06 * Math.sin(elapsedSec * 2.8);
      for (let i = 0; i < this.materials.length; i++) {
        const mat = this.materials[i];
        if (!mat) continue;
        mat.emissiveIntensity = i === 8 ? pulse * 0.55 : pulse;
      }
    }
  }

  public syncFromTransform(
    ballNumber: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    pocketed: boolean,
  ) {
    const inst = this.balls.get(ballNumber);
    if (!inst) return;

    const wasPocketed = inst.pocketed;
    inst.pocketed = pocketed;
    inst.mesh.position.set(x, y, z);
    inst.mesh.quaternion.set(qx, qy, qz, qw);

    const onTable = !pocketed && y >= TABLE_DIMENSIONS.surfaceY - 0.01;

    if (!pocketed) {
      if (wasPocketed || !inst.mesh.visible) {
        inst.visualScale = 1;
        inst.mesh.visible = true;
        inst.mesh.scale.setScalar(1);
      } else if (y < TABLE_DIMENSIONS.surfaceY - 0.002) {
        // Gentle visual shrink while sinking inside pocket well
        const depth = Math.max(0, TABLE_DIMENSIONS.surfaceY - y);
        const dropScale = Math.max(0.55, 1 - depth * 3.2);
        inst.visualScale = dropScale;
        inst.mesh.scale.setScalar(dropScale);
      } else if (inst.visualScale !== 1) {
        inst.visualScale = 1;
        inst.mesh.scale.setScalar(1);
      }
    }

    if (onTable) {
      _shadowPos.set(x, TABLE_DIMENSIONS.surfaceY + 0.0007, z);
      _shadowScale.set(1, 1, 1);
    } else {
      _shadowPos.set(x, -10, z);
      _shadowScale.set(0, 0, 0);
    }
    _shadowMatrix.compose(_shadowPos, _shadowQuat, _shadowScale);
    this.shadowInstancedMesh.setMatrixAt(ballNumber, _shadowMatrix);
    this.shadowInstancedMesh.instanceMatrix.needsUpdate = true;
  }

  public getShadowInstancedMesh(): THREE.InstancedMesh {
    return this.shadowInstancedMesh;
  }

  public getObjectBallAimColor(
    ballNumber: number,
    clothHex: string,
    outColor: THREE.Color,
  ): { needsContrastHalo: boolean } {
    return resolveObjectBallAimColor(ballNumber, this.currentSkinId, clothHex, outColor);
  }

  public getGeometrySegmentCounts(): { widthSegments: number; heightSegments: number } {
    return {
      widthSegments: this.currentWidthSegs,
      heightSegments: this.currentHeightSegs,
    };
  }

  public dispose() {
    disposeObject3D(this.group);
    this.textures = [];
    this.materials = [];
    this.balls.clear();
  }
}
