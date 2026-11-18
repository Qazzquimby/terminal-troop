import { z } from "zod";
import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { isLit, isLitTo } from "./light.js";
import type { TileMap } from "./map.js";
import { createSession } from "./session.js";
import type { SimConfig } from "./session.js";
import { exitAlong, inShadow, shadowCasters } from "./shadow.js";
import { visibilityPolygon, wallKey } from "./vision.js";

const open: TileMap = {
  cell: 50,
  cols: 20,
  rows: 20,
  solid: new Uint8Array(400),
};

const east = { x: 1, y: 0 };

test("a ray leaves a disc by its far side, and finds none to a disc it misses, starts in or has passed", () => {
  const disc = { x: 100, y: 0, radius: 10 };
  expect(exitAlong(disc, { x: 0, y: 0 }, east)).toBeCloseTo(110);
  expect(exitAlong(disc, { x: 0, y: 20 }, east)).toBeNull();
  expect(exitAlong(disc, { x: 100, y: 5 }, east)).toBeNull();
  expect(exitAlong(disc, { x: 200, y: 0 }, east)).toBeNull();
});

test("a ray leaves a box by its far side, turned as the box is", () => {
  const box = { length: 40, width: 20, heading: 0 };
  const along = { x: 100, y: 0, radius: 20, box };
  expect(exitAlong(along, { x: 0, y: 0 }, east)).toBeCloseTo(120);
  const across = { ...along, box: { ...box, heading: Math.PI / 2 } };
  expect(exitAlong(across, { x: 0, y: 0 }, east)).toBeCloseTo(110);
  expect(exitAlong(across, { x: 0, y: 25 }, east)).toBeNull();
  expect(exitAlong(along, { x: 100, y: 0 }, east)).toBeNull();
});

test("a body shadows what lies behind it from a light, but not itself, nor from a light within it", () => {
  const body = { id: "b", x: 100, y: 0, radius: 10 };
  const light = { x: 0, y: 0 };
  expect(inShadow([body], light, { x: 200, y: 0 })).toBe(true);
  expect(inShadow([body], light, { x: 105, y: 0 })).toBe(false);
  expect(inShadow([body], light, { x: 50, y: 0 })).toBe(false);
  expect(inShadow([body], light, { x: 200, y: 50 })).toBe(false);
  expect(inShadow([body], light, { x: 200, y: 0 }, "b")).toBe(false);
  expect(inShadow([body], { x: 100, y: 0 }, { x: 200, y: 0 })).toBe(false);
});

test("a traced light stops at the far side of a body in it, its shadow's edges sharp", () => {
  const light = { x: 500, y: 500, range: 400 };
  const body = { id: "b", x: 600, y: 500, radius: 20 };
  const traced = visibilityPolygon(open, light, 360, Infinity, [body]);
  const reach = (angle: number) =>
    Math.min(
      ...traced.points
        .filter(
          (point) =>
            Math.abs(Math.atan2(point.y - 500, point.x - 500) - angle) < 1e-9,
        )
        .map((point) => Math.hypot(point.x - 500, point.y - 500)),
    );
  expect(reach(0)).toBeCloseTo(120);
  expect(reach(Math.PI / 2)).toBeCloseTo(400);
  // Just past the body's edge, the light goes on to its full reach.
  const edge = Math.asin(20 / 100);
  expect(reach(edge + 1e-7)).toBeCloseTo(400);
  expect(reach(edge - 1e-7)).toBeLessThan(110);

  // The body it shines from within shadows nothing.
  const own = visibilityPolygon(open, light, 360, Infinity, [
    { id: "own", x: 500, y: 500, radius: 20 },
  ]);
  expect(
    own.points.every((point) => Math.hypot(point.x - 500, point.y - 500) > 399),
  ).toBe(true);
});

/** A session with a lamp at (450, 300), the local player standing at it, and a post 100 east. */
function litScene(config: SimConfig = testSimConfig) {
  const game = createSession("me", "ME", "SHADE", "dev", testSfx(), config);
  Object.assign(game.local, { x: 450, y: 300, aim: 0 });
  registerEntityType(game, "lamp", {
    radius: 5,
    maxHealth: 1,
    collides: false,
    castsShadow: false,
    data: z.object({}),
    light: () => ({ range: 600 }),
    draw: () => undefined,
  });
  registerEntityType(game, "post", {
    radius: 20,
    maxHealth: 1,
    data: z.object({}),
    draw: () => undefined,
  });
  registerEntityType(game, "mat", {
    radius: 20,
    maxHealth: 1,
    castsShadow: false,
    data: z.object({}),
    draw: () => undefined,
  });
  spawnEntity(game, "lamp", 450, 300, {});
  return game;
}

test("what lies in a body's shadow from a light given off is dark to the rules that ask of light", () => {
  const game = litScene();
  const behind = { x: 650, y: 300 };
  expect(isLit(game, behind)).toBe(true);
  const post = spawnEntity(game, "post", 550, 300, {});
  expect(isLit(game, behind)).toBe(false);
  // The post itself stands in the light, and beside its shadow it is light still.
  expect(isLit(game, { x: 550, y: 300 })).toBe(true);
  expect(isLit(game, { x: 650, y: 400 })).toBe(true);
  // The post takes no heed of its own shadow, which goes where it goes.
  expect(isLitTo(game, post.id, behind)).toBe(true);
  // The player standing at the lamp shines it out past itself, and casts no shadow in it.
  expect(isLit(game, { x: 350, y: 300 })).toBe(true);
});

test("a kind that casts no shadow leaves the light whole", () => {
  const game = litScene();
  spawnEntity(game, "mat", 550, 300, {});
  expect(isLit(game, { x: 650, y: 300 })).toBe(true);
  expect(shadowCasters(game).map(({ id }) => id)).toEqual(["me"]);
});

test("shadows kept only to look at leave the rules that ask of light as they were", () => {
  const game = litScene({
    ...testSimConfig,
    light: { ...testSimConfig.light, shadows: { cast: true, gameplay: false } },
  });
  spawnEntity(game, "post", 550, 300, {});
  expect(shadowCasters(game)).toHaveLength(2);
  expect(isLit(game, { x: 650, y: 300 })).toBe(true);
});

test("with shadows off, no body casts one", () => {
  const game = litScene({
    ...testSimConfig,
    light: { ...testSimConfig.light, shadows: { cast: false, gameplay: true } },
  });
  spawnEntity(game, "post", 550, 300, {});
  expect(shadowCasters(game)).toEqual([]);
  expect(isLit(game, { x: 650, y: 300 })).toBe(true);
});

test("a wall face in a body's shadow is not lit", () => {
  // A wall along column 12, the light in column 5, a body between them on its row.
  const solid = new Uint8Array(400);
  for (let row = 0; row < 20; row++) solid[row * 20 + 12] = 1;
  const map: TileMap = { ...open, solid };
  const light = { x: 275, y: 525, range: 600 };
  const facing = wallKey(map, 12, 10);
  expect(visibilityPolygon(map, light, 360).walls.has(facing)).toBe(true);
  const body = { id: "b", x: 450, y: 525, radius: 40 };
  const shadowed = visibilityPolygon(map, light, 360, Infinity, [body]);
  expect(shadowed.walls.has(facing)).toBe(false);
  expect(shadowed.walls.has(wallKey(map, 12, 4))).toBe(true);
});
