import {
  PatchbayBrain,
  type Percept,
  patchbayForward,
  RuleBasedBrain,
  type RuleContext,
  ruleThink,
  tanhApprox,
} from "@sim/brain";
import * as C from "@sim/constants";
import type { Genome, RuleState } from "@sim/types";
import { describe, expect, it } from "vitest";

function freshRuleState(): RuleState {
  return { mode: "wander", targetId: -1, targetKind: "none", committedTicks: 0 };
}

function baseCtx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    selfId: 1,
    energyFrac: 0.8,
    hydrationFrac: 0.8,
    localWater: 0,
    nearestFood: null,
    nearestThreat: null,
    nearestMate: null,
    mateReciprocalTargetId: null,
    mateInReach: false,
    ruleState: freshRuleState(),
    ...over,
  };
}

const percept = (id: number, angle: number, distance: number, isAgent = false): Percept => ({
  id,
  angle,
  distance,
  isAgent,
});

describe("tanhApprox (pinned activation)", () => {
  it("is odd, passes through 0, and saturates", () => {
    expect(tanhApprox(0)).toBe(0);
    expect(tanhApprox(5)).toBe(1);
    expect(tanhApprox(-5)).toBe(-1);
    expect(tanhApprox(-1)).toBeCloseTo(-tanhApprox(1), 12);
  });
  it("approximates tanh in the mid-range", () => {
    for (const x of [-2, -1, -0.5, 0.5, 1, 2]) {
      expect(tanhApprox(x)).toBeCloseTo(Math.tanh(x), 1);
    }
  });
  it("stays within [-1,1]", () => {
    for (let x = -10; x <= 10; x += 0.13) {
      const y = tanhApprox(x);
      expect(y).toBeGreaterThanOrEqual(-1);
      expect(y).toBeLessThanOrEqual(1);
    }
  });
});

describe("ruleThink — determinism", () => {
  it("identical context → identical intents", () => {
    const mk = () =>
      baseCtx({
        energyFrac: 0.3,
        nearestFood: percept(9, 0.5, 0.4),
      });
    const a = ruleThink(mk());
    const b = ruleThink(mk());
    expect(a).toEqual(b);
  });

  it("never calls Math.random (no invocation in source)", async () => {
    // Structural guard: the brain module must not *call* Math.random. Match the
    // invocation `Math.random(` so prose/comments mentioning the name don't trip it.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/sim/brain.ts", import.meta.url), "utf8"),
    );
    expect(/Math\.random\s*\(/.test(src)).toBe(false);
  });
});

describe("ruleThink — priority + all 7 actions covered", () => {
  it("flees a threat when not critical (turn steers away, accelerate=1, emit)", () => {
    const i = ruleThink(baseCtx({ energyFrac: 0.9, nearestThreat: percept(5, 0.0, 0.3) }));
    // Threat dead ahead (angle 0) → steer away = +1 (or −1 after wrap). |turn| == 1.
    expect(Math.abs(i.turn)).toBeCloseTo(1, 12);
    expect(i.accelerate).toBe(1);
    expect(i.emit).toBe(true); // emit scent fires near a threat
  });

  it("suppresses flee when energy is critical (feeds instead)", () => {
    const i = ruleThink(
      baseCtx({
        energyFrac: C.CRITICAL_FRAC - 0.01,
        nearestThreat: percept(5, 0, 0.3),
        nearestFood: percept(8, 0.2, 0.5),
      }),
    );
    // Not fleeing → seek food path sets eat.
    expect(i.eat).toBe(true);
  });

  it("seeks food when hungry (turn toward, eat intent)", () => {
    const i = ruleThink(
      baseCtx({ energyFrac: C.HUNGRY_FRAC - 0.1, nearestFood: percept(8, 0.5, 0.4) }),
    );
    expect(i.turn).toBeCloseTo(0.5, 12);
    expect(i.eat).toBe(true);
    expect(i.accelerate).toBe(1);
  });

  it("attacks when the food target is a living agent (contest path)", () => {
    const i = ruleThink(
      baseCtx({ energyFrac: C.HUNGRY_FRAC - 0.1, nearestFood: percept(8, 0.1, 0.3, true) }),
    );
    expect(i.eat).toBe(true);
    expect(i.attack).toBe(true); // exercised so the contest/corpse path has coverage
  });

  it("drinks when thirsty and water is present", () => {
    const i = ruleThink(baseCtx({ hydrationFrac: C.THIRSTY_FRAC - 0.1, localWater: 0.5 }));
    expect(i.drink).toBe(true);
  });

  it("seeks a mate and sets mate intent when well-fed", () => {
    const i = ruleThink(
      baseCtx({ energyFrac: C.MATE_THRESHOLD + 0.2, nearestMate: percept(20, 0.3, 0.5) }),
    );
    expect(i.mate).toBe(true);
    expect(i.accelerate).toBe(1);
  });

  it("wanders (holds heading) when nothing pressing", () => {
    const ctx = baseCtx();
    const i = ruleThink(ctx);
    expect(i.turn).toBe(0);
    expect(i.accelerate).toBe(0);
    expect(ctx.ruleState.mode).toBe("wander");
    expect(ctx.ruleState.targetId).toBe(-1);
  });
});

