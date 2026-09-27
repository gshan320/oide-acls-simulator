import { SHOCKABLE_RHYTHMS } from "@/types/patient";
import {
  INITIAL_RHYTHM_LABELS,
  SPECIAL_CIRCUMSTANCE_LABELS,
  type InitialRhythm,
  type KkmProtocolFamily,
  type PatientParameters,
  type SpecialCircumstance,
} from "@/types/session";

/**
 * KKM ACLS rules engine.
 *
 * Encodes the adult advanced life support decision matrices of the Ministry of
 * Health Malaysia (KKM) NCORT ALS manual as data, then expands them into an
 * exact, timestamped intervention sequence for a given patient intake profile.
 *
 * Three algorithms are covered, and the presenting rhythm selects between them:
 *
 *   cardiac-arrest  VF / pulseless VT / torsades / PEA / asystole
 *   tachycardia     unstable tachycardia with a pulse, narrow or broad QRS
 *   bradycardia     symptomatic bradycardia
 *
 * Everything here is pure and deterministic: no clock, no DOM, no RNG. The same
 * intake profile always expands to a byte-identical step list, which is what
 * lets the traditional and OIDE arms be compared as a controlled experiment
 * rather than as two independent rolls of the dice.
 *
 * The doses, energies and intervals are the guideline's. The OIDE energy
 * calibration layered on top of them (see `decisionEngine`) is a custom
 * training model, NOT a published guideline. Neither is a medical device.
 */

/* ------------------------------------------------------------------ *
 * Protocol timing — shared by both arms
 * ------------------------------------------------------------------ */

/** Simulated span of a full protocol run. */
export const SIMULATED_DURATION_MS = 20 * 60_000;
/** Real-time span the run is compressed into. */
export const PLAYBACK_DURATION_MS = 60_000;
/** 1 real second = 20 simulated seconds. */
export const TIME_LAPSE_FACTOR = SIMULATED_DURATION_MS / PLAYBACK_DURATION_MS;

/** One uninterrupted CPR block between rhythm checks. */
export const CPR_BLOCK_MS = 120_000;
/** Hands-off interval from "stop compressions" to energy delivery. */
export const RHYTHM_CHECK_TO_SHOCK_MS = 4_000;
/** Delay from delivery back onto the chest. */
export const SHOCK_TO_CPR_MS = 1_000;
/** CPR block + rhythm check + shock + resume. */
export const CYCLE_MS =
  CPR_BLOCK_MS + RHYTHM_CHECK_TO_SHOCK_MS + SHOCK_TO_CPR_MS;

/** KKM high-quality CPR is 100–120/min; 110 sits mid-band. */
export const COMPRESSION_RATE = 110;

/* ------------------------------------------------------------------ *
 * Energy — the one variable the two arms disagree on
 * ------------------------------------------------------------------ */

/** Fixed biphasic defibrillation energy the traditional arm always selects. */
export const TRADITIONAL_SHOCK_J = 200;

/**
 * Synchronised cardioversion rungs, joules.
 *
 * KKM steps the energy up on each failed attempt rather than calibrating it,
 * so a patient whose thorax needs more than the opening rung is shocked twice
 * to get there. Narrow-QRS regular tachycardia opens at 50 J; broad-QRS opens
 * at 100 J because the ventricular mass being depolarised is larger.
 */
export const CARDIOVERSION_LADDER_NARROW_J = [50, 100, 150, 200];
export const CARDIOVERSION_LADDER_BROAD_J = [100, 150, 200, 200];

/**
 * Energy that actually converts an organised tachycardia at nominal 75 Ω, J.
 *
 * The requirement, not a selection: both arms are resolved against it. It is
 * the quantity the OIDE route calibrates towards and the traditional ladder
 * climbs blindly past.
 */
export const CARDIOVERSION_REQUIREMENT_NARROW_J = 70;
export const CARDIOVERSION_REQUIREMENT_BROAD_J = 130;

/** Safety margin OIDE adds over the requirement so attempt 1 converts. */
export const CARDIOVERSION_SAFETY_MARGIN = 1.05;

/** Deliverable synchronised-cardioversion envelope, joules. */
export const CARDIOVERSION_MIN_J = 30;
export const CARDIOVERSION_MAX_J = 200;

/* ------------------------------------------------------------------ *
 * Transcutaneous pacing
 * ------------------------------------------------------------------ */

/** Fixed output the traditional route starts pacing at, mA. */
export const TRADITIONAL_PACE_OUTPUT_MA = 80;
/** Output the traditional route adds on each failed capture check, mA. */
export const PACE_OUTPUT_STEP_MA = 10;
/** How long the traditional route waits before escalating, ms. */
export const PACE_ESCALATION_INTERVAL_MS = 30_000;
/** Ceiling of the pacing envelope, mA. */
export const PACE_OUTPUT_MAX_MA = 200;
/** Output that captures at nominal 75 Ω, mA. */
export const PACE_CAPTURE_REQUIREMENT_MA = 60;
/** Margin OIDE adds so the first calibrated output captures. */
export const PACE_SAFETY_MARGIN = 1.05;
/** Demand rate transcutaneous pacing is set to, bpm. */
export const PACE_RATE_BPM = 70;

/* ------------------------------------------------------------------ *
 * Drug doses and intervals
 * ------------------------------------------------------------------ */

export const ADRENALINE_DOSE_MG = 1;
/** Redose interval — inside the KKM 3–5 minute window. */
export const ADRENALINE_INTERVAL_MS = 240_000;
/** Shockable arrest: after the initial shocks, once IV/IO access is in. */
export const ADRENALINE_FIRST_MS = 180_000;
/** Non-shockable arrest: KKM gives it as soon as access allows. */
export const ADRENALINE_FIRST_NONSHOCKABLE_MS = 60_000;

export const AMIODARONE_ARREST_FIRST_MG = 300;
export const AMIODARONE_ARREST_SECOND_MG = 150;
/** Shock number each arrest amiodarone dose follows. */
export const AMIODARONE_FIRST_AFTER_SHOCK = 3;
export const AMIODARONE_SECOND_AFTER_SHOCK = 5;
/** Bolus is pushed shortly after the shock it follows. */
export const AMIODARONE_DELAY_MS = 20_000;

/** Tachycardia with a pulse: 150 mg over 10 min, repeatable once. */
export const AMIODARONE_TACHY_DOSE_MG = 150;

