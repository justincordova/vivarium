/**
 * tick.ts — the engine: `sense → think → act → resolve`, double-buffered.
 *
 * Composes every prior `sim/` module. Built last because it depends on all of them
 * (SPEC.md §"The Tick Loop"). Two load-bearing invariants gate this file:
 *   - **Determinism**: two runs from the same seed are bit-identical after N ticks.
 *     Iteration is index-based over stable id arrays; order is seeded-shuffle for
 *     agent actions and ascending-id for removals/plants; no `Set`/`Object.keys`.
 *   - **Conservation**: `totalEnergy`/`totalWater` are exactly equal before and
 *     after every tick. Every transfer goes through `energy.ts` helpers; every
 *     metabolic/action cost routes to `solarReservoir` as heat (SPEC.md §Energy
 *     step 4). All costs are integer quanta via `toQuantum`.
 *
 * Part of `sim/`.
 */

import type { Intents, Percept, RuleContext } from "./brain";
import { derive, patchbayThinkCached, ruleThink, tanhApprox } from "./brain";
// Fixed brain-skeleton dimension (NOT a tunable — the umwelt length is permanent per
// SPEC.md §Sensors; a change is a version bump, so it is read from constants directly
// like world.ts does, not from world.config.tunables).
import { SENSORS } from "./constants";
import {
  type Compartment,
  cellCompartment,
  fieldCompartment,
  toQuantum,
  transfer,
  transferUpTo,
} from "./energy";
import { crossover, distance, expressTrait, mutate, plantSeed } from "./genetics";
import { registerLineage } from "./history";
import { localDensity, SpatialHash, type SpatialPoint } from "./spatial";
import { growthMultiplier, moveCostMultiplier } from "./terrain";
import {
  Action,
  Biome,
  type Config,
  type Corpse,
  type Creature,
  type Plant,
  Sensor,
  type World,
} from "./types";

// ── Expressed-trait helpers ──────────────────────────────────────────────────

function maxEnergy(c: Creature, t: Config["tunables"]): number {
  return t.MAX_ENERGY_BASE + t.MAX_ENERGY_PER_SIZE * expressTrait(c.genome.size);
}
function maxHydration(c: Creature, t: Config["tunables"]): number {
  return t.MAX_HYDRATION_BASE + t.MAX_HYDRATION_PER_SIZE * expressTrait(c.genome.size);
}
function maxHealth(c: Creature, t: Config["tunables"]): number {
  return (
    t.MAX_HEALTH_BASE +
    t.MAX_HEALTH_PER_SIZE * expressTrait(c.genome.size) +
    t.MAX_HEALTH_PER_ARMOR * expressTrait(c.genome.armor)
  );
}
function reach(c: Creature, t: Config["tunables"]): number {
  return t.REACH_BASE + t.REACH_PER_SIZE * expressTrait(c.genome.size);
}
function attackPower(c: Creature): number {
  return expressTrait(c.genome.aggression) * expressTrait(c.genome.size);
}
function defenseScale(c: Creature): number {
  return Math.max(
    expressTrait(c.genome.size),
    expressTrait(c.genome.armor) * expressTrait(c.genome.size),
  );
}

/** Relative angle from `c`'s heading to a point, in the pinned `[−1,1]` convention. */
function relAngle(c: Creature, tx: number, ty: number): number {
  const abs = Math.atan2(ty - c.y, tx - c.x);
  let d = abs - c.heading;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d / Math.PI;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

// ── Immutable prior-state snapshot (double-buffering) ────────────────────────

interface Snapshot {
  creatures: readonly Creature[];
  /** id → creature, for O(1) percept-to-entity resolution. */
  byId: Map<number, Creature>;
  hash: SpatialHash;
  plantHash: SpatialHash;
  plantById: Map<number, Plant>;
  /** committed mate-target per creature id, from the prior tick (for rendezvous). */
  committedTargetById: Map<number, number>;
}

/** Cell size for the per-tick spatial hashes (world units). Bounds neighbor queries. */
const HASH_CELL = 10;

function snapshot(world: World): Snapshot {
  const pts: SpatialPoint[] = world.creatures.map((c) => ({ id: c.id, x: c.x, y: c.y }));
  const plantPts: SpatialPoint[] = world.plants.map((p) => ({ id: p.id, x: p.x, y: p.y }));
  const committed = new Map<number, number>();
  const byId = new Map<number, Creature>();
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i] as Creature;
    committed.set(c.id, c.ruleState.targetId);
    byId.set(c.id, c);
  }
  const plantById = new Map<number, Plant>();
  for (let i = 0; i < world.plants.length; i++) {
    const p = world.plants[i] as Plant;
    plantById.set(p.id, p);
  }
  return {
    creatures: world.creatures.slice(),
    byId,
    hash: new SpatialHash(pts, HASH_CELL),
    plantHash: new SpatialHash(plantPts, HASH_CELL),
    plantById,
    committedTargetById: committed,
  };
}

// ── Sense: build a RuleContext for one creature from the snapshot ────────────

function classifyFood(self: Creature, other: Creature): boolean {
  // Carnivore-leaning creatures perceive weaker living agents as food (huntable).
  return expressTrait(self.genome.diet) > 0.5 && expressTrait(other.genome.diet) >= 0;
}
function isThreat(self: Creature, other: Creature, t: Config["tunables"]): boolean {
  // Require the other to be *substantially* stronger (a margin) before it registers
  // as a threat — otherwise near-peers all flee each other and never feed/mate,
  // starving the bootstrap. (Phase-0 provisional; Phase 1 sweeps THREAT_MARGIN.)
  return attackPower(other) > defenseScale(self) * t.THREAT_MARGIN;
}
function isMate(self: Creature, other: Creature, t: Config["tunables"]): boolean {
  return (
    distance(self.genome, other.genome, t) < t.SPECIES_COMPAT_THRESHOLD &&
    other.energy > expressTrait(other.genome.matingThreshold)
  );
}

