import { expect, test } from "vitest";
import type { TileMap } from "../sim/index.js";
import { createCamera } from "./camera.js";
import { createZoomFit, zoomToFit } from "./zoom-fit.js";
import type { ZoomFitConfig } from "./zoom-fit.js";

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
  rate: 1000,
};

/** A room `size` cells square, walled round, of 50px cells. */
function room(size: number): TileMap {
  const solid = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const edge = row === 0 || col === 0 || row === size - 1;
      if (edge || col === size - 1) solid[row * size + col] = 1;
    }
  }
  return { cell: 50, cols: size, rows: size, solid };
}

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
  const zoom = createZoomFit({ ...fit, rate: 1 });
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
  expect(settle(200)).toBe(fit.max);
});

test("with the camera upright the zoom is left alone, unless it fits always", () => {
  const camera = createCamera(view, cameraConfig);
  const eye = { x: 75, y: 75 };
  expect(createZoomFit(fit).step(camera, room(3), eye, 1, false)).toBe(1);
  const always = createZoomFit({ ...fit, always: true });
  always.step(camera, room(3), eye, 1, false);
  expect(always.step(camera, room(3), eye, 1, false)).toBeLessThan(1);
});