/** Lignocaine 1–1.5 mg/kg IV; the engine doses at the mid-band. */
export const LIGNOCAINE_DOSE_MG_PER_KG = 1.25;
export const LIGNOCAINE_MAX_SINGLE_DOSE_MG = 100;

export const ADENOSINE_FIRST_DOSE_MG = 6;
export const ADENOSINE_SECOND_DOSE_MG = 12;

/** Magnesium sulphate 2 g for torsades de pointes. */
export const MAGNESIUM_DOSE_MG = 2_000;
/** Given as soon as access allows — it is the reversible cause, not an adjunct. */
export const MAGNESIUM_AT_MS = 60_000;
/** Restoring homogeneous repolarisation lifts AMSA, mV·Hz. */
export const MAGNESIUM_AMSA_GAIN = 1.5;

export const ATROPINE_DOSE_MG = 0.5;
export const ATROPINE_INTERVAL_MS = 180_000;
/** KKM caps the cumulative atropine dose at 3 mg. */
export const ATROPINE_MAX_TOTAL_MG = 3;
export const ATROPINE_MAX_DOSES =
  ATROPINE_MAX_TOTAL_MG / ATROPINE_DOSE_MG;

/* ------------------------------------------------------------------ *
 * Algorithm-specific schedule anchors
 * ------------------------------------------------------------------ */

/** Sedation before a synchronised shock in a conscious patient. */
export const TACHY_SEDATION_MS = 20_000;
export const CARDIOVERSION_FIRST_MS = 45_000;
/** Reassess, add an antiarrhythmic, then re-attempt. */
export const CARDIOVERSION_INTERVAL_MS = 60_000;

export const BRADY_ATROPINE_FIRST_MS = 30_000;
/** Atropine-refractory bradycardia escalates to pacing here. */
export const BRADY_PACING_MS = 300_000;
/** Chronotropic infusion, if pacing is unavailable or ineffective. */
export const BRADY_INFUSION_MS = 480_000;

/* ------------------------------------------------------------------ *
 * Special-circumstance anchors
 * ------------------------------------------------------------------ */

/** Manual left uterine displacement, applied as soon as hands are free. */
export const LUD_AT_MS = 15_000;
/** Perimortem caesarean decision point in a maternal arrest. */
export const PMCD_AT_MS = 240_000;
/** Calcium chloride + bicarbonate in a hyperkalaemic arrest. */
export const HYPERKALEMIA_TREATMENT_AT_MS = 150_000;
/** Opioid antidote. */
export const NALOXONE_AT_MS = 60_000;
/** Lipid rescue for local anaesthetic / lipophilic drug toxicity. */
export const LIPID_EMULSION_AT_MS = 180_000;
/** Active rewarming started in severe hypothermia. */
export const REWARMING_AT_MS = 30_000;
/**
 * "Withhold further shocks until core temperature exceeds 30 °C": the
 * simulated instant rewarming reaches that threshold.
 */
export const REWARM_TARGET_MS = 10 * 60_000;
/** Shocks the hypothermia gate still permits before rewarming. */
export const HYPOTHERMIA_SHOCKS_BEFORE_REWARM = 1;
/** Severe hypothermia halves the metabolism of every drug given. */
export const HYPOTHERMIA_DRUG_INTERVAL_SCALE = 2;
/** Aortocaval decompression restores preload, so compressions do more. */
export const LUD_CPR_YIELD_SCALE = 1.15;
/** Transthoracic impedance a morbidly obese thorax will not read below, Ω. */
export const OBESITY_IMPEDANCE_FLOOR_OHMS = 110;
/** Lipid emulsion bolus volume, mL/kg. */
export const LIPID_EMULSION_ML_PER_KG = 1.5;
/** Restoring myocardial excitability lifts AMSA, mV·Hz. */
export const HYPERKALEMIA_AMSA_GAIN = 1.2;
/** Reversing the toxidrome lifts AMSA, mV·Hz. */
export const ANTIDOTE_AMSA_GAIN = 0.8;

/* ------------------------------------------------------------------ *
 * Matrix shapes
 * ------------------------------------------------------------------ */

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** MM:SS on the simulated clock — the format the event feed prints. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

export type KkmEnergyMode = "defibrillation" | "synchronized-cardioversion";

export interface KkmEnergyLadder {
  mode: KkmEnergyMode;
  /** Fixed rungs the traditional protocol steps through, joules. */
  rungsJ: number[];
  /**
   * Energy that converts this rhythm at nominal 75 Ω, joules — the target the
   * OIDE route calibrates towards. Null for cardiac arrest, where conversion
   * is resolved against AMSA rather than against a fixed requirement.
   */
  conversionRequirementJ: number | null;
}

export interface KkmDrugOrder {
  drugId: string;
  /** Feed line without its timestamp, e.g. "Adrenaline 1 mg IV/IO Push". */
  label: string;
  /** Fixed dose in mg, or null when the dose is weight-based. */
  doseMg: number | null;
  /** mg/kg for a weight-based order. */
  doseMgPerKg: number | null;
  /** Cap applied to a weight-based dose, mg. */
  maxSingleDoseMg: number | null;
  firstAtMs: number;
  /** 0 for a single order. */
  intervalMs: number;
  maxDoses: number;
  /** Cumulative ceiling across every dose, mg. Null for no ceiling. */
  maxTotalMg: number | null;
  /** Withhold until this many shocks have actually been delivered. */
  afterShock?: number;
  /** AMSA the dose buys back, mV·Hz. */
  amsaGain?: number;
  guidelineRef: string;
}

export interface KkmAdjunct {
  id: string;
  label: string;
  atMs: number;
  kind: "pacing" | "adjunct";
  guidelineRef: string;
}

/** One rhythm's complete KKM decision matrix. */
export interface KkmRhythmMatrix {
  rhythm: InitialRhythm;
  family: KkmProtocolFamily;
  label: string;
  /** Unsynchronised defibrillation is indicated. */
  defibrillate: boolean;
  /** Either arm delivers energy — defibrillation or synchronised. */
  deliversEnergy: boolean;
  /** The algorithm runs CPR blocks between rhythm checks. */
  compressions: boolean;
  energy: KkmEnergyLadder | null;
  drugs: KkmDrugOrder[];
  adjuncts: KkmAdjunct[];
  /** The algorithm's own checklist — 4H/4T, or the tachycardia criteria. */
  checklist: string[];
  guidelineRef: string;
}

/* ------------------------------------------------------------------ *
 * Drug order builders
 * ------------------------------------------------------------------ */

