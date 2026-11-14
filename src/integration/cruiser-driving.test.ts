import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import {
  createSession,
  giveItem,
  itemIn,
  registerContent,
  updateSession,
} from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { crew, idle, sessionOf } from "./crew.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

const DT = 1 / 60;

type Noise = Session["noises"][number];

/** A cruiser 80px across; one zombie when asked for, none arriving later. */
function entitiesWith(zombies: number): EntitiesConfig {
  return {
    ...testEntitiesConfig,
    zombie: {
      ...testEntitiesConfig.zombie,
      spawn: { ...testEntitiesConfig.zombie.spawn, count: zombies },
      spawning: { ...testEntitiesConfig.zombie.spawning, maxAlive: 0 },
    },
    cruiser: { ...testEntitiesConfig.cruiser, radius: 40 },
  };
}

/** No scrap on the ground, so interact never picks anything up. */
const items: ItemsConfig = {
  ...testItemsConfig,
  scrap: {
    ...testItemsConfig.scrap,
    scatter: { ...testItemsConfig.scrap.scatter, count: 0 },
  },
};

const { cruiser: config } = testEntitiesConfig;

/** The dev square, hosted alone, with its cruiser and the fuel item. */
function world(zombies = 0): Session {
  const game = createSession(
    "me",
    "ME",
    "DRIVE",
    "dev",
    testSfx(),
    testSimConfig,
    // Off to the side, so the world lays the same zombies each run.
    { at: { x: 450, y: 550 } },
  );
  registerContent(game, [
    ...entityContent(entitiesWith(zombies)),
    ...itemContent(items),
  ]);
  for (const content of game.contents) content.populate(game);
  return game;
}

function kindOf(game: Session, name: string): WorldEntity {
  const kind = game.kindIds.get(name);
  const found = [...game.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
}

const cruiserOf = (game: Session): WorldEntity => kindOf(game, "cruiser");

interface CruiserState {
  readonly fuel: number;
  readonly damage: number;
  readonly heading: number;
}

const stateOf = (game: Session): CruiserState => {
  const { data } = cruiserOf(game);
  if (typeof data !== "object" || data === null) throw new Error("no state");
  return { fuel: 0, damage: 0, heading: 0, ...data };
};

/** Puts the cruiser at `at`, pointing `heading`, with `fuel` seconds of fuel and `damage` taken. */
function park(
  game: Session,
  at: Point,
  state: Partial<CruiserState> = {},
): WorldEntity {
  const cruiser = cruiserOf(game);
  Object.assign(cruiser, {
    ...at,
    prevX: at.x,
    prevY: at.y,
    tx: at.x,
    ty: at.y,
  });
  cruiser.data = { fuel: 0, damage: 0, heading: 0, ...state };
  return cruiser;
}

function stand(game: Session, at: Point): void {
  Object.assign(game.local, {
    ...at,
    prevX: at.x,
    prevY: at.y,
    vx: 0,
    vy: 0,
  });
}

/** Steps `seconds` on `controls`, gathering every noise made meanwhile. */
function play(game: Session, seconds: number, controls = idle): Noise[] {
  const noises: Noise[] = [];
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, controls, DT);
    noises.push(...game.noises);
  }
  return noises;
}

const press = (game: Session, controls: Partial<Controls>): void => {
  updateSession(game, { ...idle, ...controls }, DT);
};

const throttle: Controls = { ...idle, move: { x: 0, y: -1 } };

/** The cruiser fuelled at `at`, pointing `heading`, and the local player at its wheel. */
function driving(game: Session, at: Point, heading = 0): WorldEntity {
  const cruiser = park(game, at, { fuel: 10, heading });
  stand(game, { x: at.x, y: at.y + 50 });
  press(game, { interact: true });
  expect(game.local.ride?.vehicle).toBe(cruiser.id);
  return cruiser;
}

test("an unfuelled cruiser can't be entered; fuel used beside it is poured in, and then it can", () => {
  const game = world();
  const cruiser = park(game, { x: 450, y: 300 });
  stand(game, { x: 450, y: 360 });
  press(game, { interact: true });
  expect(game.local.ride).toBeNull();

  expect(giveItem(game, "me", "fuel", 1)).toBe(true);
  play(game, 0.5);
  press(game, { select: 1, use: true });
  expect(itemIn(game, "me", 1)).toBeNull();
  expect(stateOf(game).fuel).toBe(items.fuel.seconds);

  play(game, 0.5);
  press(game, { interact: true });
  expect(game.local.ride?.vehicle).toBe(cruiser.id);
  expect(game.local).toMatchObject({ x: cruiser.x, y: cruiser.y });
});

test("fuel used away from the cruiser stays in hand", () => {
  const game = world();
  park(game, { x: 450, y: 300 });
  stand(game, { x: 150, y: 300 });
  expect(giveItem(game, "me", "fuel", 1)).toBe(true);
  press(game, { select: 1, use: true });
  expect(itemIn(game, "me", 1)).toBe("fuel");
  expect(stateOf(game).fuel).toBe(0);
});

