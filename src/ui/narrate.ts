/**
 * narrate.ts — the plain-language layer (Living World §"Humanized default UI").
 *
 * Pure functions that turn sim data into English: world events into chronicle lines, and
 * a creature into the three sentences the inspector card leads with. Split out of the
 * components for the same reason `render/palette.ts` and `ui/share.ts` are — the
 * interesting logic is decision-making, not markup, and it should be unit-testable in
 * the Node env without React or a store.
 *
 * Two rules bind everything here:
 *
 *  1. **Lineages are named by hue, never by id.** "Lineage #47" is a database key the
 *     player cannot act on. The renderer already tints creatures and nests by lineage
 *     hue, so "the amber bloodline" both reads as English *and* tells you where to look.
 *     Raw ids remain in science mode, where they are the right answer.
 *  2. **Never claim a fact the sim does not track.** The design sketch imagined "3
 *     offspring"; nothing counts offspring, so the card does not say it. Everything
 *     below is derived from the genome, the vitals, or the action histogram.
 */

import { TRAIT_RANGE, type TraitGene } from "@sim/genetics";
import type { Creature } from "@sim/types";
import type { WorldEvent } from "@worker/protocol";

// ── World events ─────────────────────────────────────────────────────────────

/**
 * Name a hue the way a person would. Coarse on purpose — these are labels for finding a
 * creature on screen, not colour science, and too many names would stop being memorable.
 */
export function hueName(hue: number): string {
  if (!Number.isFinite(hue) || hue < 0) return "";
  const h = ((hue % 360) + 360) % 360;
  if (h < 20) return "red";
  if (h < 45) return "amber";
  if (h < 70) return "gold";
  if (h < 100) return "chartreuse";
  if (h < 150) return "green";
  if (h < 190) return "teal";
  if (h < 215) return "cyan";
  if (h < 255) return "blue";
  if (h < 290) return "violet";
  if (h < 330) return "magenta";
  return "crimson";
}

/** Turn one resolved world event into a sentence. */
export function narrate(e: WorldEvent): string {
  const who = `the ${hueName(e.hue)} bloodline`;
  switch (e.kind) {
    case "silence":
      return "The world fell silent — nothing is left alive.";
    case "extinction":
      return `${who} died out.`;
    case "boom":
      // The factor is the interesting part: "thriving" alone doesn't convey scale.
      return `${who} is thriving — ${e.factor.toFixed(1)}× in a few generations.`;
    case "dominant":
      return `${who} now outnumbers every other.`;
    case "home":
      return e.place ? `${who} built a home in ${e.place}.` : `${who} built a home.`;
  }
}

// ── The creature card ────────────────────────────────────────────────────────
//
// A wall of 16 unlabelled float sliders answers "what are this creature's parameters".
// A newcomer is asking a different question: "what *is* this thing?". The card answers
// that in three sentences — what it is, how it's doing, and what it actually spends its
// time on — and the sliders stay underneath for anyone who wants them.

function expressed(allele: [number, number]): number {
  return (allele[0] + allele[1]) / 2;
}

/** Where a gene sits in its own legal range, 0..1 — so adjectives compare like with like. */
function geneFrac(c: Creature, gene: TraitGene): number {
  const [lo, hi] = TRAIT_RANGE[gene];
  if (hi <= lo) return 0.5;
  const v = (expressed(c.genome[gene] as [number, number]) - lo) / (hi - lo);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** "A swift, armored hunter." — the headline noun phrase, built from the genome. */
export function describeKind(c: Creature): string {
  const diet = geneFrac(c, "diet");
  const noun = diet > 0.66 ? "hunter" : diet < 0.33 ? "grazer" : "omnivore";

  const adjectives: string[] = [];
  const speed = geneFrac(c, "speed");
  if (speed > 0.7) adjectives.push("swift");
  else if (speed < 0.3) adjectives.push("slow");

  const size = geneFrac(c, "size");
  if (size > 0.7) adjectives.push("massive");
  else if (size < 0.3) adjectives.push("tiny");

  // Defences are the most legible thing on screen (back plates, flank spots), so they
  // earn a word whenever they're pronounced.
  if (geneFrac(c, "armor") > 0.6) adjectives.push("armored");
  if (geneFrac(c, "toxicity") > 0.6) adjectives.push("toxic");

  const head = adjectives[0] ?? noun;
  const article = /^[aeiou]/.test(head) ? "An" : "A";
  return adjectives.length === 0
    ? `${article} ${noun}.`
    : `${article} ${adjectives.join(", ")} ${noun}.`;
}

/**
 * How it's faring right now. Ordered worst-first and returns a single clause, because a
 * creature that is both starving and wounded is, to the player, simply dying.
 */
export function describeCondition(c: Creature): string {
  if (c.health < 30) return "Badly wounded.";
  if (c.hydration < 60) return "Parched — it needs water.";
  if (c.energy < 120) return "Starving.";
  if (c.energy > 700) return "Well fed and thriving.";
  return "Getting by.";
}

/**
 * What it actually *does*, read from `actionWindow` — the trailing histogram of fired
 * actions. This is the one part of the card that is behavioural rather than genetic: it
 * describes the evolved policy, not the body. Turn/Accelerate (slots 0–1) are excluded
 * because they fire almost every tick for everyone and would drown out real choices.
 */
const BEHAVIOR_PHRASE: Record<number, string> = {
  2: "Spends its time feeding.",
  3: "Spends its time at the water.",
  4: "Spends its time hunting.",
  5: "Spends its time seeking a mate.",
  6: "Spends its time laying scent trails.",
  7: "Spends its time tending its home.",
};

/** The floor below which the histogram is noise, not a habit — see `describeBehavior`. */
const BEHAVIOR_MIN = 0.5;

export function describeBehavior(c: Creature): string {
  const w = c.actionWindow;
  let bestSlot = -1;
  let best = 0;
  for (let k = 2; k < w.length; k++) {
    const v = w[k] as number;
    if (v > best) {
      best = v;
      bestSlot = k;
    }
  }
  // A near-empty histogram means it has not committed to anything yet; naming a habit
  // off a rounding-error-sized slot would be a fabrication.
  if (bestSlot < 0 || best < BEHAVIOR_MIN) return "Still just wandering.";
  return BEHAVIOR_PHRASE[bestSlot] ?? "Still just wandering.";
}
