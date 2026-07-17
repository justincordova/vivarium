/**
 * SimCanvas.tsx — the canvas element + the requestAnimationFrame render loop.
 *
 * This component runs NO sim logic. It reads the latest worker frame from the
 * non-reactive `latestFrame` ref and draws it via `render/canvas.draw`. The camera
 * lives in a ref (mutated on drag/wheel, read by the rAF loop) so panning/zooming
 * never triggers a React re-render — the only thing that moves is the simulation.
 */

import { type Camera, fitCamera, pan, resize, screenToWorld, zoomAt } from "@render/camera";
import { draw } from "@render/canvas";
import { latestFrame, useSimStore } from "@store/useSimStore";
import { useEffect, useRef } from "react";

/** Pixels the pointer must move before a press counts as a drag (not a click). */
const DRAG_THRESHOLD = 4;

export function SimCanvas(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const camRef = useRef<Camera | null>(null);
  const inspect = useSimStore((s) => s.inspect);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    // Size the backing store to the element's box (device-pixel aware).
    const fitCanvas = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width;
      const h = rect.height;
      if (camRef.current === null) {
        // First fit: frame the whole world once a frame's dims are known.
        const f = latestFrame.current;
        camRef.current = fitCamera(f?.worldWidth ?? 200, f?.worldHeight ?? 200, w, h);
      } else {
        camRef.current = resize(camRef.current, w, h);
      }
      // Paint the dark chrome background once so trails accumulate over it.
      ctx.fillStyle = "#08080a";
      ctx.fillRect(0, 0, w, h);
    };
    fitCanvas();
    const ro = new ResizeObserver(fitCanvas);
    ro.observe(canvas);

    let raf = 0;
    const loop = (): void => {
      const frame = latestFrame.current;
      const cam = camRef.current;
      if (frame !== null && cam !== null) draw(frame, ctx, cam);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // ── Pointer interaction: drag to pan, wheel to zoom, click to inspect ──────────
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current;
    const cam = camRef.current;
    if (d === null || cam === null) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.moved += Math.abs(dx) + Math.abs(dy);
    camRef.current = pan(cam, dx, dy);
    d.x = e.clientX;
    d.y = e.clientY;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current;
    drag.current = null;
    const cam = camRef.current;
    const frame = latestFrame.current;
    if (d === null || cam === null || frame === null) return;
    if (d.moved >= DRAG_THRESHOLD) return; // it was a pan, not a click

    // Click: find the nearest creature to the click in world space, inspect it.
    const rect = e.currentTarget.getBoundingClientRect();
    const [wx, wy] = screenToWorld(cam, e.clientX - rect.left, e.clientY - rect.top);
    const c = frame.creatures;
    let best = -1;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < c.count; i++) {
      const ddx = (c.x[i] as number) - wx;
      const ddy = (c.y[i] as number) - wy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    // Only inspect if the click landed reasonably near a creature (world units).
    const hitRadius = 6 / cam.zoom + 4;
    if (best >= 0 && bestD2 <= hitRadius * hitRadius) {
      inspect(c.ids[best] as number);
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const cam = camRef.current;
    if (cam === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    camRef.current = zoomAt(cam, factor, e.clientX - rect.left, e.clientY - rect.top);
  };

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full cursor-crosshair touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    />
  );
}
