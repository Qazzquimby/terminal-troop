import { expect, test } from "vitest";
import { VIEW_H, VIEW_W } from "../sim/index.js";
import { createCamera, updateCamera } from "./camera.js";

test("camera centers its target even at the world boundary", () => {
  const camera = createCamera();
  updateCamera(camera, { x: 14, y: 14 });
  expect(camera).toEqual({ x: 14 - VIEW_W / 2, y: 14 - VIEW_H / 2 });
});
