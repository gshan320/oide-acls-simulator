import { SHOCKABLE_RHYTHMS, type AclsRhythm } from "@/types/patient";
import type { ClinicalAction, EnergyBreakdown } from "@/types/signal";

/**
 * OIDE Clinical Decision Engine — pure functions.
 *
 * Kept out of the worker so the recommendation logic can be exercised directly
 * rather than only through a rendered monitor. Nothing here touches worker
 * state or the DOM.
 *
 * This is a custom OIDE calibration for training, NOT a published resuscitation
 * guideline. It is not a medical device.
 */

/** Base_Energy in E_opt = Base_Energy × Impedance_Correction × AMSA_Scaling_Factor. */
export const OIDE_BASE_ENERGY_J = 150;
/** Nominal adult transthoracic impedance; the denominator of Impedance_Correction. */
export const OIDE_NOMINAL_IMPEDANCE_OHMS = 75;

/** AMSA at or above which a shock is recommended, mV·Hz. */
export const AMSA_HIGH_THRESHOLD = 15.5;
/** AMSA below which a shock is deferred, mV·Hz. */
export const AMSA_LOW_THRESHOLD = 6.5;

/**
 * AMSA_Scaling_Factor calibration. Higher AMSA means a better-energised
 * myocardium, which defibrillates at lower delivered energy, so the multiplier
 * falls as AMSA rises. Anchored so that at nominal 75 Ω the shock-recommended
 * band spans the specified 110 J – 140 J:
 *
 *   AMSA ≤ 6.5   → 1.000 → 150 J
 *   AMSA = 15.5  → 0.933 → 140 J
 *   AMSA ≥ 25.0  → 0.733 → 110 J
 */
export const AMSA_SCALE_CEILING = 1;
export const AMSA_SCALE_AT_HIGH_THRESHOLD = 140 / OIDE_BASE_ENERGY_J;
export const AMSA_SCALE_FLOOR = 110 / OIDE_BASE_ENERGY_J;
/** AMSA at which the scaling factor bottoms out. */
export const AMSA_SCALE_SATURATION = 25;

/** Deliverable envelope of a biphasic defibrillator, joules. */
export const DELIVERABLE_MIN_J = 50;
export const DELIVERABLE_MAX_J = 360;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Monotonically decreasing multiplier over the calibration anchors above. */
export function amsaScalingFactor(amsa: number): number {
  if (!Number.isFinite(amsa) || amsa <= AMSA_LOW_THRESHOLD) {
    return AMSA_SCALE_CEILING;
  }

  if (amsa < AMSA_HIGH_THRESHOLD) {
    const t =
      (amsa - AMSA_LOW_THRESHOLD) / (AMSA_HIGH_THRESHOLD - AMSA_LOW_THRESHOLD);
    return (
      AMSA_SCALE_CEILING +
      t * (AMSA_SCALE_AT_HIGH_THRESHOLD - AMSA_SCALE_CEILING)
    );
  }

  const t = clamp01(
    (amsa - AMSA_HIGH_THRESHOLD) /
      (AMSA_SCALE_SATURATION - AMSA_HIGH_THRESHOLD),
  );
  return (
    AMSA_SCALE_AT_HIGH_THRESHOLD +
    t * (AMSA_SCALE_FLOOR - AMSA_SCALE_AT_HIGH_THRESHOLD)
  );
}

/**
 * Map AMSA onto a clinical action.
 *
 * Gated on rhythm first. AMSA quantifies myocardial energy state, which only
 * bears on the decision when defibrillation is on the table at all — advising a
 * shock for a perfusing or non-shockable rhythm would be actively harmful, so
 * the three AMSA tiers are only reachable for VF/pVT/torsades.
 */
export function clinicalActionFor(
  amsa: number,
  rhythm: AclsRhythm,
): ClinicalAction {
  if (!SHOCKABLE_RHYTHMS.has(rhythm)) {
    return {
      tier: "non-shockable",
      message: "NON-SHOCKABLE RHYTHM — AMSA ADVISORY ONLY, DO NOT DEFIBRILLATE",
      shockAdvised: false,
    };
  }

  if (amsa >= AMSA_HIGH_THRESHOLD) {
    return {
      tier: "high",
      message: "HIGH ROSC PROBABILITY — SHOCK RECOMMENDED",
      shockAdvised: true,
    };
  }

  if (amsa >= AMSA_LOW_THRESHOLD) {
    return {
      tier: "intermediate",
      message: "INTERMEDIATE ENERGY — PERFORM 2-MIN CPR TO BOOST PERFUSION",
      shockAdvised: false,
    };
  }

  return {
    tier: "low",
    message: "LOW MYOCARDIAL ENERGY — DEFER SHOCK (RISK OF MYOCARDIAL INJURY)",
    shockAdvised: false,
  };
}

/** E_opt = Base_Energy × Impedance_Correction × AMSA_Scaling_Factor. */
export function recommendEnergy(
  amsa: number,
  patientImpedanceOhms: number,
): { recommendedJoules: number; energy: EnergyBreakdown } {
  const impedanceCorrection =
    patientImpedanceOhms / OIDE_NOMINAL_IMPEDANCE_OHMS;
  const amsaScaling = amsaScalingFactor(amsa);
  const unclampedJoules =
    OIDE_BASE_ENERGY_J * impedanceCorrection * amsaScaling;

  const recommendedJoules = Math.round(
    Math.min(DELIVERABLE_MAX_J, Math.max(DELIVERABLE_MIN_J, unclampedJoules)),
  );

  return {
    recommendedJoules,
    energy: {
      baseEnergyJ: OIDE_BASE_ENERGY_J,
      patientImpedanceOhms,
      impedanceCorrection,
      amsaScalingFactor: amsaScaling,
      unclampedJoules,
    },
  };
}
