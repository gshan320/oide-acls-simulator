import { AMSA_HIGH_THRESHOLD, AMSA_LOW_THRESHOLD } from "./decisionEngine";

/**
 * Rhythm-conversion and injury modelling.
 *
 * Pure functions with an injectable RNG so shock resolution can be tested
 * deterministically. Custom OIDE calibration for training, not a published
 * resuscitation guideline.
 */

/** Base ROSC probability by AMSA band. */
export const ROSC_BASE_HIGH = 0.9;
export const ROSC_BASE_INTERMEDIATE = 0.45;
export const ROSC_BASE_LOW = 0.05;

/** Hands-off time is free up to this long. */
export const PAUSE_GRACE_MS = 5_000;
/** Absolute probability lost per second of pause beyond the grace period. */
export const PAUSE_PENALTY_PER_SECOND = 0.02;

/** Joules of excess energy → one unit of myocardial injury index. */
export const MII_JOULES_COEFFICIENT = 0.5;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Base ROSC probability from AMSA alone, before the pause penalty. */
export function baseRoscProbability(amsa: number): number {
  if (!Number.isFinite(amsa)) return ROSC_BASE_LOW;
  if (amsa >= AMSA_HIGH_THRESHOLD) return ROSC_BASE_HIGH;
  if (amsa >= AMSA_LOW_THRESHOLD) return ROSC_BASE_INTERMEDIATE;
  return ROSC_BASE_LOW;
}

/**
 * Absolute probability lost to hands-off time: 2% per second beyond 5 s.
 * Returns a positive number to subtract.
 */
export function pausePenalty(preShockPauseMs: number): number {
  if (!Number.isFinite(preShockPauseMs) || preShockPauseMs <= PAUSE_GRACE_MS) {
    return 0;
  }
  const excessSeconds = (preShockPauseMs - PAUSE_GRACE_MS) / 1000;
  return excessSeconds * PAUSE_PENALTY_PER_SECOND;
}

/** Final ROSC probability for a shock, clamped to [0, 1]. */
export function roscProbability(
  amsa: number,
  preShockPauseMs: number,
): number {
  return clamp01(baseRoscProbability(amsa) - pausePenalty(preShockPauseMs));
}

export interface ShockResolution {
  base: number;
  penalty: number;
  /** Post-penalty probability actually rolled against. */
  probability: number;
  /** The sampled value, retained so a run can be audited after the fact. */
  roll: number;
  success: boolean;
}

/**
 * Resolve one shock. `rng` must return [0, 1); inject a stub to make the
 * outcome deterministic in tests.
 */
export function resolveShock(
  amsa: number,
  preShockPauseMs: number,
  rng: () => number = Math.random,
): ShockResolution {
  const base = baseRoscProbability(amsa);
  const penalty = pausePenalty(preShockPauseMs);
  const probability = clamp01(base - penalty);
  const roll = rng();

  return { base, penalty, probability, roll, success: roll < probability };
}

/**
 * Myocardial injury index.
 *
 * MII = (delivered − OIDE optimal) × 0.5, floored at 0. A protocol that
 * delivers exactly the calibrated energy scores 0; a blanket 200 J dose
 * accumulates injury on every patient whose calibrated energy is lower —
 * which is most low-impedance and fine-VF patients.
 */
export function myocardialInjuryIndex(
  deliveredJoules: number,
  optimalJoules: number,
): number {
  const excess = deliveredJoules - optimalJoules;
  return excess <= 0 ? 0 : excess * MII_JOULES_COEFFICIENT;
}
