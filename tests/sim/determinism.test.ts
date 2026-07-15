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

describe("determinism (the load-bearing gate)", () => {
  it("two 1000-tick runs from the same seed are bit-identical", () => {
    // A live 1000-tick run over a full population is ~10s, so keep numRuns small
    // and lift the per-test timeout; the viability gate covers long multi-seed runs.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), (seed) => {
        const a = createWorld(seed, makeConfig({}));
        const b = createWorld(seed, makeConfig({}));
        for (let i = 0; i < 1000; i++) {
          tick(a);
          tick(b);
        }
        expect(fingerprint(a)).toBe(fingerprint(b));
      }),
      { numRuns: 3 },
    );
  }, 60_000);
});

describe("conservation (exact, every tick)", () => {
  it("totalEnergy and totalWater are invariant across 1000 ticks", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), (seed) => {
        const w = createWorld(seed, makeConfig({}));
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
  }, 60_000);
});
