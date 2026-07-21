import * as C from "@sim/constants";
import { describe, expect, it } from "vitest";

describe("constants — structural relations", () => {
  it("ARROWS equals the sum of the three connection groups", () => {
    // Guards the ARROWS literal against the skeleton dimensions
    // (Living World Phase 6B: 210 + 100 + 70 === 380, up from 350 with 3 terrain senses).
    expect(C.ARROWS).toBe(C.SENSORS * C.HIDDEN + C.HIDDEN * C.HIDDEN + C.HIDDEN * C.ACTIONS);
    expect(C.ARROWS).toBe(380);
  });

  it("skeleton dimensions match the pinned umwelt/action counts", () => {
    expect(C.SENSORS).toBe(21); // 18 base + 3 terrain senses (Living World Phase 6B)
    expect(C.HIDDEN).toBe(10);
    expect(C.ACTIONS).toBe(7);
  });

  it("newborn enable fraction is a probability", () => {
    expect(C.NEWBORN_ENABLE_FRAC).toBeGreaterThan(0);
    expect(C.NEWBORN_ENABLE_FRAC).toBeLessThan(1);
  });

  it("policy fractions are ordered critical < hungry (feeding overrides flee only when critical)", () => {
    expect(C.CRITICAL_FRAC).toBeLessThan(C.HUNGRY_FRAC);
  });

  it("TRAIT_MUT_SIGMA has an entry for every diploid trait gene", () => {
    // If a trait gene is added to Genome, its per-gene sigma must exist or
    // genetics.ts (Task 0.5.1) cannot mutate it.
    const geneNames = [
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
    for (const g of geneNames) {
      expect(C.TRAIT_MUT_SIGMA[g]).toBeGreaterThan(0);
    }
  });

  it("PLANT_MUT_SIGMA has an entry for every diploid plant gene", () => {
    // plantSeed indexes this by plant gene; a missing entry would silently freeze
    // that gene's evolution (or crash).
    const plantGenes = [
      "maxSize",
      "height",
      "dispersal",
      "toughness",
      "seedInvestment",
      "maxAge",
    ] as const;
    for (const g of plantGenes) {
      expect(C.PLANT_MUT_SIGMA[g]).toBeGreaterThan(0);
    }
  });
});

describe("constants — presence check (every name a later Phase 0 task references)", () => {
  it("all referenced constants are defined and numeric", () => {
    const required = [
      // tick/time
      "TICKS_PER_DAY",
      "DAYS_PER_SEASON",
      "MS_PER_TICK",
      "MAX_OFFLINE_TICKS",
      // movement
      "MAX_TURN_RATE",
      "MAX_ACCEL",
      "K_SIZE",
      "K_ARMOR",
      // brain skeleton
      "SENSORS",
      "HIDDEN",
      "ACTIONS",
      "ARROWS",
      "NEWBORN_ENABLE_FRAC",
      // pinned activation
      "TANH_APPROX_NUM_C",
      "TANH_APPROX_DEN_C0",
      "TANH_APPROX_DEN_C2",
      "TANH_APPROX_CLAMP",
      // distance
      "DIST_WEIGHT_COEF",
      "DIST_MASK_COEF",
      // mutation
      "WEIGHT_MUT_RATE",
      "WEIGHT_MUT_SIGMA",
      "ENABLE_ON_RATE",
      "ENABLE_OFF_RATE",
      "DRIFT_RATE",
      "DRIFT_SIGMA",
      "TRAIT_MUT_RATE",
      "HUE_MUT_RATE",
      "HUE_DRIFT",
      "MUT_GLOBAL",
      // energy/water field dynamics
      "LIGHT_DECAY",
      "CORPSE_DECAY_FRACTION",
      "HYDRATION_DECAY",
      "PLANT_GROWTH_MAX",
      "LIGHT_THRESHOLD",
      "FERTILITY_THRESHOLD",
      // healing
      "HEAL_ENERGY_THRESHOLD",
      "HEAL_RATE",
      "HEAL_COST",
      // species / density
      "SPECIES_COMPAT_THRESHOLD",
      "DENSITY_RADIUS",
      "CREATURE_CAP",
      "REPRO_SOFT_FRAC",
      "REPRO_CROWD_LIMIT",
      "ALLEE_POP_THRESHOLD",
      // gated-action thresholds
      "EAT_THRESHOLD",
      "DRINK_THRESHOLD",
      "ATTACK_THRESHOLD",
      "MATE_THRESHOLD",
      "EMIT_THRESHOLD",
      // rule-policy fractions
      "HUNGRY_FRAC",
      "THIRSTY_FRAC",
      "CRITICAL_FRAC",
      "TARGET_COMMIT_TICKS",
      // trait maxima / sensor normalizers
      "MAX_ENERGY_BASE",
      "MAX_ENERGY_PER_SIZE",
      "MAX_HYDRATION_BASE",
      "MAX_HYDRATION_PER_SIZE",
      "MAX_HEALTH_BASE",
      "MAX_HEALTH_PER_SIZE",
      "MAX_HEALTH_PER_ARMOR",
      "TEMP_MIN",
      "TEMP_MAX",
      "LIGHT_SENSOR_MAX",
      "SCENT_SENSOR_MAX",
      "WATER_CELL_MAX",
      "FERTILITY_CELL_MAX",
      // contests
      "REACH_BASE",
      "REACH_PER_SIZE",
      "K_SPEED",
      "K_ANGLE",
      // scent
      "EMIT_INTENSITY",
      // Phase 1 — world-health metrics
      "SPECIES_SPATIAL_RADIUS",
      "SPECIES_RECOMPUTE_INTERVAL",
      "NOVELTY_WINDOW",
      "NOVELTY_ACT_EPS",
      "NOVELTY_SAMPLE",
      "HISTORY_RECENT_WINDOW",
      "HISTORY_DOWNSAMPLE_TICKS",
      "HISTORY_SAMPLE_INTERVAL",
      // Phase 1 — sweep ranking
      "EXTINCT_SWEET",
      "RANK_W_POP_VARIANCE",
      "RANK_W_TRAIT_VARIANCE",
      "RANK_W_SPECIES",
      "RANK_W_NOVELTY",
      "RANK_W_EXTINCT",
      "RANK_W_STAGNATION",
      "RANK_W_CHAIN_DISCOUNT",
    ] as const;

    const mod = C as Record<string, unknown>;
    for (const name of required) {
      expect(mod[name], `missing constant: ${name}`).toBeTypeOf("number");
    }
  });
});
