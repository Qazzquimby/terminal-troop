import type { NetEvent } from "./config.js";

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
