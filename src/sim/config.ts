/**
 * config.ts — the single concrete `defaultConfig` value + `makeConfig` helper.
 *
 * `createWorld` (0.7), the headless runner (0.10), the viability gate (0.11), and
 * Phase 2's first render all need a concrete config *value*, not just the `Config`
 * type. One owner here prevents each caller inventing its own (divergence).
 *
 * Every field is populated from the `constants.ts` defaults. Part of `sim/`:
 * imports only sibling `sim/` modules.
 */

import * as C from "./constants";
import type { Config, Tunables } from "./types";
import { RNG_STREAM_NAMES } from "./types";

/** Build the tunables block from the `constants.ts` defaults (fresh, mutable copies). */
function defaultTunables(): Tunables {
  return {
    // tick/time
    TICKS_PER_DAY: C.TICKS_PER_DAY,
    DAYS_PER_SEASON: C.DAYS_PER_SEASON,
    MS_PER_TICK: C.MS_PER_TICK,
    MAX_OFFLINE_TICKS: C.MAX_OFFLINE_TICKS,
    // movement
    MAX_TURN_RATE: C.MAX_TURN_RATE,
    MAX_ACCEL: C.MAX_ACCEL,
    K_SIZE: C.K_SIZE,
    K_ARMOR: C.K_ARMOR,
    // brain
    NEWBORN_ENABLE_FRAC: C.NEWBORN_ENABLE_FRAC,
    // distance
    DIST_WEIGHT_COEF: C.DIST_WEIGHT_COEF,
    DIST_MASK_COEF: C.DIST_MASK_COEF,
    // mutation
    WEIGHT_MUT_RATE: C.WEIGHT_MUT_RATE,
    WEIGHT_MUT_SIGMA: C.WEIGHT_MUT_SIGMA,
    ENABLE_ON_RATE: C.ENABLE_ON_RATE,
    ENABLE_OFF_RATE: C.ENABLE_OFF_RATE,
    DRIFT_RATE: C.DRIFT_RATE,
    DRIFT_SIGMA: C.DRIFT_SIGMA,
    TRAIT_MUT_RATE: C.TRAIT_MUT_RATE,
    TRAIT_MUT_SIGMA: { ...C.TRAIT_MUT_SIGMA },
    PLANT_MUT_SIGMA: { ...C.PLANT_MUT_SIGMA },
    HUE_MUT_RATE: C.HUE_MUT_RATE,
    HUE_DRIFT: C.HUE_DRIFT,
    MUT_GLOBAL: C.MUT_GLOBAL,
    // energy/water field dynamics
    LIGHT_DECAY: C.LIGHT_DECAY,
    CORPSE_DECAY_FRACTION: C.CORPSE_DECAY_FRACTION,
    HYDRATION_DECAY: C.HYDRATION_DECAY,
    PLANT_GROWTH_MAX: C.PLANT_GROWTH_MAX,
    LIGHT_THRESHOLD: C.LIGHT_THRESHOLD,
    FERTILITY_THRESHOLD: C.FERTILITY_THRESHOLD,
    PLANT_CAP_PER_CELL: C.PLANT_CAP_PER_CELL,
    // healing
    HEAL_ENERGY_THRESHOLD: C.HEAL_ENERGY_THRESHOLD,
    HEAL_RATE: C.HEAL_RATE,
    HEAL_COST: C.HEAL_COST,
    // species / density
    SPECIES_COMPAT_THRESHOLD: C.SPECIES_COMPAT_THRESHOLD,
    DENSITY_RADIUS: C.DENSITY_RADIUS,
    CREATURE_CAP: C.CREATURE_CAP,
    // gated-action thresholds
    EAT_THRESHOLD: C.EAT_THRESHOLD,
    DRINK_THRESHOLD: C.DRINK_THRESHOLD,
    ATTACK_THRESHOLD: C.ATTACK_THRESHOLD,
    MATE_THRESHOLD: C.MATE_THRESHOLD,
    EMIT_THRESHOLD: C.EMIT_THRESHOLD,
    // rule-policy fractions
    HUNGRY_FRAC: C.HUNGRY_FRAC,
    THIRSTY_FRAC: C.THIRSTY_FRAC,
    CRITICAL_FRAC: C.CRITICAL_FRAC,
    TARGET_COMMIT_TICKS: C.TARGET_COMMIT_TICKS,
    // trait maxima / sensor normalizers
    MAX_ENERGY_BASE: C.MAX_ENERGY_BASE,
    MAX_ENERGY_PER_SIZE: C.MAX_ENERGY_PER_SIZE,
    MAX_HYDRATION_BASE: C.MAX_HYDRATION_BASE,
    MAX_HYDRATION_PER_SIZE: C.MAX_HYDRATION_PER_SIZE,
    MAX_HEALTH_BASE: C.MAX_HEALTH_BASE,
    MAX_HEALTH_PER_SIZE: C.MAX_HEALTH_PER_SIZE,
    MAX_HEALTH_PER_ARMOR: C.MAX_HEALTH_PER_ARMOR,
    TEMP_MIN: C.TEMP_MIN,
    TEMP_MAX: C.TEMP_MAX,
    LIGHT_SENSOR_MAX: C.LIGHT_SENSOR_MAX,
    SCENT_SENSOR_MAX: C.SCENT_SENSOR_MAX,
    WATER_CELL_MAX: C.WATER_CELL_MAX,
    FERTILITY_CELL_MAX: C.FERTILITY_CELL_MAX,
    // metabolic/movement cost coefficients
    METABOLIC_COST_COEF: C.METABOLIC_COST_COEF,
    MOVEMENT_COST_COEF: C.MOVEMENT_COST_COEF,
    // contests
    THREAT_MARGIN: C.THREAT_MARGIN,
    REACH_BASE: C.REACH_BASE,
    REACH_PER_SIZE: C.REACH_PER_SIZE,
    K_SPEED: C.K_SPEED,
    K_ANGLE: C.K_ANGLE,
    // scent
    EMIT_INTENSITY: C.EMIT_INTENSITY,
    // Phase 1 — world-health metrics
    SPECIES_SPATIAL_RADIUS: C.SPECIES_SPATIAL_RADIUS,
    SPECIES_RECOMPUTE_INTERVAL: C.SPECIES_RECOMPUTE_INTERVAL,
    NOVELTY_WINDOW: C.NOVELTY_WINDOW,
    NOVELTY_ACT_EPS: C.NOVELTY_ACT_EPS,
    NOVELTY_SAMPLE: C.NOVELTY_SAMPLE,
  };
}

