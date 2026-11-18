import { expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  receiveEvent,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { freshThumper, thumper as thumperContent } from "../thumper/index.js";
import {
  freshTricycle,
  onWay,
  tricycle as tricycleContent,
  TricycleState,
} from "./index.js";

const DT = 1 / 60;
const { tricycle: config, thumper: thumperConfig } = testEntitiesConfig;
const WALK = testSimConfig.player.speed;

/**
 * The dev square, 18x12 cells of 50px, walled round its edge, its pillars at x 200-300, y 50-150
 * and x 600-700, y 450-550; the local player, ME, stands at (x, y). A thumper may be spawned too,
 * as a body that is not a player. Tricycles are as `trikeConfig` has them, the test config's by
 * default.
 */
function world(x: number, y: number, trikeConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "TRIKE",
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
    tricycleContent.create({ tricycle: trikeConfig }),
    thumperContent.create({ thumper: thumperConfig }),
  ]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  return game;
}

/** Steps `seconds`, the local player standing, each event the host sends heard at once. */
function run(game: Session, seconds: number): void {
  const controls = {
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

/** A tricycle at `at` riding `route`. */
function tricycleAt(game: Session, at: Point, route: Point[]): WorldEntity {
  return spawnEntity(game, "tricycle", at.x, at.y, {
    ...freshTricycle(game.worldTime),
    route,
  });
}

const stateOf = (entity: WorldEntity): TricycleState =>
  TricycleState.parse(entity.data);

const rang = (game: Session): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith("bell.mp3"));

/** A corner far from where these tests ride. */
const FAR = { x: 875, y: 575 };

/** Along the open row between the pillars, left to right. */
const ROW = [{ x: 825, y: 325 }];

test("a body is on its way when it stands near enough the line of its route, within range", () => {
  const self = { x: 0, y: 0, radius: 10 };
  const route = [
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  expect(onWay(self, route, { x: 50, y: 15, radius: 10 }, 400)).toBe(true);
  expect(onWay(self, route, { x: 110, y: 60, radius: 10 }, 400)).toBe(true);
  expect(onWay(self, route, { x: 50, y: 40, radius: 10 }, 400)).toBe(false);
  expect(onWay(self, route, { x: 50, y: 15, radius: 10 }, 30)).toBe(false);
});

test("it rides at 1.3 times a walk with no one about", () => {
  const game = world(FAR.x, FAR.y);
  const trike = tricycleAt(game, { x: 75, y: 325 }, ROW);
  run(game, 0.5);
  expect(Math.hypot(trike.vx, trike.vy)).toBeCloseTo(WALK * config.speedShare);
  expect(stateOf(trike).slowed).toBe(false);
  expect(rang(game)).toBe(false);
});

test("a player on its way ahead hears its bell, and it slows to 0.9 times a walk as it nears them", () => {
  const game = world(400, 325);
  const trike = tricycleAt(game, { x: 75, y: 325 }, ROW);
  run(game, DT * 2);
  expect(rang(game)).toBe(true);
  expect(stateOf(trike).rangAt).not.toBeNull();
  run(game, 1);
  expect(stateOf(trike).slowed).toBe(true);
  expect(Math.hypot(trike.vx, trike.vy)).toBeCloseTo(WALK * config.slowShare);
});

test("a player behind it neither slows it nor hears its bell", () => {
  const game = world(125, 325);
  const trike = tricycleAt(game, { x: 300, y: 325 }, ROW);
  run(game, 0.2);
  expect(stateOf(trike).slowed).toBe(false);
  expect(rang(game)).toBe(false);
});

test("it runs a player down for 70", () => {
  const game = world(400, 325);
  tricycleAt(game, { x: 300, y: 325 }, ROW);
  run(game, 1.5);
  expect(game.local.health).toBe(game.local.maxHealth - config.damage);
});

test("it rides through a body it does not run down, leaving it unhurt and where it stood", () => {
  const game = world(FAR.x, FAR.y);
  const trike = tricycleAt(game, { x: 75, y: 325 }, ROW);
  const other = spawnEntity(game, "thumper", 300, 325, {
    ...freshThumper(game.worldTime),
    until: 1000,
  });
  run(game, 2.5);
  expect(trike.x).toBeGreaterThan(400);
  expect(other.x).toBeCloseTo(300);
  expect(other.y).toBeCloseTo(325);
  expect(other.health).toBe(other.maxHealth);
});

test("its next ride sets off the way it already heads, rather than doubling back", () => {
  // Its rides are drawn at random, here from fixed seeds, one per trial, so the test is the same
  // each run. From the middle of the open row, with room for a full ride both ways, every one of
  // many sets off within a right angle of its facing. (Facing a wall too near for a full ride, it
  // may well set off sideways: that is the backtracking it falls back to when nothing else goes.)
  for (let trial = 0; trial < 20; trial++)
    for (const facing of [0, Math.PI]) {
      let seed = trial + 1;
      vi.spyOn(Math, "random").mockImplementation(() => {
        // A small LCG; any fixed sequence spread over [0, 1) will do.
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
        return seed / 2 ** 31;
      });
      const game = world(FAR.x, 75);
      const trike = spawnEntity(game, "tricycle", 425, 325, {
        ...freshTricycle(game.worldTime, facing),
      });
      run(game, DT);
      const first = stateOf(trike).route.find(
        (point) => Math.hypot(point.x - 425, point.y - 325) >= 50,
      );
      if (first === undefined) throw new Error("no ride");
      const setsOff = Math.atan2(first.y - 325, first.x - 425);
      expect(Math.cos(setsOff - facing)).toBeGreaterThan(0);
      vi.mocked(Math.random).mockRestore();
    }
});

/** How far the middle of a 50px cell can be from a spot in it. */
const HALF_CELL_DIAGONAL = 25 * Math.SQRT2;

/** Where `trike`'s ride ends: the middle of the cell holding the spot it chose. */
function destinationOf(trike: WorldEntity): Point {
  const end = stateOf(trike).route.at(-1);
  if (end === undefined) throw new Error("no ride");
  return end;
}

test("it rides only to spots within range of a player, though no spot round it is", () => {
  const near = 150;
  const player = { x: 125, y: 525 };
  for (let trial = 0; trial < 10; trial++) {
    const game = world(player.x, player.y, {
      ...config,
      ride: { ...config.ride, near },
    });
    const trike = spawnEntity(game, "tricycle", 775, 175, {
      ...freshTricycle(game.worldTime),
    });
    run(game, DT);
    const end = destinationOf(trike);
    expect(Math.hypot(end.x - player.x, end.y - player.y)).toBeLessThanOrEqual(
      near + HALF_CELL_DIAGONAL,
    );
  }
});

test("it rides near whatever it runs down, not only near players", () => {
  const near = 150;
  const thumper = { x: 125, y: 525 };
  for (let trial = 0; trial < 10; trial++) {
    const game = world(875, 75, {
      ...config,
      targets: ["thumper"],
      ride: { ...config.ride, near },
    });
    spawnEntity(game, "thumper", thumper.x, thumper.y, {
      ...freshThumper(game.worldTime),
      until: 1000,
    });
    const trike = spawnEntity(game, "tricycle", 775, 175, {
      ...freshTricycle(game.worldTime),
    });
    run(game, DT);
    const end = destinationOf(trike);
    expect(
      Math.hypot(end.x - thumper.x, end.y - thumper.y),
    ).toBeLessThanOrEqual(near + HALF_CELL_DIAGONAL);
  }
});
