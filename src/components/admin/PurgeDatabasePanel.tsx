"use client";

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import { GlassPanel } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  countStoredData,
  purgeAllData,
  type PurgeSummary,
} from "@/lib/firebase/firestore";

type Phase =
  | { kind: "idle" }
  | { kind: "counting" }
  | { kind: "confirming"; found: PurgeSummary }
  | { kind: "purging" }
  | { kind: "done"; removed: PurgeSummary }
  | { kind: "error"; message: string };

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * One-click Firestore purge for the research environment.
 *
 * Deleting every recorded session is irreversible and there is no undo, so the
 * single click opens a confirmation that quotes the **actual** stored counts
 * first. That is the difference between a deliberate reset and a misclick on a
 * homepage, and reading the counts costs one round trip.
 */
export function PurgeDatabasePanel({ disabled = false }: { disabled?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const begin = useCallback(async () => {
    setPhase({ kind: "counting" });
    try {
      setPhase({ kind: "confirming", found: await countStoredData() });
    } catch (cause) {
      setPhase({
        kind: "error",
        message: message(cause, "Could not read the database."),
      });
    }
  }, []);

  const purge = useCallback(async () => {
    setPhase({ kind: "purging" });
    try {
      setPhase({ kind: "done", removed: await purgeAllData() });
    } catch (cause) {
      setPhase({
        kind: "error",
        message: message(cause, "The purge did not complete."),
      });
    }
  }, []);

  const busy = phase.kind === "counting" || phase.kind === "purging";

  return (
    <GlassPanel
      title="Database maintenance"
      accent={phase.kind === "confirming" ? "alert" : "none"}
      action={
        <span className="text-[10px] uppercase tracking-[0.14em] text-readout-faint">
          Simulations · Interventions · AmsaLogs
        </span>
      }
    >
      <p className="text-[11px] leading-relaxed text-readout-dim">
        Firestore accumulates every session ever recorded. Clear it so the next
        run is the only thing in the database — exports and debriefs then contain
        new data only, with no old sessions mixed in.
      </p>

      {disabled ? (
        <p className="mt-3 rounded-lg border border-monitor-600 bg-monitor-900/60 px-3 py-2 text-[11px] text-readout-faint">
          Firebase is not configured, so there is nothing stored to clear.
        </p>
      ) : (
        <div className="mt-3">
          {(phase.kind === "idle" || phase.kind === "counting") && (
            <button
              type="button"
              onClick={() => void begin()}
              disabled={busy}
              className={cn(
                "flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-3",
                "border-alert-critical/45 bg-alert-critical/10 text-sm font-semibold",
                "uppercase tracking-[0.16em] text-alert-critical transition",
                "hover:bg-alert-critical/20",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {phase.kind === "counting" ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Reading database…
                </>
              ) : (
                <>
                  <Trash2 className="size-4" aria-hidden />
                  Clear All Simulation Data
                </>
              )}
            </button>
          )}

          {phase.kind === "confirming" && (
            <div
              role="alertdialog"
              aria-label="Confirm database purge"
              className="rounded-xl border border-alert-critical/50 bg-alert-critical/[0.08] p-3"
            >
              <p className="flex items-start gap-2 text-xs font-semibold text-alert-critical">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {phase.found.sessions === 0
                  ? "The database is already empty."
                  : `Permanently delete ${plural(phase.found.sessions, "session")}?`}
              </p>

              {phase.found.sessions > 0 && (
                <dl className="tabular mt-2.5 grid grid-cols-3 gap-2">
                  {(
                    [
                      ["Sessions", phase.found.sessions],
                      ["Interventions", phase.found.interventions],
                      ["AMSA logs", phase.found.amsaLogs],
                    ] as const
                  ).map(([label, count]) => (
                    <div
                      key={label}
                      className="rounded-lg bg-monitor-900/60 px-2.5 py-2"
                    >
                      <dt className="text-[9px] uppercase tracking-[0.14em] text-readout-dim">
                        {label}
                      </dt>
                      <dd className="mt-1 text-lg leading-none text-readout">
                        {count.toLocaleString()}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              <p className="mt-2.5 text-[11px] leading-relaxed text-readout-dim">
                {phase.found.sessions > 0
                  ? "This cannot be undone. Export anything you still need first."
                  : "Nothing will be deleted."}
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void purge()}
                  disabled={phase.found.sessions === 0}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2",
                    "border-alert-critical/60 bg-alert-critical/20 text-xs font-semibold",
                    "uppercase tracking-[0.14em] text-alert-critical transition",
                    "hover:bg-alert-critical/30",
                    "disabled:cursor-not-allowed disabled:opacity-40",
                  )}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Yes, delete everything
                </button>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "idle" })}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg border border-monitor-600",
                    "px-3 py-2 text-xs text-readout-dim transition",
                    "hover:border-monitor-500 hover:text-readout",
                  )}
                >
                  <X className="size-3.5" aria-hidden />
                  Cancel
                </button>
              </div>
            </div>
          )}

          {phase.kind === "purging" && (
            <p className="flex items-center gap-2 rounded-xl border border-alert-advisory/50 bg-alert-advisory/10 px-3 py-3 text-xs text-alert-advisory">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Deleting subcollections, then sessions…
            </p>
          )}

          {phase.kind === "done" && (
            <div className="rounded-xl border border-trace-ecg/50 bg-trace-ecg/[0.08] px-3 py-3">
              <p className="flex items-center gap-2 text-xs font-semibold text-trace-ecg">
                <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                Database cleared
              </p>
              <p className="tabular mt-1 text-[11px] text-readout-dim">
                Removed {plural(phase.removed.sessions, "session")},{" "}
                {plural(phase.removed.interventions, "intervention")} and{" "}
                {plural(phase.removed.amsaLogs, "AMSA log")}. The next session
                will be the only thing stored.
              </p>
              <button
                type="button"
                onClick={() => setPhase({ kind: "idle" })}
                className="mt-2 text-[11px] text-signal-blue underline-offset-2 hover:underline"
              >
                Check again
              </button>
            </div>
          )}

          {phase.kind === "error" && (
            <div
              role="alert"
              className="rounded-xl border border-alert-critical/50 bg-alert-critical/12 px-3 py-3"
            >
              <p className="flex items-center gap-2 text-xs font-semibold text-alert-critical">
                <Database className="size-4 shrink-0" aria-hidden />
                {phase.message}
              </p>
              <button
                type="button"
                onClick={() => setPhase({ kind: "idle" })}
                className="mt-2 text-[11px] text-signal-blue underline-offset-2 hover:underline"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </GlassPanel>
  );
}
