import {
  createSimClock,
  drawnLocal,
  isGhost,
  itemName,
  onAir,
  renderPosition,
  remotePlayers,
  sayHere,
  speak,
  updateSession,
  viewOf,
} from "./sim/index.js";
import { NetEvent, carries, createCountingTransport } from "./net/index.js";
import type { CabinCommand, Point, Session } from "./sim/index.js";
import { createRoom, playerName, randomRoomCode } from "./room/index.js";
import type { RoomState } from "./room/index.js";
import {
  aimAhead,
  createInput,
  actionKeyLabel,
  turnMove,
} from "./input/index.js";
import {
  cabinView,
  coinTossPanel,
  controlsHintFor,
  createCabin,
  doorPanel,
  hintMode,
  minimapPanel,
  radioPanel,
  transmitPanel,
  createHud,
  createDebugOverlay,
  createMicIndicatorView,
  createSpawnMenu,
  createSettingsMenu,
  createStatusView,
  menuPeers,
  roomDebugInfo,
  shopPanel,
  storagePanel,
  trackInputContext,
  voiceDebugLines,
  element,
} from "./ui/index.js";
import {
  draw,
  createCamera,
  createMapMemory,
  createFlashes,
  createRipples,
  screenToWorld,
  screenToWorldDirection,
  snapCamera,
  updateCamera,
  createSpectator,
  createZoomFit,
  eyeOf,
  stepSpectator,
  pulledView,
  viewHeading,
} from "./render/index.js";
import type { Eye, Sees } from "./render/index.js";
import { createSfx } from "./audio/index.js";
import { micIndicator, createNullVoice, pushToTalk } from "./voice/index.js";
import { createPerfStats } from "./perf-stats/index.js";
import { createPositionMemory } from "./position-memory/index.js";
import { createPlayerIdentity } from "./identity/index.js";
import type { DebugInfo } from "./ui/index.js";
import type { Settings } from "./settings/index.js";
import { createSettingsStore } from "./settings/index.js";
import type { Transport } from "./net/index.js";
import type { Voice, VoiceSettings } from "./voice/index.js";
import { config } from "./config.js";
import { loadClientEnv } from "./env.js";
import { createSupabaseTransport } from "./adapters/supabase-transport/index.js";
import { createBroadcastChannelTransport } from "./adapters/broadcast-channel-transport/index.js";
import { createTrysteroTransport } from "./adapters/trystero-transport/index.js";
import { createWebRtcVoice } from "./adapters/webrtc-voice/index.js";
import { createSpeechSynth } from "./adapters/speech-synth/index.js";
import { createScope } from "./lib/scope/index.js";
import {
  departingIn,
  entityContent,
  hasEscaped,
  requestSpawn,
  shortOfQuota,
  spawnChoices,
  takesDebugSpawns,
} from "./entities/index.js";
import type { SpawnChoice } from "./entities/index.js";
import { credit, itemContent } from "./items/index.js";
import { moveContent } from "./moves/index.js";
import { createWorldLog, logsWorld } from "./world-log/index.js";

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
const hud = createHud(
  {
    bar: element("#hud", HTMLDivElement),
    slots: element("#hud-slots", HTMLOListElement),
    credit: element("#hud-credit", HTMLSpanElement),
    weight: element("#hud-weight", HTMLSpanElement),
    departure: element("#hud-departure", HTMLSpanElement),
  },
  config.hud,
);
const debugEl = element("#debug", HTMLPreElement);
const debugSpawnEl = element("#debug-spawn", HTMLDivElement);
const micEl = element("#mic-indicator", HTMLParagraphElement);
const settingsDialog = element("#settings", HTMLDialogElement);
const settingsBtn = element("#settings-open", HTMLButtonElement);
const controlsHint = element(".controls-hint", HTMLParagraphElement);
/** What the cabin asked of the vehicle, each run in a step of its own, oldest first. */
const cabinCommands: CabinCommand[] = [];
const sendCabin = (command: CabinCommand): void => {
  cabinCommands.push(command);
};
const cabin = createCabin(element("#cabin", HTMLDivElement), sendCabin);
cabin.addPanel(storagePanel(sendCabin));
cabin.addPanel(coinTossPanel(sendCabin), "finances");
cabin.addPanel(shopPanel(sendCabin), "finances");
/** Whether the cabin's transmit button is held down with the mouse. */
let cabinTransmit = false;
cabin.addPanel(minimapPanel(config.minimap, sendCabin));
cabin.addPanel(
  transmitPanel((held) => {
    cabinTransmit = held;
  }),
);
cabin.addPanel(radioPanel(sendCabin));
cabin.addPanel(doorPanel(sendCabin));

