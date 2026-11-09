import { z } from "zod";
import { NetEvent } from "../net/index.js";

const PlayerId = z.string().min(1).max(64);

/** A STATE payload, its name cut to `nameMax` characters. z.number() rejects NaN and ±Infinity. */
function stateMessage(nameMax: number) {
  return z.object({
    id: PlayerId,
    name: z.string().transform((name) => name.slice(0, nameMax)),
    x: z.number(),
    y: z.number(),
    aim: z.number(),
  });
}

/** HELLO and BYE carry only the sender's id. */
const PresenceMessage = z.object({ id: PlayerId });

/** Every event's payload schema; a missing event fails to compile. */
export function roomMessages(nameMax: number) {
  return {
    [NetEvent.HELLO]: PresenceMessage,
    [NetEvent.STATE]: stateMessage(nameMax),
    [NetEvent.BYE]: PresenceMessage,
    // The voice room parses its own signals.
    [NetEvent.SIGNAL]: z.unknown(),
  } as const satisfies Record<NetEvent, z.ZodType>;
}

export type RoomMessages = ReturnType<typeof roomMessages>;

/** The payload a handler of `E` receives. */
export type Message<E extends NetEvent> = z.output<RoomMessages[E]>;

/** The payload a send of `E` takes. */
export type MessageInput<E extends NetEvent> = z.input<RoomMessages[E]>;
