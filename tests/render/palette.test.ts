/**
 * palette.test.ts — the pure genome→appearance mapping (SPEC.md §Visual Design).
 * Node env: `appearance` is a pure function of the lean frame channels.
 */

import type { CreatureFrame } from "@worker/protocol";
import { describe, expect, it } from "vitest";
import { appearance } from "../../src/render/palette";

/** Build a one-creature CreatureFrame with the given expressed channel values. */
function frameOf(v: {
  hue?: number;
  size?: number;
  energyFrac?: number;
  diet?: number;
  armor?: number;
  toxicity?: number;
  age?: number;
}): CreatureFrame {
  return {
    count: 1,
    ids: Int32Array.of(1),
    x: Float32Array.of(0),
    y: Float32Array.of(0),
    heading: Float32Array.of(0),
    hue: Float32Array.of(v.hue ?? 200),
    size: Float32Array.of(v.size ?? 1),
    energyFrac: Float32Array.of(v.energyFrac ?? 1),
    diet: Float32Array.of(v.diet ?? 0),
    armor: Float32Array.of(v.armor ?? 0),
    toxicity: Float32Array.of(v.toxicity ?? 0),
    age: Float32Array.of(v.age ?? 0),
  };
}

/** Extract the saturation percentage from an `hsl(h s% l%)` string. */
function satOf(hsl: string): number {
  const m = hsl.match(/hsl\(\s*[\d.]+\s+([\d.]+)%/);
  if (m === null) throw new Error(`not an hsl string: ${hsl}`);
  return Number(m[1]);
}

describe("appearance", () => {
  it("maps two hues to two distinguishable colors", () => {
    const a = appearance(frameOf({ hue: 10 }), 0);
    const b = appearance(frameOf({ hue: 210 }), 0);
    expect(a.fill).not.toBe(b.fill);
    expect(a.fill).toContain("hsl(10");
    expect(b.fill).toContain("hsl(210");
  });

  it("a starving creature is washed out (lower saturation) than a fed one", () => {
    const fed = appearance(frameOf({ energyFrac: 1 }), 0);
    const starving = appearance(frameOf({ energyFrac: 0 }), 0);
    expect(satOf(starving.fill)).toBeLessThan(satOf(fed.fill));
  });

  it("herbivores read round (many vertices), carnivores angular (few)", () => {
    const herb = appearance(frameOf({ diet: 0 }), 0);
    const carn = appearance(frameOf({ diet: 1 }), 0);
    expect(herb.vertices).toBeGreaterThan(carn.vertices);
    expect(carn.vertices).toBeGreaterThanOrEqual(3);
  });

  it("larger size → larger radius", () => {
    const small = appearance(frameOf({ size: 0.5 }), 0);
    const big = appearance(frameOf({ size: 9 }), 0);
    expect(big.radius).toBeGreaterThan(small.radius);
  });

  it("armor grows spikes; no armor → no spikes", () => {
    const bare = appearance(frameOf({ armor: 0 }), 0);
    const armored = appearance(frameOf({ armor: 9 }), 0);
    expect(bare.spikes).toBe(0);
    expect(armored.spikes).toBeGreaterThan(0);
  });

  it("high toxicity flags the ornament ring", () => {
    expect(appearance(frameOf({ toxicity: 0 }), 0).toxic).toBe(false);
    expect(appearance(frameOf({ toxicity: 9 }), 0).toxic).toBe(true);
  });

  it("age strengthens the outline ring", () => {
    const young = appearance(frameOf({ age: 0 }), 0);
    const old = appearance(frameOf({ age: 5000 }), 0);
    expect(old.ageRing).toBeGreaterThan(young.ageRing);
  });

  it("hue wraps into 0..360", () => {
    const a = appearance(frameOf({ hue: 370 }), 0);
    expect(a.fill).toContain("hsl(10");
    const b = appearance(frameOf({ hue: -10 }), 0);
    expect(b.fill).toContain("hsl(350");
  });
});
