import { expect, test } from "vitest";
import type { Point, TileMap } from "../sim/index.js";
import { createCamera } from "./camera.js";
import { createZoomFit, furthestSeen, zoomToFit } from "./zoom-fit.js";
import type { Sees, ZoomFitConfig } from "./zoom-fit.js";

const view = { width: 900, height: 600 };
const cameraConfig = {
  zoom: 1.25,
  zoomRate: 10,
  followRate: 10,
  snapDistance: 200,
  roll: { rate: 10, anchor: 0.8 },
};
const fit: ZoomFitConfig = {
  always: false,
  rays: 32,
  margin: 1,
  min: 1,
  max: 3,
  step: 25,
  interval: 0,
  deadBand: 0,
  outTime: 1e-3,
  inTime: 1e-3,
};

/** A room `cols` cells across and `rows` down, `cols` when left out, walled round, of 50px cells. */
function room(cols: number, rows = cols): TileMap {
  const solid = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const edge = row === 0 || col === 0 || row === rows - 1;
      if (edge || col === cols - 1) solid[row * cols + col] = 1;
    }
  }
  return { cell: 50, cols, rows, solid };
}

/** Shows what lies within `range` of `eye`. */
const within =
  (eye: Point, range: number): Sees =>
  (point) =>
    Math.hypot(point.x - eye.x, point.y - eye.y) <= range;

const furthest = (eye: Point, points: readonly Point[]): number =>
  Math.max(...points.map((p) => Math.hypot(p.x - eye.x, p.y - eye.y)));

test("the zoom that fits is set by the furthest point seen, ahead, sideways or behind", () => {
  const eye = { x: 0, y: 0 };
  // Upright, the eye at the middle: 300px up and 450px across fit at 1:1.
  expect(zoomToFit(view, 0, 0.5, eye, [{ x: 0, y: -600 }], 1)).toBeCloseTo(2);
  expect(zoomToFit(view, 0, 0.5, eye, [{ x: 900, y: 0 }], 1)).toBeCloseTo(2);
  expect(
    zoomToFit(
      view,
      0,
      0.5,
      eye,
      [
        { x: 0, y: -300 },
        { x: 0, y: 150 },
      ],
      1.1,
    ),
  ).toBeCloseTo(1.1);
});

test("with the eye pulled down the screen, what lies behind fits within as far as ahead", () => {
  const eye = { x: 0, y: 0 };
  // 480px of view ahead of an eye 80% down; only 120px behind it.
  expect(zoomToFit(view, 0, 0.8, eye, [{ x: 0, y: -480 }], 1)).toBeCloseTo(1);
  expect(zoomToFit(view, 0, 0.8, eye, [{ x: 0, y: 480 }], 1)).toBeCloseTo(1);
});

test("the fit follows the turn: what lies ahead is fitted up the screen", () => {
  const eye = { x: 0, y: 0 };
  // Facing the world's right (`-π/2 - 0` roll puts it at the top), a point 960px right is ahead.
  const ahead = zoomToFit(view, -Math.PI / 2, 0.8, eye, [{ x: 960, y: 0 }], 1);
  expect(ahead).toBeCloseTo(2);
});

test("the fitted zoom is kept within its bounds, and eases from the camera's own zoom", () => {
  const camera = createCamera(view, cameraConfig);
  const zoom = createZoomFit({ ...fit, outTime: 1, inTime: 1 });
  const eye = { x: 75, y: 75 };
  // A cupboard one cell square: what fits is far closer than the bound.
  const map = room(3);
  expect(zoom.step(camera, map, eye, 1 / 60, true)).toBe(1);
  const eased = zoom.step(camera, map, eye, 1 / 60, true);
  expect(eased).toBeLessThan(1);
  expect(eased * cameraConfig.zoom).toBeGreaterThan(fit.min);
  const settled = createZoomFit(fit);
  settled.step(camera, map, eye, 1, true);
  expect(settled.step(camera, map, eye, 1, true) * cameraConfig.zoom).toBe(
    fit.min,
  );
});

test("a bigger room zooms out further, up to the most it may", () => {
  const camera = createCamera(view, cameraConfig);
  const settle = (size: number) => {
    const zoom = createZoomFit(fit);
    const eye = { x: (size * 50) / 2, y: (size * 50) / 2 };
    zoom.step(camera, room(size), eye, 1, true);
    return zoom.step(camera, room(size), eye, 1, true) * cameraConfig.zoom;
  };
  expect(settle(30)).toBeGreaterThan(settle(20));
  expect(settle(200)).toBeCloseTo(fit.max);
});

