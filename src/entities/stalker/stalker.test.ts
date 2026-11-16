import { omit } from "lodash-es";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  canSeeFrom,
  createPlayer,
  createSession,
  hurt,
  hurtPlayer,
  directionalVision,
  receiveEvent,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Player, Point, Session, WorldEntity } from "../../sim/index.js";
import { freshZombie, zombie } from "../zombie/index.js";
import type { StalkerConfig } from "./index.js";
import {
  freshStalker,
  stalker as stalkerContent,
  StalkerState,
} from "./index.js";

const DT = 1 / 60;
const { stalker: config } = testEntitiesConfig;
/** The stalker, heeding any body's gaze but its own kind's rather than players' alone. */
const heedingAnyone: StalkerConfig = omit(config, "watchedBy");

/** The dev square, 18x12 cells of 50px, all dark; the local player stands at (x, y). */
function world(x: number, y: number, stalker: StalkerConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "SKULK",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  registerContent(game, [stalkerContent.create({ stalker })]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  return game;
}

/** Steps `seconds`, the local player looking at `look`, each sound the host sends heard at once. */
function run(game: Session, seconds: number, look: Point): void {
  const controls = {
    move: { x: 0, y: 0 },
    aim: look,
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
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, controls, DT);
    for (const { content, event, to, payload } of game.outbox.splice(0))
      receiveEvent(
        game,
        { from: game.localId, to, content, event, payload },
        game.localId,
      );
    for (const { event, payload, sender } of game.inbox.splice(0))
      event.receive(game, payload, sender);
  }
}

function stalkerAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(game, "stalker", x, y, freshStalker(game.worldTime));
}

const stateOf = (entity: WorldEntity): StalkerState =>
  StalkerState.parse(entity.data);

const sounded = (game: Session, file: string): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith(file));

/** Whether `player`, facing as it does, has the point `at` in its view cone, out to `range`. */
function watches(
  game: Session,
  player: Player,
  at: Point,
  range: number,
): boolean {
  const [cone] = directionalVision(
    player,
    player.aim,
    game.config.vision,
    range,
  );
  return canSeeFrom(game.world.map, cone, at);
}

test("it closes on a player faster than a walk, creeps once it sees them, and kills at a touch", () => {
  const game = world(700, 300);
  const stalker = stalkerAt(game, 150, 300);
  run(game, 0.5, { x: 900, y: 300 });

  // Still further off than it sees, it comes on at its full speed.
  expect(stateOf(stalker).mode).toBe("hunt");
  expect(stateOf(stalker).creeping).toBe(false);
  expect(stalker.vx).toBeCloseTo(config.speed);
  expect(config.speed).toBeCloseTo(testSimConfig.player.speed * 1.2);

  // In its sight, the player is crept up on at a tenth of a walk.
  run(game, 0.5, { x: 900, y: 300 });
  expect(stateOf(stalker).mode).toBe("hunt");
  expect(stateOf(stalker).creeping).toBe(true);
  expect(stalker.vx).toBeCloseTo(config.creepSpeed);
  expect(config.creepSpeed).toBeCloseTo(testSimConfig.player.speed * 0.1);
  expect(game.local.health).toBe(game.local.maxHealth);

  run(game, 20, { x: 900, y: 300 });
  expect(game.local.health).toBe(0);
  expect(sounded(game, "attack.mp3")).toBe(true);
});

test("caught in a player's gaze, it hisses and backs off home for the retreat's length, then hunts again", () => {
  const game = world(700, 300);
  const stalker = stalkerAt(game, 200, 300);
  run(game, 0.5, { x: 900, y: 300 });
  const home = stateOf(stalker).home;
  expect(home).toEqual({ x: 200, y: 300 });
  const before = stalker.x;
  expect(before).toBeGreaterThan(200);

  run(game, DT, { x: 0, y: 300 });
  expect(stateOf(stalker).mode).toBe("retreat");
  expect(sounded(game, "retreat.mp3")).toBe(true);
  run(game, 1, { x: 0, y: 300 });
  expect(stalker.x).toBeLessThan(before);
  expect(game.local.health).toBe(game.local.maxHealth);

  // Looked away from, it keeps retreating until the time is up, then hunts.
  run(game, config.retreatSeconds - 1.5, { x: 900, y: 300 });
  expect(stateOf(stalker).mode).toBe("retreat");
  run(game, 1, { x: 900, y: 300 });
  expect(stateOf(stalker).mode).toBe("hunt");
});

test("a retreat keeps its distance from a player where it can", () => {
  const game = world(700, 300);
  const stalker = stalkerAt(game, 300, 300);
  run(game, DT, { x: 0, y: 300 });
  expect(stateOf(stalker).mode).toBe("retreat");
  const start = Math.hypot(stalker.x - 700, stalker.y - 300);
  for (let i = 0; i < 60; i++) {
    run(game, DT, { x: 0, y: 300 });
    expect(Math.hypot(stalker.x - 700, stalker.y - 300)).toBeGreaterThanOrEqual(
      start - 1,
    );
  }
});

