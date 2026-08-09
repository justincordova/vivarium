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
import { rankScore } from "@sim/score";
import { type HealthHistory, worldHealth } from "@sim/stats";
import type { Config, Creature, LineageEvent, World } from "@sim/types";
import type {
  CorpseFrame,
  CreatureFrame,
  FlashFrame,
  PlantFrame,
  RenderFrame,
  StatsPayload,
  TimelinePayload,
  TraitBins,
  WorldEvent,
} from "./protocol";
import { FLASH_TICKS } from "./protocol";

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
  // `config.tunables` is caller-controlled: `parseHash` accepts any FINITE `t.KEY=value`
  // from a share URL — including 0 — and the poisoned config is autosaved, so it persists.
  // `tick % 0` is NaN, and NaN light survives every clamp downstream (all NaN comparisons
  // are false), reaching `drawDayNight` where an `rgba(...,NaN)` fill string is invalid and
  // therefore IGNORED by the canvas — leaving the previous fillStyle set and painting the
  // entire viewport opaque. The world simply vanishes, with no error. Fall back to full
  // daylight rather than emitting a value that cannot be rendered.
  if (!Number.isFinite(ticksPerDay) || ticksPerDay <= 0) return 1;
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
    speed: new Float32Array(n),
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
    creatures.speed[i] = expressTrait(c.genome.speed);
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

  // Water field, normalized 0..1 per cell against the field's OWN current max, for the
  // renderer's water shading (so drought/flood dips/spikes read as gaps/brightening on
  // top of the authored water biome). Read-only; floats are fine outside tick().
  const cells = world.fields.water.length;
  const water = new Float32Array(cells);
  let waterMax = 1;
  for (let i = 0; i < cells; i++) {
    const w = world.fields.water[i] as number;
    if (w > waterMax) waterMax = w;
  }
  for (let i = 0; i < cells; i++) {
    water[i] = clamp01((world.fields.water[i] as number) / waterMax);
  }

  // Authored biome per cell (copied so the frame owns its buffer for transfer).
  const biome = new Uint8Array(world.terrain.biome);

  // Nests (Society) — struct-of-arrays with a stable per-lineage hue (hashed from the
  // root id so a lineage's homes read as one color without scanning creatures).
  const nn = world.nests.length;
  const nests = {
    count: nn,
    x: new Float32Array(nn),
    y: new Float32Array(nn),
    strengthFrac: new Float32Array(nn),
    hue: new Float32Array(nn),
  };
  const nestMax = t.NEST_MAX_STRENGTH > 0 ? t.NEST_MAX_STRENGTH : 1;
  for (let i = 0; i < nn; i++) {
    const n = world.nests[i];
    if (n === undefined) continue;
    nests.x[i] = n.x;
    nests.y[i] = n.y;
    nests.strengthFrac[i] = clamp01(n.strength / nestMax);
    nests.hue[i] = lineageHue(n.lineage);
  }

  return {
    tick: world.tick,
    worldWidth: world.config.worldWidth,
    worldHeight: world.config.worldHeight,
    gridCols: world.config.gridCols,
    gridRows: world.config.gridRows,
    light: dayLight(world.tick, t.TICKS_PER_DAY),
    water,
    biome,
    creatures,
    plants,
    corpses,
    nests,
    flashes: buildFlashes(world),
  };
}

/** Hard ceiling on marks per frame, so a mass-death tick cannot stall the renderer. */
const MAX_FLASHES = 64;

/**
 * Collect births/kills from the last `FLASH_TICKS` ticks so the renderer can mark them.
 *
 * Scans `world.eventLog` **backwards** and stops at the cutoff: the log is tick-ordered
 * and bounded, so this is O(recent events), not O(ring). Entries predating the position
 * suffix (`kill:<id>` with no coordinates) are skipped rather than drawn at the origin —
 * a mark in the wrong place is worse than no mark.
 */
