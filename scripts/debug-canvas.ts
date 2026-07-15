/**
 * debug-canvas.ts — THROWAWAY Phase 1 debug viewer (plan Task 1.6).
 *
 * "A CSV will not tell you why your world died; watching it die tells you in ten
 * seconds." Runs the pure sim on the main thread in a requestAnimationFrame loop and
 * draws creatures as hue-colored dots + plants as faint green marks. No camera, no
 * React, no worker, no abstraction — deliberately disposable (replaced by the real
 * renderer in Phase 2). Do not build render infrastructure here.
 *
 * Query params: ?seed=1&speed=4  (speed = sim ticks per animation frame).
 * Imports only from `src/sim/`.
 */

import { makeConfig } from "../src/sim/config";
import { expressTrait } from "../src/sim/genetics";
import { tick } from "../src/sim/tick";
import { createWorld } from "../src/sim/world";

const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? 1);
const speed = Math.max(1, Number(params.get("speed") ?? 4));

const world = createWorld(seed, makeConfig({}));
const canvas = document.getElementById("view") as HTMLCanvasElement;
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
const info = document.getElementById("info") as HTMLElement;
const sx = canvas.width / world.config.worldWidth;
const sy = canvas.height / world.config.worldHeight;

function frame(): void {
  for (let i = 0; i < speed; i++) tick(world);

  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Plants: faint green marks.
  ctx.fillStyle = "rgba(80,200,120,0.35)";
  for (const p of world.plants) ctx.fillRect(p.x * sx - 1, p.y * sy - 1, 2, 2);

  // Corpses: dim grey.
  ctx.fillStyle = "rgba(150,150,150,0.4)";
  for (const co of world.corpses) ctx.fillRect(co.x * sx - 1, co.y * sy - 1, 2, 2);

  // Creatures: dots colored by genome hue, sized by the `size` gene.
  for (const c of world.creatures) {
    const hue = ((expressTrait(c.genome.hue) % 360) + 360) % 360;
    const r = 1.5 + expressTrait(c.genome.size) * 0.4;
    ctx.fillStyle = `hsl(${hue}, 70%, 60%)`;
    ctx.beginPath();
    ctx.arc(c.x * sx, c.y * sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  info.textContent = `tick=${world.tick}  pop=${world.creatures.length}  plants=${world.plants.length}  corpses=${world.corpses.length}`;
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
