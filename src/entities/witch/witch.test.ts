import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  mulberry32,
  registerContent,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Session, WorldEntity } from "../../sim/index.js";
import { freshWitch, witch as witchContent, WitchState } from "./index.js";
import type { WitchConfig } from "./index.js";

const DT = 1 / 60;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  holdingUse: false,
  secondary: false,
  interact: false,
  drop: false,
};
const { witch: config } = testEntitiesConfig;

// Her wander legs and hideouts draw from Math.random; seeded so each run is the same.
beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(5));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The sounds each session's host has sent, by the last part of their urls. */
const sent = new WeakMap<Session, string[]>();

/** The dev square, all of it dark, with the witch; the player stands at (x, y). */
function world(x: number, y: number, witch: WitchConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "WITCH",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [witchContent.create({ witch })]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  sent.set(game, []);
  return game;
}

const played = (game: Session): string[] => sent.get(game) ?? [];

const Sent = z.object({ effects: z.array(z.object({ sound: z.string() })) });

/** Steps `seconds`, one step a frame, noting each sound the host sends. */
function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, idle, DT);
    for (const { payload } of game.outbox.splice(0)) {
      const parsed = Sent.safeParse(payload);
      if (!parsed.success) continue;
      for (const { sound } of parsed.data.effects)
        played(game).push(sound.split("/").at(-1) ?? sound);
    }
  }
}

function witchAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(game, "witch", x, y, freshWitch(game.worldTime, config));
}

const stateOf = (witch: WorldEntity) => WitchState.parse(witch.data);

test("a dormant witch with no one near sits still and barks now and then", () => {
  const game = world(100, 300);
  const witch = witchAt(game, 700, 300);
  run(game, config.barkGap.dormant.max + 0.1);
  expect(stateOf(witch).mode).toBe("dormant");
  expect(witch.x).toBe(700);
  expect(played(game)).toContain("bark.mp3");
});

test("a player close by makes her growl, and if still there a second later she wakes and runs them down", () => {
  const game = world(450, 300);
  const witch = witchAt(game, 650, 300);
  run(game, 0.1);
  expect(stateOf(witch).mode).toBe("warning");
  expect(played(game)).toContain("growl.mp3");
  run(game, config.warnSeconds);
  expect(stateOf(witch).mode).toBe("enraged");
  expect(played(game)).toContain("enrage.mp3");
  run(game, 1);
  expect(game.local.health).toBeLessThan(game.local.maxHealth);
  expect(played(game)).toContain("attack.mp3");
});

test("a player who backs off before her growl ends leaves her dormant", () => {
  const game = world(450, 300);
  const witch = witchAt(game, 650, 300);
  run(game, 0.1);
  expect(stateOf(witch).mode).toBe("warning");
  Object.assign(game.local, { x: 100, y: 300, prevX: 100, prevY: 300 });
  run(game, config.warnSeconds);
  expect(stateOf(witch).mode).toBe("dormant");
  expect(witch.x).toBe(650);
});

test("light on her wakes her enraged, however far the players", () => {
  const game = world(100, 300);
  registerEntityType(game, "lamp", {
    radius: 5,
    maxHealth: 1,
    collides: false,
    data: z.object({}),
    light: () => ({ range: 100 }),
    draw: () => undefined,
  });
  const witch = witchAt(game, 700, 300);
  run(game, 0.5);
  expect(stateOf(witch).mode).toBe("dormant");
  spawnEntity(game, "lamp", 760, 300, {});
  run(game, 0.1);
  expect(stateOf(witch).mode).toBe("enraged");
});

test("hurt while dormant, she wakes and heads for whoever she can see", () => {
  const game = world(100, 300);
  const witch = witchAt(game, 700, 300);
  run(game, 0.1);
  witch.health -= 15;
  run(game, 0.2);
  expect(stateOf(witch).mode).toBe("enraged");
  expect(stateOf(witch).target).toMatchObject({ x: 100, y: 300 });
  expect(witch.vx).toBeLessThan(0);
});

test("once her rage runs out she runs for a dark spot away from the players and sleeps there", () => {
  const game = world(100, 300);
  const witch = witchAt(game, 700, 300);
  const state = stateOf(witch);
  witch.data = {
    ...state,
    mode: "enraged",
    until: game.worldTime + 0.5,
  };
  run(game, 0.6);
  expect(stateOf(witch).mode).toBe("retreat");
  const speed =
    testSimConfig.player.speed * testSimConfig.player.sprintMultiplier;
  expect(Math.hypot(witch.vx, witch.vy)).toBeCloseTo(speed);
  run(game, 4);
  expect(stateOf(witch).mode).toBe("dormant");
  expect(
    Math.hypot(witch.x - game.local.x, witch.y - game.local.y),
  ).toBeGreaterThan(config.retreat.clearance - witch.radius);
});

test("once she kills, she retreats at once", () => {
  const game = world(450, 300, { ...config, attackDamage: 1000 });
  const witch = witchAt(game, 650, 300);
  run(game, config.warnSeconds + 1.5);
  expect(game.local.health).toBe(0);
  expect(["retreat", "dormant"]).toContain(stateOf(witch).mode);
});
