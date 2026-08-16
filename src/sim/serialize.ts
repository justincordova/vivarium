/**
 * serialize.ts — pure, versioned save/load with a forward-migration scaffold.
 *
 * SPEC.md §Persistence requires `version: 1` from the first write, a self-describing
 * save, and that a `version: N` reader can load a `version: <N` blob (every field
 * optional/defaulted). The roundtrip test also double-checks determinism.
 *
 * **Serialized per creature** (dropping any of these breaks the roundtrip/
 * determinism gates): `parentId`, the diploid brain arrays, the recurrent `hidden`
 * vector, and `ruleState`. **Not serialized**: the derived brain cache (a pure
 * function of the homologs — re-derived on load).
 *
 * Pure — no DOM/IndexedDB (those are worker/Phase 5 concerns). Part of `sim/`.
 */

import { makeDefaultConfig } from "./config";
import { ACTIONS, ARROWS, INFLUENCE_MAX } from "./constants";
import { deserializeRng, serializeRng } from "./rng";
import {
  Biome,
  type Config,
  type Corpse,
  type Creature,
  type Fields,
  type Genome,
  type Nest,
  type Plant,
  type PlantGenome,
  type RngBundle,
  type Terrain,
  type Tunables,
  type World,
} from "./types";

/**
 * v1 → v2 (Phase 4): the active brain became config-selectable (`config.brainKind`).
 * A v1 blob predates the field; the v1→v2 migration defaults it to `'rule'` (the only
 * brain that existed at v1), so an old rule-based save loads and keeps running the
 * rule policy. The `hidden` vector was already serialized at v1, so no per-creature
 * migration is needed — an inherited-but-never-exercised brain simply starts computing
 * once `brainKind` is switched to `'patchbay'`.
 */
/**
 * v2 → v3 (Phase 5A.3): typed lineage events + stable lineage identity became
 * serialized runtime state (`lineageRoots`, `lineageEvents`, `dominant`,
 * `rootPopSnapshots`). A v2 blob predates them; the v2→v3 migration defaults them
 * (empty map/arrays, null dominant) — the world loads and starts lineage tracking from
 * reload. No historical events are fabricated (we cannot invent a past we did not
 * record); the report only narrates events fired from here forward.
 */
export const SAVE_VERSION = 6;

/** The serialized snapshot shape (all JSON-able; typed arrays become number[]). */
export interface SaveBlob {
  version: number;
  config: Config;
  tick: number;
  solarReservoir: number;
  nextId: number;
  rng: Record<string, number>;
  creatures: SerCreature[];
  plants: SerPlant[];
  corpses: Corpse[];
  fields: SerFields;
  eventLog: { tick: number; event: string }[];
  history: World["history"];
  /** Phase 5A.3 (v3): serialized lineage identity + typed events + detection state. */
  lineageRoots?: Record<number, number>;
  lineageEvents?: World["lineageEvents"];
  dominant?: World["dominant"];
  rootPopSnapshots?: World["rootPopSnapshots"];
  /** Living World (v4): authored terrain (biome + elevation per cell). */
  terrain?: { biome: number[]; elevation: number[] };
  /** Society (v5): nests (emergent homes). Absent in a pre-v5 blob. */
  nests?: Nest[];
  lastSavedRealTime: number;
  /** Terrarium stewardship budget (v6). Optional: a pre-v6 blob loads with a full one. */
  influence?: number;
}

interface SerCreature {
  id: number;
  parentId: number | null;
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  energy: number;
  hydration: number;
  health: number;
  age: number;
  genome: SerGenome;
  hidden: number[];
  ruleState: Creature["ruleState"];
  /** behaviorNovelty trailing action-fire histogram (length ACTIONS). */
  actionWindow: number[];
}

interface SerGenome {
  weightsA: number[];
  weightsB: number[];
  enabledA: number[];
  enabledB: number[];
  traits: Record<string, [number, number]>;
  hue: [number, number];
}

interface SerPlant {
  id: number;
  parentId: number | null;
  x: number;
  y: number;
  energy: number;
  age: number;
  genome: Record<string, [number, number]>;
}

interface SerFields {
  light: number[];
  fertility: number[];
  water: number[];
  temperature: number[];
  scent: number[];
}

const TRAIT_KEYS = [
  "size",
  "speed",
  "senseRadius",
  "metabolism",
  "aggression",
  "diet",
  "circadian",
  "nightVision",
  "armor",
  "toxicity",
  "offspringInvestment",
  "matingThreshold",
  "maxLifespan",
  "digestionEfficiency",
  "sociality",
] as const;

