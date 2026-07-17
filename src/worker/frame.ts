/**
 * frame.ts — pure builders that turn a live `World` into the lean render `RenderFrame`
 * and the periodic `StatsPayload` (protocol.ts).
 *
 * Kept separate from `sim.worker.ts` so it is unit-testable in the Node/Vitest env
 * (a real Worker isn't). Reads the World; never mutates it. It may compute with
 * floats (`Math.log`, energy fractions) because it is OUTSIDE `tick()` — nothing
 * here is fed back into the deterministic selection path (AGENTS.md: metrics/render
 * may use floats; read-only).
 *
 * Every per-creature channel is an EXPRESSED scalar (mean of the diploid alleles),
 * matching the SPEC.md §Visual Design appearance table, so the palette is a pure
 * function of these arrays and no `Creature` object crosses the worker boundary.
 */

import { expressTrait, TRAIT_GENES, TRAIT_RANGE } from "@sim/genetics";
import { countExtinctionEvents, recentPopulationSeries } from "@sim/history";
import { type HealthHistory, worldHealth } from "@sim/stats";
import type { Config, Creature, World } from "@sim/types";
import type {
  CorpseFrame,
  CreatureFrame,
  PlantFrame,
  RenderFrame,
  StatsPayload,
  TraitBins,
} from "./protocol";

/** Histogram buckets per gene for the trait-distribution charts (display-only). */
export const TRAIT_BINS = 24;

/** maxEnergy = MAX_ENERGY_BASE + MAX_ENERGY_PER_SIZE·size (mirrors tick.ts `maxEnergy`). */
function maxEnergyOf(c: Creature, t: Config["tunables"]): number {
  return t.MAX_ENERGY_BASE + t.MAX_ENERGY_PER_SIZE * expressTrait(c.genome.size);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Day/night level in 0..1 from `tick % TICKS_PER_DAY`. The sim adds light only in
 * the first half of the day (tick.ts); this mirrors that as a smooth cosine so the
 * renderer's tint eases through dawn/dusk rather than snapping. Read-only, so the
 * cosine is fine here (never in `sim/`).
 */
export function dayLight(tick: number, ticksPerDay: number): number {
  const phase = ((tick % ticksPerDay) + ticksPerDay) % ticksPerDay;
  // Peak (1) at phase 0 (noon-ish), trough (0) at half-day (midnight).
  return 0.5 + 0.5 * Math.cos((phase / ticksPerDay) * 2 * Math.PI);
}

/**
 * Build the lean per-creature/plant/corpse frame. Iterates the creature list by
 * index (never a Set/Map) so ordering is stable. Allocates fresh typed arrays sized
 * to the current counts.
 */
export function buildRenderFrame(world: World): RenderFrame {
  const t = world.config.tunables;
  const cs = world.creatures;
  const n = cs.length;

  const creatures: CreatureFrame = {
    count: n,
    ids: new Int32Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    heading: new Float32Array(n),
    hue: new Float32Array(n),
    size: new Float32Array(n),
    energyFrac: new Float32Array(n),
    diet: new Float32Array(n),
    armor: new Float32Array(n),
    toxicity: new Float32Array(n),
    age: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const c = cs[i] as Creature;
    creatures.ids[i] = c.id;
    creatures.x[i] = c.x;
    creatures.y[i] = c.y;
    creatures.heading[i] = c.heading;
    creatures.hue[i] = expressTrait(c.genome.hue);
    creatures.size[i] = expressTrait(c.genome.size);
    creatures.energyFrac[i] = clamp01(c.energy / maxEnergyOf(c, t));
    creatures.diet[i] = expressTrait(c.genome.diet);
    creatures.armor[i] = expressTrait(c.genome.armor);
    creatures.toxicity[i] = expressTrait(c.genome.toxicity);
    creatures.age[i] = c.age;
  }

  const ps = world.plants;
  const pn = ps.length;
  const plants: PlantFrame = {
    count: pn,
    x: new Float32Array(pn),
    y: new Float32Array(pn),
    energyFrac: new Float32Array(pn),
    hue: new Float32Array(pn),
  };
  for (let i = 0; i < pn; i++) {
    const p = ps[i];
    if (p === undefined) continue;
    plants.x[i] = p.x;
    plants.y[i] = p.y;
    const maxE = Math.max(1, expressTrait(p.genome.maxSize));
    plants.energyFrac[i] = clamp01(p.energy / maxE);
    plants.hue[i] = expressTrait(p.genome.hue);
  }

  const xs = world.corpses;
  const xn = xs.length;
  // Normalize corpse vigor against the largest corpse this frame (display-only).
  let maxCorpseE = 1;
  for (let i = 0; i < xn; i++) {
    const e = xs[i]?.energy ?? 0;
    if (e > maxCorpseE) maxCorpseE = e;
  }
  const corpses: CorpseFrame = {
    count: xn,
    x: new Float32Array(xn),
    y: new Float32Array(xn),
    energyFrac: new Float32Array(xn),
  };
  for (let i = 0; i < xn; i++) {
    const x = xs[i];
    if (x === undefined) continue;
    corpses.x[i] = x.x;
    corpses.y[i] = x.y;
    corpses.energyFrac[i] = clamp01(x.energy / maxCorpseE);
  }

  return {
    tick: world.tick,
    worldWidth: world.config.worldWidth,
    worldHeight: world.config.worldHeight,
    light: dayLight(world.tick, t.TICKS_PER_DAY),
    creatures,
    plants,
    corpses,
  };
}

/**
 * The per-frame transferable ArrayBuffers, for a zero-copy `postMessage(frame,
 * [...transfers])`. Every typed array's `.buffer` is listed so the structured clone
 * moves rather than copies them (the frame is regenerated each tick, so donating
 * the buffers is safe).
 */
export function frameTransferables(frame: RenderFrame): ArrayBuffer[] {
  const { creatures: c, plants: p, corpses: x } = frame;
  return [
    c.ids.buffer,
    c.x.buffer,
    c.y.buffer,
    c.heading.buffer,
    c.hue.buffer,
    c.size.buffer,
    c.energyFrac.buffer,
    c.diet.buffer,
    c.armor.buffer,
    c.toxicity.buffer,
    c.age.buffer,
    p.x.buffer,
    p.y.buffer,
    p.energyFrac.buffer,
    p.hue.buffer,
    x.x.buffer,
    x.y.buffer,
    x.energyFrac.buffer,
  ] as ArrayBuffer[];
}

/**
 * Founder-lineage-root population counts. The map is CUMULATIVE and passed in by the
 * caller (the worker keeps it across ticks): a founder (`parentId === null`) is its
 * own root; any other creature's root is its parent's root. Because parents are
 * recorded before their children ever exist and the map is never pruned, a child's
 * root resolves even after its parent has died. Returns `{ root -> liveCount }` over
 * the currently-alive creatures only.
 */
export function populationByLineageRoot(
  world: World,
  rootOf: Map<number, number>,
): Record<number, number> {
  const cs = world.creatures;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i] as Creature;
    if (rootOf.has(c.id)) continue;
    if (c.parentId === null) {
      rootOf.set(c.id, c.id);
    } else {
      const parentRoot = rootOf.get(c.parentId);
      // Parent existed earlier, so it is mapped; fall back to self if somehow not.
      rootOf.set(c.id, parentRoot ?? c.id);
    }
  }
  const counts: Record<number, number> = {};
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i] as Creature;
    const root = rootOf.get(c.id) ?? c.id;
    counts[root] = (counts[root] ?? 0) + 1;
  }
  return counts;
}

