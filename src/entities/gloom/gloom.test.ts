import { z } from "zod";
import { describe, expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  hurt,
  hurtPlayer,
  isLit,
  isShrouded,
  receiveEvent,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { mineLayer, freshMineLayer } from "../mine-layer/index.js";
import { avoidingLight } from "../route.js";
import { freshSleeper, sleeper, SleeperState } from "../sleeper/index.js";
import { freshStatue, statue } from "../statue/index.js";
import { freshGloom, gloom, GloomState } from "./index.js";

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
const {
  gloom: config,
  sleeper: sleeperConfig,
  statue: statueConfig,
  mineLayer: layerConfig,
} = testEntitiesConfig;

/**
 * The dev square, 18x12 cells, dark, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550,
 * with no living player in it, so nothing hunts or flees one.
 */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "GLOOM",
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
    gloom.create({ gloom: config }),
    sleeper.create({ sleeper: sleeperConfig }),
    statue.create({ statue: statueConfig }),
    mineLayer.create({ mineLayer: layerConfig }),
  ]);
  registerEntityType(game, "lamp", {
    radius: 5,
    maxHealth: 1,
    collides: false,
    data: z.object({}),
    light: () => ({ range: 900 }),
    draw: () => undefined,
  });
  hurtPlayer(game, game.local, Infinity);
  return game;
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

const gloomAt = (game: Session, at: Point): WorldEntity =>
  spawnEntity(game, "gloom", at.x, at.y, freshGloom(game.worldTime));

const sleeperAt = (game: Session, at: Point): WorldEntity =>
  spawnEntity(
    game,
    "sleeper",
    at.x,
    at.y,
    freshSleeper(game.worldTime, sleeperConfig),
  );

const stateOf = (entity: WorldEntity): GloomState =>
  GloomState.parse(entity.data);

const sounded = (game: Session, file: string): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith(`/${file}`));

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe("gloom", () => {
  test("it follows the body it sees of the rarest kind that shuns light over one that pays light no mind", () => {
    const game = world();
    const self = gloomAt(game, { x: 450, y: 300 });
    // Nearest of all, but light is nothing to a mine layer.
    spawnEntity(
      game,
      "mineLayer",
      480,
      300,
      freshMineLayer(game.worldTime, layerConfig),
    );
    sleeperAt(game, { x: 400, y: 300 });
    sleeperAt(game, { x: 520, y: 300 });
    const rare = spawnEntity(
      game,
      "statue",
      450,
      420,
      freshStatue(game.worldTime),
    );
    run(game, DT);
    expect(stateOf(self).followee).toBe(rare.id);
    expect(sounded(game, "latch.mp3")).toBe(true);
  });

  test("with no kind that shuns light in sight, it follows one that pays light no mind, never another gloom", () => {
    const game = world();
    const self = gloomAt(game, { x: 450, y: 300 });
    gloomAt(game, { x: 470, y: 300 });
    const layer = spawnEntity(
      game,
      "mineLayer",
      550,
      300,
      freshMineLayer(game.worldTime, layerConfig),
    );
    run(game, DT);
    expect(stateOf(self).followee).toBe(layer.id);
  });

  test("among kinds as rare, it follows the nearest", () => {
    const game = world();
    const self = gloomAt(game, { x: 450, y: 300 });
    sleeperAt(game, { x: 300, y: 300 });
    const near = sleeperAt(game, { x: 520, y: 300 });
    run(game, DT);
    expect(stateOf(self).followee).toBe(near.id);
  });

  test("it drifts with no one to follow", () => {
    const game = world();
    const self = gloomAt(game, { x: 450, y: 300 });
    run(game, config.wanderPause.max + 1);
    expect(stateOf(self).followee).toBeNull();
    expect(distance(self, { x: 450, y: 300 })).toBeGreaterThan(0);
  });

  test("it keeps close to whom it follows, and shrouds them, so they take the world for dark", () => {
    const game = world();
    spawnEntity(game, "lamp", 100, 300, {});
    const self = gloomAt(game, { x: 400, y: 300 });
    const followed = sleeperAt(game, { x: 750, y: 300 });
    run(game, 3);
    expect(stateOf(self).followee).toBe(followed.id);
    expect(distance(self, followed)).toBeLessThanOrEqual(
      config.followDistance + 1,
    );
    expect(isShrouded(game, followed.id)).toBe(true);
    // Lit ground far off, out of the gloom's darkness: she would steer round it, but not now.
    const lit = { col: 2, row: 6 };
    expect(isLit(game, { x: 125, y: 325 })).toBe(true);
    expect(avoidingLight(game, followed.id)(lit)).toBe(false);
    expect(avoidingLight(game, "someone else")(lit)).toBe(true);
    // The light on her wakes her no more.
    expect(SleeperState.parse(followed.data).mode).toBe("dormant");
  });

  test("its shroud wears off once it is gone", () => {
    const game = world();
    const self = gloomAt(game, { x: 450, y: 300 });
    const followed = sleeperAt(game, { x: 520, y: 300 });
    run(game, DT);
    expect(isShrouded(game, followed.id)).toBe(true);
    hurt(game, self, 1, null);
    run(game, config.shroudSeconds + 0.1);
    expect(isShrouded(game, followed.id)).toBe(false);
  });

  test("darkness round it unlights what any light reaches, out to its dark radius", () => {
    const game = world();
    spawnEntity(game, "lamp", 100, 300, {});
    gloomAt(game, { x: 450, y: 300 });
    expect(isLit(game, { x: 450 + config.darkRadius - 10, y: 300 })).toBe(
      false,
    );
    expect(isLit(game, { x: 450 - config.darkRadius - 10, y: 300 })).toBe(true);
  });

  test("one blow breaks it, with a sigh", () => {
    const game = world();
    const self = gloomAt(game, { x: 450, y: 300 });
    hurt(game, self, 1, null);
    run(game, DT);
    expect(game.entities.has(self.id)).toBe(false);
    expect(sounded(game, "disperse.mp3")).toBe(true);
  });
});
