import { describe, expect, it } from "vitest";
import { PERFUSING_RHYTHMS, SHOCKABLE_RHYTHMS } from "@/types/patient";
import {
  ADENOSINE_FIRST_DOSE_MG,
  ADENOSINE_SECOND_DOSE_MG,
  AMIODARONE_TACHY_DOSE_MG,
  ATROPINE_DOSE_MG,
  ATROPINE_MAX_TOTAL_MG,
  BRADY_PACING_MS,
  CARDIOVERSION_FIRST_MS,
  CARDIOVERSION_INTERVAL_MS,
  CARDIOVERSION_LADDER_BROAD_J,
  CARDIOVERSION_LADDER_NARROW_J,
  CARDIOVERSION_MAX_J,
  CARDIOVERSION_REQUIREMENT_NARROW_J,
  HYPERKALEMIA_TREATMENT_AT_MS,
  HYPOTHERMIA_DRUG_INTERVAL_SCALE,
  KKM_RHYTHM_MATRICES,
  LIGNOCAINE_DOSE_MG_PER_KG,
  LIPID_EMULSION_ML_PER_KG,
  LUD_AT_MS,
  MAGNESIUM_AT_MS,
  MAGNESIUM_DOSE_MG,
  OBESITY_IMPEDANCE_FLOOR_OHMS,
  PACE_OUTPUT_MAX_MA,
  REWARM_TARGET_MS,
  SIMULATED_DURATION_MS,
  TRADITIONAL_PACE_OUTPUT_MA,
  TRADITIONAL_SHOCK_J,
  calibratedCardioversionJoules,
  calibratedPaceOutputMa,
  cardioversionRequirementJoules,
  circumstanceModifier,
  circumstanceModifiers,
  formatClock,
  generateKkmTimeline,
  kkmMatrixFor,
  paceCaptureRequirementMa,
  protocolFamilyFor,
  rungFor,
  shockPermitted,
  traditionalPaceOutputMa,
} from "./kkmAclsRules";
import type {
  InitialRhythm,
  PatientParameters,
  SpecialCircumstance,
} from "@/types/session";

const CASE: PatientParameters = {
  referenceId: "OIDE-TEST-KKM",
  ageYears: 62,
  weightKg: 80,
  transthoracicImpedanceOhms: 90,
  timeDownWithoutCprMinutes: 3,
  initialRhythm: "vfib",
  comorbidities: { ischemicHeartDisease: false, previousMi: false },
  specialCircumstances: [],
};

const withCase = (
  rhythm: InitialRhythm,
  specialCircumstances: SpecialCircumstance[] = [],
): PatientParameters => ({ ...CASE, initialRhythm: rhythm, specialCircumstances });

const stepsFor = (
  rhythm: InitialRhythm,
  circumstances: SpecialCircumstance[] = [],
) => generateKkmTimeline(withCase(rhythm, circumstances)).steps;

describe("algorithm routing", () => {
  it("routes every intake presentation to exactly one KKM algorithm", () => {
    const expected: Record<InitialRhythm, string> = {
      vfib: "cardiac-arrest",
      "vfib-fine": "cardiac-arrest",
      "vtach-pulseless": "cardiac-arrest",
      torsades: "cardiac-arrest",
      pea: "cardiac-arrest",
      asystole: "cardiac-arrest",
      "vtach-with-pulse": "tachycardia",
      svt: "tachycardia",
      "sinus-bradycardia": "bradycardia",
    };

    for (const [rhythm, family] of Object.entries(expected)) {
      expect(protocolFamilyFor(rhythm as InitialRhythm)).toBe(family);
    }
  });

  it("gives every matrix a guideline reference and a checklist", () => {
    for (const matrix of Object.values(KKM_RHYTHM_MATRICES)) {
      expect(matrix.guidelineRef.startsWith("kkm.")).toBe(true);
      expect(matrix.checklist.length).toBeGreaterThan(0);
    }
  });

  it("runs compressions only for the arrest algorithm", () => {
    for (const matrix of Object.values(KKM_RHYTHM_MATRICES)) {
      expect(matrix.compressions).toBe(matrix.family === "cardiac-arrest");
    }
  });
});

