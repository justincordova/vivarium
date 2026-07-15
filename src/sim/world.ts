/**
 * world.ts — `createWorld`: founder spawning, plant pre-seeding, field init.
 *
 * `tick.ts` and the headless harness need a valid initial world, and the
 * conservation gate must hold from tick 0 (SPEC.md §Initial Conditions, §Energy).
 *
 * **Conservation at tick 0 is load-bearing:** all energy starts in `solarReservoir`
 * and is *transferred out* into founders/plants — never minted — so
 * `totalEnergy(createWorld(...)) === config.initialSolarReservoir` exactly. Water is
 * placed in the water field at creation and drawn into founder hydration, so
 * `totalWater` equals the placed field total. Both use `energy.ts` transfer helpers.
 *
 * Determinism: genome jitter and placement both draw from the `spawn` sub-stream
 * (SPEC.md §Initial Conditions). Part of `sim/`.
 */

import * as C from "./constants";
import { cellCompartment, fieldCompartment, transfer } from "./energy";
import { TRAIT_GENES, TRAIT_RANGE, type TraitGene } from "./genetics";
import { createRngBundle, gaussian } from "./rng";
import type {
  Allele,
  Config,
  Creature,
  Fields,
  Genome,
  Plant,
  PlantGenome,
  RNG,
  World,
} from "./types";

// ── Seed genome templates (viable starting points, SPEC.md §Initial Conditions) ─

/** Midpoint expressed value of a trait's legal range — the "viable seed" default. */
function midTrait(gene: TraitGene): number {
  const [lo, hi] = TRAIT_RANGE[gene];
  return (lo + hi) / 2;
}

/** A shared seed brain template all founders are lightly-jittered copies of. */
interface BrainTemplate {
  weightsA: Float32Array;
  weightsB: Float32Array;
  enabledA: Uint8Array;
  enabledB: Uint8Array;
}

/**
 * Build the single shared founder brain template. Founders are *copies* of this with
 * light per-arrow jitter, so their expressed brains stay within
 * `SPECIES_COMPAT_THRESHOLD` of each other and the initial population is one
 * interbreeding species (SPEC.md §Initial Conditions — "copies of a small number of
 * viable seed genomes"). Independent random brains would put founders ~10× past the
 * compatibility threshold and no one could mate.
 */
function makeBrainTemplate(spawn: RNG): BrainTemplate {
  const weightsA = new Float32Array(C.ARROWS);
  const weightsB = new Float32Array(C.ARROWS);
  const enabledA = new Uint8Array(C.ARROWS);
  const enabledB = new Uint8Array(C.ARROWS);
  for (let i = 0; i < C.ARROWS; i++) {
    const w = gaussian(spawn) * 0.5;
    weightsA[i] = w;
    weightsB[i] = w;
    const on = spawn.next() < C.NEWBORN_ENABLE_FRAC ? 1 : 0;
    enabledA[i] = on;
    enabledB[i] = on;
  }
  return { weightsA, weightsB, enabledA, enabledB };
}

