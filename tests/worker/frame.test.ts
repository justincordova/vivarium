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
import { recordHistory } from "@sim/history";
import { tick } from "@sim/tick";
import type { Creature } from "@sim/types";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";
import {
  buildEventFeed,
  buildFlashes,
  buildRenderFrame,
  buildStats,
  buildTraitBins,
  dayLight,
  frameTransferables,
  MAX_FEED_EVENTS,
  populationByLineageRoot,
  TRAIT_BINS,
} from "../../src/worker/frame";
import type { CreatureFrame } from "../../src/worker/protocol";
import { FLASH_TICKS } from "../../src/worker/protocol";

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

  it("carries a per-cell water field normalized to 0..1 (drives the water shading)", () => {
    const world = createWorld(1, makeConfig({}));
    const frame = buildRenderFrame(world);
    expect(frame.water).toBeInstanceOf(Float32Array);
    expect(frame.water.length).toBe(world.config.gridCols * world.config.gridRows);
    for (let i = 0; i < frame.water.length; i++) {
      const w = frame.water[i] as number;
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
    // A world seeded with water should show at least one wet cell.
    expect(Array.from(frame.water).some((w) => w > 0)).toBe(true);
  });

  it("carries the per-cell authored biome map (drives the terrain render)", () => {
    const world = createWorld(1, makeConfig({}));
    const frame = buildRenderFrame(world);
    expect(frame.biome).toBeInstanceOf(Uint8Array);
    expect(frame.biome.length).toBe(world.config.gridCols * world.config.gridRows);
    expect(Array.from(frame.biome)).toEqual(Array.from(world.terrain.biome));
    for (let i = 0; i < frame.biome.length; i++) {
      expect(frame.biome[i]).toBeGreaterThanOrEqual(0);
      expect(frame.biome[i]).toBeLessThanOrEqual(4);
    }
  });

  it("carries nests as a struct-of-arrays (drives the nest render)", () => {
    const world = createWorld(1, makeConfig({}));
    world.nests = [
      { id: 1, x: 10, y: 20, lineage: 5, strength: world.config.tunables.NEST_MAX_STRENGTH },
      { id: 2, x: 30, y: 40, lineage: 5, strength: 0 },
    ];
    const frame = buildRenderFrame(world);
    expect(frame.nests.count).toBe(2);
    expect(frame.nests.x[0]).toBe(10);
    expect(frame.nests.y[0]).toBe(20);
    // strengthFrac is normalized against NEST_MAX_STRENGTH (full strength → 1).
    expect(frame.nests.strengthFrac[0]).toBeCloseTo(1, 5);
    expect(frame.nests.strengthFrac[1]).toBe(0);
    // Same lineage → same display hue; hue is a valid 0..360 value.
    expect(frame.nests.hue[0]).toBe(frame.nests.hue[1]);
    expect(frame.nests.hue[0] as number).toBeGreaterThanOrEqual(0);
    expect(frame.nests.hue[0] as number).toBeLessThan(360);
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

  // `parseHash` accepts any finite `t.TICKS_PER_DAY=` from a share URL (0 included) and
  // the config is autosaved, so a poisoned value persists. `tick % 0` is NaN, and NaN
  // survives every downstream clamp to reach the canvas as an invalid `rgba(...,NaN)`
  // fill — which the spec says to ignore, leaving the previous fillStyle and painting the
  // whole viewport opaque. The frame must never carry a light level that cannot be drawn.
  it("never emits a non-finite level for a degenerate TICKS_PER_DAY", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const l = dayLight(1234, bad);
      expect(Number.isFinite(l)).toBe(true);
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

describe("buildTimeline", () => {
  it("carries the downsampled population history + extinction ticks + now", () => {
    const world = createWorld(1, makeConfig({}));
    recordHistory(world); // t=0 baseline
    for (let i = 0; i < 300; i++) {
      tick(world);
      recordHistory(world);
    }
    const tl = buildStats(world).timeline;
    expect(tl.now).toBe(world.tick);
    // History samples every HISTORY_SAMPLE_INTERVAL → at least a few points over 300 ticks.
    expect(tl.points.length).toBeGreaterThanOrEqual(3);
    // Points are tick-ordered.
    for (let i = 1; i < tl.points.length; i++) {
      expect((tl.points[i] as { tick: number }).tick).toBeGreaterThanOrEqual(
        (tl.points[i - 1] as { tick: number }).tick,
      );
    }
    expect(Array.isArray(tl.extinctionTicks)).toBe(true);
  });
});

describe("buildEventFeed", () => {
  /** A world whose event log holds one of every shape the feed must handle. */
  function seededWorld() {
    const world = createWorld(1, makeConfig({}));
    world.eventLog.length = 0;
    world.lineageEvents.length = 0;
    return world;
  }

  it("narrates only notable events — births and kills are filtered out", () => {
    const world = seededWorld();
    world.eventLog.push(
      { tick: 10, event: "birth:5" },
      { tick: 11, event: "kill:7" },
      { tick: 12, event: "extinct" },
    );
    const feed = buildEventFeed(world);
    expect(feed.map((e) => e.kind)).toEqual(["silence"]);
  });

  it("sites a home event with a plain-language place and a lineage hue", () => {
    const world = seededWorld();
    world.eventLog.push({ tick: 20, event: "nest:3:100:100" });
    const [ev] = buildEventFeed(world);
    expect(ev?.kind).toBe("home");
    expect(ev?.lineage).toBe(3);
    expect(ev?.hue).toBeGreaterThanOrEqual(0);
    expect(ev?.hue).toBeLessThan(360);
    // y=100 of a 1000-tall world is the northern third.
    expect(ev?.place).toMatch(/^the northern /);
  });

  it("tolerates the pre-position `nest:<root>` form still present in saved logs", () => {
    const world = seededWorld();
    world.eventLog.push({ tick: 20, event: "nest:3" });
    const [ev] = buildEventFeed(world);
    expect(ev?.kind).toBe("home");
    expect(ev?.lineage).toBe(3);
    expect(ev?.place).toBe(""); // no site, but still narratable
  });

  it("merges typed lineage events and orders the whole feed by tick", () => {
    const world = seededWorld();
    world.eventLog.push({ tick: 30, event: "nest:1:10:10" });
    world.lineageEvents.push(
      { kind: "lineageBoom", tick: 10, lineage: 2, factor: 2.5 },
      { kind: "extinction", tick: 20, lineage: 4 },
      { kind: "newDominant", tick: 40, lineage: 2 },
    );
    const feed = buildEventFeed(world);
    expect(feed.map((e) => e.tick)).toEqual([10, 20, 30, 40]);
    expect(feed.map((e) => e.kind)).toEqual(["boom", "extinction", "home", "dominant"]);
    expect(feed[0]?.factor).toBe(2.5);
  });

  it("keeps the most recent MAX_FEED_EVENTS and stays stable across rebuilds", () => {
    const world = seededWorld();
    for (let i = 0; i < MAX_FEED_EVENTS + 25; i++) {
      world.eventLog.push({ tick: i, event: `nest:${i}:10:10` });
    }
    const feed = buildEventFeed(world);
    expect(feed.length).toBe(MAX_FEED_EVENTS);
    // Truncation drops the OLDEST, so the newest event must survive.
    expect(feed[feed.length - 1]?.tick).toBe(MAX_FEED_EVENTS + 24);
    // The feed is rebuilt from scratch each stats tick; a wobbling order would flicker
    // the UI, so the same World must always produce the same keys in the same order.
    expect(buildEventFeed(world).map((e) => e.key)).toEqual(feed.map((e) => e.key));
  });

  it("gives every event a key unique enough to use as a React key", () => {
    const world = createWorld(1, makeConfig({}));
    for (let i = 0; i < 400; i++) {
      tick(world);
      recordHistory(world);
    }
    const feed = buildEventFeed(world);
    expect(new Set(feed.map((e) => e.key)).size).toBe(feed.length);
  });
});

describe("buildFlashes", () => {
  it("carries only births/kills inside the flash window, with age since the event", () => {
    const world = createWorld(1, makeConfig({}));
    world.eventLog.length = 0;
    world.tick = 100;
    world.eventLog.push(
      { tick: 100 - FLASH_TICKS - 1, event: "kill:1:10:10" }, // too old
      { tick: 96, event: "kill:2:20:20" },
      { tick: 99, event: "birth:3:30:30" },
    );
    const f = buildFlashes(world);
    expect(f.count).toBe(2);
    // Scanned newest-first, so the most recent event leads.
    expect(Array.from(f.kind)).toEqual([0, 1]); // birth, then kill
    expect(Array.from(f.age)).toEqual([1, 4]);
    expect(Array.from(f.x)).toEqual([30, 20]);
  });

  it("ignores events that carry no position rather than marking the origin", () => {
    const world = createWorld(1, makeConfig({}));
    world.eventLog.length = 0;
    world.tick = 10;
    // The pre-position form, still present in saved logs. A mark at (0,0) would be a lie.
    world.eventLog.push({ tick: 10, event: "kill:1" }, { tick: 10, event: "birth:2" });
    expect(buildFlashes(world).count).toBe(0);
  });

  it("ignores non-birth/kill entries", () => {
    const world = createWorld(1, makeConfig({}));
    world.eventLog.length = 0;
    world.tick = 10;
    world.eventLog.push({ tick: 10, event: "nest:1:5:5" }, { tick: 10, event: "extinct" });
    expect(buildFlashes(world).count).toBe(0);
  });

  it("is included in the render frame and its buffers are transferable", () => {
    const world = createWorld(1, makeConfig({}));
    for (let i = 0; i < 60; i++) tick(world);
    const frame = buildRenderFrame(world);
    expect(frame.flashes.count).toBeGreaterThanOrEqual(0);
    expect(frame.flashes.x.length).toBe(frame.flashes.count);
    const transfers = frameTransferables(frame);
    expect(transfers).toContain(frame.flashes.x.buffer);
    expect(transfers).toContain(frame.flashes.kind.buffer);
  });
});

describe("buildEventFeed — home coalescing", () => {
  it("collapses a lineage's burst of home-founding into its first report", () => {
    const world = createWorld(1, makeConfig({}));
    world.eventLog.length = 0;
    world.lineageEvents.length = 0;
    // One lineage founding five homes in quick succession is one story.
    for (const t of [100, 150, 200, 260, 300]) {
      world.eventLog.push({ tick: t, event: `nest:9:50:50` });
    }
    const feed = buildEventFeed(world);
    expect(feed.length).toBe(1);
    expect(feed[0]?.tick).toBe(100);
  });

  it("still reports a later home once the lineage has been quiet", () => {
    const world = createWorld(1, makeConfig({}));
    world.eventLog.length = 0;
    world.lineageEvents.length = 0;
    world.eventLog.push(
      { tick: 100, event: "nest:9:50:50" },
      { tick: 5000, event: "nest:9:50:50" },
    );
    expect(buildEventFeed(world).map((e) => e.tick)).toEqual([100, 5000]);
  });

  it("coalesces per lineage, not globally", () => {
    const world = createWorld(1, makeConfig({}));
    world.eventLog.length = 0;
    world.lineageEvents.length = 0;
    world.eventLog.push(
      { tick: 100, event: "nest:1:50:50" },
      { tick: 101, event: "nest:2:50:50" },
      { tick: 102, event: "nest:3:50:50" },
    );
    expect(buildEventFeed(world).map((e) => e.lineage)).toEqual([1, 2, 3]);
  });

  it("stops home spam from evicting rare lineage drama from the feed", () => {
    const world = createWorld(1, makeConfig({}));
    world.eventLog.length = 0;
    world.lineageEvents.length = 0;
    world.lineageEvents.push({ kind: "extinction", tick: 1, lineage: 77 });
    // Far more home events than the feed can hold, all from one lineage.
    for (let t = 2; t < 2 + MAX_FEED_EVENTS * 3; t++) {
      world.eventLog.push({ tick: t, event: "nest:9:50:50" });
    }
    const feed = buildEventFeed(world);
    // Without coalescing the extinction would be truncated away as the oldest entry.
    expect(feed.some((e) => e.kind === "extinction")).toBe(true);
  });
});
