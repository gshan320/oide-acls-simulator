"use client";

import { cn } from "@/lib/utils";
import {
  AMSA_HIGH_THRESHOLD,
  AMSA_LOW_THRESHOLD,
  AMSA_SCALE_SATURATION,
} from "@/lib/oide/decisionEngine";

/** Full-scale reading; matches the AMSA at which the energy curve bottoms out. */
const MAX = AMSA_SCALE_SATURATION;

const W = 260;
const H = 148;
const CX = W / 2;
const CY = 128;
const R = 96;
const TRACK = 16;

const ZONES = [
  { from: 0, to: AMSA_LOW_THRESHOLD, color: "#FF3B30", label: "Defer" },
  {
    from: AMSA_LOW_THRESHOLD,
    to: AMSA_HIGH_THRESHOLD,
    color: "#FFB020",
    label: "CPR",
  },
  { from: AMSA_HIGH_THRESHOLD, to: MAX, color: "#00FFAA", label: "Shock" },
] as const;

/** Value → angle, sweeping 180° (left) down to 0° (right). */
const angleFor = (value: number) =>
  180 - (Math.min(Math.max(value, 0), MAX) / MAX) * 180;

function polar(radius: number, angleDeg: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + radius * Math.cos(a), CY - radius * Math.sin(a)];
}

function arcPath(radius: number, fromDeg: number, toDeg: number): string {
  const [x1, y1] = polar(radius, fromDeg);
  const [x2, y2] = polar(radius, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  // Angles decrease left→right, which is a clockwise sweep on screen.
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
}

interface AmsaGaugeProps {
  /** Live AMSA in mV·Hz; null before the first analysis window completes. */
  amsa: number | null;
  className?: string;
}

/**
 * AMSA metabolic gauge.
 *
 * Zone colour is a redundant cue only — the numeric value and the zone name are
 * both always shown, so the reading never depends on distinguishing red from
 * green.
 */
export function AmsaGauge({ amsa, className }: AmsaGaugeProps) {
  const value = amsa ?? 0;
  const zone =
    ZONES.find((z) => value >= z.from && value < z.to) ??
    (value >= MAX ? ZONES[2] : ZONES[0]);
  const needleAngle = angleFor(value);
  const [nx, ny] = polar(R - TRACK / 2 - 6, needleAngle);

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full max-w-[260px]"
        role="img"
        aria-label={`AMSA ${amsa === null ? "unavailable" : `${value.toFixed(1)} millivolt hertz`}, ${zone.label} zone`}
      >
        {/* Unlit track */}
        <path
          d={arcPath(R, 180, 0)}
          fill="none"
          stroke="#1A2130"
          strokeWidth={TRACK}
          strokeLinecap="round"
        />

        {ZONES.map((z) => (
          <path
            key={z.label}
            d={arcPath(R, angleFor(z.from), angleFor(z.to))}
            fill="none"
            stroke={z.color}
            strokeWidth={TRACK}
            strokeOpacity={zone.label === z.label ? 0.95 : 0.28}
          />
        ))}

        {/* Threshold ticks */}
        {[AMSA_LOW_THRESHOLD, AMSA_HIGH_THRESHOLD].map((t) => {
          const [x1, y1] = polar(R - TRACK / 2, angleFor(t));
          const [x2, y2] = polar(R + TRACK / 2, angleFor(t));
          return (
            <line
              key={t}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#0A0D12"
              strokeWidth={2}
            />
          );
        })}

        {amsa !== null && (
          <>
            <line
              x1={CX}
              y1={CY}
              x2={nx}
              y2={ny}
              stroke={zone.color}
              strokeWidth={3}
              strokeLinecap="round"
            />
            <circle cx={CX} cy={CY} r={6} fill={zone.color} />
          </>
        )}

        <text
          x={CX - R}
          y={CY + 18}
          textAnchor="middle"
          className="fill-[#4B5A70] text-[10px]"
        >
          0
        </text>
        <text
          x={CX + R}
          y={CY + 18}
          textAnchor="middle"
          className="fill-[#4B5A70] text-[10px]"
        >
          {MAX}
        </text>
      </svg>

      <div className="-mt-6 flex flex-col items-center">
        <span
          className="tabular text-4xl leading-none"
          style={{ color: amsa === null ? "#4B5A70" : zone.color }}
        >
          {amsa === null ? "—" : value.toFixed(1)}
        </span>
        <span className="mt-1 text-[10px] uppercase tracking-[0.16em] text-readout-dim">
          mV·Hz · {zone.label}
        </span>
      </div>
    </div>
  );
}
