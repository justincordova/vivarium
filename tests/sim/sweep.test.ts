import type { WorldHealth } from "@sim/stats";
import { describe, expect, it } from "vitest";
import { rankScore, SWEEP_AXES, sampleConfig } from "../../scripts/sweep-core";

const HORIZON = 100_000;

/** A neutral baseline health for a world that REACHED the horizon alive. */
function health(over: Partial<WorldHealth> = {}): WorldHealth {
  return {
    survivalTicks: HORIZON,
    meanPopulation: 80,
    populationVariance: 300,
    traitVariance: 0.01,
    speciesCount: 10,
    maxDiameter: 5,
    extinctionEvents: 3,
    behaviorNovelty: 0.2,
    ...over,
  };
}

describe("rankScore — pinned ranking shape", () => {
  it("a stagnant world (long survival, ~zero oscillation) ranks below a lively one", () => {
    const stagnant = health({
      populationVariance: 0,
      traitVariance: 0,
      speciesCount: 1,
      behaviorNovelty: 0,
      extinctionEvents: 0,
    });
    const lively = health();
    expect(rankScore(stagnant, HORIZON)).toBeLessThan(rankScore(lively, HORIZON));
  });

  it("a boom-crash world that DIED early ranks below a modest survivor (horizon gate)", () => {
    // The failure the first real sweep exposed: a world that boomed then crashed to
    // extinction has HUGE populationVariance but is dead (species/novelty 0). It must
    // NOT outrank a modestly-oscillating world that actually reached the horizon.
    const crashed = health({
      survivalTicks: 3141, // died at 3% of the horizon
      populationVariance: 8547, // enormous variance from the boom-then-crash
      speciesCount: 0,
      behaviorNovelty: 0,
      traitVariance: 0,
      meanPopulation: 0,
    });
    const modestSurvivor = health({
      populationVariance: 120,
      speciesCount: 4,
      behaviorNovelty: 0.1,
    });
    expect(rankScore(crashed, HORIZON)).toBeLessThan(rankScore(modestSurvivor, HORIZON));
    // And a non-survivor always scores below zero (no diversity/variance credit).
    expect(rankScore(crashed, HORIZON)).toBeLessThan(0);
  });

  it("among non-survivors, surviving longer ranks higher (gradient toward viability)", () => {
    const early = health({ survivalTicks: 1000, meanPopulation: 0 });
    const later = health({ survivalTicks: 50_000, meanPopulation: 0 });
    expect(rankScore(later, HORIZON)).toBeGreaterThan(rankScore(early, HORIZON));
  });

  it("rewards higher populationVariance among survivors (oscillation is good)", () => {
    const low = health({ populationVariance: 50 });
    const high = health({ populationVariance: 800 });
    expect(rankScore(high, HORIZON)).toBeGreaterThan(rankScore(low, HORIZON));
  });

  it("rewards higher traitVariance and behaviorNovelty", () => {
    expect(rankScore(health({ traitVariance: 0.05 }), HORIZON)).toBeGreaterThan(
      rankScore(health({ traitVariance: 0.0 }), HORIZON),
    );
    expect(rankScore(health({ behaviorNovelty: 0.6 }), HORIZON)).toBeGreaterThan(
      rankScore(health({ behaviorNovelty: 0.0 }), HORIZON),
    );
  });

  it("scores extinctionEvents as a tent peaking at the sweet spot", () => {
    const none = rankScore(health({ extinctionEvents: 0 }), HORIZON);
    const sweet = rankScore(health({ extinctionEvents: 5 }), HORIZON);
    const collapse = rankScore(health({ extinctionEvents: 40 }), HORIZON);
    expect(sweet).toBeGreaterThan(none);
    expect(sweet).toBeGreaterThan(collapse);
  });

  it("discounts a chained mega-cluster via maxDiameter (chaining can't game diversity)", () => {
    // Same speciesCount, but one has a huge diameter → its species reward is discounted.
    const tight = health({ speciesCount: 8, maxDiameter: 4 });
    const chained = health({ speciesCount: 8, maxDiameter: 200 });
    expect(rankScore(chained, HORIZON)).toBeLessThan(rankScore(tight, HORIZON));
  });

  it("is a pure function — same input, same score", () => {
    const h = health();
    expect(rankScore(h, HORIZON)).toBe(rankScore(h, HORIZON));
  });
});

describe("sampleConfig — reproducible search", () => {
  it("same master seed + index → identical overrides", () => {
    expect(sampleConfig(1, 0)).toEqual(sampleConfig(1, 0));
    expect(sampleConfig(7, 42)).toEqual(sampleConfig(7, 42));
  });

  it("different indices produce different configs", () => {
    expect(sampleConfig(1, 0)).not.toEqual(sampleConfig(1, 1));
  });

  it("every sampled value lands within its axis range", () => {
    for (let i = 0; i < 50; i++) {
      const o = sampleConfig(3, i);
      for (const axis of SWEEP_AXES) {
        const value = axis.path.startsWith("tunables.")
          ? // biome-ignore lint/suspicious/noExplicitAny: dynamic read by path in test
            (o.tunables as any)?.[axis.path.slice("tunables.".length)]
          : // biome-ignore lint/suspicious/noExplicitAny: dynamic read by path in test
            (o as any)[axis.path];
        expect(value).toBeGreaterThanOrEqual(axis.lo);
        expect(value).toBeLessThanOrEqual(axis.hi);
      }
    }
  });
});
