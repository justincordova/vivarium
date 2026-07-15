/**
 * history.ts — rolling world history: sampling + bounded-memory downsampling.
 *
 * `worldHealth`'s window metrics (`meanPopulation`, `populationVariance`) and the
 * Phase 2 charts read `world.history` (SPEC.md §Lineage; plan Task 1.2). Unbounded
 * memory is a designed-for failure mode, so this keeps a recent window at full
 * detail (every `HISTORY_SAMPLE_INTERVAL` ticks) and downsamples older entries to
 * one point per `HISTORY_DOWNSAMPLE_TICKS` ticks.
 *
 * **Called by the worker/runner, NOT by `tick()`** — sampling cadence is a stats
 * concern, and the per-gene trait means/variances use `expressTrait` (fine, but
 * this keeps `tick()` free of history bookkeeping). It writes only `world.history`.
 *
 * Part of `sim/`: imports only sibling `sim/` modules. Deterministic (index-based;
 * no `Set`/`Object.keys` iteration affecting values).
 */

import * as C from "./constants";
import { expressTrait, TRAIT_GENES, type TraitGene } from "./genetics";
import { speciesClusters } from "./stats";
import type { Creature, HistorySample, World } from "./types";

/** Per-gene population mean + variance of expressed value over the current creatures. */
function traitMomentsOf(creatures: readonly Creature[]): {
  means: Record<string, number>;
  variances: Record<string, number>;
} {
  const means: Record<string, number> = {};
  const variances: Record<string, number> = {};
  const n = creatures.length;
  for (let g = 0; g < TRAIT_GENES.length; g++) {
    const gene = TRAIT_GENES[g] as TraitGene;
    if (n === 0) {
      means[gene] = 0;
      variances[gene] = 0;
      continue;
    }
    let m = 0;
    for (let i = 0; i < n; i++) m += expressTrait((creatures[i] as Creature).genome[gene]);
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const d = expressTrait((creatures[i] as Creature).genome[gene]) - m;
      v += d * d;
    }
    v /= n;
    means[gene] = m;
    variances[gene] = v;
  }
  return { means, variances };
}

/**
 * Build a full-detail history sample for the current world state. `speciesCount` is
 * recomputed only on the ~500-tick cadence (SPEC.md); off-cadence it is carried
 * forward from the previous sample (or 0) so we don't pay the clustering cost every
 * sample.
 */
export function buildSample(world: World, recomputeSpecies: boolean): HistorySample {
  const moments = traitMomentsOf(world.creatures);
  const prev = world.history[world.history.length - 1];
  const speciesCount = recomputeSpecies ? speciesClusters(world).count : (prev?.speciesCount ?? 0);
  return {
    tick: world.tick,
    population: world.creatures.length,
    plantCount: world.plants.length,
    corpseCount: world.corpses.length,
    traitMeans: moments.means,
    traitVariances: moments.variances,
    speciesCount,
  };
}

/**
 * Append a history sample if the sample cadence has elapsed, then prune older
 * entries down to the downsample rate. Idempotent per tick: only samples when
 * `world.tick % HISTORY_SAMPLE_INTERVAL === 0`. The recent window (the last
 * `HISTORY_RECENT_WINDOW` samples) stays at full detail; older samples are thinned
 * to at most one per `HISTORY_DOWNSAMPLE_TICKS` ticks.
 */
export function recordHistory(world: World): void {
  if (world.tick % C.HISTORY_SAMPLE_INTERVAL !== 0) return;
  const prev = world.history[world.history.length - 1];
  const recomputeSpecies = world.tick % C.SPECIES_RECOMPUTE_INTERVAL === 0;
  const sample = buildSample(world, recomputeSpecies);
  // Whole-world extinction event: population crossed from positive to zero since the
  // last sample. Emitted here (a stats concern) rather than in `tick()` so the hot
  // loop stays free of derived bookkeeping; still deterministic (a pure function of
  // sampled population). Extinction is "total collapse" (SPEC.md §World-Health).
  if (sample.population === 0 && prev !== undefined && prev.population > 0) {
    world.eventLog.push({ tick: world.tick, event: "extinct" });
  }
  world.history.push(sample);
  downsampleOldHistory(world);
}

/**
 * Thin the portion of history older than the recent window to one sample per
 * `HISTORY_DOWNSAMPLE_TICKS` ticks. Keeps the most recent `HISTORY_RECENT_WINDOW`
 * samples untouched; for older samples, keeps the first sample of each downsample
 * bucket (bucket = floor(tick / HISTORY_DOWNSAMPLE_TICKS)). Index-based; stable.
 */
export function downsampleOldHistory(world: World): void {
  const h = world.history;
  const recentStart = h.length - C.HISTORY_RECENT_WINDOW;
  if (recentStart <= 1) return; // nothing old enough to thin yet

  const kept: HistorySample[] = [];
  let lastBucket = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < recentStart; i++) {
    const s = h[i] as HistorySample;
    const bucket = Math.floor(s.tick / C.HISTORY_DOWNSAMPLE_TICKS);
    if (bucket !== lastBucket) {
      kept.push(s);
      lastBucket = bucket;
    }
  }
  // Append the untouched recent window in order.
  for (let i = recentStart; i < h.length; i++) kept.push(h[i] as HistorySample);
  world.history = kept;
}

/**
 * The recent population series from history, for `worldHealth`'s window metrics.
 * Returns the last `HISTORY_RECENT_WINDOW` populations in tick order.
 */
export function recentPopulationSeries(world: World): number[] {
  const h = world.history;
  const start = Math.max(0, h.length - C.HISTORY_RECENT_WINDOW);
  const out: number[] = [];
  for (let i = start; i < h.length; i++) out.push((h[i] as HistorySample).population);
  return out;
}

/**
 * Count extinction events in the event log — a `kill:*` cascade is not an
 * extinction; the tracked signal is the population reaching zero (total collapse).
 * Phase 5A.3 will formalize the typed event union; for Phase 1 the runner counts
 * `extinct` events the sampler emits when population hits 0 after being positive.
 */
export function countExtinctionEvents(world: World): number {
  let n = 0;
  for (let i = 0; i < world.eventLog.length; i++) {
    if ((world.eventLog[i] as { event: string }).event === "extinct") n++;
  }
  return n;
}
