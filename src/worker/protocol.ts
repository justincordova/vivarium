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
import type { Config, Creature } from "@sim/types";

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

/**
 * One full render snapshot. `light` is the day/night level in 0..1 (1 = noon,
 * 0 = deep night), computed worker-side from `tick % TICKS_PER_DAY`; the renderer
 * multiplies it into a single day/night tint (SPEC.md §Visual Design).
 */
export interface RenderFrame {
  tick: number;
  worldWidth: number;
  worldHeight: number;
  light: number;
  creatures: CreatureFrame;
  plants: PlantFrame;
  corpses: CorpseFrame;
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands (main → worker)  — SPEC.md §Data Flow sketch (canonical)
// ─────────────────────────────────────────────────────────────────────────────

export type Command =
  | { t: "init"; seed: number; config: Config }
  | { t: "play" }
  | { t: "pause" }
  | { t: "speed"; ticksPerFrame: number }
  | { t: "inspect"; id: number }
  | { t: "snapshot" };

// ─────────────────────────────────────────────────────────────────────────────
// Events (worker → main)
// ─────────────────────────────────────────────────────────────────────────────

export type Event =
  | { t: "frame"; frame: RenderFrame }
  | { t: "stats"; stats: StatsPayload }
  | { t: "creature"; data: Creature } // reply to `inspect`
  | { t: "snapshot"; world: SaveBlob } // reply to `snapshot`
  | { t: "catchupProgress"; done: number; total: number };
