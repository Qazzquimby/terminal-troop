import { z } from "zod";
import type { Session } from "./session.js";

/**
 * State a content entry keeps once for the whole world. The host owns it; every client holds a
 * copy, so a client that joins late or takes over as host has it. An entry only the host acts
 * on, such as a record of requests it has answered, is held everywhere too, for the next host.
 */
export interface WorldDataSpec<S> {
  /** Checks a value, encodes it for the wire and decodes it back. */
  readonly schema: z.ZodType<S>;
  /** The value until the host first sets it. */
  readonly initial: S;
}

/** Reads a content entry's world state on any client, and writes it on the host. */
export interface WorldData<S> extends WorldDataSpec<S> {
  get(game: Session): S;
  /**
   * Sets the value, if this client hosts; on any other the host decides it, so this changes
   * nothing and returns false. Throws when `value` does not encode.
   */
  set(game: Session, value: S): boolean;
}

/** A host by its id, in the election that chose it. */
export interface HostTerm {
  readonly host: string;
  readonly term: number;
}

/** A world entry's value as this client holds it. */
export interface HeldWorldValue {
  /** The value in its wire form. */
  readonly wire: unknown;
  /** Counts the host's changes to the entry; each new host counts on from the one it holds. */
  readonly version: number;
  /** The host it was taken from; null when this client set it, hosting. */
  readonly from: HostTerm | null;
}

/** World state as a host sends it: each entry's version and wire value, by the entry's name. */
export type WorldEntries = Record<string, readonly [number, unknown]>;

/** A world entry's version and value as it travels; the value is the entry's to parse. */
const WireEntry = z.tuple([z.number().int().min(0), z.unknown()]);

/** A content entry's world state, read and written through the returned accessor. */
export function worldData<S>(spec: WorldDataSpec<S>): WorldData<S> {
  const { schema, initial } = spec;
  const data: WorldData<S> = {
    schema,
    initial,
    get(game) {
      const held = game.worldValues.get(data);
      return held === undefined ? initial : schema.parse(held.wire);
    },
    set(game, value) {
      if (!game.hosting) return false;
      const wire = schema.encode(value);
      const held = game.worldValues.get(data);
      if (
        held !== undefined &&
        JSON.stringify(held.wire) === JSON.stringify(wire)
      )
        return true;
      game.worldValues.set(data, {
        wire,
        version: (held?.version ?? 0) + 1,
        from: null,
      });
      game.worldChanged.add(data);
      return true;
    },
  };
  return data;
}

/** A content entry's world state, by the key each part travels under within the entry. */
export type WorldDataSet = Readonly<Record<string, WorldData<unknown>>>;

/** Registers each of `world` under the content entry `name`, as `<name>.<key>`. */
export function registerWorldData(
  game: Session,
  name: string,
  world: WorldDataSet,
): void {
  for (const [key, data] of Object.entries(world)) {
    const wireName = `${name}.${key}`;
    if (game.worldData.has(wireName))
      throw new Error(`World data already registered: ${wireName}`);
    game.worldData.set(wireName, data);
  }
}

/**
 * The world state a host sends next: every entry when `full`, an entry it never set at version 0
 * with its initial value; otherwise only those set since the last call, or null when there are
 * none.
 */
export function takeWorldEntries(
  game: Session,
  full: boolean,
): WorldEntries | null {
  const sent = [...game.worldData].filter(
    ([, data]) => full || game.worldChanged.has(data),
  );
  game.worldChanged.clear();
  if (sent.length === 0) return null;
  return Object.fromEntries(
    sent.map(([name, data]) => {
      const held = game.worldValues.get(data);
      return [
        name,
        held === undefined
          ? ([0, data.schema.encode(data.initial)] as const)
          : ([held.version, held.wire] as const),
      ];
    }),
  );
}

function sameTerm(a: HostTerm | null, b: HostTerm): boolean {
  return a !== null && a.host === b.host && a.term === b.term;
}

/**
 * Takes the world state the host `from` sent. An entry replaces the one held unless both come
 * from the same host and term and the one held is as new or newer, so a late or repeated message
 * never rolls an entry back, and a new host's state replaces what an earlier host sent. An entry
 * of an unregistered name, malformed, or whose schema rejects its value, is dropped; an entry
 * missing keeps its value.
 */
export function applyWorldEntries(
  game: Session,
  from: HostTerm,
  entries: Readonly<Record<string, unknown>>,
): void {
  for (const [name, entry] of Object.entries(entries)) {
    const data = game.worldData.get(name);
    const wire = WireEntry.safeParse(entry);
    if (data === undefined || !wire.success) continue;
    const [version, value] = wire.data;
    const held = game.worldValues.get(data);
    if (
      held !== undefined &&
      sameTerm(held.from, from) &&
      version <= held.version
    )
      continue;
    const parsed = data.schema.safeParse(value);
    if (!parsed.success) continue;
    game.worldValues.set(data, {
      wire: data.schema.encode(parsed.data),
      version,
      from: { host: from.host, term: from.term },
    });
  }
}
