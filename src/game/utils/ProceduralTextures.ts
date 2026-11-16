import * as THREE from 'three';
import type { FeltTheme } from '../../store/useGameStore';
import { BALL_DEFINITIONS, FELT_PALETTES, type BallDefinition } from './constants';

export interface FeltTextureSet {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
}

export type TableWoodFinish = 'walnut' | 'walnut_dark' | 'ebony' | 'rosewood' | 'obsidian_neon';
export type TableTrimMetal = 'brass' | 'steel' | 'gold' | 'cyan_chrome';

export interface TableSkinVisualSpec {
  id: string;
  clothBase: string;
  clothHighlight: string;
  clothShadow: string;
  cushionHex: number;
  markingColor: string;
  spotColor: string;
  woodFinish: TableWoodFinish;
  trimMetal: TableTrimMetal;
}

const TABLE_SKIN_SPECS: Record<string, TableSkinVisualSpec> = {
  table_classic_green: {
    id: 'table_classic_green',
    clothBase: '#0f5c3a',
    clothHighlight: '#167449',
    clothShadow: '#093e26',
    cushionHex: 0x0f5c3a,
    markingColor: 'rgba(240, 244, 238, 0.42)',
    spotColor: 'rgba(240, 244, 238, 0.65)',
    woodFinish: 'walnut',
    trimMetal: 'brass',
  },
  table_blue_tournament: {
    id: 'table_blue_tournament',
    clothBase: '#124e78',
    clothHighlight: '#1a659a',
    clothShadow: '#0a3351',
    cushionHex: 0x124e78,
    markingColor: 'rgba(240, 244, 238, 0.45)',
    spotColor: 'rgba(240, 244, 238, 0.72)',
    woodFinish: 'walnut_dark',
    trimMetal: 'steel',
  },
  table_luxury_dark: {
    id: 'table_luxury_dark',
    clothBase: '#202832',
    clothHighlight: '#2c3745',
    clothShadow: '#13171d',
    cushionHex: 0x202832,
    markingColor: 'rgba(226, 184, 87, 0.46)',
    spotColor: 'rgba(226, 184, 87, 0.78)',
    woodFinish: 'ebony',
    trimMetal: 'gold',
  },
  table_royal_crimson: {
    id: 'table_royal_crimson',
    clothBase: '#681827',
    clothHighlight: '#842033',
    clothShadow: '#470f19',
    cushionHex: 0x681827,
    markingColor: 'rgba(247, 226, 182, 0.46)',
    spotColor: 'rgba(247, 226, 182, 0.74)',
    woodFinish: 'rosewood',
    trimMetal: 'gold',
  },
  table_royal_gold: {
    id: 'table_royal_gold',
    clothBase: '#1e1b15',
    clothHighlight: '#2b261c',
    clothShadow: '#12100c',
    cushionHex: 0x1e1b15,
    markingColor: 'rgba(251, 191, 36, 0.56)',
    spotColor: 'rgba(253, 224, 71, 0.85)',
    woodFinish: 'rosewood',
    trimMetal: 'gold',
  },
  table_neon_arena: {
    id: 'table_neon_arena',
    clothBase: '#0b1e28',
    clothHighlight: '#112f3d',
    clothShadow: '#061118',
    cushionHex: 0x0b1e28,
    markingColor: 'rgba(34, 211, 238, 0.62)',
    spotColor: 'rgba(103, 232, 249, 0.85)',
    woodFinish: 'obsidian_neon',
    trimMetal: 'cyan_chrome',
  },
};

