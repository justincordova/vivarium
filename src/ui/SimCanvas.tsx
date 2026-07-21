/**
 * SimCanvas.tsx — the canvas element + the requestAnimationFrame render loop.
 *
 * This component runs NO sim logic. It reads the latest worker frame from the
 * non-reactive `latestFrame` ref and draws it via `render/canvas.draw`. The camera
 * lives in a ref (mutated on drag/wheel, read by the rAF loop) so panning/zooming
 * never triggers a React re-render — the only thing that moves is the simulation.
 *
 * Canvas clicks dispatch a worker command chosen by the active tool (Task 3.4):
 * inspect / spawn / delete / move-water. The rAF loop also drives the follow-cam
 * (Task 3.5): it hard-locks the camera to the followed creature and, when that
 * creature vanishes from the frame (death), surfaces a grayscale caption.
 */

import {
  type Camera,
  centerOn,
  fitCamera,
  pan,
  resize,
  screenToWorld,
  zoomAt,
} from "@render/camera";
import { draw } from "@render/canvas";
import { latestFrame, useSimStore } from "@store/useSimStore";
import { useEffect, useRef, useState } from "react";

/** Pixels the pointer must move before a press counts as a drag (not a click). A little
 * generous so a quick tap with minor jitter still spawns/inspects on the first try. */
const DRAG_THRESHOLD = 8;
/** A press shorter than this (ms) always counts as a click, even if it wandered a bit —
 * so a quick tap is never swallowed as a pan. */
const TAP_MS = 250;
/** Water quanta moved per drought/flood click. */
const WATER_BRUSH_DELTA = 400;
const WATER_BRUSH_RADIUS = 2;

interface DeathNote {
  id: number;
  age: number;
}

