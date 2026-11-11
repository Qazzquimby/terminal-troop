export const NetEvent = {
  HELLO: "hello",
  STATE: "state",
  BYE: "bye",
  /** Says the sender is still in the room, and whether its page is hidden. */
  HEARTBEAT: "beat",
  /** The host's full set of entities. */
  ENTITIES: "entities",
  /** An event of a content entry's own, for the clients its route reaches. */
  CONTENT: "content",

  /** Voice connection setup: addressed to one player, but broadcast to the room. */
  SIGNAL: "signal",
} as const;
export type NetEvent = (typeof NetEvent)[keyof typeof NetEvent];

type NetHandlers = Partial<Record<NetEvent, (payload: unknown) => void>>;

/**
 * Port for room messaging. A transport broadcasts to every other member of the room it
 * joined and never echoes a message back to its sender. Payloads arrive unparsed.
 */
export interface Transport {
  /** Human-readable name shown in the status line. */
  readonly label: string;
  /** Leaves any current room first. Resolves once messages can flow. */
  join: (room: string, handlers: NetHandlers) => Promise<void>;
  leave: () => Promise<void>;
  /** No-op when not in a room. */
  send: (event: NetEvent, payload: unknown) => Promise<void>;
}
