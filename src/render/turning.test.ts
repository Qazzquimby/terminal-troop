import { expect, test } from "vitest";
import { z } from "zod";
import { idle } from "../integration/crew.js";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import {
  createPlayer,
  createSession,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import type { Session } from "../sim/index.js";
import { pulledView, viewHeading } from "./turning.js";
import type { HeldView } from "./turning.js";

/** A session with the local player at (450, 300), and a lure kind pulling every gaze in 0.4s. */
function lured(): Session {
  const game = createSession(
    "me",
    "ME",
    "TURN",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerEntityType(game, "lure", {
    radius: 10,
    maxHealth: 100,
    data: z.object({}),
    pullsGaze: () => ({ seconds: 0.4 }),
    draw: () => undefined,
  });
  Object.assign(game.local, { x: 450, y: 300, prevX: 450, prevY: 300 });
  return game;
}

/**
 * Runs `count` frames of a step each from `view`, the mouse aiming straight ahead along its
 * heading and the view turned before and after it, as the rotating camera has them.
 */
function frames(game: Session, view: HeldView, count: number) {
  let turned = { ...view, facing: view.heading };
  for (let frame = 0; frame < count; frame++) {
    turned = pulledView(game, turned);
    const ahead = {
      x: game.local.x + Math.cos(turned.heading) * 1000,
      y: game.local.y + Math.sin(turned.heading) * 1000,
    };
    updateSession(game, { ...idle, aim: ahead }, 1 / 60);
    turned = pulledView(game, turned);
  }
  return turned;
}

test("a body pulling the gaze turns a turning view onto it, and leaves it there once gone", () => {
  const game = lured();
  const up = -Math.PI / 2;
  const lure = spawnEntity(game, "lure", 600, 300, {});
  const held = frames(game, { heading: up, held: null }, 60);
  // The view faces the lure, as the aim does; the mouse's own heading is kept beneath.
  expect(held.facing).toBeCloseTo(0);
  expect(game.local.aim).toBeCloseTo(0);
  expect(held.heading).toBe(up);
  game.entities.delete(lure.id);
  // Not for a step does the aim swing back to where the mouse had it.
  const free = frames(game, held, 1);
  expect(free.held).toBeNull();
  expect(free.heading).toBeCloseTo(0);
  expect(free.facing).toBeCloseTo(0);
  expect(game.local.aim).toBeCloseTo(0);
});

test("with nothing pulling, a turning view faces where the mouse turned it", () => {
  const game = lured();
  expect(frames(game, { heading: 1, held: null }, 5)).toEqual({
    heading: 1,
    held: null,
    facing: 1,
  });
});

const player = (aim: number) => ({
  ...createPlayer("p", "P", { x: 0, y: 0 }, testSimConfig),
  aim,
});
const riding = (heading: number) => ({
  ...player(0),
  ride: { vehicle: "car", driving: true, heading, speed: 0, turn: 0 },
});

test("on foot, the mouse turns the view from where it faced", () => {
  expect(viewHeading(1, { kind: "self" }, player(0), 0.25)).toBe(1.25);
});

test("in a vehicle the view points along its heading, whatever the mouse does", () => {
  expect(viewHeading(1, { kind: "self" }, riding(2), 0.25)).toBe(2);
});

test("a ghost watching a player looks the way that player looks, or its vehicle points", () => {
  const local = player(0);
  expect(
    viewHeading(1, { kind: "watch", player: player(-2) }, local, 0.5),
  ).toBe(-2);
  expect(viewHeading(1, { kind: "watch", player: riding(3) }, local, 0.5)).toBe(
    3,
  );
});

test("a ghost's free camera turns with the mouse", () => {
  const free = { kind: "free", at: { x: 0, y: 0 } } as const;
  expect(viewHeading(1, free, player(0), -0.5)).toBe(0.5);
});
