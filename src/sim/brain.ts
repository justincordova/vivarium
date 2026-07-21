/**
 * brain.ts — the `BrainOps` swap contract, the pinned activation, and the Phase 0
 * rule-based policy.
 *
 * `tick.ts` drives behavior through the rule policy in Phase 0; Phase 4 swaps in a
 * `PatchbayBrain` implementing the SAME `BrainOps` interface, touching only `think`
 * (SPEC.md §"Why not NEAT"). The diploid brain arrays are inherited/mutated/
 * distance-measured/serialized by `genetics.ts`/`serialize.ts` from commit one even
 * though the rule policy ignores them — which is what makes the swap cheap.
 *
 * Determinism: the policy is a fully-specified deterministic formula (no
 * `Math.random`); every stochastic genome op takes an explicit named RNG sub-stream.
 * Part of `sim/`.
 */

import * as C from "./constants";
import { crossover, deriveExpressed } from "./genetics";
import type { DerivedBrain, Genome, RNG, RuleState } from "./types";

// ── Pinned activation ────────────────────────────────────────────────────────

/**
 * The pinned rational approximation of `tanh` (SPEC.md §"Activation function
 * (pinned)"). FROZEN — reads the `TANH_APPROX_*` constants. Used by the future
 * `PatchbayBrain` forward pass; harmless for the rule policy but defined here so the
 * whole brain layer shares one activation.
 *
 *   tanh(x) ≈ x·(27 + x²) / (27 + 9·x²), saturating to ±1 beyond ±CLAMP.
 */
export function tanhApprox(x: number): number {
  if (x > C.TANH_APPROX_CLAMP) return 1;
  if (x < -C.TANH_APPROX_CLAMP) return -1;
  const x2 = x * x;
  return (x * (C.TANH_APPROX_NUM_C + x2)) / (C.TANH_APPROX_DEN_C0 + C.TANH_APPROX_DEN_C2 * x2);
}

// ── The swap contract ────────────────────────────────────────────────────────

/**
 * The brain interface (SPEC.md §"Why not NEAT"). The single `rng` passed is always
 * the specific named sub-stream the caller selects: `create ← spawn`,
 * `mutate ← mutation`, `crossover ← mating`. `distance` is pure (no RNG).
 */
export interface BrainOps<B> {
  create(rng: RNG): B;
  think(brain: B, senses: Float32Array, memory: Float32Array): Float32Array;
  mutate(brain: B, rng: RNG): void;
  crossover(mom: B, dad: B, rng: RNG): B;
  distance(a: B, b: B): number;
  serialize(brain: B): ArrayBuffer;
}

/** Derive the forward-pass operand from a genome's homologs (delegates to genetics). */
export function derive(genome: Genome): { weights: Float32Array; enabled: Uint8Array } {
  return deriveExpressed(genome.weightsA, genome.weightsB, genome.enabledA, genome.enabledB);
}

// ── The patchbay forward pass (Phase 4) ──────────────────────────────────────

/**
 * The fixed arrow layout in the shared address space (SPEC.md §Brain Design — the
 * patchbay). Arrow #k is the same arrow in every creature that ever lives; this
 * pinned partition and the index conventions below are **load-bearing for
 * determinism and cross-engine reachability** — reordering them changes the
 * summation order and low FP bits, so they are frozen. The golden-vector test in
 * `brain.test.ts` is the enforcement.
 *
 *   [0                     .. SENSORS*HIDDEN)            sensors → hidden   (210)
 *   [SENSORS*HIDDEN        .. +HIDDEN*HIDDEN)            hidden(prev) → hidden (100)
 *   [SENSORS*HIDDEN+HIDDEN*HIDDEN .. +HIDDEN*ACTIONS)    hidden → actions   (70)
 *
 * Within each group the index is **row-major over (source, target)**:
 *   sensors→hidden:  k = s*HIDDEN + h              (sensor s, hidden h)
 *   hidden→hidden:   k = SH + j*HIDDEN + h         (prev-hidden j, hidden h)
 *   hidden→actions:  k = SH + HH + h*ACTIONS + a   (hidden h, action a)
 */