export function getTableSkinVisualSpec(
  tableSkinId: string,
  fallbackTheme?: FeltTheme,
): TableSkinVisualSpec {
  if (tableSkinId !== 'table_classic_green' && TABLE_SKIN_SPECS[tableSkinId]) {
    return TABLE_SKIN_SPECS[tableSkinId];
  }
  if (fallbackTheme && fallbackTheme !== 'tournamentGreen') {
    const pal = FELT_PALETTES[fallbackTheme];
    return {
      id: 'table_classic_green',
      clothBase: pal.base,
      clothHighlight: pal.highlight,
      clothShadow: pal.shadow,
      cushionHex:
        fallbackTheme === 'championshipBlue'
          ? 0x124e78
          : fallbackTheme === 'burgundyClub'
            ? 0x681827
            : 0x0f5c3a,
      markingColor: 'rgba(240, 244, 238, 0.42)',
      spotColor: 'rgba(240, 244, 238, 0.65)',
      woodFinish: 'walnut',
      trimMetal: 'brass',
    };
  }
  return TABLE_SKIN_SPECS.table_classic_green;
}

function buildFeltTextureSetFromSpec(
  spec: TableSkinVisualSpec,
  maxAnisotropy: number,
): FeltTextureSet {
  const width = 1024;
  const height = 512;

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = width;
  colorCanvas.height = height;
  const ctx = colorCanvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    40,
    width * 0.5,
    height * 0.5,
    width * 0.62,
  );
  grad.addColorStop(0, spec.clothHighlight);
  grad.addColorStop(0.65, spec.clothBase);
  grad.addColorStop(1, spec.clothShadow);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Fine worsted cloth fiber micro-grain
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const twill = (x + y * 2) % 4 === 0 ? 3 : -2;
      const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const noise = (hash - Math.floor(hash) - 0.5) * 9;
      const delta = twill + noise;
      data[idx] = Math.max(0, Math.min(255, data[idx] + delta));
      data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] + delta));
      data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] + delta));
    }
  }
  ctx.putImageData(imgData, 0, 0);

  if (spec.id === 'table_neon_arena') {
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.14)';
    ctx.lineWidth = 2;
    ctx.strokeRect(18, 18, width - 36, height - 36);
  } else if (spec.id === 'table_royal_gold') {
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.24)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(18, 18, width - 36, height - 36);
  }

  // Subtle rail-edge cloth shadow
  const edgeGradTop = ctx.createLinearGradient(0, 0, 0, 26);
  edgeGradTop.addColorStop(0, 'rgba(0,0,0,0.28)');
  edgeGradTop.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = edgeGradTop;
  ctx.fillRect(0, 0, width, 26);

  const edgeGradBot = ctx.createLinearGradient(0, height - 26, 0, height);
  edgeGradBot.addColorStop(0, 'rgba(0,0,0,0)');
  edgeGradBot.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = edgeGradBot;
  ctx.fillRect(0, height - 26, width, 26);

  // Headstring
  ctx.strokeStyle = spec.markingColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(width * 0.25, 16);
  ctx.lineTo(width * 0.25, height - 16);
  ctx.stroke();

  // Head spot
  ctx.fillStyle = spec.spotColor;
  ctx.beginPath();
  ctx.arc(width * 0.25, height * 0.5, 4.5, 0, Math.PI * 2);
  ctx.fill();

  // Center spot
  ctx.beginPath();
  ctx.arc(width * 0.5, height * 0.5, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Foot spot
  ctx.fillStyle = 'rgba(18, 22, 20, 0.72)';
  ctx.beginPath();
  ctx.arc(width * 0.75, height * 0.5, 7.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = spec.spotColor;
  ctx.beginPath();
  ctx.arc(width * 0.75, height * 0.5, 2.5, 0, Math.PI * 2);
  ctx.fill();

  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAnisotropy;
  map.needsUpdate = true;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 512;
  bumpCanvas.height = 256;
  const bCtx = bumpCanvas.getContext('2d')!;
  const bImg = bCtx.createImageData(512, 256);
  const bData = bImg.data;
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 512; x++) {
      const idx = (y * 512 + x) * 4;
      const weave = (x + y) % 2 === 0 ? 140 : 115;
      const hash = Math.sin(x * 19.13 + y * 91.7) * 43758.5453;
      const n = (hash - Math.floor(hash) - 0.5) * 30;
      const val = Math.max(0, Math.min(255, weave + n));
      bData[idx] = val;
      bData[idx + 1] = val;
      bData[idx + 2] = val;
      bData[idx + 3] = 255;
    }
  }
  bCtx.putImageData(bImg, 0, 0);

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.repeat.set(6, 3);
  bumpMap.anisotropy = maxAnisotropy;
  bumpMap.needsUpdate = true;

  return { map, bumpMap };
}