test("throttle drives it the way it points, carrying the cruiser, burning fuel only while it moves; interact gets out beside it", () => {
  const game = world();
  const cruiser = driving(game, { x: 300, y: 300 });
  play(game, 1);
  expect(stateOf(game).fuel).toBeCloseTo(10, 5);

  play(game, 1, throttle);
  expect(game.local.x).toBeGreaterThan(360);
  expect(game.local.y).toBeCloseTo(300, 5);
  expect(cruiser).toMatchObject({ x: game.local.x, y: game.local.y });
  expect(stateOf(game).fuel).toBeCloseTo(9, 1);

  const at = { x: cruiser.x, y: cruiser.y };
  press(game, { interact: true });
  expect(game.local.ride).toBeNull();
  // Out on its left, which is up while it points right.
  expect(game.local.y).toBeLessThan(at.y - config.radius);
  play(game, 1);
  expect(cruiser).toMatchObject(at);
});

test("it turns slowly, and only while it moves", () => {
  const game = world();
  driving(game, { x: 450, y: 300 });
  play(game, 0.5, { ...idle, move: { x: 1, y: 0 } });
  expect(game.local.ride?.heading).toBe(0);
  play(game, 1, { ...idle, move: { x: 1, y: -1 } });
  const heading = game.local.ride?.heading ?? 0;
  expect(heading).toBeGreaterThan(0.1);
  expect(heading).toBeLessThan(config.handling.turnRate);
});

test("out of fuel, its throttle does nothing", () => {
  const game = world();
  driving(game, { x: 300, y: 300 });
  cruiserOf(game).data = { ...stateOf(game), fuel: 0.2 };
  play(game, 3, throttle);
  expect(stateOf(game).fuel).toBe(0);
  expect(game.local.ride?.speed).toBe(0);
  const x = game.local.x;
  play(game, 1, throttle);
  expect(game.local.x).toBe(x);
});

test("its engine idles quietly as it stands fuelled, ignored by zombies, and is loud while driven", async () => {
  const made = await crew(
    {
      spots: { a: { x: 450, y: 340 } },
      content: [...entityContent(entitiesWith(0)), ...itemContent(items)],
    },
    "a",
  );
  const game = sessionOf(made.room("a"));
  park(game, { x: 450, y: 300 }, { fuel: 10 });
  const heard = (seconds: number, controls = idle): Noise[] => {
    const noises: Noise[] = [];
    for (let step = 0; step < Math.round(seconds / DT); step++) {
      made.step({ a: controls });
      noises.push(...game.noises);
    }
    return noises;
  };
  expect(heard(1.5)).toContainEqual(
    expect.objectContaining({
      radius: config.engine.idle.radius,
      tags: ["cruiser", "inert", "engine"],
    }),
  );
  made.step({ a: { ...idle, interact: true } });
  expect(game.local.ride).not.toBeNull();
  expect(heard(1.5, throttle)).toContainEqual(
    expect.objectContaining({
      radius: config.engine.drive.radius,
      source: "a",
      tags: ["player", "engine"],
    }),
  );
});

/** Driving left from the right of the dev square into its first pillar, x 200..300, y 50..150. */
function crash(game: Session, damage = 0): WorldEntity {
  const cruiser = driving(game, { x: 800, y: 100 }, Math.PI);
  cruiser.data = { ...stateOf(game), damage };
  play(game, 3, throttle);
  return cruiser;
}

test("a crash knocks down the walls it hits, stops the cruiser dead and damages it", () => {
  const game = world();
  const { map } = game.world;
  crash(game);
  // The pillar's right column, cells (5, 1) and (5, 2), is down; its left stands.
  expect(map.solid[1 * map.cols + 5]).toBe(0);
  expect(map.solid[2 * map.cols + 5]).toBe(0);
  expect(map.solid[1 * map.cols + 4]).toBe(1);
  expect(stateOf(game).damage).toBe(config.crash.damage);
  expect(game.local.ride).not.toBeNull();
});

test("bumping a wall slowly only stops it", () => {
  const game = world();
  const { map } = game.world;
  driving(game, { x: 370, y: 100 }, Math.PI);
  play(game, 2, throttle);
  expect(map.solid[1 * map.cols + 5]).toBe(1);
  expect(stateOf(game).damage).toBe(0);
  expect(game.local.x).toBeCloseTo(300 + 40, 5);
});

test("at breakdown damage its driver gets out and its fuel is gone", () => {
  const game = world();
  crash(game, config.crash.breakdown - config.crash.damage);
  expect(game.local.ride).toBeNull();
  expect(stateOf(game)).toMatchObject({ fuel: 0, damage: 0 });
  press(game, { interact: true });
  expect(game.local.ride).toBeNull();
});

test("driven into a zombie at speed, it hurts it once and shoves it clear of its side, and goes on past", () => {
  const game = world(1);
  const zombie = kindOf(game, "zombie");
  Object.assign(zombie, { x: 600, y: 310, tx: 600, ty: 310 });
  driving(game, { x: 150, y: 300 });
  for (let step = 0; step < 240 && zombie.health === zombie.maxHealth; step++)
    press(game, throttle);
  expect(zombie.health).toBe(zombie.maxHealth - config.ram.damage);
  expect(Math.abs(zombie.y - game.local.y)).toBeGreaterThanOrEqual(
    40 + zombie.radius,
  );
  expect(Math.abs(game.local.ride?.speed ?? 0)).toBeGreaterThan(
    config.ram.speed,
  );
});

test("driven into a zombie slowly, it does not hurt it", () => {
  const game = world(1);
  const zombie = kindOf(game, "zombie");
  Object.assign(zombie, { x: 260, y: 300, tx: 260, ty: 300 });
  driving(game, { x: 200, y: 300 });
  play(game, 0.3, throttle);
  expect(zombie.health).toBe(zombie.maxHealth);
});
