import { z } from "zod";
import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { buildWorld } from "./generation.js";
import {
  ambientLightAt,
  ambientPolygons,
  darkSources,
  isLit,
  isLitTo,
  lightRooms,
  powerRooms,
} from "./light.js";
import { isShrouded, shroud } from "./status.js";
import type { UnlitRoom } from "./light.js";
import { AREA, mulberry32 } from "./map.js";
import type { Room, World } from "./map.js";
import { createSession } from "./session.js";
import { wallKey } from "./vision.js";

const CELL = 50;
const { wall, road, yard, room, door } = AREA;

/**
 * Five columns, three rows: yard over road on the left, then a wall with a door in it, then a lit
 * room over a dark one, which has a fixture but no power.
 */
function smallWorld(): World {
  const cols = 5;
  // prettier-ignore
  const area = Uint8Array.from([
    yard, yard, wall, room, room,
    road, road, door, room, room,
    road, road, wall, room, room,
  ]);
  // prettier-ignore
  const ids = Int16Array.from([
    -1, -1, -1, 0, 0,
    -1, -1, -1, 0, 0,
    -1, -1, -1, 1, 1,
  ]);
  const box = {
    col: 3,
    cols: 2,
    rows: 1,
    cells: 2,
    hallway: false,
    building: 0,
  };
  const rooms: Room[] = [
    { ...box, id: 0, row: 0, rows: 2, fixture: true, powered: true },
    { ...box, id: 1, row: 2, fixture: true, powered: false },
  ];
  return {
    W: cols * CELL,
    H: 3 * CELL,
    map: {
      cell: CELL,
      cols,
      rows: 3,
      solid: area.map((code) => (code === wall ? 1 : 0)),
    },
    layout: {
      area,
      room: ids,
      rooms,
      roadDistance: new Uint16Array(area.length),
      farthest: 0,
      start: { x: 0, y: 0, w: 0, h: 0 },
      exit: { x: 0, y: 0, w: 0, h: 0 },
      danger: { road: 0, right: 0, exit: 0, reach: 0 },
      roadCentre: new Float32Array(0),
      exitShade: 0,
    },
  };
}

const centre = (col: number, row: number) => ({
  x: (col + 0.5) * CELL,
  y: (row + 0.5) * CELL,
});

test("sunlight lights the road and yards, a powered fixture its room, and nothing else", () => {
  const world = smallWorld();
  expect(ambientLightAt(world, centre(0, 0))).toBe("sun");
  expect(ambientLightAt(world, centre(1, 2))).toBe("sun");
  expect(ambientLightAt(world, centre(2, 1))).toBeNull();
  expect(ambientLightAt(world, centre(4, 1))).toBe("fixture");
  expect(ambientLightAt(world, centre(4, 2))).toBeNull();
  expect(ambientLightAt(world, { x: -10, y: 10 })).toBeNull();
});

test("ambient light is drawn as a box for each run of a row, with the walls round it lit", () => {
  const world = smallWorld();
  const everywhere = { x: 0, y: 0, width: world.W, height: world.H };

  const sun = ambientPolygons(world, everywhere, "sun");
  expect(sun.map(({ points }) => points)).toEqual(
    [0, 1, 2].map((row) => [
      { x: 0, y: row * CELL },
      { x: 2 * CELL, y: row * CELL },
      { x: 2 * CELL, y: (row + 1) * CELL },
      { x: 0, y: (row + 1) * CELL },
    ]),
  );
  expect(sun[0]?.walls.get(wallKey(world.map, 2, 0))).toEqual([
    {
      from: { x: 2 * CELL, y: 0 },
      to: { x: 2 * CELL, y: CELL },
      normal: { x: -1, y: 0 },
    },
  ]);
  expect(sun[1]?.walls.has(wallKey(world.map, 2, 1))).toBe(false);

  const fixture = ambientPolygons(world, everywhere, "fixture");
  expect(fixture).toHaveLength(2);
  expect(fixture.every(({ points }) => points[0]?.x === 3 * CELL)).toBe(true);
});

test("a light given off lights where it reaches, short of walls; a player's own sight does not", () => {
  const game = createSession("me", "ME", "LIT", "dev", testSfx(), {
    ...testSimConfig,
  });
  Object.assign(game.local, { x: 450, y: 300, aim: 0 });
  expect(isLit(game, { x: 500, y: 300 })).toBe(false);

  registerEntityType(game, "lamp", {
    radius: 5,
    maxHealth: 1,
    collides: false,
    data: z.object({}),
    light: () => ({
      range: 300,
      from: { x: 0, y: -50 },
      shape: { kind: "cone", direction: 0, angle: Math.PI / 2 },
    }),
    draw: () => undefined,
  });
  // The dev square's pillar fills cells 12-13 of rows 9-10.
  spawnEntity(game, "lamp", 450, 550, {});
  expect(isLit(game, { x: 550, y: 500 })).toBe(true);
  expect(isLit(game, { x: 350, y: 500 })).toBe(false);
  expect(isLit(game, { x: 720, y: 500 })).toBe(false);
});

test("rooms get fixtures and power by chance, power drawn apart from fixtures", () => {
  const rooms: UnlitRoom[] = Array.from({ length: 400 }, (_, id) => ({
    id,
    col: 0,
    row: 0,
    cols: 1,
    rows: 1,
    cells: 1,
    hallway: false,
    building: 0,
  }));
  const none = lightRooms(
    rooms,
    { fixture: 0, powered: 0, exitShade: 0 },
    mulberry32(1),
  );
  expect(none.some((each) => each.fixture || each.powered)).toBe(false);
  const all = lightRooms(
    rooms,
    { fixture: 1, powered: 1, exitShade: 0 },
    mulberry32(1),
  );
  expect(all.every((each) => each.fixture && each.powered)).toBe(true);

  const powered = powerRooms(rooms, 0.25, mulberry32(2)).filter(Boolean);
  expect(powered.length).toBeGreaterThan(60);
  expect(powered.length).toBeLessThan(140);
});

