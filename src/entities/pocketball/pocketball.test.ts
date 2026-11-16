import { expect, test } from "vitest";
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
  isAreaFree,
  pocketAt,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { placeStunTrap, stunTrap } from "../stun-trap/index.js";
import { freshZombie, zombie as zombieContent } from "../zombie/index.js";
import { pocketball, pocketOf, throwPocketball } from "./index.js";

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
const RANGE = testItemsConfig.pocketball.range;

/**
 * The dev square, 800 by 600, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550, with
 * zombies, stun traps and pocketballs; the player stands left of its clear middle row.
 */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "BALL",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    zombieContent.create(testEntitiesConfig),
    stunTrap.create(testEntitiesConfig),
    pocketball.create(testEntitiesConfig),
    ...itemContent(testItemsConfig),
  ]);
  standAt(game, { x: 100, y: 300 });
  return game;
}

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

const standAt = (game: Session, at: Point) =>
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });

const zombieAt = (game: Session, at: Point): WorldEntity =>
  spawnEntity(
    game,
    "zombie",
    at.x,
    at.y,
    freshZombie(1, game.worldTime, testEntitiesConfig.zombie),
  );

/** Every ball in flight. */
const flying = (game: Session): WorldEntity[] =>
  [...game.entities.values()].filter(
    (entity) => entity.kind === game.kindIds.get("pocketball"),
  );

/** A lying item's state, as far as these tests read it. */
const Lying = z.object({
  item: z.string(),
  state: z.record(z.string(), z.number()).optional(),
});

/** Whether `entity` is a pocketball lying about. */
const isLyingBall = (entity: WorldEntity): boolean =>
  Lying.safeParse(entity.data).data?.item === "pocketball";

/** Every pocketball lying about, with the pocket each holds. */
function lying(
  game: Session,
): { readonly at: Point; readonly pocket: number | null }[] {
  const found = [];
  for (const entity of game.entities.values()) {
    const data = Lying.safeParse(entity.data).data;
    if (data?.item === "pocketball")
      found.push({ at: entity, pocket: pocketOf(data.state) });
  }
  return found;
}

const throwRight = (game: Session, pocket: number | null) => {
  throwPocketball(game, game.local, { aim: 0, range: RANGE, pocket });
};

test("pockets are walled rooms off the map, far below it, the map itself unchanged", () => {
  const game = world();
  const { map } = game.world;
  const below = map.rows * map.cell;
  const open = [...Array(20).keys()].flatMap((i) =>
    [...Array(200).keys()].map((j) => ({
      x: i * map.cell + 1,
      y: below + j * map.cell + 1,
    })),
  );
  const pockets = open.filter((at) => isAreaFree(map, at.x, at.y, 0));
  // Each pocket is 3x3 cells, every one of them its own.
  expect(pockets.length % 9).toBe(0);
  expect(pockets.length).toBeGreaterThan(0);
  for (const at of pockets) {
    expect(pocketAt(map, at)).not.toBeNull();
    // Far below the map, beyond any noise.
    expect(at.y - below).toBeGreaterThan(50 * map.cell);
  }
  expect(pocketAt(map, { x: 100, y: 300 })).toBeNull();
});

test("an empty ball thrown at a monster catches it into a pocket and drops where it struck, full", () => {
  const game = world();
  const zombie = zombieAt(game, { x: 180, y: 300 });
  throwRight(game, null);
  run(game, 0.3);

  const pocket = pocketAt(game.world.map, zombie);
  expect(pocket).not.toBeNull();
  expect(flying(game)).toHaveLength(0);
  const [ball, ...more] = lying(game);
  expect(more).toHaveLength(0);
  expect(ball?.pocket).toBe(pocket);
  expect(ball?.at.x).toBeGreaterThan(110);
  expect(ball?.at.x).toBeLessThan(180);
});

test("a monster in a pocket stays there, walled in, however long it is left", () => {
  const game = world();
  const zombie = zombieAt(game, { x: 180, y: 300 });
  throwRight(game, null);
  run(game, 0.3);
  const pocket = pocketAt(game.world.map, zombie);
  run(game, 5);
  expect(pocketAt(game.world.map, zombie)).toBe(pocket);
});