export function createFeltTextures(
  theme: FeltTheme,
  maxAnisotropy: number,
): FeltTextureSet {
  const spec = getTableSkinVisualSpec('table_classic_green', theme);
  return buildFeltTextureSetFromSpec(spec, maxAnisotropy);
}

export function createFeltTexturesByTableSkin(
  tableSkinId: string,
  maxAnisotropy: number,
  fallbackTheme?: FeltTheme,
): FeltTextureSet {
  const spec = getTableSkinVisualSpec(tableSkinId, fallbackTheme);
  return buildFeltTextureSetFromSpec(spec, maxAnisotropy);
}

export function createWoodTextures(
  maxAnisotropy: number,
  finish: TableWoodFinish = 'walnut',
): {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const palette =
    finish === 'obsidian_neon'
      ? { base: '#0c1016', r: 16, g: 20, b: 28, amp: 5, pore: 'rgba(6, 10, 15, 0.35)' }
      : finish === 'ebony'
        ? { base: '#15171c', r: 24, g: 26, b: 32, amp: 7, pore: 'rgba(5, 6, 8, 0.35)' }
        : finish === 'rosewood'
          ? { base: '#341318', r: 58, g: 21, b: 26, amp: 14, pore: 'rgba(18, 5, 8, 0.28)' }
          : finish === 'walnut_dark'
            ? { base: '#361f14', r: 58, g: 34, b: 22, amp: 14, pore: 'rgba(16, 8, 4, 0.28)' }
            : { base: '#472515', r: 72, g: 38, b: 22, amp: 18, pore: 'rgba(22, 10, 5, 0.24)' };

  ctx.fillStyle = palette.base;
  ctx.fillRect(0, 0, size, size);

  for (let y = 0; y < size; y++) {
    const wave = Math.sin(y * 0.045) * 14 + Math.cos(y * 0.018) * 22;
    const tone = Math.sin((y + wave) * 0.14);
    const r = Math.max(0, Math.min(255, Math.floor(palette.r + tone * palette.amp)));
    const g = Math.max(0, Math.min(255, Math.floor(palette.g + tone * palette.amp * 0.65)));
    const b = Math.max(0, Math.min(255, Math.floor(palette.b + tone * palette.amp * 0.45)));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, y, size, 1);
  }

  ctx.fillStyle = palette.pore;
  for (let i = 0; i < 420; i++) {
    const x = (Math.sin(i * 78.233) * 0.5 + 0.5) * size;
    const y = (Math.cos(i * 45.164) * 0.5 + 0.5) * size;
    const w = 18 + (i % 55);
    ctx.fillRect(x, y, w, 1.2);
  }

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = maxAnisotropy;
  map.needsUpdate = true;

  const rCanvas = document.createElement('canvas');
  rCanvas.width = 256;
  rCanvas.height = 256;
  const rCtx = rCanvas.getContext('2d')!;
  rCtx.fillStyle = finish === 'obsidian_neon' ? '#6a6a6a' : '#555555';
  rCtx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 2) {
    const v = (finish === 'obsidian_neon' ? 96 : 72) + Math.floor(Math.sin(y * 0.18) * 18);
    rCtx.fillStyle = `rgb(${v},${v},${v})`;
    rCtx.fillRect(0, y, 256, 2);
  }
  const roughnessMap = new THREE.CanvasTexture(rCanvas);
  roughnessMap.wrapS = THREE.RepeatWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.needsUpdate = true;

  return { map, roughnessMap };
}

