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
import type {
  Command,
  Event,
  GenomePatch,
  PaintField,
  RenderFrame,
  SpawnSpec,
  StatsPayload,
} from "@worker/protocol";
import { create } from "zustand";

/** Non-reactive latest render frame, written by the worker message handler, read by
 * the canvas rAF loop. Deliberately outside Zustand so frames don't trigger renders. */
export const latestFrame: { current: RenderFrame | null } = { current: null };

/** One point in the population time-series (accumulated as `stats` events arrive). */
export interface PopPoint {
  tick: number;
  population: number;
  species: number;
}

/** How many stats points the population chart retains (a rolling window). */
const POP_HISTORY_MAX = 240;

export type Speed = 1 | 2 | 4 | 8;

/** The active canvas interaction mode (god-power tools land in Phase 3B). */
export type Tool = "inspect" | "spawn" | "delete" | "paintWaterDown" | "paintWaterUp";

interface SimState {
  running: boolean;
  speed: Speed;
  seed: number;
  /** Latest periodic stats (low-frequency — safe as reactive state). */
  stats: StatsPayload | null;
  /** Rolling population/species time-series for the always-visible charts. */
  popHistory: PopPoint[];
  /** The creature returned by the last `inspect`, or null. */
  inspected: Creature | null;
  /** True once the worker has been created and `init` sent. */
  ready: boolean;
  /** Live tunable overrides applied via sliders (for UI reflection). */
  params: Record<string, number>;
  /**
   * True once a god-power/live param change has detached the world from its shareable
   * URL (the URL encodes only the initial config; SPEC.md Task 3.1). Surfaced in the UI.
   */
  detached: boolean;
  /** Active canvas tool. */
  tool: Tool;
  /** Creature id the camera is locked to (follow-cam), or null. */
  followId: number | null;

  play(): void;
  pause(): void;
  toggle(): void;
  setSpeed(speed: Speed): void;
  step(ticks: number): void;
  inspect(id: number): void;
  clearInspected(): void;
  setSeed(seed: number): void;
  reinit(): void;
  setParam(key: string, value: number): void;
  editGenome(id: number, patch: GenomePatch): void;
  spawn(spec: SpawnSpec): void;
  remove(id: number): void;
  paint(field: PaintField, cell: number, delta: number, brush?: number): void;
  setTool(tool: Tool): void;
  setFollow(id: number | null): void;
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
  popHistory: [],
  inspected: null,
  ready: false,
  params: {},
  detached: false,
  tool: "inspect",
  followId: null,

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
  step(ticks) {
    // Stepping only makes sense while paused (the loop advances time otherwise).
    if (get().running) return;
    send({ t: "step", ticks });
  },
  inspect(id) {
    send({ t: "inspect", id });
  },
  clearInspected() {
    set({ inspected: null });
  },
  setSeed(seed) {
    set({ seed });
  },
  reinit() {
    // Re-create the world on the current seed — a fresh, URL-attached world.
    send({ t: "init", seed: get().seed, config: makeConfig({}) });
    set({ inspected: null, followId: null, detached: false, params: {}, popHistory: [] });
  },
  setParam(key, value) {
    send({ t: "setParam", key, value });
    set((s) => ({ params: { ...s.params, [key]: value }, detached: true }));
  },
  editGenome(id, patch) {
    send({ t: "editGenome", id, patch });
    set({ detached: true });
  },
  spawn(spec) {
    send({ t: "spawn", spec });
    set({ detached: true });
  },
  remove(id) {
    send({ t: "delete", id });
    set({ detached: true });
  },
  paint(field, cell, delta, brush) {
    send({ t: "paint", field, cell, delta, brush });
    set({ detached: true });
  },
  setTool(tool) {
    set({ tool });
  },
  setFollow(id) {
    set({ followId: id });
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
      case "stats": {
        const total = Object.values(msg.stats.population).reduce((a, b) => a + b, 0);
        const point: PopPoint = {
          tick: msg.stats.tick,
          population: total,
          species: msg.stats.speciesCount,
        };
        useSimStore.setState((s) => {
          // A tick going backwards means a re-init happened — reset the series.
          const prev = s.popHistory[s.popHistory.length - 1];
          const base = prev !== undefined && point.tick < prev.tick ? [] : s.popHistory;
          const next = [...base, point];
          if (next.length > POP_HISTORY_MAX) next.splice(0, next.length - POP_HISTORY_MAX);
          return { stats: msg.stats, popHistory: next };
        });
        break;
      }
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
