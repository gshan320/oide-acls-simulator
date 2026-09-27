"use client";

import { useMemo } from "react";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type Chart,
  type ChartData,
  type ChartOptions,
  type Plugin,
} from "chart.js";
import { Line } from "react-chartjs-2";
import Link from "next/link";
import {
  Activity,
  CheckCircle2,
  ClipboardList,
  Download,
  FileJson,
  HeartCrack,
  HeartPulse,
  Home,
  Loader2,
  Percent,
  Timer,
  Waves,
  XCircle,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { GlassPanel } from "@/components/ui";
import { cn, formatElapsed } from "@/lib/utils";
import {
  AMSA_HIGH_THRESHOLD,
  AMSA_LOW_THRESHOLD,
} from "@/lib/oide/decisionEngine";
import {
  ARM_LABELS,
  CONVERSION_LABEL,
  CONVERSION_NOUN,
  rhythmLabel,
} from "@/lib/oide/aclsEngine";
import {
  SPECIAL_CIRCUMSTANCE_LABELS,
  type AmsaTimepointPayload,
  type ArmOutcome,
  type InterventionPayload,
  type KkmProtocolFamily,
  type SimulationOutcome,
  type SimulationSessionDoc,
} from "@/types/session";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Legend,
  Tooltip,
);

const INK = "#7C8DA6";
const GRID = "rgba(0, 229, 255, 0.10)";
const AMSA_TRADITIONAL = "#FF9F0A";
const AMSA_OIDE = "#00E5FF";
const SHOCK_TRADITIONAL = "#FF3B30";
const SHOCK_OIDE = "#00FFAA";
const EPI_COLOR = "#FFD60A";
const ADJUNCT_COLOR = "#B388FF";
const CPR_BAND = "rgba(0, 255, 170, 0.07)";

/**
 * Shades the CPR intervals behind the trace and draws the AMSA decision
 * thresholds. Background context belongs in a plugin, not in a second dataset
 * that would clutter the legend.
 */
function backdropPlugin(
  cprSpans: Array<[number, number]>,
  maxOffsetMs: number,
): Plugin<"line"> {
  return {
    id: "oide-backdrop",
    beforeDatasetsDraw(chart: Chart<"line">) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.y) return;

      ctx.save();

      ctx.fillStyle = CPR_BAND;
      for (const [from, to] of cprSpans) {
        const x1 =
          chartArea.left + (from / maxOffsetMs) * (chartArea.right - chartArea.left);
        const x2 =
          chartArea.left + (to / maxOffsetMs) * (chartArea.right - chartArea.left);
        ctx.fillRect(x1, chartArea.top, Math.max(1, x2 - x1), chartArea.bottom - chartArea.top);
      }

      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      for (const [threshold, color] of [
        [AMSA_LOW_THRESHOLD, SHOCK_TRADITIONAL],
        [AMSA_HIGH_THRESHOLD, SHOCK_OIDE],
      ] as const) {
        const y = scales.y.getPixelForValue(threshold);
        if (y < chartArea.top || y > chartArea.bottom) continue;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(chartArea.left, y);
        ctx.lineTo(chartArea.right, y);
        ctx.stroke();
      }

      ctx.restore();
    },
  };
}

interface OutcomeAnalysisProps {
  session: SimulationSessionDoc;
  outcome: SimulationOutcome;
  amsaLogs: AmsaTimepointPayload[];
  interventions: InterventionPayload[];
  /** Omit to hide the session export control (e.g. in preview mode). */
  onExport?: () => void;
  exporting?: boolean;
  exportError?: string | null;
  /**
   * Dual-arm timeline export. Separate from `onExport` because it is a
   * different artefact: the full generated timelines and AMSA tracks for both
   * routes, assembled locally rather than read back from Firestore.
   */
  onExportTimeline?: () => void;
}

