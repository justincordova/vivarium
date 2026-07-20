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
import { hasSavedWorld } from "@worker/persistence";
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
  /**
   * UI lifecycle for the landing flow (UI overhaul): "landing" shows the front door,
   * "entering" is the boot/catch-up window, "live" is the running world. A shared-URL
   * deep link skips straight to "entering".
   */
  phase: "landing" | "entering" | "live";
  /** Whether a saved world exists (async-checked on mount) → gates the "Continue" button. */
  hasSave: boolean;

  play(): void;
  pause(): void;
  toggle(): void;
  setSpeed(speed: Speed): void;
  step(ticks: number): void;
  inspect(id: number): void;
  clearInspected(): void;
  setSeed(seed: number): void;
  reinit(): void;
  /**
   * Boot the world from a chosen source (landing screen). Sends the `boot` command with
   * the source selector and moves to the "entering" phase; `ready` flips to "live".
   */
  bootWorld(source: "continue" | "cold-open" | "fresh"): void;
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
/** Guards the one-time `visibilitychange` listener registration (see startWorker). */
let visibilityBound = false;

function send(cmd: Command): void {
  worker?.postMessage(cmd);
}

/** Pending export: resolved by the next `snapshot` event with the serialized world. */
let pendingSnapshot: ((blob: SaveBlob) => void) | null = null;

/**
 * Request the worker's current world snapshot as a `SaveBlob`. Serialized 1:1 with the
 * worker's `snapshot` reply, so only ONE may be in flight — a concurrent request rejects
 * (rather than overwriting the resolver, which would leak the first promise and resolve
 * the second against the wrong reply). A timeout rejects if no reply arrives (e.g. the
 * worker has no world yet) so the promise never hangs.
 */
