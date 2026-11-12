import { z } from "zod";
import { NetEvent } from "./transport.js";
import type { Transport } from "./transport.js";

/** The messages of one broadcast, in the order they were sent: each an event and its payload. */
const Batch = z.object({ messages: z.array(z.unknown()) });

const Entry = z.tuple([z.enum(NetEvent), z.unknown()]);

/**
 * The messages a BATCH payload carries, in order. An entry that is not an event and a payload,
 * or that is itself a batch, is left out; a payload that is no batch carries none.
 */
export function unbatch(
  payload: unknown,
): { event: NetEvent; payload: unknown }[] {
  const batch = Batch.safeParse(payload);
  if (!batch.success) return [];
  return batch.data.messages.flatMap((entry) => {
    const parsed = Entry.safeParse(entry);
    if (!parsed.success || parsed.data[0] === NetEvent.BATCH) return [];
    const [event, inner] = parsed.data;
    return [{ event, payload: inner }];
  });
}

export interface BatchingTransport {
  readonly transport: Transport;
  /**
   * Runs `fn`, holding what it sends; once it returns, what was held goes out as one broadcast,
   * a lone message as itself. Calls nest: only the outermost sends. Outside `fn` a send goes out
   * at once.
   */
  readonly batch: <T>(fn: () => T) => T;
}

/**
 * Wraps a transport so a burst of messages costs one broadcast. Receiving, it hands each
 * message of a batch to its event's handler in order, and holds what those handlers send for
 * one broadcast too.
 */
export function createBatchingTransport(inner: Transport): BatchingTransport {
  let depth = 0;
  let held: [NetEvent, unknown][] = [];

  function flush(): void {
    const out = held;
    held = [];
    const [only] = out;
    if (out.length === 1 && only !== undefined) void inner.send(...only);
    else if (out.length > 1) void inner.send(NetEvent.BATCH, { messages: out });
  }

  function batch<T>(fn: () => T): T {
    depth++;
    try {
      return fn();
    } finally {
      depth--;
      if (depth === 0) flush();
    }
  }

  return {
    transport: {
      label: inner.label,
      join: (room, handlers) =>
        inner.join(room, {
          ...handlers,
          [NetEvent.BATCH]: (payload) => {
            batch(() => {
              for (const message of unbatch(payload))
                handlers[message.event]?.(message.payload);
            });
          },
        }),
      leave: () => inner.leave(),
      send(event, payload) {
        if (depth === 0) return inner.send(event, payload);
        held.push([event, payload]);
        return Promise.resolve();
      },
    },
    batch,
  };
}
