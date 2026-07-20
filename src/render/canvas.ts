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

/** Draw a single creature body (polygon silhouette + spikes + rings).
 *
 * `rich` enables the prettier path — a soft radial-gradient body with a faint
 * bioluminescent glow and tapered (triangular) spikes. It is disabled under density so
 * a packed world holds frame rate; the plain path is the old flat silhouette. Either
 * way the shape/color/spikes are still fully derived from `Appearance` (the genome). */
function drawCreature(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  heading: number,
  r: number,
  a: Appearance,
  rich: boolean,
): void {
  // Soft glow halo (rich only): a cheap-ish radial gradient behind the body, tinted by
  // the creature's own color — reads as bioluminescence without a per-pixel shader.
  if (rich && r > 2) {
    const g = ctx.createRadialGradient(sx, sy, r * 0.2, sx, sy, r * 2.1);
    g.addColorStop(0, a.glow);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Spikes (behind the body). Tapered filled triangles when rich; thin lines otherwise.
  if (a.spikes > 0) {
    ctx.save();
    if (rich) ctx.fillStyle = a.stroke;
    else {
      ctx.strokeStyle = a.stroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
    }
    for (let s = 0; s < a.spikes; s++) {
      const ang = heading + (s / a.spikes) * Math.PI * 2;
      const inner = r * 0.9;
      const outer = r * (1 + a.spikeLength);
      if (rich) {
        const w = r * 0.28;
        const nx = -Math.sin(ang) * w;
        const ny = Math.cos(ang) * w;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(ang) * inner + nx, sy + Math.sin(ang) * inner + ny);
        ctx.lineTo(sx + Math.cos(ang) * inner - nx, sy + Math.sin(ang) * inner - ny);
        ctx.lineTo(sx + Math.cos(ang) * outer, sy + Math.sin(ang) * outer);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.moveTo(sx + Math.cos(ang) * inner, sy + Math.sin(ang) * inner);
        ctx.lineTo(sx + Math.cos(ang) * outer, sy + Math.sin(ang) * outer);
      }
    }
    if (!rich) ctx.stroke();
    ctx.restore();
  }

  // Body polygon, oriented by heading (first vertex points forward).
  ctx.beginPath();
  for (let v = 0; v < a.vertices; v++) {
    const ang = heading + (v / a.vertices) * Math.PI * 2;
    const px = sx + Math.cos(ang) * r;
    const py = sy + Math.sin(ang) * r;
    if (v === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  if (rich && r > 2) {
    // Radial gradient body: a bright off-center highlight → base fill, for a soft,
    // rounded, lit look instead of a flat fill.
    const hx = sx - Math.cos(heading) * r * 0.3;
    const hy = sy - Math.sin(heading) * r * 0.3;
    const bg = ctx.createRadialGradient(hx, hy, r * 0.1, sx, sy, r);
    bg.addColorStop(0, a.highlight);
    bg.addColorStop(1, a.fill);
    ctx.fillStyle = bg;
  } else {
    ctx.fillStyle = a.fill;
  }
  ctx.fill();
  ctx.strokeStyle = a.stroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Toxicity ornament: a dashed inner ring.
  if (a.toxic) {
    ctx.save();
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = a.stroke;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Age ring: a faint outline that strengthens with age.
  if (a.ageRing > 0.02) {
    ctx.save();
    ctx.strokeStyle = `rgba(230, 230, 235, ${a.ageRing.toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx, sy, r + 2, 0, Math.PI * 2);
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
