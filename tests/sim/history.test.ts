import { makeConfig } from "@sim/config";
import * as C from "@sim/constants";
import {
  countExtinctionEvents,
  downsampleOldHistory,
  recentPopulationSeries,
  recordHistory,
} from "@sim/history";
import { deserialize, serialize } from "@sim/serialize";
import { tick } from "@sim/tick";
import type { World } from "@sim/types";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";

function runWithHistory(seed: number, ticks: number): World {
  const w = createWorld(seed, makeConfig({}));
  recordHistory(w); // sample tick 0
  for (let i = 0; i < ticks; i++) {
    tick(w);
    recordHistory(w);
  }
  return w;
}

describe("history sampling", () => {
  it("samples on the HISTORY_SAMPLE_INTERVAL cadence", () => {
    const w = runWithHistory(42, C.HISTORY_SAMPLE_INTERVAL * 3);
    // Samples at ticks 0, interval, 2*interval, 3*interval → 4 entries (nothing thinned
    // yet since well under the recent window).
    const ticksSampled = w.history.map((h) => h.tick);
    expect(ticksSampled).toEqual([
      0,
      C.HISTORY_SAMPLE_INTERVAL,
      C.HISTORY_SAMPLE_INTERVAL * 2,
      C.HISTORY_SAMPLE_INTERVAL * 3,
    ]);
  });

  it("recent window stays full-detail; older entries are downsampled", () => {
    // Drive the downsampler directly with synthetic samples (fast — avoids running
    // tens of thousands of real ticks just to exercise pruning). Populate history at
    // full cadence past the recent window, calling downsampleOldHistory each push.
    const w = createWorld(7, makeConfig({}));
    const totalSamples = C.HISTORY_RECENT_WINDOW + 50;
    for (let s = 0; s <= totalSamples; s++) {
      w.history.push({
        tick: s * C.HISTORY_SAMPLE_INTERVAL,
        population: 10,
        plantCount: 0,
        corpseCount: 0,
      });
      downsampleOldHistory(w);
    }

    // The most recent HISTORY_RECENT_WINDOW samples are contiguous at full cadence.
    const recent = w.history.slice(-C.HISTORY_RECENT_WINDOW);
    for (let i = 1; i < recent.length; i++) {
      const dt = (recent[i]?.tick ?? 0) - (recent[i - 1]?.tick ?? 0);
      expect(dt).toBe(C.HISTORY_SAMPLE_INTERVAL);
    }

    // Older-than-window samples are thinned to <= 1 per HISTORY_DOWNSAMPLE_TICKS: no
    // two kept old samples share a downsample bucket.
    const old = w.history.slice(0, w.history.length - C.HISTORY_RECENT_WINDOW);
    const buckets = old.map((h) => Math.floor(h.tick / C.HISTORY_DOWNSAMPLE_TICKS));
    expect(new Set(buckets).size).toBe(buckets.length);
  });

  it("per-gene trait moments are recorded on each sample", () => {
    const w = runWithHistory(3, C.HISTORY_SAMPLE_INTERVAL);
    const last = w.history[w.history.length - 1];
    expect(last?.traitMeans?.size).toBeTypeOf("number");
    expect(last?.traitVariances?.size).toBeTypeOf("number");
    expect(last?.speciesCount).toBeTypeOf("number");
  });

  it("recentPopulationSeries returns the recent-window populations in order", () => {
    const w = runWithHistory(9, C.HISTORY_SAMPLE_INTERVAL * 5);
    const series = recentPopulationSeries(w);
    expect(series.length).toBeLessThanOrEqual(C.HISTORY_RECENT_WINDOW);
    expect(series[series.length - 1]).toBe(w.creatures.length);
  });
});

describe("extinction events", () => {
  it("emits an 'extinct' event when population crosses to zero", () => {
    const w = createWorld(1, makeConfig({}));
    // Seed a positive prior sample, then force extinction and sample again.
    recordHistory(w); // tick 0, positive population
    w.creatures = [];
    w.creatureIds = [];
    w.tick = C.HISTORY_SAMPLE_INTERVAL; // land on a sample tick
    recordHistory(w);
    expect(countExtinctionEvents(w)).toBe(1);
  });
});

describe("history survives serialization roundtrip", () => {
  it("serialize → deserialize preserves the history shape", () => {
    const w = runWithHistory(21, C.HISTORY_SAMPLE_INTERVAL * 4);
    const restored = deserialize(serialize(w));
    expect(restored.history.length).toBe(w.history.length);
    expect(restored.history.map((h) => h.tick)).toEqual(w.history.map((h) => h.tick));
    expect(restored.history.map((h) => h.population)).toEqual(w.history.map((h) => h.population));
    // Per-gene moments survive too.
    const a = restored.history[restored.history.length - 1];
    const b = w.history[w.history.length - 1];
    expect(a?.speciesCount).toBe(b?.speciesCount);
  });

  it("per-creature actionWindow survives the roundtrip", () => {
    const w = runWithHistory(33, 200);
    const restored = deserialize(serialize(w));
    for (let i = 0; i < w.creatures.length; i++) {
      expect(Array.from(restored.creatures[i]?.actionWindow ?? [])).toEqual(
        Array.from(w.creatures[i]?.actionWindow ?? []),
      );
    }
  });
});
