/**
 * catchup.ts — offline catch-up: replay the ticks owed while the tab was closed.
 *
 * On reopen, the world has NOT advanced (nothing runs while closed). Catch-up is
 * literally calling `tick()` N times as fast as possible, where N is the ticks owed
 * since the last save, capped at `MAX_OFFLINE_TICKS` (the Phase-4-re-derived worst-case
 * ceiling — keeps catch-up < ~20s). This module is the pure loop; the worker wires the
 * wall-clock, the load, and the progress messages.
 *
 * **The load-bearing invariant (tests/sim/catchup.test.ts):** the catch-up loop must
 * produce a BIT-IDENTICAL world to the same number of plain live ticks. It therefore
 * calls the SAME `tick()` and the SAME `recordHistory()` per tick that the live loop
 * (`sim.worker.ts step()`) calls — it strips only *observation* (no render-frame build,
 * no stats emission), never *computation*. `recordHistory` is a pure observer (RNG-free;
 * it writes only `world.history`/`world.eventLog` deterministically), so including it
 * keeps history/events identical too, not just world state.
 *
 * Imports only `sim/`. No DOM, no `realTime` inside the replay.
 */

import { recordHistory } from "@sim/history";
import { tick } from "@sim/tick";
import type { World } from "@sim/types";

/** How many ticks are owed since the last save, capped at the offline ceiling. */
export function ticksOwed(world: World, lastSavedRealTime: number, now: number): number {
  const msPerTick = world.config.tunables.MS_PER_TICK;
  const elapsed = now - lastSavedRealTime;
  if (!(elapsed > 0) || !(msPerTick > 0)) return 0; // clock skew / bad config → 0, never negative
  const raw = Math.floor(elapsed / msPerTick);
  return Math.min(raw, world.config.tunables.MAX_OFFLINE_TICKS);
}

/**
 * Replay exactly `owed` ticks in place, invoking `onProgress(done, total)` every
 * `progressEvery` ticks (and once at completion). Identical per-tick work to the live
 * loop minus observation, so the resulting world is bit-identical to `owed` live ticks.
 * Synchronous — never yields mid-tick (the god-power/determinism boundary rule).
 */
export function runCatchup(
  world: World,
  owed: number,
  onProgress: (done: number, total: number) => void,
  progressEvery = 500,
): void {
  if (owed <= 0) return;
  for (let i = 0; i < owed; i++) {
    tick(world);
    recordHistory(world);
    if (i % progressEvery === 0) onProgress(i, owed);
  }
  onProgress(owed, owed);
}
