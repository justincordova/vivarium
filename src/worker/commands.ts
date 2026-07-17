/**
 * commands.ts — pure, conservation-correct World mutators for the Phase 3 god-powers
 * (Task 3.1). Applied by `sim.worker.ts` at the tick boundary (never mid-resolve) so
 * determinism and the closed energy/water ledgers are preserved.
 *
 * **Every quantum movement goes through `energy.ts` transfers — nothing is minted or
 * destroyed.** Spawn draws from the reservoir/water; delete mirrors the sim's own
 * death path (energy→corpse, hydration→local water cell); paint moves ledger quanta
 * to/from the reservoir, and water paint is a local redistribution (no reservoir for
 * water exists). `totalEnergy`/`totalWater` hold exactly the tick after any op.
 *
 * Kept out of `sim/` (it's a UI/worker concern) but imports only sim TYPES + the
 * transfer helpers — never render/ui. Node-testable (no Worker/DOM).
 */

import * as C from "@sim/constants";
import { cellCompartment, fieldCompartment, transfer, transferUpTo } from "@sim/energy";
import { TRAIT_GENES, TRAIT_RANGE, type TraitGene } from "@sim/genetics";
import type { Allele, Corpse, Creature, Genome, Tunables, World } from "@sim/types";
import type { GenomePatch, PaintField, SpawnSpec } from "./protocol";