function senseContext(
  self: Creature,
  snap: Snapshot,
  world: World,
): {
  ctx: RuleContext;
  food: Percept | null;
  mate: Percept | null;
  threat: Percept | null;
  mateInReachFull: boolean;
  /** The 18-element sensor vector (SPEC.md §Sensors) — the patchbay `think` input. */
  senses: Float32Array;
} {
  const t = world.config.tunables;
  const senseRadius = expressTrait(self.genome.senseRadius);

  const nearest = (predicate: (o: Creature) => boolean, allowPlants: boolean): Percept | null => {
    let best: Creature | Plant | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    let bestIsAgent = false;
    // Creatures — bounded query over the spatial hash (O(neighbors), not O(N)).
    const creatureNeighbors = snap.hash.queryWithin(self.x, self.y, senseRadius);
    for (let i = 0; i < creatureNeighbors.length; i++) {
      const o = snap.byId.get(creatureNeighbors[i] as number);
      if (o === undefined || o.id === self.id) continue;
      const d = dist(self.x, self.y, o.x, o.y);
      if (d > senseRadius) continue;
      if (!predicate(o)) continue;
      if (d < bestD || (d === bestD && best !== null && o.id < best.id)) {
        best = o;
        bestD = d;
        bestIsAgent = true;
      }
    }
    // Plants (for food only) — bounded query over the plant hash.
    if (allowPlants && expressTrait(self.genome.diet) < 1) {
      const plantNeighbors = snap.plantHash.queryWithin(self.x, self.y, senseRadius);
      for (let i = 0; i < plantNeighbors.length; i++) {
        const p = snap.plantById.get(plantNeighbors[i] as number);
        if (p === undefined) continue;
        const d = dist(self.x, self.y, p.x, p.y);
        if (d > senseRadius) continue;
        if (d < bestD || (d === bestD && best !== null && p.id < best.id)) {
          best = p;
          bestD = d;
          bestIsAgent = false;
        }
      }
    }
    if (best === null) return null;
    return {
      id: best.id,
      angle: relAngle(self, best.x, best.y),
      distance: Math.min(1, bestD / senseRadius),
      isAgent: bestIsAgent,
    };
  };

  const food = nearest((o) => classifyFood(self, o), true);
  const threat = nearest((o) => isThreat(self, o, t), false);
  const mate = nearest((o) => isMate(self, o, t), false);

  const cellIdx = cellIndexOf(world.config, self.x, self.y);
  const localWater = Math.min(1, (world.fields.water[cellIdx] as number) / t.WATER_CELL_MAX);
  const mateReciprocal = mate !== null ? (snap.committedTargetById.get(mate.id) ?? null) : null;

  // Distance to the nearest mate at snapshot time (real units). `mateInReach` (0.6×
  // reach) tells the policy to settle *inside* reach so the pair doesn't oscillate at
  // the boundary; `mateInReachFull` (full reach) is what actually authorizes a birth,
  // evaluated against the snapshot so mating is order-independent (SPEC.md §Tick Loop
  // — decisions use the double-buffered prior state, no first-mover advantage).
  let mateInReach = false;
  let mateInReachFull = false;
  if (mate !== null) {
    // O(1) via the snapshot's id index (same object as a linear `find`), off the
    // O(N²) mate-sensing path that would otherwise dominate the hottest loop.
    const mateCreature = snap.byId.get(mate.id);
    if (mateCreature !== undefined) {
      const d = dist(self.x, self.y, mateCreature.x, mateCreature.y);
      mateInReach = d <= reach(self, t) * 0.6;
      mateInReachFull = d <= reach(self, t);
    }
  }

  const energyFrac = Math.min(1, self.energy / maxEnergy(self, t));
  const hydrationFrac = Math.min(1, self.hydration / maxHydration(self, t));

  const ctx: RuleContext = {
    selfId: self.id,
    energyFrac,
    hydrationFrac,
    localWater,
    nearestFood: food,
    nearestThreat: threat,
    nearestMate: mate,
    mateReciprocalTargetId: mateReciprocal,
    mateInReach,
    ruleState: self.ruleState,
  };

  // The 21-sensor umwelt (SPEC.md §Sensors — exact indices, polarities, normalizers;
  // Living World Phase 6B appended 3 terrain senses).
  // Distance sensors follow the pinned polarity: 0 = adjacent, 1 = at/beyond limit /
  // absent (a null percept reads 1.0, indistinguishable from "nothing there").
  const senses = new Float32Array(SENSORS);
  const maxLife = expressTrait(self.genome.maxLifespan);
  const light = world.fields.light[cellIdx] as number;
  const temp = world.fields.temperature[cellIdx] as number;
  const fertility = world.fields.fertility[cellIdx] as number;
  const scent = world.fields.scent[cellIdx] as number;
  const density = localDensity(snap.hash, self.x, self.y, t.DENSITY_RADIUS);
  senses[Sensor.Bias] = 1;
  senses[Sensor.OwnEnergy] = energyFrac;
  senses[Sensor.OwnHydration] = hydrationFrac;
  senses[Sensor.OwnAge] = maxLife > 0 ? Math.min(1, self.age / maxLife) : 1;
  senses[Sensor.OwnHealth] = Math.min(1, self.health / maxHealth(self, t));
  senses[Sensor.NearestFoodDistance] = food !== null ? food.distance : 1;
  senses[Sensor.NearestFoodAngle] = food !== null ? food.angle : 0;
  senses[Sensor.NearestThreatDistance] = threat !== null ? threat.distance : 1;
  senses[Sensor.NearestThreatAngle] = threat !== null ? threat.angle : 0;
  senses[Sensor.NearestMateDistance] = mate !== null ? mate.distance : 1;
  senses[Sensor.NearestMateAngle] = mate !== null ? mate.angle : 0;
  // Density normalizer: saturate at 2×REPRO_CROWD_LIMIT neighbors (a tunable referent,
  // not an undefined quantity — SPEC.md §Sensors "every 0..1 sensor has a named
  // referent"). `density` includes self, so subtract 1 for the neighbor count.
  senses[Sensor.LocalDensity] = Math.min(1, Math.max(0, density - 1) / (2 * t.REPRO_CROWD_LIMIT));
  senses[Sensor.LightLevel] = Math.min(1, light / t.LIGHT_SENSOR_MAX);
  senses[Sensor.LocalTemperature] = clampUnit((temp - t.TEMP_MIN) / (t.TEMP_MAX - t.TEMP_MIN));
  senses[Sensor.LocalWater] = localWater;
  senses[Sensor.LocalFertility] = Math.min(1, fertility / t.FERTILITY_CELL_MAX);
  senses[Sensor.ScentValue] = Math.min(1, scent / t.SCENT_SENSOR_MAX);
  // Scent gradient direction (sensor 17): the signed relative angle toward the
  // higher-scent neighbor cell. Fed 0 in v1 (a reserved sensor per SPEC.md §Sensors
  // "some may be fed zeros initially and enabled one at a time") — deferring the
  // gradient sample keeps "change one thing at a time" and avoids a second field pass.
  senses[Sensor.ScentGradient] = 0;

  // Terrain senses (Living World, Phase 6B). Local biome normalized to 0..1, and a unit
  // vector toward the nearest water cell (0,0 if none within the search radius). All
  // read-only functions of terrain + position → deterministic.
  senses[Sensor.LocalBiome] = (world.terrain.biome[cellIdx] as number) / 4;
  const [wdx, wdy] = nearestWaterDir(world, self.x, self.y);
  senses[Sensor.WaterDirX] = wdx;
  senses[Sensor.WaterDirY] = wdy;

  return { ctx, food, mate, threat, mateInReachFull, senses };
}

