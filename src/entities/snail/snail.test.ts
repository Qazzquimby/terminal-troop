import { expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createPlayer,
  createSession,
  hurtPlayer,
  inRect,
  mulberry32,
  registerContent,
  registerEntityType,
  removePlayer,
  spawnEntity,
  stun,
  updateSession,
} from "../../sim/index.js";
import type { Player, Session, WorldEntity } from "../../sim/index.js";
import { entityContent } from "../index.js";
import { freshZombie, zombie as zombieContent } from "../zombie/index.js";
import {
  freshSnail,
  quarryName,
  snail as snailContent,
  SnailState,
} from "./index.js";
import type { SnailConfig } from "./index.js";

const DT = 1 / 60;
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
/** Seconds into a world before the spawner may bring the test snail. */
const ARRIVES_AFTER = 10;

/** The test snail, which the spawner may bring 10 seconds into a world. */
const config: SnailConfig = {
  ...testEntitiesConfig.snail,
  spawning: {
    ...testEntitiesConfig.snail.spawning,
    weight: 1,
    after: ARRIVES_AFTER,
  },
};

/** A session of `kind`, with zombies and the snail; the player stands at (x, y). */
function world(kind: "dev" | "standard", x = 750, y = 300): Session {
  const game = createSession(
    "me",
    "ME",
    "SNAIL",
    kind,
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    zombieContent.create(testEntitiesConfig),
    snailContent.create({ snail: config }),
  ]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  return game;
}

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

function snailAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(game, "snail", x, y, freshSnail("me", game.worldTime));
}

test("a snail creeps straight for its player at a fifth of a player's pace", () => {
  const game = world("dev");
  const snail = snailAt(game, 400, 300);
  run(game, 1);
  const speed = testSimConfig.player.speed * config.speedShare;
  expect(Math.hypot(snail.vx, snail.vy)).toBeCloseTo(speed);
  expect(snail.vx).toBeGreaterThan(0);
  expect(snail.x).toBeCloseTo(400 + speed, -1);
});

test("a snail that touches a player deals it a killing blow", () => {
  const game = world("dev", 430, 300);
  snailAt(game, 400, 300);
  run(game, 0.2);
  expect(game.local.health).toBe(0);
});

test("a snail kills a zombie it touches, and nothing kills it", () => {
  const game = world("dev");
  const snail = snailAt(game, 400, 300);
  const zombie = spawnEntity(
    game,
    "zombie",
    420,
    300,
    freshZombie(1, game.worldTime, testEntitiesConfig.zombie),
  );
  stun(game, zombie.id, 10);
  run(game, 0.2);
  expect(game.entities.has(zombie.id)).toBe(false);

  snail.health -= 1_000_000;
  run(game, 0.2);
  expect(game.entities.has(snail.id)).toBe(true);
});

test("a stunned snail stays put", () => {
  const game = world("dev");
  const snail = snailAt(game, 400, 300);
  stun(game, snail.id, 1);
  run(game, 0.5);
  expect(snail.x).toBe(400);
  run(game, 1);
  expect(snail.x).toBeGreaterThan(400);
});

test("a snail with no player to follow picks another, or stands", () => {
  const game = world("dev");
  const snail = spawnEntity(
    game,
    "snail",
    400,
    300,
    freshSnail("gone", game.worldTime),
  );
  run(game, 0.5);
  expect(SnailState.parse(snail.data).quarry).toBe("me");
});

