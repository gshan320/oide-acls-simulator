"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { OutcomeAnalysis } from "@/components/simulator";
import { AlertBanner } from "@/components/ui";
import { exportSessionData } from "@/lib/firebase/firestore";
import { downloadJson, sessionExportFilename } from "@/lib/exportFile";
import type { SessionExportBundle } from "@/types/session";

export default function DebriefPage() {
  return (
    <Suspense fallback={null}>
      <DebriefView />
    </Suspense>
  );
}

function DebriefView() {
  const simId = useSearchParams().get("sim");
  return simId ? <SessionDebrief simId={simId} /> : <NoSession />;
}

/** Loads a concluded session straight from Firestore and re-renders its dashboard. */
function SessionDebrief({ simId }: { simId: string }) {
  const [bundle, setBundle] = useState<SessionExportBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    exportSessionData(simId)
      .then((result) => {
        if (!cancelled) setBundle(result);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Could not load session.");
      });

    // Guard against a late resolve writing into an unmounted component.
    return () => {
      cancelled = true;
    };
  }, [simId]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      // Re-fetch rather than reusing the mount-time bundle, so the export
      // always reflects the current state of the collections.
      const fresh = await exportSessionData(simId);
      setBundle(fresh);
      downloadJson(sessionExportFilename(simId), fresh);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }, [simId]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <AlertBanner
          level="critical"
          title="Could not load debrief"
          detail={error}
        />
      </main>
    );
  }

  if (!bundle) {
    return (
      <main className="mx-auto flex max-w-7xl items-center gap-3 px-6 py-10 text-sm text-readout-dim">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading debrief for {simId}…
      </main>
    );
  }

  if (!bundle.session.outcome) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <AlertBanner
          level="advisory"
          title="Session has not concluded"
          detail={`${simId} is still marked ${bundle.session.status}. Finish the scenario on the monitor to produce a debrief.`}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Debrief</h1>
      <OutcomeAnalysis
        session={bundle.session}
        outcome={bundle.session.outcome}
        amsaLogs={bundle.amsaLogs}
        interventions={bundle.interventions}
        onExport={handleExport}
        exporting={exporting}
        exportError={exportError}
      />
    </main>
  );
}

function NoSession() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Debrief</h1>
      <AlertBanner
        level="advisory"
        title="No session selected"
        detail="Append ?sim={simId} to reload a concluded session's comparative dashboard. A session concludes once both protocol routes have finished their time-lapsed runs on the monitor."
      />
    </main>
  );
}