const adrenalineArrest = (shockable: boolean): KkmDrugOrder => ({
  drugId: "adrenaline",
  label: `Adrenaline ${ADRENALINE_DOSE_MG} mg IV/IO Push`,
  doseMg: ADRENALINE_DOSE_MG,
  doseMgPerKg: null,
  maxSingleDoseMg: null,
  firstAtMs: shockable
    ? ADRENALINE_FIRST_MS
    : ADRENALINE_FIRST_NONSHOCKABLE_MS,
  intervalMs: ADRENALINE_INTERVAL_MS,
  maxDoses: Math.ceil(SIMULATED_DURATION_MS / ADRENALINE_INTERVAL_MS),
  maxTotalMg: null,
  amsaGain: 1,
  guidelineRef: shockable
    ? "kkm.arrest.shockable.adrenaline"
    : "kkm.arrest.nonshockable.adrenaline",
});

const amiodaroneArrest = (
  doseMg: number,
  afterShock: number,
): KkmDrugOrder => ({
  drugId: "amiodarone",
  label: `Amiodarone ${doseMg} mg IV Bolus (after shock #${afterShock})`,
  doseMg,
  doseMgPerKg: null,
  maxSingleDoseMg: null,
  firstAtMs:
    (afterShock - 1) * CYCLE_MS +
    CPR_BLOCK_MS +
    RHYTHM_CHECK_TO_SHOCK_MS +
    AMIODARONE_DELAY_MS,
  intervalMs: 0,
  maxDoses: 1,
  maxTotalMg: null,
  afterShock,
  guidelineRef: "kkm.arrest.shockable.amiodarone",
});

/* ------------------------------------------------------------------ *
 * The matrices
 * ------------------------------------------------------------------ */

const ARREST_CHECKLIST = [
  "Reversible causes — 4H: hypoxia, hypovolaemia, hypo/hyperkalaemia & metabolic, hypothermia.",
  "Reversible causes — 4T: thrombosis (coronary/pulmonary), tension pneumothorax, tamponade, toxins.",
  "Minimise interruptions: chest compression fraction ≥ 80%, pre-shock pause < 5 s.",
  "Secure the airway and confirm placement with waveform capnography.",
];

function shockableArrestMatrix(rhythm: InitialRhythm): KkmRhythmMatrix {
  return {
    rhythm,
    family: "cardiac-arrest",
    label: INITIAL_RHYTHM_LABELS[rhythm],
    defibrillate: true,
    deliversEnergy: true,
    compressions: true,
    energy: {
      mode: "defibrillation",
      rungsJ: [TRADITIONAL_SHOCK_J],
      conversionRequirementJ: null,
    },
    drugs: [
      adrenalineArrest(true),
      amiodaroneArrest(AMIODARONE_ARREST_FIRST_MG, AMIODARONE_FIRST_AFTER_SHOCK),
      amiodaroneArrest(
        AMIODARONE_ARREST_SECOND_MG,
        AMIODARONE_SECOND_AFTER_SHOCK,
      ),
    ],
    adjuncts: [],
    checklist: [
      `Defibrillate at ${TRADITIONAL_SHOCK_J} J biphasic, then resume compressions immediately.`,
      "Adrenaline 1 mg IV/IO every 3–5 min once access is secured.",
      `Amiodarone ${AMIODARONE_ARREST_FIRST_MG} mg after shock 3 and ${AMIODARONE_ARREST_SECOND_MG} mg after shock 5; lignocaine 1–1.5 mg/kg is the KKM alternative where amiodarone is unavailable.`,
      ...ARREST_CHECKLIST,
    ],
    guidelineRef: "kkm.arrest.shockable",
  };
}

function nonShockableArrestMatrix(rhythm: InitialRhythm): KkmRhythmMatrix {
  return {
    rhythm,
    family: "cardiac-arrest",
    label: INITIAL_RHYTHM_LABELS[rhythm],
    defibrillate: false,
    deliversEnergy: false,
    compressions: true,
    energy: null,
    drugs: [adrenalineArrest(false)],
    adjuncts: [],
    checklist: [
      "Do not defibrillate — there is no fibrillatory waveform to terminate.",
      "Adrenaline 1 mg IV/IO as soon as access allows, then every 3–5 min.",
      "No antiarrhythmic is indicated; outcome turns on finding the reversible cause.",
      ...ARREST_CHECKLIST,
    ],
    guidelineRef: "kkm.arrest.nonshockable",
  };
}

const TACHY_CHECKLIST = [
  "Instability criteria: hypotension, acute altered mental state, ischaemic chest pain, acute heart failure, shock.",
  "Unstable → immediate synchronised cardioversion; sedate first if the patient is conscious.",
  "Identify QRS width and regularity before choosing energy or drug.",
  "Seek expert help and treat the underlying cause once the rate is controlled.",
];

const NARROW_TACHY_MATRIX: KkmRhythmMatrix = {
  rhythm: "svt",
  family: "tachycardia",
  label: INITIAL_RHYTHM_LABELS.svt,
  defibrillate: false,
  deliversEnergy: true,
  compressions: false,
  energy: {
    mode: "synchronized-cardioversion",
    rungsJ: CARDIOVERSION_LADDER_NARROW_J,
    conversionRequirementJ: CARDIOVERSION_REQUIREMENT_NARROW_J,
  },
  drugs: [
    {
      drugId: "adenosine",
      label: `Adenosine ${ADENOSINE_FIRST_DOSE_MG} mg Rapid IV Push (regular monomorphic narrow QRS)`,
      doseMg: ADENOSINE_FIRST_DOSE_MG,
      doseMgPerKg: null,
      maxSingleDoseMg: null,
      firstAtMs: CARDIOVERSION_FIRST_MS + 30_000,
      intervalMs: 0,
      maxDoses: 1,
      maxTotalMg: null,
      afterShock: 1,
      guidelineRef: "kkm.tachy.narrow.adenosine-1",
    },
    {
      drugId: "adenosine",
      label: `Adenosine ${ADENOSINE_SECOND_DOSE_MG} mg Rapid IV Push (second dose)`,
      doseMg: ADENOSINE_SECOND_DOSE_MG,
      doseMgPerKg: null,
      maxSingleDoseMg: null,
      firstAtMs: CARDIOVERSION_FIRST_MS + CARDIOVERSION_INTERVAL_MS + 30_000,
      intervalMs: 0,
      maxDoses: 1,
      maxTotalMg: null,
      afterShock: 2,
      guidelineRef: "kkm.tachy.narrow.adenosine-2",
    },
  ],
  adjuncts: [
    {
      id: "sedation",
      label:
        "Sedation prior to synchronised cardioversion — Midazolam 2.5 mg IV titrated",
      atMs: TACHY_SEDATION_MS,
      kind: "adjunct",
      guidelineRef: "kkm.tachy.sedation",
    },
  ],
  checklist: [
    `Synchronised cardioversion, narrow QRS: ${CARDIOVERSION_LADDER_NARROW_J.join(" → ")} J biphasic.`,
    `Adenosine ${ADENOSINE_FIRST_DOSE_MG} mg then ${ADENOSINE_SECOND_DOSE_MG} mg rapid IV push if the rhythm is regular and monomorphic.`,
    ...TACHY_CHECKLIST,
  ],
  guidelineRef: "kkm.tachy.narrow",
};

