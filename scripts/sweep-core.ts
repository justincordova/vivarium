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
 *   - `rankScore(health, ticks)` — the pinned-shape scalarization the sweep ranks by.
 *
 * The parallel driver lives in `sweep.ts`; keeping the core pure makes the ranking
 * curve unit-testable (plan verification: a stagnant config must rank near the bottom).
 *
 * Imports only from `src/sim/`. Deterministic throughout.
 */

import type { ConfigOverrides } from "../src/sim/config";
import { makeConfig } from "../src/sim/config";
import * as C from "../src/sim/constants";
import { countExtinctionEvents, recentPopulationSeries, recordHistory } from "../src/sim/history";
import { mulberry32 } from "../src/sim/rng";
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
export const SWEEP_AXES: readonly Axis[] = [
  { path: "tunables.MUT_GLOBAL", lo: 0.25, hi: 3.0 },
  { path: "tunables.METABOLIC_COST_COEF", lo: 0.02, hi: 0.3 },
  { path: "tunables.PLANT_GROWTH_MAX", lo: 5, hi: 40 },
  { path: "tunables.TICKS_PER_DAY", lo: 200, hi: 2000, integer: true },
  { path: "tunables.CREATURE_CAP", lo: 60, hi: 200, integer: true },
  { path: "tunables.LIGHT_DECAY", lo: 0.02, hi: 0.3 },
  { path: "tunables.CORPSE_DECAY_FRACTION", lo: 0.02, hi: 0.2 },
  { path: "tunables.HYDRATION_DECAY", lo: 0.005, hi: 0.05 },
  { path: "tunables.SPECIES_SPATIAL_RADIUS", lo: 10, hi: 50 },
  { path: "initialSolarReservoir", lo: 1_000_000, hi: 4_000_000, integer: true },
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
  const r = mulberry32((masterSeed ^ (i * 0x9e3779b1)) >>> 0);
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

/**
 * The pinned-shape ranking scalarization (plan Task 1.5). Rewards oscillation,
 * genetic + behavioral diversity, and species count; penalizes stagnation (high
 * survival + near-zero variance); scores `extinctionEvents` as a tent peaking at
 * `EXTINCT_SWEET`; and discounts a chained mega-cluster via `maxDiameter` so
 * single-linkage chaining cannot game the diversity reward. Higher = better.
 */
export function rankScore(health: WorldHealth): number {
  const {
    populationVariance,
    traitVariance,
    speciesCount,
    behaviorNovelty,
    extinctionEvents,
    maxDiameter,
    survivalTicks,
  } = health;

  // Extinction tent: rises 0→EXTINCT_SWEET then falls (symmetric triangular peak 1).
  const sweet = C.EXTINCT_SWEET;
  const extinctTent = sweet <= 0 ? 0 : Math.max(0, 1 - Math.abs(extinctionEvents - sweet) / sweet);

  // Chaining discount: if the widest cluster's diameter far exceeds the compat
  // threshold, the "species" are a cline — scale the species reward down toward 0.
  const thr = makeConfig({}).tunables.SPECIES_COMPAT_THRESHOLD;
  const chainFactor = maxDiameter > thr ? thr / maxDiameter : 1;
  const speciesReward = speciesCount * (1 - C.RANK_W_CHAIN_DISCOUNT * (1 - chainFactor));

  // Stagnation penalty: a world that survived a long time but barely oscillated is
  // boring. Penalty ∝ (how far it got) × (how flat it was).
  const survivalFrac = Math.min(1, survivalTicks / C.RANK_SURVIVAL_SCALE);
  const flatness = 1 / (1 + populationVariance); // ~1 when variance ≈ 0, →0 as it grows
  const stagnation = survivalFrac * flatness;

  return (
    C.RANK_W_POP_VARIANCE * populationVariance +
    C.RANK_W_TRAIT_VARIANCE * traitVariance +
    C.RANK_W_SPECIES * Math.max(0, speciesReward) +
    C.RANK_W_NOVELTY * behaviorNovelty +
    C.RANK_W_EXTINCT * extinctTent -
    C.RANK_W_STAGNATION * stagnation
  );
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
  return { index, seed: runSeed, overrides, health, score: rankScore(health) };
}
