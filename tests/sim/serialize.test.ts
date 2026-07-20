import { makeConfig } from "@sim/config";
import { deserialize, SAVE_VERSION, serialize } from "@sim/serialize";
import { totalEnergy, totalWater } from "@sim/stats";
import { tick } from "@sim/tick";
import type { World } from "@sim/types";
import { createWorld } from "@sim/world";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

function fingerprint(w: World): string {
  const parts: string[] = [String(w.tick), String(w.solarReservoir), String(w.nextId)];
  for (const c of w.creatures) {
    parts.push(
      `${c.id}:${c.x}:${c.y}:${c.heading}:${c.energy}:${c.hydration}:${c.health}:${c.age}:${Array.from(c.hidden).join(",")}:${c.ruleState.mode}:${c.ruleState.targetId}`,
    );
    parts.push(`W:${Array.from(c.genome.weightsA).join(",")}`);
  }
  for (const p of w.plants) parts.push(`P${p.id}:${p.x}:${p.y}:${p.energy}:${p.age}`);
  for (const co of w.corpses) parts.push(`C${co.id}:${co.energy}`);
  parts.push(`RNG:${JSON.stringify(w.rng.motion.state)}:${w.rng.mutation.state}`);
  return parts.join("|");
}

describe("serialize — roundtrip identity", () => {
  it("deserialize(serialize(world)) reproduces the world (fingerprint)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100000 }),
        fc.integer({ min: 0, max: 50 }),
        (seed, n) => {
          const w = createWorld(seed, makeConfig({}));
          for (let i = 0; i < n; i++) tick(w);
          const round = deserialize(serialize(w));
          expect(fingerprint(round)).toBe(fingerprint(w));
          expect(totalEnergy(round)).toBe(totalEnergy(w));
          expect(totalWater(round)).toBe(totalWater(w));
        },
      ),
      { numRuns: 20 },
    );
  }, 120_000);

  it("writes the current version and does not serialize the derived brain cache", () => {
    const w = createWorld(1, makeConfig({}));
    const blob = serialize(w);
    expect(blob.version).toBe(SAVE_VERSION);
    expect(blob.version).toBe(4); // v2 brainKind, v3 lineage events, v4 terrain (Living World)
    // Derived cache is absent from the blob; deserialized creatures have no `derived`.
    const round = deserialize(blob);
    for (const c of round.creatures) expect(c.derived).toBeUndefined();
  });
});

describe("serialize — v1 → v2 migration (Phase 4 brainKind)", () => {
  it("a v1 rule-based save (no brainKind) migrates, loads, and defaults to 'rule'", () => {
    const w = createWorld(5, makeConfig({}));
    for (let i = 0; i < 50; i++) tick(w);
    // Simulate a genuine v1 blob: version 1, config missing brainKind.
    const blob = serialize(w);
    // biome-ignore lint/suspicious/noExplicitAny: intentionally degrade to a v1 shape
    const v1 = { ...blob, version: 1, config: { ...blob.config } } as any;
    v1.config.brainKind = undefined;

    const round = deserialize(v1);
    expect(round.config.brainKind).toBe("rule");
    expect(round.creatures.length).toBe(w.creatures.length);
  });

  it("a v2 save (no lineage fields) migrates to v3 with defaulted lineage state", () => {
    const w = createWorld(6, makeConfig({}));
    for (let i = 0; i < 50; i++) tick(w);
    const blob = serialize(w);
    // Simulate a v2 blob: strip the Phase-5A.3 fields and set version 2.
    // biome-ignore lint/suspicious/noExplicitAny: intentionally degrade to a v2 shape
    const v2 = { ...blob, version: 2 } as any;
    v2.lineageRoots = undefined;
    v2.lineageEvents = undefined;
    v2.dominant = undefined;
    v2.rootPopSnapshots = undefined;

    const round = deserialize(v2);
    expect(round.lineageRoots).toEqual({});
    expect(round.lineageEvents).toEqual([]);
    expect(round.dominant).toBeNull();
    expect(round.rootPopSnapshots).toEqual([]);
    expect(round.creatures.length).toBe(w.creatures.length);
  });

  it("a v3 roundtrip preserves lineage roots + typed events", () => {
    const w = createWorld(8, makeConfig({}));
    // Run long enough to accumulate lineage roots (births) and history samples.
    for (let i = 0; i < 400; i++) tick(w);
    const round = deserialize(serialize(w));
    expect(round.lineageRoots).toEqual(w.lineageRoots);
    expect(round.lineageEvents).toEqual(w.lineageEvents);
    expect(round.dominant).toEqual(w.dominant);
  });

  it("a migrated v1 save stays deterministic + conservative for N ticks", () => {
    const w = createWorld(9, makeConfig({}));
    for (let i = 0; i < 30; i++) tick(w);
    const blob = serialize(w);
    // biome-ignore lint/suspicious/noExplicitAny: v1 shape
    const v1 = { ...blob, version: 1, config: { ...blob.config } } as any;
    v1.config.brainKind = undefined;

    const a = deserialize(v1);
    const b = deserialize(v1);
    const e0 = totalEnergy(a);
    const wat0 = totalWater(a);
    for (let i = 0; i < 200; i++) {
      tick(a);
      tick(b);
      expect(totalEnergy(a)).toBe(e0);
      expect(totalWater(a)).toBe(wat0);
    }
    const fa = a.creatures.map((c) => `${c.id}:${c.x}:${c.energy}`).join("|");
    const fb = b.creatures.map((c) => `${c.id}:${c.x}:${c.energy}`).join("|");
    expect(fa).toBe(fb);
  });
});

