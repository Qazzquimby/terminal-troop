import { expect, test } from "vitest";
import { createSfx } from "../audio/index.js";
import type { Session } from "../sim/index.js";
import {
  FIXED_DT,
  createPlayer,
  createSession,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import { interpolatedView } from "./render.js";

const walkRight = { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 }, sprint: false };

function session(): Session {
  return createSession("me", "ME", "LERP1", "standard", createSfx());
}

const degrees = (value: number): number => (value * Math.PI) / 180;

const origin = { x: 0, y: 0 };

test("entities record their pre-step position", () => {
  const game = session();
  registerEntityType(game, 1, {
    radius: 5,
    collides: false,
    draw: () => undefined,
  });
  const entity = spawnEntity(game, 1, 100, 200);
  expect(entity).toMatchObject({ prevX: 100, prevY: 200 });

  entity.vx = 10 / FIXED_DT;
  updateSession(game, walkRight, FIXED_DT, performance.now());

  expect(entity).toMatchObject({ x: 110, prevX: 100 });
  expect(interpolatedView(game, 0.5, origin).entities.get(entity.id)?.x).toBe(
    105,
  );
});

test("the render view draws bodies between steps without touching the simulation", () => {
  const game = session();
  const remote = createPlayer("them", "THEM", game.world);
  game.players.set("them", remote);
  Object.assign(remote, { prevX: 100, x: 110, prevY: 50, y: 50 });
  Object.assign(game.local, { prevX: 300, x: 320 });

  const view = interpolatedView(game, 0.5, origin);

  expect(view.players.get("them")).toMatchObject({ x: 105, y: 50 });
  expect(view.local.x).toBe(310);
  expect(view.players.get("me")).toBe(view.local);
  expect(view.local.stamina).toBe(game.local.stamina);
  expect(remote.x).toBe(110);
  expect(game.local.x).toBe(320);

  const settled = interpolatedView(game, 1, origin);
  expect(settled.players.get("them")).toMatchObject({ x: 110, y: 50 });
  expect(settled.local.x).toBe(320);
});

test("the view's remote aim is interpolated by alpha along the shortest arc", () => {
  const game = session();
  const remote = createPlayer("them", "THEM", game.world);
  game.players.set("them", remote);
  Object.assign(remote, { prevAim: degrees(160), aim: degrees(-160) });

  const quarter = interpolatedView(game, 0.25, origin).players.get("them");
  const start = interpolatedView(game, 0, origin).players.get("them");

  expect(quarter?.aim).toBeCloseTo(degrees(170));
  expect(start?.aim).toBeCloseTo(degrees(160));
  expect(remote.aim).toBeCloseTo(degrees(-160));
});

test("the view's local aim points from the interpolated position to the mouse", () => {
  const game = session();
  Object.assign(game.local, { prevX: 300, x: 320, prevY: 200, y: 200, aim: 2 });

  const view = interpolatedView(game, 0.5, { x: 310, y: 250 });

  expect(view.local.aim).toBeCloseTo(Math.PI / 2);
  expect(view.players.get("me")?.aim).toBeCloseTo(Math.PI / 2);
  expect(game.local.aim).toBe(2);
});
