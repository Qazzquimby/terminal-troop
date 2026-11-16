import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import {
  createSession,
  engages,
  hurt,
  hurtPlayer,
  lastHurtBy,
  livingBodies,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import type { Session, WorldEntity } from "../sim/index.js";
import { landMine, layMine, mines } from "./land-mine/index.js";
import { freshZombie, zombie } from "./zombie/index.js";

/*
 * World entities act on one another only while both are within the engagement range of a living
 * player (#360); out past it they pass each other by. A player is always in play. The dev square
 * is 900 by 600, so these run on a range of 250 rather than the shipped 15 cells.
 */

const DT = 1 / 60;
const RANGE = 250;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  holdingUse: false,
  secondary: false,
  interact: false,
  drop: false,
};

/** Where the monster stands. */
const AT = { x: 400, y: 300 };
/** Near enough `AT` for what is there to be in play. */
const NEAR = { x: 450, y: 450 };
/** Too far from `AT` for what is there to be in play. */
const FAR = { x: 875, y: 575 };

/** A zombie that leaves players be, so only the post beside it draws it. */
const zombieConfig = {
  ...testEntitiesConfig.zombie,
  ignores: [...testEntitiesConfig.zombie.ignores, "player"],
};

/** The dev square, its one player standing at `at`, with zombies, mines and posts. */
function world(at: { x: number; y: number }): Session {
  const game = createSession("me", "ME", "ENGAGE", "dev", testSfx(), {
    ...testSimConfig,
    engagement: { range: RANGE },
  });
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  registerContent(game, [
    zombie.create({ zombie: zombieConfig }),
    landMine.create({ landMine: testEntitiesConfig.landMine }),
  ]);
  registerEntityType(game, "post", {
    radius: 15,
    maxHealth: 1_000,
    data: z.object({}),
    draw: () => undefined,
  });
  Object.assign(game.local, { x: at.x, y: at.y, prevX: at.x, prevY: at.y });
  return game;
}

const postAt = (game: Session, x: number, y: number): WorldEntity =>
  spawnEntity(game, "post", x, y, {});

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

/** A zombie at `AT` with a post touching it, stepped 2s; the post. */
function zombieBesidePost(game: Session): WorldEntity {
  const monster = spawnEntity(
    game,
    "zombie",
    AT.x,
    AT.y,
    freshZombie(1, 0, zombieConfig),
  );
  const post = postAt(game, AT.x + monster.radius + 28, AT.y);
  run(game, 2);
  return post;
}

describe("a monster beside another body", () => {
  test("strikes it near a living player", () => {
    const game = world(NEAR);
    const post = zombieBesidePost(game);
    expect(post.health).toBeLessThan(post.maxHealth);
  });

  test("leaves it be far from every player", () => {
    const game = world(FAR);
    const post = zombieBesidePost(game);
    expect(post.health).toBe(post.maxHealth);
    expect(lastHurtBy(game, post.id)).toBeNull();
  });

  test("leaves it be with only a ghost near", () => {
    const game = world(NEAR);
    hurtPlayer(game, game.local, Infinity);
    const post = zombieBesidePost(game);
    expect(post.health).toBe(post.maxHealth);
  });
});

describe("a hurt from one world entity to another", () => {
  test("lands when both are in play", () => {
    const game = world(NEAR);
    const a = postAt(game, AT.x, AT.y);
    const b = postAt(game, AT.x + 40, AT.y);
    hurt(game, b, 5, a.id);
    expect(b.health).toBe(b.maxHealth - 5);
    expect(lastHurtBy(game, b.id)).toBe(a.id);
  });

  test("is held back when either is out of play", () => {
    const game = world({ x: 100, y: 300 });
    const inside = postAt(game, 200, 300);
    const outside = postAt(game, 800, 300);
    hurt(game, outside, 5, inside.id);
    hurt(game, inside, 5, outside.id);
    expect(outside.health).toBe(outside.maxHealth);
    expect(inside.health).toBe(inside.maxHealth);
    expect(lastHurtBy(game, outside.id)).toBeNull();
    expect(lastHurtBy(game, inside.id)).toBeNull();
  });

  test("from no one, or a body to itself, lands anywhere", () => {
    const game = world(FAR);
    const post = postAt(game, 100, 100);
    hurt(game, post, 5, null);
    hurt(game, post, 5, post.id);
    expect(post.health).toBe(post.maxHealth - 10);
  });

  test("to or from a player is never held back", () => {
    const game = world(FAR);
    const post = postAt(game, 100, 100);
    expect(engages(game, post.id, game.local)).toBe(true);
    expect(engages(game, game.localId, post)).toBe(true);
    hurt(game, post, 5, game.localId);
    expect(post.health).toBe(post.maxHealth - 5);
  });
});

test("a world entity out of play finds the players, and none of the other world entities", () => {
  const game = world({ x: 100, y: 300 });
  const inside = postAt(game, 200, 300);
  const outside = postAt(game, 800, 300);
  const other = postAt(game, 820, 300);
  const ids = (by: string) => livingBodies(game, by).map((body) => body.id);
  expect(ids(outside.id)).toEqual([game.localId, outside.id]);
  expect(ids(inside.id)).toEqual([game.localId, inside.id]);
  expect(ids(other.id)).not.toContain(outside.id);
  expect(livingBodies(game).map((body) => body.id)).toContain(outside.id);
});

describe("an armed land mine with a body on it", () => {
  function mineUnderPost(game: Session): void {
    layMine(game, AT);
    run(game, testEntitiesConfig.landMine.armSeconds + 0.5);
    spawnEntity(game, "post", AT.x, AT.y + 20, {});
    run(game, 1);
  }

  test("goes off near a living player", () => {
    const game = world(NEAR);
    mineUnderPost(game);
    expect(mines(game)).toHaveLength(0);
  });

  test("lies still far from every player", () => {
    const game = world(FAR);
    mineUnderPost(game);
    expect(mines(game)).toHaveLength(1);
  });
});
