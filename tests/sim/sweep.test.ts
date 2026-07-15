import type { WorldHealth } from "@sim/stats";
import { describe, expect, it } from "vitest";
import { rankScore, SWEEP_AXES, sampleConfig } from "../../scripts/sweep-core";

/** A neutral baseline health; individual tests perturb the fields under test. */
function health(over: Partial<WorldHealth> = {}): WorldHealth {
  return {
    survivalTicks: 100_000,
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
    expect(rankScore(stagnant)).toBeLessThan(rankScore(lively));
  });

  it("rewards higher populationVariance (oscillation is good, not penalized)", () => {
    const low = health({ populationVariance: 50 });
    const high = health({ populationVariance: 800 });
    expect(rankScore(high)).toBeGreaterThan(rankScore(low));
  });

  it("rewards higher traitVariance and behaviorNovelty", () => {
    expect(rankScore(health({ traitVariance: 0.05 }))).toBeGreaterThan(
      rankScore(health({ traitVariance: 0.0 })),
    );
    expect(rankScore(health({ behaviorNovelty: 0.6 }))).toBeGreaterThan(
      rankScore(health({ behaviorNovelty: 0.0 })),
    );
  });

  it("scores extinctionEvents as a tent peaking at the sweet spot", () => {
    const none = rankScore(health({ extinctionEvents: 0 }));
    const sweet = rankScore(health({ extinctionEvents: 5 }));
    const collapse = rankScore(health({ extinctionEvents: 40 }));
    expect(sweet).toBeGreaterThan(none);
    expect(sweet).toBeGreaterThan(collapse);
  });

  it("discounts a chained mega-cluster via maxDiameter (chaining can't game diversity)", () => {
    // Same speciesCount, but one has a huge diameter → its species reward is discounted.
    const tight = health({ speciesCount: 8, maxDiameter: 4 });
    const chained = health({ speciesCount: 8, maxDiameter: 200 });
    expect(rankScore(chained)).toBeLessThan(rankScore(tight));
  });

  it("is a pure function — same input, same score", () => {
    const h = health();
    expect(rankScore(h)).toBe(rankScore(h));
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