/**
 * Arrow count for a given hidden-neuron count (SENSORS/ACTIONS are permanently fixed
 * per SPEC.md §Sensors/§Actions; only HIDDEN varies — the enlargement experiment,
 * Task 4.4). For the default `HIDDEN=10`, `SENSORS=21` this is `ARROWS=380`.
 */
export function arrowCount(hidden: number): number {
  return C.SENSORS * hidden + hidden * hidden + hidden * C.ACTIONS;
}

/**
 * One deterministic patchbay forward pass over the derived (expressed) brain.
 * Masked accumulation `sum += input * weights[k] * enabled[k]` in the pinned
 * index order (SPEC.md §Brain Design "Forward pass masks disabled arrows"):
 *
 *   1. For each hidden neuron `h`, pre-activation is
 *      `Σ_s senses[s]·w·en (sensors→hidden) + Σ_j memory[j]·w·en (hidden→hidden)`,
 *      both groups summing into the SAME accumulator for `h`. `memory` is the
 *      creature's `hidden` vector from the *previous* tick, read before this tick's
 *      activation — no within-tick self-reference, fully determinate.
 *   2. `newHidden[h] = tanhApprox(preActivation[h])`.
 *   3. `actions[a] = tanhApprox(Σ_h newHidden[h]·w·en (hidden→actions))`.
 *
 * `hidden` defaults to `C.HIDDEN` (10) so every production caller stays bit-identical
 * (the golden-vector test relies on this). The enlargement experiment (Task 4.4)
 * passes a different `hidden` on FRESH worlds only — changing it reshapes the arrow
 * count and the `hidden` vector length, so a HIDDEN=10 save cannot migrate to
 * HIDDEN=20 (SPEC.md §Brain Design; this is world-creation geometry, not a live knob).
 *
 * Returns `{ actions, hidden: newHidden }`; the caller writes `newHidden` back to
 * `creature.hidden` for next tick. Pure — no RNG (a forward pass is deterministic
 * given brain + senses + memory).
 */
export function patchbayForward(
  weights: Float32Array,
  enabled: Uint8Array,
  senses: Float32Array,
  memory: Float32Array,
  hidden: number = C.HIDDEN,
): { actions: Float32Array; hidden: Float32Array } {
  const H = hidden;
  const sensorsHiddenBase = 0;
  const hiddenHiddenBase = C.SENSORS * H;
  const hiddenActionsBase = C.SENSORS * H + H * H;
  const newHidden = new Float32Array(H);

  // 1–2. Hidden pre-activations: sensors→hidden then hidden→hidden into one accumulator.
  for (let h = 0; h < H; h++) {
    let sum = 0;
    // sensors → hidden (source-major: iterate sensors, fixed target h).
    for (let s = 0; s < C.SENSORS; s++) {
      const k = sensorsHiddenBase + s * H + h;
      sum += (senses[s] as number) * (weights[k] as number) * (enabled[k] as number);
    }
    // hidden(prev) → hidden (source-major: iterate prev-hidden j, fixed target h).
    for (let j = 0; j < H; j++) {
      const k = hiddenHiddenBase + j * H + h;
      sum += (memory[j] as number) * (weights[k] as number) * (enabled[k] as number);
    }
    newHidden[h] = tanhApprox(sum);
  }

  // 3. Actions: hidden → actions (source-major: iterate hidden h, fixed target a).
  const actions = new Float32Array(C.ACTIONS);
  for (let a = 0; a < C.ACTIONS; a++) {
    let sum = 0;
    for (let h = 0; h < H; h++) {
      const k = hiddenActionsBase + h * C.ACTIONS + a;
      sum += (newHidden[h] as number) * (weights[k] as number) * (enabled[k] as number);
    }
    actions[a] = tanhApprox(sum);
  }

  return { actions, hidden: newHidden };
}

