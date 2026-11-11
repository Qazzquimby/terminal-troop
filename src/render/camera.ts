import type { Point, ViewConfig } from "../sim/index.js";

/** How the camera frames the player. */
export interface CameraConfig {
  /** Zoom-out factor the camera settles at: 1 shows the view at 1:1, larger shows more world. */
  readonly zoom: number;
  /** Rate, per second, at which the zoom eases towards `zoom`. */
  readonly zoomRate: number;
}

/** The top-left corner of the view in world space, the view's size, and its zoom. */
export interface Camera extends Point {
  readonly view: ViewConfig;
  readonly config: CameraConfig;
  /** Zoom-out factor: 1 shows the view at 1:1, larger shows more world. */
  zoom: number;
}

/** A camera at 1:1, about to ease out to its configured zoom. */
export function createCamera(view: ViewConfig, config: CameraConfig): Camera {
  return { x: 0, y: 0, view, config, zoom: 1 };
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

/** Eases the zoom over `dt` seconds, then centres the view on `target`. */
export function updateCamera(camera: Camera, target: Point, dt: number): void {
  const { zoom, zoomRate } = camera.config;
  camera.zoom += (zoom - camera.zoom) * (1 - Math.exp(-zoomRate * dt));
  const halfWidth = (camera.view.width * camera.zoom) / 2;
  const halfHeight = (camera.view.height * camera.zoom) / 2;
  camera.x = target.x - halfWidth;
  camera.y = target.y - halfHeight;
}