test("a world's lights change nothing of its layout", () => {
  const lit = (fixture: number, powered: number) =>
    buildWorld(
      {
        ...testSimConfig.world,
        generation: {
          ...testSimConfig.world.generation,
          lights: { fixture, powered, exitShade: 0 },
        },
      },
      mulberry32(3),
    );
  const dark = lit(0, 0);
  const bright = lit(1, 1);
  expect(bright.layout.area).toEqual(dark.layout.area);
  expect(bright.layout.rooms.length).toBeGreaterThan(0);
  expect(
    bright.layout.rooms.every((each) => each.fixture && each.powered),
  ).toBe(true);
  const roomCell = dark.layout.area.indexOf(AREA.room);
  const at = {
    x: ((roomCell % dark.map.cols) + 0.5) * CELL,
    y: (Math.floor(roomCell / dark.map.cols) + 0.5) * CELL,
  };
  expect(ambientLightAt(dark, at)).toBeNull();
  expect(ambientLightAt(bright, at)).toBe("fixture");
});

/** The centres of every road and yard cell of `world`. */
function outdoorCells(world: World): { x: number; y: number }[] {
  const { cell, cols } = world.map;
  return [...world.layout.area.entries()]
    .filter(([, code]) => code === road || code === yard)
    .map(([i]) => ({
      x: ((i % cols) + 0.5) * cell,
      y: (Math.floor(i / cols) + 0.5) * cell,
    }));
}

test("daylight recedes towards the road's centre line, which is lit last, and none is left at night", () => {
  const world = buildWorld(testSimConfig.world, mulberry32(5));
  const outdoors = outdoorCells(world);
  const sunlitAt = (daylight: number) =>
    outdoors.filter((at) => ambientLightAt(world, at, daylight) === "sun");
  const counts = [1, 0.6, 0.2, 0.01, 0].map((share) => sunlitAt(share).length);
  for (let i = 1; i < counts.length; i++)
    expect(counts[i]).toBeLessThan(counts[i - 1] ?? 0);
  expect(counts.at(-1)).toBe(0);

  // What is still lit late is what lies nearest the centre line.
  const { cell } = world.map;
  const offCentre = (at: { x: number; y: number }) =>
    Math.abs(
      at.y / cell - (world.layout.roadCentre[Math.floor(at.x / cell)] ?? 0),
    );
  const late = new Set(sunlitAt(0.2));
  const furthestLit = Math.max(...[...late].map(offCentre));
  const litByDay = sunlitAt(1);
  expect(
    litByDay
      .filter((at) => !late.has(at))
      .every((at) => offCentre(at) > furthestLit),
  ).toBe(true);
});

test("sunlight never reaches the ground round the exit", () => {
  const world = buildWorld(testSimConfig.world, mulberry32(5));
  const { exit, exitShade } = world.layout;
  expect(exitShade).toBeGreaterThan(0);
  const inExit = outdoorCells(world).filter(
    (at) => at.x >= exit.x && at.y >= exit.y && at.y <= exit.y + exit.h,
  );
  expect(inExit.length).toBeGreaterThan(0);
  expect(inExit.every((at) => ambientLightAt(world, at, 1) === null)).toBe(
    true,
  );
  const reach = (exitShade + 1) * world.map.cell;
  const beyond = outdoorCells(world).filter((at) => at.x < exit.x - reach);
  expect(beyond.every((at) => ambientLightAt(world, at, 1) === "sun")).toBe(
    true,
  );
});

test("a session's road is lit by day and dark at night, by its world clock", () => {
  const game = createSession(
    "me",
    "ME",
    "DAY",
    "standard",
    testSfx(),
    testSimConfig,
  );
  const middle = outdoorCells(game.world).find(
    (at) => Math.abs(at.x - game.world.W / 2) < CELL,
  );
  if (middle === undefined) throw new Error("no road in the middle");
  expect(isLit(game, middle, [])).toBe(true);
  game.worldTime = testSimConfig.day.night;
  expect(isLit(game, middle, [])).toBe(false);
});

test("darkness given off unlights what it reaches, whatever lights it; a shrouded body takes the world for dark", () => {
  const game = createSession("me", "ME", "DARK", "dev", testSfx(), {
    ...testSimConfig,
  });
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
  spawnEntity(game, "lamp", 450, 300, {});
  expect(isLit(game, { x: 650, y: 300 })).toBe(true);
  spawnEntity(game, "shade", 600, 300, {});
  expect(darkSources(game)).toEqual([{ x: 600, y: 300, range: 100 }]);
  expect(isLit(game, { x: 650, y: 300 })).toBe(false);
  expect(isLit(game, { x: 450, y: 300 })).toBe(true);

  expect(isLitTo(game, "me", { x: 450, y: 300 })).toBe(true);
  expect(shroud(game, "me", 1)).toBe(true);
  expect(isShrouded(game, "me")).toBe(true);
  expect(isLitTo(game, "me", { x: 450, y: 300 })).toBe(false);
  expect(isLit(game, { x: 450, y: 300 })).toBe(true);
  game.worldTime += 1.1;
  expect(isLitTo(game, "me", { x: 450, y: 300 })).toBe(true);
});
