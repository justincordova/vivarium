/**
 * canvas.ts — draw(frame, ctx, camera): render one snapshot to a 2D canvas.
 *
 * A pure function of a `RenderFrame` (+ ctx + camera) — no sim logic, no store, no
 * React. Swapping to WebGL later touches only this folder (SPEC.md §Architecture).
 *
 * Visual Design rules enforced here (SPEC.md §Visual Design):
 *  - Trails: the canvas is NOT cleared each frame; we fill a low-alpha black rect
 *    for near-free motion blur, so movement leaves fading trails.
 *  - Day/night: a single translucent overlay derived from `frame.light`.
 *  - The world is the only saturated thing; plants/corpses are muted, creatures
 *    carry the only vivid color (from palette.ts).
 *  - Nothing eases or bounces — the only motion is the simulation advancing.
 */

import type { RenderFrame } from "@worker/protocol";
import { type Camera, worldToScreen, worldToScreenX, worldToScreenY } from "./camera";
import { type Appearance, appearance } from "./palette";

/** How aggressively trails fade. Higher = shorter trails (more opaque wipe). */
const TRAIL_FADE_ALPHA = 0.28;
/** Plant mark base color (muted green, low chroma — chrome-adjacent, not vivid). */
const PLANT_COLOR = "hsl(130 30% 42%)";
/** Corpse mark color (desaturated warm gray — distinct from plants and creatures). */
const CORPSE_COLOR = "hsl(28 18% 46%)";
/** Above this live-creature count, drop the rich per-creature glow/gradient path so a
 * dense world stays at frame rate (the flat silhouette still conveys all the genome
 * channels). Tuned to comfortably exceed the default creature cap. */
const RICH_RENDER_MAX = 220;

/**
 * Paint the fading-trail wipe. Call once at the top of each frame instead of
 * `clearRect`. The alpha scales slightly with darkness so night trails linger a
 * touch longer (reads as calmer nocturnal motion) without ever fully persisting.
 */
