import { VIEW_H, VIEW_W } from "./config.js";

export function createCamera() {
  return { x: 0, y: 0 };
}

export function updateCamera(camera, target) {
  camera.x = target.x - VIEW_W / 2;
  camera.y = target.y - VIEW_H / 2;
}
