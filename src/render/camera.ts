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
  return [(wx - cam.cx) * cam.zoom + cam.viewW / 2, (wy - cam.cy) * cam.zoom + cam.viewH / 2];
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
