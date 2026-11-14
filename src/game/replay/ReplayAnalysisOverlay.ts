import * as THREE from 'three';
import { BALL_DEFINITIONS, BALL_SPECS, POCKET_POSITIONS, TABLE_DIMENSIONS } from '../utils/constants';
import type { BallTrajectoryPoint, RecordedShot, ShotCollisionEvent } from './types';

interface TrajectoryEntry {
  ballNumber: number;
  points: BallTrajectoryPoint[];
  activeLine: THREE.Line;
}

interface CollisionMarkerEntry {
  event: ShotCollisionEvent;
  group: THREE.Group;
  ringMat: THREE.MeshBasicMaterial;
  dotMat: THREE.MeshBasicMaterial;
}

interface PocketMarkerEntry {
  timeSec: number;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
}

export class ReplayAnalysisOverlay {
  public readonly group = new THREE.Group();

  private trajectoryEntries: TrajectoryEntry[] = [];
  private collisionEntries: CollisionMarkerEntry[] = [];
  private pocketEntries: PocketMarkerEntry[] = [];
  private builtShotId: string | null = null;

  constructor() {
    this.group.name = 'ReplayAnalysisOverlay';
    this.group.visible = false;
  }

  public setShot(shot: RecordedShot | null): void {
    if (!shot) {
      this.clear();
      this.builtShotId = null;
      return;
    }
    if (this.builtShotId === shot.id) {
      return;
    }

    this.clear();
    this.builtShotId = shot.id;

    const lineY = TABLE_DIMENSIONS.surfaceY + 0.0024;
    const markerY = TABLE_DIMENSIONS.surfaceY + 0.0029;

    // 1. Build Cue Ball & Object Ball Trajectory Lines
    for (const traj of shot.trajectories) {
      if (traj.points.length < 2) continue;

      const positions = new Float32Array(traj.points.length * 3);
      for (let i = 0; i < traj.points.length; i++) {
        positions[i * 3 + 0] = traj.points[i].x;
        positions[i * 3 + 1] = lineY + (traj.ballNumber === 0 ? 0.0005 : 0);
        positions[i * 3 + 2] = traj.points[i].z;
      }

      const isCue = traj.ballNumber === 0;
      const def = BALL_DEFINITIONS[traj.ballNumber];
      const baseColor = isCue
        ? 0xf8fafc
        : traj.ballNumber === 8
          ? 0xfbbf24
          : new THREE.Color(def?.color ?? '#38bdf8').getHex();

      // Subtle full-path preview
      const fullGeo = new THREE.BufferGeometry();
      fullGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const fullMat = new THREE.LineBasicMaterial({
        color: baseColor,
        transparent: true,
        opacity: isCue ? 0.34 : 0.24,
        depthWrite: false,
      });
      const fullLine = new THREE.Line(fullGeo, fullMat);
      fullLine.frustumCulled = false;
      this.group.add(fullLine);

      // Active progress path up to currentTimeSec
      const activeGeo = new THREE.BufferGeometry();
      activeGeo.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
      activeGeo.setDrawRange(0, 0);
      const activeMat = new THREE.LineBasicMaterial({
        color: isCue ? 0x38bdf8 : baseColor,
        transparent: true,
        opacity: isCue ? 0.96 : 0.88,
        depthWrite: false,
      });
      const activeLine = new THREE.Line(activeGeo, activeMat);
      activeLine.frustumCulled = false;
      this.group.add(activeLine);

      this.trajectoryEntries.push({
        ballNumber: traj.ballNumber,
        points: traj.points,
        activeLine,
      });
    }

    // 2. Build Collision Point Markers
    const ballRingGeo = new THREE.RingGeometry(
      BALL_SPECS.radius * 0.45,
      BALL_SPECS.radius * 0.85,
      28,
    );
    ballRingGeo.rotateX(-Math.PI / 2);

    const cushionRingGeo = new THREE.RingGeometry(
      BALL_SPECS.radius * 0.32,
      BALL_SPECS.radius * 0.62,
      24,
    );
    cushionRingGeo.rotateX(-Math.PI / 2);

    const dotGeo = new THREE.CircleGeometry(BALL_SPECS.radius * 0.22, 18);
    dotGeo.rotateX(-Math.PI / 2);

    for (const col of shot.collisions) {
      const color =
        col.kind === 'cue_ball'
          ? 0xfbbf24
          : col.kind === 'ball_ball'
            ? 0x38bdf8
            : 0xa7f3d0;

      const markerGroup = new THREE.Group();
      markerGroup.position.set(col.x, markerY, col.z);

      const ringMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ringMesh = new THREE.Mesh(
        col.kind === 'cushion' ? cushionRingGeo.clone() : ballRingGeo.clone(),
        ringMat,
      );

      const dotMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const dotMesh = new THREE.Mesh(dotGeo.clone(), dotMat);
      dotMesh.position.y = 0.0002;

      markerGroup.add(ringMesh);
      markerGroup.add(dotMesh);
      this.group.add(markerGroup);

      this.collisionEntries.push({
        event: col,
        group: markerGroup,
        ringMat,
        dotMat,
      });
    }

    ballRingGeo.dispose();
    cushionRingGeo.dispose();
    dotGeo.dispose();

    // 3. Build Pocketed Ball Pocket Rings
    for (const pocketEvt of shot.pocketedBalls) {
      const pPos = POCKET_POSITIONS.find((p) => p.id === pocketEvt.pocketId);
      if (!pPos) continue;
      const geo = new THREE.RingGeometry(0.058, 0.078, 32);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: pocketEvt.ballNumber === 0 ? 0xf43f5e : 0x10b981,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(pPos.x, markerY + 0.0003, pPos.z);
      this.group.add(mesh);
      this.pocketEntries.push({
        timeSec: pocketEvt.timeSec,
        mesh,
        mat,
      });
    }
  }

