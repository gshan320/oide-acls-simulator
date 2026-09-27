"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Droplet,
  Gauge,
  HeartPulse,
  Lock,
  Play,
  Radio,
  ShieldAlert,
  Stethoscope,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { GlassPanel } from "@/components/ui";
import { WaveformCanvas } from "./WaveformCanvas";
import { AmsaGauge } from "./AmsaGauge";
import { OutcomeAnalysis } from "./OutcomeAnalysis";
import { useEcgWorker } from "@/workers/useEcgWorker";
import { cn, formatElapsed } from "@/lib/utils";
import { downloadJson, sessionExportFilename } from "@/lib/exportFile";
import {
  ARM_LABELS,
  ARM_STRATEGY,
  COMPRESSION_RATE,
  CONVERSION_LABEL,
  CONVERSION_NOUN,
  PLAYBACK_DURATION_MS,
  PROTOCOL_ARMS,
  SIMULATED_DURATION_MS,
  TIME_LAPSE_FACTOR,
  assessPatient,
  buildArmTimeline,
  buildDualArmExport,
  combineOutcome,
  frameAt,
  heartRateFor,
  paceCaptureRequirementMa,
  protocolMatrixFor,
  sampleAmsaTrack,
  toAmsaTimepoint,
  toInterventionPayload,
  type AclsArmResult,
  type AclsEvent,
  type AclsPlaybackFrame,
  type RhythmAssessment,
} from "@/lib/oide/aclsEngine";
import {
  SPECIAL_CIRCUMSTANCE_LABELS,
  type AmsaTimepointPayload,
  type InterventionPayload,
  type KkmProtocolFamily,
  type PatientParameters,
  type SimulationOutcome,
  type SimulationSessionDoc,
} from "@/types/session";

type Arm = "traditional" | "oide";

/**
 * How often the AMSA track is persisted and plotted.
 *
 * The engine integrates at 1 Hz because the physics needs that resolution; two
 * arms of 1200 documents each does not. Every 5 simulated seconds preserves the
 * trajectory's shape at a twelfth of the write volume.
 */
const AMSA_LOG_STRIDE_MS = 5_000;

/**
 * Wall-clock interval between published clock updates.
 *
 * The waveforms are drawn straight from the worker's ring buffers inside their
 * own animation frame, so React only has to keep the numeric readouts and the
 * event feed current. 12 Hz is past the point where a counting readout looks
 * smooth, and it keeps the re-render budget clear for the canvases.
 */
const PUBLISH_INTERVAL_MS = 80;

interface AutomatedDualSimulatorProps {
  session: SimulationSessionDoc;
  /** Persist one intervention. Failures are surfaced by the host, never thrown. */
  onIntervention: (payload: InterventionPayload) => void;
  /** Persist one AMSA timepoint; the Firestore layer batches them. */
  onAmsaTimepoint: (payload: AmsaTimepointPayload) => void;
  /** Fired once, when both arms have finished their runs. */
  onConclude: (outcome: SimulationOutcome) => void;
  /** Host-side session export. Omit to offer only the local dual-arm bundle. */
  onExport?: () => void;
  exporting?: boolean;
  exportError?: string | null;
}

/**
 * Automated, time-lapsed comparative ACLS workspace.
 *
 * There are no protocol controls here: both arms are generated up front by
 * `aclsEngine` and then played back, so the learner's job is to watch the same
 * patient receive two energy strategies and read the difference off the
 * telemetry. Each arm runs its own 20-minute sequence compressed into 60
 * real seconds, one at a time, and the comparison unlocks only once both have
 * completed — otherwise the two arms could be compared at different points in
 * their timelines, which is exactly the confound the workspace exists to avoid.
 */
