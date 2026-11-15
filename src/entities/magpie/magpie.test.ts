import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import { itemContent } from "../../items/index.js";
import {
  createSession,
  hurt,
  hurtPlayer,
  giveItem,
  itemInstances,
  itemIn,
  mulberry32,
  receiveEvent,
  registerContent,
  registerEntityType,
  spawnEntity,
  spawnWorldItem,
  takeItem,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { freshMagpie, magpie as magpieContent, MagpieState } from "./index.js";
import type { MagpieConfig } from "./index.js";

const DT = 1 / 60;
const { magpie: config } = testEntitiesConfig;
const SLOTS = [0, 1, 2, 3];

// Nest numbers, search points and patrol spots draw from Math.random; seeded so each run is the
// same.
beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(5));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The dev square, 18x12 cells of 50px, all dark, with magpie beetles and the items; the local
 * player stands at (x, y).
 */
function world(x: number, y: number, magpie: MagpieConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "HOARD",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  registerContent(game, [
    magpieContent.create({ magpie }),
    ...itemContent(testItemsConfig),
  ]);
  standAt(game, x, y);
  return game;
}

function standAt(game: Session, x: number, y: number): void {
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
}

/** Steps `seconds`, the local player looking at `look`, each sound the host sends heard at once. */
function run(game: Session, seconds: number, look: Point = { x: 900, y: 600 }) {
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

function magpieAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(game, "magpie", x, y, freshMagpie(game.worldTime));
}

const stateOf = (entity: WorldEntity): MagpieState =>
  MagpieState.parse(entity.data);

const sounded = (game: Session, file: string): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith(file));

const scrapLying = (game: Session) =>
  itemInstances(game, "scrap").filter(({ place }) => "lying" in place);

test("a group that arrives together settles one nest, each laying search points round it", () => {
  const game = world(850, 550);
  const group = [
    magpieAt(game, 300, 300),
    magpieAt(game, 340, 300),
    magpieAt(game, 300, 340),
  ];
  run(game, DT);

  const [first, ...rest] = group.map(stateOf);
  expect(first?.nest).toEqual({ x: 300, y: 300 });
  expect(first?.nestId).not.toBe(0);
  for (const state of rest) {
    expect(state.nest).toEqual(first?.nest);
    expect(state.nestId).toBe(first?.nestId);
  }
  for (const state of group.map(stateOf)) {
    expect(state.points.length).toBeGreaterThan(0);
    for (const point of state.points)
      expect(Math.hypot(point.x - 300, point.y - 300)).toBeLessThanOrEqual(
        config.search.range,
      );
  }
  // Another far off settles a nest of its own.
  const stray = magpieAt(game, 750, 100);
  run(game, DT);
  expect(stateOf(stray).nestId).not.toBe(first?.nestId);
});

test("it wanders from search point to search point, marking each seen", () => {
  // Its search points lie within 150px of its nest, so it never comes near the player.
  const game = world(850, 550, {
    ...config,
    search: { ...config.search, range: 150 },
  });
  const bug = magpieAt(game, 300, 300);
  run(game, DT);
  expect(stateOf(bug).goal).not.toBeNull();
  expect(Math.hypot(bug.vx, bug.vy)).toBeCloseTo(config.wanderSpeed);
  run(game, 8);
  expect(stateOf(bug).mode).toBe("wander");
  expect(stateOf(bug).seen).not.toBe(0);
});

test("it carries scrap it sees home, held up to see, lays it by the nest as the nest's own, then guards", () => {
  const game = world(850, 575);
  const bug = magpieAt(game, 200, 300);
  run(game, DT);
  const { nestId } = stateOf(bug);
  spawnWorldItem(game, { x: 380, y: 300 }, "scrap");
  bug.data = { ...stateOf(bug), facing: 0, route: [] };

  // 180px off at its foraging pace: it gets there in about a second.
  run(game, 1.2);
  expect(stateOf(bug).carrying).toBe("scrap");
  expect(sounded(game, "pick-up.mp3")).toBe(true);
  expect(scrapLying(game)).toHaveLength(0);

  run(game, 3);
  expect(stateOf(bug).carrying).toBeNull();
  expect(stateOf(bug).mode).toBe("guard");
  const [laid] = scrapLying(game);
  expect(laid?.state).toEqual({ nest: nestId });
  expect(
    Math.hypot((laid?.at.x ?? 0) - 200, (laid?.at.y ?? 0) - 300),
  ).toBeLessThanOrEqual(config.dropRadius + 1);
  expect(sounded(game, "drop.mp3")).toBe(true);

  // Guarding runs out back to foraging.
  run(game, config.guardSeconds);
  expect(stateOf(bug).mode).toBe("wander");
});

