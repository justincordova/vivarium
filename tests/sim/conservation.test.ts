import {
  type Compartment,
  cellCompartment,
  fieldCompartment,
  toQuantum,
  transfer,
  transferUpTo,
} from "@sim/energy";
import { totalEnergy, totalWater } from "@sim/stats";
import type { Corpse, Creature, Plant, World } from "@sim/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

// ── Minimal static-world builder (no tick yet; just compartments to sum) ────────

function makeFields(cells: number, light: number, fertility: number, water: number) {
  return {
    light: new Int32Array(cells).fill(light),
    fertility: new Int32Array(cells).fill(fertility),
    water: new Int32Array(cells).fill(water),
    temperature: new Float32Array(cells).fill(20),
    scent: new Float32Array(cells).fill(0),
  };
}

function stubCreature(id: number, energy: number, hydration: number): Creature {
  return {
    id,
    parentId: null,
    x: 0,
    y: 0,
    heading: 0,
    vx: 0,
    vy: 0,
    energy,
    hydration,
    health: 10,
    age: 0,
    // biome-ignore lint/suspicious/noExplicitAny: genome shape irrelevant to ledger sums
    genome: {} as any,
    hidden: new Float32Array(0),
    ruleState: { mode: "wander", targetId: -1, targetKind: "none", committedTicks: 0 },
    actionWindow: new Float32Array(7),
  };
}

function stubPlant(id: number, energy: number): Plant {
  // biome-ignore lint/suspicious/noExplicitAny: genome shape irrelevant to ledger sums
  return { id, parentId: null, x: 0, y: 0, energy, age: 0, genome: {} as any };
}

function stubCorpse(id: number, energy: number): Corpse {
  return { id, x: 0, y: 0, energy };
}

function makeWorld(opts: {
  solar: number;
  creatures: Creature[];
  plants: Plant[];
  corpses: Corpse[];
  cells: number;
  light: number;
  fertility: number;
  water: number;
}): World {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: config irrelevant to ledger sums
    config: {} as any,
    tick: 0,
    solarReservoir: opts.solar,
    creatures: opts.creatures,
    plants: opts.plants,
    corpses: opts.corpses,
    creatureIds: opts.creatures.map((c) => c.id),
    nextId: 1000,
    fields: makeFields(opts.cells, opts.light, opts.fertility, opts.water),
    terrain: {
      biome: new Uint8Array(opts.cells).fill(1 /* Grassland */),
      elevation: new Float32Array(opts.cells),
    },
    // biome-ignore lint/suspicious/noExplicitAny: rng irrelevant to ledger sums
    rng: {} as any,
    eventLog: [],
    history: [],
    lineageRoots: {},
    lineageEvents: [],
    dominant: null,
    rootPopSnapshots: [],
    lastSavedRealTime: 0,
  };
}

// ── totalEnergy / totalWater over a random static world ─────────────────────────

describe("stats — totalEnergy / totalWater equal the hand-summed compartments", () => {
  it("totalEnergy sums solar + creatures + plants + corpses + fertility + light", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000 }),
        fc.array(fc.record({ e: fc.nat(1000), h: fc.nat(1000) }), { maxLength: 30 }),
        fc.array(fc.nat(1000), { maxLength: 30 }),
        fc.array(fc.nat(1000), { maxLength: 30 }),
        fc.integer({ min: 1, max: 64 }),
        fc.nat(500),
        fc.nat(500),
        fc.nat(500),
        (solar, cs, ps, xs, cells, light, fertility, water) => {
          const creatures = cs.map((c, i) => stubCreature(i, c.e, c.h));
          const plants = ps.map((e, i) => stubPlant(i, e));
          const corpses = xs.map((e, i) => stubCorpse(i, e));
          const world = makeWorld({
            solar,
            creatures,
            plants,
            corpses,
            cells,
            light,
            fertility,
            water,
          });

          const handEnergy =
            solar +
            cs.reduce((a, c) => a + c.e, 0) +
            ps.reduce((a, e) => a + e, 0) +
            xs.reduce((a, e) => a + e, 0) +
            fertility * cells +
            light * cells;
          const handWater = water * cells + cs.reduce((a, c) => a + c.h, 0);

          expect(totalEnergy(world)).toBe(handEnergy);
          expect(totalWater(world)).toBe(handWater);
        },
      ),
    );
  });

  it("water excludes corpses and plants by construction", () => {
    const world = makeWorld({
      solar: 100,
      creatures: [stubCreature(0, 10, 7)],
      plants: [stubPlant(0, 50)],
      corpses: [stubCorpse(0, 40)],
      cells: 4,
      light: 0,
      fertility: 0,
      water: 3,
    });
    // Water is only field (3*4=12) + creature hydration (7) = 19, regardless of
    // plant/corpse energy.
    expect(totalWater(world)).toBe(19);
  });
});

