import { z } from "zod";
import type { NetEvent, Transport } from "../../net/index.js";

/**
 * Same-machine transport over the browser's BroadcastChannel: every tab or window of this
 * origin that joins the same room is a player. No server, no latency, no packet loss.
 * `events` lists every room event name; envelopes naming any other event are dropped.
 */
export function createBroadcastChannelTransport(
  events: readonly [NetEvent, ...NetEvent[]],
): Transport {
  const Envelope = z.object({ event: z.enum(events), payload: z.unknown() });
  let channel: BroadcastChannel | null = null;

  function leave(): Promise<void> {
    channel?.close();
    channel = null;
    return Promise.resolve();
  }

  return {
    label: "local",

    async join(room, handlers) {
      await leave();
      const joined = new BroadcastChannel(`terminal-troop:${room}`);
      joined.addEventListener("message", (message: MessageEvent<unknown>) => {
        const parsed = Envelope.safeParse(message.data);
        if (parsed.success) handlers[parsed.data.event]?.(parsed.data.payload);
      });
      channel = joined;
    },

    leave,

    send(event, payload) {
      channel?.postMessage({ event, payload });
      return Promise.resolve();
    },
  };
}
