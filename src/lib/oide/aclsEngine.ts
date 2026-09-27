import type { AclsRhythm } from "@/types/patient";
import {
  AMSA_HIGH_THRESHOLD,
  AMSA_LOW_THRESHOLD,
  AMSA_SCALE_SATURATION,
  clinicalActionFor,
  recommendEnergy,
} from "./decisionEngine";
import { myocardialInjuryIndex } from "./outcome";
import {
  ADRENALINE_INTERVAL_MS,
  ATROPINE_MAX_TOTAL_MG,
  CARDIOVERSION_SAFETY_MARGIN,
  COMPRESSION_RATE,
  CPR_BLOCK_MS,
  PACE_ESCALATION_INTERVAL_MS,
  PACE_OUTPUT_MAX_MA,
  PACE_RATE_BPM,
  PLAYBACK_DURATION_MS,
  SIMULATED_DURATION_MS,
  TIME_LAPSE_FACTOR,
  TRADITIONAL_SHOCK_J,
  calibratedCardioversionJoules,
  calibratedPaceOutputMa,
  cardioversionRequirementJoules,
  circumstanceModifiers,
  formatClock,
  generateKkmTimeline,
  isDefibrillatable,
  kkmMatrixFor,
  paceCaptureRequirementMa,
  shockPermitted,
  traditionalPaceOutputMa,
  type KkmProtocolPlan,
  type KkmStep,
} from "./kkmAclsRules";
import {
  INITIAL_RHYTHM_LABELS,
  SPECIAL_CIRCUMSTANCE_LABELS,
  type AmsaTimepointPayload,
  type ArmOutcome,
  type InitialRhythm,
  type InterventionPayload,
  type InterventionType,
  type KkmProtocolFamily,
  type PatientParameters,
  type ProtocolArm,
  type SimulationOutcome,
  type SpecialCircumstance,
} from "@/types/session";

/**
 * Automated, time-lapsed comparative ACLS engine.
 *
 * Generates the whole 20-minute resuscitation for one protocol arm up front, as
 * a deterministic list of timestamped events plus a 1 Hz AMSA track. Nothing
 * here touches React, the DOM, a clock, or a random number generator: the same
 * patient parameters always produce byte-identical timelines, which is what
 * makes the traditional-vs-OIDE comparison a controlled experiment rather than
 * two independent rolls of the dice.
 *
 * The clinical sequence itself comes from `kkmAclsRules` — the KKM NCORT adult
 * ALS decision matrices, expanded against the intake profile. Both arms execute
 * that same sequence, including every special-circumstance modification, and
 * diverge on exactly one variable: the energy (or pacing output) each delivery
 * carries. Traditional selects the guideline's fixed figure; OIDE selects the
 * impedance- and AMSA-calibrated optimum. Everything downstream — myocardial
 * stunning, AMSA trajectory, when the rhythm converts, cumulative injury —
 * follows from that single difference.
 *
 * This is a custom OIDE calibration for training, NOT a published
 * resuscitation guideline. It is not a medical device.
 */

/* ------------------------------------------------------------------ *
 * Protocol timing and doses — owned by the rules engine, re-exported
 * here so the UI has a single import surface for the whole model.
 * ------------------------------------------------------------------ */

export {
  ADENOSINE_FIRST_DOSE_MG,
  ADENOSINE_SECOND_DOSE_MG,
  ADRENALINE_DOSE_MG,
  ADRENALINE_FIRST_MS,
  ADRENALINE_FIRST_NONSHOCKABLE_MS,
  ADRENALINE_INTERVAL_MS,
  AMIODARONE_ARREST_FIRST_MG,
  AMIODARONE_ARREST_SECOND_MG,
  AMIODARONE_DELAY_MS,
  AMIODARONE_FIRST_AFTER_SHOCK,
  AMIODARONE_SECOND_AFTER_SHOCK,
  AMIODARONE_TACHY_DOSE_MG,
  ATROPINE_DOSE_MG,
  ATROPINE_MAX_TOTAL_MG,
  BRADY_PACING_MS,
  CARDIOVERSION_FIRST_MS,
  CARDIOVERSION_INTERVAL_MS,
  CARDIOVERSION_LADDER_BROAD_J,
  CARDIOVERSION_LADDER_NARROW_J,
  COMPRESSION_RATE,
  CPR_BLOCK_MS,
  CYCLE_MS,
  HYPERKALEMIA_TREATMENT_AT_MS,
  HYPOTHERMIA_DRUG_INTERVAL_SCALE,
  KKM_INTAKE_GROUPS,
  KKM_RHYTHM_MATRICES,
  LIGNOCAINE_DOSE_MG_PER_KG,
  LUD_AT_MS,
  MAGNESIUM_DOSE_MG,
  OBESITY_IMPEDANCE_FLOOR_OHMS,
  PACE_RATE_BPM,
  PLAYBACK_DURATION_MS,
  REWARM_TARGET_MS,
  RHYTHM_CHECK_TO_SHOCK_MS,
  SHOCK_TO_CPR_MS,
  SIMULATED_DURATION_MS,
  TIME_LAPSE_FACTOR,
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
  type KkmCircumstanceModifier,
  type KkmProtocolPlan,
  type KkmRhythmMatrix,
  type KkmStep,
  type KkmStepKind,
} from "./kkmAclsRules";

/** Resolution of the AMSA track, and of the forward integration. */
export const AMSA_SAMPLE_INTERVAL_MS = 1_000;

/** Deliverable transthoracic impedance range of the intake form. */
export const IMPEDANCE_MIN_OHMS = 40;
export const IMPEDANCE_MAX_OHMS = 150;

/** Heart rate the patient settles at once the rhythm is restored. */
export const POST_ROSC_HEART_RATE = 96;

/**
 * Rate each presentation arrives at, bpm.
 *
 * Zero wherever the rhythm produces no cardiac output — the monitor shows
 * dashes rather than a number, which is what an arrest actually looks like.
 */
export const PRESENTING_HEART_RATE: Record<InitialRhythm, number> = {
  vfib: 0,
  "vfib-fine": 0,
  "vtach-pulseless": 0,
  // Polymorphic VT at this rate fills nothing: no output, so no rate to show.
  torsades: 0,
  pea: 0,
  asystole: 0,
  "vtach-with-pulse": 168,
  svt: 186,
  "sinus-bradycardia": 38,
};

/**
 * Rate to display for a rhythm under a given algorithm, bpm; 0 for no output.
 *
 * A converted bradycardia is being paced, not beating on its own, so it shows
 * the pacer's demand rate rather than a spontaneous post-ROSC rate.
 */
export function heartRateFor(
  rhythm: AclsRhythm,
  family: KkmProtocolFamily,
): number {
  if (rhythm === "sinus") {
    return family === "bradycardia" ? PACE_RATE_BPM : POST_ROSC_HEART_RATE;
  }
  return PRESENTING_HEART_RATE[rhythm as InitialRhythm] ?? 0;
}

/* ------------------------------------------------------------------ *
 * AMSA dynamics
 * ------------------------------------------------------------------ */

/**
 * AMSA a freshly witnessed arrest presents with, by rhythm, mV·Hz.
 *
 * Zero wherever there is no fibrillatory waveform to measure — the
 * non-shockable arrest rhythms, and every perfusing presentation handled under
 * the tachycardia and bradycardia algorithms.
 */
