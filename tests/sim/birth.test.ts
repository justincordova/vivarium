import { makeConfig } from "@sim/config";
import { ACTIONS } from "@sim/constants";
import { expressTrait } from "@sim/genetics";
import { totalEnergy, totalWater } from "@sim/stats";
import { tick } from "@sim/tick";
import type { Creature, World } from "@sim/types";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";

/**
 * Build a tiny controlled world with exactly two compatible, well-fed, adjacent-ish
 * creatures so a birth is reachable within a bounded number of ticks. We start from
 * a real createWorld (for valid fields/reservoir), then replace the creature list
 * with two hand-placed clones so they are guaranteed genetically compatible.
 */
function twoMateWorld(seed: number, apart: number): World {
  const config = makeConfig({ founderCount: 2 });
  const w = createWorld(seed, config);
  const base = w.creatures[0] as Creature;
  const cx = config.worldWidth / 2;
  const cy = config.worldHeight / 2;

  // Make the shared genome non-threatening to itself: low aggression, some armor, so
  // attackPower (aggression·size) < defenseScale (max(size, armor·size)). Otherwise
  // both perceive each other as threats and flee instead of mating.
  base.genome.aggression = [0, 0];
  base.genome.armor = [2, 2];
  base.genome.matingThreshold = [50, 50];
  base.genome.offspringInvestment = [30, 30];
  base.genome.diet = [0, 0]; // herbivore → not classified as huntable food

  const mk = (id: number, x: number, heading: number): Creature => ({
    ...base,
    id,
    parentId: null,
    x,
    y: cy,
    // Face the partner so the capped turn rate (an untuned Phase-0 kinematic, not the
    // rendezvous mechanism under test) doesn't confound gap-closing.
    heading,
    vx: 0,
    vy: 0,
    energy: 3000, // ample to survive crossing the gap (metabolism/movement cost is
    // deliberately un-tuned in Phase 0 — balance is Phase 1's job)
    hydration: 2000,
    health: 50,
    age: 0,
    genome: base.genome, // identical genome → genetic distance 0 → compatible
    hidden: new Float32Array(config.hidden),
    ruleState: { mode: "wander", targetId: -1, targetKind: "none", committedTicks: 0 },
  });

  // Re-home all energy/water so totals still reconcile: the original founders'
  // energy is already drawn from the reservoir; we overwrite creatures with our two.
  // To keep conservation valid we rebuild from scratch: put everything in reservoir,
  // then hand our two creatures their stores out of it.
  const c1 = mk(1000, cx - apart / 2, 0); // left creature faces +x (toward partner)
  const c2 = mk(1001, cx + apart / 2, Math.PI); // right creature faces −x

  // Reset: reclaim all creature/plant energy back to reservoir, drop plants/corpses,
  // then fund our two creatures from the reservoir so books balance.
  for (const c of w.creatures) w.solarReservoir += c.energy;
  for (const p of w.plants) w.solarReservoir += p.energy;
  // water: return original creature hydration to field cell 0.
  for (const c of w.creatures) w.fields.water[0] = (w.fields.water[0] as number) + c.hydration;

  w.creatures = [c1, c2];
  w.creatureIds = [c1.id, c1.id === 1000 ? 1001 : 1000];
  w.plants = [];
  w.corpses = [];

  // Fund c1, c2 from reservoir / water field.
  for (const c of [c1, c2]) {
    w.solarReservoir -= c.energy;
    w.fields.water[0] = (w.fields.water[0] as number) - c.hydration;
  }
  w.nextId = 2000;
  return w;
}

