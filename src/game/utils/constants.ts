import type { FeltTheme } from '../../store/useGameStore';

// Official 9-foot American Pool Table dimensions (in meters)
export const TABLE_DIMENSIONS = {
  playLength: 2.54, // 100 inches (X-axis: -1.27 to +1.27)
  playWidth: 1.27,  // 50 inches  (Z-axis: -0.635 to +0.635)
  halfLength: 1.27,
  halfWidth: 0.635,

  surfaceY: 0.78, // Slate cloth surface height above floor (y = 0)
  slateThickness: 0.045,

  cushionDepth: 0.048,
  cushionHeight: 0.0365, // Nose height above cloth
  railWidth: 0.135,
  railHeight: 0.046,
  apronHeight: 0.155,

  // Precision pocket placement & mouth openings (4.5" corner, 5.0" side)
  cornerPocketOffset: 0.018,
  sidePocketOffset: 0.028,
  cornerPocketRadius: 0.062,
  sidePocketRadius: 0.065,
  cornerMouthGap: 0.082, // Half-gap cut at corners along rail
  sideMouthGap: 0.072,   // Half-gap cut at side pockets along X

  // Spots
  headSpotX: -0.635, // -playLength / 4
  footSpotX: 0.635,  // +playLength / 4
} as const;

export const BALL_SPECS = {
  radius: 0.028575, // 2.25 inches diameter = 0.05715m
  mass: 0.17,       // 170g regulation phenolic resin ball
  restitution: 0.92,
  friction: 0.055,  // phenolic ball-to-ball friction
  linearDamping: 0.0,  // handled by physical sliding/rolling cloth drag
  angularDamping: 0.0, // handled by physical cloth & spin friction
  sleepThreshold: 0.011,
} as const;

export const CLOTH_PHYSICS = {
  slideMu: 0.21,          // kinetic sliding friction coefficient on worsted cloth
  rollMu: 0.014,          // rolling resistance coefficient
  spinDecayY: 12.5,       // vertical-axis (English) cloth pivot friction (rad/s^2)
  cushionRestitution: 0.84,
  cushionSpinThrow: 0.28, // tangential English rebound coupling factor
  maxTipOffsetRatio: 0.78,// max normalized cue tip offset before miscue limit
  gravity: 9.81,
} as const;

export const CUE_SPECS = {
  length: 1.47,       // 58 inches
  tipRadius: 0.0063,  // 12.6mm tip
  buttRadius: 0.0155, // 31mm butt
  baseElevationRad: 0.055, // ~3.15 degrees natural stroke angle
  idleStandoff: 0.026,     // Tip gap behind cue ball surface at idle
  maxPullback: 0.28,       // Max cue pullback in meters at 100% power
} as const;

export const DRAG_SHOOT_CONFIG = {
  maxDragPx: 140,
  minDragPx: 7,
  powerExponent: 1.25,
  minSpeed: 0.65, // m/s gentle tap
  maxSpeed: 9.4,  // m/s full break shot
} as const;

export interface BallDefinition {
  number: number;
  name: string;
  color: string;
  isStripe: boolean;
}

// Accurate American Billiards / Aramith Pro-Cup color palette
export const BALL_DEFINITIONS: BallDefinition[] = [
  { number: 0, name: 'Cue Ball', color: '#f5f2e8', isStripe: false },
  { number: 1, name: '1 Solid Yellow', color: '#eab308', isStripe: false },
  { number: 2, name: '2 Solid Blue', color: '#1d4ed8', isStripe: false },
  { number: 3, name: '3 Solid Red', color: '#dc2626', isStripe: false },
  { number: 4, name: '4 Solid Purple', color: '#6d28d9', isStripe: false },
  { number: 5, name: '5 Solid Orange', color: '#ea580c', isStripe: false },
  { number: 6, name: '6 Solid Green', color: '#15803d', isStripe: false },
  { number: 7, name: '7 Solid Maroon', color: '#881337', isStripe: false },
  { number: 8, name: '8 Black', color: '#14151a', isStripe: false },
  { number: 9, name: '9 Stripe Yellow', color: '#eab308', isStripe: true },
  { number: 10, name: '10 Stripe Blue', color: '#1d4ed8', isStripe: true },
  { number: 11, name: '11 Stripe Red', color: '#dc2626', isStripe: true },
  { number: 12, name: '12 Stripe Purple', color: '#6d28d9', isStripe: true },
  { number: 13, name: '13 Stripe Orange', color: '#ea580c', isStripe: true },
  { number: 14, name: '14 Stripe Green', color: '#15803d', isStripe: true },
  { number: 15, name: '15 Stripe Maroon', color: '#881337', isStripe: true },
];

