import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Accent = "none" | "ecg" | "blue" | "alert";

const accentRing: Record<Accent, string> = {
  none: "",
  ecg: "border-trace-ecg/35 shadow-glow-ecg",
  blue: "border-signal-blue/35 shadow-glow-blue",
  alert: "border-alert-critical/45 shadow-glow-alert",
};

interface GlassPanelProps {
  children: ReactNode;
  /** Small uppercase label rendered in the panel header. */
  title?: string;
  /** Right-aligned header slot — status chips, unit toggles, etc. */
  action?: ReactNode;
  accent?: Accent;
  className?: string;
}

/** Frosted control surface — the base container for every simulator module. */
export function GlassPanel({
  children,
  title,
  action,
  accent = "none",
  className,
}: GlassPanelProps) {
  return (
    <section
      className={cn(
        "glass-panel rounded-2xl",
        accentRing[accent],
        className,
      )}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-monitor-600/60 px-4 py-2.5">
          {title && (
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-readout-dim">
              {title}
            </h2>
          )}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}
