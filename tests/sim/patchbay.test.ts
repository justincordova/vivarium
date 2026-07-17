/**
 * patchbay.test.ts — Phase 4 Task 4.2 verification: the config-selectable patchbay
 * brain runs a full world that is deterministic and conservation-valid, and an old
 * rule-based save switched to the patchbay brain runs correctly (the first time real
 * forward-pass dynamics drive inherited brain arrays).
 */

import { makeConfig } from "@sim/config";
import { deserialize, serialize } from "@sim/serialize";
import { totalEnergy, totalWater } from "@sim/stats";
import { tick } from "@sim/tick";
import type { World } from "@sim/types";
import { createWorld } from "@sim/world";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

/** Structural fingerprint including hidden state (recurrence is determinism-critical). */
function fingerprint(w: World): string {
  const parts: string[] = [String(w.tick), String(w.solarReservoir), String(w.nextId)];
  for (const c of w.creatures) {
    parts.push(
      `${c.id}:${c.x}:${c.y}:${c.heading}:${c.energy}:${c.hydration}:${c.health}:${c.age}:${Array.from(c.hidden).join(",")}`,
    );
  }
  for (const p of w.plants) parts.push(`P${p.id}:${p.x}:${p.y}:${p.energy}`);
  return parts.join("|");
}

describe("patchbay brain — config switch runs a real world", () => {
  it("a brainKind:'patchbay' world advances and keeps a live population", () => {
    const w = createWorld(1, makeConfig({ brainKind: "patchbay" }));
    for (let i = 0; i < 500; i++) tick(w);
    expect(w.tick).toBe(500);
    // The seed wiring lets founders forage/mate, so the population does not immediately
    // collapse (a random-noise brain would fail to bootstrap the sexual population).
    expect(w.creatures.length).toBeGreaterThan(0);
  });

  it("populates and reuses the derived-brain cache (recurrent hidden state moves)", () => {
    const w = createWorld(2, makeConfig({ brainKind: "patchbay" }));
    for (let i = 0; i < 20; i++) tick(w);
    const c = w.creatures[0];
    expect(c).toBeDefined();
    if (c) {
      // The forward pass derives-and-caches on first think.
      expect(c.derived).toBeDefined();
      // Recurrence: at least one creature has a non-zero hidden vector after 20 ticks.
      const anyHidden = w.creatures.some((cr) => Array.from(cr.hidden).some((v) => v !== 0));
      expect(anyHidden).toBe(true);
    }
  });
});

describe("patchbay brain — determinism (the load-bearing gate)", () => {
  it("two 500-tick patchbay runs from the same seed are bit-identical", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), (seed) => {
        const a = createWorld(seed, makeConfig({ brainKind: "patchbay" }));
        const b = createWorld(seed, makeConfig({ brainKind: "patchbay" }));
        for (let i = 0; i < 500; i++) {
          tick(a);
          tick(b);
        }
        expect(fingerprint(a)).toBe(fingerprint(b));
      }),
      { numRuns: 3 },
    );
  }, 120_000);
});

describe("patchbay brain — conservation (exact, every tick)", () => {
  it("totalEnergy and totalWater are invariant across 500 patchbay ticks", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), (seed) => {
        const w = createWorld(seed, makeConfig({ brainKind: "patchbay" }));
        const e0 = totalEnergy(w);
        const wat0 = totalWater(w);
        for (let i = 0; i < 500; i++) {
          tick(w);
          expect(totalEnergy(w)).toBe(e0);
          expect(totalWater(w)).toBe(wat0);
        }
      }),
      { numRuns: 3 },
    );
  }, 120_000);
});

describe("patchbay brain — enlargement geometry (HIDDEN=20 fresh world)", () => {
  it("a HIDDEN=20 fresh world sizes brain arrays to 900 arrows and a 20-vector", () => {
    const w = createWorld(1, makeConfig({ brainKind: "patchbay", hidden: 20 }));
    const c = w.creatures[0];
    expect(c).toBeDefined();
    if (c) {
      // arrowCount(20) = 18*20 + 20*20 + 20*7 = 900.
      expect(c.genome.weightsA).toHaveLength(900);
      expect(c.genome.enabledA).toHaveLength(900);
      expect(c.hidden).toHaveLength(20);
    }
  });

  it("a HIDDEN=20 patchbay world stays deterministic + conservative for N ticks", () => {
    const a = createWorld(3, makeConfig({ brainKind: "patchbay", hidden: 20 }));
    const b = createWorld(3, makeConfig({ brainKind: "patchbay", hidden: 20 }));
    const e0 = totalEnergy(a);
    const wat0 = totalWater(a);
    for (let i = 0; i < 300; i++) {
      tick(a);
      tick(b);
      expect(totalEnergy(a)).toBe(e0);
      expect(totalWater(a)).toBe(wat0);
    }
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});

describe("patchbay brain — inherited brain arrays run under the swap", () => {
  it("a rule-world save switched to patchbay stays deterministic + conservative", () => {
    // Build a rule world, evolve it (brain arrays inherited but never exercised), save,
    // then reload with brainKind flipped to patchbay — the first time real forward-pass
    // dynamics drive those inherited arrays. This needs explicit coverage, not just
    // "it loads" (plan Task 4.2 verify).
    const ruleWorld = createWorld(11, makeConfig({}));
    for (let i = 0; i < 100; i++) tick(ruleWorld);
    const blob = serialize(ruleWorld);
    // Flip the persisted config to patchbay.
    const patchBlob = { ...blob, config: { ...blob.config, brainKind: "patchbay" as const } };

    const a = deserialize(patchBlob);
    const b = deserialize(patchBlob);
    expect(a.config.brainKind).toBe("patchbay");
    const e0 = totalEnergy(a);
    const wat0 = totalWater(a);
    for (let i = 0; i < 200; i++) {
      tick(a);
      tick(b);
      expect(totalEnergy(a)).toBe(e0);
      expect(totalWater(a)).toBe(wat0);
    }
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});
