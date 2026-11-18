import { z } from "zod";
import { describe, expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  AREA,
  createSession,
  defineEntity,
  destroyWalls,
  hurt,
  isSolid,
  receiveEvent,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Session, WorldEntity } from "../../sim/index.js";
import { planRoute } from "../route.js";
import { door as doorContent, DoorState, drawDoor } from "./index.js";

const DT = 1 / 60;
const config = testEntitiesConfig.door;
const CELL = 50;
/** The doorway: column 9 of the dev square is walled top to bottom but for row 5. */
const DOOR = { col: 9, row: 5 } as const;
const DOOR_AT = { x: (DOOR.col + 0.5) * CELL, y: (DOOR.row + 0.5) * CELL };

/**
 * A test body that walks right at its speed, whatever is in its way: as a monster steered into a
 * door it wants to be past.
 */
const walker = <N extends string>(name: N, opensDoors: boolean) =>
  defineEntity(name, (speed: number) => ({
    radius: 14,
    maxHealth: 100,
    opensDoors,
    data: z.object({}),
    update(entity) {
      entity.vx = speed;
      entity.vy = 0;
      return {};
    },
    draw: () => undefined,
  }));

const opener = walker("opener", true);
const basher = walker("basher", false);

/** The dev square, walled down column 9 but for the doorway; the local player at (x, y). */
function world(x: number, y: number): Session {
  const game = createSession(
    "me",
    "ME",
    "STONE",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  registerContent(game, [
    doorContent.create({ door: config }),
    opener.create({ opener: 60 }),
    basher.create({ basher: 60 }),
  ]);
  const { map } = game.world;
  for (let row = 0; row < map.rows; row++)
    if (row !== DOOR.row) map.solid[row * map.cols + DOOR.col] = 1;
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  return game;
}

function addDoor(game: Session, open: boolean): WorldEntity {
  const state: DoorState = { open, across: true };
  return spawnEntity(game, "door", DOOR_AT.x, DOOR_AT.y, state);
}

/** Steps `seconds`, pressing interact on the first step if `interact`, events delivered at once. */
function run(game: Session, seconds: number, interact = false): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(
      game,
      {
        move: { x: 0, y: 0 },
        aim: { x: game.local.x + 1, y: game.local.y },
        sprint: false,
        crouch: false,
        select: null,
        cycle: 0,
        use: false,
        holdingUse: false,
        secondary: false,
        interact: interact && step === 0,
        drop: false,
      },
      DT,
    );
    for (const { content, event, to, payload } of game.outbox.splice(0))
      receiveEvent(
        game,
        { from: game.localId, to, content, event, payload },
        game.localId,
      );
    for (const { event, payload, sender } of game.inbox.splice(0))
      event.receive(game, payload, sender);
  }
}

const doorwaySolid = (game: Session) =>
  isSolid(game.world.map, DOOR.col, DOOR.row);

const isOpen = (door: WorldEntity) => DoorState.parse(door.data).open;

