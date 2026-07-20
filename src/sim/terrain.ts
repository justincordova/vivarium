/**
 * terrain.ts — pure, deterministic terrain generation + rate modulators
 * (Living World redesign, Phase 6A).
 *
 * Authored terrain: generated ONCE at world creation from a passed `terrain` RNG
 * sub-stream, then read-only during `tick()`. It imports nothing but types, uses no
 * `Math.random`, and iterates index-based — so it is deterministic and testable in
 * Node like the rest of `sim/`. It mints/destroys nothing: the multipliers below only
 * scale rates the tick already computes.
 */

import { Biome, type Config, type RNG, type Terrain } from "./types";

/** Elevation below this is water; above `ROCK_LEVEL` is rock. Tuned for variety. */
const WATER_LEVEL = 0.34;
const ROCK_LEVEL = 0.78;

/**
 * Value-noise sampled on a coarse lattice and bilinearly interpolated, summed over a
 * couple of octaves. Lattice values are drawn from the RNG up front (deterministic),
 * so the whole field is a pure function of the stream state.
 */
function makeNoise(rng: RNG, lattice: number): number[] {
  const n = (lattice + 1) * (lattice + 1);
  const g = new Array<number>(n);
  for (let i = 0; i < n; i++) g[i] = rng.next();
  return g;
}

function sampleNoise(g: number[], lattice: number, u: number, v: number): number {
  // u,v in 0..1 → lattice cell + local fraction, bilinear blend with smoothstep.
  const fx = u * lattice;
  const fy = v * lattice;
  const x0 = Math.min(lattice - 1, Math.floor(fx));
  const y0 = Math.min(lattice - 1, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const row = lattice + 1;
  const v00 = g[y0 * row + x0] as number;
  const v10 = g[y0 * row + x0 + 1] as number;
  const v01 = g[(y0 + 1) * row + x0] as number;
  const v11 = g[(y0 + 1) * row + x0 + 1] as number;
  const top = v00 + (v10 - v00) * sx;
  const bot = v01 + (v11 - v01) * sx;
  return top + (bot - top) * sy;
}

/**
 * Generate the terrain layer for `config`, seeded from the passed `terrain` stream.
 * Elevation = 2-octave value noise (0..1). Biome is classified from elevation plus a
 * separate moisture noise: low → Water, high → Rock, dry-mid → Barren, moist-mid split
 * Forest/Grassland.
 */
export function generateTerrain(config: Config, rng: RNG): Terrain {
  const { gridCols: cols, gridRows: rows } = config;
  const cells = cols * rows;
  const biome = new Uint8Array(cells);
  const elevation = new Float32Array(cells);

  // Draw all lattice values up front (deterministic; order fixed).
  const elevA = makeNoise(rng, 4);
  const elevB = makeNoise(rng, 8);
  const moist = makeNoise(rng, 5);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const u = cols <= 1 ? 0 : col / (cols - 1);
      const v = rows <= 1 ? 0 : row / (rows - 1);
      // Two octaves; the fine octave adds detail at lower weight.
      const e = 0.68 * sampleNoise(elevA, 4, u, v) + 0.32 * sampleNoise(elevB, 8, u, v);
      elevation[i] = e;
      const m = sampleNoise(moist, 5, u, v);

      let b: Biome;
      if (e < WATER_LEVEL) b = Biome.Water;
      else if (e > ROCK_LEVEL) b = Biome.Rock;
      else if (m < 0.38) b = Biome.Barren;
      else if (m > 0.62) b = Biome.Forest;
      else b = Biome.Grassland;
      biome[i] = b;
    }
  }

  return { biome, elevation };
}

/**
 * Plant-growth multiplier by biome (Living World §Biomes as selection pressure).
 * Grassland is food-rich; forest medium; barren sparse; rock/water grow nothing.
 * Applied to the integer `grow` amount in `tick.ts` (still `toQuantum`-floored, so the
 * ledger stays integer and conserved — this scales a rate, it does not mint energy).
 */
export function growthMultiplier(biome: number): number {
  switch (biome) {
    case Biome.Grassland:
      return 1.4;
    case Biome.Forest:
      return 1.0;
    case Biome.Barren:
      return 0.2;
    default: // Water, Rock
      return 0;
  }
}

/**
 * Movement multiplier by biome. Rock is slow, water near-impassable; land is normal.
 * Scales `vx/vy` at the position update — affects POSITION only, no ledger.
 */
export function moveCostMultiplier(biome: number): number {
  switch (biome) {
    case Biome.Rock:
      return 0.4;
    case Biome.Water:
      return 0.15;
    default: // Grassland, Forest, Barren
      return 1;
  }
}
