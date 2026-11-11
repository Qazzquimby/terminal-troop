import { z } from "zod";
import { NetEvent } from "../net/index.js";

const PlayerId = z.string().min(1).max(64);

/**
 * Health: any number from 0 up, Infinity included. JSON has no Infinity, so it travels as the
 * string "Infinity". z.number() rejects NaN and ±Infinity.
 */
export const Health = z.codec(
  z.union([z.number().min(0), z.literal("Infinity")]),
  z.union([z.number().min(0), z.literal(Infinity)]),
  {
    decode: (wire) => (wire === "Infinity" ? Infinity : wire),
    encode: (health) => (health === Infinity ? "Infinity" : health),
  },
);

/** An item's id. The room knows no items, so any well-formed id passes. */
const ItemId = z.string().min(1).max(32);

/**
 * A STATE payload, its name cut to `nameMax` characters when heard, with the id of the item the
 * sender holds, or null for nothing.
 */
function stateMessage(nameMax: number) {
  return z.object({
    id: PlayerId,
    name: z.codec(z.string(), z.string(), {
      decode: (name) => name.slice(0, nameMax),
      encode: (name) => name,
    }),
    x: z.number(),
    y: z.number(),
    aim: z.number(),
    health: Health,
    held: ItemId.nullable(),
  });
}

/** HELLO and BYE carry only the sender's id. */
const PresenceMessage = z.object({ id: PlayerId });

/** Who the sender takes for the host, and the election that chose it. */
const HostView = z.object({
  id: PlayerId,
  term: z.number().int().min(0),
  solo: z.boolean(),
});

/**
 * A heartbeat carries the sender's id, whether its page is hidden, and its host view; null
 * before it has one.
 */
const HeartbeatMessage = PresenceMessage.extend({
  hidden: z.boolean(),
  host: HostView.nullable(),
});

/** Most entities a snapshot carries. */
const MAX_ENTITIES = 256;

/**
 * Every entity the sender hosts, by the sender's id. Each kind parses its own data, so an
 * entity whose data its kind rejects is dropped where it is applied.
 */
const EntitiesMessage = z.object({
  host: PlayerId,
  entities: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        kind: z.number().int().min(1),
        x: z.number(),
        y: z.number(),
        health: Health,
        data: z.unknown(),
      }),
    )
    .max(MAX_ENTITIES),
});

/**
 * A player's item use, sent to the whole room for the host to apply and everyone to hear: who
 * used which item, standing where and facing which way.
 */
const UseMessage = z.object({
  by: PlayerId,
  item: ItemId,
  x: z.number(),
  y: z.number(),
  aim: z.number(),
});

/** Damage the sender, as host, deals to the player `target`. */
const DamageMessage = z.object({
  host: PlayerId,
  target: PlayerId,
  amount: z.number().positive(),
});

/** Every event's payload schema; a missing event fails to compile. */
export function roomMessages(nameMax: number) {
  return {
    [NetEvent.HELLO]: PresenceMessage,
    [NetEvent.STATE]: stateMessage(nameMax),
    [NetEvent.BYE]: PresenceMessage,
    [NetEvent.HEARTBEAT]: HeartbeatMessage,
    [NetEvent.ENTITIES]: EntitiesMessage,
    [NetEvent.USE]: UseMessage,
    [NetEvent.DAMAGE]: DamageMessage,

    // The voice room parses its own signals.
    [NetEvent.SIGNAL]: z.unknown(),
  } as const satisfies Record<NetEvent, z.ZodType>;
}

export type RoomMessages = ReturnType<typeof roomMessages>;

/** The payload of `E` as the room handles it: what a handler receives and a send takes. */
export type Message<E extends NetEvent> = z.output<RoomMessages[E]>;

/** The payload of `E` as it travels, JSON-safe: a send encodes to it, a handler decodes from it. */
export type WireMessage<E extends NetEvent> = z.input<RoomMessages[E]>;
