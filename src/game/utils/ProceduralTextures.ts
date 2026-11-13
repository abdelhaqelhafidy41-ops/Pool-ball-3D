import * as THREE from 'three';
import type { FeltTheme } from '../../store/useGameStore';
import { BALL_DEFINITIONS, FELT_PALETTES, type BallDefinition } from './constants';

export interface FeltTextureSet {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
}

export function createFeltTextures(
  theme: FeltTheme,
  maxAnisotropy: number,
): FeltTextureSet {
  const palette = FELT_PALETTES[theme];
  const width = 1024;
  const height = 512;

  // 1. Albedo Map
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = width;
  colorCanvas.height = height;
  const ctx = colorCanvas.getContext('2d')!;

  // Base radial studio light falloff across the cloth
  const grad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    40,
    width * 0.5,
    height * 0.5,
    width * 0.62,
  );
  grad.addColorStop(0, palette.highlight);
  grad.addColorStop(0.65, palette.base);
  grad.addColorStop(1, palette.shadow);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Fine worsted cloth fiber micro-grain
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      // Diagonal worsted twill pattern + deterministic subtle noise
      const twill = ((x + y * 2) % 4 === 0 ? 3 : -2);
      const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const noise = ((hash - Math.floor(hash)) - 0.5) * 9;
      const delta = twill + noise;
      data[idx] = Math.max(0, Math.min(255, data[idx] + delta));
      data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] + delta));
      data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] + delta));
    }
  }
  ctx.putImageData(imgData, 0, 0);

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

  // Tournament markings: Headstring (baulk line at x = 25% of playing surface)
  ctx.strokeStyle = 'rgba(240, 244, 238, 0.42)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(width * 0.25, 16);
  ctx.lineTo(width * 0.25, height - 16);
  ctx.stroke();

  // Head spot (x = 25%)
  ctx.fillStyle = 'rgba(240, 244, 238, 0.65)';
  ctx.beginPath();
  ctx.arc(width * 0.25, height * 0.5, 4.5, 0, Math.PI * 2);
  ctx.fill();

  // Center spot (x = 50%)
  ctx.beginPath();
  ctx.arc(width * 0.5, height * 0.5, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Foot spot (x = 75%) with black tournament sticker ring
  ctx.fillStyle = 'rgba(18, 22, 20, 0.72)';
  ctx.beginPath();
  ctx.arc(width * 0.75, height * 0.5, 7.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(240, 244, 238, 0.85)';
  ctx.beginPath();
  ctx.arc(width * 0.75, height * 0.5, 2.5, 0, Math.PI * 2);
  ctx.fill();

  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAnisotropy;
  map.needsUpdate = true;

  // 2. Bump Map (Linear space - NoColorSpace)
  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 512;
  bumpCanvas.height = 256;
  const bCtx = bumpCanvas.getContext('2d')!;
  const bImg = bCtx.createImageData(512, 256);
  const bData = bImg.data;
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 512; x++) {
      const idx = (y * 512 + x) * 4;
      const weave = ((x + y) % 2 === 0 ? 140 : 115);
      const hash = Math.sin(x * 19.13 + y * 91.7) * 43758.5453;
      const n = ((hash - Math.floor(hash)) - 0.5) * 30;
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

export function createWoodTextures(maxAnisotropy: number): {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#472515';
  ctx.fillRect(0, 0, size, size);

  // Rich American walnut wood grain streaks
  for (let y = 0; y < size; y++) {
    const wave = Math.sin(y * 0.045) * 14 + Math.cos(y * 0.018) * 22;
    const tone = Math.sin((y + wave) * 0.14);
    const r = Math.floor(72 + tone * 18);
    const g = Math.floor(38 + tone * 11);
    const b = Math.floor(22 + tone * 7);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, y, size, 1);
  }

  // Fine dark wood pores
  ctx.fillStyle = 'rgba(22, 10, 5, 0.24)';
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

  // Subtle roughness map in linear space
  const rCanvas = document.createElement('canvas');
  rCanvas.width = 256;
  rCanvas.height = 256;
  const rCtx = rCanvas.getContext('2d')!;
  rCtx.fillStyle = '#555555';
  rCtx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 2) {
    const v = 72 + Math.floor(Math.sin(y * 0.18) * 18);
    rCtx.fillStyle = `rgb(${v},${v},${v})`;
    rCtx.fillRect(0, y, 256, 2);
  }
  const roughnessMap = new THREE.CanvasTexture(rCanvas);
  roughnessMap.wrapS = THREE.RepeatWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.needsUpdate = true;

  return { map, roughnessMap };
}

