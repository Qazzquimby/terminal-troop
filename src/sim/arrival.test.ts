import { describe, expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { isAreaFree, mulberry32 } from "./map.js";
import type { Point, WorldKind } from "./map.js";
import type { Start } from "./session.js";
import { createSession } from "./session.js";

const RADIUS = testSimConfig.player.radius;
const SPREAD = testSimConfig.arrival.spread;

function session(
  code: string,
  start: Start = {},
  kind: WorldKind = "standard",
) {
  return createSession("me", "ME", code, kind, testSfx(), testSimConfig, start);
}

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe("rally point", () => {
  test("is the same on every client in a room, wherever its player starts", () => {
    const first = session("RALLY", { rng: mulberry32(1) });
    const second = session("RALLY", { rng: mulberry32(2) });
    expect(first.local).not.toMatchObject({ x: second.local.x });
    expect(second.rally).toEqual(first.rally);
  });

  test("differs between rooms, and has room for a player", () => {
    const rally = session("RALLY").rally;
    expect(session("OTHER").rally).not.toEqual(rally);
    const { map } = session("RALLY").world;
    expect(isAreaFree(map, rally.x, rally.y, RADIUS)).toBe(true);
  });
});

describe("a player new to the world", () => {
  test("starts near the rally point, on free floor, off it, and apart from the others", () => {
    for (const kind of ["standard", "dev"] as const) {
      const spots = [1, 2, 3, 4, 5, 6].map(
        (seed) => session("ARRIVE", { rng: mulberry32(seed) }, kind).local,
      );
      const { world, rally } = session("ARRIVE", {}, kind);
      for (const spot of spots) {
        expect(distance(spot, rally)).toBeLessThanOrEqual(SPREAD);
        expect(distance(spot, rally)).toBeGreaterThanOrEqual(RADIUS * 2);
        expect(isAreaFree(world.map, spot.x, spot.y, RADIUS)).toBe(true);
      }
      const gaps = spots.flatMap((a, i) =>
        spots.slice(i + 1).map((b) => distance(a, b)),
      );
      expect(Math.min(...gaps)).toBeGreaterThan(0);
      expect(Math.max(...gaps)).toBeGreaterThan(RADIUS * 2);
    }
  });
});

describe("a player back in the world", () => {
  test("starts where it stood", () => {
    const { rally } = session("BACK");
    const at = { x: rally.x + 1, y: rally.y };
    expect(session("BACK", { at }).local).toMatchObject({
      ...at,
      prevX: at.x,
      tx: at.x,
    });
  });

  test("arrives by the rally point instead when it cannot stand where it was", () => {
    // The dev square's pillar fills x 200-300, y 50-150.
    const invalid = [
      { x: 250, y: 100 },
      { x: -40, y: 100 },
      { x: 5000, y: 5000 },
      { x: Number.NaN, y: 100 },
    ];
    for (const at of invalid) {
      const game = session("BACK", { at }, "dev");
      expect(distance(game.local, game.rally)).toBeLessThanOrEqual(SPREAD);
    }
  });
});