const PLANT_TRAIT_KEYS = [
  "maxSize",
  "height",
  "dispersal",
  "toughness",
  "seedInvestment",
  "maxAge",
] as const;

// ── serialize ────────────────────────────────────────────────────────────────

function serGenome(g: Genome): SerGenome {
  const traits: Record<string, [number, number]> = {};
  for (const k of TRAIT_KEYS) traits[k] = [g[k][0], g[k][1]];
  return {
    weightsA: Array.from(g.weightsA),
    weightsB: Array.from(g.weightsB),
    enabledA: Array.from(g.enabledA),
    enabledB: Array.from(g.enabledB),
    traits,
    hue: [g.hue[0], g.hue[1]],
  };
}

function serPlantGenome(g: PlantGenome): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const k of PLANT_TRAIT_KEYS) out[k] = [g[k][0], g[k][1]];
  out.hue = [g.hue[0], g.hue[1]];
  return out;
}

export function serialize(world: World): SaveBlob {
  return {
    version: SAVE_VERSION,
    config: world.config,
    tick: world.tick,
    solarReservoir: world.solarReservoir,
    nextId: world.nextId,
    rng: serializeRng(world.rng),
    creatures: world.creatures.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      x: c.x,
      y: c.y,
      heading: c.heading,
      vx: c.vx,
      vy: c.vy,
      energy: c.energy,
      hydration: c.hydration,
      health: c.health,
      age: c.age,
      genome: serGenome(c.genome),
      hidden: Array.from(c.hidden),
      ruleState: { ...c.ruleState },
      actionWindow: Array.from(c.actionWindow),
    })),
    plants: world.plants.map((p) => ({
      id: p.id,
      parentId: p.parentId,
      x: p.x,
      y: p.y,
      energy: p.energy,
      age: p.age,
      genome: serPlantGenome(p.genome),
    })),
    corpses: world.corpses.map((co) => ({ ...co })),
    nests: world.nests.map((n) => ({ ...n })),
    fields: {
      light: Array.from(world.fields.light),
      fertility: Array.from(world.fields.fertility),
      water: Array.from(world.fields.water),
      temperature: Array.from(world.fields.temperature),
      scent: Array.from(world.fields.scent),
    },
    eventLog: world.eventLog.map((e) => ({ ...e })),
    history: world.history.map((h) => ({ ...h })),
    lineageRoots: { ...world.lineageRoots },
    lineageEvents: world.lineageEvents.map((e) => ({ ...e })),
    dominant: world.dominant === null ? null : { ...world.dominant },
    rootPopSnapshots: world.rootPopSnapshots.map((s) => ({
      tick: s.tick,
      counts: { ...s.counts },
    })),
    terrain: {
      biome: Array.from(world.terrain.biome),
      elevation: Array.from(world.terrain.elevation),
    },
    lastSavedRealTime: world.lastSavedRealTime,
    influence: world.influence,
  };
}

// ── deserialize (with defaulting so a partial/older blob still loads) ─────────

function deGenome(s: SerGenome): Genome {
  // Society (v5) brain-geometry re-seed: a pre-v5 genome's brain arrays are the wrong
  // length (SENSORS/ACTIONS changed → ARROWS 380 → 420). We CANNOT migrate the weights
  // arrow-for-arrow (the documented breaking geometry change). Rebuild an inert brain of
  // the correct length — zero weights, all arrows disabled — RNG-free so the load path
  // stays deterministic and serialize.ts avoids importing world.ts (no import cycle).
  // Trait alleles are preserved; only brain wiring is reset. A creature loaded inert
  // re-evolves from a blank slate. The shipped cold-open is regenerated fresh, so only
  // hand-carried pre-v5 personal saves ever load inert (accepted major-version cost).
  const geometryMatches = (s.weightsA ?? []).length === ARROWS;
  const g = {
    weightsA: geometryMatches ? Float32Array.from(s.weightsA ?? []) : new Float32Array(ARROWS),
    weightsB: geometryMatches ? Float32Array.from(s.weightsB ?? []) : new Float32Array(ARROWS),
    enabledA: geometryMatches ? Uint8Array.from(s.enabledA ?? []) : new Uint8Array(ARROWS),
    enabledB: geometryMatches ? Uint8Array.from(s.enabledB ?? []) : new Uint8Array(ARROWS),
  } as Genome;
  const traits = s.traits ?? {};
  for (const k of TRAIT_KEYS) {
    // `sociality` (v5) is absent from a pre-v5 blob → default to the neutral midpoint
    // (0.5,0.5) rather than (0,0), so migrated creatures load solitary-neutral, not
    // maximally solitary. All pre-v5 traits are present and round-trip unchanged.
    const fallback: [number, number] = k === "sociality" ? [0.5, 0.5] : [0, 0];
    const pair = traits[k] ?? fallback;
    g[k] = [pair[0], pair[1]];
  }
  const hue = s.hue ?? [0, 0];
  g.hue = [hue[0], hue[1]];
  return g;
}