/**
 * Build a fresh `defaultConfig`. A function (not a frozen singleton) so every
 * caller gets an independent, mutable copy — `makeConfig` and world creation must
 * never share nested references with a global.
 */
export function makeDefaultConfig(): Config {
  return {
    worldWidth: 200,
    worldHeight: 200,
    gridCols: 64,
    gridRows: 64,
    initialSolarReservoir: 2_000_000,
    founderCount: 60, // within SPEC.md §Initial Conditions 40–100
    hidden: C.HIDDEN,
    brainKind: "rule",
    rngStreams: [...RNG_STREAM_NAMES],
    tunables: defaultTunables(),
  };
}

/** Recursively freeze an object and its nested objects/arrays in place. */
function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === "object") {
    for (const value of Object.values(obj)) deepFreeze(value);
    Object.freeze(obj);
  }
  return obj;
}

/**
 * The canonical default config value — **deep-frozen** so it is a safe shared
 * reference: any stray direct mutation throws rather than silently poisoning every
 * later world (determinism is load-bearing). Callers that need to mutate must use
 * `makeConfig(overrides)`, which returns a fresh deep copy.
 */
export const defaultConfig: Config = deepFreeze(makeDefaultConfig());

/** Shallow-overridable top-level config fields (nested `tunables` handled separately). */
export type ConfigOverrides = Partial<Omit<Config, "tunables" | "rngStreams">> & {
  tunables?: Partial<Tunables>;
};

/**
 * Deep-copy `defaultConfig` and apply `overrides`. Used by the Phase 1 sweep and
 * the enlargement experiment. `makeConfig({})` deep-equals `defaultConfig`.
 */
export function makeConfig(overrides: ConfigOverrides = {}): Config {
  const base = makeDefaultConfig();
  const { tunables: tunableOverrides, ...topOverrides } = overrides;
  const merged: Config = {
    ...base,
    ...topOverrides,
    rngStreams: [...base.rngStreams],
    tunables: {
      ...base.tunables,
      ...tunableOverrides,
      // The nested sigma tables are merged explicitly so a partial override does not
      // drop the other gene entries.
      TRAIT_MUT_SIGMA: {
        ...base.tunables.TRAIT_MUT_SIGMA,
        ...(tunableOverrides?.TRAIT_MUT_SIGMA ?? {}),
      },
      PLANT_MUT_SIGMA: {
        ...base.tunables.PLANT_MUT_SIGMA,
        ...(tunableOverrides?.PLANT_MUT_SIGMA ?? {}),
      },
    },
  };
  return merged;
}
