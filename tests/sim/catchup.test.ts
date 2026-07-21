/**
 * catchup.test.ts — the load-bearing offline-catch-up invariant (design:
 * phase-5a-persistence, plan Task 5A.2).
 *
 * Catch-up replays owed ticks "stripped down" (no rendering/stats emission). This is
 * only safe if the stripped replay produces a **bit-identical world** to the same
 * number of normal live ticks — otherwise a returning user silently gets a different
 * world than the one that would have run. This test is that guarantee: if any future
 * change sneaks a side effect (an RNG draw, a world mutation) into a catch-up-only
 * path, the fingerprints diverge and this fails.
 *
 * Node env; imports only `sim/` + the pure `runCatchup`/`ticksOwed` from `worker/`.
 */

import { makeConfig } from "@sim/config";
import { recordHistory } from "@sim/history";
import { tick } from "@sim/tick";
import type { World } from "@sim/types";
import { createWorld } from "@sim/world";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { runCatchup, ticksOwed } from "../../src/worker/catchup";

/**
 * Full structural fingerprint including hidden state, genome, history, and event log —
 * catch-up must reproduce ALL of it, not just positions (history/events are part of
 * what a returning user sees).
 */
function fingerprint(w: World): string {
  const parts: string[] = [String(w.tick), String(w.solarReservoir), String(w.nextId)];
  for (const c of w.creatures) {
    parts.push(
      `${c.id}:${c.x}:${c.y}:${c.heading}:${c.energy}:${c.hydration}:${c.health}:${c.age}:${Array.from(c.hidden).join(",")}`,
    );
    parts.push(`W:${Array.from(c.genome.weightsA).join(",")}`);
  }
  for (const p of w.plants) parts.push(`P${p.id}:${p.x}:${p.y}:${p.energy}:${p.age}`);
  for (const co of w.corpses) parts.push(`C${co.id}:${co.energy}`);
  parts.push(`H:${w.history.length}:${JSON.stringify(w.history[w.history.length - 1] ?? null)}`);
  parts.push(`E:${w.eventLog.length}`);
  // Phase 5A.3: lineage roots + typed events must replay bit-identically during catch-up.
  parts.push(`LR:${JSON.stringify(w.lineageRoots)}`);
  parts.push(`LE:${JSON.stringify(w.lineageEvents)}`);
  parts.push(`DOM:${JSON.stringify(w.dominant)}`);
  parts.push(`RNG:${w.rng.mutation.state}:${w.rng.mating.state}:${w.rng.resolve.state}`);
  return parts.join("|");
}

/**
 * A small world for the catch-up invariant tests. Bit-identity of catch-up vs. live is
 * world-size-independent; the enlarged 1000×1000 default makes these two-world property
 * comparisons exceed the timeout under full-suite parallelism.
 */
function smallConfig() {
  return makeConfig({ worldWidth: 200, worldHeight: 200, gridCols: 64, gridRows: 64 });
}

/** The reference: what the LIVE loop does per tick (tick + recordHistory), minus emit. */
function liveReplay(world: World, n: number): void {
  for (let i = 0; i < n; i++) {
    tick(world);
    recordHistory(world);
  }
}

describe("offline catch-up — bit-identical invariant", () => {
  it("N stripped catch-up ticks == N live ticks (world + history + events)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100000 }),
        fc.integer({ min: 1, max: 600 }),
        (seed, n) => {
          const live = createWorld(seed, smallConfig());
          liveReplay(live, n);

          const caught = createWorld(seed, smallConfig());
          runCatchup(caught, n, () => {}, 100);

          expect(fingerprint(caught)).toBe(fingerprint(live));
        },
      ),
      { numRuns: 8 },
    );
  }, 120_000);

  it("holds for the patchbay brain too (real forward-pass dynamics)", () => {
    const cfg = () =>
      makeConfig({
        brainKind: "patchbay",
        worldWidth: 200,
        worldHeight: 200,
        gridCols: 64,
        gridRows: 64,
      });
    const live = createWorld(42, cfg());
    liveReplay(live, 400);
    const caught = createWorld(42, cfg());
    runCatchup(caught, 400, () => {}, 100);
    expect(fingerprint(caught)).toBe(fingerprint(live));
  }, 60_000);

  it("progress callback fires monotonically and ends at (owed, owed)", () => {
    const w = createWorld(3, smallConfig());
    const calls: [number, number][] = [];
    runCatchup(w, 250, (done, total) => calls.push([done, total]), 100);
    // done values: 0, 100, 200, then the final 250.
    expect(calls[0]).toEqual([0, 250]);
    expect(calls[calls.length - 1]).toEqual([250, 250]);
    for (let i = 1; i < calls.length; i++) {
      expect((calls[i] as [number, number])[0]).toBeGreaterThan(
        (calls[i - 1] as [number, number])[0],
      );
      expect((calls[i] as [number, number])[1]).toBe(250);
    }
  });

  it("runCatchup with 0 owed is a no-op (no ticks, no progress)", () => {
    const w = createWorld(1, smallConfig());
    const before = fingerprint(w);
    let called = false;
    runCatchup(w, 0, () => {
      called = true;
    });
    expect(fingerprint(w)).toBe(before);
    expect(called).toBe(false);
  });
});

describe("ticksOwed — cap + clock-skew safety", () => {
  it("computes floor(elapsed / MS_PER_TICK)", () => {
    const w = createWorld(1, smallConfig());
    const ms = w.config.tunables.MS_PER_TICK;
    expect(ticksOwed(w, 1000, 1000 + ms * 10)).toBe(10);
    expect(ticksOwed(w, 1000, 1000 + ms * 10 + ms / 2)).toBe(10); // floors
  });

  it("caps at MAX_OFFLINE_TICKS", () => {
    const w = createWorld(1, smallConfig());
    const ms = w.config.tunables.MS_PER_TICK;
    const huge = 1000 + ms * (w.config.tunables.MAX_OFFLINE_TICKS + 5000);
    expect(ticksOwed(w, 1000, huge)).toBe(w.config.tunables.MAX_OFFLINE_TICKS);
  });

  it("clock moved backward (now < saved) → 0, never negative", () => {
    const w = createWorld(1, smallConfig());
    expect(ticksOwed(w, 5000, 1000)).toBe(0);
    expect(ticksOwed(w, 5000, 5000)).toBe(0);
  });
});
