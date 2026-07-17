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
import type { SaveBlob } from "@sim/serialize";
import type { Creature, LineageEvent } from "@sim/types";
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
import {
  exportWorld as exportWorldFile,
  fetchColdOpen,
  importWorld as importWorldFile,
  parseHash,
} from "../ui/share";

/** Non-reactive latest render frame, written by the worker message handler, read by
 * the canvas rAF loop. Deliberately outside Zustand so frames don't trigger renders. */
export const latestFrame: { current: RenderFrame | null } = { current: null };

/** One point in the population time-series (accumulated as `stats` events arrive). */
export interface PopPoint {
  tick: number;
  population: number;
  species: number;
}

/**
 * One point in the per-lineage population time-series (Phase 5C.2): a tick plus the
 * live population of each tracked founder-lineage root (keyed by `l<root>`). Sparse —
 * a lineage absent this tick is simply missing; the chart treats missing as 0.
 */
export interface LineagePoint {
  tick: number;
  [lineageKey: string]: number;
}

/** How many stats points the population chart retains (a rolling window). */
const POP_HISTORY_MAX = 240;

/** How many top lineages the speciation view plots (Phase 5C.2) — keeps it legible. */
const LINEAGE_PLOT_MAX = 6;

export type Speed = 1 | 2 | 4 | 8;

/** The active canvas interaction mode (god-power tools land in Phase 3B). */
export type Tool = "inspect" | "spawn" | "delete" | "paintWaterDown" | "paintWaterUp";

/** Offline catch-up progress while replaying owed ticks on boot (Phase 5A). */
export interface CatchupState {
  done: number;
  total: number;
}

/** The "while you were away" report (Phase 5A.3): drama that happened during catch-up. */
export interface Report {
  sinceTick: number;
  nowTick: number;
  events: LineageEvent[];
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
  /** Rolling per-lineage population time-series (Phase 5C.2 speciation view). */
  lineageHistory: LineagePoint[];
  /** The founder-lineage roots to plot (the current largest, by population). */
  topLineages: number[];
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
  /** The "while you were away" report, shown after a catch-up with drama; null to dismiss. */
  report: Report | null;

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
  dismissReport(): void;
  /** Export the current world as a gzipped `.viv.gz` download (Phase 5A.4). */
  exportWorld(): void;
  /** Import a `.viv.gz` file, replacing the live world (Phase 5A.4). */
  importWorld(file: File): Promise<void>;
}

let worker: Worker | null = null;

function send(cmd: Command): void {
  worker?.postMessage(cmd);
}

/** Pending export: resolved by the next `snapshot` event with the serialized world. */
let pendingSnapshot: ((blob: SaveBlob) => void) | null = null;

/** Request the worker's current world snapshot as a `SaveBlob` (one at a time). */
function requestSnapshot(): Promise<SaveBlob> {
  return new Promise((resolve) => {
    pendingSnapshot = resolve;
    send({ t: "snapshot" });
  });
}

export const useSimStore = create<SimState>((set, get) => ({
  running: false,
  speed: 1,
  seed: 1, // the Phase 1 gate seed — the world that oscillates and diversifies
  stats: null,
  popHistory: [],
  lineageHistory: [],
  topLineages: [],
  inspected: null,
  ready: false,
  params: {},
  detached: false,
  tool: "inspect",
  followId: null,
  catchup: null,
  catchupEnabled: readCatchupPref(),
  persistError: null,
  report: null,

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
  dismissReport() {
    set({ report: null });
  },
  exportWorld() {
    // Ask the worker for a snapshot, then gzip + download it. Fire-and-forget; the
    // download is triggered when the snapshot arrives.
    void requestSnapshot().then((blob) => exportWorldFile(blob));
  },
  async importWorld(file) {
    const blob = await importWorldFile(file);
    send({ t: "loadSave", blob });
    // The imported world is detached from any shareable URL (it is a full snapshot).
    set({ detached: true, inspected: null, followId: null, popHistory: [] });
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
          // A tick going backwards means a re-init/load happened — reset the series.
          const prev = s.popHistory[s.popHistory.length - 1];
          const reset = prev !== undefined && point.tick < prev.tick;
          const base = reset ? [] : s.popHistory;
          const next = [...base, point];
          if (next.length > POP_HISTORY_MAX) next.splice(0, next.length - POP_HISTORY_MAX);

          // Per-lineage speciation view (Phase 5C.2): plot the current top lineages by
          // population. Keeping a stable top-set avoids the legend thrashing every tick.
          const pop = msg.stats.population;
          const top = Object.keys(pop)
            .map(Number)
            .sort((a, b) => (pop[b] ?? 0) - (pop[a] ?? 0))
            .slice(0, LINEAGE_PLOT_MAX);
          const lpoint: LineagePoint = { tick: point.tick };
          for (const root of top) lpoint[`l${root}`] = pop[root] ?? 0;
          const lbase = reset ? [] : s.lineageHistory;
          const lnext = [...lbase, lpoint];
          if (lnext.length > POP_HISTORY_MAX) lnext.splice(0, lnext.length - POP_HISTORY_MAX);

          return { stats: msg.stats, popHistory: next, lineageHistory: lnext, topLineages: top };
        });
        break;
      }
      case "creature":
        useSimStore.setState({ inspected: msg.data });
        break;
      case "snapshot":
        // Fulfill a pending export request with the serialized world.
        if (pendingSnapshot !== null) {
          pendingSnapshot(msg.world);
          pendingSnapshot = null;
        }
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
      case "report":
        useSimStore.setState({
          report: { sinceTick: msg.sinceTick, nowTick: msg.nowTick, events: msg.events },
        });
        break;
    }
  };
  // Persistence-aware boot: load-or-create + optional offline catch-up. `ready` (not
  // this call) flips the store ready and starts play, so the UI shows the catch-up
  // overlay first when there are owed ticks.
  //
  // A shareable-URL hash (`#seed=..&mut=..`) overrides the default seed/config for a
  // fresh reproducible world (Phase 5A.4). A stored autosave still wins on the WORKER
  // side (loadNewest) — the hash only sets the cold-start parameters if there is no
  // save. This keeps "reopen finds my world" while still honoring a shared link on a
  // clean browser.
  const shared = typeof location !== "undefined" ? parseHash(location.hash) : null;
  const seed = shared?.seed ?? useSimStore.getState().seed;
  if (shared !== null) useSimStore.setState({ seed });
  const config = makeConfig(shared?.tunables ? { tunables: shared.tunables } : {});
  const { catchupEnabled } = useSimStore.getState();

  // A shared link (`#seed=..`) means the visitor wants THAT fresh world → skip the
  // cold open. Otherwise fetch the pre-evolved cold-open snapshot (Phase 5B.2) and hand
  // it to the worker, which uses it only if there is no saved world. The fetch is
  // best-effort and never blocks: on failure the worker cold-starts from founders.
  void (async () => {
    const coldOpen = shared === null ? await fetchColdOpen() : null;
    send({ t: "boot", seed, config, catchupEnabled, coldOpen: coldOpen ?? undefined });
  })();

  // `visibilitychange` is a document (main-thread) event the worker cannot observe;
  // forward it as a `save` so the worker autosaves when the tab is hidden.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") send({ t: "save" });
    });
  }
  return worker;
}
