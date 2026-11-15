import * as THREE from 'three';
import { TABLE_DIMENSIONS } from '../utils/constants';
import { disposeObject3D } from '../utils/dispose';

const _tempMatrix = new THREE.Matrix4();
const _tempPos = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _tempScale = new THREE.Vector3();

interface ParticleState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  phase: number;
  size: number;
}

const EMBER_COUNT = 36;

export class VictoryEffects {
  public readonly group = new THREE.Group();

  private active = false;
  private elapsed = 0;
  private duration = 4.6;
  private currentId = 'victory_classic_burst';

  private readonly haloRing: THREE.Mesh;
  private readonly haloMat: THREE.MeshBasicMaterial;
  private readonly shockRing: THREE.Mesh;
  private readonly shockMat: THREE.MeshBasicMaterial;
  private readonly emberMesh: THREE.InstancedMesh;
  private readonly emberMat: THREE.MeshBasicMaterial;
  private readonly particles: ParticleState[] = [];

  constructor() {
    this.group.name = 'VictoryEffects';
    this.group.visible = false;

    const baseY = TABLE_DIMENSIONS.surfaceY + 0.015;

    const haloGeo = new THREE.RingGeometry(0.18, 0.24, 48);
    haloGeo.rotateX(-Math.PI / 2);
    this.haloMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.haloRing = new THREE.Mesh(haloGeo, this.haloMat);
    this.haloRing.position.set(0, baseY, 0);
    this.group.add(this.haloRing);

    const shockGeo = new THREE.RingGeometry(0.12, 0.16, 48);
    shockGeo.rotateX(-Math.PI / 2);
    this.shockMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.shockRing = new THREE.Mesh(shockGeo, this.shockMat);
    this.shockRing.position.set(0, baseY + 0.02, 0);
    this.group.add(this.shockRing);

    const emberGeo = new THREE.OctahedronGeometry(0.014, 0);
    this.emberMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.emberMesh = new THREE.InstancedMesh(emberGeo, this.emberMat, EMBER_COUNT);
    this.emberMesh.frustumCulled = false;
    this.group.add(this.emberMesh);

    for (let i = 0; i < EMBER_COUNT; i++) {
      this.particles.push({
        x: 0,
        y: baseY,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        phase: (i / EMBER_COUNT) * Math.PI * 2,
        size: 0.8 + (i % 4) * 0.22,
      });
    }
  }

  public play(victoryId: string) {
    this.currentId = victoryId || 'victory_classic_burst';
    this.active = true;
    this.elapsed = 0;
    this.group.visible = true;

    const baseY = TABLE_DIMENSIONS.surfaceY + 0.025;
    if (this.currentId === 'victory_neon_shockwave') {
      this.haloMat.color.setHex(0x22d3ee);
      this.shockMat.color.setHex(0xec4899);
      this.emberMat.color.setHex(0x67e8f9);
    } else if (this.currentId === 'victory_championship_spotlight') {
      this.haloMat.color.setHex(0xfef08a);
      this.shockMat.color.setHex(0xf59e0b);
      this.emberMat.color.setHex(0xfde047);
    } else if (this.currentId === 'victory_gold_fountain') {
      this.haloMat.color.setHex(0xfbbf24);
      this.shockMat.color.setHex(0xf97316);
      this.emberMat.color.setHex(0xfbbf24);
    } else {
      this.haloMat.color.setHex(0xf59e0b);
      this.shockMat.color.setHex(0xfde68a);
      this.emberMat.color.setHex(0xfbbf24);
    }

    for (let i = 0; i < EMBER_COUNT; i++) {
      const p = this.particles[i];
      const angle = (i / EMBER_COUNT) * Math.PI * 2;
      const radialSpeed =
        this.currentId === 'victory_gold_fountain'
          ? 0.22 + (i % 5) * 0.07
          : 0.35 + (i % 3) * 0.14;
      p.x = Math.cos(angle) * 0.06;
      p.y = baseY + (i % 4) * 0.02;
      p.z = Math.sin(angle) * 0.06;
      p.vx = Math.cos(angle) * radialSpeed;
      p.vy =
        this.currentId === 'victory_gold_fountain'
          ? 1.15 + (i % 6) * 0.16
          : 0.65 + (i % 5) * 0.15;
      p.vz = Math.sin(angle) * radialSpeed;
      p.phase = i * 0.45;
    }

    this.update(0);
  }

  public stop() {
    this.active = false;
    this.elapsed = 0;
    this.group.visible = false;
  }

  public update(dt: number) {
    if (!this.active) return;

    this.elapsed += dt;
    if (this.elapsed >= this.duration) {
      this.stop();
      return;
    }

    const progress = this.elapsed / this.duration;
    const fadeOut = progress > 0.7 ? Math.max(0, 1 - (progress - 0.7) / 0.3) : 1;

    const baseY = TABLE_DIMENSIONS.surfaceY + 0.018;
    const pulse = (this.elapsed * 0.9) % 1;

    const haloScale = 1 + pulse * (this.currentId === 'victory_neon_shockwave' ? 4.2 : 2.8);
    this.haloRing.scale.set(haloScale, 1, haloScale);
    this.haloRing.position.y = baseY + pulse * 0.24;
    this.haloMat.opacity = (1 - pulse) * 0.78 * fadeOut;

    const pulse2 = (this.elapsed * 0.9 + 0.5) % 1;
    const shockScale = 1 + pulse2 * 3.5;
    this.shockRing.scale.set(shockScale, 1, shockScale);
    this.shockRing.position.y = baseY + 0.03 + pulse2 * 0.32;
    this.shockMat.opacity = (1 - pulse2) * 0.65 * fadeOut;

    const gravity = this.currentId === 'victory_gold_fountain' ? 1.45 : 0.72;
    for (let i = 0; i < EMBER_COUNT; i++) {
      const p = this.particles[i];
      if (dt > 0) {
        p.vy -= gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        if (p.y < baseY && this.elapsed < this.duration * 0.65) {
          const angle = p.phase + this.elapsed * 2.1;
          p.x = Math.cos(angle) * 0.08;
          p.y = baseY;
          p.z = Math.sin(angle) * 0.08;
          p.vy = 0.85 + (i % 5) * 0.14;
        }
      }
      _tempPos.set(p.x, Math.max(baseY, p.y), p.z);
      _tempQuat.setFromAxisAngle(
        THREE.Object3D.DEFAULT_UP,
        this.elapsed * 3.0 + p.phase,
      );
      const s = p.size * fadeOut;
      _tempScale.set(s, s, s);
      _tempMatrix.compose(_tempPos, _tempQuat, _tempScale);
      this.emberMesh.setMatrixAt(i, _tempMatrix);
    }
    this.emberMesh.instanceMatrix.needsUpdate = true;
    this.emberMat.opacity = 0.9 * fadeOut;
  }

  public dispose() {
    this.stop();
    disposeObject3D(this.group);
  }
}
