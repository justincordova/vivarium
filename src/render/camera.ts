/**
 * camera.ts — pan/zoom state and screen↔world coordinate transforms.
 *
 * Pure data + pure functions (no canvas, no DOM). `canvas.ts` applies the transform;
 * the UI mutates the camera on drag/wheel. Screen↔world is the single source of truth
 * for hit-testing (click → world point → nearest creature → `inspect`).
 *
 * Transform: screen = (world - center) * zoom + viewport/2. So `center` is the world
 * point under the middle of the viewport, and `zoom` is screen-pixels per world-unit.
 */

export interface Camera {
  /** World coordinate at the viewport center. */
  cx: number;
  cy: number;
  /** Screen pixels per world unit. */
  zoom: number;
  /** Viewport size in screen pixels. */
  viewW: number;
  viewH: number;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 12;

function clampZoom(z: number): number {
  return z < MIN_ZOOM ? MIN_ZOOM : z > MAX_ZOOM ? MAX_ZOOM : z;
}

/** A camera framing the whole world in the viewport, centered. */
export function fitCamera(
  worldWidth: number,
  worldHeight: number,
  viewW: number,
  viewH: number,
): Camera {
  const zoom = clampZoom(
    Math.min(viewW / Math.max(1, worldWidth), viewH / Math.max(1, worldHeight)),
  );
  return { cx: worldWidth / 2, cy: worldHeight / 2, zoom, viewW, viewH };
}

/** World point → screen pixel. */
export function worldToScreen(cam: Camera, wx: number, wy: number): [number, number] {
  return [worldToScreenX(cam, wx), worldToScreenY(cam, wy)];
}

// Allocation-free scalar projections for the per-entity draw loop, which runs this once
// per plant/corpse/creature every animation frame — the tuple form's short-lived array
// would otherwise be the only GC pressure in the render hot path. UI hit-testing keeps
// the convenient tuple `worldToScreen`.
/** World x → screen x (no allocation). */
export function worldToScreenX(cam: Camera, wx: number): number {
  return (wx - cam.cx) * cam.zoom + cam.viewW / 2;
}
/** World y → screen y (no allocation). */
export function worldToScreenY(cam: Camera, wy: number): number {
  return (wy - cam.cy) * cam.zoom + cam.viewH / 2;
}

/** Screen pixel → world point (inverse of `worldToScreen`). */
export function screenToWorld(cam: Camera, sx: number, sy: number): [number, number] {
  return [(sx - cam.viewW / 2) / cam.zoom + cam.cx, (sy - cam.viewH / 2) / cam.zoom + cam.cy];
}

/** Pan by a screen-space delta (drag): shift the world center opposite the drag. */
export function pan(cam: Camera, dxScreen: number, dyScreen: number): Camera {
  return { ...cam, cx: cam.cx - dxScreen / cam.zoom, cy: cam.cy - dyScreen / cam.zoom };
}

/**
 * Zoom by `factor` about a screen anchor (typically the cursor), keeping the world
 * point under the anchor fixed — the natural wheel-zoom feel. `factor` > 1 zooms in.
 */
export function zoomAt(cam: Camera, factor: number, anchorX: number, anchorY: number): Camera {
  const [wx, wy] = screenToWorld(cam, anchorX, anchorY);
  const zoom = clampZoom(cam.zoom * factor);
  // Solve for the new center so (wx,wy) still maps to (anchorX,anchorY).
  const cx = wx - (anchorX - cam.viewW / 2) / zoom;
  const cy = wy - (anchorY - cam.viewH / 2) / zoom;
  return { ...cam, cx, cy, zoom };
}

/** Update the viewport size (on resize), preserving center and zoom. */
export function resize(cam: Camera, viewW: number, viewH: number): Camera {
  return { ...cam, viewW, viewH };
}

/**
 * Re-center the camera on a world point (follow-cam), preserving zoom and viewport.
 * A hard lock — no easing (SPEC.md §Visual Design: only the sim moves). The rAF loop
 * calls this each frame with the followed creature's latest position.
 */
export function centerOn(cam: Camera, wx: number, wy: number): Camera {
  return { ...cam, cx: wx, cy: wy };
}

/** Set the zoom level directly (clamped), preserving center and viewport. */
export function setZoom(cam: Camera, zoom: number): Camera {
  return { ...cam, zoom: clampZoom(zoom) };
}
