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
import type { LineageEvent, World } from "@sim/types";

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
 *
 * `awaySink`, if provided, accumulates every lineage event fired during the replay
 * into an UNBOUNDED array. The "while you were away" report cannot be reconstructed
 * from `world.lineageEvents` after the fact: that is a bounded ring
 * (`MAX_LINEAGE_EVENTS`) pruned from the front, so a dramatic catch-up can evict
 * genuine away-events before the report is built. Sinking here — right after each
 * `recordHistory`, before any later sample can prune — captures the true window. The
 * sink is observation-only (never read back into `tick()`), so it does not affect
 * determinism.
 */
export function runCatchup(
  world: World,
  owed: number,
  onProgress: (done: number, total: number) => void,
  progressEvery = 500,
  awaySink?: LineageEvent[],
): void {
  if (owed <= 0) return;
  for (let i = 0; i < owed; i++) {
    tick(world);
    recordHistory(world);
    if (awaySink !== undefined) collectTickEvents(world, awaySink);
    if (i % progressEvery === 0) onProgress(i, owed);
  }
  onProgress(owed, owed);
}

/**
 * Append the lineage events that fired on the CURRENT tick to `sink`. `recordHistory`
 * appends this tick's events to the tail of the ring (all tagged `tick === world.tick`)
 * and only ever front-prunes older entries, so THIS tick's events are always the
 * contiguous back of the ring — reading the trailing run with `e.tick === world.tick`
 * captures them intact regardless of front-pruning. Immune to the ring's bounded
 * eviction, which is exactly the loss the away-report otherwise suffers.
 */
function collectTickEvents(world: World, sink: LineageEvent[]): void {
  const events = world.lineageEvents;
  const now = world.tick;
  let start = events.length;
  while (start > 0 && (events[start - 1] as LineageEvent).tick === now) start--;
  for (let k = start; k < events.length; k++) sink.push(events[k] as LineageEvent);
}