describe("ruleThink — mutual mate rendezvous asymmetry", () => {
  it("lower-id holds still, higher-id approaches, when reciprocated", () => {
    // Self is the LOWER id (1) with a reciprocating mate (2): self holds.
    const lowCtx = baseCtx({
      selfId: 1,
      energyFrac: C.MATE_THRESHOLD + 0.3,
      nearestMate: percept(2, 0.4, 0.6),
      mateReciprocalTargetId: 1, // mate committed back to self
    });
    const low = ruleThink(lowCtx);
    expect(lowCtx.ruleState.mode).toBe("rendezvous");
    expect(low.accelerate).toBe(0); // lower-id holds
    expect(low.mate).toBe(true);

    // Self is the HIGHER id (5) with a reciprocating mate (2): self approaches.
    const highCtx = baseCtx({
      selfId: 5,
      energyFrac: C.MATE_THRESHOLD + 0.3,
      nearestMate: percept(2, 0.4, 0.6),
      mateReciprocalTargetId: 5,
    });
    const high = ruleThink(highCtx);
    expect(highCtx.ruleState.mode).toBe("rendezvous");
    expect(high.accelerate).toBe(1); // higher-id approaches
    expect(high.mate).toBe(true);
  });

  it("non-reciprocated mate seeking is plain pursuit (not rendezvous)", () => {
    const ctx = baseCtx({
      selfId: 1,
      energyFrac: C.MATE_THRESHOLD + 0.3,
      nearestMate: percept(2, 0.4, 0.6),
      mateReciprocalTargetId: null,
    });
    const i = ruleThink(ctx);
    expect(ctx.ruleState.mode).toBe("seek");
    expect(i.accelerate).toBe(1);
  });
});

describe("RuleBasedBrain — BrainOps interface", () => {
  it("serialize returns an empty buffer (genome serialized by serialize.ts, cache not stored)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: only serialize() under test here
    const buf = RuleBasedBrain.serialize({} as any);
    expect(buf.byteLength).toBe(0);
  });

  it("think ignores brain arrays and returns a neutral ACTIONS-length vector", () => {
    // biome-ignore lint/suspicious/noExplicitAny: think ignores the genome in Phase 0
    const stubGenome = {} as any;
    const out = RuleBasedBrain.think(
      stubGenome,
      new Float32Array(C.SENSORS),
      new Float32Array(C.HIDDEN),
    );
    expect(out).toHaveLength(C.ACTIONS);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });
});

// ── PatchbayBrain — the Phase 4 forward pass ─────────────────────────────────

/**
 * Build an expressed weights/enabled pair from a fixed LCG (independent of the sim's
 * `mulberry32` RNG, so the golden vector never silently tracks a sim-RNG change).
 * Uses `Math.fround` so values match `Float32Array` storage exactly.
 */
function fixedExpressedBrain(seed: number): { weights: Float32Array; enabled: Uint8Array } {
  let st = seed >>> 0;
  const rnd = (): number => {
    st = (1664525 * st + 1013904223) >>> 0;
    return st / 4294967296;
  };
  const weights = new Float32Array(C.ARROWS);
  const enabled = new Uint8Array(C.ARROWS);
  for (let k = 0; k < C.ARROWS; k++) {
    weights[k] = Math.fround((rnd() * 2 - 1) * 0.8);
    enabled[k] = rnd() < 0.5 ? 1 : 0;
  }
  return { weights, enabled };
}

/** A diploid genome whose expressed brain equals `weights`/`enabled` (both homologs identical). */
function genomeFromExpressed(weights: Float32Array, enabled: Uint8Array): Genome {
  return {
    weightsA: weights.slice(),
    weightsB: weights.slice(),
    enabledA: enabled.slice(),
    enabledB: enabled.slice(),
  } as Genome;
}

