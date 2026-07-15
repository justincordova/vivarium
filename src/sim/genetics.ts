/**
 * genetics.ts — meiosis, mutation, expressed-brain derivation, genetic distance,
 * and clonal plant reproduction.
 *
 * `world.ts` (founders) and `tick.ts` (births) both call this; the Inheritance
 * invariant is defined here (SPEC.md §"Crossover, mutation, distance", §Mutation).
 *
 * **Single owner of `deriveExpressed`** (mean weights, OR-ed masks): `distance`
 * uses it and the brain cache (Task 0.6.1) calls it — it is never reimplemented.
 *
 * Determinism: every stochastic draw takes an explicit named RNG sub-stream
 * (`mating` for gametes, `mutation` for mutation/drift, `spawn`/`mutation` for
 * seeds); accumulation is index-based in a fixed order. Part of `sim/`.
 */

import * as C from "./constants";
import { gaussian } from "./rng";
import type { Allele, Genome, PlantGenome, RNG } from "./types";

// ── Trait-gene registry (fixed order — load-bearing for the golden-vector test) ──

/** The 14 diploid trait genes plus `hue`, in fixed iteration order. */
export const TRAIT_GENES = [
  "size",
  "speed",
  "senseRadius",
  "metabolism",
  "aggression",
  "diet",
  "circadian",
  "nightVision",
  "armor",
  "toxicity",
  "offspringInvestment",
  "matingThreshold",
  "maxLifespan",
  "digestionEfficiency",
] as const;
export type TraitGene = (typeof TRAIT_GENES)[number];

/** Legal ranges per trait gene (clamp target for mutation). All (tunable). */
export const TRAIT_RANGE: Record<TraitGene, [number, number]> = {
  size: [0.1, 10],
  speed: [0, 10],
  senseRadius: [1, 50],
  metabolism: [0.1, 5],
  aggression: [0, 10],
  diet: [0, 1],
  circadian: [0, 1],
  nightVision: [0, 1],
  armor: [0, 10],
  toxicity: [0, 10],
  offspringInvestment: [1, 500],
  matingThreshold: [0, 500],
  maxLifespan: [10, 100000],
  digestionEfficiency: [0.05, 1],
};

// ── Expression (mean of alleles) ─────────────────────────────────────────────

/** Expressed value of a continuous trait gene: mean of its two alleles. */
export function expressTrait(allele: Allele): number {
  return (allele[0] + allele[1]) / 2;
}

/**
 * The derived forward-pass operand from two homologs (SPEC.md §"Brain weight
 * expression"). **The single implementation** of the mean/OR derivation:
 * `weights[k] = (hA[k]+hB[k]) / 2`, `enabled[k] = mA[k] | mB[k]` (dominant-enabled
 * OR — never AND). Pure function of the homologs, so its result is a cache, not
 * serialized.
 */
export function deriveExpressed(
  hA: Float32Array,
  hB: Float32Array,
  mA: Uint8Array,
  mB: Uint8Array,
): { weights: Float32Array; enabled: Uint8Array } {
  const n = hA.length;
  const weights = new Float32Array(n);
  const enabled = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    weights[k] = ((hA[k] as number) + (hB[k] as number)) / 2;
    enabled[k] = ((mA[k] as number) | (mB[k] as number)) as number;
  }
  return { weights, enabled };
}

// ── Meiosis (gamete) ─────────────────────────────────────────────────────────

/**
 * Form one gamete: per arrow, independently pick one of the two homolog alleles
 * (no linkage in v1). Draws from the `mating` sub-stream. Returns a haploid
 * weight+mask pair.
 */
export function gamete(
  hA: Float32Array,
  hB: Float32Array,
  mA: Uint8Array,
  mB: Uint8Array,
  mating: RNG,
): { w: Float32Array; m: Uint8Array } {
  const n = hA.length;
  const w = new Float32Array(n);
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const takeA = mating.next() < 0.5;
    w[i] = (takeA ? hA[i] : hB[i]) as number;
    m[i] = (takeA ? mA[i] : mB[i]) as number;
  }
  return { w, m };
}