export const AMSA_RHYTHM_BASELINE: Record<InitialRhythm, number> = {
  vfib: 15.5,
  "vfib-fine": 9,
  "vtach-pulseless": 17,
  // High-amplitude, near-sinusoidal, and fast: torsades carries more
  // fibrillatory energy than coarse VF and less than monomorphic pVT.
  torsades: 16.5,
  pea: 0,
  asystole: 0,
  "vtach-with-pulse": 0,
  svt: 0,
  "sinus-bradycardia": 0,
};

/** AMSA lost per minute of arrest before anyone started compressions. */
export const AMSA_DOWNTIME_DECAY_PER_MIN = 0.45;
/** AMSA gained per minute of high-quality compressions, at t = 0. */
export const AMSA_CPR_GAIN_PER_MIN = 2;
/**
 * The perfusion a given minute of CPR buys falls as the arrest wears on —
 * acidosis, myocardial oedema, and falling coronary perfusion pressure. Without
 * this the AMSA track would rise forever and every case would eventually
 * convert, which would hide the cost of a late ROSC.
 */
export const AMSA_CPR_FATIGUE_TAU_MS = 12 * 60_000;
/** AMSA lost per minute of hands-off time. */
export const AMSA_HANDS_OFF_DECAY_PER_MIN = 3;
/** Myocardial stunning from a shock that failed to convert, mV·Hz. */
export const AMSA_POST_SHOCK_STUN = 1.4;
/** Additional stunning per joule delivered above the calibrated optimum. */
export const AMSA_OVERDOSE_STUN_PER_JOULE = 0.008;
/** AMSA gained from the coronary perfusion pressure bump after a dose. */
export const AMSA_EPINEPHRINE_GAIN = 1;
/** Physiological ceiling; matches where the energy curve bottoms out. */
export const AMSA_CEILING = AMSA_SCALE_SATURATION;

/**
 * Defibrillation efficacy at or above which the rhythm converts.
 *
 * Calibrated so that a well-perfused myocardium shocked at its calibrated
 * energy converts within the first two attempts, while the same myocardium
 * shocked at a blanket 200 J needs more attempts and accumulates injury
 * getting there.
 */
export const CONVERSION_THRESHOLD = 0.62;

/** Efficacy lost per unit of excess energy ratio. */
export const OVER_ENERGY_PENALTY = 0.35;
/** However far over the optimum, a shock retains at least this much efficacy. */
export const OVER_ENERGY_FLOOR = 0.5;

/**
 * Myocardial reserve a perfusing tachycardia brings to a synchronised shock.
 *
 * High and fixed, because the myocardium has been perfusing right up to the
 * moment of cardioversion: unlike an arrest, nothing here is energy-starved, so
 * whether the attempt works turns on the energy alone.
 */
export const CARDIOVERSION_RESERVE = 0.92;

/* ------------------------------------------------------------------ *
 * Survival modelling
 * ------------------------------------------------------------------ */

export const SURVIVAL_ROSC_BASE = 0.62;
/** Neurologically intact survival lost per minute spent in arrest. */
export const SURVIVAL_PER_MINUTE_TO_ROSC = 0.03;
/** Survival lost per unit of myocardial injury index. */
export const SURVIVAL_PER_MII_UNIT = 0.0015;
/** Survival with no ROSC inside the protocol window. */
export const SURVIVAL_NO_ROSC = 0.01;
export const SURVIVAL_CEILING = 0.95;
export const SURVIVAL_FLOOR = 0.01;

/**
 * A patient who never lost their circulation starts from a far better place:
 * the algorithm is restoring a rate, not restarting a heart.
 */
export const SURVIVAL_STABILISED_BASE = 0.94;
/** Survival lost per minute of sustained haemodynamic instability. */
export const SURVIVAL_PER_MINUTE_UNSTABLE = 0.012;
/** Survival for a tachycardia or bradycardia never brought under control. */
export const SURVIVAL_UNSTABLE_TIMEOUT = 0.4;

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** Labels for every rhythm a run can display, post-conversion sinus included. */
export function rhythmLabel(rhythm: AclsRhythm): string {
  return rhythm in INITIAL_RHYTHM_LABELS
    ? INITIAL_RHYTHM_LABELS[rhythm as InitialRhythm]
    : "Sinus rhythm (restored)";
}

/**
 * Intake impedance, clamped to the range the hardware can deliver into and
 * floored by any special circumstance that raises it — a morbidly obese thorax
 * does not present 60 Ω however the slider was set.
 */
export function effectiveImpedanceOhms(params: PatientParameters): number {
  const raw = params.transthoracicImpedanceOhms;
  const value = Number.isFinite(raw) ? raw : 75;

  const floor = circumstanceModifiers(params).reduce<number>(
    (lowest, modifier) => Math.max(lowest, modifier.impedanceFloorOhms ?? 0),
    IMPEDANCE_MIN_OHMS,
  );

  return clamp(Math.max(value, floor), IMPEDANCE_MIN_OHMS, IMPEDANCE_MAX_OHMS);
}

/** AMSA the case opens on: rhythm baseline, decayed by unwitnessed downtime. */
export function initialAmsa(params: PatientParameters): number {
  const baseline = AMSA_RHYTHM_BASELINE[params.initialRhythm] ?? 0;
  if (baseline <= 0) return 0;

  const downMinutes = Math.max(0, params.timeDownWithoutCprMinutes || 0);
  return Math.max(0, baseline - downMinutes * AMSA_DOWNTIME_DECAY_PER_MIN);
}

/** Compression yield at a given point in the arrest, mV·Hz per minute. */
export function cprGainPerMinute(elapsedMs: number, yieldScale = 1): number {
  return (
    AMSA_CPR_GAIN_PER_MIN *
    Math.exp(-elapsedMs / AMSA_CPR_FATIGUE_TAU_MS) *
    yieldScale
  );
}

/**
 * How much of the myocardium's defibrillation reserve AMSA reports, 0–1.
 * Zero at the defer threshold, saturating where the energy curve bottoms out.
 */
export function myocardialReserve(amsa: number): number {
  if (!Number.isFinite(amsa)) return 0;
  return clamp01(
    (amsa - AMSA_LOW_THRESHOLD) / (AMSA_SCALE_SATURATION - AMSA_LOW_THRESHOLD),
  );
}

/**
 * How well a delivered energy matches the calibrated optimum, 0–1.
 *
 * The asymmetry is the clinical point. Under-dosing fails to depolarise a
 * critical mass of myocardium, so efficacy falls off quadratically. Over-dosing
 * still defibrillates — it just injures the heart doing it — so efficacy decays
 * gently and never below `OVER_ENERGY_FLOOR`. The cost of over-dosing shows up
 * in `postShockStun` and the myocardial injury index instead.
 */
export function energyAdequacy(
  deliveredJoules: number,
  optimalJoules: number,
): number {
  if (!(optimalJoules > 0) || !(deliveredJoules > 0)) return 0;

  const ratio = deliveredJoules / optimalJoules;
  if (ratio >= 1) {
    return Math.max(OVER_ENERGY_FLOOR, 1 - (ratio - 1) * OVER_ENERGY_PENALTY);
  }
  return ratio * ratio;
}