export function AutomatedDualSimulator({
  session,
  onIntervention,
  onAmsaTimepoint,
  onConclude,
  onExport,
  exporting = false,
  exportError = null,
}: AutomatedDualSimulatorProps) {
  /**
   * Rebuilt from primitives rather than the session object, so a Firestore
   * snapshot that re-creates an identical patient does not regenerate the
   * timelines and reset a run in progress.
   */
  const {
    referenceId,
    ageYears,
    weightKg,
    transthoracicImpedanceOhms,
    timeDownWithoutCprMinutes,
    initialRhythm,
  } = session.patient;
  const { ischemicHeartDisease, previousMi } = session.patient.comorbidities;
  /**
   * Joined rather than spread: a Firestore snapshot hands back a fresh array
   * every time, and an array identity in the dependency list would rebuild
   * both timelines — resetting a run in progress — on every snapshot.
   */
  const circumstanceKey = (session.patient.specialCircumstances ?? []).join(",");

  const patient = useMemo<PatientParameters>(
    () => ({
      referenceId,
      ageYears,
      weightKg,
      transthoracicImpedanceOhms,
      timeDownWithoutCprMinutes,
      initialRhythm,
      comorbidities: { ischemicHeartDisease, previousMi },
      specialCircumstances:
        circumstanceKey === ""
          ? []
          : (circumstanceKey.split(
              ",",
            ) as PatientParameters["specialCircumstances"]),
    }),
    [
      referenceId,
      ageYears,
      weightKg,
      transthoracicImpedanceOhms,
      timeDownWithoutCprMinutes,
      initialRhythm,
      ischemicHeartDisease,
      previousMi,
      circumstanceKey,
    ],
  );

  const timelines = useMemo(
    () => ({
      traditional: buildArmTimeline(patient, "traditional"),
      oide: buildArmTimeline(patient, "oide"),
    }),
    [patient],
  );

  const amsaLogs = useMemo(
    () => ({
      traditional: sampleAmsaTrack(
        timelines.traditional.amsaTrack,
        AMSA_LOG_STRIDE_MS,
      ),
      oide: sampleAmsaTrack(timelines.oide.amsaTrack, AMSA_LOG_STRIDE_MS),
    }),
    [timelines],
  );

  /** Null until the assessment gate has been cleared. */
  const [assessment, setAssessment] = useState<RhythmAssessment | null>(null);
  const [activeArm, setActiveArm] = useState<Arm | null>(null);
  const [simulatedMs, setSimulatedMs] = useState(0);
  const [completed, setCompleted] = useState<Partial<Record<Arm, AclsArmResult>>>(
    {},
  );
  const [view, setView] = useState<Arm | "comparison">("traditional");
  const [showFiltered, setShowFiltered] = useState(true);

  const bothComplete =
    completed.traditional !== undefined && completed.oide !== undefined;

  /* ---------------- signal chain ---------------- */

  const {
    rawSignal,
    filteredSignal,
    pleth,
    etco2,
    writeCount,
    metrics,
    configure,
    start,
    stop,
  } = useEcgWorker();

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  /* ---------------- playback ---------------- */

  /**
   * The host's callbacks are read through refs so the playback effect depends
   * only on which arm is running. A parent that re-creates its handlers each
   * render would otherwise restart the animation loop mid-sequence.
   */
  const onInterventionRef = useRef(onIntervention);
  const onAmsaTimepointRef = useRef(onAmsaTimepoint);
  const onConcludeRef = useRef(onConclude);
  useEffect(() => {
    onInterventionRef.current = onIntervention;
    onAmsaTimepointRef.current = onAmsaTimepoint;
    onConcludeRef.current = onConclude;
  }, [onIntervention, onAmsaTimepoint, onConclude]);

  const startedAtRef = useRef(0);
  /** Next event index still to be persisted for the running arm. */
  const eventCursorRef = useRef(0);
  /** Next AMSA sample index still to be persisted for the running arm. */
  const amsaCursorRef = useRef(0);
  const publishedAtRef = useRef(0);

  const startSequence = useCallback(
    (arm: Arm) => {
      if (activeArm !== null || completed[arm] !== undefined) return;

      eventCursorRef.current = 0;
      amsaCursorRef.current = 0;
      publishedAtRef.current = 0;
      setSimulatedMs(0);
      setView(arm);
      setActiveArm(arm);
      startedAtRef.current = performance.now();
    },
    [activeArm, completed],
  );

  useEffect(() => {
    if (activeArm === null) return;

    const timeline = timelines[activeArm];
    const samples = amsaLogs[activeArm];
    const durationMs = timeline.result.durationMs;
    let frame = 0;

    const tick = () => {
      const wall = performance.now();
      const simMs = Math.min(
        durationMs,
        (wall - startedAtRef.current) * TIME_LAPSE_FACTOR,
      );

      // Persist everything the clock has just swept past, in timeline order.
      while (
        eventCursorRef.current < timeline.events.length &&
        timeline.events[eventCursorRef.current].atMs <= simMs
      ) {
        onInterventionRef.current(
          toInterventionPayload(
            timeline.events[eventCursorRef.current],
            activeArm,
          ),
        );
        eventCursorRef.current += 1;
      }

      while (
        amsaCursorRef.current < samples.length &&
        samples[amsaCursorRef.current].atMs <= simMs
      ) {
        onAmsaTimepointRef.current(
          toAmsaTimepoint(samples[amsaCursorRef.current], activeArm),
        );
        amsaCursorRef.current += 1;
      }

      const finished = simMs >= durationMs;
      if (finished || wall - publishedAtRef.current >= PUBLISH_INTERVAL_MS) {
        publishedAtRef.current = wall;
        setSimulatedMs(simMs);
      }

      if (finished) {
        setCompleted((prev) => ({ ...prev, [activeArm]: timeline.result }));
        setActiveArm(null);
        return;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [activeArm, timelines, amsaLogs]);

  /** The session outcome is reported once, when the second arm lands. */
  const concludedRef = useRef(false);
  useEffect(() => {
    const { traditional, oide } = completed;
    if (!traditional || !oide || concludedRef.current) return;

    concludedRef.current = true;
    onConcludeRef.current(combineOutcome(traditional, oide));
  }, [completed]);

  /* ---------------- what the telemetry is showing ---------------- */

  const displayArm: Arm = view === "comparison" ? "oide" : view;

  const frame = useMemo<AclsPlaybackFrame>(() => {
    const timeline = timelines[displayArm];
    if (activeArm === displayArm) return frameAt(timeline, simulatedMs);
    // A finished arm holds its last frame; an unstarted one shows intake.
    return frameAt(
      timeline,
      completed[displayArm] ? timeline.result.durationMs : 0,
    );
  }, [timelines, displayArm, activeArm, simulatedMs, completed]);

  const impedanceOhms = assessment?.impedanceOhms ?? transthoracicImpedanceOhms;
  const family: KkmProtocolFamily =
    assessment?.family ?? timelines.traditional.family;
  const heartRate = heartRateFor(frame.rhythm, family);

  useEffect(() => {
    configure({
      sampleRate: 500,
      rhythm: frame.rhythm,
      heartRate,
      compressionsActive: frame.compressionsActive,
      compressionRate: COMPRESSION_RATE,
      patientImpedanceOhms: impedanceOhms,
    });
  }, [
    configure,
    frame.rhythm,
    frame.compressionsActive,
    heartRate,
    impedanceOhms,
  ]);

  /* ---------------- exports ---------------- */

  const handleTimelineExport = useCallback(() => {
    if (assessment === null) return;

    downloadJson(
      sessionExportFilename(`${session.simId}-dual-arm`),
      buildDualArmExport({
        simId: session.simId,
        patient,
        assessment,
        traditional: timelines.traditional,
        oide: timelines.oide,
        exportedAt: new Date().toISOString(),
      }),
    );
  }, [assessment, patient, session.simId, timelines]);

  /* ---------------- comparison inputs ---------------- */

  const comparison = useMemo(() => {
    const { traditional, oide } = completed;
    if (!traditional || !oide) return null;

    const interventions = PROTOCOL_ARMS.flatMap((arm) =>
      timelines[arm].events.map((event) => toInterventionPayload(event, arm)),
    );
    const logs = PROTOCOL_ARMS.flatMap((arm) =>
      amsaLogs[arm].map((sample) => toAmsaTimepoint(sample, arm)),
    );

    return {
      outcome: combineOutcome(traditional, oide),
      interventions,
      amsaLogs: logs,
    };
  }, [completed, timelines, amsaLogs]);

  /* ---------------- render ---------------- */

  if (assessment === null) {
    return (
      <IntakeGate
        patient={patient}
        onAssess={() => setAssessment(assessPatient(patient))}
      />
    );
  }

  return (
    <div className="space-y-4">
      <SessionHeader
        patient={patient}
        assessment={assessment}
        activeArm={activeArm}
        completed={completed}
        // The visible route's own clock, not the raw playback state: switching
        // to a route that has not run yet must not leave the other's time up.
        simulatedMs={frame.simulatedMs}
      />

      <AssessmentSummary assessment={assessment} collapsed />

      <TabBar
        view={view}
        family={assessment.family}
        activeArm={activeArm}
        completed={completed}
        bothComplete={bothComplete}
        onSelect={setView}
      />

      {view === "comparison" && comparison ? (
        <OutcomeAnalysis
          session={session}
          outcome={comparison.outcome}
          amsaLogs={comparison.amsaLogs}
          interventions={comparison.interventions}
          onExport={onExport}
          exporting={exporting}
          exportError={exportError}
          onExportTimeline={handleTimelineExport}
        />
      ) : (
        <ArmWorkspace
          arm={displayArm}
          assessment={assessment}
          frame={frame}
          heartRate={heartRate}
          result={completed[displayArm] ?? null}
          running={activeArm === displayArm}
          lockedBy={activeArm !== null && activeArm !== displayArm ? activeArm : null}
          impedanceOhms={impedanceOhms}
          etco2Value={metrics ? Math.round(metrics.etco2) : null}
          showFiltered={showFiltered}
          onToggleSignal={setShowFiltered}
          onStart={() => startSequence(displayArm)}
          traces={{
            ecg: showFiltered ? filteredSignal : rawSignal,
            pleth,
            etco2,
            writeCount,
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Patient intake & assessment gate
 * ------------------------------------------------------------------ */

function IntakeGate({
  patient,
  onAssess,
}: {
  patient: PatientParameters;
  onAssess: () => void;
}) {
  const circumstances = patient.specialCircumstances ?? [];
  const matrix = protocolMatrixFor(patient.initialRhythm);

  const profile: Array<[string, string]> = [
    ["Patient ID", patient.referenceId],
    ["Age", `${patient.ageYears} y`],
    ["Weight", `${patient.weightKg} kg`],
    ["Transthoracic impedance", `${patient.transthoracicImpedanceOhms} Ω`],
    ["Time down without CPR", `${patient.timeDownWithoutCprMinutes} min`],
    ["Presentation rhythm", matrix.label],
  ];

  return (
    <div className="space-y-4">
      <GlassPanel title="Patient intake profile — locked" accent="blue">
        <dl className="grid gap-2 sm:grid-cols-3">
          {profile.map(([label, value]) => (
            <div
              key={label}
              className="rounded-xl bg-monitor-900/60 px-3 py-2"
            >
              <dt className="text-[9px] uppercase tracking-[0.14em] text-readout-dim">
                {label}
              </dt>
              <dd className="tabular mt-1 text-sm text-readout">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[9px] uppercase tracking-[0.14em] text-readout-dim">
            Special circumstances
          </span>
          {circumstances.length === 0 ? (
            <span className="text-[11px] text-readout-faint">none flagged</span>
          ) : (
            circumstances.map((circumstance) => (
              <span
                key={circumstance}
                className="flex items-center gap-1 rounded-full border border-alert-advisory/50 bg-alert-advisory/10 px-2 py-0.5 text-[10px] text-alert-advisory"
              >
                <ShieldAlert className="size-2.5" aria-hidden />
                {SPECIAL_CIRCUMSTANCE_LABELS[circumstance]}
              </span>
            ))
          )}
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-readout-faint">
          The resuscitation tabs stay locked until the rhythm has been scanned
          and the KKM algorithm confirmed. Both routes then run the same
          20-minute sequence, time-lapsed into{" "}
          {PLAYBACK_DURATION_MS / 1000} seconds.
        </p>
      </GlassPanel>

      <button
        type="button"
        onClick={onAssess}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-xl border border-signal-blue/45",
          "bg-signal-blue/12 px-4 py-4 text-sm font-semibold uppercase tracking-[0.16em]",
          "text-signal-blue transition hover:bg-signal-blue/20 hover:shadow-glow-blue",
        )}
      >
        <Stethoscope className="size-4" aria-hidden />
        Assess Patient &amp; Confirm ACLS Protocol
      </button>
    </div>
  );
}

function AssessmentSummary({
  assessment,
  collapsed = false,
}: {
  assessment: RhythmAssessment;
  collapsed?: boolean;
}) {
  const tone = assessment.shockable
    ? "border-trace-ecg/50 bg-trace-ecg/[0.08] text-trace-ecg"
    : "border-alert-advisory/50 bg-alert-advisory/[0.08] text-alert-advisory";

  return (
    <GlassPanel
      title="Clinical assessment"
      accent={assessment.shockable ? "ecg" : "none"}
      action={
        <span className="tabular text-[10px] text-readout-dim">
          AMSA {assessment.initialAmsa.toFixed(1)} mV·Hz
          {assessment.shockable && ` · opens at ${assessment.initialOideJoules} J`}
        </span>
      }
    >
      <div
        className={cn(
          "flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border px-3 py-2.5",
          tone,
        )}
        role="status"
      >
        <span className="text-sm font-bold uppercase tracking-[0.1em]">
          {assessment.verdict}
        </span>
        <span className="text-xs opacity-90">{assessment.rhythmLabel}</span>
        <span className="text-[11px] opacity-75">{assessment.protocol}</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ul
          className={cn(
            "mt-3 space-y-1.5 text-[11px] leading-relaxed text-readout-dim",
            collapsed && "max-h-40 overflow-y-auto pr-1",
          )}
        >
          {assessment.findings.map((finding) => (
            <li key={finding} className="flex gap-2">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-signal-blue/70" />
              {finding}
            </li>
          ))}
        </ul>

        <div className="mt-3">
          <p className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-readout-dim">
            KKM protocol notes
            {assessment.circumstances.length > 0 &&
              ` · ${assessment.circumstances.length} special circumstance${
                assessment.circumstances.length === 1 ? "" : "s"
              }`}
          </p>
          <ul
            className={cn(
              "space-y-1.5 text-[11px] leading-relaxed text-readout-dim",
              collapsed && "max-h-40 overflow-y-auto pr-1",
            )}
          >
            {assessment.protocolNotes.map((note) => (
              <li key={note} className="flex gap-2">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-alert-advisory/70" />
                {note}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </GlassPanel>
  );
}

/* ------------------------------------------------------------------ *
 * Header & tabs
 * ------------------------------------------------------------------ */

function SessionHeader({
  patient,
  assessment,
  activeArm,
  completed,
  simulatedMs,
}: {
  patient: PatientParameters;
  assessment: RhythmAssessment;
  activeArm: Arm | null;
  completed: Partial<Record<Arm, AclsArmResult>>;
  simulatedMs: number;
}) {
  const facts = [
    `${patient.ageYears} y`,
    `${patient.weightKg} kg`,
    `${assessment.impedanceOhms} Ω`,
    assessment.rhythmLabel,
    ...(assessment.family === "cardiac-arrest"
      ? [`${patient.timeDownWithoutCprMinutes} min down`]
      : []),
    ...assessment.circumstances.map(
      (circumstance) => SPECIAL_CIRCUMSTANCE_LABELS[circumstance],
    ),
  ];

  const runsDone = PROTOCOL_ARMS.filter(
    (arm) => completed[arm] !== undefined,
  ).length;

  return (
    <div className="glass-panel flex flex-wrap items-center justify-between gap-4 rounded-2xl px-4 py-3">
      <div>
        <h1 className="tabular text-lg font-semibold tracking-tight">
          {patient.referenceId}
        </h1>
        <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-readout-dim">
          {facts.map((fact) => (
            <span key={fact} className="tabular">
              {fact}
            </span>
          ))}
        </p>
      </div>

      <div className="flex items-center gap-5">
        <div className="text-right">
          <p className="tabular text-2xl leading-none text-readout">
            {formatElapsed(simulatedMs)}
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-readout-dim">
            Simulated · 1 s = {TIME_LAPSE_FACTOR} s
          </p>
        </div>
        <div className="text-right">
          <p
            className={cn(
              "tabular text-2xl leading-none",
              runsDone === 2 ? "text-trace-ecg" : "text-readout-dim",
            )}
          >
            {runsDone}/2
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-readout-dim">
            {activeArm ? "Running" : "Routes complete"}
          </p>
        </div>
      </div>
    </div>
  );
}

function TabBar({
  view,
  family,
  activeArm,
  completed,
  bothComplete,
  onSelect,
}: {
  view: Arm | "comparison";
  family: KkmProtocolFamily;
  activeArm: Arm | null;
  completed: Partial<Record<Arm, AclsArmResult>>;
  bothComplete: boolean;
  onSelect: (next: Arm | "comparison") => void;
}) {
  return (
    <div
      className="grid gap-2 sm:grid-cols-3"
      role="tablist"
      aria-label="Protocol route"
    >
      {PROTOCOL_ARMS.map((arm) => {
        const running = activeArm === arm;
        const locked = activeArm !== null && activeArm !== arm;
        const done = completed[arm] !== undefined;
        const selected = view === arm;

        return (
          <button
            key={arm}
            type="button"
            role="tab"
            aria-selected={selected}
            // A locked tab cannot be opened: switching mid-run would tear the
            // waveform away from the sequence that is driving it.
            disabled={locked}
            onClick={() => onSelect(arm)}
            className={cn(
              "flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition",
              selected
                ? "border-signal-blue/60 bg-signal-blue/12 text-signal-blue"
                : "border-monitor-600 text-readout-dim hover:border-monitor-500 hover:text-readout",
              locked && "cursor-not-allowed opacity-45 hover:border-monitor-600",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold uppercase tracking-wide">
                {ARM_LABELS[arm]}
              </span>
              <span className="block text-[10px] text-readout-faint">
                {ARM_STRATEGY[family][arm]}
              </span>
            </span>
            <StatusBadge running={running} locked={locked} done={done} />
          </button>
        );
      })}

      <button
        type="button"
        role="tab"
        aria-selected={view === "comparison"}
        disabled={!bothComplete}
        title={
          bothComplete
            ? undefined
            : "Both routes must finish their time-lapsed runs first"
        }
        onClick={() => onSelect("comparison")}
        className={cn(
          "flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition",
          view === "comparison"
            ? "border-trace-ecg/60 bg-trace-ecg/12 text-trace-ecg"
            : bothComplete
              ? "border-trace-ecg/40 bg-trace-ecg/[0.06] text-trace-ecg hover:bg-trace-ecg/15"
              : "border-monitor-600 text-readout-dim",
          !bothComplete && "cursor-not-allowed opacity-45",
        )}
      >
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold">
            Compare Both Routes
          </span>
          <span className="block text-[10px] text-readout-faint">
            {bothComplete
              ? "Energy, injury index, ROSC and survival"
              : "Locked until both runs complete"}
          </span>
        </span>
        {bothComplete ? (
          <BarChart3 className="size-4 shrink-0" aria-hidden />
        ) : (
          <Lock className="size-4 shrink-0" aria-hidden />
        )}
      </button>
    </div>
  );
}

function StatusBadge({
  running,
  locked,
  done,
}: {
  running: boolean;
  locked: boolean;
  done: boolean;
}) {
  if (running) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-alert-advisory/60 bg-alert-advisory/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-alert-advisory">
        <Radio className="size-2.5 animate-alarm-pulse" aria-hidden />
        Running
      </span>
    );
  }

  if (locked) {
    return (
      <span className="shrink-0 rounded-full border border-monitor-500 bg-monitor-800/70 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-readout-dim">
        Simulation in Progress…
      </span>
    );
  }

  if (done) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-trace-ecg/60 bg-trace-ecg/12 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-trace-ecg">
        <CheckCircle2 className="size-2.5" aria-hidden />
        Complete
      </span>
    );
  }

  return (
    <span className="shrink-0 rounded-full border border-monitor-600 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-readout-faint">
      Standby
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * One route's time-lapsed workspace
 * ------------------------------------------------------------------ */

interface TraceBuffers {
  ecg: React.RefObject<Float32Array>;
  pleth: React.RefObject<Float32Array>;
  etco2: React.RefObject<Float32Array>;
  writeCount: React.RefObject<number>;
}

function ArmWorkspace({
  arm,
  assessment,
  frame,
  heartRate,
  result,
  running,
  lockedBy,
  impedanceOhms,
  etco2Value,
  showFiltered,
  onToggleSignal,
  onStart,
  traces,
}: {
  arm: Arm;
  assessment: RhythmAssessment;
  frame: AclsPlaybackFrame;
  heartRate: number;
  result: AclsArmResult | null;
  running: boolean;
  lockedBy: Arm | null;
  impedanceOhms: number;
  etco2Value: number | null;
  showFiltered: boolean;
  onToggleSignal: (next: boolean) => void;
  onStart: () => void;
  traces: TraceBuffers;
}) {
  const progress = Math.min(
    100,
    (frame.simulatedMs / SIMULATED_DURATION_MS) * 100,
  );
  const pacing = assessment.family === "bradycardia";

  return (
    <div className="space-y-4">
      <GlassPanel
        title={ARM_LABELS[arm].toUpperCase()}
        accent={arm === "oide" ? "ecg" : "none"}
        action={
          <span className="tabular text-[10px] text-readout-dim">
            {pacing
              ? `${frame.paceOutputMa || "—"} mA pacing`
              : `${frame.shockCount} shocks · ${frame.cumulativeJoules} J`}
          </span>
        }
      >
        <SequenceControl
          arm={arm}
          assessment={assessment}
          running={running}
          lockedBy={lockedBy}
          result={result}
          progress={progress}
          simulatedMs={frame.simulatedMs}
          onStart={onStart}
        />
      </GlassPanel>

      <div className="grid items-start gap-4 xl:grid-cols-[1fr_21rem]">
        <GlassPanel
          title="Live telemetry"
          accent="ecg"
          action={
            <SignalToggle
              showFiltered={showFiltered}
              onChange={onToggleSignal}
            />
          }
        >
          <div className="space-y-3">
            <WaveformCanvas
              buffer={traces.ecg}
              writeCount={traces.writeCount}
              color={showFiltered ? "#B388FF" : "#00FFAA"}
              mode="bipolar"
              range={1.3}
              label={
                showFiltered
                  ? "II — DSP filtered (adaptive LMS)"
                  : "II — raw (CPR artefact)"
              }
              scaleLabel="±1.3 mV"
            />
            <WaveformCanvas
              buffer={traces.pleth}
              writeCount={traces.writeCount}
              color="#00E5FF"
              mode="unipolar"
              range={1.1}
              label="Pleth — SpO₂"
              scaleLabel={
                frame.compressionsActive
                  ? `compression pulses · ${COMPRESSION_RATE}/min`
                  : frame.rhythm === "sinus"
                    ? "pulsatile"
                    : "no pulsatile flow"
              }
              className="h-24"
            />
            <WaveformCanvas
              buffer={traces.etco2}
              writeCount={traces.writeCount}
              color="#FFD60A"
              mode="unipolar"
              range={50}
              label="EtCO₂ — capnography"
              scaleLabel="0–50 mmHg"
              className="h-24"
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Readout
              icon={HeartPulse}
              label="Heart rate"
              value={heartRate > 0 ? String(heartRate) : "— —"}
              unit="bpm"
              tone={
                heartRate === 0
                  ? "text-readout-faint"
                  : frame.rhythm === "sinus"
                    ? "text-trace-ecg"
                    : "text-alert-advisory"
              }
              hint={
                frame.rhythm === "sinus" && pacing ? "paced, demand mode" : undefined
              }
            />
            <Readout
              icon={Activity}
              label="Live AMSA"
              value={assessment.shockable ? frame.amsa.toFixed(1) : "n/a"}
              unit={assessment.shockable ? "mV·Hz" : ""}
              tone={
                assessment.shockable ? "text-signal-blue" : "text-readout-faint"
              }
              hint={assessment.shockable ? undefined : "no fibrillatory waveform"}
            />
            {pacing ? (
              <Readout
                icon={Zap}
                label={arm === "traditional" ? "Fixed output" : "Calibrated output"}
                value={String(frame.paceOutputMa || "—")}
                unit="mA"
                tone={
                  arm === "traditional"
                    ? "text-alert-critical"
                    : "text-trace-ecg"
                }
                hint={`capture needs ${paceCaptureRequirementMa(impedanceOhms)} mA`}
              />
            ) : (
              <Readout
                icon={Zap}
                label={arm === "traditional" ? "Fixed energy" : "Calibrated energy"}
                value={String(
                  arm === "traditional"
                    ? assessment.initialTraditionalJoules
                    : assessment.shockable
                      ? frame.recommendedJoules
                      : assessment.initialOideJoules,
                )}
                unit="J"
                tone={arm === "traditional" ? "text-alert-critical" : "text-trace-ecg"}
                hint={
                  arm === "traditional"
                    ? `OIDE would use ${assessment.shockable ? frame.recommendedJoules : assessment.initialOideJoules} J`
                    : `vs ${assessment.initialTraditionalJoules} J guideline dose`
                }
              />
            )}
            <Readout
              icon={Droplet}
              label="EtCO₂"
              value={etco2Value === null ? "—" : String(etco2Value)}
              unit="mmHg"
              tone="text-trace-resp"
            />
            <Readout
              icon={Gauge}
              label="Impedance"
              value={String(impedanceOhms)}
              unit="Ω"
              tone="text-readout"
            />
          </div>

          {assessment.shockable && (
            <div className="mt-3 border-t border-monitor-600/60 pt-3">
              <AmsaGauge amsa={frame.amsa} />
            </div>
          )}
        </GlassPanel>

        <EventFeed events={frame.events} />
      </div>
    </div>
  );
}

function SequenceControl({
  arm,
  assessment,
  running,
  lockedBy,
  result,
  progress,
  simulatedMs,
  onStart,
}: {
  arm: Arm;
  assessment: RhythmAssessment;
  running: boolean;
  lockedBy: Arm | null;
  result: AclsArmResult | null;
  progress: number;
  simulatedMs: number;
  onStart: () => void;
}) {
  const conversion = CONVERSION_LABEL[assessment.family];
  const conversionNoun = CONVERSION_NOUN[assessment.family];
  const pacing = assessment.family === "bradycardia";

  if (result) {
    return (
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-trace-ecg/45 bg-trace-ecg/[0.08] px-3 py-3">
          <CheckCircle2 className="size-5 shrink-0 text-trace-ecg" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-trace-ecg">
              Sequence complete —{" "}
              {result.roscAchieved
                ? `${conversion} at ${formatElapsed(result.roscAtMs ?? 0)}`
                : `no ${conversionNoun} inside the 20-minute window`}
            </span>
            <span className="block text-[10px] text-readout-faint">
              {pacing
                ? `paced at ${result.paceOutputMa} mA`
                : `${result.shockCount} shocks · ${result.cumulativeJoules} J delivered`}{" "}
              · MII {result.myocardialInjuryIndex.toFixed(1)} · pre-shock pause{" "}
              {result.totalPreShockPauseMs} ms · survival{" "}
              {(result.survivalLikelihood * 100).toFixed(0)}%
              {result.deferredShockCount > 0 &&
                ` · ${result.deferredShockCount} shocks withheld`}
            </span>
          </span>
        </div>
        <ProgressBar progress={100} label="Run complete" />
      </div>
    );
  }

  if (running) {
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-3 rounded-xl border border-alert-advisory/55 bg-alert-advisory/10 px-3 py-3">
          <Radio
            className="size-5 shrink-0 animate-alarm-pulse text-alert-advisory"
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-alert-advisory">
              Simulation in progress — {formatElapsed(simulatedMs)} of{" "}
              {formatElapsed(SIMULATED_DURATION_MS)} simulated
            </span>
            <span className="block text-[10px] text-readout-faint">
              Time-lapse ×{TIME_LAPSE_FACTOR} · the other route is locked until
              this run finishes
            </span>
          </span>
        </div>
        <ProgressBar
          progress={progress}
          label={`${Math.round(progress)}% of the protocol window`}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onStart}
        disabled={lockedBy !== null}
        title={
          lockedBy !== null
            ? `${ARM_LABELS[lockedBy]} is mid-sequence`
            : undefined
        }
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-4",
          "text-sm font-semibold uppercase tracking-[0.16em] transition",
          arm === "oide"
            ? "border-trace-ecg/45 bg-trace-ecg/12 text-trace-ecg hover:bg-trace-ecg/20 hover:shadow-glow-ecg"
            : "border-alert-critical/50 bg-alert-critical/10 text-alert-critical hover:bg-alert-critical/20",
          lockedBy !== null &&
            "cursor-not-allowed opacity-40 hover:shadow-none hover:brightness-100",
        )}
      >
        <Play className="size-4" aria-hidden />
        Start {pacing ? "Bradycardia" : "Resuscitation"} Sequence (Time-Lapse)
      </button>
      <p className="text-[10px] leading-relaxed text-readout-faint">
        {formatElapsed(SIMULATED_DURATION_MS)} of protocol compressed into{" "}
        {PLAYBACK_DURATION_MS / 1000} s. {ARM_STRATEGY[assessment.family][arm]}.
        {assessment.family === "cardiac-arrest" &&
          ` 2-minute CPR blocks at ${COMPRESSION_RATE} CPM.`}
        {assessment.circumstances.length > 0 &&
          ` Special-circumstance modifications for ${assessment.circumstances
            .map((circumstance) => SPECIAL_CIRCUMSTANCE_LABELS[circumstance])
            .join(", ")} are applied to both routes.`}
      </p>
    </div>
  );
}

function ProgressBar({
  progress,
  label,
}: {
  progress: number;
  label: string;
}) {
  return (
    <div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-monitor-700"
        role="progressbar"
        aria-label="Protocol progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div
          className="h-full rounded-full bg-signal-blue transition-[width] duration-100 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="mt-1 text-[10px] text-readout-faint">{label}</p>
    </div>
  );
}

const SEVERITY_TONE: Record<AclsEvent["severity"], string> = {
  info: "border-monitor-600 text-readout-dim",
  success: "border-trace-ecg/50 text-trace-ecg",
  advisory: "border-alert-advisory/50 text-alert-advisory",
  critical: "border-alert-critical/50 text-alert-critical",
};

/** Scrolling live event log, newest line pinned into view. */
function EventFeed({ events }: { events: AclsEvent[] }) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [events.length]);

  return (
    <GlassPanel
      title="Live event log"
      accent="blue"
      action={
        <span className="tabular text-[10px] text-readout-dim">
          {events.length} events
        </span>
      }
    >
      <ol
        ref={listRef}
        // Fixed height rather than min/max: the feed has to scroll rather than
        // grow, or the waveforms shift down every time a line lands.
        className="h-[28rem] space-y-1.5 overflow-y-auto pr-1"
        aria-live="polite"
      >
        {events.length === 0 && (
          <li className="text-[11px] text-readout-faint">
            Waiting for the sequence to start…
          </li>
        )}
        {events.map((event, index) => (
          <li
            key={`${event.atMs}-${event.kind}-${index}`}
            className={cn(
              "border-l-2 pl-2.5 text-[11px] leading-snug",
              SEVERITY_TONE[event.severity],
            )}
          >
            <span className="tabular mr-1.5 text-readout-faint">
              [{formatElapsed(event.atMs)}]
            </span>
            {event.message}
          </li>
        ))}
      </ol>
    </GlassPanel>
  );
}

/* ------------------------------------------------------------------ *
 * Shared chrome
 * ------------------------------------------------------------------ */

function SignalToggle({
  showFiltered,
  onChange,
}: {
  showFiltered: boolean;
  onChange: (next: boolean) => void;
}) {
  const options = [
    { value: false, label: "Raw" },
    { value: true, label: "DSP filtered" },
  ];

  return (
    <div className="flex gap-1" role="group" aria-label="ECG signal source">
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={showFiltered === option.value}
          className={cn(
            "rounded-lg border px-2.5 py-1 text-[10px] transition",
            showFiltered === option.value
              ? "border-signal-blue/60 bg-signal-blue/12 text-signal-blue"
              : "border-monitor-600 text-readout-dim hover:border-monitor-500 hover:text-readout",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Readout({
  icon: Icon,
  label,
  value,
  unit,
  tone,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  unit: string;
  tone: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl bg-monitor-900/60 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-[0.14em] text-readout-dim">
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <p className={cn("tabular mt-1 text-2xl leading-none", tone)}>
        {value}
        <span className="ml-1 text-[10px] text-readout-faint">{unit}</span>
      </p>
      {hint && (
        <p className="mt-0.5 truncate text-[9px] text-readout-faint">{hint}</p>
      )}
    </div>
  );
}
