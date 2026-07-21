import { makeConfig } from "@sim/config";
import { ARROWS } from "@sim/constants";
import { deserialize, type SaveBlob, serialize } from "@sim/serialize";
import { totalEnergy, totalWater } from "@sim/stats";
import { tick } from "@sim/tick";
import { Biome, type Nest } from "@sim/types";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";

// Society (Phase 7A): nests, the `sociality` gene, kin sensing, and the save v4→v5
// migration. These exercise the exported surface only; behavior (creatures choosing to
// nest) is covered by the terrained-world conservation property + the cold-open.

describe("society — sociality gene", () => {
  it("founders carry a sociality allele pair inside [0,1]", () => {
    const w = createWorld(7, makeConfig({}));
    for (const c of w.creatures) {
      const [a, b] = c.genome.sociality;
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
  });
});

describe("society — nest lifecycle", () => {
  it("a seeded nest decays by NEST_DECAY each tick and is removed at zero", () => {
    const w = createWorld(3, makeConfig({}));
    const t = w.config.tunables;
    // Seed a single nest at a known strength; no creature reinforces it (its lineage is a
    // sentinel that never matches a live creature's root), so it only decays.
    const start = 5 * t.NEST_DECAY;
    w.nests = [{ id: 999999, x: 1, y: 1, lineage: -1, strength: start }];
    const before = w.nests[0]?.strength ?? 0;
    tick(w);
    // Either it decayed by exactly NEST_DECAY, or (if start was ≤ decay) it was removed.
    if (w.nests.length > 0) {
      expect((w.nests[0] as Nest).strength).toBe(before - t.NEST_DECAY);
    }
    // Run enough ticks to guarantee removal.
    for (let i = 0; i < 10; i++) tick(w);
    expect(w.nests.some((n) => n.id === 999999)).toBe(false);
  });

  it("nest decay never touches the energy/water ledgers", () => {
    const w = createWorld(11, makeConfig({}));
    const t = w.config.tunables;
    w.nests = [{ id: 888888, x: 2, y: 2, lineage: -1, strength: 50 * t.NEST_DECAY }];
    const e0 = totalEnergy(w);
    const wa0 = totalWater(w);
    for (let i = 0; i < 20; i++) {
      tick(w);
      expect(totalEnergy(w)).toBe(e0);
      expect(totalWater(w)).toBe(wa0);
    }
  });
});

describe("society — serialize v5", () => {
  it("round-trips nests and the sociality gene identically", () => {
    const w = createWorld(5, makeConfig({}));
    w.nests = [
      { id: 1, x: 10, y: 20, lineage: 3, strength: 42 },
      { id: 2, x: 30, y: 40, lineage: 3, strength: 100 },
    ];
    const round = deserialize(serialize(w));
    expect(round.nests).toEqual(w.nests);
    expect(round.creatures[0]?.genome.sociality).toEqual(w.creatures[0]?.genome.sociality);
    expect(totalEnergy(round)).toBe(totalEnergy(w));
    expect(totalWater(round)).toBe(totalWater(w));
  });

  it("serialize writes version 5 and includes nests", () => {
    const w = createWorld(9, makeConfig({}));
    w.nests = [{ id: 1, x: 1, y: 1, lineage: 0, strength: 30 }];
    const blob = serialize(w);
    expect(blob.version).toBe(5);
    expect(blob.nests).toHaveLength(1);
  });
});

describe("society — v4 → v5 migration", () => {
  it("a pre-v5 blob loads with empty nests, neutral sociality, and a re-seeded brain", () => {
    // Build a v5 blob, then downgrade it to a synthetic v4: strip nests + sociality and
    // truncate the brain arrays to a pre-Society length (380) to force the geometry
    // re-seed path in deGenome.
    const w = createWorld(2, makeConfig({}));
    w.nests = [{ id: 1, x: 1, y: 1, lineage: 0, strength: 30 }];
    const blob = serialize(w) as SaveBlob;

    const cloned = structuredClone(blob);
    // Drop `nests` to simulate a pre-v5 blob (destructure-omit, no `delete`).
    const { nests: _droppedNests, ...v4 } = cloned;
    v4.version = 4;
    for (const c of v4.creatures) {
      // Old geometry: 380-length brain arrays and no `sociality` trait.
      c.genome.weightsA = c.genome.weightsA.slice(0, 380);
      c.genome.weightsB = c.genome.weightsB.slice(0, 380);
      c.genome.enabledA = c.genome.enabledA.slice(0, 380);
      c.genome.enabledB = c.genome.enabledB.slice(0, 380);
      const { sociality: _droppedSociality, ...traits } = c.genome.traits;
      c.genome.traits = traits;
    }

    const loaded = deserialize(v4 as SaveBlob);
    expect(loaded.nests).toEqual([]);
    for (const c of loaded.creatures) {
      // Sociality defaulted to the neutral midpoint, not (0,0).
      expect(c.genome.sociality).toEqual([0.5, 0.5]);
      // Brain re-seeded to the new geometry length, inert (all disabled).
      expect(c.genome.weightsA).toHaveLength(ARROWS);
      expect(c.genome.enabledA).toHaveLength(ARROWS);
      expect(Array.from(c.genome.enabledA).every((e) => e === 0)).toBe(true);
    }
  });
});

describe("society — kin sensing (indirect via a live world)", () => {
  it("a fresh terrained world ticks with kin senses present and stays conserved", () => {
    // The kin scan is inside the (unexported) sense builder; this guards that adding it
    // did not perturb conservation or crash on a real world with lineage roots populated.
    const w = createWorld(13, makeConfig({ brainKind: "patchbay" }));
    const e0 = totalEnergy(w);
    const wa0 = totalWater(w);
    for (let i = 0; i < 30; i++) {
      tick(w);
      expect(totalEnergy(w)).toBe(e0);
      expect(totalWater(w)).toBe(wa0);
    }
    // Water biome exists in the generated terrain (kin/water sensing has real targets).
    expect(Array.from(w.terrain.biome).some((b) => b === Biome.Water)).toBe(true);
  });
});
