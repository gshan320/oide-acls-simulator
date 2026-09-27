import { describe, expect, it } from "vitest";
import {
  AMIODARONE_ARREST_FIRST_MG,
  AMIODARONE_ARREST_SECOND_MG,
  AMSA_CEILING,
  AMSA_DOWNTIME_DECAY_PER_MIN,
  AMSA_POST_SHOCK_STUN,
  AMSA_RHYTHM_BASELINE,
  CONVERSION_THRESHOLD,
  CPR_BLOCK_MS,
  ADRENALINE_FIRST_MS,
  IMPEDANCE_MAX_OHMS,
  IMPEDANCE_MIN_OHMS,
  OVER_ENERGY_FLOOR,
  PLAYBACK_DURATION_MS,
  RHYTHM_CHECK_TO_SHOCK_MS,
  SIMULATED_DURATION_MS,
  SURVIVAL_NO_ROSC,
  TIME_LAPSE_FACTOR,
  TRADITIONAL_SHOCK_J,
  assessPatient,
  buildArmTimeline,
  buildDualArmExport,
  combineOutcome,
  cprGainPerMinute,
  defibrillationEfficacy,
  effectiveImpedanceOhms,
  energyAdequacy,
  formatClock,
  frameAt,
  initialAmsa,
  myocardialReserve,
  generateKkmTimeline,
  playbackMsFor,
  postShockStun,
  simulatedMsFor,
  survivalLikelihood,
  toArmOutcome,
} from "./aclsEngine";
import { AMSA_LOW_THRESHOLD, AMSA_SCALE_SATURATION } from "./decisionEngine";
import type { InitialRhythm, PatientParameters } from "@/types/session";

/** Reference case: 65 y, 90 Ω, 4 min down, coarse VF. */
const CASE: PatientParameters = {
  referenceId: "OIDE-TEST-0001",
  ageYears: 65,
  weightKg: 85,
  transthoracicImpedanceOhms: 90,
  timeDownWithoutCprMinutes: 4,
  initialRhythm: "vfib",
  comorbidities: { ischemicHeartDisease: true, previousMi: true },
};

const withRhythm = (rhythm: InitialRhythm): PatientParameters => ({
  ...CASE,
  initialRhythm: rhythm,
});

describe("playback clock", () => {
  it("compresses 20 simulated minutes into 60 real seconds", () => {
    expect(SIMULATED_DURATION_MS).toBe(1_200_000);
    expect(PLAYBACK_DURATION_MS).toBe(60_000);
    expect(TIME_LAPSE_FACTOR).toBe(20);
  });

  it("maps one real second onto twenty simulated seconds", () => {
    expect(simulatedMsFor(1000)).toBe(20_000);
    expect(simulatedMsFor(PLAYBACK_DURATION_MS)).toBe(SIMULATED_DURATION_MS);
    expect(playbackMsFor(SIMULATED_DURATION_MS)).toBe(PLAYBACK_DURATION_MS);
  });

  it("round-trips and never runs backwards past zero", () => {
    expect(playbackMsFor(simulatedMsFor(12_345))).toBeCloseTo(12_345, 6);
    expect(simulatedMsFor(-500)).toBe(0);
    expect(playbackMsFor(-500)).toBe(0);
  });
});

describe("effectiveImpedanceOhms", () => {
  it("passes through an in-range intake value", () => {
    expect(effectiveImpedanceOhms(CASE)).toBe(90);
  });

  it("clamps to the deliverable envelope", () => {
    expect(
      effectiveImpedanceOhms({ ...CASE, transthoracicImpedanceOhms: 10 }),
    ).toBe(IMPEDANCE_MIN_OHMS);
    expect(
      effectiveImpedanceOhms({ ...CASE, transthoracicImpedanceOhms: 400 }),
    ).toBe(IMPEDANCE_MAX_OHMS);
  });

  it("falls back to the nominal adult value for a non-finite reading", () => {
    expect(
      effectiveImpedanceOhms({
        ...CASE,
        transthoracicImpedanceOhms: Number.NaN,
      }),
    ).toBe(75);
  });
});

