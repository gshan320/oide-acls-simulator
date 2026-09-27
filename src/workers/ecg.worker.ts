/// <reference lib="webworker" />

/**
 * Multi-channel bedside signal worker.
 *
 * Synthesises three physiologically independent channels off the main thread:
 *
 *   ecg    Lead II, mV, bipolar. Rhythm morphology + CPR motion artefact.
 *   pleth  Plethysmograph, 0–1, unipolar. Flat in arrest; blunt mechanical
 *          pulses under CPR; a real dicrotic pulse once perfusion returns.
 *   etco2  Capnogram, mmHg, unipolar. Square-ish expiratory plateau whose
 *          height tracks pulmonary blood flow — the CPR quality signal.
 *
 * The channels share a sample clock but nothing else. What couples them is
 * `PerfusionState`, derived from the rhythm and whether compressions are
 * running, which is the actual physiology: cardiac output drives both the
 * pulse and CO₂ delivery to the lungs.
 *
 * Instantiate with:
 *   new Worker(new URL("@/workers/ecg.worker.ts", import.meta.url), { type: "module" })
 */

import FFT from "fft.js";
import { PERFUSING_RHYTHMS } from "@/types/patient";
import { clinicalActionFor, recommendEnergy } from "@/lib/oide/decisionEngine";
import type {
  ChannelMetrics,
  EcgConfig,
  EcgWorkerRequest,
  EcgWorkerResponse,
  OideDecision,
  PerfusionState,
  SpectrumResult,
} from "@/types/signal";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Emit a chunk every 40 ms ≈ 25 fps of waveform data. */
const CHUNK_INTERVAL_MS = 40;
/** Power of two required by the radix-4 FFT. */
const FFT_SIZE = 1024;

/**
 * CPR artefact rejection for the analysis path.
 *
 * Chest compressions inject a large periodic component at the compression
 * fundamental plus its harmonics, which inflates AMSA and can capture the
 * dominant-frequency search. At the 110/min default that is a 1.83 Hz
 * fundamental and a 3.67 Hz second harmonic.
 *
 * The notches are derived from `config.compressionRate` rather than hardcoded,
 * so they track the configured rate across the whole 100–120/min guideline band.
 */
const CPR_NOTCH_HARMONICS = 2;
/**
 * Half-width of each notch, Hz. Wide enough to cover rate jitter and the FFT's
 * own bin resolution (500 Hz / 1024 ≈ 0.49 Hz), narrow enough to leave the
 * fibrillatory band intact.
 */
const CPR_NOTCH_HALF_WIDTH_HZ = 0.35;

/* ------------------------------------------------------------------ *
 * Adaptive CPR-artefact cancellation (normalised LMS)
 * ------------------------------------------------------------------ */

/**
 * Classic adaptive noise canceller. The primary input is the acquired ECG
 * (signal + artefact); the reference input is the compression motion, which
 * correlates with the artefact and not with the underlying rhythm. An adaptive
 * FIR learns the motion→ECG transfer function, and the *error* signal — what
 * the filter could not explain from motion alone — is the cleaned ECG.
 *
 * On real equipment the reference comes from the accelerometer in the CPR puck;
 * here the worker synthesises the same motion profile it injects, which is the
 * analogue of a perfectly mounted sensor.
 *
 * Normalised LMS is used rather than plain LMS so the step size stays stable as
 * compression depth changes; a small leakage term stops the weights drifting
 * along the null space of a strictly periodic reference.
 */
const LMS_TAPS = 128;
/** NLMS step size. Stable for 0 < μ < 2; 0.3 trades convergence against misadjustment. */
const LMS_STEP = 0.3;
/** Guards the normalisation when the reference is silent. */
const LMS_REGULARISATION = 1e-6;
/** Leakage per sample — negligible drag, prevents unbounded weight drift. */
const LMS_LEAKAGE = 1e-6;

const lmsWeights = new Float32Array(LMS_TAPS);
const lmsDelayLine = new Float32Array(LMS_TAPS);
let lmsPos = 0;
/** Running Σx² over the delay line, maintained incrementally for NLMS. */
let lmsRefPower = 0;

const fft = new FFT(FFT_SIZE);
const fftOutput: number[] = fft.createComplexArray();
/** Reused so the hot path allocates nothing per transform. */
const fftInput: number[] = new Array<number>(FFT_SIZE).fill(0);
const analysisWindow = new Float32Array(FFT_SIZE);

