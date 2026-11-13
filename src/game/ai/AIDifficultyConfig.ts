import type { AiDifficulty, AiThinkingSpeed } from '../rules/types';

export interface AiDifficultyProfile {
  id: AiDifficulty;
  label: string;
  defaultName: string;
  tagline: string;
  // Execution accuracy (Gaussian std dev)
  aimJitterStdDevRad: number;
  powerJitterStdDev: number;
  spinErrorStdDev: number;
  // Search & simulation depth
  maxCandidatesToSimulate: number;
  maxSafetyCandidates: number;
  lookaheadDepth: 1 | 2;
  maxLookaheadFollowUps: number;
  stabilityCheckCount: number; // extra perturbed physics checks on top candidate (Pro/Legend)
  // Shot repertoire
  allowBankShots: boolean;
  allowComboShots: boolean;
  allowSafetyShots: boolean;
  allowSpin: boolean;
  allowSideEnglish: boolean;
  // Strategic weights
  positionWeight: number;
  safetyWeight: number;
  opponentThreatWeight: number;
  minAttackPotScore: number;
  // Timing (ms)
  analyzeDelayMs: number;
  aimingDurationMs: number;
  pullbackDurationMs: number;
}

export const AI_DIFFICULTY_PROFILES: Record<AiDifficulty, AiDifficultyProfile> = {
  beginner: {
    id: 'beginner',
    label: 'Beginner',
    defaultName: 'Rookie Sam',
    tagline: 'Basic shot selection · Natural misses · Minimal spin',
    aimJitterStdDevRad: 0.048, // ~2.75° std dev -> realistic misses on medium/long cuts
    powerJitterStdDev: 0.11,
    spinErrorStdDev: 0.12,
    maxCandidatesToSimulate: 6,
    maxSafetyCandidates: 1,
    lookaheadDepth: 1,
    maxLookaheadFollowUps: 0,
    stabilityCheckCount: 0,
    allowBankShots: false,
    allowComboShots: false,
    allowSafetyShots: false,
    allowSpin: false,
    allowSideEnglish: false,
    positionWeight: 0.15,
    safetyWeight: 0.1,
    opponentThreatWeight: 0.1,
    minAttackPotScore: -999, // always tries to pot something
    analyzeDelayMs: 520,
    aimingDurationMs: 420,
    pullbackDurationMs: 360,
  },
  intermediate: {
    id: 'intermediate',
    label: 'Intermediate',
    defaultName: 'Club Victor',
    tagline: 'Evaluates multiple shots · Basic position & spin · Occasional safeties',
    aimJitterStdDevRad: 0.021, // ~1.2° std dev
    powerJitterStdDev: 0.055,
    spinErrorStdDev: 0.07,
    maxCandidatesToSimulate: 12,
    maxSafetyCandidates: 3,
    lookaheadDepth: 1,
    maxLookaheadFollowUps: 0,
    stabilityCheckCount: 0,
    allowBankShots: true,
    allowComboShots: true,
    allowSafetyShots: true,
    allowSpin: true,
    allowSideEnglish: false,
    positionWeight: 0.55,
    safetyWeight: 0.45,
    opponentThreatWeight: 0.45,
    minAttackPotScore: 42,
    analyzeDelayMs: 650,
    aimingDurationMs: 480,
    pullbackDurationMs: 380,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    defaultName: 'Master Elena',
    tagline: 'Calculates cut & bank paths · Cue positioning · Tactical spin & safeties',
    aimJitterStdDevRad: 0.0085, // ~0.49° std dev
    powerJitterStdDev: 0.025,
    spinErrorStdDev: 0.035,
    maxCandidatesToSimulate: 20,
    maxSafetyCandidates: 5,
    lookaheadDepth: 2,
    maxLookaheadFollowUps: 2,
    stabilityCheckCount: 1,
    allowBankShots: true,
    allowComboShots: true,
    allowSafetyShots: true,
    allowSpin: true,
    allowSideEnglish: true,
    positionWeight: 0.95,
    safetyWeight: 0.85,
    opponentThreatWeight: 0.85,
    minAttackPotScore: 68,
    analyzeDelayMs: 740,
    aimingDurationMs: 520,
    pullbackDurationMs: 400,
  },
  legend: {
    id: 'legend',
    label: 'Legend',
    defaultName: 'Grandmaster Vega',
    tagline: 'Multi-shot lookahead · Bank & combo mastery · Precision English & safety play',
    aimJitterStdDevRad: 0.0028, // ~0.16° std dev — surgical accuracy
    powerJitterStdDev: 0.012,
    spinErrorStdDev: 0.015,
    maxCandidatesToSimulate: 28,
    maxSafetyCandidates: 6,
    lookaheadDepth: 2,
    maxLookaheadFollowUps: 3,
    stabilityCheckCount: 1,
    allowBankShots: true,
    allowComboShots: true,
    allowSafetyShots: true,
    allowSpin: true,
    allowSideEnglish: true,
    positionWeight: 1.3,
    safetyWeight: 1.15,
    opponentThreatWeight: 1.1,
    minAttackPotScore: 82,
    analyzeDelayMs: 820,
    aimingDurationMs: 560,
    pullbackDurationMs: 420,
  },
};

export function getAiDifficultyProfile(difficulty: AiDifficulty): AiDifficultyProfile {
  return AI_DIFFICULTY_PROFILES[difficulty] ?? AI_DIFFICULTY_PROFILES.intermediate;
}

export function getThinkingSpeedScale(speed: AiThinkingSpeed): number {
  switch (speed) {
    case 'fast':
      return 0.48;
    case 'realistic':
      return 1.45;
    case 'normal':
    default:
      return 1.0;
  }
}
