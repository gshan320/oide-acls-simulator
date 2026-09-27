import type { AclsRhythm } from "./patient";

/**
 * Sprint-3 Firestore schema.
 *
 *   Simulations/{simId}                    root session document
 *   Simulations/{simId}/Interventions/{id} learner actions, append-only
 *   Simulations/{simId}/AmsaLogs/{id}      1 Hz decision-engine timepoints
 */

/**
 * Presentations a scenario can open on.
 *
 * All three KKM adult ALS algorithms are represented, because the assessment
 * gate has to be able to route between them: the arrest algorithm (shockable
 * and non-shockable halves), tachycardia with a pulse, and symptomatic
 * bradycardia.
 */
export type InitialRhythm = Extract<
  AclsRhythm,
  | "vfib"
  | "vfib-fine"
  | "vtach-pulseless"
  | "torsades"
  | "pea"
  | "asystole"
  | "vtach-with-pulse"
  | "svt"
  | "sinus-bradycardia"
>;

export const INITIAL_RHYTHM_LABELS: Record<InitialRhythm, string> = {
  vfib: "Coarse VFib",
  "vfib-fine": "Fine VFib",
  "vtach-pulseless": "Pulseless VT",
  torsades: "Torsades de Pointes",
  pea: "PEA",
  asystole: "Asystole",
  "vtach-with-pulse": "Unstable Tachycardia — Broad QRS",
  svt: "Unstable Tachycardia — Narrow QRS",
  "sinus-bradycardia": "Symptomatic Bradycardia",
};

/** Which KKM adult ALS algorithm a presentation is handled under. */
export type KkmProtocolFamily =
  | "cardiac-arrest"
  | "tachycardia"
  | "bradycardia";

/**
 * ACLS special circumstances the KKM manual carries dedicated modifications
 * for. Multi-select: a pregnant dialysis patient in a cold water immersion
 * arrest is one patient, not three scenarios.
 */
export type SpecialCircumstance =
  | "pregnancy"
  | "hypothermia"
  | "hyperkalemia"
  | "toxicological"
  | "morbid-obesity";

export const SPECIAL_CIRCUMSTANCES: ReadonlyArray<SpecialCircumstance> = [
  "pregnancy",
  "hypothermia",
  "hyperkalemia",
  "toxicological",
  "morbid-obesity",
];

export const SPECIAL_CIRCUMSTANCE_LABELS: Record<SpecialCircumstance, string> =
  {
    pregnancy: "Pregnancy (maternal arrest)",
    hypothermia: "Severe hypothermia (< 30 °C)",
    hyperkalemia: "Hyperkalemia / severe renal failure",
    toxicological: "Toxicological overdose",
    "morbid-obesity": "Morbid obesity (high TTI)",
  };

export interface Comorbidities {
  ischemicHeartDisease: boolean;
  previousMi: boolean;
}

/** Everything the setup form collects. */
export interface PatientParameters {
  /** Human-readable, de-identified reference, e.g. "OIDE-7K3F-2M9Q". */
  referenceId: string;
  ageYears: number;
  weightKg: number;
  /** 40–150 Ω. Feeds Impedance_Correction in the OIDE energy calculation. */
  transthoracicImpedanceOhms: number;
  /** Minutes of arrest before any CPR; seeds the starting AMSA decay state. */
  timeDownWithoutCprMinutes: number;
  initialRhythm: InitialRhythm;
  comorbidities: Comorbidities;
  /**
   * Optional in the type so a session document written before the field
   * existed still parses; every reader treats a missing value as `[]`.
   */
  specialCircumstances?: SpecialCircumstance[];
}

export type SimulationSessionStatus = "active" | "completed" | "aborted";

/** Root document at Simulations/{simId}. */
export interface SimulationSessionDoc {
  simId: string;
  patient: PatientParameters;
  status: SimulationSessionStatus;
  /** Client clock, ms. `createdAt` below is the authoritative server stamp. */
  startedAtMs: number;
  outcome: SimulationOutcome | null;
}

export type InterventionType =
  | "cpr-started"
  | "cpr-stopped"
  | "shock-delivered"
  | "shock-deferred"
  | "drug-administered"
  | "airway-secured"
  | "access-obtained"
  | "rhythm-check"
  /** Capacitor charge started, carrying the target energy in `joules`. */
  | "device_charge"
  /** Capacitor bled off after 15 s armed without delivery — team hesitation. */
  | "device_auto_disarm"
  /** Transcutaneous pacing started, or its output escalated. */
  | "pacing-started"
  /** Electrical and mechanical capture confirmed. */
  | "pacing-capture"
  /** A special-circumstance or supportive measure: LUD, rewarming, sedation. */
  | "adjunct-applied"
  /** A shock converted the rhythm; the arm's sequence stops here. */
  | "rosc"
  /** The arm's automated sequence finished, by ROSC or by protocol timeout. */
  | "sequence-end";