// Official 8-ball triangular rack layout (1 at apex, 8 in center of row 3, solid/stripe on back corners)
export const RACK_ORDER: number[] = [
  1,
  9, 2,
  10, 8, 3,
  4, 11, 5, 12,
  13, 6, 14, 15, 7,
];

export const FELT_PALETTES: Record<
  FeltTheme,
  { base: string; highlight: string; shadow: string; label: string }
> = {
  tournamentGreen: {
    base: '#0f5c3a',
    highlight: '#167449',
    shadow: '#093e26',
    label: 'Tournament Green',
  },
  championshipBlue: {
    base: '#124e78',
    highlight: '#1a659a',
    shadow: '#0a3351',
    label: 'Championship Blue',
  },
  burgundyClub: {
    base: '#681827',
    highlight: '#842033',
    shadow: '#470f19',
    label: 'Burgundy Club',
  },
};

export interface PocketPosition {
  id: string;
  x: number;
  z: number;
  radius: number;
  isCorner: boolean;
}

export const POCKET_POSITIONS: PocketPosition[] = [
  {
    id: 'corner-tl',
    x: -TABLE_DIMENSIONS.halfLength - TABLE_DIMENSIONS.cornerPocketOffset,
    z: -TABLE_DIMENSIONS.halfWidth - TABLE_DIMENSIONS.cornerPocketOffset,
    radius: TABLE_DIMENSIONS.cornerPocketRadius,
    isCorner: true,
  },
  {
    id: 'corner-tr',
    x: TABLE_DIMENSIONS.halfLength + TABLE_DIMENSIONS.cornerPocketOffset,
    z: -TABLE_DIMENSIONS.halfWidth - TABLE_DIMENSIONS.cornerPocketOffset,
    radius: TABLE_DIMENSIONS.cornerPocketRadius,
    isCorner: true,
  },
  {
    id: 'corner-bl',
    x: -TABLE_DIMENSIONS.halfLength - TABLE_DIMENSIONS.cornerPocketOffset,
    z: TABLE_DIMENSIONS.halfWidth + TABLE_DIMENSIONS.cornerPocketOffset,
    radius: TABLE_DIMENSIONS.cornerPocketRadius,
    isCorner: true,
  },
  {
    id: 'corner-br',
    x: TABLE_DIMENSIONS.halfLength + TABLE_DIMENSIONS.cornerPocketOffset,
    z: TABLE_DIMENSIONS.halfWidth + TABLE_DIMENSIONS.cornerPocketOffset,
    radius: TABLE_DIMENSIONS.cornerPocketRadius,
    isCorner: true,
  },
  {
    id: 'side-top',
    x: 0,
    z: -TABLE_DIMENSIONS.halfWidth - TABLE_DIMENSIONS.sidePocketOffset,
    radius: TABLE_DIMENSIONS.sidePocketRadius,
    isCorner: false,
  },
  {
    id: 'side-bottom',
    x: 0,
    z: TABLE_DIMENSIONS.halfWidth + TABLE_DIMENSIONS.sidePocketOffset,
    radius: TABLE_DIMENSIONS.sidePocketRadius,
    isCorner: false,
  },
];
