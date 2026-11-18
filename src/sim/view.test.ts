import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { createSession, viewOf } from "./index.js";

test("a point shows on the screen just where a body that small would", () => {
  const game = createSession(
    "me",
    "ME",
    "VIEW",
    "dev",
    testSfx(),
    testSimConfig,
  );
  Object.assign(game.local, { x: 300, y: 300, prevX: 300, prevY: 300 });
  const view = viewOf(game, game.local);
  let shown = 0;
  let hidden = 0;
  for (let distance = 20; distance <= 900; distance += 40)
    for (let turn = 0; turn < 16; turn++) {
      const angle = (turn / 16) * Math.PI * 2;
      const point = {
        x: 300 + Math.cos(angle) * distance,
        y: 300 + Math.sin(angle) * distance,
      };
      const sees = view.sees(point);
      expect(sees).toBe(view.shows({ ...point, radius: 0 }));
      if (sees) shown++;
      else hidden++;
    }
  // Both kinds came up, so the test compared something.
  expect(shown).toBeGreaterThan(0);
  expect(hidden).toBeGreaterThan(0);
});