describe("adult cardiac arrest matrix", () => {
  it("defibrillates VF, fine VF and pulseless VT at a fixed 200 J", () => {
    for (const rhythm of ["vfib", "vfib-fine", "vtach-pulseless"] as const) {
      const matrix = kkmMatrixFor(rhythm);
      expect(matrix.defibrillate).toBe(true);
      expect(matrix.energy?.rungsJ).toEqual([TRADITIONAL_SHOCK_J]);
      // Conversion is resolved against AMSA, not a fixed energy requirement.
      expect(matrix.energy?.conversionRequirementJ).toBeNull();
    }
  });

  it("withholds energy entirely for PEA and asystole", () => {
    for (const rhythm of ["pea", "asystole"] as const) {
      const matrix = kkmMatrixFor(rhythm);
      expect(matrix.defibrillate).toBe(false);
      expect(matrix.deliversEnergy).toBe(false);
      expect(matrix.energy).toBeNull();
      expect(matrix.drugs.map((d) => d.drugId)).toEqual(["adrenaline"]);
    }
  });

  it("repeats the top rung once the ladder is exhausted", () => {
    const ladder = kkmMatrixFor("vfib").energy!;
    expect(rungFor(ladder, 1)).toBe(TRADITIONAL_SHOCK_J);
    expect(rungFor(ladder, 9)).toBe(TRADITIONAL_SHOCK_J);
  });
});

describe("adult tachycardia with a pulse matrix", () => {
  it("opens narrow QRS at 50 J and broad QRS at 100 J", () => {
    expect(kkmMatrixFor("svt").energy?.rungsJ).toEqual(
      CARDIOVERSION_LADDER_NARROW_J,
    );
    expect(kkmMatrixFor("vtach-with-pulse").energy?.rungsJ).toEqual(
      CARDIOVERSION_LADDER_BROAD_J,
    );
    expect(CARDIOVERSION_LADDER_NARROW_J[0]).toBe(50);
    expect(CARDIOVERSION_LADDER_BROAD_J[0]).toBe(100);
  });

  it("synchronises every tachycardia shock to the R wave", () => {
    for (const step of stepsFor("svt").filter((s) => s.kind === "shock")) {
      expect(step.synchronised).toBe(true);
    }
  });

  it("sedates before the first cardioversion attempt", () => {
    const steps = stepsFor("svt");
    const sedation = steps.find((s) => s.guidelineRef.endsWith("sedation"));
    const firstShock = steps.find((s) => s.kind === "shock");
    expect(sedation).toBeDefined();
    expect(sedation!.atMs).toBeLessThan(firstShock!.atMs);
  });

  it("spaces the cardioversion ladder one attempt per minute", () => {
    const shocks = stepsFor("svt").filter((s) => s.kind === "shock");
    expect(shocks).toHaveLength(CARDIOVERSION_LADDER_NARROW_J.length);
    expect(shocks[0].atMs).toBe(CARDIOVERSION_FIRST_MS);
    expect(shocks[1].atMs - shocks[0].atMs).toBe(CARDIOVERSION_INTERVAL_MS);
    expect(shocks.map((s) => s.rungJoules)).toEqual(
      CARDIOVERSION_LADDER_NARROW_J,
    );
  });

  it("gives adenosine 6 mg then 12 mg for a narrow QRS only", () => {
    const narrow = stepsFor("svt").filter((s) => s.drugId === "adenosine");
    expect(narrow.map((s) => s.doseMg)).toEqual([
      ADENOSINE_FIRST_DOSE_MG,
      ADENOSINE_SECOND_DOSE_MG,
    ]);
    // Each dose is withheld until the preceding attempt has actually happened.
    expect(narrow.map((s) => s.afterShock)).toEqual([1, 2]);

    expect(
      stepsFor("vtach-with-pulse").some((s) => s.drugId === "adenosine"),
    ).toBe(false);
  });

  it("caps broad-QRS amiodarone at 150 mg twice, then offers lignocaine", () => {
    const steps = stepsFor("vtach-with-pulse");
    const amiodarone = steps.filter((s) => s.drugId === "amiodarone");
    expect(amiodarone.map((s) => s.doseMg)).toEqual([
      AMIODARONE_TACHY_DOSE_MG,
      AMIODARONE_TACHY_DOSE_MG,
    ]);

    const lignocaine = steps.filter((s) => s.drugId === "lignocaine");
    expect(lignocaine).toHaveLength(1);
    // 1–1.5 mg/kg, dosed at the mid-band against the intake weight.
    expect(lignocaine[0].doseMg).toBe(
      Math.round(LIGNOCAINE_DOSE_MG_PER_KG * CASE.weightKg),
    );
  });

  it("caps a weight-based dose at its single-dose ceiling", () => {
    const heavy = generateKkmTimeline({
      ...withCase("vtach-with-pulse"),
      weightKg: 200,
    });
    const lignocaine = heavy.steps.find((s) => s.drugId === "lignocaine");
    expect(lignocaine?.doseMg).toBe(100);
  });

  it("points a polymorphic broad QRS at the torsades presentation", () => {
    expect(
      kkmMatrixFor("vtach-with-pulse").checklist.some((line) =>
        line.includes("torsades"),
      ),
    ).toBe(true);
  });
});

