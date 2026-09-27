"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { AutomatedDualSimulator } from "@/components/simulator";
import { AlertBanner } from "@/components/ui";
import {
  exportSessionData,
  flushAmsaLogs,
  logAmsaTimepoint,
  logSimulationAction,
  saveFinalOutcome,
  subscribeToSimulation,
} from "@/lib/firebase/firestore";
import { downloadJson, sessionExportFilename } from "@/lib/exportFile";
import type {
  AmsaTimepointPayload,
  InterventionPayload,
  SimulationOutcome,
  SimulationSessionDoc,
} from "@/types/session";

/**
 * The automated dual-arm workspace.
 *
 * `?sim={simId}` opens a persisted session created by the intake form; without
 * one the page renders the same workspace against a local fixture so the
 * architecture can be inspected with no Firestore project attached. There are
 * no manual protocol controls on either path — both arms are generated up front
 * by the rules engine and played back.
 */
export default function MonitorPage() {
  return (
    <Suspense fallback={null}>
      <MonitorView />
    </Suspense>
  );
}

function MonitorView() {
  const simId = useSearchParams().get("sim");
  return simId ? <LiveSession simId={simId} /> : <PreviewSession />;
}

/* ------------------------------------------------------------------ *
 * Local fixture — nothing is persisted
 * ------------------------------------------------------------------ */

const PREVIEW_SESSION: SimulationSessionDoc = {
  simId: "OIDE-PREVIEW",
  patient: {
    referenceId: "OIDE-PREVIEW",
    ageYears: 65,
    weightKg: 85,
    transthoracicImpedanceOhms: 90,
    timeDownWithoutCprMinutes: 4,
    initialRhythm: "vfib",
    comorbidities: { ischemicHeartDisease: true, previousMi: true },
    specialCircumstances: [],
  },
  status: "active",
  startedAtMs: 0,
  outcome: null,
};

function PreviewSession() {
  const noop = useCallback(() => {}, []);

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <AlertBanner
        className="mb-4"
        level="advisory"
        title="Preview mode — nothing is persisted"
        detail="No ?sim= was supplied, so the workspace is running against a local fixture. Interventions and AMSA timepoints are discarded rather than written to Firestore. Start from Patient intake to create a recorded session."
      />
      <AutomatedDualSimulator
        session={PREVIEW_SESSION}
        onIntervention={noop}
        onAmsaTimepoint={noop}
        onConclude={noop}
      />
    </main>
  );
}

/* ------------------------------------------------------------------ *
 * Live session, loaded from Simulations/{simId}
 * ------------------------------------------------------------------ */

function LiveSession({ simId }: { simId: string }) {
  const [session, setSession] = useState<SimulationSessionDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToSimulation(
      simId,
      (doc) => {
        setSession(doc);
        setLoading(false);
        if (!doc) setError(`Simulation ${simId} was not found.`);
      },
      (cause) => {
        setError(cause.message);
        setLoading(false);
      },
    );
    return unsubscribe;
  }, [simId]);

  // Leaving the monitor must not discard whatever is still buffered.
  useEffect(() => () => void flushAmsaLogs(simId), [simId]);

  /**
   * Interventions are written immediately — they are the audit trail. Nothing
   * is mirrored into local state: the simulator generates both arms up front
   * and renders its own comparison, so the page is a write path only.
   */
  const handleIntervention = useCallback(
    (payload: InterventionPayload) => {
      logSimulationAction(simId, payload).catch((cause: unknown) =>
        setLogError(
          cause instanceof Error ? cause.message : "Failed to log intervention.",
        ),
      );
    },
    [simId],
  );

  /** AMSA timepoints stream in during playback; the Firestore layer batches them. */
  const handleAmsaTimepoint = useCallback(
    (payload: AmsaTimepointPayload) => logAmsaTimepoint(simId, payload),
    [simId],
  );

  const handleConclude = useCallback(
    (result: SimulationOutcome) => {
      saveFinalOutcome(simId, result).catch((cause: unknown) =>
        setLogError(
          cause instanceof Error ? cause.message : "Failed to save outcome.",
        ),
      );
    },
    [simId],
  );

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const bundle = await exportSessionData(simId);
      downloadJson(sessionExportFilename(simId), bundle);
    } catch (cause) {
      setExportError(
        cause instanceof Error ? cause.message : "Export failed.",
      );
    } finally {
      setExporting(false);
    }
  }, [simId]);

  if (loading) {
    return (
      <main className="mx-auto flex max-w-7xl items-center gap-3 px-6 py-10 text-sm text-readout-dim">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading session {simId}…
      </main>
    );
  }

  if (error || !session) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <AlertBanner
          level="critical"
          title="Could not load simulation"
          detail={error ?? "Unknown error."}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      {logError && (
        <AlertBanner
          className="mb-4"
          level="advisory"
          title="Some events did not reach Firestore"
          detail={logError}
        />
      )}

      <AutomatedDualSimulator
        session={session}
        onIntervention={handleIntervention}
        onAmsaTimepoint={handleAmsaTimepoint}
        onConclude={handleConclude}
        onExport={handleExport}
        exporting={exporting}
        exportError={exportError}
      />
    </main>
  );
}
