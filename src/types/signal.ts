import type { AclsRhythm } from "./patient";

/** Messages exchanged with the ECG signal worker (src/workers/ecg.worker.ts). */

export type ChannelId = "ecg" | "pleth" | "etco2";

/**
 * Perfusion regime. Derived from the rhythm and whether compressions are
 * running; it is what makes the pleth and capnography channels diverge.
 */
export type PerfusionState = "arrest" | "cpr" | "rosc";

export interface EcgConfig {
  /** Samples per second for the synthesised traces. */
  sampleRate: number;
  rhythm: AclsRhythm;
  heartRate: number;
  /** 0–1 sensor noise and 50 Hz mains hum. */
  noiseLevel: number;
  compressionsActive: boolean;
  /**
   * Compressions per minute. Phase-locks the ECG motion artefact to the
   * mechanical pleth pulses — the same hands produce both.
   */
  compressionRate: number;
  /** 0–1 CPR quality: scales pleth pulse height and the EtCO₂ plateau. */
  compressionQuality: number;
  /** Ventilations per minute; sets the capnogram breath period. */
  ventilationRate: number;
  /** Transthoracic impedance in ohms; 75 Ω is the nominal adult value. */
  patientImpedanceOhms: number;
  /** Disable to compare AMSA with and without adaptive cancellation. */
  adaptiveFilterEnabled: boolean;
}

export type EcgWorkerRequest =
  | { type: "configure"; config: Partial<EcgConfig> }
  | { type: "start" }
  | { type: "stop" }
  | { type: "analyze"; samples: Float32Array };

export interface SpectrumResult {
  /** Bin frequencies in Hz. */
  frequencies: Float32Array;
  /** Magnitude per bin, after CPR notch suppression. */
  magnitudes: Float32Array;
  /** Dominant frequency in Hz — the AMSA/VF-waveform proxy. */
  dominantHz: number;
  /** AMSA over 2–48 Hz of the adaptively filtered signal, after notching. */
  amsa: number;
  /** Same signal, before the notch. The gap is what the notch removed. */
  amsaRaw: number;
  /** Centre frequencies (Hz) suppressed on this transform; empty when idle. */
  notchedHz: number[];
}

/** Slow-moving derived values, reported about once a second. */
export interface ChannelMetrics {
  /** Current end-tidal plateau in mmHg — the number the capnogram is drawing. */
  etco2: number;
  perfusion: PerfusionState;
  /** True while the pleth channel is producing pulses of any origin. */
  pulsatile: boolean;
}

/* ------------------------------------------------------------------ *
 * OIDE Clinical Decision Engine
 * ------------------------------------------------------------------ */

/**
 * `non-shockable` gates the three AMSA tiers: AMSA only bears on the decision
 * when defibrillation is on the table at all.
 */
export type ClinicalActionTier =
  | "high"
  | "intermediate"
  | "low"
  | "non-shockable";

export interface ClinicalAction {
  tier: ClinicalActionTier;
  /** Verbatim decision-engine text for the monitor. */
  message: string;
  shockAdvised: boolean;
}

/** Every term of E_opt, exposed so the recommended energy is auditable. */
export interface EnergyBreakdown {
  /** Base_Energy, joules. */
  baseEnergyJ: number;
  patientImpedanceOhms: number;
  /** Patient_Impedance / 75. */
  impedanceCorrection: number;
  /** Calibrated multiplier derived from AMSA. */
  amsaScalingFactor: number;
  /** E_opt before clamping to the deliverable envelope. */
  unclampedJoules: number;
}

export interface OideDecision {
  /** AMSA of the adaptively filtered signal, mV·Hz. Drives every field below. */
  currentAMSA: number;
  /** AMSA of the raw signal — artefact-corrupted during compressions. */
  amsaUnfiltered: number;
  recommendedJoules: number;
  clinicalAction: ClinicalAction;
  energy: EnergyBreakdown;
  /** Broadband artefact rejection achieved by the LMS canceller, dB. */
  artefactSuppressionDb: number;
  /** True while the canceller has a live reference to work from. */
  adaptiveFilterActive: boolean;
}

export type EcgWorkerResponse =
  /**
   * One chunk per channel; all four advance by the same sample count.
   * `rawSignal` is what the monitor draws; `filteredSignal` is what the
   * decision engine measures.
   */
  | {
      type: "samples";
      startIndex: number;
      /** Lead II as acquired, millivolts, bipolar. Includes CPR artefact. */
      rawSignal: Float32Array;
      /** Lead II after adaptive CPR-artefact cancellation. */
      filteredSignal: Float32Array;
      /** Plethysmograph, 0–1 arbitrary units, unipolar. */
      pleth: Float32Array;
      /** Capnography, mmHg, unipolar. */
      etco2: Float32Array;
    }
  | { type: "spectrum"; result: SpectrumResult }
  | { type: "decision"; decision: OideDecision }
  | { type: "metrics"; metrics: ChannelMetrics }
  | { type: "error"; message: string };
