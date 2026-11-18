export type GraphicsQuality = 'low' | 'medium' | 'high';

export interface GraphicsQualityProfile {
  id: GraphicsQuality;
  label: string;
  description: string;
  dprCap: number;
  shadowsAllowed: boolean;
  shadowMapSize: number;
  ballWidthSegments: number;
  ballHeightSegments: number;
  maxAnisotropyCap: number;
  useRectAreaLight: boolean;
  envMapIntensityScale: number;
  maxVfxParticles: number;
  feltSheen: number;
  feltBumpScale: number;
}

export const GRAPHICS_QUALITY_PROFILES: Record<GraphicsQuality, GraphicsQualityProfile> = {
  low: {
    id: 'low',
    label: 'Low',
    description: 'Battery & mobile saver · 1x DPR, compact geometry & VFX',
    dprCap: 1.0,
    shadowsAllowed: false,
    shadowMapSize: 512,
    ballWidthSegments: 24,
    ballHeightSegments: 16,
    maxAnisotropyCap: 2,
    useRectAreaLight: false,
    envMapIntensityScale: 0.85,
    maxVfxParticles: 24,
    feltSheen: 0.0,
    feltBumpScale: 0.0014,
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    description: 'Balanced desktop & mobile · 1.5x DPR, 1024px shadows',
    dprCap: 1.5,
    shadowsAllowed: true,
    shadowMapSize: 1024,
    ballWidthSegments: 36,
    ballHeightSegments: 24,
    maxAnisotropyCap: 4,
    useRectAreaLight: false,
    envMapIntensityScale: 1.0,
    maxVfxParticles: 48,
    feltSheen: 0.3,
    feltBumpScale: 0.002,
  },
  high: {
    id: 'high',
    label: 'High',
    description: 'Studio showcase · Up to 2x DPR, 2048px shadows & full VFX',
    dprCap: 2.0,
    shadowsAllowed: true,
    shadowMapSize: 2048,
    ballWidthSegments: 48,
    ballHeightSegments: 32,
    maxAnisotropyCap: 8,
    useRectAreaLight: true,
    envMapIntensityScale: 1.12,
    maxVfxParticles: 72,
    feltSheen: 0.44,
    feltBumpScale: 0.0024,
  },
};

export interface HardwareCapabilityHints {
  isSoftwareGl?: boolean;
  deviceMemoryGb?: number | null;
  hardwareConcurrency?: number | null;
  isMobileViewport?: boolean;
  devicePixelRatio?: number;
}

export function detectRecommendedQuality(
  hints?: HardwareCapabilityHints,
): GraphicsQuality {
  const isSoftwareGl = hints?.isSoftwareGl ?? false;
  if (isSoftwareGl) return 'low';

  let deviceMemoryGb = hints?.deviceMemoryGb ?? null;
  let hardwareConcurrency = hints?.hardwareConcurrency ?? null;
  let isMobileViewport = hints?.isMobileViewport ?? false;

  if (typeof window !== 'undefined' && hints === undefined) {
    const nav = window.navigator as Navigator & { deviceMemory?: number };
    deviceMemoryGb =
      typeof nav.deviceMemory === 'number' && Number.isFinite(nav.deviceMemory)
        ? nav.deviceMemory
        : null;
    hardwareConcurrency =
      typeof nav.hardwareConcurrency === 'number' && Number.isFinite(nav.hardwareConcurrency)
        ? nav.hardwareConcurrency
        : null;
    const coarsePointer =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    isMobileViewport =
      coarsePointer || Math.min(window.innerWidth, window.innerHeight) < 768;
  }

  if (deviceMemoryGb !== null && deviceMemoryGb <= 2) {
    return 'low';
  }
  if (hardwareConcurrency !== null && hardwareConcurrency <= 2) {
    return 'low';
  }

  if (isMobileViewport) {
    if (
      (deviceMemoryGb !== null && deviceMemoryGb < 4) ||
      (hardwareConcurrency !== null && hardwareConcurrency <= 4)
    ) {
      return 'low';
    }
    return 'medium';
  }

  if (
    (deviceMemoryGb !== null && deviceMemoryGb >= 8) ||
    (hardwareConcurrency !== null && hardwareConcurrency >= 6)
  ) {
    return 'high';
  }

  if (deviceMemoryGb === null && hardwareConcurrency === null) {
    return 'high';
  }

  return 'medium';
}

export function sanitizeGraphicsQuality(value: unknown): GraphicsQuality | null {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return null;
}

export function getGraphicsProfile(quality: GraphicsQuality): GraphicsQualityProfile {
  return GRAPHICS_QUALITY_PROFILES[quality] ?? GRAPHICS_QUALITY_PROFILES.medium;
}
