import { describe, expect, test } from "vitest";
import {
  POSITION_MEMORY_KEY,
  createPositionMemory,
} from "./position-memory.js";
import type { PositionPlace, PositionStorage } from "./position-memory.js";

const config = { saveInterval: 1, maxRooms: 2 };
const here: PositionPlace = {
  player: "me",
  room: "ROOM1",
  world: "dev",
  seed: 1,
};

/** Storage held in a map, counting writes. */
function memoryStorage(): PositionStorage & {
  readonly saved: Map<string, string>;
  writes: number;
} {
  const saved = new Map<string, string>();
  return {
    saved,
    writes: 0,
    get: (key) => saved.get(key) ?? null,
    set(key, value) {
      this.writes++;
      saved.set(key, value);
    },
  };
}

describe("position memory", () => {
  test("knows nothing of a world never saved", () => {
    expect(createPositionMemory(config, memoryStorage()).enter(here)).toBe(
      undefined,
    );
  });

  test("finds where the player stood on the next visit", () => {
    const storage = memoryStorage();
    const before = createPositionMemory(config, storage);
    before.enter(here);
    before.save({ x: 10, y: 20 }, 0);
    before.save({ x: 30, y: 40 }, 100);
    before.flush();

    const after = createPositionMemory(config, storage);
    expect(after.enter(here)).toEqual({ x: 30, y: 40 });
  });

  test("keeps each player apart: a player in another tab finds its own spot", () => {
    const storage = memoryStorage();
    const mine = createPositionMemory(config, storage);
    const theirs = createPositionMemory(config, storage);
    mine.enter(here);
    theirs.enter({ ...here, player: "them" });
    mine.save({ x: 1, y: 2 }, 0);
    theirs.save({ x: 3, y: 4 }, 0);

    const fresh = createPositionMemory(config, storage);
    expect(fresh.enter(here)).toEqual({ x: 1, y: 2 });
    expect(fresh.enter({ ...here, player: "them" })).toEqual({ x: 3, y: 4 });
    expect(fresh.enter({ ...here, player: "new" })).toBe(undefined);
  });

  test("keeps each world apart: another room, world kind or seed finds nothing", () => {
    const storage = memoryStorage();
    const memory = createPositionMemory(config, storage);
    memory.enter(here);
    memory.save({ x: 10, y: 20 }, 0);

    const fresh = createPositionMemory(config, storage);
    expect(fresh.enter({ ...here, room: "ROOM2" })).toBe(undefined);
    expect(fresh.enter({ ...here, world: "standard" })).toBe(undefined);
    expect(fresh.enter({ ...here, seed: 2 })).toBe(undefined);
    expect(fresh.enter(here)).toEqual({ x: 10, y: 20 });
  });

  test("saves at most once each interval while the player moves, and only when it moved", () => {
    const storage = memoryStorage();
    const memory = createPositionMemory(config, storage);
    memory.enter(here);
    memory.save({ x: 1, y: 1 }, 0);
    memory.save({ x: 2, y: 1 }, 500);
    expect(storage.writes).toBe(1);
    memory.save({ x: 3, y: 1 }, 1000);
    expect(storage.writes).toBe(2);
    memory.save({ x: 3, y: 1 }, 5000);
    memory.flush();
    expect(storage.writes).toBe(2);
  });

  test("saves the world left when entering another", () => {
    const storage = memoryStorage();
    const memory = createPositionMemory(config, storage);
    memory.enter(here);
    memory.save({ x: 1, y: 1 }, 0);
    memory.save({ x: 5, y: 5 }, 10);
    memory.enter({ ...here, room: "ROOM2" });
    expect(createPositionMemory(config, storage).enter(here)).toEqual({
      x: 5,
      y: 5,
    });
  });

  test("keeps only the most recently saved worlds", () => {
    const storage = memoryStorage();
    const memory = createPositionMemory(config, storage);
    for (const room of ["A", "B", "C"]) {
      memory.enter({ ...here, room });
      memory.save({ x: 1, y: 1 }, 0);
    }
    const fresh = createPositionMemory(config, storage);
    expect(fresh.enter({ ...here, room: "A" })).toBe(undefined);
    expect(fresh.enter({ ...here, room: "C" })).toEqual({ x: 1, y: 1 });
  });

  test("a failing or garbled store never stops the game", () => {
    const failing: PositionStorage = {
      get: () => {
        throw new Error("denied");
      },
      set: () => {
        throw new Error("full");
      },
    };
    const memory = createPositionMemory(config, failing);
    expect(memory.enter(here)).toBe(undefined);
    expect(() => {
      memory.save({ x: 1, y: 1 }, 0);
      memory.flush();
    }).not.toThrow();

    for (const garbled of ["{", '[{"place":1}]', "null"]) {
      const storage = memoryStorage();
      storage.saved.set(POSITION_MEMORY_KEY, garbled);
      expect(createPositionMemory(config, storage).enter(here)).toBe(undefined);
    }
  });

  test("a write that failed is tried again", () => {
    const storage = memoryStorage();
    let full = true;
    const flaky: PositionStorage = {
      get: storage.get,
      set(key, value) {
        if (full) throw new Error("full");
        storage.set(key, value);
      },
    };
    const memory = createPositionMemory(config, flaky);
    memory.enter(here);
    memory.save({ x: 7, y: 8 }, 0);
    full = false;
    memory.flush();
    expect(createPositionMemory(config, storage).enter(here)).toEqual({
      x: 7,
      y: 8,
    });
  });
});
