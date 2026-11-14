import type { SpatialFalloff } from "./audio/index.js";
import type { EntitiesConfig } from "./entities/index.js";
import type {
  CameraConfig,
  FlashConfig,
  MapMemoryConfig,
  RippleConfig,
} from "./render/index.js";
import type { PositionMemoryConfig } from "./position-memory/index.js";
import type { RoomConfig } from "./room/index.js";
import type { SimClockConfig, SimConfig } from "./sim/index.js";
import type { ItemsConfig } from "./items/index.js";
import type { MovesConfig } from "./moves/index.js";
import type { GreetingConfig } from "./net/index.js";
import type { HudConfig, UiConfig } from "./ui/index.js";

import type { VoiceConnectionConfig, VoiceFalloff } from "./voice/index.js";

/** Every tunable, grouped by concern; each group has the shape its module declares. */
interface AppConfig extends SimConfig {
  readonly sim: SimClockConfig;
  readonly room: RoomConfig;
  /** For transports whose peers connect some time after joining. */
  readonly greeting: GreetingConfig;
  readonly camera: CameraConfig;
  readonly ripples: RippleConfig;
  readonly flashes: FlashConfig;
  readonly mapMemory: MapMemoryConfig;
  readonly positionMemory: PositionMemoryConfig;
  readonly entities: EntitiesConfig;
  readonly items: ItemsConfig;
  readonly moves: MovesConfig;
  readonly voice: VoiceFalloff;
  readonly voiceConnections: VoiceConnectionConfig;
  readonly audio: SpatialFalloff;
  readonly ui: UiConfig;
  readonly hud: HudConfig;
}

const CELL = 50;
const STAMINA_MAX = 100;

