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
import { ruleThink } from "./brain";
import {
  type Compartment,
  cellCompartment,
  fieldCompartment,
  toQuantum,
  transfer,
  transferUpTo,
} from "./energy";
import { crossover, distance, expressTrait, mutate, plantSeed } from "./genetics";
import { localDensity, SpatialHash, type SpatialPoint } from "./spatial";
import type { Config, Corpse, Creature, Plant, World } from "./types";

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
  hash: SpatialHash;
  /** committed mate-target per creature id, from the prior tick (for rendezvous). */
  committedTargetById: Map<number, number>;
}

function snapshot(world: World): Snapshot {
  const pts: SpatialPoint[] = world.creatures.map((c) => ({ id: c.id, x: c.x, y: c.y }));
  const committed = new Map<number, number>();
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i] as Creature;
    committed.set(c.id, c.ruleState.targetId);
  }
  // Cell size ~ mean senseRadius; a per-tick constant is fine for correctness.
  return {
    creatures: world.creatures.slice(),
    hash: new SpatialHash(pts, 8),
    committedTargetById: committed,
  };
}

// ── Sense: build a RuleContext for one creature from the snapshot ────────────

function classifyFood(self: Creature, other: Creature): boolean {
  // Carnivore-leaning creatures perceive weaker living agents as food (huntable).
  return expressTrait(self.genome.diet) > 0.5 && expressTrait(other.genome.diet) >= 0;
}
function isThreat(self: Creature, other: Creature): boolean {
  return attackPower(other) > defenseScale(self);
}
function isMate(self: Creature, other: Creature, t: Config["tunables"]): boolean {
  return (
    distance(self.genome, other.genome) < t.SPECIES_COMPAT_THRESHOLD &&
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
} {
  const t = world.config.tunables;
  const senseRadius = expressTrait(self.genome.senseRadius);

  const nearest = (predicate: (o: Creature) => boolean, allowPlants: boolean): Percept | null => {
    let best: Creature | Plant | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    let bestIsAgent = false;
    // Creatures.
    for (let i = 0; i < snap.creatures.length; i++) {
      const o = snap.creatures[i] as Creature;
      if (o.id === self.id) continue;
      const d = dist(self.x, self.y, o.x, o.y);
      if (d > senseRadius) continue;
      if (!predicate(o)) continue;
      if (d < bestD || (d === bestD && best !== null && o.id < best.id)) {
        best = o;
        bestD = d;
        bestIsAgent = true;
      }
    }
    // Plants (for food only).
    if (allowPlants && expressTrait(self.genome.diet) < 1) {
      for (let i = 0; i < world.plants.length; i++) {
        const p = world.plants[i] as Plant;
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
  const threat = nearest((o) => isThreat(self, o), false);
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
    const mateCreature = snap.creatures.find((o) => o.id === mate.id);
    if (mateCreature !== undefined) {
      const d = dist(self.x, self.y, mateCreature.x, mateCreature.y);
      mateInReach = d <= reach(self, t) * 0.6;
      mateInReachFull = d <= reach(self, t);
    }
  }

  const ctx: RuleContext = {
    selfId: self.id,
    energyFrac: Math.min(1, self.energy / maxEnergy(self, t)),
    hydrationFrac: Math.min(1, self.hydration / maxHydration(self, t)),
    localWater,
    nearestFood: food,
    nearestThreat: threat,
    nearestMate: mate,
    mateReciprocalTargetId: mateReciprocal,
    mateInReach,
    ruleState: self.ruleState,
  };
  return { ctx, food, mate, threat, mateInReachFull };
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
    const { ctx, food, mate, threat, mateInReachFull } = senseContext(c, snap, world);
    const intents = ruleThink(ctx);
    planned.push({
      creature: c,
      intents,
      foodId: food?.id ?? null,
      mateId: mate?.id ?? null,
      threatId: threat?.id ?? null,
      mateInReach: mateInReachFull,
    });
    // Recurrent memory: rule policy returns no hidden delta; keep a zero vector so
    // the plumbing matches the Phase 4 swap.
    // (c.hidden stays as-is; rule policy ignores it.)
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
    applyCreature(world, c, plan, byId, reservoir, t);
  }

  // 4.2 Removals in ascending-id order.
  resolveRemovals(world);

  // 4.3 Plant updates in ascending plant-id order.
  resolvePlants(world, reservoir);

  // 4.4 Field updates, fixed order.
  resolveFields(world, reservoir);

  world.tick++;
}

// ── 4.1 helpers ──────────────────────────────────────────────────────────────

function applyCreature(
  world: World,
  c: Creature,
  plan: PlannedAction,
  byId: Map<number, Creature>,
  reservoir: Compartment,
  t: Config["tunables"],
): void {
  const cEnergy = fieldCompartment(c, "energy");
  const size = expressTrait(c.genome.size);
  const metabolism = expressTrait(c.genome.metabolism);

  // Baseline metabolic cost → reservoir (heat). Scaled by size & metabolism.
  const baseline = toQuantum(1 + size * metabolism);
  transferUpTo(cEnergy, reservoir, baseline);

  // Density surcharge (crowding) → reservoir.
  const density = localDensity(
    new SpatialHash(
      world.creatures.map((x) => ({ id: x.id, x: x.x, y: x.y })),
      t.DENSITY_RADIUS,
    ),
    c.x,
    c.y,
    t.DENSITY_RADIUS,
  );
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
  c.x = clamp(c.x + c.vx, 0, world.config.worldWidth);
  c.y = clamp(c.y + c.vy, 0, world.config.worldHeight);
  if (appliedAccel !== 0) {
    transferUpTo(cEnergy, reservoir, toQuantum(speed * speed * 0.1 + 1));
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
    tryMate(world, c, plan.mateId, byId, t);
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
): void {
  const b = byId.get(mateId);
  if (b === undefined || b.id === a.id) return;
  // Reach was validated against the snapshot (plan.mateInReach) so mating is
  // order-independent; no live-distance recheck here (it would reintroduce the
  // mid-tick overshoot/first-mover sensitivity).
  // Both must be above their mating threshold.
  if (a.energy <= expressTrait(a.genome.matingThreshold)) return;
  if (b.energy <= expressTrait(b.genome.matingThreshold)) return;
  // Deterministic single-birth: only the LOWER-id parent initiates, so the pair
  // produces one child regardless of processing order.
  if (a.id > b.id) return;

  const invA = toQuantum(expressTrait(a.genome.offspringInvestment));
  const invB = toQuantum(expressTrait(b.genome.offspringInvestment));
  if (invA > a.energy || invB > b.energy) return; // can't afford

  const childGenome = crossover(a.genome, b.genome, world.rng.mating);
  mutate(childGenome, world.rng.mutation);

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
  world.eventLog.push({ tick: world.tick, event: `birth:${child.id}` });
}

// ── 4.2 Removals (ascending id) ──────────────────────────────────────────────

function resolveRemovals(world: World): void {
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
      const grow = Math.min(t.PLANT_GROWTH_MAX, headroom);
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
    // Seeding: if above reproductive size, spend energy to spawn one seed.
    const seedCost = toQuantum(expressTrait(p.genome.seedInvestment));
    if (p.energy > seedCost * 2 && seedCost > 0) {
      const seedGenome = plantSeed(p.genome, world.rng.mutation);
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
function clampUnit(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
