import * as THREE from 'three';
import type { FeltTheme } from '../../store/useGameStore';
import { POCKET_POSITIONS, TABLE_DIMENSIONS, type PocketPosition } from '../utils/constants';
import { disposeObject3D } from '../utils/dispose';
import {
  createContactShadowTexture,
  createFeltTextures,
  createFeltTexturesByTableSkin,
  createWoodTextures,
  getTableSkinVisualSpec,
  type FeltTextureSet,
  type TableTrimMetal,
  type TableWoodFinish,
} from '../utils/ProceduralTextures';
import type { GraphicsQualityProfile } from '../utils/graphicsQuality';

export class PoolTable {
  public readonly group = new THREE.Group();
  private readonly decorationGroup = new THREE.Group();

  private feltMaterial!: THREE.MeshPhysicalMaterial;
  private cushionMaterial!: THREE.MeshStandardMaterial;
  private woodMaterial!: THREE.MeshPhysicalMaterial;
  private darkWoodMaterial!: THREE.MeshStandardMaterial;
  private brassMaterial!: THREE.MeshPhysicalMaterial;
  private leatherMaterial!: THREE.MeshStandardMaterial;
  private pearlMaterial!: THREE.MeshPhysicalMaterial;
  private slateUnderMaterial!: THREE.MeshStandardMaterial;

  private feltTextures!: FeltTextureSet;
  private woodMap!: THREE.CanvasTexture;
  private woodRoughMap!: THREE.CanvasTexture;
  private diamondSightsMesh: THREE.InstancedMesh | null = null;

  private maxAnisotropy: number;
  private currentTableSkinId = 'table_classic_green';
  private currentDecorationId = 'decor_none';
  private currentFallbackTheme: FeltTheme;
  private currentWoodFinish: TableWoodFinish = 'walnut';
  private appliedFeltKey = '';

  constructor(initialTheme: FeltTheme, maxAnisotropy: number) {
    this.maxAnisotropy = maxAnisotropy;
    this.currentFallbackTheme = initialTheme;
    this.group.name = 'PoolTable';
    this.decorationGroup.name = 'TableDecorations';
    this.buildTable(initialTheme);
    this.group.add(this.decorationGroup);
  }