/** Post-scenario comparative dashboard. */
export function OutcomeAnalysis({
  session,
  outcome,
  amsaLogs,
  interventions,
  onExport,
  exporting = false,
  exportError = null,
  onExportTimeline,
}: OutcomeAnalysisProps) {
  const sorted = useMemo(
    () => [...amsaLogs].sort((a, b) => a.offsetMs - b.offsetMs),
    [amsaLogs],
  );

  /**
   * Which algorithm ran. Read off the arm outcome rather than re-derived from
   * the rhythm, so a session loaded back from Firestore reports whatever it
   * actually ran under. Bundles written before the field existed fall back to
   * the arrest algorithm, which is what they all were.
   */
  const family: KkmProtocolFamily =
    outcome.arms.oide.family ?? outcome.arms.traditional.family ?? "cardiac-arrest";
  /** A fibrillatory waveform is the only thing with an AMSA to plot. */
  const measurable = sorted.some((point) => point.currentAMSA > 0);

  /**
   * The two arms are plotted as separate trajectories, which is the whole point
   * of the comparison: identical CPR, divergent energy, divergent AMSA. Logs
   * written before the arm tag existed carry no arm and fall into `shared`,
   * where they are plotted once as a single trace rather than dropped.
   */
  const series = useMemo(() => {
    const byArm = { traditional: [] as AmsaTimepointPayload[], oide: [] as AmsaTimepointPayload[], shared: [] as AmsaTimepointPayload[] };
    for (const point of sorted) byArm[point.arm ?? "shared"].push(point);
    return byArm;
  }, [sorted]);

  const maxOffsetMs = Math.max(
    outcome.totalDurationMs,
    sorted.at(-1)?.offsetMs ?? 0,
    1,
  );

  /** Contiguous stretches where compressions were running. */
  const cprSpans = useMemo(() => {
    const spans: Array<[number, number]> = [];
    let openedAt: number | null = null;

    for (const event of [...interventions].sort(
      (a, b) => a.offsetMs - b.offsetMs,
    )) {
      if (event.type === "cpr-started" && openedAt === null) {
        openedAt = event.offsetMs;
      } else if (
        // A rhythm check is a hands-off interval by definition, so it closes
        // the band as surely as an explicit stop does.
        (event.type === "cpr-stopped" || event.type === "rhythm-check") &&
        openedAt !== null
      ) {
        spans.push([openedAt, event.offsetMs]);
        openedAt = null;
      }
    }
    if (openedAt !== null) spans.push([openedAt, maxOffsetMs]);
    return spans;
  }, [interventions, maxOffsetMs]);

  const markers = useMemo(() => {
    /** Place each marker at the AMSA that was live when it happened. */
    const amsaAt = (offsetMs: number) =>
      sorted.reduce<number | null>(
        (best, point) => (point.offsetMs <= offsetMs ? point.currentAMSA : best),
        null,
      ) ?? 0;

    const pick = (test: (e: InterventionPayload) => boolean) =>
      interventions
        .filter(test)
        .map((e) => ({ x: e.offsetMs, y: e.amsaAtTime ?? amsaAt(e.offsetMs) }));

    return {
      traditionalShocks: pick(
        (e) => e.type === "shock-delivered" && e.arm === "traditional",
      ),
      oideShocks: pick((e) => e.type === "shock-delivered" && e.arm === "oide"),
      drugs: pick((e) => e.type === "drug-administered"),
      /** Special-circumstance and supportive measures, and withheld shocks. */
      adjuncts: pick(
        (e) => e.type === "adjunct-applied" || e.type === "shock-deferred",
      ),
    };
  }, [interventions, sorted]);

  const amsaSeries = (
    label: string,
    points: AmsaTimepointPayload[],
    color: string,
    dashed: boolean,
  ) => ({
    label,
    data: points.map((p) => ({ x: p.offsetMs, y: p.currentAMSA })),
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    borderDash: dashed ? [6, 4] : undefined,
    tension: 0.3,
    pointRadius: 0,
    pointHoverRadius: 5,
    fill: false,
  });

  const data: ChartData<"line"> = {
    datasets: [
      ...(series.traditional.length > 0
        ? [
            amsaSeries(
              `AMSA — ${ARM_LABELS.traditional}`,
              series.traditional,
              AMSA_TRADITIONAL,
              true,
            ),
          ]
        : []),
      ...(series.oide.length > 0
        ? [amsaSeries(`AMSA — ${ARM_LABELS.oide}`, series.oide, AMSA_OIDE, false)]
        : []),
      ...(series.shared.length > 0
        ? [amsaSeries("AMSA", series.shared, AMSA_OIDE, false)]
        : []),
      {
        label: "Shock — traditional",
        data: markers.traditionalShocks,
        borderColor: SHOCK_TRADITIONAL,
        backgroundColor: SHOCK_TRADITIONAL,
        showLine: false,
        pointStyle: "triangle",
        pointRadius: 8,
        pointHoverRadius: 11,
      },
      {
        label: "Shock — OIDE",
        data: markers.oideShocks,
        borderColor: SHOCK_OIDE,
        backgroundColor: SHOCK_OIDE,
        showLine: false,
        pointStyle: "rectRot",
        pointRadius: 8,
        pointHoverRadius: 11,
      },
      {
        label: "Drug administered",
        data: markers.drugs,
        borderColor: EPI_COLOR,
        backgroundColor: EPI_COLOR,
        showLine: false,
        pointStyle: "circle",
        pointRadius: 6,
        pointHoverRadius: 9,
      },
      {
        label: "Special-circumstance measure",
        data: markers.adjuncts,
        borderColor: ADJUNCT_COLOR,
        backgroundColor: ADJUNCT_COLOR,
        showLine: false,
        pointStyle: "crossRot",
        pointRadius: 7,
        pointHoverRadius: 10,
      },
    ],
  };

  const options: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: {
        labels: {
          color: INK,
          boxWidth: 8,
          usePointStyle: true,
          font: { size: 10 },
        },
      },
      tooltip: {
        backgroundColor: "#121822",
        borderColor: "rgba(0,229,255,0.25)",
        borderWidth: 1,
        titleColor: "#E6F7FF",
        bodyColor: "#E6F7FF",
        callbacks: {
          title: (items) => formatElapsed(Number(items[0]?.parsed.x ?? 0)),
          label: (item) =>
            `${item.dataset.label}: ${Number(item.parsed.y).toFixed(1)} mV·Hz`,
        },
      },
    },
    scales: {
      x: {
        type: "linear",
        min: 0,
        max: maxOffsetMs,
        grid: { display: false },
        border: { color: GRID },
        ticks: {
          color: INK,
          font: { size: 10 },
          maxTicksLimit: 8,
          callback: (value) => formatElapsed(Number(value)),
        },
      },
      y: {
        beginAtZero: true,
        grid: { color: GRID },
        border: { display: false },
        title: {
          display: true,
          text: "AMSA (mV·Hz)",
          color: INK,
          font: { size: 10 },
        },
        ticks: { color: INK, font: { size: 10 }, maxTicksLimit: 6 },
      },
    },
  };

  return (
    <div className="space-y-4">
      <GlassPanel
        title="Session outcome"
        accent={outcome.roscAchieved ? "ecg" : "alert"}
        action={
          (onExportTimeline || onExport) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {onExportTimeline && (
                <ExportButton
                  icon={FileJson}
                  label="Export Research Data (JSON)"
                  onClick={onExportTimeline}
                />
              )}
              {onExport && (
                <ExportButton
                  icon={exporting ? Loader2 : Download}
                  label={exporting ? "Bundling…" : "Export session data (JSON)"}
                  spinning={exporting}
                  disabled={exporting}
                  onClick={onExport}
                />
              )}
            </div>
          )
        }
      >
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-readout-dim">
          <span className="tabular text-sm text-readout">
            {session.patient.referenceId}
          </span>
          <span className="tabular">
            {session.patient.ageYears} y · {session.patient.weightKg} kg ·{" "}
            {session.patient.transthoracicImpedanceOhms} Ω
          </span>
          <span className="tabular">
            Duration {formatElapsed(outcome.totalDurationMs)}
          </span>
          <span>
            Ended: <span className="text-readout">{outcome.endedReason}</span>
          </span>
          {(session.patient.specialCircumstances ?? []).map((circumstance) => (
            <span
              key={circumstance}
              className="rounded-full border border-alert-advisory/50 bg-alert-advisory/10 px-2 py-0.5 text-[10px] text-alert-advisory"
            >
              {SPECIAL_CIRCUMSTANCE_LABELS[circumstance]}
            </span>
          ))}
        </div>

        {exportError && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-alert-critical/50 bg-alert-critical/12 px-3 py-2 text-xs text-alert-critical"
          >
            {exportError}
          </p>
        )}

        <ComparisonStrip
          traditional={outcome.arms.traditional}
          oide={outcome.arms.oide}
          family={family}
        />

        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <OutcomeCard
            title={ARM_LABELS.traditional}
            arm={outcome.arms.traditional}
            family={family}
          />
          <OutcomeCard
            title={ARM_LABELS.oide}
            arm={outcome.arms.oide}
            family={family}
            highlight
          />
        </div>
      </GlassPanel>

      <GlassPanel title="Comparative AMSA trajectory" accent="blue">
        <div className="h-72">
          <Line
            data={data}
            options={options}
            plugins={[backdropPlugin(cprSpans, maxOffsetMs)]}
          />
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-readout-faint">
          {measurable ? (
            <>
              One trace per route: the dashed amber line is the traditional arm,
              the solid cyan line is OIDE. Both arms received identical
              compressions, so the gap between them is the myocardial cost of
              the energy strategy alone. Shaded bands are CPR intervals;
              horizontal dashed guides mark the {AMSA_LOW_THRESHOLD} and{" "}
              {AMSA_HIGH_THRESHOLD} mV·Hz decision thresholds, drawn only when
              they fall inside the plotted range.
            </>
          ) : (
            <>
              AMSA reads zero throughout: this presentation has no fibrillatory
              waveform to measure, so the amplitude spectrum carries no
              myocardial energy information and the comparison rests on
              delivered energy and time-to-conversion alone. The markers still
              locate every delivery and every special-circumstance measure on
              the timeline.
            </>
          )}{" "}
          Markers differ in shape as well as colour, and the same events are
          listed in the table below.
        </p>
      </GlassPanel>

      <EventTable interventions={interventions} />

      <SessionNav />
    </div>
  );
}