/**
 * Per-gene expressed-value histogram over a FIXED legal-range domain (never the
 * per-frame observed min/max), so the charts have a stable, comparable domain. One
 * `TRAIT_BINS`-length count array per functional trait gene.
 */
export function buildTraitBins(world: World): TraitBins {
  const cs = world.creatures;
  const bins: TraitBins = {};
  for (let g = 0; g < TRAIT_GENES.length; g++) {
    const gene = TRAIT_GENES[g];
    if (gene === undefined) continue;
    const [lo, hi] = TRAIT_RANGE[gene];
    const range = hi - lo;
    const counts = new Array<number>(TRAIT_BINS).fill(0);
    for (let i = 0; i < cs.length; i++) {
      const v = expressTrait((cs[i] as Creature).genome[gene]);
      let idx = range > 0 ? Math.floor(((v - lo) / range) * TRAIT_BINS) : 0;
      if (idx < 0) idx = 0;
      if (idx >= TRAIT_BINS) idx = TRAIT_BINS - 1;
      counts[idx] = (counts[idx] as number) + 1;
    }
    bins[gene] = counts;
  }
  return bins;
}

/** Assemble the periodic `StatsPayload` (world-health + lineage populations + bins). */
export function buildStats(world: World, rootOf: Map<number, number>): StatsPayload {
  const history: HealthHistory = {
    populationSeries: recentPopulationSeries(world),
    extinctionEvents: countExtinctionEvents(world),
  };
  const h = worldHealth(world, history);
  return {
    tick: world.tick,
    survivalTicks: h.survivalTicks,
    meanPopulation: h.meanPopulation,
    populationVariance: h.populationVariance,
    traitVariance: h.traitVariance,
    speciesCount: h.speciesCount,
    extinctionEvents: h.extinctionEvents,
    behaviorNovelty: h.behaviorNovelty,
    population: populationByLineageRoot(world, rootOf),
    traits: buildTraitBins(world),
  };
}
