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
import { buildRenderFrame, buildStats, frameTransferables } from "./frame";
import type { Command, Event } from "./protocol";

/** How often (in ticks) to emit a `stats` message; frames emit every render step. */
const STATS_INTERVAL = 100;

let world: World | null = null;
let running = false;
let ticksPerFrame = 1;
/** Cumulative id→lineage-root map (never pruned) — see frame.populationByLineageRoot. */
const rootOf = new Map<number, number>();
/** Handle for the scheduled loop step, so pause/re-init can cancel it. */
let loopHandle: ReturnType<typeof setTimeout> | null = null;

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
  rootOf.clear();
  world = createWorld(seed, config);
  recordHistory(world);
  // Emit an initial frame + stats so the UI paints the cold world before play.
  emitFrame();
  emitStats();
}

self.onmessage = (ev: MessageEvent<Command>): void => {
  const cmd = ev.data;
  switch (cmd.t) {
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
  }
};