/**
 * Exit route from the comparison.
 *
 * The dual-arm workspace is otherwise a dead end: both runs are spent, the
 * tabs only switch between finished timelines, and there is nothing left to do
 * on this screen. A plain `Link` rather than `router.back()` — the intake form
 * is several steps back in history and returning there would re-enter a session
 * that has already concluded.
 */
function SessionNav() {
  const links: Array<{
    href: string;
    icon: LucideIcon;
    label: string;
    hint: string;
    primary?: boolean;
  }> = [
    {
      href: "/",
      icon: Home,
      label: "Back to Homepage",
      hint: "All routes, and the database reset",
      primary: true,
    },
    {
      href: "/scenario",
      icon: ClipboardList,
      label: "New Patient Intake",
      hint: "Start another session from a fresh profile",
    },
  ];

  return (
    <GlassPanel title="Session complete">
      <div className="grid gap-2 sm:grid-cols-2">
        {links.map(({ href, icon: Icon, label, hint, primary }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 rounded-xl border px-3 py-3 transition",
              primary
                ? "border-signal-blue/50 bg-signal-blue/10 text-signal-blue hover:bg-signal-blue/20"
                : "border-monitor-600 text-readout-dim hover:border-monitor-500 hover:text-readout",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="block text-xs font-semibold uppercase tracking-[0.12em]">
                {label}
              </span>
              <span className="block text-[10px] text-readout-faint">
                {hint}
              </span>
            </span>
          </Link>
        ))}
      </div>
      <p className="mt-2.5 text-[10px] leading-relaxed text-readout-faint">
        Everything on this screen is already persisted. Export the research data
        above if you need it — leaving the page does not discard it, but starting
        a fresh session will add to the database rather than replace it.
      </p>
    </GlassPanel>
  );
}

function ExportButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  spinning = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  spinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border border-signal-blue/40",
        "bg-signal-blue/10 px-2.5 py-1 text-[11px] font-medium text-signal-blue",
        "transition hover:border-signal-blue/70 hover:bg-signal-blue/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <Icon
        className={cn("size-3", spinning && "animate-spin")}
        aria-hidden
      />
      {label}
    </button>
  );
}

/**
 * The headline of the whole exercise: the same patient, the same KKM sequence,
 * two energy strategies, side by side.
 */
function ComparisonStrip({
  traditional,
  oide,
  family,
}: {
  traditional: ArmOutcome;
  oide: ArmOutcome;
  family: KkmProtocolFamily;
}) {
  const conversion = CONVERSION_LABEL[family];
  const conversionNoun = CONVERSION_NOUN[family];

  const rows: Array<{
    label: string;
    traditional: string;
    oide: string;
    delta: string;
    /** True when OIDE's figure is the better one — drives the delta colour. */
    oideFavoured: boolean;
  }> = [
    {
      label: "Total energy delivered",
      traditional: `${traditional.cumulativeJoules} J`,
      oide: `${oide.cumulativeJoules} J`,
      delta: `${signed(oide.cumulativeJoules - traditional.cumulativeJoules)} J`,
      oideFavoured: oide.cumulativeJoules < traditional.cumulativeJoules,
    },
    {
      label: "Myocardial injury index (MII)",
      traditional: traditional.myocardialInjuryIndex.toFixed(1),
      oide: oide.myocardialInjuryIndex.toFixed(1),
      delta: signed(
        oide.myocardialInjuryIndex - traditional.myocardialInjuryIndex,
        1,
      ),
      oideFavoured:
        oide.myocardialInjuryIndex < traditional.myocardialInjuryIndex,
    },
    {
      label: "Pre-shock pause accumulation",
      traditional: `${traditional.totalPreShockPauseMs} ms`,
      oide: `${oide.totalPreShockPauseMs} ms`,
      delta: `${signed(
        oide.totalPreShockPauseMs - traditional.totalPreShockPauseMs,
      )} ms`,
      oideFavoured:
        oide.totalPreShockPauseMs < traditional.totalPreShockPauseMs,
    },
    {
      label: `Final ${conversionNoun} probability`,
      traditional: formatPercent(traditional.roscProbability),
      oide: formatPercent(oide.roscProbability),
      delta: `${signed(
        ((oide.roscProbability ?? 0) - (traditional.roscProbability ?? 0)) * 100,
      )} pp`,
      oideFavoured:
        (oide.roscProbability ?? 0) > (traditional.roscProbability ?? 0),
    },
    {
      label: "Rhythm outcome",
      traditional: rhythmOutcome(traditional, conversion),
      oide: rhythmOutcome(oide, conversion),
      delta:
        traditional.timeToRoscMs !== null && oide.timeToRoscMs !== null
          ? `${signed((oide.timeToRoscMs - traditional.timeToRoscMs) / 1000, 1)} s`
          : "—",
      oideFavoured:
        oide.timeToRoscMs !== null &&
        (traditional.timeToRoscMs === null ||
          oide.timeToRoscMs < traditional.timeToRoscMs),
    },
    {
      label: "Survival likelihood",
      traditional: formatPercent(traditional.survivalLikelihood),
      oide: formatPercent(oide.survivalLikelihood),
      delta:
        traditional.survivalLikelihood === undefined ||
        oide.survivalLikelihood === undefined
          ? "—"
          : `${signed((oide.survivalLikelihood - traditional.survivalLikelihood) * 100)} pp`,
      oideFavoured:
        (oide.survivalLikelihood ?? 0) > (traditional.survivalLikelihood ?? 0),
    },
  ];

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[34rem] text-left text-xs">
        <thead>
          <tr className="text-[9px] uppercase tracking-[0.14em] text-readout-dim">
            <th className="pb-2 pr-3 font-semibold">Measure</th>
            <th className="pb-2 pr-3 font-semibold">Traditional KKM</th>
            <th className="pb-2 pr-3 font-semibold text-trace-ecg">
              OIDE calibrated
            </th>
            <th className="pb-2 font-semibold">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-monitor-600/50">
              <td className="py-2 pr-3 text-readout-dim">{row.label}</td>
              <td className="tabular py-2 pr-3 text-base text-readout">
                {row.traditional}
              </td>
              <td className="tabular py-2 pr-3 text-base text-trace-ecg">
                {row.oide}
              </td>
              <td
                className={cn(
                  "tabular py-2 text-base",
                  row.oideFavoured ? "text-trace-ecg" : "text-readout-dim",
                )}
              >
                {row.delta}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] leading-relaxed text-readout-faint">
        Both routes ran the identical KKM sequence — same compressions, same
        drug schedule, same special-circumstance modifications. The only
        variable is the energy each delivery carried, so every difference below
        is attributable to the energy strategy alone. Δ is OIDE relative to
        traditional; on the rhythm row it is the time-to-conversion difference.
      </p>
    </div>
  );
}

