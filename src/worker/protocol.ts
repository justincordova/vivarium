/**
 * protocol.ts — the worker↔main message contract (SPEC.md §Architecture, §Data Flow).
 *
 * Imported by BOTH `worker/sim.worker.ts` and the main-thread store. The worker
 * never posts the whole `World`; it posts the lean `frame`/`stats` messages defined
 * here, and a full `Creature` crosses only in reply to an explicit `inspect`.
 *
 * This file is the single source of truth for the render frame's shape. `render/`
 * (the palette + canvas) consumes `CreatureFrame` directly, so the frame is
 * guaranteed to carry every field appearance needs — enforced by the type-level
 * contract test (`tests/worker/protocol.contract.test.ts`).
 *
 * Not part of `sim/` — but it may only import *types* from `sim/`, never behavior.
 */

import type { SaveBlob } from "@sim/serialize";
import type { Config, Creature, LineageEvent } from "@sim/types";

// ─────────────────────────────────────────────────────────────────────────────
// Lean render frame (struct-of-arrays)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All expressed-per-creature appearance channels as parallel typed arrays, index
 * `i` describing creature `i`. Every value is an EXPRESSED scalar (mean of the
 * diploid alleles) computed worker-side — no `Creature` objects cross the boundary.
 *
 * This is the exact set `render/palette.ts` reads (SPEC.md §Visual Design table):
 *   position (x,y) + heading, hue, size, energyFrac (→saturation), diet (→shape),
 *   armor + toxicity (→spikes/ornaments), age (→outline ring). `ids` backs
 *   click-to-inspect (screen hit → creature id → `inspect`).
 *
 * `count` is authoritative; the arrays may be over-allocated (reused buffers), so
 * consumers must iterate `0..count`, never `array.length`.
 */
export interface CreatureFrame {
  count: number;
  ids: Int32Array;
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;
  hue: Float32Array;
  size: Float32Array;
  /** current energy / maxEnergy, clamped 0..1 — drives saturation (starving = washed out). */
  energyFrac: Float32Array;
  /** expressed `diet`, 0=herbivore(round) … 1=carnivore(angular). */
  diet: Float32Array;
  armor: Float32Array;
  toxicity: Float32Array;
  age: Float32Array;
  /** expressed `speed` — drives fin prominence + tail length (procedural body plan). */
  speed: Float32Array;
}

/** Plants as a lean struct-of-arrays: position + energy fraction + hue. */
export interface PlantFrame {
  count: number;
  x: Float32Array;
  y: Float32Array;
  /** current energy / maxSize energy, clamped 0..1 — plant vigor. */
  energyFrac: Float32Array;
  hue: Float32Array;
}

/** Corpses as a lean struct-of-arrays: position + energy fraction. */
export interface CorpseFrame {
  count: number;
  x: Float32Array;
  y: Float32Array;
  energyFrac: Float32Array;
}

/** Nests (Society) as a lean struct-of-arrays: position, strength fraction, owner hue. */
export interface NestFrame {
  count: number;
  x: Float32Array;
  y: Float32Array;
  /** strength / NEST_MAX_STRENGTH, clamped 0..1 — drives marker size/opacity. */
  strengthFrac: Float32Array;
  /** Owning lineage's hue (0..360) for tinting, or -1 if unknown. */
  hue: Float32Array;
}

/**
 * One full render snapshot. `light` is the day/night level in 0..1 (1 = noon,
 * 0 = deep night), computed worker-side from `tick % TICKS_PER_DAY`; the renderer
 * multiplies it into a single day/night tint (SPEC.md §Visual Design).
 */
export interface RenderFrame {
  tick: number;
  worldWidth: number;
  worldHeight: number;
  /** Field grid resolution — lets the UI map a click to the exact paintable cell. */
  gridCols: number;
  gridRows: number;
  light: number;
  /**
   * Per-cell water saturation in 0..1 (row-major, `gridCols*gridRows` long), so the
   * renderer can shade drought/flood on top of the authored water biome.
   */
  water: Float32Array;
  /**
   * Per-cell authored biome (`Biome` enum value, row-major), so the renderer draws the
   * terrain map (water / grassland / forest / barren / rock).
   */
  biome: Uint8Array;
  creatures: CreatureFrame;
  plants: PlantFrame;
  corpses: CorpseFrame;
  /** Nests (Society) — emergent homes rendered as lineage-tinted markers. */
  nests: NestFrame;
  /** Very recent births/kills, so something visibly *happens* when it happens. */
  flashes: FlashFrame;
}

/**
 * Momentary events worth a mark on screen — a birth or a kill in the last handful of
 * ticks. Without these the world moves continuously but never *reacts*: predation, the
 * most dramatic thing that happens, is invisible unless you happen to be watching the
 * exact pixel. Positions are carried on the event itself because the creature is gone
 * from the world by the time a frame is built.
 *
 * `age` is in ticks since the event, so the renderer can fade it out without keeping
 * any state of its own — the frame stays a complete description of the moment.
 */
