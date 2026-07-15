/**
 * stats.ts — the authoritative conserved-quantity sums + Phase 1 world-health metrics.
 *
 * `totalEnergy(world)` and `totalWater(world)` are the single functions the sim and
 * the conservation property test both call (SPEC.md §Energy, §Water). Exact integer
 * arithmetic — no epsilon. The invariants are `totalEnergy(after) === totalEnergy
 * (before)` and `totalWater(after) === totalWater(before)`, every tick.
 *
 * `worldHealth` (SPEC.md §World-Health Metrics; plan Task 1.1) is the scalar the
 * Phase 1 sweep optimizes. **It is read by the runner/sweep, NEVER by `tick()`** —
 * so it may use `Math.log` (JSD) and other non-pinned floats: it is outside the
 * cross-engine determinism boundary. A future refactor MUST NOT route any
 * `worldHealth` term back into selection/`tick()` or it silently breaks that
 * guarantee.
 *
 * Part of `sim/`: imports only sibling `sim/` modules.
 */

import { distance, expressTrait, TRAIT_GENES, TRAIT_RANGE, type TraitGene } from "./genetics";
import { SpatialHash, type SpatialPoint } from "./spatial";
import type { Creature, World } from "./types";

/** Exact integer sum of an integer typed array (index-based; no reduce/iterator). */
function sumInt32(arr: Int32Array): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] as number;
  return s;
}

/**
 * The conserved energy quantity — exact integer sum over every compartment
 * (SPEC.md §"The conserved quantity"):
 *   solarReservoir + Σcreature.energy + Σplant.energy + Σcorpse.energy
 *   + ΣfertilityField + ΣlightField.
 * There is no `scent`/`temperature` term — those are non-conserved modulator fields.
 */
export function totalEnergy(world: World): number {
  let total = world.solarReservoir;
  const { creatures, plants, corpses, fields } = world;
  for (let i = 0; i < creatures.length; i++) total += (creatures[i] as { energy: number }).energy;
  for (let i = 0; i < plants.length; i++) total += (plants[i] as { energy: number }).energy;
  for (let i = 0; i < corpses.length; i++) total += (corpses[i] as { energy: number }).energy;
  total += sumInt32(fields.fertility);
  total += sumInt32(fields.light);
  return total;
}

/**
 * The conserved water quantity (SPEC.md §Water):
 *   ΣwaterField + Σcreature.hydration.
 * Corpses carry **no** water (no `hydration` field — enforced by the `Corpse` type)
 * and plants hold no water, so neither appears here. Adding either would silently
 * break `totalWater` conservation.
 */
export function totalWater(world: World): number {
  let total = sumInt32(world.fields.water);
  const { creatures } = world;
  for (let i = 0; i < creatures.length; i++) {
    total += (creatures[i] as { hydration: number }).hydration;
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// World-health metrics  (SPEC.md §World-Health Metrics; plan Task 1.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The scalarizable world-health snapshot the Phase 1 sweep ranks configs by.
 * `survivalTicks`/`meanPopulation`/`populationVariance`/`extinctionEvents` are
 * derived from the rolling history (`meanPopulation` etc. need a window); the rest
 * are computed from the live world. `populationVariance` is a **reward** (high =
 * good oscillation), never a penalty — the ranking must not punish it (SPEC.md).
 */
export interface WorldHealth {
  survivalTicks: number;
  meanPopulation: number;
  populationVariance: number;
  traitVariance: number;
  speciesCount: number;
  /** Guard against single-linkage chaining: max intra-cluster expressed distance. */
  maxDiameter: number;
  extinctionEvents: number;
  /** PROVISIONAL proxy (SPEC.md §Open Questions defers the exact formula). */
  behaviorNovelty: number;
}

/**
 * Functional trait genes — every diploid trait gene EXCEPT the neutral `hue`
 * (SPEC.md §The Genome: hue drifts neutrally, so it must not count toward genetic
 * diversity). Fixed order from the `TRAIT_GENES` registry.
 */
const FUNCTIONAL_TRAIT_GENES: readonly TraitGene[] = TRAIT_GENES;

/**
 * `traitVariance` = mean over functional trait genes of the population variance of
 * that gene's **expressed** value, each gene normalized by its legal range so genes
 * contribute comparably (plan Task 1.1). Monoculture → ~0. Empty population → 0.
 */
export function traitVariance(creatures: readonly Creature[]): number {
  const n = creatures.length;
  if (n === 0) return 0;
  let sumNorm = 0;
  for (let g = 0; g < FUNCTIONAL_TRAIT_GENES.length; g++) {
    const gene = FUNCTIONAL_TRAIT_GENES[g] as TraitGene;
    const [lo, hi] = TRAIT_RANGE[gene];
    const range = hi - lo;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      mean += expressTrait((creatures[i] as Creature).genome[gene]);
    }
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      const d = expressTrait((creatures[i] as Creature).genome[gene]) - mean;
      variance += d * d;
    }
    variance /= n;
    // Normalize per gene by the square of its legal range so each gene's variance is
    // on a comparable [0,~1] scale regardless of units.
    sumNorm += range > 0 ? variance / (range * range) : 0;
  }
  return sumNorm / FUNCTIONAL_TRAIT_GENES.length;
}