function dePlantGenome(s: Record<string, [number, number]>): PlantGenome {
  const g = {} as PlantGenome;
  for (const k of PLANT_TRAIT_KEYS) {
    const pair = s[k] ?? [0, 0];
    g[k] = [pair[0], pair[1]];
  }
  const hue = s.hue ?? [0, 0];
  g.hue = [hue[0], hue[1]];
  return g;
}

function deFields(s: SerFields): Fields {
  return {
    light: Int32Array.from(s.light ?? []),
    fertility: Int32Array.from(s.fertility ?? []),
    water: Int32Array.from(s.water ?? []),
    temperature: Float32Array.from(s.temperature ?? []),
    scent: Float32Array.from(s.scent ?? []),
  };
}

/**
 * Rebuild the terrain arrays from a blob. A v3-or-older blob (no `terrain`) defaults to
 * a flat, all-Grassland terrain sized to the config grid — matching today's uniform
 * behavior, so an old world loads visually stable (NOT re-generated from seed).
 */
function deTerrain(blob: SaveBlob): Terrain {
  const cells = (blob.config?.gridCols ?? 0) * (blob.config?.gridRows ?? 0);
  // Only trust a blob's terrain arrays if they exactly cover the config grid. A
  // mismatched length (a hand-edited save, or one from a different grid resolution whose
  // config was patched but whose terrain wasn't) would make `terrain.biome[i]` read past
  // the end → undefined → NaN/0 (Water) biome multipliers, silently corrupting
  // biome-dependent dynamics while the rest of the world runs at the configured
  // resolution. Fall back to the flat-grassland default on any mismatch.
  if (
    blob.terrain !== undefined &&
    (blob.terrain.biome ?? []).length === cells &&
    (blob.terrain.elevation ?? []).length === cells
  ) {
    return {
      biome: Uint8Array.from(blob.terrain.biome ?? []),
      elevation: Float32Array.from(blob.terrain.elevation ?? []),
    };
  }
  const biome = new Uint8Array(cells).fill(Biome.Grassland);
  const elevation = new Float32Array(cells); // flat
  return { biome, elevation };
}

/** v3 → v4: terrain became world state; an older blob defaults to flat grassland. */
function migrateV3toV4(b: SaveBlob): SaveBlob {
  // `deTerrain` handles the absent-terrain default at load; here we only bump the
  // version and (for round-trip stability) leave `terrain` undefined so the loader
  // fills the default.
  return { ...b, version: 4 };
}

/**
 * v4 → v5 (Society): nests + the `sociality` gene became world/genome state, and the
 * brain geometry changed (SENSORS 21→24, ACTIONS 7→8, ARROWS 380→420). `deserialize`
 * handles the loads: absent `nests` → `[]`, absent `sociality` → neutral (0.5,0.5)
 * default (`deGenome`), and a 380-length brain re-seeds inert at 420 (`deGenome`). Here
 * we only bump the version; the loaders fill the defaults.
 */
function migrateV4toV5(b: SaveBlob): SaveBlob {
  return { ...b, version: 5 };
}

/**
 * v5 → v6 (Terrarium): `influence`, the stewardship budget, became world state. An older
 * world has never spent any, so it loads with a full budget — `deserialize` supplies that
 * default; here we only bump the version.
 */
function migrateV5toV6(b: SaveBlob): SaveBlob {
  return { ...b, version: 6 };
}

/** v1 → v2: default `config.brainKind` to `'rule'` if the blob predates the field. */
function migrateV1toV2(b: SaveBlob): SaveBlob {
  const config = { ...b.config, brainKind: b.config?.brainKind ?? "rule" };
  return { ...b, config, version: 2 };
}

/** v2 → v3: default the Phase-5A.3 lineage fields (start tracking from reload). */
function migrateV2toV3(b: SaveBlob): SaveBlob {
  return {
    ...b,
    lineageRoots: b.lineageRoots ?? {},
    lineageEvents: b.lineageEvents ?? [],
    dominant: b.dominant ?? null,
    rootPopSnapshots: b.rootPopSnapshots ?? [],
    version: 3,
  };
}

