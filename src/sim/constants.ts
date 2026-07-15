/**
 * constants.ts — the balancing vocabulary.
 *
 * Every named constant the simulation references. Values marked `(tunable)` are
 * starting points to be swept in Phase 1, not law (SPEC.md §"Tick Semantics &
 * Units"). Values marked `(bench)` are chosen only after `vitest bench` reports
 * the real headless tick rate; the placeholders here are provisional.
 *
 * These are the *default* values. Every UI-mutable tunable is copied into
 * `Config` (see config.ts) and read by `tick()` from `world.config`, never by
 * importing this module directly — that indirection is load-bearing for
 * determinism, Phase 3 `setParam`, and Phase 5 forking. `constants.ts` supplies
 * the defaults `defaultConfig` copies in.
 *
 * This module is part of `sim/`: it imports nothing (SPEC.md §"The `sim/` purity
 * rule").
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tick / time
// ─────────────────────────────────────────────────────────────────────────────

/** Ticks in a full day/night cycle. (tunable, sweepable) */
export const TICKS_PER_DAY = 1000;
/** Day/night cycles per season. (tunable) */
export const DAYS_PER_SEASON = 30;
/** How fast world-time flows in real time, ms per tick. (bench — chosen after Phase 1 bench) */
export const MS_PER_TICK = 50;
/** Offline catch-up ceiling, in ticks. (bench — chosen so worst-case catch-up < ~20s) */
export const MAX_OFFLINE_TICKS = 100_000;

// ─────────────────────────────────────────────────────────────────────────────
// Movement / kinematics  (SPEC.md §Actions — the mass/accel formula)
// ─────────────────────────────────────────────────────────────────────────────

/** Max angular velocity per tick, radians, before the `metabolism` multiplier. (tunable) */
export const MAX_TURN_RATE = 0.35;
/** Max forward acceleration per tick, world-units, before `metabolism`/mass. (tunable) */
export const MAX_ACCEL = 0.5;
/** mass = 1 + K_SIZE·size + K_ARMOR·armor. Size contribution to mass. (tunable) */
export const K_SIZE = 1.0;
/** mass = 1 + K_SIZE·size + K_ARMOR·armor. Armor contribution to mass. (tunable) */
export const K_ARMOR = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// Brain skeleton  (SPEC.md §"Brain Design — the patchbay")
// ─────────────────────────────────────────────────────────────────────────────

/** Sensor input count. Fixed — widening it is a version bump (SPEC.md §Sensors). */
export const SENSORS = 18;
/** Hidden-neuron count. Free parameter with a memory cost; subject of the enlargement experiment. */
export const HIDDEN = 10;
/** Action output count (SPEC.md §Actions). */
export const ACTIONS = 7;
/**
 * Total arrows per homolog. A plain literal (SPEC.md: "keep each value a plain
 * literal; do not compute"); the structural relation
 * `ARROWS === SENSORS*HIDDEN + HIDDEN*HIDDEN + HIDDEN*ACTIONS` (350 === 180+100+70)
 * is asserted by constants.test.ts, which guards this literal.
 */
export const ARROWS = 350;
/** Fraction of arrows enabled in a newborn — sparse start (SPEC.md §"Newborns are sparse"). (tunable) */
export const NEWBORN_ENABLE_FRAC = 0.15;

// ─────────────────────────────────────────────────────────────────────────────
// Activation function (pinned)  (SPEC.md §"Activation function (pinned)")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pinned rational approximation of tanh — FROZEN. Changing these invalidates every
 * saved brain, so they are fixed now and never changed. `Math.tanh`/`sin`/`exp` are
 * not bit-identical across engines; this closed form keeps cross-engine determinism
 * reachable (SPEC.md §Determinism point 3).
 *
 * Form (a (2,2) Padé-style approximant, clamped outside ±TANH_APPROX_CLAMP):
 *   tanh(x) ≈ x·(TANH_APPROX_NUM_C + x²) / (TANH_APPROX_DEN_C0 + TANH_APPROX_DEN_C2·x²)
 * which for the pinned coefficients is  x·(27 + x²) / (27 + 9·x²).
 * Outside ±TANH_APPROX_CLAMP the result saturates to ±1.
 */
export const TANH_APPROX_NUM_C = 27;
export const TANH_APPROX_DEN_C0 = 27;
export const TANH_APPROX_DEN_C2 = 9;
/** |x| beyond this saturates to ±1 (the approximant overshoots past here). */
export const TANH_APPROX_CLAMP = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Genetic distance  (SPEC.md §"Genetic distance")
// ─────────────────────────────────────────────────────────────────────────────

