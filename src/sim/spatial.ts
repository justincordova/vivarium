/**
 * spatial.ts — hash-grid neighbor index + the single canonical `localDensity`.
 *
 * Sensors (nearest food/threat/mate, density #11) and contest reach all query
 * this. Density-dependent removal and sensor #11 must read the **same**
 * `localDensity` (SPEC.md §Removal, §Sensors — "there is exactly one density
 * definition in the sim").
 *
 * Determinism: no `Set`/`Object.keys` iteration; results are order-independent
 * because every query resolves ties by ascending entity `id` (SPEC.md §"What
 * counts as food/threat/mate"). Part of `sim/`: imports nothing.
 */

/** A point with a stable id — the unit the grid indexes. */
export interface SpatialPoint {
  id: number;
  x: number;
  y: number;
}

/** Boundary rule (pinned): a point is "within radius" iff `dist <= radius`. */
function withinRadius(dx: number, dy: number, radius: number): boolean {
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * A uniform hash grid over continuous positions. Built once per query-batch from a
 * point array; rebuilt (not incrementally updated) each tick by the caller. Cell
 * size is passed in — it is a query-cost knob, not a correctness one.
 */
export class SpatialHash {
  readonly cellSize: number;
  /**
   * cellKey → indices into `points` occupying that cell. Keys are strings
   * (`"cx,cy"`) to avoid the integer-packing aliasing that would make two distinct
   * cells share a bucket for large or negative cell coords. The `Map` is only ever
   * `.get`-queried by key, never iterated, so its insertion order does not affect
   * determinism.
   */
  private readonly cells: Map<string, number[]>;
  private readonly points: readonly SpatialPoint[];

  constructor(points: readonly SpatialPoint[], cellSize: number) {
    if (cellSize <= 0) throw new Error("cellSize must be > 0");
    this.cellSize = cellSize;
    this.points = points;
    this.cells = new Map();
    // Index by array position (index-based; no Set/Object.keys iteration).
    for (let i = 0; i < points.length; i++) {
      const p = points[i] as SpatialPoint;
      const key = this.cellKey(this.cellCoord(p.x), this.cellCoord(p.y));
      const bucket = this.cells.get(key);
      if (bucket === undefined) this.cells.set(key, [i]);
      else bucket.push(i);
    }
  }

  private cellCoord(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  /** Deterministic, aliasing-free cell key from integer cell coords. */
  private cellKey(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  /**
   * Collect indices of every point whose cell overlaps the query disc's bounding
   * box. A superset of the true neighbors (callers apply the exact `withinRadius`
   * test); scanning the bounding block of cells is what makes the query cheap.
   */
  private candidateIndices(x: number, y: number, radius: number): number[] {
    const out: number[] = [];
    const minCx = this.cellCoord(x - radius);
    const maxCx = this.cellCoord(x + radius);
    const minCy = this.cellCoord(y - radius);
    const maxCy = this.cellCoord(y + radius);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.cells.get(this.cellKey(cx, cy));
        if (bucket === undefined) continue;
        for (let b = 0; b < bucket.length; b++) out.push(bucket[b] as number);
      }
    }
    return out;
  }

  /**
   * Ids of all indexed points within `radius` of `(x, y)`. A bounded query
   * (O(neighbors)) callers use to avoid O(N) scans; the exact `withinRadius` filter
   * is applied so results are precise, not just the cell-block superset.
   */
  queryWithin(x: number, y: number, radius: number): number[] {
    const candidates = this.candidateIndices(x, y, radius);
    const out: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const p = this.points[candidates[i] as number] as SpatialPoint;
      const dx = p.x - x;
      const dy = p.y - y;
      if (withinRadius(dx, dy, radius)) out.push(p.id);
    }
    return out;
  }

  /**
   * Nearest point (by Euclidean distance) within `radius` of `(x, y)` for which
   * `predicate` holds, **ties broken by ascending `id`** — a total, deterministic
   * order independent of scan order. Returns `null` if none qualifies.
   *
   * `predicate` lets the caller express food/threat/mate classification (which is
   * relative to the perceiving creature).
   */
  nearestWithin(
    x: number,
    y: number,
    radius: number,
    predicate: (p: SpatialPoint) => boolean,
  ): SpatialPoint | null {
    const candidates = this.candidateIndices(x, y, radius);
    let best: SpatialPoint | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;
    for (let i = 0; i < candidates.length; i++) {
      const p = this.points[candidates[i] as number] as SpatialPoint;
      const dx = p.x - x;
      const dy = p.y - y;
      if (!withinRadius(dx, dy, radius)) continue;
      if (!predicate(p)) continue;
      const distSq = dx * dx + dy * dy;
      if (
        distSq < bestDistSq ||
        // Exact-distance tie → prefer the lower id (deterministic total order).
        (distSq === bestDistSq && best !== null && p.id < best.id)
      ) {
        best = p;
        bestDistSq = distSq;
      }
    }
    return best;
  }

  /**
   * Count of points within `radius` of `(x, y)` satisfying `predicate` (default:
   * all). **The single canonical density definition** — sensor #11 and
   * density-dependent removal both call this and must never diverge (SPEC.md
   * §Removal). Includes a point at its own position if it is in the index; callers
   * that want to exclude self pass a predicate.
   */
  countWithin(
    x: number,
    y: number,
    radius: number,
    predicate: (p: SpatialPoint) => boolean = () => true,
  ): number {
    const candidates = this.candidateIndices(x, y, radius);
    let count = 0;
    for (let i = 0; i < candidates.length; i++) {
      const p = this.points[candidates[i] as number] as SpatialPoint;
      const dx = p.x - x;
      const dy = p.y - y;
      if (withinRadius(dx, dy, radius) && predicate(p)) count++;
    }
    return count;
  }
}

/**
 * The canonical `localDensity(pos)`: living-agent count within `radius` of a
 * position. A thin, named wrapper over `SpatialHash.countWithin` so there is one
 * import-able density function (SPEC.md §Removal — sensor #11 and the removal
 * penalty read this same value).
 */
export function localDensity(hash: SpatialHash, x: number, y: number, radius: number): number {
  return hash.countWithin(x, y, radius);
}
