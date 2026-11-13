import { BALL_SPECS, TABLE_DIMENSIONS } from '../utils/constants';

export interface BallRackCoordinate {
  number: number;
  x: number;
  y: number;
  z: number;
}

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Generates an official 8-ball triangular rack:
 * - Apex ball at foot spot (row 0)
 * - 8-ball in center of row 3 (index 4 in 0-based 15-ball rack)
 * - Back corners (indices 10 and 14) strictly one solid and one stripe
 * - Cue ball at head spot
 */
export function generateOfficialEightBallRack(): BallRackCoordinate[] {
  const y = TABLE_DIMENSIONS.surfaceY + BALL_SPECS.radius;
  const positions: BallRackCoordinate[] = [
    {
      number: 0,
      x: TABLE_DIMENSIONS.headSpotX,
      y,
      z: 0,
    },
  ];

  const solids = shuffleArray([2, 3, 4, 5, 6, 7]);
  const stripes = shuffleArray([9, 10, 11, 12, 13, 14, 15]);

  // Back corners must be one solid and one stripe
  const leftCornerIsSolid = Math.random() < 0.5;
  const cornerLeft = leftCornerIsSolid ? solids.pop()! : stripes.pop()!;
  const cornerRight = leftCornerIsSolid ? stripes.pop()! : solids.pop()!;

  const middlePool = shuffleArray([...solids, ...stripes]);
  const rackNumbers = new Array<number>(15);
  rackNumbers[0] = 1; // Apex
  rackNumbers[4] = 8; // Center of row 3
  rackNumbers[10] = cornerLeft;
  rackNumbers[14] = cornerRight;

  let poolIdx = 0;
  for (let i = 0; i < 15; i++) {
    if (rackNumbers[i] === undefined) {
      rackNumbers[i] = middlePool[poolIdx++];
    }
  }

  const spacing = BALL_SPECS.radius * 2.012;
  const rowStepX = spacing * Math.sqrt(3) * 0.5;
  let idx = 0;

  for (let row = 0; row < 5; row++) {
    const rowX = TABLE_DIMENSIONS.footSpotX + row * rowStepX;
    for (let col = 0; col <= row; col++) {
      const z = (col - row * 0.5) * spacing;
      positions.push({
        number: rackNumbers[idx++],
        x: rowX,
        y,
        z,
      });
    }
  }

  return positions;
}
