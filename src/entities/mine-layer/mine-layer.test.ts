import { describe, expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import { itemContent } from "../../items/index.js";
import {
  createSession,
  falls,
  hurt,
  hurtPlayer,
  itemInstances,
  lastHurtBy,
  receiveEvent,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { freshZombie, zombie as zombieContent } from "../zombie/index.js";
import { landMine, layMine, mines, MineState } from "../land-mine/index.js";
import { freshMineLayer, mineLayer, MineLayerState } from "./index.js";

const DT = 1 / 60;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 900, y: 600 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  secondary: false,
  interact: false,
  drop: false,
  holdingUse: false,
};
const { mineLayer: config, landMine: mineConfig } = testEntitiesConfig;

/** The dev square, 18x12 cells, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550. */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "MINES",
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
    landMine.create({ landMine: mineConfig }),
    mineLayer.create({ mineLayer: config }),
    zombieContent.create({ zombie: testEntitiesConfig.zombie }),
    ...itemContent(testItemsConfig),
  ]);
  standAt(game, 875, 575);
  return game;
}

function standAt(game: Session, x: number, y: number): void {
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
}

/** Leaves the local player a ghost, so nothing sees or sets anything off by it. */
function noPlayer(game: Session): void {
  hurtPlayer(game, game.local, Infinity);
}

/** Steps `seconds`, each sound the host sends heard at once. */
function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, idle, DT);
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

const layerAt = (game: Session, x: number, y: number): WorldEntity =>
  spawnEntity(game, "mineLayer", x, y, freshMineLayer(game.worldTime, config));

const stateOf = (entity: WorldEntity): MineLayerState =>
  MineLayerState.parse(entity.data);

const mineState = (entity: WorldEntity): MineState =>
  MineState.parse(entity.data);

/** The first mine lying in the world; fails the test when there is none. */
function firstMine(game: Session): WorldEntity {
  const [mine] = mines(game);
  if (mine === undefined) throw new Error("No mine lies in the world");
  return mine;
}

const sounded = (game: Session, file: string): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith(`/${file}`));

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe("land mine", () => {
  test("it arms after its arm time with a beep, then beeps every few seconds", () => {
    const game = world();
    noPlayer(game);
    layMine(game, { x: 450, y: 300 });
    const mine = firstMine(game);
    run(game, mineConfig.armSeconds - 0.1);
    expect(mineState(mine).beepAt).toBeNull();
    expect(sounded(game, "arm.mp3")).toBe(false);
    run(game, 0.2);
    expect(mineState(mine).beepAt).not.toBeNull();
    expect(sounded(game, "arm.mp3")).toBe(true);
    expect(sounded(game, "beep.mp3")).toBe(false);
    run(game, mineConfig.beepGap);
    expect(sounded(game, "beep.mp3")).toBe(true);
    expect(mines(game)).toHaveLength(1);
  });

  test("a player near it once it arms sets it off: a beep, then a burst hurting by distance, credited to the mine", () => {
    const game = world();
    standAt(game, 500, 300);
    layMine(game, { x: 450, y: 300 });
    const mine = firstMine(game);
    run(game, mineConfig.armSeconds - 0.1);
    expect(game.local.health).toBe(testSimConfig.player.maxHealth);
    run(game, 0.2);
    expect(sounded(game, "trigger.mp3")).toBe(true);
    expect(sounded(game, "blast.mp3")).toBe(false);
    expect(game.local.health).toBe(testSimConfig.player.maxHealth);
    run(game, mineConfig.fuse);
    expect(sounded(game, "blast.mp3")).toBe(true);
    // 50px off, halfway out: 90 damage.
    expect(testSimConfig.player.maxHealth - game.local.health).toBeCloseTo(90);
    expect(lastHurtBy(game, game.localId)).toBe(mine.id);
    expect(mines(game)).toHaveLength(0);
  });

  test("its burst makes a noise heard far off", () => {
    const game = world();
    standAt(game, 500, 300);
    layMine(game, { x: 450, y: 300 });
    let loudest = 0;
    for (let step = 0; step < 4 / DT; step++) {
      run(game, DT);
      for (const noise of game.noises)
        loudest = Math.max(loudest, noise.radius);
    }
    expect(loudest).toBe(mineConfig.sounds.blast);
  });

  test("a player out of its range leaves it be", () => {
    const game = world();
    standAt(game, 450, 300 + mineConfig.triggerRange + 40);
    layMine(game, { x: 450, y: 300 });
    run(game, mineConfig.armSeconds + 2);
    expect(mines(game)).toHaveLength(1);
    expect(sounded(game, "trigger.mp3")).toBe(false);
  });

  test("any body sets it off, a monster too, but neither a mine layer nor another mine does", () => {
    const game = world();
    noPlayer(game);
    layMine(game, { x: 450, y: 300 });
    layMine(game, { x: 470, y: 300 });
    const layer = layerAt(game, 430, 300);
    run(game, mineConfig.armSeconds + 1);
    expect(mines(game)).toHaveLength(2);
    expect(layer.health).toBe(config.maxHealth);

    const other = world();
    noPlayer(other);
    layMine(other, { x: 450, y: 300 });
    run(other, mineConfig.armSeconds + 0.1);
    const zombie = spawnEntity(
      other,
      "zombie",
      450,
      360,
      freshZombie(1, 0, testEntitiesConfig.zombie),
    );
    run(other, mineConfig.fuse + 0.1);
    expect(mines(other)).toHaveLength(0);
    expect(zombie.health).toBeLessThan(testEntitiesConfig.zombie.maxHealth);
  });

  test("a body its burst kills falls to the mine, by name, though the mine is gone", () => {
    const game = world();
    noPlayer(game);
    layMine(game, { x: 450, y: 300 });
    const mine = firstMine(game);
    run(game, mineConfig.armSeconds + 0.1);
    const zombie = spawnEntity(
      game,
      "zombie",
      460,
      300,
      freshZombie(1, 0, testEntitiesConfig.zombie),
    );
    run(game, mineConfig.fuse + 0.1);
    const fall = falls.get(game).find(({ victim }) => victim.id === zombie.id);
    expect(fall?.by).toMatchObject({ id: mine.id, kind: "landMine" });
  });

  test("one mine's burst sets off another it reaches, armed or not", () => {
    const game = world();
    standAt(game, 500, 300);
    layMine(game, { x: 450, y: 300 });
    run(game, 1);
    noPlayer(game);
    standAt(game, 875, 575);
    layMine(game, { x: 380, y: 300 });
    hurt(game, firstMine(game), 1, null);
    run(game, mineConfig.fuse + 0.1);
    expect(mines(game)).toHaveLength(1);
    run(game, mineConfig.fuse + 0.1);
    expect(mines(game)).toHaveLength(0);
  });
});

