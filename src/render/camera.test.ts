import { expect, test } from "vitest";
import {
  createCamera,
  screenToWorld,
  snapCamera,
  updateCamera,
} from "./camera.js";

const view = { width: 900, height: 600 };

test("camera centers its target even at the world boundary", () => {
  const camera = createCamera(view, {
    zoom: 1,
    zoomRate: 10,
    followRate: 10,
    snapDistance: 200,
  });
  updateCamera(camera, { x: 14, y: 14 }, 1 / 60);
  expect(camera).toMatchObject({ x: 14 - 450, y: 14 - 300 });
});

test("camera eases its zoom toward the configured zoom", () => {
  const camera = createCamera(view, {
    zoom: 2,
    zoomRate: 10,
    followRate: 10,
    snapDistance: 200,
  });
  updateCamera(camera, { x: 0, y: 0 }, 1 / 60);
  expect(camera.zoom).toBeGreaterThan(1);
  expect(camera.zoom).toBeLessThan(2);
});

test("the zoom eases by elapsed time, however it is split into frames", () => {
  const config = { zoom: 2, zoomRate: 10, followRate: 10, snapDistance: 200 };
  const fast = createCamera(view, config);
  for (let frame = 0; frame < 12; frame++)
    updateCamera(fast, { x: 0, y: 0 }, 1 / 120);
  const slow = createCamera(view, config);
  for (let frame = 0; frame < 3; frame++)
    updateCamera(slow, { x: 0, y: 0 }, 1 / 30);
  expect(fast.zoom).toBeCloseTo(slow.zoom, 10);
});

test("no time passing leaves the zoom as it is", () => {
  const camera = createCamera(view, {
    zoom: 2,
    zoomRate: 10,
    followRate: 10,
    snapDistance: 200,
  });
  updateCamera(camera, { x: 0, y: 0 }, 0);
  expect(camera.zoom).toBe(1);
});

test("screenToWorld inverts the view transform at any zoom", () => {
  const camera = createCamera(view, {
    zoom: 2,
    zoomRate: 10,
    followRate: 10,
    snapDistance: 200,
  });
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

const follow = { zoom: 1, zoomRate: 10, followRate: 10, snapDistance: 200 };
const centre = (camera: ReturnType<typeof createCamera>) =>
  screenToWorld(camera, { x: view.width / 2, y: view.height / 2 });

test("the view's centre trails a moving target, closing the gap over time", () => {
  const camera = createCamera(view, follow);
  updateCamera(camera, { x: 100, y: 100 }, 1 / 60);
  expect(centre(camera)).toEqual({ x: 100, y: 100 });
  updateCamera(camera, { x: 150, y: 100 }, 1 / 60);
  const { x } = centre(camera);
  expect(x).toBeGreaterThan(100);
  expect(x).toBeLessThan(150);
  for (let frame = 0; frame < 120; frame++)
    updateCamera(camera, { x: 150, y: 100 }, 1 / 60);
  expect(centre(camera).x).toBeCloseTo(150);
});

test("following eases by elapsed time, however it is split into frames", () => {
  const fast = createCamera(view, follow);
  const slow = createCamera(view, follow);
  updateCamera(fast, { x: 0, y: 0 }, 0);
  updateCamera(slow, { x: 0, y: 0 }, 0);
  for (let frame = 0; frame < 12; frame++)
    updateCamera(fast, { x: 80, y: -40 }, 1 / 120);
  for (let frame = 0; frame < 3; frame++)
    updateCamera(slow, { x: 80, y: -40 }, 1 / 30);
  expect(fast.x).toBeCloseTo(slow.x, 10);
  expect(fast.y).toBeCloseTo(slow.y, 10);
});

test("a target further off than the snap distance is cut to, not eased to", () => {
  const camera = createCamera(view, follow);
  updateCamera(camera, { x: 0, y: 0 }, 1 / 60);
  updateCamera(camera, { x: 1000, y: 0 }, 1 / 60);
  expect(centre(camera)).toEqual({ x: 1000, y: 0 });
});

test("entering a room snaps the view to the player, however near the old view was", () => {
  const camera = createCamera(view, follow);
  updateCamera(camera, { x: 0, y: 0 }, 1 / 60);
  snapCamera(camera, { x: 120, y: 30 });
  expect(centre(camera)).toEqual({ x: 120, y: 30 });
  updateCamera(camera, { x: 120, y: 30 }, 1 / 60);
  expect(centre(camera)).toEqual({ x: 120, y: 30 });
});

test("the mouse maps to the world through the trailing camera it is drawn with", () => {
  const camera = createCamera(view, { ...follow, zoom: 2 });
  camera.zoom = 2;
  updateCamera(camera, { x: 0, y: 0 }, 0);
  updateCamera(camera, { x: 60, y: 0 }, 1 / 60);
  const { x } = centre(camera);
  expect(x).toBeLessThan(60);
  expect(
    screenToWorld(camera, { x: view.width / 2 + 10, y: view.height / 2 }),
  ).toEqual({
    x: x + 20,
    y: 0,
  });
});
