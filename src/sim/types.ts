/**
 * types.ts — all core data shapes and the sensor/action enums.
 *
 * Every module operates on these; defining them wrong forces later rewrites of the
 * save format. Shapes match SPEC.md exactly (§The Genome, §Plant Lifecycle,
 * §Sensors, §Actions, §Space & Fields, §Persistence, §Lineage).
 *
 * Part of `sim/`: imports nothing (SPEC.md §"The `sim/` purity rule").
 */

// ─────────────────────────────────────────────────────────────────────────────
// Diploid allele helper
// ─────────────────────────────────────────────────────────────────────────────

/** A diploid gene: two alleles. Continuous traits express as the mean of the pair. */
export type Allele = [number, number];

// ─────────────────────────────────────────────────────────────────────────────
// Genome  (SPEC.md §The Genome)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A creature genome: diploid brain arrays + diploid trait genes + the neutral
 * `hue` marker. The brain arrays exist and evolve from commit one even though the
 * Phase 0 rule-based policy ignores them (SPEC.md §"Why not NEAT" — this is what
 * makes the Phase 4 swap touch only `think`).
 */
export interface Genome {
  // Brain (see Brain Design) — diploid. Length ARROWS (380) each.
  weightsA: Float32Array; // one homolog
  weightsB: Float32Array; // the other homolog
  enabledA: Uint8Array; // 0/1 mask homolog A
  enabledB: Uint8Array; // 0/1 mask homolog B

  // Trait genes — diploid (two alleles each; expressed as the mean unless noted).
  size: Allele;
  speed: Allele;
  senseRadius: Allele;
  metabolism: Allele;
  aggression: Allele;
  diet: Allele; // 0 = pure herbivore, 1 = pure carnivore
  circadian: Allele; // 0 = diurnal, 1 = nocturnal
  nightVision: Allele;
  armor: Allele;
  toxicity: Allele;
  offspringInvestment: Allele;
  matingThreshold: Allele;
  maxLifespan: Allele;
  digestionEfficiency: Allele;

  // Appearance — neutral, drifts freely, carries lineage. Diploid so hybrids are
  // visibly hybrid. Zero effect on survival.
  hue: Allele; // 0..360
}

/**
 * A plant genome: diploid trait genes plus the neutral `hue` marker, and **no
 * brain arrays** (plants are passive; their behavior is a formula). Reproduction
 * is clonal in v1 (SPEC.md §Plant Lifecycle).
 */
