import { z } from "zod";
import { describe, expect, test, vi } from "vitest";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import {
  ambientLightAt,
  createSession,
  darkFront,
  deepFront,
  eyesOf,
  frontAt,
  hearFronts,
  inView,
  isDeepdark,
  isLit,
  perceives,
  registerContent,
  registerEntityType,
  spawnEntity,
  spawnWorldItem,
} from "../sim/index.js";
import type { Point, Session, SimConfig } from "../sim/index.js";
import { testItemsConfig, testSfx, testSimConfig } from "./sim-config.js";

const CELL = testSimConfig.world.cell;

/**
 * Fronts that set out at the start and cross the 900px dev square in 200s, so at 100s the
 * deepdark lies left of x 450.
 */
const sweeping: SimConfig = {
  ...testSimConfig,
  deepdark: {
    ...testSimConfig.deepdark,
    fronts: { dark: 0, deep: 0, end: 200 },
  },
};

/** The dark dev square, its pillars off the row at y 300, with a lamp and a watcher kind. */
function square(config: SimConfig = sweeping): Session {
  const game = createSession("me", "ME", "DEEP", "dev", testSfx(), config);
  registerEntityType(game, "lamp", {
    radius: 5,
    maxHealth: 1,
    collides: false,
    data: z.object({}),
    light: () => ({ range: 600 }),
    draw: () => undefined,
  });
  registerEntityType(game, "shade", {
    radius: 5,
    maxHealth: 1,
    collides: false,
    data: z.object({}),
    darkness: () => 100,
    draw: () => undefined,
  });
  registerEntityType(game, "watcher", {
    radius: 5,
    maxHealth: 1,
    collides: false,
    data: z.object({}),
    eyes: () => ({ cone: null, around: 300 }),
    draw: () => undefined,
  });
  return game;
}

const at = (x: number): Point => ({ x, y: 300 });

describe("fronts", () => {
  test("a front sets out from the left edge at its time and reaches the right at the end", () => {
    expect(frontAt(900, 180, 1200, 100)).toBe(-Infinity);
    expect(frontAt(900, 180, 1200, 180)).toBe(0);
    expect(frontAt(900, 180, 1200, 690)).toBe(450);
    expect(frontAt(900, 180, 1200, 1500)).toBe(900);
  });

  test("darkness and deepdark sweep the world by its world clock, darkness first", () => {
    const game = square({
      ...testSimConfig,
      deepdark: {
        ...testSimConfig.deepdark,
        fronts: { dark: 100, deep: 200, end: 300 },
      },
    });
    expect(darkFront(game)).toBe(-Infinity);
    game.worldTime = 200;
    expect(darkFront(game)).toBe(450);
    expect(deepFront(game)).toBe(0);
    game.worldTime = 250;
    expect(deepFront(game)).toBe(450);
    expect(isDeepdark(game, at(400))).toBe(true);
    expect(isDeepdark(game, at(500))).toBe(false);
  });

  test("no sunlight falls behind the darkness front; no place's own light at all behind the deepdark one", () => {
    const game = createSession(
      "me",
      "ME",
      "FRONTS",
      "standard",
      testSfx(),
      testSimConfig,
    );
    const { world } = game;
    const cells: Point[] = [];
    for (let row = 0; row < world.map.rows; row++)
      for (let col = 0; col < world.map.cols; col++)
        cells.push({ x: (col + 0.5) * CELL, y: (row + 0.5) * CELL });
    const sun = cells.find((cell) => ambientLightAt(world, cell) === "sun");
    const fixture = cells.find(
      (cell) => ambientLightAt(world, cell) === "fixture",
    );
    if (sun === undefined || fixture === undefined)
      throw new Error("no lit cells");
    const passed = (cell: Point) => cell.x + CELL;
    expect(
      ambientLightAt(world, sun, 1, { dark: passed(sun), deep: -Infinity }),
    ).toBeNull();
    expect(
      ambientLightAt(world, fixture, 1, {
        dark: passed(fixture),
        deep: -Infinity,
      }),
    ).toBe("fixture");
    expect(
      ambientLightAt(world, fixture, 1, {
        dark: passed(fixture),
        deep: passed(fixture),
      }),
    ).toBeNull();
  });

  test("each front is heard as it sets out, but not by a clock that jumps past it", () => {
    const game = square({
      ...testSimConfig,
      deepdark: {
        ...testSimConfig.deepdark,
        fronts: { dark: 100, deep: 200, end: 300 },
      },
    });
    const play = vi.spyOn(game.sfx, "play");
    const heard = (file: string) =>
      play.mock.calls.some(([url]) => url.endsWith(`/${file}`));
    game.worldTime = 99.9;
    hearFronts(game);
    game.worldTime = 100.1;
    hearFronts(game);
    expect(heard("darkness.mp3")).toBe(true);
    expect(heard("deepdark.mp3")).toBe(false);
    game.worldTime = 250;
    hearFronts(game);
    expect(heard("deepdark.mp3")).toBe(false);
  });
});