/** Build a founder genome: a lightly-jittered copy of the shared brain template. */
function makeFounderGenome(spawn: RNG, template: BrainTemplate, carnivore: boolean): Genome {
  const jitter = (base: number, gene: TraitGene): Allele => {
    const [lo, hi] = TRAIT_RANGE[gene];
    const span = (hi - lo) * 0.05; // ±5% of range, lightly randomized
    const a = clamp(base + gaussian(spawn) * span, lo, hi);
    const b = clamp(base + gaussian(spawn) * span, lo, hi);
    return [a, b];
  };

  // Small per-arrow weight jitter around the shared template — keeps founders within
  // the compatibility threshold while adding variation.
  const weightsA = new Float32Array(C.ARROWS);
  const weightsB = new Float32Array(C.ARROWS);
  const enabledA = new Uint8Array(C.ARROWS);
  const enabledB = new Uint8Array(C.ARROWS);
  for (let i = 0; i < C.ARROWS; i++) {
    weightsA[i] = (template.weightsA[i] as number) + gaussian(spawn) * 0.02;
    weightsB[i] = (template.weightsB[i] as number) + gaussian(spawn) * 0.02;
    enabledA[i] = template.enabledA[i] as number;
    enabledB[i] = template.enabledB[i] as number;
  }

  const g = { weightsA, weightsB, enabledA, enabledB } as Genome;
  for (const gene of TRAIT_GENES) g[gene] = jitter(midTrait(gene), gene);
  // Override to a viable *seed phenotype* (SPEC.md §Initial Conditions: founders are
  // lightly-randomized copies of viable seed genomes — mid-range is not necessarily
  // viable). These bootstrap values let founders feed and mate at moderate energy;
  // everything still evolves from here. (Phase-0 provisional; Phase 1 sweeps.)
  const seedGene = (gene: TraitGene, base: number): void => {
    g[gene] = jitter(base, gene);
  };
  seedGene("size", carnivore ? 5 : 3);
  seedGene("speed", carnivore ? 5 : 4);
  seedGene("metabolism", 1);
  // A minority of founders are carnivores (high diet + aggression) so predator–prey
  // dynamics exist from tick 0 and the ecosystem loop includes real kills; the rest
  // are herbivores. Both evolve freely from here.
  seedGene("diet", carnivore ? 0.9 : 0.1);
  seedGene("aggression", carnivore ? 4 : 1);
  seedGene("senseRadius", 25);
  seedGene("matingThreshold", 140); // fed enough to mate (throttles breeding)
  seedGene("offspringInvestment", 90); // costly but lets survivors rebuild after a trough
  seedGene("maxLifespan", 2000);
  seedGene("digestionEfficiency", 0.8);
  g.hue = [spawn.next() * 360, spawn.next() * 360];
  return g;
}

