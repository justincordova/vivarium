/**
 * score.ts — "how interesting is this world?", as one number.
 *
 * SPEC.md §World-Health Metrics ("balance as search, not taste"). This scalarization was
 * written for the Phase 1 parameter sweep, which needed to *rank* thousands of configs
 * without a human looking at them. Terrarium mode needs the same judgement for the player
 * (`docs/designs/terrarium.md`), so it lives here rather than in `scripts/`: two
 * independent definitions of "interesting" would drift, and then the sweep would be
 * optimizing for something the game does not reward.
 *
 * Part of `sim/`: pure, imports only sibling `sim/` modules.
 */

import { makeConfig } from "./config";
import * as C from "./constants";
import type { WorldHealth } from "./stats";

/**
 * The pinned-shape ranking scalarization (plan Task 1.5). Rewards oscillation, genetic +
 * behavioral diversity, and species count; penalizes stagnation (high survival + near-zero
 * variance); scores `extinctionEvents` as a tent peaking at `EXTINCT_SWEET`; and discounts
 * a chained mega-cluster via `maxDiameter` so single-linkage chaining cannot game the
 * diversity reward. Higher = better.
 */
export function rankScore(health: WorldHealth, ticks: number): number {
  const {
    populationVariance,
    traitVariance,
    speciesCount,
    behaviorNovelty,
    extinctionEvents,
    maxDiameter,
    meanPopulation,
    survivalTicks,
  } = health;

  // Reaching the horizon is a PRECONDITION for the diversity/oscillation rewards.
  // Without this gate the sweep optimizes into the broken corner: a world that booms
  // to carrying capacity then crashes to zero has *huge* populationVariance and would
  // rank #1 — but it is dead, with speciesCount/novelty = 0 (measured on the empty
  // final frame). A crash is not oscillation. So a config that did not survive to
  // `ticks` earns ONLY survival-progress credit and none of the variance/diversity
  // reward (SPEC.md: a collapsed world must score bad).
  const reachedHorizon = ticks <= 0 || survivalTicks >= ticks;
  if (!reachedHorizon) {
    // Partial credit ∝ how far it got, so the search still gradient-follows toward
    // longer-lived configs, but always ranks below any horizon-reaching world.
    return -C.RANK_W_STAGNATION * (1 - survivalTicks / ticks);
  }

  // A survivor that is actually empty/near-empty at the horizon is not alive in any
  // meaningful sense — guard against a technicality where survivalTicks == ticks but
  // the population is ~0.
  if (meanPopulation < 1) return -C.RANK_W_STAGNATION;

  // Extinction tent: rises 0→EXTINCT_SWEET then falls (symmetric triangular peak 1).
  const sweet = C.EXTINCT_SWEET;
  const extinctTent = sweet <= 0 ? 0 : Math.max(0, 1 - Math.abs(extinctionEvents - sweet) / sweet);

  // Chaining discount: if the widest cluster's diameter far exceeds the compat
  // threshold, the "species" are a cline — scale the species reward down toward 0.
  const thr = makeConfig({}).tunables.SPECIES_COMPAT_THRESHOLD;
  const chainFactor = maxDiameter > thr ? thr / maxDiameter : 1;
  const speciesReward = speciesCount * (1 - C.RANK_W_CHAIN_DISCOUNT * (1 - chainFactor));

  // Stagnation penalty: a horizon-reaching world that barely oscillated is boring.
  // Penalty ∝ flatness of the recent population window.
  const flatness = 1 / (1 + populationVariance); // ~1 when variance ≈ 0, →0 as it grows
  const stagnation = flatness;

  return (
    C.RANK_W_POP_VARIANCE * populationVariance +
    C.RANK_W_TRAIT_VARIANCE * traitVariance +
    C.RANK_W_SPECIES * Math.max(0, speciesReward) +
    C.RANK_W_NOVELTY * behaviorNovelty +
    C.RANK_W_EXTINCT * extinctTent -
    C.RANK_W_STAGNATION * stagnation
  );
}