function drawMarbleVeins(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  baseHex: string,
  veinColorA: string,
  veinColorB: string,
  seed: number,
) {
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 22; i++) {
    ctx.beginPath();
    const yStart = ((Math.sin(seed * 13.7 + i * 2.13) * 0.5 + 0.5) * height) | 0;
    ctx.moveTo(0, yStart);
    for (let x = 0; x <= width; x += 24) {
      const wave =
        Math.sin(x * 0.014 + i * 1.3 + seed) * 44 +
        Math.cos(x * 0.031 - i * 0.9 + seed * 0.7) * 20;
      ctx.lineTo(x, (yStart + wave + height) % height);
    }
    ctx.strokeStyle = i % 2 === 0 ? veinColorA : veinColorB;
    ctx.lineWidth = 1.5 + ((i * 7 + seed) % 5);
    ctx.stroke();
  }
}

export function createBallTexture(
  def: BallDefinition,
  maxAnisotropy: number,
  ballSkinId = 'ball_classic',
): THREE.CanvasTexture {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const ivory = '#f5f1e3';
  const isNeon = ballSkinId === 'ball_neon_pulse';
  const isMarble = ballSkinId === 'ball_artisan_marble';
  const isMetallic = ballSkinId === 'ball_brushed_metallic';
  const isGolden = ballSkinId === 'ball_golden';
  const isCrystal = ballSkinId === 'ball_crystal';
  const isAurora = ballSkinId === 'ball_aurora_chroma';

  if (def.number === 0) {
    if (isNeon) {
      ctx.fillStyle = '#0e1726';
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 5;
      ctx.strokeRect(0, height * 0.5 - 6, width, 12);
      ctx.fillStyle = '#22d3ee';
      for (const uFrac of [0.125, 0.375, 0.625, 0.875]) {
        ctx.beginPath();
        ctx.arc(width * uFrac, height * 0.5, 13, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (isGolden) {
      const goldGrad = ctx.createLinearGradient(0, 0, width, height);
      goldGrad.addColorStop(0, '#fef3c7');
      goldGrad.addColorStop(0.5, '#f6c85f');
      goldGrad.addColorStop(1, '#d97706');
      ctx.fillStyle = goldGrad;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#78350f';
      for (const uFrac of [0.125, 0.375, 0.625, 0.875]) {
        ctx.beginPath();
        ctx.arc(width * uFrac, height * 0.5, 11, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillRect(0, 0, width, 12);
      ctx.fillRect(0, height - 12, width, 12);
    } else if (isCrystal) {
      const crysGrad = ctx.createLinearGradient(0, 0, width, height);
      crysGrad.addColorStop(0, '#f0f9ff');
      crysGrad.addColorStop(0.5, '#bae6fd');
      crysGrad.addColorStop(1, '#e0f2fe');
      ctx.fillStyle = crysGrad;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(2, 132, 199, 0.32)';
      ctx.lineWidth = 2;
      for (let i = -2; i <= 10; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 120, 0);
        ctx.lineTo(i * 120 + 220, height);
        ctx.stroke();
      }
      ctx.fillStyle = '#0284c7';
      for (const uFrac of [0.125, 0.375, 0.625, 0.875]) {
        ctx.beginPath();
        ctx.arc(width * uFrac, height * 0.5, 11, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (isMarble) {
      drawMarbleVeins(
        ctx,
        width,
        height,
        '#ece7db',
        'rgba(68, 64, 60, 0.25)',
        'rgba(212, 168, 79, 0.3)',
        99,
      );
      ctx.fillStyle = '#b91c1c';
      for (const uFrac of [0.125, 0.375, 0.625, 0.875]) {
        ctx.beginPath();
        ctx.arc(width * uFrac, height * 0.5, 11, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillRect(0, 0, width, 14);
      ctx.fillRect(0, height - 14, width, 14);
    } else if (isAurora) {
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, '#eef2ff');
      grad.addColorStop(0.5, '#d1fae5');
      grad.addColorStop(1, '#fce7f3');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#7c3aed';
      for (const uFrac of [0.125, 0.375, 0.625, 0.875]) {
        ctx.beginPath();
        ctx.arc(width * uFrac, height * 0.5, 11, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = isMetallic ? '#e2e8f0' : ivory;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#b91c1c';
      for (const uFrac of [0.125, 0.375, 0.625, 0.875]) {
        ctx.beginPath();
        ctx.arc(width * uFrac, height * 0.5, 11, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillRect(0, 0, width, 16);
      ctx.fillRect(0, height - 16, width, 16);
    }
  } else {
    // Object balls 1..15
    const baseFill = isNeon
      ? '#0a0f1a'
      : isGolden
        ? '#f3cf72'
        : isCrystal
          ? '#e0f2fe'
          : isMetallic
            ? '#d8e0ea'
            : ivory;
    ctx.fillStyle = baseFill;
    ctx.fillRect(0, 0, width, height);

    if (def.isStripe) {
      if (isMarble) {
        drawMarbleVeins(
          ctx,
          width,
          height,
          '#e8e2d5',
          'rgba(25, 28, 34, 0.34)',
          'rgba(212, 168, 79, 0.24)',
          def.number,
        );
      }
      const bandHalfHeight = 112;
      ctx.fillStyle = def.color;
      ctx.fillRect(0, height * 0.5 - bandHalfHeight, width, bandHalfHeight * 2);

      if (isMarble) {
        drawMarbleVeins(
          ctx,
          width,
          bandHalfHeight * 2,
          def.color,
          'rgba(12, 14, 18, 0.44)',
          'rgba(248, 244, 232, 0.22)',
          def.number + 31,
        );
        // Re-clip marble onto stripe region cleanly
        ctx.fillStyle = '#e8e2d5';
        ctx.fillRect(0, 0, width, height * 0.5 - bandHalfHeight);
        ctx.fillRect(0, height * 0.5 + bandHalfHeight, width, height);
      } else if (isNeon) {
        ctx.fillStyle = '#090e18';
        ctx.fillRect(0, height * 0.5 - bandHalfHeight + 10, width, bandHalfHeight * 2 - 20);
        ctx.fillStyle = def.color;
        ctx.fillRect(0, height * 0.5 - bandHalfHeight, width, 8);
        ctx.fillRect(0, height * 0.5 + bandHalfHeight - 8, width, 8);
      } else if (isGolden) {
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(0, height * 0.5 - bandHalfHeight, width, 10);
        ctx.fillRect(0, height * 0.5 + bandHalfHeight - 10, width, 10);
      } else if (isCrystal) {
        const sg = ctx.createLinearGradient(0, height * 0.5 - bandHalfHeight, width, height * 0.5 + bandHalfHeight);
        sg.addColorStop(0, def.color);
        sg.addColorStop(0.5, '#7dd3fc');
        sg.addColorStop(1, def.color);
        ctx.fillStyle = sg;
        ctx.fillRect(0, height * 0.5 - bandHalfHeight, width, bandHalfHeight * 2);
      } else if (isAurora) {
        const g = ctx.createLinearGradient(0, height * 0.5 - bandHalfHeight, width, height * 0.5 + bandHalfHeight);
        g.addColorStop(0, def.color);
        g.addColorStop(0.5, '#38bdf8');
        g.addColorStop(1, '#c084fc');
        ctx.fillStyle = g;
        ctx.fillRect(0, height * 0.5 - bandHalfHeight, width, bandHalfHeight * 2);
      }

      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(0, height * 0.5 - bandHalfHeight, width, 2);
      ctx.fillRect(0, height * 0.5 + bandHalfHeight - 2, width, 2);
    } else {
      // Solid balls 1..8
      if (isMarble) {
        drawMarbleVeins(
          ctx,
          width,
          height,
          def.color,
          'rgba(14, 15, 18, 0.42)',
          'rgba(248, 245, 235, 0.24)',
          def.number,
        );
      } else if (isNeon) {
        ctx.fillStyle = '#090d16';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = def.color;
        ctx.fillRect(0, height * 0.5 - 12, width, 24);
      } else if (isGolden) {
        const sg = ctx.createLinearGradient(0, 0, width, height);
        if (def.number === 8) {
          sg.addColorStop(0, '#1c1710');
          sg.addColorStop(0.5, '#2b2112');
          sg.addColorStop(1, '#14100b');
        } else {
          sg.addColorStop(0, def.color);
          sg.addColorStop(0.5, '#f6c85f');
          sg.addColorStop(1, def.color);
        }
        ctx.fillStyle = sg;
        ctx.fillRect(0, 0, width, height);
      } else if (isCrystal) {
        const cg = ctx.createLinearGradient(0, 0, width, height);
        cg.addColorStop(0, def.color);
        cg.addColorStop(0.5, def.number === 8 ? '#0f172a' : '#bae6fd');
        cg.addColorStop(1, def.color);
        ctx.fillStyle = cg;
        ctx.fillRect(0, 0, width, height);
      } else if (isAurora) {
        const g = ctx.createLinearGradient(0, 0, width, height);
        g.addColorStop(0, def.color);
        g.addColorStop(0.55, def.number === 8 ? '#312e81' : '#34d399');
        g.addColorStop(1, '#f472b6');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      } else {
        ctx.fillStyle = def.color;
        ctx.fillRect(0, 0, width, height);
      }
    }

    if (isMetallic) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      for (let y = 0; y < height; y += 3) {
        ctx.fillRect(0, y, width, 1);
      }
    } else if (isCrystal) {
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 2;
      for (let i = -2; i <= 10; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 110, 0);
        ctx.lineTo(i * 110 + 180, height);
        ctx.stroke();
      }
    }

    drawBallMedallion(ctx, width * 0.25, height * 0.5, def.number, {
      isNeon,
      isMarble,
      isGolden,
      isCrystal,
      accentColor: def.color,
    });
    drawBallMedallion(ctx, width * 0.75, height * 0.5, def.number, {
      isNeon,
      isMarble,
      isGolden,
      isCrystal,
      accentColor: def.color,
    });
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

function drawBallMedallion(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  num: number,
  style: {
    isNeon: boolean;
    isMarble: boolean;
    isGolden: boolean;
    isCrystal: boolean;
    accentColor: string;
  },
) {
  const radius = 64;

  ctx.fillStyle = style.isNeon
    ? style.accentColor
    : style.isCrystal
      ? '#7dd3fc'
      : style.isGolden || style.isMarble
        ? '#d4a84f'
        : 'rgba(0, 0, 0, 0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = style.isNeon ? '#0a0f1a' : style.isGolden ? '#fffbeb' : style.isCrystal ? '#f0f9ff' : '#f8f5eb';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = style.isNeon
    ? style.accentColor
    : style.isGolden
      ? '#b45309'
      : style.isCrystal
        ? '#0284c7'
        : 'rgba(20, 20, 24, 0.28)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = style.isNeon ? '#f8fafc' : style.isCrystal ? '#0c4a6e' : '#111318';
  ctx.font = '800 66px "Inter", "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const yOffset = num === 6 || num === 9 ? -2 : 2;
  ctx.fillText(String(num), cx, cy + yOffset);

  if (num === 6 || num === 9) {
    ctx.fillRect(cx - 20, cy + 32, 40, 5);
  }
}

export function createAllBallTextures(
  maxAnisotropy: number,
  ballSkinId = 'ball_classic',
): THREE.CanvasTexture[] {
  return BALL_DEFINITIONS.map((def) => createBallTexture(def, maxAnisotropy, ballSkinId));
}

export function createCueButtTexture(
  maxAnisotropy: number,
  cueSkinId = 'cue_classic_maple',
): THREE.CanvasTexture {
  const width = 512;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  if (cueSkinId === 'cue_carbon_stealth') {
    ctx.fillStyle = '#11151b';
    ctx.fillRect(0, 0, width, height);
    for (let y = 0; y < height; y += 8) {
      for (let x = 0; x < width; x += 8) {
        ctx.fillStyle = (x + y) % 16 === 0 ? '#1d242e' : '#0b0e12';
        ctx.fillRect(x, y, 7, 7);
      }
    }
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(0, 198, width, 10);
    ctx.fillRect(0, 410, width, 10);
    ctx.fillStyle = '#090c10';
    ctx.fillRect(0, 212, width, 194);
  } else if (cueSkinId === 'cue_gold_imperial') {
    ctx.fillStyle = '#120f0b';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#f59e0b';
    for (let i = 0; i < 4; i++) {
      const cx = (i + 0.5) * (width / 4);
      ctx.beginPath();
      ctx.moveTo(cx - 42, 0);
      ctx.lineTo(cx, 188);
      ctx.lineTo(cx + 42, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#fde68a';
    ctx.fillRect(0, 198, width, 14);
    ctx.fillStyle = '#171411';
    ctx.fillRect(0, 212, width, 196);
    for (let y = 216; y < 404; y += 6) {
      ctx.fillStyle = 'rgba(245,158,11,0.16)';
      ctx.fillRect(0, y, width, 2);
    }
    ctx.fillStyle = '#fde68a';
    ctx.fillRect(0, 408, width, 14);
  } else if (cueSkinId === 'cue_platinum_apex') {
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, '#94a3b8');
    grad.addColorStop(0.5, '#e2e8f0');
    grad.addColorStop(1, '#64748b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, 200);
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 200, width, 210);
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(0, 198, width, 10);
    ctx.fillRect(0, 408, width, 10);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 418, width, 94);
  } else if (cueSkinId === 'cue_neon_cosmic') {
    ctx.fillStyle = '#090b14';
    ctx.fillRect(0, 0, width, height);
    const neb = ctx.createLinearGradient(0, 0, width, 200);
    neb.addColorStop(0, '#ec4899');
    neb.addColorStop(0.5, '#6366f1');
    neb.addColorStop(1, '#22d3ee');
    ctx.fillStyle = neb;
    for (let i = 0; i < 6; i++) {
      const cx = (i + 0.5) * (width / 6);
      ctx.beginPath();
      ctx.moveTo(cx - 28, 0);
      ctx.lineTo(cx, 192);
      ctx.lineTo(cx + 28, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#22d3ee';
    ctx.fillRect(0, 196, width, 10);
    ctx.fillStyle = '#0c101d';
    ctx.fillRect(0, 206, width, 202);
    ctx.fillStyle = '#ec4899';
    ctx.fillRect(0, 408, width, 10);
    ctx.fillStyle = neb;
    ctx.fillRect(0, 424, width, 88);
    ctx.fillStyle = 'rgba(10, 12, 22, 0.55)';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(i * 128 + 18, 434, 92, 68);
    }
  } else if (cueSkinId === 'cue_dragon_sovereign') {
    ctx.fillStyle = '#22080c';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#dc2626';
    for (let i = 0; i < 4; i++) {
      const cx = (i + 0.5) * (width / 4);
      ctx.beginPath();
      ctx.moveTo(cx - 46, 0);
      ctx.lineTo(cx, 194);
      ctx.lineTo(cx + 46, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(0, 198, width, 14);
    ctx.fillStyle = '#14080a';
    ctx.fillRect(0, 212, width, 196);
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(0, 408, width, 14);
    ctx.fillStyle = '#7f1d1d';
    ctx.fillRect(0, 422, width, 90);
    ctx.fillStyle = '#fbbf24';
    for (let i = 0; i < 4; i++) {
      const cx = (i + 0.5) * (width / 4);
      ctx.beginPath();
      ctx.moveTo(cx, 436);
      ctx.lineTo(cx + 16, 466);
      ctx.lineTo(cx, 496);
      ctx.lineTo(cx - 16, 466);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    // Classic Maple or Walnut Heritage
    const isWalnut = cueSkinId === 'cue_walnut_heritage';
    ctx.fillStyle = isWalnut ? '#2b160d' : '#1b1412';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = isWalnut ? '#b57b4c' : '#c89b62';
    for (let i = 0; i < 4; i++) {
      const cx = (i + 0.5) * (width / 4);
      ctx.beginPath();
      ctx.moveTo(cx - 44, 0);
      ctx.lineTo(cx, 190);
      ctx.lineTo(cx + 44, 0);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = isWalnut ? '#5b2a18' : '#6e2318';
      ctx.beginPath();
      ctx.moveTo(cx - 28, 0);
      ctx.lineTo(cx, 145);
      ctx.lineTo(cx + 28, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = isWalnut ? '#b57b4c' : '#c89b62';
    }

    ctx.fillStyle = '#d4af37';
    ctx.fillRect(0, 200, width, 12);

    ctx.fillStyle = isWalnut ? '#23140e' : '#15171c';
    ctx.fillRect(0, 212, width, 195);
    for (let y = 214; y < 405; y += 3) {
      ctx.fillStyle = y % 6 === 0 ? 'rgba(220,220,225,0.14)' : 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, y, width, 1.5);
    }

    ctx.fillStyle = '#d4af37';
    ctx.fillRect(0, 407, width, 12);
    ctx.fillStyle = isWalnut ? '#311a10' : '#1f1613';
    ctx.fillRect(0, 419, width, 93);

    ctx.fillStyle = '#ebe6d8';
    for (let i = 0; i < 4; i++) {
      const cx = (i + 0.5) * (width / 4);
      ctx.beginPath();
      ctx.moveTo(cx, 438);
      ctx.lineTo(cx + 14, 464);
      ctx.lineTo(cx, 490);
      ctx.lineTo(cx - 14, 464);
      ctx.closePath();
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

export function createCueShaftTexture(
  maxAnisotropy: number,
  cueSkinId: string,
): THREE.CanvasTexture | null {
  if (cueSkinId !== 'cue_carbon_stealth' && cueSkinId !== 'cue_neon_cosmic') {
    return null;
  }
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  if (cueSkinId === 'cue_carbon_stealth') {
    ctx.fillStyle = '#181e26';
    ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 8) {
      for (let x = 0; x < size; x += 8) {
        ctx.fillStyle = (x + y) % 16 === 0 ? '#242c37' : '#10141a';
        ctx.fillRect(x, y, 6, 6);
      }
    }
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#1e1b4b');
    grad.addColorStop(0.5, '#701a75');
    grad.addColorStop(1, '#0e7490');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(34, 211, 238, 0.35)';
    for (let i = 0; i < 18; i++) {
      const x = (i * 47) % size;
      const y = (i * 73) % size;
      ctx.beginPath();
      ctx.arc(x, y, 4 + (i % 5), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

export function createStudioFloorTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#12151b';
  ctx.fillRect(0, 0, size, size);

  const plankH = 64;
  const plankW = 256;
  for (let row = 0; row < size / plankH; row++) {
    const offset = (row % 2) * (plankW / 2);
    for (let col = -1; col <= size / plankW; col++) {
      const shade = 16 + ((row * 7 + col * 13) % 7);
      ctx.fillStyle = `rgb(${shade}, ${shade + 2}, ${shade + 6})`;
      ctx.fillRect(col * plankW + offset + 1, row * plankH + 1, plankW - 2, plankH - 2);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

export function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(
    size * 0.5,
    size * 0.5,
    12,
    size * 0.5,
    size * 0.5,
    size * 0.5,
  );
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.72)');
  grad.addColorStop(0.65, 'rgba(0, 0, 0, 0.34)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
