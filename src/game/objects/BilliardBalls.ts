import * as THREE from 'three';
import {
  BALL_DEFINITIONS,
  BALL_SPECS,
  RACK_ORDER,
  TABLE_DIMENSIONS,
} from '../utils/constants';
import {
  createAllBallTextures,
  createContactShadowTexture,
} from '../utils/ProceduralTextures';

export interface BallInstance {
  number: number;
  mesh: THREE.Mesh;
  shadowMesh: THREE.Mesh;
  pocketed: boolean;
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

export class BilliardBalls {
  public readonly group = new THREE.Group();
  public readonly balls = new Map<number, BallInstance>();

  private readonly maxAnisotropy: number;
  private currentSkinId = 'ball_classic';
  private textures: THREE.CanvasTexture[] = [];
  private materials: THREE.MeshPhysicalMaterial[] = [];

  constructor(maxAnisotropy: number) {
    this.maxAnisotropy = maxAnisotropy;
    this.group.name = 'BilliardBalls';
    this.buildBalls(maxAnisotropy);
  }

  private buildBalls(maxAnisotropy: number) {
    const sphereGeo = new THREE.SphereGeometry(BALL_SPECS.radius, 48, 32);
    this.textures = createAllBallTextures(maxAnisotropy, this.currentSkinId);

    const shadowTex = createContactShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(BALL_SPECS.radius * 2.5, BALL_SPECS.radius * 2.5);
    shadowGeo.rotateX(-Math.PI / 2);

    const initialPositions = computeInitialBallPositions();

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
        envMapIntensity: 1.15,
      });
      this.materials[def.number] = mat;

      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.position.set(pos.x, pos.y, pos.z);
      // Orient numbers so they face nicely upward/outward on rack
      mesh.rotation.set(0.25, -Math.PI * 0.5, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `Ball_${def.number}`;

      const shadowMat = new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.58,
      });
      const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
      shadowMesh.position.set(pos.x, TABLE_DIMENSIONS.surfaceY + 0.0007, pos.z);

      this.group.add(mesh);
      this.group.add(shadowMesh);

      this.balls.set(def.number, {
        number: def.number,
        mesh,
        shadowMesh,
        pocketed: false,
      });
    }
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

      switch (targetId) {
        case 'ball_brushed_metallic':
          mat.metalness = 0.72;
          mat.roughness = 0.22;
          mat.clearcoat = 0.65;
          mat.clearcoatRoughness = 0.14;
          mat.envMapIntensity = 1.45;
          break;
        case 'ball_golden':
          mat.metalness = 0.88;
          mat.roughness = 0.14;
          mat.clearcoat = 0.9;
          mat.clearcoatRoughness = 0.06;
          mat.envMapIntensity = 1.55;
          mat.emissive.setHex(0x78350f);
          mat.emissiveIntensity = 0.08;
          break;
        case 'ball_crystal':
          mat.metalness = 0.15;
          mat.roughness = 0.06;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.02;
          mat.reflectivity = 1.0;
          mat.envMapIntensity = 1.6;
          mat.emissive.set(def.number === 0 ? '#7dd3fc' : '#38bdf8');
          mat.emissiveIntensity = 0.14;
          break;
        case 'ball_neon_pulse':
          mat.metalness = 0.12;
          mat.roughness = 0.14;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.04;
          mat.envMapIntensity = 1.2;
          mat.emissive.set(def.number === 0 ? '#22d3ee' : def.color);
          mat.emissiveIntensity = def.number === 8 ? 0.12 : 0.22;
          break;
        case 'ball_artisan_marble':
          mat.metalness = 0.04;
          mat.roughness = 0.1;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.03;
          mat.envMapIntensity = 1.25;
          break;
        case 'ball_aurora_chroma':
          mat.metalness = 0.28;
          mat.roughness = 0.11;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.04;
          mat.envMapIntensity = 1.35;
          mat.emissive.setHex(0x38bdf8);
          mat.emissiveIntensity = 0.16;
          break;
        case 'ball_classic':
        default:
          mat.metalness = 0.02;
          mat.roughness = 0.13;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.05;
          mat.envMapIntensity = 1.15;
          break;
      }

      mat.needsUpdate = true;
    }

    for (const tex of oldTextures) {
      tex.dispose();
    }
  }

  public update(elapsedSec: number) {
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

    inst.pocketed = pocketed;
    inst.mesh.position.set(x, y, z);
    inst.mesh.quaternion.set(qx, qy, qz, qw);

    const onTable = !pocketed && y >= TABLE_DIMENSIONS.surfaceY - 0.01;
    inst.shadowMesh.visible = onTable;
    if (onTable) {
      inst.shadowMesh.position.set(x, TABLE_DIMENSIONS.surfaceY + 0.0007, z);
    }
  }
}
