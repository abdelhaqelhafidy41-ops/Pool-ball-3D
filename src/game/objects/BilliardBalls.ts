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

export class BilliardBalls {
  public readonly group = new THREE.Group();
  public readonly balls = new Map<number, BallInstance>();

  constructor(maxAnisotropy: number) {
    this.group.name = 'BilliardBalls';
    this.buildBalls(maxAnisotropy);
  }

  private buildBalls(maxAnisotropy: number) {
    const sphereGeo = new THREE.SphereGeometry(BALL_SPECS.radius, 48, 32);
    const textures = createAllBallTextures(maxAnisotropy);

    const shadowTex = createContactShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(BALL_SPECS.radius * 2.5, BALL_SPECS.radius * 2.5);
    shadowGeo.rotateX(-Math.PI / 2);

    const initialPositions = computeInitialBallPositions();

    for (const pos of initialPositions) {
      const def = BALL_DEFINITIONS[pos.number];
      const tex = textures[pos.number];

      const mat = new THREE.MeshPhysicalMaterial({
        map: tex,
        roughness: 0.13,
        metalness: 0.02,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        reflectivity: 0.9,
        envMapIntensity: 1.15,
      });

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