test("a player it sees near its nest sets it guarding; one close by away from the nest spooks it", () => {
  const game = world(850, 575);
  const bug = magpieAt(game, 300, 300);
  run(game, DT);
  standAt(game, 400, 300);
  bug.data = { ...stateOf(bug), facing: 0 };
  run(game, DT);
  expect(stateOf(bug).mode).toBe("guard");

  const away = world(850, 575);
  const far = magpieAt(away, 100, 300);
  run(away, DT);
  Object.assign(far, { x: 400, y: 300, prevX: 400, prevY: 300 });
  standAt(away, 600, 300);
  far.data = { ...stateOf(far), facing: 0, route: [] };
  run(away, DT);
  expect(stateOf(far).mode).toBe("spook");
  expect(stateOf(far).quarry).toBe("me");
  expect(sounded(away, "alarm.mp3")).toBe(true);
});

test("hurt, it drops what it carries and chases whoever hurt it a while, biting it", () => {
  const game = world(450, 300);
  const bug = magpieAt(game, 300, 300);
  run(game, DT);
  bug.data = { ...stateOf(bug), carrying: "scrap" };
  hurt(game, bug, 15, game.localId);
  run(game, DT);
  const state = stateOf(bug);
  expect(state.mode).toBe("spook");
  expect(state.quarry).toBe("me");
  expect(state.until).toBeCloseTo(game.worldTime + config.spookSeconds, 1);
  expect(state.carrying).toBeNull();
  expect(scrapLying(game)).toHaveLength(1);
  expect(Math.hypot(bug.vx, bug.vy)).toBeCloseTo(config.chaseSpeed);

  run(game, 2);
  expect(game.local.health).toBeLessThan(game.local.maxHealth);
  expect(sounded(game, "attack.mp3")).toBe(true);
});

test("taking scrap its nest claimed draws the whole nest's revenge, until the thief leaves it behind", () => {
  const game = world(800, 550);
  const leader = magpieAt(game, 200, 300);
  const group = [leader, magpieAt(game, 230, 300)];
  run(game, DT);
  const { nestId } = stateOf(leader);
  const slot = SLOTS.find((at) => itemIn(game, "me", at) === null) ?? 0;
  expect(giveItem(game, "me", "scrap", slot, undefined, { nest: nestId })).toBe(
    true,
  );
  run(game, DT);
  for (const bug of group) {
    expect(stateOf(bug).mode).toBe("revenge");
    expect(stateOf(bug).quarry).toBe("me");
  }

  // Dropped far from where the thief goes, the theft is forgiven.
  expect(takeItem(game, "me", slot, "scrap")).toBe(true);
  spawnWorldItem(game, { x: 800, y: 550 }, "scrap", undefined, {
    nest: nestId,
  });
  standAt(game, 450, 75);
  run(game, DT);
  for (const bug of group) expect(stateOf(bug).mode).toBe("wander");
});

test("dying, it drops what it carries", () => {
  const game = world(850, 575);
  const bug = magpieAt(game, 300, 300);
  run(game, DT);
  bug.data = { ...stateOf(bug), carrying: "scrap" };
  bug.health = 0;
  run(game, DT);
  expect(game.entities.has(bug.id)).toBe(false);
  expect(scrapLying(game)).toHaveLength(1);
});

/** A post at (x, y): a body with no eyes nor will of its own, neither player nor monster. */
function postAt(game: Session, x: number, y: number): WorldEntity {
  if (!game.kindIds.has("post"))
    registerEntityType(game, "post", {
      radius: 10,
      maxHealth: 1000,
      data: z.object({}),
      draw: () => undefined,
    });
  return spawnEntity(game, "post", x, y, {});
}

test("any body it sees near its nest sets it guarding; one close by away from the nest spooks it, and it bites", () => {
  const game = world(850, 575);
  hurtPlayer(game, game.local, Infinity);
  const bug = magpieAt(game, 300, 300);
  run(game, DT);
  postAt(game, 400, 300);
  bug.data = { ...stateOf(bug), facing: 0 };
  run(game, DT);
  expect(stateOf(bug).mode).toBe("guard");

  const away = world(850, 575);
  hurtPlayer(away, away.local, Infinity);
  const far = magpieAt(away, 100, 300);
  run(away, DT);
  Object.assign(far, { x: 400, y: 300, prevX: 400, prevY: 300 });
  const post = postAt(away, 600, 300);
  far.data = { ...stateOf(far), facing: 0, route: [] };
  run(away, DT);
  expect(stateOf(far)).toMatchObject({ mode: "spook", quarry: post.id });
  run(away, 2);
  expect(post.health).toBeLessThan(1000);
});

test("hurt by no one, it is spooked by the nearest body, player or not", () => {
  const game = world(850, 575);
  const bug = magpieAt(game, 300, 300);
  const post = postAt(game, 450, 300);
  run(game, DT);
  hurt(game, bug, 5, null);
  run(game, DT);
  expect(stateOf(bug)).toMatchObject({ mode: "spook", quarry: post.id });
});