describe("torsades de pointes", () => {
  const matrix = kkmMatrixFor("torsades");

  it("runs under the arrest algorithm, not the tachycardia one", () => {
    // SHOCKABLE_RHYTHMS contains torsades and PERFUSING_RHYTHMS does not, so
    // the signal worker already draws it in the arrest perfusion regime.
    expect(matrix.family).toBe("cardiac-arrest");
    expect(matrix.compressions).toBe(true);
    expect(SHOCKABLE_RHYTHMS.has("torsades")).toBe(true);
    expect(PERFUSING_RHYTHMS.has("torsades")).toBe(false);
  });

  it("defibrillates unsynchronised at the fixed arrest energy", () => {
    expect(matrix.defibrillate).toBe(true);
    expect(matrix.energy?.mode).toBe("defibrillation");
    expect(matrix.energy?.rungsJ).toEqual([TRADITIONAL_SHOCK_J]);
    // Conversion resolves against AMSA, as it does for every arrest rhythm.
    expect(matrix.energy?.conversionRequirementJ).toBeNull();

    for (const step of stepsFor("torsades").filter((s) => s.kind === "shock")) {
      expect(step.synchronised).toBe(false);
      expect(step.rungJoules).toBe(TRADITIONAL_SHOCK_J);
    }
  });

  it("gives magnesium sulphate 2 g early — it is the reversible cause", () => {
    const magnesium = stepsFor("torsades").filter(
      (s) => s.drugId === "magnesium-sulphate",
    );
    expect(magnesium).toHaveLength(1);
    expect(magnesium[0].doseMg).toBe(MAGNESIUM_DOSE_MG);
    expect(magnesium[0].atMs).toBe(MAGNESIUM_AT_MS);
    // Restoring homogeneous repolarisation buys AMSA back.
    expect(magnesium[0].amsaGain).toBeGreaterThan(0);

    // Ahead of the first adrenaline dose, unlike any other shockable rhythm.
    const adrenaline = stepsFor("torsades").find(
      (s) => s.drugId === "adrenaline",
    );
    expect(magnesium[0].atMs).toBeLessThan(adrenaline!.atMs);
  });

  it("withholds amiodarone — it would prolong the QT that caused this", () => {
    expect(stepsFor("torsades").some((s) => s.drugId === "amiodarone")).toBe(
      false,
    );
    expect(
      matrix.checklist.some((line) => line.includes("Amiodarone is withheld")),
    ).toBe(true);

    // Every other shockable arrest rhythm does get it.
    for (const rhythm of ["vfib", "vfib-fine", "vtach-pulseless"] as const) {
      expect(stepsFor(rhythm).some((s) => s.drugId === "amiodarone")).toBe(true);
    }
  });

  it("still runs the arrest CPR structure", () => {
    const steps = stepsFor("torsades");
    expect(steps.filter((s) => s.kind === "cpr-start").length).toBeGreaterThan(0);
    expect(steps.filter((s) => s.kind === "rhythm-check").length).toBe(
      steps.filter((s) => s.kind === "shock").length,
    );
  });
});

describe("adult bradycardia matrix", () => {
  it("gives atropine 0.5 mg every 3–5 min to a 3 mg ceiling", () => {
    const doses = stepsFor("sinus-bradycardia").filter(
      (s) => s.drugId === "atropine",
    );
    expect(doses.every((s) => s.doseMg === ATROPINE_DOSE_MG)).toBe(true);

    const total = doses.reduce((sum, s) => sum + (s.doseMg ?? 0), 0);
    expect(total).toBeLessThanOrEqual(ATROPINE_MAX_TOTAL_MG);

    for (let i = 1; i < doses.length; i++) {
      const gapMinutes = (doses[i].atMs - doses[i - 1].atMs) / 60_000;
      expect(gapMinutes).toBeGreaterThanOrEqual(3);
      expect(gapMinutes).toBeLessThanOrEqual(5);
    }
  });

  it("escalates to transcutaneous pacing and a chronotropic infusion", () => {
    const steps = stepsFor("sinus-bradycardia");
    const pacing = steps.find((s) => s.kind === "pacing");
    expect(pacing?.atMs).toBe(BRADY_PACING_MS);

    const infusion = steps.find((s) => s.drugId === "adrenaline-infusion");
    expect(infusion).toBeDefined();
    expect(infusion!.atMs).toBeGreaterThan(pacing!.atMs);
    // The KKM alternative is named on the same order line.
    expect(infusion!.label).toContain("Dopamine");
  });

  it("delivers no energy — the problem is rate, not disorganisation", () => {
    expect(stepsFor("sinus-bradycardia").some((s) => s.kind === "shock")).toBe(
      false,
    );
  });
});

