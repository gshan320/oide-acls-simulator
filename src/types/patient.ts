/** The rhythm vocabulary the signal worker and the rules engine share. */

export type AclsRhythm =
  | "sinus"
  | "sinus-bradycardia"
  | "sinus-tachycardia"
  | "atrial-fibrillation"
  | "svt"
  | "vtach-pulseless"
  | "vtach-with-pulse"
  | "vfib"
  | "vfib-fine"
  | "torsades"
  | "pea"
  | "asystole"
  | "third-degree-block";

/** Rhythms for which a defibrillator shock is indicated. */
export const SHOCKABLE_RHYTHMS: ReadonlySet<AclsRhythm> = new Set<AclsRhythm>([
  "vfib",
  "vfib-fine",
  "vtach-pulseless",
  "torsades",
]);

/**
 * Rhythms that generate a pulse, and therefore a pleth waveform and a normal
 * capnogram. PEA is deliberately absent: the electrical activity is organised
 * but produces no cardiac output, which is exactly what the EtCO₂ trace shows.
 */
export const PERFUSING_RHYTHMS: ReadonlySet<AclsRhythm> = new Set<AclsRhythm>([
  "sinus",
  "sinus-bradycardia",
  "sinus-tachycardia",
  "atrial-fibrillation",
  "svt",
  "vtach-with-pulse",
  "third-degree-block",
]);
