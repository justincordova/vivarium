/**
 * stats.ts — the authoritative conserved-quantity sums.
 *
 * `totalEnergy(world)` and `totalWater(world)` are the single functions the sim and
 * the conservation property test both call (SPEC.md §Energy, §Water). Exact integer
 * arithmetic — no epsilon. The invariants are `totalEnergy(after) === totalEnergy
 * (before)` and `totalWater(after) === totalWater(before)`, every tick.
 *
 * Part of `sim/`: imports only sibling `sim/` modules.
 */

import type { World } from "./types";

/** Exact integer sum of an integer typed array (index-based; no reduce/iterator). */
function sumInt32(arr: Int32Array): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] as number;
  return s;
}

/**
 * The conserved energy quantity — exact integer sum over every compartment
 * (SPEC.md §"The conserved quantity"):
 *   solarReservoir + Σcreature.energy + Σplant.energy + Σcorpse.energy
 *   + ΣfertilityField + ΣlightField.
 * There is no `scent`/`temperature` term — those are non-conserved modulator fields.
 */
export function totalEnergy(world: World): number {
  let total = world.solarReservoir;
  const { creatures, plants, corpses, fields } = world;
  for (let i = 0; i < creatures.length; i++) total += (creatures[i] as { energy: number }).energy;
  for (let i = 0; i < plants.length; i++) total += (plants[i] as { energy: number }).energy;
  for (let i = 0; i < corpses.length; i++) total += (corpses[i] as { energy: number }).energy;
  total += sumInt32(fields.fertility);
  total += sumInt32(fields.light);
  return total;
}

/**
 * The conserved water quantity (SPEC.md §Water):
 *   ΣwaterField + Σcreature.hydration.
 * Corpses carry **no** water (no `hydration` field — enforced by the `Corpse` type)
 * and plants hold no water, so neither appears here. Adding either would silently
 * break `totalWater` conservation.
 */
export function totalWater(world: World): number {
  let total = sumInt32(world.fields.water);
  const { creatures } = world;
  for (let i = 0; i < creatures.length; i++) {
    total += (creatures[i] as { hydration: number }).hydration;
  }
  return total;
}