/**
 * `PatchbayBrain` — the Phase 4 `BrainOps<Genome>`. Implements the real forward pass
 * (SPEC.md §"Make the swap cheap": same interface, so the tick loop calls
 * `think` unchanged). `mutate`/`distance` still throw here for the same reason as
 * `RuleBasedBrain` — the live path calls `genetics.ts` with `world.config.tunables`
 * directly (the bare `BrainOps` signatures don't carry tunables); `crossover` takes
 * no tunables so it delegates. `create` is provided by `world.ts` founder
 * construction. These are kept explicit rather than fake-delegating so the
 * config-indirection rule is not quietly violated.
 *
 * `think` derives the expressed brain fresh from the homologs each call. The tick
 * loop's per-creature `derived` cache (Task 0.6.1) is the performance path used in
 * production; this method stays cache-free so it is correct in isolation (the
 * golden-vector and recurrence tests call it directly).
 */
export const PatchbayBrain: BrainOps<Genome> = {
  create(_rng: RNG): Genome {
    throw new Error("PatchbayBrain.create is provided by world.ts founder construction");
  },
  think(brain: Genome, senses: Float32Array, memory: Float32Array): Float32Array {
    const { weights, enabled } = derive(brain);
    return patchbayForward(weights, enabled, senses, memory).actions;
  },
  mutate(_brain: Genome, _rng: RNG): void {
    throw new Error("PatchbayBrain.mutate: call genetics.mutate with tunables directly");
  },
  crossover(mom: Genome, dad: Genome, rng: RNG): Genome {
    return crossover(mom, dad, rng);
  },
  distance(_a: Genome, _b: Genome): number {
    throw new Error("PatchbayBrain.distance: call genetics.distance with tunables directly");
  },
  serialize(_brain: Genome): ArrayBuffer {
    // The genome (incl. brain arrays) is serialized by serialize.ts; the recurrent
    // `hidden` vector is serialized per-creature. The derived cache is NOT serialized
    // (re-derived on load), so this per-brain hook stays empty.
    return new ArrayBuffer(0);
  },
};

/**
 * Run the forward pass from a creature's *cached* derived brain (the tick-loop
 * performance path). Identical math to `patchbayForward`; takes the pre-derived
 * `DerivedBrain` so the tick loop can reuse the Phase 0.6 cache instead of
 * re-deriving every tick.
 */
export function patchbayThinkCached(
  derived: DerivedBrain,
  senses: Float32Array,
  memory: Float32Array,
  hidden: number = C.HIDDEN,
): { actions: Float32Array; hidden: Float32Array } {
  return patchbayForward(derived.weights, derived.enabled, senses, memory, hidden);
}

/**
 * `RuleBasedBrain` — Phase 0's `BrainOps<Genome>`, present to fix the swap-contract
 * *shape*. In Phase 0 the tick loop calls `genetics.ts` (`mutate`/`crossover`/
 * `distance`) and `ruleThink` **directly** — none of these methods are on the live
 * path yet. They are Phase-4 wiring points: `create` is done by `world.ts` founder
 * construction, and `mutate`/`distance` need `world.config.tunables` (which the
 * bare `BrainOps` signatures don't carry), so they are wired when `PatchbayBrain`
 * lands. Kept explicit rather than fake-delegating so the config-indirection rule is
 * not quietly violated. `crossover` takes no tunables, so it can delegate today.
 */