test("with the camera upright the zoom is left alone, unless it fits always", () => {
  const camera = createCamera(view, cameraConfig);
  const eye = { x: 75, y: 75 };
  expect(createZoomFit(fit).step(camera, room(3), eye, 1, false)).toBe(1);
  const always = createZoomFit({ ...fit, always: true });
  always.step(camera, room(3), eye, 1, false);
  expect(always.step(camera, room(3), eye, 1, false)).toBeLessThan(1);
});

test("each ray reaches only as far as what shows, not on to the wall it ends on", () => {
  // A corridor 40 cells long, the eye at its near end.
  const map = room(40, 3);
  const eye = { x: 75, y: 75 };
  const all = furthestSeen(map, eye, 16, 5000, 25, () => true);
  expect(furthest(eye, all)).toBeGreaterThan(1800);
  const lit = furthestSeen(map, eye, 16, 5000, 25, within(eye, 300));
  expect(furthest(eye, lit)).toBeLessThanOrEqual(300);
  expect(furthest(eye, lit)).toBeGreaterThan(300 - 25);
  // What shows only past a dark stretch still counts: a lit room at the corridor's end.
  const far = furthestSeen(map, eye, 16, 5000, 25, (p) => p.x > 1500);
  expect(furthest(eye, far)).toBeGreaterThan(1800);
  // Nothing showing gives the eye itself.
  const none = furthestSeen(map, eye, 16, 5000, 25, () => false);
  expect(furthest(eye, none)).toBe(0);
});

test("down a long corridor in sight, the zoom fits only as far as it shows", () => {
  const camera = createCamera(view, cameraConfig);
  const map = room(80, 3);
  const eye = { x: 75, y: 75 };
  const settle = (sees: Sees): number => {
    const zoom = createZoomFit(fit);
    zoom.step(camera, map, eye, 1, true, () => sees);
    return (
      zoom.step(camera, map, eye, 1, true, () => sees) * camera.config.zoom
    );
  };
  expect(settle(() => true)).toBeCloseTo(fit.max);
  expect(settle(within(eye, 600))).toBeCloseTo(1.33, 1);
  expect(settle(() => false)).toBeCloseTo(fit.min);
});

/** A zoom in an open room, settled on what lies within `range` of the eye, and how to go on. */
function openRoom(config: ZoomFitConfig, range: number) {
  const camera = createCamera(view, cameraConfig);
  const map = room(100);
  const eye = { x: 2500, y: 2500 };
  const zoom = createZoomFit(config);
  const step = (reach: number, dt: number): number =>
    zoom.step(camera, map, eye, dt, true, () => within(eye, reach)) *
    camera.config.zoom;
  step(range, 1);
  for (let i = 0; i < 600; i++) step(range, 1 / 60);
  return step;
}

test("small changes in what shows, within the dead band, leave the zoom be", () => {
  // Upright with the eye mid-screen, 300px of view ahead: 450px in sight fits at 1.5.
  const step = openRoom({ ...fit, deadBand: 0.2 }, 450);
  const settled = step(450, 1 / 60);
  expect(settled).toBeCloseTo(1.5, 1);
  expect(step(495, 1)).toBe(settled);
  expect(step(405, 1)).toBe(settled);
  expect(step(675, 1)).toBeCloseTo(2.25, 1);
});

test("the zoom glides off from rest, without a jolt, and settles", () => {
  const step = openRoom({ ...fit, outTime: 1, inTime: 1 }, 450);
  const from = Math.log(step(450, 1 / 60));
  const gap = Math.log(2.25) - from;
  const first = Math.log(step(675, 1 / 60)) - from;
  // An ease at the same pace would move 1 - e^(-2/60), over 3%, of the way at once.
  expect(first).toBeGreaterThan(0);
  expect(first / gap).toBeLessThan(0.005);
  let zoom = 0;
  for (let i = 0; i < 240; i++) zoom = step(675, 1 / 60);
  expect(zoom).toBeLessThanOrEqual(2.25);
  expect((Math.log(zoom) - from) / gap).toBeGreaterThan(0.95);
});

test("it glides out quicker than back in", () => {
  const config = { ...fit, outTime: 1, inTime: 2 };
  const covered = (from: number, to: number): number => {
    const step = openRoom(config, from);
    const start = Math.log(step(from, 1 / 60));
    let zoom = 0;
    for (let i = 0; i < 60; i++) zoom = step(to, 1 / 60);
    // Upright with the eye mid-screen, 300px of view ahead.
    const end = Math.log(to / 300);
    return (Math.log(zoom) - start) / (end - start);
  };
  expect(covered(450, 675)).toBeGreaterThan(covered(675, 450));
});
