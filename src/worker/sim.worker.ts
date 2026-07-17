/**
 * sim.worker.ts — the Web Worker that owns the authoritative `World` and runs the
 * tick loop off the main thread (SPEC.md §Architecture). It posts lean `frame`
 * snapshots every render step and `stats` every N ticks; a full `Creature` crosses
 * the boundary only in reply to `inspect`; a serialized world only on `snapshot`.
 *
 * Imports ONLY from `sim/` and `protocol.ts`/`frame.ts`. Never imports `render`/`ui`
 * (the layering direction is load-bearing). This file runs in a Worker global scope,
 * so it is not unit-tested directly — the testable logic lives in `frame.ts`; this
 * file is only message plumbing + the loop.
 */

import { recordHistory } from "@sim/history";
import { serialize } from "@sim/serialize";
import { tick } from "@sim/tick";
import type { Config, World } from "@sim/types";
import { createWorld } from "@sim/world";
import { runCatchup, ticksOwed } from "./catchup";
import { applyDelete, applyEditGenome, applyPaint, applySetParam, applySpawn } from "./commands";
import { buildRenderFrame, buildStats, frameTransferables } from "./frame";
import { Autosaver, idbStore, loadNewest, type Meta } from "./persistence";
import type { Command, Event } from "./protocol";

/** How often (in ticks) to emit a `stats` message; frames emit every render step. */
const STATS_INTERVAL = 100;
/** Real-time autosave cadence, ms (wall-clock, independent of MS_PER_TICK/speed). */
const AUTOSAVE_INTERVAL_MS = 30_000;

let world: World | null = null;
let running = false;
let ticksPerFrame = 1;
/** Cumulative id→lineage-root map (never pruned) — see frame.populationByLineageRoot. */
const rootOf = new Map<number, number>();
/** Handle for the scheduled loop step, so pause/re-init can cancel it. */
let loopHandle: ReturnType<typeof setTimeout> | null = null;

// ── Phase 5A persistence state ───────────────────────────────────────────────
/** The autosave coordinator (crash-safe rotating slots); null until the first boot. */
let autosaver: Autosaver | null = null;
/** The wall-clock autosave timer handle. */
let autosaveHandle: ReturnType<typeof setInterval> | null = null;
/** Whether offline catch-up replays owed ticks on boot (a user preference). */
let catchupEnabled = true;