let config: EcgConfig = {
  sampleRate: 500,
  rhythm: "sinus",
  heartRate: 72,
  noiseLevel: 0.02,
  compressionsActive: false,
  // AHA/KKM high-quality CPR: 100–120/min. 110 sits mid-band.
  compressionRate: 110,
  compressionQuality: 0.85,
  ventilationRate: 10,
  patientImpedanceOhms: 75,
  adaptiveFilterEnabled: true,
};

let timer: ReturnType<typeof setInterval> | null = null;
let sampleIndex = 0;
let windowFill = 0;

/**
 * Current EtCO₂ plateau in mmHg, integrated across ticks rather than computed
 * per sample: the trace has to *ramp* into a new perfusion state, and that ramp
 * is the clinically meaningful part of a ROSC.
 */
let etco2Plateau = 7;

/** Raw ECG over the current FFT window, kept alongside the filtered copy. */
const analysisWindowRaw = new Float32Array(FFT_SIZE);

function post(message: EcgWorkerResponse, transfer: Transferable[] = []) {
  ctx.postMessage(message, transfer);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/**
 * Gaussian bump — each deflection is modelled as one of these, which is cheap
 * and gives a far more realistic trace than piecewise-linear segments.
 */
function bump(phase: number, center: number, amplitude: number, width: number) {
  const d = phase - center;
  return amplitude * Math.exp(-(d * d) / (2 * width * width));
}

function noise(level: number): number {
  return (Math.random() - 0.5) * 2 * level;
}

/** Which regime the pleth and capnogram are in right now. */
function perfusionOf(c: EcgConfig): PerfusionState {
  if (PERFUSING_RHYTHMS.has(c.rhythm)) return "rosc";
  return c.compressionsActive ? "cpr" : "arrest";
}

/* ------------------------------------------------------------------ *
 * Channel 1 — ECG lead II
 * ------------------------------------------------------------------ */

/** One beat of normal sinus morphology; `phase` runs 0→1 across the R-R interval. */
function sinusBeat(phase: number): number {
  return (
    bump(phase, 0.16, 0.09, 0.032) + // P
    bump(phase, 0.36, -0.06, 0.008) + // Q
    bump(phase, 0.39, 1.0, 0.009) + // R
    bump(phase, 0.42, -0.16, 0.011) + // S
    bump(phase, 0.62, 0.22, 0.045) // T
  );
}

/** Wide, monomorphic complex with no discernible P wave. */
function wideComplexBeat(phase: number): number {
  return (
    bump(phase, 0.35, 0.85, 0.04) +
    bump(phase, 0.47, -0.5, 0.05) +
    bump(phase, 0.68, -0.18, 0.06)
  );
}

/**
 * Chaotic, non-periodic fibrillatory activity: four incommensurate components
 * so the trace never repeats, plus a slow amplitude envelope so coarse VF
 * visibly waxes and wanes the way real VF does.
 */
function fibrillation(t: number, coarse: boolean): number {
  const amp = coarse ? 0.42 : 0.12;
  const envelope = 0.78 + 0.22 * Math.sin(2 * Math.PI * 0.31 * t + 0.9);
  return (
    amp *
    envelope *
    (Math.sin(2 * Math.PI * 5.3 * t) * 0.6 +
      Math.sin(2 * Math.PI * 8.1 * t + 1.7) * 0.3 +
      Math.sin(2 * Math.PI * 3.4 * t + 0.4) * 0.4 +
      Math.sin(2 * Math.PI * 11.9 * t + 2.3) * 0.15)
  );
}

/** Torsades: VT whose axis twists around the baseline. */
function torsades(t: number, phase: number): number {
  const envelope = Math.sin(2 * Math.PI * 0.45 * t);
  return wideComplexBeat(phase) * envelope;
}

/**
 * Unit-amplitude compression motion: a broad oscillation at the compression
 * rate plus a sharper recoil transient. This is the *reference channel* for the
 * adaptive canceller — the analogue of what a CPR-puck accelerometer measures,
 * carrying the artefact's shape and phase but none of its amplitude.
 *
 * Returns 0 when nobody is compressing, which parks the canceller.
 */
function compressionReference(t: number): number {
  if (!config.compressionsActive) return 0;

  const period = 60 / Math.max(config.compressionRate, 1);
  const phase = (t % period) / period;
  return Math.sin(2 * Math.PI * (t / period)) + bump(phase, 0.22, 0.55, 0.05);
}

/**
 * The artefact actually injected into the ECG: the motion profile scaled by how
 * hard the compressions are. Sharing `compressionReference` guarantees the
 * reference stays correlated with the artefact, exactly as a real sensor is.
 */
function compressionArtefact(t: number, quality: number): number {
  const depth = 0.18 + 0.22 * clamp01(quality);
  return depth * compressionReference(t);
}

/**
 * One NLMS iteration. `primary` is the acquired ECG, `reference` the motion
 * signal; the returned error is the artefact-cancelled ECG.
 *
 * Caveat inherent to adaptive noise cancellation: any genuine ECG component
 * that happens to be coherent with the compression rate is indistinguishable
 * from artefact and will be cancelled with it.
 */
function adaptiveCancel(primary: number, reference: number): number {
  // Slide the delay line, maintaining Σx² incrementally rather than rescanning.
  const evicted = lmsDelayLine[lmsPos];
  lmsRefPower += reference * reference - evicted * evicted;
  if (lmsRefPower < 0) lmsRefPower = 0;
  lmsDelayLine[lmsPos] = reference;

  // y = wᵀx, walking the delay line newest-first.
  let y = 0;
  let idx = lmsPos;
  for (let k = 0; k < LMS_TAPS; k++) {
    y += lmsWeights[k] * lmsDelayLine[idx];
    idx = idx === 0 ? LMS_TAPS - 1 : idx - 1;
  }

  // The error signal is the cancelled output — the part of the ECG that the
  // motion reference cannot explain.
  const error = primary - y;

  const step = LMS_STEP / (lmsRefPower + LMS_REGULARISATION);
  idx = lmsPos;
  for (let k = 0; k < LMS_TAPS; k++) {
    lmsWeights[k] =
      (1 - LMS_LEAKAGE) * lmsWeights[k] + step * error * lmsDelayLine[idx];
    idx = idx === 0 ? LMS_TAPS - 1 : idx - 1;
  }

  lmsPos = lmsPos === LMS_TAPS - 1 ? 0 : lmsPos + 1;
  return error;
}

function ecgSampleAt(index: number): number {
  const {
    sampleRate,
    rhythm,
    heartRate,
    noiseLevel,
    compressionsActive,
    compressionQuality,
  } = config;
  const t = index / sampleRate;
  const rrSeconds = 60 / Math.max(heartRate, 1);
  const phase = (t % rrSeconds) / rrSeconds;

  let value: number;

  switch (rhythm) {
    case "sinus":
    case "sinus-bradycardia":
    case "sinus-tachycardia":
      value = sinusBeat(phase);
      break;

    case "atrial-fibrillation":
      // Irregularly irregular: jitter the phase, drop the P wave.
      value =
        sinusBeat((phase + 0.07 * Math.sin(t * 9.7)) % 1) -
        bump(phase, 0.16, 0.09, 0.032) +
        0.03 * Math.sin(2 * Math.PI * 7 * t);
      break;

    case "svt":
      value = sinusBeat(phase) - bump(phase, 0.16, 0.09, 0.032) * 0.6;
      break;

    case "vtach-pulseless":
    case "vtach-with-pulse":
      value = wideComplexBeat(phase);
      break;

    case "vfib":
      value = fibrillation(t, true);
      break;

    case "vfib-fine":
      // Low-amplitude fibrillation: less myocardial energy, so a markedly
      // lower AMSA and a different decision tier.
      value = fibrillation(t, false);
      break;

    case "torsades":
      value = torsades(t, phase);
      break;

    case "third-degree-block":
      // Atria and ventricles march independently.
      value =
        bump((t % 0.75) / 0.75, 0.2, 0.09, 0.03) + wideComplexBeat(phase) * 0.7;
      break;

    case "pea":
      // Organised electrical activity — the trace looks perfusing, the patient isn't.
      value = sinusBeat(phase) * 0.7;
      break;

    case "asystole":
      value = 0;
      break;

    default:
      value = sinusBeat(phase);
  }

  if (compressionsActive) {
    value += compressionArtefact(t, compressionQuality);
    // Rescuer movement raises the broadband floor, not just the periodic term.
    // This part is uncorrelated with the reference, so the canceller cannot
    // remove it — which is the honest limit of adaptive noise cancellation.
    value += noise(noiseLevel * 2.5);
  }

  // 50 Hz mains interference scales with the noise setting.
  value += noiseLevel * 0.4 * Math.sin(2 * Math.PI * 50 * t);
  value += noise(noiseLevel);

  return value;
}

/* ------------------------------------------------------------------ *
 * Channel 2 — Plethysmograph
 * ------------------------------------------------------------------ */

/** Perfusing pulse: brisk systolic upstroke, dicrotic notch, diastolic runoff. */
function perfusingPulse(phase: number): number {
  return (
    bump(phase, 0.17, 1.0, 0.055) + // systolic peak
    bump(phase, 0.34, 0.28, 0.045) + // dicrotic wave
    bump(phase, 0.62, 0.06, 0.09) // diastolic runoff
  );
}

/**
 * Compression-generated pulse: narrow, blunt, and with no dicrotic notch —
 * a mechanical pressure wave, not a cardiac ejection.
 */
function mechanicalPulse(phase: number): number {
  return bump(phase, 0.2, 1.0, 0.05);
}

function plethSampleAt(index: number, perfusion: PerfusionState): number {
  const {
    sampleRate,
    heartRate,
    noiseLevel,
    compressionRate,
    compressionQuality,
  } = config;
  const t = index / sampleRate;

  if (perfusion === "rosc") {
    const period = 60 / Math.max(heartRate, 1);
    const phase = (t % period) / period;
    // Slow respiratory sway on the baseline, as a real finger probe shows.
    const sway = 0.03 * Math.sin(2 * Math.PI * 0.25 * t);
    return perfusingPulse(phase) * 0.92 + sway + noise(noiseLevel * 0.35);
  }

  if (perfusion === "cpr") {
    const period = 60 / Math.max(compressionRate, 1);
    const phase = (t % period) / period;
    // Compressions move blood, but poorly: 18–40% of a perfusing pulse.
    const amplitude = 0.18 + 0.22 * clamp01(compressionQuality);
    return mechanicalPulse(phase) * amplitude + noise(noiseLevel * 0.5);
  }

  // Arrest with no compressions: no cardiac output, so no pulsatile signal.
  // Sensor noise only — a flat trace, not a mathematically perfect line.
  return noise(noiseLevel * 0.25);
}

/* ------------------------------------------------------------------ *
 * Channel 3 — Capnography
 * ------------------------------------------------------------------ */

/**
 * Normalised capnogram over one breath, 0→1.
 *
 *   phase I    inspiratory baseline, ~0
 *   phase II   rapid expiratory upstroke
 *   phase III  alveolar plateau, gently upsloping to the end-tidal point
 *   phase 0    rapid inspiratory downstroke
 */
function capnogramShape(phase: number): number {
  const RISE_END = 0.06;
  const PLATEAU_END = 0.55;
  const FALL_END = 0.63;

  if (phase < RISE_END) {
    return 0.94 * smoothstep(phase / RISE_END);
  }
  if (phase < PLATEAU_END) {
    const p = (phase - RISE_END) / (PLATEAU_END - RISE_END);
    return 0.94 + 0.06 * p; // upsloping phase III
  }
  if (phase < FALL_END) {
    const p = (phase - PLATEAU_END) / (FALL_END - PLATEAU_END);
    return 1 - smoothstep(p);
  }
  return 0;
}

/** Where the plateau *wants* to be, in mmHg, for the current perfusion state. */
function plateauTarget(perfusion: PerfusionState, quality: number): number {
  switch (perfusion) {
    case "rosc":
      // Pulmonary blood flow restored: sharp jump into the high 30s.
      return 38;
    case "cpr":
      // Compressions deliver a fraction of normal cardiac output. Quality maps
      // directly onto the plateau — this is the feedback the learner is meant
      // to read off the monitor.
      return 15 + 10 * clamp01(quality);
    case "arrest":
      // Untreated arrest: residual CO₂ washout only.
      return 7;
  }
}

/**
 * Ramp the plateau toward its target with an asymmetric time constant.
 * ROSC presents as an abrupt step up; losing output washes out more slowly.
 */
function advancePlateau(target: number, dt: number) {
  const tau = target > etco2Plateau ? 0.8 : 6;
  etco2Plateau += (target - etco2Plateau) * (1 - Math.exp(-dt / tau));
}

function etco2SampleAt(index: number): number {
  const { sampleRate, ventilationRate, noiseLevel } = config;
  const t = index / sampleRate;
  const breathPeriod = 60 / Math.max(ventilationRate, 1);
  const phase = (t % breathPeriod) / breathPeriod;

  const value = etco2Plateau * capnogramShape(phase);
  return Math.max(0, value + noise(noiseLevel * 1.2));
}

/* ------------------------------------------------------------------ *
 * Spectral analysis (ECG channel only)
 * ------------------------------------------------------------------ */

/** Hann window — reduces spectral leakage before the transform. */
function fillWindowedInput(buffer: Float32Array) {
  const last = FFT_SIZE - 1;
  for (let i = 0; i < FFT_SIZE; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / last));
    fftInput[i] = (buffer[i] ?? 0) * w;
  }
}