/** Weight on the Euclidean-over-expressed-weights term of genetic distance. (tunable) */
export const DIST_WEIGHT_COEF = 1.0;
/** Weight on the Hamming-over-expressed-masks term of genetic distance. (tunable) */
export const DIST_MASK_COEF = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// Mutation  (SPEC.md §Mutation — all rates draw from the `mutation` sub-stream)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-homolog per-arrow probability of a Gaussian weight nudge. (tunable) */
export const WEIGHT_MUT_RATE = 0.02;
/** Std-dev of the weight nudge. (tunable) */
export const WEIGHT_MUT_SIGMA = 0.15;
/** Per-homolog per-arrow probability of flipping a 0→1 (brain grows). (tunable) */
export const ENABLE_ON_RATE = 0.002;
/** Per-homolog per-arrow probability of flipping a 1→0 (brain prunes). (tunable) */
export const ENABLE_OFF_RATE = 0.002;
/** Per-homolog per-disabled-arrow probability of neutral drift. (tunable) */
export const DRIFT_RATE = 0.01;
/** Std-dev of disabled-arrow neutral drift (SPEC.md pins this at 0.2). (tunable) */
export const DRIFT_SIGMA = 0.2;
/** Per-allele probability of a trait-gene mutation. (tunable) */
export const TRAIT_MUT_RATE = 0.03;
/**
 * Per-gene std-dev of a trait mutation, in the gene's own units. (tunable, per-gene)
 * Keyed by trait-gene name; every diploid trait gene in `Genome` has an entry.
 */
export const TRAIT_MUT_SIGMA = {
  size: 0.1,
  speed: 0.1,
  senseRadius: 0.1,
  metabolism: 0.1,
  aggression: 0.1,
  diet: 0.05,
  circadian: 0.05,
  nightVision: 0.1,
  armor: 0.1,
  toxicity: 0.1,
  offspringInvestment: 0.1,
  matingThreshold: 0.1,
  maxLifespan: 0.1,
  digestionEfficiency: 0.05,
} as const;
/**
 * Per-gene std-dev of a *plant* trait mutation, in each gene's own units. (tunable,
 * per-gene) Separate from the creature `TRAIT_MUT_SIGMA` — plant genes have their own
 * ranges (e.g. `maxSize` 1–1000), so reusing a creature sigma would misfit them.
 */
export const PLANT_MUT_SIGMA = {
  maxSize: 5,
  height: 0.1,
  dispersal: 0.5,
  toughness: 0.02,
  seedInvestment: 2,
  maxAge: 50,
} as const;
/** Per-allele probability of a hue mutation. (tunable) */
export const HUE_MUT_RATE = 0.05;
/** Std-dev of hue drift, degrees, wrapped mod 360. (tunable) */
export const HUE_DRIFT = 5;
/**
 * The DoD "mutation rate" slider — a single global multiplier applied to every
 * per-locus rate above (never the sigmas). One knob, uniform pressure. (tunable)
 */
export const MUT_GLOBAL = 1.0;

// ─────────────────────────────────────────────────────────────────────────────
// Energy / water field dynamics  (SPEC.md §Energy, §Water, §Plant Lifecycle)
// ─────────────────────────────────────────────────────────────────────────────

/** Fraction of each light-field cell that decays back to `solarReservoir` per tick. (tunable) */
export const LIGHT_DECAY = 0.1;
/**
 * Fraction of a corpse's energy returned to local fertility per tick. Actual decay is
 * `max(1, floor(corpse.energy × CORPSE_DECAY_FRACTION))` so a corpse always reaches 0
 * in finite ticks (SPEC.md §Removal & Corpses). (tunable)
 */
export const CORPSE_DECAY_FRACTION = 0.05;
/** Fraction of a creature's hydration store lost (returned to water field) per tick. (tunable) */
export const HYDRATION_DECAY = 0.01;
/** Per-tick photosynthesis rate cap, before headroom limiting (SPEC.md §Plant Lifecycle). (tunable) */
export const PLANT_GROWTH_MAX = 15;
/** Minimum light in a cell for a plant to photosynthesize. (tunable) */
export const LIGHT_THRESHOLD = 1;
/** Minimum fertility in a cell for a plant to photosynthesize. (tunable) */
export const FERTILITY_THRESHOLD = 1;
/** Soft plant carrying capacity: max plants per grid cell before seeding halts. (tunable) */
export const PLANT_CAP_PER_CELL = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Health regeneration  (SPEC.md §"Health regeneration")
// ─────────────────────────────────────────────────────────────────────────────