/**
 * `speciesCount` result: cluster count plus the max intra-cluster expressed genetic
 * distance across all clusters (`maxDiameter`). A cluster whose diameter ≫
 * `SPECIES_COMPAT_THRESHOLD` is a genetic cline chained by single-linkage, not one
 * species — the sweep reads `maxDiameter` so chaining can't game the diversity
 * reward (plan Task 1.1).
 */
export interface SpeciesResult {
  count: number;
  maxDiameter: number;
}

/**
 * Spatially-restricted, diameter-checked single-linkage species clustering
 * (plan Task 1.1). Compatibility edges exist only between creatures within
 * `SPECIES_SPATIAL_RADIUS` of each other (allopatric speciation is spatial; also
 * turns the edge build into ~O(n·k)) whose genetic `distance < SPECIES_COMPAT_THRESHOLD`.
 * Union-find over that edge set, index-based on the stable creature array with
 * ascending-index tie handling — deterministic. Also returns `maxDiameter` (the max
 * intra-cluster pairwise expressed distance) as the chaining guard.
 */
export function speciesClusters(world: World): SpeciesResult {
  const creatures = world.creatures;
  const n = creatures.length;
  if (n === 0) return { count: 0, maxDiameter: 0 };
  const t = world.config.tunables;

  // Union-find (index-based; ascending-index root by always attaching higher→lower).
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while ((parent[r] as number) !== r) r = parent[r] as number;
    // Path-compress toward the (lower-index) root.
    let cur = x;
    while ((parent[cur] as number) !== r) {
      const nxt = parent[cur] as number;
      parent[cur] = r;
      cur = nxt;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Attach the higher-index root under the lower so roots stay ascending-id stable.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  // Spatial hash keyed by array index (id used only for point identity here).
  const pts: SpatialPoint[] = new Array(n);
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = creatures[i] as Creature;
    pts[i] = { id: c.id, x: c.x, y: c.y };
    idToIndex.set(c.id, i);
  }
  const radius = t.SPECIES_SPATIAL_RADIUS;
  const hash = new SpatialHash(pts, Math.max(1, radius));

  // Restrict edges to spatial neighbors; add an edge on genetic compatibility.
  for (let i = 0; i < n; i++) {
    const ci = creatures[i] as Creature;
    const neighborIds = hash.queryWithin(ci.x, ci.y, radius);
    for (let k = 0; k < neighborIds.length; k++) {
      const j = idToIndex.get(neighborIds[k] as number);
      if (j === undefined || j <= i) continue; // each unordered pair once
      const cj = creatures[j] as Creature;
      if (distance(ci.genome, cj.genome, t) < t.SPECIES_COMPAT_THRESHOLD) union(i, j);
    }
  }

  // Count distinct roots and, per cluster, its max intra-cluster expressed distance.
  const rootMembers = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const bucket = rootMembers.get(r);
    if (bucket === undefined) rootMembers.set(r, [i]);
    else bucket.push(i);
  }
  let maxDiameter = 0;
  // Iterate members deterministically by ascending index; the Map is only counted,
  // its diameters are max-reduced (order-independent).
  for (let i = 0; i < n; i++) {
    const members = rootMembers.get(i);
    if (members === undefined) continue;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const ca = creatures[members[a] as number] as Creature;
        const cb = creatures[members[b] as number] as Creature;
        const d = distance(ca.genome, cb.genome, t);
        if (d > maxDiameter) maxDiameter = d;
      }
    }
  }
  return { count: rootMembers.size, maxDiameter };
}

