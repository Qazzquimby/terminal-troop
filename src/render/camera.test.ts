import { expect, test } from "vitest";
import { createCamera, screenToWorld, updateCamera } from "./camera.js";

const view = { width: 900, height: 600 };

test("camera centers its target even at the world boundary", () => {
  const camera = createCamera(view, { zoom: 1, zoomRate: 10 });
  updateCamera(camera, { x: 14, y: 14 }, 1 / 60);
  expect(camera).toMatchObject({ x: 14 - 450, y: 14 - 300 });
});

test("camera eases its zoom toward the configured zoom", () => {
  const camera = createCamera(view, { zoom: 2, zoomRate: 10 });
  updateCamera(camera, { x: 0, y: 0 }, 1 / 60);
  expect(camera.zoom).toBeGreaterThan(1);
  expect(camera.zoom).toBeLessThan(2);
});

test("the zoom eases by elapsed time, however it is split into frames", () => {
  const config = { zoom: 2, zoomRate: 10 };
  const fast = createCamera(view, config);
  for (let frame = 0; frame < 12; frame++)
    updateCamera(fast, { x: 0, y: 0 }, 1 / 120);
  const slow = createCamera(view, config);
  for (let frame = 0; frame < 3; frame++)
    updateCamera(slow, { x: 0, y: 0 }, 1 / 30);
  expect(fast.zoom).toBeCloseTo(slow.zoom, 10);
});

test("no time passing leaves the zoom as it is", () => {
  const camera = createCamera(view, { zoom: 2, zoomRate: 10 });
  updateCamera(camera, { x: 0, y: 0 }, 0);
  expect(camera.zoom).toBe(1);
});

test("screenToWorld inverts the view transform at any zoom", () => {
  const camera = createCamera(view, { zoom: 2, zoomRate: 10 });
  camera.zoom = 2;
  updateCamera(camera, { x: 1000, y: 800 }, 0);

  expect(screenToWorld(camera, { x: 450, y: 300 })).toEqual({
    x: 1000,
    y: 800,
  });
  expect(screenToWorld(camera, { x: 0, y: 0 })).toEqual({
    x: camera.x,
    y: camera.y,
  });
});
