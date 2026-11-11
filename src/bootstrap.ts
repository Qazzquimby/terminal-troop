import {
  createSimClock,
  heldEmoji,
  remotePlayers,
  renderPosition,
  selectSlot,
  swing,
  updateSession,
} from "./sim/index.js";
import { NetEvent, createCountingTransport } from "./net/index.js";
import type { Session } from "./sim/index.js";
import { createRoom, playerName, randomRoomCode } from "./room/index.js";
import type { RoomState } from "./room/index.js";
import { createInput, actionKeyLabel } from "./input/index.js";
import {
  createInventoryHud,
  createDebugOverlay,
  createMicIndicatorView,
  createSettingsMenu,
  createStatusView,
  menuPeers,
  roomDebugInfo,
  trackInputContext,
  element,
} from "./ui/index.js";
import { draw, createCamera, updateCamera } from "./render/index.js";
import { createSfx } from "./audio/index.js";
import { micIndicator, createNullVoice, pushToTalk } from "./voice/index.js";
import { createPerfStats } from "./perf-stats/index.js";
import type { DebugInfo } from "./ui/index.js";
import type { Settings } from "./settings/index.js";
import { createSettingsStore } from "./settings/index.js";
import type { Transport } from "./net/index.js";
import type { Voice, VoiceSettings } from "./voice/index.js";
import { config } from "./config.js";
import { loadClientEnv } from "./env.js";
import { createSupabaseTransport } from "./adapters/supabase-transport/index.js";
import { createBroadcastChannelTransport } from "./adapters/broadcast-channel-transport/index.js";
import { createWebRtcVoice } from "./adapters/webrtc-voice/index.js";
import { createScope } from "./lib/scope/index.js";
import { createMonsters } from "./monsters/index.js";

/** Owns everything that lives as long as the page. */
const app = createScope();