/** Combined likelihood that this shock, at this energy, converts the rhythm. */
export function defibrillationEfficacy(
  amsa: number,
  deliveredJoules: number,
  optimalJoules: number,
): number {
  return (
    myocardialReserve(amsa) * energyAdequacy(deliveredJoules, optimalJoules)
  );
}

/**
 * Likelihood a synchronised shock restores an organised rhythm.
 *
 * Resolved against the energy the thorax actually *requires*, not against
 * either arm's selection, so both arms are judged by the same physics.
 */
export function cardioversionEfficacy(
  deliveredJoules: number,
  requirementJoules: number,
): number {
  return (
    CARDIOVERSION_RESERVE * energyAdequacy(deliveredJoules, requirementJoules)
  );
}

/** AMSA lost to myocardial stunning by a shock that did not convert. */
export function postShockStun(
  deliveredJoules: number,
  optimalJoules: number,
): number {
  const excess = Math.max(0, deliveredJoules - optimalJoules);
  return AMSA_POST_SHOCK_STUN + excess * AMSA_OVERDOSE_STUN_PER_JOULE;
}

/**
 * Neurologically intact survival likelihood, 0–1.
 *
 * For an arrest, two things move it: how long the patient spent without a
 * circulation before conversion, and how much myocardium the protocol burned
 * getting there. For a patient who never arrested, the clock runs far more
 * slowly — sustained instability is dangerous, not immediately lethal.
 */
export function survivalLikelihood(input: {
  roscAchieved: boolean;
  roscAtMs: number | null;
  myocardialInjuryIndex: number;
  family?: KkmProtocolFamily;
}): number {
  const family = input.family ?? "cardiac-arrest";
  const arrest = family === "cardiac-arrest";

  if (!input.roscAchieved || input.roscAtMs === null) {
    return arrest ? SURVIVAL_NO_ROSC : SURVIVAL_UNSTABLE_TIMEOUT;
  }

  const minutes = input.roscAtMs / 60_000;
  const raw =
    (arrest ? SURVIVAL_ROSC_BASE : SURVIVAL_STABILISED_BASE) -
    minutes *
      (arrest ? SURVIVAL_PER_MINUTE_TO_ROSC : SURVIVAL_PER_MINUTE_UNSTABLE) -
    input.myocardialInjuryIndex * SURVIVAL_PER_MII_UNIT;

  return clamp(raw, SURVIVAL_FLOOR, SURVIVAL_CEILING);
}

/* ------------------------------------------------------------------ *
 * Playback clock
 * ------------------------------------------------------------------ */

/** Real playback milliseconds → position on the simulated 20-minute clock. */
export const simulatedMsFor = (playbackMs: number): number =>
  Math.max(0, playbackMs) * TIME_LAPSE_FACTOR;

/** Position on the simulated clock → real playback milliseconds. */
export const playbackMsFor = (simulatedMs: number): number =>
  Math.max(0, simulatedMs) / TIME_LAPSE_FACTOR;

/* ------------------------------------------------------------------ *
 * Assessment gate
 * ------------------------------------------------------------------ */

export interface RhythmAssessment {
  rhythm: InitialRhythm;
  rhythmLabel: string;
  /** Which KKM algorithm the presentation routes to. */
  family: KkmProtocolFamily;
  /** Unsynchronised defibrillation is indicated. */
  shockable: boolean;
  /** Either arm delivers energy — defibrillation or synchronised. */
  deliversEnergy: boolean;
  /** Headline verdict, e.g. "SHOCKABLE RHYTHM". */
  verdict: string;
  /** Protocol arm the diagnostics unlock. */
  protocol: string;
  /** Clinical assessment summary, one line per finding. */
  findings: string[];
  /** The algorithm's own checklist, plus every circumstance modification. */
  protocolNotes: string[];
  impedanceOhms: number;
  /** Whether the intake impedance had to be clamped or floored. */
  impedanceClamped: boolean;
  initialAmsa: number;
  /** Energy OIDE would select for delivery 1; 0 when none is indicated. */
  initialOideJoules: number;
  /** Fixed energy the traditional route would select for delivery 1. */
  initialTraditionalJoules: number;
  circumstances: SpecialCircumstance[];
}

const FAMILY_PROTOCOL_LABEL: Record<KkmProtocolFamily, string> = {
  "cardiac-arrest": "KKM Adult Cardiac Arrest algorithm",
  tachycardia: "KKM Adult Tachycardia With A Pulse algorithm",
  bradycardia: "KKM Adult Bradycardia algorithm",
};

/**
 * Scan the intake profile and decide which algorithm the case runs under.
 *
 * Rhythm first, always: AMSA quantifies myocardial energy state, which only
 * bears on the decision when unsynchronised defibrillation is on the table at
 * all.
 */
