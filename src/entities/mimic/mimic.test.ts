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
  ITEM_TAG,
  mulberry32,
  pickupTarget,
  receiveEvent,
  registerContent,
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

test("it walks to an item it sees and poses as it, standing still, as an item to every rule", () => {
  const game = world(AWAY.x, AWAY.y);
  spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const mimic = mimicAt(game, { x: 150, y: 325 });
  expect(seemsItem(game, mimic)).toBeNull();
  expect(hasKindTag(game, mimic.id, [ITEM_TAG])).toBe(false);
  run(game, 2);
  const state = stateOf(mimic);
  expect(state.mode).toBe("hide");
  expect(state.posing).toBe("shovel");
  expect(Math.hypot(mimic.x - 300, mimic.y - 325)).toBeLessThan(
    mimic.radius + testSimConfig.worldItems.radius + config.settleGap + 1,
  );
  expect(seemsItem(game, mimic)?.item).toBe("shovel");
  expect(hasKindTag(game, mimic.id, [ITEM_TAG])).toBe(true);
  expect(sounded(game, "settle.mp3")).toBe(true);
  const { x, y } = mimic;
  run(game, 3);
  expect(mimic.x).toBe(x);
  expect(mimic.y).toBe(y);
});

test("a body coming near springs it within its delay, and it bites like a zombie", () => {
  const game = world(AWAY.x, AWAY.y);
  spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const mimic = mimicAt(game, { x: 150, y: 325 });
  run(game, 2);
  expect(stateOf(mimic).mode).toBe("hide");
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

test("hunting, it moves at 0.8 times a player's walk", () => {
  const game = world(AWAY.x, AWAY.y);
  const mimic = mimicAt(game, { x: 150, y: 325 });
  standAt(game, 350, 325);
  run(game, 0.5);
  expect(stateOf(mimic).mode).toBe("hunt");
  expect(Math.hypot(mimic.vx, mimic.vy)).toBeCloseTo(
    testSimConfig.player.speed * 0.8,
  );
});

test("reaching to pick it up targets it as an item and springs it at once, taking nothing", () => {
  const slow = { ...config, springDelay: { min: 3, max: 3 } };
  const game = world(AWAY.x, AWAY.y, slow);
  spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const mimic = mimicAt(game, { x: 150, y: 325 });
  run(game, 2);
  expect(stateOf(mimic).mode).toBe("hide");
  // On its far side from the shovel it poses beside, so the mimic is the nearest it touches.
  standAt(game, mimic.x - 20, mimic.y);
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
  run(game, 2);
  expect(stateOf(mimic).mode).toBe("hide");
  hurt(game, mimic, 1, game.localId);
  run(game, DT);
  expect(stateOf(mimic).mode).toBe("hunt");
  expect(stateOf(mimic).foe).toBe("me");
});

test("its hiding over, it moves on to hide somewhere new rather than where it was", () => {
  const brief = { ...config, hideSeconds: { min: 1, max: 1 } };
  const game = world(AWAY.x, AWAY.y, brief);
  spawnWorldItem(game, { x: 150, y: 325 }, "shovel");
  spawnWorldItem(game, { x: 350, y: 325 }, "scrap");
  const mimic = mimicAt(game, { x: 110, y: 325 });
  run(game, 1);
  expect(stateOf(mimic).posing).toBe("shovel");
  let next: string | null = null;
  run(game, 3, {
    each: () => {
      const { mode, posing } = stateOf(mimic);
      if (next === null && mode === "hide" && posing !== "shovel")
        next = posing;
    },
  });
  expect(next).toBe("scrap");
});

test("with only its last spot about, it hides there again, but not until it has wandered a while", () => {
  const brief = { ...config, hideSeconds: { min: 1, max: 1 } };
  const game = world(AWAY.x, AWAY.y, brief);
  spawnWorldItem(game, { x: 150, y: 325 }, "shovel");
  const mimic = mimicAt(game, { x: 110, y: 325 });
  run(game, 0.5);
  expect(stateOf(mimic).mode).toBe("hide");
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

test("a second mimic will not hide by an item another already poses beside", () => {
  const game = world(AWAY.x, AWAY.y);
  spawnWorldItem(game, { x: 300, y: 325 }, "shovel");
  const first = mimicAt(game, { x: 150, y: 325 });
  run(game, 2);
  expect(stateOf(first).mode).toBe("hide");
  const second = mimicAt(game, { x: 150, y: 325 });
  run(game, 2);
  expect(stateOf(second).mode).not.toBe("hide");
});