describe("serialize — the free determinism double-check", () => {
  it("500 → serialize → deserialize → 500 equals a straight 1000-tick run", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), (seed) => {
        const straight = createWorld(seed, makeConfig({}));
        for (let i = 0; i < 1000; i++) tick(straight);

        const split = createWorld(seed, makeConfig({}));
        for (let i = 0; i < 500; i++) tick(split);
        const resumed = deserialize(serialize(split));
        for (let i = 0; i < 500; i++) tick(resumed);

        expect(fingerprint(resumed)).toBe(fingerprint(straight));
      }),
      { numRuns: 2 },
    );
  }, 120_000);
});

describe("serialize — forward-compatible defaulting", () => {
  it("a blob with an omitted field still deserializes (default applied)", () => {
    const w = createWorld(3, makeConfig({}));
    const blob = serialize(w);
    // Simulate an older/partial blob: drop history + lastSavedRealTime + a creature's
    // hidden vector.
    // biome-ignore lint/suspicious/noExplicitAny: intentionally degrade the blob
    const partial = { ...blob } as any;
    partial.history = undefined;
    partial.lastSavedRealTime = undefined;
    if (partial.creatures[0]) partial.creatures[0].hidden = undefined;

    const round = deserialize(partial);
    expect(round.history).toEqual([]);
    expect(round.lastSavedRealTime).toBe(0);
    expect(round.creatures[0]?.hidden).toHaveLength(w.config.hidden);
  });

  it("a versionless blob is migrated to the current version", () => {
    const w = createWorld(3, makeConfig({}));
    // biome-ignore lint/suspicious/noExplicitAny: simulate a pre-versioning blob
    const blob = { ...serialize(w) } as any;
    blob.version = undefined;
    const round = deserialize(blob);
    expect(round.creatures.length).toBe(w.creatures.length);
  });

  it("round-trips terrain exactly (biome + elevation)", () => {
    const w = createWorld(11, makeConfig({}));
    const round = deserialize(serialize(w));
    expect(Array.from(round.terrain.biome)).toEqual(Array.from(w.terrain.biome));
    expect(Array.from(round.terrain.elevation)).toEqual(Array.from(w.terrain.elevation));
  });

  it("a v3 blob (no terrain) migrates to v4 with flat grassland terrain", () => {
    const w = createWorld(5, makeConfig({}));
    // biome-ignore lint/suspicious/noExplicitAny: simulate a pre-terrain v3 blob
    const blob = { ...serialize(w) } as any;
    blob.version = 3;
    blob.terrain = undefined;
    const round = deserialize(blob);
    const cells = w.config.gridCols * w.config.gridRows;
    expect(round.terrain.biome.length).toBe(cells);
    // All grassland (Biome.Grassland === 1), flat elevation.
    expect(Array.from(round.terrain.biome).every((b) => b === 1)).toBe(true);
    expect(Array.from(round.terrain.elevation).every((e) => e === 0)).toBe(true);
  });
});
