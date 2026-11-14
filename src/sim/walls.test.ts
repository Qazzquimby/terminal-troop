import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { applyWorldEntries, createSession, takeWorldEntries } from "./index.js";
import { isSolid } from "./map.js";
import { destroyWalls, followWalls, wallCellsIn } from "./walls.js";

/** The dev square: 18x12 cells of 50px, with 2x2 pillars at cells (4, 1) and (12, 9). */
function session(id = "me") {
  return createSession(
    id,
    id.toUpperCase(),
    "WALLS",
    "dev",
    testSfx(),
    testSimConfig,
  );
}

/** The first pillar's cells, row-major: x 200..300, y 50..150. */
const PILLAR = [22, 23, 40, 41];

test("a circle takes the wall cells it overlaps, and no open ones", () => {
  const { map } = session().world;
  expect(wallCellsIn(map, { center: { x: 250, y: 100 }, radius: 10 })).toEqual(
    PILLAR,
  );
  expect(wallCellsIn(map, { center: { x: 225, y: 75 }, radius: 20 })).toEqual([
    22,
  ]);
  // Just short of the pillar's left face.
  expect(wallCellsIn(map, { center: { x: 180, y: 75 }, radius: 20 })).toEqual(
    [],
  );
});

test("a square reaches the corners a circle of its radius misses", () => {
  const { map } = session().world;
  const center = { x: 185, y: 35 };
  expect(wallCellsIn(map, { center, radius: 20 })).toEqual([]);
  expect(wallCellsIn(map, { center, radius: 20, shape: "square" })).toEqual([
    22,
  ]);
});

test("the host knocks walls down at once, and every client follows its world state", () => {
  const host = session("host");
  const guest = session("guest");
  guest.hosting = false;
  const area = { center: { x: 250, y: 100 }, radius: 10 };

  expect(destroyWalls(guest, area)).toBe(0);
  expect(isSolid(guest.world.map, 4, 1)).toBe(true);

  expect(destroyWalls(host, area)).toBe(4);
  expect(isSolid(host.world.map, 4, 1)).toBe(false);
  expect(isSolid(host.world.map, 5, 2)).toBe(false);
  expect(destroyWalls(host, area)).toBe(0);

  const entries = takeWorldEntries(host, false);
  expect(entries?.["core/walls.destroyed"]).toEqual([1, PILLAR]);
  applyWorldEntries(guest, { host: "host", term: 1 }, entries ?? {});
  followWalls(guest);
  for (const index of PILLAR) expect(guest.world.map.solid[index]).toBe(0);
  // The other pillar stands.
  expect(isSolid(guest.world.map, 12, 9)).toBe(true);
});
