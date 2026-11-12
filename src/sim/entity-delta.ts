import { z } from "zod";
import type { EntitySnapshot } from "./entities.js";

/**
 * What changed of an entity a client already holds: its id, and only the fields that changed.
 * `patch` holds the changed keys of state that is an object, merged over what the client holds;
 * `data` replaces the state whole, as when a key of it went.
 */
export interface EntityChange {
  readonly id: string;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly health?: number | undefined;
  readonly data?: unknown;
  readonly patch?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * What a snapshot sent after one of `previous` carries: the entities new since, whole; what
 * changed of the others; and the ids of those gone.
 */
export interface EntityDelta {
  readonly added: EntitySnapshot[];
  readonly changed: EntityChange[];
  readonly removed: string[];
}

/** State that is an object, which changes travel key by key. */
const Fields = z.record(z.string(), z.unknown());

const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** How state went from `before` to `after`: nothing, the keys that changed, or all of it. */
function dataChange(
  before: unknown,
  after: unknown,
): Pick<EntityChange, "data" | "patch"> {
  const from = Fields.safeParse(before);
  const to = Fields.safeParse(after);
  if (
    from.success &&
    to.success &&
    Object.keys(from.data).every((key) => Object.hasOwn(to.data, key))
  ) {
    const patch = Object.fromEntries(
      Object.entries(to.data).filter(
        ([key, value]) => !same(from.data[key], value),
      ),
    );
    return Object.keys(patch).length === 0 ? {} : { patch };
  }
  return same(before, after) ? {} : { data: after };
}

/** What changed of `before` to make `after`, or null when nothing did. */
function entityChange(
  before: EntitySnapshot,
  after: EntitySnapshot,
): EntityChange | null {
  const change: EntityChange = {
    id: after.id,
    ...(before.x === after.x ? {} : { x: after.x }),
    ...(before.y === after.y ? {} : { y: after.y }),
    ...(before.health === after.health ? {} : { health: after.health }),
    ...dataChange(before.data, after.data),
  };
  return Object.keys(change).length > 1 ? change : null;
}

/**
 * The delta from the entities `previous`, by id, to `current`. An entity whose kind changed is
 * sent whole, as new.
 */
export function entityDelta(
  previous: ReadonlyMap<string, EntitySnapshot>,
  current: readonly EntitySnapshot[],
): EntityDelta {
  const added: EntitySnapshot[] = [];
  const changed: EntityChange[] = [];
  const ids = new Set<string>();
  for (const entity of current) {
    ids.add(entity.id);
    const before = previous.get(entity.id);
    if (before?.kind !== entity.kind) {
      added.push(entity);
      continue;
    }
    const change = entityChange(before, entity);
    if (change !== null) changed.push(change);
  }
  const removed = [...previous.keys()].filter((id) => !ids.has(id));
  return { added, changed, removed };
}

/** The state `change` makes of `before`, both in the form state travels in. */
export function changedData(before: unknown, change: EntityChange): unknown {
  if (change.data !== undefined) return change.data;
  if (change.patch === undefined) return before;
  const fields = Fields.safeParse(before);
  return { ...(fields.success ? fields.data : {}), ...change.patch };
}
