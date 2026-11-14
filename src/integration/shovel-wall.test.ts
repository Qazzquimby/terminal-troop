import { expect, test, vi } from "vitest";
import { itemContent } from "../items/index.js";
import { PLAYER_TAG } from "../sim/index.js";
import type { Controls, Point } from "../sim/index.js";
import { crew, idle, sessionOf } from "./crew.js";
import { testItemsConfig } from "./sim-config.js";

const { shovel } = testItemsConfig;
/** Just left of the dev square's pillar at x 200..300, y 50..150: a swing right reaches it. */
const BY_WALL = { x: 150, y: 100 };
/** Open floor, nothing in reach. */
const OPEN = { x: 450, y: 300 };

/** The noises the host's player made over half a second of swinging right from `at`. */
async function swingFrom(at: Point) {
  const made = await crew(
    { spots: { a: at }, content: itemContent(testItemsConfig) },
    "a",
  );
  const game = sessionOf(made.room("a"));
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  const swing: Controls = {
    ...idle,
    use: true,
    aim: { x: at.x + 1000, y: at.y },
  };
  const noises: unknown[] = [];
  made.step({ a: swing });
  for (let step = 0; step < 30; step++) {
    noises.push(...game.noises);
    made.step();
  }
  return noises;
}

test("a swing that hits a wall clangs: a noise out to the wall radius", async () => {
  expect(await swingFrom(BY_WALL)).toContainEqual(
    expect.objectContaining({
      radius: shovel.wallNoiseRadius,
      source: "a",
      tags: [PLAYER_TAG],
    }),
  );
});

test("a swing at thin air only whooshes", async () => {
  const noises = await swingFrom(OPEN);
  expect(noises).toContainEqual(
    expect.objectContaining({ radius: shovel.missNoiseRadius }),
  );
  expect(noises).not.toContainEqual(
    expect.objectContaining({ radius: shovel.wallNoiseRadius }),
  );
});
