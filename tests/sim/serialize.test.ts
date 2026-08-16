import { makeConfig } from "@sim/config";
import { ACTIONS } from "@sim/constants";
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
  }, 300_000);

  it("writes the current version and does not serialize the derived brain cache", () => {
    const w = createWorld(1, makeConfig({}));
    const blob = serialize(w);
    expect(blob.version).toBe(SAVE_VERSION);
    // v2 brainKind, v3 lineage, v4 terrain, v5 society (nests/sociality), v6 terrarium
    // (influence). Pinned as a literal so bumping the save format stays a conscious act.
    expect(blob.version).toBe(6);
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
  // Pinned to a modest world for the same reason `determinism.test.ts` pins `DET_WORLD`:
  // this is a two-world × 1000-tick × N-run property, and on the enlarged 1000×1000
  // default it exceeds its timeout under full-suite parallelism. The round trip
  // (terrain, creatures, nests, fields, RNG streams) is exercised at any size — the
  // invariant under test is bit-identity across a save boundary, not world scale.
  const ROUNDTRIP_WORLD = {
    worldWidth: 200,
    worldHeight: 200,
    gridCols: 64,
    gridRows: 64,
  } as const;

  it("500 → serialize → deserialize → 500 equals a straight 1000-tick run", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), (seed) => {
        const straight = createWorld(seed, makeConfig({ ...ROUNDTRIP_WORLD }));
        for (let i = 0; i < 1000; i++) tick(straight);

        const split = createWorld(seed, makeConfig({ ...ROUNDTRIP_WORLD }));
        for (let i = 0; i < 500; i++) tick(split);
        const resumed = deserialize(serialize(split));
        for (let i = 0; i < 500; i++) tick(resumed);

        expect(fingerprint(resumed)).toBe(fingerprint(straight));
      }),
      { numRuns: 2 },
    );
  }, 300_000);
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

  // v4→v5 (Society) widened ACTIONS 7→8 for the nest action. A pre-v5 blob therefore
  // carries 7-slot action windows, and nothing else renormalizes them — so an unnormalized
  // load would leave the migrated cohort permanently the wrong width: the nest slot write
  // is an out-of-bounds typed-array store (silently discarded), and the empty-window
  // uniform is 1/7 against 1/8 for every creature born after the load, which makes
  // `jensenShannon` report divergence between two creatures that have fired nothing.
  it("a pre-v5 blob's 7-slot actionWindow is restored at the current ACTIONS width", () => {
    const w = createWorld(5, makeConfig({}));
    // biome-ignore lint/suspicious/noExplicitAny: simulate a pre-Society v4 blob
    const blob = { ...serialize(w) } as any;
    blob.version = 4;
    for (const c of blob.creatures) c.actionWindow = [1, 2, 3, 4, 5, 6, 7];
    const round = deserialize(blob);
    for (const c of round.creatures) {
      expect(c.actionWindow).toHaveLength(ACTIONS);
      // The saved slots survive; the new nest slot starts empty.
      expect(Array.from(c.actionWindow)).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
    }
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

describe("serialize — stale tunables in an old blob", () => {
  // Built once: the key-sweep below strips all 88 tunables in turn, and re-ticking a
  // fresh world per key costs minutes for no added coverage.
  let base: string | null = null;

  /** A world serialized, JSON round-tripped, and downgraded to an older save version. */
  function staleBlob(version: number, mutate: (t: Record<string, unknown>) => void) {
    if (base === null) {
      const w = createWorld(1, makeConfig({}));
      for (let i = 0; i < 200; i++) tick(w);
      base = JSON.stringify(serialize(w));
    }
    const blob = JSON.parse(base);
    blob.version = version;
    mutate(blob.config.tunables);
    return blob;
  }

  // A tunable is routinely added WITHOUT a SAVE_VERSION bump (the blob's shape does not
  // change), so no `migrateVNtoVN1` step can be responsible for defaulting it. Absent, it
  // reads `undefined`, arithmetic turns it into NaN, and a NaN cell index makes the
  // typed-array credit a silent no-op while the matching debit still lands — quanta are
  // destroyed rather than moved, on a world the autosaver then writes back.
  it("backfills every tunable the blob predates", () => {
    const blob = staleBlob(SAVE_VERSION - 1, (t) => {
      delete t.ATTACK_DAMAGE_COEF;
      delete t.TEMP_SEASON_AMPLITUDE;
      delete t.MUT_GLOBAL;
    });
    const w = deserialize(blob);
    const def = makeConfig({}).tunables;
    expect(w.config.tunables.ATTACK_DAMAGE_COEF).toBe(def.ATTACK_DAMAGE_COEF);
    expect(w.config.tunables.TEMP_SEASON_AMPLITUDE).toBe(def.TEMP_SEASON_AMPLITUDE);
    expect(w.config.tunables.MUT_GLOBAL).toBe(def.MUT_GLOBAL);
  });

  // The invariant the leak actually violates, asserted at its source and over the WHOLE
  // key set rather than the one tunable that happens to be missing today. Waiting for the
  // ledger to visibly drift needs ~2000 ticks (the NaN has to reach a landed attack, then
  // a death at a NaN position), which is far past the test timeout — and this is the
  // stronger statement anyway: no tunable may be non-finite after a load, ever.
  it("leaves no non-finite tunable, whatever the blob is missing", () => {
    const complete = makeConfig({}).tunables as unknown as Record<string, unknown>;
    for (const missing of Object.keys(complete)) {
      const blob = staleBlob(SAVE_VERSION - 1, (t) => {
        delete t[missing];
      });
      const loaded = deserialize(blob).config.tunables as unknown as Record<string, unknown>;
      for (const key of Object.keys(complete)) {
        const v = loaded[key];
        // Two tunables are nested per-gene sigma tables rather than numbers.
        if (typeof complete[key] === "object" && complete[key] !== null) {
          for (const gene of Object.keys(complete[key] as Record<string, number>)) {
            const g = (v as Record<string, unknown>)?.[gene];
            expect(Number.isFinite(g), `${key}.${gene} after dropping ${missing}`).toBe(true);
          }
        } else {
          expect(Number.isFinite(v), `${key} after dropping ${missing}`).toBe(true);
        }
      }
    }
  });

  // Save files are user-supplied (`.viv` import), so a hand-edited or truncated tunable is
  // reachable. A non-number is the same defect class as an absent one: it becomes NaN.
  it("rejects a non-finite tunable from an edited save file", () => {
    const blob = staleBlob(SAVE_VERSION, (t) => {
      t.ATTACK_DAMAGE_COEF = "2.0";
      t.METABOLIC_COST_COEF = null;
      t.MUT_GLOBAL = Number.NaN;
    });
    const w = deserialize(blob);
    const def = makeConfig({}).tunables;
    expect(w.config.tunables.ATTACK_DAMAGE_COEF).toBe(def.ATTACK_DAMAGE_COEF);
    expect(w.config.tunables.METABOLIC_COST_COEF).toBe(def.METABOLIC_COST_COEF);
    expect(w.config.tunables.MUT_GLOBAL).toBe(def.MUT_GLOBAL);
  });

  // The backfill must not clobber a real override — a shared `#mut=5` world or a slider
  // edit is legitimately persisted config, and resetting it on load would silently undo
  // the user's world.
  it("preserves a legitimately saved override", () => {
    const w = createWorld(1, makeConfig({ tunables: { MUT_GLOBAL: 5 } }));
    const blob = JSON.parse(JSON.stringify(serialize(w)));
    expect(deserialize(blob).config.tunables.MUT_GLOBAL).toBe(5);
  });

  // The nested sigma tables are objects, so a number-only backfill silently swaps a saved
  // world's mutation sigmas for the defaults — a config reset nothing would report.
  it("preserves a saved override inside a nested sigma table", () => {
    const base = makeConfig({}).tunables.TRAIT_MUT_SIGMA;
    const gene = Object.keys(base)[0] as keyof typeof base;
    const w = createWorld(1, makeConfig({ tunables: { TRAIT_MUT_SIGMA: { [gene]: 0.375 } } }));
    const blob = JSON.parse(JSON.stringify(serialize(w)));
    const loaded = deserialize(blob).config.tunables.TRAIT_MUT_SIGMA;
    expect(loaded[gene]).toBe(0.375);
    // and the sibling entries survive the merge
    expect(Object.keys(loaded).length).toBe(Object.keys(base).length);
  });
});