test("a full ball lets its catch out where it lands, clear of walls, and is spent", () => {
  const game = world();
  const zombie = zombieAt(game, { x: 180, y: 300 });
  throwRight(game, null);
  run(game, 0.3);
  const pocket = lying(game)[0]?.pocket ?? null;
  for (const entity of game.entities.values())
    if (isLyingBall(entity)) game.entities.delete(entity.id);

  throwRight(game, pocket);
  run(game, 1);
  expect(pocketAt(game.world.map, zombie)).toBeNull();
  // Out where the ball dropped, its range ahead.
  expect(zombie.x).toBeGreaterThan(100 + RANGE * 0.8);
  expect(isAreaFree(game.world.map, zombie.x, zombie.y, zombie.radius)).toBe(
    true,
  );
  expect(flying(game)).toHaveLength(0);
  expect(lying(game)).toHaveLength(0);
});

test("a full ball striking a body lets its catch out there", () => {
  const game = world();
  const caught = zombieAt(game, { x: 180, y: 300 });
  throwRight(game, null);
  run(game, 0.3);
  const pocket = lying(game)[0]?.pocket ?? null;
  zombieAt(game, { x: 200, y: 300 });

  throwRight(game, pocket);
  run(game, 0.3);
  expect(pocketAt(game.world.map, caught)).toBeNull();
  expect(Math.hypot(caught.x - 190, caught.y - 300)).toBeLessThan(60);
});

test("an empty ball that strikes nothing drops after its range, empty", () => {
  const game = world();
  throwRight(game, null);
  run(game, 1);
  const [ball, ...more] = lying(game);
  expect(more).toHaveLength(0);
  expect(ball?.pocket).toBeNull();
  expect(ball?.at.x).toBeCloseTo(100 + game.local.radius + 7 + RANGE, -1);
});

test("a ball bounces off walls, its flight counting the way back", () => {
  const game = world();
  // Thrown left from just right of the square's left edge: it strikes the wall, comes back, and
  // drops its range's worth of flight from where it left.
  standAt(game, { x: 400, y: 300 });
  throwPocketball(game, game.local, {
    aim: -Math.PI / 2,
    range: RANGE,
    pocket: null,
  });
  run(game, 1);
  // Up from just above the thrower to the top edge's wall, then back down what is left of its
  // range, not on through the wall.
  const radius = testEntitiesConfig.pocketball.radius;
  const from = 300 - game.local.radius - radius - 1;
  const up = from - radius;
  // A step that meets the wall stops at it, so up to a step of flight is lost to a bounce.
  const at = lying(game)[0]?.at.y ?? 0;
  expect(at).toBeLessThanOrEqual(radius + (RANGE - up));
  expect(at).toBeGreaterThan(radius + (RANGE - up) - 15);
});

test("players are bodies like any other: a ball bouncing back catches its own thrower", () => {
  const game = world();
  standAt(game, { x: 400, y: 80 });
  throwPocketball(game, game.local, {
    aim: -Math.PI / 2,
    range: RANGE,
    pocket: null,
  });
  run(game, 0.5);
  expect(pocketAt(game.world.map, game.local)).not.toBeNull();
});

test("each catch takes a pocket of its own", () => {
  const game = world();
  const first = zombieAt(game, { x: 180, y: 300 });
  throwRight(game, null);
  run(game, 0.3);
  const second = zombieAt(game, { x: 180, y: 300 });
  standAt(game, { x: 100, y: 300 });
  throwRight(game, null);
  run(game, 0.3);
  const pockets = [first, second].map((zombie) =>
    pocketAt(game.world.map, zombie),
  );
  expect(pockets).not.toContain(null);
  expect(pockets[0]).not.toBe(pockets[1]);
  expect(
    lying(game)
      .map(({ pocket }) => pocket)
      .sort(),
  ).toEqual([...pockets].sort());
});

test("a ball flies over inert things, such as a stun trap, without catching them", () => {
  const game = world();
  placeStunTrap(game, { x: 180, y: 300 });
  const trap = [...game.entities.values()].at(-1);
  throwRight(game, null);
  run(game, 1);
  expect(trap).toMatchObject({ x: 180, y: 300 });
  expect(lying(game)[0]?.pocket).toBeNull();
});