/**
 * Which protocol arm produced the action.
 * `shared` covers changes to the patient that neither arm owns exclusively.
 */
export type ProtocolArm = "traditional" | "oide" | "shared";

/** One document in Simulations/{simId}/Interventions. */
export interface InterventionPayload {
  type: InterventionType;
  arm: ProtocolArm;
  /** ms since simulation start — the debrief timeline axis. */
  offsetMs: number;
  /** Joules actually delivered; only meaningful for shock-delivered. */
  joules?: number;
  /**
   * Hands-off time immediately preceding this shock, ms. Recorded per shock so
   * the debrief can attribute pause cost to the arm that caused it.
   */
  preShockPauseMs?: number;
  /** AMSA at the moment of the action, for post-hoc correlation. */
  amsaAtTime?: number;
  /** What OIDE would have recommended at this moment — the MII baseline. */
  oideOptimalJoules?: number;
  /**
   * Defibrillation efficacy this shock was resolved against, 0–1 — the product
   * of myocardial reserve (from AMSA) and how well the delivered energy matched
   * the calibrated optimum.
   */
  roscProbability?: number;
  /** Whether this shock converted the rhythm. */
  roscAchieved?: boolean;
  drugId?: string;
  doseMg?: number;
  /** Transcutaneous pacing output, mA. Pacing events only. */
  paceOutputMa?: number;
  /** True when this shock was synchronised to the R wave (cardioversion). */
  synchronised?: boolean;
  rhythmAtTime?: AclsRhythm;
  /** KKM algorithm step this action implements, e.g. "kkm.arrest.shock". */
  guidelineRef?: string;
  /** Free-text detail for the event strip. */
  note?: string;
}

/** One document in Simulations/{simId}/AmsaLogs — a 1 Hz OideDecision sample. */
export interface AmsaTimepointPayload {
  /** Which protocol arm produced the sample; the two arms are plotted apart. */
  arm: ProtocolArm;
  offsetMs: number;
  /** AMSA from the adaptively filtered signal, mV·Hz. */
  currentAMSA: number;
  /** AMSA before adaptive cancellation — artefact-corrupted during CPR. */
  amsaUnfiltered: number;
  /** LMS broadband suppression achieved at this timepoint, dB. */
  artefactSuppressionDb: number;
  recommendedJoules: number;
  clinicalActionTier: string;
  clinicalActionMessage: string;
  rhythmAtTime: AclsRhythm;
  compressionsActive: boolean;
}

/** Per-protocol results, so the two arms can be compared directly. */
export interface ArmOutcome {
  arm: "traditional" | "oide";
  /** True only for the arm whose shock converted the rhythm. */
  roscAchieved: boolean;
  shockCount: number;
  /** Sum of energy this arm actually delivered, joules. */
  cumulativeJoules: number;
  /** Sum of what OIDE would have recommended at those same moments. */
  optimalJoules: number;
  /** Σ max(0, delivered − optimal) × 0.5 over every shock this arm delivered. */
  myocardialInjuryIndex: number;
  /** Hands-off time banked against this arm's shocks, ms. */
  totalPreShockPauseMs: number;
  epinephrineDoses: number;
  /** Neurologically intact survival likelihood, 0–1. */
  survivalLikelihood: number;
  /** Simulated instant of conversion, ms; null if this arm never converted. */
  timeToRoscMs: number | null;
  /**
   * Defibrillation efficacy of the last shock this arm resolved, 0–1 — the
   * conversion probability the run actually ended on. Zero for an arm that
   * delivered no energy.
   */
  roscProbability: number;
  /** Rhythm the arm finished on. */
  finalRhythm: AclsRhythm;
  /** Which KKM algorithm the arm ran. */
  family: KkmProtocolFamily;
  /** Instant transcutaneous pacing captured, ms; bradycardia runs only. */
  paceCaptureAtMs: number | null;
}

/** Written back onto the root document when the scenario ends. */
export interface SimulationOutcome {
  roscAchieved: boolean;
  /** Which protocol delivered the converting shock, if any. */
  roscByArm: "traditional" | "oide" | null;
  /** Sum of every shock delivered across both arms, joules. */
  cumulativeJoules: number;
  /**
   * Total hands-off time immediately preceding shocks, ms. The single
   * strongest modifiable predictor of defibrillation success.
   */
  totalPreShockPauseMs: number;
  totalDurationMs: number;
  shockCount: number;
  arms: { traditional: ArmOutcome; oide: ArmOutcome };
  endedReason: "rosc" | "death" | "transferred" | "timeout" | "aborted";
  note?: string;
}

/** Everything a session produced, as exported for research. */
export interface SessionExportBundle {
  /** Schema version, so downstream parsers can branch safely. */
  formatVersion: 1;
  exportedAt: string;
  simId: string;
  session: SimulationSessionDoc;
  interventions: InterventionPayload[];
  amsaLogs: AmsaTimepointPayload[];
  counts: {
    interventions: number;
    amsaLogs: number;
  };
}
