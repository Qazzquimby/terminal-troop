import "./style.css";
import { NetEvent, Status } from "./config.js";
import {
  createGame,
  handleBye,
  handleCatch,
  handleClonePopped,
  handleFoodEaten,
  handleFoodSpawn,
  handleFoodSync,
  handleHello,
  handleFear,
  handleImpulse,
  handleState,
  handleWallEdit,
  roundSecondsLeft,
  selectClass,
  toggleDummy,
  updateGame,
} from "./game.js";
import { createInput } from "./input.js";
import { buildWorld, getWorldSize } from "./map.js";
import { createAbilityUseDetector, createSfx } from "./audio.js";
import {
  createAbilityHud,
  createClassPicker,
  renderRoundResult,
  renderRoundTimer,
  renderScoreboard,
} from "./hud.js";
import { getRoomCode, joinRoom, leaveRoom, send } from "./net.js";
import { computeStandings, createRankTracker } from "./scoreboard.js";
import { draw } from "./render.js";
import { createCamera, updateCamera } from "./camera.js";

const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const statusEl = document.querySelector("#status");
const nameInput = document.querySelector("#name");
const roomInput = document.querySelector("#room");
const createBtn = document.querySelector("#create");
const joinBtn = document.querySelector("#join");
const copyBtn = document.querySelector("#copy");
const scoreboardEl = document.querySelector("#scoreboard");
const classPickerEl = document.querySelector("#class-picker");
const roundTimerEl = document.querySelector("#round-timer");
const roundBannerEl = document.querySelector("#round-banner");
const abilityHudEl = document.querySelector("#ability-hud");

const initialMapSize = getWorldSize(1);
const world = buildWorld(initialMapSize.cols, initialMapSize.rows);
const camera = createCamera();
const playerId = crypto.randomUUID();
const tracker = createRankTracker();
const net = { send };

let game = null;
let errorText = "";
let lastFrame = performance.now();

const NAME_KEY = "dot-duel:name";

function loadName() {
  return localStorage.getItem(NAME_KEY) || playerId.slice(0, 4).toUpperCase();
}

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function chooseClass(classId) {
  if (game) selectClass(game, classId);
}

const input = createInput(canvas, camera, {
  selectClass: chooseClass,
  toggleDummy() {
    if (game) toggleDummy(game);
  },
});

const updateClassPicker = createClassPicker(classPickerEl, chooseClass);
const updateAbilityHud = createAbilityHud(abilityHudEl);
const detectAbilityUse = createAbilityUseDetector();
const sfx = createSfx();

function announceAbilityUse(player) {
  for (const slot of detectAbilityUse(player)) {
    const event = {
      id: playerId,
      classId: player.classId,
      slot,
      x: player.x,
      y: player.y,
    };
    sfx.playAbility(event, player);
    send(NetEvent.ABILITY, event);
  }
}

function updateStatus() {
  if (errorText) {
    statusEl.textContent = errorText;
    return;
  }
  if (!game) {
    statusEl.textContent = "Create a room to start.";
    return;
  }

  const count = game.players.size;
  const waiting = count === 1 ? " · Waiting for another player…" : "";
  statusEl.textContent = `Room ${getRoomCode()} · ${count} player${count === 1 ? "" : "s"}${waiting}`;
}

async function enterRoom(code) {
  errorText = "";
  await leaveRoom();

  const name = (nameInput.value.trim().slice(0, 8) || loadName().trim().slice(0, 8));
  nameInput.value = name;
  localStorage.setItem(NAME_KEY, name);
  game = createGame(playerId, world, name, sfx);

  await joinRoom(
    code,
    playerId,
    {
      [NetEvent.STATE]: (payload) => handleState(game, payload),
      [NetEvent.HELLO]: () => handleHello(game, net),
      [NetEvent.BYE]: (payload) => handleBye(game, payload),
      [NetEvent.CATCH]: (payload) => handleCatch(game, payload),
      [NetEvent.IMPULSE]: (payload) => handleImpulse(game, payload),
      [NetEvent.FEAR]: (payload) => handleFear(game, payload),
      [NetEvent.CLONE_POPPED]: (payload) => handleClonePopped(game, payload),
      [NetEvent.FOOD_SPAWN]: (payload) => handleFoodSpawn(game, payload),
      [NetEvent.FOOD_EATEN]: (payload) => handleFoodEaten(game, payload),
      [NetEvent.FOOD_SYNC]: (payload) => handleFoodSync(game, payload),
      [NetEvent.WALL_EDIT]: (payload) => handleWallEdit(game, payload),
      [NetEvent.ABILITY]: (payload) => {
        if (payload.id === playerId) return;
        sfx.playAbility(payload, game.players.get(game.localId));
      },
    },
    () => {
      copyBtn.hidden = false;
      send(NetEvent.HELLO, { id: playerId });
    },
  );
}

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  if (game) {
    updateGame(game, input, dt, net);
    const standings = computeStandings(game.players, tracker, game.localId, now);
    renderScoreboard(scoreboardEl, standings);
    renderRoundTimer(roundTimerEl, roundSecondsLeft(game));
    renderRoundResult(roundBannerEl, game.roundResult, now);
    updateCamera(camera, world, game.players.get(game.localId));
    draw(ctx, world, game, now, camera);
  }

  const me = game ? game.players.get(game.localId) : null;
  updateAbilityHud(me);
  if (me) announceAbilityUse(me);
  const choosing = me?.status === Status.CHOOSING;
  const selectedClass = choosing ? null : (me?.nextClassId ?? me?.classId);
  updateClassPicker(Boolean(me), selectedClass);
  updateStatus();
  requestAnimationFrame(frame);
}

createBtn.addEventListener("click", async () => {
  const code = makeRoomCode();
  roomInput.value = code;
  await enterRoom(code);
});

joinBtn.addEventListener("click", async () => {
  await enterRoom(roomInput.value);
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
  copyBtn.textContent = "Copied!";
  setTimeout(() => (copyBtn.textContent = "Copy link"), 1200);
});

nameInput.value = loadName();

const initialRoom = new URLSearchParams(location.search).get("room");
if (initialRoom) {
  roomInput.value = initialRoom;
  await enterRoom(initialRoom)
}

requestAnimationFrame(frame);