const context = canvas.getContext("2d");
if (context === null) throw new Error("Canvas 2D context unavailable.");
const ctx = context;

const envResult = loadClientEnv(
  {
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env
      .VITE_SUPABASE_PUBLISHABLE_KEY,
    VITE_TRANSPORT: import.meta.env.VITE_TRANSPORT,
    VITE_ICE_SERVERS: import.meta.env.VITE_ICE_SERVERS,
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
 * Online play when Supabase is configured: through Realtime, or over data channels Realtime sets
 * up as `VITE_TRANSPORT` says. Without it, or with `?local` in the URL, rooms run over
 * BroadcastChannel between windows of this browser.
 */
function selectTransport(params: URLSearchParams): Transport {
  if (params.has("local") || env.supabase === null) {
    return createBroadcastChannelTransport(NetEvent);
  }
  const { url, publishableKey } = env.supabase;
  if (env.transport === "trystero")
    return createTrysteroTransport(NetEvent, {
      url,
      publishableKey,
      iceServers: env.iceServers,
      greeting: {
        ...config.greeting,
        greets: (event, payload) => carries(event, payload, NetEvent.HELLO),
        now: () => performance.now(),
      },
    });
  return createSupabaseTransport(url, publishableKey);
}

/** Incoming voice plays through the sound effects' master gain. */
function selectVoice(initial: VoiceSettings): Voice {
  if (typeof RTCPeerConnection === "undefined") return createNullVoice(initial);
  return createWebRtcVoice(
    sfx,
    initial,
    config.voiceConnections,
    config.voiceRadio,
    config.voiceClips,
    config.voiceDetector,
  );
}

const params = new URLSearchParams(location.search);
/** `?debug` shows the debug overlay, exposes voice and the room on `window`, and logs voice failures. */
const debug = params.has("debug");
const playerIdKey = "terminal-troop:player-id";
/** Kept in the page's session storage: a reload is the same player, another tab another one. */
const identity = createPlayerIdentity(
  {
    get: () => sessionStorage.getItem(playerIdKey),
    set: (value) => {
      sessionStorage.setItem(playerIdKey, value);
    },
  },
  () => crypto.randomUUID(),
);
const defaultName = identity.current().slice(0, 4).toUpperCase();
const camera = createCamera(config.view, config.camera);
/** What the local player watches while it is a ghost. */
const spectator = createSpectator();
/** The zoom that fits how far the local view sees, while the camera turns with it. */
const zoomFit = createZoomFit(config.zoomFit);
/** Blurred with `Math.random`: what each player hears is drawn on its own client alone. */
const ripples = createRipples(config.ripples, Math.random);
const flashes = createFlashes(config.flashes);
/** The browser's storage, by key, for what the game remembers between visits. */
const browserStorage = {
  get: (key: string) => localStorage.getItem(key),
  set: (key: string, value: string) => {
    localStorage.setItem(key, value);
  },
  remove: (key: string) => {
    localStorage.removeItem(key);
  },
};
const mapMemory = createMapMemory(config.mapMemory, browserStorage);
const positions = createPositionMemory(config.positionMemory, browserStorage);
const clock = createSimClock(config.sim);
const counted = createCountingTransport(selectTransport(params), () =>
  performance.now(),
);
const transport = counted.transport;
const perf = createPerfStats();
const debugOverlay = createDebugOverlay(debugEl, debug, config.ui);
/** Whether the debug overlay, and the spawn menu with it, is showing. */
let debugShown = debug;
/**
 * Whether this client takes debug spawns while it hosts: in development, under `?debug`, and in
 * production when the config says so. Its spawn menu shows only then; another host may refuse.
 */
const debugSpawns = takesDebugSpawns(
  config.entities.debugSpawn,
  import.meta.env.DEV,
  debug,
);
/** The session the spawn menu last listed the choices of. */
let spawnFrom: Session | null = null;
const spawnMenu = createSpawnMenu<SpawnChoice>(debugSpawnEl, (choice) => {
  if (spawnFrom !== null) requestSpawn(spawnFrom, choice);
});
const micView = createMicIndicatorView(micEl);
const sfx = createSfx(config.audio);
const speech = createSpeechSynth(sfx, config.speechSynth.sampleRate);
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

/** Shows the controls the local player has now; only touches the page when they change. */
function showControlsHint(session: Session | null): void {
  const text = controlsHintFor(
    session === null ? "foot" : hintMode(session.local),
    settings.get().voice.mode === "pushToTalk",
    settings.get().view.rotateCamera,
    input.captured(),
  );
  if (controlsHint.textContent !== text) controlsHint.textContent = text;
  // A turning camera draws the player just above the inventory, where the hint would sit over it.
  controlsHint.classList.toggle("top", settings.get().view.rotateCamera);
}

/**
 * Whether the mouse turns the local view: with the rotating camera on, on foot or as a ghost. In a
 * vehicle the view follows it, and the cabin wants the pointer.
 */
function mouseTurnsView(): boolean {
  const session = joinedSession(room.state());
  return (
    settings.get().view.rotateCamera &&
    session !== null &&
    session.local.ride === null
  );
}

/**
 * The way the local view faces while the camera turns with it, radians: turned by the mouse, or
 * kept to what the view follows. With the rotating camera off it follows the local player's
 * facing, so turning the camera on starts from there.
 */
let heading = -Math.PI / 2;
/** Where a body pulling the local player's gaze last had the turned view; null while none does. */
let pulledTo: number | null = null;

/**
 * The way the turned view faces now: on foot, a body pulling the gaze turns it with the aim, and
 * leaves the heading where it let go. Otherwise the heading.
 */
function holdView(session: Session, rotating: boolean): number {
  if (
    !rotating ||
    eyeOf(spectator, session).kind !== "self" ||
    session.local.ride !== null
  ) {
    pulledTo = null;
    return heading;
  }
  const view = pulledView(session, { heading, held: pulledTo });
  ({ heading, held: pulledTo } = view);
  return view.facing;
}

/** The session drawn last frame, whose local player the turned view aims from. */
let aimFrom: Session | null = null;

function applySettings(current: Settings): void {
  sfx.setMasterVolume(current.audio.masterVolume);
  voice.configure(current.voice);
}
applySettings(settings.get());
app.defer(settings.subscribe(applySettings));

const room = createRoom({
  localId: identity.current(),
  renewId: () => identity.renew(),
  world: env.world,
  transport,
  voice,
  sfx,
  speech,
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
  content: [
    ...entityContent({
      ...config.entities,
      debugSpawn: { ...config.entities.debugSpawn, enabled: debugSpawns },
    }),
    ...itemContent(config.items),
    ...moveContent(config.moves),
  ],
  falloff: config.voice,
  savedPosition: (place) => positions.enter(place),
  onChange() {
    refreshPeers(room.state());
  },
  onPeerFailed(id) {
    if (debug) console.info("Voice connection failed", id);
  },
});
// Debug hook for driving voice, trying speech voices, and reading presence, ripples, flashes, map memory and positions from the console or a test browser.
if (debug)
  Object.assign(window, {
    voice,
    room,
    ripples,
    flashes,
    mapMemory,
    positions,
    /**
     * Has the local player say `text` in the voice `voice` names, on this client alone: for
     * trying voices out. No one else hears it, nor does anything in the world.
     */
    say(text: string, voice = "plain") {
      const session = joinedSession(room.state());
      if (session !== null)
        sayHere(session, session.localId, session.local, { text, voice });
    },
  });
/**
 * What happens in the world, printed to the console and read from it as `window.log`: on in
 * development and under `?debug`, and in production when the config says so.
 */
const worldLog = logsWorld(config.worldLog, import.meta.env.DEV, debug)
  ? createWorldLog(config.worldLog)
  : null;
if (worldLog !== null) Object.assign(window, { log: worldLog });

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
  // With the rotating camera on, the mouse turns the view rather than pointing: the aim is
  // straight ahead.
  (point) =>
    settings.get().view.rotateCamera && aimFrom !== null
      ? aimAhead(aimFrom.local, heading)
      : screenToWorld(camera, point),
  config.view,
  config.wheel,
  config.turn,
  {
    toggleSettings: {
      press(time) {
        settingsMenu.toggle(time);
      },
    },
    toggleDebug: {
      press() {
        debugOverlay.toggle();
        debugShown = !debugShown;
      },
    },
    pushToTalk: pushToTalk(voice),
  },
  "play",
);
const inputContext = trackInputContext("play", input.setContext);
const settingsMenu = createSettingsMenu(settingsDialog, settings, {
  onOpenChange(open, time) {
    if (open) refreshPeers(room.state());
    inputContext.set(open ? "menu" : "play", time);
    // Closing settings is a press, so the browser lets the mouse be captured again at once,
    // rather than waiting for a click on the game.
    if (!open && mouseTurnsView()) input.requestCapture();
  },
  onPeerMutedChange(id, muted) {
    voice.setPeerMuted(id, muted);
  },
  onPeerRetry(id) {
    voice.retry(id);
  },
  onRequestMic() {
    voice.requestMic();
  },
  onMicTest(on) {
    voice.setMicTest(on);
  },
});

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
  const url = new URLSearchParams(location.search);
  url.set("room", state.code);
  history.replaceState({}, "", `${location.pathname}?${url.toString()}`);
  clock.reset(performance.now());
  ripples.clear();
  flashes.clear();
  mapMemory.enter(
    { room: state.code, world: env.world, seed: state.session.seed },
    state.session.world.map,
  );
  snapCamera(camera, state.session.local);
}