describe("initialAmsa", () => {
  it("decays the rhythm baseline by the unwitnessed downtime", () => {
    expect(initialAmsa({ ...CASE, timeDownWithoutCprMinutes: 0 })).toBeCloseTo(
      AMSA_RHYTHM_BASELINE.vfib,
      10,
    );
    expect(initialAmsa(CASE)).toBeCloseTo(
      AMSA_RHYTHM_BASELINE.vfib - 4 * AMSA_DOWNTIME_DECAY_PER_MIN,
      10,
    );
  });

  it("is zero for rhythms with no fibrillatory waveform", () => {
    expect(initialAmsa(withRhythm("pea"))).toBe(0);
    expect(initialAmsa(withRhythm("asystole"))).toBe(0);
  });

  it("floors at zero rather than going negative", () => {
    expect(
      initialAmsa({ ...CASE, initialRhythm: "vfib-fine", timeDownWithoutCprMinutes: 60 }),
    ).toBe(0);
  });
});

describe("cprGainPerMinute", () => {
  it("decays monotonically as the arrest wears on", () => {
    const early = cprGainPerMinute(0);
    const mid = cprGainPerMinute(6 * 60_000);
    const late = cprGainPerMinute(18 * 60_000);
    expect(early).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(late);
    expect(late).toBeGreaterThan(0);
  });
});

describe("myocardialReserve", () => {
  it("is zero at or below the defer threshold and saturates at the ceiling", () => {
    expect(myocardialReserve(AMSA_LOW_THRESHOLD)).toBe(0);
    expect(myocardialReserve(0)).toBe(0);
    expect(myocardialReserve(AMSA_SCALE_SATURATION)).toBe(1);
    expect(myocardialReserve(999)).toBe(1);
  });

  it("rises monotonically between the thresholds", () => {
    expect(myocardialReserve(12)).toBeGreaterThan(myocardialReserve(9));
    expect(myocardialReserve(20)).toBeGreaterThan(myocardialReserve(12));
  });

  it("treats a non-finite reading as no reserve", () => {
    expect(myocardialReserve(Number.NaN)).toBe(0);
  });
});

describe("energyAdequacy", () => {
  it("is perfect when delivered energy equals the calibrated optimum", () => {
    expect(energyAdequacy(150, 150)).toBe(1);
  });

  it("penalises under-dosing quadratically", () => {
    // Half the required energy retains a quarter of the efficacy.
    expect(energyAdequacy(75, 150)).toBeCloseTo(0.25, 10);
    expect(energyAdequacy(120, 150)).toBeCloseTo(0.64, 10);
  });

  it("penalises over-dosing gently and never below the floor", () => {
    expect(energyAdequacy(200, 150)).toBeCloseTo(1 - (1 / 3) * 0.35, 10);
    expect(energyAdequacy(1000, 150)).toBe(OVER_ENERGY_FLOOR);
  });

  it("is more forgiving of over- than of equally-sized under-dosing", () => {
    expect(energyAdequacy(200, 100)).toBeGreaterThan(energyAdequacy(50, 100));
  });

  it("returns zero for a degenerate optimum or delivery", () => {
    expect(energyAdequacy(200, 0)).toBe(0);
    expect(energyAdequacy(0, 150)).toBe(0);
  });
});

describe("defibrillationEfficacy", () => {
  it("is the product of reserve and energy match", () => {
    expect(defibrillationEfficacy(20, 150, 150)).toBeCloseTo(
      myocardialReserve(20),
      10,
    );
  });

  it("ranks a calibrated shock above a blanket dose at the same AMSA", () => {
    const calibrated = defibrillationEfficacy(19, 120, 120);
    const blanket = defibrillationEfficacy(19, TRADITIONAL_SHOCK_J, 120);
    expect(calibrated).toBeGreaterThan(blanket);
  });
});

