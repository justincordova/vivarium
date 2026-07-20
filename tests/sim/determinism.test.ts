import { makeConfig } from "@sim/config";
import { totalEnergy, totalWater } from "@sim/stats";
import { tick } from "@sim/tick";
import type { World } from "@sim/types";
import { createWorld } from "@sim/world";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

/** Structural fingerprint of a world for bit-identity comparison. */
function fingerprint(w: World): string {
  const parts: string[] = [String(w.tick), String(w.solarReservoir), String(w.nextId)];
  for (const c of w.creatures) {
    parts.push(
      `${c.id}:${c.x}:${c.y}:${c.heading}:${c.energy}:${c.hydration}:${c.health}:${c.age}`,
    );
  }
  for (const p of w.plants) parts.push(`P${p.id}:${p.x}:${p.y}:${p.energy}:${p.age}`);
  for (const co of w.corpses) parts.push(`C${co.id}:${co.energy}`);
  return parts.join("|");
}

// Pin to a modest world: the determinism machinery (terrain gen, RNG sub-streams,
// per-cell terrain reads, closed ledgers) is fully exercised at any size, and the
// enlarged 1000×1000 default makes two-world×1000-tick×N-run property tests exceed the
// timeout under full-suite parallelism. Bit-identity is the invariant under test, not
// world scale.
const DET_WORLD = { worldWidth: 200, worldHeight: 200, gridCols: 64, gridRows: 64 } as const;

describe("determinism (the load-bearing gate)", () => {
  it("two 1000-tick runs from the same seed are bit-identical", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), (seed) => {
        const a = createWorld(seed, makeConfig({ ...DET_WORLD }));
        const b = createWorld(seed, makeConfig({ ...DET_WORLD }));
        for (let i = 0; i < 1000; i++) {
          tick(a);
          tick(b);
        }
        expect(fingerprint(a)).toBe(fingerprint(b));
      }),
      { numRuns: 3 },
    );
  }, 120_000);
});

describe("conservation (exact, every tick)", () => {
  it("totalEnergy and totalWater are invariant across 1000 ticks", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), (seed) => {
        const w = createWorld(seed, makeConfig({ ...DET_WORLD }));
        const e0 = totalEnergy(w);
        const wat0 = totalWater(w);
        for (let i = 0; i < 1000; i++) {
          tick(w);
          expect(totalEnergy(w)).toBe(e0);
          expect(totalWater(w)).toBe(wat0);
        }
      }),
      { numRuns: 3 },
    );
  }, 120_000);
});
