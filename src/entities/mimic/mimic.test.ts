import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import { itemContent } from "../../items/index.js";
import {
  createSession,
  hasKindTag,
  hurt,
  isAreaFree,
  ITEM_TAG,
  mulberry32,
  pickupTarget,
  receiveEvent,
  registerContent,
  removeEntity,
  seemsItem,
  spawnEntity,
  spawnWorldItem,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { freshMimic, mimic as mimicContent, MimicState } from "./index.js";
import type { MimicConfig } from "./index.js";

const DT = 1 / 60;
const { mimic: config } = testEntitiesConfig;

beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(3));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The dev square, 18x12 cells of 50px, walled round its edge, its pillars at x 200-300, y 50-150
 * and x 600-700, y 450-550, with mimics and the items; the local player stands at (x, y).
 */
function world(x: number, y: number, mimic: MimicConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "MIMIC",
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
    mimicContent.create({ mimic }),
    ...itemContent(testItemsConfig),
  ]);
  standAt(game, x, y);
  return game;
}

function standAt(game: Session, x: number, y: number): void {
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
}

/** Steps `seconds`, each sound the host sends heard at once; `each` sees every step. */
function run(
  game: Session,
  seconds: number,
  { interact = false, each }: { interact?: boolean; each?: () => void } = {},
): void {
  const controls = {
    move: { x: 0, y: 0 },
    aim: { x: 900, y: 600 },
    sprint: false,
    crouch: false,
    select: null,
    cycle: 0,
    use: false,
    holdingUse: false,
    secondary: false,
    interact,
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
    each?.();
  }
}

/** A mimic at `at`, facing right, along the open row through the square's middle. */
function mimicAt(game: Session, at: Point): WorldEntity {
  return spawnEntity(game, "mimic", at.x, at.y, freshMimic(game.worldTime, 9));
}

const stateOf = (entity: WorldEntity): MimicState =>
  MimicState.parse(entity.data);

const sounded = (game: Session, file: string): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith(file));

/** Far off in the corner, out of every mimic's notice in these tests. */
const AWAY = { x: 875, y: 575 };

/** Hides near what it copies, so the tests that place it by hand know where it stands. */
const near: MimicConfig = { ...config, hideRange: 40 };

/** Steps until `mimic` hides, up to `seconds`; throws if it never does. */
function untilHidden(game: Session, mimic: WorldEntity, seconds = 8): void {
  for (let waited = 0; waited < seconds; waited += 0.1) {
    if (stateOf(mimic).mode === "hide") return;
    run(game, 0.1);
  }
  if (stateOf(mimic).mode !== "hide") throw new Error("never hid");
}

/** An open spot `by` px from `body`, on whichever side is clear. */
function besideOf(game: Session, body: Point, by: number): Point {
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const at = { x: body.x + dx * by, y: body.y + dy * by };
    if (isAreaFree(game.world.map, at.x, at.y, 15)) return at;
  }
  throw new Error("boxed in");
}

test("it hides somewhere open within its hide range of an item it sees and poses as it, as an item to every rule", () => {
  const game = world(AWAY.x, AWAY.y);
  const shovel = spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const mimic = mimicAt(game, { x: 150, y: 325 });
  expect(seemsItem(game, mimic)).toBeNull();
  expect(hasKindTag(game, mimic.id, [ITEM_TAG])).toBe(false);
  untilHidden(game, mimic);
  const state = stateOf(mimic);
  expect(state.posing).toBe("shovel");
  const apart = Math.hypot(mimic.x - shovel.x, mimic.y - shovel.y);
  expect(apart).toBeLessThanOrEqual(config.hideRange + mimic.radius);
  expect(apart).toBeGreaterThan(mimic.radius);
  expect(isAreaFree(game.world.map, mimic.x, mimic.y, mimic.radius)).toBe(true);
  expect(seemsItem(game, mimic)?.item).toBe("shovel");
  expect(hasKindTag(game, mimic.id, [ITEM_TAG])).toBe(true);
  expect(sounded(game, "settle.mp3")).toBe(true);
  const { x, y } = mimic;
  run(game, 3);
  expect(mimic.x).toBe(x);
  expect(mimic.y).toBe(y);
});

test("it does not always hide right beside the item it copies", () => {
  const spots: number[] = [];
  for (let seed = 1; seed <= 6; seed++) {
    const game = world(AWAY.x, AWAY.y);
    spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
    const mimic = spawnEntity(
      game,
      "mimic",
      150,
      325,
      freshMimic(game.worldTime, seed),
    );
    untilHidden(game, mimic);
    spots.push(Math.hypot(mimic.x - 300, mimic.y - 325));
  }
  expect(Math.max(...spots)).toBeGreaterThan(config.hideRange / 4);
});

test("a body coming near springs it within its delay, and it bites like a zombie", () => {
  const game = world(AWAY.x, AWAY.y, near);
  spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const mimic = mimicAt(game, { x: 150, y: 325 });
  untilHidden(game, mimic);
  standAt(game, mimic.x + 60, mimic.y);
  let sprungAfter: number | null = null;
  const start = game.worldTime;
  run(game, config.springDelay.max + 0.2, {
    each: () => {
      if (sprungAfter === null && stateOf(mimic).mode === "hunt")
        sprungAfter = game.worldTime - start;
    },
  });
  expect(sprungAfter).not.toBeNull();
  expect(sprungAfter).toBeLessThanOrEqual(config.springDelay.max + 0.1);
  expect(stateOf(mimic).foe).toBe("me");
  expect(seemsItem(game, mimic)).toBeNull();
  expect(hasKindTag(game, mimic.id, [ITEM_TAG])).toBe(false);
  expect(sounded(game, "reveal.mp3")).toBe(true);
  run(game, 1);
  expect(game.local.health).toBeLessThanOrEqual(
    testSimConfig.player.maxHealth - config.attackDamage,
  );
  expect(sounded(game, "attack.mp3")).toBe(true);
});