test("snails come through the spawner once their time has come, out of the start and far from the players, after a player", () => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(3));
  const game = createSession(
    "me",
    "ME",
    "SNAIL",
    "standard",
    testSfx(),
    testSimConfig,
  );
  registerContent(
    game,
    entityContent({
      ...testEntitiesConfig,
      spawner: { period: 5, nothing: 0, certainAfter: 1, headStart: 60 },
      snail: config,
    }),
  );
  for (const content of game.contents) content.populate(game);
  Object.assign(game.local, { x: game.rally.x, y: game.rally.y });
  const snails = () =>
    [...game.entities.values()].filter(
      (entity) => entity.kind === game.kindIds.get("snail"),
    );
  // Its time has not come as the world starts, so its head start brings none.
  expect(snails()).toHaveLength(0);
  run(game, ARRIVES_AFTER - 1);
  expect(snails()).toHaveLength(0);
  const known = new Set(game.entities.keys());
  for (let step = 0; step < Math.round(15 / DT); step++) {
    updateSession(game, idle, DT);
    for (const arrived of snails()) {
      if (known.has(arrived.id)) continue;
      known.add(arrived.id);
      expect(inRect(game.world.layout.start, arrived)).toBe(false);
      expect(
        Math.hypot(arrived.x - game.local.x, arrived.y - game.local.y),
      ).toBeGreaterThanOrEqual(config.spawning.unseenDistance);
    }
  }
  vi.restoreAllMocks();
  // No longer one at a time: each roll brings another.
  expect(snails().length).toBeGreaterThan(1);
  // Each picks the player to follow.
  for (const arrived of snails())
    expect(SnailState.parse(arrived.data).quarry).toBe("me");
});

/** A post at (x, y): a body with no eyes nor will of its own, neither player nor monster. */
function postAt(game: Session, x: number, y: number): WorldEntity {
  if (!game.kindIds.has("post"))
    registerEntityType(game, "post", {
      radius: 10,
      maxHealth: 100,
      data: z.object({}),
      draw: () => undefined,
    });
  return spawnEntity(game, "post", x, y, {});
}

/** Another player, `id`, standing at (x, y) in `game`. */
function otherAt(game: Session, id: string, x: number, y: number): Player {
  const other = createPlayer(id, id.toUpperCase(), { x, y }, testSimConfig);
  game.players.set(other.id, other);
  return other;
}

function quarryOf(snail: WorldEntity): string | null {
  return SnailState.parse(snail.data).quarry;
}

test("it picks only players, passing over nearer bodies of other kinds", () => {
  const game = world("dev", 1200, 300);
  const snail = spawnEntity(
    game,
    "snail",
    400,
    300,
    freshSnail(null, game.worldTime),
  );
  postAt(game, 440, 300);
  const zombie = spawnEntity(
    game,
    "zombie",
    360,
    300,
    freshZombie(1, game.worldTime, testEntitiesConfig.zombie),
  );
  stun(game, zombie.id, 10);
  run(game, 0.1);
  expect(quarryOf(snail)).toBe("me");
});

test("it picks another player once its own dies", () => {
  const game = world("dev", 1200, 300);
  const other = otherAt(game, "other", 200, 300);
  const snail = spawnEntity(
    game,
    "snail",
    400,
    300,
    freshSnail(other.id, game.worldTime),
  );
  run(game, 0.1);
  expect(quarryOf(snail)).toBe(other.id);
  hurtPlayer(game, other, Infinity);
  run(game, 0.1);
  expect(quarryOf(snail)).toBe("me");
});

test("it picks another player once its own leaves", () => {
  const game = world("dev", 1200, 300);
  const other = otherAt(game, "other", 200, 300);
  const snail = spawnEntity(
    game,
    "snail",
    400,
    300,
    freshSnail(other.id, game.worldTime),
  );
  run(game, 0.1);
  removePlayer(game, other.id);
  run(game, 0.1);
  expect(quarryOf(snail)).toBe("me");
});

test("with no player alive it stands, whatever other bodies are about, but still kills what it touches", () => {
  const game = world("dev");
  hurtPlayer(game, game.local, Infinity);
  const snail = snailAt(game, 400, 300);
  const post = postAt(game, 420, 300);
  postAt(game, 200, 300);
  run(game, 0.5);
  expect(quarryOf(snail)).toBeNull();
  expect(Math.hypot(snail.vx, snail.vy)).toBe(0);
  expect(game.entities.has(post.id)).toBe(false);
});

test("the name under it is its quarry's, from its synced state alone, and none without one", () => {
  // As a client reads it: the snail's state as it came over the wire.
  const game = world("dev");
  otherAt(game, "other", 200, 300);
  const sent: unknown = JSON.parse(
    JSON.stringify(freshSnail("other", game.worldTime)),
  );
  expect(quarryName(game, SnailState.parse(sent))).toBe("OTHER");
  expect(quarryName(game, freshSnail(null, game.worldTime))).toBeNull();
  expect(quarryName(game, freshSnail("gone", game.worldTime))).toBeNull();
});
