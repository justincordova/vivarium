import { type Percept, RuleBasedBrain, type RuleContext, ruleThink, tanhApprox } from "@sim/brain";
import * as C from "@sim/constants";
import type { RuleState } from "@sim/types";
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
