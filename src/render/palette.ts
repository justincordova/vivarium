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

/**
 * Resolved drawing parameters for one creature — a procedural BODY PLAN grown from the
 * genome (Living World Phase 2). Still "derived, never designed": every field below is a
 * pure function of the expressed genes, so evolution drives appearance and every creature
 * is unique. `canvas.ts` assembles body + head + fins + tail + armor + markings from it.
 */
export interface Appearance {
  /** World-unit body half-length (the body is drawn elongated along heading). */
  radius: number;
  /** HSL fill (the creature body). Saturation encodes energy. */
  fill: string;
  /** HSL stroke for the body outline. */
  stroke: string;
  /** Brighter tint for the lit highlight of the gradient body (rich render). */
  highlight: string;
  /** Translucent glow color for the bioluminescent halo (rich render). */
  glow: string;
  /**
   * Body roundness 0..1 from `diet`: 1 = plump/round herbivore, 0 = leaner carnivore.
   * Fattens the torso. These are LAND-capable creatures, not fish.
   */
  roundness: number;
  /** Number of leg PAIRS along the flanks (from `speed`) — faster = more legs. */
  legPairs: number;
  /** Leg length as a fraction of torso width (from `speed`). */
  legLength: number;
  /** Tail-nub length 0..1 (from `speed`) — a short stub, not a swimmer's fin. */
  tailLength: number;
  /** Armored dorsal plates count (defense: `armor`). 0 = none. */
  plates: number;
  /** Plate prominence as a fraction of radius. */
  plateSize: number;
  /** Whether to draw toxicity warning markings (bright dorsal spots). */
  toxic: boolean;
  /** Age outline ring opacity 0..1 (older = more visible ring). */
  ageRing: number;
  /** Legacy: polygon vertices (kept for the low-detail fallback silhouette). */
  vertices: number;
  /** Legacy radial spikes (low-detail fallback). */
  spikes: number;
  spikeLength: number;
}

// Silhouette vertex count endpoints for the low-detail fallback silhouette.
const HERBIVORE_VERTICES = 16; // reads as a smooth disc
const CARNIVORE_VERTICES = 3; // a sharp triangle

// Body radius mapping from expressed `size` over its legal range. Bumped up so
// creatures read as organisms, not specks.
const MIN_RADIUS = 3.4;
const MAX_RADIUS = 14;

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
  const speed = f.speed[i] as number;
  // Sanitize hue before the modulo: a NaN slot (corrupt save / out-of-range live edit)
  // would otherwise yield the string "hsl(NaN …)", which canvas silently ignores — the
  // creature would render in the PREVIOUS fillStyle's color. Mirrors the `remap` NaN guard.
  const rawHue = f.hue[i] as number;
  const hue = Number.isFinite(rawHue) ? ((rawHue % 360) + 360) % 360 : 0;

  const [sizeLo, sizeHi] = TRAIT_RANGE.size;
  const radius = remap(size, sizeLo, sizeHi, MIN_RADIUS, MAX_RADIUS);

  // Saturation from energy: full energy = vivid, empty = near-gray. Keep a small
  // floor so a live creature is never fully colorless.
  const sat = Math.round(remap(energyFrac, 0, 1, 18, 88));
  // Slightly brighter when healthy so the world pops off the dark chrome.
  const light = Math.round(remap(energyFrac, 0, 1, 42, 58));
  const fill = `hsl(${hue.toFixed(0)} ${sat}% ${light}%)`;
  const stroke = `hsl(${hue.toFixed(0)} ${sat}% ${Math.max(0, light - 22)}%)`;
  // A brighter, more saturated tint for the body's lit highlight, and a translucent
  // same-hue glow whose strength tracks energy (a starving creature barely glows).
  const highlight = `hsl(${hue.toFixed(0)} ${Math.min(100, sat + 12)}% ${Math.min(80, light + 22)}%)`;
  const glowAlpha = (0.1 + 0.28 * energyFrac).toFixed(3);
  const glow = `hsla(${hue.toFixed(0)} ${sat}% ${Math.min(70, light + 12)}% / ${glowAlpha})`;

  const [dietLo, dietHi] = TRAIT_RANGE.diet;
  // Roundness: herbivore (diet→0) is plump/round, carnivore (diet→1) is sleek.
  const roundness = 1 - remap(diet, dietLo, dietHi, 0, 1);
  const vertices = Math.round(remap(diet, dietLo, dietHi, HERBIVORE_VERTICES, CARNIVORE_VERTICES));

  const [speedLo, speedHi] = TRAIT_RANGE.speed;
  // Faster creatures grow more/longer legs and a slightly longer tail nub.
  const speedNorm = remap(speed, speedLo, speedHi, 0, 1);
  const legPairs = Math.max(2, Math.round(2 + speedNorm * 2)); // 2..4 pairs
  const legLength = 0.4 + 0.7 * speedNorm;
  const tailLength = 0.3 + 0.6 * speedNorm;

  const [armorLo, armorHi] = TRAIT_RANGE.armor;
  // Armored creatures grow dorsal plates along the back.
  const armored = armor > armorLo + (armorHi - armorLo) * 0.12;
  const plates = armored ? Math.round(remap(armor, armorLo, armorHi, 3, 8)) : 0;
  const plateSize = remap(armor, armorLo, armorHi, 0.28, 0.7);
  // Legacy spikes for the low-detail fallback path.
  const spikes = plates;
  const spikeLength = plateSize;

  const [toxLo, toxHi] = TRAIT_RANGE.toxicity;
  const toxic = toxicity > toxLo + (toxHi - toxLo) * 0.5;

  // Age ring fades in over the first ~2000 ticks of life, then holds.
  const ageRing = remap(age, 0, 2000, 0, 0.5);

  return {
    radius: Math.max(1, radius),
    fill,
    stroke,
    highlight,
    glow,
    roundness,
    legPairs,
    legLength,
    tailLength,
    plates,
    plateSize,
    toxic,
    ageRing,
    vertices: Math.max(3, vertices),
    spikes,
    spikeLength,
  };
}
