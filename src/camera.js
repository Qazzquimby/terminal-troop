import { VIEW_H, VIEW_W } from "./config.js";

function follow(target, view, size) {
  if (size <= view) return (size - view) / 2;
  return Math.max(0, Math.min(size - view, target - view / 2));
}

export function createCamera() {
  return { x: 0, y: 0 };
}

export function updateCamera(camera, world, target) {
  camera.x = follow(target.x, VIEW_W, world.W);
  camera.y = follow(target.y, VIEW_H, world.H);
}