/**
 * Centre frequencies to suppress: the compression fundamental and its
 * harmonics. Empty when no compressions are running — notching then would
 * only discard real fibrillatory signal.
 */
function cprNotchCentres(): number[] {
  if (!config.compressionsActive) return [];

  const fundamental = config.compressionRate / 60;
  const centres: number[] = [];
  for (let h = 1; h <= CPR_NOTCH_HARMONICS; h++) {
    centres.push(fundamental * h);
  }
  return centres;
}

const isNotched = (hz: number, centres: number[]) =>
  centres.some((c) => Math.abs(hz - c) <= CPR_NOTCH_HALF_WIDTH_HZ);

/**
 * Magnitude spectrum plus AMSA (amplitude spectrum area, 2–48 Hz), which is
 * the literature's proxy for how likely a shock is to terminate VF.
 *
 * The notch applies to this analysis path only. The displayed ECG trace stays
 * unfiltered on purpose — clinicians read the raw artefact to judge compression
 * mechanics, exactly as a real defibrillator shows it.
 */
function analyze(samples: Float32Array): SpectrumResult {
  fillWindowedInput(samples);
  fft.realTransform(fftOutput, fftInput);
  fft.completeSpectrum(fftOutput);

  const bins = FFT_SIZE / 2;
  const frequencies = new Float32Array(bins);
  const magnitudes = new Float32Array(bins);
  const binHz = config.sampleRate / FFT_SIZE;
  const notchedHz = cprNotchCentres();

  let dominantHz = 0;
  let peak = 0;
  let amsa = 0;
  let amsaRaw = 0;

  for (let i = 0; i < bins; i++) {
    const re = fftOutput[2 * i];
    const im = fftOutput[2 * i + 1];
    const raw = Math.hypot(re, im) / bins;
    const hz = i * binHz;
    const suppressed = isNotched(hz, notchedHz);
    const magnitude = suppressed ? 0 : raw;

    frequencies[i] = hz;
    magnitudes[i] = magnitude;

    if (hz >= 2 && hz <= 48) {
      amsaRaw += raw * hz;
      amsa += magnitude * hz;
      // The dominant-frequency search reads the filtered spectrum, so a strong
      // compression harmonic can no longer win the peak.
      if (magnitude > peak) {
        peak = magnitude;
        dominantHz = hz;
      }
    }
  }

  return { frequencies, magnitudes, dominantHz, amsa, amsaRaw, notchedHz };
}

