import { createClient } from "@supabase/supabase-js";
import { NetEvent } from "./config.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

let supabase = null;
let channel = null;
let roomCode = null;
let localId = null;

function ensureSupabase() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.local and fill them in.");
  }
  if (!supabase) supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
}

export function getRoomCode() {
  return roomCode;
}

export async function leaveRoom() {
  if (channel && supabase) {
    if (localId) {
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
}

export async function joinRoom(code, id, handlers, onSubscribed) {
  ensureSupabase();
  await leaveRoom();

  roomCode = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(roomCode)) {
    throw new Error("Room code must be 3–8 letters/numbers.");
  }
  localId = id;

  channel = supabase.channel(`dot-duel:${roomCode}`, {
    config: { broadcast: { self: false } },
  });

  for (const [event, handler] of Object.entries(handlers)) {
    channel.on("broadcast", { event }, ({ payload }) => handler(payload));
  }

  await channel.subscribe((status) => {
    if (status === "SUBSCRIBED") onSubscribed(roomCode);
  });

  history.replaceState({}, "", `${location.pathname}?room=${roomCode}`);
}

export function send(event, payload) {
  if (!channel) return;
  channel.send({ type: "broadcast", event, payload });
}

window.addEventListener("beforeunload", () => {
  if (!channel || !localId) return;
  channel.send({ type: "broadcast", event: NetEvent.BYE, payload: { id: localId } });
});