describe("deepdark", () => {
  test("light reaches only part of its range into it", () => {
    const game = square();
    game.worldTime = 100;
    spawnEntity(game, "lamp", 700, 300, {});
    // 200 out, out of the deepdark: lit.
    expect(isLit(game, at(500))).toBe(true);
    // 270 out, within half the lamp's 600 into the deepdark: lit.
    expect(isLit(game, at(430))).toBe(true);
    // 400 out, past half its range into the deepdark: dark, though in range.
    expect(isLit(game, at(300))).toBe(false);
  });

  test("darkness something gives off, such as a gloom's, is deepdark", () => {
    const game = square(testSimConfig);
    spawnEntity(game, "shade", 600, 300, {});
    expect(isDeepdark(game, at(650))).toBe(true);
    expect(isDeepdark(game, at(450))).toBe(false);
  });

  test("every body's eyes see only part as far into it", () => {
    const game = square();
    game.worldTime = 100;
    const watcher = spawnEntity(game, "watcher", 300, 300, {});
    const sight = eyesOf(game, watcher);
    // 250 off, out of the deepdark: seen.
    expect(inView(game, sight, at(550))).toBe(true);
    // 200 off in the deepdark, past half its 300: unseen.
    expect(inView(game, sight, at(100))).toBe(false);
    // 100 off in the deepdark: seen.
    expect(inView(game, sight, at(200))).toBe(true);
  });
});

describe("dark scrap", () => {
  /** The dark square with items, the fronts set out as `config` has them. */
  function withItems(config: SimConfig): Session {
    const game = square(config);
    const items: ItemsConfig = testItemsConfig;
    registerContent(game, itemContent(items));
    return game;
  }

  test("is worth 3, and laid half as often as plain scrap", () => {
    const { darkScrap, scrap } = testItemsConfig;
    expect(darkScrap.value).toBe(3);
    expect(scrap.value).not.toBe(darkScrap.value);
  });

  test("lying out of deepdark, nobody perceives it; in it, everybody does", () => {
    const game = withItems(sweeping);
    game.worldTime = 100;
    const out = spawnWorldItem(game, at(600), "darkScrap");
    const inside = spawnWorldItem(game, at(300), "darkScrap");
    const plain = spawnWorldItem(game, at(600), "scrap");
    expect(perceives(game, "me", out.id)).toBe(false);
    expect(perceives(game, null, out.id)).toBe(false);
    expect(perceives(game, "me", inside.id)).toBe(true);
    expect(perceives(game, "me", plain.id)).toBe(true);
    // A shroud of darkness reaching it brings it into deepdark too.
    spawnEntity(game, "shade", 650, 300, {});
    expect(perceives(game, "me", out.id)).toBe(true);
  });
});