describe("energy and pacing calibration", () => {
  const ladder = kkmMatrixFor("svt").energy!;

  it("scales the conversion requirement with transthoracic impedance", () => {
    expect(cardioversionRequirementJoules(ladder, 75)).toBe(
      CARDIOVERSION_REQUIREMENT_NARROW_J,
    );
    expect(cardioversionRequirementJoules(ladder, 150)).toBe(
      CARDIOVERSION_REQUIREMENT_NARROW_J * 2,
    );
  });

  it("selects above the requirement, inside the deliverable envelope", () => {
    for (const ohms of [40, 75, 90, 120, 150]) {
      const requirement = cardioversionRequirementJoules(ladder, ohms);
      const selected = calibratedCardioversionJoules(ladder, ohms);
      expect(selected).toBeLessThanOrEqual(CARDIOVERSION_MAX_J);
      if (requirement < CARDIOVERSION_MAX_J) {
        expect(selected).toBeGreaterThanOrEqual(requirement);
      }
    }
  });

  it("returns no energy for an algorithm that delivers none", () => {
    const brady = kkmMatrixFor("sinus-bradycardia");
    expect(brady.energy).toBeNull();
    const arrest = kkmMatrixFor("vfib").energy!;
    expect(cardioversionRequirementJoules(arrest, 90)).toBe(0);
    expect(calibratedCardioversionJoules(arrest, 90)).toBe(0);
  });

  it("calibrates pacing output above the capture requirement", () => {
    for (const ohms of [75, 100, 120, 150]) {
      expect(calibratedPaceOutputMa(ohms)).toBeGreaterThanOrEqual(
        paceCaptureRequirementMa(ohms),
      );
    }
  });

  it("climbs the traditional pacing dial from a fixed start", () => {
    expect(traditionalPaceOutputMa(0)).toBe(TRADITIONAL_PACE_OUTPUT_MA);
    expect(traditionalPaceOutputMa(3)).toBe(TRADITIONAL_PACE_OUTPUT_MA + 30);
    expect(traditionalPaceOutputMa(999)).toBe(PACE_OUTPUT_MAX_MA);
  });
});