/**
 * AMSA alone, no notch and no array allocation — used to measure the raw signal
 * for comparison against the adaptively filtered one.
 *
 * AMSA = Σ (frequency × amplitude) over 2–48 Hz.
 */
function amsaOnly(samples: Float32Array): number {
  fillWindowedInput(samples);
  fft.realTransform(fftOutput, fftInput);
  fft.completeSpectrum(fftOutput);

  const bins = FFT_SIZE / 2;
  const binHz = config.sampleRate / FFT_SIZE;
  let amsa = 0;

  for (let i = 0; i < bins; i++) {
    const hz = i * binHz;
    if (hz < 2 || hz > 48) continue;
    const amplitude =
      Math.hypot(fftOutput[2 * i], fftOutput[2 * i + 1]) / bins;
    amsa += amplitude * hz;
  }

  return amsa;
}

/** 20·log₁₀(rms_raw / rms_filtered) over the analysis window. */
function suppressionDb(raw: Float32Array, filtered: Float32Array): number {
  let rawSum = 0;
  let filteredSum = 0;
  for (let i = 0; i < raw.length; i++) {
    rawSum += raw[i] * raw[i];
    filteredSum += filtered[i] * filtered[i];
  }
  if (rawSum <= 0 || filteredSum <= 0) return 0;
  return 10 * Math.log10(rawSum / filteredSum);
}

