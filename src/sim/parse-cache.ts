import type { z } from "zod";

/*
 * State is held as values that are replaced, never changed in place: a kind's update returns a
 * new state, a world entry's write holds a new entry. So a schema's verdict on a held value, and
 * the value it parses out, stands for as long as that value is held, and is worked out once
 * rather than on every read (#470). Network input is parsed where it arrives, as before.
 */

let freezing = false;

/**
 * Freezes, from now on, each value a `heldParser` or world data caches and what it parses out of
 * it, so changing one in place throws rather than leaving a stale verdict. The tests turn it on;
 * a game leaves it off, to pay nothing for it.
 */
export function freezeHeld(on: boolean): void {
  freezing = on;
}

/** Freezes `value` and everything in it, when `freezeHeld` is on. */
export function guardHeld(value: unknown): void {
  if (freezing) deepFreeze(value);
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
}

/**
 * `schema.safeParse`, worked out once for each value held. A result is shared by every caller
 * that asks of the same value, so it must not be changed in place. A value that is not an object
 * is parsed each time: it is cheap, and has no identity to key on.
 */
export function heldParser<S>(
  schema: z.ZodType<S>,
): (value: unknown) => z.ZodSafeParseResult<S> {
  const verdicts = new WeakMap<object, z.ZodSafeParseResult<S>>();
  return (value) => {
    if (typeof value !== "object" || value === null)
      return schema.safeParse(value);
    const known = verdicts.get(value);
    if (known !== undefined) return known;
    const parsed = schema.safeParse(value);
    guardHeld(value);
    if (parsed.success) guardHeld(parsed.data);
    verdicts.set(value, parsed);
    return parsed;
  };
}