describe("doors", () => {
  test("a new world lays a shut door in each 1-wide doorway it picks, and none in a wider one", () => {
    const game = createSession(
      "me",
      "ME",
      "STONE",
      "standard",
      testSfx(),
      testSimConfig,
    );
    const content = doorContent.create({ door: { ...config, frequency: 1 } });
    registerContent(game, [content]);
    content.populate(game);
    const { map, layout } = game.world;
    const { cols, rows } = map;
    const area = (col: number, row: number) =>
      col < 0 || row < 0 || col >= cols || row >= rows
        ? AREA.wall
        : layout.area[row * cols + col];
    const wall = (col: number, row: number) => area(col, row) === AREA.wall;
    const isDoor = (col: number, row: number) => area(col, row) === AREA.door;
    // Each door cell with no door cell beside it and walls on two opposite sides: a 1-wide gap.
    const gaps: { col: number; row: number; across: boolean }[] = [];
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < cols; col++) {
        if (!isDoor(col, row)) continue;
        if (
          isDoor(col - 1, row) ||
          isDoor(col + 1, row) ||
          isDoor(col, row - 1) ||
          isDoor(col, row + 1)
        )
          continue;
        const up = wall(col, row - 1) && wall(col, row + 1);
        const side = wall(col - 1, row) && wall(col + 1, row);
        if (up !== side) gaps.push({ col, row, across: up });
      }
    const doorCells = layout.area.filter((code) => code === AREA.door).length;
    expect(gaps.length).toBeGreaterThan(0);
    // The world has wider doorways too, which get no door.
    expect(doorCells).toBeGreaterThan(gaps.length);
    const doors = [...game.entities.values()];
    expect(doors).toHaveLength(gaps.length);
    for (const door of doors) {
      const col = Math.floor(door.x / map.cell);
      const row = Math.floor(door.y / map.cell);
      const found = gaps.find((g) => g.col === col && g.row === row);
      expect(found).toBeDefined();
      expect(DoorState.parse(door.data)).toEqual({
        open: false,
        across: found?.across,
      });
    }
    const none = createSession(
      "me",
      "ME",
      "STONE",
      "standard",
      testSfx(),
      testSimConfig,
    );
    const off = doorContent.create({ door: { ...config, frequency: 0 } });
    registerContent(none, [off]);
    off.populate(none);
    expect(none.entities.size).toBe(0);
  });

  test("an open door is drawn flat against the wall it hangs on, leaving its doorway clear", () => {
    for (const across of [true, false]) {
      const game = world(100, 300);
      const door = addDoor(game, true);
      const rects: [number, number, number, number][] = [];
      const ctx = {
        fillStyle: "",
        fillRect: (x: number, y: number, w: number, h: number) => {
          rects.push([x, y, w, h]);
        },
        beginPath: () => undefined,
        arc: () => undefined,
        fill: () => undefined,
      };
      drawDoor(ctx, CELL, door, { open: true, across });
      const left = DOOR.col * CELL;
      const top = DOOR.row * CELL;
      expect(rects.length).toBeGreaterThan(0);
      for (const [x, y, w, h] of rects) {
        // Across, the way runs left to right: the door lies along the wall above, a thin strip.
        if (across) {
          expect(y).toBeGreaterThanOrEqual(top);
          expect(y + h).toBeLessThanOrEqual(top + CELL * 0.25);
        } else {
          expect(x).toBeGreaterThanOrEqual(left);
          expect(x + w).toBeLessThanOrEqual(left + CELL * 0.25);
        }
      }
    }
  });

  test("a closed door walls its cell off; open, or broken, it is floor", () => {
    const game = world(100, 300);
    const door = addDoor(game, false);
    run(game, DT);
    expect(doorwaySolid(game)).toBe(true);
    door.data = { open: true, across: true };
    run(game, DT);
    expect(doorwaySolid(game)).toBe(false);
    door.data = { open: false, across: true };
    run(game, DT);
    expect(doorwaySolid(game)).toBe(true);
    hurt(game, door, config.maxHealth, null);
    run(game, DT * 2);
    expect(game.entities.has(door.id)).toBe(false);
    expect(doorwaySolid(game)).toBe(false);
  });

  test("a player beside a door opens and closes it with interact, and is heard doing so", () => {
    const game = world(DOOR_AT.x - CELL, DOOR_AT.y);
    const door = addDoor(game, false);
    run(game, DT);
    run(game, 0.5, true);
    expect(isOpen(door)).toBe(true);
    expect(doorwaySolid(game)).toBe(false);
    run(game, 0.5, true);
    expect(isOpen(door)).toBe(false);
  });

  test("a player out of reach of a door works nothing", () => {
    const game = world(DOOR_AT.x - CELL * 4, DOOR_AT.y);
    const door = addDoor(game, false);
    run(game, 0.5, true);
    expect(isOpen(door)).toBe(false);
  });

  test("a door does not shut on a body standing in its doorway", () => {
    const game = world(DOOR_AT.x - CELL, DOOR_AT.y);
    const door = addDoor(game, true);
    spawnEntity(game, "basher", DOOR_AT.x, DOOR_AT.y, {});
    run(game, DT, true);
    expect(isOpen(door)).toBe(true);
  });

  test("a body that opens doors, walked into a closed one, opens it in half a second", () => {
    const game = world(100, 500);
    const door = addDoor(game, false);
    spawnEntity(game, "opener", DOOR_AT.x - CELL, DOOR_AT.y, {});
    run(game, 0.6);
    expect(isOpen(door)).toBe(false);
    run(game, 0.6);
    expect(isOpen(door)).toBe(true);
    expect(door.health).toBe(config.maxHealth);
  });

  test("any other body walked into a closed door bashes it, every second, until it breaks", () => {
    const game = world(100, 500);
    const door = addDoor(game, false);
    spawnEntity(game, "basher", DOOR_AT.x - CELL, DOOR_AT.y, {});
    run(game, 2);
    expect(isOpen(door)).toBe(false);
    expect(door.health).toBeLessThan(config.maxHealth);
    expect(door.health).toBeGreaterThanOrEqual(
      config.maxHealth - config.bash.damage * 2,
    );
    run(game, 16);
    expect(game.entities.has(door.id)).toBe(false);
    expect(doorwaySolid(game)).toBe(false);
  });

  test("blasts that knock walls down spare a door's cell", () => {
    const game = world(100, 500);
    addDoor(game, false);
    run(game, DT);
    destroyWalls(game, { center: DOOR_AT, radius: CELL });
    expect(doorwaySolid(game)).toBe(true);
    expect(isSolid(game.world.map, DOOR.col, DOOR.row - 1)).toBe(false);
  });

  test("a route goes through a closed door, but not a wanderer's", () => {
    const game = world(100, 500);
    addDoor(game, false);
    run(game, DT);
    const from = { x: DOOR_AT.x - CELL * 2, y: DOOR_AT.y };
    const to = { x: DOOR_AT.x + CELL * 2, y: DOOR_AT.y };
    const route = planRoute(game.world.map, 14, from, to);
    expect(route).not.toBeNull();
    expect(
      route?.some((at) => Math.hypot(at.x - DOOR_AT.x, at.y - DOOR_AT.y) < 1),
    ).toBe(true);
    const wander = planRoute(
      game.world.map,
      14,
      from,
      to,
      undefined,
      undefined,
      false,
    );
    expect(wander).toBeNull();
  });
});