export const config = {
  // A road 8 to 24 cells wide meanders left to right, bending every 16 columns by up to 8 rows,
  // with 3 to 7 cells of yard either side: clutter by a tenth of the tries by the road, nine
  // tenths at the yard's far edge. Past it, buildings of 3x3 to 9x9 rooms, a fifth of cuts laying a
  // 2-wide hallway up to 16 long, doors 1 to 3 wide; a third of the spare ways get doors too, so
  // routes loop. The start is the road's first 6 columns, the exit its last 8.
  world: {
    cell: CELL,
    cols: 140,
    rows: 80,
    seed: 1,
    wallBounce: 0,
    generation: {
      road: { width: { min: 8, max: 24 }, step: 16, meander: 8, margin: 18 },
      yard: {
        depth: { min: 3, max: 7 },
        clutter: { near: 0.1, far: 0.9 },
        tries: 0.6,
      },
      rooms: {
        size: { min: 3, max: 9 },
        minCells: 6,
        solidChance: 0.3,
        hallwayChance: 0.2,
        hallway: { width: 2, length: 16 },
        door: { min: 1, max: 3 },
        loops: 0.35,
      },
      // Monsters spawn, and loot is richer, up to 4x by distance from the road and 4x towards the
      // exit: 16x at the far right corner over the road at the start.
      danger: { road: 3, right: 3 },
      start: 6,
      exit: 8,
    },
  },
  view: { width: 900, height: 600 },
  // Eases out from 1:1 by a fifth of the gap each 60Hz frame. Follows the player by a quarter of
  // the gap each 60Hz frame: about 7px behind at a walk and 12px at a sprint, so a lunge leads
  // it. A jump of more than 4 cells, such as a respawn, is cut to rather than panned across.
  camera: {
    zoom: 1.25,
    zoomRate: 13.4,
    followRate: 18,
    snapDistance: CELL * 4,
  },
  // Noises the local player hears, each drawn as a ring snapping out to the noise's radius in
  // 0.15s, then fading over the rest of 0.9s. One made by something other than a player that it
  // can't see glows warm and soft at the screen's edge instead, the way it seemed to come from.
  ripples: {
    duration: 0.9,
    expand: 0.15,
    width: { sharp: 1.5, soft: 7 },
    alpha: { sharp: 0.65, soft: 0.15 },
    colour: "#9fd3ff",
    edge: {
      radius: 90,
      inset: 12,
      alpha: { sharp: 0.7, soft: 0.2 },
      colour: "#ffb070",
    },
  },
  // Terrain seen before and out of sight now: grey, the floor barely there, walls easier to read.
  mapMemory: {
    saveInterval: 5,
    maxRooms: 50,
    floor: { fill: "#181818", grid: "#2a2a2a", alpha: 0.4 },
    wall: { fill: "#5a5a5a", edge: "#6a6a6a", alpha: 0.5 },
  },
  // Where the player stands, saved every 2s while it moves, so a reload puts it back there.
  positionMemory: { saveInterval: 2, maxRooms: 50 },
  // A kick's flash: three quarters of its size at first, swelling to full as it fades over 0.3s.
  flashes: {
    duration: 0.3,
    start: 0.75,
    fill: 0.55,
    width: 4,
    colour: { hit: "#ffb04a", miss: "#e6edf3" },
  },
  player: {
    radius: 14,
    speed: 120,
    acceleration: 1100,
    sprintMultiplier: 1.8,
    crouchMultiplier: 0.5,
    maxHealth: 100,
    inventorySlots: 6,
    nameMax: 8,
    knockbackSeconds: 0.15,
    // Every pound carried slows a player evenly, to 20% slower at 100lb and no slower past it:
    // a shovel and a scrap (30lb) cost 6%.
    load: { full: 100, slowdown: 0.2 },
  },
  stamina: {
    max: STAMINA_MAX,
    // A full bar lasts 3s.
    drain: STAMINA_MAX / 3,
    // Empty to full in 4s.
    regen: STAMINA_MAX / 4,
    regenDelay: 0.6,
    recover: STAMINA_MAX * 0.3,
  },
  // A player new to a world starts within 2 cells of its rally point, where the cruiser waits.
  arrival: { spread: CELL * 2 },
  vision: { coneAngle: Math.PI / 2, rays: 360, surroundingsRadius: CELL * 1.4 },
  light: { range: CELL * 6 },
  // A guest holds a hit it predicted for up to a second before the host confirms it.
  net: { smoothing: 12, predictionHold: 1 },
  // A noise 10 cells off seems to come from anywhere within 2.5 cells of it.
  noise: { blur: 0.25 },
  // Each step is heard by anything within its radius: a sprint carries well past a zombie's
  // sight, a walk a few cells, a crouch barely past arm's length.
  footsteps: {
    walk: { interval: 0.5, radius: CELL * 5 },
    sprint: { interval: 0.3, radius: CELL * 16 },
    crouch: { interval: 0.7, radius: CELL * 1.5 },
  },
  // Speech is judged by its loudest moment over the last 0.75s, so the gaps between words don't
  // silence it. The mic level runs from -60 dBFS (0) to full scale (1): a quiet room sits below
  // 0.35 (-39 dBFS), talking at about 0.5 (-30 dBFS) carries 4 cells, under a walk's 5, and a
  // shout at 0.85 (-9 dBFS) or more carries 10, past a walk but short of a sprint's 16. Rounded to
  // whole cells, so a player reports a new radius only as its loudness steps; a speaker ripples
  // every 0.5s, a walking step's pace.
  voiceNoise: {
    window: 0.75,
    threshold: 0.35,
    full: 0.85,
    radius: { quiet: CELL * 2, loud: CELL * 10 },
    step: CELL,
    interval: 0.5,
  },
  // Items lying about: a 16px glyph, picked up at most five times a second.
  worldItems: { radius: 8, cooldown: 0.2, dropCooldown: 0.2 },
  room: {
    sendHz: 10,
    // Others see a player's facing for its view cone; turning alone sends it five times a second.
    facingMs: 200,
    fullSnapshotMs: 5000,
    heartbeatMs: 1000,
    presence: {
      awayAfterMs: 3500,
      goneSilentMs: 30_000,
      goneHiddenMs: 180_000,
    },
  },
  // Peers connect a second or two after joining; past this, a HELLO is news to no one.
  greeting: { replayMs: 10_000 },
  entities: {
    zombie: {
      // Groups of one to five, three on average, so a third as many groups as there were zombies
      // when they came one at a time; at least one.
      spawn: {
        count: { density: 0.4, min: 1 },
        seed: 1,
        clearance: CELL * 10,
      },
      // A group every 36 seconds as a world begins, the gap falling evenly to one every 3 seconds
      // over its first five minutes, so as many arrive on average as when they came one at a time;
      // never within 14 cells of a player, nor past 120 alive. A group stands within 2 cells of its
      // first.
      spawning: {
        firstGap: 36,
        lastGap: 3,
        rampSeconds: 300,
        maxAlive: 120,
        tries: 24,
        unseenDistance: 700,
        group: { min: 1, max: 5, spread: CELL * 2 },
      },
      radius: 15,
      maxHealth: 40,
      attackDamage: 35,
      wanderSpeed: 60,
      chaseSpeed: 120,
      sightRange: CELL * 5,
      wanderRange: CELL * 5,
      wanderPause: { min: 0.4, max: 1.5 },
      repathDistance: CELL / 2,
      barkGap: { min: 6, max: 12 },
      attackRange: 30,
      attackCooldown: 2,
      // How far each of its sounds is heard, and so how far its noise carries: a bark past its
      // sight, the cry as it starts a chase further, its bite only nearby.
      sounds: { bark: CELL * 8, alert: CELL * 10, attack: CELL * 5 },
    },
    cruiser: {
      lightRadius: CELL * 12,
      // Everyone in the exit escapes once the cruiser has waited there 20s.
      escape: { delay: 20, volume: 0.8 },
    },
  },
  // Each item's weight in pounds; its uses, unlimited when left out; and its loot weight, its
  // share of the loot a new world lays, with its rarity.
  items: {
    shovel: {
      weight: 15,
      loot: { weight: 30, rarity: "common" },
      radius: 20,
      reach: 45,
      damage: 15,
      knockback: 20,
      cooldown: 1,
      duration: 0.18,
      volume: 0.8,
      // A swing that hits rings out 14 cells; a miss whooshes 3.
      hitNoiseRadius: CELL * 14,
      missNoiseRadius: CELL * 3,
    },
    scrap: {
      weight: 15,
      value: 1,
      cashoutRadius: CELL * 3,
      sellInterval: 0.25,
      volume: 0.8,
      scatter: { count: 75, seed: 2, clearance: CELL * 3 },
    },
    // A new world lays 20 items, a fifth as many as its scrap, each picked by loot weight. At the
    // most dangerous spot there is an even chance of a second, an uncommon item is twice as
    // likely, a rare one four times.
    loot: {
      scatter: { count: 20, seed: 4, clearance: CELL * 3 },
      danger: { extra: 0.5, rarity: { common: 1, uncommon: 2, rare: 4 } },
    },
  },
  moves: {
    // A lunge of one body length into a kick that lands a little short of the shovel; five
    // kicks fell a zombie, each sending it 2.5 of its own body lengths away.
    kick: {
      reach: 32,
      radius: 18,
      damage: 8,
      knockback: 2.5,
      cooldown: 0.8,
      stamina: STAMINA_MAX * 0.15,
      lunge: { lengths: 1, seconds: 0.08 },
      noiseRadius: CELL * 12,
    },
  },
  sim: { fixedDt: 1 / 60, maxCatchUpS: 30, maxStepsPerFrame: 240 },
  voice: { full: 100, silent: 600, pan: 300 },
  voiceConnections: {
    levelRampS: 0.05,
    connectDeadlineMs: 15_000,
    pending: { cap: 32, ttlMs: 5000 },
    retry: { firstMs: 2000, maxMs: 60_000 },
    statsIntervalMs: 1000,
  },
  audio: { full: 0, silent: 1000, pan: 500 },
  ui: { debugRefreshMs: 250 },
  // An item with up to 10 uses shows each as a segment of its bar.
  hud: { segmentsUpTo: 10 },
} as const satisfies AppConfig;