/** Forward-migration scaffold. Each `migrate_vN_to_vN1` upgrades in place. */
function migrate(blob: SaveBlob): SaveBlob {
  let b = blob;
  // A blob with no version predates versioning entirely — treat as v1.
  if (b.version === undefined) b = { ...b, version: 1 };
  if (b.version < 2) b = migrateV1toV2(b);
  if (b.version < 3) b = migrateV2toV3(b);
  if (b.version < 4) b = migrateV3toV4(b);
  if (b.version < 5) b = migrateV4toV5(b);
  if (b.version < 6) b = migrateV5toV6(b);
  return b;
}

/**
 * Restore the `behaviorNovelty` fire histogram at the CURRENT `ACTIONS` width.
 *
 * A pre-v5 blob was written when `ACTIONS` was 7 — v4→v5 (Society) widened it to 8 for the
 * nest action. `Float32Array.from` alone would restore a 7-slot window on such a blob, and
 * nothing else normalizes it, so the migrated cohort would carry the wrong width for the
 * rest of its life: `updateActionWindow`'s write to `w[Action.Nest]` is index 7 and would
 * be silently discarded as an out-of-bounds typed-array store (nesting invisible to the
 * metric), and `normalizeHistogram` would build a 7-bin distribution whose empty-window
 * uniform is 1/7 against 1/8 for every creature born after the load — so `jensenShannon`
 * would report a nonzero divergence between two creatures that have fired nothing at all.
 *
 * Copy whatever was saved into a correctly-sized window; a wider future blob truncates
 * rather than overflowing.
 */
function deActionWindow(saved: number[] | undefined): Float32Array {
  const w = new Float32Array(ACTIONS);
  if (saved !== undefined) w.set(saved.slice(0, ACTIONS));
  return w;
}

/**
 * Fill in tunables the blob predates, and reject non-finite ones.
 *
 * The per-version `migrateVNtoVN1` steps cannot carry this: a tunable is routinely added
 * WITHOUT a `SAVE_VERSION` bump (nothing about the blob's shape changed), so there is no
 * version boundary to hang the default on — a `version: 5` blob written before
 * `ATTACK_DAMAGE_COEF` existed is indistinguishable from one written after. `Tunables`
 * requires every key, so an absent one is always a stale-blob artifact, never a choice.
 *
 * Left unfilled it does not throw: `undefined` flows into arithmetic as `NaN`, and `NaN`
 * silently destroys ledger quanta (a `NaN` cell index makes the typed-array credit a
 * no-op while the debit still lands), breaking the closed-ledger invariant on a world the
 * autosaver then writes back over the rotation.
 *
 * Iterate the DEFAULTS keys, never the blob's — that pins insertion order to a fixed set
 * regardless of what an imported file contains, and drops unknown keys. The finiteness
 * check also guards the untrusted-import path, where a hand-edited `.viv` can carry a
 * string or null where a number belongs.
 *
 * Two tunables (`TRAIT_MUT_SIGMA`, `PLANT_MUT_SIGMA`) are nested per-gene tables rather
 * than numbers, and they get the same treatment one level down. Taking the default table
 * wholesale instead would quietly reset a saved world's mutation sigmas on every load.
 */
function reconcileTunables(loaded: Tunables | undefined): Tunables {
  const defaults = makeDefaultConfig().tunables;
  const out: Tunables = { ...defaults };
  // `Tunables` is a fixed 88-key interface with no index signature; one narrow view lets
  // us assign by string key without weakening the return type.
  const view = out as unknown as Record<string, unknown>;
  const src = (loaded ?? {}) as Record<string, unknown>;
  const base = defaults as unknown as Record<string, unknown>;
  for (const key of Object.keys(defaults)) {
    const def = base[key];
    const v = src[key];
    if (typeof def === "object" && def !== null) {
      const table: Record<string, number> = { ...(def as Record<string, number>) };
      const savedTable = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
      for (const gene of Object.keys(table)) {
        const g = savedTable[gene];
        if (typeof g === "number" && Number.isFinite(g)) table[gene] = g;
      }
      view[key] = table;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      view[key] = v;
    }
  }
  return out;
}

