export const NetEvent = {
  HELLO: "hello",
  STATE: "state",
  BYE: "bye",
  /** Says the sender is still in the room, and whether its page is hidden. */
  HEARTBEAT: "beat",
  /** The host's entities: all of them, or those changed since its last. */
  ENTITIES: "entities",
  /** The host's world state: all of it, or the entries changed since its last. */
  WORLD: "world",
  /** An event of a content entry's own, for the clients its route reaches. */
  CONTENT: "content",

  /** Voice connection setup: addressed to one player, but broadcast to the room. */
  SIGNAL: "signal",

  /** Several of the others, sent as one broadcast; the batching transport unpacks it. */
  BATCH: "batch",
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

/**
 * For a transport whose members connect to each other some time after joining, so that what a
 * member says on joining can miss those that connect later.
 */
export interface GreetingConfig {
  /** How long after it greets the room a member greets again each member that connects. */
  readonly replayMs: number;
}