export function assessPatient(params: PatientParameters): RhythmAssessment {
  const plan = generateKkmTimeline(params);
  const matrix = plan.matrix;
  const impedanceOhms = effectiveImpedanceOhms(params);
  const impedanceClamped = impedanceOhms !== params.transthoracicImpedanceOhms;
  const amsa = initialAmsa(params);
  const { recommendedJoules, energy } = recommendEnergy(amsa, impedanceOhms);
  const circumstances = params.specialCircumstances ?? [];

  const oideJoules = matrix.defibrillate
    ? recommendedJoules
    : matrix.energy === null
      ? 0
      : calibratedCardioversionJoules(matrix.energy, impedanceOhms);

  const traditionalJoules =
    matrix.energy === null ? 0 : matrix.energy.rungsJ[0];

  const findings: string[] = [
    `Patient ${params.referenceId} — ${params.ageYears} y, ${params.weightKg} kg.`,
    `Presenting rhythm ${rhythmLabel(params.initialRhythm)} — ${FAMILY_PROTOCOL_LABEL[matrix.family]}.`,
    `Transthoracic impedance ${impedanceOhms} Ω — impedance correction ×${energy.impedanceCorrection.toFixed(2)}.`,
  ];

  if (matrix.family === "cardiac-arrest") {
    findings.push(
      `Downtime ${params.timeDownWithoutCprMinutes} min without CPR — AMSA decayed to ${amsa.toFixed(1)} mV·Hz.`,
    );
  }

  if (impedanceClamped) {
    findings.push(
      `Intake impedance ${params.transthoracicImpedanceOhms} Ω adjusted to ${impedanceOhms} Ω — outside the ${IMPEDANCE_MIN_OHMS}–${IMPEDANCE_MAX_OHMS} Ω deliverable range, or floored by a special circumstance.`,
    );
  }

  if (matrix.defibrillate) {
    findings.push(
      amsa >= AMSA_HIGH_THRESHOLD
        ? `AMSA ${amsa.toFixed(1)} mV·Hz is above the ${AMSA_HIGH_THRESHOLD} mV·Hz shock threshold — myocardium is defibrillation-ready.`
        : amsa >= AMSA_LOW_THRESHOLD
          ? `AMSA ${amsa.toFixed(1)} mV·Hz is in the intermediate band — the first CPR block should raise it before shock 1.`
          : `AMSA ${amsa.toFixed(1)} mV·Hz is below the ${AMSA_LOW_THRESHOLD} mV·Hz defer threshold — low myocardial energy, high injury risk.`,
      `OIDE would open at ${oideJoules} J against the traditional fixed ${traditionalJoules} J.`,
    );
  } else if (matrix.deliversEnergy && matrix.energy !== null) {
    const requirement = cardioversionRequirementJoules(
      matrix.energy,
      impedanceOhms,
    );
    findings.push(
      "No fibrillatory waveform — AMSA is advisory only; energy is synchronised to the R wave.",
      `This thorax needs about ${requirement} J to convert. OIDE opens at ${oideJoules} J; the traditional ladder opens at ${traditionalJoules} J and climbs ${matrix.energy.rungsJ.join(" → ")} J.`,
    );
  } else if (matrix.family === "bradycardia") {
    const captureMa = paceCaptureRequirementMa(impedanceOhms);
    findings.push(
      "No defibrillation is indicated — the problem is rate, not rhythm disorganisation.",
      `Atropine to a ${ATROPINE_MAX_TOTAL_MG} mg ceiling, then transcutaneous pacing at ${PACE_RATE_BPM}/min. This thorax needs about ${captureMa} mA to capture; OIDE opens at ${calibratedPaceOutputMa(impedanceOhms)} mA against a fixed 80 mA.`,
    );
  } else {
    findings.push(
      "No fibrillatory waveform to measure — AMSA is advisory only and defibrillation is not indicated.",
      "Both arms run compressions, airway, and vasopressor only; neither delivers energy, so the comparison shows a zero-joule tie.",
    );
  }

  const comorbidities = [
    params.comorbidities.ischemicHeartDisease && "ischemic heart disease",
    params.comorbidities.previousMi && "previous MI",
  ].filter((entry): entry is string => typeof entry === "string");

  findings.push(
    comorbidities.length > 0
      ? `Relevant history: ${comorbidities.join(", ")}.`
      : "No ischemic history recorded.",
  );

  findings.push(
    circumstances.length > 0
      ? `Special circumstances: ${circumstances
          .map((entry) => SPECIAL_CIRCUMSTANCE_LABELS[entry])
          .join("; ")}.`
      : "No ACLS special circumstances flagged.",
  );

  return {
    rhythm: params.initialRhythm,
    rhythmLabel: rhythmLabel(params.initialRhythm),
    family: matrix.family,
    shockable: matrix.defibrillate,
    deliversEnergy: matrix.deliversEnergy,
    verdict: matrix.defibrillate
      ? "SHOCKABLE RHYTHM"
      : matrix.deliversEnergy
        ? "UNSTABLE — SYNCHRONISED CARDIOVERSION"
        : matrix.family === "bradycardia"
          ? "SYMPTOMATIC BRADYCARDIA"
          : "NON-SHOCKABLE RHYTHM",
    protocol: FAMILY_PROTOCOL_LABEL[matrix.family],
    findings,
    protocolNotes: plan.notes,
    impedanceOhms,
    impedanceClamped,
    initialAmsa: amsa,
    initialOideJoules: oideJoules,
    initialTraditionalJoules: traditionalJoules,
    circumstances,
  };
}

/* ------------------------------------------------------------------ *
 * Timeline
 * ------------------------------------------------------------------ */

export type AclsEventKind =
  | "assessment"
  | "cpr-start"
  | "rhythm-check"
  | "shock"
  | "shock-deferred"
  | "drug"
  | "pacing"
  | "pacing-capture"
  | "adjunct"
  | "rosc"
  | "end";

export type AclsEventSeverity = "info" | "success" | "advisory" | "critical";

/** One line of the live event feed, with everything the log row needs. */
export interface AclsEvent {
  /** Position on the simulated 20-minute clock, ms. */
  atMs: number;
  kind: AclsEventKind;
  /** Rendered verbatim in the scrolling event log, after its timestamp. */
  message: string;
  severity: AclsEventSeverity;
  rhythm: AclsRhythm;
  compressionsActive: boolean;
  amsa: number;
  /** KKM algorithm step this event implements. */
  guidelineRef?: string;
  /** Energy this arm actually delivered. Shock events only. */
  joules?: number;
  /** The calibrated optimum at this instant — the MII baseline. */
  optimalJoules?: number;
  /** True when the shock was synchronised to the R wave. */
  synchronised?: boolean;
  /** 1-based shock number within the run. */
  shockIndex?: number;
  /** Hands-off interval immediately preceding the shock, ms. */
  preShockPauseMs?: number;
  /** Post-penalty efficacy this shock was resolved against. */
  efficacy?: number;
  roscAchieved?: boolean;
  drugId?: string;
  doseMg?: number;
  /** Transcutaneous pacing output, mA. Pacing events only. */
  paceOutputMa?: number;
}

/** One point on an arm's AMSA trajectory. */
export interface AclsAmsaSample {
  atMs: number;
  amsa: number;
  /** The calibrated energy this arm would deliver right now, joules. */
  recommendedJoules: number;
  rhythm: AclsRhythm;
  compressionsActive: boolean;
}

export interface AclsArmResult {
  arm: "traditional" | "oide";
  family: KkmProtocolFamily;
  roscAchieved: boolean;
  /** Simulated instant of conversion, ms; null if the arm never converted. */
  roscAtMs: number | null;
  shockCount: number;
  /** Shocks the hypothermia gate withheld. */
  deferredShockCount: number;
  cumulativeJoules: number;
  /** Sum of the calibrated optimum at this arm's delivery moments. */
  optimalJoules: number;
  myocardialInjuryIndex: number;
  /** Hands-off time banked against this arm's shocks, ms. */
  totalPreShockPauseMs: number;
  /** All hands-off time, shock-adjacent or not, ms. */
  totalHandsOffMs: number;
  epinephrineDoses: number;
  amiodaroneMg: number;
  /** Cumulative dose per drug id, mg. */
  drugTotalsMg: Record<string, number>;
  /** Efficacy of the last delivery this arm resolved, 0–1. */
  roscProbability: number;
  survivalLikelihood: number;
  finalAmsa: number;
  finalRhythm: AclsRhythm;
  /** Instant pacing captured, ms; bradycardia runs only. */
  paceCaptureAtMs: number | null;
  /** Output the arm was pacing at when the run ended, mA; 0 if never paced. */
  paceOutputMa: number;
  /** Simulated span the run actually occupied. */
  durationMs: number;
  endedReason: "rosc" | "timeout";
}

export interface AclsArmTimeline {
  arm: "traditional" | "oide";
  family: KkmProtocolFamily;
  events: AclsEvent[];
  amsaTrack: AclsAmsaSample[];
  result: AclsArmResult;
}

function defibMessage(
  arm: "traditional" | "oide",
  shockIndex: number,
  deliveredJoules: number,
  optimalJoules: number,
): string {
  return arm === "traditional"
    ? `Shock #${shockIndex} Delivered: ${deliveredJoules} J (Traditional) vs ${optimalJoules} J (OIDE calibrated)`
    : `Shock #${shockIndex} Delivered: ${deliveredJoules} J (OIDE) vs ${TRADITIONAL_SHOCK_J} J (Traditional fixed)`;
}

function cardioversionMessage(
  arm: "traditional" | "oide",
  shockIndex: number,
  deliveredJoules: number,
  otherJoules: number,
  requirementJoules: number,
): string {
  const source = arm === "traditional" ? "Traditional ladder" : "OIDE calibrated";
  const other = arm === "traditional" ? "OIDE calibrated" : "Traditional ladder";
  return `Synchronised Cardioversion #${shockIndex}: ${deliveredJoules} J (${source}) vs ${otherJoules} J (${other}) — this thorax needs ${requirementJoules} J`;
}

