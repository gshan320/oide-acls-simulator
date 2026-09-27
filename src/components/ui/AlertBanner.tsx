import { AlertTriangle, Info, ShieldAlert, Siren } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type AlertLevel = "info" | "advisory" | "urgent" | "critical";

const levelStyle: Record<
  AlertLevel,
  { wrap: string; icon: LucideIcon; text: string }
> = {
  info: {
    wrap: "border-signal-blue/40 bg-signal-blue/10",
    icon: Info,
    text: "text-signal-blue",
  },
  advisory: {
    wrap: "border-alert-advisory/45 bg-alert-advisory/10",
    icon: AlertTriangle,
    text: "text-alert-advisory",
  },
  urgent: {
    wrap: "border-alert-urgent/50 bg-alert-urgent/12",
    icon: ShieldAlert,
    text: "text-alert-urgent",
  },
  critical: {
    wrap: "border-alert-critical/60 bg-alert-critical/15 shadow-glow-alert",
    icon: Siren,
    text: "text-alert-critical",
  },
};

interface AlertBannerProps {
  level: AlertLevel;
  title: string;
  detail?: string;
  className?: string;
}

/** Escalating alarm strip shown above the monitors. */
export function AlertBanner({
  level,
  title,
  detail,
  className,
}: AlertBannerProps) {
  const { wrap, icon: Icon, text } = levelStyle[level];

  return (
    <div
      role={level === "critical" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3",
        wrap,
        className,
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          text,
          level === "critical" && "animate-alarm-pulse",
        )}
        aria-hidden
      />
      <div className="min-w-0">
        <p className={cn("text-sm font-semibold", text)}>{title}</p>
        {detail && (
          <p className="mt-0.5 text-xs text-readout-dim">{detail}</p>
        )}
      </div>
    </div>
  );
}