const BROAD_TACHY_MATRIX: KkmRhythmMatrix = {
  rhythm: "vtach-with-pulse",
  family: "tachycardia",
  label: INITIAL_RHYTHM_LABELS["vtach-with-pulse"],
  defibrillate: false,
  deliversEnergy: true,
  compressions: false,
  energy: {
    mode: "synchronized-cardioversion",
    rungsJ: CARDIOVERSION_LADDER_BROAD_J,
    conversionRequirementJ: CARDIOVERSION_REQUIREMENT_BROAD_J,
  },
  drugs: [
    {
      drugId: "amiodarone",
      label: `Amiodarone ${AMIODARONE_TACHY_DOSE_MG} mg IV over 10 min`,
      doseMg: AMIODARONE_TACHY_DOSE_MG,
      doseMgPerKg: null,
      maxSingleDoseMg: null,
      firstAtMs: CARDIOVERSION_FIRST_MS + 30_000,
      intervalMs: CARDIOVERSION_INTERVAL_MS,
      // 150 mg, repeatable once — 300 mg before the maintenance infusion.
      maxDoses: 2,
      maxTotalMg: AMIODARONE_TACHY_DOSE_MG * 2,
      afterShock: 1,
      guidelineRef: "kkm.tachy.broad.amiodarone",
    },
    {
      drugId: "lignocaine",
      label: `Lignocaine ${LIGNOCAINE_DOSE_MG_PER_KG} mg/kg IV (1–1.5 mg/kg — amiodarone alternative)`,
      doseMg: null,
      doseMgPerKg: LIGNOCAINE_DOSE_MG_PER_KG,
      maxSingleDoseMg: LIGNOCAINE_MAX_SINGLE_DOSE_MG,
      firstAtMs:
        CARDIOVERSION_FIRST_MS + 2 * CARDIOVERSION_INTERVAL_MS + 30_000,
      intervalMs: 0,
      maxDoses: 1,
      maxTotalMg: null,
      afterShock: 3,
      guidelineRef: "kkm.tachy.broad.lignocaine",
    },
  ],
  adjuncts: [
    {
      id: "sedation",
      label:
        "Sedation prior to synchronised cardioversion — Midazolam 2.5 mg IV titrated",
      atMs: TACHY_SEDATION_MS,
      kind: "adjunct",
      guidelineRef: "kkm.tachy.sedation",
    },
  ],
  checklist: [
    `Synchronised cardioversion, broad QRS: ${CARDIOVERSION_LADDER_BROAD_J.join(" → ")} J biphasic.`,
    `Amiodarone ${AMIODARONE_TACHY_DOSE_MG} mg IV over 10 min, repeatable once to ${AMIODARONE_TACHY_DOSE_MG * 2} mg, then 1 mg/min maintenance infusion for 6 h.`,
    "Lignocaine 1–1.5 mg/kg IV is the alternative antiarrhythmic.",
    "If the QRS is polymorphic rather than monomorphic this is torsades — select that presentation instead: magnesium replaces amiodarone and the shock is unsynchronised.",
    ...TACHY_CHECKLIST,
  ],
  guidelineRef: "kkm.tachy.broad",
};

/**
 * Torsades de pointes — sustained polymorphic VT.
 *
 * Handled under the arrest algorithm, not the tachycardia one, because that is
 * what it is: `SHOCKABLE_RHYTHMS` contains it and `PERFUSING_RHYTHMS` does not,
 * so the signal worker already draws it in the arrest perfusion regime — flat
 * pleth, 7 mmHg EtCO₂. It carries a genuine fibrillatory waveform, so AMSA is
 * measurable and conversion resolves against it exactly as it does for VF.
 *
 * Two things make it its own branch rather than a relabelled VF:
 * magnesium is the specific treatment, and amiodarone is *withheld* — the
 * antiarrhythmic the other shockable rhythms get would prolong the QT interval
 * that caused this rhythm in the first place.
 */
const TORSADES_MATRIX: KkmRhythmMatrix = {
  rhythm: "torsades",
  family: "cardiac-arrest",
  label: INITIAL_RHYTHM_LABELS.torsades,
  defibrillate: true,
  deliversEnergy: true,
  compressions: true,
  energy: {
    mode: "defibrillation",
    rungsJ: [TRADITIONAL_SHOCK_J],
    conversionRequirementJ: null,
  },
  drugs: [
    adrenalineArrest(true),
    {
      drugId: "magnesium-sulphate",
      label: `Magnesium Sulphate ${MAGNESIUM_DOSE_MG / 1000} g IV/IO Push (torsades — specific treatment)`,
      doseMg: MAGNESIUM_DOSE_MG,
      doseMgPerKg: null,
      maxSingleDoseMg: null,
      // Time-critical: this is the reversible cause, not an adjunct.
      firstAtMs: MAGNESIUM_AT_MS,
      intervalMs: 0,
      maxDoses: 1,
      maxTotalMg: null,
      amsaGain: MAGNESIUM_AMSA_GAIN,
      guidelineRef: "kkm.arrest.torsades.magnesium",
    },
  ],
  adjuncts: [],
  checklist: [
    `Magnesium sulphate ${MAGNESIUM_DOSE_MG / 1000} g IV/IO is the specific treatment — give it early, it is the reversible cause.`,
    `Defibrillate at ${TRADITIONAL_SHOCK_J} J biphasic, unsynchronised: polymorphic VT has no consistent R wave to synchronise to.`,
    "Amiodarone is withheld — it prolongs the QT interval that produced this rhythm. This is the one shockable arrest where the standard antiarrhythmic is contraindicated.",
    "Stop every QT-prolonging drug and correct potassium, magnesium and calcium.",
    ...ARREST_CHECKLIST,
  ],
  guidelineRef: "kkm.arrest.torsades",
};

