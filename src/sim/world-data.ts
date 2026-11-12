import type { z } from "zod";
import type { Session } from "./session.js";

/**
 * State a content entry keeps once for the whole world: the host owns it, and sends it with
 * every entity snapshot, so a client that joins late or takes over as host has it.
 */
export interface WorldDataSpec<S> {
  /** Checks a value, encodes it for the wire and decodes it back. */
  readonly schema: z.ZodType<S>;
  /** The value until the host sets it, or a snapshot carries it. */
  readonly initial: S;
}

/** Reads a content entry's world state on any client, and writes it on the host. */
export interface WorldData<S> extends WorldDataSpec<S> {
  get(game: Session): S;
  /**
   * Sets the value, if this client hosts; on any other the host's snapshots decide it, so this
   * changes nothing and returns false. Throws when `value` does not encode.
   */
  set(game: Session, value: S): boolean;
}

/** A content entry's world state, read and written through the returned accessor. */
export function worldData<S>(spec: WorldDataSpec<S>): WorldData<S> {
  const { schema, initial } = spec;
  const data: WorldData<S> = {
    schema,
    initial,
    get(game) {
      if (!game.worldValues.has(data)) return initial;
      return schema.parse(game.worldValues.get(data));
    },
    set(game, value) {
      if (!game.hosting) return false;
      game.worldValues.set(data, schema.encode(value));
      return true;
    },
  };
  return data;
}

/** Registers `data` under the content entry `name`, the key the entry's state travels under. */
export function registerWorldData(
  game: Session,
  name: string,
  data: WorldData<unknown>,
): void {
  if (game.worldData.has(name))
    throw new Error(`World data already registered: ${name}`);
  game.worldData.set(name, data);
}

/** Every content entry's world state, each encoded by its own schema, by name, as the host sends it. */
export function worldState(game: Session): Record<string, unknown> {
  return Object.fromEntries(
    [...game.worldData].map(([name, data]) => [
      name,
      data.schema.encode(data.get(game)),
    ]),
  );
}

/**
 * Takes the world state a host sent: each value decoded by its own entry's schema. A value of an
 * unregistered entry, or one its schema rejects, is dropped; an entry missing keeps its value.
 */
export function applyWorldState(
  game: Session,
  state: Readonly<Record<string, unknown>>,
): void {
  for (const [name, wire] of Object.entries(state)) {
    const data = game.worldData.get(name);
    if (data === undefined) continue;
    const parsed = data.schema.safeParse(wire);
    if (parsed.success)
      game.worldValues.set(data, data.schema.encode(parsed.data));
  }
}
