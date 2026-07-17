/**
 * frame.test.ts — the worker frame/stats builders + the frame↔palette CONTRACT.
 *
 * The contract (Phase 2 plan Task 2A.1): the `frame` payload must carry every field
 * `render/palette.ts` consumes. `CreatureFrame` in `protocol.ts` is the single
 * source of truth for that appearance channel set; the palette (Task 2B.1) is typed
 * to read exactly these arrays. This test pins the channel set so a future edit that
 * drops (say) `toxicity` from the frame fails here instead of silently breaking the
 * renderer. Node env (pure functions + a live World; no Worker, no DOM).
 */

import { makeConfig } from "@sim/config";
import { tick } from "@sim/tick";
import type { Creature } from "@sim/types";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";
import {
  buildRenderFrame,
  buildStats,
  buildTraitBins,
  dayLight,
  frameTransferables,
  populationByLineageRoot,
  TRAIT_BINS,
} from "../../src/worker/frame";
import type { CreatureFrame } from "../../src/worker/protocol";

/**
 * The appearance channels the SPEC.md §Visual Design table derives, minus geometry
 * (x/y/heading/ids). If the palette needs a new gene channel, add it to BOTH the
 * frame and this list — that is the contract this test enforces.
 */
const REQUIRED_APPEARANCE_CHANNELS = [
  "hue",
  "size",
  "energyFrac",
  "diet",
  "armor",
  "toxicity",
  "age",
] as const satisfies readonly (keyof CreatureFrame)[];

describe("frame↔palette contract", () => {
  it("the render frame carries every appearance channel the palette consumes", () => {
    const world = createWorld(1, makeConfig({}));
    for (let i = 0; i < 50; i++) tick(world);
    const frame = buildRenderFrame(world);

    expect(frame.creatures.count).toBe(world.creatures.length);
    for (const ch of REQUIRED_APPEARANCE_CHANNELS) {
      const arr = frame.creatures[ch];
      expect(arr, `frame missing channel ${ch}`).toBeInstanceOf(Float32Array);
      expect(arr.length).toBe(frame.creatures.count);
    }
    // Geometry + identity present for hit-testing and drawing.
    expect(frame.creatures.ids).toBeInstanceOf(Int32Array);
    expect(frame.creatures.x.length).toBe(frame.creatures.count);
    expect(frame.creatures.y.length).toBe(frame.creatures.count);
    expect(frame.creatures.heading.length).toBe(frame.creatures.count);
  });

  it("expressed channels equal the mean of the diploid alleles", () => {
    const world = createWorld(7, makeConfig({}));
    const frame = buildRenderFrame(world);
    const c0 = world.creatures[0] as Creature;
    const meanHue = (c0.genome.hue[0] + c0.genome.hue[1]) / 2;
    expect(frame.creatures.hue[0]).toBeCloseTo(meanHue, 4);
    const meanDiet = (c0.genome.diet[0] + c0.genome.diet[1]) / 2;
    expect(frame.creatures.diet[0]).toBeCloseTo(meanDiet, 4);
  });

  it("energyFrac is a 0..1 fraction of maxEnergy", () => {
    const world = createWorld(3, makeConfig({}));
    const frame = buildRenderFrame(world);
    for (let i = 0; i < frame.creatures.count; i++) {
      const f = frame.creatures.energyFrac[i] as number;
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it("carries world dims and a day/night light level in 0..1", () => {
    const world = createWorld(1, makeConfig({}));
    const frame = buildRenderFrame(world);
    expect(frame.worldWidth).toBe(world.config.worldWidth);
    expect(frame.worldHeight).toBe(world.config.worldHeight);
    expect(frame.light).toBeGreaterThanOrEqual(0);
    expect(frame.light).toBeLessThanOrEqual(1);
  });
});

describe("dayLight", () => {
  it("peaks at day start and troughs at half-day", () => {
    const D = 1000;
    expect(dayLight(0, D)).toBeCloseTo(1, 5);
    expect(dayLight(D / 2, D)).toBeCloseTo(0, 5);
    expect(dayLight(D, D)).toBeCloseTo(1, 5); // wraps
  });
  it("stays within 0..1 across a full day", () => {
    for (let tk = 0; tk < 1000; tk += 37) {
      const l = dayLight(tk, 1000);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1);
    }
  });
});

describe("frameTransferables", () => {
  it("lists a distinct ArrayBuffer per typed-array channel", () => {
    const world = createWorld(1, makeConfig({}));
    const frame = buildRenderFrame(world);
    const buffers = frameTransferables(frame);
    expect(buffers.every((b) => b instanceof ArrayBuffer)).toBe(true);
    // No buffer listed twice (double-transfer throws in structured clone).
    expect(new Set(buffers).size).toBe(buffers.length);
  });
});

describe("populationByLineageRoot", () => {
  it("founders are their own root; roots trace back through parent death", () => {
    const world = createWorld(1, makeConfig({}));
    const counts0 = populationByLineageRoot(world);
    // Every founder maps to itself → one creature per root at t0.
    const total0 = Object.values(counts0).reduce((a, b) => a + b, 0);
    expect(total0).toBe(world.creatures.length);
    for (const c of world.creatures) {
      expect(world.lineageRoots[c.id]).toBe(c.id);
    }
    // Run: births inherit their parent's root; roots stay bounded by founder count.
    for (let i = 0; i < 300; i++) tick(world);
    const counts = populationByLineageRoot(world);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(world.creatures.length);
    // Never more distinct roots than founders (all lineages trace to a founder).
    expect(Object.keys(counts).length).toBeLessThanOrEqual(world.config.founderCount);
  });
});

describe("buildTraitBins", () => {
  it("produces a TRAIT_BINS-length histogram per gene summing to the population", () => {
    const world = createWorld(5, makeConfig({}));
    const bins = buildTraitBins(world);
    expect(bins.size).toBeInstanceOf(Array); // 'size' gene exists
    for (const gene of Object.keys(bins)) {
      const h = bins[gene] as number[];
      expect(h.length).toBe(TRAIT_BINS);
      const sum = h.reduce((a, b) => a + b, 0);
      expect(sum).toBe(world.creatures.length);
    }
  });
});

describe("buildStats", () => {
  it("assembles world-health + lineage populations + trait bins", () => {
    const world = createWorld(1, makeConfig({}));
    for (let i = 0; i < 120; i++) tick(world);
    const stats = buildStats(world);
    expect(stats.tick).toBe(world.tick);
    expect(stats.survivalTicks).toBe(world.tick);
    expect(stats.speciesCount).toBeGreaterThanOrEqual(0);
    expect(Object.keys(stats.traits).length).toBeGreaterThan(0);
    const popTotal = Object.values(stats.population).reduce((a, b) => a + b, 0);
    expect(popTotal).toBe(world.creatures.length);
  });
});
