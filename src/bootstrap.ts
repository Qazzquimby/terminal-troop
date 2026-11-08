import "./engine/style.css";
import {
  FIXED_DT,
  MAX_FRAME_S,
  NetEvent,
  PLAYER_NAME_MAX,
} from "./engine/config.js";
import type { Session } from "./engine/session.js";
import {
  createSession,
  receiveState,
  sendState,
  updateSession,
} from "./engine/session.js";
import { PresenceMessage } from "./engine/protocol.js";
import { createInput } from "./engine/input.js";
import { createInventoryHud } from "./engine/hud.js";
import { draw } from "./engine/render.js";
import { createCamera, updateCamera } from "./engine/camera.js";
import { createSfx } from "./engine/audio.js";
import type { Transport } from "./engine/transport.js";
import { loadClientEnv } from "./env.js";
import { createSupabaseTransport } from "./adapters/supabase-transport.js";
import { createBroadcastChannelTransport } from "./adapters/broadcast-channel-transport.js";

function element<T extends HTMLElement>(
  selector: string,
  type: new () => T,
): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type))
    throw new Error(`Missing ${type.name} ${selector}`);
  return found;
}

const canvas = element("#game", HTMLCanvasElement);
const statusEl = element("#status", HTMLParagraphElement);
const nameInput = element("#name", HTMLInputElement);
const roomInput = element("#room", HTMLInputElement);
const createBtn = element("#create", HTMLButtonElement);
const joinBtn = element("#join", HTMLButtonElement);
const copyBtn = element("#copy", HTMLButtonElement);
const inventoryEl = element("#inventory", HTMLElement);
const inventoryList = element("#inventory-slots", HTMLOListElement);

const context = canvas.getContext("2d");
if (context === null) throw new Error("Canvas 2D context unavailable.");
const ctx = context;

const envResult = loadClientEnv(
  {
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env
      .VITE_SUPABASE_PUBLISHABLE_KEY,
  },
  import.meta.env.PROD ? "production" : "development",
);
if (!envResult.success) {
  statusEl.textContent = envResult.error.message;
  throw envResult.error;
}
const env = envResult.data;

/**
 * Online play when Supabase is configured. Without it, or with `?local` in the URL, rooms run
 * over BroadcastChannel between windows of this browser.
 */
function selectTransport(params: URLSearchParams): Transport {
  if (params.has("local") || env.supabase === null) {
    return createBroadcastChannelTransport();
  }
  return createSupabaseTransport(env.supabase.url, env.supabase.publishableKey);
}

const playerId = crypto.randomUUID();
const defaultName = playerId.slice(0, 4).toUpperCase();
const camera = createCamera();
const transport = selectTransport(new URLSearchParams(location.search));
const sfx = createSfx();
const nameKey = "world:name";
const updateInventory = createInventoryHud(inventoryEl, inventoryList);

let game: Session | null = null;
let roomCode: string | null = null;
let connecting = false;
let inventoryOpen = false;
let errorText = "";
let lastFrame = performance.now();
let accumulator = 0;

function nonEmpty(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

nameInput.value = nonEmpty(localStorage.getItem(nameKey)) ?? defaultName;

const input = createInput(canvas, camera, {
  toggleInventory() {
    if (game !== null) inventoryOpen = !inventoryOpen;
  },
});

function updateStatus(): void {
  createBtn.disabled = connecting;
  joinBtn.disabled = connecting;

  if (errorText !== "") {
    statusEl.textContent = errorText;
  } else if (connecting) {
    statusEl.textContent = "Connecting…";
  } else if (game !== null) {
    const count = game.players.size;
    statusEl.textContent = `Room ${roomCode ?? "?"} (${transport.label}) · ${String(count)} player${count === 1 ? "" : "s"}`;
  } else {
    statusEl.textContent = "Create or join a room to start.";
  }
}

function sayHello(session: Session): void {
  void transport.send(NetEvent.HELLO, { id: playerId });
  sendState(session, transport, performance.now(), true);
}

async function leaveRoom(): Promise<void> {
  if (roomCode !== null) await transport.send(NetEvent.BYE, { id: playerId });
  roomCode = null;
  await transport.leave();
}

async function enterRoom(rawCode: string): Promise<void> {
  if (connecting) return;

  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(code)) {
    errorText = "Room code must be 3–8 letters/numbers.";
    return;
  }

  connecting = true;
  errorText = "";
  sfx.stopAll();
  game = null;
  copyBtn.hidden = true;
  inventoryOpen = false;
  accumulator = 0;
  updateStatus();

  try {
    await leaveRoom();

    const name =
      nonEmpty(nameInput.value.trim().slice(0, PLAYER_NAME_MAX)) ?? defaultName;
    nameInput.value = name;
    roomInput.value = code;
    localStorage.setItem(nameKey, name);

    const session = createSession(playerId, name, code, sfx);
    await transport.join(code, {
      [NetEvent.STATE]: (payload) => {
        receiveState(session, payload);
      },
      [NetEvent.HELLO]: () => {
        sendState(session, transport, performance.now(), true);
      },
      [NetEvent.BYE]: (payload) => {
        const parsed = PresenceMessage.safeParse(payload);
        if (parsed.success && parsed.data.id !== playerId)
          session.players.delete(parsed.data.id);
      },
    });
    roomCode = code;
    sayHello(session);

    const params = new URLSearchParams(location.search);
    params.set("room", code);
    history.replaceState({}, "", `${location.pathname}?${params.toString()}`);

    game = session;
    updateCamera(camera, game.local);
    copyBtn.hidden = false;
  } catch (error) {
    errorText = error instanceof Error ? error.message : "Unable to join room.";
  } finally {
    connecting = false;
    lastFrame = performance.now();
    updateStatus();
  }
}

function frame(now: number): void {
  const elapsed = Math.min((now - lastFrame) / 1000, MAX_FRAME_S);
  lastFrame = now;

  if (game !== null) {
    accumulator += elapsed;
    while (accumulator >= FIXED_DT) {
      updateSession(game, input.getControls(), FIXED_DT, now);
      updateCamera(camera, game.local);
      accumulator -= FIXED_DT;
    }

    sendState(game, transport, now);
    draw(ctx, game, camera, now);
    updateInventory(game.local.inventory, inventoryOpen);
  } else {
    inventoryEl.hidden = true;
    ctx.fillStyle = "#090b0e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  updateStatus();
  requestAnimationFrame(frame);
}

createBtn.addEventListener("click", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const code = Array.from(bytes, (value) => (value % 36).toString(36))
    .join("")
    .toUpperCase();
  void enterRoom(code);
});

joinBtn.addEventListener("click", () => {
  void enterRoom(roomInput.value);
});

copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(location.href).then(
    () => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = "Copy link";
      }, 1200);
    },
    () => {
      errorText = "Clipboard unavailable. Copy the address from your browser.";
    },
  );
});

document.addEventListener("visibilitychange", () => {
  accumulator = 0;
  lastFrame = performance.now();
  if (game !== null && !document.hidden) sayHello(game);
});

window.addEventListener("beforeunload", () => {
  if (roomCode !== null) void transport.send(NetEvent.BYE, { id: playerId });
});

requestAnimationFrame(frame);

const initialRoom = new URLSearchParams(location.search).get("room");
if (initialRoom !== null) void enterRoom(initialRoom);