/**
 * Run one protocol arm end to end.
 *
 * Forward Euler at `AMSA_SAMPLE_INTERVAL_MS`, which is also the sample rate of
 * the returned track — so the chart and the numbers the events carry come from
 * exactly the same integration rather than from a closed form that could drift
 * away from it. Every planned instant falls on the 1 s grid by construction.
 */
export function buildArmTimeline(
  params: PatientParameters,
  arm: "traditional" | "oide",
): AclsArmTimeline {
  const plan = generateKkmTimeline(params);
  const matrix = plan.matrix;
  const impedanceOhms = effectiveImpedanceOhms(params);

  const events: AclsEvent[] = [];
  const amsaTrack: AclsAmsaSample[] = [];

  /**
   * Only a fibrillatory waveform has an AMSA to grow. For every other
   * presentation the track stays pinned at zero and the comparison rests on
   * the delivered energy alone.
   */
  const measurable = isDefibrillatable(params.initialRhythm);
  const requirementJoules =
    matrix.energy === null
      ? 0
      : cardioversionRequirementJoules(matrix.energy, impedanceOhms);
  const calibratedJoules =
    matrix.energy === null
      ? 0
      : calibratedCardioversionJoules(matrix.energy, impedanceOhms);
  const captureRequirementMa = paceCaptureRequirementMa(impedanceOhms);

  let amsa = initialAmsa(params);
  let rhythm: AclsRhythm = params.initialRhythm;
  let compressionsActive = false;
  /** When the current hands-off interval began; null while compressing. */
  let handsOffSinceMs: number | null = matrix.compressions ? 0 : null;

  let shockCount = 0;
  let deferredShockCount = 0;
  let cumulativeJoules = 0;
  let optimalJoulesTotal = 0;
  let mii = 0;
  let preShockPauseMs = 0;
  let handsOffMs = 0;
  let epinephrineDoses = 0;
  let amiodaroneMg = 0;
  const drugTotalsMg: Record<string, number> = {};
  let lastEfficacy = 0;
  let roscAtMs: number | null = null;
  let endedAtMs = SIMULATED_DURATION_MS;

  /** Pacing state; only the bradycardia algorithm ever engages it. */
  let paceOutputMa = 0;
  let paceEscalations = 0;
  let nextPaceCheckMs = Number.POSITIVE_INFINITY;
  let paceCaptureAtMs: number | null = null;

  const steps = plan.steps;
  let cursor = 0;

  const push = (event: AclsEvent) => events.push(event);

  for (let t = 0; t <= SIMULATED_DURATION_MS; t += AMSA_SAMPLE_INTERVAL_MS) {
    // --- Fire everything scheduled for this instant ---
    while (cursor < steps.length && steps[cursor].atMs === t) {
      const step: KkmStep = steps[cursor];
      cursor += 1;

      switch (step.kind) {
        case "assessment": {
          push({
            atMs: t,
            kind: "assessment",
            message: step.label,
            severity: "advisory",
            rhythm,
            compressionsActive,
            amsa,
            guidelineRef: step.guidelineRef,
          });
          break;
        }

        case "cpr-start": {
          compressionsActive = true;
          handsOffSinceMs = null;
          push({
            atMs: t,
            kind: "cpr-start",
            message:
              events.some((event) => event.kind === "cpr-start")
                ? `CPR Resumed (${COMPRESSION_RATE} CPM)`
                : `CPR Initiated (${COMPRESSION_RATE} CPM)`,
            severity: "info",
            rhythm,
            compressionsActive,
            amsa,
            guidelineRef: step.guidelineRef,
          });
          break;
        }

        case "rhythm-check": {
          compressionsActive = false;
          handsOffSinceMs = t;
          push({
            atMs: t,
            kind: "rhythm-check",
            message: `Rhythm Check: ${rhythmLabel(rhythm)}`,
            severity: "advisory",
            rhythm,
            compressionsActive,
            amsa,
            guidelineRef: step.guidelineRef,
          });
          break;
        }

        case "shock": {
          // Severe hypothermia: a cold myocardium is refractory, so KKM caps
          // the attempts until rewarming reaches 30 °C.
          if (!shockPermitted(plan.shockGate, shockCount, t)) {
            deferredShockCount += 1;
            push({
              atMs: t,
              kind: "shock-deferred",
              message: `Shock withheld — core temperature below 30 °C; rewarming in progress (resumes ${formatClock(plan.shockGate.fromMs)})`,
              severity: "advisory",
              rhythm,
              compressionsActive: false,
              amsa,
              guidelineRef: step.guidelineRef,
            });
            break;
          }

          const synchronised = step.synchronised === true;
          const rung = step.rungJoules ?? TRADITIONAL_SHOCK_J;

          const optimal = synchronised
            ? calibratedJoules
            : recommendEnergy(amsa, impedanceOhms).recommendedJoules;
          const delivered = arm === "traditional" ? rung : optimal;
          const pauseMs = handsOffSinceMs === null ? 0 : t - handsOffSinceMs;

          const efficacy = synchronised
            ? cardioversionEfficacy(delivered, requirementJoules)
            : defibrillationEfficacy(amsa, delivered, optimal);
          const converted = efficacy >= CONVERSION_THRESHOLD;

          /**
           * Baseline the injury index is charged against.
           *
           * For defibrillation it is the calibrated optimum at this instant:
           * failed attempts are an expected part of the arrest algorithm and
           * both arms pay for them equally. A *synchronised* shock that
           * converted nothing is different — the calibrated route would never
           * have selected that rung at all, so every joule of it is excess.
           */
          const injuryBaseline = synchronised && !converted ? 0 : optimal;

          shockCount += 1;
          cumulativeJoules += delivered;
          optimalJoulesTotal += injuryBaseline;
          mii += myocardialInjuryIndex(delivered, injuryBaseline);
          preShockPauseMs += pauseMs;
          lastEfficacy = efficacy;

          push({
            atMs: t,
            kind: "shock",
            message: synchronised
              ? cardioversionMessage(
                  arm,
                  shockCount,
                  delivered,
                  arm === "traditional" ? calibratedJoules : rung,
                  requirementJoules,
                )
              : defibMessage(arm, shockCount, delivered, optimal),
            severity: converted ? "success" : "critical",
            rhythm,
            compressionsActive: false,
            amsa,
            guidelineRef: step.guidelineRef,
            joules: delivered,
            optimalJoules: optimal,
            synchronised,
            shockIndex: shockCount,
            preShockPauseMs: pauseMs,
            efficacy,
            roscAchieved: converted,
          });

          if (converted) {
            rhythm = "sinus";
            roscAtMs = t;
            endedAtMs = t;
            compressionsActive = false;
            handsOffSinceMs = null;

            push({
              atMs: t,
              kind: "rosc",
              message: matrix.compressions
                ? `ROSC — organised rhythm restored after shock #${shockCount} at ${formatClock(t)}`
                : `Sinus rhythm restored after cardioversion #${shockCount} at ${formatClock(t)} — reassess perfusion and treat the cause`,
              severity: "success",
              rhythm,
              compressionsActive: false,
              amsa,
              guidelineRef: step.guidelineRef,
            });
          } else if (measurable) {
            amsa = clamp(amsa - postShockStun(delivered, optimal), 0, AMSA_CEILING);
          }
          break;
        }

        case "drug": {
          const doseMg = step.doseMg ?? 0;
          if (step.afterShock !== undefined && shockCount < step.afterShock) {
            break;
          }

          if (step.drugId === "adrenaline") epinephrineDoses += 1;
          if (step.drugId === "amiodarone") amiodaroneMg += doseMg;
          if (step.drugId !== undefined) {
            drugTotalsMg[step.drugId] =
              (drugTotalsMg[step.drugId] ?? 0) + doseMg;
          }

          if (measurable && step.amsaGain !== undefined) {
            amsa = clamp(amsa + step.amsaGain, 0, AMSA_CEILING);
          }

          push({
            atMs: t,
            kind: "drug",
            message: step.label,
            severity: "info",
            rhythm,
            compressionsActive,
            amsa,
            guidelineRef: step.guidelineRef,
            drugId: step.drugId,
            ...(step.doseMg === undefined ? {} : { doseMg: step.doseMg }),
          });
          break;
        }

        case "pacing": {
          paceOutputMa =
            arm === "traditional"
              ? traditionalPaceOutputMa(0)
              : calibratedPaceOutputMa(impedanceOhms);
          paceEscalations = 0;
          nextPaceCheckMs = t;

          push({
            atMs: t,
            kind: "pacing",
            message: `${step.label} — output ${paceOutputMa} mA (${
              arm === "traditional"
                ? "Traditional fixed start"
                : `OIDE calibrated for ${impedanceOhms} Ω`
            })`,
            severity: "advisory",
            rhythm,
            compressionsActive,
            amsa,
            guidelineRef: step.guidelineRef,
            paceOutputMa,
          });
          break;
        }

        case "adjunct": {
          if (measurable && step.amsaGain !== undefined) {
            amsa = clamp(amsa + step.amsaGain, 0, AMSA_CEILING);
          }
          push({
            atMs: t,
            kind: "adjunct",
            message: step.label,
            severity: "advisory",
            rhythm,
            compressionsActive,
            amsa,
            guidelineRef: step.guidelineRef,
          });
          break;
        }
      }
    }

    /* --- Pacing capture check --- */
    if (roscAtMs === null && paceOutputMa > 0 && t >= nextPaceCheckMs) {
      if (paceOutputMa >= captureRequirementMa) {
        paceCaptureAtMs = t;
        roscAtMs = t;
        endedAtMs = t;
        rhythm = "sinus";
        lastEfficacy = 1;
        nextPaceCheckMs = Number.POSITIVE_INFINITY;

        push({
          atMs: t,
          kind: "pacing-capture",
          message: `Electrical and mechanical capture confirmed at ${paceOutputMa} mA — paced rate ${PACE_RATE_BPM}/min, perfusion restored at ${formatClock(t)}`,
          severity: "success",
          rhythm,
          compressionsActive: false,
          amsa,
          paceOutputMa,
        });
      } else if (paceOutputMa < PACE_OUTPUT_MAX_MA) {
        // KKM turns the dial up until capture; the traditional route starts
        // from a fixed 80 mA and climbs, which costs time the calibrated
        // route never spends.
        paceEscalations += 1;
        paceOutputMa = traditionalPaceOutputMa(paceEscalations);
        nextPaceCheckMs = t + PACE_ESCALATION_INTERVAL_MS;

        push({
          atMs: t,
          kind: "pacing",
          message: `No capture at ${traditionalPaceOutputMa(paceEscalations - 1)} mA — output increased to ${paceOutputMa} mA`,
          severity: "critical",
          rhythm,
          compressionsActive: false,
          amsa,
          paceOutputMa,
        });
      } else {
        nextPaceCheckMs = Number.POSITIVE_INFINITY;
      }
    }

    amsaTrack.push({
      atMs: t,
      amsa,
      recommendedJoules: measurable
        ? recommendEnergy(amsa, impedanceOhms).recommendedJoules
        : calibratedJoules,
      rhythm,
      compressionsActive,
    });

    if (roscAtMs !== null) break;

    // --- Integrate one step forward ---
    if (compressionsActive) {
      if (measurable) amsa += cprGainPerMinute(t, plan.cprYieldScale) / 60;
    } else {
      if (measurable) amsa -= AMSA_HANDS_OFF_DECAY_PER_MIN / 60;
      if (matrix.compressions) handsOffMs += AMSA_SAMPLE_INTERVAL_MS;
    }
    amsa = clamp(amsa, 0, AMSA_CEILING);
  }

  const roscAchieved = roscAtMs !== null;

  push({
    atMs: endedAtMs,
    kind: "end",
    message: roscAchieved
      ? `Sequence complete — ${matrix.compressions ? "ROSC" : "rhythm restored"} at ${formatClock(endedAtMs)}, ${cumulativeJoules} J total`
      : `Protocol window elapsed at ${formatClock(endedAtMs)} — no conversion, ${cumulativeJoules} J total`,
    severity: roscAchieved ? "success" : "critical",
    rhythm,
    compressionsActive: false,
    amsa,
  });

  return {
    arm,
    family: matrix.family,
    events,
    amsaTrack,
    result: {
      arm,
      family: matrix.family,
      roscAchieved,
      roscAtMs,
      shockCount,
      deferredShockCount,
      cumulativeJoules,
      optimalJoules: optimalJoulesTotal,
      myocardialInjuryIndex: mii,
      totalPreShockPauseMs: preShockPauseMs,
      totalHandsOffMs: handsOffMs,
      epinephrineDoses,
      amiodaroneMg,
      drugTotalsMg,
      roscProbability: lastEfficacy,
      survivalLikelihood: survivalLikelihood({
        roscAchieved,
        roscAtMs,
        myocardialInjuryIndex: mii,
        family: matrix.family,
      }),
      finalAmsa: amsa,
      finalRhythm: rhythm,
      paceCaptureAtMs,
      paceOutputMa,
      durationMs: endedAtMs,
      endedReason: roscAchieved ? "rosc" : "timeout",
    },
  };
}