/**
 * Unit vector from `(x,y)` toward the center of the nearest Water-biome cell within a
 * bounded ring search, or `[0,0]` if none is found. Deterministic and index-based
 * (expanding square rings around the creature's cell), so it never iterates a Set or
 * depends on insertion order.
 */
function nearestWaterDir(world: World, x: number, y: number): [number, number] {
  const { gridCols: cols, gridRows: rows, worldWidth: ww, worldHeight: wh } = world.config;
  const cw = ww / cols;
  const ch = wh / rows;
  const c0 = Math.min(cols - 1, Math.max(0, Math.floor((x / ww) * cols)));
  const r0 = Math.min(rows - 1, Math.max(0, Math.floor((y / wh) * rows)));
  const MAX_RING = 8; // bounded search — a local sense, not a global oracle
  for (let ring = 0; ring <= MAX_RING; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      const rr = r0 + dr;
      if (rr < 0 || rr >= rows) continue;
      for (let dc = -ring; dc <= ring; dc++) {
        // Only the ring perimeter (skip the interior already scanned).
        if (ring > 0 && Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue;
        const cc = c0 + dc;
        if (cc < 0 || cc >= cols) continue;
        if (world.terrain.biome[rr * cols + cc] === Biome.Water) {
          const tx = (cc + 0.5) * cw;
          const ty = (rr + 0.5) * ch;
          const ddx = tx - x;
          const ddy = ty - y;
          const len = Math.hypot(ddx, ddy);
          return len > 0 ? [ddx / len, ddy / len] : [0, 0];
        }
      }
    }
  }
  return [0, 0];
}

function cellIndexOf(config: Config, x: number, y: number): number {
  const col = Math.min(
    config.gridCols - 1,
    Math.max(0, Math.floor((x / config.worldWidth) * config.gridCols)),
  );
  const row = Math.min(
    config.gridRows - 1,
    Math.max(0, Math.floor((y / config.worldHeight) * config.gridRows)),
  );
  return row * config.gridCols + col;
}

// ── Seeded shuffle (resolve-shuffle stream) ──────────────────────────────────

function shuffledIndices(n: number, rngNext: () => number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rngNext() * (i + 1));
    const tmp = idx[i] as number;
    idx[i] = idx[j] as number;
    idx[j] = tmp;
  }
  return idx;
}

// ── Patchbay action decoder ──────────────────────────────────────────────────

/**
 * Decode a patchbay `actions` vector (7 floats, each already in the activation's
 * `[−1,1]` range) into the same `Intents` the rule policy emits, so the downstream
 * resolve path is identical for both brains (SPEC.md §Actions).
 *
 *   - `turn` / `accelerate` (outputs 0/1) pass through as signed scalars. The
 *     clamp-then-scale-by-metabolism happens in `applyCreature` (SPEC.md §Actions
 *     "Output-clamp-then-scale ordering"); `accelerate ≤ 0` there means brake/rest,
 *     so a negative neural output is a valid "hold" — no separate rest output.
 *   - Gated actions (2–5) fire when their output exceeds the reserved per-action
 *     threshold tunable (`EAT_THRESHOLD` … `MATE_THRESHOLD`).
 *   - `emit` (6) fires above `EMIT_THRESHOLD`.
 *
 * Targets (which food/mate/threat) still come from the perceived percepts in the
 * `PlannedAction`, exactly as under the rule policy — the brain chooses *whether*
 * to eat/attack/mate, the sensors choose the nearest valid target.
 */
function decodeActions(actions: Float32Array, t: Config["tunables"]): Intents {
  return {
    turn: actions[Action.Turn] as number,
    accelerate: actions[Action.Accelerate] as number,
    eat: (actions[Action.Eat] as number) > t.EAT_THRESHOLD,
    drink: (actions[Action.Drink] as number) > t.DRINK_THRESHOLD,
    attack: (actions[Action.Attack] as number) > t.ATTACK_THRESHOLD,
    mate: (actions[Action.Mate] as number) > t.MATE_THRESHOLD,
    emit: (actions[Action.EmitScent] as number) > t.EMIT_THRESHOLD,
  };
}

/**
 * Run the active brain for one creature: the rule policy (Phases 0–3) or the
 * patchbay forward pass (Phase 4), selected by `world.config.brainKind`. For the
 * patchbay, derives-and-caches the expressed brain on `creature.derived`, runs the
 * forward pass against `creature.hidden` (previous tick's recurrent state), writes
 * the new hidden vector back, and decodes the action vector into intents.
 *
 * The `derived` cache is lazily populated once per creature and persists for its
 * life (its homologs never change after birth — mutation applies only to newborns).
 * God-power brain edits invalidate it by setting `creature.derived = undefined`
 * (worker/commands.ts), forcing a re-derive here.
 */
function runBrain(world: World, self: Creature, ctx: RuleContext, senses: Float32Array): Intents {
  if (world.config.brainKind === "rule") {
    return ruleThink(ctx);
  }
  // Patchbay: derive-once-and-cache, then forward pass with recurrent memory. The
  // hidden-neuron count is world-creation geometry (config.hidden), not a constant, so
  // the enlargement experiment (Task 4.4) can run HIDDEN=20 fresh worlds.
  if (self.derived === undefined) self.derived = derive(self.genome);
  const { actions, hidden } = patchbayThinkCached(
    self.derived,
    senses,
    self.hidden,
    world.config.hidden,
  );
  self.hidden = hidden; // recurrent state for next tick (serialized runtime state)
  return decodeActions(actions, world.config.tunables);
}

