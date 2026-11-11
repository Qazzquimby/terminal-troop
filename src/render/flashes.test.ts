import { expect, test } from "vitest";
import { createSession, showFlash } from "../sim/index.js";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import type { FlashConfig } from "./flashes.js";
import { createFlashes, flashDisc } from "./flashes.js";

const config: FlashConfig = {
  duration: 0.2,
  start: 0.5,
  fill: 0.3,
  width: 2,
  colour: { hit: "red", miss: "grey" },
};

function session() {
  return createSession("me", "ME", "FLASH", "dev", testSfx(), testSimConfig);
}

test("keeps each flash shown in a step until its time is up", () => {
  const game = session();
  const flashes = createFlashes(config);
  showFlash(game, { at: { x: 10, y: 20 }, radius: 18, hit: true });
  flashes.see(game, 1000);
  expect(flashes.list).toEqual([
    { at: { x: 10, y: 20 }, radius: 18, hit: true, startedAt: 1000 },
  ]);
  game.flashes.length = 0;
  flashes.see(game, 1199);
  expect(flashes.list).toHaveLength(1);
  flashes.see(game, 1200);
  expect(flashes.list).toEqual([]);
});

test("clearing drops every flash", () => {
  const game = session();
  const flashes = createFlashes(config);
  showFlash(game, { at: { x: 0, y: 0 }, radius: 10, hit: false });
  flashes.see(game, 0);
  flashes.clear();
  expect(flashes.list).toEqual([]);
});

test("a flash swells from its start size to the blow's radius as it fades, coloured by whether it hit", () => {
  const flash = { at: { x: 5, y: 6 }, radius: 20, hit: false, startedAt: 1000 };
  expect(flashDisc(flash, 999, config)).toBeNull();
  expect(flashDisc(flash, 1000, config)).toEqual({
    x: 5,
    y: 6,
    radius: 10,
    fade: 1,
    colour: "grey",
  });
  expect(flashDisc(flash, 1100, config)).toMatchObject({
    radius: 15,
    fade: 0.5,
  });
  expect(flashDisc({ ...flash, hit: true }, 1100, config)?.colour).toBe("red");
  expect(flashDisc(flash, 1200, config)).toBeNull();
});
