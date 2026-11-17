import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import {
  bodiesIn,
  cabinDoor,
  createSession,
  driverOf,
  driversOf,
  eyesOf,
  inView,
  isLookedAt,
  livingBodies,
  livingBody,
  noisesHeardBy,
  occupantsOf,
  registerContent,
  speak,
  updateSession,
  VOICE_TAG,
} from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

const DT = 1 / 60;

/** A cruiser 80px across; `zombies` zombies, none arriving later. */
function entitiesWith(zombies: number): EntitiesConfig {
  return {
    ...testEntitiesConfig,
    zombie: {
      ...testEntitiesConfig.zombie,
      spawn: { ...testEntitiesConfig.zombie.spawn, count: zombies },
    },
    cruiser: { ...testEntitiesConfig.cruiser, length: 80, width: 48 },
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

/** The dev square, hosted alone, with its cruiser and `zombies` zombies. */
function world(zombies = 0): Session {
  const game = createSession(
    "me",
    "ME",
    "CABIN",
    "dev",
    testSfx(),
    testSimConfig,
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

/** Puts `entity` at `at`, at rest. */
function put(entity: WorldEntity, at: Point): void {
  Object.assign(entity, {
    ...at,
    prevX: at.x,
    prevY: at.y,
    tx: at.x,
    ty: at.y,
    vx: 0,
    vy: 0,
  });
}

/** Puts the cruiser at `at`, pointing right, with `fuel` seconds of fuel. */
function park(game: Session, at: Point, fuel = 0): WorldEntity {
  const cruiser = kindOf(game, "cruiser");
  put(cruiser, at);
  cruiser.data = { fuel, damage: 0, heading: 0 };
  return cruiser;
}

function stand(game: Session, at: Point): void {
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y, vx: 0, vy: 0 });
}

const press = (game: Session, controls: Partial<Controls>): void => {
  updateSession(game, { ...idle, ...controls }, DT);
};

function play(game: Session, seconds: number, controls = idle): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, controls, DT);
}

/** The local player in the cruiser parked at `at`, off its wheel. */
function inside(game: Session, at: Point, fuel = 0): WorldEntity {
  const cruiser = park(game, at, fuel);
  stand(game, { x: at.x, y: at.y + 50 });
  press(game, { interact: true });
  expect(game.local.ride).toMatchObject({
    vehicle: cruiser.id,
    driving: false,
  });
  return cruiser;
}

test("three players get in one cruiser, unfuelled; any number take its wheel at once", async () => {
  const made = await crew(
    {
      spots: {
        a: { x: 400, y: 360 },
        b: { x: 450, y: 360 },
        c: { x: 500, y: 360 },
      },
      content: [...entityContent(entitiesWith(0)), ...itemContent(items)],
    },
    "a",
    "b",
    "c",
  );
  const host = sessionOf(made.room("a"));
  const cruiser = park(host, { x: 450, y: 300 });
  made.run(500);
  made.step({
    a: { ...idle, interact: true },
    b: { ...idle, interact: true },
    c: { ...idle, interact: true },
  });
  made.run(500);
  expect(
    occupantsOf(host, cruiser.id)
      .map((player) => player.id)
      .sort(),
  ).toEqual(["a", "b", "c"]);
  for (const id of ["a", "b", "c"])
    expect(playerOn(made.room("a"), id)).toMatchObject({
      x: cruiser.x,
      y: cruiser.y,
    });

  made.step({ c: { ...idle, cabin: "drive" } });
  made.run(500);
  made.step({ b: { ...idle, cabin: "drive" } });
  made.run(1000);
  // Both are at the wheel; b leads, first by id, whoever took it first.
  for (const id of ["a", "b", "c"]) {
    const game = sessionOf(made.room(id));
    expect(occupantsOf(game, cruiser.id)).toHaveLength(3);
    expect(driversOf(game, cruiser.id).map((player) => player.id)).toEqual([
      "b",
      "c",
    ]);
    expect(driverOf(game, cruiser.id)?.id).toBe("b");
  }
  expect(sessionOf(made.room("c")).local.ride?.driving).toBe(true);

  // Once b lets go, c leads alone.
  made.step({ b: { ...idle, interact: true } });
  made.run(1000);
  expect(driversOf(host, cruiser.id).map((player) => player.id)).toEqual(["c"]);

  made.step({ a: { ...idle, cabin: "exit" } });
  made.run(500);
  expect(playerOn(made.room("a"), "a").ride).toBeNull();
  expect(occupantsOf(host, cruiser.id)).toHaveLength(2);
});

test("a body inside behind the shut door is out of the world: not seen, looked at, struck, bumped into or hunted", () => {
  const game = world(1);
  const zombie = kindOf(game, "zombie");
  const cruiser = inside(game, { x: 450, y: 300 });
  press(game, { cabin: "door" });
  put(zombie, { x: 450, y: 300 + 24 + zombie.radius + 2 });
  play(game, 0.1);

  const { local } = game;
  expect(livingBodies(game)).not.toContain(local);
  expect(livingBody(game, local.id)).toBeNull();
  expect(bodiesIn(game, { center: local, radius: 50 })).not.toContain(local);
  // The zombie's eyes would take in where it sits, but there is nobody there to see.
  expect(inView(game, eyesOf(game, zombie), cruiser)).toBe(true);
  // Nor does it look out, even facing the zombie.
  local.aim = Math.PI / 2;
  expect(
    isLookedAt(game, zombie, { except: (body) => body.id !== local.id }),
  ).toBe(false);

  play(game, 3);
  expect(local.health).toBe(local.maxHealth);
  expect(local).toMatchObject({ x: cruiser.x, y: cruiser.y });
});

