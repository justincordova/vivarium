/**
 * commands.test.ts — the Phase 3 god-power World mutators (Task 3.1).
 *
 * The load-bearing property: every god-power preserves the closed ledgers exactly
 * (`totalEnergy`/`totalWater` integer-equal before and after — AND after a real tick,
 * proving the mutation left the world in a valid state the sim can advance). Node env.
 */

import { makeConfig } from "@sim/config";
import { ARROWS } from "@sim/constants";
import { expressTrait } from "@sim/genetics";
import { totalEnergy, totalWater } from "@sim/stats";
import { tick } from "@sim/tick";
import type { Creature } from "@sim/types";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";
import {
  applyDelete,
  applyEditGenome,
  applyPaint,
  applySetParam,
  applySpawn,
  cellIndexOf,
} from "../../src/worker/commands";
import type { SpawnSpec } from "../../src/worker/protocol";

const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({
  x: 100,
  y: 100,
  traits: { size: 3, diet: 0.2, speed: 4 },
  hue: 200,
  energy: 250,
  hydration: 120,
  ...over,
});

describe("applySpawn", () => {
  it("adds a creature and conserves both ledgers (now and after a tick)", () => {
    const world = createWorld(1, makeConfig({}));
    const e0 = totalEnergy(world);
    const w0 = totalWater(world);
    const n0 = world.creatures.length;

    const id = applySpawn(world, spec());
    expect(id).toBeGreaterThanOrEqual(0);
    expect(world.creatures.length).toBe(n0 + 1);
    expect(world.creatureIds).toContain(id);
    expect(totalEnergy(world)).toBe(e0);
    expect(totalWater(world)).toBe(w0);

    tick(world);
    expect(totalEnergy(world)).toBe(e0);
    expect(totalWater(world)).toBe(w0);
  });

  it("draws endowment from the reservoir/water — never mints", () => {
    const world = createWorld(2, makeConfig({}));
    const res0 = world.solarReservoir;
    applySpawn(world, spec({ energy: 200, hydration: 0 }));
    expect(world.solarReservoir).toBe(res0 - 200);
  });

  it("expresses the spec traits on the spawned creature", () => {
    const world = createWorld(1, makeConfig({}));
    const id = applySpawn(world, spec({ traits: { size: 7, diet: 0.9 } }));
    const c = world.creatures.find((cr) => cr.id === id) as Creature;
    expect(expressTrait(c.genome.size)).toBeCloseTo(7, 5);
    expect(expressTrait(c.genome.diet)).toBeCloseTo(0.9, 5);
  });
});

describe("applyDelete", () => {
  it("removes a creature and conserves both ledgers (now and after a tick)", () => {
    const world = createWorld(1, makeConfig({}));
    const e0 = totalEnergy(world);
    const w0 = totalWater(world);
    const victim = world.creatures[3] as Creature;
    const n0 = world.creatures.length;

    expect(applyDelete(world, victim.id)).toBe(true);
    expect(world.creatures.length).toBe(n0 - 1);
    expect(world.creatureIds).not.toContain(victim.id);
    expect(totalEnergy(world)).toBe(e0);
    expect(totalWater(world)).toBe(w0);

    tick(world);
    expect(totalEnergy(world)).toBe(e0);
    expect(totalWater(world)).toBe(w0);
  });

  it("returns false for an unknown id", () => {
    const world = createWorld(1, makeConfig({}));
    expect(applyDelete(world, 999999)).toBe(false);
  });
});

