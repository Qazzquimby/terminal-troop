import type { Point, ViewConfig } from "../sim/index.js";

/** The top-left corner of the view in world space, and the view's size. */
export interface Camera extends Point {
  readonly view: ViewConfig;
}

export function createCamera(view: ViewConfig): Camera {
  return { x: 0, y: 0, view };
}

export function updateCamera(camera: Camera, target: Point): void {
  camera.x = target.x - camera.view.width / 2;
  camera.y = target.y - camera.view.height / 2;
}