/** Listens on `target` until the app scope is disposed. */
function on(
  target: EventTarget,
  type: string,
  listener: (event: Event) => void,
): void {
  target.addEventListener(type, listener, { signal: app.signal });
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
const debugEl = element("#debug", HTMLPreElement);
const micEl = element("#mic-indicator", HTMLParagraphElement);
const settingsDialog = element("#settings", HTMLDialogElement);
const settingsBtn = element("#settings-open", HTMLButtonElement);
const controlsHint = element(".controls-hint", HTMLParagraphElement);
const baseHint = controlsHint.textContent.trim();

const context = canvas.getContext("2d");
if (context === null) throw new Error("Canvas 2D context unavailable.");
const ctx = context;

const envResult = loadClientEnv(
  {
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env
      .VITE_SUPABASE_PUBLISHABLE_KEY,
    VITE_WORLD: import.meta.env.VITE_WORLD,
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
    return createBroadcastChannelTransport(NetEvent);
  }
  return createSupabaseTransport(env.supabase.url, env.supabase.publishableKey);
}

/** Incoming voice plays through the sound effects' master gain. */
function selectVoice(initial: VoiceSettings): Voice {
  if (typeof RTCPeerConnection === "undefined") return createNullVoice(initial);
  return createWebRtcVoice(sfx, initial, config.voiceConnections);
}

const params = new URLSearchParams(location.search);
/** `?debug` shows the debug overlay, exposes voice and the room on `window`, and logs voice failures. */
const debug = params.has("debug");
const playerId = crypto.randomUUID();
const defaultName = playerId.slice(0, 4).toUpperCase();
const camera = createCamera(config.view);
const clock = createSimClock(config.sim);
const counted = createCountingTransport(selectTransport(params), () =>
  performance.now(),
);
const transport = counted.transport;
const perf = createPerfStats();
const debugOverlay = createDebugOverlay(debugEl, debug, config.ui);
const micView = createMicIndicatorView(micEl);
const sfx = createSfx(config.audio);
const nameKey = "world:name";
const settingsKey = "terminal-troop:settings";
const settings = createSettingsStore({
  get: () => localStorage.getItem(settingsKey),
  set: (value) => {
    localStorage.setItem(settingsKey, value);
  },
});
const voice = selectVoice(settings.get().voice);

const talkKey = actionKeyLabel("pushToTalk");
element("#voice-mode-ptt-label", HTMLSpanElement).textContent =
  `Push to talk (${talkKey})`;

function applySettings(current: Settings): void {
  sfx.setMasterVolume(current.audio.masterVolume);
  voice.configure(current.voice);
  controlsHint.textContent =
    current.voice.mode === "pushToTalk"
      ? `${baseHint} · ${talkKey} to talk`
      : baseHint;
}
applySettings(settings.get());
app.defer(settings.subscribe(applySettings));
const updateInventory = createInventoryHud(inventoryEl, inventoryList);

let inventoryOpen = false;

const room = createRoom({
  localId: playerId,
  world: env.world,
  transport,
  voice,
  sfx,
  scope: app,
  clock: {
    now: () => performance.now(),
    every(ms, fn) {
      const timer = setInterval(fn, ms);
      return () => {
        clearInterval(timer);
      };
    },
  },
  config: config.room,
  sim: config,
  monsters: createMonsters(config.monsters),
  falloff: config.voice,
  onChange() {
    refreshPeers(room.state());
  },
  onPeerFailed(id) {
    if (debug) console.info("Voice connection failed", id);
  },
});
// Debug hook for driving voice and reading presence from the console or a test browser.
if (debug) Object.assign(window, { voice, room });

/** The session being played, or null outside a room. */
function joinedSession(state: RoomState): Session | null {
  return state.kind === "joined" ? state.session : null;
}

function nonEmpty(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

nameInput.value = nonEmpty(localStorage.getItem(nameKey)) ?? defaultName;

const input = createInput(
  canvas,
  camera,
  config.view,
  {
    toggleInventory: {
      press() {
        if (room.state().kind === "joined") inventoryOpen = !inventoryOpen;
      },
    },
    toggleSettings: {
      press(time) {
        settingsMenu.toggle(time);
      },
    },
    toggleDebug: {
      press() {
        debugOverlay.toggle();
      },
    },
    pushToTalk: pushToTalk(voice),
  },
  "play",
);
const inputContext = trackInputContext("play", input.setContext);
const settingsMenu = createSettingsMenu(
  settingsDialog,
  settings,
  (open, time) => {
    if (open) refreshPeers(room.state());
    inputContext.set(open ? "menu" : "play", time);
  },
  (id, muted) => {
    voice.setPeerMuted(id, muted);
  },
);

/** Whether remote player `id` is away. */
function isAway(id: string): boolean {
  return room.presenceOf(id)?.kind === "away";
}

/** Lists the other players in the room, with their voice mutes, in the settings menu. */
function refreshPeers(state: RoomState): void {
  const session = joinedSession(state);
  const players = session === null ? [] : remotePlayers(session);
  settingsMenu.setPeers(menuPeers(players, voice.status().mutedPeers, isAway));
}
refreshPeers(room.state());

const status = createStatusView({
  status: statusEl,
  create: createBtn,
  join: joinBtn,
  copy: copyBtn,
});

/** Joins `rawCode` under the name in the name field, then points the URL and camera at it. */
async function enterRoom(rawCode: string): Promise<void> {
  const name = playerName(nameInput.value, config.player.nameMax, defaultName);
  const result = await room.join(rawCode, name);
  const state = room.state();
  if (!result.ok) {
    if (state.kind === "joined") status.notice(result.error, state);
    return;
  }
  if (state.kind !== "joined") return;
  nameInput.value = name;
  localStorage.setItem(nameKey, name);
  roomInput.value = state.code;
  inventoryOpen = false;
  const url = new URLSearchParams(location.search);
  url.set("room", state.code);
  history.replaceState({}, "", `${location.pathname}?${url.toString()}`);
  clock.reset(performance.now());
  updateCamera(camera, state.session.local);
}

function debugInfo(): DebugInfo {
  const now = performance.now();
  const session = joinedSession(room.state());
  return {
    perf: perf.snapshot(now),
    room:
      session === null
        ? null
        : roomDebugInfo(session, now, counted.rates(now), room),
  };
}

/**
 * Reads the clock here rather than taking the rAF timestamp: that is the frame start, and key
 * events handled after it carry later times, which would push them a frame late.
 */
function frame(): void {
  const now = performance.now();
  const frameStats = { now, steps: 0, updateMs: 0, drawMs: 0 };

  const session = joinedSession(room.state());
  if (session !== null) {
    const updateStart = performance.now();
    const { steps, alpha } = clock.advance(now, (until) => {
      const { controls, slot } = input.getStep(until);
      if (slot !== undefined) {
        session.local.held = selectSlot(session.local.inventory, slot);
      }
      updateSession(session, controls, clock.dt);
    });
    frameStats.steps = steps;
    frameStats.updateMs = performance.now() - updateStart;
    room.frame(now);
    updateCamera(camera, renderPosition(session.local, alpha));
    const drawStart = performance.now();
    draw(
      ctx,
      session,
      camera,
      now,
      alpha,
      input.mouseWorld(),
      isAway,
      heldEmoji(session.local.inventory, session.local.held),
    );
    frameStats.drawMs = performance.now() - drawStart;
    updateInventory(
      session.local.inventory,
      session.local.held,
      inventoryOpen,
    );
  } else {
    inventoryEl.hidden = true;
    ctx.fillStyle = "#090b0e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  status.show(room.state(), transport.label);
  perf.recordFrame(frameStats);
  debugOverlay.update(now, debugInfo);
  micView.show(session === null ? null : micIndicator(voice.status(), talkKey));
  requestAnimationFrame(frame);
}

on(createBtn, "click", () => {
  voice.requestMic();
  void enterRoom(randomRoomCode(crypto.getRandomValues(new Uint8Array(6))));
});

on(settingsBtn, "click", (event) => {
  settingsMenu.open(event.timeStamp);
});

/** Swing sounds, relative to the public directory. */
const SWING_SOUNDS = {
  hit: "/shovel/hit.mp3",
  miss: "/shovel/miss.mp3",
} as const;

canvas.addEventListener(
  "pointerdown",
  (event) => {
    if (event.button !== 0) return;
    const session = joinedSession(room.state());
    if (session === null) return;
    const result = swing(session, performance.now(), config.swing);
    if (result === null) return;
    sfx
      .play(
        result.hit ? SWING_SOUNDS.hit : SWING_SOUNDS.miss,
        session.local,
        session.local,
        { volume: 0.8 },
      )
      .catch((error: unknown) => {
        if (debug) console.info("Swing sound failed", error);
      });
  },
  { signal: app.signal },
);

on(joinBtn, "click", () => {
  voice.requestMic();
  void enterRoom(roomInput.value);
});

on(copyBtn, "click", () => {
  navigator.clipboard.writeText(location.href).then(
    () => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = "Copy link";
      }, 1200);
    },
    () => {
      status.notice(
        "Clipboard unavailable. Copy the address from your browser.",
        room.state(),
      );
    },
  );
});

on(document, "visibilitychange", () => {
  room.setHidden(document.hidden);
});

// Leaving sends BYE before anything else, while the page can still send.
on(window, "beforeunload", () => {
  void room.leave();
});

requestAnimationFrame(frame);

const initialRoom = params.get("room");
if (initialRoom !== null) void enterRoom(initialRoom);
