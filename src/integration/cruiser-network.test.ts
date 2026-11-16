import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { driverOf } from "../sim/index.js";
import { crew, idle, jitter, playerOn, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

/** A cruiser 80px across; no zombies, nor scrap to pick up. */
const content = () => [
  ...entityContent({
    ...testEntitiesConfig,
    zombie: {
      ...testEntitiesConfig.zombie,
      spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
    },
    cruiser: { ...testEntitiesConfig.cruiser, length: 80, width: 48 },
  }),
  ...itemContent({
    ...testItemsConfig,
    scrap: {
      ...testItemsConfig.scrap,
      scatter: { ...testItemsConfig.scrap.scatter, count: 0 },
    },
  }),
];

/** The host `a` and the guest `b` that drives, on a hub whose sends arrive 60 to 180ms later. */
const pair = (b: Point) =>
  crew(
    {
      spots: { a: { x: 800, y: 300 }, b },
      content: content(),
      delay: jitter(),
    },
    "a",
    "b",
  );

function cruiserOn(game: Session): WorldEntity {
  const kind = game.kindIds.get("cruiser");
  const found = [...game.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (found === undefined) throw new Error("no cruiser");
  return found;
}

/** As the host, puts the cruiser at `at`, fuelled, pointing `heading`. */
function park(host: Session, at: Point, heading = 0): WorldEntity {
  const cruiser = cruiserOn(host);
  Object.assign(cruiser, {
    ...at,
    prevX: at.x,
    prevY: at.y,
    tx: at.x,
    ty: at.y,
  });
  cruiser.data = { fuel: 10, damage: 0, heading };
  return cruiser;
}

const throttle: Controls = { ...idle, move: { x: 0, y: -1 } };

const gap = (one: Point, other: Point): number =>
  Math.hypot(one.x - other.x, one.y - other.y);

test("a guest takes the wheel at once; the host drives the cruiser where the guest steers it, and they agree", async () => {
  const { room, run, step } = await pair({ x: 300, y: 360 });
  const host = sessionOf(room("a"));
  const guest = sessionOf(room("b"));
  const cruiser = park(host, { x: 300, y: 300 });
  run(500);

  step({ b: { ...idle, interact: true } });
  step({ b: { ...idle, interact: true } });
  expect(guest.local.ride).toMatchObject({
    vehicle: cruiser.id,
    driving: true,
  });
  run(500);
  const onHost = playerOn(room("a"), "b");
  expect(onHost.ride).toMatchObject({ vehicle: cruiser.id, driving: true });

  run(1500, { b: throttle });
  run(300, { b: { ...throttle, move: { x: 1, y: -1 } } });
  // Brakes to a stop.
  run(700, { b: { ...idle, move: { x: 0, y: 1 } } });
  run(1000);
  // At most the nudge onto where the host has the cruiser as it gets in.
  expect(guest.corrections.count).toBeLessThanOrEqual(1);
  expect(guest.local.x).toBeGreaterThan(450);
  expect(gap(guest.local, onHost)).toBeLessThan(0.01);
  expect(gap(cruiser, onHost)).toBeLessThan(0.01);
  expect(gap(cruiserOn(guest), cruiser)).toBeLessThan(1);
  expect(guest.local.ride?.heading).toBeCloseTo(onHost.ride?.heading ?? 0, 5);

  step({ b: { ...idle, interact: true } });
  expect(guest.local.ride?.driving).toBe(false);
  step({ b: { ...idle, cabin: "exit" } });
  expect(guest.local.ride).toBeNull();
  run(500);
  expect(onHost.ride).toBeNull();
  expect(gap(guest.local, onHost)).toBeLessThan(0.01);
});

test("a guest's crash knocks the wall down on every client", async () => {
  const { room, run, step } = await pair({ x: 800, y: 160 });
  const host = sessionOf(room("a"));
  const guest = sessionOf(room("b"));
  park(host, { x: 800, y: 100 }, Math.PI);
  run(500);
  step({ b: { ...idle, interact: true } });
  step({ b: { ...idle, cabin: "drive" } });
  run(3000, { b: throttle });
  run(1000);
  for (const game of [host, guest]) {
    const { map } = game.world;
    expect(map.solid[1 * map.cols + 5]).toBe(0);
    expect(map.solid[2 * map.cols + 5]).toBe(0);
    expect(map.solid[1 * map.cols + 4]).toBe(1);
  }
  expect(gap(guest.local, playerOn(room("a"), "b"))).toBeLessThan(0.01);
});

test("two at the wheel at once: their steers add up, so pulling against each other holds the cruiser still", async () => {
  const { room, run, step } = await crew(
    {
      spots: { a: { x: 280, y: 360 }, b: { x: 320, y: 360 } },
      content: content(),
      delay: jitter(),
    },
    "a",
    "b",
  );
  const host = sessionOf(room("a"));
  const guest = sessionOf(room("b"));
  const cruiser = park(host, { x: 300, y: 300 });
  run(500);
  for (const id of ["a", "b"]) {
    step({ [id]: { ...idle, interact: true } });
    run(200);
    step({ [id]: { ...idle, cabin: "drive" } });
    run(200);
  }
  run(500);
  for (const game of [host, guest])
    for (const id of ["a", "b"])
      expect(game.players.get(id)?.ride).toMatchObject({
        vehicle: cruiser.id,
        driving: true,
      });

  // One forward, one back: they cancel, and once both steers are in it stays put.
  const against = { a: throttle, b: { ...idle, move: { x: 0, y: 1 } } };
  run(1000, against);
  const held = cruiser.x;
  run(1500, against);
  expect(Math.abs(cruiser.x - held)).toBeLessThan(1);

  // Both forward: it goes, no faster than one alone would. The guest following the lead takes
  // the lead's lagging place as no correction.
  const corrections = guest.corrections.count;
  run(1500, { a: throttle, b: throttle });
  expect(guest.corrections.count).toBe(corrections);
  expect(cruiser.x).toBeGreaterThan(400);
  const speed = playerOn(room("a"), "a").ride?.speed ?? 0;
  expect(speed).toBeLessThanOrEqual(
    testEntitiesConfig.cruiser.handling.speed + 1e-6,
  );
  // Once it rolls to a stop, the one following is with the lead, on every client.
  run(4000);
  expect(gap(playerOn(room("a"), "b"), cruiser)).toBeLessThan(0.01);
  expect(gap(cruiserOn(guest), cruiser)).toBeLessThan(1);

  // The lead lets go; the other goes on driving it alone, back the way it came.
  step({ a: { ...idle, interact: true } });
  run(500);
  expect(driverOf(host, cruiser.id)?.id).toBe("b");
  const before = cruiser.x;
  run(1500, { b: { ...idle, move: { x: 0, y: 1 } } });
  expect(cruiser.x).toBeLessThan(before - 30);
});
