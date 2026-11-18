import * as THREE from 'three';
import { BALL_SPECS, POCKET_POSITIONS, TABLE_DIMENSIONS } from '../utils/constants';
import { disposeObject3D } from '../utils/dispose';

export const MAX_VFX_PARTICLES = 72;
const MAX_VFX_RINGS = 12;

const _matrix = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _upAxis = new THREE.Vector3(0, 1, 0);

interface ParticleSlot {
  active: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  size: number;
  spinSpeed: number;
  colorHex: number;
}

interface RingSlot {
  active: boolean;
  age: number;
  life: number;
  startScale: number;
  endScale: number;
  maxOpacity: number;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
}

interface PocketGlowSlot {
  pocketId: string;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  intensity: number;
}

export class TableVfxSystem {
  public readonly group = new THREE.Group();

  private readonly particleMesh: THREE.InstancedMesh;
  private readonly particles: ParticleSlot[] = [];
  private readonly rings: RingSlot[] = [];
  private readonly pocketGlows: PocketGlowSlot[] = [];

  private maxActiveParticles = MAX_VFX_PARTICLES;
  private particleCursor = 0;
  private ringCursor = 0;
  private activeParticleCount = 0;

  constructor() {
    this.group.name = 'TableVfxSystem';

    const geo = new THREE.OctahedronGeometry(0.01, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.particleMesh = new THREE.InstancedMesh(geo, mat, MAX_VFX_PARTICLES);
    this.particleMesh.frustumCulled = false;
    this.particleMesh.visible = false;
    this.particleMesh.count = 0;

    for (let i = 0; i < MAX_VFX_PARTICLES; i++) {
      this.particles.push({
        active: false,
        age: 0,
        life: 0.3,
        x: 0,
        y: -10,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        gravity: 2.2,
        size: 1,
        spinSpeed: 4,
        colorHex: 0xffffff,
      });
      _pos.set(0, -10, 0);
      _quat.identity();
      _scale.set(0, 0, 0);
      _matrix.compose(_pos, _quat, _scale);
      this.particleMesh.setMatrixAt(i, _matrix);
      this.particleMesh.setColorAt(i, _color.setHex(0xffffff));
    }
    this.particleMesh.instanceMatrix.needsUpdate = true;
    if (this.particleMesh.instanceColor) {
      this.particleMesh.instanceColor.needsUpdate = true;
    }
    this.group.add(this.particleMesh);

    const ringGeo = new THREE.RingGeometry(0.022, 0.031, 28);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX_VFX_RINGS; i++) {
      const rMat = new THREE.MeshBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const rMesh = new THREE.Mesh(ringGeo, rMat);
      rMesh.visible = false;
      this.group.add(rMesh);
      this.rings.push({
        active: false,
        age: 0,
        life: 0.35,
        startScale: 0.7,
        endScale: 2.4,
        maxOpacity: 0.75,
        mesh: rMesh,
        material: rMat,
      });
    }

    for (const pocket of POCKET_POSITIONS) {
      const pGeo = new THREE.RingGeometry(pocket.radius * 0.9, pocket.radius * 1.18, 32);
      pGeo.rotateX(-Math.PI / 2);
      const pMat = new THREE.MeshBasicMaterial({
        color: 0x34d399,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const pMesh = new THREE.Mesh(pGeo, pMat);
      pMesh.position.set(pocket.x, TABLE_DIMENSIONS.surfaceY + 0.0022, pocket.z);
      pMesh.visible = false;
      this.group.add(pMesh);
      this.pocketGlows.push({
        pocketId: pocket.id,
        mesh: pMesh,
        material: pMat,
        intensity: 0,
      });
    }
  }

  public setMaxParticles(limit: number) {
    const clamped = Math.max(8, Math.min(MAX_VFX_PARTICLES, Math.floor(limit)));
    this.maxActiveParticles = clamped;
    for (let i = clamped; i < MAX_VFX_PARTICLES; i++) {
      this.particles[i].active = false;
    }
  }

  public getMaxParticles(): number {
    return this.maxActiveParticles;
  }

  public getActiveParticleCount(): number {
    return this.activeParticleCount;
  }

  private spawnParticle(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    gravity: number,
    colorHex: number,
    spinSpeed = 5,
  ) {
    const cap = this.maxActiveParticles;
    if (cap <= 0) return;

    let idx = -1;
    for (let attempt = 0; attempt < cap; attempt++) {
      const candidate = (this.particleCursor + attempt) % cap;
      if (!this.particles[candidate].active) {
        idx = candidate;
        this.particleCursor = (candidate + 1) % cap;
        break;
      }
    }
    if (idx === -1) {
      idx = this.particleCursor % cap;
      this.particleCursor = (idx + 1) % cap;
    }

    const slot = this.particles[idx];
    slot.active = true;
    slot.age = 0;
    slot.life = life;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.vx = vx;
    slot.vy = vy;
    slot.vz = vz;
    slot.gravity = gravity;
    slot.size = size;
    slot.spinSpeed = spinSpeed;
    slot.colorHex = colorHex;

    this.particleMesh.setColorAt(idx, _color.setHex(colorHex));
    if (this.particleMesh.instanceColor) {
      this.particleMesh.instanceColor.needsUpdate = true;
    }
    this.particleMesh.visible = true;
  }

  private spawnRing(
    x: number,
    y: number,
    z: number,
    startScale: number,
    endScale: number,
    life: number,
    maxOpacity: number,
    colorHex: number,
  ) {
    const slot = this.rings[this.ringCursor];
    this.ringCursor = (this.ringCursor + 1) % MAX_VFX_RINGS;

    slot.active = true;
    slot.age = 0;
    slot.life = life;
    slot.startScale = startScale;
    slot.endScale = endScale;
    slot.maxOpacity = maxOpacity;
    slot.material.color.setHex(colorHex);
    slot.material.opacity = maxOpacity;
    slot.mesh.position.set(x, y, z);
    slot.mesh.scale.set(startScale, 1, startScale);
    slot.mesh.visible = true;
  }

  public emitCueStrike(x: number, y: number, z: number, angle: number, power: number) {
    const intensity = Math.max(0.15, Math.min(1, power));
    const count = Math.min(8, Math.max(3, Math.round(3 + intensity * 5)));
    const backX = -Math.cos(angle);
    const backZ = -Math.sin(angle);
    const perpX = -backZ;
    const perpZ = backX;

    for (let i = 0; i < count; i++) {
      const spread = (i / Math.max(1, count - 1) - 0.5) * 0.9;
      const speed = (0.28 + intensity * 0.55) * (0.7 + (i % 3) * 0.18);
      const vx = (backX * 0.65 + perpX * spread) * speed;
      const vz = (backZ * 0.65 + perpZ * spread) * speed;
      const vy = 0.25 + (i % 3) * 0.16;
      const hex = i % 2 === 0 ? 0xbae6fd : 0xf1f5f9;
      this.spawnParticle(
        x + backX * BALL_SPECS.radius * 0.85,
        Math.max(TABLE_DIMENSIONS.surfaceY + 0.012, y),
        z + backZ * BALL_SPECS.radius * 0.85,
        vx,
        vy,
        vz,
        0.24 + intensity * 0.14,
        0.55 + intensity * 0.35,
        1.7,
        hex,
      );
    }

    this.spawnRing(
      x,
      TABLE_DIMENSIONS.surfaceY + 0.002,
      z,
      0.85,
      1.75 + intensity * 0.8,
      0.26,
      0.32 + intensity * 0.22,
      0xe0f2fe,
    );
  }

  public emitBallCollision(x: number, z: number, impactSpeed: number, isCueBall: boolean) {
    if (!Number.isFinite(impactSpeed) || impactSpeed < 0.35) return;
    const intensity = Math.min(1, Math.max(0.1, (impactSpeed - 0.3) / 5.0));
    const count = Math.min(9, Math.max(2, Math.round(2 + intensity * 6)));
    const baseY = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius * 0.85;

    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + impactSpeed * 0.37;
      const speed = 0.28 + intensity * 0.72 * (0.65 + (i % 3) * 0.2);
      const hex = isCueBall ? (i % 2 === 0 ? 0xfef08a : 0xffffff) : 0xfde68a;
      this.spawnParticle(
        x,
        baseY,
        z,
        Math.cos(a) * speed,
        0.35 + intensity * 0.45,
        Math.sin(a) * speed,
        0.2 + intensity * 0.16,
        0.45 + intensity * 0.4,
        2.6,
        hex,
      );
    }

    if (intensity > 0.25) {
      this.spawnRing(
        x,
        TABLE_DIMENSIONS.surfaceY + 0.0018,
        z,
        0.65,
        1.5 + intensity * 1.1,
        0.22,
        0.25 + intensity * 0.3,
        isCueBall ? 0xfef08a : 0xfbbf24,
      );
    }
  }

  public emitCushionImpact(x: number, z: number, impactSpeed: number) {
    if (!Number.isFinite(impactSpeed) || impactSpeed < 0.45) return;
    const intensity = Math.min(1, (impactSpeed - 0.4) / 4.2);
    const count = Math.min(5, Math.max(2, Math.round(2 + intensity * 3)));
    const baseY = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius * 0.55;

    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const speed = 0.18 + intensity * 0.36;
      this.spawnParticle(
        x,
        baseY,
        z,
        Math.cos(a) * speed,
        0.22 + (i % 2) * 0.12,
        Math.sin(a) * speed,
        0.22 + intensity * 0.1,
        0.42 + intensity * 0.25,
        1.4,
        0xcbd5e1,
      );
    }
  }