/* ------------------------------------------------------------------ *
 * OIDE Clinical Decision Engine
 * ------------------------------------------------------------------ */

/** Compose the engine's pure outputs with this tick's filter diagnostics. */
function buildDecision(
  currentAMSA: number,
  amsaUnfiltered: number,
  artefactSuppressionDb: number,
): OideDecision {
  const { recommendedJoules, energy } = recommendEnergy(
    currentAMSA,
    config.patientImpedanceOhms,
  );

  return {
    currentAMSA,
    amsaUnfiltered,
    recommendedJoules,
    clinicalAction: clinicalActionFor(currentAMSA, config.rhythm),
    energy,
    artefactSuppressionDb,
    adaptiveFilterActive:
      config.adaptiveFilterEnabled && config.compressionsActive,
  };
}

/* ------------------------------------------------------------------ *
 * Tick
 * ------------------------------------------------------------------ */

function tick() {
  const { sampleRate, compressionQuality } = config;
  const count = Math.max(
    1,
    Math.round((sampleRate * CHUNK_INTERVAL_MS) / 1000),
  );
  const dt = 1 / sampleRate;

  const perfusion = perfusionOf(config);
  const target = plateauTarget(perfusion, compressionQuality);

  const rawSignal = new Float32Array(count);
  const filteredSignal = new Float32Array(count);
  const pleth = new Float32Array(count);
  const etco2 = new Float32Array(count);

  let emitSpectrum = false;

  for (let i = 0; i < count; i++) {
    const index = sampleIndex + i;

    advancePlateau(target, dt);

    const raw = ecgSampleAt(index);
    // The canceller runs on every sample so its weights stay converged, but the
    // filtered output is only substituted when the feature is enabled.
    const cancelled = adaptiveCancel(
      raw,
      compressionReference(index / sampleRate),
    );
    const filtered = config.adaptiveFilterEnabled ? cancelled : raw;

    rawSignal[i] = raw;
    filteredSignal[i] = filtered;
    pleth[i] = plethSampleAt(index, perfusion);
    etco2[i] = etco2SampleAt(index);

    // The decision engine measures the filtered signal; the raw copy is kept
    // alongside it purely to quantify what cancellation achieved.
    analysisWindowRaw[windowFill] = raw;
    analysisWindow[windowFill] = filtered;
    windowFill++;

    if (windowFill === FFT_SIZE) {
      emitSpectrum = true;

      const result = analyze(analysisWindow);
      const amsaUnfiltered = amsaOnly(analysisWindowRaw);
      const db = suppressionDb(analysisWindowRaw, analysisWindow);

      post({ type: "spectrum", result });
      post({
        type: "decision",
        decision: buildDecision(result.amsa, amsaUnfiltered, db),
      });

      // 50% overlap keeps the spectrum responsive without re-buffering a full window.
      analysisWindow.copyWithin(0, FFT_SIZE / 2);
      analysisWindowRaw.copyWithin(0, FFT_SIZE / 2);
      windowFill = FFT_SIZE / 2;
    }
  }

  const startIndex = sampleIndex;
  sampleIndex += count;

  // Transfer, don't copy — the main thread takes ownership of all four buffers.
  post(
    { type: "samples", startIndex, rawSignal, filteredSignal, pleth, etco2 },
    [rawSignal.buffer, filteredSignal.buffer, pleth.buffer, etco2.buffer],
  );

  // Numeric readouts move on the spectrum's cadence (~1 Hz), not every frame.
  if (emitSpectrum) {
    const metrics: ChannelMetrics = {
      etco2: etco2Plateau,
      perfusion,
      pulsatile: perfusion !== "arrest",
    };
    post({ type: "metrics", metrics });
  }
}

function stop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

ctx.addEventListener("message", (event: MessageEvent<EcgWorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case "configure":
        config = { ...config, ...request.config };
        break;

      case "start":
        stop();
        timer = setInterval(tick, CHUNK_INTERVAL_MS);
        break;

      case "stop":
        stop();
        break;

      case "analyze":
        post({ type: "spectrum", result: analyze(request.samples) });
        break;
    }
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export {};