function requestSnapshot(): Promise<SaveBlob> {
  if (pendingSnapshot !== null) {
    return Promise.reject(new Error("a world export is already in progress"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSnapshot = null;
      reject(new Error("snapshot request timed out"));
    }, 10_000);
    pendingSnapshot = (blob) => {
      clearTimeout(timer);
      resolve(blob);
    };
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
  phase: "landing",
  hasSave: false,

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
    // Guard against NaN/±Infinity from intermediate input states ("-", "1e") so a
    // degenerate seed never reaches `init` (which would seed a non-reproducible world).
    if (!Number.isFinite(seed)) return;
    set({ seed: Math.trunc(seed) });
  },
  reinit() {
    // Re-create the world on the current seed — a fresh, URL-attached world. The worker's
    // `init` pauses the fresh world (stop()), so reconcile `running` and reset ALL derived
    // series (population + lineage) so the charts don't show the previous world's data.
    send({ t: "init", seed: get().seed, config: makeConfig({}) });
    set({
      inspected: null,
      followId: null,
      detached: false,
      params: {},
      // Null `stats` too: it backs the Timeline scrubber and trait histogram. Without
      // this the previous world's whole-run timeline/traits stay on screen until the new
      // (paused) world emits its first stats — which never happens if the user doesn't
      // press play. Blank them so the charts reflect the new world immediately.
      stats: null,
      popHistory: [],
      lineageHistory: [],
      topLineages: [],
      running: false,
    });
  },
  bootWorld(source) {
    // Move to the boot window immediately (the landing fades; the catch-up overlay may
    // show during "continue"). `ready` from the worker flips us to "live".
    set({ phase: "entering" });
    const seed = get().seed;
    const config = makeConfig({});
    const catchupEnabled = get().catchupEnabled;
    // "cold-open" needs the pre-evolved snapshot; "fresh"/"continue" don't. The fetch is
    // best-effort — on failure the worker cold-starts from founders (still a valid world).
    void (async () => {
      const coldOpen = source === "cold-open" ? ((await fetchColdOpen()) ?? undefined) : undefined;
      send({ t: "boot", seed, config, catchupEnabled, coldOpen, source });
    })().catch(() => {
      // Last resort for an unexpected postMessage throw — release to founders.
      send({ t: "boot", seed, config, catchupEnabled, source: "fresh" });
    });
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
    // Ask the worker for a snapshot, then gzip + download it. A failure (concurrent
    // export, timeout, or gzip error) surfaces as a non-fatal error indicator rather
    // than an unhandled rejection.
    requestSnapshot()
      .then((blob) => exportWorldFile(blob))
      .catch((e: unknown) => {
        set({ persistError: e instanceof Error ? e.message : "export failed" });
      });
  },
  async importWorld(file) {
    let blob: SaveBlob;
    try {
      blob = await importWorldFile(file);
    } catch (e: unknown) {
      // A corrupt or wrong-type file → surface a non-fatal error, leave the world as-is.
      set({ persistError: e instanceof Error ? e.message : "import failed" });
      return;
    }
    send({ t: "loadSave", blob });
    // The imported world is detached from any shareable URL (it is a full snapshot). The
    // worker's `loadSave` pauses the loaded world (stop()), so reconcile `running` and
    // reset the derived series so the charts don't show the old world's data.
    set({
      detached: true,
      inspected: null,
      followId: null,
      // Blank `stats` (timeline + trait histogram) so the old world's history doesn't
      // linger under the freshly imported, paused world. See `reinit` for the rationale.
      stats: null,
      popHistory: [],
      lineageHistory: [],
      topLineages: [],
      running: false,
    });
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

          // Per-lineage speciation view (Phase 5C.2). Record THIS tick's top lineages,
          // then plot the stable UNION of roots seen across the retained window so a
          // stacked band never spuriously drops to zero on the left just because a
          // currently-top lineage wasn't top earlier (a lineage genuinely absent at a
          // past tick is filled 0 in that row, which is correct — it had 0 population).
          const pop = msg.stats.population;
          const top = Object.keys(pop)
            .map(Number)
            .sort((a, b) => (pop[b] ?? 0) - (pop[a] ?? 0))
            .slice(0, LINEAGE_PLOT_MAX);
          const lpoint: LineagePoint = { tick: point.tick };
          for (const root of top) lpoint[`l${root}`] = pop[root] ?? 0;
          const lbase = reset ? [] : s.lineageHistory;
          const lwindow = [...lbase, lpoint];
          if (lwindow.length > POP_HISTORY_MAX) lwindow.splice(0, lwindow.length - POP_HISTORY_MAX);

          // The plotted key-set: the union of all `l<root>` keys across the window, ranked
          // by each root's PEAK population across the window (not the latest tick). Ranking
          // by the latest tick would drop a lineage that dominated the window's history but
          // is absent NOW — its `pop[root]` is 0, so it sorts last and gets sliced off,
          // erasing its whole band and reintroducing the spurious drop this normalization
          // exists to prevent. Peak keeps historically-big bands in the plotted set. Then
          // fill every point with every plotted key (missing ⇒ 0) so Recharts draws no gaps.
          const rootPeak = new Map<number, number>();
          for (const p of lwindow) {
            for (const k of Object.keys(p)) {
              if (!k.startsWith("l")) continue;
              const root = Number(k.slice(1));
              rootPeak.set(root, Math.max(rootPeak.get(root) ?? 0, p[k] ?? 0));
            }
          }
          const plotted = Array.from(rootPeak.keys())
            .sort((a, b) => (rootPeak.get(b) ?? 0) - (rootPeak.get(a) ?? 0))
            .slice(0, LINEAGE_PLOT_MAX);
          const lnext = lwindow.map((p) => {
            const row: LineagePoint = { tick: p.tick };
            for (const root of plotted) row[`l${root}`] = p[`l${root}`] ?? 0;
            return row;
          });

          return {
            stats: msg.stats,
            popHistory: next,
            lineageHistory: lnext,
            topLineages: plotted,
          };
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
        // Boot (load + any catch-up) complete: dismiss the overlay, enter the live phase,
        // and auto-play so a visitor sees a living world immediately.
        useSimStore.setState({ catchup: null, ready: true, phase: "live" });
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

  // Entry policy (UI overhaul):
  //   - A shared link (`#seed=..`) is an explicit intent to enter THAT world → skip the
  //     landing, boot straight into it (fresh from the shared seed, no cold open).
  //   - Otherwise show the landing screen and let the visitor choose the source; the
  //     buttons call `bootWorld(...)`. We only probe whether a save exists so the landing
  //     can offer "Continue".
  if (shared !== null) {
    useSimStore.setState({ phase: "entering" });
    void (async () => {
      send({ t: "boot", seed, config, catchupEnabled, source: "fresh" });
    })().catch(() => {
      // Last resort for an unexpected `send`/postMessage throw — leave no unhandled
      // rejection; the worker cold-starts from founders on its own.
    });
  } else {
    void hasSavedWorld()
      .then((has) => useSimStore.setState({ hasSave: has }))
      .catch(() => useSimStore.setState({ hasSave: false }));
  }

  // `visibilitychange` is a document (main-thread) event the worker cannot observe;
  // forward it as a `save` so the worker autosaves when the tab is hidden. Registered
  // exactly once behind its own guard (independent of the worker-creation guard above),
  // so a future worker teardown/re-create never stacks duplicate listeners.
  if (typeof document !== "undefined" && !visibilityBound) {
    visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") send({ t: "save" });
    });
  }
  return worker;
}
