/**
 * rng.ts — the determinism substrate.
 *
 * `mulberry32` with the 7 named sub-streams (SPEC.md §"RNG Discipline"). All
 * stochastic code draws from these; the whole determinism guarantee rests here.
 *
 * The entire serializable state of a stream is its single 32-bit `state` word:
 * `next()` reads and writes `state` in place, so the property is exact — storing
 * the state word and resuming continues the sequence mid-stream (SPEC.md
 * §Persistence: live state is serialized, not just the seed).
 *
 * Part of `sim/`: imports only sibling `sim/` modules; no `Math.random`.
 */

import type { RNG, RngBundle, RngStreamName } from "./types";
import { RNG_STREAM_NAMES } from "./types";

/**
 * A `mulberry32` generator. The returned object's `state` field is the complete
 * serializable state; each `next()` advances it in place and returns a float in
 * [0, 1). Deterministic and engine-independent (integer ops + `>>> 0`).
 */
export function mulberry32(state: number): RNG {
  return {
    state: state >>> 0,
    next(): number {
      // Advance the 32-bit state in place so `this.state` is always live.
      this.state = (this.state + 0x6d2b79f5) >>> 0;
      let t = this.state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * Fixed per-stream salts. Deriving each sub-stream's seed as a mix of the world
 * seed with its own salt means adding a consumer in one stream never perturbs the
 * draw sequence of any other (SPEC.md §"RNG Discipline"). These salts are part of
 * the determinism contract — changing one re-rolls every existing seed's world for
 * that stream, so they are fixed.
 */
const STREAM_SALT: Record<RngStreamName, number> = {
  motion: 0x9e3779b1,
  mutation: 0x85ebca77,
  mating: 0xc2b2ae3d,
  "resolve-shuffle": 0x27d4eb2f,
  resolve: 0x165667b1,
  "field-noise": 0xd3a2646c,
  spawn: 0xfd7046c5,
};

/**
 * Derive a sub-stream seed from the world seed and a salt. A couple of `mulberry32`
 * mixing steps decorrelate nearby world seeds so seed 41 and seed 42 do not produce
 * correlated streams.
 */
function deriveSeed(worldSeed: number, salt: number): number {
  let s = (worldSeed ^ salt) >>> 0;
  // Two mixing steps from a throwaway generator seeded at `s`.
  const mixer = mulberry32(s);
  mixer.next();
  mixer.next();
  s = mixer.state;
  return s >>> 0;
}

/**
 * Create the bundle of all 7 named sub-streams, each deterministically seeded from
 * the world seed + its fixed salt. Iterates `RNG_STREAM_NAMES` (a stable ordered
 * array), never `Object.keys` (SPEC.md §Determinism).
 */
export function createRngBundle(worldSeed: number): RngBundle {
  const bundle = {} as RngBundle;
  for (let i = 0; i < RNG_STREAM_NAMES.length; i++) {
    const name = RNG_STREAM_NAMES[i] as RngStreamName;
    bundle[name] = mulberry32(deriveSeed(worldSeed, STREAM_SALT[name]));
  }
  return bundle;
}

/**
 * A standard-normal draw via Box–Muller, drawn from a passed stream.
 *
 * **The spare second normal is deliberately discarded, not cached.** A cached
 * spare would be hidden state not captured in the stream's 32-bit `state` word,
 * which would break the serialize→resume property (a save mid-pair would resume
 * without the spare). Drawing a fresh pair each call keeps `state` the complete
 * serializable state at the cost of one extra `next()` per call — a correctness
 * requirement, not an optimization target.
 */
export function gaussian(rng: RNG): number {
  // u1 in (0, 1] to keep log() finite.
  let u1 = rng.next();
  if (u1 <= 0) u1 = Number.MIN_VALUE;
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** The serialized form of the bundle: one integer state word per stream name. */
export type SerializedRng = Record<RngStreamName, number>;

/** Serialize the bundle as one integer per stream (the live `state` words). */
export function serializeRng(bundle: RngBundle): SerializedRng {
  const out = {} as SerializedRng;
  for (let i = 0; i < RNG_STREAM_NAMES.length; i++) {
    const name = RNG_STREAM_NAMES[i] as RngStreamName;
    out[name] = bundle[name].state >>> 0;
  }
  return out;
}

/**
 * Rebuild a bundle from serialized per-stream state words, resuming each stream
 * mid-sequence. A missing stream defaults to state 0 (a future migration concern;
 * v1 always writes all 7).
 */
export function deserializeRng(data: SerializedRng): RngBundle {
  const bundle = {} as RngBundle;
  for (let i = 0; i < RNG_STREAM_NAMES.length; i++) {
    const name = RNG_STREAM_NAMES[i] as RngStreamName;
    bundle[name] = mulberry32((data[name] ?? 0) >>> 0);
  }
  return bundle;
}
