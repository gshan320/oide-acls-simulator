"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Activity } from "lucide-react";
import { PatientForm } from "@/components/simulator";
import { AlertBanner } from "@/components/ui";
import { createSimulationSession } from "@/lib/firebase/firestore";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import type { PatientParameters } from "@/types/session";

export default function ScenarioPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (parameters: PatientParameters) => {
    setSubmitting(true);
    setError(null);

    try {
      const simId = await createSimulationSession(parameters);
      router.push(`/monitor?sim=${encodeURIComponent(simId)}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create the simulation session.",
      );
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-6 flex items-center gap-3">
        <Activity className="size-6 text-trace-ecg" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Scenario setup
          </h1>
          <p className="text-xs text-readout-dim">
            Parameters are written to Simulations/&#123;simId&#125; before the
            monitor opens.
          </p>
        </div>
      </header>

      {!isFirebaseConfigured && (
        <AlertBanner
          className="mb-4"
          level="advisory"
          title="Firebase is not configured"
          detail="Fill in NEXT_PUBLIC_FIREBASE_* in .env.local. Starting a simulation will fail until then."
        />
      )}

      <PatientForm
        onSubmit={handleSubmit}
        submitting={submitting}
        error={error}
      />
    </main>
  );
}
