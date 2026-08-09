/**
 * sweep-core.ts — the pure, testable core of the Phase 1 parameter sweep (Task 1.5).
 *
 * SPEC.md §World-Health Metrics ("balance as search, not taste"): the habitable band
 * is found by search, not hand-tuning. This module holds the three pure pieces the
 * sweep and its tests share:
 *   - `sampleConfig(masterSeed, i)` — deterministically sample one `ConfigOverrides`
 *     over the (tunable) ranges, seeded from a master seed so the sweep is reproducible.
 *   - `runConfig(seed, overrides, ticks, sampleEvery)` — run one config headless and
 *     return its final `WorldHealth`.
 *   - `rankScore` — re-exported from `src/sim/score.ts`, which owns it now that
 *     Terrarium mode scores the player's world with the same function.
 *
 * The parallel driver lives in `sweep.ts`; keeping the core pure makes the ranking
 * curve unit-testable (plan verification: a stagnant config must rank near the bottom).
 *
 * Imports only from `src/sim/`. Deterministic throughout.
 */

import type { ConfigOverrides } from "../src/sim/config";
import { makeConfig } from "../src/sim/config";
import { countExtinctionEvents, recentPopulationSeries, recordHistory } from "../src/sim/history";
import { mulberry32 } from "../src/sim/rng";
import { rankScore } from "../src/sim/score";
import { type HealthHistory, type WorldHealth, worldHealth } from "../src/sim/stats";
import { tick } from "../src/sim/tick";
import { createWorld } from "../src/sim/world";

/** One swept axis: a tunable path + its inclusive [lo, hi] sampling range. */
interface Axis {
  /** Dotted path into `ConfigOverrides` (top-level or `tunables.*`). */
  readonly path: string;
  readonly lo: number;
  readonly hi: number;
  /** If true, round to an integer (day length, reservoir, cap). */
  readonly integer?: boolean;
}

/**
 * The swept axes (SPEC.md §World-Health "known stabilizers" + plan Task 1.5). A
 * deliberately compact set spanning the levers that move the habitable band:
 * mutation pressure, metabolism, plant regrowth, day length, energy budget,
 * carrying capacity, field decay, and the metric's own `SPECIES_SPATIAL_RADIUS`
 * (plan: swept with sensitivity checked, so speciesCount isn't an artifact of one
 * hand-picked radius).
 */
// Ranges narrowed toward the viable region diagnostics identified (plan Task 1.5 gate:
// "if nothing qualifies, iterate on sim/constants/costs"). Two collapse mechanisms were
// diagnosed and addressed: (a) metabolic starvation under high mutation load — so
// metabolism/mutation are kept moderate; (b) a synchronized death-spiral at the hard
// population cap — fixed structurally by the density-dependent reproduction brake.
// For OSCILLATION the sweep must find grazing pressure tight enough that herbivores
// deplete plants and create scarcity (a plant→herbivore feedback loop), so plant
// density/regrowth (PLANT_GROWTH_MAX, PLANT_CAP_PER_CELL) and the brake's soft
// threshold (REPRO_SOFT_FRAC) are swept — abundant-plant configs sit flat, scarce-plant
// configs boom-bust.
export const SWEEP_AXES: readonly Axis[] = [
  { path: "tunables.MUT_GLOBAL", lo: 0.5, hi: 1.6 },
  { path: "tunables.METABOLIC_COST_COEF", lo: 0.03, hi: 0.09 },
  { path: "tunables.PLANT_GROWTH_MAX", lo: 3, hi: 18 },
  { path: "tunables.PLANT_CAP_PER_CELL", lo: 1, hi: 3, integer: true },
  { path: "tunables.TICKS_PER_DAY", lo: 300, hi: 1600, integer: true },
  { path: "tunables.CREATURE_CAP", lo: 90, hi: 220, integer: true },
  { path: "tunables.REPRO_SOFT_FRAC", lo: 0.3, hi: 0.7 },
  { path: "tunables.CORPSE_DECAY_FRACTION", lo: 0.03, hi: 0.15 },
  { path: "tunables.HYDRATION_DECAY", lo: 0.008, hi: 0.03 },
  { path: "tunables.SPECIES_SPATIAL_RADIUS", lo: 15, hi: 45 },
  { path: "initialSolarReservoir", lo: 1_500_000, hi: 4_000_000, integer: true },
] as const;

/** Set a dotted `tunables.X` or top-level `X` path on a `ConfigOverrides`. */
function setPath(o: ConfigOverrides, path: string, value: number): void {
  if (path.startsWith("tunables.")) {
    const key = path.slice("tunables.".length);
    if (o.tunables === undefined) o.tunables = {};
    // biome-ignore lint/suspicious/noExplicitAny: dynamic tunable assignment by path
    (o.tunables as any)[key] = value;
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic top-level assignment by path
    (o as any)[path] = value;
  }
}

/**
 * Deterministically sample the i-th config for a sweep from `masterSeed`. Each axis
 * draws one uniform in its range from a per-sample stream (`masterSeed ⊕ i`), so the
 * whole sweep is reproducible: same master seed → same K configs → same ranking.
 */
export function sampleConfig(masterSeed: number, i: number): ConfigOverrides {
  // `Math.imul` (not float `*`) keeps the low 32 bits exact regardless of `i`, so the
  // per-sample seed is bit-stable at any sweep size — a plain `i * 0x9e3779b1` loses
  // integer precision once the product exceeds 2^53 (~3.4M samples), which would silently
  // alias distinct sample indices to identical configs. Matches the integer-hash house
  // style in rng.ts / frame.ts, and honors this function's "same seed → same K configs".
  const r = mulberry32((masterSeed ^ Math.imul(i, 0x9e3779b1)) >>> 0);
  const overrides: ConfigOverrides = {};
  for (let a = 0; a < SWEEP_AXES.length; a++) {
    const axis = SWEEP_AXES[a] as Axis;
    const raw = axis.lo + r.next() * (axis.hi - axis.lo);
    setPath(overrides, axis.path, axis.integer ? Math.round(raw) : raw);
  }
  return overrides;
}

/** Run one config headless for `ticks` and return its final `WorldHealth`. */
export function runConfig(seed: number, overrides: ConfigOverrides, ticks: number): WorldHealth {
  const world = createWorld(seed, makeConfig(overrides));
  recordHistory(world);
  for (let i = 0; i < ticks; i++) {
    tick(world);
    recordHistory(world);
    // Early-out on extinction: a dead world's metrics won't change, and continuing
    // wastes the sweep's time budget. The final health still reflects the collapse.
    if (world.creatures.length === 0) break;
  }
  const history: HealthHistory = {
    populationSeries: recentPopulationSeries(world),
    extinctionEvents: countExtinctionEvents(world),
  };
  return worldHealth(world, history);
}

/** One sweep result row: the sampled config index/overrides + its health + score. */
export interface SweepResult {
  index: number;
  seed: number;
  overrides: ConfigOverrides;
  health: WorldHealth;
  score: number;
}

/** Run and score a single sampled config (the unit a worker executes). */
export function evaluate(
  masterSeed: number,
  index: number,
  runSeed: number,
  ticks: number,
): SweepResult {
  const overrides = sampleConfig(masterSeed, index);
  const health = runConfig(runSeed, overrides, ticks);
  return { index, seed: runSeed, overrides, health, score: rankScore(health, ticks) };
}

// Re-exported so the sweep and its tests keep one import site while `sim/score.ts`
// remains the single definition of "interesting" (see docs/designs/terrarium.md).
export { rankScore };
