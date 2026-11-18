import { expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  hurt,
  receiveEvent,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { door as doorContent, DoorState } from "../door/index.js";
import { freshThumper, thumper as thumperContent } from "../thumper/index.js";
import {
  freshTricycle,
  onWay,
  tricycle as tricycleContent,
  TricycleState,
} from "./index.js";

const DT = 1 / 60;
const {
  tricycle: config,
  thumper: thumperConfig,
  door: doorConfig,
} = testEntitiesConfig;
const WALK = testSimConfig.player.speed;

/**
 * The dev square, 18x12 cells of 50px, walled round its edge, its pillars at x 200-300, y 50-150
 * and x 600-700, y 450-550; the local player, ME, stands at (x, y). A thumper may be spawned too,
 * as a body that is not a player. Tricycles are as `trikeConfig` has them and thumpers as
 * `thumpers` has them, the test config's by default.
 */
function world(
  x: number,
  y: number,
  trikeConfig = config,
  thumpers = thumperConfig,
): Session {
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
    thumperContent.create({ thumper: thumpers }),
    doorContent.create({ door: doorConfig }),
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

/** The test thumper, but sparing tricycles, so one passing through it does not hurt it. */
const sparing = {
  ...thumperConfig,
  ignores: [...thumperConfig.ignores, "tricycle"],
};

test("it rides through a body it does not run down, leaving it unhurt and where it stood", () => {
  const game = world(FAR.x, FAR.y, config, sparing);
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

/**
 * Runs `body` with `Math.random` drawing from a fixed sequence for `seed`, so a test of its
 * random rides is the same each run.
 */
function seeded(seed: number, body: () => void): void {
  let state = seed;
  vi.spyOn(Math, "random").mockImplementation(() => {
    // A small LCG; any fixed sequence spread over [0, 1) will do.
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  });
  try {
    body();
  } finally {
    vi.mocked(Math.random).mockRestore();
  }
}

/** Which way `trike`'s ride sets off from `from`: to its first waypoint a cell off. */
function setsOff(trike: WorldEntity, from: Point): number {
  const first = stateOf(trike).route.find(
    (point) => Math.hypot(point.x - from.x, point.y - from.y) >= 50,
  );
  if (first === undefined) throw new Error("no ride");
  return Math.atan2(first.y - from.y, first.x - from.x);
}

/** Whether `trike`'s ride, from `from`, comes within `range` of `body`. */
function ridesBy(
  trike: WorldEntity,
  from: Point,
  body: Point,
  range: number,
): boolean {
  const radius = range / 2;
  return onWay(
    { ...from, radius },
    stateOf(trike).route,
    { ...body, radius },
    Infinity,
  );
}

/** The test config, but running down only thumpers: with none spawned, it runs down no one. */
const thumperHunting = { ...config, targets: ["thumper"] };

test("its next ride sets off the way it already heads, rather than doubling back", () => {
  // From the middle of the open row, with room for a full ride both ways, every one of many sets
  // off within a right angle of its facing. (Facing a wall too near for a full ride, it may well
  // set off sideways: that is the backtracking it falls back to when nothing else goes.)
  for (let trial = 0; trial < 20; trial++)
    for (const facing of [0, Math.PI])
      seeded(trial + 1, () => {
        const game = world(FAR.x, 75, thumperHunting);
        const at = { x: 425, y: 325 };
        const trike = spawnEntity(game, "tricycle", at.x, at.y, {
          ...freshTricycle(game.worldTime, facing),
        });
        run(game, DT);
        expect(Math.cos(setsOff(trike, at) - facing)).toBeGreaterThan(0);
      });
});

test("its rides are long: at least its ride's min along the way", () => {
  for (let trial = 0; trial < 20; trial++)
    seeded(trial + 1, () => {
      const game = world(FAR.x, 75, thumperHunting);
      const at = { x: 425, y: 325 };
      const trike = spawnEntity(game, "tricycle", at.x, at.y, {
        ...freshTricycle(game.worldTime, (trial / 20) * Math.PI * 2),
      });
      run(game, DT);
      let from: Point = at;
      let length = 0;
      for (const point of stateOf(trike).route) {
        length += Math.hypot(point.x - from.x, point.y - from.y);
        from = point;
      }
      expect(length).toBeGreaterThanOrEqual(config.ride.min);
    });
});

test("it rides by a player ahead and on past them, rather than up to them", () => {
  const player = { x: 425, y: 325 };
  const at = { x: 125, y: 325 };
  for (let trial = 0; trial < 20; trial++)
    seeded(trial + 1, () => {
      const game = world(player.x, player.y);
      const trike = spawnEntity(game, "tricycle", at.x, at.y, {
        ...freshTricycle(game.worldTime, 0),
      });
      run(game, DT);
      expect(ridesBy(trike, at, player, config.ride.pass)).toBe(true);
      const end = destinationOf(trike);
      expect(Math.hypot(end.x - player.x, end.y - player.y)).toBeGreaterThan(
        config.ride.pass,
      );
    });
});

test("it rides by a player off to its side, though not straight ahead", () => {
  const player = { x: 425, y: 325 };
  const at = { x: 425, y: 75 };
  for (let trial = 0; trial < 20; trial++)
    seeded(trial + 1, () => {
      const game = world(player.x, player.y);
      const trike = spawnEntity(game, "tricycle", at.x, at.y, {
        ...freshTricycle(game.worldTime, 0),
      });
      run(game, DT);
      expect(ridesBy(trike, at, player, config.ride.pass)).toBe(true);
    });
});

test("having just passed the only player, it rides on rather than turning back for them", () => {
  const player = { x: 350, y: 325 };
  const at = { x: 425, y: 325 };
  for (let trial = 0; trial < 20; trial++)
    seeded(trial + 1, () => {
      const game = world(player.x, player.y);
      const trike = spawnEntity(game, "tricycle", at.x, at.y, {
        ...freshTricycle(game.worldTime, 0),
      });
      run(game, DT);
      expect(stateOf(trike).passed[game.localId]).toBeDefined();
      expect(Math.cos(setsOff(trike, at))).toBeGreaterThan(0);
    });
});

test("of two bodies it runs down, it rides by the one it has not lately passed", () => {
  const at = { x: 425, y: 325 };
  const west = { x: 225, y: 250 };
  const east = { x: 625, y: 250 };
  for (let trial = 0; trial < 10; trial++)
    for (const [lately, other] of [
      [west, east],
      [east, west],
    ] as const)
      seeded(trial + 1, () => {
        const game = world(FAR.x, FAR.y, thumperHunting);
        const thumpers = [lately, other].map((spot) =>
          spawnEntity(game, "thumper", spot.x, spot.y, {
            ...freshThumper(game.worldTime),
            until: 1000,
          }),
        );
        const trike = spawnEntity(game, "tricycle", at.x, at.y, {
          ...freshTricycle(game.worldTime, -Math.PI / 2),
          passed: { [thumpers[0]?.id ?? ""]: game.worldTime },
        });
        run(game, DT);
        expect(ridesBy(trike, at, other, config.ride.pass)).toBe(true);
        expect(ridesBy(trike, at, lately, config.ride.pass)).toBe(false);
      });
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

test("it forgets passing a body once its rest has run out", () => {
  const game = world(FAR.x, FAR.y);
  const trike = spawnEntity(game, "tricycle", 75, 325, {
    ...freshTricycle(game.worldTime),
    route: ROW,
    passed: {
      lately: game.worldTime - config.ride.rest / 2,
      long: game.worldTime - config.ride.rest,
    },
  });
  run(game, DT);
  expect(Object.keys(stateOf(trike).passed)).toEqual(["lately"]);
});

const raged = (game: Session): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith("rage.mp3"));

test("hurt by a player, it rages with a furious ring, turning on them and charging them at twice a walk", () => {
  // Behind it, so it would never turn for them calm.
  const game = world(125, 325);
  const trike = tricycleAt(game, { x: 425, y: 325 }, ROW);
  hurt(game, trike, 10, game.localId);
  run(game, DT);
  expect(stateOf(trike).foe).toBe(game.localId);
  expect(raged(game)).toBe(true);
  let fastest = 0;
  for (let step = 0; step < 90 && trike.x > game.local.x; step++) {
    run(game, DT);
    fastest = Math.max(fastest, Math.hypot(trike.vx, trike.vy));
  }
  expect(trike.vx).toBeLessThan(0);
  expect(fastest).toBeCloseTo(WALK * config.rage.speedShare);
});

test("raging, it rides on through whatever hurt it, past them, rather than stopping at them", () => {
  const game = world(400, 325);
  const trike = tricycleAt(game, { x: 700, y: 325 }, ROW);
  hurt(game, trike, 10, game.localId);
  run(game, DT);
  const end = stateOf(trike).route.at(-1);
  expect(end?.x).toBeLessThan(400 - config.ride.pass);
  run(game, 1.5);
  expect(game.local.health).toBe(game.local.maxHealth - config.damage);
});

test("its rage ends after its rage seconds, and it rides on calm", () => {
  const game = world(125, 325);
  const trike = tricycleAt(game, { x: 300, y: 325 }, ROW);
  hurt(game, trike, 10, game.localId);
  run(game, DT);
  expect(stateOf(trike).foe).not.toBeNull();
  // Out of reach in the far corner, so it never runs them down meanwhile.
  Object.assign(game.local, { x: FAR.x, y: FAR.y, prevX: FAR.x, prevY: FAR.y });
  run(game, config.rage.seconds);
  expect(stateOf(trike).foe).toBeNull();
  expect(Math.hypot(trike.vx, trike.vy)).toBeLessThanOrEqual(
    WALK * config.speedShare + 1e-6,
  );
});

test("hurt by a body it does not run down, it rages at that body and strikes it", () => {
  const game = world(FAR.x, FAR.y);
  const trike = tricycleAt(game, { x: 75, y: 325 }, ROW);
  const other = spawnEntity(game, "thumper", 400, 325, {
    ...freshThumper(game.worldTime),
    until: 1000,
  });
  hurt(game, trike, 10, other.id);
  run(game, 0.1);
  expect(stateOf(trike).foe).toBe(other.id);
  run(game, 1.5);
  expect(other.health).toBeLessThan(other.maxHealth);
});

test("no more than its plans a step plan a ride in one step; the rest plan in a later one", () => {
  seeded(1, () => {
    const game = world(FAR.x, 75, {
      ...thumperHunting,
      ride: { ...config.ride, plansPerStep: 2 },
    });
    const trikes = [375, 425, 475].map((x) =>
      spawnEntity(game, "tricycle", x, 325, freshTricycle(game.worldTime)),
    );
    const riding = () =>
      trikes.filter((trike) => stateOf(trike).route.length > 0).length;
    run(game, DT);
    expect(riding()).toBe(2);
    run(game, DT);
    expect(riding()).toBe(3);
  });
});

/** The doorway: column 9 of the dev square walled top to bottom but for row 5, a door in it. */
const DOOR_AT = { x: 475, y: 275 };

/** `game`'s dev square walled down column 9 but for the doorway, a shut door standing in it. */
function shutDoorAcross(game: Session): WorldEntity {
  const { map } = game.world;
  for (let row = 0; row < map.rows; row++)
    if (row !== 5) map.solid[row * map.cols + 9] = 1;
  const state: DoorState = { open: false, across: true };
  return spawnEntity(game, "door", DOOR_AT.x, DOOR_AT.y, state);
}

/** Whether `route`, ridden from `from`, comes within a cell's half of the doorway's middle. */
const throughDoor = (from: Point, route: readonly Point[]): boolean =>
  onWay({ ...from, radius: 1 }, route, { ...DOOR_AT, radius: 24 }, Infinity);

test("its rides go round a shut door, never through it, though only past it is a player", () => {
  seeded(1, () => {
    // The player shut off beyond the door; every ride toward them would go through it.
    const game = world(FAR.x, FAR.y);
    const door = shutDoorAcross(game);
    const at = { x: 325, y: 275 };
    const trike = spawnEntity(game, "tricycle", at.x, at.y, {
      ...freshTricycle(game.worldTime),
    });
    run(game, DT);
    // With no way to the player, it rides about on its own side rather than standing.
    expect(stateOf(trike).route.length).toBeGreaterThan(0);
    expect(throughDoor(at, stateOf(trike).route)).toBe(false);
    run(game, 4);
    expect(trike.x).toBeLessThan(DOOR_AT.x);
    expect(door.health).toBe(door.maxHealth);
    expect(DoorState.parse(door.data).open).toBe(false);
  });
});

test("a door shut across a ride it is on, it plans another rather than standing at the door", () => {
  seeded(2, () => {
    const game = world(FAR.x, 75, thumperHunting);
    const door = shutDoorAcross(game);
    // A ride planned before the door shut, through the doorway and on.
    const trike = tricycleAt(game, { x: 225, y: 275 }, [{ x: 825, y: 275 }]);
    run(game, 3);
    expect(trike.x).toBeLessThan(DOOR_AT.x);
    expect(
      Math.hypot(trike.x - DOOR_AT.x, trike.y - DOOR_AT.y),
    ).toBeGreaterThan(100);
    expect(stateOf(trike).route.length).toBeGreaterThan(0);
    expect(throughDoor(trike, stateOf(trike).route)).toBe(false);
    expect(door.health).toBe(door.maxHealth);
  });
});

test("held up on a ride, getting nowhere along it for its stall seconds, it plans another", () => {
  // At no speed at all it makes no headway, whatever its way.
  const game = world(FAR.x, 75, { ...thumperHunting, speedShare: 0 });
  const ride = [{ x: 825, y: 325 }];
  const trike = tricycleAt(game, { x: 425, y: 325 }, ride);
  run(game, config.stall.seconds - 0.1);
  expect(stateOf(trike).route).toEqual(ride);
  run(game, 0.2);
  expect(stateOf(trike).route).not.toEqual(ride);
  expect(stateOf(trike).route.length).toBeGreaterThan(0);
});

/**
 * Steps `trike` a step at a time, up to `seconds`, until `done`, calling `each` with its heading
 * and speed before and after every step.
 */
function track(
  game: Session,
  trike: WorldEntity,
  seconds: number,
  each: (before: TricycleState, after: TricycleState) => void,
  done: () => boolean = () => false,
): void {
  for (let step = 0; step < Math.round(seconds / DT) && !done(); step++) {
    const before = stateOf(trike);
    run(game, DT);
    each(before, stateOf(trike));
  }
}

const turnOf = (before: TricycleState, after: TricycleState): number =>
  Math.abs(
    Math.atan2(
      Math.sin(after.facing - before.facing),
      Math.cos(after.facing - before.facing),
    ),
  );

test("it turns no faster than its turn rate, slowing into a sharp turn, and still reaches its ride's end", () => {
  const game = world(FAR.x, 75, thumperHunting);
  const cruise = WALK * config.speedShare;
  // East along the open row, then sharply back west and a little down: a turn of near 170°.
  const end = { x: 475, y: 375 };
  const trike = spawnEntity(game, "tricycle", 425, 325, {
    ...freshTricycle(game.worldTime, 0),
    speed: cruise,
    route: [{ x: 725, y: 325 }, end],
  });
  let sharpest = 0;
  let slowest = Infinity;
  let reached = false;
  track(
    game,
    trike,
    4,
    (before, after) => {
      sharpest = Math.max(sharpest, turnOf(before, after));
      if (turnOf(before, after) > 0) slowest = Math.min(slowest, after.speed);
    },
    () => {
      reached ||=
        Math.hypot(trike.x - end.x, trike.y - end.y) <= config.handling.reach;
      return reached;
    },
  );
  expect(reached).toBe(true);
  expect(sharpest).toBeGreaterThan(0);
  expect(sharpest).toBeLessThanOrEqual(config.handling.turnRate * DT + 1e-6);
  expect(slowest).toBeLessThan(cruise / 2);
  // Braking into it, its wheels skid.
  expect(
    vi
      .mocked(game.sfx.play)
      .mock.calls.some(([url]) => url.endsWith("skid.mp3")),
  ).toBe(true);
});

test("from a stand it gains speed no faster than its acceleration, up to its cruise", () => {
  const game = world(FAR.x, FAR.y);
  const trike = tricycleAt(game, { x: 75, y: 325 }, ROW);
  const speeds: number[] = [];
  track(game, trike, 1, (before, after) => {
    expect(after.speed - before.speed).toBeLessThanOrEqual(
      config.handling.acceleration * DT + 0.1,
    );
    speeds.push(after.speed);
  });
  expect(speeds[0]).toBeCloseTo(config.handling.acceleration * DT, 0);
  expect(speeds.at(-1)).toBeCloseTo(WALK * config.speedShare, 0);
  expect(speeds).toEqual([...speeds].sort((a, b) => a - b));
});

test("turning round near where it was, it is not held up: it keeps its ride rather than planning another", () => {
  const game = world(FAR.x, 75, {
    ...thumperHunting,
    // Short of this in a fraction of a second would count as held up, but for its turning.
    stall: { distance: 50, seconds: 0.2 },
  });
  // A spot just behind it, moving fast: it must come round in a tight loop to reach it.
  const behind = { x: 375, y: 325 };
  const trike = spawnEntity(game, "tricycle", 425, 325, {
    ...freshTricycle(game.worldTime, 0),
    speed: WALK * config.speedShare,
    route: [behind],
  });
  let kept = true;
  track(
    game,
    trike,
    3,
    () => undefined,
    () => {
      const route = stateOf(trike).route;
      if (route.length === 1 && route[0]?.x === behind.x) return false;
      kept =
        Math.hypot(trike.x - behind.x, trike.y - behind.y) <=
        config.handling.reach + WALK * config.speedShare * DT;
      return true;
    },
  );
  expect(kept).toBe(true);
});
