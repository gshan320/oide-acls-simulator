import Link from "next/link";
import { Activity, BarChart3, ClipboardList, MonitorPlay } from "lucide-react";
import { AlertBanner, GlassPanel } from "@/components/ui";
import { PurgeDatabasePanel } from "@/components/admin";
import { isFirebaseConfigured } from "@/lib/firebase/config";

const MODULES = [
  {
    href: "/scenario",
    icon: ClipboardList,
    title: "Patient intake",
    body: "Vitals, presentation rhythm, and the ACLS special circumstances that modify the algorithm.",
  },
  {
    href: "/monitor",
    icon: MonitorPlay,
    title: "Dual-arm workspace",
    body: "Traditional KKM protocol and OIDE calibrated energy, each time-lapsed into 60 seconds.",
  },
  {
    href: "/debrief",
    icon: BarChart3,
    title: "Comparative outcomes",
    body: "Energy, myocardial injury index, pre-shock pause, and the AMSA trajectory overlay.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-6 py-12">
      <header className="flex items-center gap-3">
        <Activity className="size-7 text-trace-ecg" aria-hidden />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            OIDE ACLS Simulator
          </h1>
          <p className="text-sm text-readout-dim">
            Advanced cardiac life support, instrumented.
          </p>
        </div>
      </header>

      {!isFirebaseConfigured && (
        <AlertBanner
          level="advisory"
          title="Firebase is not configured"
          detail="Fill in the NEXT_PUBLIC_FIREBASE_* values in .env.local to enable session persistence and the transactional event log."
        />
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {MODULES.map(({ href, icon: Icon, title, body }) => (
          <Link key={href} href={href} className="group">
            <GlassPanel className="h-full transition group-hover:border-signal-blue/50">
              <Icon className="size-5 text-signal-blue" aria-hidden />
              <h2 className="mt-3 text-sm font-semibold text-readout">
                {title}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-readout-dim">
                {body}
              </p>
            </GlassPanel>
          </Link>
        ))}
      </div>

      <PurgeDatabasePanel disabled={!isFirebaseConfigured} />

      <p className="mt-auto text-xs text-readout-faint">
        Training use only. Not a medical device and not for clinical
        decision-making.
      </p>
    </main>
  );
}