export const RuleBasedBrain: BrainOps<Genome> = {
  create(_rng: RNG): Genome {
    throw new Error("RuleBasedBrain.create is provided by world.ts founder construction");
  },
  think(_brain: Genome, _senses: Float32Array, _memory: Float32Array): Float32Array {
    // Rule policy ignores brain arrays; returns a neutral output vector. Actual
    // Phase 0 behavior is computed by ruleThink from world context.
    return new Float32Array(C.ACTIONS);
  },
  mutate(_brain: Genome, _rng: RNG): void {
    // Phase-4 hook: the live Phase-0 path calls genetics.mutate(child, rng, tunables)
    // directly from tick.ts so the mutation rates come from world.config.tunables.
    throw new Error("RuleBasedBrain.mutate: call genetics.mutate with tunables directly");
  },
  crossover(mom: Genome, dad: Genome, rng: RNG): Genome {
    return crossover(mom, dad, rng);
  },
  distance(_a: Genome, _b: Genome): number {
    // Phase-4 hook: the live path calls genetics.distance(a, b, tunables) directly so
    // the distance coefficients come from world.config.tunables.
    throw new Error("RuleBasedBrain.distance: call genetics.distance with tunables directly");
  },
  serialize(_brain: Genome): ArrayBuffer {
    // The genome (incl. brain arrays) is serialized by serialize.ts (Task 0.9);
    // BrainOps.serialize is the Phase 4 per-brain hook, unused by the rule policy.
    return new ArrayBuffer(0);
  },
};

// ── The rule policy (what tick.ts drives) ────────────────────────────────────

/** A perceived nearby entity, resolved to the identity/geometry the policy needs. */
export interface Percept {
  id: number;
  /** Signed relative angle in the pinned `[−1,1]` convention (0 ahead, + = CCW/left). */
  angle: number;
  /** Distance normalized to `[0,1]` of senseRadius (0 adjacent, 1 at/beyond limit). */
  distance: number;
  /** Whether this percept is a living agent (huntable) vs. a plant/corpse. */
  isAgent: boolean;
}

/**
 * Everything the rule policy reads. The tick loop assembles this from the
 * double-buffered prior snapshot (SPEC.md §Tick Loop — no first-mover advantage).
 * Fractions (energy/hydration) are already normalized to `[0,1]`.
 */
export interface RuleContext {
  selfId: number;
  energyFrac: number;
  hydrationFrac: number;
  localWater: number; // sensor 14, [0,1]
  nearestFood: Percept | null;
  nearestThreat: Percept | null;
  nearestMate: Percept | null;
  /** The mate's reciprocal committed target id (for rendezvous), or null if unknown. */
  mateReciprocalTargetId: number | null;
  /** Whether the nearest mate is within interaction reach (tick loop knows real units). */
  mateInReach: boolean;
  ruleState: RuleState;
}

/** The intents the policy emits; resolve validates gated intents against real genes. */
export interface Intents {
  turn: number; // [−1,1], pinned angle convention
  accelerate: number; // [0,1]
  eat: boolean;
  drink: boolean;
  attack: boolean;
  mate: boolean;
  emit: boolean;
  nest: boolean; // Society, Phase 7A — build/claim a home (patchbay-era; rule brain never nests)
}

/** Add π (i.e. +1 in the `angle/π` encoding) and re-wrap to `[−1,1]` — "steer away". */
function steerAway(angle: number): number {
  let a = angle + 1;
  if (a > 1) a -= 2;
  return a;
}

/**
 * The fully-specified deterministic rule policy. Reads `ctx`, mutates `ctx.ruleState`
 * for target hysteresis + mutual mate rendezvous, and returns steering + gated
 * intents. Priority (fixed, SPEC-derived):
 *   1. threat within sense AND energy ≥ CRITICAL_FRAC → flee
 *   2. hungry (energy < HUNGRY_FRAC) AND food perceived → seek food
 *   3. energy > MATE_THRESHOLD AND compatible mate perceived → seek mate (rendezvous)
 *   4. else wander (hold heading)
 * Gated intents (eat/drink/attack/mate/emit) are set optimistically; resolve fires
 * them only when the real reach formula / target genes permit.
 */