export function buildFlashes(world: World): FlashFrame {
  const cutoff = world.tick - FLASH_TICKS;
  const xs: number[] = [];
  const ys: number[] = [];
  const ages: number[] = [];
  const kinds: number[] = [];

  for (let i = world.eventLog.length - 1; i >= 0 && xs.length < MAX_FLASHES; i--) {
    const e = world.eventLog[i] as { tick: number; event: string };
    if (e.tick < cutoff) break;
    const isKill = e.event.startsWith("kill:");
    if (!isKill && !e.event.startsWith("birth:")) continue;
    const parts = e.event.split(":");
    const x = Number(parts[2]);
    const y = Number(parts[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue; // pre-position saved entry
    xs.push(x);
    ys.push(y);
    ages.push(world.tick - e.tick);
    kinds.push(isKill ? 1 : 0);
  }

  return {
    count: xs.length,
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    age: Float32Array.from(ages),
    kind: Uint8Array.from(kinds),
  };
}

/** Stable display hue (0..360) for a lineage root id — a cheap integer hash, display-only. */
function lineageHue(lineage: number): number {
  // Mix the bits so adjacent ids get distinct hues; purely cosmetic (outside tick()).
  const h = Math.imul(lineage ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return (h % 360000) / 1000;
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
    c.speed.buffer,
    p.x.buffer,
    p.y.buffer,
    p.energyFrac.buffer,
    p.hue.buffer,
    x.x.buffer,
    x.y.buffer,
    x.energyFrac.buffer,
    frame.water.buffer,
    frame.biome.buffer,
    frame.nests.x.buffer,
    frame.nests.y.buffer,
    frame.nests.strengthFrac.buffer,
    frame.nests.hue.buffer,
    frame.flashes.x.buffer,
    frame.flashes.y.buffer,
    frame.flashes.age.buffer,
    frame.flashes.kind.buffer,
  ] as ArrayBuffer[];
}

/**
 * Founder-lineage-root population counts over the currently-alive creatures. Reads the
 * single source of truth — `world.lineageRoots` (Phase 5A.3), the serialized cumulative
 * id→root map populated at founder construction + birth in `sim/`. Returns
 * `{ root -> liveCount }`.
 */
export function populationByLineageRoot(world: World): Record<number, number> {
  const cs = world.creatures;
  const counts: Record<number, number> = {};
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i] as Creature;
    const root = world.lineageRoots[c.id] ?? c.id;
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

/**
 * The whole-run timeline overview (Phase 5B.1): the downsampled population history +
 * extinction-event ticks. Reads `world.history` (already bounded/downsampled) and the
 * `extinct` entries in the event log. Pure read.
 */
export function buildTimeline(world: World): TimelinePayload {
  const points = world.history.map((h) => ({ tick: h.tick, population: h.population }));
  const extinctionTicks: number[] = [];
  for (let i = 0; i < world.eventLog.length; i++) {
    const e = world.eventLog[i] as { tick: number; event: string };
    if (e.event === "extinct") extinctionTicks.push(e.tick);
  }
  return { points, extinctionTicks, now: world.tick };
}

/** How many narratable events the feed carries. Small: this is a story, not a log. */
export const MAX_FEED_EVENTS = 40;

/**
 * A lineage founding another home within this many ticks of its last reported one is the
 * same story, not a new one. Tuned to roughly a day (`TICKS_PER_DAY` = 1000).
 */
const HOME_COALESCE_TICKS = 1_000;

/** Biome enum → the noun the narrator uses for a place. Index is the `Biome` value. */
const BIOME_NOUN = ["shallows", "grassland", "forest", "flats", "highlands"] as const;

/**
 * Name a world position in plain language — a vertical band plus the biome noun at that
 * cell ("the northern forest"). Deliberately coarse: it exists so a player can *look*
 * there, not to be a coordinate. Reads terrain only (immutable during ticks), so it is a
 * pure function of the snapshot.
 */
function placeName(world: World, x: number, y: number): string {
  const { worldWidth: ww, worldHeight: wh, gridCols: cols, gridRows: rows } = world.config;
  const col = Math.min(cols - 1, Math.max(0, Math.floor((x / ww) * cols)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor((y / wh) * rows)));
  const biome = world.terrain.biome[row * cols + col] ?? 1;
  const noun = BIOME_NOUN[biome] ?? "wilds";
  const band = y < wh / 3 ? "northern " : y > (wh * 2) / 3 ? "southern " : "";
  return `the ${band}${noun}`;
}

/**
 * Build the plain-language event feed: the *notable* subset of what happened, resolved
 * into hue + place so the UI can phrase it without reaching back into the World.
 *
 * Two sources are merged and re-sorted by tick:
 *   - `world.lineageEvents` — the typed drama (extinction / boom / dominance), already
 *     detected deterministically on the history cadence.
 *   - `world.eventLog` — scanned for the two entries worth telling a player about:
 *     `extinct` (the whole world fell silent) and `nest:<root>[:x:y]` (a home appeared).
 *     Births and kills are skipped on purpose; they fire nearly every tick and would
 *     bury the signal.
 *
 * Both logs are bounded rings in `sim/`, so this scan is O(bounded) and safe to redo on
 * every stats tick. The result is truncated to the most recent `MAX_FEED_EVENTS`, which
 * makes the payload self-contained — the UI renders the latest list verbatim and needs
 * no accumulation or dedupe of its own.
 *
 * **Home events are coalesced per lineage** (`HOME_COALESCE_TICKS`). A thriving lineage
 * founds homes in bursts, so without this the feed degenerates into a page of "the green
 * bloodline built a home in the northern grassland" — and, worse, those repeats evict the
 * genuinely rare drama (booms, extinctions, dominance shifts) from a fixed-size feed.
 * Keeping the first of each burst preserves the news and drops the echo.
 */
export function buildEventFeed(world: World): WorldEvent[] {
  const out: WorldEvent[] = [];
  /** Last reported home tick per lineage, for burst coalescing (see the doc comment). */
  const lastHomeTick = new Map<number, number>();

  for (let i = 0; i < world.lineageEvents.length; i++) {
    const e = world.lineageEvents[i] as LineageEvent;
    const kind = e.kind === "lineageBoom" ? "boom" : e.kind === "newDominant" ? "dominant" : e.kind;
    out.push({
      key: `${kind}:${e.tick}:${e.lineage}`,
      tick: e.tick,
      kind,
      lineage: e.lineage,
      hue: lineageHue(e.lineage),
      factor: e.kind === "lineageBoom" ? e.factor : 0,
      place: "",
    });
  }

  for (let i = 0; i < world.eventLog.length; i++) {
    const e = world.eventLog[i] as { tick: number; event: string };
    if (e.event === "extinct") {
      out.push({
        key: `silence:${e.tick}:-1`,
        tick: e.tick,
        kind: "silence",
        lineage: -1,
        hue: -1,
        factor: 0,
        place: "",
      });
      continue;
    }
    if (!e.event.startsWith("nest:")) continue;
    // `nest:<root>` (older saved logs) or `nest:<root>:<x>:<y>` (current). Tolerate both:
    // `eventLog` is serialized, so a loaded world can still hold the 2-field form.
    const parts = e.event.split(":");
    const root = Number(parts[1]);
    if (!Number.isFinite(root)) continue;
    // Coalesce a lineage's burst of home-founding into its first report. The log is
    // tick-ordered, so the last kept tick per lineage is all the state this needs.
    const lastKept = lastHomeTick.get(root);
    if (lastKept !== undefined && e.tick - lastKept < HOME_COALESCE_TICKS) continue;
    lastHomeTick.set(root, e.tick);
    const x = Number(parts[2]);
    const y = Number(parts[3]);
    const sited = Number.isFinite(x) && Number.isFinite(y);
    out.push({
      key: `home:${e.tick}:${root}`,
      tick: e.tick,
      kind: "home",
      lineage: root,
      hue: lineageHue(root),
      factor: 0,
      place: sited ? placeName(world, x, y) : "",
    });
  }

  // Stable order: by tick, then by key so a same-tick pair never swaps between digests
  // (the feed is rebuilt from scratch each time; a wobbling order would flicker the UI).
  out.sort((a, b) => (a.tick !== b.tick ? a.tick - b.tick : a.key < b.key ? -1 : 1));
  return out.length > MAX_FEED_EVENTS ? out.slice(out.length - MAX_FEED_EVENTS) : out;
}

/** Assemble the periodic `StatsPayload` (world-health + lineage populations + bins). */
export function buildStats(world: World): StatsPayload {
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
    population: populationByLineageRoot(world),
    traits: buildTraitBins(world),
    timeline: buildTimeline(world),
    events: buildEventFeed(world),
    influence: world.influence,
    // `survivalTicks` as the horizon: the world has, by definition, survived to now, so
    // this asks "is what you have right now interesting" rather than grading against a
    // fixed finish line the player has not reached yet.
    score: rankScore(h, h.survivalTicks),
  };
}
