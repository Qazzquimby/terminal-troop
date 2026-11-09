import {
  createSession,
  createSimClock,
  receiveState,
  remotePlayers,
  removePlayer,
  roomKey,
  sendState,
  updateSession,
  renderPosition,
} from "./sim/index.js";
import {
  NetEvent,
  PresenceMessage,
  createCountingTransport,
} from "./net/index.js";
import type { Session } from "./sim/index.js";
import { createInput, actionKeyLabel } from "./input/index.js";
import {
  createInventoryHud,
  createDebugOverlay,
  createMicIndicatorView,
  createSettingsMenu,
  menuPeers,
  roomDebugInfo,
  trackInputContext,
  element,
} from "./ui/index.js";
import { draw, createCamera, updateCamera } from "./render/index.js";
import { createSfx } from "./audio/index.js";
import {
  applyProximity,
  micIndicator,
  createNullVoice,
  pushToTalk,
  syncVoicePeers,
} from "./voice/index.js";
import { createPerfStats } from "./perf-stats/index.js";
import type { DebugInfo } from "./ui/index.js";
import type { Settings } from "./settings/index.js";
import { createSettingsStore } from "./settings/index.js";
import type { Transport } from "./net/index.js";
import type { Voice, VoiceRoom, VoiceSettings } from "./voice/index.js";
import { config } from "./config.js";
import { loadClientEnv } from "./env.js";
import { createSupabaseTransport } from "./adapters/supabase-transport/index.js";
import { createBroadcastChannelTransport } from "./adapters/broadcast-channel-transport/index.js";
import { createWebRtcVoice } from "./adapters/webrtc-voice/index.js";
import { createScope } from "./lib/scope/index.js";

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
/** `?debug` shows the debug overlay, exposes voice on `window`, and logs voice failures. */
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
// Debug hook for driving voice from the console or a test browser.
if (debug) Object.assign(window, { voice });

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

let game: Session | null = null;
let roomCode: string | null = null;
let connecting = false;
let inventoryOpen = false;
let errorText = "";
let voiceRoom: VoiceRoom | null = null;
/** The remote players `voiceRoom` was last told to connect to. */
let voicePeers: ReadonlySet<string> = new Set();

/** Points voice at the remote players of `session`; cheap when they are unchanged. */
function syncVoice(session: Session): void {
  if (voiceRoom !== null)
    voicePeers = syncVoicePeers(session, voiceRoom, voicePeers, config.voice);
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
        if (game !== null) inventoryOpen = !inventoryOpen;
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
    if (open) refreshPeers(game);
    inputContext.set(open ? "menu" : "play", time);
  },
  (id, muted) => {
    voice.setPeerMuted(id, muted);
  },
);

/** Lists the other players of `session` in the settings menu, with their voice mutes. */
function refreshPeers(session: Session | null): void {
  const players = session === null ? [] : remotePlayers(session);
  settingsMenu.setPeers(menuPeers(players, voice.status().mutedPeers));
}
refreshPeers(null);

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
  voiceRoom?.leave();
  voiceRoom = null;
  voicePeers = new Set();
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
  refreshPeers(null);
  copyBtn.hidden = true;
  inventoryOpen = false;
  updateStatus();

  try {
    await leaveRoom();

    const name =
      nonEmpty(nameInput.value.trim().slice(0, config.player.nameMax)) ??
      defaultName;
    nameInput.value = name;
    roomInput.value = code;
    localStorage.setItem(nameKey, name);

    const session = createSession(
      playerId,
      name,
      code,
      env.world,
      sfx,
      config,
      {
        playerJoined: () => {
          syncVoice(session);
          refreshPeers(session);
        },
        playerLeft: () => {
          syncVoice(session);
          refreshPeers(session);
        },
      },
    );
    await transport.join(roomKey(code, env.world), {
      [NetEvent.STATE]: (payload) => {
        receiveState(session, payload);
      },
      [NetEvent.HELLO]: () => {
        sendState(session, transport, performance.now(), true);
      },
      [NetEvent.BYE]: (payload) => {
        const parsed = PresenceMessage.safeParse(payload);
        if (!parsed.success) return;
        removePlayer(session, parsed.data.id);
        syncVoice(session);
      },
      [NetEvent.SIGNAL]: (payload) => {
        voiceRoom?.receive(payload);
      },
    });
    voiceRoom = voice.join(
      playerId,
      (signal) => void transport.send(NetEvent.SIGNAL, signal),
      {
        peerFailed(id) {
          if (debug) console.info("Voice connection failed", id);
        },
      },
    );
    syncVoice(session);
    roomCode = code;
    sayHello(session);

    const url = new URLSearchParams(location.search);
    url.set("room", code);
    history.replaceState({}, "", `${location.pathname}?${url.toString()}`);

    game = session;
    clock.reset(performance.now());
    updateCamera(camera, game.local);
    copyBtn.hidden = false;
  } catch (error) {
    errorText = error instanceof Error ? error.message : "Unable to join room.";
  } finally {
    connecting = false;
    updateStatus();
  }
}

function debugInfo(): DebugInfo {
  const now = performance.now();
  const session = game;
  return {
    perf: perf.snapshot(now),
    room:
      session === null ? null : roomDebugInfo(session, now, counted.rates(now)),
  };
}

/**
 * Reads the clock here rather than taking the rAF timestamp: that is the frame start, and key
 * events handled after it carry later times, which would push them a frame late.
 */
function frame(): void {
  const now = performance.now();
  const frameStats = { now, steps: 0, updateMs: 0, drawMs: 0 };

  if (game !== null) {
    const session = game;
    const updateStart = performance.now();
    const { steps, alpha } = clock.advance(now, (until) => {
      updateSession(session, input.getControls(until), clock.dt, until);
    });
    frameStats.steps = steps;
    frameStats.updateMs = performance.now() - updateStart;
    if (voiceRoom !== null) {
      syncVoice(session);
      applyProximity(session, voiceRoom, config.voice);
    }

    sendState(session, transport, now);
    updateCamera(camera, renderPosition(session.local, alpha));
    const drawStart = performance.now();
    draw(ctx, session, camera, now, alpha, input.mouseWorld());
    frameStats.drawMs = performance.now() - drawStart;
    updateInventory(session.local.inventory, inventoryOpen);
  } else {
    inventoryEl.hidden = true;
    ctx.fillStyle = "#090b0e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  updateStatus();
  perf.recordFrame(frameStats);
  debugOverlay.update(now, debugInfo);
  micView.show(game === null ? null : micIndicator(voice.status(), talkKey));
  requestAnimationFrame(frame);
}

on(createBtn, "click", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const code = Array.from(bytes, (value) => (value % 36).toString(36))
    .join("")
    .toUpperCase();
  voice.requestMic();
  void enterRoom(code);
});

on(settingsBtn, "click", (event) => {
  settingsMenu.open(event.timeStamp);
});

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
      errorText = "Clipboard unavailable. Copy the address from your browser.";
    },
  );
});

on(document, "visibilitychange", () => {
  if (!document.hidden && game !== null) sayHello(game);
});

on(window, "beforeunload", () => {
  if (roomCode !== null) void transport.send(NetEvent.BYE, { id: playerId });
});

requestAnimationFrame(frame);

const initialRoom = params.get("room");
if (initialRoom !== null) void enterRoom(initialRoom);
