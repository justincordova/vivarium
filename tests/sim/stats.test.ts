import { makeConfig } from "@sim/config";
import * as C from "@sim/constants";
import { TRAIT_GENES, TRAIT_RANGE, type TraitGene } from "@sim/genetics";
import { mulberry32 } from "@sim/rng";
import {
  behaviorNovelty,
  heritability,
  meanEnabled,
  speciesClusters,
  traitVariance,
  worldHealth,
} from "@sim/stats";
import type { Creature, Genome, World } from "@sim/types";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";

// ── Fixture builders ─────────────────────────────────────────────────────────

/** A genome whose brain arrays are all-`fill` and traits sit at their range midpoint. */
function genomeWith(
  brainFill: number,
  traitOverrides: Partial<Record<TraitGene, number>> = {},
): Genome {
  const g = {
    weightsA: new Float32Array(C.ARROWS).fill(brainFill),
    weightsB: new Float32Array(C.ARROWS).fill(brainFill),
    enabledA: new Uint8Array(C.ARROWS).fill(1),
    enabledB: new Uint8Array(C.ARROWS).fill(1),
  } as Genome;
  for (const gene of TRAIT_GENES) {
    const [lo, hi] = TRAIT_RANGE[gene];
    const v = traitOverrides[gene] ?? (lo + hi) / 2;
    g[gene] = [v, v];
  }
  g.hue = [0, 0];
  return g;
}

let nextId = 1;
function creatureAt(x: number, y: number, genome: Genome, actionWindow?: number[]): Creature {
  return {
    id: nextId++,
    parentId: null,
    x,
    y,
    heading: 0,
    vx: 0,
    vy: 0,
    energy: 100,
    hydration: 100,
    health: 50,
    age: 0,
    genome,
    hidden: new Float32Array(0),
    ruleState: { mode: "wander", targetId: -1, targetKind: "none", committedTicks: 0 },
    actionWindow: Float32Array.from(actionWindow ?? new Array(C.ACTIONS).fill(0)),
  };
}

/** A base world with the default config but an empty creature list we fill ourselves. */
function emptyWorld(): World {
  const w = createWorld(1, makeConfig({}));
  w.creatures = [];
  w.creatureIds = [];
  w.plants = [];
  w.corpses = [];
  return w;
}

// ── traitVariance ──────────────────────────────────────────────────────────────

describe("traitVariance", () => {
  it("monoculture → near zero", () => {
    const g = genomeWith(0);
    const creatures = [creatureAt(0, 0, g), creatureAt(1, 1, g), creatureAt(2, 2, g)];
    expect(traitVariance(creatures)).toBeCloseTo(0, 10);
  });

  it("a spread population → positive", () => {
    const lo = genomeWith(0, { size: TRAIT_RANGE.size[0], speed: TRAIT_RANGE.speed[0] });
    const hi = genomeWith(0, { size: TRAIT_RANGE.size[1], speed: TRAIT_RANGE.speed[1] });
    expect(traitVariance([creatureAt(0, 0, lo), creatureAt(1, 1, hi)])).toBeGreaterThan(0);
  });

  it("empty population → 0", () => {
    expect(traitVariance([])).toBe(0);
  });
});

// ── speciesClusters ─────────────────────────────────────────────────────────────