  private buildTable(theme: FeltTheme) {
    const spec = getTableSkinVisualSpec(this.currentTableSkinId, theme);
    this.currentWoodFinish = spec.woodFinish;
    const wood = createWoodTextures(this.maxAnisotropy, spec.woodFinish);
    this.woodMap = wood.map;
    this.woodRoughMap = wood.roughnessMap;
    this.feltTextures = createFeltTextures(theme, this.maxAnisotropy);
    this.appliedFeltKey = `${this.currentTableSkinId}::${theme}`;

    // Materials
    this.feltMaterial = new THREE.MeshPhysicalMaterial({
      map: this.feltTextures.map,
      bumpMap: this.feltTextures.bumpMap,
      bumpScale: 0.0022,
      roughness: 0.88,
      metalness: 0.0,
      sheen: 0.36,
      sheenRoughness: 0.84,
      sheenColor: new THREE.Color(spec.clothHighlight),
    });

    this.cushionMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.cushionHex),
      bumpMap: this.feltTextures.bumpMap,
      bumpScale: 0.0018,
      roughness: 0.86,
      metalness: 0.0,
    });

    this.woodMaterial = new THREE.MeshPhysicalMaterial({
      map: this.woodMap,
      roughnessMap: this.woodRoughMap,
      roughness: 0.34,
      metalness: 0.04,
      clearcoat: 0.65,
      clearcoatRoughness: 0.18,
    });

    this.darkWoodMaterial = new THREE.MeshStandardMaterial({
      map: this.woodMap,
      color: 0x8b6e5b,
      roughness: 0.45,
      metalness: 0.05,
    });

    this.brassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xd9b35c,
      metalness: 0.92,
      roughness: 0.2,
      anisotropy: 0.75,
      clearcoat: 0.35,
      clearcoatRoughness: 0.12,
    });

    this.leatherMaterial = new THREE.MeshStandardMaterial({
      color: 0x161211,
      roughness: 0.74,
      metalness: 0.06,
    });

    const pocketWellMaterial = new THREE.MeshStandardMaterial({
      color: 0x07080a,
      roughness: 0.94,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });

    this.pearlMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xf4efe2,
      roughness: 0.18,
      metalness: 0.08,
      clearcoat: 0.85,
    });

    this.slateUnderMaterial = new THREE.MeshStandardMaterial({
      color: 0x181c22,
      roughness: 0.7,
      metalness: 0.1,
    });

    // 1. Slate Bed & Felt Playing Surface with true 6 Pocket Cutouts
    this.buildPlayingSurface(this.slateUnderMaterial);

    // 2. Six Rubber Cushions (K-55 profile with mitered pocket jaws)
    this.buildCushions();

    // 3. Wooden Rails with precision Pocket Bays + Inlaid Diamond Sights
    this.buildRailsAndSights(this.woodMaterial, this.pearlMaterial);

    // 4. Redesigned Unified Six Pockets (Turned drop wells + flush leather throats + brass castings)
    this.buildPockets(this.brassMaterial, this.leatherMaterial, pocketWellMaterial);

    // 5. Cabinet Apron, Brass Trim & 4 Turned Lathe Legs
    this.buildCabinetAndLegs(this.darkWoodMaterial, this.brassMaterial);

    // 6. Ground Contact Shadow under the table
    const shadowTex = createContactShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(3.6, 2.3);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.62,
    });
    const tableShadow = new THREE.Mesh(shadowGeo, shadowMat);
    tableShadow.rotation.x = -Math.PI / 2;
    tableShadow.position.y = 0.003;
    this.group.add(tableShadow);
  }

  private buildPlayingSurface(slateMaterial: THREE.Material) {
    const D = TABLE_DIMENSIONS;
    // Keep outer perimeter strictly outside all 6 pocket holes (max |x|=1.350, max |z|=0.728)
    // while staying inside the cabinet footprint (1.380 x 0.745) and buried beneath wooden rails.
    const outerHalfL = D.halfLength + D.cushionDepth + 0.06; // 1.378
    const outerHalfW = D.halfWidth + D.cushionDepth + 0.06;  // 0.743

    // 2D shape in XY (rotated -PI/2 around X so shapeY -> -worldZ)
    const clothShape = new THREE.Shape();
    clothShape.moveTo(-outerHalfL, -outerHalfW);
    clothShape.lineTo(outerHalfL, -outerHalfW);
    clothShape.lineTo(outerHalfL, outerHalfW);
    clothShape.lineTo(-outerHalfL, outerHalfW);
    clothShape.closePath();

    // Subtract 6 clean circular pocket holes aligned to POCKET_POSITIONS
    for (const p of POCKET_POSITIONS) {
      const hole = new THREE.Path();
      hole.absarc(p.x, -p.z, p.radius, 0, Math.PI * 2, true);
      clothShape.holes.push(hole);
    }

    const feltGeo = new THREE.ShapeGeometry(clothShape, 40);
    feltGeo.rotateX(-Math.PI / 2);

    // Map UVs cleanly across the inner playing surface
    const posAttr = feltGeo.attributes.position;
    const uvAttr = feltGeo.attributes.uv;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      const u = (x + D.halfLength) / D.playLength;
      const v = 1 - (z + D.halfWidth) / D.playWidth;
      uvAttr.setXY(i, u, v);
    }
    uvAttr.needsUpdate = true;

    const feltMesh = new THREE.Mesh(feltGeo, this.feltMaterial);
    feltMesh.position.y = D.surfaceY;
    feltMesh.receiveShadow = true;
    feltMesh.name = 'PlayingSurfaceCloth';
    this.group.add(feltMesh);

    // Solid slate backing beneath the cloth (same exact 6 pocket cutouts)
    const slateGeo = new THREE.ExtrudeGeometry(clothShape, {
      depth: D.slateThickness,
      bevelEnabled: false,
      curveSegments: 36,
    });
    slateGeo.rotateX(-Math.PI / 2);
    const slateMesh = new THREE.Mesh(slateGeo, slateMaterial);
    slateMesh.position.y = D.surfaceY - D.slateThickness - 0.0006;
    slateMesh.receiveShadow = true;
    slateMesh.name = 'SlateBed';
    this.group.add(slateMesh);
  }

  private buildCushions() {
    const D = TABLE_DIMENSIONS;
    const h = D.railHeight - 0.004;
    const noseY = D.cushionHeight;
    const depth = D.cushionDepth;

    const createCushionSegment = (
      length: number,
      bevelStart: number,
      bevelEnd: number,
    ): THREE.BufferGeometry => {
      const shape = new THREE.Shape();
      shape.moveTo(0, 0.004);
      shape.lineTo(depth, noseY - 0.004);
      shape.lineTo(depth, noseY + 0.003);
      shape.lineTo(0, h);
      shape.closePath();

      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: length,
        bevelEnabled: true,
        bevelThickness: 0.0025,
        bevelSize: 0.002,
        bevelSegments: 2,
      });

      geo.translate(0, 0, -length / 2);

      // Miter/angle cushion ends into pocket throats
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i); // 0 (wood rail edge) .. depth (cushion nose)
        const vz = pos.getZ(i);
        const noseRatio = Math.max(0, Math.min(1, vx / depth));
        if (vz < -length / 2 + 0.018 && bevelStart !== 0) {
          pos.setZ(i, vz + bevelStart * noseRatio);
        } else if (vz > length / 2 - 0.018 && bevelEnd !== 0) {
          pos.setZ(i, vz - bevelEnd * noseRatio);
        }
      }
      geo.computeVertexNormals();
      return geo;
    };

    const longSegStart = D.sideMouthGap;
    const longSegEnd = D.halfLength - D.cornerMouthGap;
    const longSegLen = longSegEnd - longSegStart;
    const longSegCenter = (longSegStart + longSegEnd) / 2;

    const longConfigs = [
      { x: -longSegCenter, z: -D.halfWidth - depth, rotY: Math.PI / 2, bStart: 0.032, bEnd: 0.016 },
      { x: longSegCenter, z: -D.halfWidth - depth, rotY: Math.PI / 2, bStart: 0.016, bEnd: 0.032 },
      { x: -longSegCenter, z: D.halfWidth + depth, rotY: -Math.PI / 2, bStart: 0.016, bEnd: 0.032 },
      { x: longSegCenter, z: D.halfWidth + depth, rotY: -Math.PI / 2, bStart: 0.032, bEnd: 0.016 },
    ];

    for (const cfg of longConfigs) {
      const geo = createCushionSegment(longSegLen, cfg.bStart, cfg.bEnd);
      const mesh = new THREE.Mesh(geo, this.cushionMaterial);
      mesh.position.set(cfg.x, D.surfaceY, cfg.z);
      mesh.rotation.y = cfg.rotY;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    const shortSegLen = D.playWidth - 2 * D.cornerMouthGap;
    const shortConfigs = [
      { x: -D.halfLength - depth, z: 0, rotY: 0 },
      { x: D.halfLength + depth, z: 0, rotY: Math.PI },
    ];

    for (const cfg of shortConfigs) {
      const geo = createCushionSegment(shortSegLen, 0.032, 0.032);
      const mesh = new THREE.Mesh(geo, this.cushionMaterial);
      mesh.position.set(cfg.x, D.surfaceY, cfg.z);
      mesh.rotation.y = cfg.rotY;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  private buildRailsAndSights(woodMat: THREE.Material, pearlMat: THREE.Material) {
    const D = TABLE_DIMENSIONS;
    const innerEdgeX = D.halfLength + D.cushionDepth;
    const innerEdgeZ = D.halfWidth + D.cushionDepth;
    const outerEdgeX = innerEdgeX + D.railWidth;
    const outerEdgeZ = innerEdgeZ + D.railWidth;

    const railShape = new THREE.Shape();
    railShape.moveTo(-outerEdgeX, -outerEdgeZ);
    railShape.lineTo(outerEdgeX, -outerEdgeZ);
    railShape.lineTo(outerEdgeX, outerEdgeZ);
    railShape.lineTo(-outerEdgeX, outerEdgeZ);
    railShape.closePath();

    // Compute exact intersection points of the inner rail lines with each pocket bay circle
    // Pocket bay radius matches the outer wall of the leather throat liner so there are zero gaps
    const tl = POCKET_POSITIONS[0]; // (-1.288, -0.653) -> shape (-1.288, +0.653)
    const tr = POCKET_POSITIONS[1];
    const bl = POCKET_POSITIONS[2];
    const br = POCKET_POSITIONS[3];
    const st = POCKET_POSITIONS[4]; // (0, -0.663) -> shape (0, +0.663)
    const sb = POCKET_POSITIONS[5];

    const cornerBayR = tl.radius + 0.011; // 0.073
    const sideBayR = st.radius + 0.011;   // 0.076

    const cornerDx = Math.sqrt(Math.max(0, cornerBayR * cornerBayR - (innerEdgeZ - Math.abs(tl.z)) ** 2));
    const cornerDz = Math.sqrt(Math.max(0, cornerBayR * cornerBayR - (innerEdgeX - Math.abs(tl.x)) ** 2));
    const sideDx = Math.sqrt(Math.max(0, sideBayR * sideBayR - (innerEdgeZ - Math.abs(st.z)) ** 2));

    const hole = new THREE.Path();

    // Start just right of Top-Left corner bay on Top rail, trace Clockwise around inner table
    hole.moveTo(tl.x + cornerDx, innerEdgeZ);

    // Top-Left corner pocket arc (sweeping around outer corner)
    const tlStartA = Math.atan2(innerEdgeZ - (-tl.z), (tl.x + cornerDx) - tl.x);
    const tlEndA = Math.atan2((-tl.z - cornerDz) - (-tl.z), -innerEdgeX - tl.x);
    hole.absarc(tl.x, -tl.z, cornerBayR, tlStartA, tlEndA, false);

    // Left rail down to Bottom-Left corner bay
    hole.lineTo(-innerEdgeX, -bl.z + cornerDz);
    const blStartA = Math.atan2((-bl.z + cornerDz) - (-bl.z), -innerEdgeX - bl.x);
    const blEndA = Math.atan2(-innerEdgeZ - (-bl.z), (bl.x + cornerDx) - bl.x);
    hole.absarc(bl.x, -bl.z, cornerBayR, blStartA, blEndA, false);

    // Bottom-Left rail to Bottom Side pocket bay
    hole.lineTo(-sideDx, -innerEdgeZ);
    const sbStartA = Math.atan2(-innerEdgeZ - (-sb.z), -sideDx - sb.x);
    const sbEndA = Math.atan2(-innerEdgeZ - (-sb.z), sideDx - sb.x);
    hole.absarc(sb.x, -sb.z, sideBayR, sbStartA, sbEndA, false);

    // Bottom-Right rail to Bottom-Right corner bay
    hole.lineTo(br.x - cornerDx, -innerEdgeZ);
    const brStartA = Math.atan2(-innerEdgeZ - (-br.z), (br.x - cornerDx) - br.x);
    const brEndA = Math.atan2((-br.z + cornerDz) - (-br.z), innerEdgeX - br.x);
    hole.absarc(br.x, -br.z, cornerBayR, brStartA, brEndA, false);

    // Right rail up to Top-Right corner bay
    hole.lineTo(innerEdgeX, -tr.z - cornerDz);
    const trStartA = Math.atan2((-tr.z - cornerDz) - (-tr.z), innerEdgeX - tr.x);
    const trEndA = Math.atan2(innerEdgeZ - (-tr.z), (tr.x - cornerDx) - tr.x);
    hole.absarc(tr.x, -tr.z, cornerBayR, trStartA, trEndA, false);

    // Top-Right rail to Top Side pocket bay
    hole.lineTo(sideDx, innerEdgeZ);
    const stStartA = Math.atan2(innerEdgeZ - (-st.z), sideDx - st.x);
    const stEndA = Math.atan2(innerEdgeZ - (-st.z), -sideDx - st.x);
    hole.absarc(st.x, -st.z, sideBayR, stStartA, stEndA, false);

    hole.closePath();
    railShape.holes.push(hole);

    const railGeo = new THREE.ExtrudeGeometry(railShape, {
      depth: D.railHeight,
      bevelEnabled: true,
      bevelThickness: 0.005,
      bevelSize: 0.005,
      bevelSegments: 3,
      curveSegments: 28,
    });
    railGeo.rotateX(-Math.PI / 2);

    const pos = railGeo.attributes.position;
    const uv = railGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, pos.getX(i) * 0.65, pos.getZ(i) * 0.65);
    }
    uv.needsUpdate = true;

    const railMesh = new THREE.Mesh(railGeo, woodMat);
    railMesh.position.y = D.surfaceY;
    railMesh.castShadow = true;
    railMesh.receiveShadow = true;
    railMesh.name = 'WoodenRails';
    this.group.add(railMesh);

    // Mother-of-Pearl Diamond Sights (18 sights inlaid flush via single InstancedMesh)
    const diamondShape = new THREE.Shape();
    diamondShape.moveTo(0, 0.012);
    diamondShape.lineTo(0.007, 0);
    diamondShape.lineTo(0, -0.012);
    diamondShape.lineTo(-0.007, 0);
    diamondShape.closePath();

    const sightGeo = new THREE.ShapeGeometry(diamondShape);
    sightGeo.rotateX(-Math.PI / 2);

    const sightY = D.surfaceY + D.railHeight + 0.0054;
    const longSightZ = innerEdgeZ + D.railWidth * 0.5;
    const shortSightX = innerEdgeX + D.railWidth * 0.5;

    const longFractions = [-3 / 8, -2 / 8, -1 / 8, 1 / 8, 2 / 8, 3 / 8];
    const shortFractions = [-1 / 4, 0, 1 / 4];
    const totalSights = longFractions.length * 2 + shortFractions.length * 2;

    const sightInstanced = new THREE.InstancedMesh(sightGeo, pearlMat, totalSights);
    sightInstanced.name = 'DiamondSights';

    const matrix = new THREE.Matrix4();
    const posVec = new THREE.Vector3();
    const quatId = new THREE.Quaternion();
    const quatRot = new THREE.Quaternion().setFromAxisAngle(
      THREE.Object3D.DEFAULT_UP,
      Math.PI / 2,
    );
    const scaleOne = new THREE.Vector3(1, 1, 1);

    let instanceIdx = 0;
    for (const frac of longFractions) {
      const sx = frac * D.playLength;
      for (const sz of [-longSightZ, longSightZ]) {
        posVec.set(sx, sightY, sz);
        matrix.compose(posVec, quatId, scaleOne);
        sightInstanced.setMatrixAt(instanceIdx++, matrix);
      }
    }

    for (const frac of shortFractions) {
      const sz = frac * D.playWidth;
      for (const sx of [-shortSightX, shortSightX]) {
        posVec.set(sx, sightY, sz);
        matrix.compose(posVec, quatRot, scaleOne);
        sightInstanced.setMatrixAt(instanceIdx++, matrix);
      }
    }
    sightInstanced.instanceMatrix.needsUpdate = true;
    this.diamondSightsMesh = sightInstanced;
    this.group.add(sightInstanced);
  }

  /**
   * Builds a clean annular arc shape in 2D XY (for ExtrudeGeometry rotated -PI/2 around X).
   */
  private createArcFlangeGeometry(
    innerR: number,
    outerR: number,
    startAngle: number,
    endAngle: number,
    height: number,
    bevel: boolean,
  ): THREE.BufferGeometry {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, outerR, startAngle, endAngle, false);
    shape.lineTo(Math.cos(endAngle) * innerR, Math.sin(endAngle) * innerR);
    shape.absarc(0, 0, innerR, endAngle, startAngle, true);
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: bevel,
      bevelThickness: bevel ? 0.003 : 0,
      bevelSize: bevel ? 0.0025 : 0,
      bevelSegments: bevel ? 3 : 1,
      curveSegments: 32,
    });
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  private buildPockets(
    brassMat: THREE.Material,
    leatherMat: THREE.Material,
    wellMat: THREE.Material,
  ) {
    const D = TABLE_DIMENSIONS;
    const wellDepth = 0.145;

    for (const pocket of POCKET_POSITIONS) {
      const pocketGroup = this.createPocketAssembly(
        pocket,
        D.railHeight,
        wellDepth,
        brassMat,
        leatherMat,
        wellMat,
      );
      pocketGroup.position.set(pocket.x, D.surfaceY, pocket.z);
      this.group.add(pocketGroup);
    }
  }

  private createPocketAssembly(
    pocket: PocketPosition,
    railHeight: number,
    wellDepth: number,
    brassMat: THREE.Material,
    leatherMat: THREE.Material,
    wellMat: THREE.Material,
  ): THREE.Group {
    const g = new THREE.Group();
    g.name = `Pocket_${pocket.id}`;

    const rHole = pocket.radius;
    const rBay = rHole + 0.011;

    // 1. Continuous 360-degree turned drop-well cup (flush beneath cloth hole edge)
    // Lathe profile: bottom floor -> tapered drop wall -> flush lip just under cloth surface (y = -0.0004)
    const wellPoints = [
      new THREE.Vector2(0.0, -wellDepth),
      new THREE.Vector2(rHole * 0.78, -wellDepth),
      new THREE.Vector2(rHole * 0.86, -wellDepth + 0.025),
      new THREE.Vector2(rHole * 0.985, -0.006),
      new THREE.Vector2(rHole * 1.015, -0.0004),
    ];
    const wellGeo = new THREE.LatheGeometry(wellPoints, 40);
    wellGeo.computeVertexNormals();
    const wellMesh = new THREE.Mesh(wellGeo, wellMat);
    wellMesh.name = `PocketWell_${pocket.id}`;
    wellMesh.receiveShadow = true;
    g.add(wellMesh);

    // 2. Outward angle facing away from table center in 2D shape coords (shapeX = x, shapeY = -z)
    const outwardAngle = Math.atan2(-Math.sign(pocket.z), Math.sign(pocket.x));
    // Corners wrap ~224 degrees around the outer rail bay; side pockets wrap ~174 degrees
    const halfSweep = pocket.isCorner ? Math.PI * 0.625 : Math.PI * 0.485;
    const startA = outwardAngle - halfSweep;
    const endA = outwardAngle + halfSweep;

    // 3. Dark Leather Throat Liner Wall (connects slate cutout cleanly up to rail top)
    const linerHeight = railHeight + 0.005;
    const linerGeo = this.createArcFlangeGeometry(
      rHole - 0.001,
      rBay + 0.002,
      startA,
      endA,
      linerHeight,
      false,
    );
    const linerMesh = new THREE.Mesh(linerGeo, leatherMat);
    linerMesh.position.y = -0.001;
    linerMesh.castShadow = true;
    linerMesh.receiveShadow = true;
    g.add(linerMesh);

    // 4. Sculpted Brushed Gold/Brass Outer Casting Collar (seated flush on top of wooden rail & leather liner)
    const rimFlangeGeo = this.createArcFlangeGeometry(
      rHole + 0.002,
      rBay + 0.025,
      startA - 0.04,
      endA + 0.04,
      0.0065,
      true,
    );
    const rimMesh = new THREE.Mesh(rimFlangeGeo, brassMat);
    rimMesh.position.y = railHeight + 0.0035;
    rimMesh.castShadow = true;
    rimMesh.receiveShadow = true;
    g.add(rimMesh);

    // 5. Recessed Inner Leather Bumper Strip inside the brass casting (subtle stepped rim)
    const innerPadGeo = this.createArcFlangeGeometry(
      rHole - 0.002,
      rHole + 0.009,
      startA,
      endA,
      0.009,
      true,
    );
    const innerPadMesh = new THREE.Mesh(innerPadGeo, leatherMat);
    innerPadMesh.position.y = railHeight + 0.002;
    innerPadMesh.castShadow = true;
    g.add(innerPadMesh);

    return g;
  }

  private buildCabinetAndLegs(woodMat: THREE.Material, brassMat: THREE.Material) {
    const D = TABLE_DIMENSIONS;
    const cabinetL = D.playLength + 0.22;
    const cabinetW = D.playWidth + 0.22;
    const cabinetHalfL = cabinetL * 0.5;
    const cabinetHalfW = cabinetW * 0.5;
    const cabinetTopY = D.surfaceY - D.slateThickness;

    // Punch pocket well clearances through the cabinet block so top-down views never hit wood inside pockets
    const apronShape = new THREE.Shape();
    apronShape.moveTo(-cabinetHalfL, -cabinetHalfW);
    apronShape.lineTo(cabinetHalfL, -cabinetHalfW);
    apronShape.lineTo(cabinetHalfL, cabinetHalfW);
    apronShape.lineTo(-cabinetHalfL, cabinetHalfW);
    apronShape.closePath();

    for (const p of POCKET_POSITIONS) {
      const hole = new THREE.Path();
      hole.absarc(p.x, -p.z, p.radius + 0.004, 0, Math.PI * 2, true);
      apronShape.holes.push(hole);
    }

    const apronGeo = new THREE.ExtrudeGeometry(apronShape, {
      depth: D.apronHeight,
      bevelEnabled: false,
      curveSegments: 24,
    });
    apronGeo.rotateX(-Math.PI / 2);
    const apronPos = apronGeo.attributes.position;
    const apronUv = apronGeo.attributes.uv;
    for (let i = 0; i < apronPos.count; i++) {
      apronUv.setXY(
        i,
        (apronPos.getX(i) + apronPos.getZ(i)) * 0.45,
        apronPos.getY(i) * 2.2,
      );
    }
    apronUv.needsUpdate = true;

    const apronMesh = new THREE.Mesh(apronGeo, woodMat);
    apronMesh.position.y = cabinetTopY - D.apronHeight;
    apronMesh.castShadow = true;
    apronMesh.receiveShadow = true;
    apronMesh.name = 'CabinetApron';
    this.group.add(apronMesh);

    const trimGeo = new THREE.BoxGeometry(cabinetL + 0.016, 0.014, cabinetW + 0.016);
    const trimMesh = new THREE.Mesh(trimGeo, brassMat);
    trimMesh.position.y = cabinetTopY - D.apronHeight + 0.018;
    this.group.add(trimMesh);

    const plaqueGeo = new THREE.BoxGeometry(0.24, 0.042, 0.01);
    const plaque = new THREE.Mesh(plaqueGeo, brassMat);
    plaque.position.set(0, cabinetTopY - D.apronHeight * 0.45, cabinetW * 0.5 + 0.004);
    this.group.add(plaque);

    const legTopY = cabinetTopY - D.apronHeight + 0.02;
    const lathePoints = [
      new THREE.Vector2(0.0, 0.0),
      new THREE.Vector2(0.056, 0.0),
      new THREE.Vector2(0.06, 0.025),
      new THREE.Vector2(0.045, 0.04),
      new THREE.Vector2(0.052, 0.14),
      new THREE.Vector2(0.072, 0.28),
      new THREE.Vector2(0.088, 0.40),
      new THREE.Vector2(0.076, 0.46),
      new THREE.Vector2(0.095, 0.52),
      new THREE.Vector2(0.095, legTopY),
      new THREE.Vector2(0.0, legTopY),
    ];
    const legGeo = new THREE.LatheGeometry(lathePoints, 28);
    legGeo.computeVertexNormals();

    const footGeo = new THREE.CylinderGeometry(0.058, 0.062, 0.032, 24);

    const legX = cabinetL * 0.5 - 0.16;
    const legZ = cabinetW * 0.5 - 0.14;
    const legOffsets = [
      [-legX, -legZ],
      [legX, -legZ],
      [-legX, legZ],
      [legX, legZ],
    ];

    for (const [lx, lz] of legOffsets) {
      const legMesh = new THREE.Mesh(legGeo, woodMat);
      legMesh.position.set(lx, 0, lz);
      legMesh.castShadow = true;
      legMesh.receiveShadow = true;
      this.group.add(legMesh);

      const footMesh = new THREE.Mesh(footGeo, brassMat);
      footMesh.position.set(lx, 0.016, lz);
      footMesh.castShadow = true;
      this.group.add(footMesh);
    }
  }

  private applyTrimMetal(trimMetal: TableTrimMetal) {
    this.brassMaterial.emissive.setHex(0x000000);
    this.brassMaterial.emissiveIntensity = 0;
    this.pearlMaterial.color.setHex(0xf4efe2);
    this.pearlMaterial.emissive.setHex(0x000000);
    this.pearlMaterial.emissiveIntensity = 0;

    switch (trimMetal) {
      case 'steel':
        this.brassMaterial.color.setHex(0xcbd5e1);
        this.brassMaterial.roughness = 0.16;
        this.leatherMaterial.color.setHex(0x13161b);
        this.darkWoodMaterial.color.setHex(0x7c6e67);
        break;
      case 'gold':
        this.brassMaterial.color.setHex(0xf2c95d);
        this.brassMaterial.roughness = 0.17;
        this.leatherMaterial.color.setHex(0x151110);
        this.darkWoodMaterial.color.setHex(0x6d615c);
        this.pearlMaterial.color.setHex(0xfef3c7);
        break;
      case 'cyan_chrome':
        this.brassMaterial.color.setHex(0x94e2f5);
        this.brassMaterial.roughness = 0.14;
        this.brassMaterial.emissive.setHex(0x0891b2);
        this.brassMaterial.emissiveIntensity = 0.25;
        this.leatherMaterial.color.setHex(0x0c1118);
        this.darkWoodMaterial.color.setHex(0x525b68);
        this.pearlMaterial.color.setHex(0x22d3ee);
        this.pearlMaterial.emissive.setHex(0x22d3ee);
        this.pearlMaterial.emissiveIntensity = 0.65;
        break;
      case 'brass':
      default:
        this.brassMaterial.color.setHex(0xd9b35c);
        this.brassMaterial.roughness = 0.2;
        this.leatherMaterial.color.setHex(0x161211);
        this.darkWoodMaterial.color.setHex(0x8b6e5b);
        break;
    }

    this.brassMaterial.needsUpdate = true;
    this.leatherMaterial.needsUpdate = true;
    this.darkWoodMaterial.needsUpdate = true;
    this.pearlMaterial.needsUpdate = true;
  }

  private rebuildDecorations(decorationId: string, tableSkinId: string) {
    disposeObject3D(this.decorationGroup);
    this.decorationGroup.clear();

    const D = TABLE_DIMENSIONS;
    const innerEdgeX = D.halfLength + D.cushionDepth;
    const innerEdgeZ = D.halfWidth + D.cushionDepth;
    const outerEdgeX = innerEdgeX + D.railWidth;
    const outerEdgeZ = innerEdgeZ + D.railWidth;
    const cabinetL = D.playLength + 0.22;
    const cabinetW = D.playWidth + 0.22;
    const cabinetTopY = D.surfaceY - D.slateThickness;
    const railTopY = D.surfaceY + D.railHeight + 0.0056;

    // Neon Arena table natively includes subtle perimeter cyan trim unless overridden
    const effectiveDecor =
      decorationId === 'decor_none' && tableSkinId === 'table_neon_arena'
        ? 'decor_neon_underflow'
        : decorationId;

    if (effectiveDecor === 'decor_none') {
      return;
    }

    if (effectiveDecor === 'decor_brass_corners' || effectiveDecor === 'decor_gold_inlays') {
      const accentHex = effectiveDecor === 'decor_gold_inlays' ? 0xf6c85f : 0xd4a84f;
      const accentMat = new THREE.MeshPhysicalMaterial({
        color: accentHex,
        metalness: 0.94,
        roughness: 0.16,
        clearcoat: 0.4,
      });

      // Corner rail escutcheon plates (strictly on outer wood corners, zero cloth overlap)
      const plateGeo = new THREE.BoxGeometry(0.068, 0.004, 0.068);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const plate = new THREE.Mesh(plateGeo, accentMat);
          plate.position.set(
            sx * (outerEdgeX - 0.046),
            railTopY,
            sz * (outerEdgeZ - 0.046),
          );
          this.decorationGroup.add(plate);
        }
      }

      if (effectiveDecor === 'decor_gold_inlays') {
        const longStripGeo = new THREE.BoxGeometry(cabinetL * 0.86, 0.009, 0.008);
        for (const sz of [-1, 1]) {
          const strip = new THREE.Mesh(longStripGeo, accentMat);
          strip.position.set(0, cabinetTopY - D.apronHeight * 0.22, sz * (cabinetW * 0.5 + 0.003));
          this.decorationGroup.add(strip);
        }
        const shortStripGeo = new THREE.BoxGeometry(0.008, 0.009, cabinetW * 0.82);
        for (const sx of [-1, 1]) {
          const strip = new THREE.Mesh(shortStripGeo, accentMat);
          strip.position.set(sx * (cabinetL * 0.5 + 0.003), cabinetTopY - D.apronHeight * 0.22, 0);
          this.decorationGroup.add(strip);
        }
      }
      return;
    }

    if (effectiveDecor === 'decor_neon_underflow') {
      const neonMat = new THREE.MeshStandardMaterial({
        color: 0x67e8f9,
        emissive: 0x22d3ee,
        emissiveIntensity: 1.35,
        roughness: 0.2,
        metalness: 0.1,
      });

      // Perimeter apron neon rails (outside cabinet box)
      const longLedGeo = new THREE.BoxGeometry(cabinetL + 0.022, 0.011, 0.012);
      for (const sz of [-1, 1]) {
        const led = new THREE.Mesh(longLedGeo, neonMat);
        led.position.set(0, cabinetTopY - D.apronHeight * 0.52, sz * (cabinetW * 0.5 + 0.007));
        this.decorationGroup.add(led);
      }

      const shortLedGeo = new THREE.BoxGeometry(0.012, 0.011, cabinetW + 0.022);
      for (const sx of [-1, 1]) {
        const led = new THREE.Mesh(shortLedGeo, neonMat);
        led.position.set(sx * (cabinetL * 0.5 + 0.007), cabinetTopY - D.apronHeight * 0.52, 0);
        this.decorationGroup.add(led);
      }

      // Pedestal floor halo rectangle
      const floorMat = new THREE.MeshBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.55,
      });
      const fLong = new THREE.BoxGeometry(cabinetL + 0.06, 0.004, 0.016);
      const fShort = new THREE.BoxGeometry(0.016, 0.004, cabinetW + 0.06);
      for (const sz of [-1, 1]) {
        const bar = new THREE.Mesh(fLong, floorMat);
        bar.position.set(0, 0.005, sz * (cabinetW * 0.5 + 0.024));
        this.decorationGroup.add(bar);
      }
      for (const sx of [-1, 1]) {
        const bar = new THREE.Mesh(fShort, floorMat);
        bar.position.set(sx * (cabinetL * 0.5 + 0.024), 0.005, 0);
        this.decorationGroup.add(bar);
      }
      return;
    }

    if (
      effectiveDecor === 'decor_championship_crest' ||
      effectiveDecor === 'decor_season1_obsidian_gold'
    ) {
      const goldMat = new THREE.MeshPhysicalMaterial({
        color: 0xfbbf24,
        metalness: 0.96,
        roughness: 0.14,
        emissive: 0x92400e,
        emissiveIntensity: 0.22,
      });

      const longFiligreeGeo = new THREE.BoxGeometry(cabinetL + 0.022, 0.012, 0.01);
      for (const sz of [-1, 1]) {
        const bar = new THREE.Mesh(longFiligreeGeo, goldMat);
        bar.position.set(0, cabinetTopY - D.apronHeight * 0.25, sz * (cabinetW * 0.5 + 0.006));
        this.decorationGroup.add(bar);
      }
      const shortFiligreeGeo = new THREE.BoxGeometry(0.01, 0.012, cabinetW + 0.022);
      for (const sx of [-1, 1]) {
        const bar = new THREE.Mesh(shortFiligreeGeo, goldMat);
        bar.position.set(sx * (cabinetL * 0.5 + 0.006), cabinetTopY - D.apronHeight * 0.25, 0);
        this.decorationGroup.add(bar);
      }

      // Floor gold championship trim perimeter
      const floorRingMat = new THREE.MeshBasicMaterial({
        color: 0xf59e0b,
        transparent: true,
        opacity: 0.45,
      });
      const fLong = new THREE.BoxGeometry(cabinetL + 0.08, 0.004, 0.018);
      const fShort = new THREE.BoxGeometry(0.018, 0.004, cabinetW + 0.08);
      for (const sz of [-1, 1]) {
        const bar = new THREE.Mesh(fLong, floorRingMat);
        bar.position.set(0, 0.005, sz * (cabinetW * 0.5 + 0.032));
        this.decorationGroup.add(bar);
      }
      for (const sx of [-1, 1]) {
        const bar = new THREE.Mesh(fShort, floorRingMat);
        bar.position.set(sx * (cabinetL * 0.5 + 0.032), 0.005, 0);
        this.decorationGroup.add(bar);
      }
    }
  }

  public setFeltTheme(theme: FeltTheme) {
    this.currentFallbackTheme = theme;
    this.applyTableCosmetics(this.currentTableSkinId, this.currentDecorationId, theme);
  }

  public applyTableCosmetics(
    tableSkinId: string,
    decorationId: string,
    fallbackTheme?: FeltTheme,
  ) {
    const resolvedTheme = fallbackTheme ?? this.currentFallbackTheme;
    this.currentFallbackTheme = resolvedTheme;
    const normalizedTable = tableSkinId || 'table_classic_green';
    const normalizedDecor = decorationId || 'decor_none';

    const spec = getTableSkinVisualSpec(normalizedTable, resolvedTheme);
    const nextFeltKey = `${normalizedTable}::${resolvedTheme}`;

    if (nextFeltKey !== this.appliedFeltKey) {
      this.appliedFeltKey = nextFeltKey;
      const nextFelt = createFeltTexturesByTableSkin(
        normalizedTable,
        this.maxAnisotropy,
        resolvedTheme,
      );
      const oldMap = this.feltTextures.map;
      const oldBump = this.feltTextures.bumpMap;

      this.feltTextures = nextFelt;
      this.feltMaterial.map = nextFelt.map;
      this.feltMaterial.bumpMap = nextFelt.bumpMap;
      this.feltMaterial.sheenColor.set(spec.clothHighlight);
      this.feltMaterial.needsUpdate = true;

      this.cushionMaterial.color.setHex(spec.cushionHex);
      this.cushionMaterial.bumpMap = nextFelt.bumpMap;
      this.cushionMaterial.needsUpdate = true;

      oldMap.dispose();
      oldBump.dispose();
    }

    if (spec.woodFinish !== this.currentWoodFinish) {
      this.currentWoodFinish = spec.woodFinish;
      const oldWoodMap = this.woodMap;
      const oldWoodRough = this.woodRoughMap;
      const nextWood = createWoodTextures(this.maxAnisotropy, spec.woodFinish);
      this.woodMap = nextWood.map;
      this.woodRoughMap = nextWood.roughnessMap;

      this.woodMaterial.map = this.woodMap;
      this.woodMaterial.roughnessMap = this.woodRoughMap;
      this.woodMaterial.roughness = spec.woodFinish === 'obsidian_neon' ? 0.22 : 0.34;
      this.woodMaterial.metalness = spec.woodFinish === 'obsidian_neon' ? 0.16 : 0.04;
      this.woodMaterial.needsUpdate = true;

      this.darkWoodMaterial.map = this.woodMap;
      this.darkWoodMaterial.needsUpdate = true;

      oldWoodMap.dispose();
      oldWoodRough.dispose();
    }

    this.applyTrimMetal(spec.trimMetal);

    if (
      this.currentDecorationId !== normalizedDecor ||
      this.currentTableSkinId !== normalizedTable
    ) {
      this.currentTableSkinId = normalizedTable;
      this.currentDecorationId = normalizedDecor;
      this.rebuildDecorations(normalizedDecor, normalizedTable);
    }
  }

  public setQualityProfile(profile: GraphicsQualityProfile, rendererMaxAnisotropy: number) {
    const aniso = Math.min(rendererMaxAnisotropy, profile.maxAnisotropyCap);
    this.maxAnisotropy = aniso;

    this.feltMaterial.sheen = profile.feltSheen;
    this.feltMaterial.bumpScale = profile.feltBumpScale;
    this.feltMaterial.needsUpdate = true;

    this.cushionMaterial.bumpScale = profile.feltBumpScale * 0.85;
    this.cushionMaterial.needsUpdate = true;

    for (const tex of [
      this.feltTextures?.map,
      this.feltTextures?.bumpMap,
      this.woodMap,
      this.woodRoughMap,
    ]) {
      if (tex && tex.anisotropy !== aniso) {
        tex.anisotropy = aniso;
        tex.needsUpdate = true;
      }
    }
  }

  public getDiamondSightsMesh(): THREE.InstancedMesh | null {
    return this.diamondSightsMesh;
  }

  public dispose() {
    disposeObject3D(this.group);
    this.diamondSightsMesh = null;
  }
}
