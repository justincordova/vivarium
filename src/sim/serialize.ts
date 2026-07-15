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

export const SAVE_VERSION = 1;

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

/** Forward-migration scaffold. Each `migrate_vN_to_vN1` upgrades in place. */
function migrate(blob: SaveBlob): SaveBlob {
  let b = blob;
  // v0/undefined → v1: nothing to do yet (v1 is the first version). Future:
  // while (b.version < SAVE_VERSION) b = migrate_vN_to_vN1(b);
  if (b.version === undefined) b = { ...b, version: SAVE_VERSION };
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
    ruleState: c.ruleState ?? {
      mode: "wander",
      targetId: -1,
      targetKind: "none",
      committedTicks: 0,
    },
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
    lastSavedRealTime: blob.lastSavedRealTime ?? 0,
  };
}
