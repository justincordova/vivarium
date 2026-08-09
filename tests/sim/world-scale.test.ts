/**
 * world-scale.test.ts — the regression gate for the default world's *scale*.
 *
 * Phase 6 grew the world 25× in area and left `CREATURE_CAP` and `senseRadius` where they
 * were. Nothing failed. It took two phases and a 4-hour measurement to notice that the
 * shipped world had stopped working — booming once, collapsing to a 1–2 species
 * monoculture and dying outright on 1 seed in 3
 * (`docs/findings/world-scale-oscillation.md`).
 *
 * The reason nothing failed is that the real gate, `gate.test.ts`, is pinned to the legacy
 * 200×200 rule world, and the honest measurement (50k ticks × several seeds) costs ~30
 * minutes per seed — far outside any test budget. So this file gates the *derived
 * quantity* the expensive measurement was ultimately about, which is O(1) to check.
 */

import { makeConfig } from "@sim/config";
import { recordHistory } from "@sim/history";
import { tick } from "@sim/tick";
import { createWorld, FOUNDER_SENSE_RADIUS } from "@sim/world";
import { describe, expect, it } from "vitest";

/**
 * Expected number of other creatures inside one creature's sense radius at carrying
 * capacity — `(cap / area) × π r²`. This single number is what Phase 6 broke, and what the
 * 400×400 rebalance restored.
 */
function encounterDensity(): number {
  const c = makeConfig({});
  const cap = c.tunables.CREATURE_CAP;
  return (cap / (c.worldWidth * c.worldHeight)) * Math.PI * FOUNDER_SENSE_RADIUS ** 2;
}

describe("default world scale", () => {
  /**
   * Band endpoints are measured, not guessed (3 seeds × 50k ticks each, sweep mode of
   * `scripts/measure-oscillation.ts`):
   *
   *   density 0.24 (1000×1000) — collapses: 2/3 seeds alive, 0–2 species  ✗
   *   density 0.94 ( 500×500 ) — survives, oscillates on 1 of 3 seeds
   *   density 1.47 ( 400×400 ) — oscillates on 3 of 3 seeds  ← current default
   *   density 2.62 ( 300×300 ) — survives, oscillates on 1 of 3 seeds
   *   density 5.89 ( 200×200 ) — saturates: pinned at the cap, 0 cycles on every seed  ✗
   *
   * Both ends are failure modes, so this is a band and not a floor. It is deliberately
   * wider than the tested-good point: the job is to catch a world-size or cap change that
   * silently leaves the viable range, not to pin the default to one value.
   */
  it("keeps encounter density inside the measured-viable band", () => {
    const density = encounterDensity();
    // Too sparse → creatures never meet: no predation, no gene flow, monoculture, death.
    expect(density).toBeGreaterThan(0.8);
    // Too dense → the population pins against the cap and stops oscillating entirely.
    expect(density).toBeLessThan(3.0);
  });

  /**
   * Guards the specific coupling that failed: `worldWidth`/`worldHeight` and
   * `CREATURE_CAP` are independently editable, and the damage only shows up in their
   * ratio. If someone changes one, this fails and points at the other.
   */
  it("pins the exact default so a change to either side is deliberate", () => {
    const c = makeConfig({});
    expect(c.worldWidth).toBe(400);
    expect(c.worldHeight).toBe(400);
    expect(c.tunables.CREATURE_CAP).toBe(120);
    expect(encounterDensity()).toBeCloseTo(1.47, 2);
  });

  /**
   * A liveness smoke test — cheap enough for CI, and it would have caught the extinction
   * seed. Not an oscillation test: amplitude needs tens of thousands of ticks to develop,
   * which is exactly what does not fit here.
   */
  it("sustains a living population from founders on multiple seeds", () => {
    for (const seed of [1, 7]) {
      const world = createWorld(seed, makeConfig({}));
      recordHistory(world);
      for (let i = 0; i < 1500; i++) {
        tick(world);
        recordHistory(world);
      }
      expect(world.creatures.length, `seed ${seed} went extinct`).toBeGreaterThan(20);
    }
  }, 240_000);
});
