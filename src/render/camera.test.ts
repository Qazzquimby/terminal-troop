import { expect, test } from "vitest";
import {
  createCamera,
  screenToWorldDirection,
  screenToWorld,
  snapCamera,
  updateCamera,
  worldToScreen,
} from "./camera.js";

const view = { width: 900, height: 600 };
const roll = { rate: 10, anchor: 0.6 };

test("camera centers its target even at the world boundary", () => {
  const camera = createCamera(view, {
    zoom: 1,
    zoomRate: 10,
    followRate: 10,
    snapDistance: 200,
    roll,
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
    roll,
  });
  updateCamera(camera, { x: 0, y: 0 }, 1 / 60);
  expect(camera.zoom).toBeGreaterThan(1);
  expect(camera.zoom).toBeLessThan(2);
});

test("the zoom eases by elapsed time, however it is split into frames", () => {
  const config = {
    zoom: 2,
    zoomRate: 10,
    followRate: 10,
    snapDistance: 200,
    roll,
  };
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
    roll,
  });
  updateCamera(camera, { x: 0, y: 0 }, 0);
  expect(camera.zoom).toBe(1);
});

test("a zoom scale eases the camera to its configured zoom times the scale, and back without", () => {
  const camera = createCamera(view, {
    zoom: 1.5,
    zoomRate: 10,
    followRate: 10,
    snapDistance: 200,
    roll,
  });
  for (let frame = 0; frame < 600; frame++)
    updateCamera(camera, { x: 0, y: 0 }, 1 / 60, 2);
  expect(camera.zoom).toBeCloseTo(3, 5);
  for (let frame = 0; frame < 600; frame++)
    updateCamera(camera, { x: 0, y: 0 }, 1 / 60);
  expect(camera.zoom).toBeCloseTo(1.5, 5);
});

test("screenToWorld inverts the view transform at any zoom", () => {
  const camera = createCamera(view, {
    zoom: 2,
    zoomRate: 10,
    followRate: 10,
    snapDistance: 200,
    roll,
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

const follow = {
  zoom: 1,
  zoomRate: 10,
  followRate: 10,
  snapDistance: 200,
  roll,
};
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

const settled = (
  camera: ReturnType<typeof createCamera>,
  facing: number | null,
  scale = 1,
) => {
  for (let frame = 0; frame < 600; frame++)
    updateCamera(camera, { x: 500, y: 400 }, 1 / 60, scale, facing);
};

test("a turning camera puts the facing at the top of the screen, the eye down the view", () => {
  const camera = createCamera(view, follow);
  settled(camera, 0.3);
  const eye = worldToScreen(camera, { x: 500, y: 400 });
  expect(eye.x).toBeCloseTo(view.width / 2);
  expect(eye.y).toBeCloseTo(view.height * roll.anchor);
  const ahead = worldToScreen(camera, {
    x: 500 + Math.cos(0.3) * 50,
    y: 400 + Math.sin(0.3) * 50,
  });
  expect(ahead.x).toBeCloseTo(eye.x);
  expect(ahead.y).toBeCloseTo(eye.y - 50);
});

test("the mouse maps to the world through a turned, zoomed view", () => {
  const camera = createCamera(view, follow);
  settled(camera, 2.1, 1.7);
  for (const point of [
    { x: 0, y: 0 },
    { x: 123, y: 456 },
    { x: 900, y: 600 },
  ]) {
    const back = worldToScreen(camera, screenToWorld(camera, point));
    expect(back.x).toBeCloseTo(point.x);
    expect(back.y).toBeCloseTo(point.y);
  }
  // Up the screen is the facing, whatever the zoom.
  const up = screenToWorldDirection(camera, { x: 0, y: -1 });
  expect(Math.atan2(up.y, up.x)).toBeCloseTo(2.1);
});

test("the camera's box holds every corner of a turned view", () => {
  const camera = createCamera(view, follow);
  settled(camera, 1);
  for (const corner of [
    { x: 0, y: 0 },
    { x: view.width, y: 0 },
    { x: 0, y: view.height },
    { x: view.width, y: view.height },
  ]) {
    const at = screenToWorld(camera, corner);
    expect(at.x).toBeGreaterThanOrEqual(camera.x - 1e-6);
    expect(at.y).toBeGreaterThanOrEqual(camera.y - 1e-6);
    expect(at.x).toBeLessThanOrEqual(camera.x + camera.width + 1e-6);
    expect(at.y).toBeLessThanOrEqual(camera.y + camera.height + 1e-6);
  }
  expect(camera.width).toBeGreaterThan(view.width);
});

test("the turn eases the shorter way round, and back upright once it stops", () => {
  const camera = createCamera(view, follow);
  // Facing up already: no turn.
  settled(camera, -Math.PI / 2);
  expect(camera.roll).toBeCloseTo(0);
  // Facing just past straight down: a turn clockwise is short of a half turn, so it goes that way.
  updateCamera(camera, { x: 500, y: 400 }, 1 / 60, 1, Math.PI / 2 + 0.1);
  expect(camera.roll).toBeGreaterThan(0);
  updateCamera(camera, { x: 500, y: 400 }, 0, 1, Math.PI / 2 - 0.1);
  settled(camera, Math.PI / 2 - 0.1);
  expect(camera.roll).toBeCloseTo(-Math.PI + 0.1);
  settled(camera, null);
  expect(camera.roll).toBe(0);
  expect(camera.anchor).toBe(0.5);
  expect(camera.x).toBe(500 - view.width / 2);
});