describe("postShockStun", () => {
  it("charges the base stun when energy matched the optimum", () => {
    expect(postShockStun(150, 150)).toBeCloseTo(AMSA_POST_SHOCK_STUN, 10);
    expect(postShockStun(100, 150)).toBeCloseTo(AMSA_POST_SHOCK_STUN, 10);
  });

  it("adds stunning in proportion to the excess joules", () => {
    expect(postShockStun(250, 150)).toBeGreaterThan(postShockStun(200, 150));
  });
});

describe("survivalLikelihood", () => {
  it("collapses to the floor without ROSC", () => {
    expect(
      survivalLikelihood({
        roscAchieved: false,
        roscAtMs: null,
        myocardialInjuryIndex: 0,
      }),
    ).toBe(SURVIVAL_NO_ROSC);
  });

  it("falls with time to ROSC and with myocardial injury", () => {
    const early = survivalLikelihood({
      roscAchieved: true,
      roscAtMs: 120_000,
      myocardialInjuryIndex: 0,
    });
    const late = survivalLikelihood({
      roscAchieved: true,
      roscAtMs: 600_000,
      myocardialInjuryIndex: 0,
    });
    const injured = survivalLikelihood({
      roscAchieved: true,
      roscAtMs: 120_000,
      myocardialInjuryIndex: 200,
    });

    expect(early).toBeGreaterThan(late);
    expect(early).toBeGreaterThan(injured);
  });

  it("stays inside [0, 1]", () => {
    const worst = survivalLikelihood({
      roscAchieved: true,
      roscAtMs: SIMULATED_DURATION_MS,
      myocardialInjuryIndex: 5000,
    });
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe("assessPatient", () => {
  it("unlocks the shockable arm for VF and pulseless VT", () => {
    for (const rhythm of ["vfib", "vfib-fine", "vtach-pulseless"] as const) {
      const assessment = assessPatient(withRhythm(rhythm));
      expect(assessment.shockable).toBe(true);
      expect(assessment.verdict).toBe("SHOCKABLE RHYTHM");
      expect(assessment.initialOideJoules).toBeGreaterThan(0);
    }
  });

  it("rules out defibrillation for PEA and asystole", () => {
    for (const rhythm of ["pea", "asystole"] as const) {
      const assessment = assessPatient(withRhythm(rhythm));
      expect(assessment.shockable).toBe(false);
      expect(assessment.verdict).toBe("NON-SHOCKABLE RHYTHM");
      expect(assessment.initialAmsa).toBe(0);
      expect(assessment.initialOideJoules).toBe(0);
    }
  });

  it("reports the clamped impedance and flags that it was clamped", () => {
    const clean = assessPatient(CASE);
    expect(clean.impedanceClamped).toBe(false);

    const clamped = assessPatient({
      ...CASE,
      transthoracicImpedanceOhms: 200,
    });
    expect(clamped.impedanceClamped).toBe(true);
    expect(clamped.impedanceOhms).toBe(IMPEDANCE_MAX_OHMS);
    expect(clamped.findings.join(" ")).toContain(
      `adjusted to ${IMPEDANCE_MAX_OHMS} Ω`,
    );
  });

  it("summarises the case before the tabs unlock", () => {
    const assessment = assessPatient(CASE);
    expect(assessment.findings.length).toBeGreaterThan(4);
    expect(assessment.findings.join(" ")).toContain(CASE.referenceId);
    expect(assessment.findings.join(" ")).toContain("ischemic heart disease");
  });
});

describe("generateKkmTimeline — cardiac arrest", () => {
  const stepsFor = (rhythm: InitialRhythm) =>
    generateKkmTimeline(withRhythm(rhythm)).steps;

  it("lays down 2-minute CPR blocks with a rhythm check and shock per cycle", () => {
    const steps = stepsFor("vfib");
    const cprStarts = steps.filter((s) => s.kind === "cpr-start");
    const checks = steps.filter((s) => s.kind === "rhythm-check");
    const shocks = steps.filter((s) => s.kind === "shock");

    expect(cprStarts[0].atMs).toBe(0);
    expect(checks[0].atMs).toBe(CPR_BLOCK_MS);
    expect(shocks[0].atMs).toBe(CPR_BLOCK_MS + RHYTHM_CHECK_TO_SHOCK_MS);
    expect(cprStarts).toHaveLength(checks.length);
    expect(shocks).toHaveLength(checks.length);
  });

  it("selects the fixed 200 J rung on every traditional shock rung", () => {
    for (const step of stepsFor("vfib").filter((s) => s.kind === "shock")) {
      expect(step.rungJoules).toBe(TRADITIONAL_SHOCK_J);
      expect(step.synchronised).toBe(false);
    }
  });

  it("schedules adrenaline inside the 3–5 minute window", () => {
    const doses = stepsFor("vfib").filter((s) => s.drugId === "adrenaline");
    expect(doses[0].atMs).toBe(ADRENALINE_FIRST_MS);

    for (let i = 1; i < doses.length; i++) {
      const gapMinutes = (doses[i].atMs - doses[i - 1].atMs) / 60_000;
      expect(gapMinutes).toBeGreaterThanOrEqual(3);
      expect(gapMinutes).toBeLessThanOrEqual(5);
    }
  });

  it("gives adrenaline sooner when the rhythm is non-shockable", () => {
    const shockable = stepsFor("vfib").find((s) => s.drugId === "adrenaline");
    const nonShockable = stepsFor("asystole").find(
      (s) => s.drugId === "adrenaline",
    );
    expect(nonShockable?.atMs).toBeLessThan(shockable?.atMs ?? 0);
  });

  it("ties amiodarone to the third and fifth shocks", () => {
    const boluses = stepsFor("vfib").filter((s) => s.drugId === "amiodarone");
    expect(boluses.map((s) => s.doseMg)).toEqual([
      AMIODARONE_ARREST_FIRST_MG,
      AMIODARONE_ARREST_SECOND_MG,
    ]);
    expect(boluses.map((s) => s.afterShock)).toEqual([3, 5]);
  });

  it("plans no energy and no antiarrhythmic for a non-shockable rhythm", () => {
    const steps = stepsFor("asystole");
    expect(steps.some((s) => s.kind === "shock")).toBe(false);
    expect(steps.some((s) => s.drugId === "amiodarone")).toBe(false);
    expect(steps.some((s) => s.drugId === "adrenaline")).toBe(true);
  });

  it("stays inside the protocol window", () => {
    for (const step of stepsFor("vfib")) {
      expect(step.atMs).toBeLessThanOrEqual(SIMULATED_DURATION_MS);
    }
  });
});

describe("buildArmTimeline", () => {
  const traditional = buildArmTimeline(CASE, "traditional");
  const oide = buildArmTimeline(CASE, "oide");

  it("is deterministic — the same parameters give the same timeline", () => {
    expect(buildArmTimeline(CASE, "oide")).toEqual(oide);
    expect(buildArmTimeline(CASE, "traditional")).toEqual(traditional);
  });

  it("opens on CPR at 110 compressions per minute", () => {
    expect(traditional.events[0]).toMatchObject({
      atMs: 0,
      kind: "cpr-start",
      message: "CPR Initiated (110 CPM)",
    });
  });

  it("labels every later CPR block as a resumption", () => {
    const blocks = traditional.events.filter((e) => e.kind === "cpr-start");
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks.slice(1)) {
      expect(block.message).toBe("CPR Resumed (110 CPM)");
    }
  });

  it("delivers a fixed 200 J on every traditional shock", () => {
    const shocks = traditional.events.filter((e) => e.kind === "shock");
    expect(shocks.length).toBeGreaterThan(0);
    for (const shock of shocks) {
      expect(shock.joules).toBe(TRADITIONAL_SHOCK_J);
    }
  });

  it("delivers the calibrated optimum on every OIDE shock", () => {
    const shocks = oide.events.filter((e) => e.kind === "shock");
    expect(shocks.length).toBeGreaterThan(0);
    for (const shock of shocks) {
      expect(shock.joules).toBe(shock.optimalJoules);
      expect(shock.joules).not.toBe(TRADITIONAL_SHOCK_J);
    }
    expect(oide.result.myocardialInjuryIndex).toBe(0);
  });

  it("names both energies on the shock line, as the event feed prints it", () => {
    const first = traditional.events.find((e) => e.kind === "shock");
    expect(first?.message).toMatch(
      /^Shock #1 Delivered: 200 J \(Traditional\) vs \d+ J \(OIDE calibrated\)$/,
    );

    const oideFirst = oide.events.find((e) => e.kind === "shock");
    expect(oideFirst?.message).toMatch(
      /^Shock #1 Delivered: \d+ J \(OIDE\) vs 200 J \(Traditional fixed\)$/,
    );
  });

  it("banks the rhythm-check hands-off interval against each shock", () => {
    for (const shock of traditional.events.filter((e) => e.kind === "shock")) {
      expect(shock.preShockPauseMs).toBe(RHYTHM_CHECK_TO_SHOCK_MS);
    }
  });

  it("resolves each shock against the conversion threshold", () => {
    for (const shock of oide.events.filter((e) => e.kind === "shock")) {
      expect(shock.roscAchieved).toBe(
        (shock.efficacy ?? 0) >= CONVERSION_THRESHOLD,
      );
    }
  });

  it("ends the run at conversion and converts the rhythm to sinus", () => {
    expect(oide.result.roscAchieved).toBe(true);
    expect(oide.result.roscAtMs).not.toBeNull();
    expect(oide.result.durationMs).toBe(oide.result.roscAtMs);
    expect(oide.result.endedReason).toBe("rosc");
    expect(oide.events.at(-1)?.kind).toBe("end");
    expect(oide.events.some((e) => e.kind === "rosc")).toBe(true);
    expect(oide.amsaTrack.at(-1)?.rhythm).toBe("sinus");
  });

  it("keeps every event and sample inside the run's own span", () => {
    for (const arm of [traditional, oide]) {
      for (const event of arm.events) {
        expect(event.atMs).toBeLessThanOrEqual(arm.result.durationMs);
      }
      expect(arm.amsaTrack.at(-1)?.atMs).toBe(arm.result.durationMs);
      expect(arm.amsaTrack.at(0)?.atMs).toBe(0);
    }
  });

  it("reaches ROSC sooner and on far less energy under OIDE", () => {
    expect(traditional.result.roscAchieved).toBe(true);
    expect(oide.result.roscAtMs!).toBeLessThan(traditional.result.roscAtMs!);
    expect(oide.result.cumulativeJoules).toBeLessThan(
      traditional.result.cumulativeJoules,
    );
    expect(oide.result.shockCount).toBeLessThan(traditional.result.shockCount);
    expect(traditional.result.myocardialInjuryIndex).toBeGreaterThan(0);
    expect(oide.result.survivalLikelihood).toBeGreaterThan(
      traditional.result.survivalLikelihood,
    );
  });

  it("charges the traditional arm's excess energy to the injury index", () => {
    const { cumulativeJoules, optimalJoules, myocardialInjuryIndex } =
      traditional.result;
    expect(myocardialInjuryIndex).toBeCloseTo(
      (cumulativeJoules - optimalJoules) * 0.5,
      10,
    );
  });

  it("keeps AMSA inside its physiological envelope throughout", () => {
    for (const arm of [traditional, oide]) {
      for (const sample of arm.amsaTrack) {
        expect(sample.amsa).toBeGreaterThanOrEqual(0);
        expect(sample.amsa).toBeLessThanOrEqual(AMSA_CEILING);
      }
    }
  });

  it("runs the full window with no energy for a non-shockable rhythm", () => {
    for (const rhythm of ["pea", "asystole"] as const) {
      const arm = buildArmTimeline(withRhythm(rhythm), "oide");
      expect(arm.result.shockCount).toBe(0);
      expect(arm.result.cumulativeJoules).toBe(0);
      expect(arm.result.roscAchieved).toBe(false);
      expect(arm.result.endedReason).toBe("timeout");
      expect(arm.result.durationMs).toBe(SIMULATED_DURATION_MS);
      expect(arm.result.epinephrineDoses).toBeGreaterThan(0);
      expect(arm.result.amiodaroneMg).toBe(0);
      // No fibrillatory waveform means nothing to measure and nothing to boost.
      for (const sample of arm.amsaTrack) expect(sample.amsa).toBe(0);
    }
  });

  it("skips the amiodarone bolus for a shock the run never reached", () => {
    const early = buildArmTimeline(
      { ...CASE, timeDownWithoutCprMinutes: 0, transthoracicImpedanceOhms: 75 },
      "oide",
    );
    expect(early.result.shockCount).toBeLessThan(3);
    expect(early.result.amiodaroneMg).toBe(0);
    expect(
      early.events.some((e) => e.drugId === "amiodarone"),
    ).toBe(false);
  });

  it("gives both amiodarone boluses on a run that reaches shock 5", () => {
    // Fine VF, 6 minutes down, high impedance: a refractory case that runs the
    // full window and therefore passes both antiarrhythmic milestones.
    const refractory = buildArmTimeline(
      {
        ...CASE,
        initialRhythm: "vfib-fine",
        timeDownWithoutCprMinutes: 6,
        transthoracicImpedanceOhms: 110,
      },
      "traditional",
    );

    expect(refractory.result.shockCount).toBeGreaterThanOrEqual(5);
    expect(refractory.result.amiodaroneMg).toBe(
      AMIODARONE_ARREST_FIRST_MG + AMIODARONE_ARREST_SECOND_MG,
    );
    expect(
      refractory.events.find((e) => e.drugId === "amiodarone")?.message,
    ).toBe(`Amiodarone ${AMIODARONE_ARREST_FIRST_MG} mg IV Bolus (after shock #3)`);
  });

  it("drops a bolus scheduled after the run had already converted", () => {
    // Traditional converts on shock 3, so the bolus 20 s later never lands.
    expect(traditional.result.shockCount).toBe(3);
    expect(traditional.result.amiodaroneMg).toBe(0);
  });

  it("orders events by their instant on the simulated clock", () => {
    for (const arm of [traditional, oide]) {
      for (let i = 1; i < arm.events.length; i++) {
        expect(arm.events[i].atMs).toBeGreaterThanOrEqual(
          arm.events[i - 1].atMs,
        );
      }
    }
  });
});

describe("frameAt", () => {
  const oide = buildArmTimeline(CASE, "oide");

  it("reveals nothing beyond the requested instant", () => {
    const frame = frameAt(oide, CPR_BLOCK_MS);
    expect(frame.events.every((e) => e.atMs <= CPR_BLOCK_MS)).toBe(true);
    expect(frame.shockCount).toBe(0);
    expect(frame.cumulativeJoules).toBe(0);
    expect(frame.finished).toBe(false);
  });

  it("accumulates shocks and joules as the clock advances", () => {
    const afterFirst = frameAt(oide, CPR_BLOCK_MS + RHYTHM_CHECK_TO_SHOCK_MS);
    expect(afterFirst.shockCount).toBe(1);
    expect(afterFirst.cumulativeJoules).toBeGreaterThan(0);
  });

  it("agrees with the run's own totals once it is finished", () => {
    const end = frameAt(oide, SIMULATED_DURATION_MS);
    expect(end.finished).toBe(true);
    expect(end.shockCount).toBe(oide.result.shockCount);
    expect(end.cumulativeJoules).toBe(oide.result.cumulativeJoules);
    expect(end.rhythm).toBe("sinus");
  });

  it("clamps a negative or over-long instant into the track", () => {
    expect(frameAt(oide, -1000).simulatedMs).toBe(0);
    expect(frameAt(oide, 10 * SIMULATED_DURATION_MS).amsa).toBe(
      oide.amsaTrack.at(-1)?.amsa,
    );
  });
});

describe("combineOutcome", () => {
  const traditional = buildArmTimeline(CASE, "traditional").result;
  const oide = buildArmTimeline(CASE, "oide").result;

  it("credits the arm that converted first", () => {
    const outcome = combineOutcome(traditional, oide);
    expect(outcome.roscAchieved).toBe(true);
    expect(outcome.roscByArm).toBe("oide");
    expect(outcome.endedReason).toBe("rosc");
  });

  it("sums both arms' energy and shocks", () => {
    const outcome = combineOutcome(traditional, oide);
    expect(outcome.cumulativeJoules).toBe(
      traditional.cumulativeJoules + oide.cumulativeJoules,
    );
    expect(outcome.shockCount).toBe(
      traditional.shockCount + oide.shockCount,
    );
  });

  it("reports a timeout when neither arm converted", () => {
    const params = withRhythm("asystole");
    const outcome = combineOutcome(
      buildArmTimeline(params, "traditional").result,
      buildArmTimeline(params, "oide").result,
    );
    expect(outcome.roscAchieved).toBe(false);
    expect(outcome.roscByArm).toBeNull();
    expect(outcome.endedReason).toBe("timeout");
  });

  it("carries survival and time-to-ROSC onto the persisted arm outcome", () => {
    const arm = toArmOutcome(oide);
    expect(arm.survivalLikelihood).toBe(oide.survivalLikelihood);
    expect(arm.timeToRoscMs).toBe(oide.roscAtMs);
    expect(arm.arm).toBe("oide");
  });
});

describe("buildDualArmExport", () => {
  const traditional = buildArmTimeline(CASE, "traditional");
  const oide = buildArmTimeline(CASE, "oide");
  const bundle = buildDualArmExport({
    simId: CASE.referenceId,
    patient: CASE,
    assessment: assessPatient(CASE),
    traditional,
    oide,
    exportedAt: "2026-09-02T00:00:00.000Z",
  });

  it("carries both arms in full, events and AMSA track alike", () => {
    expect(bundle.formatVersion).toBe(3);
    expect(bundle.exportedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(bundle.arms.traditional.events).toEqual(traditional.events);
    expect(bundle.arms.oide.amsaTrack).toEqual(oide.amsaTrack);
  });

  it("states the deltas the comparison exists to show", () => {
    expect(bundle.comparison.jouleDelta).toBe(
      traditional.result.cumulativeJoules - oide.result.cumulativeJoules,
    );
    expect(bundle.comparison.jouleDelta).toBeGreaterThan(0);
    expect(bundle.comparison.miiDelta).toBeGreaterThan(0);
    expect(bundle.comparison.survivalDelta).toBeGreaterThan(0);
    expect(bundle.comparison.timeToRoscDeltaMs).toBeGreaterThan(0);
  });

  it("leaves the ROSC delta unstated when an arm never converted", () => {
    const params = withRhythm("asystole");
    const flat = buildDualArmExport({
      simId: params.referenceId,
      patient: params,
      assessment: assessPatient(params),
      traditional: buildArmTimeline(params, "traditional"),
      oide: buildArmTimeline(params, "oide"),
      exportedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(flat.comparison.timeToRoscDeltaMs).toBeNull();
  });

  it("is serialisable — the bundle is what gets written to disk", () => {
    expect(() => JSON.stringify(bundle)).not.toThrow();
  });
});

describe("formatClock", () => {
  it("prints the MM:SS the event feed shows", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(124_000)).toBe("02:04");
    expect(formatClock(SIMULATED_DURATION_MS)).toBe("20:00");
  });

  it("floors negatives to the start of the clock", () => {
    expect(formatClock(-5000)).toBe("00:00");
  });
});