test("hunting, it moves at its speed share of a player's walk", () => {
  const game = world(AWAY.x, AWAY.y);
  const mimic = mimicAt(game, { x: 150, y: 325 });
  standAt(game, 350, 325);
  run(game, 0.5);
  expect(stateOf(mimic).mode).toBe("hunt");
  expect(Math.hypot(mimic.vx, mimic.vy)).toBeCloseTo(
    testSimConfig.player.speed * config.speedShare,
  );
});

test("reaching to pick it up targets it as an item and springs it at once, taking nothing", () => {
  const slow = { ...near, springDelay: { min: 3, max: 3 } };
  const game = world(AWAY.x, AWAY.y, slow);
  const shovel = spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const mimic = mimicAt(game, { x: 150, y: 325 });
  untilHidden(game, mimic);
  // With the shovel gone, the mimic is the only item it touches.
  removeEntity(game, shovel.id);
  const at = besideOf(game, mimic, 20);
  standAt(game, at.x, at.y);
  run(game, DT);
  expect(stateOf(mimic).mode).toBe("hide");
  expect(pickupTarget(game)?.id).toBe(mimic.id);
  const carried = game.local.inventory.map((slot) => slot?.id ?? null);
  run(game, 0.1, { interact: true });
  expect(stateOf(mimic).mode).toBe("hunt");
  expect(stateOf(mimic).foe).toBe("me");
  expect(game.local.inventory.map((slot) => slot?.id ?? null)).toEqual(carried);
});

test("hurt while hiding, it springs at once on whatever hurt it", () => {
  const game = world(AWAY.x, AWAY.y);
  spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const mimic = mimicAt(game, { x: 150, y: 325 });
  untilHidden(game, mimic);
  hurt(game, mimic, 1, game.localId);
  run(game, DT);
  expect(stateOf(mimic).mode).toBe("hunt");
  expect(stateOf(mimic).foe).toBe("me");
});

test("its hiding over, it moves on to copy something new rather than what it copied", () => {
  const brief = { ...near, hideSeconds: { min: 1, max: 1 } };
  const game = world(AWAY.x, AWAY.y, brief);
  spawnWorldItem(game, { x: 150, y: 325 }, "shovel");
  spawnWorldItem(game, { x: 350, y: 325 }, "scrap");
  const mimic = mimicAt(game, { x: 110, y: 325 });
  untilHidden(game, mimic);
  expect(stateOf(mimic).posing).toBe("shovel");
  let next: string | null = null;
  run(game, 4, {
    each: () => {
      const { mode, posing } = stateOf(mimic);
      if (next === null && mode === "hide" && posing !== "shovel")
        next = posing;
    },
  });
  expect(next).toBe("scrap");
});

test("with only what it last copied about, it copies it again, but not until it has wandered a while", () => {
  const brief = { ...near, hideSeconds: { min: 1, max: 1 } };
  const game = world(AWAY.x, AWAY.y, brief);
  spawnWorldItem(game, { x: 150, y: 325 }, "shovel");
  const mimic = mimicAt(game, { x: 110, y: 325 });
  untilHidden(game, mimic);
  const hiding: { readonly at: number; readonly hides: boolean }[] = [];
  run(game, 15, {
    each: () => {
      hiding.push({
        at: game.worldTime,
        hides: stateOf(mimic).mode === "hide",
      });
    },
  });
  const left = hiding.find(({ hides }) => !hides);
  if (left === undefined) throw new Error("never left");
  const back = hiding.find(({ at, hides }) => at > left.at && hides);
  if (back === undefined) throw new Error("never came back");
  expect(back.at - left.at).toBeGreaterThanOrEqual(config.rehideAfter);
});

test("several mimics copy the same item", () => {
  const game = world(AWAY.x, AWAY.y);
  spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const first = mimicAt(game, { x: 150, y: 325 });
  untilHidden(game, first);
  const second = mimicAt(game, { x: 150, y: 325 });
  untilHidden(game, second);
  expect(stateOf(first).posing).toBe("shovel");
  expect(stateOf(second).posing).toBe("shovel");
  expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeGreaterThan(
    config.spacing,
  );
});

test("a mimic copies a mimic posing as an item, and a copy of a copy is of the real item", () => {
  const game = world(AWAY.x, AWAY.y, near);
  const shovel = spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const first = mimicAt(game, { x: 150, y: 325 });
  untilHidden(game, first);
  // The shovel gone, the posing mimic is the only item about to copy.
  removeEntity(game, shovel.id);
  const second = mimicAt(game, { x: 150, y: 325 });
  untilHidden(game, second);
  expect(stateOf(second).posing).toBe("shovel");
  expect(seemsItem(game, second)?.item).toBe("shovel");
  removeEntity(game, first.id);
  const third = mimicAt(game, { x: 150, y: 325 });
  untilHidden(game, third);
  expect(stateOf(third).posing).toBe("shovel");
  expect(seemsItem(game, third)?.item).toBe("shovel");
});

test("seeing nothing that seems an item but itself, it never copies itself", () => {
  const game = world(AWAY.x, AWAY.y, {
    ...near,
    hideSeconds: { min: 1, max: 1 },
  });
  const shovel = spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const mimic = mimicAt(game, { x: 150, y: 325 });
  untilHidden(game, mimic);
  removeEntity(game, shovel.id);
  run(game, 3);
  expect(stateOf(mimic).mode).toBe("wander");
});
