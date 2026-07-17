/**
 * useSimStore.ts — the Zustand store: UI/sim-control state + the worker handle.
 *
 * The UI reads this store and sends commands; it NEVER calls `tick()` (SPEC.md
 * §Architecture — the layering direction is load-bearing). The worker owns the World.
 *
 * Frame-rate discipline: `frame` messages arrive every render step. Storing them in
 * reactive state would re-render React on every frame. Instead the latest frame lives
 * in a plain mutable ref (`latestFrame`) that the canvas rAF loop reads directly;
 * only LOW-frequency data (stats, the inspected creature, control flags) is reactive
 * Zustand state that components subscribe to.
 */

import { makeConfig } from "@sim/config";
import type { Creature } from "@sim/types";
import type { Command, Event, RenderFrame, StatsPayload } from "@worker/protocol";
import { create } from "zustand";

/** Non-reactive latest render frame, written by the worker message handler, read by
 * the canvas rAF loop. Deliberately outside Zustand so frames don't trigger renders. */
export const latestFrame: { current: RenderFrame | null } = { current: null };

export type Speed = 1 | 2 | 4 | 8;

interface SimState {
  running: boolean;
  speed: Speed;
  seed: number;
  /** Latest periodic stats (low-frequency — safe as reactive state). */
  stats: StatsPayload | null;
  /** The creature returned by the last `inspect`, or null. */
  inspected: Creature | null;
  /** True once the worker has been created and `init` sent. */
  ready: boolean;

  play(): void;
  pause(): void;
  toggle(): void;
  setSpeed(speed: Speed): void;
  inspect(id: number): void;
  clearInspected(): void;
}

let worker: Worker | null = null;

function send(cmd: Command): void {
  worker?.postMessage(cmd);
}

export const useSimStore = create<SimState>((set, get) => ({
  running: false,
  speed: 1,
  seed: 1, // the Phase 1 gate seed — the world that oscillates and diversifies
  stats: null,
  inspected: null,
  ready: false,

  play() {
    send({ t: "play" });
    set({ running: true });
  },
  pause() {
    send({ t: "pause" });
    set({ running: false });
  },
  toggle() {
    get().running ? get().pause() : get().play();
  },
  setSpeed(speed) {
    send({ t: "speed", ticksPerFrame: speed });
    set({ speed });
  },
  inspect(id) {
    send({ t: "inspect", id });
  },
  clearInspected() {
    set({ inspected: null });
  },
}));

/**
 * Create the worker, wire its events into the store, and send `init` with the Phase 1
 * winning config on the gate seed. Idempotent — a second call is a no-op (guards the
 * React 18/19 StrictMode double-mount).
 */
export function startWorker(): Worker {
  if (worker !== null) return worker;
  worker = new Worker(new URL("../worker/sim.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (ev: MessageEvent<Event>) => {
    const msg = ev.data;
    switch (msg.t) {
      case "frame":
        latestFrame.current = msg.frame;
        break;
      case "stats":
        useSimStore.setState({ stats: msg.stats });
        break;
      case "creature":
        useSimStore.setState({ inspected: msg.data });
        break;
      // `snapshot` / `catchupProgress` are wired in later phases (persistence).
    }
  };
  const seed = useSimStore.getState().seed;
  send({ t: "init", seed, config: makeConfig({}) });
  useSimStore.setState({ ready: true });
  return worker;
}