const BRADY_MATRIX: KkmRhythmMatrix = {
  rhythm: "sinus-bradycardia",
  family: "bradycardia",
  label: INITIAL_RHYTHM_LABELS["sinus-bradycardia"],
  defibrillate: false,
  deliversEnergy: false,
  compressions: false,
  energy: null,
  drugs: [
    {
      drugId: "atropine",
      label: `Atropine ${ATROPINE_DOSE_MG} mg IV`,
      doseMg: ATROPINE_DOSE_MG,
      doseMgPerKg: null,
      maxSingleDoseMg: null,
      firstAtMs: BRADY_ATROPINE_FIRST_MS,
      intervalMs: ATROPINE_INTERVAL_MS,
      maxDoses: ATROPINE_MAX_DOSES,
      maxTotalMg: ATROPINE_MAX_TOTAL_MG,
      guidelineRef: "kkm.brady.atropine",
    },
    {
      drugId: "adrenaline-infusion",
      label:
        "Adrenaline infusion 2–10 mcg/min IV titrated to response (alternative: Dopamine 5–20 mcg/kg/min)",
      doseMg: null,
      doseMgPerKg: null,
      maxSingleDoseMg: null,
      firstAtMs: BRADY_INFUSION_MS,
      intervalMs: 0,
      maxDoses: 1,
      maxTotalMg: null,
      guidelineRef: "kkm.brady.chronotrope",
    },
  ],
  adjuncts: [
    {
      id: "pacing",
      label: `Transcutaneous Pacing — demand mode at ${PACE_RATE_BPM}/min`,
      atMs: BRADY_PACING_MS,
      kind: "pacing",
      guidelineRef: "kkm.brady.pacing",
    },
  ],
  checklist: [
    `Atropine ${ATROPINE_DOSE_MG} mg IV, repeated every 3–5 min to a maximum of ${ATROPINE_MAX_TOTAL_MG} mg.`,
    "If atropine is ineffective: transcutaneous pacing, or adrenaline 2–10 mcg/min, or dopamine 5–20 mcg/kg/min.",
    "Atropine is unreliable in high-degree AV block and after cardiac transplant — do not delay pacing for it.",
    "Look for hypoxia, drugs (beta blocker, calcium channel blocker, digoxin), hyperkalaemia and inferior MI.",
  ],
  guidelineRef: "kkm.brady",
};

/** Every encoded matrix, keyed by the rhythm it applies to. */
export const KKM_RHYTHM_MATRICES: Record<InitialRhythm, KkmRhythmMatrix> = {
  vfib: shockableArrestMatrix("vfib"),
  "vfib-fine": shockableArrestMatrix("vfib-fine"),
  "vtach-pulseless": shockableArrestMatrix("vtach-pulseless"),
  torsades: TORSADES_MATRIX,
  pea: nonShockableArrestMatrix("pea"),
  asystole: nonShockableArrestMatrix("asystole"),
  svt: NARROW_TACHY_MATRIX,
  "vtach-with-pulse": BROAD_TACHY_MATRIX,
  "sinus-bradycardia": BRADY_MATRIX,
};

export function kkmMatrixFor(rhythm: InitialRhythm): KkmRhythmMatrix {
  return KKM_RHYTHM_MATRICES[rhythm];
}

export function protocolFamilyFor(rhythm: InitialRhythm): KkmProtocolFamily {
  return KKM_RHYTHM_MATRICES[rhythm].family;
}

/* ------------------------------------------------------------------ *
 * Special circumstances
 * ------------------------------------------------------------------ */

/** A timed line the circumstance injects into the sequence. */
export interface KkmCircumstanceStep {
  atMs: number;
  label: string;
  /** AMSA the intervention buys back, mV·Hz. */
  amsaGain?: number;
  guidelineRef: string;
}

export interface KkmCircumstanceModifier {
  circumstance: SpecialCircumstance;
  label: string;
  /** Multiplies every drug repeat interval — hypothermia doubles them. */
  drugIntervalScale: number;
  /** Shocks are withheld between `shocksAllowedBefore` and this instant. */
  shockGateFromMs: number;
  shocksAllowedBefore: number;
  /** Multiplies the AMSA yield of every minute of compressions. */
  cprYieldScale: number;
  /** Transthoracic impedance the thorax will not read below, Ω. */
  impedanceFloorOhms: number | null;
  steps: KkmCircumstanceStep[];
  notes: string[];
}

/**
 * Expand one special circumstance into its KKM modification.
 *
 * `weightKg` is a parameter because two of the modifications are weight-based:
 * the lipid emulsion bolus volume, and the note about chest wall depth.
 */
