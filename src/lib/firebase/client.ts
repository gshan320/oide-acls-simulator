"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
} from "firebase/firestore";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { firebaseConfig, isFirebaseConfigured, useEmulators } from "./config";

let emulatorsConnected = false;

/** Idempotent app init — safe under Fast Refresh and repeated imports. */
export function getFirebaseApp(): FirebaseApp {
  if (!isFirebaseConfigured) {
    throw new Error(
      "Firebase is not configured. Fill in NEXT_PUBLIC_FIREBASE_* in .env.local.",
    );
  }
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

export function getDb(): Firestore {
  const db = getFirestore(getFirebaseApp());

  if (useEmulators && !emulatorsConnected) {
    const [host, port] = (
      process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080"
    ).split(":");
    connectFirestoreEmulator(db, host, Number(port));
    connectAuthEmulator(
      getAuth(getFirebaseApp()),
      process.env.NEXT_PUBLIC_AUTH_EMULATOR_URL ?? "http://127.0.0.1:9099",
      { disableWarnings: true },
    );
    emulatorsConnected = true;
  }

  return db;
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}
