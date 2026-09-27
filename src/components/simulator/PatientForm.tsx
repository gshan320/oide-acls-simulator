"use client";

import { useId, useState } from "react";
import {
  Activity,
  Baby,
  Dices,
  FlaskConical,
  Gauge,
  HeartPulse,
  Loader2,
  Lock,
  Scale,
  ShieldAlert,
  Snowflake,
  Timer,
  Weight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { GlassPanel } from "@/components/ui";
import { generateReadableId } from "@/lib/firebase/firestore";
import { cn } from "@/lib/utils";
import { KKM_INTAKE_GROUPS, kkmMatrixFor } from "@/lib/oide/kkmAclsRules";
import {
  INITIAL_RHYTHM_LABELS,
  SPECIAL_CIRCUMSTANCES,
  SPECIAL_CIRCUMSTANCE_LABELS,
  type PatientParameters,
  type SpecialCircumstance,
} from "@/types/session";

const IMPEDANCE_MIN = 40;
const IMPEDANCE_MAX = 150;

const DEFAULTS: PatientParameters = {
  referenceId: "",
  ageYears: 58,
  weightKg: 75,
  transthoracicImpedanceOhms: 75,
  timeDownWithoutCprMinutes: 0,
  initialRhythm: "vfib",
  comorbidities: { ischemicHeartDisease: false, previousMi: false },
  specialCircumstances: [],
};

/** Clinically plausible preset for the Quick Randomize button. */
const RANDOMIZE_PRESET: Omit<PatientParameters, "referenceId"> = {
  ageYears: 65,
  weightKg: 85,
  transthoracicImpedanceOhms: 90,
  timeDownWithoutCprMinutes: 4,
  initialRhythm: "vfib-fine",
  comorbidities: { ischemicHeartDisease: true, previousMi: true },
  specialCircumstances: [],
};

/** One line of clinical consequence per circumstance, shown under its toggle. */
const CIRCUMSTANCE_DETAIL: Record<
  SpecialCircumstance,
  { icon: LucideIcon; detail: string }
> = {
  pregnancy: {
    icon: Baby,
    detail: "Adds manual left uterine displacement and the PMCD decision point.",
  },
  hypothermia: {
    icon: Snowflake,
    detail: "Doubles drug intervals; withholds shocks until core > 30 °C.",
  },
  hyperkalemia: {
    icon: FlaskConical,
    detail: "Adds calcium chloride and sodium bicarbonate at 02:30.",
  },
  toxicological: {
    icon: ShieldAlert,
    detail: "Logs naloxone, then a weight-based lipid emulsion bolus.",
  },
  "morbid-obesity": {
    icon: Scale,
    detail: "Floors transthoracic impedance at 110 Ω — fixed energy under-delivers.",
  },
};

const fieldClass =
  "w-full rounded-lg border border-monitor-600 bg-monitor-900/70 px-3 py-2 text-sm text-readout " +
  "placeholder:text-readout-faint outline-none transition focus:border-signal-blue/70 " +
  "focus:ring-1 focus:ring-signal-blue/40";

const labelClass =
  "mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-readout-dim";

interface PatientFormProps {
  /** Resolve once the session exists; the page handles navigation. */
  onSubmit: (parameters: PatientParameters) => void | Promise<void>;
  initial?: PatientParameters;
  submitting?: boolean;
  /** Surfaced above the submit button, e.g. a failed Firestore write. */
  error?: string | null;
}

/**
 * Pre-brief intake for the OIDE simulator.
 *
 * The presenting rhythm is the single most consequential field on the form: it
 * selects which of the three KKM adult ALS algorithms the session runs under,
 * so the options are grouped by that algorithm rather than by waveform.
 */
export function PatientForm({
  onSubmit,
  initial = DEFAULTS,
  submitting = false,
  error = null,
}: PatientFormProps) {
  const [params, setParams] = useState<PatientParameters>(initial);
  const ids = useId();

  const circumstances = params.specialCircumstances ?? [];
  const matrix = kkmMatrixFor(params.initialRhythm);

  const set = <K extends keyof PatientParameters>(
    key: K,
    value: PatientParameters[K],
  ) => setParams((prev) => ({ ...prev, [key]: value }));

  const toggleComorbidity = (key: keyof PatientParameters["comorbidities"]) =>
    setParams((prev) => ({
      ...prev,
      comorbidities: {
        ...prev.comorbidities,
        [key]: !prev.comorbidities[key],
      },
    }));

  const toggleCircumstance = (circumstance: SpecialCircumstance) =>
    setParams((prev) => {
      const current = prev.specialCircumstances ?? [];
      return {
        ...prev,
        // Kept in the canonical order so two profiles with the same
        // circumstances always serialise identically.
        specialCircumstances: SPECIAL_CIRCUMSTANCES.filter((entry) =>
          entry === circumstance
            ? !current.includes(entry)
            : current.includes(entry),
        ),
      };
    });

  /**
   * Ids are generated on interaction, never during render — deriving one at
   * render time would make the server and client markup disagree.
   */
  const randomize = () =>
    setParams({ ...RANDOMIZE_PRESET, referenceId: generateReadableId() });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void onSubmit({
      ...params,
      referenceId: params.referenceId.trim() || generateReadableId(),
      specialCircumstances: circumstances,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <GlassPanel
        title="Patient parameters"
        accent="blue"
        action={
          <button
            type="button"
            onClick={randomize}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border border-signal-blue/40 bg-signal-blue/10",
              "px-2.5 py-1 text-[11px] font-medium text-signal-blue transition",
              "hover:border-signal-blue/70 hover:bg-signal-blue/20",
            )}
          >
            <Dices className="size-3" aria-hidden />
            Quick randomize
          </button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor={`${ids}-ref`}>
              Patient reference ID
            </label>
            <input
              id={`${ids}-ref`}
              className={cn(fieldClass, "tabular")}
              value={params.referenceId}
              onChange={(e) => set("referenceId", e.target.value)}
              placeholder="Leave blank to auto-generate (e.g. OIDE-7K3F-2M9Q)"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <NumberField
            id={`${ids}-age`}
            label="Age"
            unit="years"
            icon={HeartPulse}
            min={0}
            max={120}
            value={params.ageYears}
            onChange={(v) => set("ageYears", v)}
          />

          <NumberField
            id={`${ids}-weight`}
            label="Weight"
            unit="kg"
            icon={Weight}
            min={1}
            max={400}
            value={params.weightKg}
            onChange={(v) => set("weightKg", v)}
            hint="Drives every weight-based dose: lignocaine mg/kg, lipid emulsion mL/kg."
          />
        </div>
      </GlassPanel>

      <GlassPanel title="Defibrillation context" accent="ecg">
        <div className="space-y-5">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <label className={cn(labelClass, "mb-0")} htmlFor={`${ids}-imp`}>
                <Gauge className="size-3" aria-hidden />
                Transthoracic impedance
              </label>
              <span className="tabular text-sm text-trace-ecg">
                {params.transthoracicImpedanceOhms}
                <span className="ml-1 text-[10px] text-readout-faint">Ω</span>
              </span>
            </div>
            <input
              id={`${ids}-imp`}
              type="range"
              min={IMPEDANCE_MIN}
              max={IMPEDANCE_MAX}
              step={1}
              value={params.transthoracicImpedanceOhms}
              onChange={(e) =>
                set("transthoracicImpedanceOhms", Number(e.target.value))
              }
              className="w-full accent-[var(--color-trace-ecg)]"
            />
            <div className="mt-1 flex justify-between text-[10px] text-readout-faint">
              <span className="tabular">{IMPEDANCE_MIN} Ω</span>
              <span>nominal adult 75 Ω</span>
              <span className="tabular">{IMPEDANCE_MAX} Ω</span>
            </div>
            <p className="mt-1.5 text-[11px] text-readout-faint">
              Scales delivered energy directly: E_opt includes Z / 75 Ω, and the
              pacing output OIDE selects scales with it too.
            </p>
          </div>

          <NumberField
            id={`${ids}-down`}
            label="Time down without CPR"
            unit="minutes"
            icon={Timer}
            min={0}
            max={60}
            value={params.timeDownWithoutCprMinutes}
            onChange={(v) => set("timeDownWithoutCprMinutes", v)}
            hint="Seeds the starting AMSA: each minute down costs 0.45 mV·Hz."
          />

          <div>
            <span className={labelClass}>
              <Activity className="size-3" aria-hidden />
              Presentation rhythm
            </span>
            <div
              className="space-y-3"
              role="radiogroup"
              aria-label="Presentation rhythm"
            >
              {KKM_INTAKE_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-readout-faint">
                    {group.label}
                  </p>
                  <div className="grid gap-1.5 sm:grid-cols-3">
                    {group.rhythms.map((rhythm) => {
                      const selected = params.initialRhythm === rhythm;
                      return (
                        <button
                          key={rhythm}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => set("initialRhythm", rhythm)}
                          className={cn(
                            "rounded-lg border px-3 py-2 text-left text-xs leading-snug transition",
                            selected
                              ? "border-trace-ecg/60 bg-trace-ecg/12 text-trace-ecg"
                              : "border-monitor-600 text-readout-dim hover:border-monitor-500 hover:text-readout",
                          )}
                        >
                          {INITIAL_RHYTHM_LABELS[rhythm]}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-[11px] text-readout-faint">
                    {group.hint}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </GlassPanel>

      <GlassPanel
        title="ACLS special circumstances"
        accent={circumstances.length > 0 ? "alert" : "none"}
        action={
          <span className="tabular text-[10px] text-readout-dim">
            {circumstances.length} selected
          </span>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {SPECIAL_CIRCUMSTANCES.map((circumstance) => (
            <Toggle
              key={circumstance}
              label={SPECIAL_CIRCUMSTANCE_LABELS[circumstance]}
              detail={CIRCUMSTANCE_DETAIL[circumstance].detail}
              icon={CIRCUMSTANCE_DETAIL[circumstance].icon}
              checked={circumstances.includes(circumstance)}
              onChange={() => toggleCircumstance(circumstance)}
            />
          ))}
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-readout-faint">
          Multi-select: each one layers its own KKM modification onto{" "}
          <span className="text-readout-dim">both</span> protocol routes, so the
          energy comparison stays controlled.
        </p>
      </GlassPanel>

      <GlassPanel title="Comorbidities">
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle
            label="Ischemic heart disease"
            checked={params.comorbidities.ischemicHeartDisease}
            onChange={() => toggleComorbidity("ischemicHeartDisease")}
          />
          <Toggle
            label="Previous MI"
            checked={params.comorbidities.previousMi}
            onChange={() => toggleComorbidity("previousMi")}
          />
        </div>
      </GlassPanel>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-alert-critical/50 bg-alert-critical/12 px-4 py-3 text-xs text-alert-critical"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-xl border border-trace-ecg/40",
          "bg-trace-ecg/12 px-4 py-3 text-sm font-semibold uppercase tracking-[0.16em]",
          "text-trace-ecg transition hover:bg-trace-ecg/20 hover:shadow-glow-ecg",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none",
        )}
      >
        {submitting ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Locking intake profile…
          </>
        ) : (
          <>
            <Lock className="size-4" aria-hidden />
            Assess Patient &amp; Lock Intake Profile
          </>
        )}
      </button>

      <p className="text-center text-[11px] text-readout-faint">
        Locks this profile and opens the monitor. Both routes will then run the{" "}
        {matrix.label} branch of the {matrix.guidelineRef.split(".")[1]}{" "}
        algorithm against the same patient.
      </p>
    </form>
  );
}

function NumberField({
  id,
  label,
  unit,
  icon: Icon,
  min,
  max,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  unit: string;
  icon: LucideIcon;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={id}>
        <Icon className="size-3" aria-hidden />
        {label} <span className="text-readout-faint">({unit})</span>
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        className={cn(fieldClass, "tabular")}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => {
          const next = Number(e.target.value);
          onChange(Number.isFinite(next) ? next : 0);
        }}
      />
      {hint && <p className="mt-1 text-[11px] text-readout-faint">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  detail,
  icon: Icon,
  checked,
  onChange,
}: {
  label: string;
  detail?: string;
  icon?: LucideIcon;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={cn(
        "flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-xs transition",
        checked
          ? "border-alert-advisory/55 bg-alert-advisory/12 text-alert-advisory"
          : "border-monitor-600 text-readout-dim hover:border-monitor-500 hover:text-readout",
      )}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-medium">
          {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
          {label}
        </span>
        {detail && (
          <span className="mt-0.5 block text-[10px] leading-snug text-readout-faint">
            {detail}
          </span>
        )}
      </span>
      <span
        className={cn(
          "relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition",
          checked ? "bg-alert-advisory/70" : "bg-monitor-600",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-3 rounded-full bg-monitor-900 transition-all",
            checked ? "left-3.5" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}
