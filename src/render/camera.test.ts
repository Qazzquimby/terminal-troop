import { expect, test } from "vitest";
import { createCamera, updateCamera } from "./camera.js";

test("camera centers its target even at the world boundary", () => {
  const camera = createCamera({ width: 900, height: 600 });
  updateCamera(camera, { x: 14, y: 14 });
  expect(camera).toMatchObject({ x: 14 - 450, y: 14 - 300 });
});
