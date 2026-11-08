import { VIEW_H, VIEW_W } from "./config.js";
import type { Point, World } from "./map.js";

export function createCamera(): Point {
  return { x: 0, y: 0 };
}

/** Centres `target`, except along an axis where the whole world fits the view: that axis centres the world. */
export function updateCamera(
  camera: Point,
  target: Point,
  world: Pick<World, "W" | "H">,
): void {
  camera.x = (world.W <= VIEW_W ? world.W / 2 : target.x) - VIEW_W / 2;
  camera.y = (world.H <= VIEW_H ? world.H / 2 : target.y) - VIEW_H / 2;
}