describe("mine layer", () => {
  test("it leaves golden scrap where it arrives", () => {
    const game = world();
    noPlayer(game);
    const layer = layerAt(game, 450, 300);
    run(game, DT);
    expect(stateOf(layer).home).toEqual({ x: 450, y: 300 });
    const gold = itemInstances(game, "goldenScrap").filter(
      ({ place }) => "lying" in place,
    );
    expect(gold).toHaveLength(1);
    expect(gold[0]?.at).toMatchObject({ x: 450, y: 300 });
  });

  test("alone, it circles its home, ring by ring further out, laying a mine every so often", () => {
    const game = world();
    noPlayer(game);
    const layer = layerAt(game, 450, 300);
    run(game, config.layGap.wander - 0.5);
    expect(mines(game)).toHaveLength(0);
    run(game, 1);
    expect(mines(game)).toHaveLength(1);
    expect(sounded(game, "lay.mp3")).toBe(true);
    const home = { x: 450, y: 300 };
    let furthest = 0;
    for (let second = 0; second < 15; second++) {
      run(game, 1);
      furthest = Math.max(furthest, distance(layer, home));
      expect(stateOf(layer).mode).toBe("wander");
    }
    expect(furthest).toBeGreaterThan(config.orbit.min);
    expect(furthest).toBeLessThanOrEqual(config.orbit.max + layer.radius);
    expect(stateOf(layer).ring).toBeGreaterThan(config.orbit.min);
    expect(mines(game).length).toBeGreaterThanOrEqual(2);
  });

  test("seeing a player, it runs from it, laying mines faster, until it has not seen one for a while", () => {
    const game = world();
    standAt(game, 350, 300);
    const layer = layerAt(game, 450, 300);
    run(game, 0.1);
    expect(stateOf(layer).mode).toBe("flee");
    run(game, 1);
    expect(distance(layer, game.local)).toBeGreaterThan(150);
    run(game, config.layGap.flee);
    expect(mines(game)).toHaveLength(1);
    expect(stateOf(layer).layAt - game.worldTime).toBeLessThanOrEqual(
      config.layGap.flee,
    );
    // Out of its sight for good, it calms down once its calm time has passed.
    noPlayer(game);
    run(game, config.calmSeconds + 0.5);
    expect(stateOf(layer).mode).toBe("wander");
  });

  test("it flees a monster it sees as it would a player", () => {
    const game = world();
    noPlayer(game);
    const layer = layerAt(game, 450, 300);
    spawnEntity(
      game,
      "zombie",
      380,
      300,
      freshZombie(1, 0, testEntitiesConfig.zombie),
    );
    run(game, 0.1);
    expect(stateOf(layer).mode).toBe("flee");
  });
});
