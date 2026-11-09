import { z } from "zod";

const PlayerId = z.string().min(1).max(64);

// z.number() rejects NaN and ±Infinity.
const StateMessage = z.object({
  id: PlayerId,
  name: z.string(),
  x: z.number(),
  y: z.number(),
  aim: z.number(),
});

type StateMessage = z.infer<typeof StateMessage>;

/** Reads a STATE payload with its name cut to `nameMax` characters; null when it does not parse. */
export function parseStateMessage(
  payload: unknown,
  nameMax: number,
): StateMessage | null {
  const parsed = StateMessage.safeParse(payload);
  if (!parsed.success) return null;
  return { ...parsed.data, name: parsed.data.name.slice(0, nameMax) };
}

/** HELLO and BYE carry only the sender's id. */
export const PresenceMessage = z.object({ id: PlayerId });

/** A heartbeat carries the sender's id and whether its page is hidden. */
export const HeartbeatMessage = PresenceMessage.extend({ hidden: z.boolean() });
