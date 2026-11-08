import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { createClient, REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import type { Transport } from "../engine/transport.js";

/** Transport over Supabase Realtime broadcast channels. */
export function createSupabaseTransport(
  url: string,
  publishableKey: string,
): Transport {
  let client: SupabaseClient | null = null;
  let channel: RealtimeChannel | null = null;

  async function leave(): Promise<void> {
    if (channel === null || client === null) return;
    const leaving = channel;
    channel = null;
    await client.removeChannel(leaving);
  }

  return {
    label: "online",

    async join(room, handlers) {
      await leave();
      client ??= createClient(url, publishableKey);

      const joined = client.channel(`world-v1:${room}`, {
        config: { broadcast: { self: false } },
      });
      channel = joined;

      Object.entries(handlers).forEach(([event, handler]) => {
        joined.on("broadcast", { event }, ({ payload }) => {
          handler(payload);
        });
      });

      try {
        await new Promise<void>((resolve, reject) => {
          joined.subscribe((status) => {
            if (channel !== joined) return;
            switch (status) {
              case REALTIME_SUBSCRIBE_STATES.SUBSCRIBED:
                resolve();
                return;
              case REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR:
              case REALTIME_SUBSCRIBE_STATES.TIMED_OUT:
              case REALTIME_SUBSCRIBE_STATES.CLOSED:
                reject(new Error(`Room connection failed: ${status}`));
                return;
            }
          });
        });
      } catch (error) {
        await leave();
        throw error;
      }
    },

    leave,

    async send(event, payload) {
      if (channel === null) return;
      await channel.send({ type: "broadcast", event, payload });
    },
  };
}
