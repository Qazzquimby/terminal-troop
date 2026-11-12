import { z } from "zod";
import { NetEvent } from "../net/index.js";
import { rounded } from "../sim/index.js";

const PlayerId = z.string().min(1).max(64);

/**
 * A position in the world, to a tenth of a pixel. Wall faces and body sizes are whole pixels,
 * so rounding never carries a body that is clear of every wall into one.
 */
const Coordinate = rounded(1);

/** A facing in radians, to a hundredth. */
const Angle = rounded(2);

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

/**
 * A STATE payload, its name cut to `nameMax` characters when heard. `content` holds each content
 * entry's state for the sender by the entry's name; each entry parses its own, so a value its
 * entry rejects, or of an entry this client lacks, is dropped where it is applied.
 */
function stateMessage(nameMax: number) {
  return z.object({
    id: PlayerId,
    name: z.codec(z.string(), z.string(), {
      decode: (name) => name.slice(0, nameMax),
      encode: (name) => name,
    }),
    x: Coordinate,
    y: Coordinate,
    aim: Angle,
    health: Health,
    content: z.record(z.string(), z.unknown()),
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

/** Most entities a snapshot carries, and most ids it says are gone. */
const MAX_ENTITIES = 4096;

const EntityId = z.string().min(1).max(80);

/** An entity whole: as a full snapshot carries each, and any other each new one. */
const EntityEntry = z.object({
  id: EntityId,
  kind: z.number().int().min(1),
  x: Coordinate,
  y: Coordinate,
  health: Health,
  data: z.unknown(),
});

/** What changed of an entity since the sender's last snapshot: only the fields that did. */
const EntityChange = z.object({
  id: EntityId,
  x: Coordinate.optional(),
  y: Coordinate.optional(),
  health: Health.optional(),
  data: z.unknown().optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The entities the sender hosts, by the sender's id; who spawned its world's starting entities;
 * and the time on its world's clock, to a hundredth of a second. A full snapshot carries every
 * entity whole; any other the entities new since the sender's last, what changed of the others,
 * and the ids of those gone. Each kind parses its own data, so an entity its kind rejects is
 * dropped where it is applied.
 */
const EntitiesMessage = z.object({
  host: PlayerId,
  origin: PlayerId,
  full: z.boolean(),
  time: rounded(2),
  entities: z.array(EntityEntry).max(MAX_ENTITIES),
  changed: z.array(EntityChange).max(MAX_ENTITIES),
  removed: z.array(EntityId).max(MAX_ENTITIES),
});

/**
 * The world state the sender hosts, by the sender's id and the term of the election that chose
 * it: each entry's `[version, value]` by the entry's name, all of them or those changed since the
 * sender's last. Each entry parses its own, so one malformed or rejected is dropped where it is
 * applied.
 */
const WorldMessage = z.object({
  host: PlayerId,
  term: z.number().int().min(0),
  entries: z.record(z.string(), z.unknown()),
});

/** `entry` as it arrives: positions rounded as they travel. */
export const asSent = (
  entry: z.output<typeof EntityEntry>,
): z.output<typeof EntityEntry> =>
  EntityEntry.decode(EntityEntry.encode(entry));

/** A content entry's name, or an event's key within its entry. */
const ContentKey = z.string().min(1).max(64);

/**
 * A content entry's event: the sender's id, the player it is for (null unless it is for one
 * player), the entry's name, the event's key and its payload. The event's own schema parses the
 * payload, so one it rejects, or of an event this client lacks, is dropped where it is received.
 */
const ContentMessage = z.object({
  from: PlayerId,
  to: PlayerId.nullable(),
  content: ContentKey,
  event: ContentKey,
  payload: z.unknown(),
});

/** Every event's payload schema; a missing event fails to compile. */
export function roomMessages(nameMax: number) {
  return {
    [NetEvent.HELLO]: PresenceMessage,
    [NetEvent.STATE]: stateMessage(nameMax),
    [NetEvent.BYE]: PresenceMessage,
    [NetEvent.HEARTBEAT]: HeartbeatMessage,
    [NetEvent.ENTITIES]: EntitiesMessage,
    [NetEvent.WORLD]: WorldMessage,
    [NetEvent.CONTENT]: ContentMessage,

    // The voice room parses its own signals.
    [NetEvent.SIGNAL]: z.unknown(),
    // The batching transport unpacks batches before the room sees them.
    [NetEvent.BATCH]: z.unknown(),
  } as const satisfies Record<NetEvent, z.ZodType>;
}

export type RoomMessages = ReturnType<typeof roomMessages>;

/** The payload of `E` as the room handles it: what a handler receives and a send takes. */
export type Message<E extends NetEvent> = z.output<RoomMessages[E]>;

/** The payload of `E` as it travels, JSON-safe: a send encodes to it, a handler decodes from it. */
export type WireMessage<E extends NetEvent> = z.input<RoomMessages[E]>;
