/**
 * camera.test.ts — pan/zoom + screen↔world transforms (pure math, Node env).
 */

import { describe, expect, it } from "vitest";
import {
  type Camera,
  centerOn,
  fitCamera,
  MAX_ZOOM,
  MIN_ZOOM,
  pan,
  resize,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from "../../src/render/camera";

const cam = (): Camera => ({ cx: 500, cy: 400, zoom: 2, viewW: 800, viewH: 600 });

describe("worldToScreen / screenToWorld", () => {
  it("the world center maps to the viewport center", () => {
    const c = cam();
    expect(worldToScreen(c, c.cx, c.cy)).toEqual([c.viewW / 2, c.viewH / 2]);
  });

  it("is a round-trip inverse", () => {
    const c = cam();
    for (const [wx, wy] of [
      [0, 0],
      [123, 456],
      [1000, 800],
    ]) {
      const [sx, sy] = worldToScreen(c, wx as number, wy as number);
      const [rx, ry] = screenToWorld(c, sx, sy);
      expect(rx).toBeCloseTo(wx as number, 6);
      expect(ry).toBeCloseTo(wy as number, 6);
    }
  });

  it("applies zoom as screen-pixels-per-world-unit", () => {
    const c = cam();
    const [sx] = worldToScreen(c, c.cx + 10, c.cy);
    expect(sx - c.viewW / 2).toBeCloseTo(10 * c.zoom, 6);
  });
});

describe("pan", () => {
  it("shifts the world center opposite the drag by zoom", () => {
    const c = cam();
    const p = pan(c, 100, 0); // drag right 100px
    expect(p.cx).toBeCloseTo(c.cx - 100 / c.zoom, 6);
    expect(p.cy).toBe(c.cy);
  });
});

describe("zoomAt", () => {
  it("keeps the world point under the anchor fixed", () => {
    const c = cam();
    const anchor: [number, number] = [200, 150];
    const before = screenToWorld(c, ...anchor);
    const z = zoomAt(c, 1.5, ...anchor);
    const after = screenToWorld(z, ...anchor);
    expect(after[0]).toBeCloseTo(before[0], 4);
    expect(after[1]).toBeCloseTo(before[1], 4);
    expect(z.zoom).toBeCloseTo(c.zoom * 1.5, 6);
  });

  it("clamps zoom to [MIN_ZOOM, MAX_ZOOM]", () => {
    const c = cam();
    expect(zoomAt(c, 1000, 0, 0).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(c, 0.00001, 0, 0).zoom).toBe(MIN_ZOOM);
  });
});

describe("fitCamera", () => {
  it("centers the world and fits it within the viewport", () => {
    const c = fitCamera(1000, 800, 800, 600);
    expect(c.cx).toBe(500);
    expect(c.cy).toBe(400);
    // Whole world fits: both extents map inside the viewport.
    const [x1, y1] = worldToScreen(c, 1000, 800);
    const [x0, y0] = worldToScreen(c, 0, 0);
    expect(x1 - x0).toBeLessThanOrEqual(800 + 1e-6);
    expect(y1 - y0).toBeLessThanOrEqual(600 + 1e-6);
  });

  it("respects the min zoom clamp for tiny viewports", () => {
    const c = fitCamera(100000, 100000, 10, 10);
    expect(c.zoom).toBe(MIN_ZOOM);
  });
});

describe("resize", () => {
  it("updates viewport size, preserving center and zoom", () => {
    const c = cam();
    const r = resize(c, 1024, 768);
    expect(r.viewW).toBe(1024);
    expect(r.viewH).toBe(768);
    expect(r.cx).toBe(c.cx);
    expect(r.zoom).toBe(c.zoom);
  });
});

describe("centerOn (follow-cam)", () => {
  it("re-centers on a world point, preserving zoom and viewport", () => {
    const c = cam();
    const f = centerOn(c, 123, 456);
    expect(f.cx).toBe(123);
    expect(f.cy).toBe(456);
    expect(f.zoom).toBe(c.zoom);
    expect(f.viewW).toBe(c.viewW);
    // The followed point now sits at the viewport center.
    expect(worldToScreen(f, 123, 456)).toEqual([c.viewW / 2, c.viewH / 2]);
  });
});
