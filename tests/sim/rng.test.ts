import { createRngBundle, deserializeRng, gaussian, mulberry32, serializeRng } from "@sim/rng";
import { RNG_STREAM_NAMES } from "@sim/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const seed = () => fc.integer({ min: 0, max: 0xffffffff });
const draws = (n: number) => fc.integer({ min: 0, max: n });

describe("mulberry32 — determinism", () => {
  it("same seed produces identical sequences", () => {
    fc.assert(
      fc.property(seed(), draws(200), (s, n) => {
        const a = mulberry32(s);
        const b = mulberry32(s);
        for (let i = 0; i < n; i++) expect(a.next()).toBe(b.next());
      }),
    );
  });

  it("returns floats in [0, 1)", () => {
    fc.assert(
      fc.property(seed(), draws(500), (s, n) => {
        const r = mulberry32(s);
        for (let i = 0; i < n; i++) {
          const v = r.next();
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(1);
        }
      }),
    );
  });

  it("state is the complete serializable state: cloning at state reproduces the tail", () => {
    fc.assert(
      fc.property(seed(), draws(100), draws(100), (s, n, m) => {
        const straight = mulberry32(s);
        for (let i = 0; i < n; i++) straight.next();
        // Snapshot the live state, then draw M more.
        const snapshot = straight.state;
        const tail: number[] = [];
        for (let i = 0; i < m; i++) tail.push(straight.next());
        // A fresh generator seeded at the snapshot reproduces the exact tail.
        const resumed = mulberry32(snapshot);
        for (let i = 0; i < m; i++) expect(resumed.next()).toBe(tail[i]);
      }),
    );
  });
});

describe("bundle — creation & sub-stream independence", () => {
  it("same world seed yields identical bundles across every stream", () => {
    fc.assert(
      fc.property(seed(), draws(50), (s, n) => {
        const a = createRngBundle(s);
        const b = createRngBundle(s);
        for (const name of RNG_STREAM_NAMES) {
          for (let i = 0; i < n; i++) expect(a[name].next()).toBe(b[name].next());
        }
      }),
    );
  });

  it("the 7 sub-streams from one seed are distinct (salts decorrelate them)", () => {
    const bundle = createRngBundle(12345);
    const firsts = RNG_STREAM_NAMES.map((name) => bundle[name].next());
    expect(new Set(firsts).size).toBe(RNG_STREAM_NAMES.length);
  });

  it("interleaving draws on one stream does not shift another (streams independent)", () => {
    fc.assert(
      fc.property(seed(), draws(100), (s, k) => {
        // Reference: draw `mating` alone.
        const ref = createRngBundle(s);
        const refMating: number[] = [];
        for (let i = 0; i < 20; i++) refMating.push(ref.mating.next());

        // Perturbed: hammer `motion` k times first, interleaved, then draw `mating`.
        const perturbed = createRngBundle(s);
        for (let i = 0; i < k; i++) perturbed.motion.next();
        const pMating: number[] = [];
        for (let i = 0; i < 20; i++) {
          perturbed.motion.next(); // extra draws on a DIFFERENT stream
          pMating.push(perturbed.mating.next());
        }
        expect(pMating).toEqual(refMating);
      }),
    );
  });
});

describe("serialize / deserialize — mid-sequence resume", () => {
  it("N draws → serialize → deserialize → M draws equals a single N+M run (per stream)", () => {
    fc.assert(
      fc.property(seed(), draws(80), draws(80), (s, n, m) => {
        // Straight N+M run.
        const straight = createRngBundle(s);
        const straightTail = {} as Record<string, number[]>;
        for (const name of RNG_STREAM_NAMES) {
          for (let i = 0; i < n; i++) straight[name].next();
        }
        for (const name of RNG_STREAM_NAMES) {
          const tail: number[] = [];
          for (let i = 0; i < m; i++) tail.push(straight[name].next());
          straightTail[name] = tail;
        }

        // Split run: N, serialize, deserialize, M.
        const split = createRngBundle(s);
        for (const name of RNG_STREAM_NAMES) {
          for (let i = 0; i < n; i++) split[name].next();
        }
        const resumed = deserializeRng(serializeRng(split));
        for (const name of RNG_STREAM_NAMES) {
          const expected = straightTail[name] ?? [];
          for (let i = 0; i < m; i++) {
            expect(resumed[name].next()).toBe(expected[i]);
          }
        }
      }),
    );
  });

  it("serialized form is one integer per stream", () => {
    const data = serializeRng(createRngBundle(7));
    for (const name of RNG_STREAM_NAMES) {
      expect(Number.isInteger(data[name])).toBe(true);
      expect(data[name]).toBeGreaterThanOrEqual(0);
      expect(data[name]).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("gaussian", () => {
  it("is deterministic for a given stream state", () => {
    const a = mulberry32(999);
    const b = mulberry32(999);
    for (let i = 0; i < 50; i++) expect(gaussian(a)).toBe(gaussian(b));
  });

  it("draws are finite (u1 clamped away from 0)", () => {
    const r = mulberry32(3);
    for (let i = 0; i < 1000; i++) expect(Number.isFinite(gaussian(r))).toBe(true);
  });

  it("holds no cached spare: state after gaussian fully determines the next gaussian", () => {
    const r = mulberry32(555);
    gaussian(r);
    const midState = r.state;
    const next = gaussian(r);
    // A fresh generator at the captured state reproduces the very next draw —
    // proving no spare normal is hidden outside `state`.
    expect(gaussian(mulberry32(midState))).toBe(next);
  });

  it("roughly standard-normal over many draws (loose sanity)", () => {
    const r = mulberry32(2024);
    const N = 20000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const g = gaussian(r);
      sum += g;
      sumSq += g * g;
    }
    const mean = sum / N;
    const variance = sumSq / N - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(variance - 1)).toBeLessThan(0.1);
  });
});
