import { describe, expect, it } from "vitest";
import {
  MII_JOULES_COEFFICIENT,
  PAUSE_GRACE_MS,
  ROSC_BASE_HIGH,
  ROSC_BASE_INTERMEDIATE,
  ROSC_BASE_LOW,
  baseRoscProbability,
  myocardialInjuryIndex,
  pausePenalty,
  roscProbability,
  resolveShock,
} from "./outcome";

describe("baseRoscProbability", () => {
  it("maps each AMSA band to its base probability", () => {
    expect(baseRoscProbability(20)).toBe(ROSC_BASE_HIGH);
    expect(baseRoscProbability(15.5)).toBe(ROSC_BASE_HIGH);
    expect(baseRoscProbability(15.49)).toBe(ROSC_BASE_INTERMEDIATE);
    expect(baseRoscProbability(6.5)).toBe(ROSC_BASE_INTERMEDIATE);
    expect(baseRoscProbability(6.49)).toBe(ROSC_BASE_LOW);
    expect(baseRoscProbability(0)).toBe(ROSC_BASE_LOW);
  });

  it("falls back to the lowest band for non-finite AMSA", () => {
    expect(baseRoscProbability(Number.NaN)).toBe(ROSC_BASE_LOW);
  });
});

describe("pausePenalty", () => {
  it("is free within the grace period", () => {
    for (const ms of [0, 1000, PAUSE_GRACE_MS]) {
      expect(pausePenalty(ms)).toBe(0);
    }
  });

  it("costs 2 percentage points per second beyond the grace period", () => {
    expect(pausePenalty(6000)).toBeCloseTo(0.02, 10);
    expect(pausePenalty(10_000)).toBeCloseTo(0.1, 10);
    expect(pausePenalty(15_000)).toBeCloseTo(0.2, 10);
  });

  it("scales linearly with excess time", () => {
    expect(pausePenalty(25_000)).toBeCloseTo(2 * pausePenalty(15_000), 10);
  });
});

describe("roscProbability", () => {
  it("subtracts the pause penalty from the base", () => {
    // High band, 10 s pause: 0.90 - (5 s x 0.02) = 0.80
    expect(roscProbability(20, 10_000)).toBeCloseTo(0.8, 10);
    // Intermediate band, 8 s pause: 0.45 - (3 s x 0.02) = 0.39
    expect(roscProbability(10, 8000)).toBeCloseTo(0.39, 10);
  });

  it("clamps to zero rather than going negative", () => {
    // Low band with a very long pause would otherwise be well below zero.
    expect(roscProbability(2, 120_000)).toBe(0);
  });

  it("never exceeds one", () => {
    expect(roscProbability(100, 0)).toBeLessThanOrEqual(1);
  });

  it("is monotonically non-increasing in pause duration", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let ms = 0; ms <= 60_000; ms += 250) {
      const p = roscProbability(20, ms);
      expect(p).toBeLessThanOrEqual(previous + 1e-12);
      previous = p;
    }
  });
});

describe("resolveShock", () => {
  it("succeeds when the roll falls under the probability", () => {
    const result = resolveShock(20, 0, () => 0.5);
    expect(result.probability).toBeCloseTo(0.9, 10);
    expect(result.success).toBe(true);
  });

  it("fails when the roll lands above the probability", () => {
    expect(resolveShock(20, 0, () => 0.95).success).toBe(false);
  });

  it("is exclusive at the boundary — a roll equal to p fails", () => {
    expect(resolveShock(20, 0, () => 0.9).success).toBe(false);
  });

  it("can never succeed once the probability is clamped to zero", () => {
    for (const roll of [0, 0.001, 0.5, 0.999]) {
      expect(resolveShock(1, 300_000, () => roll).success).toBe(false);
    }
  });

  it("reports the components that produced the decision", () => {
    const result = resolveShock(10, 8000, () => 0.2);
    expect(result.base).toBeCloseTo(0.45, 10);
    expect(result.penalty).toBeCloseTo(0.06, 10);
    expect(result.roll).toBe(0.2);
  });

  it("converges on the stated probability over many trials", () => {
    // Deterministic LCG so the assertion cannot flake.
    let seed = 12345;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const trials = 20_000;
    let successes = 0;
    for (let i = 0; i < trials; i++) {
      if (resolveShock(20, 10_000, rng).success) successes++;
    }
    // Expected 0.80; allow a generous band for sampling noise.
    expect(successes / trials).toBeGreaterThan(0.77);
    expect(successes / trials).toBeLessThan(0.83);
  });
});

describe("myocardialInjuryIndex", () => {
  it("scales excess energy by the coefficient", () => {
    expect(myocardialInjuryIndex(400, 260)).toBeCloseTo(
      140 * MII_JOULES_COEFFICIENT,
      10,
    );
  });

  it("is zero when a protocol delivers exactly the calibrated energy", () => {
    expect(myocardialInjuryIndex(360, 360)).toBe(0);
  });

  it("floors at zero when less than optimal was delivered", () => {
    expect(myocardialInjuryIndex(100, 260)).toBe(0);
  });

  it("is zero before any shock is delivered", () => {
    expect(myocardialInjuryIndex(0, 0)).toBe(0);
  });

  /** The comparison the metric exists to make. */
  it("penalises a blanket 200 J dose against calibrated output", () => {
    const traditional = myocardialInjuryIndex(200 * 3, 180 * 3);
    const oide = myocardialInjuryIndex(180 * 3, 180 * 3);
    expect(oide).toBe(0);
    expect(traditional).toBeGreaterThan(0);
  });
});
