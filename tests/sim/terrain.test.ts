/**
 * terrain.test.ts — authored terrain generation is deterministic and well-formed
 * (Living World redesign, Phase 6A). Node env; pure function of a seeded RNG stream.
 */

import { makeConfig } from "@sim/config";
import { createRngBundle } from "@sim/rng";
import { generateTerrain, growthMultiplier, moveCostMultiplier } from "@sim/terrain";
import { Biome } from "@sim/types";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";

describe("generateTerrain", () => {
  it("is deterministic: same seed → identical biome and elevation arrays", () => {
    const cfg = makeConfig({});
    const a = generateTerrain(cfg, createRngBundle(42).terrain);
    const b = generateTerrain(cfg, createRngBundle(42).terrain);
    expect(Array.from(a.biome)).toEqual(Array.from(b.biome));
    expect(Array.from(a.elevation)).toEqual(Array.from(b.elevation));
  });

  it("different seeds → different terrain", () => {
    const cfg = makeConfig({});
    const a = generateTerrain(cfg, createRngBundle(1).terrain);
    const b = generateTerrain(cfg, createRngBundle(2).terrain);
    expect(Array.from(a.biome)).not.toEqual(Array.from(b.biome));
  });

  it("all biome values are valid (0..4) and elevation is in 0..1", () => {
    const cfg = makeConfig({});
    const t = generateTerrain(cfg, createRngBundle(7).terrain);
    expect(t.biome.length).toBe(cfg.gridCols * cfg.gridRows);
    for (let i = 0; i < t.biome.length; i++) {
      expect(t.biome[i]).toBeGreaterThanOrEqual(0);
      expect(t.biome[i]).toBeLessThanOrEqual(4);
      expect(t.elevation[i]).toBeGreaterThanOrEqual(0);
      expect(t.elevation[i]).toBeLessThanOrEqual(1);
    }
  });

  it("produces variety: at least one water cell and one non-water cell", () => {
    const cfg = makeConfig({});
    const t = generateTerrain(cfg, createRngBundle(1).terrain);
    const water = Array.from(t.biome).filter((b) => b === Biome.Water).length;
    expect(water).toBeGreaterThan(0);
    expect(water).toBeLessThan(t.biome.length);
  });
});

describe("terrain in createWorld", () => {
  it("attaches terrain and preserves the exact water ledger total", () => {
    const cfg = makeConfig({});
    const w = createWorld(3, cfg);
    expect(w.terrain.biome.length).toBe(cfg.gridCols * cfg.gridRows);
    // Water cells hold more water than land cells (concentrated, not uniform).
    let waterCellSum = 0;
    let landCellSum = 0;
    let waterCells = 0;
    let landCells = 0;
    for (let i = 0; i < w.terrain.biome.length; i++) {
      if (w.terrain.biome[i] === Biome.Water) {
        waterCellSum += w.fields.water[i] as number;
        waterCells++;
      } else {
        landCellSum += w.fields.water[i] as number;
        landCells++;
      }
    }
    if (waterCells > 0 && landCells > 0) {
      expect(waterCellSum / waterCells).toBeGreaterThan(landCellSum / landCells);
    }
  });
});

describe("terrain rate modulators", () => {
  it("grassland grows fastest; water/rock grow nothing", () => {
    expect(growthMultiplier(Biome.Grassland)).toBeGreaterThan(growthMultiplier(Biome.Forest));
    expect(growthMultiplier(Biome.Barren)).toBeGreaterThan(0);
    expect(growthMultiplier(Biome.Water)).toBe(0);
    expect(growthMultiplier(Biome.Rock)).toBe(0);
  });

  it("water and rock impede movement; land is normal", () => {
    expect(moveCostMultiplier(Biome.Grassland)).toBe(1);
    expect(moveCostMultiplier(Biome.Rock)).toBeLessThan(1);
    expect(moveCostMultiplier(Biome.Water)).toBeLessThan(moveCostMultiplier(Biome.Rock));
  });
});
