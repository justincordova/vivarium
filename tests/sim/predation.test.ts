import { makeConfig } from "@sim/config";
import { totalEnergy, totalWater } from "@sim/stats";
import { tick } from "@sim/tick";
import type { Corpse, Creature } from "@sim/types";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";

/**
 * Scavenging must actually pay. `tryEat`'s corpse branch can only fire if the food
 * percept is able to NAME a corpse, and `plan.foodId` comes solely from the percept —
 * so if corpses are ever dropped from the sensing path again, meat silently becomes
 * inedible: every kill routes 100% of the prey's energy corpse→fertility→plants and the
 * carnivore niche becomes economically impossible. That failure is invisible (no crash,
 * no ledger violation, tests still green), which is why it is pinned here.
 */
function loneEater(diet: number): {
  world: ReturnType<typeof createWorld>;
  c: Creature;
  corpse: Corpse;
} {
  const world = createWorld(5, makeConfig({ brainKind: "rule" }));
  const c = world.creatures[0] as Creature;
  world.creatures = [c];
  world.creatureIds = [c.id];
  // The corpse is the ONLY food in the world, so any energy the creature gains can only
  // have come from it.
  world.plants = [];
  c.genome.diet = [diet, diet];
  c.genome.digestionEfficiency = [1, 1];
  // Well under HUNGRY_FRAC, so the rule brain's seek-food branch fires.
  c.energy = 10;
  const corpse: Corpse = { id: world.nextId++, x: c.x, y: c.y, energy: 5000 };
  world.corpses = [corpse];
  return { world, c, corpse };
}

describe("predation — carrion is edible", () => {
  it("a meat-eater standing on a corpse gains energy from it", () => {
    const { world, c, corpse } = loneEater(1);
    const before = c.energy;
    tick(world);
    expect(c.energy).toBeGreaterThan(before);
    // And it came out of the corpse, not from thin air.
    expect(corpse.energy).toBeLessThan(5000);
  });

  it("a pure plant-eater does not eat meat", () => {
    const { world, corpse } = loneEater(0);
    tick(world);
    // `diet = 0` captures `corpse.energy * 0 * digest = 0`; the corpse only decays.
    const decay = Math.max(1, Math.floor(5000 * world.config.tunables.CORPSE_DECAY_FRACTION));
    expect(5000 - corpse.energy).toBeLessThanOrEqual(decay);
  });

  it("eating a corpse moves quanta without minting or destroying any", () => {
    const { world } = loneEater(1);
    const e0 = totalEnergy(world);
    const w0 = totalWater(world);
    for (let i = 0; i < 5; i++) {
      tick(world);
      expect(totalEnergy(world)).toBe(e0);
      expect(totalWater(world)).toBe(w0);
    }
  });
});
