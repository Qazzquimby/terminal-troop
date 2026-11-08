import "./engine/style.css";
import {
  FIXED_DT,
  MAX_FRAME_S,
  NetEvent,
} from "./engine/config.js";
import {
  createSession,
  receiveState,
  sendState,
  updateSession,
} from "./engine/session.js";
import { createInput } from "./engine/input.js";
import { createInventoryHud } from "./engine/hud.js";
import { draw } from "./engine/render.js";
import { createCamera, updateCamera } from "./engine/camera.js";
import { getRoomCode, joinRoom, leaveRoom, send } from "./engine/net.js";
import { createSfx } from "./engine/audio.js";

const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector("#game"));
const ctx = canvas.getContext("2d");
const statusEl = document.querySelector("#status");
const nameInput = /** @type {HTMLInputElement} */ (document.querySelector("#name"));
const roomInput = /** @type {HTMLInputElement} */ (document.querySelector("#room"));
const createBtn = /** @type {HTMLButtonElement} */ (document.querySelector("#create"));
const joinBtn = /** @type {HTMLButtonElement} */ (document.querySelector("#join"));
const copyBtn = /** @type {HTMLButtonElement} */ (document.querySelector("#copy"));
const inventoryEl = /** @type {HTMLElement} */ (document.querySelector("#inventory"));
const inventoryList = document.querySelector("#inventory-slots");

const playerId = crypto.randomUUID();
const camera = createCamera();
const net = { send };
const sfx = createSfx();
const nameKey = "world:name";
const updateInventory = createInventoryHud(inventoryEl, inventoryList);

let game = null;
let connecting = false;
let inventoryOpen = false;
let errorText = "";
let lastFrame = performance.now();
let accumulator = 0;

nameInput.value = localStorage.getItem(nameKey)
  || playerId.slice(0, 4).toUpperCase();

const input = createInput(canvas, camera, {
  toggleInventory() {
    if (game) inventoryOpen = !inventoryOpen;
  },
});

function updateStatus() {
  createBtn.disabled = connecting;
  joinBtn.disabled = connecting;

  if (errorText) {
    statusEl.textContent = errorText;
  } else if (connecting) {
    statusEl.textContent = "Connecting…";
  } else if (game) {
    const count = game.players.size;
    statusEl.textContent = `Room ${getRoomCode()} · ${count} player${count === 1 ? "" : "s"}`;
  } else {
    statusEl.textContent = "Create or join a room to start.";
  }
}

async function enterRoom(rawCode) {
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

    const name = nameInput.value.trim().slice(0, 8)
      || playerId.slice(0, 4).toUpperCase();
    nameInput.value = name;
    roomInput.value = code;
    localStorage.setItem(nameKey, name);

    const session = createSession(playerId, name, code, sfx);
    await joinRoom(code, playerId, {
      [NetEvent.STATE]: (state) => receiveState(session, state),
      [NetEvent.HELLO]: () => sendState(session, net, performance.now(), true),
      [NetEvent.BYE]: (state) => {
        if (state?.id !== playerId) session.players.delete(state?.id);
      },
    }, () => {
      send(NetEvent.HELLO, { id: playerId });
      sendState(session, net, performance.now(), true);
    });

    game = session;
    updateCamera(camera, game.players.get(playerId));
    copyBtn.hidden = false;
  } catch (error) {
    errorText = error instanceof Error ? error.message : "Unable to join room.";
  } finally {
    connecting = false;
    lastFrame = performance.now();
    updateStatus();
  }
}

function frame(now) {
  const elapsed = Math.min((now - lastFrame) / 1000, MAX_FRAME_S);
  lastFrame = now;

  if (game) {
    accumulator += elapsed;
    while (accumulator >= FIXED_DT) {
      const controls = input.getControls();
      updateSession(game, controls, FIXED_DT, now);
      updateCamera(camera, game.players.get(playerId));
      accumulator -= FIXED_DT;
    }

    sendState(game, net, now);
    draw(ctx, game, camera, now);
    updateInventory(game.players.get(playerId).inventory, inventoryOpen);
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

joinBtn.addEventListener("click", () => void enterRoom(roomInput.value));

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy link"; }, 1200);
  } catch {
    errorText = "Clipboard unavailable. Copy the address from your browser.";
  }
});

document.addEventListener("visibilitychange", () => {
  accumulator = 0;
  lastFrame = performance.now();
  if (game && !document.hidden) {
    send(NetEvent.HELLO, { id: playerId });
    sendState(game, net, performance.now(), true);
  }
});

requestAnimationFrame(frame);

const initialRoom = new URLSearchParams(location.search).get("room");
if (initialRoom) void enterRoom(initialRoom);
