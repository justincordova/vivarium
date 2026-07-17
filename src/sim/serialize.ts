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

import { ACTIONS } from "./constants";
import { deserializeRng, serializeRng } from "./rng";
import type {
  Config,
  Corpse,
  Creature,
  Fields,
  Genome,
  Plant,
  PlantGenome,
  RngBundle,
  World,
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
export const SAVE_VERSION = 3;

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
  lastSavedRealTime: number;
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
    lastSavedRealTime: world.lastSavedRealTime,
  };
}

// ── deserialize (with defaulting so a partial/older blob still loads) ─────────

function deGenome(s: SerGenome): Genome {
  const g = {
    weightsA: Float32Array.from(s.weightsA ?? []),
    weightsB: Float32Array.from(s.weightsB ?? []),
    enabledA: Uint8Array.from(s.enabledA ?? []),
    enabledB: Uint8Array.from(s.enabledB ?? []),
  } as Genome;
  const traits = s.traits ?? {};
  for (const k of TRAIT_KEYS) {
    const pair = traits[k] ?? [0, 0];
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
  return b;
}

export function deserialize(data: SaveBlob): World {
  const blob = migrate(data);
  const config = blob.config;
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
    actionWindow:
      c.actionWindow !== undefined ? Float32Array.from(c.actionWindow) : new Float32Array(ACTIONS),
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
  const rng: RngBundle = deserializeRng(blob.rng ?? {});

  return {
    config,
    tick: blob.tick ?? 0,
    solarReservoir: blob.solarReservoir ?? 0,
    creatures,
    plants,
    corpses,
    creatureIds: creatures.map((c) => c.id),
    nextId: blob.nextId ?? 0,
    fields: deFields(blob.fields),
    rng,
    eventLog: (blob.eventLog ?? []).map((e) => ({ ...e })),
    history: (blob.history ?? []).map((h) => ({ ...h })),
    // Phase 5A.3 lineage state (migration defaults these for a v2 blob).
    lineageRoots: { ...(blob.lineageRoots ?? {}) },
    lineageEvents: (blob.lineageEvents ?? []).map((e) => ({ ...e })),
    dominant: blob.dominant ?? null,
    rootPopSnapshots: (blob.rootPopSnapshots ?? []).map((s) => ({
      tick: s.tick,
      counts: { ...s.counts },
    })),
    lastSavedRealTime: blob.lastSavedRealTime ?? 0,
  };
}
