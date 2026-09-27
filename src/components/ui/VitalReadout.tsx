import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type VitalTone = "ecg" | "blue" | "resp" | "abp" | "warn" | "critical";

const toneText: Record<VitalTone, string> = {
  ecg: "text-trace-ecg",
  blue: "text-trace-spo2",
  resp: "text-trace-resp",
  abp: "text-trace-abp",
  warn: "text-alert-advisory",
  critical: "text-alert-critical",
};

interface VitalReadoutProps {
  label: string;
  value: number | string;
  unit?: string;
  tone?: VitalTone;
  icon?: LucideIcon;
  /** Flash the readout — use for out-of-range vitals. */
  alarming?: boolean;
  className?: string;
}

/** Large tabular numeric readout, styled like a bedside monitor field. */
export function VitalReadout({
  label,
  value,
  unit,
  tone = "ecg",
  icon: Icon,
  alarming = false,
  className,
}: VitalReadoutProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-xl bg-monitor-900/60 px-3 py-2",
        alarming && "animate-alarm-pulse ring-1 ring-alert-critical/60",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-readout-dim">
        {Icon && <Icon className="size-3" aria-hidden />}
        <span>{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={cn("tabular text-4xl leading-none", toneText[tone])}>
          {value}
        </span>
        {unit && <span className="text-xs text-readout-faint">{unit}</span>}
      </div>
    </div>
  );
}
