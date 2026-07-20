import { defaultConfig, makeConfig, makeDefaultConfig } from "@sim/config";
import type { Config, Tunables } from "@sim/types";
import { RNG_STREAM_NAMES } from "@sim/types";
import { describe, expect, it } from "vitest";

describe("config — defaultConfig completeness", () => {
  it("has a defined value for every Config field", () => {
    const requiredTop: (keyof Config)[] = [
      "worldWidth",
      "worldHeight",
      "gridCols",
      "gridRows",
      "initialSolarReservoir",
      "founderCount",
      "hidden",
      "brainKind",
      "rngStreams",
      "tunables",
    ];
    for (const k of requiredTop) {
      expect(defaultConfig[k], `missing Config field: ${k}`).not.toBeUndefined();
    }
  });

  it("is deep-frozen so it cannot be mutated as a shared reference", () => {
    expect(Object.isFrozen(defaultConfig)).toBe(true);
    expect(Object.isFrozen(defaultConfig.tunables)).toBe(true);
    expect(Object.isFrozen(defaultConfig.tunables.TRAIT_MUT_SIGMA)).toBe(true);
    expect(Object.isFrozen(defaultConfig.rngStreams)).toBe(true);
    expect(() => {
      (defaultConfig as { worldWidth: number }).worldWidth = 1;
    }).toThrow();
  });

  it("makeConfig results are NOT frozen (mutable working copies)", () => {
    expect(Object.isFrozen(makeConfig({}))).toBe(false);
    expect(Object.isFrozen(makeConfig({}).tunables)).toBe(false);
  });

  it("serializes the full 8-stream RNG layout", () => {
    expect(defaultConfig.rngStreams).toEqual([...RNG_STREAM_NAMES]);
    expect(defaultConfig.rngStreams).toHaveLength(8);
  });

  it("Phase 0 defaults: rule brain, founder count in the SPEC 40–100 band", () => {
    expect(defaultConfig.brainKind).toBe("rule");
    expect(defaultConfig.founderCount).toBeGreaterThanOrEqual(40);
    expect(defaultConfig.founderCount).toBeLessThanOrEqual(100);
  });

  it("every Tunables field is a defined number (or a per-gene sigma record)", () => {
    const t = defaultConfig.tunables;
    const recordFields = new Set<keyof Tunables>(["TRAIT_MUT_SIGMA", "PLANT_MUT_SIGMA"]);
    for (const [key, value] of Object.entries(t) as [keyof Tunables, unknown][]) {
      if (recordFields.has(key)) {
        expect(typeof value).toBe("object");
        continue;
      }
      expect(value, `tunable ${String(key)} not numeric`).toBeTypeOf("number");
    }
  });
});

describe("config — makeConfig", () => {
  it("makeConfig({}) deep-equals defaultConfig", () => {
    expect(makeConfig({})).toEqual(defaultConfig);
  });

  it("applies a top-level override without touching the rest", () => {
    const cfg = makeConfig({ founderCount: 42 });
    expect(cfg.founderCount).toBe(42);
    expect(cfg.worldWidth).toBe(defaultConfig.worldWidth);
  });

  it("applies a partial tunables override, keeping other tunables", () => {
    const cfg = makeConfig({ tunables: { MUT_GLOBAL: 2 } });
    expect(cfg.tunables.MUT_GLOBAL).toBe(2);
    expect(cfg.tunables.WEIGHT_MUT_RATE).toBe(defaultConfig.tunables.WEIGHT_MUT_RATE);
  });

  it("merges a partial TRAIT_MUT_SIGMA without dropping other genes", () => {
    const cfg = makeConfig({ tunables: { TRAIT_MUT_SIGMA: { size: 0.99 } } });
    expect(cfg.tunables.TRAIT_MUT_SIGMA.size).toBe(0.99);
    expect(cfg.tunables.TRAIT_MUT_SIGMA.speed).toBe(defaultConfig.tunables.TRAIT_MUT_SIGMA.speed);
  });

  it("deep-copies: mutating a result never mutates defaultConfig or another result", () => {
    const a = makeConfig({});
    a.tunables.MUT_GLOBAL = 999;
    a.tunables.TRAIT_MUT_SIGMA.size = 999;
    a.rngStreams = [];
    expect(defaultConfig.tunables.MUT_GLOBAL).not.toBe(999);
    expect(defaultConfig.tunables.TRAIT_MUT_SIGMA.size).not.toBe(999);
    expect(defaultConfig.rngStreams).toHaveLength(8);
    expect(makeConfig({}).tunables.MUT_GLOBAL).not.toBe(999);
  });

  it("makeDefaultConfig returns independent instances", () => {
    const a = makeDefaultConfig();
    const b = makeDefaultConfig();
    expect(a).not.toBe(b);
    expect(a.tunables).not.toBe(b.tunables);
    a.tunables.MUT_GLOBAL = 7;
    expect(b.tunables.MUT_GLOBAL).not.toBe(7);
  });
});
