/**
 * tick.bench.ts — Phase 1 Task 1.4 benchmarks.
 *
 * Measures the two real Phase-1 hot paths so `MS_PER_TICK` and `MAX_OFFLINE_TICKS`
 * are chosen from a measured rate, not a guessed one (SPEC.md §Tick Semantics,
 * §Offline Catch-up; plan Task 1.4):
 *   1. `tick(world)` at a realistic warmed-up population + plant density — the real
 *      hot path (per-creature spatial-hash queries dominate). NOT a toy population.
 *   2. `worldHealth(...)` recompute at population scale — it runs every ~500 ticks
 *      and can dominate sweep wall-clock, and it does NOT show up in the per-tick
 *      bench, so it is measured separately.
 *
 * The derived-weights-cache A/B (plan Task 1.4) is deliberately NOT here: the cache
 * backs the Phase-4 `PatchbayBrain.think` forward pass, which does not exist yet
 * (the rule policy ignores brain arrays, so `Creature.derived` is never on the live
 * path in Phase 0–3). The plan sequences that A/B for *after* the sweep fixes
 * `DRIFT_RATE` and *after* the Phase-4 brain lands; benchmarking a code path that
 * currently returns a constant vector would be a fabricated measurement. It is
 * recorded as deferred in `constants.ts` alongside the `MAX_OFFLINE_TICKS` note.
 *
 * Runs in Node (never jsdom). Imports only from `src/sim/`.
 */

import { makeConfig } from "@sim/config";
import { countExtinctionEvents, recentPopulationSeries, recordHistory } from "@sim/history";
import { type HealthHistory, worldHealth } from "@sim/stats";
import { tick } from "@sim/tick";
import type { World } from "@sim/types";
import { createWorld } from "@sim/world";
import { bench, describe } from "vitest";

/**
 * Build a warmed-up world at steady-state density. Seed 1 sustains a living
 * population (viability quorum); 600 ticks lets founders breed to the carrying-
 * capacity band (~100 creatures) and plants reach realistic density, so the bench
 * measures the true per-creature cost rather than the sparse founder state.
 */
function warmWorld(): World {
  const world = createWorld(1, makeConfig({}));
  for (let i = 0; i < 600; i++) {
    tick(world);
    recordHistory(world);
  }
  return world;
}

describe("tick loop", () => {
  // A fresh warmed world; `tick` mutates it, so each iteration advances one tick
  // from steady state — representative of the sustained hot path.
  const world = warmWorld();
  bench("tick(world) at steady-state population", () => {
    tick(world);
  });
});

describe("metrics path", () => {
  // Read-only: a fixed warmed world, called repeatedly. This is the ~500-tick
  // recompute cost that gates sweep throughput.
  const world = warmWorld();
  const history: HealthHistory = {
    populationSeries: recentPopulationSeries(world),
    extinctionEvents: countExtinctionEvents(world),
  };
  bench("worldHealth(world, history) at population scale", () => {
    worldHealth(world, history);
  });
});