  public emitPocketBurst(x: number, z: number, pocketId: string, isEightBall: boolean) {
    const glow = this.pocketGlows.find((g) => g.pocketId === pocketId);
    if (glow) {
      glow.intensity = 1.0;
      glow.material.color.setHex(isEightBall ? 0xfbbf24 : 0x34d399);
      glow.mesh.visible = true;
    }

    const colorPrimary = isEightBall ? 0xfbbf24 : 0x34d399;
    const colorSecondary = isEightBall ? 0xfef08a : 0x67e8f9;
    const count = isEightBall ? 14 : 9;
    const baseY = TABLE_DIMENSIONS.surfaceY + 0.012;

    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const radial = 0.2 + (i % 3) * 0.12;
      this.spawnParticle(
        x + Math.cos(a) * 0.02,
        baseY,
        z + Math.sin(a) * 0.02,
        Math.cos(a) * radial,
        0.65 + (i % 4) * 0.18,
        Math.sin(a) * radial,
        0.38 + (i % 3) * 0.1,
        isEightBall ? 0.95 : 0.72,
        2.1,
        i % 2 === 0 ? colorPrimary : colorSecondary,
      );
    }

    this.spawnRing(
      x,
      TABLE_DIMENSIONS.surfaceY + 0.0024,
      z,
      1.1,
      isEightBall ? 3.1 : 2.3,
      0.42,
      isEightBall ? 0.75 : 0.55,
      colorPrimary,
    );
  }

  public emitTurnPulse(x: number, z: number, isLocalTurn: boolean) {
    this.spawnRing(
      x,
      TABLE_DIMENSIONS.surfaceY + 0.002,
      z,
      1.05,
      2.65,
      0.45,
      isLocalTurn ? 0.58 : 0.36,
      isLocalTurn ? 0x34d399 : 0xf59e0b,
    );
  }

  public update(dt: number) {
    const safeDt = Math.max(0, Math.min(0.05, dt));
    const surfaceFloor = TABLE_DIMENSIONS.surfaceY + 0.006;

    let activeCount = 0;
    let highestActiveIdx = -1;

    for (let i = 0; i < MAX_VFX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      p.age += safeDt;
      if (p.age >= p.life) {
        p.active = false;
        _pos.set(0, -10, 0);
        _quat.identity();
        _scale.set(0, 0, 0);
        _matrix.compose(_pos, _quat, _scale);
        this.particleMesh.setMatrixAt(i, _matrix);
        continue;
      }

      if (safeDt > 0) {
        p.vy -= p.gravity * safeDt;
        p.x += p.vx * safeDt;
        p.y += p.vy * safeDt;
        p.z += p.vz * safeDt;
        if (p.y < surfaceFloor && p.vy < 0) {
          p.y = surfaceFloor;
          p.vy = -p.vy * 0.25;
          p.vx *= 0.72;
          p.vz *= 0.72;
        }
      }

      const lifeProgress = p.age / p.life;
      const s = p.size * (1 - lifeProgress * 0.85);
      _pos.set(p.x, p.y, p.z);
      _quat.setFromAxisAngle(_upAxis, p.age * p.spinSpeed + i * 0.4);
      _scale.set(s, s, s);
      _matrix.compose(_pos, _quat, _scale);
      this.particleMesh.setMatrixAt(i, _matrix);

      activeCount++;
      highestActiveIdx = i;
    }

    this.activeParticleCount = activeCount;
    if (highestActiveIdx >= 0) {
      this.particleMesh.visible = true;
      this.particleMesh.count = highestActiveIdx + 1;
      this.particleMesh.instanceMatrix.needsUpdate = true;
    } else {
      this.particleMesh.visible = false;
      this.particleMesh.count = 0;
    }

    for (let i = 0; i < MAX_VFX_RINGS; i++) {
      const r = this.rings[i];
      if (!r.active) continue;

      r.age += safeDt;
      if (r.age >= r.life) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }

      const t = r.age / r.life;
      const eased = 1 - Math.pow(1 - t, 2.2);
      const scale = r.startScale + (r.endScale - r.startScale) * eased;
      r.mesh.scale.set(scale, 1, scale);
      r.material.opacity = r.maxOpacity * (1 - t);
    }

    for (let i = 0; i < this.pocketGlows.length; i++) {
      const g = this.pocketGlows[i];
      if (g.intensity <= 0.005) {
        if (g.mesh.visible) {
          g.intensity = 0;
          g.mesh.visible = false;
        }
        continue;
      }
      g.intensity = Math.max(0, g.intensity - safeDt * 1.45);
      g.material.opacity = g.intensity * 0.68;
      const s = 1 + (1 - g.intensity) * 0.14;
      g.mesh.scale.set(s, 1, s);
    }
  }

  public reset() {
    for (let i = 0; i < MAX_VFX_PARTICLES; i++) {
      this.particles[i].active = false;
    }
    this.activeParticleCount = 0;
    this.particleMesh.visible = false;
    this.particleMesh.count = 0;

    for (const r of this.rings) {
      r.active = false;
      r.mesh.visible = false;
    }
    for (const g of this.pocketGlows) {
      g.intensity = 0;
      g.mesh.visible = false;
    }
  }

  public dispose() {
    this.reset();
    disposeObject3D(this.group);
  }
}