/** Shows the spawn menu with the debug overlay, in a room, listing what `session` can spawn. */
function showSpawnMenu(session: Session | null): void {
  const visible = debugSpawns && debugShown && session !== null;
  spawnMenu.setVisible(visible);
  if (!visible || session === spawnFrom) return;
  spawnFrom = session;
  spawnMenu.setChoices(spawnChoices(session));
}

function debugInfo(): DebugInfo {
  const now = performance.now();
  const session = joinedSession(room.state());
  const nameOf = (id: string): string =>
    session?.players.get(id)?.name ?? id.slice(0, 8);
  return {
    perf: perf.snapshot(now),
    room:
      session === null
        ? null
        : roomDebugInfo(session, now, counted.rates(now), room),
    voice: voiceDebugLines(voice.diagnostics(), nameOf, now),
  };
}

/** Where the camera centres for `eye`, `alpha` of the way into the next step. */
function eyeTarget(session: Session, eye: Eye, alpha: number): Point {
  switch (eye.kind) {
    case "self":
      return drawnLocal(session, alpha);
    case "watch":
      return renderPosition(eye.player, alpha);
    case "free":
      return eye.at;
  }
}

/**
 * What shows on the screen for `eye`, by the one test the renderer draws by (#457): what the
 * watched body, or the local one, sees and has lit. A free ghost's eye shows all the map in sight.
 */