/** Fixed sense + memory vectors used by the golden test (bias sensor = 1.0). */
function fixedSenses(): Float32Array {
  const senses = new Float32Array(C.SENSORS);
  for (let s = 0; s < C.SENSORS; s++) senses[s] = Math.fround(((s % 3) - 1) * 0.5);
  senses[0] = 1;
  return senses;
}
function fixedMemory(): Float32Array {
  const memory = new Float32Array(C.HIDDEN);
  for (let j = 0; j < C.HIDDEN; j++) memory[j] = Math.fround(j % 2 ? 0.3 : -0.2);
  return memory;
}

/**
 * An INDEPENDENT reference forward pass, written separately from `patchbayForward`,
 * summing in the specified index order. Any accidental reorder of the production
 * accumulation changes low FP bits and diverges from this reference (SPEC.md
 * §Determinism point 4 — the cross-engine door). This is the real enforcement of the
 * fixed-accumulation-order rule.
 */
function referenceForward(
  weights: Float32Array,
  enabled: Uint8Array,
  senses: Float32Array,
  memory: Float32Array,
): { actions: Float32Array; hidden: Float32Array } {
  const SH = C.SENSORS * C.HIDDEN;
  const HH = C.HIDDEN * C.HIDDEN;
  const hidden = new Float32Array(C.HIDDEN);
  for (let h = 0; h < C.HIDDEN; h++) {
    let sum = 0;
    for (let s = 0; s < C.SENSORS; s++) {
      const k = s * C.HIDDEN + h;
      sum += (senses[s] as number) * (weights[k] as number) * (enabled[k] as number);
    }
    for (let j = 0; j < C.HIDDEN; j++) {
      const k = SH + j * C.HIDDEN + h;
      sum += (memory[j] as number) * (weights[k] as number) * (enabled[k] as number);
    }
    hidden[h] = tanhApprox(sum);
  }
  const actions = new Float32Array(C.ACTIONS);
  for (let a = 0; a < C.ACTIONS; a++) {
    let sum = 0;
    for (let h = 0; h < C.HIDDEN; h++) {
      const k = SH + HH + h * C.ACTIONS + a;
      sum += (hidden[h] as number) * (weights[k] as number) * (enabled[k] as number);
    }
    actions[a] = tanhApprox(sum);
  }
  return { actions, hidden };
}