export function fadeTrails(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgba(8, 8, 10, ${TRAIL_FADE_ALPHA})`;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** Muted per-biome fill colors (chrome-adjacent; creatures remain the vivid focus).
 * Index by `Biome` enum value: 0 Water, 1 Grassland, 2 Forest, 3 Barren, 4 Rock. */
const BIOME_FILL = [
  "rgb(26, 58, 92)", // water — deep blue
  "rgb(38, 58, 40)", // grassland — muted green
  "rgb(26, 44, 32)", // forest — darker green
  "rgb(70, 62, 44)", // barren — dry tan-brown
  "rgb(52, 54, 60)", // rock — cool gray
] as const;

/**
 * Terrain underlay: fill each grid cell by its authored biome, with a light water
 * shading on top so pooling/drought/flood read as brighter/darker patches. One rect per
 * cell, culled to the viewport. Drawn under plants/creatures.
 */
function drawTerrain(ctx: CanvasRenderingContext2D, frame: RenderFrame, cam: Camera): void {
  const { gridCols, gridRows, biome, water } = frame;
  if (gridCols <= 0 || gridRows <= 0) return;
  const cw = frame.worldWidth / gridCols;
  const ch = frame.worldHeight / gridRows;
  ctx.save();
  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      const idx = row * gridCols + col;
      const x0 = worldToScreenX(cam, col * cw);
      const y0 = worldToScreenY(cam, row * ch);
      const x1 = worldToScreenX(cam, (col + 1) * cw);
      const y1 = worldToScreenY(cam, (row + 1) * ch);
      if (x1 < 0 || y1 < 0 || x0 > cam.viewW || y0 > cam.viewH) continue;
      const b = biome[idx] as number;
      ctx.fillStyle = BIOME_FILL[b] ?? BIOME_FILL[1];
      ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      // Water shading on top: brighten where water genuinely pools (drought/flood read
      // as changes here). Only meaningful cells, so land stays clean.
      const w = water[idx] as number;
      if (w > 0.55) {
        const t = (w - 0.55) / 0.45;
        ctx.fillStyle = `rgba(58, 130, 190, ${(0.05 + 0.3 * t).toFixed(3)})`;
        ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      }
    }
  }
  ctx.restore();
}

/** Draw the world-bounds rectangle so the walled arena edge is legible. */
function drawBounds(ctx: CanvasRenderingContext2D, frame: RenderFrame, cam: Camera): void {
  const [x0, y0] = worldToScreen(cam, 0, 0);
  const [x1, y1] = worldToScreen(cam, frame.worldWidth, frame.worldHeight);
  ctx.save();
  ctx.strokeStyle = "rgba(120, 120, 130, 0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}

/**
 * Draw a single creature as a procedural ORGANISM (Living World Phase 2) — a body plan
 * grown entirely from the genome: a streamlined body (roundness ← diet), lateral fins +
 * a trailing tail (← speed), dorsal armor plates (← armor), toxicity warning spots, a
 * forward head with an eye, plus the hue/energy color and age ring. Nothing is designed;
 * every part is a function of `Appearance`, so evolution drives the look.
 *
 * `rich` is the full organism; the low-detail fallback (under density / tiny on screen)
 * is a simple oriented blob so a packed world holds frame rate.
 */
function drawCreature(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  heading: number,
  r: number,
  a: Appearance,
  rich: boolean,
): void {
  // Work in a body-local frame: +x = forward, +y = right. Far simpler and cheaper than
  // rotating every vertex by hand, and keeps the part math readable.
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(heading);

  if (!rich || r <= 2) {
    // Low-detail fallback: an oriented teardrop blob (still shows facing + color).
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.2, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fillStyle = a.fill;
    ctx.fill();
    ctx.restore();
    return;
  }

  const bodyLen = r * 1.5; // nose-to-tail half-length
  const bodyWide = r * (0.55 + 0.4 * a.roundness); // fatter herbivore, sleeker carnivore

  // 1. Bioluminescent glow halo behind everything.
  {
    const g = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 2.2);
    g.addColorStop(0, a.glow);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 2. Tail — a trailing translucent fin sweeping behind (length ← speed).
  {
    const tx = -bodyLen; // tail root at the back
    const tl = bodyLen * a.tailLength;
    ctx.beginPath();
    ctx.moveTo(tx, 0);
    ctx.quadraticCurveTo(tx - tl * 0.6, -bodyWide * 0.9, tx - tl, -bodyWide * 0.5);
    ctx.quadraticCurveTo(tx - tl * 0.7, 0, tx - tl, bodyWide * 0.5);
    ctx.quadraticCurveTo(tx - tl * 0.6, bodyWide * 0.9, tx, 0);
    ctx.closePath();
    ctx.fillStyle = a.glow;
    ctx.fill();
  }

  // 3. Lateral fins — a pair mid-body, size ← speed.
  {
    const fx = -bodyLen * 0.15;
    const fl = bodyWide * (1 + a.finSize * 1.6);
    ctx.fillStyle = a.glow;
    for (const side of [-1, 1] as const) {
      ctx.beginPath();
      ctx.moveTo(fx, side * bodyWide * 0.5);
      ctx.quadraticCurveTo(fx - fl * 0.5, side * fl, fx - fl, side * fl * 0.8);
      ctx.quadraticCurveTo(fx - fl * 0.3, side * bodyWide * 0.6, fx, side * bodyWide * 0.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 4. Body — a streamlined teardrop: rounded nose forward, tapering to the tail. Filled
  //    with a lit gradient (highlight near the top-front → base fill).
  ctx.beginPath();
  ctx.moveTo(bodyLen, 0); // nose
  ctx.quadraticCurveTo(bodyLen * 0.3, -bodyWide, -bodyLen * 0.5, -bodyWide * 0.7);
  ctx.quadraticCurveTo(-bodyLen, -bodyWide * 0.25, -bodyLen, 0); // tail root
  ctx.quadraticCurveTo(-bodyLen, bodyWide * 0.25, -bodyLen * 0.5, bodyWide * 0.7);
  ctx.quadraticCurveTo(bodyLen * 0.3, bodyWide, bodyLen, 0);
  ctx.closePath();
  {
    const bg = ctx.createRadialGradient(bodyLen * 0.3, -bodyWide * 0.3, r * 0.1, 0, 0, bodyLen);
    bg.addColorStop(0, a.highlight);
    bg.addColorStop(1, a.fill);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = a.stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 5. Dorsal armor plates along the back ridge (count/size ← armor).
  if (a.plates > 0) {
    ctx.fillStyle = a.stroke;
    for (let p = 0; p < a.plates; p++) {
      const t = a.plates === 1 ? 0.5 : p / (a.plates - 1);
      const px = bodyLen * 0.6 - t * bodyLen * 1.3; // front→back along the ridge
      const ph = bodyWide * a.plateSize; // plate height
      ctx.beginPath();
      ctx.moveTo(px + ph * 0.6, 0);
      ctx.lineTo(px, -ph);
      ctx.lineTo(px - ph * 0.6, 0);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 6. Toxicity warning spots — bright dots along the flanks.
  if (a.toxic) {
    ctx.fillStyle = "rgba(245, 240, 120, 0.9)";
    for (const side of [-1, 1] as const) {
      for (let s = 0; s < 3; s++) {
        const px = bodyLen * 0.3 - s * bodyLen * 0.35;
        ctx.beginPath();
        ctx.arc(px, side * bodyWide * 0.45, Math.max(0.8, r * 0.12), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 7. Head + eye near the nose — the cue that reads it as a facing creature.
  if (r > 3) {
    const ex = bodyLen * 0.55;
    const er = Math.max(1, r * 0.18);
    ctx.beginPath();
    ctx.arc(ex, 0, er, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(10, 12, 18, 0.92)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ex - er * 0.3, -er * 0.3, Math.max(0.5, er * 0.4), 0, Math.PI * 2);
    ctx.fillStyle = "rgba(235, 240, 255, 0.9)";
    ctx.fill();
  }

  ctx.restore();

  // 8. Age ring — a faint circle in world space (drawn after restore, centered on sx,sy).
  if (a.ageRing > 0.02) {
    ctx.save();
    ctx.strokeStyle = `rgba(230, 230, 235, ${a.ageRing.toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 1.7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Draw the whole frame. Order: trail fade → bounds → plants → corpses → creatures →
 * day/night overlay. Culls anything off the viewport.
 */
export function draw(frame: RenderFrame, ctx: CanvasRenderingContext2D, cam: Camera): void {
  fadeTrails(ctx, cam.viewW, cam.viewH);
  drawTerrain(ctx, frame, cam);
  drawBounds(ctx, frame, cam);

  // Plants — faint muted marks (SPEC.md: fields/plants recede; creatures dominate).
  const p = frame.plants;
  ctx.fillStyle = PLANT_COLOR;
  for (let i = 0; i < p.count; i++) {
    const sx = worldToScreenX(cam, p.x[i] as number);
    const sy = worldToScreenY(cam, p.y[i] as number);
    if (sx < -8 || sy < -8 || sx > cam.viewW + 8 || sy > cam.viewH + 8) continue;
    const r = 1 + 1.5 * (p.energyFrac[i] as number);
    ctx.globalAlpha = 0.35 + 0.35 * (p.energyFrac[i] as number);
    ctx.fillRect(sx - r / 2, sy - r / 2, r, r);
  }
  ctx.globalAlpha = 1;

  // Corpses — distinct desaturated diamonds.
  const co = frame.corpses;
  ctx.fillStyle = CORPSE_COLOR;
  for (let i = 0; i < co.count; i++) {
    const sx = worldToScreenX(cam, co.x[i] as number);
    const sy = worldToScreenY(cam, co.y[i] as number);
    if (sx < -8 || sy < -8 || sx > cam.viewW + 8 || sy > cam.viewH + 8) continue;
    const r = 2 + 2 * (co.energyFrac[i] as number);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-r / 2, -r / 2, r, r);
    ctx.restore();
  }

  // Creatures — the vivid, glowing focus of the scene. The prettier "rich" path
  // (gradient body + glow + tapered spikes) is disabled under density so a packed world
  // holds frame rate; above the threshold we fall back to the flat silhouette.
  const c = frame.creatures;
  const rich = c.count <= RICH_RENDER_MAX;
  for (let i = 0; i < c.count; i++) {
    const sx = worldToScreenX(cam, c.x[i] as number);
    const sy = worldToScreenY(cam, c.y[i] as number);
    const a = appearance(c, i);
    const rPx = a.radius * cam.zoom;
    // Cull against the FULL drawn extent, not just the body radius: `drawCreature`
    // extends spikes to `r·(1 + spikeLength)`. Using bare `rPx` here makes a large,
    // armored creature pop in/out at the viewport edge (its spikes are still visible
    // while its center is culled). `+6` covers the age ring / min-radius floor.
    const margin = rPx * (1 + a.spikeLength) + 6;
    if (sx < -margin || sy < -margin || sx > cam.viewW + margin || sy > cam.viewH + margin) {
      continue;
    }
    // Rich detail only pays off when the creature is big enough on screen to see it.
    drawCreature(ctx, sx, sy, c.heading[i] as number, Math.max(1.5, rPx), a, rich && rPx > 2.5);
  }

  drawDayNight(ctx, cam, frame.light);
}

/**
 * Day/night tint: a single translucent overlay. At noon (`light`=1) it's clear; at
 * night (`light`→0) a cool dark-blue multiply dims and cools the world. One rect,
 * no gradient stops animated — the tint just tracks the sim's clock.
 */
export function drawDayNight(ctx: CanvasRenderingContext2D, cam: Camera, light: number): void {
  const darkness = 1 - Math.max(0, Math.min(1, light));
  if (darkness <= 0.001) return;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  // Cool night blue; alpha grows with darkness but caps so night stays legible.
  ctx.fillStyle = `rgba(18, 24, 54, ${(darkness * 0.45).toFixed(3)})`;
  ctx.fillRect(0, 0, cam.viewW, cam.viewH);
  ctx.restore();
}