export function deserialize(data: SaveBlob): World {
  const blob = migrate(data);
  // Deep-copy `config` so two `deserialize` calls on one blob never alias it. Nested
  // `tunables` is mutated in place by god-powers (worker `setParam`), so a shared
  // reference would cross-corrupt two worlds loaded from the same blob — the same
  // class of aliasing bug the `ruleState` spread-copy below guards against.
  const config = structuredClone(blob.config);
  config.tunables = reconcileTunables(config.tunables);
  const hidden = config.hidden;

  const creatures: Creature[] = (blob.creatures ?? []).map((c) => ({
    id: c.id,
    parentId: c.parentId ?? null,
    x: c.x,
    y: c.y,
    heading: c.heading,
    vx: c.vx,
    vy: c.vy,
    energy: c.energy,
    hydration: c.hydration,
    health: c.health,
    age: c.age,
    genome: deGenome(c.genome),
    // hidden is serialized runtime state; default to a zero vector if absent.
    hidden: c.hidden !== undefined ? Float32Array.from(c.hidden) : new Float32Array(hidden),
    // Spread-copy so two `deserialize` calls on the same blob never ALIAS the same
    // mutable `ruleState` object — ticking mutates it (hysteresis/mode/target), so a
    // shared reference would cross-corrupt two worlds loaded from one blob.
    ruleState: c.ruleState
      ? { ...c.ruleState }
      : {
          mode: "wander",
          targetId: -1,
          targetKind: "none",
          committedTicks: 0,
        },
    // Serialized behaviorNovelty accumulator; default to a zero histogram if a
    // pre-Phase-1 blob lacks it (optional/defaulted → no migration needed).
    actionWindow: deActionWindow(c.actionWindow),
    // derived cache intentionally NOT restored — re-derived on first use.
  }));

  const plants: Plant[] = (blob.plants ?? []).map((p) => ({
    id: p.id,
    parentId: p.parentId ?? null,
    x: p.x,
    y: p.y,
    energy: p.energy,
    age: p.age,
    genome: dePlantGenome(p.genome),
  }));

  const corpses: Corpse[] = (blob.corpses ?? []).map((co) => ({ ...co }));
  // Nests (Society, Phase 7A). Absent in a pre-v5 blob → empty (migrateV4toV5 default).
  const nests: Nest[] = (blob.nests ?? []).map((n) => ({ ...n }));
  // Reconcile `nextId` against every loaded entity id. A corrupt/hand-edited blob (or one
  // missing the field → default 0) whose `nextId` is ≤ an existing entity id would make
  // the next birth/seed/corpse/nest reuse a LIVE id — colliding in `lineageRoots`,
  // corrupting `parentId`-based lineage resolution (`registerLineage` reads the parent's
  // root by id), and breaking the spatial hash's ascending-id tie-break (no longer a
  // total order). Trust the blob's value only if it already pasts every existing id;
  // otherwise advance it. A no-op for any well-formed save.
  let nextId = blob.nextId ?? 0;
  for (let i = 0; i < creatures.length; i++) {
    const id = (creatures[i] as Creature).id;
    if (id >= nextId) nextId = id + 1;
  }
  for (let i = 0; i < plants.length; i++) {
    const id = (plants[i] as Plant).id;
    if (id >= nextId) nextId = id + 1;
  }
  for (let i = 0; i < corpses.length; i++) {
    const id = (corpses[i] as Corpse).id;
    if (id >= nextId) nextId = id + 1;
  }
  for (let i = 0; i < nests.length; i++) {
    const id = (nests[i] as Nest).id;
    if (id >= nextId) nextId = id + 1;
  }
  const rng: RngBundle = deserializeRng(blob.rng ?? {});

  return {
    config,
    tick: blob.tick ?? 0,
    solarReservoir: blob.solarReservoir ?? 0,
    creatures,
    plants,
    corpses,
    nests,
    creatureIds: creatures.map((c) => c.id),
    nextId,
    fields: deFields(blob.fields),
    terrain: deTerrain(blob),
    rng,
    eventLog: (blob.eventLog ?? []).map((e) => ({ ...e })),
    history: (blob.history ?? []).map((h) => ({ ...h })),
    // Phase 5A.3 lineage state (migration defaults these for a v2 blob).
    lineageRoots: { ...(blob.lineageRoots ?? {}) },
    lineageEvents: (blob.lineageEvents ?? []).map((e) => ({ ...e })),
    // Spread-copy (not a bare reference) to keep the "two loads never share mutable
    // state" invariant uniform, independent of whether a downstream mutates in place.
    dominant: blob.dominant ? { ...blob.dominant } : null,
    rootPopSnapshots: (blob.rootPopSnapshots ?? []).map((s) => ({
      tick: s.tick,
      counts: { ...s.counts },
    })),
    lastSavedRealTime: blob.lastSavedRealTime ?? 0,
    // Absent in a pre-v6 blob → a full budget (migrateV5toV6 only bumps the version).
    influence: blob.influence ?? INFLUENCE_MAX,
  };
}
