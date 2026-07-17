/**
 * temperature.test.ts — deterministic seasonal + day/night temperature (Phase 5C.1).
 *
 * Temperature must be a pure, deterministic function of `world.tick` (no RNG, no
 * `Math.sin` — cross-engine bit-identical), cycle seasonally + across day/night, and
 * impose a conserved cold surcharge that selects through `size`. These pin the model.
 */

import { makeConfig } from "@sim/config";
import { totalEnergy, totalWater } from "@sim/stats";
import { temperatureAt, tick } from "@sim/tick";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";

describe("temperatureAt — deterministic season + day/night", () => {
  const t = makeConfig({}).tunables;

  it("is a pure function of tick (identical inputs → identical output)", () => {
    for (const k of [0, 137, 5000, 123456]) {
      expect(temperatureAt(k, t)).toBe(temperatureAt(k, t));
    }
  });

  it("drops by exactly the night drop across the same instant's day boundary", () => {
    // The night drop is a step at day-phase 0.5. Compare two ticks straddling it at the
    // SAME season phase (adjacent ticks → season component identical to FP precision).
    const half = Math.floor(t.TICKS_PER_DAY * 0.5);
    const justBeforeNight = half - 1; // day
    const justAfterNight = half; // night
    const gap = temperatureAt(justBeforeNight, t) - temperatureAt(justAfterNight, t);
    // Only the night drop differs (season phase moves one tick → negligible).
    expect(gap).toBeGreaterThan(t.TEMP_NIGHT_DROP - 0.5);
    expect(gap).toBeLessThan(t.TEMP_NIGHT_DROP + 0.5);
  });

  it("cycles seasonally: mid-season is warmer than a season edge (daytime)", () => {
    const seasonTicks = t.TICKS_PER_DAY * t.DAYS_PER_SEASON;
    // Daytime samples at season edge (phase 0) vs mid-season (phase 0.5).
    const edge = temperatureAt(0, t); // day-phase 0, season-phase 0
    const mid = temperatureAt(Math.floor(seasonTicks * 0.5), t); // season peak
    expect(mid).toBeGreaterThan(edge);
  });

  it("stays within the baseline ± amplitude (minus night drop) band", () => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const seasonTicks = t.TICKS_PER_DAY * t.DAYS_PER_SEASON;
    for (let k = 0; k < seasonTicks; k += 50) {
      const v = temperatureAt(k, t);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(max).toBeLessThanOrEqual(t.TEMP_BASELINE + t.TEMP_SEASON_AMPLITUDE + 1e-6);
    expect(min).toBeGreaterThanOrEqual(
      t.TEMP_BASELINE - t.TEMP_SEASON_AMPLITUDE - t.TEMP_NIGHT_DROP - 1e-6,
    );
  });

  it("temperatureAt uses no Math.sin/exp (cross-engine determinism)", async () => {
    // temperatureAt feeds sensor 13 AND the metabolic surcharge (both determinism-
    // critical), so it must use the pinned triangle wave, not Math.sin (which movement
    // kinematics elsewhere in tick.ts legitimately use for position, off the pinned path).
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/sim/tick.ts", import.meta.url), "utf8"),
    );
    const start = src.indexOf("export function temperatureAt");
    const body = src.slice(start, src.indexOf("\n}", start));
    expect(/Math\.(sin|cos|exp|tanh)\s*\(/.test(body)).toBe(false);
  });
});

describe("temperature surcharge — conservation holds with seasons on", () => {
  it("cold cells impose a surcharge but totalEnergy/totalWater stay exact", () => {
    // A cold world: shift comfort high so the surcharge fires frequently.
    const w = createWorld(1, makeConfig({ tunables: { TEMP_COMFORT: 40, TEMP_COLD_COEF: 0.5 } }));
    const e0 = totalEnergy(w);
    const wat0 = totalWater(w);
    for (let i = 0; i < 400; i++) {
      tick(w);
      expect(totalEnergy(w)).toBe(e0);
      expect(totalWater(w)).toBe(wat0);
    }
    // The field is written inside resolveFields BEFORE `world.tick++`, so it reflects
    // the temperature at `w.tick - 1` (Float32 storage → compare the fround'd value).
    expect(w.fields.temperature[0]).toBe(Math.fround(temperatureAt(w.tick - 1, w.config.tunables)));
  });
});