/** Energy must exceed this for health to regenerate at all. (tunable) */
export const HEAL_ENERGY_THRESHOLD = 30;
/** Health points regenerated per tick when healing (capped at maxHealth). (tunable) */
export const HEAL_RATE = 1;
/** Energy paid per health point healed (credited to solarReservoir as heat). (tunable) */
export const HEAL_COST = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Species / density  (SPEC.md §"What counts as mate", §Density-dependent removal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genetic-distance cutoff below which two creatures are compatible. One shared
 * constant for mate classification (sensor 9), the `mate` action gate, and
 * `speciesCount` clustering — they must never diverge into two. (tunable)
 */
export const SPECIES_COMPAT_THRESHOLD = 8;
/** Fixed radius `localDensity(pos)` queries — sensor #11 and density removal share it. (tunable) */
export const DENSITY_RADIUS = 6;
/** Soft carrying capacity: reproduction is suppressed at/above this population. (tunable) */
export const CREATURE_CAP = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Gated-action thresholds  (SPEC.md §Actions "Gated actions fire when their
// output exceeds a threshold")
// ─────────────────────────────────────────────────────────────────────────────

export const EAT_THRESHOLD = 0.5; // (tunable)
export const DRINK_THRESHOLD = 0.5; // (tunable)
export const ATTACK_THRESHOLD = 0.5; // (tunable)
export const MATE_THRESHOLD = 0.7; // (tunable) — must be quite full to seek a mate
export const EMIT_THRESHOLD = 0.5; // (tunable)

// ─────────────────────────────────────────────────────────────────────────────
// Rule-policy fractions  (consumed by RuleBasedBrain.think, Task 0.6.1)
// ─────────────────────────────────────────────────────────────────────────────

/** Energy fraction below which a creature seeks food. (tunable) */
export const HUNGRY_FRAC = 0.8;
/** Hydration fraction below which a creature seeks water. (tunable) */
export const THIRSTY_FRAC = 0.4;
/**
 * Energy fraction below which flee-from-threat is suppressed in favor of feeding.
 * "Not critical" in the policy means energy ≥ CRITICAL_FRAC. (tunable)
 */
export const CRITICAL_FRAC = 0.2;
/**
 * Hysteresis: ticks a creature stays committed to a chosen target before
 * re-selecting — prevents the steer-toward-nearest limit cycle. (tunable)
 */
export const TARGET_COMMIT_TICKS = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Trait maxima / sensor normalizers  (SPEC.md §Sensors — every 0..1 sensor has a
// named referent)
// ─────────────────────────────────────────────────────────────────────────────

/** maxEnergy = MAX_ENERGY_BASE + MAX_ENERGY_PER_SIZE·size (SPEC.md: larger energy store). (tunable) */
export const MAX_ENERGY_BASE = 50;
export const MAX_ENERGY_PER_SIZE = 50;
/** maxHydration = MAX_HYDRATION_BASE + MAX_HYDRATION_PER_SIZE·size. (tunable, new modeling choice) */
export const MAX_HYDRATION_BASE = 50;
export const MAX_HYDRATION_PER_SIZE = 50;
/** maxHealth = MAX_HEALTH_BASE + MAX_HEALTH_PER_SIZE·size + MAX_HEALTH_PER_ARMOR·armor. (tunable) */
export const MAX_HEALTH_BASE = 20;
export const MAX_HEALTH_PER_SIZE = 40;
export const MAX_HEALTH_PER_ARMOR = 40;

/** Temperature sensor normalization range (sensor 13). (tunable) */
export const TEMP_MIN = -10;
export const TEMP_MAX = 40;
/** Light sensor normalization ceiling (sensor 12). (tunable) */
export const LIGHT_SENSOR_MAX = 100;
/** Scent sensor normalization ceiling (sensor 16). (tunable) */
export const SCENT_SENSOR_MAX = 100;
/** Local-water sensor normalization ceiling (sensor 14). (tunable) */
export const WATER_CELL_MAX = 100;
/** Local-fertility sensor normalization ceiling (sensor 15). (tunable) */
export const FERTILITY_CELL_MAX = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Contests  (SPEC.md §Contests)
// ─────────────────────────────────────────────────────────────────────────────

/** Multiplier on the size·metabolism baseline metabolic drain per tick. (tunable) */
export const METABOLIC_COST_COEF = 0.1;
/** Multiplier on the speed² movement-energy cost per tick. (tunable) */
export const MOVEMENT_COST_COEF = 0.01;

/**
 * A creature registers another as a *threat* only if the other's attack power
 * exceeds its own defensive scale by this factor — a margin so near-peers don't all
 * flee each other and starve the bootstrap. (tunable)
 */
export const THREAT_MARGIN = 1.5;

/** reach = REACH_BASE + REACH_PER_SIZE·size. Base interaction reach, world units. (tunable) */
export const REACH_BASE = 2.0;
/** reach = REACH_BASE + REACH_PER_SIZE·size. Size term. (tunable) */
export const REACH_PER_SIZE = 0.5;
/** Escape-check sigmoid coefficient on the speed differential. (tunable) */
export const K_SPEED = 2.0;
/** Escape-check sigmoid coefficient on off-heading. (tunable) */
export const K_ANGLE = 1.0;

// ─────────────────────────────────────────────────────────────────────────────
// Scent emission  (SPEC.md §Actions — emit scent, action 6)
// ─────────────────────────────────────────────────────────────────────────────

/** Intensity written into the scent field by a low-constant emit (rule policy). (tunable) */
export const EMIT_INTENSITY = 10;

/**
 * Normalized-distance (of senseRadius) below which a rendezvousing creature treats a
 * mate as "arrived" and holds, if the tick loop's real-units `mateInReach` is not
 * supplied. Fallback only. (tunable)
 */
export const RENDEZVOUS_ARRIVE_FRAC = 0.05;
