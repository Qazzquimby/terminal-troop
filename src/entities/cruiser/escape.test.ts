import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createPlayer,
  credit,
  createSession,
  inRect,
  registerContent,
  updateSession,
} from "../../sim/index.js";
import type { Controls, Point, Session } from "../../sim/index.js";
import type { EntitiesConfig } from "../index.js";
import { entityContent } from "../index.js";
import { departingIn, departure, hasEscaped, shortOfQuota } from "./index.js";

const DT = 1 / 60;
const DELAY = testEntitiesConfig.cruiser.escape.delay;

const still: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  secondary: false,
  interact: false,
  drop: false,
  holdingUse: false,
};

/**
 * The dev square with its cruiser and no zombies; its exit is its rightmost three columns. The
 * cruiser leaves only with `quota` credit banked.
 */
function world(quota = 0): Session {
  const { cruiser } = testEntitiesConfig;
  const entities: EntitiesConfig = {
    ...testEntitiesConfig,
    cruiser: { ...cruiser, escape: { ...cruiser.escape, quota } },
    zombie: {
      ...testEntitiesConfig.zombie,
      spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
    },
  };
  const game = createSession(
    "me",
    "ME",
    "EXIT",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, entityContent(entities));
  for (const content of game.contents) content.populate(game);
  return game;
}

function play(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, still, DT);
}

/** Puts the world's cruiser at `at`, as driving it there would. */
function placeCruiser(game: Session, at: Point): void {
  const kind = game.kindIds.get("cruiser");
  for (const entity of game.entities.values()) {
    if (entity.kind !== kind) continue;
    Object.assign(entity, { x: at.x, y: at.y, tx: at.x, ty: at.y });
  }
}

const IN_EXIT = { x: 825, y: 300 };
const BY_EXIT = { x: 825, y: 450 };
const OUTSIDE = { x: 450, y: 300 };

test("the dev square's exit is its rightmost three columns, its start its leftmost three", () => {
  const { start, exit } = world().world.layout;
  expect(exit).toEqual({ x: 750, y: 0, w: 150, h: 600 });
  expect(start).toEqual({ x: 0, y: 0, w: 150, h: 600 });
  expect(inRect(exit, IN_EXIT)).toBe(true);
  expect(inRect(exit, OUTSIDE)).toBe(false);
});

test("the cruiser starts in the start, away from the exit, and no countdown runs", () => {
  const game = world();
  play(game, DELAY + 1);
  expect(departingIn(game, DELAY)).toBeNull();
  expect(hasEscaped(game, game.local)).toBe(false);
});

test("once the cruiser waits in the exit for the delay, every player in the exit escapes, and no one else", () => {
  const game = world();
  const left = createPlayer("left", "LEFT", OUTSIDE, testSimConfig);
  const along = createPlayer("along", "ALONG", BY_EXIT, testSimConfig);
  game.players.set(left.id, left);
  game.players.set(along.id, along);
  Object.assign(game.local, IN_EXIT);
  placeCruiser(game, IN_EXIT);

  play(game, DELAY - 0.5);
  expect(departingIn(game, DELAY)).toBeCloseTo(0.5, 1);
  expect(departure.get(game).escaped).toEqual([]);

  play(game, 1);
  expect(hasEscaped(game, game.local)).toBe(true);
  expect(hasEscaped(game, along)).toBe(true);
  expect(hasEscaped(game, left)).toBe(false);
});

test("the countdown starts afresh for whoever is left, and a player escapes once", () => {
  const game = world();
  Object.assign(game.local, IN_EXIT);
  placeCruiser(game, IN_EXIT);
  play(game, DELAY + 0.5);
  expect(departure.get(game).escaped).toEqual(["me"]);
  expect(departingIn(game, DELAY)).toBeGreaterThan(DELAY - 1);
  play(game, DELAY + 0.5);
  expect(departure.get(game).escaped).toEqual(["me"]);
});

test("driving the cruiser out of the exit stops the countdown, and back in starts it again", () => {
  const game = world();
  Object.assign(game.local, IN_EXIT);
  placeCruiser(game, IN_EXIT);
  play(game, DELAY - 2);
  placeCruiser(game, OUTSIDE);
  play(game, DT);
  expect(departingIn(game, DELAY)).toBeNull();
  placeCruiser(game, IN_EXIT);
  play(game, DELAY - 2);
  expect(hasEscaped(game, game.local)).toBe(false);
  play(game, 2.5);
  expect(hasEscaped(game, game.local)).toBe(true);
});

test("only the host decides who escapes", () => {
  const game = world();
  game.hosting = false;
  Object.assign(game.local, IN_EXIT);
  placeCruiser(game, IN_EXIT);
  play(game, DELAY + 1);
  expect(departingIn(game, DELAY)).toBeNull();
  expect(hasEscaped(game, game.local)).toBe(false);
});

test("the cruiser waits in the exit until the team has its quota banked, and keeps it", () => {
  const game = world(30);
  Object.assign(game.local, IN_EXIT);
  credit.set(game, 25);
  expect(shortOfQuota(game, 30)).toBeNull();
  placeCruiser(game, IN_EXIT);
  play(game, DELAY + 1);
  expect(departingIn(game, DELAY)).toBeNull();
  expect(shortOfQuota(game, 30)).toBe(5);
  expect(hasEscaped(game, game.local)).toBe(false);

  credit.set(game, 30);
  expect(shortOfQuota(game, 30)).toBeNull();
  play(game, DELAY - 1);
  // Dropping short again, as a revival into debt would, stops the countdown.
  credit.set(game, 29);
  play(game, DT);
  expect(departingIn(game, DELAY)).toBeNull();
  credit.set(game, 30);
  play(game, DELAY + 0.5);
  expect(hasEscaped(game, game.local)).toBe(true);
  expect(credit.get(game)).toBe(30);
});
