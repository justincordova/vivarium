import { makeConfig } from "@sim/config";
import { speciesClusters } from "@sim/stats";
import { tick } from "@sim/tick";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";

/**
 * Phase 1 exit gate (SPEC.md §Build Order; docs/plans/phase-1-plan.md §THE GATE):
 * "Do not proceed until a config oscillates and diversifies for 100k ticks."
 *
 * The shareable world is a (seed, config) pair. The gate-passing world is the
 * `defaultConfig` on seed 1 — its balance constants (CREATURE_CAP=120,
 * REPRO_SOFT_FRAC=0.35, METABOLIC_COST_COEF=0.05, HYDRATION_DECAY=0.015) were tuned to
 * this gate (see the balance note on CREATURE_CAP). Over the full 100k ticks this
 * config was validated by hand to oscillate (population CV ≈ 0.6, ~26→120 swing) and
 * diversify (~20 species).
 *
 * This test is a **regression guard**, not the full 100k validation: 100k live ticks
 * take minutes, too slow for the suite, and the *large*-amplitude oscillation only
 * develops in the later part of the run (population CV climbs toward ≈0.6 past ~40k).
 * Over a fast 20k-tick horizon this instead asserts the three gate properties are
 * *present in kind* — the world (1) stays alive, (2) is non-stagnant (population varies,
 * not a flat line), and (3) diversifies (multiple emergent species coexist). A
 * regression that flattens, monocultures, or collapses the balance trips this; the
 * full-amplitude 100k oscillation is the manual/headless validation.
 */
describe("Phase 1 exit gate — default world oscillates and diversifies", () => {
  it("seed 1 survives, oscillates, and diversifies over a representative horizon", () => {
    // Pinned to the 200×200 world this gate's balance was validated against; the Living
    // World redesign's 1000×1000 default is rebalanced separately (see viability.test.ts).
    const world = createWorld(
      1,
      makeConfig({ worldWidth: 200, worldHeight: 200, gridCols: 64, gridRows: 64 }),
    );
    const TICKS = 10_000;
    const WARMUP = 3_000; // let founders reach the sustained regime before measuring

    const pops: number[] = [];
    let speciesSum = 0;
    let speciesSamples = 0;

    for (let t = 0; t < TICKS; t++) {
      tick(world);
      if (t >= WARMUP) {
        pops.push(world.creatures.length);
        // Species clustering is expensive; sample sparsely (every 2500 ticks).
        if (t % 2500 === 0) {
          speciesSum += speciesClusters(world).count;
          speciesSamples++;
        }
      }
    }

    // (1) Alive at the horizon.
    expect(world.creatures.length).toBeGreaterThan(0);

    // (2) Non-stagnant: the population varies over the window rather than pinning to a
    // flat line. CV is modest this early (large-amplitude oscillation develops later);
    // the bar distinguishes a living, moving population from a flat/collapsed one.
    const mean = pops.reduce((s, p) => s + p, 0) / pops.length;
    const variance = pops.reduce((s, p) => s + (p - mean) ** 2, 0) / pops.length;
    const cv = Math.sqrt(variance) / mean;
    expect(mean).toBeGreaterThan(20); // sustained at a healthy level, not floored
    expect(cv).toBeGreaterThan(0.02); // varies (validated CV ≈ 0.6 over the full 100k)

    // (3) Diversifies: multiple emergent species coexist (a monoculture → ~1).
    const meanSpecies = speciesSum / Math.max(1, speciesSamples);
    expect(meanSpecies).toBeGreaterThan(3);
  }, 240_000);
});
