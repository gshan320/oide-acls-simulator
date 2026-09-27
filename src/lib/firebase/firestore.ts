"use client";

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
  type CollectionReference,
  type DocumentReference,
  type Timestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { getDb } from "./client";
import type {
  AmsaTimepointPayload,
  InterventionPayload,
  PatientParameters,
  SessionExportBundle,
  SimulationOutcome,
  SimulationSessionDoc,
} from "@/types/session";

/**
 * Firestore access for the Sprint-3 schema.
 *
 *   Simulations/{simId}
 *   Simulations/{simId}/Interventions/{autoId}
 *   Simulations/{simId}/AmsaLogs/{autoId}
 *
 * Firebase Web SDK v10+ modular API throughout. Every write stamps
 * `serverTimestamp()` so ordering never depends on client clocks.
 */

export const SIMULATIONS = "Simulations";
export const INTERVENTIONS = "Interventions";
export const AMSA_LOGS = "AmsaLogs";

/** How many AMSA timepoints to accumulate before flushing as one batch. */
const AMSA_BATCH_SIZE = 30;
/** Flush a partial buffer after this long, so a paused sim still persists. */
const AMSA_FLUSH_INTERVAL_MS = 20_000;

export const simulationRef = (simId: string): DocumentReference =>
  doc(getDb(), SIMULATIONS, simId);

export const interventionsRef = (simId: string): CollectionReference =>
  collection(getDb(), SIMULATIONS, simId, INTERVENTIONS);

export const amsaLogsRef = (simId: string): CollectionReference =>
  collection(getDb(), SIMULATIONS, simId, AMSA_LOGS);

/**
 * Readable, de-identified session id — "OIDE-7K3F-2M9Q".
 *
 * Crypto-random rather than time-seeded so two tablets starting a scenario in
 * the same second cannot collide. Ambiguous glyphs (I/O/0/1) are excluded so
 * the id survives being read aloud across a resus bay.
 */
