import { describe, expect, it } from "vitest";
import type { AclsRhythm } from "@/types/patient";
import {
  AMSA_HIGH_THRESHOLD,
  AMSA_LOW_THRESHOLD,
  AMSA_SCALE_SATURATION,
  DELIVERABLE_MAX_J,
  DELIVERABLE_MIN_J,
  amsaScalingFactor,
  clinicalActionFor,
  recommendEnergy,
} from "./decisionEngine";

const NOMINAL_OHMS = 75;
const joulesAt = (amsa: number, ohms = NOMINAL_OHMS) =>
  recommendEnergy(amsa, ohms).recommendedJoules;

describe("amsaScalingFactor", () => {
  it("holds at the ceiling up to the low threshold", () => {
    for (const amsa of [0, 1, 3.3, AMSA_LOW_THRESHOLD]) {
      expect(amsaScalingFactor(amsa)).toBe(1);
    }
  });

  it("hits the calibration anchors", () => {
    expect(amsaScalingFactor(AMSA_HIGH_THRESHOLD)).toBeCloseTo(140 / 150, 6);
    expect(amsaScalingFactor(AMSA_SCALE_SATURATION)).toBeCloseTo(110 / 150, 6);
  });

  it("saturates above the saturation point", () => {
    const floor = amsaScalingFactor(AMSA_SCALE_SATURATION);
    for (const amsa of [30, 60, 1000]) {
      expect(amsaScalingFactor(amsa)).toBeCloseTo(floor, 10);
    }
  });

  it("decreases monotonically across the whole range", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let amsa = 0; amsa <= 50; amsa += 0.05) {
      const factor = amsaScalingFactor(amsa);
      expect(factor).toBeLessThanOrEqual(previous + 1e-9);
      previous = factor;
    }
  });

  /**
   * Defensive default: a garbage AMSA must not talk the engine into delivering
   * *less* energy, so any non-finite input falls back to the ceiling.
   */
  it("treats non-finite AMSA as the ceiling rather than propagating NaN", () => {
    expect(amsaScalingFactor(Number.NaN)).toBe(1);
    expect(amsaScalingFactor(Number.POSITIVE_INFINITY)).toBe(1);
    expect(amsaScalingFactor(Number.NEGATIVE_INFINITY)).toBe(1);
    expect(Number.isFinite(recommendEnergy(Number.NaN, 75).recommendedJoules)).toBe(
      true,
    );
  });
});

describe("recommendEnergy", () => {
  it("applies E_opt = base x impedance correction x AMSA scaling", () => {
    const { energy, recommendedJoules } = recommendEnergy(20, 90);

    expect(energy.baseEnergyJ).toBe(150);
    expect(energy.impedanceCorrection).toBeCloseTo(90 / 75, 10);
    expect(energy.unclampedJoules).toBeCloseTo(
      150 * (90 / 75) * energy.amsaScalingFactor,
      10,
    );
    expect(recommendedJoules).toBe(Math.round(energy.unclampedJoules));
  });

  it("meets the specified anchors at nominal impedance", () => {
    expect(joulesAt(AMSA_LOW_THRESHOLD)).toBe(150);
    expect(joulesAt(AMSA_HIGH_THRESHOLD)).toBe(140);
    expect(joulesAt(AMSA_SCALE_SATURATION)).toBe(110);
  });

  it("keeps the shock-recommended band inside 110-140 J at 75 ohm", () => {
    for (let amsa = AMSA_HIGH_THRESHOLD; amsa <= 60; amsa += 0.1) {
      const joules = joulesAt(amsa);
      expect(joules).toBeGreaterThanOrEqual(110);
      expect(joules).toBeLessThanOrEqual(140);
    }
  });

  it("scales linearly with impedance before clamping", () => {
    const low = recommendEnergy(20, 50).energy.unclampedJoules;
    const high = recommendEnergy(20, 100).energy.unclampedJoules;
    expect(high / low).toBeCloseTo(2, 10);
  });

  it("clamps to the deliverable envelope at extreme impedance", () => {
    for (const ohms of [1, 5, 40, 150, 400, 5000]) {
      const joules = joulesAt(20, ohms);
      expect(joules).toBeGreaterThanOrEqual(DELIVERABLE_MIN_J);
      expect(joules).toBeLessThanOrEqual(DELIVERABLE_MAX_J);
    }
  });

  it("reports the pre-clamp value so the clamp is visible", () => {
    const { energy, recommendedJoules } = recommendEnergy(20, 5000);
    expect(energy.unclampedJoules).toBeGreaterThan(DELIVERABLE_MAX_J);
    expect(recommendedJoules).toBe(DELIVERABLE_MAX_J);
  });
});

describe("clinicalActionFor", () => {
  const SHOCKABLE: AclsRhythm[] = ["vfib", "vfib-fine", "vtach-pulseless", "torsades"];
  const NON_SHOCKABLE: AclsRhythm[] = [
    "sinus",
    "sinus-bradycardia",
    "sinus-tachycardia",
    "atrial-fibrillation",
    "svt",
    "vtach-with-pulse",
    "third-degree-block",
    "pea",
    "asystole",
  ];

  it("recommends a shock above the high threshold on shockable rhythms", () => {
    for (const rhythm of SHOCKABLE) {
      const action = clinicalActionFor(AMSA_HIGH_THRESHOLD, rhythm);
      expect(action.tier).toBe("high");
      expect(action.shockAdvised).toBe(true);
      expect(action.message).toBe("HIGH ROSC PROBABILITY — SHOCK RECOMMENDED");
    }
  });

  it("advises CPR in the intermediate band", () => {
    for (const amsa of [AMSA_LOW_THRESHOLD, 10, 15.4]) {
      const action = clinicalActionFor(amsa, "vfib");
      expect(action.tier).toBe("intermediate");
      expect(action.shockAdvised).toBe(false);
      expect(action.message).toBe(
        "INTERMEDIATE ENERGY — PERFORM 2-MIN CPR TO BOOST PERFUSION",
      );
    }
  });

  it("defers the shock below the low threshold", () => {
    for (const amsa of [0, 3.3, 6.49]) {
      const action = clinicalActionFor(amsa, "vfib");
      expect(action.tier).toBe("low");
      expect(action.shockAdvised).toBe(false);
      expect(action.message).toBe(
        "LOW MYOCARDIAL ENERGY — DEFER SHOCK (RISK OF MYOCARDIAL INJURY)",
      );
    }
  });

  it("is inclusive at the lower edge of each band", () => {
    expect(clinicalActionFor(AMSA_LOW_THRESHOLD, "vfib").tier).toBe(
      "intermediate",
    );
    expect(clinicalActionFor(AMSA_LOW_THRESHOLD - 0.01, "vfib").tier).toBe("low");
    expect(clinicalActionFor(AMSA_HIGH_THRESHOLD, "vfib").tier).toBe("high");
    expect(clinicalActionFor(AMSA_HIGH_THRESHOLD - 0.01, "vfib").tier).toBe(
      "intermediate",
    );
  });

  /**
   * The safety-critical case: without the rhythm gate the engine advises
   * defibrillating a patient who has a pulse.
   */
  it("never advises a shock on a non-shockable rhythm, at any AMSA", () => {
    for (const rhythm of NON_SHOCKABLE) {
      for (const amsa of [0, 6.5, 15.5, 20, 100]) {
        const action = clinicalActionFor(amsa, rhythm);
        expect(action.tier).toBe("non-shockable");
        expect(action.shockAdvised).toBe(false);
      }
    }
  });
});