// ── The tick ─────────────────────────────────────────────────────────────────

interface PlannedAction {
  creature: Creature;
  intents: Intents;
  foodId: number | null;
  mateId: number | null;
  threatId: number | null;
  /** Whether the mate was within reach at snapshot time (decisions are snapshot-based). */
  mateInReach: boolean;
}

export function tick(world: World): void {
  const t = world.config.tunables;
  const reservoir = fieldCompartment(world, "solarReservoir");
  const snap = snapshot(world);

  // 1–3. Sense + Think + Act: gather intents against the immutable snapshot.
  const planned: PlannedAction[] = [];
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i] as Creature;
    const { ctx, food, mate, threat, mateInReachFull, senses } = senseContext(c, snap, world);
    // Active brain: rule policy (Phases 0–3) or patchbay forward pass (Phase 4),
    // selected by config.brainKind. The patchbay writes c.hidden back for recurrence.
    const intents = runBrain(world, c, ctx, senses);
    planned.push({
      creature: c,
      intents,
      foodId: food?.id ?? null,
      mateId: mate?.id ?? null,
      threatId: threat?.id ?? null,
      mateInReach: mateInReachFull,
    });
  }

  // 4.1 Agent actions in resolve-shuffle order, creature-major.
  const order = shuffledIndices(planned.length, () => world.rng["resolve-shuffle"].next());
  const byId = new Map<number, Creature>();
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i] as Creature;
    byId.set(c.id, c);
  }

  for (let oi = 0; oi < order.length; oi++) {
    const plan = planned[order[oi] as number] as PlannedAction;
    const c = plan.creature;
    if (c.energy <= 0 || c.hydration <= 0 || c.health <= 0) continue; // already doomed
    applyCreature(world, c, plan, byId, reservoir, t, snap);
  }

  // 4.1b Update each creature's trailing action-fire histogram (behaviorNovelty
  // accumulator, plan Task 1.1/1.2). Index-order over `planned` — decay is a
  // per-creature commutative op so order is deterministic; newborns from this tick
  // are absent here and start updating next tick from their zero window. This writes
  // per-creature state but is NEVER read back into think(), so it does not enter the
  // determinism-critical path.
  for (let pi = 0; pi < planned.length; pi++) {
    const plan = planned[pi] as PlannedAction;
    updateActionWindow(plan.creature, plan.intents, t);
  }

  // 4.2 Removals in ascending-id order (with the Allee low-density starvation rescue).
  resolveRemovals(world, reservoir, t);

  // 4.3 Plant updates in ascending plant-id order.
  resolvePlants(world, reservoir);

  // 4.4 Field updates, fixed order.
  resolveFields(world, reservoir);

  world.tick++;
}

// ── 4.1b behaviorNovelty accumulator ─────────────────────────────────────────

/**
 * Decay a creature's action-fire histogram one tick and add this tick's fires
 * (plan Task 1.1). Exponential-decay realization of a trailing `NOVELTY_WINDOW`:
 * every slot × `(1 − 1/NOVELTY_WINDOW)`, then a fired action's slot += 1. Fire
 * predicates: the 5 gated actions fire when their gate fired (the intent); the 2
 * continuous outputs fire when `|output| > NOVELTY_ACT_EPS`. Pure per-creature
 * mutation of `actionWindow`; the result is read only by `stats.ts`, never `think()`.
 */
function updateActionWindow(c: Creature, intents: Intents, t: Config["tunables"]): void {
  const w = c.actionWindow;
  const decay = 1 - 1 / t.NOVELTY_WINDOW;
  for (let k = 0; k < w.length; k++) w[k] = (w[k] as number) * decay;
  const eps = t.NOVELTY_ACT_EPS;
  if (Math.abs(intents.turn) > eps) w[Action.Turn] = (w[Action.Turn] as number) + 1;
  if (Math.abs(intents.accelerate) > eps) {
    w[Action.Accelerate] = (w[Action.Accelerate] as number) + 1;
  }
  if (intents.eat) w[Action.Eat] = (w[Action.Eat] as number) + 1;
  if (intents.drink) w[Action.Drink] = (w[Action.Drink] as number) + 1;
  if (intents.attack) w[Action.Attack] = (w[Action.Attack] as number) + 1;
  if (intents.mate) w[Action.Mate] = (w[Action.Mate] as number) + 1;
  if (intents.emit) w[Action.EmitScent] = (w[Action.EmitScent] as number) + 1;
}

// ── 4.1 helpers ──────────────────────────────────────────────────────────────

