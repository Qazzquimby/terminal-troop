import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { idle } from "../integration/crew.js";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { emptyMap } from "../integration/tile-maps.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { createSession, updateSession } from "./session.js";
import { distanceToWall, hasLineOfSight, visibilityPolygon } from "./vision.js";

const DT = 1 / 60;

afterEach(() => {
  vi.restoreAllMocks();
});

test("a ray from a non-finite point returns at once", () => {
  const map = emptyMap();
  expect(hasLineOfSight(map, { x: NaN, y: 100 }, { x: 200, y: 100 })).toBe(
    false,
  );
  expect(
    distanceToWall(map, { x: Infinity, y: 100 }, { x: 1, y: 0 }, 500),
  ).toBe(0);
  expect(distanceToWall(map, { x: 100, y: 100 }, { x: NaN, y: 0 }, 500)).toBe(
    0,
  );
  expect(
    visibilityPolygon(map, { x: 100, y: Infinity }, 32).points,
  ).toHaveLength(0);
});

test("a body that goes non-finite is put back where it began the step, still, warned of once", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const game = createSession("me", "ME", "NAN", "dev", testSfx(), {
    ...testSimConfig,
  });
  registerEntityType(game, "broken", {
    radius: 10,
    maxHealth: 10,
    data: z.object({}),
    wakeful: () => true,
    update(entity, data) {
      entity.vx = NaN;
      entity.vy = Infinity;
      return data;
    },
    draw: () => undefined,
  });
  const broken = spawnEntity(game, "broken", 300, 300, {});
  for (let i = 0; i < 3; i++) updateSession(game, idle, DT);

  expect(broken.x).toBe(300);
  expect(broken.y).toBe(300);
  expect(broken.vx).toBe(0);
  expect(broken.vy).toBe(0);
  expect(warn).toHaveBeenCalledOnce();
  expect(String(warn.mock.calls[0]?.[0])).toContain("broken");
});

test("a player that goes non-finite is put back too", () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const game = createSession("me", "ME", "NAN", "dev", testSfx(), {
    ...testSimConfig,
  });
  const { x, y } = game.local;
  game.local.vx = NaN;
  updateSession(game, idle, DT);
  expect(game.local.x).toBe(x);
  expect(game.local.y).toBe(y);
  expect(game.local.vx).toBe(0);
});