describe("special circumstances", () => {
  it("applies left uterine displacement at 00:15 in a maternal arrest", () => {
    const step = stepsFor("vfib", ["pregnancy"]).find(
      (s) => s.atMs === LUD_AT_MS,
    );
    expect(step?.label).toBe("Manual Left Uterine Displacement (LUD) Applied");
    expect(formatClock(LUD_AT_MS)).toBe("00:15");
  });

  it("activates the perimortem caesarean team inside the maternal window", () => {
    const steps = stepsFor("vfib", ["pregnancy"]);
    expect(
      steps.some((s) => s.label.includes("Perimortem Caesarean")),
    ).toBe(true);
  });

  it("improves compression yield once aortocaval compression is relieved", () => {
    expect(generateKkmTimeline(withCase("vfib", ["pregnancy"])).cprYieldScale)
      .toBeGreaterThan(1);
  });

  it("doubles drug intervals and gates shocks in severe hypothermia", () => {
    const plan = generateKkmTimeline(withCase("vfib", ["hypothermia"]));
    expect(plan.drugIntervalScale).toBe(HYPOTHERMIA_DRUG_INTERVAL_SCALE);
    expect(plan.shockGate.fromMs).toBe(REWARM_TARGET_MS);
    expect(plan.shockGate.shocksAllowedBefore).toBe(1);

    const adrenaline = plan.steps.filter((s) => s.drugId === "adrenaline");
    const normal = stepsFor("vfib").filter((s) => s.drugId === "adrenaline");
    expect(adrenaline[1].atMs - adrenaline[0].atMs).toBe(
      (normal[1].atMs - normal[0].atMs) * HYPOTHERMIA_DRUG_INTERVAL_SCALE,
    );
  });

  it("permits the first hypothermic shock and withholds the rest until rewarmed", () => {
    const { shockGate } = generateKkmTimeline(
      withCase("vfib", ["hypothermia"]),
    );
    expect(shockPermitted(shockGate, 0, 124_000)).toBe(true);
    expect(shockPermitted(shockGate, 1, 249_000)).toBe(false);
    expect(shockPermitted(shockGate, 1, REWARM_TARGET_MS)).toBe(true);
  });

  it("leaves shocks ungated when no circumstance gates them", () => {
    const { shockGate } = generateKkmTimeline(withCase("vfib"));
    expect(shockGate.fromMs).toBe(0);
    expect(shockPermitted(shockGate, 7, 0)).toBe(true);
  });

  it("gives calcium chloride and bicarbonate at 02:30 in hyperkalaemia", () => {
    const step = stepsFor("pea", ["hyperkalemia"]).find(
      (s) => s.atMs === HYPERKALEMIA_TREATMENT_AT_MS,
    );
    expect(step?.label).toBe(
      "Calcium Chloride 1g IV Push + Sodium Bicarbonate 50mEq",
    );
    expect(formatClock(HYPERKALEMIA_TREATMENT_AT_MS)).toBe("02:30");
    // Restoring membrane excitability buys AMSA back.
    expect(step?.amsaGain).toBeGreaterThan(0);
  });

  it("logs naloxone and a weight-based lipid emulsion bolus for an overdose", () => {
    const steps = stepsFor("pea", ["toxicological"]);
    expect(steps.some((s) => s.label.includes("Naloxone 2 mg"))).toBe(true);

    const lipid = steps.find((s) => s.label.includes("Intralipid"));
    expect(lipid?.label).toContain(
      `${LIPID_EMULSION_ML_PER_KG * CASE.weightKg} mL`,
    );
  });

  it("floors transthoracic impedance for a morbidly obese thorax", () => {
    const plan = generateKkmTimeline(withCase("vfib", ["morbid-obesity"]));
    expect(plan.impedanceFloorOhms).toBe(OBESITY_IMPEDANCE_FLOOR_OHMS);
    expect(generateKkmTimeline(withCase("vfib")).impedanceFloorOhms).toBeNull();
  });

  it("combines several circumstances rather than picking one", () => {
    const plan = generateKkmTimeline(
      withCase("pea", ["pregnancy", "hypothermia", "hyperkalemia"]),
    );
    expect(plan.modifiers.map((m) => m.circumstance)).toEqual([
      "pregnancy",
      "hypothermia",
      "hyperkalemia",
    ]);
    expect(plan.drugIntervalScale).toBe(HYPOTHERMIA_DRUG_INTERVAL_SCALE);
    expect(plan.cprYieldScale).toBeGreaterThan(1);
    expect(plan.shockGate.fromMs).toBe(REWARM_TARGET_MS);

    for (const circumstance of ["pregnancy", "hypothermia", "hyperkalemia"] as const) {
      const label = circumstanceModifier(circumstance, CASE.weightKg).label;
      expect(plan.notes.some((note) => note.startsWith(label))).toBe(true);
    }
  });

  it("ignores an intake profile with no circumstances recorded", () => {
    expect(circumstanceModifiers({ ...CASE, specialCircumstances: undefined }))
      .toEqual([]);
  });
});

describe("expanded sequence", () => {
  it("is deterministic — the same profile expands identically", () => {
    const profile = withCase("vfib", ["pregnancy", "hyperkalemia"]);
    expect(generateKkmTimeline(profile)).toEqual(
      generateKkmTimeline(profile),
    );
  });

  it("orders steps by instant, resolving deliveries before drugs", () => {
    for (const rhythm of Object.keys(
      KKM_RHYTHM_MATRICES,
    ) as InitialRhythm[]) {
      const steps = stepsFor(rhythm);
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i].atMs).toBeGreaterThanOrEqual(steps[i - 1].atMs);
      }
    }
  });

  it("keeps every step inside the protocol window", () => {
    for (const rhythm of [
      "vfib",
      "pea",
      "svt",
      "vtach-with-pulse",
      "sinus-bradycardia",
    ] as const) {
      for (const step of stepsFor(rhythm, ["hypothermia"])) {
        expect(step.atMs).toBeLessThanOrEqual(SIMULATED_DURATION_MS);
      }
    }
  });

  it("tags every step with the guideline step it implements", () => {
    for (const step of stepsFor("svt", ["pregnancy"])) {
      expect(step.guidelineRef).toMatch(/^kkm\./);
    }
  });
});