function applyCreature(
  world: World,
  c: Creature,
  plan: PlannedAction,
  byId: Map<number, Creature>,
  reservoir: Compartment,
  t: Config["tunables"],
  snap: Snapshot,
): void {
  const cEnergy = fieldCompartment(c, "energy");
  const size = expressTrait(c.genome.size);
  const metabolism = expressTrait(c.genome.metabolism);

  // Baseline metabolic cost → reservoir (heat). Scaled by size & metabolism.
  // Coefficient keeps the drain small relative to energy stores so creatures have a
  // runway to find food (Phase-0 provisional; Phase 1 sweeps it).
  const baseline = toQuantum(1 + size * metabolism * t.METABOLIC_COST_COEF);
  transferUpTo(cEnergy, reservoir, baseline);

  // Cold-temperature metabolic surcharge (Phase 5C.1) → reservoir (heat). Below
  // TEMP_COMFORT, a creature pays extra INVERSELY to size (small bodies lose heat faster),
  // so cold cells select for larger size and (via the night drop) diurnal/circadian
  // adaptation — a real heritable pressure with no new gene. Conserved: creature energy →
  // solarReservoir, quantized. Temperature is read from the (deterministic) field.
  const localTemp = world.fields.temperature[cellIndexOf(world.config, c.x, c.y)] as number;
  const coldDeficit = t.TEMP_COMFORT - localTemp;
  if (coldDeficit > 0 && size > 0) {
    const surcharge = toQuantum((coldDeficit * t.TEMP_COLD_COEF) / size);
    if (surcharge > 0) transferUpTo(cEnergy, reservoir, surcharge);
  }

  // Density surcharge (crowding) → reservoir. Reuses the snapshot hash (start-of-tick
  // positions — consistent with double-buffering) instead of rebuilding per creature.
  const density = localDensity(snap.hash, c.x, c.y, t.DENSITY_RADIUS);
  if (density > 1) transferUpTo(cEnergy, reservoir, toQuantum((density - 1) * 0.5));

  // Senescence: cost rises near maxLifespan.
  const lifespan = expressTrait(c.genome.maxLifespan);
  if (c.age > lifespan * 0.5) {
    transferUpTo(cEnergy, reservoir, toQuantum((c.age / lifespan) * metabolism));
  }

  // Movement (turn + accelerate) with cost ∝ speed².
  const mass = 1 + t.K_SIZE * size + t.K_ARMOR * expressTrait(c.genome.armor);
  const appliedTurn = clampSigned(plan.intents.turn) * t.MAX_TURN_RATE * metabolism;
  c.heading += appliedTurn;
  const appliedAccel = (clampUnit(plan.intents.accelerate) * (t.MAX_ACCEL * metabolism)) / mass;
  const speed = expressTrait(c.genome.speed);
  if (plan.intents.accelerate <= 0) {
    // Braking/holding: strongly damp residual velocity so a "hold" creature stops
    // quickly (otherwise it drifts/overshoots a rendezvous it just reached).
    c.vx *= 0.2;
    c.vy *= 0.2;
  }
  c.vx += Math.cos(c.heading) * appliedAccel;
  c.vy += Math.sin(c.heading) * appliedAccel;
  // Cap velocity to speed gene.
  const v = Math.hypot(c.vx, c.vy);
  if (v > speed && v > 0) {
    c.vx = (c.vx / v) * speed;
    c.vy = (c.vy / v) * speed;
  }
  // Terrain impedes movement by biome (rock slow, water near-impassable): scale the
  // step by the creature's current cell. This affects POSITION only — no ledger touched.
  const moveMul = moveCostMultiplier(
    world.terrain.biome[cellIndexOf(world.config, c.x, c.y)] as number,
  );
  c.x = clamp(c.x + c.vx * moveMul, 0, world.config.worldWidth);
  c.y = clamp(c.y + c.vy * moveMul, 0, world.config.worldHeight);
  if (appliedAccel !== 0) {
    transferUpTo(cEnergy, reservoir, toQuantum(speed * speed * t.MOVEMENT_COST_COEF + 1));
  }

  // Healing (only above energy threshold; paid in energy → reservoir).
  const mh = maxHealth(c, t);
  if (c.energy > t.HEAL_ENERGY_THRESHOLD && c.health < mh) {
    const healPts = Math.min(t.HEAL_RATE, mh - c.health);
    const cost = toQuantum(healPts * t.HEAL_COST);
    if (cost <= c.energy) {
      c.health += healPts;
      transfer(cEnergy, reservoir, cost);
    }
  }

  // Drink: water cell → hydration.
  if (plan.intents.drink) {
    const cellIdx = cellIndexOf(world.config, c.x, c.y);
    const want = toQuantum(maxHydration(c, t) - c.hydration);
    if (want > 0) {
      transferUpTo(
        cellCompartment(world.fields.water, cellIdx),
        fieldCompartment(c, "hydration"),
        want,
      );
    }
  }

  // Eat: nearest food in reach (plant or corpse), diet-scaled; remainder → fertility.
  if (plan.intents.eat && plan.foodId !== null) {
    tryEat(world, c, plan.foodId, t);
  }

  // Attack: contest against the committed target if in reach and stronger.
  if (plan.intents.attack && plan.foodId !== null) {
    tryAttack(world, c, plan.foodId, byId, reservoir, t);
  }

  // Mate: reproduce with the committed mate if in reach (snapshot) + both thresholds.
  if (plan.intents.mate && plan.mateId !== null && plan.mateInReach) {
    tryMate(world, c, plan.mateId, byId, t, snap);
  }

  // Emit scent into the local cell.
  if (plan.intents.emit) {
    const cellIdx = cellIndexOf(world.config, c.x, c.y);
    world.fields.scent[cellIdx] = (world.fields.scent[cellIdx] as number) + t.EMIT_INTENSITY;
  }
}

function tryEat(world: World, c: Creature, foodId: number, t: Config["tunables"]): void {
  const r = reach(c, t);
  const diet = expressTrait(c.genome.diet);
  const digest = expressTrait(c.genome.digestionEfficiency);

  // Plant?
  for (let i = 0; i < world.plants.length; i++) {
    const p = world.plants[i] as Plant;
    if (p.id !== foodId) continue;
    if (dist(c.x, c.y, p.x, p.y) > r) return;
    const toughness = expressTrait(p.genome.toughness);
    const released = toQuantum(p.energy * (1 - toughness));
    if (released <= 0) return;
    const captured = toQuantum(released * (1 - diet) * digest);
    const cell = cellIndexOf(world.config, p.x, p.y);
    // Move captured → creature; remainder of released → fertility. Withheld stays.
    transfer(fieldCompartment(p, "energy"), fieldCompartment(c, "energy"), captured);
    transfer(
      fieldCompartment(p, "energy"),
      cellCompartment(world.fields.fertility, cell),
      released - captured,
    );
    return;
  }
  // Corpse?
  for (let i = 0; i < world.corpses.length; i++) {
    const corpse = world.corpses[i] as Corpse;
    if (corpse.id !== foodId) continue;
    if (dist(c.x, c.y, corpse.x, corpse.y) > r) return;
    // Capture the diet-scaled fraction; the uncaptured remainder stays in the
    // corpse compartment (conservative — it decays to fertility over later ticks).
    const captured = toQuantum(corpse.energy * diet * digest);
    transferUpTo(fieldCompartment(corpse, "energy"), fieldCompartment(c, "energy"), captured);
    return;
  }
}