/** Segregate one trait allele from a parent's pair (used for trait + hue meiosis). */
function segregateAllele(pair: Allele, mating: RNG): number {
  return (mating.next() < 0.5 ? pair[0] : pair[1]) as number;
}

/**
 * Sexual crossover: assemble a child genome from two parents. Each parent forms a
 * gamete (brain arrays + one allele per trait gene + hue); the child's two homologs
 * are the two gametes. Mutation is applied separately, after assembly.
 */
export function crossover(mom: Genome, dad: Genome, mating: RNG): Genome {
  const gm = gamete(mom.weightsA, mom.weightsB, mom.enabledA, mom.enabledB, mating);
  const gd = gamete(dad.weightsA, dad.weightsB, dad.enabledA, dad.enabledB, mating);

  const child = {
    weightsA: gm.w,
    enabledA: gm.m,
    weightsB: gd.w,
    enabledB: gd.m,
  } as Genome;

  for (let g = 0; g < TRAIT_GENES.length; g++) {
    const gene = TRAIT_GENES[g] as TraitGene;
    child[gene] = [segregateAllele(mom[gene], mating), segregateAllele(dad[gene], mating)];
  }
  child.hue = [segregateAllele(mom.hue, mating), segregateAllele(dad.hue, mating)];
  return child;
}

// ── Mutation ─────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Positive modulo for hue wrap. */
function wrap360(v: number): number {
  return ((v % 360) + 360) % 360;
}

/**
 * Mutate a child's homologs in place (SPEC.md §Mutation). All per-locus rates are
 * scaled by `MUT_GLOBAL`; sigmas are not. Draws exclusively from the `mutation`
 * sub-stream. Returns `dirty` — whether any disabled-arrow drift fired (the caller
 * uses it to trigger cache re-derivation).
 *
 * Fixed order (load-bearing for the golden-vector determinism test): for each
 * homolog h∈{A,B}, walk arrows 0..N applying weight-mut, enable-on, enable-off,
 * then disabled-drift; then walk trait genes in `TRAIT_GENES` order (both alleles),
 * then hue (both alleles).
 */
export function mutate(child: Genome, mutation: RNG): boolean {
  const g = C.MUT_GLOBAL;
  const weightRate = C.WEIGHT_MUT_RATE * g;
  const onRate = C.ENABLE_ON_RATE * g;
  const offRate = C.ENABLE_OFF_RATE * g;
  const driftRate = C.DRIFT_RATE * g;
  const traitRate = C.TRAIT_MUT_RATE * g;
  const hueRate = C.HUE_MUT_RATE * g;

  let dirty = false;

  const homologs: [Float32Array, Uint8Array][] = [
    [child.weightsA, child.enabledA],
    [child.weightsB, child.enabledB],
  ];
  for (let hIdx = 0; hIdx < homologs.length; hIdx++) {
    const [weights, enabled] = homologs[hIdx] as [Float32Array, Uint8Array];
    const n = weights.length;
    for (let i = 0; i < n; i++) {
      // Snapshot the mask bit at entry so an enable-off flip this tick does not make
      // the same arrow drift in the same pass (drift eligibility is the START-of-pass
      // per-homolog state, not a mid-mutation value). This keeps "enabled at entry →
      // not drift-eligible this tick" a clean invariant.
      const wasEnabled = enabled[i] === 1;

      // Weight mutation (per homolog, per arrow).
      if (mutation.next() < weightRate) {
        weights[i] = (weights[i] as number) + gaussian(mutation) * C.WEIGHT_MUT_SIGMA;
      }
      // Enable-bit flips.
      if (enabled[i] === 0) {
        if (mutation.next() < onRate) enabled[i] = 1;
      } else {
        if (mutation.next() < offRate) enabled[i] = 0;
      }
      // Disabled-arrow neutral drift — gated on THIS homolog's own start-of-pass mask
      // bit, not the OR-ed expressed bit and not the just-flipped value.
      if (!wasEnabled && mutation.next() < driftRate) {
        weights[i] = (weights[i] as number) + gaussian(mutation) * C.DRIFT_SIGMA;
        dirty = true;
      }
    }
  }

  // Trait genes — per allele, clamped to the gene's legal range.
  for (let gi = 0; gi < TRAIT_GENES.length; gi++) {
    const gene = TRAIT_GENES[gi] as TraitGene;
    const range = TRAIT_RANGE[gene];
    const sigma = (C.TRAIT_MUT_SIGMA as Record<string, number>)[gene] as number;
    const pair = child[gene];
    for (let a = 0; a < 2; a++) {
      if (mutation.next() < traitRate) {
        pair[a] = clamp((pair[a] as number) + gaussian(mutation) * sigma, range[0], range[1]);
      }
    }
  }

  // Hue — per allele, wrapped mod 360 (the only wraparound in the sim).
  for (let a = 0; a < 2; a++) {
    if (mutation.next() < hueRate) {
      child.hue[a] = wrap360((child.hue[a] as number) + gaussian(mutation) * C.HUE_DRIFT);
    }
  }

  return dirty;
}

