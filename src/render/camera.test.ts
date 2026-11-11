import { expect, test } from "vitest";
import {
  createCamera,
  screenToWorld,
  setZoomTarget,
  updateCamera,
  zoomRange,
} from "./camera.js";

test("camera centers its target even at the world boundary", () => {
  const camera = createCamera({ width: 900, height: 600 });
  camera.zoom = 1;
  camera.targetZoom = 1;
  updateCamera(camera, { x: 14, y: 14 });
  expect(camera).toMatchObject({ x: 14 - 450, y: 14 - 300 });
});

test("camera eases its zoom toward the target", () => {
  const camera = createCamera({ width: 900, height: 600 });
  camera.targetZoom = 2;
  updateCamera(camera, { x: 0, y: 0 });
  expect(camera.zoom).toBeGreaterThan(1);
  expect(camera.zoom).toBeLessThan(2);
});

test("zoom range fits the sight radius, never zooms in past 1:1, and is capped", () => {
  const view = { width: 900, height: 600 };
  expect(zoomRange(view, 100).max).toBe(1);
  expect(zoomRange(view, 600).max).toBe(2);
  expect(zoomRange(view, 10000, 4).max).toBe(4);
});

test("setZoomTarget clamps to the range", () => {
  const camera = createCamera({ width: 900, height: 600 });
  const range = { min: 1, max: 2 };
  setZoomTarget(camera, 5, range);
  expect(camera.targetZoom).toBe(2);
  setZoomTarget(camera, 0.5, range);
  expect(camera.targetZoom).toBe(1);
});

test("screenToWorld inverts the view transform at any zoom", () => {
  const camera = createCamera({ width: 900, height: 600 });
  camera.zoom = 2;
  updateCamera(camera, { x: 1000, y: 800 });

  expect(screenToWorld(camera, { x: 450, y: 300 })).toEqual({
    x: 1000,
    y: 800,
  });
  expect(screenToWorld(camera, { x: 0, y: 0 })).toEqual({
    x: camera.x,
    y: camera.y,
  });
});