describe("speciesClusters", () => {
  it("two groups separated in BOTH space and genome → 2 clusters", () => {
    const w = emptyWorld();
    const r = w.config.tunables.SPECIES_SPATIAL_RADIUS;
    // Group A: brain fill 0, clustered near origin.
    const gA = genomeWith(0);
    // Group B: brain fill far enough that genetic distance > compat threshold, placed
    // well beyond the spatial radius from group A.
    const gB = genomeWith(5);
    w.creatures = [
      creatureAt(0, 0, gA),
      creatureAt(2, 2, gA),
      creatureAt(r * 4 + 100, r * 4 + 100, gB),
      creatureAt(r * 4 + 102, r * 4 + 102, gB),
    ];
    const res = speciesClusters(w);
    expect(res.count).toBe(2);
  });

  it("a genetic chain within one neighborhood → 1 cluster but maxDiameter ≫ threshold", () => {
    const w = emptyWorld();
    const thr = w.config.tunables.SPECIES_COMPAT_THRESHOLD;
    // A chain a—b—c—d where each neighbor is within threshold but the endpoints are
    // far apart in genome. All spatially co-located so edges are not spatially pruned.
    // Adjacent expressed distance ≈ DIST_WEIGHT_COEF·sqrt(ARROWS)·step ≈ 18.7·step;
    // step=0.16 → adjacent ≈ 3 (< threshold 8), 5-step endpoint ≈ 15 (≫ threshold).
    const step = 0.16;
    const chain = [0, step, 2 * step, 3 * step, 4 * step, 5 * step].map((f) =>
      creatureAt(0, 0, genomeWith(f)),
    );
    w.creatures = chain;
    const res = speciesClusters(w);
    // Single-linkage collapses the chain to one cluster...
    expect(res.count).toBe(1);
    // ...but the diameter flags it as a cline, not one healthy species.
    expect(res.maxDiameter).toBeGreaterThan(thr);
  });

  it("empty world → 0 clusters, 0 diameter", () => {
    const w = emptyWorld();
    expect(speciesClusters(w)).toEqual({ count: 0, maxDiameter: 0 });
  });

  it("is deterministic across identical worlds", () => {
    const build = (): World => {
      const w = emptyWorld();
      const r = mulberry32(7);
      const cs: Creature[] = [];
      for (let i = 0; i < 20; i++) {
        cs.push(creatureAt(r.next() * 50, r.next() * 50, genomeWith(r.next())));
      }
      w.creatures = cs;
      return w;
    };
    nextId = 1;
    const a = speciesClusters(build());
    nextId = 1;
    const b = speciesClusters(build());
    expect(a).toEqual(b);
  });
});

// ── behaviorNovelty ─────────────────────────────────────────────────────────────

describe("behaviorNovelty", () => {
  it("identical action histograms → 0 (regardless of each one's entropy)", () => {
    const w = emptyWorld();
    const g = genomeWith(0);
    // A PEAKED (low-entropy) but identical histogram across all creatures → JSD 0.
    const peaked = [10, 0, 0, 0, 0, 0, 0];
    w.creatures = [
      creatureAt(0, 0, g, peaked),
      creatureAt(1, 1, g, peaked),
      creatureAt(2, 2, g, peaked),
    ];
    expect(behaviorNovelty(w)).toBeCloseTo(0, 10);
  });

  it("two distinct behavioral modes → clearly higher than a monoculture", () => {
    const w = emptyWorld();
    const g = genomeWith(0);
    const hunters = [0, 0, 10, 0, 5, 0, 0]; // eat/attack heavy
    const grazers = [8, 8, 0, 3, 0, 0, 0]; // turn/accelerate/drink heavy
    w.creatures = [
      creatureAt(0, 0, g, hunters),
      creatureAt(1, 1, g, hunters),
      creatureAt(2, 2, g, grazers),
      creatureAt(3, 3, g, grazers),
    ];
    expect(behaviorNovelty(w)).toBeGreaterThan(0.1);
  });

  it("fewer than 2 creatures → 0", () => {
    const w = emptyWorld();
    w.creatures = [creatureAt(0, 0, genomeWith(0), [1, 2, 3, 4, 5, 6, 7])];
    expect(behaviorNovelty(w)).toBe(0);
  });
});

// ── worldHealth (integration) ────────────────────────────────────────────────

