"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChannelMetrics,
  EcgConfig,
  EcgWorkerRequest,
  EcgWorkerResponse,
  OideDecision,
  SpectrumResult,
} from "@/types/signal";

interface UseEcgWorkerOptions {
  /** Samples of history kept per channel for the scrolling traces. */
  bufferSize?: number;
  onError?: (message: string) => void;
}

/**
 * Owns the signal worker and keeps one ring buffer per channel.
 *
 * Each buffer is a stable Float32Array — mutated in place, never reallocated —
 * so the canvas renderers read them every frame without churning the GC. Read
 * them from a requestAnimationFrame loop, not from React state.
 *
 * The three channels are generated from one sample clock and therefore share a
 * single write cursor.
 */
export function useEcgWorker(options: UseEcgWorkerOptions = {}) {
  const { bufferSize = 4096, onError } = options;

  const workerRef = useRef<Worker | null>(null);

  const rawSignalRef = useRef<Float32Array>(new Float32Array(bufferSize));
  const filteredSignalRef = useRef<Float32Array>(new Float32Array(bufferSize));
  const plethRef = useRef<Float32Array>(new Float32Array(bufferSize));
  const etco2Ref = useRef<Float32Array>(new Float32Array(bufferSize));

  /** Total samples ever written — write position is (writeCount % bufferSize). */
  const writeCountRef = useRef(0);

  const [spectrum, setSpectrum] = useState<SpectrumResult | null>(null);
  const [decision, setDecision] = useState<OideDecision | null>(null);
  const [metrics, setMetrics] = useState<ChannelMetrics | null>(null);
  const [running, setRunning] = useState(false);

  // onError is read through a ref so a changing callback identity never
  // re-creates the worker and resets the traces.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const worker = new Worker(new URL("./ecg.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<EcgWorkerResponse>) => {
      const message = event.data;

      switch (message.type) {
        case "samples": {
          const size = rawSignalRef.current.length;
          const start = writeCountRef.current % size;
          const length = message.rawSignal.length;

          // All four channels advance together, so one cursor walk serves all.
          for (let i = 0; i < length; i++) {
            const at = (start + i) % size;
            rawSignalRef.current[at] = message.rawSignal[i];
            filteredSignalRef.current[at] = message.filteredSignal[i];
            plethRef.current[at] = message.pleth[i];
            etco2Ref.current[at] = message.etco2[i];
          }
          writeCountRef.current += length;
          break;
        }

        case "spectrum":
          setSpectrum(message.result);
          break;

        case "decision":
          setDecision(message.decision);
          break;

        case "metrics":
          setMetrics(message.metrics);
          break;

        case "error":
          onErrorRef.current?.(message.message);
          break;
      }
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const send = useCallback((request: EcgWorkerRequest) => {
    workerRef.current?.postMessage(request);
  }, []);

  const configure = useCallback(
    (config: Partial<EcgConfig>) => send({ type: "configure", config }),
    [send],
  );

  const start = useCallback(() => {
    send({ type: "start" });
    setRunning(true);
  }, [send]);

  const stop = useCallback(() => {
    send({ type: "stop" });
    setRunning(false);
  }, [send]);

  return {
    /** Stable per-channel ring buffers — read directly inside your rAF loop. */
    rawSignal: rawSignalRef,
    filteredSignal: filteredSignalRef,
    pleth: plethRef,
    etco2: etco2Ref,
    /** Shared monotonic write cursor for all four channels. */
    writeCount: writeCountRef,
    spectrum,
    /** Latest OIDE decision-engine output; updates ~1 Hz. */
    decision,
    metrics,
    running,
    configure,
    start,
    stop,
  };
}