function eyeSees(session: Session, eye: Eye): Sees {
  if (eye.kind === "free") return () => true;
  const viewer = eye.kind === "watch" ? eye.player : session.local;
  return viewOf(session, viewer).sees;
}

/** When the last frame ran, on the `performance.now()` clock. */
let lastFrame = performance.now();

/**
 * Reads the clock here rather than taking the rAF timestamp: that is the frame start, and key
 * events handled after it carry later times, which would push them a frame late.
 */
function frame(): void {
  const now = performance.now();
  const frameSeconds = (now - lastFrame) / 1000;
  lastFrame = now;
  const frameStats = { now, steps: 0, updateMs: 0, drawMs: 0 };

  const session = joinedSession(room.state());
  aimFrom = session;
  const { rotateCamera: rotating, mouseSensitivity } = settings.get().view;
  // The mouse's movement turns the view, and a free pointer held at the game's side keeps turning
  // it, so it never sticks at the edge.
  const turn =
    (input.takeTurn() * config.turn.sensitivity +
      input.edgePush() * config.turn.edge.rate * frameSeconds) *
    mouseSensitivity;
  if (session !== null) {
    heading = rotating
      ? viewHeading(heading, eyeOf(spectator, session), session.local, turn)
      : session.local.aim;
    // A pull let go since the last frame leaves the heading where it was, before the steps aim.
    holdView(session, rotating);
    // The mouse is captured to turn the view on foot or as a ghost; in a vehicle the view follows
    // it, and the cabin wants the pointer.
    input.setCapture(mouseTurnsView() && !settingsDialog.open);
    // On foot or through a free camera, the keys steer as the screen shows the world: up the
    // screen is ahead. A vehicle's keys work its pedals and wheel, turned or not.
    const steerOnScreen = rotating && session.local.ride === null;
    const updateStart = performance.now();
    const { steps, alpha } = clock.advance(now, (until) => {
      speak(session, voice.speakingLevel());
      const held = input.getControls(until);
      const controls = {
        ...held,
        move: steerOnScreen
          ? turnMove(
              held.move,
              (direction) => screenToWorldDirection(camera, direction),
              config.turn.directions,
            )
          : held.move,
        cabin: cabinCommands.shift() ?? null,
        transmit: held.transmit === true || cabinTransmit,
      };
      updateSession(session, controls, clock.dt);
      worldLog?.observe(session);
      stepSpectator(spectator, session, controls, clock.dt, config.spectate);
      // Talking into a walkie talkie sends the mic out whatever the voice settings.
      voice.setKeyed(onAir.get(session.local));
      ripples.hear(session, until);
      flashes.see(session, until);
    });
    frameStats.steps = steps;
    frameStats.updateMs = performance.now() - updateStart;
    room.frame(now);
    const eye = eyeOf(spectator, session);
    if (rotating) heading = viewHeading(heading, eye, session.local, 0);
    const facing = holdView(session, rotating);
    const target = eyeTarget(session, eye, alpha);
    // The zoom fits how far the eye sees, and a ghost's wheel zoom multiplies with it.
    const fitted = zoomFit.step(
      camera,
      session.world.map,
      target,
      frameSeconds,
      rotating,
      () => eyeSees(session, eye),
    );
    updateCamera(
      camera,
      target,
      frameSeconds,
      fitted * spectator.zoom,
      rotating ? facing : null,
    );
    const drawStart = performance.now();
    draw(
      ctx,
      session,
      camera,
      now,
      alpha,
      input.mouseWorld(),
      isAway,
      flashes,
      ripples,
      mapMemory,
      eye,
    );
    mapMemory.save(now);
    if (!isGhost(session.local)) positions.save(session.local, now);
    frameStats.drawMs = performance.now() - drawStart;
    hud.show({
      inventory: session.local.inventory.map((item) =>
        item === null ? null : { ...item, name: itemName(session, item) },
      ),
      held: session.local.held,
      credit: credit.get(session),
      quota: config.entities.cruiser.escape.quota,
      shortOfQuota: shortOfQuota(session, config.entities.cruiser.escape.quota),
      escaped: hasEscaped(session, session.local),
      departingIn: departingIn(session, config.entities.cruiser.escape.delay),
    });
    cabin.show(cabinView(session), session);
  } else {
    input.setCapture(false);
    hud.show(null);
    cabin.show(null, null);
    cabinCommands.length = 0;
    voice.setKeyed(false);
    ctx.fillStyle = "#090b0e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  showControlsHint(session);
  status.show(room.state(), transport.label);
  perf.recordFrame(frameStats);
  debugOverlay.update(now, debugInfo);
  showSpawnMenu(session);
  settingsMenu.showVoice(now, () => voice.diagnostics());
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
  if (document.hidden) {
    mapMemory.flush();
    positions.flush();
  }
});

// Leaving sends BYE before anything else, while the page can still send.
on(window, "beforeunload", () => {
  void room.leave();
  mapMemory.flush();
  positions.flush();
});

requestAnimationFrame(frame);

const initialRoom = params.get("room");
if (initialRoom !== null) void enterRoom(initialRoom);
