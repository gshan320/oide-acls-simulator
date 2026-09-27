"use client";

import { useEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/utils";

/**
 * bipolar  — zero sits at mid-height, signal swings both ways (ECG).
 * unipolar — zero sits on a baseline near the bottom (pleth, capnography).
 */
export type TraceMode = "bipolar" | "unipolar";

interface WaveformCanvasProps {
  /** A channel ring buffer from useEcgWorker — mutated in place, never replaced. */
  buffer: RefObject<Float32Array>;
  /** Shared monotonic write cursor into that buffer. */
  writeCount: RefObject<number>;
  /** Stroke colour; defaults to the ECG trace green. */
  color?: string;
  /** Full-scale value in the channel's own units (mV, mmHg, arbitrary). */
  range?: number;
  mode?: TraceMode;
  className?: string;
  label?: string;
  /** Right-aligned scale caption, e.g. "0–50 mmHg". */
  scaleLabel?: string;
}

/**
 * Scrolling waveform renderer.
 *
 * Draws straight from the worker's ring buffer inside requestAnimationFrame,
 * so no sample ever passes through React state. Redraws the whole trace each
 * frame — at 4096 points that is far cheaper than diffing.
 */
export function WaveformCanvas({
  buffer,
  writeCount,
  color = "#00FFAA",
  range = 1.2,
  mode = "bipolar",
  className,
  label,
  scaleLabel,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    let frame = 0;
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const draw = () => {
      frame = requestAnimationFrame(draw);

      const samples = buffer.current;
      const written = writeCount.current;
      if (!samples || !written) return;

      const { width, height } = canvas.getBoundingClientRect();
      const size = samples.length;
      // Oldest sample still in the buffer, once it has wrapped at least once.
      const oldest = written >= size ? written % size : 0;
      const visible = Math.min(written, size);
      const step = width / visible;

      // Unipolar traces sit on a baseline just above the bottom edge; bipolar
      // traces are centred. Both leave a little headroom so peaks never clip.
      const zeroY = mode === "unipolar" ? height * 0.92 : height / 2;
      const span = mode === "unipolar" ? height * 0.84 : height * 0.42;
      const scale = span / (range || 1);

      context.clearRect(0, 0, width, height);

      context.lineWidth = 1.6;
      context.strokeStyle = color;
      context.shadowColor = color;
      context.shadowBlur = 6;
      context.lineJoin = "round";
      context.beginPath();

      for (let i = 0; i < visible; i++) {
        const value = samples[(oldest + i) % size];
        const x = i * step;
        // Clamp to the drawable band so an out-of-range excursion bends rather
        // than escaping the canvas.
        const y = Math.max(1, Math.min(height - 1, zeroY - value * scale));
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }

      context.stroke();
      context.shadowBlur = 0;
    };

    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [buffer, writeCount, color, range, mode]);

  return (
    <div
      className={cn(
        "monitor-grid relative h-32 w-full overflow-hidden rounded-xl bg-monitor-900/80",
        className,
      )}
    >
      {label && (
        <span className="absolute left-3 top-2 z-10 text-[10px] font-semibold uppercase tracking-[0.16em] text-readout-dim">
          {label}
        </span>
      )}
      {scaleLabel && (
        <span className="tabular absolute right-3 top-2 z-10 text-[10px] text-readout-faint">
          {scaleLabel}
        </span>
      )}
      <canvas ref={canvasRef} className="size-full" />
    </div>
  );
}
