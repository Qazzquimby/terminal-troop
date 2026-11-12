import { z } from "zod";
import type { Point, WorldKind } from "../sim/index.js";

/** How where the local player stands is kept between visits. */
export interface PositionMemoryConfig {
  /** How often, in seconds, the position is saved while it keeps changing. */
  readonly saveInterval: number;
  /** How many of the most recently saved worlds are kept; older ones are dropped. */
  readonly maxRooms: number;
}

/** Where positions are kept between visits, by key. Either method may throw. */
export interface PositionStorage {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
}

/** A world as a room builds it: the same room code, world kind and seed build the same map. */
export interface PositionPlace {
  readonly room: string;
  readonly world: WorldKind;
  /** The session's seed, which covers the room code and the world config's seed. */
  readonly seed: number;
}

/** Where the local player last stood in a world, kept on this client alone. */
export interface PositionMemory {
  /**
   * Saves where the player stood in the world left, then keeps positions for `place`, and
   * returns where the player last stood there, if it was saved.
   */
  enter(place: PositionPlace): Point | undefined;
  /**
   * Keeps `at` as where the player stands, and saves it unless saved under `saveInterval` before
   * `now` (ms). The first position after entering is where the player started, so it is saved
   * only once the player moves off it.
   */
  save(at: Point, now: number): void;
  /** Saves where the player stands now, as when the page hides or closes. */
  flush(): void;
}

/** The storage key of every saved position, most recently saved first. */
export const POSITION_MEMORY_KEY = "terminal-troop:positions";

const SavedSchema = z.array(
  z.object({ place: z.string(), x: z.number(), y: z.number() }),
);

type Saved = z.infer<typeof SavedSchema>;

function placeKey(place: PositionPlace): string {
  return `${place.world}:${place.room}:${String(place.seed)}`;
}

/**
 * Keeps nothing until it enters a world. Reads and writes through `storage` never stop the
 * game: a failed read finds nothing saved, and a failed write is tried again at the next save.
 */
export function createPositionMemory(
  config: PositionMemoryConfig,
  storage: PositionStorage,
): PositionMemory {
  let place: string | null = null;
  let latest: Point | null = null;
  let dirty = false;
  let nextSaveAt = 0;

  function read(): Saved {
    try {
      const raw = storage.get(POSITION_MEMORY_KEY);
      if (raw === null) return [];
      const parsed = SavedSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  function write(): void {
    if (place === null || latest === null || !dirty) return;
    const key = place;
    const entry = { place: key, x: latest.x, y: latest.y };
    const saved = [entry, ...read().filter((other) => other.place !== key)];
    try {
      storage.set(
        POSITION_MEMORY_KEY,
        JSON.stringify(saved.slice(0, config.maxRooms)),
      );
      dirty = false;
    } catch {
      // Tried again at the next save.
    }
  }

  return {
    enter(next) {
      write();
      place = placeKey(next);
      latest = null;
      dirty = false;
      nextSaveAt = 0;
      const key = place;
      const found = read().find((entry) => entry.place === key);
      return found === undefined ? undefined : { x: found.x, y: found.y };
    },
    save(at, now) {
      if (latest === null) {
        latest = { x: at.x, y: at.y };
      } else if (latest.x !== at.x || latest.y !== at.y) {
        latest = { x: at.x, y: at.y };
        dirty = true;
      }
      if (!dirty || now < nextSaveAt) return;
      write();
      nextSaveAt = now + config.saveInterval * 1000;
    },
    flush: write,
  };
}
