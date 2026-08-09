/**
 * terrarium.test.ts — the stewardship budget (`docs/designs/terrarium.md`).
 *
 * The budget is World state that `tick()` accrues and `worker/commands.ts` spends, so the
 * properties worth pinning are the ones that make it *fair*: it must accrue purely from
 * ticks (so offline catch-up refills it identically to live play, with no separate path),
 * it must never exceed its cap, and it must survive a save/load round trip — a budget that
 * silently refilled on reload would be free influence.
 */

import { makeConfig } from "@sim/config";
import * as C from "@sim/constants";
import { deserialize, serialize } from "@sim/serialize";
import { tick } from "@sim/tick";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";

describe("terrarium influence budget", () => {
  it("starts full and never exceeds the cap", () => {
    const w = createWorld(1, makeConfig({}));
    expect(w.influence).toBe(C.INFLUENCE_MAX);
    for (let i = 0; i < C.INFLUENCE_REFILL_TICKS * 5; i++) tick(w);
    expect(w.influence).toBe(C.INFLUENCE_MAX);
  });

  it("accrues one point per INFLUENCE_REFILL_TICKS after spending", () => {
    const w = createWorld(1, makeConfig({}));
    // Spend down the way the worker does, then let it refill for an exact number of ticks.
    w.influence = 0;
    const startTick = w.tick;
    const ticksToRun = C.INFLUENCE_REFILL_TICKS * 4;
    for (let i = 0; i < ticksToRun; i++) tick(w);
    // Count the refill boundaries actually crossed rather than assuming alignment — the
    // rule is keyed off absolute `world.tick`, not off when spending happened.
    let expected = 0;
    for (let t = startTick + 1; t <= startTick + ticksToRun; t++) {
      if (t % C.INFLUENCE_REFILL_TICKS === 0) expected++;
    }
    expect(w.influence).toBe(expected);
  });

  /**
   * The reason accrual is keyed off the tick counter and not a per-tick float: catch-up
   * runs the same `tick()` in a tight loop, so a batched replay must land on exactly the
   * budget live play would have reached.
   */
  it("accrues identically whether ticks are run in one batch or many", () => {
    const a = createWorld(3, makeConfig({}));
    const b = createWorld(3, makeConfig({}));
    a.influence = 0;
    b.influence = 0;
    for (let i = 0; i < 200; i++) tick(a);
    for (let chunk = 0; chunk < 8; chunk++) for (let i = 0; i < 25; i++) tick(b);
    expect(a.influence).toBe(b.influence);
  });

  it("survives a save/load round trip", () => {
    const w = createWorld(5, makeConfig({}));
    w.influence = 37;
    for (let i = 0; i < 10; i++) tick(w);
    const spent = w.influence;
    const back = deserialize(serialize(w));
    expect(back.influence).toBe(spent);
  });

  /** A pre-v6 blob has no budget recorded; it must load full, not empty. */
  it("defaults a pre-v6 save to a full budget", () => {
    const w = createWorld(5, makeConfig({}));
    const blob = serialize(w);
    blob.influence = undefined;
    blob.version = 5;
    expect(deserialize(blob).influence).toBe(C.INFLUENCE_MAX);
  });
});
