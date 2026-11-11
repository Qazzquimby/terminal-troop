import { expect, test, vi } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import type { Session } from "../sim/index.js";
import {
  createPlayer,
  createSession,
  heldItemId,
  heldItemOf,
  registerItem,
  registerEntityType,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import { drawHealthBar, drawLitWalls, interpolatedView } from "./render.js";

test("lit walls draw a shallow band into the wall instead of a whole tile", () => {
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
  };
  const walls = new Map([
    [
      0,
      [
        {
          from: { x: 100, y: 100 },
          to: { x: 100, y: 150 },
          normal: { x: -1, y: 0 },
        },
      ],
    ],
  ]);

  drawLitWalls(ctx, walls);

  expect(ctx.fillStyle).toBe("#4b525a");
  expect(ctx.strokeStyle).toBe("#5f6871");
  expect(ctx.fill).toHaveBeenCalledOnce();
  expect(ctx.stroke).toHaveBeenCalledOnce();
  expect(ctx.moveTo.mock.calls).toEqual([
    [100, 100],
    [100, 100],
  ]);
  expect(ctx.lineTo.mock.calls).toEqual([
    [100, 150],
    [104, 150],
    [104, 100],
    [100, 150],
  ]);
  expect(ctx.closePath).toHaveBeenCalledOnce();
});

const FIXED_DT = 1 / 60;

const walkRight = {
  move: { x: 1, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
};

function session(): Session {
  return createSession(
    "me",
    "ME",
    "LERP1",
    "standard",
    testSfx(),
    testSimConfig,
  );
}

test.each([
  ["a hurt body", 30, 40, true],
  ["an unhurt body", 40, 40, false],
  ["an unbreakable body, however hit", Infinity, Infinity, false],
])("%s shows a health bar: %s", (_label, health, maxHealth, shown) => {
  const ctx = { fillStyle: "", fillRect: vi.fn() };
  const body = { x: 100, y: 100, vx: 0, vy: 0, radius: 10, health, maxHealth };
  drawHealthBar(ctx, body, 80);
  expect(ctx.fillRect.mock.calls.length > 0).toBe(shown);
});

const degrees = (value: number): number => (value * Math.PI) / 180;

const origin = { x: 0, y: 0 };

test("entities record their pre-step position", () => {
  const game = session();
  registerEntityType(game, "thing", {
    radius: 5,
    maxHealth: 10,
    collides: false,
    data: z.object({}),
    draw: () => undefined,
  });
  const entity = spawnEntity(game, "thing", 100, 200, {});
  expect(entity).toMatchObject({ prevX: 100, prevY: 200 });

  entity.vx = 10 / FIXED_DT;
  updateSession(game, walkRight, FIXED_DT);

  expect(entity).toMatchObject({ x: 110, prevX: 100 });
  expect(interpolatedView(game, 0.5, origin).entities.get(entity.id)?.x).toBe(
    105,
  );
});

test("the render view draws bodies between steps without touching the simulation", () => {
  const game = session();
  const remote = createPlayer("them", "THEM", game.world, game.config);
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
  const remote = createPlayer("them", "THEM", game.world, game.config);
  game.players.set("them", remote);
  Object.assign(remote, { prevAim: degrees(160), aim: degrees(-160) });

  const quarter = interpolatedView(game, 0.25, origin).players.get("them");
  const start = interpolatedView(game, 0, origin).players.get("them");

  expect(quarter?.aim).toBeCloseTo(degrees(170));
  expect(start?.aim).toBeCloseTo(degrees(160));
  expect(remote.aim).toBeCloseTo(degrees(-160));
});

test("the view's players hold what the simulation's do", () => {
  const game = session();
  const torch = { id: "torch", name: "Torch", maxStack: 1, emoji: "🔦" };
  registerItem(game, torch, {
    cooldown: 1,
    apply: () => undefined,
    show: (_game, at) => ({ center: at, hit: false }),
    draw: () => undefined,
  });
  game.local.inventory[0] = { item: torch, quantity: 1 };
  const remote = createPlayer("them", "THEM", game.world, game.config);
  game.players.set("them", remote);
  heldItemId.set(remote, "torch");
  remote.use = { item: "torch", center: origin, hit: false, startedAt: 0 };

  const view = interpolatedView(game, 0.5, origin);
  const them = view.players.get("them");

  expect(heldItemOf(view, view.local)).toBe(torch);
  expect(them === undefined ? undefined : heldItemOf(view, them)).toBe(torch);
  expect(them?.use).toBe(remote.use);
});

test("the view's local aim points from the interpolated position to the mouse", () => {
  const game = session();
  Object.assign(game.local, { prevX: 300, x: 320, prevY: 200, y: 200, aim: 2 });

  const view = interpolatedView(game, 0.5, { x: 310, y: 250 });

  expect(view.local.aim).toBeCloseTo(Math.PI / 2);
  expect(view.players.get("me")?.aim).toBeCloseTo(Math.PI / 2);
  expect(game.local.aim).toBe(2);
});