/* ------------------------------------------------------------------ *
 * Playback projection
 * ------------------------------------------------------------------ */

/** Everything the live telemetry needs at one instant of a run. */
export interface AclsPlaybackFrame {
  simulatedMs: number;
  /** Events at or before `simulatedMs`, in order. */
  events: AclsEvent[];
  amsa: number;
  recommendedJoules: number;
  rhythm: AclsRhythm;
  compressionsActive: boolean;
  shockCount: number;
  cumulativeJoules: number;
  /** Latest pacing output at this instant, mA; 0 while not pacing. */
  paceOutputMa: number;
  /** True once the run's final event has been reached. */
  finished: boolean;
}

/**
 * Project a timeline onto one instant of playback.
 *
 * Kept pure and index-free so the component can call it every animation frame
 * without holding a cursor that could desynchronise from the clock.
 */
export function frameAt(
  timeline: AclsArmTimeline,
  simulatedMs: number,
): AclsPlaybackFrame {
  const at = Math.max(0, simulatedMs);
  const events = timeline.events.filter((event) => event.atMs <= at);

  const sampleIndex = Math.min(
    timeline.amsaTrack.length - 1,
    Math.floor(at / AMSA_SAMPLE_INTERVAL_MS),
  );
  const sample = timeline.amsaTrack[Math.max(0, sampleIndex)];

  const shocks = events.filter((event) => event.kind === "shock");
  const paced = events.filter((event) => event.paceOutputMa !== undefined);

  return {
    simulatedMs: at,
    events,
    amsa: sample?.amsa ?? 0,
    recommendedJoules: sample?.recommendedJoules ?? 0,
    rhythm: sample?.rhythm ?? timeline.amsaTrack[0]?.rhythm ?? "asystole",
    compressionsActive: sample?.compressionsActive ?? false,
    shockCount: shocks.length,
    cumulativeJoules: shocks.reduce(
      (sum, event) => sum + (event.joules ?? 0),
      0,
    ),
    paceOutputMa: paced.at(-1)?.paceOutputMa ?? 0,
    finished: at >= timeline.result.durationMs,
  };
}