// ── Genetic distance (on the expressed brain) ────────────────────────────────

/**
 * Genetic distance on the **expressed** brain (SPEC.md §"Genetic distance"):
 * Euclidean over expressed weights + Hamming over expressed masks, weighted by the
 * `constants.ts` coefficients. Operates on the expressed brain only (not trait
 * genes). Symmetric and zero-on-identity by construction.
 */
export function distance(a: Genome, b: Genome): number {
  const ea = deriveExpressed(a.weightsA, a.weightsB, a.enabledA, a.enabledB);
  const eb = deriveExpressed(b.weightsA, b.weightsB, b.enabledA, b.enabledB);
  const n = ea.weights.length;
  let sumSq = 0;
  let hamming = 0;
  for (let k = 0; k < n; k++) {
    const dw = (ea.weights[k] as number) - (eb.weights[k] as number);
    sumSq += dw * dw;
    if ((ea.enabled[k] as number) !== (eb.enabled[k] as number)) hamming++;
  }
  return C.DIST_WEIGHT_COEF * Math.sqrt(sumSq) + C.DIST_MASK_COEF * hamming;
}

// ── Clonal plant reproduction ────────────────────────────────────────────────

const PLANT_GENES = [
  "maxSize",
  "height",
  "dispersal",
  "toughness",
  "seedInvestment",
  "maxAge",
] as const;

/** Legal ranges per plant gene (clamp target for seed mutation). (tunable) */
export const PLANT_RANGE: Record<(typeof PLANT_GENES)[number], [number, number]> = {
  maxSize: [1, 1000],
  height: [0, 10],
  dispersal: [0, 50],
  toughness: [0, 1],
  seedInvestment: [1, 500],
  maxAge: [10, 100000],
};

/**
 * Clonal plant seed (SPEC.md §Plant Lifecycle — asexual in v1): copy the parent's
 * two homologs **verbatim**, then apply the same per-allele trait/hue mutation the
 * `mutation` stream applies to creatures. No meiosis, no crossover. The `spawn`
 * stream governs placement/dispersal at the call site (not here); this function
 * only mutates genes via the `mutation` stream.
 */
export function plantSeed(parent: PlantGenome, mutation: RNG): PlantGenome {
  const g = C.MUT_GLOBAL;
  const traitRate = C.TRAIT_MUT_RATE * g;
  const hueRate = C.HUE_MUT_RATE * g;

  const seed = {} as PlantGenome;
  for (let gi = 0; gi < PLANT_GENES.length; gi++) {
    const gene = PLANT_GENES[gi] as (typeof PLANT_GENES)[number];
    const range = PLANT_RANGE[gene];
    // Copy verbatim, then mutate per allele.
    const src = parent[gene];
    const pair: Allele = [src[0], src[1]];
    for (let a = 0; a < 2; a++) {
      if (mutation.next() < traitRate) {
        pair[a] = clamp(
          (pair[a] as number) + gaussian(mutation) * C.TRAIT_MUT_SIGMA.size,
          range[0],
          range[1],
        );
      }
    }
    seed[gene] = pair;
  }
  const huePair: Allele = [parent.hue[0], parent.hue[1]];
  for (let a = 0; a < 2; a++) {
    if (mutation.next() < hueRate) {
      huePair[a] = wrap360((huePair[a] as number) + gaussian(mutation) * C.HUE_DRIFT);
    }
  }
  seed.hue = huePair;
  return seed;
}
