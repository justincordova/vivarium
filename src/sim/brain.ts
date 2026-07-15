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
import { crossover, deriveExpressed, distance as genomeDistance, mutate } from "./genetics";
import type { Genome, RNG, RuleState } from "./types";

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

/**
 * `RuleBasedBrain` — Phase 0's `BrainOps<Genome>`. Genome ops delegate to
 * `genetics.ts` (the brain arrays are real and evolve); only `think` is a
 * placeholder that ignores the arrays. The tick loop uses `ruleThink` (below) for
 * actual behavior; this `think` exists to satisfy the interface and to keep the
 * Phase 4 shape (a pure senses→outputs function).
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
  mutate(brain: Genome, rng: RNG): void {
    mutate(brain, rng);
  },
  crossover(mom: Genome, dad: Genome, rng: RNG): Genome {
    return crossover(mom, dad, rng);
  },
  distance(a: Genome, b: Genome): number {
    return genomeDistance(a, b);
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

  // ── Priority 4: wander (hold heading) ──
  rs.mode = "wander";
  rs.targetId = -1;
  rs.targetKind = "none";
  intents.turn = 0;
  intents.accelerate = 0;
  return intents;
}