  public update(visible: boolean, currentTimeSec: number): void {
    this.group.visible = visible;
    if (!visible) return;

    // Advance progressive trajectory drawRange without allocations
    for (let i = 0; i < this.trajectoryEntries.length; i++) {
      const entry = this.trajectoryEntries[i];
      let count = 0;
      for (let p = 0; p < entry.points.length; p++) {
        if (entry.points[p].timeSec <= currentTimeSec + 0.008) {
          count = p + 1;
        } else {
          break;
        }
      }
      entry.activeLine.geometry.setDrawRange(0, count);
    }

    // Highlight collision markers at impact moment
    for (let i = 0; i < this.collisionEntries.length; i++) {
      const c = this.collisionEntries[i];
      const dt = Math.abs(currentTimeSec - c.event.timeSec);
      const windowSec = c.event.kind === 'cushion' ? 0.14 : 0.2;

      if (dt <= windowSec) {
        const pulse = 1 - dt / windowSec;
        const scale = 1.0 + pulse * (c.event.kind === 'cue_ball' ? 0.95 : 0.7);
        c.group.scale.set(scale, 1, scale);
        c.ringMat.opacity = 0.55 + pulse * 0.45;
        c.dotMat.opacity = 0.7 + pulse * 0.3;
      } else if (currentTimeSec >= c.event.timeSec) {
        c.group.scale.set(1, 1, 1);
        c.ringMat.opacity = 0.58;
        c.dotMat.opacity = 0.72;
      } else {
        c.group.scale.set(0.82, 1, 0.82);
        c.ringMat.opacity = 0.22;
        c.dotMat.opacity = 0.32;
      }
    }

    // Highlight pocketed markers when ball enters pocket
    for (let i = 0; i < this.pocketEntries.length; i++) {
      const p = this.pocketEntries[i];
      const dt = currentTimeSec - p.timeSec;
      if (dt >= -0.05 && dt <= 0.35) {
        const pulse = 1 - Math.abs(dt - 0.1) / 0.25;
        const scale = 1.0 + Math.max(0, pulse) * 0.35;
        p.mesh.scale.set(scale, 1, scale);
        p.mat.opacity = 0.92;
      } else if (currentTimeSec > p.timeSec) {
        p.mesh.scale.set(1, 1, 1);
        p.mat.opacity = 0.7;
      } else {
        p.mesh.scale.set(0.92, 1, 0.92);
        p.mat.opacity = 0.25;
      }
    }
  }

  public clear(): void {
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      this.group.remove(child);
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
    }
    this.trajectoryEntries = [];
    this.collisionEntries = [];
    this.pocketEntries = [];
    this.builtShotId = null;
  }

  public dispose(): void {
    this.clear();
  }
}