/* ------------------------------------------------------------------ *
 * Bridges to the persisted schema
 * ------------------------------------------------------------------ */

/**
 * CPR artefact inflates AMSA measured on the raw lead.
 *
 * The engine models the signal chain's *outcome* rather than running the LMS
 * canceller: `currentAMSA` is the filtered figure the decision engine acts on,
 * and this factor reconstructs the corrupted reading the same window would have
 * produced without cancellation — which is the pair the debrief compares.
 */
export const AMSA_ARTEFACT_INFLATION = 1.85;
/** Broadband artefact rejection the canceller achieves during compressions, dB. */
export const ARTEFACT_SUPPRESSION_DB = 14.2;

const INTERVENTION_TYPE: Record<AclsEventKind, InterventionType> = {
  assessment: "rhythm-check",
  "cpr-start": "cpr-started",
  "rhythm-check": "rhythm-check",
  shock: "shock-delivered",
  "shock-deferred": "shock-deferred",
  drug: "drug-administered",
  pacing: "pacing-started",
  "pacing-capture": "pacing-capture",
  adjunct: "adjunct-applied",
  rosc: "rosc",
  end: "sequence-end",
};

/** Map one timeline event onto the append-only intervention schema. */
export function toInterventionPayload(
  event: AclsEvent,
  arm: "traditional" | "oide",
): InterventionPayload {
  const payload: InterventionPayload = {
    type: INTERVENTION_TYPE[event.kind],
    arm,
    offsetMs: event.atMs,
    rhythmAtTime: event.rhythm,
    amsaAtTime: event.amsa,
    note: event.message,
  };

  if (event.guidelineRef !== undefined) payload.guidelineRef = event.guidelineRef;
  if (event.joules !== undefined) payload.joules = event.joules;
  if (event.optimalJoules !== undefined) {
    payload.oideOptimalJoules = event.optimalJoules;
  }
  if (event.synchronised !== undefined) payload.synchronised = event.synchronised;
  if (event.preShockPauseMs !== undefined) {
    payload.preShockPauseMs = event.preShockPauseMs;
  }
  if (event.efficacy !== undefined) payload.roscProbability = event.efficacy;
  if (event.roscAchieved !== undefined) {
    payload.roscAchieved = event.roscAchieved;
  }
  if (event.drugId !== undefined) payload.drugId = event.drugId;
  if (event.doseMg !== undefined) payload.doseMg = event.doseMg;
  if (event.paceOutputMa !== undefined) payload.paceOutputMa = event.paceOutputMa;

  return payload;
}

/** Map one AMSA sample onto the 1 Hz AmsaLogs schema. */
export function toAmsaTimepoint(
  sample: AclsAmsaSample,
  arm: "traditional" | "oide",
): AmsaTimepointPayload {
  const action = clinicalActionFor(sample.amsa, sample.rhythm);

  return {
    arm,
    offsetMs: sample.atMs,
    currentAMSA: sample.amsa,
    amsaUnfiltered: sample.compressionsActive
      ? sample.amsa * AMSA_ARTEFACT_INFLATION
      : sample.amsa,
    artefactSuppressionDb: sample.compressionsActive
      ? ARTEFACT_SUPPRESSION_DB
      : 0,
    recommendedJoules: sample.recommendedJoules,
    clinicalActionTier: action.tier,
    clinicalActionMessage: action.message,
    rhythmAtTime: sample.rhythm,
    compressionsActive: sample.compressionsActive,
  };
}

/**
 * Thin the AMSA track for plotting and persistence.
 *
 * The track is integrated at 1 Hz because the physics needs that resolution;
 * the chart and the Firestore collection do not. Sampling every `strideMs`
 * keeps the trajectory's shape while cutting the document count by the stride.
 * The final sample is always kept so the trace reaches the end of the run.
 */
export function sampleAmsaTrack(
  track: AclsAmsaSample[],
  strideMs: number,
): AclsAmsaSample[] {
  if (track.length === 0) return [];

  const stride = Math.max(AMSA_SAMPLE_INTERVAL_MS, strideMs);
  const kept = track.filter((sample) => sample.atMs % stride === 0);
  const last = track[track.length - 1];

  return kept.at(-1)?.atMs === last.atMs ? kept : [...kept, last];
}

export function toArmOutcome(result: AclsArmResult): ArmOutcome {
  return {
    arm: result.arm,
    family: result.family,
    roscAchieved: result.roscAchieved,
    shockCount: result.shockCount,
    cumulativeJoules: result.cumulativeJoules,
    optimalJoules: result.optimalJoules,
    myocardialInjuryIndex: result.myocardialInjuryIndex,
    totalPreShockPauseMs: result.totalPreShockPauseMs,
    epinephrineDoses: result.epinephrineDoses,
    survivalLikelihood: result.survivalLikelihood,
    timeToRoscMs: result.roscAtMs,
    roscProbability: result.roscProbability,
    finalRhythm: result.finalRhythm,
    paceCaptureAtMs: result.paceCaptureAtMs,
  };
}

/**
 * Fold both arms into the session-level outcome.
 *
 * `roscByArm` credits OIDE when both arms convert, because the comparison's
 * question is which protocol got there first on the least energy — and by
 * construction the arm that converted sooner is the one that did.
 */
export function combineOutcome(
  traditional: AclsArmResult,
  oide: AclsArmResult,
): SimulationOutcome {
  const candidates = [oide, traditional].filter(
    (result) => result.roscAchieved && result.roscAtMs !== null,
  );
  const winner = candidates.reduce<AclsArmResult | null>(
    (best, result) =>
      best === null || (result.roscAtMs ?? 0) < (best.roscAtMs ?? 0)
        ? result
        : best,
    null,
  );

  return {
    roscAchieved: winner !== null,
    roscByArm: winner?.arm ?? null,
    cumulativeJoules: traditional.cumulativeJoules + oide.cumulativeJoules,
    totalPreShockPauseMs:
      traditional.totalPreShockPauseMs + oide.totalPreShockPauseMs,
    totalDurationMs: Math.max(traditional.durationMs, oide.durationMs),
    shockCount: traditional.shockCount + oide.shockCount,
    arms: {
      traditional: toArmOutcome(traditional),
      oide: toArmOutcome(oide),
    },
    endedReason: winner !== null ? "rosc" : "timeout",
    note: `Automated time-lapsed dual-arm run under the ${FAMILY_PROTOCOL_LABEL[traditional.family]} — guideline-fixed energy vs OIDE calibrated energy.`,
  };
}