function tryAttack(
  world: World,
  attacker: Creature,
  targetId: number,
  byId: Map<number, Creature>,
  reservoir: Compartment,
  t: Config["tunables"],
): void {
  const target = byId.get(targetId);
  if (target === undefined || target.id === attacker.id) return;
  if (target.health <= 0) return;
  if (dist(attacker.x, attacker.y, target.x, target.y) > reach(attacker, t)) return;

  const power = attackPower(attacker);
  const resist = defenseScale(target);
  if (power < resist) return; // not the stronger party — don't initiate

  // Attack cost → reservoir (a failed attack is not free).
  transferUpTo(fieldCompartment(attacker, "energy"), reservoir, toQuantum(2));

  // Escape check (resolve stream).
  const offHeading = Math.abs(relAngle(attacker, target.x, target.y));
  const pEscape = sigmoid(
    t.K_SPEED * (expressTrait(target.genome.speed) - expressTrait(attacker.genome.speed)) +
      t.K_ANGLE * offHeading,
  );
  if (world.rng.resolve.next() < pEscape) return; // escaped

  // Contest.
  const pWin = power / (power + resist);
  if (world.rng.resolve.next() < pWin) {
    // Attacker wins: deal damage (may be lethal → corpse path at removals).
    target.health -= toQuantum(power);
    if (target.health < 0) target.health = 0;
    if (target.health === 0) {
      world.eventLog.push({ tick: world.tick, event: `kill:${target.id}` });
    }
    // Scavenge-to-gain: commit to the target so next tick seeks the corpse.
    attacker.ruleState.targetId = target.id;
    attacker.ruleState.targetKind = "corpse";
  } else {
    // Defender wins: counter-damage scaled by toxicity/armor.
    const counter = toQuantum(
      expressTrait(target.genome.toxicity) + expressTrait(target.genome.armor),
    );
    attacker.health -= counter;
    if (attacker.health < 0) attacker.health = 0;
  }
}

function tryMate(
  world: World,
  a: Creature,
  mateId: number,
  byId: Map<number, Creature>,
  t: Config["tunables"],
  snap: Snapshot,
): void {
  const b = byId.get(mateId);
  if (b === undefined || b.id === a.id) return;
  // Hard population ceiling (memory/CPU bound) — absolute, no RNG.
  if (world.creatures.length >= t.CREATURE_CAP) return;
  // Reach was validated against the snapshot (plan.mateInReach) so mating is
  // order-independent; no live-distance recheck here (it would reintroduce the
  // mid-tick overshoot/first-mover sensitivity).
  // Both must be above their mating threshold.
  if (a.energy <= expressTrait(a.genome.matingThreshold)) return;
  if (b.energy <= expressTrait(b.genome.matingThreshold)) return;
  // Deterministic single-birth: only the LOWER-id parent initiates, so the pair
  // produces one child regardless of processing order. Placed BEFORE the stochastic
  // brake so exactly one initiator per pair draws from the `mating` stream (RNG
  // consumption stays a clean function of the birth attempt, not of processing order).
  if (a.id > b.id) return;

  // Graduated density-dependent reproduction brake (SPEC.md §World-Health — density-
  // dependent effects are the primary in-scope stabilizer). A HARD cliff at the food
  // carrying capacity is fragile: births≈deaths pinned at the cap, then a transient
  // death excess death-spirals to extinction (diagnosed empirically). Two smooth
  // brakes instead:
  //   1. global soft brake — above CREATURE_CAP×REPRO_SOFT_FRAC, suppress a birth with
  //      probability rising to 1 at the cap (smooth negative feedback → oscillation).
  //   2. local-crowding brake — suppress when the initiator's neighborhood is dense, so
  //      dense demes stop breeding before sparse ones (refuges → speciation).
  // Draws use the deterministic `mating` stream; only the lower-id initiator reaches
  // here, so consumption is deterministic.
  const pop = world.creatures.length;
  const soft = t.CREATURE_CAP * t.REPRO_SOFT_FRAC;
  if (pop > soft) {
    const suppress = (pop - soft) / (t.CREATURE_CAP - soft);
    if (world.rng.mating.next() < suppress) return;
  }
  const localCrowd = localDensity(snap.hash, a.x, a.y, t.DENSITY_RADIUS) - 1;
  if (localCrowd > t.REPRO_CROWD_LIMIT) {
    const crowdSuppress = Math.min(1, (localCrowd - t.REPRO_CROWD_LIMIT) / t.REPRO_CROWD_LIMIT);
    if (world.rng.mating.next() < crowdSuppress) return;
  }

  const invA = toQuantum(expressTrait(a.genome.offspringInvestment));
  const invB = toQuantum(expressTrait(b.genome.offspringInvestment));
  if (invA > a.energy || invB > b.energy) return; // can't afford (energy)
  // Note: no hydration gate is needed here. A child born at hydration 0 would die the
  // same tick in `resolveRemovals`, but that is UNREACHABLE, given TWO premises:
  //   (1) the initiator `a` always has `hydration >= 1` — creatures with `hydration <= 0`
  //       are skipped before `applyCreature` ever calls `tryMate` (see tick.ts ~L416); and
  //   (2) `offspringInvestment ∈ [1, 500]` (genetics.ts, clamped on every mutation), so
  //       `invA >= 1` ⇒ `toQuantum(invA * 0.5) >= 1`.
  // Together: `waterA = min(toQuantum(invA*0.5), a.hydration) >= 1`, so the child always
  // seeds with positive hydration even when the co-parent `b` is fully dehydrated (waterB
  // may be 0). Gating on `b`'s hydration here would instead wrongly refuse a viable birth
  // that `a`'s water can fund. If premise (2) ever changes (a lower investment floor), the
  // child could round to hydration 0 and this reasoning must be revisited.

  const childGenome = crossover(a.genome, b.genome, world.rng.mating);
  mutate(childGenome, world.rng.mutation, t);

  const child: Creature = {
    id: world.nextId++,
    parentId: a.id,
    x: clamp((a.x + b.x) / 2, 0, world.config.worldWidth),
    y: clamp((a.y + b.y) / 2, 0, world.config.worldHeight),
    heading: a.heading,
    vx: 0,
    vy: 0,
    energy: 0,
    hydration: 0,
    health: maxHealth(a, t),
    age: 0,
    genome: childGenome,
    hidden: new Float32Array(world.config.hidden),
    ruleState: { mode: "wander", targetId: -1, targetKind: "none", committedTicks: 0 },
    actionWindow: new Float32Array(Action.EmitScent + 1),
  };
  // Energy transferred from BOTH parents; water likewise (mirror). Never minted.
  transfer(fieldCompartment(a, "energy"), fieldCompartment(child, "energy"), invA);
  transfer(fieldCompartment(b, "energy"), fieldCompartment(child, "energy"), invB);
  const waterA = Math.min(toQuantum(invA * 0.5), a.hydration);
  const waterB = Math.min(toQuantum(invB * 0.5), b.hydration);
  transfer(fieldCompartment(a, "hydration"), fieldCompartment(child, "hydration"), waterA);
  transfer(fieldCompartment(b, "hydration"), fieldCompartment(child, "hydration"), waterB);

  world.creatures.push(child);
  world.creatureIds.push(child.id);
  byId.set(child.id, child);
  // Inherit the parent's founder-lineage root (Phase 5A.3) — the initiating parent `a`.
  registerLineage(world, child.id, a.id);
  world.eventLog.push({ tick: world.tick, event: `birth:${child.id}` });
}

