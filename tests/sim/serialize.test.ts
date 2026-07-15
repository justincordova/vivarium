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
  }, 60_000);

  it("writes version 1 and does not serialize the derived brain cache", () => {
    const w = createWorld(1, makeConfig({}));
    const blob = serialize(w);
    expect(blob.version).toBe(SAVE_VERSION);
    expect(blob.version).toBe(1);
    // Derived cache is absent from the blob; deserialized creatures have no `derived`.
    const round = deserialize(blob);
    for (const c of round.creatures) expect(c.derived).toBeUndefined();
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
  }, 60_000);
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
});