export function ruleThink(ctx: RuleContext): Intents {
  const rs = ctx.ruleState;
  const intents: Intents = {
    turn: 0,
    accelerate: 0,
    eat: false,
    drink: false,
    attack: false,
    mate: false,
    emit: false,
    nest: false,
  };

  // Hysteresis: tick down the commitment counter.
  if (rs.committedTicks > 0) rs.committedTicks--;

  const threat = ctx.nearestThreat;
  const food = ctx.nearestFood;
  const mate = ctx.nearestMate;
  const threatPerceived = threat !== null && threat.distance < 1;
  const foodPerceived = food !== null && food.distance < 1;
  const matePerceived = mate !== null && mate.distance < 1;

  // Drink is independent of locomotion mode (fires when thirsty + water present).
  if (ctx.hydrationFrac < C.THIRSTY_FRAC && ctx.localWater > 0) intents.drink = true;

  // Emit a low-constant scent when a threat is near (exercises scent field/sensors).
  if (threatPerceived) intents.emit = true;

  // ── Priority 1: flee ──
  if (threatPerceived && ctx.energyFrac >= C.CRITICAL_FRAC && threat !== null) {
    rs.mode = "flee";
    rs.targetId = threat.id;
    rs.targetKind = "threat";
    intents.turn = steerAway(threat.angle);
    intents.accelerate = 1;
    // Attack only if the committed threat is also the thing we could beat — resolve
    // decides the stronger-party math; here we flag intent when fleeing is not
    // chosen. (Flee suppresses attack.)
    return intents;
  }

  // ── Priority 2: seek food ──
  if (ctx.energyFrac < C.HUNGRY_FRAC && foodPerceived && food !== null) {
    rs.mode = "seek";
    rs.targetId = food.id;
    rs.targetKind = food.isAgent ? "threat" : "food";
    intents.turn = food.angle; // steer toward, as-is (already pinned convention)
    intents.accelerate = 1;
    intents.eat = true; // resolve fires only if in reach + diet permits
    // Hunting a living agent: also flag attack so the contest path runs; resolve
    // applies it only if this creature is the stronger party (real gene contest).
    if (food.isAgent) intents.attack = true;
    return intents;
  }

  // ── Priority 3: seek mate (with mutual rendezvous) ──
  if (ctx.energyFrac > C.MATE_THRESHOLD && matePerceived && mate !== null) {
    rs.targetId = mate.id;
    rs.targetKind = "mate";
    const reciprocated = ctx.mateReciprocalTargetId === ctx.selfId;
    if (reciprocated) {
      rs.mode = "rendezvous";
      intents.turn = mate.angle; // face the partner
      // Arrived: both hold so they settle in reach (no overshoot) and mate fires from
      // a stable position regardless of resolve order. `mateInReach` (real units from
      // the tick loop) is authoritative; the small normalized-distance check is a
      // fallback for callers that don't populate it.
      const arrived = ctx.mateInReach || mate.distance < C.RENDEZVOUS_ARRIVE_FRAC;
      if (arrived) {
        intents.accelerate = 0;
      } else if (ctx.selfId < mate.id) {
        // Deterministic asymmetry: lower-id holds still, higher-id approaches.
        intents.accelerate = 0;
      } else {
        intents.accelerate = 1;
      }
    } else {
      rs.mode = "seek";
      intents.turn = mate.angle;
      intents.accelerate = 1;
    }
    intents.mate = true; // resolve fires only if in reach + both thresholds pass
    return intents;
  }

  // ── Priority 4: wander ──
  // A HUNGRY creature that perceives no food must EXPLORE to find some, not freeze.
  // At low density (a dispersed population) abundant global food can lie outside sense
  // range; a creature that stops here starves next to full plants it never reaches —
  // the diagnosed low-density trough-collapse. So a hungry wanderer roams forward
  // (holding heading) to cover ground; a sated one idles to conserve energy. Roaming
  // uses HALF acceleration: enough to find food, but half the movement cost and less
  // per-tick displacement (keeps the wander case cheap — most ticks most creatures are
  // sated and still idle).
  rs.mode = "wander";
  rs.targetId = -1;
  rs.targetKind = "none";
  intents.turn = 0;
  intents.accelerate = ctx.energyFrac < C.HUNGRY_FRAC ? 0.5 : 0;
  return intents;
}