// ── 4.2 Removals (ascending id) ──────────────────────────────────────────────

function resolveRemovals(world: World, reservoir: Compartment, t: Config["tunables"]): void {
  // Allee low-density starvation rescue (SPEC.md §World-Health — density-dependent
  // effects). Energetic analysis: light (primary production) vastly exceeds consumption,
  // so the collapse is a *spatial* overshoot (herbivores clump → strip local plants →
  // synchronized mass-starvation), not a global resource shortage. Below the threshold,
  // an otherwise-viable creature (hydrated, healthy, not aged out) whose energy hit zero
  // gets a survival ration drawn from the reservoir (a named compartment — energy
  // conserved, never minted). Combined with a gentle reproduction throttle (which keeps
  // the population near a healthy plateau), this floor lets the rare deep fluctuation
  // recover instead of cascading to extinction. Only starvation, only when already low.
  if (world.creatures.length < t.ALLEE_POP_THRESHOLD) {
    // Rescue tops a starving survivor up ABOVE its mating threshold, not just to bare
    // survival — otherwise the population clings to the floor unable to breed and a
    // later fluctuation finishes it (observed). Reaching the mating threshold lets the
    // sparse survivors reproduce and actively climb back out of the dip.
    for (let i = 0; i < world.creatures.length; i++) {
      const c = world.creatures[i] as Creature;
      if (
        c.energy <= 0 &&
        c.hydration > 0 &&
        c.health > 0 &&
        c.age < expressTrait(c.genome.maxLifespan)
      ) {
        const target = toQuantum(expressTrait(c.genome.matingThreshold) + t.MAX_ENERGY_BASE);
        transferUpTo(reservoir, fieldCompartment(c, "energy"), target);
      }
    }
  }

  const survivors: Creature[] = [];
  const dying: Creature[] = [];
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i] as Creature;
    const dead =
      c.energy <= 0 ||
      c.hydration <= 0 ||
      c.health <= 0 ||
      c.age >= expressTrait(c.genome.maxLifespan);
    if (dead) dying.push(c);
    else survivors.push(c);
  }
  dying.sort((a, b) => a.id - b.id);
  for (let i = 0; i < dying.length; i++) {
    const c = dying[i] as Creature;
    // Energy → corpse; hydration → local water cell (in full, at death).
    const corpse: Corpse = { id: world.nextId++, x: c.x, y: c.y, energy: 0 };
    if (c.energy > 0)
      transfer(fieldCompartment(c, "energy"), fieldCompartment(corpse, "energy"), c.energy);
    if (c.hydration > 0) {
      const cell = cellIndexOf(world.config, c.x, c.y);
      transfer(
        fieldCompartment(c, "hydration"),
        cellCompartment(world.fields.water, cell),
        c.hydration,
      );
    }
    world.corpses.push(corpse);
  }
  world.creatures = survivors;
  world.creatureIds = survivors.map((c) => c.id);

  // Plant deaths (fully grazed or maxAge) → residual energy to fertility.
  const plantSurvivors: Plant[] = [];
  const plantDying: Plant[] = [];
  for (let i = 0; i < world.plants.length; i++) {
    const p = world.plants[i] as Plant;
    if (p.energy <= 0 || p.age >= expressTrait(p.genome.maxAge)) plantDying.push(p);
    else plantSurvivors.push(p);
  }
  plantDying.sort((a, b) => a.id - b.id);
  for (let i = 0; i < plantDying.length; i++) {
    const p = plantDying[i] as Plant;
    if (p.energy > 0) {
      const cell = cellIndexOf(world.config, p.x, p.y);
      transfer(
        fieldCompartment(p, "energy"),
        cellCompartment(world.fields.fertility, cell),
        p.energy,
      );
    }
  }
  world.plants = plantSurvivors;
}

// ── 4.3 Plant updates (ascending id) ─────────────────────────────────────────

function resolvePlants(world: World, _reservoir: Compartment): void {
  const t = world.config.tunables;
  const ordered = world.plants.slice().sort((a, b) => a.id - b.id);
  const newSeeds: Plant[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i] as Plant;
    p.age++;
    const cell = cellIndexOf(world.config, p.x, p.y);
    const light = world.fields.light[cell] as number;
    const fertility = world.fields.fertility[cell] as number;
    if (light > t.LIGHT_THRESHOLD && fertility > t.FERTILITY_THRESHOLD) {
      const maxSize = expressTrait(p.genome.maxSize);
      const headroom = Math.max(0, toQuantum(maxSize) - p.energy);
      // `PLANT_GROWTH_MAX` is a real-valued rate cap (a swept tunable), so quantize it
      // before it reaches the integer ledger — `transferUpTo` requires integer quanta.
      // Terrain modulates the growth RATE by biome (grassland lush, barren sparse,
      // rock/water barren): scale then re-quantize so the ledger stays integer. `headroom`
      // is already integer, so `grow` is the min of two integers — nothing is minted.
      const biomeGrowth = growthMultiplier(world.terrain.biome[cell] as number);
      const grow = Math.min(toQuantum(t.PLANT_GROWTH_MAX * biomeGrowth), headroom);
      if (grow > 0) {
        // Draw from light then fertility (headroom-limited); gain exactly equals draw.
        const fromLight = transferUpTo(
          cellCompartment(world.fields.light, cell),
          fieldCompartment(p, "energy"),
          grow,
        );
        const remaining = grow - fromLight;
        if (remaining > 0) {
          transferUpTo(
            cellCompartment(world.fields.fertility, cell),
            fieldCompartment(p, "energy"),
            remaining,
          );
        }
      }
    }
    // Seeding: if above reproductive size, spend energy to spawn one seed. Halt when
    // the plant population is already saturated (a soft carrying-capacity cap that
    // keeps the sim tractable and bounds monoculture; Phase-0 provisional).
    const plantCap = world.config.gridCols * world.config.gridRows * t.PLANT_CAP_PER_CELL;
    const saturated = ordered.length + newSeeds.length >= plantCap;
    const seedCost = toQuantum(expressTrait(p.genome.seedInvestment));
    if (!saturated && p.energy > seedCost * 2 && seedCost > 0) {
      const seedGenome = plantSeed(p.genome, world.rng.mutation, t);
      const disp = expressTrait(p.genome.dispersal);
      const sx = clamp(p.x + (world.rng.spawn.next() * 2 - 1) * disp, 0, world.config.worldWidth);
      const sy = clamp(p.y + (world.rng.spawn.next() * 2 - 1) * disp, 0, world.config.worldHeight);
      const seed: Plant = {
        id: world.nextId++,
        parentId: p.id,
        x: sx,
        y: sy,
        energy: 0,
        age: 0,
        genome: seedGenome,
      };
      transfer(fieldCompartment(p, "energy"), fieldCompartment(seed, "energy"), seedCost);
      newSeeds.push(seed);
    }
  }
  for (let i = 0; i < newSeeds.length; i++) world.plants.push(newSeeds[i] as Plant);
}

