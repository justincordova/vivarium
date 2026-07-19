/**
 * palette.ts — the pure genome → appearance mapping (SPEC.md §Visual Design:
 * "appearance is derived, never designed").
 *
 * A pure function of the lean `CreatureFrame` channels at a given index — no state,
 * no DOM, no canvas. `canvas.ts` calls this per creature and does the drawing. Kept
 * pure so it is unit-testable in Node and so swapping canvas→WebGL later never
 * touches this file.
 *
 * The world is the ONLY saturated thing on screen; all chrome is grayscale — so the
 * only place color lives in the whole app is the `fillHsl`/`strokeHsl` this returns.
 */

import { TRAIT_RANGE } from "@sim/genetics";
import type { CreatureFrame } from "@worker/protocol";

/** Resolved drawing parameters for one creature. Consumed by `canvas.ts`. */
export interface Appearance {
  /** World-unit radius to draw. */
  radius: number;
  /** HSL fill (the creature body). Saturation encodes energy. */
  fill: string;
  /** HSL stroke for the body outline. */
  stroke: string;
  /**
   * Body silhouette: number of polygon vertices. Herbivores read round (many
   * vertices ≈ circle); carnivores read angular (few, sharp vertices). `diet` in
   * 0..1 interpolates between the two.
   */
  vertices: number;
  /** Radial spikes drawn around the body (defense/display: `armor`). 0 = none. */
  spikes: number;
  /** Spike length as a fraction of radius. */
  spikeLength: number;
  /** Whether to draw the toxicity ornament ring (a dashed inner ring). */
  toxic: boolean;
  /** Age outline ring opacity 0..1 (older = more visible ring). */
  ageRing: number;
}

// Silhouette vertex count endpoints: herbivore (round) ↔ carnivore (angular).
const HERBIVORE_VERTICES = 16; // reads as a smooth disc
const CARNIVORE_VERTICES = 3; // a sharp triangle

// Body radius mapping from expressed `size` over its legal range.
const MIN_RADIUS = 2.2;
const MAX_RADIUS = 9;

/** Linear map of `v` from [inLo,inHi] into [outLo,outHi], clamped to the output. */
function remap(v: number, inLo: number, inHi: number, outLo: number, outHi: number): number {
  if (inHi === inLo) return outLo;
  const t = (v - inLo) / (inHi - inLo);
  // Clamp so `NaN` maps to `outLo` (via `t > 0` being false for NaN) rather than
  // propagating `NaN` into radii / hsl() strings if an upstream frame slot is NaN.
  const c = t > 0 ? (t > 1 ? 1 : t) : 0;
  return outLo + c * (outHi - outLo);
}

/**
 * Derive one creature's appearance from the frame at index `i`.
 *
 * - **hue** → the color's hue (neutral lineage marker; the whole point of the only
 *   color on screen is to make lineages visually separable).
 * - **energyFrac** → saturation: a starving creature washes out toward gray
 *   (SPEC.md table). Lightness dips slightly when starving too, so the desaturation
 *   reads even against the dark chrome.
 * - **diet** → silhouette vertex count (round herbivore ↔ angular carnivore).
 * - **armor** → radial spikes.
 * - **toxicity** → a warning ornament ring past a threshold.
 * - **age** → a faint outline ring that strengthens with age.
 */
export function appearance(f: CreatureFrame, i: number): Appearance {
  const size = f.size[i] as number;
  const energyFrac = f.energyFrac[i] as number;
  const diet = f.diet[i] as number;
  const armor = f.armor[i] as number;
  const toxicity = f.toxicity[i] as number;
  const age = f.age[i] as number;
  const hue = (((f.hue[i] as number) % 360) + 360) % 360;

  const [sizeLo, sizeHi] = TRAIT_RANGE.size;
  const radius = remap(size, sizeLo, sizeHi, MIN_RADIUS, MAX_RADIUS);

  // Saturation from energy: full energy = vivid, empty = near-gray. Keep a small
  // floor so a live creature is never fully colorless.
  const sat = Math.round(remap(energyFrac, 0, 1, 18, 88));
  // Slightly brighter when healthy so the world pops off the dark chrome.
  const light = Math.round(remap(energyFrac, 0, 1, 42, 58));
  const fill = `hsl(${hue.toFixed(0)} ${sat}% ${light}%)`;
  const stroke = `hsl(${hue.toFixed(0)} ${sat}% ${Math.max(0, light - 22)}%)`;

  const [dietLo, dietHi] = TRAIT_RANGE.diet;
  const vertices = Math.round(remap(diet, dietLo, dietHi, HERBIVORE_VERTICES, CARNIVORE_VERTICES));

  const [armorLo, armorHi] = TRAIT_RANGE.armor;
  // Only creatures with meaningful armor grow visible spikes.
  const spikes =
    armor > armorLo + (armorHi - armorLo) * 0.12
      ? Math.round(remap(armor, armorLo, armorHi, 3, 10))
      : 0;
  const spikeLength = remap(armor, armorLo, armorHi, 0.25, 0.7);

  const [toxLo, toxHi] = TRAIT_RANGE.toxicity;
  const toxic = toxicity > toxLo + (toxHi - toxLo) * 0.5;

  // Age ring fades in over the first ~2000 ticks of life, then holds.
  const ageRing = remap(age, 0, 2000, 0, 0.5);

  return {
    radius: Math.max(1, radius),
    fill,
    stroke,
    vertices: Math.max(3, vertices),
    spikes,
    spikeLength,
    toxic,
    ageRing,
  };
}
