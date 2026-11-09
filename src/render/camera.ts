import { VIEW_H, VIEW_W } from "../sim/index.js";
import type { Point } from "../sim/index.js";

export function createCamera(): Point {
  return { x: 0, y: 0 };
}

export function updateCamera(camera: Point, target: Point): void {
  camera.x = target.x - VIEW_W / 2;
  camera.y = target.y - VIEW_H / 2;
}