/** Grid cell index for a world position (mirrors sim's cellIndexOf/cellIndex). */
export function cellIndexOf(world: World, x: number, y: number): number {
  const { gridCols, gridRows, worldWidth, worldHeight } = world.config;
  const col = Math.min(gridCols - 1, Math.max(0, Math.floor((x / worldWidth) * gridCols)));
  const row = Math.min(gridRows - 1, Math.max(0, Math.floor((y / worldHeight) * gridRows)));
  return row * gridCols + col;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ─────────────────────────────────────────────────────────────────────────────
// spawn
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a diploid genome from an expressed-trait spec: both alleles set to the given
 * (clamped) expressed value, hue split evenly, and a small default brain (all arrows
 * enabled at the newborn fraction, zero weights — a blank slate; brains are dormant
 * under RuleBasedBrain anyway). No RNG — spawns are deterministic given the spec.
 */
function genomeFromSpec(spec: SpawnSpec): Genome {
  const weightsA = new Float32Array(C.ARROWS);
  const weightsB = new Float32Array(C.ARROWS);
  const enabledA = new Uint8Array(C.ARROWS);
  const enabledB = new Uint8Array(C.ARROWS);
  const g = { weightsA, weightsB, enabledA, enabledB } as Genome;
  for (const gene of TRAIT_GENES) {
    const [lo, hi] = TRAIT_RANGE[gene];
    const v = clamp(spec.traits[gene] ?? (lo + hi) / 2, lo, hi);
    g[gene] = [v, v] as Allele;
  }
  const hue = ((spec.hue % 360) + 360) % 360;
  g.hue = [hue, hue];
  return g;
}

/**
 * Spawn a creature at `spec.{x,y}` with energy/hydration drawn from the reservoir and
 * the local water cell (saturating — you can't spawn energy the world doesn't have).
 * Returns the new creature's id. Conserves both ledgers: the endowment is transferred
 * in, never minted. Spawn intentionally bypasses `CREATURE_CAP` — it is a god-power.
 */
export function applySpawn(world: World, spec: SpawnSpec): number {
  const x = clamp(spec.x, 0, world.config.worldWidth);
  const y = clamp(spec.y, 0, world.config.worldHeight);
  const creature: Creature = {
    id: world.nextId++,
    parentId: null,
    x,
    y,
    heading: 0,
    vx: 0,
    vy: 0,
    energy: 0,
    hydration: 0,
    health: C.MAX_HEALTH_BASE,
    age: 0,
    genome: genomeFromSpec(spec),
    hidden: new Float32Array(world.config.hidden),
    ruleState: { mode: "wander", targetId: -1, targetKind: "none", committedTicks: 0 },
    actionWindow: new Float32Array(C.ACTIONS),
  };
  const reservoir = fieldCompartment(world, "solarReservoir");
  transferUpTo(
    reservoir,
    fieldCompartment(creature, "energy"),
    Math.max(0, Math.round(spec.energy)),
  );
  const cell = cellCompartment(world.fields.water, cellIndexOf(world, x, y));
  transferUpTo(
    cell,
    fieldCompartment(creature, "hydration"),
    Math.max(0, Math.round(spec.hydration)),
  );

  world.creatures.push(creature);
  world.creatureIds.push(creature.id);
  return creature.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// delete
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete a creature by id — an instant death. Mirrors the sim's own removal
 * conservation exactly: its energy becomes a corpse, its hydration returns to the
 * local water cell. Returns true if a creature was removed.
 */
export function applyDelete(world: World, id: number): boolean {
  const idx = world.creatures.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  const c = world.creatures[idx] as Creature;
  const corpse: Corpse = { id: world.nextId++, x: c.x, y: c.y, energy: 0 };
  if (c.energy > 0) {
    transfer(fieldCompartment(c, "energy"), fieldCompartment(corpse, "energy"), c.energy);
  }
  if (c.hydration > 0) {
    const cell = cellCompartment(world.fields.water, cellIndexOf(world, c.x, c.y));
    transfer(fieldCompartment(c, "hydration"), cell, c.hydration);
  }
  world.corpses.push(corpse);
  world.creatures.splice(idx, 1);
  const idIdx = world.creatureIds.indexOf(id);
  if (idIdx >= 0) world.creatureIds.splice(idIdx, 1);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// editGenome
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a typed per-allele genome edit. Trait/hue edits clamp to the gene's legal
 * range. Brain-arrow edits set the weight/enable bit on one homolog, then invalidate
 * the derived-weights cache and zero the recurrent `hidden` vector (a changed brain
 * makes stale recurrent state undefined). Returns true if applied.
 */
export function applyEditGenome(world: World, id: number, patch: GenomePatch): boolean {
  const c = world.creatures.find((cr) => cr.id === id);
  if (c === undefined) return false;
  const g = c.genome;
  if (patch.kind === "trait") {
    if (patch.gene === "hue") {
      const v = ((patch.value % 360) + 360) % 360;
      g.hue[patch.allele] = v;
      return true;
    }
    if (!(TRAIT_GENES as readonly string[]).includes(patch.gene)) return false;
    const gene = patch.gene as TraitGene;
    const [lo, hi] = TRAIT_RANGE[gene];
    g[gene][patch.allele] = clamp(patch.value, lo, hi);
    return true;
  }
  // arrow edit
  if (patch.arrow < 0 || patch.arrow >= C.ARROWS) return false;
  const weights = patch.homolog === "A" ? g.weightsA : g.weightsB;
  const enabled = patch.homolog === "A" ? g.enabledA : g.enabledB;
  if (patch.weight !== undefined) weights[patch.arrow] = patch.weight;
  if (patch.enabled !== undefined) enabled[patch.arrow] = patch.enabled;
  // Invalidate the derived-weights cache (a no-op today — RuleBasedBrain never
  // populates `.derived`; load-bearing for the Phase 4 patchbay swap, when `derive()`
  // will) and reset the recurrent hidden state (live now).
  c.derived = undefined;
  c.hidden = new Float32Array(world.config.hidden);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// paint
// ─────────────────────────────────────────────────────────────────────────────

/** Cells within Chebyshev radius `brush` of `center` (a square brush neighborhood). */
function brushCells(world: World, center: number, brush: number): number[] {
  const cols = world.config.gridCols;
  const rows = world.config.gridRows;
  const cx = center % cols;
  const cy = Math.floor(center / cols);
  const out: number[] = [];
  for (let dy = -brush; dy <= brush; dy++) {
    for (let dx = -brush; dx <= brush; dx++) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      out.push(ny * cols + nx);
    }
  }
  return out;
}

/**
 * Paint a field cell. `delta` is a signed integer quantum change at `cell`.
 *
 *  - **fertility / light** — ledger fields with a reservoir. `delta > 0` moves quanta
 *    reservoir→cell (saturating on the reservoir); `delta < 0` moves cell→reservoir.
 *    Quanta are conserved (they move to/from `solarReservoir`).
 *  - **water** — no reservoir exists (SPEC.md §Water). Paint is a LOCAL
 *    redistribution: `delta < 0` (drought) pulls water from the center out to the
 *    brush ring; `delta > 0` pulls from the ring into the center. `totalWater` holds
 *    exactly and the water visibly moves within the field. Net removal isn't
 *    representable (no atmosphere) — the UI labels this "move water," not "remove."
 *  - **temperature / scent** — non-ledgered modulators; set/added directly.
 */
export function applyPaint(
  world: World,
  field: PaintField,
  cell: number,
  delta: number,
  brush = 1,
): void {
  const cells = world.config.gridCols * world.config.gridRows;
  if (cell < 0 || cell >= cells) return;
  const d = Math.round(delta);

  if (field === "temperature" || field === "scent") {
    // Use the rounded `d`, not the raw float: these modulators are read by sensors
    // that feed the deterministic tick, so a fractional delta would inject a
    // non-integer into a sim-read field (the quantize-on-entry rule applies here too).
    const arr = world.fields[field];
    for (const idx of brushCells(world, cell, brush)) {
      arr[idx] = (arr[idx] as number) + d;
    }
    return;
  }

  if (field === "fertility" || field === "light") {
    const arr = world.fields[field];
    const reservoir = fieldCompartment(world, "solarReservoir");
    const target = cellCompartment(arr, cell);
    if (d > 0) transferUpTo(reservoir, target, d);
    else if (d < 0) transferUpTo(target, reservoir, -d);
    return;
  }

  // water — local redistribution between center and the brush ring.
  const water = world.fields.water;
  const center = cellCompartment(water, cell);
  const ring = brushCells(world, cell, brush).filter((idx) => idx !== cell);
  if (ring.length === 0) return;

  if (d < 0) {
    // Drought at center: move up to |d| out of the center, spread across the ring.
    const moveTotal = Math.min(-d, center.get());
    if (moveTotal <= 0) return;
    const per = Math.floor(moveTotal / ring.length);
    let remainder = moveTotal - per * ring.length;
    for (const idx of ring) {
      let q = per;
      if (remainder > 0) {
        q += 1;
        remainder -= 1;
      }
      if (q > 0) transfer(center, cellCompartment(water, idx), q);
    }
  } else if (d > 0) {
    // Flood center: pull up to d total from the ring (saturating per cell) into center.
    let need = d;
    for (const idx of ring) {
      if (need <= 0) break;
      const src = cellCompartment(water, idx);
      // transferUpTo already saturates at src.get(); pass `need` directly.
      const moved = transferUpTo(src, center, need);
      need -= moved;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// setParam
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Live-set a tunable in `world.config.tunables`. `tick()` reads every UI-mutable
 * tunable from there (never from `constants.ts`), so this changes the sim's behavior
 * on the next tick and is captured in the serialized `world.config`. Only known
 * numeric scalar keys are accepted. Returns true if applied.
 */
export function applySetParam(world: World, key: string, value: number): boolean {
  const t = world.config.tunables as unknown as Record<string, unknown>;
  if (!(key in t)) return false;
  if (typeof t[key] !== "number") return false;
  if (!Number.isFinite(value)) return false;
  (world.config.tunables as unknown as Record<string, number>)[key] = value;
  return true;
}

/** Whether a tunable key is a live-editable numeric scalar (for the UI to enumerate). */
export function isNumericTunable(key: string, tunables: Tunables): boolean {
  return typeof (tunables as unknown as Record<string, unknown>)[key] === "number";
}