// ── 4.4 Field updates (fixed order) ──────────────────────────────────────────

function resolveFields(world: World, reservoir: Compartment): void {
  const t = world.config.tunables;
  const cells = world.config.gridCols * world.config.gridRows;

  // corpse decay → local fertility.
  const corpseSurvivors: Corpse[] = [];
  const orderedCorpses = world.corpses.slice().sort((a, b) => a.id - b.id);
  for (let i = 0; i < orderedCorpses.length; i++) {
    const corpse = orderedCorpses[i] as Corpse;
    if (corpse.energy > 0) {
      const decayed = Math.min(
        corpse.energy,
        Math.max(1, Math.floor(corpse.energy * t.CORPSE_DECAY_FRACTION)),
      );
      const cell = cellIndexOf(world.config, corpse.x, corpse.y);
      transfer(
        fieldCompartment(corpse, "energy"),
        cellCompartment(world.fields.fertility, cell),
        decayed,
      );
    }
    if (corpse.energy > 0) corpseSurvivors.push(corpse);
  }
  world.corpses = corpseSurvivors;

  // hydration decay: each creature loses a fraction back to its local water cell.
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i] as Creature;
    const loss = Math.min(c.hydration, Math.floor(c.hydration * t.HYDRATION_DECAY));
    if (loss > 0) {
      const cell = cellIndexOf(world.config, c.x, c.y);
      transfer(fieldCompartment(c, "hydration"), cellCompartment(world.fields.water, cell), loss);
    }
  }

  // Seasonal + day/night temperature (Phase 5C.1). A DETERMINISTIC pure function of
  // `world.tick` — a triangle-wave season (NOT `Math.sin`, which isn't bit-identical
  // cross-engine) plus a night drop. Temperature is a non-conserved modulator field, so
  // writing it never touches the ledger; it feeds sensor 13 and the cold surcharge.
  const temp = temperatureAt(world.tick, t);
  for (let i = 0; i < cells; i++) world.fields.temperature[i] = temp;

  // scent field decay (non-conserved modulator).
  for (let i = 0; i < cells; i++) {
    world.fields.scent[i] = (world.fields.scent[i] as number) * 0.9;
  }

  // solar → light influx (daytime only), distributed uniformly over cells.
  const dayPhase = (world.tick % t.TICKS_PER_DAY) / t.TICKS_PER_DAY;
  const isDay = dayPhase < 0.5;
  if (isDay) {
    const budget = Math.min(world.solarReservoir, cells * 4);
    const perCell = Math.floor(budget / cells);
    if (perCell > 0) {
      for (let i = 0; i < cells; i++) {
        transfer(reservoir, cellCompartment(world.fields.light, i), perCell);
      }
    }
  }

  // unabsorbed-light decay back to reservoir.
  for (let i = 0; i < cells; i++) {
    const cell = world.fields.light[i] as number;
    if (cell > 0) {
      const decayed = Math.min(cell, Math.max(1, Math.floor(cell * t.LIGHT_DECAY)));
      transfer(cellCompartment(world.fields.light, i), reservoir, decayed);
    }
  }

  // age creatures.
  for (let i = 0; i < world.creatures.length; i++) (world.creatures[i] as Creature).age++;
}

// ── math helpers ─────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clampSigned(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Deterministic seasonal + day/night temperature at a tick (Phase 5C.1). A TRIANGLE-WAVE
 * season over `DAYS_PER_SEASON` days (piecewise-linear → cross-engine bit-identical,
 * unlike `Math.sin`) in `[−amplitude, +amplitude]` around the baseline, minus a night
 * drop during the dark half of the day. Pure function of `tick` + tunables — no RNG, no
 * wall-clock. `realTime` never enters this (SPEC.md §Determinism).
 */
export function temperatureAt(tick: number, t: Config["tunables"]): number {
  const seasonTicks = t.TICKS_PER_DAY * t.DAYS_PER_SEASON;
  // Triangle wave in [0,1) → [-1,1]: rises 0→1 over the first half, falls 1→0 over the
  // second, mapped so the peak is mid-season (summer) and the trough is season edges.
  const phase = seasonTicks > 0 ? (tick % seasonTicks) / seasonTicks : 0;
  const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2; // 0→1→0
  const season = (tri * 2 - 1) * t.TEMP_SEASON_AMPLITUDE; // [-amp, +amp]
  const dayPhase = (tick % t.TICKS_PER_DAY) / t.TICKS_PER_DAY;
  const isNight = dayPhase >= 0.5;
  return t.TEMP_BASELINE + season - (isNight ? t.TEMP_NIGHT_DROP : 0);
}
function clampUnit(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
/**
 * Logistic sigmoid via the **pinned** `tanhApprox` (identity `σ(x) = ½(tanh(x/2)+1)`),
 * NOT `Math.exp`. This is a state-affecting draw (the contest escape check), so it
 * must use the same engine-independent approximation the brain uses — `Math.exp` is
 * not bit-identical across engines and would break the cross-engine determinism the
 * activation pinning exists to preserve (SPEC.md §Determinism point 3).
 */
function sigmoid(x: number): number {
  return 0.5 * (tanhApprox(x / 2) + 1);
}
