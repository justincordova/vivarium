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

/** Offline catch-up progress while replaying owed ticks on boot (Phase 5A). */
export interface CatchupState {
  done: number;
  total: number;
}

/** localStorage key for the "replay while I was away" preference. */
const CATCHUP_PREF_KEY = "vivarium:catchup";

/** Read the catch-up preference (default ON). Guarded for non-DOM/test contexts. */
function readCatchupPref(): boolean {
  try {
    return localStorage.getItem(CATCHUP_PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeCatchupPref(enabled: boolean): void {
  try {
    localStorage.setItem(CATCHUP_PREF_KEY, enabled ? "on" : "off");
  } catch {
    // Non-DOM / storage-denied context — the pref is best-effort.
  }
}

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
  /** Non-null while offline catch-up is replaying owed ticks on boot (drives the overlay). */
  catchup: CatchupState | null;
  /** Whether offline catch-up replays owed ticks on reopen (a persisted user pref). */
  catchupEnabled: boolean;
  /** Last non-fatal persistence error (e.g. autosave failed), or null. Surfaced subtly. */
  persistError: string | null;

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
  setCatchupEnabled(enabled: boolean): void;
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
  catchup: null,
  catchupEnabled: readCatchupPref(),
  persistError: null,

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
  setCatchupEnabled(enabled) {
    writeCatchupPref(enabled);
    send({ t: "setCatchup", enabled });
    set({ catchupEnabled: enabled });
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
      case "catchupProgress":
        // total 0 ⇒ no catch-up (fresh/same-session world) → no overlay.
        useSimStore.setState({
          catchup: msg.total > 0 ? { done: msg.done, total: msg.total } : null,
        });
        break;
      case "ready":
        // Boot (load + any catch-up) complete: dismiss the overlay and auto-play so a
        // visitor sees a living world immediately.
        useSimStore.setState({ catchup: null, ready: true });
        useSimStore.getState().play();
        break;
      case "persistError":
        useSimStore.setState({ persistError: msg.reason });
        break;
    }
  };
  // Persistence-aware boot: load-or-create + optional offline catch-up. `ready` (not
  // this call) flips the store ready and starts play, so the UI shows the catch-up
  // overlay first when there are owed ticks.
  const { seed, catchupEnabled } = useSimStore.getState();
  send({ t: "boot", seed, config: makeConfig({}), catchupEnabled });

  // `visibilitychange` is a document (main-thread) event the worker cannot observe;
  // forward it as a `save` so the worker autosaves when the tab is hidden.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") send({ t: "save" });
    });
  }
  return worker;
}
