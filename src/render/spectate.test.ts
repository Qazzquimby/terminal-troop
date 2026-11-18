import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { createPlayer, createSession } from "../sim/index.js";
import type { Controls, Session } from "../sim/index.js";
import { createSpectator, eyeOf, eyeTurns, stepSpectator } from "./spectate.js";

const DT = 1 / 60;
const CONFIG = { speed: 300, zoom: { min: 0.5, max: 2.5, step: 1.2 } };

const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
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

/** The dev square with the local player and two others, `p` and `q`. */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "WATCH",
    "dev",
    testSfx(),
    testSimConfig,
    { at: { x: 100, y: 100 } },
  );
  for (const [id, x] of [
    ["q", 600],
    ["p", 300],
  ] as const)
    game.players.set(
      id,
      createPlayer(id, id.toUpperCase(), { x, y: 300 }, testSimConfig),
    );
  return game;
}

const watched = (
  spectator: ReturnType<typeof createSpectator>,
  game: Session,
) => {
  const eye = eyeOf(spectator, game);
  return eye.kind === "watch" ? eye.player.id : eye.kind;
};

test("a living player sees through its own eyes, and its body stays its own", () => {
  const game = world();
  const spectator = createSpectator();
  stepSpectator(spectator, game, { ...idle, move: { x: 1, y: 0 } }, DT, CONFIG);
  expect(eyeOf(spectator, game)).toEqual({ kind: "self" });
  expect(game.local.x).toBe(100);
});

test("a ghost watches the living in turn, the mouse buttons cycling, and listens from the one it watches", () => {
  const game = world();
  game.local.health = 0;
  const spectator = createSpectator();
  stepSpectator(spectator, game, idle, DT, CONFIG);
  expect(watched(spectator, game)).toBe("p");
  expect(game.local).toMatchObject({ x: 300, y: 300 });
  stepSpectator(spectator, game, { ...idle, use: true }, DT, CONFIG);
  expect(watched(spectator, game)).toBe("q");
  stepSpectator(spectator, game, { ...idle, use: true }, DT, CONFIG);
  expect(watched(spectator, game)).toBe("p");
  stepSpectator(spectator, game, { ...idle, secondary: true }, DT, CONFIG);
  expect(watched(spectator, game)).toBe("q");
});

test("a ghost goes on to another once the one it watches dies or leaves", () => {
  const game = world();
  game.local.health = 0;
  const spectator = createSpectator();
  stepSpectator(spectator, game, idle, DT, CONFIG);
  const p = game.players.get("p");
  if (p !== undefined) p.health = 0;
  stepSpectator(spectator, game, idle, DT, CONFIG);
  expect(watched(spectator, game)).toBe("q");
  game.players.delete("q");
  stepSpectator(spectator, game, idle, DT, CONFIG);
  // No one left living: it looks through the free camera, from where it last watched.
  expect(eyeOf(spectator, game)).toEqual({
    kind: "free",
    at: { x: 600, y: 300 },
  });
});

test("the view toggle switches a ghost to a free camera moved like a player, and back", () => {
  const game = world();
  game.local.health = 0;
  const spectator = createSpectator();
  stepSpectator(spectator, game, idle, DT, CONFIG);
  stepSpectator(spectator, game, { ...idle, toggleView: true }, DT, CONFIG);
  for (let step = 0; step < 60; step++)
    stepSpectator(
      spectator,
      game,
      { ...idle, move: { x: 0, y: -1 } },
      DT,
      CONFIG,
    );
  const eye = eyeOf(spectator, game);
  expect(eye.kind).toBe("free");
  expect(eye.kind === "free" && eye.at.y).toBeCloseTo(0, 5);
  expect(eye.kind === "free" && eye.at.x).toBe(300);
  stepSpectator(spectator, game, { ...idle, toggleView: true }, DT, CONFIG);
  expect(watched(spectator, game)).toBe("p");
});

test("a ghost's free camera stays upright and unfitted, while watching a player still turns (#502)", () => {
  const game = world();
  expect(eyeTurns(eyeOf(createSpectator(), game))).toBe(true);
  game.local.health = 0;
  const spectator = createSpectator();
  stepSpectator(spectator, game, idle, DT, CONFIG);
  expect(eyeTurns(eyeOf(spectator, game))).toBe(true);
  stepSpectator(
    spectator,
    game,
    { ...idle, toggleView: true, cycle: 1 },
    DT,
    CONFIG,
  );
  expect(eyeTurns(eyeOf(spectator, game))).toBe(false);
  // Its wheel zoom still works.
  expect(spectator.zoom).toBeGreaterThan(1);
});

test("the wheel zooms a ghost's view out and in, within its bounds", () => {
  const game = world();
  game.local.health = 0;
  const spectator = createSpectator();
  stepSpectator(spectator, game, { ...idle, cycle: 1 }, DT, CONFIG);
  expect(spectator.zoom).toBeCloseTo(1.2, 10);
  stepSpectator(spectator, game, { ...idle, cycle: -1 }, DT, CONFIG);
  expect(spectator.zoom).toBeCloseTo(1, 10);
  for (let notch = 0; notch < 20; notch++)
    stepSpectator(spectator, game, { ...idle, cycle: 1 }, DT, CONFIG);
  expect(spectator.zoom).toBe(2.5);
  for (let notch = 0; notch < 40; notch++)
    stepSpectator(spectator, game, { ...idle, cycle: -1 }, DT, CONFIG);
  expect(spectator.zoom).toBe(0.5);
});

test("the wheel leaves a living player's zoom alone, and coming back to life sets a ghost's back", () => {
  const game = world();
  const spectator = createSpectator();
  stepSpectator(spectator, game, { ...idle, cycle: 1 }, DT, CONFIG);
  expect(spectator.zoom).toBe(1);
  game.local.health = 0;
  stepSpectator(spectator, game, { ...idle, cycle: 1 }, DT, CONFIG);
  expect(spectator.zoom).toBeGreaterThan(1);
  game.local.health = 1;
  stepSpectator(spectator, game, idle, DT, CONFIG);
  expect(spectator.zoom).toBe(1);
});