/**
 * Rhythm the arm finished on, with the instant it got there — the Δ column on
 * that row is a time difference, and needs a time to be a difference of.
 */
function rhythmOutcome(arm: ArmOutcome, conversion: string): string {
  const label = arm.finalRhythm
    ? rhythmLabel(arm.finalRhythm)
    : arm.roscAchieved
      ? conversion
      : "no conversion";

  return arm.timeToRoscMs === null || arm.timeToRoscMs === undefined
    ? label
    : `${label} · ${formatElapsed(arm.timeToRoscMs)}`;
}

/** Signed figure for a delta column, e.g. "-286" / "+17". */
function signed(value: number, digits = 0): string {
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(digits)}`;
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
}

function OutcomeCard({
  title,
  arm,
  family,
  highlight = false,
}: {
  title: string;
  arm: ArmOutcome;
  family: KkmProtocolFamily;
  highlight?: boolean;
}) {
  const RoscIcon = arm.roscAchieved ? CheckCircle2 : XCircle;
  const conversion = CONVERSION_LABEL[family];
  const conversionNoun = CONVERSION_NOUN[family];

  return (
    <section
      className={cn(
        "rounded-xl border p-3",
        highlight
          ? "border-trace-ecg/40 bg-trace-ecg/[0.06]"
          : "border-monitor-600 bg-monitor-900/50",
      )}
    >
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-readout-dim">
        {title}
      </h3>

      <div
        className={cn(
          "mt-2 flex items-center gap-2 rounded-lg border px-2.5 py-1.5",
          arm.roscAchieved
            ? "border-trace-ecg/50 bg-trace-ecg/12 text-trace-ecg"
            : "border-alert-critical/45 bg-alert-critical/10 text-alert-critical",
        )}
      >
        <RoscIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="text-xs font-semibold">
          {conversion} {arm.roscAchieved ? "achieved" : "not achieved"}
          {arm.roscAchieved &&
            arm.timeToRoscMs !== null &&
            arm.timeToRoscMs !== undefined &&
            ` at ${formatElapsed(arm.timeToRoscMs)}`}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2">
        <Metric
          icon={HeartPulse}
          label="Survival likelihood"
          value={
            arm.survivalLikelihood === undefined
              ? "—"
              : (arm.survivalLikelihood * 100).toFixed(0)
          }
          unit="%"
          tone={
            arm.roscAchieved ? "text-trace-ecg" : "text-alert-critical"
          }
          hint="neurologically intact"
        />
        <Metric
          icon={Zap}
          label="Energy delivered"
          value={String(arm.cumulativeJoules)}
          unit="J"
          hint={
            family === "bradycardia"
              ? `paced, no energy delivered`
              : `${arm.shockCount} shock${arm.shockCount === 1 ? "" : "s"}`
          }
        />
        <Metric
          icon={HeartCrack}
          label="Myocardial injury index"
          value={arm.myocardialInjuryIndex.toFixed(1)}
          unit=""
          tone={arm.myocardialInjuryIndex > 0 ? "text-alert-advisory" : undefined}
          hint={`calibrated baseline ${arm.optimalJoules} J`}
        />
        <Metric
          icon={Timer}
          label="Pre-shock pause"
          value={String(arm.totalPreShockPauseMs)}
          unit="ms"
          hint={`${(arm.totalPreShockPauseMs / 1000).toFixed(1)} s hands-off`}
        />
        <Metric
          icon={Percent}
          label={`Final ${conversionNoun} probability`}
          value={
            arm.roscProbability === undefined
              ? "—"
              : (arm.roscProbability * 100).toFixed(0)
          }
          unit="%"
          tone={highlight ? "text-trace-ecg" : undefined}
        />
        <Metric
          icon={Waves}
          label="Rhythm outcome"
          value={arm.finalRhythm ? rhythmLabel(arm.finalRhythm) : "—"}
          unit=""
          valueClass="text-sm"
        />
        <Metric
          icon={Activity}
          label="Adrenaline"
          value={String(arm.epinephrineDoses)}
          unit="mg"
        />
        {family === "bradycardia" && (
          <Metric
            icon={Zap}
            label="Pacing capture"
            value={
              arm.paceCaptureAtMs === null || arm.paceCaptureAtMs === undefined
                ? "none"
                : formatElapsed(arm.paceCaptureAtMs)
            }
            unit=""
            valueClass="text-sm"
          />
        )}
      </dl>
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  unit,
  hint,
  tone = "text-readout",
  valueClass = "text-xl",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  unit: string;
  hint?: string;
  tone?: string;
  /** Override for a value that is a label rather than a number. */
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg bg-monitor-900/60 px-2.5 py-2">
      <dt className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-readout-dim">
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </dt>
      <dd className={cn("tabular mt-1 leading-tight", valueClass, tone)}>
        {value}
        {unit && <span className="ml-1 text-[10px] text-readout-faint">{unit}</span>}
      </dd>
      {hint && <p className="mt-0.5 text-[9px] text-readout-faint">{hint}</p>}
    </div>
  );
}

/** Table view of the same events the chart plots. */
function EventTable({
  interventions,
}: {
  interventions: InterventionPayload[];
}) {
  const rows = [...interventions].sort((a, b) => a.offsetMs - b.offsetMs);

  return (
    <GlassPanel title={`Event log (${rows.length})`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[38rem] text-left text-xs">
          <thead>
            <tr className="text-[9px] uppercase tracking-[0.14em] text-readout-dim">
              <th className="pb-2 pr-3 font-semibold">Time</th>
              <th className="pb-2 pr-3 font-semibold">Event</th>
              <th className="pb-2 pr-3 font-semibold">Arm</th>
              <th className="pb-2 pr-3 font-semibold">AMSA</th>
              <th className="pb-2 pr-3 font-semibold">Energy</th>
              <th className="pb-2 font-semibold">Detail</th>
            </tr>
          </thead>
          <tbody className="text-readout-dim">
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-3 text-readout-faint">
                  No interventions recorded.
                </td>
              </tr>
            )}
            {rows.map((event, index) => (
              <tr
                key={`${event.offsetMs}-${event.type}-${index}`}
                className="border-t border-monitor-600/50"
              >
                <td className="tabular py-1.5 pr-3 text-readout">
                  {formatElapsed(event.offsetMs)}
                </td>
                <td className="py-1.5 pr-3">{event.type}</td>
                <td className="py-1.5 pr-3">{event.arm}</td>
                <td className="tabular py-1.5 pr-3">
                  {event.amsaAtTime === undefined
                    ? "—"
                    : event.amsaAtTime.toFixed(1)}
                </td>
                <td className="tabular py-1.5 pr-3">
                  {event.joules !== undefined
                    ? `${event.joules} J${event.synchronised ? " sync" : ""}`
                    : event.paceOutputMa !== undefined
                      ? `${event.paceOutputMa} mA`
                      : "—"}
                </td>
                <td className="py-1.5 text-readout-faint">
                  {event.type === "shock-delivered" && event.roscProbability !== undefined
                    ? `p(conversion) ${(event.roscProbability * 100).toFixed(0)}% → ${event.roscAchieved ? "converted" : "no conversion"}`
                    : (event.note ??
                      (event.drugId
                        ? `${event.drugId} ${event.doseMg ?? ""} mg`
                        : "—"))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </GlassPanel>
  );
}
