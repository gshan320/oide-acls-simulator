import type { FirebaseOptions } from "firebase/app";

/**
 * Firebase config read from NEXT_PUBLIC_* env vars.
 *
 * These must be referenced as full literal `process.env.NEXT_PUBLIC_X`
 * expressions — Next.js inlines them at build time and cannot resolve
 * dynamic lookups like `process.env[key]`.
 */
export const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

export const useEmulators =
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";

/** True once the minimum viable config is present. */
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId,
);

/** Firestore collection names, in one place. */
export const COLLECTIONS = {
  sessions: "sessions",
  patients: "patients",
  /** Subcollection of sessions/{id}. */
  logs: "logs",
  debriefs: "debriefs",
} as const;