describe("applyEditGenome", () => {
  it("edits a trait allele, clamped to the legal range", () => {
    const world = createWorld(1, makeConfig({}));
    const c = world.creatures[0] as Creature;
    applyEditGenome(world, c.id, { kind: "trait", gene: "size", allele: 0, value: 999 });
    expect(c.genome.size[0]).toBe(10); // clamped to size max
    applyEditGenome(world, c.id, { kind: "trait", gene: "size", allele: 1, value: 2 });
    expect(c.genome.size[1]).toBe(2);
  });

  it("edits hue with wraparound", () => {
    const world = createWorld(1, makeConfig({}));
    const c = world.creatures[0] as Creature;
    applyEditGenome(world, c.id, { kind: "trait", gene: "hue", allele: 0, value: 370 });
    expect(c.genome.hue[0]).toBeCloseTo(10, 5);
  });

  it("edits a brain arrow, invalidates derived cache, and zeros hidden", () => {
    const world = createWorld(1, makeConfig({}));
    const c = world.creatures[0] as Creature;
    c.derived = { weights: new Float32Array(ARROWS), enabled: new Uint8Array(ARROWS) };
    c.hidden.fill(0.5);
    applyEditGenome(world, c.id, {
      kind: "arrow",
      arrow: 5,
      homolog: "A",
      weight: 1.25,
      enabled: 1,
    });
    expect(c.genome.weightsA[5]).toBe(1.25);
    expect(c.genome.enabledA[5]).toBe(1);
    expect(c.derived).toBeUndefined();
    expect(Array.from(c.hidden).every((v) => v === 0)).toBe(true);
  });

  it("conserves ledgers (edits touch no quanta)", () => {
    const world = createWorld(1, makeConfig({}));
    const e0 = totalEnergy(world);
    const w0 = totalWater(world);
    const c = world.creatures[0] as Creature;
    applyEditGenome(world, c.id, { kind: "trait", gene: "aggression", allele: 0, value: 5 });
    expect(totalEnergy(world)).toBe(e0);
    expect(totalWater(world)).toBe(w0);
  });

  it("rejects a non-finite trait value instead of poisoning the genome", () => {
    const world = createWorld(1, makeConfig({}));
    const c = world.creatures[0] as Creature;
    const before = c.genome.size[0] as number;
    expect(
      applyEditGenome(world, c.id, {
        kind: "trait",
        gene: "size",
        allele: 0,
        value: Number.NaN,
      }),
    ).toBe(false);
    expect(c.genome.size[0]).toBe(before);
    expect(Number.isFinite(c.genome.size[0] as number)).toBe(true);
  });

  it("rejects a non-finite brain-arrow weight (would desync the forward pass)", () => {
    const world = createWorld(1, makeConfig({}));
    const c = world.creatures[0] as Creature;
    const before = c.genome.weightsA[5] as number;
    expect(
      applyEditGenome(world, c.id, {
        kind: "arrow",
        arrow: 5,
        homolog: "A",
        weight: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
    expect(c.genome.weightsA[5]).toBe(before);
  });
});

describe("applyPaint", () => {
  it("fertility/light paint moves quanta to/from the reservoir (conserved)", () => {
    const world = createWorld(1, makeConfig({}));
    const e0 = totalEnergy(world);
    const cell = 100;
    applyPaint(world, "fertility", cell, +40, 0);
    expect(totalEnergy(world)).toBe(e0);
    applyPaint(world, "fertility", cell, -25, 0);
    expect(totalEnergy(world)).toBe(e0);
    tick(world);
    expect(totalEnergy(world)).toBe(e0);
  });

  it("water paint is a local redistribution — totalWater holds exactly (drought)", () => {
    const world = createWorld(1, makeConfig({}));
    const w0 = totalWater(world);
    const cell = cellIndexOf(world, 100, 100);
    const before = world.fields.water[cell] as number;
    applyPaint(world, "water", cell, -150, 1); // drought at the center
    expect(totalWater(world)).toBe(w0);
    expect(world.fields.water[cell] as number).toBeLessThan(before);
    tick(world);
    expect(totalWater(world)).toBe(w0);
  });

  it("water paint flood pulls from the ring into the center — totalWater holds", () => {
    const world = createWorld(1, makeConfig({}));
    const w0 = totalWater(world);
    const cell = cellIndexOf(world, 100, 100);
    const before = world.fields.water[cell] as number;
    applyPaint(world, "water", cell, +100, 1);
    expect(totalWater(world)).toBe(w0);
    expect(world.fields.water[cell] as number).toBeGreaterThan(before);
  });

  it("temperature paint sets the modulator directly (no ledger effect)", () => {
    const world = createWorld(1, makeConfig({}));
    const e0 = totalEnergy(world);
    const w0 = totalWater(world);
    const cell = cellIndexOf(world, 100, 100);
    applyPaint(world, "temperature", cell, +5, 0);
    expect(world.fields.temperature[cell] as number).toBeCloseTo(25, 5);
    expect(totalEnergy(world)).toBe(e0);
    expect(totalWater(world)).toBe(w0);
  });

  it("modulator paint quantizes a fractional delta (sim-read field stays integer)", () => {
    const world = createWorld(1, makeConfig({}));
    const cell = cellIndexOf(world, 100, 100);
    const before = world.fields.temperature[cell] as number;
    // A fractional delta must round (quantize-on-entry) — 2.6 → +3, not +2.6.
    applyPaint(world, "temperature", cell, 2.6, 0);
    expect(world.fields.temperature[cell] as number).toBeCloseTo(before + 3, 5);
  });
});

describe("applySetParam", () => {
  it("writes a tunable into world.config and changes sim behavior", () => {
    const world = createWorld(1, makeConfig({}));
    expect(applySetParam(world, "MUT_GLOBAL", 5)).toBe(true);
    expect(world.config.tunables.MUT_GLOBAL).toBe(5);
  });

  it("rejects unknown keys and non-finite values", () => {
    const world = createWorld(1, makeConfig({}));
    expect(applySetParam(world, "NOT_A_KEY", 1)).toBe(false);
    expect(applySetParam(world, "MUT_GLOBAL", Number.NaN)).toBe(false);
  });

  it("the new value survives serialization (defines the trajectory)", async () => {
    const world = createWorld(1, makeConfig({}));
    applySetParam(world, "MUT_GLOBAL", 3.5);
    const { serialize } = await import("@sim/serialize");
    const blob = serialize(world);
    expect(blob.config.tunables.MUT_GLOBAL).toBe(3.5);
  });
});
