import { localDensity, SpatialHash, type SpatialPoint } from "@sim/spatial";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

/** Brute-force nearest with the same id-tiebreak, as an independent oracle. */
function bruteNearest(
  points: SpatialPoint[],
  x: number,
  y: number,
  radius: number,
  predicate: (p: SpatialPoint) => boolean = () => true,
): SpatialPoint | null {
  let best: SpatialPoint | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const dx = p.x - x;
    const dy = p.y - y;
    const d = dx * dx + dy * dy;
    if (d > radius * radius) continue;
    if (!predicate(p)) continue;
    if (d < bestD || (d === bestD && best !== null && p.id < best.id)) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

describe("SpatialHash — nearestWithin", () => {
  it("returns the geometrically nearest point", () => {
    const points: SpatialPoint[] = [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 5, y: 0 },
      { id: 2, x: 2, y: 0 },
    ];
    const h = new SpatialHash(points, 3);
    expect(h.nearestWithin(0, 0, 10, () => true)?.id).toBe(0);
    expect(h.nearestWithin(4, 0, 10, () => true)?.id).toBe(1);
  });

  it("breaks exact-distance ties by ascending id", () => {
    // Two points equidistant from the query; the lower id must win regardless of
    // insertion order.
    const points: SpatialPoint[] = [
      { id: 7, x: 3, y: 0 },
      { id: 2, x: -3, y: 0 },
    ];
    const h1 = new SpatialHash(points, 2);
    expect(h1.nearestWithin(0, 0, 10, () => true)?.id).toBe(2);
    // Reverse insertion order → same result (order-independent).
    const h2 = new SpatialHash([...points].reverse(), 2);
    expect(h2.nearestWithin(0, 0, 10, () => true)?.id).toBe(2);
  });

  it("honors the predicate (relative food/threat/mate classification)", () => {
    const points: SpatialPoint[] = [
      { id: 0, x: 1, y: 0 },
      { id: 1, x: 2, y: 0 },
    ];
    const h = new SpatialHash(points, 4);
    expect(h.nearestWithin(0, 0, 10, (p) => p.id !== 0)?.id).toBe(1);
  });

  it("returns null when nothing qualifies in radius", () => {
    const h = new SpatialHash([{ id: 0, x: 100, y: 100 }], 4);
    expect(h.nearestWithin(0, 0, 5, () => true)).toBeNull();
  });

  it("boundary is inclusive: dist === radius is inside, dist > radius is out", () => {
    const at = new SpatialHash([{ id: 0, x: 5, y: 0 }], 3);
    expect(at.nearestWithin(0, 0, 5, () => true)?.id).toBe(0); // dist === radius
    const beyond = new SpatialHash([{ id: 0, x: 5.0001, y: 0 }], 3);
    expect(beyond.nearestWithin(0, 0, 5, () => true)).toBeNull();
  });

  it("matches a brute-force oracle over random points/queries (fast-check)", () => {
    const pointArb = fc.array(
      fc.record({
        id: fc.integer({ min: 0, max: 1000 }),
        x: fc.integer({ min: -50, max: 50 }),
        y: fc.integer({ min: -50, max: 50 }),
      }),
      { maxLength: 40 },
    );
    fc.assert(
      fc.property(
        pointArb,
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 20 }),
        (raw, qx, qy, radius, cellSize) => {
          // Dedupe ids so the tiebreak oracle is unambiguous.
          const seen = new Set<number>();
          const points = raw.filter((p) => {
            if (seen.has(p.id)) return false;
            seen.add(p.id);
            return true;
          });
          const h = new SpatialHash(points, cellSize);
          const got = h.nearestWithin(qx, qy, radius, () => true);
          const want = bruteNearest(points, qx, qy, radius);
          expect(got?.id ?? null).toBe(want?.id ?? null);
        },
      ),
    );
  });
});

describe("SpatialHash — countWithin / localDensity", () => {
  it("counts points inside the radius, inclusive of the boundary", () => {
    const points: SpatialPoint[] = [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 3, y: 0 }, // dist 3
      { id: 2, x: 5, y: 0 }, // dist 5 (=== radius)
      { id: 3, x: 6, y: 0 }, // dist 6 (out)
    ];
    const h = new SpatialHash(points, 2);
    expect(localDensity(h, 0, 0, 5)).toBe(3);
  });

  it("localDensity matches countWithin (same canonical definition)", () => {
    const pointArb = fc.array(
      fc.record({
        id: fc.integer({ min: 0, max: 1000 }),
        x: fc.integer({ min: -30, max: 30 }),
        y: fc.integer({ min: -30, max: 30 }),
      }),
      { maxLength: 50 },
    );
    fc.assert(
      fc.property(
        pointArb,
        fc.integer({ min: -30, max: 30 }),
        fc.integer({ min: -30, max: 30 }),
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 15 }),
        (points, qx, qy, radius, cellSize) => {
          const h = new SpatialHash(points, cellSize);
          // Brute count as oracle.
          let brute = 0;
          for (const p of points) {
            const dx = p.x - qx;
            const dy = p.y - qy;
            if (dx * dx + dy * dy <= radius * radius) brute++;
          }
          expect(localDensity(h, qx, qy, radius)).toBe(brute);
        },
      ),
    );
  });

  it("cell size does not change results, only cost (fast-check)", () => {
    const points: SpatialPoint[] = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      x: (i * 7) % 40,
      y: (i * 13) % 40,
    }));
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 25 }), fc.integer({ min: 1, max: 25 }), (c1, c2) => {
        const a = localDensity(new SpatialHash(points, c1), 20, 20, 15);
        const b = localDensity(new SpatialHash(points, c2), 20, 20, 15);
        expect(a).toBe(b);
      }),
    );
  });
});

describe("SpatialHash — guards", () => {
  it("rejects non-positive cell size", () => {
    expect(() => new SpatialHash([], 0)).toThrow();
    expect(() => new SpatialHash([], -1)).toThrow();
  });
});