export function createBallTexture(
  def: BallDefinition,
  maxAnisotropy: number,
): THREE.CanvasTexture {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const ivory = '#f5f1e3';

  if (def.number === 0) {
    // Pro-Cup style cue ball with subtle ivory base + 6 faint red dots for visible spin
    ctx.fillStyle = ivory;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#b91c1c';
    const dotRadius = 11;
    // 4 equatorial dots
    for (const uFrac of [0.125, 0.375, 0.625, 0.875]) {
      ctx.beginPath();
      ctx.arc(width * uFrac, height * 0.5, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
    // 2 polar dots (stretched horizontally in equirectangular projection)
    ctx.fillRect(0, 0, width, 16);
    ctx.fillRect(0, height - 16, width, 16);
  } else if (def.isStripe) {
    // Striped balls 9 - 15
    ctx.fillStyle = ivory;
    ctx.fillRect(0, 0, width, height);

    const bandHalfHeight = 112;
    ctx.fillStyle = def.color;
    ctx.fillRect(0, height * 0.5 - bandHalfHeight, width, bandHalfHeight * 2);

    // Subtle crisp trim lines along stripe border
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, height * 0.5 - bandHalfHeight, width, 2);
    ctx.fillRect(0, height * 0.5 + bandHalfHeight - 2, width, 2);

    drawBallMedallion(ctx, width * 0.25, height * 0.5, def.number);
    drawBallMedallion(ctx, width * 0.75, height * 0.5, def.number);
  } else {
    // Solid balls 1 - 8
    ctx.fillStyle = def.color;
    ctx.fillRect(0, 0, width, height);

    drawBallMedallion(ctx, width * 0.25, height * 0.5, def.number);
    drawBallMedallion(ctx, width * 0.75, height * 0.5, def.number);
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
) {
  const radius = 64;

  // Soft outer rim
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 3, 0, Math.PI * 2);
  ctx.fill();

  // Ivory white number circle
  ctx.fillStyle = '#f8f5eb';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // Crisp inner ring
  ctx.strokeStyle = 'rgba(20, 20, 24, 0.25)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 5, 0, Math.PI * 2);
  ctx.stroke();

  // Ball number
  ctx.fillStyle = '#111318';
  ctx.font = '800 66px "Inter", "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const yOffset = num === 6 || num === 9 ? -2 : 2;
  ctx.fillText(String(num), cx, cy + yOffset);

  // Underline for 6 and 9
  if (num === 6 || num === 9) {
    ctx.fillRect(cx - 20, cy + 32, 40, 5);
  }
}

export function createAllBallTextures(maxAnisotropy: number): THREE.CanvasTexture[] {
  return BALL_DEFINITIONS.map((def) => createBallTexture(def, maxAnisotropy));
}

export function createCueButtTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const width = 512;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Rich ebony base
  ctx.fillStyle = '#1b1412';
  ctx.fillRect(0, 0, width, height);

  // Maple & Rosewood decorative forearm splice points (V = 0..0.42)
  ctx.fillStyle = '#c89b62';
  for (let i = 0; i < 4; i++) {
    const cx = (i + 0.5) * (width / 4);
    ctx.beginPath();
    ctx.moveTo(cx - 44, 0);
    ctx.lineTo(cx, 190);
    ctx.lineTo(cx + 44, 0);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#6e2318';
    ctx.beginPath();
    ctx.moveTo(cx - 28, 0);
    ctx.lineTo(cx, 145);
    ctx.lineTo(cx + 28, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#c89b62';
  }

  // Gold/Brass accent ring
  ctx.fillStyle = '#d4af37';
  ctx.fillRect(0, 200, width, 12);

  // Black & silver Irish linen wrap grip (middle section)
  ctx.fillStyle = '#15171c';
  ctx.fillRect(0, 212, width, 195);
  for (let y = 214; y < 405; y += 3) {
    ctx.fillStyle = y % 6 === 0 ? 'rgba(220,220,225,0.14)' : 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, y, width, 1.5);
  }

  // Lower brass ring & ebony butt sleeve
  ctx.fillStyle = '#d4af37';
  ctx.fillRect(0, 407, width, 12);
  ctx.fillStyle = '#1f1613';
  ctx.fillRect(0, 419, width, 93);

  // Diamond mother-of-pearl inlays on butt sleeve
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

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
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

  // Subtle dark parquet planks
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