/**
 * How long a birth/kill mark lives, in ticks (~0.6 s at `MS_PER_TICK`). Both sides must
 * agree — the worker uses it to decide which events to carry, the renderer to decide how
 * fast to fade them — so it lives here, in the contract, rather than as a pair of
 * constants that can silently drift apart. (This is the one runtime value in an
 * otherwise types-only module; every `sim/` import here is type-only and erases.)
 */
export const FLASH_TICKS = 12;

export interface FlashFrame {
  count: number;
  x: Float32Array;
  y: Float32Array;
  /** Ticks elapsed since the event fired (0 = this tick). */
  age: Float32Array;
  /** 0 = birth, 1 = kill. */
  kind: Uint8Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-gene expressed-value histogram. Keyed by gene name; each value is a
 * `TRAIT_BINS`-length count array over that gene's FIXED legal clamp range (the
 * same normalization basis `traitVariance` uses) — never the per-frame observed
 * min/max, so the charts have a stable domain and don't rescale every frame.
 */
export type TraitBins = Record<string, number[]>;

/**
 * Periodic world-health + distribution stats for the charts. `population` is the
 * population count per stable founder-lineage-root key (ancestry root id), not per
 * cluster label (labels aren't stable across recomputes) nor per hue (hue drifts).
 * Series that appear/disappear are handled by the chart consumer.
 */
export interface StatsPayload {
  tick: number;
  survivalTicks: number;
  meanPopulation: number;
  populationVariance: number;
  traitVariance: number;
  speciesCount: number;
  extinctionEvents: number;
  behaviorNovelty: number;
  /** population per founder-lineage-root key. */
  population: Record<number, number>;
  traits: TraitBins;
  /**
   * The whole-run timeline (Phase 5B.1): the downsampled population history + the ticks
   * of whole-world extinction events, for the always-visible scrubber. Bounded (history
   * is downsampled), so it is cheap to resend on the stats cadence.
   */
  timeline: TimelinePayload;
  /**
   * The plain-language event feed (most recent last), rebuilt on the stats cadence from
   * the sim's `eventLog` + typed `lineageEvents`. Bounded to the most recent
   * `MAX_FEED_EVENTS`, so resending it whole each time stays cheap and the UI needs no
   * accumulation logic — it renders whatever the latest stats carry.
   */
  events: WorldEvent[];
  /** Terrarium: the stewardship budget remaining (docs/designs/terrarium.md). */
  influence: number;
  /**
   * Terrarium: how interesting this world is, from the same `rankScore` the Phase 1 sweep
   * ranks configs by — rewards oscillation/diversity, punishes stagnation, and refuses to
   * reward a collapse. One owner (`sim/score.ts`) so the game and the sweep cannot drift.
   */
  score: number;
}

/**
 * One narratable world event, resolved worker-side into everything the UI needs to
 * phrase it in plain language. The sim's raw `eventLog` is per-tick and mostly noise
 * (a birth and a kill nearly every tick); this is the *notable* subset — the drama a
 * newcomer should be told about.
 *
 * Lineages are identified to the player by **hue**, never by root id: the renderer
 * already tints creatures and nests by lineage hue, so "the amber lineage" is both
 * plain language and a thing the player can go find on screen. `lineage` is retained
 * for keying and for science mode, which still shows raw ids.
 *
 * Tick-stamped, never wall-clock — `realTime` is not sim state, and a wall-clock
 * stamp is meaningless across an offline catch-up boundary (AGENTS.md).
 */
export interface WorldEvent {
  /** Stable identity for React keys and cross-digest dedupe: `${kind}:${tick}:${lineage}`. */
  key: string;
  tick: number;
  kind: "silence" | "extinction" | "boom" | "dominant" | "home";
  /** Founder-lineage-root id, or -1 for world-level events (`silence`). */
  lineage: number;
  /** Lineage hue in 0..360 for the feed's color dot, or -1 when unknown//world-level. */
  hue: number;
  /** Growth multiplier — only meaningful for `boom`. */
  factor: number;
  /** Plain-language place ("the northern forest"), or "" when the event has no site. */
  place: string;
}