test("through the open door a body inside is in reach: seen, hunted and struck where the cruiser is", () => {
  const game = world(1);
  const zombie = kindOf(game, "zombie");
  const cruiser = inside(game, { x: 450, y: 300 });
  expect(cabinDoor(game, cruiser.id)?.closed).toBe(false);
  put(zombie, { x: 450, y: 300 + 24 + zombie.radius + 2 });
  play(game, 0.1);

  const { local } = game;
  expect(livingBodies(game)).toContain(local);
  expect(livingBody(game, local.id)).toBe(local);
  expect(bodiesIn(game, { center: local, radius: 50 })).toContain(local);
  play(game, 3);
  expect(local.health).toBeLessThan(local.maxHealth);
});

test("shutting the door takes power, shut it burns more and swings open with none left, open it charges back", () => {
  const game = world();
  const cruiser = inside(game, { x: 450, y: 300 });
  const { door } = config;
  const now = () => cabinDoor(game, cruiser.id);
  expect(now()).toEqual({ closed: false, canClose: true, charge: 1 });

  press(game, { cabin: "door" });
  expect(now()?.closed).toBe(true);
  expect(now()?.charge).toBeCloseTo(1 - door.close - door.drain * DT, 3);

  play(game, (1 - door.close) / door.drain + 0.1);
  expect(now()).toMatchObject({ closed: false, canClose: false });
  expect(now()?.charge).toBeLessThan(0.01);
  // Too little power to shut it again.
  play(game, 0.5);
  press(game, { cabin: "door" });
  expect(now()?.closed).toBe(false);

  play(game, door.close / door.recharge);
  expect(now()?.canClose).toBe(true);
  press(game, { cabin: "door" });
  expect(now()?.closed).toBe(true);
  play(game, 0.5);
  press(game, { cabin: "door" });
  expect(now()?.closed).toBe(false);
});

test("what a body inside says is heard from the cruiser, and draws a zombie to it", () => {
  const game = world(1);
  const zombie = kindOf(game, "zombie");
  const cruiser = inside(game, { x: 450, y: 300 });
  press(game, { cabin: "door" });
  const from = { x: 450, y: 300 + 220 };
  put(zombie, from);
  const listener = { at: zombie, rng: () => 0.5, ignores: ["zombie"] };

  speak(game, 1);
  press(game, {});
  const heard = noisesHeardBy(game, listener).find((noise) =>
    noise.tags.includes(VOICE_TAG),
  );
  expect(heard).toMatchObject({
    origin: { x: cruiser.x, y: cruiser.y },
    source: game.localId,
  });

  for (let second = 0; second < 4; second++) {
    speak(game, 1);
    play(game, 1);
  }
  const gap = (at: Point) => Math.hypot(at.x - cruiser.x, at.y - cruiser.y);
  expect(gap(zombie)).toBeLessThan(gap(from) - 50);
  // It came, but found no one to strike.
  expect(game.local.health).toBe(game.local.maxHealth);
});

test("the horn, from the cabin or Space at the wheel, is heard across its radius as the player's noise", async () => {
  const made = await crew(
    {
      spots: { a: { x: 450, y: 350 } },
      content: [...entityContent(entitiesWith(0)), ...itemContent(items)],
    },
    "a",
  );
  const game = sessionOf(made.room("a"));
  const cruiser = park(game, { x: 450, y: 300 }, 10);
  made.step({ a: { ...idle, interact: true } });
  expect(game.local.ride?.vehicle).toBe(cruiser.id);
  /** The horn's noises made over `seconds`, the first step on `controls`. */
  const honks = (controls: Partial<Controls>, seconds = 0.5) => {
    const noises: Session["noises"][number][] = [];
    made.step({ a: { ...idle, ...controls } });
    noises.push(...game.noises);
    for (let step = 0; step < Math.round(seconds / DT); step++) {
      made.step();
      noises.push(...game.noises);
    }
    return noises.filter((noise) => noise.tags.includes("horn"));
  };

  expect(honks({ cabin: "honk" })).toEqual([
    expect.objectContaining({
      at: { x: cruiser.x, y: cruiser.y },
      radius: config.horn.noiseRadius,
      source: "a",
      tags: ["player", "horn"],
    }),
  ]);
  // Space only honks at the wheel.
  expect(honks({ honk: true })).toEqual([]);
  made.step({ a: { ...idle, cabin: "drive" } });
  expect(game.local.ride?.driving).toBe(true);
  expect(honks({ honk: true })).toHaveLength(1);
});

test("from the cabin: Drive takes the wheel, interact at the wheel goes back to the cabin, F gets out", () => {
  const game = world();
  const cruiser = inside(game, { x: 450, y: 300 }, 10);
  press(game, { cabin: "drive" });
  expect(game.local.ride?.driving).toBe(true);
  // At the wheel, the wheel turns as it is steered.
  press(game, { move: { x: 1, y: -1 } });
  expect(game.local.ride?.turn).toBe(1);

  press(game, { interact: true });
  expect(game.local.ride).toMatchObject({
    vehicle: cruiser.id,
    driving: false,
    turn: 0,
  });
  // In the cabin its hands are inside: nothing is used or kicked.
  press(game, { use: true, secondary: true });
  expect(game.local.ride?.vehicle).toBe(cruiser.id);

  play(game, 0.5);
  // The drop key gets out; there is nothing to drop in there.
  press(game, { drop: true });
  expect(game.local.ride).toBeNull();
  const gap = Math.hypot(game.local.x - cruiser.x, game.local.y - cruiser.y);
  expect(gap).toBeGreaterThan(24);
  expect(livingBodies(game)).toContain(game.local);
});
