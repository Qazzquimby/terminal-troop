import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { createPlayer, createSession } from "../sim/index.js";
import type { Controls, Session } from "../sim/index.js";
import { createSpectator, eyeOf, stepSpectator } from "./spectate.js";

const DT = 1 / 60;
const CONFIG = { speed: 300 };

const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
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