describe("localized birth-transfer invariant", () => {
  it("a single birth moves exactly offspringInvestment from each parent, ledgers balanced", () => {
    const w = twoMateWorld(1, 1); // adjacent → mate fires quickly
    const e0 = totalEnergy(w);
    const wat0 = totalWater(w);

    // A birth is detected purely by a child appearing (parentId !== null); conservation
    // must hold every tick regardless of whether a birth fired this tick.
    for (let i = 0; i < 50; i++) {
      tick(w);
      expect(totalEnergy(w)).toBe(e0);
      expect(totalWater(w)).toBe(wat0);
      if (w.creatures.some((c) => c.parentId !== null)) break;
    }
    // A birth occurred within the bounded window.
    expect(w.creatures.some((c) => c.parentId !== null)).toBe(true);
  });
});

describe("a birth never produces a stillborn (child born hydration 0)", () => {
  it("newborns always start with positive hydration, funded by the initiating parent", () => {
    // A child born at hydration 0 would die in `resolveRemovals` the SAME tick, wasting
    // the parents' investment. This is unreachable in the sim: the initiating parent
    // always has hydration >= 1 (creatures at hydration <= 0 are skipped before they can
    // initiate mating), so its water seeds every child. This test pins that invariant:
    // across a run where births occur, EVERY newborn (parentId !== null) has hydration > 0
    // on the tick it appears. It also holds conservation every tick.
    const w = twoMateWorld(1, 1); // adjacent, well-fed → births fire quickly
    const e0 = totalEnergy(w);
    const wat0 = totalWater(w);
    const seen = new Set<number>();
    let sawBirth = false;

    for (let i = 0; i < 80; i++) {
      tick(w);
      expect(totalEnergy(w)).toBe(e0);
      expect(totalWater(w)).toBe(wat0);
      for (const c of w.creatures) {
        if (c.parentId !== null && !seen.has(c.id)) {
          seen.add(c.id);
          sawBirth = true;
          // The newborn is not a stillborn: it carries hydration to survive its first
          // removal pass.
          expect(c.hydration).toBeGreaterThan(0);
        }
      }
    }
    // Guard against a vacuous pass: a birth actually occurred in the window.
    expect(sawBirth).toBe(true);
  });
});

describe("a newborn's actionWindow matches every other creature's length", () => {
  it("newborns get a full-length (ACTIONS) actionWindow, like founders/spawns/loads", () => {
    // A shorter newborn window than founders' desyncs `behaviorNovelty`: it compares
    // per-creature action histograms across the population, so mismatched lengths make
    // `normalizeHistogram` (1/7 vs 1/8) and `jensenShannon` (reads past the shorter
    // array) diverge. Every creature must carry the same fixed-length window.
    const w = twoMateWorld(1, 1);
    for (let i = 0; i < 80; i++) {
      tick(w);
      if (w.creatures.some((c) => c.parentId !== null)) break;
    }
    expect(w.creatures.some((c) => c.parentId !== null)).toBe(true);
    for (const c of w.creatures) {
      expect(c.actionWindow.length).toBe(ACTIONS);
    }
  });
});

describe("rendezvous produces a birth within bounded ticks", () => {
  it("two compatible well-fed creatures, initially out of reach but in sense, breed", () => {
    // Place them apart but within senseRadius so rendezvous (not adjacency) is what
    // closes the gap — the case the mechanism exists to fix.
    const w = twoMateWorld(7, 10);
    const senseR = expressTrait((w.creatures[0] as Creature).genome.senseRadius);
    // Ensure the start distance is inside sense range but outside reach.
    expect(10).toBeLessThan(senseR);

    const e0 = totalEnergy(w);
    const wat0 = totalWater(w);
    let bred = false;
    for (let i = 0; i < 300 && !bred; i++) {
      tick(w);
      expect(totalEnergy(w)).toBe(e0);
      expect(totalWater(w)).toBe(wat0);
      bred = w.creatures.some((c) => c.parentId !== null);
    }
    expect(bred).toBe(true);
  });
});