export function circumstanceModifier(
  circumstance: SpecialCircumstance,
  weightKg: number,
): KkmCircumstanceModifier {
  const label = SPECIAL_CIRCUMSTANCE_LABELS[circumstance];

  switch (circumstance) {
    case "pregnancy":
      return {
        circumstance,
        label,
        drugIntervalScale: 1,
        shockGateFromMs: 0,
        shocksAllowedBefore: 0,
        cprYieldScale: LUD_CPR_YIELD_SCALE,
        impedanceFloorOhms: null,
        steps: [
          {
            atMs: LUD_AT_MS,
            label: "Manual Left Uterine Displacement (LUD) Applied",
            guidelineRef: "kkm.special.pregnancy.lud",
          },
          {
            atMs: PMCD_AT_MS,
            label:
              "Perimortem Caesarean Delivery team activated — deliver by 5 min if no ROSC",
            guidelineRef: "kkm.special.pregnancy.pmcd",
          },
        ],
        notes: [
          "Hands are placed 2–3 cm higher on the sternum; LUD relieves aortocaval compression without tilting the thorax.",
          "Defibrillation energy is unchanged in pregnancy — remove foetal monitors before delivering.",
        ],
      };

    case "hypothermia":
      return {
        circumstance,
        label,
        drugIntervalScale: HYPOTHERMIA_DRUG_INTERVAL_SCALE,
        shockGateFromMs: REWARM_TARGET_MS,
        shocksAllowedBefore: HYPOTHERMIA_SHOCKS_BEFORE_REWARM,
        cprYieldScale: 1,
        impedanceFloorOhms: null,
        steps: [
          {
            atMs: REWARMING_AT_MS,
            label:
              "Active rewarming commenced — warmed humidified O₂ and warm IV fluids; further shocks withheld until core > 30 °C",
            guidelineRef: "kkm.special.hypothermia.rewarm",
          },
          {
            atMs: REWARM_TARGET_MS,
            label:
              "Core temperature above 30 °C — shock delivery and normal drug intervals resumed",
            guidelineRef: "kkm.special.hypothermia.rewarmed",
          },
        ],
        notes: [
          `Drug intervals are doubled: a cold myocardium clears nothing at the usual rate (×${HYPOTHERMIA_DRUG_INTERVAL_SCALE}).`,
          `Shock delivery is limited to ${HYPOTHERMIA_SHOCKS_BEFORE_REWARM} attempt below 30 °C; a cold heart is refractory until rewarmed.`,
          "The patient is not dead until warm and dead — continue CPR through rewarming.",
        ],
      };

    case "hyperkalemia":
      return {
        circumstance,
        label,
        drugIntervalScale: 1,
        shockGateFromMs: 0,
        shocksAllowedBefore: 0,
        cprYieldScale: 1,
        impedanceFloorOhms: null,
        steps: [
          {
            atMs: HYPERKALEMIA_TREATMENT_AT_MS,
            label:
              "Calcium Chloride 1g IV Push + Sodium Bicarbonate 50mEq",
            amsaGain: HYPERKALEMIA_AMSA_GAIN,
            guidelineRef: "kkm.special.hyperkalemia.membrane",
          },
        ],
        notes: [
          "Calcium stabilises the myocardial membrane; bicarbonate and insulin-dextrose shift potassium intracellularly.",
          "Arrange urgent haemodialysis — the shift buys time, it does not remove the load.",
        ],
      };

    case "toxicological":
      return {
        circumstance,
        label,
        drugIntervalScale: 1,
        shockGateFromMs: 0,
        shocksAllowedBefore: 0,
        cprYieldScale: 1,
        impedanceFloorOhms: null,
        steps: [
          {
            atMs: NALOXONE_AT_MS,
            label: "Naloxone 2 mg IV/IO Push (suspected opioid toxicity)",
            amsaGain: ANTIDOTE_AMSA_GAIN,
            guidelineRef: "kkm.special.toxic.naloxone",
          },
          {
            atMs: LIPID_EMULSION_AT_MS,
            label: `Intralipid 20% ${Math.round(
              LIPID_EMULSION_ML_PER_KG * Math.max(0, weightKg),
            )} mL IV bolus (${LIPID_EMULSION_ML_PER_KG} mL/kg lipid rescue)`,
            amsaGain: ANTIDOTE_AMSA_GAIN,
            guidelineRef: "kkm.special.toxic.lipid-emulsion",
          },
        ],
        notes: [
          "Antidote is the definitive treatment: naloxone for opioids, lipid emulsion for local anaesthetic and lipophilic toxicity.",
          "Prolonged resuscitation is justified — the toxin is metabolised while the circulation is supported.",
        ],
      };

    case "morbid-obesity":
      return {
        circumstance,
        label,
        drugIntervalScale: 1,
        shockGateFromMs: 0,
        shocksAllowedBefore: 0,
        cprYieldScale: 1,
        impedanceFloorOhms: OBESITY_IMPEDANCE_FLOOR_OHMS,
        steps: [
          {
            atMs: 5_000,
            label: `High transthoracic impedance expected — pads in anteroposterior position, impedance floored at ${OBESITY_IMPEDANCE_FLOOR_OHMS} Ω`,
            guidelineRef: "kkm.special.obesity.pads",
          },
        ],
        notes: [
          `Transthoracic impedance is floored at ${OBESITY_IMPEDANCE_FLOOR_OHMS} Ω: a fixed ${TRADITIONAL_SHOCK_J} J selection delivers less transmyocardial current through a deeper thorax.`,
          "This is the case the impedance term of the OIDE calculation exists for.",
        ],
      };
  }
}

/** Every circumstance on the intake profile, deduplicated and ordered. */
export function circumstanceModifiers(
  params: PatientParameters,
): KkmCircumstanceModifier[] {
  const selected = new Set(params.specialCircumstances ?? []);
  return (Object.keys(SPECIAL_CIRCUMSTANCE_LABELS) as SpecialCircumstance[])
    .filter((circumstance) => selected.has(circumstance))
    .map((circumstance) => circumstanceModifier(circumstance, params.weightKg));
}

/* ------------------------------------------------------------------ *
 * Expanded step list
 * ------------------------------------------------------------------ */

export type KkmStepKind =
  | "assessment"
  | "cpr-start"
  | "rhythm-check"
  | "shock"
  | "drug"
  | "pacing"
  | "adjunct";

/** One instruction of the expanded sequence, on the simulated clock. */
export interface KkmStep {
  atMs: number;
  kind: KkmStepKind;
  /** Feed line without its timestamp. */
  label: string;
  guidelineRef: string;
  /** Traditional fixed energy for this rung, joules. Shock steps only. */
  rungJoules?: number;
  /** True when the shock is synchronised to the R wave. */
  synchronised?: boolean;
  /** 1-based position on the energy ladder. Shock steps only. */
  ladderIndex?: number;
  drugId?: string;
  doseMg?: number;
  /** Withhold until this many shocks have actually been delivered. */
  afterShock?: number;
  /** AMSA the step buys back, mV·Hz. */
  amsaGain?: number;
}

/** Shocks withheld between the first few attempts and a rewarming target. */
export interface KkmShockGate {
  fromMs: number;
  shocksAllowedBefore: number;
}

export interface KkmProtocolPlan {
  family: KkmProtocolFamily;
  matrix: KkmRhythmMatrix;
  /** Ordered, deterministic instruction sequence. */
  steps: KkmStep[];
  modifiers: KkmCircumstanceModifier[];
  /** Product of every circumstance's drug-interval multiplier. */
  drugIntervalScale: number;
  /** Product of every circumstance's compression-yield multiplier. */
  cprYieldScale: number;
  shockGate: KkmShockGate;
  /** Highest impedance floor any circumstance imposes, Ω. Null if none. */
  impedanceFloorOhms: number | null;
  /** Guideline checklist plus every circumstance note, for the assessment card. */
  notes: string[];
}

/**
 * Stable ordering within one instant: stop compressions, deliver, resume, then
 * give drugs. Assessment lines lead; adjuncts trail.
 */