describe("PatchbayBrain.think — forward pass", () => {
  it("is deterministic for fixed senses+memory+weights (bit-identical repeats)", () => {
    const { weights, enabled } = fixedExpressedBrain(42);
    const brain = genomeFromExpressed(weights, enabled);
    const s = fixedSenses();
    const m = fixedMemory();
    const a = PatchbayBrain.think(brain, s, m);
    const b = PatchbayBrain.think(brain, s, m);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a).toHaveLength(C.ACTIONS);
  });

  it("matches an independent reference summing in the pinned index order", () => {
    const { weights, enabled } = fixedExpressedBrain(42);
    const s = fixedSenses();
    const m = fixedMemory();
    const got = patchbayForward(weights, enabled, s, m);
    const ref = referenceForward(weights, enabled, s, m);
    expect(Array.from(got.actions)).toEqual(Array.from(ref.actions));
    expect(Array.from(got.hidden)).toEqual(Array.from(ref.hidden));
  });

  it("pins the forward pass against a hard-coded golden output vector", () => {
    // Golden vector for the 21-sensor geometry (Living World Phase 6B re-baseline). The
    // independent `referenceForward` test above summing in the pinned index order is the
    // real cross-check; this pins the exact low-FP-bit output so any later accidental
    // reorder still fails. Regenerated when SENSORS went 18 → 21 (ARROWS 350 → 380).
    const golden = [
      -0.17741656303405762, -0.22186525166034698, -0.32099679112434387, -0.34097760915756226,
      -0.003967548254877329, -0.6500503420829773, -0.7263026237487793,
    ];
    const { weights, enabled } = fixedExpressedBrain(123456789);
    const brain = genomeFromExpressed(weights, enabled);
    const out = PatchbayBrain.think(brain, fixedSenses(), fixedMemory());
    expect(Array.from(out)).toEqual(golden);
  });

  it("uses the pinned activation, not Math.tanh", () => {
    // A single fully-enabled sensor→hidden→action path with a large weight drives the
    // pre-activation past where the rational approx and Math.tanh visibly differ.
    const weights = new Float32Array(C.ARROWS);
    const enabled = new Uint8Array(C.ARROWS);
    // sensor 0 (bias=1) → hidden 0, weight 2 ; hidden 0 → action 0, weight 5.
    const SH = C.SENSORS * C.HIDDEN;
    const HH = C.HIDDEN * C.HIDDEN;
    const kS0H0 = 0 * C.HIDDEN + 0;
    const kH0A0 = SH + HH + 0 * C.ACTIONS + 0;
    weights[kS0H0] = 2;
    enabled[kS0H0] = 1;
    weights[kH0A0] = 5;
    enabled[kH0A0] = 1;
    const senses = new Float32Array(C.SENSORS);
    senses[0] = 1;
    const out = patchbayForward(weights, enabled, senses, new Float32Array(C.HIDDEN));
    // hidden0 = tanhApprox(2); action0 = tanhApprox(hidden0 * 5).
    const h0 = tanhApprox(2);
    const expected = tanhApprox(h0 * 5);
    expect(out.actions[0]).toBe(Math.fround(expected));
    // And it must NOT equal the Math.tanh path (guards against a silent swap).
    const mathPath = Math.tanh(Math.tanh(2) * 5);
    expect(out.actions[0]).not.toBeCloseTo(mathPath, 6);
  });

  it("recurrence feeds hidden state forward (memory-dependent output differs)", () => {
    const { weights, enabled } = fixedExpressedBrain(7);
    const s = fixedSenses();
    // Tick 1: zero memory. Tick 2: memory = tick-1 hidden. Same senses both ticks.
    const t1 = patchbayForward(weights, enabled, s, new Float32Array(C.HIDDEN));
    const t2 = patchbayForward(weights, enabled, s, t1.hidden);
    // With non-trivial hidden→hidden arrows, feeding memory forward changes the output.
    expect(Array.from(t2.actions)).not.toEqual(Array.from(t1.actions));
  });

  it("disabled arrows contribute zero (masking works)", () => {
    const { weights } = fixedExpressedBrain(99);
    const s = fixedSenses();
    const m = fixedMemory();
    const allOff = new Uint8Array(C.ARROWS); // every arrow disabled
    const out = patchbayForward(weights, allOff, s, m);
    // All-disabled → every pre-activation is 0 → tanhApprox(0) = 0 everywhere.
    expect(Array.from(out.hidden).every((v) => v === 0)).toBe(true);
    expect(Array.from(out.actions).every((v) => v === 0)).toBe(true);
  });

  it("flipping a single disabled arrow to enabled changes the output", () => {
    const { weights, enabled } = fixedExpressedBrain(5);
    const s = fixedSenses();
    const m = fixedMemory();
    const before = patchbayForward(weights, enabled, s, m);
    // Find a disabled arrow with a non-zero weight in the sensors→hidden group and flip it.
    const flipped = enabled.slice();
    let idx = -1;
    for (let k = 0; k < C.SENSORS * C.HIDDEN; k++) {
      if (enabled[k] === 0 && weights[k] !== 0) {
        idx = k;
        break;
      }
    }
    expect(idx).toBeGreaterThanOrEqual(0);
    flipped[idx] = 1;
    const after = patchbayForward(weights, flipped, s, m);
    expect(Array.from(after.actions)).not.toEqual(Array.from(before.actions));
  });
});

describe("PatchbayBrain — BrainOps interface", () => {
  it("crossover delegates to genetics (no tunables needed)", () => {
    const { weights, enabled } = fixedExpressedBrain(1);
    const mom = genomeFromExpressed(weights, enabled);
    const dad = genomeFromExpressed(weights, enabled);
    // Fill trait/hue so crossover's trait segregation has values to read.
    for (const g of [mom, dad]) {
      for (const key of [
        "size",
        "speed",
        "senseRadius",
        "metabolism",
        "aggression",
        "diet",
        "circadian",
        "nightVision",
        "armor",
        "toxicity",
        "offspringInvestment",
        "matingThreshold",
        "maxLifespan",
        "digestionEfficiency",
      ] as const) {
        g[key] = [1, 1];
      }
      g.hue = [0, 0];
    }
    const rng = { state: 1, next: () => 0.25 };
    const child = PatchbayBrain.crossover(mom, dad, rng);
    expect(child.weightsA).toHaveLength(C.ARROWS);
    expect(child.weightsB).toHaveLength(C.ARROWS);
  });

  it("create/mutate/distance throw (live path wires tunables directly)", () => {
    const rng = { state: 1, next: () => 0.5 };
    // biome-ignore lint/suspicious/noExplicitAny: only the throwing methods under test
    const stub = {} as any;
    expect(() => PatchbayBrain.create(rng)).toThrow();
    expect(() => PatchbayBrain.mutate(stub, rng)).toThrow();
    expect(() => PatchbayBrain.distance(stub, stub)).toThrow();
  });
});