// ── transfer helpers: round-trip conserves, rejects over-transfer / mint ─────────

describe("energy — transfer guards conservation", () => {
  function pair(a: number, b: number): [Record<"v", number>, Record<"v", number>] {
    return [{ v: a }, { v: b }];
  }

  it("transfer moves exactly qty and conserves the two-compartment sum", () => {
    fc.assert(
      fc.property(fc.nat(1000), fc.nat(1000), fc.nat(1000), (a, b, rawQty) => {
        const [src, dst] = pair(a, b);
        const from = fieldCompartment(src, "v");
        const to = fieldCompartment(dst, "v");
        const qty = Math.min(rawQty, a); // legal amount
        const before = src.v + dst.v;
        const moved = transfer(from, to, qty);
        expect(moved).toBe(qty);
        expect(src.v + dst.v).toBe(before); // conserved
        expect(src.v).toBe(a - qty);
        expect(dst.v).toBe(b + qty);
        expect(src.v).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("transfer rejects over-transfer (would overdraw source below zero)", () => {
    const [src, dst] = pair(5, 0);
    const from = fieldCompartment(src, "v");
    const to = fieldCompartment(dst, "v");
    expect(() => transfer(from, to, 6)).toThrow(/overdraw/);
    // No partial mutation on rejection.
    expect(src.v).toBe(5);
    expect(dst.v).toBe(0);
  });

  it("transfer rejects negative and non-integer qty (cannot mint or fractionally leak)", () => {
    const [src, dst] = pair(10, 0);
    const from = fieldCompartment(src, "v");
    const to = fieldCompartment(dst, "v");
    expect(() => transfer(from, to, -1)).toThrow(/non-negative/);
    expect(() => transfer(from, to, 1.5)).toThrow(/integer/);
    expect(src.v).toBe(10);
    expect(dst.v).toBe(0);
  });

  it("transferUpTo saturates at source and stays conservative", () => {
    const [src, dst] = pair(3, 0);
    const from = fieldCompartment(src, "v");
    const to = fieldCompartment(dst, "v");
    const moved = transferUpTo(from, to, 10);
    expect(moved).toBe(3);
    expect(src.v).toBe(0);
    expect(dst.v).toBe(3);
  });

  it("works across a field-array cell and an object field (heterogeneous compartments)", () => {
    const arr = new Int32Array([20, 0]);
    const obj = { energy: 5 };
    const cell: Compartment = cellCompartment(arr, 0);
    const objComp = fieldCompartment(obj, "energy");
    const before = (arr[0] as number) + obj.energy;
    transfer(cell, objComp, 8);
    expect(arr[0]).toBe(12);
    expect(obj.energy).toBe(13);
    expect((arr[0] as number) + obj.energy).toBe(before);
  });
});

describe("energy — toQuantum", () => {
  it("rounds (not floor/ceil) so ledger entry is the single pinned rule", () => {
    expect(toQuantum(2.4)).toBe(2);
    expect(toQuantum(2.5)).toBe(3);
    expect(toQuantum(2.6)).toBe(3);
    expect(toQuantum(-2.5)).toBe(-2); // Math.round half-up toward +∞
  });
});