export interface PlantGenome {
  maxSize: Allele; // reproductive/energy-storage ceiling
  height: Allele; // light-capture vs. shading (arms race)
  dispersal: Allele; // seed placement: near (dense) ↔ far (refuge)
  toughness: Allele; // energy withheld when grazed; growth cost
  seedInvestment: Allele; // energy packed per seed
  maxAge: Allele; // hard age ceiling; high ≈ immortal-until-grazed
  hue: Allele; // neutral lineage marker, 0..360
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived brain cache  (SPEC.md §"Brain weight expression" — NOT serialized)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The forward-pass operand derived from the two homologs:
 * `weights[k] = (weightsA[k] + weightsB[k]) / 2`, `enabled[k] = enabledA[k] | enabledB[k]`.
 * A pure function of the homologs, so it is **not serialized** — re-derived on load
 * (SPEC.md §Persistence). Distinct from `Creature.hidden`, which IS serialized.
 */
export interface DerivedBrain {
  weights: Float32Array; // length ARROWS
  enabled: Uint8Array; // length ARROWS
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule-brain scaffolding  (SPEC.md / plan Task 0.1.2 — serialized, rule-brain-only)
// ─────────────────────────────────────────────────────────────────────────────

/** What the rule brain's committed target is. */
export type TargetKind = "food" | "threat" | "mate" | "corpse" | "none";

/** The rule brain's behavioral mode discriminant. */
export type RuleMode = "seek" | "flee" | "rendezvous" | "scavenge" | "wander";

/**
 * Per-creature rule-brain state for target hysteresis + mutual mate rendezvous.
 * Serialized (a creature mid-`TARGET_COMMIT_TICKS` at a save boundary must resume
 * its committed target). Ignored by `PatchbayBrain`; harmless dead weight under it,
 * droppable via migration when `RuleBasedBrain` retires.
 */
export interface RuleState {
  mode: RuleMode;
  targetId: number; // -1 when none
  targetKind: TargetKind;
  committedTicks: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Creature  (SPEC.md §The Genome, §Lineage, §Removal, Tick Loop)
// ─────────────────────────────────────────────────────────────────────────────

export interface Creature {
  id: number;
  parentId: number | null; // SPEC.md §Lineage — null for founders; from commit one
  // Continuous position + heading; agents move by velocity (SPEC.md §Space & Fields).
  x: number;
  y: number;
  heading: number; // radians
  vx: number;
  vy: number;
  // Integer ledger stores (energy + hydration are conserved quanta).
  energy: number;
  hydration: number;
  health: number; // 0..maxHealth
  age: number; // increments by 1 per tick
  genome: Genome;
  /**
   * Derived-weights cache — a pure function of the homologs, NOT serialized
   * (re-derived on load). May be absent until first derived.
   */
  derived?: DerivedBrain;
  /**
   * Recurrent hidden-state vector (length HIDDEN). Genuine per-creature runtime
   * state fed to next tick's `think` — IS serialized. Inits to a zero vector at
   * birth/spawn and on any deserialize lacking it (plan Conventions block).
   */
  hidden: Float32Array;
  /** Rule-brain hysteresis/rendezvous state. Serialized. */
  ruleState: RuleState;
  /**
   * Per-creature trailing action-fire histogram (length ACTIONS = 7), backing the
   * `behaviorNovelty` metric (plan Task 1.1). An exponential-decay accumulator: each
   * tick every slot decays by `1 − 1/NOVELTY_WINDOW` and a fired action's slot gains
   * 1 — the bounded-memory realization of a trailing window. **Serialized runtime
   * state** (plan Task 1.2): without it, novelty resets to noise after every
   * save/catch-up. Updated in `tick()` but **never read back into `think()`**, so it
   * stays outside the determinism-critical selection path. Inits to zeros. */
  actionWindow: Float32Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plant & Corpse  (SPEC.md §Plant Lifecycle, §Removal & Corpses)
// ─────────────────────────────────────────────────────────────────────────────

export interface Plant {
  id: number;
  parentId: number | null;
  x: number;
  y: number;
  energy: number; // integer quanta
  age: number;
  genome: PlantGenome;
}

/**
 * A corpse carries energy but **never water** — it has no `hydration` field and
 * contributes nothing to `totalWater` (SPEC.md §Removal & Corpses; adding
 * `corpse.hydration` would silently break water conservation).
 */
export interface Corpse {
  id: number;
  x: number;
  y: number;
  energy: number; // integer quanta
}

// ─────────────────────────────────────────────────────────────────────────────
// RNG  (SPEC.md §"RNG Discipline" — 7 named sub-streams)
// ─────────────────────────────────────────────────────────────────────────────

/** The named sub-streams. The layout is part of the self-describing save. New streams
 * are APPENDED (never reordered) so existing streams' derivation is unperturbed. */
export type RngStreamName =
  | "motion"
  | "mutation"
  | "mating"
  | "resolve-shuffle"
  | "resolve"
  | "field-noise"
  | "spawn"
  | "terrain";

/** The fixed ordered list of sub-stream names (serialized in the snapshot). */
export const RNG_STREAM_NAMES: readonly RngStreamName[] = [
  "motion",
  "mutation",
  "mating",
  "resolve-shuffle",
  "resolve",
  "field-noise",
  "spawn",
  "terrain",
] as const;

/**
 * A single seeded stream. `mulberry32`'s entire serializable state is its 32-bit
 * `state` word (SPEC.md §Persistence — live state is serialized, not just seed).
 */
export interface RNG {
  state: number;
  next(): number;
}

/** The bundle of all 7 sub-streams, keyed by name. */
export type RngBundle = Record<RngStreamName, RNG>;

// ─────────────────────────────────────────────────────────────────────────────
// Fields  (SPEC.md §Space & Fields)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The gridded fields. Ledger-bearing fields (light, fertility, water) carry
 * integer quanta backing the exact-`===` conservation sums, so they are
 * `Int32Array` — never `Float32Array` (which loses precision ≥2²⁴). Non-conserved
 * modulator fields (temperature, scent) may stay `Float32Array`.
 */
export interface Fields {
  light: Int32Array; // ledger-bearing
  fertility: Int32Array; // ledger-bearing
  water: Int32Array; // ledger-bearing
  temperature: Float32Array; // modulator, non-conserved
  scent: Float32Array; // modulator, non-conserved
}

// ─────────────────────────────────────────────────────────────────────────────
// Terrain  (Living World redesign — authored, seed-generated, immutable in tick)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authored biome per grid cell. NOT ledger-bearing — terrain modulates rates
 * (growth, movement, cover), it mints/destroys nothing. Serialized world state.
 */
export enum Biome {
  Water = 0,
  Grassland = 1,
  Forest = 2,
  Barren = 3,
  Rock = 4,
}

/**
 * The per-cell terrain layer (row-major, `gridCols*gridRows`, like `Fields`).
 * Generated once from the seed at world creation and **read-only during `tick()`**.
 * `elevation` in 0..1 drives water pooling and visual relief.
 */
export interface Terrain {
  biome: Uint8Array;
  elevation: Float32Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event log  (SPEC.md §Offline Catch-up — but sim/ entries are {tick, event} only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deterministic `sim/` event-log entry. **No `realTime`** — wall-clock is
 * non-deterministic and is attached by the worker outside `sim/` (plan Conventions
 * block; SPEC.md §Offline Catch-up).
 */
export interface SimEvent {
  tick: number;
  event: string;
}

/**
 * A typed lineage event (Phase 5A.3) — the structured, deterministic drama the
 * "while you were away" report narrates. Keyed on the STABLE founder-lineage-root id
 * (`world.lineageRoots`), not a cluster label (labels aren't stable across recomputes)
 * nor hue (hue drifts). Detected on the history cadence in `history.ts`; serialized so
 * events fired during offline catch-up survive. Narrated by tick/generation, never
 * wall-clock (invalid across a catch-up boundary).
 */
export type LineageEvent =
  | { kind: "extinction"; tick: number; lineage: number }
  | { kind: "lineageBoom"; tick: number; lineage: number; factor: number }
  | { kind: "newDominant"; tick: number; lineage: number };

// ─────────────────────────────────────────────────────────────────────────────
// Downsampled history  (SPEC.md §Lineage — part of the v1 schema from the start)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One history sample. Recent samples are kept at full detail; older ones are
 * downsampled to 1 point / ~1000 ticks (SPEC.md §Lineage; plan Task 1.2). All the
 * per-gene fields are optional so a pre-Phase-1 `version:1` blob still deserializes
 * (no migration) — the plan's "shape is part of the v1 schema" requirement.
 */
export interface HistorySample {
  tick: number;
  population: number;
  plantCount: number;
  corpseCount: number;
  /** Population variance of expressed value, per functional trait gene (means/vars). */
  traitMeans?: Record<string, number>;
  traitVariances?: Record<string, number>;
  /** Cluster count at this sample (recomputed on the species cadence; else carried). */
  speciesCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config  (SPEC.md §Space & Fields, §Persistence — self-describing save)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All UI-mutable tunables. `tick()` reads these from `world.config.tunables`,
 * never by importing `constants.ts` directly (load-bearing for determinism, Phase
 * 3 `setParam`, Phase 5 forking). Mirrors the tunable constants; `defaultConfig`
 * copies the `constants.ts` defaults in (see config.ts).
 */
export interface Tunables {
  // tick/time
  TICKS_PER_DAY: number;
  DAYS_PER_SEASON: number;
  MS_PER_TICK: number;
  MAX_OFFLINE_TICKS: number;
  // movement
  MAX_TURN_RATE: number;
  MAX_ACCEL: number;
  K_SIZE: number;
  K_ARMOR: number;
  // brain
  NEWBORN_ENABLE_FRAC: number;
  // distance
  DIST_WEIGHT_COEF: number;
  DIST_MASK_COEF: number;
  // mutation
  WEIGHT_MUT_RATE: number;
  WEIGHT_MUT_SIGMA: number;
  ENABLE_ON_RATE: number;
  ENABLE_OFF_RATE: number;
  DRIFT_RATE: number;
  DRIFT_SIGMA: number;
  TRAIT_MUT_RATE: number;
  TRAIT_MUT_SIGMA: Record<string, number>;
  PLANT_MUT_SIGMA: Record<string, number>;
  HUE_MUT_RATE: number;
  HUE_DRIFT: number;
  MUT_GLOBAL: number;
  // energy/water field dynamics
  LIGHT_DECAY: number;
  CORPSE_DECAY_FRACTION: number;
  HYDRATION_DECAY: number;
  PLANT_GROWTH_MAX: number;
  LIGHT_THRESHOLD: number;
  FERTILITY_THRESHOLD: number;
  PLANT_CAP_PER_CELL: number;
  // healing
  HEAL_ENERGY_THRESHOLD: number;
  HEAL_RATE: number;
  HEAL_COST: number;
  // species / density
  SPECIES_COMPAT_THRESHOLD: number;
  DENSITY_RADIUS: number;
  CREATURE_CAP: number;
  REPRO_SOFT_FRAC: number;
  REPRO_CROWD_LIMIT: number;
  ALLEE_POP_THRESHOLD: number;
  // gated-action thresholds
  EAT_THRESHOLD: number;
  DRINK_THRESHOLD: number;
  ATTACK_THRESHOLD: number;
  MATE_THRESHOLD: number;
  EMIT_THRESHOLD: number;
  // rule-policy fractions
  HUNGRY_FRAC: number;
  THIRSTY_FRAC: number;
  CRITICAL_FRAC: number;
  TARGET_COMMIT_TICKS: number;
  // trait maxima / sensor normalizers
  MAX_ENERGY_BASE: number;
  MAX_ENERGY_PER_SIZE: number;
  MAX_HYDRATION_BASE: number;
  MAX_HYDRATION_PER_SIZE: number;
  MAX_HEALTH_BASE: number;
  MAX_HEALTH_PER_SIZE: number;
  MAX_HEALTH_PER_ARMOR: number;
  TEMP_MIN: number;
  TEMP_MAX: number;
  TEMP_BASELINE: number;
  TEMP_SEASON_AMPLITUDE: number;
  TEMP_NIGHT_DROP: number;
  TEMP_COMFORT: number;
  TEMP_COLD_COEF: number;
  LIGHT_SENSOR_MAX: number;
  SCENT_SENSOR_MAX: number;
  WATER_CELL_MAX: number;
  FERTILITY_CELL_MAX: number;
  // metabolic/movement cost coefficients
  METABOLIC_COST_COEF: number;
  MOVEMENT_COST_COEF: number;
  // contests
  THREAT_MARGIN: number;
  REACH_BASE: number;
  REACH_PER_SIZE: number;
  K_SPEED: number;
  K_ANGLE: number;
  // scent
  EMIT_INTENSITY: number;
  // Phase 1 — world-health metrics (read by stats.ts only, never by tick()).
  SPECIES_SPATIAL_RADIUS: number;
  SPECIES_RECOMPUTE_INTERVAL: number;
  NOVELTY_WINDOW: number;
  NOVELTY_ACT_EPS: number;
  NOVELTY_SAMPLE: number;
}

/** Which brain policy is active. Phase 0–3: `'rule'`; Phase 4 swaps in `'patchbay'`. */
export type BrainKind = "rule" | "patchbay";

/**
 * The self-describing config. World dims, grid resolution, initial reservoir, the
 * hidden-neuron count, the brain policy, the RNG sub-stream layout, and every
 * tunable — all serialized so a save loads standalone (SPEC.md §Persistence).
 */
export interface Config {
  worldWidth: number;
  worldHeight: number;
  gridCols: number;
  gridRows: number;
  /** Initial size of the mutable `solarReservoir` (its running balance is World state). */
  initialSolarReservoir: number;
  /** Founder count (SPEC.md §Initial Conditions — 40–100). */
  founderCount: number;
  /** Hidden-neuron count (subject of the enlargement experiment). */
  hidden: number;
  brainKind: BrainKind;
  /** The RNG sub-stream layout — self-describing about which streams existed. */
  rngStreams: readonly RngStreamName[];
  tunables: Tunables;
}

// ─────────────────────────────────────────────────────────────────────────────
// World  (SPEC.md §Energy, §Space & Fields, §Persistence)
// ─────────────────────────────────────────────────────────────────────────────

export interface World {
  config: Config;
  tick: number;
  /** The "sky": finite pool sunlight is drawn from. Mutable integer World state. */
  solarReservoir: number;
  // Compartments as arrays + a stable ID array for index-based iteration.
  creatures: Creature[];
  plants: Plant[];
  corpses: Corpse[];
  /** Stable, insertion-ordered creature IDs — iteration is index-based over this. */
  creatureIds: number[];
  /** Monotonic id source for new entities. */
  nextId: number;
  fields: Fields;
  /** Authored biome/elevation per cell (Living World). Read-only during `tick()`. */
  terrain: Terrain;
  rng: RngBundle;
  /** Deterministic sim event log — `{tick, event}` only, no wall-clock. */
  eventLog: SimEvent[];
  /** Downsampled long-run history (part of the v1 schema from the start). */
  history: HistorySample[];
  /**
   * Cumulative creature-id → founder-lineage-root-id map (Phase 5A.3). A founder
   * (`parentId === null`) is its own root; anyone else inherits their parent's root.
   * Never pruned (a dead parent still resolves its children). Serialized so lineage
   * identity survives catch-up + reload — the stable key the typed events and stats key
   * on. Populated at founder construction (`world.ts`) and birth (`tick.ts`).
   */
  lineageRoots: Record<number, number>;
  /**
   * Typed lineage events (Phase 5A.3) — the deterministic drama the report narrates.
   * A bounded ring (oldest dropped past `MAX_LINEAGE_EVENTS`). Serialized so events
   * fired during offline catch-up survive to be reported.
   */
  lineageEvents: LineageEvent[];
  /**
   * Dominance tracker for `newDominant` detection: the currently-dominant lineage root
   * and the tick it took the lead. `null` until a first dominant is seen. Serialized.
   */
  dominant: { lineage: number; sinceTick: number } | null;
  /**
   * Bounded ring of recent per-root population snapshots (Phase 5A.3), one per history
   * sample, covering ≥`BOOM_WINDOW` ticks — the basis for boom/extinction detection
   * over a window without bloating `history`. Oldest dropped once older than the
   * window. Serialized (so catch-up detection is continuous across a save boundary).
   */
  rootPopSnapshots: { tick: number; counts: Record<number, number> }[];
  /** Wall-clock of last save; attached outside sim/ for catch-up. Not read by tick(). */
  lastSavedRealTime: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sensor / Action enums  (SPEC.md §Sensors, §Actions — exact indices)
// ─────────────────────────────────────────────────────────────────────────────

/** The 21 sensor input indices (SPEC.md §Sensors). */
export enum Sensor {
  Bias = 0,
  OwnEnergy = 1,
  OwnHydration = 2,
  OwnAge = 3,
  OwnHealth = 4,
  NearestFoodDistance = 5,
  NearestFoodAngle = 6,
  NearestThreatDistance = 7,
  NearestThreatAngle = 8,
  NearestMateDistance = 9,
  NearestMateAngle = 10,
  LocalDensity = 11,
  LightLevel = 12,
  LocalTemperature = 13,
  LocalWater = 14,
  LocalFertility = 15,
  ScentValue = 16,
  ScentGradient = 17,
  // Terrain senses (Living World, Phase 6B) — appended so existing sensor indices are
  // unchanged (though the total arrow COUNT/geometry changes, breaking old brains).
  LocalBiome = 18, // normalized biome id (0..1)
  WaterDirX = 19, // unit vector toward nearest water cell, x
  WaterDirY = 20, // unit vector toward nearest water cell, y
}

/** The 7 action output indices (SPEC.md §Actions). */
export enum Action {
  Turn = 0,
  Accelerate = 1,
  Eat = 2,
  Drink = 3,
  Attack = 4,
  Mate = 5,
  EmitScent = 6,
}