test("its hunt goes round another player's gaze, never stepping into it", () => {
  const range = 400;
  // It creeps at full speed here, to reach the local player within the test.
  const game = world(560, 560, {
    ...config,
    watchRange: range,
    creepSpeed: config.speed,
  });
  // A second player, further off, looks down and to the left; the straight way to the local
  // player crosses its view, though neither end is in it.
  const watcher = createPlayer(
    "them",
    "THEM",
    { x: 600, y: 60 },
    testSimConfig,
  );
  watcher.aim = (Math.PI * 3) / 4;
  watcher.taim = (Math.PI * 3) / 4;
  game.players.set(watcher.id, watcher);
  const stalker = stalkerAt(game, 60, 300);
  const crossing = { x: 400, y: 404 };
  expect(watches(game, watcher, crossing, range)).toBe(true);

  for (let i = 0; i < 240 && game.local.health > 0; i++) {
    run(game, DT, { x: 900, y: 560 });
    expect(stateOf(stalker).mode).toBe("hunt");
    expect(watches(game, watcher, stalker, range)).toBe(false);
  }
  expect(game.local.health).toBe(0);
});

test("hurt, it shrieks and rages at the nearest living thing, watched or not, then hunts again", () => {
  const game = world(700, 300);
  const stalker = stalkerAt(game, 400, 300);
  run(game, DT, { x: 0, y: 300 });
  expect(stateOf(stalker).mode).toBe("retreat");

  hurt(game, stalker, 15, game.localId);
  run(game, DT, { x: 0, y: 300 });
  expect(stateOf(stalker).mode).toBe("enraged");
  expect(sounded(game, "enraged.mp3")).toBe(true);
  run(game, 1.5, { x: 0, y: 300 });
  expect(game.local.health).toBe(0);

  run(game, config.enragedSeconds, { x: 0, y: 300 });
  expect(stateOf(stalker).mode).toBe("hunt");
});

test("hurt by a zombie, it rages at the player it targets rather than the zombie", () => {
  const game = world(650, 300);
  registerContent(game, [zombie.create(testEntitiesConfig)]);
  const stalker = stalkerAt(game, 400, 300);
  const biter = spawnEntity(
    game,
    "zombie",
    100,
    300,
    freshZombie(1, 0, testEntitiesConfig.zombie),
  );
  hurt(game, stalker, 15, biter.id);
  run(game, DT, { x: 900, y: 300 });
  expect(stateOf(stalker).mode).toBe("enraged");
  expect(stateOf(stalker).foe).toBeNull();
  expect(stalker.vx).toBeGreaterThan(0);
});

test("it passes over a nearer body that is not a player and stalks the player", () => {
  const game = world(650, 300);
  const stalker = stalkerAt(game, 400, 300);
  const post = lookoutAt(game, 300, 300, 0);
  run(game, 0.5, { x: 900, y: 300 });
  expect(stateOf(stalker).mode).toBe("hunt");
  expect(stalker.vx).toBeGreaterThan(0);
  expect(post.health).toBe(1000);
});

/**
 * A body with eyes but no will at (x, y), looking left down a player's cone out to `range`, or
 * blind for 0, which a stalker hunts like any other.
 */
function lookoutAt(
  game: Session,
  x: number,
  y: number,
  range: number,
): WorldEntity {
  if (!game.kindIds.has("lookout"))
    registerEntityType(game, "lookout", {
      radius: 10,
      maxHealth: 1000,
      data: z.object({ range: z.number() }),
      eyes: (_entity, state) => ({
        cone: { direction: Math.PI, angle: Math.PI / 2, range: state.range },
        around: 0,
      }),
      draw: () => undefined,
    });
  return spawnEntity(game, "lookout", x, y, { range });
}

test("with no player about, it leaves other bodies be, but strikes one it touches", () => {
  const game = world(100, 550);
  hurtPlayer(game, game.local, Infinity);
  const stalker = stalkerAt(game, 650, 300);
  const far = lookoutAt(game, 200, 300, 0);
  const touched = lookoutAt(game, 670, 300, 0);
  run(game, 2.5, { x: 900, y: 300 });
  expect(stateOf(stalker).mode).toBe("hunt");
  expect(Math.abs(stalker.x - 650)).toBeLessThan(10);
  expect(far.health).toBe(1000);
  expect(touched.health).toBeLessThan(1000);
});

test("a body that is not a player looking at it does not send it back", () => {
  const game = world(100, 550);
  hurtPlayer(game, game.local, Infinity);
  const stalker = stalkerAt(game, 500, 300);
  lookoutAt(game, 700, 300, 300);
  run(game, DT, { x: 900, y: 300 });
  expect(stateOf(stalker).mode).toBe("hunt");
});

test("heeding any body's gaze, any body's sends it back, as far as that body looks", () => {
  const game = world(100, 550, heedingAnyone);
  hurtPlayer(game, game.local, Infinity);
  const near = stalkerAt(game, 500, 300);
  const far = stalkerAt(game, 300, 100);
  lookoutAt(game, 700, 300, 300);
  lookoutAt(game, 700, 100, 300);
  run(game, DT, { x: 900, y: 300 });
  expect(stateOf(near).mode).toBe("retreat");
  expect(stateOf(far).mode).toBe("hunt");
});

test("its own kind's gaze does not send it back", () => {
  const game = world(100, 550, heedingAnyone);
  hurtPlayer(game, game.local, Infinity);
  const stalker = stalkerAt(game, 400, 300);
  const other = stalkerAt(game, 600, 300);
  other.data = { ...stateOf(other), facing: Math.PI };
  run(game, DT, { x: 900, y: 300 });
  expect(stateOf(stalker).mode).toBe("hunt");
});