const STEP_RANK: Record<KkmStepKind, number> = {
  assessment: -1,
  "rhythm-check": 0,
  shock: 1,
  "cpr-start": 2,
  pacing: 3,
  drug: 4,
  adjunct: 5,
};

/** Expand one drug order into its individual dose steps. */
function expandDrugOrder(
  order: KkmDrugOrder,
  weightKg: number,
  intervalScale: number,
): KkmStep[] {
  const steps: KkmStep[] = [];
  const interval = order.intervalMs * intervalScale;

  const singleDoseMg =
    order.doseMg ??
    (order.doseMgPerKg === null
      ? null
      : Math.min(
          order.maxSingleDoseMg ?? Number.POSITIVE_INFINITY,
          Math.round(order.doseMgPerKg * Math.max(0, weightKg)),
        ));

  let givenMg = 0;

  for (let dose = 0; dose < order.maxDoses; dose++) {
    const atMs = order.firstAtMs + dose * interval;
    if (atMs > SIMULATED_DURATION_MS) break;
    // A single order (interval 0) must not stack every dose on one instant.
    if (dose > 0 && interval === 0) break;
    if (
      order.maxTotalMg !== null &&
      singleDoseMg !== null &&
      givenMg + singleDoseMg > order.maxTotalMg
    ) {
      break;
    }
    if (singleDoseMg !== null) givenMg += singleDoseMg;

    const label =
      order.maxTotalMg !== null && singleDoseMg !== null && order.maxDoses > 1
        ? `${order.label} — cumulative ${round1(givenMg)} of ${order.maxTotalMg} mg`
        : order.label;

    steps.push({
      atMs,
      kind: "drug",
      label,
      guidelineRef: order.guidelineRef,
      drugId: order.drugId,
      ...(singleDoseMg === null ? {} : { doseMg: singleDoseMg }),
      ...(order.afterShock === undefined
        ? {}
        : { afterShock: order.afterShock }),
      ...(order.amsaGain === undefined ? {} : { amsaGain: order.amsaGain }),
    });
  }

  return steps;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** CPR blocks, rhythm checks and defibrillation attempts. */
function arrestSteps(matrix: KkmRhythmMatrix): KkmStep[] {
  const steps: KkmStep[] = [];
  const cycles = Math.floor(SIMULATED_DURATION_MS / CYCLE_MS);
  let ladderIndex = 0;

  for (let cycle = 0; cycle < cycles; cycle++) {
    const base = cycle * CYCLE_MS;
    steps.push({
      atMs: base,
      kind: "cpr-start",
      label: `CPR (${COMPRESSION_RATE} CPM)`,
      guidelineRef: `${matrix.guidelineRef}.cpr`,
    });
    steps.push({
      atMs: base + CPR_BLOCK_MS,
      kind: "rhythm-check",
      label: "Rhythm Check",
      guidelineRef: `${matrix.guidelineRef}.rhythm-check`,
    });

    if (matrix.energy !== null && matrix.defibrillate) {
      ladderIndex += 1;
      steps.push({
        atMs: base + CPR_BLOCK_MS + RHYTHM_CHECK_TO_SHOCK_MS,
        kind: "shock",
        label: "Defibrillate",
        guidelineRef: `${matrix.guidelineRef}.shock`,
        rungJoules: rungFor(matrix.energy, ladderIndex),
        synchronised: false,
        ladderIndex,
      });
    }
  }

  return steps;
}

/** Sedation, then the synchronised cardioversion ladder. */
function tachycardiaSteps(matrix: KkmRhythmMatrix): KkmStep[] {
  const steps: KkmStep[] = [
    {
      atMs: 0,
      kind: "assessment",
      label:
        "Unstable tachycardia with a pulse — O₂, IV access, 12-lead ECG, continuous monitoring",
      guidelineRef: `${matrix.guidelineRef}.assess`,
    },
  ];

  const ladder = matrix.energy;
  if (ladder === null) return steps;

  for (let attempt = 1; attempt <= ladder.rungsJ.length; attempt++) {
    const atMs =
      CARDIOVERSION_FIRST_MS + (attempt - 1) * CARDIOVERSION_INTERVAL_MS;
    if (atMs > SIMULATED_DURATION_MS) break;

    steps.push({
      atMs,
      kind: "shock",
      label:
        ladder.mode === "synchronized-cardioversion"
          ? "Synchronised Cardioversion"
          : "Defibrillate (unsynchronised — polymorphic)",
      guidelineRef: `${matrix.guidelineRef}.cardiovert`,
      rungJoules: rungFor(ladder, attempt),
      synchronised: ladder.mode === "synchronized-cardioversion",
      ladderIndex: attempt,
    });
  }

  return steps;
}

/** Atropine, then transcutaneous pacing, then a chronotropic infusion. */
function bradycardiaSteps(matrix: KkmRhythmMatrix): KkmStep[] {
  return [
    {
      atMs: 0,
      kind: "assessment",
      label:
        "Symptomatic bradycardia — O₂, IV access, 12-lead ECG, identify the block",
      guidelineRef: `${matrix.guidelineRef}.assess`,
    },
  ];
}

/** Energy at one rung, repeating the top rung once the ladder is exhausted. */
export function rungFor(ladder: KkmEnergyLadder, ladderIndex: number): number {
  const index = clamp(ladderIndex - 1, 0, ladder.rungsJ.length - 1);
  return ladder.rungsJ[index];
}

/**
 * Expand an intake profile into the exact KKM intervention sequence.
 *
 * The returned steps are what *both* arms execute; the arms differ only in the
 * energy (or pacing output) each shock step delivers, which is resolved later
 * by the simulation engine against the OIDE calibration.
 */
export function generateKkmTimeline(
  params: PatientParameters,
): KkmProtocolPlan {
  const matrix = kkmMatrixFor(params.initialRhythm);
  const modifiers = circumstanceModifiers(params);

  const drugIntervalScale = modifiers.reduce(
    (scale, modifier) => scale * modifier.drugIntervalScale,
    1,
  );
  const cprYieldScale = modifiers.reduce(
    (scale, modifier) => scale * modifier.cprYieldScale,
    1,
  );
  const impedanceFloorOhms = modifiers.reduce<number | null>(
    (floor, modifier) =>
      modifier.impedanceFloorOhms === null
        ? floor
        : Math.max(floor ?? 0, modifier.impedanceFloorOhms),
    null,
  );

  // The strictest gate wins: the latest resume instant, on the fewest shocks.
  const gated = modifiers.filter((modifier) => modifier.shockGateFromMs > 0);
  const shockGate: KkmShockGate = {
    fromMs: gated.reduce(
      (latest, modifier) => Math.max(latest, modifier.shockGateFromMs),
      0,
    ),
    shocksAllowedBefore:
      gated.length === 0
        ? Number.POSITIVE_INFINITY
        : gated.reduce(
            (fewest, modifier) =>
              Math.min(fewest, modifier.shocksAllowedBefore),
            Number.POSITIVE_INFINITY,
          ),
  };

  const structural =
    matrix.family === "cardiac-arrest"
      ? arrestSteps(matrix)
      : matrix.family === "tachycardia"
        ? tachycardiaSteps(matrix)
        : bradycardiaSteps(matrix);

  const drugSteps = matrix.drugs.flatMap((order) =>
    expandDrugOrder(order, params.weightKg, drugIntervalScale),
  );

  const adjunctSteps: KkmStep[] = matrix.adjuncts
    .filter((adjunct) => adjunct.atMs <= SIMULATED_DURATION_MS)
    .map((adjunct) => ({
      atMs: adjunct.atMs,
      kind: adjunct.kind,
      label: adjunct.label,
      guidelineRef: adjunct.guidelineRef,
    }));

  const circumstanceSteps: KkmStep[] = modifiers.flatMap((modifier) =>
    modifier.steps
      .filter((step) => step.atMs <= SIMULATED_DURATION_MS)
      .map((step) => ({
        atMs: step.atMs,
        kind: "adjunct" as const,
        label: step.label,
        guidelineRef: step.guidelineRef,
        ...(step.amsaGain === undefined ? {} : { amsaGain: step.amsaGain }),
      })),
  );

  const steps = [
    ...structural,
    ...drugSteps,
    ...adjunctSteps,
    ...circumstanceSteps,
  ]
    .filter((step) => step.atMs <= SIMULATED_DURATION_MS)
    // Array#sort is stable, so equal instants keep the order they were pushed
    // in: structural first, then drugs in matrix order.
    .sort((a, b) => a.atMs - b.atMs || STEP_RANK[a.kind] - STEP_RANK[b.kind]);

  return {
    family: matrix.family,
    matrix,
    steps,
    modifiers,
    drugIntervalScale,
    cprYieldScale,
    shockGate,
    impedanceFloorOhms,
    notes: [
      ...matrix.checklist,
      ...modifiers.flatMap((modifier) => [
        `${modifier.label}: ${modifier.notes[0]}`,
        ...modifier.notes.slice(1),
      ]),
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Energy and pacing calibration
 * ------------------------------------------------------------------ */

/**
 * Energy that converts this rhythm through *this* thorax, joules.
 *
 * The requirement scales with transthoracic impedance because it is
 * transmyocardial current, not delivered joules, that depolarises myocardium.
 */
export function cardioversionRequirementJoules(
  ladder: KkmEnergyLadder,
  impedanceOhms: number,
): number {
  const base = ladder.conversionRequirementJ;
  if (base === null || !(base > 0)) return 0;
  return Math.round((base * impedanceOhms) / 75);
}

/** OIDE's synchronised selection: the requirement plus its safety margin. */
export function calibratedCardioversionJoules(
  ladder: KkmEnergyLadder,
  impedanceOhms: number,
): number {
  const requirement = cardioversionRequirementJoules(ladder, impedanceOhms);
  if (requirement <= 0) return 0;
  return Math.round(
    clamp(
      requirement * CARDIOVERSION_SAFETY_MARGIN,
      CARDIOVERSION_MIN_J,
      CARDIOVERSION_MAX_J,
    ),
  );
}

/** Transcutaneous output that captures through this thorax, mA. */
export function paceCaptureRequirementMa(impedanceOhms: number): number {
  return Math.round((PACE_CAPTURE_REQUIREMENT_MA * impedanceOhms) / 75);
}

/** OIDE's pacing selection: the capture requirement plus its safety margin. */
export function calibratedPaceOutputMa(impedanceOhms: number): number {
  return Math.round(
    clamp(
      paceCaptureRequirementMa(impedanceOhms) * PACE_SAFETY_MARGIN,
      PACE_OUTPUT_STEP_MA,
      PACE_OUTPUT_MAX_MA,
    ),
  );
}

/**
 * Traditional pacing output after `escalations` failed capture checks, mA.
 * KKM turns the dial up until capture; the dial starts at a fixed 80 mA.
 */
export function traditionalPaceOutputMa(escalations: number): number {
  return Math.min(
    PACE_OUTPUT_MAX_MA,
    TRADITIONAL_PACE_OUTPUT_MA + Math.max(0, escalations) * PACE_OUTPUT_STEP_MA,
  );
}

/** Whether a shock at this instant is permitted by the hypothermia gate. */
export function shockPermitted(
  gate: KkmShockGate,
  shocksAlreadyDelivered: number,
  atMs: number,
): boolean {
  if (gate.fromMs <= 0) return true;
  if (shocksAlreadyDelivered < gate.shocksAllowedBefore) return true;
  return atMs >= gate.fromMs;
}

/** Rhythms the intake form offers, grouped by the algorithm they route to. */
export const KKM_INTAKE_GROUPS: ReadonlyArray<{
  family: KkmProtocolFamily;
  label: string;
  hint: string;
  rhythms: InitialRhythm[];
}> = [
  {
    family: "cardiac-arrest",
    label: "Cardiac arrest — shockable",
    hint: "Defibrillation indicated; both energy routes deliver. Torsades adds magnesium and withholds amiodarone.",
    rhythms: ["vfib", "vfib-fine", "vtach-pulseless", "torsades"],
  },
  {
    family: "cardiac-arrest",
    label: "Cardiac arrest — non-shockable",
    hint: "No fibrillatory waveform; neither route delivers energy.",
    rhythms: ["pea", "asystole"],
  },
  {
    family: "tachycardia",
    label: "Tachycardia with a pulse (unstable)",
    hint: "Synchronised cardioversion after sedation; energy differs by QRS width.",
    rhythms: ["vtach-with-pulse", "svt"],
  },
  {
    family: "bradycardia",
    label: "Bradycardia",
    hint: "Atropine, then transcutaneous pacing or a chronotropic infusion.",
    rhythms: ["sinus-bradycardia"],
  },
];

/** True when the presentation is a cardiac arrest with a fibrillatory waveform. */
export const isDefibrillatable = (rhythm: InitialRhythm): boolean =>
  SHOCKABLE_RHYTHMS.has(rhythm);
