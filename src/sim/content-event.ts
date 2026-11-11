import type { z } from "zod";
import type { Session } from "./session.js";

/**
 * Which clients receive an event:
 * - host: the client hosting, the sender's own included
 * - all: every client, the sender's own included
 * - player: the client of the one player it is sent to
 */
export type EventRoute = "host" | "all" | "player";

/** Whom a client accepts an event from: anyone in the room, or only the player it takes for the host. */
type EventSender = "host" | "any";

/** A kind of network event a content entry sends and receives, typed by its payload `P`. */
export interface ContentEventSpec<P, R extends EventRoute> {
  /**
   * Checks a payload, encodes it for the wire and decodes it back. A payload this rejects is
   * dropped where it arrives.
   */
  readonly schema: z.ZodType<P>;
  /** Which clients receive it. */
  readonly to: R;
  /** Whom a receiving client accepts it from; anyone in the room when left out. */
  readonly from?: EventSender;
  /** Applies the event on a client that receives it, inside its sim step. */
  receive(game: Session, payload: P, sender: string): void;
}

interface EventBase<P, R extends EventRoute> extends ContentEventSpec<P, R> {
  readonly from: EventSender;
}

/** An event for the host or for everyone. */
export interface RoomEvent<P> extends EventBase<P, "host" | "all"> {
  /** Queues `payload` for the room to send. Throws when it does not encode or the event is not registered. */
  send(game: Session, payload: P): void;
}

/** An event for one player. */
export interface PlayerEvent<P> extends EventBase<P, "player"> {
  /** Queues `payload` for the room to send to `target`. Throws when it does not encode or the event is not registered. */
  send(game: Session, target: string, payload: P): void;
}

export type ContentEvent<P> = RoomEvent<P> | PlayerEvent<P>;

/** A content entry's events, by the key each travels under within the entry. */
export type ContentEvents = Readonly<Record<string, ContentEvent<unknown>>>;

/** Where an event is registered: its content entry's name, and its key within the entry. */
export interface EventAddress {
  readonly content: string;
  readonly event: string;
}

/** An event as it travels: its address, its sender, the player it is for, and its encoded payload. */
export interface EventMessage extends EventAddress {
  readonly from: string;
  /** The player a "player" event is for; null for any other. */
  readonly to: string | null;
  readonly payload: unknown;
}

/** An event sent from this client, waiting for the room to route it. */
export interface OutgoingEvent extends EventAddress {
  readonly route: EventRoute;
  readonly to: string | null;
  readonly payload: unknown;
}

/** An event received, waiting for the next sim step. */
export interface Delivery {
  readonly event: ContentEvent<unknown>;
  readonly payload: unknown;
  readonly sender: string;
}

/** A content entry's event, sent through and received from the room, typed by its schema. */
export function contentEvent<P>(
  spec: ContentEventSpec<P, "player">,
): PlayerEvent<P>;
export function contentEvent<P>(
  spec: ContentEventSpec<P, "host" | "all">,
): RoomEvent<P>;
export function contentEvent<P>(
  spec: ContentEventSpec<P, EventRoute>,
): ContentEvent<P> {
  const { schema, to, from = "any" } = spec;
  const queue = (game: Session, target: string | null, payload: P): void => {
    const address = game.eventAddresses.get(event);
    if (address === undefined) throw new Error("Event not registered");
    game.outbox.push({
      ...address,
      route: to,
      to: target,
      payload: schema.encode(payload),
    });
  };
  const receive = (game: Session, payload: P, sender: string): void => {
    spec.receive(game, payload, sender);
  };
  const event: ContentEvent<P> =
    to === "player"
      ? {
          schema,
          to,
          from,
          receive,
          send: (game, target, payload) => {
            queue(game, target, payload);
          },
        }
      : {
          schema,
          to,
          from,
          receive,
          send: (game, payload) => {
            queue(game, null, payload);
          },
        };
  return event;
}

/** Registers each of `events` under the content entry `name`. */
export function registerEvents(
  game: Session,
  name: string,
  events: ContentEvents,
): void {
  for (const [key, event] of Object.entries(events)) {
    if (game.eventAddresses.has(event))
      throw new Error(`Event already registered: ${name}.${key}`);
    game.eventAddresses.set(event, { content: name, event: key });
    const entry =
      game.events.get(name) ?? new Map<string, ContentEvent<unknown>>();
    entry.set(key, event);
    game.events.set(name, entry);
  }
}

/**
 * Queues `message` for the next step, if this client is one it is for and it comes from whom
 * its event accepts: `host` is the player this client takes for the host. A message of an
 * unregistered event, or whose payload its schema rejects, is dropped.
 */
export function receiveEvent(
  game: Session,
  message: EventMessage,
  host: string | undefined,
): void {
  const event = game.events.get(message.content)?.get(message.event);
  if (event === undefined) return;
  if (event.from === "host" && message.from !== host) return;
  if (event.to === "host" && host !== game.localId) return;
  if (event.to === "player" && message.to !== game.localId) return;
  const parsed = event.schema.safeParse(message.payload);
  if (parsed.success)
    game.inbox.push({ event, payload: parsed.data, sender: message.from });
}

/** Applies every event received since the last step, in the order received. */
export function applyEvents(game: Session): void {
  for (const { event, payload, sender } of game.inbox.splice(0))
    event.receive(game, payload, sender);
}