export function generateReadableId(prefix = "OIDE"): string {
  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);

  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return `${prefix}-${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */

/**
 * Create the root document at Simulations/{simId}.
 *
 * Uses a transaction rather than a plain set so a regenerated or hand-entered
 * reference id cannot silently overwrite a session that already exists.
 */
export async function createSimulationSession(
  patientData: PatientParameters,
): Promise<string> {
  const simId = patientData.referenceId?.trim() || generateReadableId();
  const ref = simulationRef(simId);

  const session: SimulationSessionDoc = {
    simId,
    patient: { ...patientData, referenceId: simId },
    status: "active",
    startedAtMs: Date.now(),
    outcome: null,
  };

  await runTransaction(getDb(), async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists()) {
      throw new Error(`Simulation ${simId} already exists.`);
    }
    tx.set(ref, { ...session, createdAt: serverTimestamp() });
  });

  return simId;
}

/** Append one learner action to Simulations/{simId}/Interventions. */
export async function logSimulationAction(
  simId: string,
  actionPayload: InterventionPayload,
): Promise<string> {
  const ref = await addDoc(interventionsRef(simId), {
    ...actionPayload,
    recordedAt: serverTimestamp(),
  });
  return ref.id;
}

/* ------------------------------------------------------------------ *
 * AMSA timepoint stream (1 Hz, buffered)
 * ------------------------------------------------------------------ */

interface AmsaBuffer {
  pending: AmsaTimepointPayload[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Chains flushes so two overlapping calls cannot interleave batches. */
  inFlight: Promise<void>;
}

const amsaBuffers = new Map<string, AmsaBuffer>();

function bufferFor(simId: string): AmsaBuffer {
  let buffer = amsaBuffers.get(simId);
  if (!buffer) {
    buffer = { pending: [], timer: null, inFlight: Promise.resolve() };
    amsaBuffers.set(simId, buffer);
  }
  return buffer;
}

/**
 * Append a decision-engine timepoint to Simulations/{simId}/AmsaLogs.
 *
 * The engine emits at 1 Hz, so writing each point individually would cost 60
 * round trips per minute per session. Points are buffered and flushed as a
 * single `writeBatch`, which is one network operation regardless of size.
 *
 * Resolves as soon as the point is buffered. Await `flushAmsaLogs` (or
 * `saveFinalOutcome`, which flushes for you) when durability matters.
 */
export function logAmsaTimepoint(
  simId: string,
  amsaPayload: AmsaTimepointPayload,
): void {
  const buffer = bufferFor(simId);
  buffer.pending.push(amsaPayload);

  if (buffer.pending.length >= AMSA_BATCH_SIZE) {
    void flushAmsaLogs(simId);
    return;
  }

  // A partial buffer still lands within the interval, so a scenario that
  // pauses mid-batch does not lose its tail.
  buffer.timer ??= setTimeout(() => {
    void flushAmsaLogs(simId);
  }, AMSA_FLUSH_INTERVAL_MS);
}

/** Write any buffered AMSA timepoints for this session as one batch. */
export function flushAmsaLogs(simId: string): Promise<void> {
  const buffer = amsaBuffers.get(simId);
  if (!buffer) return Promise.resolve();

  if (buffer.timer) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }
  if (buffer.pending.length === 0) return buffer.inFlight;

  const points = buffer.pending;
  buffer.pending = [];

  buffer.inFlight = buffer.inFlight.then(async () => {
    const db = getDb();
    const collectionRef = amsaLogsRef(simId);

    // Firestore caps a batch at 500 operations.
    for (let i = 0; i < points.length; i += 500) {
      const batch = writeBatch(db);
      for (const point of points.slice(i, i + 500)) {
        batch.set(doc(collectionRef), {
          ...point,
          recordedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }
  });

  return buffer.inFlight;
}

/** Drop buffered points without writing them — use when abandoning a session. */
export function discardAmsaBuffer(simId: string): void {
  const buffer = amsaBuffers.get(simId);
  if (buffer?.timer) clearTimeout(buffer.timer);
  amsaBuffers.delete(simId);
}

/**
 * Drop every session's buffered points and cancel every pending flush.
 *
 * Called before a purge: a timer armed by a session that has since been left
 * open in another tab would otherwise fire *after* the delete and write a fresh
 * `AmsaLogs` document into a collection that was supposed to be empty.
 */
export function discardAllAmsaBuffers(): void {
  for (const buffer of amsaBuffers.values()) {
    if (buffer.timer) clearTimeout(buffer.timer);
  }
  amsaBuffers.clear();
}

/* ------------------------------------------------------------------ *
 * Completion
 * ------------------------------------------------------------------ */

/**
 * Update Simulations/{simId} with the final outcome.
 *
 * Flushes the AMSA buffer first so the persisted log is complete before the
 * session is marked finished, then applies the outcome transactionally to
 * avoid clobbering a concurrent write from another device.
 */
export async function saveFinalOutcome(
  simId: string,
  outcomeData: SimulationOutcome,
): Promise<void> {
  await flushAmsaLogs(simId);

  const ref = simulationRef(simId);
  await runTransaction(getDb(), async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists()) {
      throw new Error(`Simulation ${simId} not found.`);
    }

    tx.update(ref, {
      status: outcomeData.endedReason === "aborted" ? "aborted" : "completed",
      outcome: outcomeData,
      completedAt: serverTimestamp(),
    });
  });

  amsaBuffers.delete(simId);
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function getSimulationSession(
  simId: string,
): Promise<SimulationSessionDoc | null> {
  const snapshot = await getDoc(simulationRef(simId));
  return snapshot.exists() ? (snapshot.data() as SimulationSessionDoc) : null;
}

/** Live root document. Returns the unsubscribe function. */
export function subscribeToSimulation(
  simId: string,
  onChange: (session: SimulationSessionDoc | null) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    simulationRef(simId),
    (snapshot) =>
      onChange(
        snapshot.exists() ? (snapshot.data() as SimulationSessionDoc) : null,
      ),
    onError,
  );
}

/** Live intervention log, oldest first. Returns the unsubscribe function. */
export function subscribeToInterventions(
  simId: string,
  onChange: (entries: InterventionPayload[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    interventionsRef(simId),
    (snapshot) => {
      const entries = snapshot.docs
        .map((d) => d.data() as InterventionPayload)
        .sort((a, b) => a.offsetMs - b.offsetMs);
      onChange(entries);
    },
    onError,
  );
}

/* ------------------------------------------------------------------ *
 * Research export
 * ------------------------------------------------------------------ */

/** Firestore `serverTimestamp()` fields come back as Timestamp instances. */
function plainify<T>(data: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] =
      value && typeof value === "object" && "toDate" in value
        ? (value as Timestamp).toDate().toISOString()
        : value;
  }
  return out as T;
}

/**
 * Bundle a whole session — root document, every intervention, every AMSA
 * timepoint — into one structured object.
 *
 * Flushes any buffered AMSA points first, so an export taken moments after the
 * last shock is not missing its tail. Subcollections are read in parallel and
 * sorted by `offsetMs` so the timeline is ordered regardless of document id.
 */
export async function exportSessionData(
  simId: string,
): Promise<SessionExportBundle> {
  await flushAmsaLogs(simId);

  const [sessionSnap, interventionSnap, amsaSnap] = await Promise.all([
    getDoc(simulationRef(simId)),
    getDocs(query(interventionsRef(simId), orderBy("offsetMs"))),
    getDocs(query(amsaLogsRef(simId), orderBy("offsetMs"))),
  ]);

  if (!sessionSnap.exists()) {
    throw new Error(`Simulation ${simId} not found.`);
  }

  const interventions = interventionSnap.docs.map((d) =>
    plainify<InterventionPayload>(d.data()),
  );
  const amsaLogs = amsaSnap.docs.map((d) =>
    plainify<AmsaTimepointPayload>(d.data()),
  );

  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    simId,
    session: plainify<SimulationSessionDoc>(sessionSnap.data()),
    interventions,
    amsaLogs,
    counts: {
      interventions: interventions.length,
      amsaLogs: amsaLogs.length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Purge
 * ------------------------------------------------------------------ */

/** Firestore caps a single batch at 500 operations. */
const BATCH_LIMIT = 500;

/** What a purge found and removed. */
export interface PurgeSummary {
  sessions: number;
  interventions: number;
  amsaLogs: number;
}

/** How much is currently stored — the figure the confirmation step quotes. */
export async function countStoredData(): Promise<PurgeSummary> {
  const sessions = await getDocs(collection(getDb(), SIMULATIONS));

  const perSession = await Promise.all(
    sessions.docs.map(async (session) => {
      const [interventions, amsaLogs] = await Promise.all([
        getDocs(interventionsRef(session.id)),
        getDocs(amsaLogsRef(session.id)),
      ]);
      return { interventions: interventions.size, amsaLogs: amsaLogs.size };
    }),
  );

  return perSession.reduce<PurgeSummary>(
    (total, counts) => ({
      sessions: total.sessions,
      interventions: total.interventions + counts.interventions,
      amsaLogs: total.amsaLogs + counts.amsaLogs,
    }),
    { sessions: sessions.size, interventions: 0, amsaLogs: 0 },
  );
}

/** Delete every document in one collection, batched at Firestore's ceiling. */
async function deleteCollection(
  collectionRef: CollectionReference,
): Promise<number> {
  const snapshot = await getDocs(collectionRef);
  const db = getDb();

  for (let i = 0; i < snapshot.docs.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const document of snapshot.docs.slice(i, i + BATCH_LIMIT)) {
      batch.delete(document.ref);
    }
    await batch.commit();
  }

  return snapshot.size;
}

/**
 * Delete every stored simulation — root documents and both subcollections.
 *
 * Deleting a document in Firestore does **not** delete its subcollections, so
 * the children have to go first and explicitly; skipping them would leave
 * orphaned `Interventions` and `AmsaLogs` that still answer a collection query
 * and would silently mix into the next export. Children are removed before
 * their parent, so an interruption leaves a session whose subcollections are
 * already gone rather than a root document that no longer exists above live
 * telemetry.
 *
 * In-memory buffers are discarded first, for the reason given on
 * `discardAllAmsaBuffers`.
 */
export async function purgeAllData(): Promise<PurgeSummary> {
  discardAllAmsaBuffers();

  const sessions = await getDocs(collection(getDb(), SIMULATIONS));
  const summary: PurgeSummary = {
    sessions: sessions.size,
    interventions: 0,
    amsaLogs: 0,
  };

  for (const session of sessions.docs) {
    const [interventions, amsaLogs] = await Promise.all([
      deleteCollection(interventionsRef(session.id)),
      deleteCollection(amsaLogsRef(session.id)),
    ]);
    summary.interventions += interventions;
    summary.amsaLogs += amsaLogs;

    await deleteDoc(session.ref);
  }

  return summary;
}

/** Seed an empty session document directly — used by tests and fixtures. */
export async function upsertSimulationSession(
  session: SimulationSessionDoc,
): Promise<void> {
  await setDoc(
    simulationRef(session.simId),
    { ...session, createdAt: serverTimestamp() },
    { merge: true },
  );
}