/** The whole-run overview backing the timeline scrubber (Phase 5B.1). */
export interface TimelinePayload {
  /** Downsampled `{tick, population}` points spanning the full run. */
  points: { tick: number; population: number }[];
  /** Ticks at which a whole-world extinction event fired (chart tick-marks). */
  extinctionTicks: number[];
  /** The current tick (the scrubber's "now" marker). */
  now: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands (main → worker)  — SPEC.md §Data Flow sketch (canonical)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single typed, per-allele genome edit (Task 3.1). Either a trait/hue gene allele
 * or one brain arrow on one homolog. Editing a homolog marks the derived-weights
 * cache dirty and resets the recurrent `hidden` vector (stale recurrent state against
 * a changed brain is undefined — zeroing is the pinned choice).
 */
export type GenomePatch =
  | { kind: "trait"; gene: string; allele: 0 | 1; value: number }
  | { kind: "arrow"; arrow: number; homolog: "A" | "B"; weight?: number; enabled?: 0 | 1 };

/** A paintable field. Ledger fields move quanta; modulators are set directly. */
export type PaintField = "fertility" | "light" | "water" | "temperature" | "scent";

/**
 * A minimal spawn genome spec: expressed trait values (per gene) + hue. The worker
 * builds a diploid `Genome` from these (both alleles = the given value) with a
 * default/jittered brain, so the UI never has to ship full diploid arrays.
 */
export interface SpawnSpec {
  x: number;
  y: number;
  traits: Record<string, number>;
  hue: number;
  /** Energy/hydration to endow, drawn from the reservoir/water (never minted). */
  energy: number;
  hydration: number;
}

export type Command =
  // ── Phase 5A: persistence-aware boot (load-or-create + offline catch-up) ──────
  // `boot` is the default entry: the worker loads the newest saved world (or creates
  // a fresh one from seed+config), replays owed ticks if `catchupEnabled`, then goes
  // live. `init` remains the explicit new-world / reset path (bypasses storage).
  // `coldOpen` (Phase 5B.2): a pre-evolved snapshot loaded ONLY when there is no saved
  // world — so a first-time visitor lands in a living, hunting world, not a cold founder
  // start. A returning visitor's autosave always wins over it.
  //
  // `source` (UI overhaul) lets the landing screen CHOOSE the world instead of the
  // worker's default precedence:
  //   - undefined | "auto" → historical precedence: saved > coldOpen > founders.
  //   - "continue"         → same as "auto" (load the saved world; the button only
  //                          shows when a save exists).
  //   - "cold-open"        → IGNORE any save; load the supplied coldOpen snapshot.
  //   - "fresh"            → IGNORE any save; create founders from seed+config.
  // "cold-open"/"fresh" chosen while a save exists overwrite it on the next autosave.
  | {
      t: "boot";
      seed: number;
      config: Config;
      catchupEnabled: boolean;
      coldOpen?: SaveBlob;
      source?: "auto" | "continue" | "cold-open" | "fresh";
    }
  | { t: "setCatchup"; enabled: boolean }
  // `save` = "autosave now". The worker owns the save logic + ~30s timer, but
  // `visibilitychange` is a `document` (main-thread) event, so the main thread
  // forwards it as this command when the tab is hidden. Idempotent + guarded by the
  // Autosaver's in-flight flag.
  | { t: "save" }
  | { t: "init"; seed: number; config: Config }
  // Load a world from an imported save blob (Phase 5A.4 file import) — replaces the
  // live world with the deserialized one, then repaints.
  | { t: "loadSave"; blob: SaveBlob }
  | { t: "play" }
  | { t: "pause" }
  | { t: "speed"; ticksPerFrame: number }
  | { t: "inspect"; id: number }
  | { t: "snapshot" }
  // ── Phase 3 god-powers + stepping (all applied at the tick boundary) ──────────
  | { t: "step"; ticks: number }
  | { t: "spawn"; spec: SpawnSpec }
  | { t: "delete"; id: number }
  | { t: "editGenome"; id: number; patch: GenomePatch }
  | { t: "paint"; field: PaintField; cell: number; delta: number; brush?: number }
  | { t: "setParam"; key: string; value: number }
  /** Terrarium mode on/off (docs/designs/terrarium.md) — gates god-powers on `influence`. */
  | { t: "terrarium"; on: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Events (worker → main)
// ─────────────────────────────────────────────────────────────────────────────

export type Event =
  | { t: "frame"; frame: RenderFrame }
  | { t: "stats"; stats: StatsPayload }
  | { t: "creature"; data: Creature } // reply to `inspect`
  | { t: "snapshot"; world: SaveBlob } // reply to `snapshot`
  // ── Phase 5A: persistence lifecycle ──────────────────────────────────────────
  // `catchupProgress` drives the boot overlay (`total: 0` ⇒ no catch-up, skip it);
  // `ready` fires once the first live frame is emitted (dismiss the overlay);
  // `persistError` is a NON-FATAL failure that leaves the world intact. `kind` names the
  // subsystem so the UI can say which one broke: an autosave/storage failure and a save
  // file that could not be read are very different things to be told, and reporting the
  // second as the first sends the user looking at their storage instead of their file.
  | { t: "catchupProgress"; done: number; total: number }
  | { t: "ready" }
  | { t: "persistError"; reason: string; kind?: "autosave" | "import" | "boot" }
  // The "while you were away" report (Phase 5A.3): posted once after a catch-up that
  // produced lineage events. `sinceTick`/`nowTick` frame the window (narrated by
  // generation/tick, never wall-clock). Absent ⇒ no report (no catch-up or no drama).
  | { t: "report"; sinceTick: number; nowTick: number; events: LineageEvent[] };