function makePlantGenome(spawn: RNG): PlantGenome {
  const a = (lo: number, hi: number): Allele => {
    const mid = (lo + hi) / 2;
    const span = (hi - lo) * 0.05;
    return [
      clamp(mid + gaussian(spawn) * span, lo, hi),
      clamp(mid + gaussian(spawn) * span, lo, hi),
    ];
  };
  // Founder plants start easy to eat (low toughness) and modestly sized so the
  // herbivore bootstrap has accessible food; toughness evolves up under grazing
  // pressure (Phase-0 provisional seeding).
  const low = (lo: number, hi: number): Allele => [
    clamp(lo + gaussian(spawn) * (hi - lo) * 0.1, lo, hi),
    clamp(lo + gaussian(spawn) * (hi - lo) * 0.1, lo, hi),
  ];
  return {
    maxSize: a(80, 200),
    height: a(0, 10),
    dispersal: a(0, 50),
    toughness: low(0, 0.2),
    seedInvestment: a(1, 100),
    maxAge: a(10, 100000),
    hue: [spawn.next() * 360, spawn.next() * 360],
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ── World creation ───────────────────────────────────────────────────────────

/** Per-founder starting energy/hydration and per-plant starting energy (tunable). */
const FOUNDER_START_ENERGY = 300;
const FOUNDER_START_HYDRATION = 150;
const PLANT_START_ENERGY = 60;
/** Plants pre-seeded at moderate density: this many per founder. */
const PLANTS_PER_FOUNDER = 5;
/** Initial fertility placed per grid cell so plants can photosynthesize from tick 0. */
const INITIAL_FERTILITY_PER_CELL = 50;
/** Number of spatial demes founders cluster into (SPEC.md §Initial Conditions). */
const DEME_COUNT = 4;
/** Radius of a deme cluster, world units. */
const DEME_RADIUS = 15;
/** Initial water placed per grid cell (drawn into founder hydration). */
const INITIAL_WATER_PER_CELL = 200;

function emptyFields(cells: number): Fields {
  return {
    light: new Int32Array(cells),
    fertility: new Int32Array(cells),
    water: new Int32Array(cells),
    temperature: new Float32Array(cells).fill(20),
    scent: new Float32Array(cells),
  };
}

function cellIndex(config: Config, x: number, y: number): number {
  const col = Math.min(config.gridCols - 1, Math.floor((x / config.worldWidth) * config.gridCols));
  const row = Math.min(config.gridRows - 1, Math.floor((y / config.worldHeight) * config.gridRows));
  return row * config.gridCols + col;
}

/**
 * Create a fresh, conservation-valid world from a seed + config. All energy begins
 * in `solarReservoir` and is transferred out to founders/plants; all water begins
 * in the water field and is drawn into founder hydration.
 */
export function createWorld(seed: number, config: Config): World {
  const cells = config.gridCols * config.gridRows;
  const fields = emptyFields(cells);
  const rng = createRngBundle(seed);
  const spawn = rng.spawn;

  // Place all water in the field up front (the declared water total).
  for (let i = 0; i < cells; i++) fields.water[i] = INITIAL_WATER_PER_CELL;

  const world: World = {
    config,
    tick: 0,
    solarReservoir: config.initialSolarReservoir,
    creatures: [],
    plants: [],
    corpses: [],
    creatureIds: [],
    nextId: 0,
    fields,
    rng,
    eventLog: [],
    history: [],
    lastSavedRealTime: 0,
  };

  const reservoir = fieldCompartment(world, "solarReservoir");

  // Seed initial fertility from the reservoir (drawn, never minted) so plants can
  // photosynthesize from tick 0 rather than waiting for the first corpse/decay.
  for (let i = 0; i < cells; i++) {
    transfer(reservoir, cellCompartment(fields.fertility, i), INITIAL_FERTILITY_PER_CELL);
  }

  // Deme centers, drawn from the spawn stream.
  const demeCenters: [number, number][] = [];
  for (let d = 0; d < DEME_COUNT; d++) {
    demeCenters.push([spawn.next() * config.worldWidth, spawn.next() * config.worldHeight]);
  }

  // One shared seed brain; every founder is a lightly-jittered copy (so they form one
  // interbreeding species).
  const brainTemplate = makeBrainTemplate(spawn);

  // Founders: clustered into demes; genome jitter + placement from `spawn`.
  for (let f = 0; f < config.founderCount; f++) {
    const deme = demeCenters[f % DEME_COUNT] as [number, number];
    const x = clamp(deme[0] + (spawn.next() * 2 - 1) * DEME_RADIUS, 0, config.worldWidth);
    const y = clamp(deme[1] + (spawn.next() * 2 - 1) * DEME_RADIUS, 0, config.worldHeight);
    // ~17% of founders are carnivores so predation reliably occurs across seeds
    // without over-predating the bootstrap population.
    const genome = makeFounderGenome(spawn, brainTemplate, f % 6 === 0);

    const creature: Creature = {
      id: world.nextId++,
      parentId: null,
      x,
      y,
      heading: spawn.next() * 2 * Math.PI,
      vx: 0,
      vy: 0,
      energy: 0,
      hydration: 0,
      health: C.MAX_HEALTH_BASE,
      age: 0,
      genome,
      hidden: new Float32Array(config.hidden),
      ruleState: { mode: "wander", targetId: -1, targetKind: "none", committedTicks: 0 },
    };
    // Draw starting energy from the reservoir and hydration from the local water cell.
    transfer(reservoir, fieldCompartment(creature, "energy"), FOUNDER_START_ENERGY);
    const waterCell = cellCompartment(fields.water, cellIndex(config, x, y));
    const hyd = Math.min(FOUNDER_START_HYDRATION, waterCell.get());
    transfer(waterCell, fieldCompartment(creature, "hydration"), hyd);

    world.creatures.push(creature);
    world.creatureIds.push(creature.id);
  }

  // Plants: pre-seeded at moderate density, placed from `spawn`; energy from reservoir.
  const plantCount = config.founderCount * PLANTS_PER_FOUNDER;
  for (let p = 0; p < plantCount; p++) {
    const x = spawn.next() * config.worldWidth;
    const y = spawn.next() * config.worldHeight;
    const plant: Plant = {
      id: world.nextId++,
      parentId: null,
      x,
      y,
      energy: 0,
      age: 0,
      genome: makePlantGenome(spawn),
    };
    transfer(reservoir, fieldCompartment(plant, "energy"), PLANT_START_ENERGY);
    world.plants.push(plant);
  }

  return world;
}
