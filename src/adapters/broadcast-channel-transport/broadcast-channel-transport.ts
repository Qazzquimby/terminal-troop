import { z } from "zod";
import type { Transport } from "../../net/index.js";

const Envelope = z.object({ event: z.string(), payload: z.unknown() });

/**
 * Same-machine transport over the browser's BroadcastChannel: every tab or window of this
 * origin that joins the same room is a player. No server, no latency, no packet loss.
 */
export function createBroadcastChannelTransport(): Transport {
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
        if (!parsed.success) return;
        const { event, payload } = parsed.data;
        for (const [name, handle] of Object.entries(handlers)) {
          if (name === event) handle(payload);
        }
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
