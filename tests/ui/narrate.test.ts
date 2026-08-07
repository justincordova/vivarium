/**
 * narrate.test.ts — the plain-language layer (src/ui/narrate.ts).
 *
 * These are the sentences a newcomer actually reads, so the properties worth pinning are
 * editorial as much as functional: every event kind must produce a sentence, a lineage
 * must never be named by its raw id, and the creature card must never assert a habit or
 * a condition the underlying data doesn't support.
 *
 * Pure module, Node env — no React, no store, no DOM (SPEC.md §Testing).
 */

import { makeConfig } from "@sim/config";
import { TRAIT_GENES, TRAIT_RANGE, type TraitGene } from "@sim/genetics";
import { tick } from "@sim/tick";
import type { Creature } from "@sim/types";
import { createWorld } from "@sim/world";
import { describeBehavior, describeCondition, describeKind, hueName, narrate } from "@ui/narrate";
import type { WorldEvent } from "@worker/protocol";
import { describe, expect, it } from "vitest";

const ALL_KINDS = ["silence", "extinction", "boom", "dominant", "home"] as const;

function event(over: Partial<WorldEvent> = {}): WorldEvent {
  return {
    key: "k",
    tick: 100,
    kind: "home",
    lineage: 7,
    hue: 40,
    factor: 0,
    place: "the northern forest",
    ...over,
  };
}

/** A live creature to mutate, so the card is exercised against real genome shapes. */
function aCreature(): Creature {
  const world = createWorld(1, makeConfig({}));
  return world.creatures[0] as Creature;
}

/** Force a gene to a fraction of its own legal range. */
function setGene(c: Creature, gene: TraitGene, frac: number): void {
  const [lo, hi] = TRAIT_RANGE[gene];
  const v = lo + (hi - lo) * frac;
  (c.genome[gene] as [number, number]) = [v, v];
}

describe("hueName", () => {
  it("names every hue on the wheel", () => {
    for (let h = 0; h < 360; h += 1) {
      expect(hueName(h)).not.toBe("");
    }
  });

  it("wraps out-of-range hues instead of falling through", () => {
    expect(hueName(400)).toBe(hueName(40));
    expect(hueName(-1)).toBe(""); // the sentinel for "no lineage", not a colour
  });
});

describe("narrate", () => {
  it("produces a non-empty sentence for every event kind", () => {
    for (const kind of ALL_KINDS) {
      const line = narrate(event({ kind, factor: 2 }));
      expect(line.length).toBeGreaterThan(0);
      expect(line.endsWith(".")).toBe(true);
    }
  });

  it("never exposes a raw lineage id to the reader", () => {
    for (const kind of ALL_KINDS) {
      expect(narrate(event({ kind, lineage: 4242, factor: 2 }))).not.toContain("4242");
    }
  });

  it("names the lineage by hue so the player can find it on screen", () => {
    expect(narrate(event({ kind: "extinction", hue: 40 }))).toContain("amber");
    expect(narrate(event({ kind: "extinction", hue: 210 }))).toContain("cyan");
  });

  it("states the scale of a boom, not just that one happened", () => {
    expect(narrate(event({ kind: "boom", factor: 2.5 }))).toContain("2.5×");
  });

  it("names the place for a sited home and stays grammatical without one", () => {
    expect(narrate(event({ kind: "home", place: "the northern forest" }))).toContain(
      "in the northern forest",
    );
    const unsited = narrate(event({ kind: "home", place: "" }));
    expect(unsited).toBe("the amber bloodline built a home.");
  });
});

describe("describeKind", () => {
  it("names the diet as the head noun", () => {
    const c = aCreature();
    setGene(c, "diet", 0.9);
    expect(describeKind(c)).toContain("hunter");
    setGene(c, "diet", 0.1);
    expect(describeKind(c)).toContain("grazer");
    setGene(c, "diet", 0.5);
    expect(describeKind(c)).toContain("omnivore");
  });

  it("only reaches for an adjective when the trait is actually pronounced", () => {
    const c = aCreature();
    for (const g of TRAIT_GENES as readonly TraitGene[]) setGene(c, g, 0.5);
    // Everything mid-range → nothing worth remarking on.
    expect(describeKind(c)).toBe("An omnivore.");
    setGene(c, "speed", 0.95);
    expect(describeKind(c)).toContain("swift");
  });

  it("agrees its article with the leading word", () => {
    const c = aCreature();
    for (const g of TRAIT_GENES as readonly TraitGene[]) setGene(c, g, 0.5);
    setGene(c, "armor", 0.95);
    // "armored" is vowel-initial → "An", not "A".
    expect(describeKind(c).startsWith("An armored")).toBe(true);
    setGene(c, "armor", 0.5);
    setGene(c, "speed", 0.95);
    expect(describeKind(c).startsWith("A swift")).toBe(true);
  });
});

describe("describeCondition", () => {
  it("leads with the most urgent problem", () => {
    const c = aCreature();
    c.health = 10;
    c.hydration = 10;
    c.energy = 10;
    expect(describeCondition(c)).toBe("Badly wounded.");
    c.health = 100;
    expect(describeCondition(c)).toBe("Parched — it needs water.");
    c.hydration = 500;
    expect(describeCondition(c)).toBe("Starving.");
    c.energy = 900;
    expect(describeCondition(c)).toBe("Well fed and thriving.");
  });
});

describe("describeBehavior", () => {
  it("reports the dominant deliberate action", () => {
    const c = aCreature();
    c.actionWindow.fill(0);
    c.actionWindow[4] = 12; // Attack
    expect(describeBehavior(c)).toBe("Spends its time hunting.");
    c.actionWindow[7] = 20; // Nest outweighs it
    expect(describeBehavior(c)).toBe("Spends its time tending its home.");
  });

  it("ignores turn/accelerate, which fire constantly for everyone", () => {
    const c = aCreature();
    c.actionWindow.fill(0);
    c.actionWindow[0] = 500; // Turn
    c.actionWindow[1] = 500; // Accelerate
    c.actionWindow[2] = 3; // Eat
    expect(describeBehavior(c)).toBe("Spends its time feeding.");
  });

  it("claims no habit when the histogram is still noise", () => {
    const c = aCreature();
    c.actionWindow.fill(0);
    expect(describeBehavior(c)).toBe("Still just wandering.");
    c.actionWindow[4] = 0.01; // a decayed trace, not a habit
    expect(describeBehavior(c)).toBe("Still just wandering.");
  });

  it("always returns a sentence for a real, evolved creature", () => {
    const world = createWorld(3, makeConfig({}));
    for (let i = 0; i < 200; i++) tick(world);
    for (const c of world.creatures) {
      expect(describeBehavior(c).endsWith(".")).toBe(true);
      expect(describeKind(c).endsWith(".")).toBe(true);
      expect(describeCondition(c).endsWith(".")).toBe(true);
    }
  });
});
