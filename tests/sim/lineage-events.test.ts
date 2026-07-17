/**
 * lineage-events.test.ts — the typed lineage-event detector (Phase 5A.3).
 *
 * The "while you were away" report narrates deterministic events keyed on stable
 * founder-lineage-root identity. This pins the detection: a lineage going extinct fires
 * exactly one `extinction`; a doubling fires `lineageBoom`; a sustained lead fires
 * `newDominant` (a brief lead does not). Scripted fixtures drive `detectLineageEvents`
 * directly against hand-built per-root populations — deterministic, `sim/` only.
 */

import { makeConfig } from "@sim/config";
import * as C from "@sim/constants";
import { detectLineageEvents, registerLineage } from "@sim/history";
import type { Creature, Genome, World } from "@sim/types";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";

/** A minimal creature with a given id + lineage (genome/fields irrelevant to detection). */
function stubCreature(id: number): Creature {
  return {
    id,
    parentId: null,
    x: 0,
    y: 0,
    heading: 0,
    vx: 0,
    vy: 0,
    energy: 1,
    hydration: 1,
    health: 1,
    age: 0,
    genome: {} as Genome,
    hidden: new Float32Array(0),
    ruleState: { mode: "wander", targetId: -1, targetKind: "none", committedTicks: 0 },
    actionWindow: new Float32Array(7),
  };
}

/** Set the world's live creatures to `count` members of lineage `root` (+ optionally more). */
function setPopulation(world: World, byRoot: Record<number, number>): void {
  const creatures: Creature[] = [];
  let nextId = 1;
  for (const rootStr of Object.keys(byRoot)) {
    const root = Number(rootStr);
    const count = byRoot[root] ?? 0;
    for (let i = 0; i < count; i++) {
      const c = stubCreature(nextId++);
      creatures.push(c);
      world.lineageRoots[c.id] = root;
    }
  }
  world.creatures = creatures;
}

/** A fresh empty world for hand-driven detection (no founders). */
function bareWorld(): World {
  const w = createWorld(1, makeConfig({}));
  w.creatures = [];
  w.lineageRoots = {};
  w.lineageEvents = [];
  w.dominant = null;
  w.rootPopSnapshots = [];
  return w;
}

describe("detectLineageEvents — extinction", () => {
  it("fires exactly one extinction when a live lineage drops to zero", () => {
    const w = bareWorld();
    // Sample 1: lineage 100 has 5, lineage 200 has 3.
    w.tick = 100;
    setPopulation(w, { 100: 5, 200: 3 });
    detectLineageEvents(w);
    expect(w.lineageEvents).toHaveLength(0); // first sample: baseline only

    // Sample 2: lineage 200 gone.
    w.tick = 200;
    setPopulation(w, { 100: 5 });
    detectLineageEvents(w);
    const extinctions = w.lineageEvents.filter((e) => e.kind === "extinction");
    expect(extinctions).toHaveLength(1);
    expect(extinctions[0]).toEqual({ kind: "extinction", tick: 200, lineage: 200 });
  });

  it("does not fire extinction for a lineage that was already zero", () => {
    const w = bareWorld();
    w.tick = 100;
    setPopulation(w, { 100: 5 });
    detectLineageEvents(w);
    w.tick = 200;
    setPopulation(w, { 100: 5 });
    detectLineageEvents(w);
    expect(w.lineageEvents.filter((e) => e.kind === "extinction")).toHaveLength(0);
  });
});

describe("detectLineageEvents — boom", () => {
  it("fires lineageBoom when a lineage at least doubles over the window", () => {
    const w = bareWorld();
    // Baseline within the window: lineage 100 has 4.
    w.tick = 100;
    setPopulation(w, { 100: 4 });
    detectLineageEvents(w);
    // Later, still within BOOM_WINDOW: lineage 100 has 8 (2×).
    w.tick = 100 + C.HISTORY_SAMPLE_INTERVAL;
    setPopulation(w, { 100: 8 });
    detectLineageEvents(w);
    const booms = w.lineageEvents.filter((e) => e.kind === "lineageBoom");
    expect(booms.length).toBeGreaterThanOrEqual(1);
    const boom = booms[0] as { kind: "lineageBoom"; lineage: number; factor: number };
    expect(boom.lineage).toBe(100);
    expect(boom.factor).toBeGreaterThanOrEqual(C.BOOM_FACTOR);
  });

  it("does not fire boom for a lineage that merely grows a little", () => {
    const w = bareWorld();
    w.tick = 100;
    setPopulation(w, { 100: 4 });
    detectLineageEvents(w);
    w.tick = 100 + C.HISTORY_SAMPLE_INTERVAL;
    setPopulation(w, { 100: 5 }); // < 2×
    detectLineageEvents(w);
    expect(w.lineageEvents.filter((e) => e.kind === "lineageBoom")).toHaveLength(0);
  });
});

describe("detectLineageEvents — dominance", () => {
  it("fires newDominant only after a lead is held for DOMINANCE_WINDOW ticks", () => {
    const w = bareWorld();
    // Lineage 100 leads from tick 0.
    w.tick = 0;
    setPopulation(w, { 100: 10, 200: 2 });
    detectLineageEvents(w);
    // Still leading, but not held long enough yet.
    w.tick = C.DOMINANCE_WINDOW - C.HISTORY_SAMPLE_INTERVAL;
    setPopulation(w, { 100: 10, 200: 2 });
    detectLineageEvents(w);
    expect(w.lineageEvents.filter((e) => e.kind === "newDominant")).toHaveLength(0);
    // Now held ≥ DOMINANCE_WINDOW.
    w.tick = C.DOMINANCE_WINDOW;
    setPopulation(w, { 100: 10, 200: 2 });
    detectLineageEvents(w);
    const dom = w.lineageEvents.filter((e) => e.kind === "newDominant");
    expect(dom).toHaveLength(1);
    expect((dom[0] as { lineage: number }).lineage).toBe(100);
  });

  it("resets the hold clock when the lead changes hands (no premature fire)", () => {
    const w = bareWorld();
    w.tick = 0;
    setPopulation(w, { 100: 10, 200: 2 });
    detectLineageEvents(w);
    // Lead flips to 200 just before the window elapses → clock resets, no fire yet.
    w.tick = C.DOMINANCE_WINDOW - C.HISTORY_SAMPLE_INTERVAL;
    setPopulation(w, { 100: 2, 200: 10 });
    detectLineageEvents(w);
    expect(w.lineageEvents.filter((e) => e.kind === "newDominant")).toHaveLength(0);
    expect(w.dominant?.lineage).toBe(200);
  });
});

describe("registerLineage", () => {
  it("founders are their own root; children inherit the parent's root", () => {
    const w = bareWorld();
    registerLineage(w, 1, null); // founder
    registerLineage(w, 2, 1); // child of 1
    registerLineage(w, 3, 2); // grandchild
    expect(w.lineageRoots[1]).toBe(1);
    expect(w.lineageRoots[2]).toBe(1);
    expect(w.lineageRoots[3]).toBe(1);
  });

  it("is idempotent (re-registering does not change the root)", () => {
    const w = bareWorld();
    registerLineage(w, 1, null);
    registerLineage(w, 1, null);
    expect(w.lineageRoots[1]).toBe(1);
  });
});
