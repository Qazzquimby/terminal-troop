import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { createClient, REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { NetEvent } from "./config.js";

export type NetHandlers = Partial<Record<NetEvent, (payload: unknown) => void>>;

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

let supabase: SupabaseClient | null = null;
let channel: RealtimeChannel | null = null;
let roomCode: string | null = null;
let localId: string | null = null;

function ensureSupabase(): SupabaseClient {
  if (SUPABASE_URL === "" || SUPABASE_PUBLISHABLE_KEY === "") {
    throw new Error(
      "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.local and fill them in.",
    );
  }
  supabase ??= createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  return supabase;
}

export function getRoomCode(): string | null {
  return roomCode;
}

export async function leaveRoom(): Promise<void> {
  if (channel !== null && supabase !== null) {
    if (localId !== null) {
      await channel.send({
        type: "broadcast",
        event: NetEvent.BYE,
        payload: { id: localId },
      });
    }
    await supabase.removeChannel(channel);
  }
  channel = null;
  roomCode = null;
  localId = null;
}

export async function joinRoom(
  code: string,
  id: string,
  handlers: NetHandlers,
  onSubscribed: (roomCode: string) => void,
): Promise<void> {
  const client = ensureSupabase();
  await leaveRoom();

  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(normalized)) {
    throw new Error("Room code must be 3–8 letters/numbers.");
  }
  roomCode = normalized;
  localId = id;

  const joinedChannel = client.channel(`world-v1:${normalized}`, {
    config: { broadcast: { self: false } },
  });
  channel = joinedChannel;

  Object.entries(handlers).forEach(([event, handler]) => {
    joinedChannel.on("broadcast", { event }, ({ payload }) => {
      handler(payload);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      joinedChannel.subscribe((status) => {
        if (channel !== joinedChannel) return;
        switch (status) {
          case REALTIME_SUBSCRIBE_STATES.SUBSCRIBED:
            onSubscribed(normalized);
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
    await leaveRoom();
    throw error;
  }

  history.replaceState({}, "", `${location.pathname}?room=${normalized}`);
}

export function send(event: NetEvent, payload: unknown): void {
  if (channel === null) return;
  void channel.send({ type: "broadcast", event, payload });
}

window.addEventListener("beforeunload", () => {
  if (channel === null || localId === null) return;
  void channel.send({
    type: "broadcast",
    event: NetEvent.BYE,
    payload: { id: localId },
  });
});