/**
 * `behaviorNovelty` (PROVISIONAL — the one spec-deferred metric). Subsampled mean
 * pairwise Jensen–Shannon divergence over per-creature action histograms (plan Task
 * 1.1): sample `min(pop, NOVELTY_SAMPLE)` creatures by ascending id, normalize each
 * `actionWindow` to a distribution over the 7 actions, and average pairwise JSD.
 * Normalized to [0,1] by dividing by `log(2)`. Identical histograms → 0 (regardless
 * of each one's own entropy — between-creature divergence is the right proxy, not
 * within-distribution spread). Uses `Math.log` — legal here (outside `tick()`).
 */
export function behaviorNovelty(world: World): number {
  const creatures = world.creatures;
  const n = creatures.length;
  if (n < 2) return 0;
  const sampleN = Math.min(n, world.config.tunables.NOVELTY_SAMPLE);

  // Deterministic ascending-id subsample.
  const byId = creatures.slice().sort((a, b) => a.id - b.id);
  const dists: Float64Array[] = new Array(sampleN);
  for (let s = 0; s < sampleN; s++) {
    dists[s] = normalizeHistogram((byId[s] as Creature).actionWindow);
  }

  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sampleN; i++) {
    for (let j = i + 1; j < sampleN; j++) {
      sum += jensenShannon(dists[i] as Float64Array, dists[j] as Float64Array);
      pairs++;
    }
  }
  if (pairs === 0) return 0;
  return sum / pairs / Math.LN2; // normalize JSD (natural-log) to [0,1]
}

/** Normalize a non-negative fire histogram to a probability distribution (uniform if empty). */
function normalizeHistogram(window: Float32Array): Float64Array {
  const k = window.length;
  const out = new Float64Array(k);
  let total = 0;
  for (let i = 0; i < k; i++) total += window[i] as number;
  if (total <= 0) {
    for (let i = 0; i < k; i++) out[i] = 1 / k; // no fires yet → uniform
    return out;
  }
  for (let i = 0; i < k; i++) out[i] = (window[i] as number) / total;
  return out;
}

/** Jensen–Shannon divergence (natural log) between two equal-length distributions. */
function jensenShannon(p: Float64Array, q: Float64Array): number {
  const k = p.length;
  let div = 0;
  for (let i = 0; i < k; i++) {
    const pi = p[i] as number;
    const qi = q[i] as number;
    const m = (pi + qi) / 2;
    if (pi > 0) div += 0.5 * pi * Math.log(pi / m);
    if (qi > 0) div += 0.5 * qi * Math.log(qi / m);
  }
  return div < 0 ? 0 : div;
}

/**
 * A slice of rolling history the population-window metrics read. The runner/sweep
 * pass the recent `population` series and the count of extinction events; kept a
 * plain interface so callers can build it from `world.history` or their own buffer.
 */
export interface HealthHistory {
  populationSeries: readonly number[];
  extinctionEvents: number;
}

/** Population mean over the window (0 if empty). */
function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i] as number;
  return s / xs.length;
}

/** Population variance over the window (0 if empty). */
function variance(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = (xs[i] as number) - m;
    s += d * d;
  }
  return s / xs.length;
}

/**
 * Assemble the full `WorldHealth` from the live world plus a `HealthHistory` window.
 * `survivalTicks` is the current tick (how far the world got); `meanPopulation`/
 * `populationVariance` come from the window; the rest from the live world.
 */
export function worldHealth(world: World, history: HealthHistory): WorldHealth {
  const species = speciesClusters(world);
  return {
    survivalTicks: world.tick,
    meanPopulation: mean(history.populationSeries),
    populationVariance: variance(history.populationSeries),
    traitVariance: traitVariance(world.creatures),
    speciesCount: species.count,
    maxDiameter: species.maxDiameter,
    extinctionEvents: history.extinctionEvents,
    behaviorNovelty: behaviorNovelty(world),
  };
}
