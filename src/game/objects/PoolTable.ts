import * as THREE from 'three';
import type { FeltTheme } from '../../store/useGameStore';
import { POCKET_POSITIONS, TABLE_DIMENSIONS, type PocketPosition } from '../utils/constants';
import {
  createContactShadowTexture,
  createFeltTextures,
  createWoodTextures,
  type FeltTextureSet,
} from '../utils/ProceduralTextures';

export class PoolTable {
  public readonly group = new THREE.Group();
  private feltMaterial!: THREE.MeshStandardMaterial;
  private cushionMaterial!: THREE.MeshStandardMaterial;
  private feltTextures!: FeltTextureSet;
  private maxAnisotropy: number;

  constructor(initialTheme: FeltTheme, maxAnisotropy: number) {
    this.maxAnisotropy = maxAnisotropy;
    this.group.name = 'PoolTable';
    this.buildTable(initialTheme);
  }

  private buildTable(theme: FeltTheme) {
    const { map: woodMap, roughnessMap: woodRoughMap } = createWoodTextures(this.maxAnisotropy);
    this.feltTextures = createFeltTextures(theme, this.maxAnisotropy);

    // Materials
    this.feltMaterial = new THREE.MeshStandardMaterial({
      map: this.feltTextures.map,
      bumpMap: this.feltTextures.bumpMap,
      bumpScale: 0.0022,
      roughness: 0.88,
      metalness: 0.0,
    });

    this.cushionMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.getThemeColor(theme)),
      bumpMap: this.feltTextures.bumpMap,
      bumpScale: 0.0018,
      roughness: 0.86,
      metalness: 0.0,
    });

    const woodMaterial = new THREE.MeshPhysicalMaterial({
      map: woodMap,
      roughnessMap: woodRoughMap,
      roughness: 0.34,
      metalness: 0.04,
      clearcoat: 0.65,
      clearcoatRoughness: 0.18,
    });

    const darkWoodMaterial = new THREE.MeshStandardMaterial({
      map: woodMap,
      color: 0x8b6e5b,
      roughness: 0.45,
      metalness: 0.05,
    });

    const brassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xd9b35c,
      metalness: 0.92,
      roughness: 0.2,
      anisotropy: 0.75,
      clearcoat: 0.35,
      clearcoatRoughness: 0.12,
    });

    const leatherMaterial = new THREE.MeshStandardMaterial({
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

    const pearlMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xf4efe2,
      roughness: 0.18,
      metalness: 0.08,
      clearcoat: 0.85,
    });

    const slateUnderMaterial = new THREE.MeshStandardMaterial({
      color: 0x181c22,
      roughness: 0.7,
      metalness: 0.1,
    });

    // 1. Slate Bed & Felt Playing Surface with true 6 Pocket Cutouts
    this.buildPlayingSurface(slateUnderMaterial);

    // 2. Six Rubber Cushions (K-55 profile with mitered pocket jaws)
    this.buildCushions();

    // 3. Wooden Rails with precision Pocket Bays + Inlaid Diamond Sights
    this.buildRailsAndSights(woodMaterial, pearlMaterial);

    // 4. Redesigned Unified Six Pockets (Turned drop wells + flush leather throats + brass castings)
    this.buildPockets(brassMaterial, leatherMaterial, pocketWellMaterial);

    // 5. Cabinet Apron, Brass Trim & 4 Turned Lathe Legs
    this.buildCabinetAndLegs(darkWoodMaterial, brassMaterial);

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
    const outerHalfL = D.halfLength + D.cushionDepth + 0.024;
    const outerHalfW = D.halfWidth + D.cushionDepth + 0.024;

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

    const feltGeo = new THREE.ShapeGeometry(clothShape, 32);
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
      curveSegments: 28,
    });
    slateGeo.rotateX(-Math.PI / 2);
    const slateMesh = new THREE.Mesh(slateGeo, slateMaterial);
    slateMesh.position.y = D.surfaceY - D.slateThickness - 0.0006;
    slateMesh.receiveShadow = true;
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

    // Mother-of-Pearl Diamond Sights (18 sights inlaid flush on top of the rails)
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
    for (const frac of longFractions) {
      const sx = frac * D.playLength;
      for (const sz of [-longSightZ, longSightZ]) {
        const m = new THREE.Mesh(sightGeo, pearlMat);
        m.position.set(sx, sightY, sz);
        this.group.add(m);
      }
    }

    const shortFractions = [-1 / 4, 0, 1 / 4];
    for (const frac of shortFractions) {
      const sz = frac * D.playWidth;
      for (const sx of [-shortSightX, shortSightX]) {
        const m = new THREE.Mesh(sightGeo, pearlMat);
        m.position.set(sx, sightY, sz);
        m.rotation.y = Math.PI / 2;
        this.group.add(m);
      }
    }
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

    // 1. Continuous 360-degree turned drop-well cup & beveled slate-edge lip (below playing surface)
    // Lathe profile: bottom floor -> tapered drop wall -> flush beveled lip at cloth surface (y = 0)
    const wellPoints = [
      new THREE.Vector2(0.0, -wellDepth),
      new THREE.Vector2(rHole * 0.78, -wellDepth),
      new THREE.Vector2(rHole * 0.84, -wellDepth + 0.025),
      new THREE.Vector2(rHole * 0.99, -0.006),
      new THREE.Vector2(rHole * 1.045, 0.0005),
      new THREE.Vector2(rHole * 1.075, -0.003),
    ];
    const wellGeo = new THREE.LatheGeometry(wellPoints, 36);
    wellGeo.computeVertexNormals();
    const wellMesh = new THREE.Mesh(wellGeo, wellMat);
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
    const cabinetTopY = D.surfaceY - D.slateThickness;

    const apronGeo = new THREE.BoxGeometry(cabinetL, D.apronHeight, cabinetW);
    const apronMesh = new THREE.Mesh(apronGeo, woodMat);
    apronMesh.position.y = cabinetTopY - D.apronHeight * 0.5;
    apronMesh.castShadow = true;
    apronMesh.receiveShadow = true;
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

  private getThemeColor(theme: FeltTheme): number {
    switch (theme) {
      case 'championshipBlue':
        return 0x124e78;
      case 'burgundyClub':
        return 0x681827;
      case 'tournamentGreen':
      default:
        return 0x0f5c3a;
    }
  }

  public setFeltTheme(theme: FeltTheme) {
    const nextTextures = createFeltTextures(theme, this.maxAnisotropy);
    const oldMap = this.feltTextures.map;
    const oldBump = this.feltTextures.bumpMap;

    this.feltTextures = nextTextures;
    this.feltMaterial.map = nextTextures.map;
    this.feltMaterial.bumpMap = nextTextures.bumpMap;
    this.feltMaterial.needsUpdate = true;

    this.cushionMaterial.color.setHex(this.getThemeColor(theme));
    this.cushionMaterial.bumpMap = nextTextures.bumpMap;
    this.cushionMaterial.needsUpdate = true;

    oldMap.dispose();
    oldBump.dispose();
  }
}
