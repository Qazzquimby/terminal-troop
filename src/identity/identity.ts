import { z } from "zod";

/** Where the player id is kept: the page's own storage, kept across reloads. Either method may throw. */
export interface PlayerIdStorage {
  get: () => string | null;
  set: (value: string) => void;
}

/** The local player's id, the same across reloads of one page and different between pages. */
export interface PlayerIdentity {
  current(): string;
  /** Replaces the id with a fresh one, kept from now on, and returns it. */
  renew(): string;
}

/** As long as a player id may be on the wire. */
const PlayerId = z.string().min(1).max(64);

/**
 * Reads the id kept in `storage`, or keeps a fresh one from `fresh`. Storage never stops the
 * game: an id that cannot be read or kept is fresh, and lasts as long as the page.
 */
export function createPlayerIdentity(
  storage: PlayerIdStorage,
  fresh: () => string,
): PlayerIdentity {
  function keep(id: string): string {
    try {
      storage.set(id);
    } catch {
      // Lasts as long as the page.
    }
    return id;
  }

  function read(): string | null {
    try {
      const parsed = PlayerId.safeParse(storage.get());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  let id = read() ?? keep(fresh());
  return {
    current: () => id,
    renew() {
      id = keep(fresh());
      return id;
    },
  };
}