/* ------------------------------------------------------------------ *
 * Research export
 * ------------------------------------------------------------------ */

export interface DualArmExportBundle {
  formatVersion: 3;
  exportedAt: string;
  simId: string;
  patient: PatientParameters;
  assessment: RhythmAssessment;
  /** The KKM plan both arms executed, as generated from the intake profile. */
  protocol: {
    family: KkmProtocolFamily;
    guidelineRef: string;
    checklist: string[];
    steps: KkmStep[];
    circumstances: SpecialCircumstance[];
    drugIntervalScale: number;
    cprYieldScale: number;
    shockGate: KkmProtocolPlan["shockGate"];
    impedanceFloorOhms: number | null;
  };
  engine: {
    simulatedDurationMs: number;
    playbackDurationMs: number;
    timeLapseFactor: number;
    cprBlockMs: number;
    compressionRate: number;
    traditionalShockJ: number;
    adrenalineIntervalMs: number;
    amsaSampleIntervalMs: number;
    conversionThreshold: number;
    cardioversionReserve: number;
    cardioversionSafetyMargin: number;
    disclaimer: string;
  };
  arms: Record<
    "traditional" | "oide",
    {
      result: AclsArmResult;
      events: AclsEvent[];
      amsaTrack: AclsAmsaSample[];
    }
  >;
  comparison: {
    /** Traditional minus OIDE, joules. Positive = OIDE spared energy. */
    jouleDelta: number;
    /** Traditional minus OIDE myocardial injury index. */
    miiDelta: number;
    /** Traditional minus OIDE pre-shock pause accumulation, ms. */
    preShockPauseDeltaMs: number;
    /** OIDE minus traditional survival likelihood, absolute. */
    survivalDelta: number;
    /** Traditional minus OIDE time to conversion, ms; null unless both got there. */
    timeToRoscDeltaMs: number | null;
  };
}

/**
 * Assemble the full dual-arm research bundle.
 *
 * `exportedAt` is a parameter rather than a `Date.now()` call so the bundle is
 * a pure function of its inputs and can be asserted on in a test.
 */
export function buildDualArmExport(input: {
  simId: string;
  patient: PatientParameters;
  assessment: RhythmAssessment;
  traditional: AclsArmTimeline;
  oide: AclsArmTimeline;
  exportedAt: string;
}): DualArmExportBundle {
  const { traditional, oide } = input;
  const plan = generateKkmTimeline(input.patient);
  const bothConverted =
    traditional.result.roscAtMs !== null && oide.result.roscAtMs !== null;

  return {
    formatVersion: 3,
    exportedAt: input.exportedAt,
    simId: input.simId,
    patient: input.patient,
    assessment: input.assessment,
    protocol: {
      family: plan.family,
      guidelineRef: plan.matrix.guidelineRef,
      checklist: plan.notes,
      steps: plan.steps,
      circumstances: input.patient.specialCircumstances ?? [],
      drugIntervalScale: plan.drugIntervalScale,
      cprYieldScale: plan.cprYieldScale,
      shockGate: plan.shockGate,
      impedanceFloorOhms: plan.impedanceFloorOhms,
    },
    engine: {
      simulatedDurationMs: SIMULATED_DURATION_MS,
      playbackDurationMs: PLAYBACK_DURATION_MS,
      timeLapseFactor: TIME_LAPSE_FACTOR,
      cprBlockMs: CPR_BLOCK_MS,
      compressionRate: COMPRESSION_RATE,
      traditionalShockJ: TRADITIONAL_SHOCK_J,
      adrenalineIntervalMs: ADRENALINE_INTERVAL_MS,
      amsaSampleIntervalMs: AMSA_SAMPLE_INTERVAL_MS,
      conversionThreshold: CONVERSION_THRESHOLD,
      cardioversionReserve: CARDIOVERSION_RESERVE,
      cardioversionSafetyMargin: CARDIOVERSION_SAFETY_MARGIN,
      disclaimer:
        "KKM NCORT adult ALS decision matrices with a custom OIDE energy calibration layered on top, for training only. Not a published resuscitation guideline and not a medical device.",
    },
    arms: {
      traditional: {
        result: traditional.result,
        events: traditional.events,
        amsaTrack: traditional.amsaTrack,
      },
      oide: {
        result: oide.result,
        events: oide.events,
        amsaTrack: oide.amsaTrack,
      },
    },
    comparison: {
      jouleDelta:
        traditional.result.cumulativeJoules - oide.result.cumulativeJoules,
      miiDelta:
        traditional.result.myocardialInjuryIndex -
        oide.result.myocardialInjuryIndex,
      preShockPauseDeltaMs:
        traditional.result.totalPreShockPauseMs -
        oide.result.totalPreShockPauseMs,
      survivalDelta:
        oide.result.survivalLikelihood - traditional.result.survivalLikelihood,
      timeToRoscDeltaMs: bothConverted
        ? (traditional.result.roscAtMs ?? 0) - (oide.result.roscAtMs ?? 0)
        : null,
    },
  };
}

/** Arms this workspace runs, in tab order. */
export const PROTOCOL_ARMS: ReadonlyArray<"traditional" | "oide"> = [
  "traditional",
  "oide",
];

export const ARM_LABELS: Record<"traditional" | "oide", string> = {
  traditional: "Traditional KKM ACLS Protocol",
  oide: "OIDE Calibrated Energy Protocol",
};

/** What each arm's energy strategy is, in one line. */
export const ARM_STRATEGY: Record<
  KkmProtocolFamily,
  Record<"traditional" | "oide", string>
> = {
  "cardiac-arrest": {
    traditional: `Fixed ${TRADITIONAL_SHOCK_J} J biphasic · 3–5 min adrenaline · 300/150 mg amiodarone`,
    oide: "TTI + AMSA calibrated joules · shock timing follows the AMSA gate",
  },
  tachycardia: {
    traditional: "Fixed KKM cardioversion ladder, escalating on each failure",
    oide: "TTI-calibrated synchronised energy, sized to convert first pass",
  },
  bradycardia: {
    traditional: "Fixed 80 mA pacing start, dialled up until capture",
    oide: "TTI-calibrated pacing output, sized to capture on the first attempt",
  },
};

/**
 * What a converted run is called under each algorithm.
 *
 * Sentence-initial form, so it reads correctly followed by "achieved" or a
 * timestamp: "ROSC achieved", "Pacing capture at 05:00".
 */
export const CONVERSION_LABEL: Record<KkmProtocolFamily, string> = {
  "cardiac-arrest": "ROSC",
  tachycardia: "Rhythm conversion",
  bradycardia: "Pacing capture",
};

/**
 * Mid-sentence noun form — "no ROSC", "final capture probability".
 *
 * Held separately rather than lower-cased at the call site, because ROSC is an
 * acronym and `"ROSC".toLowerCase()` reads as a typo.
 */
export const CONVERSION_NOUN: Record<KkmProtocolFamily, string> = {
  "cardiac-arrest": "ROSC",
  tachycardia: "conversion",
  bradycardia: "capture",
};

/** Narrow a `ProtocolArm` to the two arms a timeline can be built for. */
export const isRunnableArm = (
  arm: ProtocolArm,
): arm is "traditional" | "oide" => arm === "traditional" || arm === "oide";

/** Re-exported so callers need only one import for the whole model. */
export { kkmMatrixFor as protocolMatrixFor };