function post(msg: Event, transfer?: ArrayBuffer[]): void {
  // `self.postMessage` in a worker; the transfer list donates buffers (zero-copy).
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function emitFrame(): void {
  if (world === null) return;
  const frame = buildRenderFrame(world);
  post({ t: "frame", frame }, frameTransferables(frame));
}

function emitStats(): void {
  if (world === null) return;
  post({ t: "stats", stats: buildStats(world, rootOf) });
}

/**
 * One scheduled step: advance `ticksPerFrame` ticks, record history, then emit a
 * frame (and stats on the cadence). Paced by MS_PER_TICK via setTimeout — a Worker
 * has no rAF, and the render cadence is the main thread's job; the worker just needs
 * to keep world-time flowing at roughly the configured rate.
 */
function step(): void {
  if (!running || world === null) {
    loopHandle = null;
    return;
  }
  for (let i = 0; i < ticksPerFrame; i++) {
    tick(world);
    recordHistory(world);
  }
  emitFrame();
  if (world.tick % STATS_INTERVAL < ticksPerFrame) emitStats();

  const msPerTick = world.config.tunables.MS_PER_TICK;
  const delay = Math.max(0, msPerTick * ticksPerFrame);
  loopHandle = setTimeout(step, delay);
}

function start(): void {
  if (running || world === null) return;
  running = true;
  if (loopHandle === null) step();
}

function stop(): void {
  running = false;
  if (loopHandle !== null) {
    clearTimeout(loopHandle);
    loopHandle = null;
  }
}

function init(seed: number, config: Config): void {
  stop();
  stopAutosave();
  rootOf.clear();
  autosaver = new Autosaver(idbStore, null);
  world = createWorld(seed, config);
  recordHistory(world);
  // Emit an initial frame + stats so the UI paints the cold world before play.
  emitFrame();
  emitStats();
  startAutosave();
}

/**
 * Persistence-aware boot (Phase 5A): load the newest saved world, or create a fresh one
 * from seed+config; replay owed ticks if catch-up is enabled; then emit the first live
 * frame and start autosave. Async (IndexedDB); the message handler fires it and it owns
 * all its own errors — a storage failure degrades to a cold start, never a crash.
 */
async function boot(seed: number, config: Config): Promise<void> {
  stop();
  stopAutosave();
  rootOf.clear();

  let loadedRealTime: number | null = null;
  let loadedMeta: Meta | null = null;
  try {
    const loaded = await loadNewest(idbStore);
    if (loaded !== null) {
      world = loaded.world;
      loadedRealTime = loaded.lastSavedRealTime;
      loadedMeta = loaded.meta;
    }
  } catch {
    // Storage read failed — fall through to a cold start.
    world = null;
  }
  if (world === null) {
    world = createWorld(seed, config);
    recordHistory(world);
  }

  // Seed the autosaver with the loaded meta so the first save rotates to the OLDER
  // slot and never overwrites the slot we just loaded from (a cold start seeds null →
  // rotation begins at slot A).
  autosaver = new Autosaver(idbStore, loadedMeta);

  // Offline catch-up: replay ticks owed since the save, capped, with progress.
  if (catchupEnabled && loadedRealTime !== null) {
    const owed = ticksOwed(world, loadedRealTime, Date.now());
    if (owed > 0) {
      post({ t: "catchupProgress", done: 0, total: owed });
      runCatchup(world, owed, (done, total) => post({ t: "catchupProgress", done, total }));
    } else {
      post({ t: "catchupProgress", done: 0, total: 0 });
    }
  } else {
    post({ t: "catchupProgress", done: 0, total: 0 });
  }

  // First live frame + stats, then signal the UI it may reveal the world.
  emitFrame();
  emitStats();
  post({ t: "ready" });
  startAutosave();
}

/** Save now (crash-safe). Non-fatal: a failure posts `persistError` and keeps running. */
async function saveNow(): Promise<void> {
  if (world === null || autosaver === null) return;
  const ok = await autosaver.save(world, Date.now());
  if (!ok) post({ t: "persistError", reason: "autosave failed" });
}

function startAutosave(): void {
  if (autosaveHandle !== null) return;
  autosaveHandle = setInterval(() => {
    void saveNow();
  }, AUTOSAVE_INTERVAL_MS);
}

function stopAutosave(): void {
  if (autosaveHandle !== null) {
    clearInterval(autosaveHandle);
    autosaveHandle = null;
  }
}

/**
 * Advance exactly `n` ticks synchronously (single/N-step while paused), then repaint.
 * A no-op if running (the loop already advances time). Used by the `step` command.
 */
function stepTicks(n: number): void {
  if (world === null || running) return;
  const count = Math.max(0, Math.floor(n));
  for (let i = 0; i < count; i++) {
    tick(world);
    recordHistory(world);
  }
  emitFrame();
  emitStats();
}

/**
 * Repaint after an out-of-loop god-power mutation so a paused world reflects the
 * change immediately. When running, the next scheduled `step` already repaints.
 */
function repaintIfPaused(): void {
  if (!running) {
    emitFrame();
    emitStats();
  }
}

// Correctness note: god-power mutations are applied here, at a tick boundary, never
// mid-tick. That holds ONLY because `step`/`stepTicks` are fully synchronous and JS is
// single-threaded — a command can be dequeued between scheduled steps, never during a
// `tick()`. Do not make the tick loop yield (no `await`/microtask chunking inside a
// tick) or a command could land mid-resolve and break determinism/conservation.
self.onmessage = (ev: MessageEvent<Command>): void => {
  const cmd = ev.data;
  switch (cmd.t) {
    case "boot":
      catchupEnabled = cmd.catchupEnabled;
      // Fire-and-forget: `boot` owns its own errors and posts progress/ready itself.
      void boot(cmd.seed, cmd.config);
      break;
    case "setCatchup":
      catchupEnabled = cmd.enabled;
      break;
    case "save":
      // "Autosave now" — forwarded from the main thread on `visibilitychange` (a
      // document event the worker cannot observe directly).
      void saveNow();
      break;
    case "init":
      init(cmd.seed, cmd.config);
      break;
    case "play":
      start();
      break;
    case "pause":
      stop();
      break;
    case "speed":
      ticksPerFrame = Math.max(1, Math.floor(cmd.ticksPerFrame));
      break;
    case "inspect": {
      if (world === null) break;
      const c = world.creatures.find((cr) => cr.id === cmd.id);
      if (c !== undefined) post({ t: "creature", data: c });
      break;
    }
    case "snapshot":
      if (world !== null) post({ t: "snapshot", world: serialize(world) });
      break;
    // ── Phase 3 god-powers + stepping (applied at the tick boundary) ────────────
    case "step":
      stepTicks(cmd.ticks);
      break;
    case "spawn":
      if (world !== null) {
        applySpawn(world, cmd.spec);
        repaintIfPaused();
      }
      break;
    case "delete":
      if (world !== null && applyDelete(world, cmd.id)) repaintIfPaused();
      break;
    case "editGenome":
      if (world !== null && applyEditGenome(world, cmd.id, cmd.patch)) {
        // Reply with the updated creature so an open inspector refreshes.
        const c = world.creatures.find((cr) => cr.id === cmd.id);
        if (c !== undefined) post({ t: "creature", data: c });
        repaintIfPaused();
      }
      break;
    case "paint":
      if (world !== null) {
        applyPaint(world, cmd.field, cmd.cell, cmd.delta, cmd.brush);
        repaintIfPaused();
      }
      break;
    case "setParam":
      if (world !== null && applySetParam(world, cmd.key, cmd.value)) repaintIfPaused();
      break;
  }
};