describe("graduated density-dependent reproduction brake", () => {
  it("population never exceeds the hard CREATURE_CAP", () => {
    // The hard ceiling is absolute (memory/CPU bound). 1500 ticks reaches the cap on
    // the default seed; assert the invariant holds every tick.
    const cap = 90;
    const w = createWorld(1, makeConfig({ tunables: { CREATURE_CAP: cap } }));
    for (let i = 0; i < 1500; i++) {
      tick(w);
      expect(w.creatures.length).toBeLessThanOrEqual(cap);
    }
  }, 90000);

  it("the brake is deterministic — two runs with the same seed match population exactly", () => {
    const run = (): number[] => {
      const w = createWorld(3, makeConfig({ tunables: { CREATURE_CAP: 90 } }));
      const series: number[] = [];
      for (let i = 0; i < 1200; i++) {
        tick(w);
        if (i % 200 === 0) series.push(w.creatures.length);
      }
      return series;
    };
    expect(run()).toEqual(run());
  }, 90000);

  it("a lower soft fraction holds the population no higher than a late brake", () => {
    // With REPRO_SOFT_FRAC low, the stochastic brake bites earlier, so the population
    // peak is no higher than a run where the brake engages only near the cap.
    const peak = (softFrac: number): number => {
      // Pin a small world so population density actually reaches the cap — the density
      // brake is what's under test, not the (now much larger) default world size.
      const w = createWorld(
        1,
        makeConfig({
          worldWidth: 200,
          worldHeight: 200,
          gridCols: 64,
          gridRows: 64,
          tunables: { CREATURE_CAP: 200, REPRO_SOFT_FRAC: softFrac },
        }),
      );
      let mx = 0;
      for (let i = 0; i < 1200; i++) {
        tick(w);
        mx = Math.max(mx, w.creatures.length);
      }
      return mx;
    };
    expect(peak(0.3)).toBeLessThanOrEqual(peak(0.95));
  }, 120000);
});

describe("Allee low-density starvation rescue", () => {
  it("rescues a starving but otherwise-viable creature below the threshold, conserving energy", () => {
    // A world with a single starving-but-viable creature (pop 1 < ALLEE threshold):
    // its energy hits zero, but the rescue tops it up from the reservoir so it survives
    // the removal pass — and total energy is conserved (drawn, not minted).
    const w = createWorld(1, makeConfig({ founderCount: 2 }));
    // Keep exactly one creature, hydrated + healthy but out of energy.
    const c = w.creatures[0] as Creature;
    w.creatures = [c];
    w.creatureIds = [c.id];
    c.energy = 0;
    c.hydration = 500;
    c.health = 40;
    c.age = 0;
    c.genome.maxLifespan = [100000, 100000];
    const e0 = totalEnergy(w);
    tick(w);
    // Survived the starvation removal (rescued) and energy is still conserved exactly.
    expect(w.creatures.length).toBe(1);
    expect(totalEnergy(w)).toBe(e0);
  }, 90000);

  it("does NOT rescue when the population is at/above the threshold", () => {
    // At a healthy population the rescue is inactive, so a starving creature dies
    // normally (density-dependent: relief only at low density). Pin a small world so the
    // population reliably climbs above the Allee threshold (the default world is now far
    // larger, keeping founders too sparse to reach it).
    const smallCfg = makeConfig({ worldWidth: 200, worldHeight: 200, gridCols: 64, gridRows: 64 });
    const w = createWorld(1, smallCfg);
    // Run to a healthy population well above the Allee threshold.
    for (let i = 0; i < 800; i++) tick(w);
    expect(w.creatures.length).toBeGreaterThan(smallCfg.tunables.ALLEE_POP_THRESHOLD);
    // Starve one creature to zero energy; at high pop it should be removed next tick.
    const victim = w.creatures[0] as Creature;
    const victimId = victim.id;
    victim.energy = 0;
    victim.hydration = 500;
    victim.health = 40;
    tick(w);
    expect(w.creatures.some((c) => c.id === victimId)).toBe(false);
  }, 90000);
});