describe("worldHealth", () => {
  it("assembles all fields and is deterministic for the same world", () => {
    const w = emptyWorld();
    w.tick = 1234;
    const g = genomeWith(0);
    w.creatures = [
      creatureAt(0, 0, g, [3, 0, 0, 0, 0, 0, 0]),
      creatureAt(1, 1, g, [0, 3, 0, 0, 0, 0, 0]),
    ];
    const history = { populationSeries: [2, 4, 2, 4], extinctionEvents: 1 };
    const h1 = worldHealth(w, history);
    const h2 = worldHealth(w, history);
    expect(h1).toEqual(h2);
    expect(h1.survivalTicks).toBe(1234);
    expect(h1.meanPopulation).toBe(3);
    expect(h1.populationVariance).toBe(1);
    expect(h1.extinctionEvents).toBe(1);
    expect(h1.speciesCount).toBe(1);
  });

  it("a flat population series → zero populationVariance", () => {
    const w = emptyWorld();
    w.creatures = [creatureAt(0, 0, genomeWith(0))];
    const h = worldHealth(w, { populationSeries: [5, 5, 5, 5], extinctionEvents: 0 });
    expect(h.populationVariance).toBeCloseTo(0, 10);
  });
});

// ── meanEnabled (Phase 4 enable-density instrument) ──────────────────────────

describe("meanEnabled", () => {
  it("all arrows enabled → 1", () => {
    const g = genomeWith(0); // genomeWith fills both enabled masks with 1
    expect(meanEnabled([creatureAt(0, 0, g)])).toBeCloseTo(1, 10);
  });

  it("no arrows enabled → 0", () => {
    const g = genomeWith(0);
    g.enabledA = new Uint8Array(C.ARROWS);
    g.enabledB = new Uint8Array(C.ARROWS);
    expect(meanEnabled([creatureAt(0, 0, g)])).toBe(0);
  });

  it("OR-of-homologs: half on A, other half on B → all expressed on", () => {
    const g = genomeWith(0);
    const a = new Uint8Array(C.ARROWS);
    const b = new Uint8Array(C.ARROWS);
    for (let k = 0; k < C.ARROWS; k++) {
      if (k % 2 === 0) a[k] = 1;
      else b[k] = 1;
    }
    g.enabledA = a;
    g.enabledB = b;
    // Expressed = A | B = all on.
    expect(meanEnabled([creatureAt(0, 0, g)])).toBeCloseTo(1, 10);
  });

  it("empty population → 0", () => {
    expect(meanEnabled([])).toBe(0);
  });
});

// ── heritability (Phase 4 heritability gate) ─────────────────────────────────

describe("heritability", () => {
  it("identical parent+child → parent↔child distance 0, ratio 0", () => {
    const w = emptyWorld();
    const g = genomeWith(0);
    const parent = creatureAt(0, 0, g);
    const child = creatureAt(1, 1, genomeWith(0));
    child.parentId = parent.id;
    // A third, DIFFERENT creature so mean pairwise distance is positive.
    const other = creatureAt(2, 2, genomeWith(3));
    w.creatures = [parent, child, other];
    const her = heritability(w);
    expect(her.pairs).toBe(1);
    expect(her.meanParentChild).toBeCloseTo(0, 6);
    expect(her.ratio).toBeCloseTo(0, 6);
  });

  it("is deterministic and returns zero for a population with no tracked parents", () => {
    const w = emptyWorld();
    w.creatures = [creatureAt(0, 0, genomeWith(0)), creatureAt(1, 1, genomeWith(3))];
    const a = heritability(w);
    const b = heritability(w);
    expect(a).toEqual(b);
    expect(a.pairs).toBe(0);
    expect(a.meanParentChild).toBe(0);
  });

  it("ratio rises when children diverge from parents", () => {
    const w = emptyWorld();
    // Parent at fill 0; child noticeably diverged; a spread of others for the baseline.
    const parent = creatureAt(0, 0, genomeWith(0));
    const child = creatureAt(1, 1, genomeWith(1));
    child.parentId = parent.id;
    const others = [creatureAt(2, 2, genomeWith(0)), creatureAt(3, 3, genomeWith(0.2))];
    w.creatures = [parent, child, ...others];
    const her = heritability(w);
    expect(her.meanParentChild).toBeGreaterThan(0);
    expect(her.ratio).toBeGreaterThan(0);
  });
});
