import type { Point, ViewConfig } from "../sim/index.js";

/** How the camera frames the player. */
export interface CameraConfig {
  /** Zoom-out factor the camera settles at: 1 shows the view at 1:1, larger shows more world. */
  readonly zoom: number;
  /** Rate, per second, at which the zoom eases towards `zoom`. */
  readonly zoomRate: number;
  /** Rate, per second, at which the view's centre eases towards its target. */
  readonly followRate: number;
  /** A target further than this, in pixels, from the view's centre is jumped to, not eased to. */
  readonly snapDistance: number;
}

/** The top-left corner of the view in world space, the view's size, and its zoom. */
export interface Camera extends Point {
  readonly view: ViewConfig;
  readonly config: CameraConfig;
  /** Zoom-out factor: 1 shows the view at 1:1, larger shows more world. */
  zoom: number;
  /** The world point the view is centred on; null until it first has a target. */
  focus: Point | null;
}

/** A camera at 1:1, about to ease out to its configured zoom. */
export function createCamera(view: ViewConfig, config: CameraConfig): Camera {
  return { x: 0, y: 0, view, config, zoom: 1, focus: null };
}

/**
 * The world point under `point`, given in view (CSS pixel) space. Inverts the scale/translate
 * that `draw` applies, so it stays correct at any zoom.
 */
export function screenToWorld(camera: Camera, point: Point): Point {
  return {
    x: camera.x + point.x * camera.zoom,
    y: camera.y + point.y * camera.zoom,
  };
}

/** Eases a fraction of the way from `from` to `to` set by `rate` per second over `dt` seconds. */
function ease(from: number, to: number, rate: number, dt: number): number {
  return from + (to - from) * (1 - Math.exp(-rate * dt));
}

/** Points the view's corner at its focus, at its zoom. */
function frame(camera: Camera, focus: Point): void {
  camera.focus = { x: focus.x, y: focus.y };
  camera.x = focus.x - (camera.view.width * camera.zoom) / 2;
  camera.y = focus.y - (camera.view.height * camera.zoom) / 2;
}

/**
 * Eases the zoom and the view's centre towards `target` over `dt` seconds. A camera with no
 * focus yet, or one further than its snap distance from `target`, jumps straight to it.
 */
export function updateCamera(camera: Camera, target: Point, dt: number): void {
  const { zoom, zoomRate, followRate, snapDistance } = camera.config;
  camera.zoom = ease(camera.zoom, zoom, zoomRate, dt);
  const { focus } = camera;
  if (
    focus === null ||
    Math.hypot(target.x - focus.x, target.y - focus.y) > snapDistance
  ) {
    frame(camera, target);
    return;
  }
  frame(camera, {
    x: ease(focus.x, target.x, followRate, dt),
    y: ease(focus.y, target.y, followRate, dt),
  });
}

/** Centres the view on `target` at once, as on entering a room. */
export function snapCamera(camera: Camera, target: Point): void {
  frame(camera, target);
}