export function SimCanvas(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const camRef = useRef<Camera | null>(null);
  // Whether the camera has been fit against a REAL frame's world dims (not the fallback).
  // SimCanvas mounts before the worker posts any frame, so the initial `fitCanvas` fits to
  // the 200×200 fallback; the real world is far larger — re-fit once the first frame lands.
  const cameraFitToWorld = useRef<boolean>(false);
  const [deathNote, setDeathNote] = useState<DeathNote | null>(null);
  // Last-seen age of the followed creature, for the death caption.
  const followAge = useRef<number>(0);
  // The followId a death note was already emitted for, so the rAF loop emits it exactly
  // once regardless of when the `setFollow(null)` store write propagates.
  const deathEmittedFor = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const fitCanvas = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width;
      const h = rect.height;
      if (camRef.current === null) {
        const f = latestFrame.current;
        camRef.current = fitCamera(f?.worldWidth ?? 200, f?.worldHeight ?? 200, w, h);
        // Only count this as a real fit if a real frame backed it.
        if (f !== null) cameraFitToWorld.current = true;
      } else {
        camRef.current = resize(camRef.current, w, h);
      }
      ctx.fillStyle = "#08080a";
      ctx.fillRect(0, 0, w, h);
    };
    fitCanvas();
    const ro = new ResizeObserver(fitCanvas);
    ro.observe(canvas);

    let raf = 0;
    const loop = (): void => {
      const frame = latestFrame.current;
      let cam = camRef.current;
      // Re-fit the camera the first time a REAL frame arrives (the mount-time fit used the
      // 200×200 fallback because no frame existed yet). Guarded so later pan/zoom/resize
      // are never clobbered.
      if (frame !== null && cam !== null && !cameraFitToWorld.current) {
        cam = fitCamera(frame.worldWidth, frame.worldHeight, cam.viewW, cam.viewH);
        camRef.current = cam;
        cameraFitToWorld.current = true;
      }
      if (frame !== null && cam !== null) {
        // Follow-cam: lock onto the followed creature, or announce its death.
        const followId = useSimStore.getState().followId;
        if (followId !== null) {
          const c = frame.creatures;
          let found = -1;
          for (let i = 0; i < c.count; i++) {
            if ((c.ids[i] as number) === followId) {
              found = i;
              break;
            }
          }
          if (found >= 0) {
            followAge.current = c.age[found] as number;
            cam = centerOn(cam, c.x[found] as number, c.y[found] as number);
            camRef.current = cam;
            // This follow is live → re-arm the death note. Without this, re-following an
            // id whose death note already fired (e.g. an id that recurs after a world
            // swap, since this component stays mounted) would suppress the note AND never
            // release the lock, leaving the camera stuck.
            deathEmittedFor.current = null;
          } else if (deathEmittedFor.current !== followId) {
            // The followed creature is gone → death caption once, then release the lock.
            // The ref guard makes this fire exactly once even if `setFollow(null)` hasn't
            // propagated to `getState().followId` by the next frame.
            deathEmittedFor.current = followId;
            setDeathNote({ id: followId, age: Math.round(followAge.current) });
            useSimStore.getState().setFollow(null);
          }
        }
        draw(frame, ctx, cam);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // ── Pointer interaction ────────────────────────────────────────────────────────
  const drag = useRef<{ x: number; y: number; moved: number; t: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw for synthetic events; harmless.
    }
    drag.current = { x: e.clientX, y: e.clientY, moved: 0, t: performance.now() };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current;
    const cam = camRef.current;
    if (d === null || cam === null) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.moved += Math.abs(dx) + Math.abs(dy);
    // Dragging pans and breaks any follow-lock (free camera).
    if (useSimStore.getState().followId !== null) useSimStore.getState().setFollow(null);
    camRef.current = pan(cam, dx, dy);
    d.x = e.clientX;
    d.y = e.clientY;
  };

  /** Index of the creature nearest a world point, or -1 if none within `hitRadius`. */
  const nearestCreature = (wx: number, wy: number, hitRadius: number): number => {
    const frame = latestFrame.current;
    if (frame === null) return -1;
    const c = frame.creatures;
    let best = -1;
    let bestD2 = hitRadius * hitRadius;
    for (let i = 0; i < c.count; i++) {
      const ddx = (c.x[i] as number) - wx;
      const ddy = (c.y[i] as number) - wy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current;
    drag.current = null;
    const cam = camRef.current;
    const frame = latestFrame.current;
    if (d === null || cam === null || frame === null) return;
    // A quick tap is always a click (even with minor jitter); otherwise fall back to the
    // distance threshold. This keeps spawn/inspect reliable on the first tap.
    const quickTap = performance.now() - d.t < TAP_MS;
    if (!quickTap && d.moved >= DRAG_THRESHOLD) return; // a deliberate pan, not a click

    const rect = e.currentTarget.getBoundingClientRect();
    const [wx, wy] = screenToWorld(cam, e.clientX - rect.left, e.clientY - rect.top);
    const store = useSimStore.getState();
    const hitRadius = 6 / cam.zoom + 4;

    switch (store.tool) {
      case "inspect": {
        const i = nearestCreature(wx, wy, hitRadius);
        if (i >= 0) store.inspect(frame.creatures.ids[i] as number);
        break;
      }
      case "delete": {
        const i = nearestCreature(wx, wy, hitRadius);
        if (i >= 0) store.remove(frame.creatures.ids[i] as number);
        break;
      }
      case "spawn": {
        // Spawn a LARGE, well-endowed, low-metabolism creature at the click so it is easy
        // to see and survives long enough to inspect (the worker auto-inspects it). The
        // camera is intentionally NOT moved — the view stays where the user put it.
        store.spawn({
          x: wx,
          y: wy,
          traits: { size: 8, speed: 4, diet: 0.3, metabolism: 0.7, senseRadius: 25 },
          hue: Math.floor((wx / frame.worldWidth) * 360),
          energy: 900,
          hydration: 400,
        });
        break;
      }
      case "paintWaterDown":
      case "paintWaterUp": {
        const cell = cellIndexOfFrame(
          frame.gridCols,
          frame.gridRows,
          frame.worldWidth,
          frame.worldHeight,
          wx,
          wy,
        );
        const delta = store.tool === "paintWaterDown" ? -WATER_BRUSH_DELTA : WATER_BRUSH_DELTA;
        store.paint("water", cell, delta, WATER_BRUSH_RADIUS);
        break;
      }
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const cam = camRef.current;
    if (cam === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    camRef.current = zoomAt(cam, factor, e.clientX - rect.left, e.clientY - rect.top);
  };

  // On-screen zoom controls (the wheel is not discoverable, esp. on trackpads). These
  // zoom about the canvas center and refit to the world, mutating the same camera ref
  // the rAF loop reads — so no React re-render is needed.
  const zoomByCenter = (factor: number): void => {
    const cam = camRef.current;
    if (cam === null) return;
    camRef.current = zoomAt(cam, factor, cam.viewW / 2, cam.viewH / 2);
  };
  const fitToWorld = (): void => {
    const cam = camRef.current;
    const frame = latestFrame.current;
    if (cam === null) return;
    camRef.current = fitCamera(
      frame?.worldWidth ?? 200,
      frame?.worldHeight ?? 200,
      cam.viewW,
      cam.viewH,
    );
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-crosshair touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      />

      {/* Zoom controls — makes zoom discoverable (the wheel alone is not). */}
      <div className="panel absolute bottom-4 left-1/2 flex -translate-x-1/2 translate-y-0 items-center gap-0.5 p-0.5 sm:left-auto sm:right-4 sm:translate-x-0">
        <button
          type="button"
          onClick={() => zoomByCenter(1 / 1.25)}
          className="btn-ghost tabular h-7 w-7 text-base leading-none"
          title="Zoom out"
          aria-label="zoom out"
        >
          −
        </button>
        <button
          type="button"
          onClick={fitToWorld}
          className="btn-ghost px-2 py-1 text-[10px] uppercase tracking-widest"
          title="Fit the whole world in view"
          aria-label="fit world"
        >
          fit
        </button>
        <button
          type="button"
          onClick={() => zoomByCenter(1.25)}
          className="btn-ghost tabular h-7 w-7 text-base leading-none"
          title="Zoom in"
          aria-label="zoom in"
        >
          +
        </button>
      </div>

      {deathNote !== null && (
        <div className="panel tabular pointer-events-auto absolute bottom-28 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 px-3 py-1.5 text-xs text-[var(--fg-dim)]">
          <span>
            creature #{deathNote.id} gone · age {deathNote.age.toLocaleString("en-US")}
          </span>
          <button
            type="button"
            onClick={() => setDeathNote(null)}
            className="text-[var(--fg-mute)] hover:text-[var(--fg)]"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Grid cell index for a world position, using the frame's grid resolution — mirrors
 * `worker/commands.cellIndexOf` (which needs a full `World`). The worker re-validates
 * the cell against its own bounds, so an edge case is clamped there too.
 */
function cellIndexOfFrame(
  gridCols: number,
  gridRows: number,
  worldW: number,
  worldH: number,
  x: number,
  y: number,
): number {
  const col = Math.min(gridCols - 1, Math.max(0, Math.floor((x / worldW) * gridCols)));
  const row = Math.min(gridRows - 1, Math.max(0, Math.floor((y / worldH) * gridRows)));
  return row * gridCols + col;
}
