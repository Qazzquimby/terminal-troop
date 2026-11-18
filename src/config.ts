import type { SpatialFalloff } from "./audio/index.js";
import type { EntitiesConfig } from "./entities/index.js";
import type {
  CameraConfig,
  FlashConfig,
  MapMemoryConfig,
  RippleConfig,
  SpectateConfig,
  ZoomFitConfig,
} from "./render/index.js";
import type { PositionMemoryConfig } from "./position-memory/index.js";
import type { RoomConfig } from "./room/index.js";
import type { SimClockConfig, SimConfig } from "./sim/index.js";
import type { ItemsConfig } from "./items/index.js";
import type { MovesConfig } from "./moves/index.js";
import type { GreetingConfig } from "./net/index.js";
import type { HudConfig, MinimapConfig, UiConfig } from "./ui/index.js";
import type { TurnConfig, WheelConfig } from "./input/index.js";

import type {
  RadioSoundConfig,
  VoiceClipConfig,
  VoiceConnectionConfig,
  VoiceDetectorConfig,
  VoiceFalloff,
} from "./voice/index.js";
import type { WorldLogConfig } from "./world-log/index.js";

// Units, unless a line says otherwise: distances and radii in px (CELL px to a cell), speeds in
// px/s, times in seconds (`...Ms` in ms), volumes 0..1, `sounds.*` the px a sound is heard and
// is a noise to, spawning `weight` a share of the spawner's picks.
interface AppConfig extends SimConfig {
  readonly sim: SimClockConfig;
  readonly room: RoomConfig;
  readonly greeting: GreetingConfig;
  readonly camera: CameraConfig;
  readonly zoomFit: ZoomFitConfig;
  readonly spectate: SpectateConfig;
  readonly ripples: RippleConfig;
  readonly flashes: FlashConfig;
  readonly mapMemory: MapMemoryConfig;
  readonly positionMemory: PositionMemoryConfig;
  readonly entities: EntitiesConfig;
  readonly items: ItemsConfig;
  readonly moves: MovesConfig;
  readonly voice: VoiceFalloff;
  readonly voiceConnections: VoiceConnectionConfig;
  readonly voiceRadio: RadioSoundConfig;
  readonly voiceClips: VoiceClipConfig;
  readonly voiceDetector: VoiceDetectorConfig;
  readonly audio: SpatialFalloff;
  readonly speechSynth: { readonly sampleRate: number }; // Hz
  readonly ui: UiConfig;
  readonly hud: HudConfig;
  readonly minimap: MinimapConfig;
  readonly wheel: WheelConfig;
  readonly turn: TurnConfig;
  readonly worldLog: WorldLogConfig;
}

const CELL = 50; // px
const STAMINA_MAX = 100;
const SHOVEL_DAMAGE = 15; // the unit monster health is reckoned in
// A body with at least this much full health drops a heart, and is "tough" to the doppelganger.
const SLEEPER_HEALTH = SHOVEL_DAMAGE * 10;
// The doppelganger fears kinds with a spawn weight this low or lower.
const SLEEPER_SPAWN_WEIGHT = 50;
const PLAYER_SPEED = 120;
const SPRINT = 1.8; // sprint speed multiplier
// Radians past a view cone's edge that still count as looking at a watched kind (stops stutter).
const WATCH_MARGIN = (10 * Math.PI) / 180;
// Seconds into a world when the spawner and growing groups reach full strength.
const END_GAME = 20 * 60;
const EXIT_REACH = 20; // cells round the exit kept dark and extra dangerous
// Monsters with no living player this near lie dormant (stand still, cost nothing).
const DORMANT_BEYOND = CELL * 50;

const SCANNER = {
  weight: 2,
  uses: 300, // seconds of battery
  loot: { weight: 5, rarity: "uncommon" },
  range: CELL * 20,
  slowest: 1.5, // seconds between beeps for a target at the edge of range
  fastest: 0.125, // seconds between beeps for a target at its feet, dead ahead
  behind: 0.25, // how much a target behind the holder counts, against 1 ahead
  drain: 1, // uses a second while on
  cooldown: 0.25,
  volume: 0.5,
  beepRange: CELL * 4,
  clickRange: CELL,
} as const;

export const config = {
  world: {
    cell: CELL,
    cols: 100,
    rows: 60,
    seed: 1,
    wallBounce: 0, // share of speed kept, reversed, on hitting a wall
    generation: {
      // Widths and meander in cells; step: columns between bends; margin: rows kept off top/bottom.
      road: { width: { min: 6, max: 12 }, step: 10, meander: 10, margin: 18 },
      yard: {
        depth: { min: 4, max: 10 }, // cells
        clutter: { near: 0.2, far: 0.9 }, // share of tries cluttered: by the road, at the far edge
        tries: 0.6,
      },
      rooms: {
        size: { min: 3, max: 9 }, // cells
        minCells: 6,
        solidChance: 0.3,
        hallwayChance: 0.2,
        hallway: { width: 2, length: 16 }, // cells
        door: { min: 1, max: 3 }, // doorway width, cells
        loops: 0.1, // share of spare inner walls given a door
        exits: [0.6, 0.3, 0.1], // chance of a building having 1, 2, 3 doors out
        building: { min: 3, max: 8 },
      },
      // fixture/powered: chance a room has a light / that it is lit. exitShade: cells of dark
      // round the exit even by day.
      lights: { fixture: 1.0, powered: 1 / 30, exitShade: EXIT_REACH },
      // Spawn and loot weight multipliers: road and right add up to that many times more by
      // distance from the road / towards the right; exit adds this much at the exit, fading to 0
      // `reach` cells out.
      danger: { road: 3, right: 3, exit: 20, reach: EXIT_REACH },
      start: 6, // columns
      exit: 8, // columns
    },
  },
  view: { width: 900, height: 600 },
  // notch: px of scroll per step; line: px per line in line-mode wheels; idleMs: a part-notch is
  // forgotten after this.
  wheel: { notch: 40, line: 16, page: 600, idleMs: 250 },
  camera: {
    zoom: 1.25,
    zoomRate: 13.4, // exponential ease rate, per second
    followRate: 18, // exponential ease rate, per second
    snapDistance: CELL * 4, // jumps further than this cut instead of panning
    // Rotating camera (a setting). rate: ease rate per second; anchor: eye's height down view, 0..1.
    roll: { rate: 13.4, anchor: 0.78 },
  },
  // Rotating camera: zoom glides to fit the furthest point that shows (seen and lit). always: also
  // when upright; rays: cast round the eye; margin: multiplier of room to spare.
  zoomFit: {
    always: false,
    rays: 48,
    step: CELL / 2, // px between points checked along a ray
    margin: 1.15,
    min: 0.7,
    max: 2.5,
    interval: 0.1, // between re-measures
    deadBand: 0.12, // fraction the fit must change by before the zoom follows
    outTime: 1.2, // about how long a glide out takes (critically damped spring)
    inTime: 2,
  },
  // sensitivity: radians per px of mouse, times the player's setting; directions: steer headings
  // in a full turn.
  turn: {
    sensitivity: 0.0028,
    directions: 64,
    spike: 300, // px; a single mouse move bigger than this is a browser glitch and dropped
    // Uncaptured mouse: a cursor within `band` (share of width) of a side turns at `rate` rad/s.
    edge: { band: 0.1, rate: 3 },
  },
  // zoom: multiples of the living camera's zoom; step: factor per wheel notch.
  spectate: { speed: CELL * 8, zoom: { min: 0.5, max: 2.5, step: 1.2 } },
  ripples: {
    duration: 0.9,
    expand: 0.15, // seconds for the ring to reach full size
    width: { sharp: 1.5, soft: 7 },
    alpha: { sharp: 0.2, soft: 0.05 },
    colour: "#9fd3ff",
    // An unseen non-player noise glows at the screen edge instead.
    edge: {
      radius: 90,
      inset: 12,
      alpha: { sharp: 0.25, soft: 0.03 },
      colour: "#ffb070",
    },
  },
  mapMemory: {
    saveInterval: 5,
    maxRooms: 50, // worlds kept
    floor: { fill: "#181818", grid: "#2a2a2a", alpha: 0.4 },
    wall: { fill: "#5a5a5a", edge: "#6a6a6a", alpha: 0.5 },
    // Out-of-sight terrain fades from far to near.
    fade: {
      seconds: 10, // to fade at `reach` cells
      spread: 0.3, // random share of that time, so it fades in blots
      blot: 3, // cells across
      detail: 4,
      refresh: 0.25, // seconds between renewing terrain in sight
      reach: 6, // cells
      nearest: 1, // cells
    },
  },
  positionMemory: { saveInterval: 2, maxRooms: 50 },
  flashes: {
    duration: 0.3,
    start: 0.75, // starting share of full size
    fill: 0.55,
    width: 4,
    colour: { hit: "#ffb04a", miss: "#e6edf3" },
    tracer: { width: 1.5, colour: "#fff3b0" },
  },
  player: {
    radius: 14,
    speed: PLAYER_SPEED,
    acceleration: 1100,
    sprintMultiplier: SPRINT,
    crouchMultiplier: 0.5,
    maxHealth: 100,
    inventorySlots: 6,
    nameMax: 8, // characters
    knockbackSeconds: 0.15,
    mass: 1, // the unit every body's mass is reckoned in
    // full: lb carried for the most slowdown; slowdown: speed share lost at full.
    load: { full: 100, slowdown: 0.5 },
    switchVolume: 0.4,
  },
  stamina: {
    max: STAMINA_MAX,
    drain: STAMINA_MAX / 6, // per second sprinting
    regen: STAMINA_MAX / 10, // per second
    regenDelay: 0.6,
    recover: STAMINA_MAX * 0.3, // needed after emptying before sprinting again
  },
  arrival: { spread: CELL * 2 }, // round the rally point
  death: { scatter: CELL, reviveHealth: 50 },
  // Entities act on one another only while both are this near a living player.
  engagement: { range: CELL * 15 },
  stunned: {
    darkness: 0.95, // 0..1
    fadeOut: 1, // seconds at the end of a stun over which the view clears
    ring: { volume: 0.5, fadeSeconds: 1 },
  },
  vision: {
    coneAngle: Math.PI / 2,
    rays: 360,
    surroundingsRadius: CELL * 0.7,
    lookRange: CELL * 7, // how far a body looks, light or not (holds a statue etc.)
    footprintSpacing: CELL / 4, // px between points checked for a body being in sight
  },
  // range: carried light down the cone. shadows: bodies in light cast shadows (drawn / for rules).
  light: { range: CELL * 6, shadows: { cast: true, gameplay: true } },
  day: {
    startHour: 8,
    midnight: END_GAME, // seconds in
    afternoon: 10 * 60, // seconds in; daylight starts receding
    night: 17 * 60, // seconds in; no daylight left
    volume: 0.5,
  },
  deepdark: {
    light: 0.5, // multiplier on light reach inside it
    sight: 0.5, // multiplier on bodies' own sight inside it
    memoryFade: 3, // multiplier on remembered terrain's fade speed
    eyes: { every: 4, for: 0.6, colour: "#ff3b30" },
    // Seconds in when dark / deepdark set out from the left edge; both reach the right at `end`.
    fronts: { dark: 2 * 60, deep: 4 * 60, end: END_GAME },
  },
  // smoothing: ease rate; glide: seconds to reach a reported position; predictionHold: seconds a
  // guest holds a predicted hit; snap: a jump further than this is placed, not glided.
  net: { smoothing: 12, glide: 0.15, predictionHold: 1, snap: CELL * 7 },
  noise: { blur: 0.25 }, // a noise seems to come from within this share of its distance
  footsteps: {
    walk: { interval: 0.5, radius: CELL * 3 },
    sprint: { interval: 0.3, radius: CELL * 7 },
    crouch: { interval: 0.7, radius: 0 },
  },
  // Mic loudness 0..1 maps -60 dBFS..0 dBFS.
  voiceNoise: {
    window: 0.3, // seconds of loudest level judged, so gaps between words don't silence it
    threshold: 0.35, // below this is silence
    full: 0.85, // at or above this carries `radius.loud`
    radius: { quiet: CELL * 2, loud: CELL * 10 },
    step: CELL, // radius rounding
    interval: 0.5, // seconds between ripples
  },
  echoes: { maxChars: 64_000 }, // base64 characters in a speech clip
  speech: {
    // pitch Hz; intonation semitones; rate letters/s; formant >1 smaller throat; roughness and
    // breathiness 0..1; ring: ring modulator Hz (0 none); range: px heard and a noise.
    voices: {
      plain: {
        pitch: 140,
        intonation: 4,
        rate: 12,
        formant: 1,
        roughness: 0.1,
        breathiness: 0.1,
        ring: 0,
        volume: 0.8,
        range: CELL * 5,
      },
      child: {
        pitch: 300,
        intonation: 7,
        rate: 13,
        formant: 1.25,
        roughness: 0.05,
        breathiness: 0.15,
        ring: 0,
        volume: 0.8,
        range: CELL * 5,
      },
      shout: {
        pitch: 260,
        intonation: 9,
        rate: 14,
        formant: 1.2,
        roughness: 0.35,
        breathiness: 0.05,
        ring: 0,
        volume: 1,
        range: CELL * 10,
      },
      robot: {
        pitch: 110,
        intonation: 0,
        rate: 10,
        formant: 1,
        roughness: 0,
        breathiness: 0,
        ring: 50,
        volume: 0.7,
        range: CELL * 5,
      },
      creepy: {
        pitch: 75,
        intonation: 2,
        rate: 7,
        formant: 0.85,
        roughness: 0.6,
        breathiness: 0.4,
        ring: 0,
        volume: 0.7,
        range: CELL * 4,
      },
      whisper: {
        pitch: 150,
        intonation: 2,
        rate: 11,
        formant: 1,
        roughness: 0,
        breathiness: 1,
        ring: 0,
        volume: 0.5,
        range: CELL * 2,
      },
      gruff: {
        pitch: 95,
        intonation: 3,
        rate: 11,
        formant: 0.9,
        roughness: 0.45,
        breathiness: 0.1,
        ring: 0,
        volume: 0.9,
        range: CELL * 6,
      },
    },
    fallback: "plain", // voice for a line that names none
    captionHold: 1.5, // seconds a line stays shown after it is said
  },
  speechSynth: { sampleRate: 22_050 },
  // cooldown: seconds between pick-ups.
  worldItems: { radius: 8, cooldown: 0.2, dropCooldown: 0.2 },
  room: {
    sendHz: 10,
    facingMs: 200, // min gap between facing-only updates
    fullSnapshotMs: 5000,
    heartbeatMs: 1000,
    presence: {
      awayAfterMs: 3500,
      goneSilentMs: 30_000,
      goneHiddenMs: 180_000,
    },
  },
  greeting: { replayMs: 10_000 }, // how long after joining a HELLO is still replayed to late peers
  entities: {
    door: {
      radius: CELL / 2,
      maxHealth: 300,
      seed: 4,
      frequency: 0.75, // chance a 1-wide doorway gets a door; wider ones never do
      reach: CELL * 1.2, // how near a player must be to work it
      openSeconds: 0.5, // for bodies that open doors
      bash: { damage: 20, cooldown: 1 }, // for bodies that don't
      toll: 10, // cells a route must save to go through a shut door
      sounds: { swing: CELL * 8, hit: CELL * 10, break: CELL * 16 },
    },
    zombie: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 100,
        tries: 24,
        unseenDistance: 700, // never spawns nearer a player than this
        // Group size at world start, growing to `grows` by `grows.by` seconds.
        group: {
          min: 1,
          max: 5,
          spread: CELL * 3,
          grows: { min: 5, max: 11, by: END_GAME },
        },
      },
      radius: 15,
      mass: 1,
      // Exploders ignored so bites don't set them off.
      ignores: ["zombie", "exploder"],
      maxHealth: 30,
      attackDamage: 35,
      wanderSpeed: 60,
      chaseSpeed: PLAYER_SPEED * 0.8,
      sightRange: CELL * 5,
      wanderRange: CELL * 5,
      wanderPause: { min: 0.4, max: 1.5 },
      repathDistance: CELL / 2,
      barkGap: { min: 6, max: 12 },
      attackRange: 30,
      attackCooldown: 2,
      chase: { limit: 15, rest: 5 }, // seconds chasing at most, then seconds ignoring what it sees
      sounds: { bark: CELL * 8, alert: CELL * 10, attack: CELL * 5 },
    },
    cruiser: {
      length: CELL * 4,
      width: CELL * 2.4,
      handling: {
        speed: CELL * 6,
        reverse: CELL * 2,
        acceleration: CELL * 3, // px/s²
        braking: CELL * 9, // px/s²
        drag: CELL * 2, // px/s²
        turnRate: 1.2, // rad/s at full grip
        grip: CELL * 3, // speed below which it turns slower
      },
      reach: CELL / 2, // how near its body a player can get in
      burn: 1, // fuel seconds per second driven
      standing: CELL / 4, // below this speed it stands and burns nothing
      gauge: 30, // seconds of fuel the gauge shows full
      engine: {
        idle: { interval: 1, radius: 0 },
        drive: { interval: 0.5, radius: CELL * 14 },
      },
      crash: {
        speed: CELL * 3, // speed lost against a wall that counts as a crash
        damage: 50,
        breakdown: 250, // total crash damage that breaks it down
        noiseRadius: CELL * 20,
      },
      ram: {
        speed: CELL * 2, // min speed to hurt what it hits
        damage: 50,
        cooldown: 0.5,
        noiseRadius: CELL * 10,
      },
      horn: { noiseRadius: CELL * 18, volume: 0.9 },
      // Playback only: range in plain px, not cells. How far monsters hear it is the noise above.
      sounds: {
        idle: { volume: 0.05, range: 6 },
        drive: { volume: 0.4, range: 20 },
        reverse: { volume: 0.4, range: 20 },
        crash: { volume: 0.8, range: 34 },
        ram: { volume: 0.5, range: 22 },
      },
      // angle: cone width in radians; spread: px each lamp sits off the middle.
      headlights: { range: CELL * 12, angle: Math.PI * (2 / 9), spread: 38 },
      escape: {
        delay: 20, // seconds waiting in the exit before everyone in it escapes
        volume: 0.8,
        quota: 30, // credit the team must have banked to escape; kept
        depart: { volume: 0.3, range: 20 }, // range in px
      },
      revive: { reach: CELL, volume: 0.3, cost: 6 }, // cost in credit; may go into debt
      // Door power is 0..1: close costs, drain/recharge per second shut/open.
      door: {
        close: 0.2,
        drain: 0.02,
        recharge: 0.01,
        volume: 0.8,
        range: CELL * 3,
      },
      storage: { slots: 6, noiseRadius: CELL, volume: 0.7 },
      // Prices in credit; one scrap sells for 1.
      shop: {
        wares: [
          { item: "walkie", price: 2 },
          { item: "flashlight", price: 3 },
          { item: "shovel", price: 3 },
          { item: "flareGun", price: 4 },
          { item: "itemScanner", price: 4 },
          { item: "monsterScanner", price: 4 },
          { item: "teleporter", price: 5 },
          { item: "bomb", price: 6 },
          { item: "pocketball", price: 6 },
          { item: "turret", price: 8 },
        ],
        noiseRadius: CELL * 2,
        volume: 0.8,
      },
      // chance: per ware per draw; minOff/maxOff: percent; every: seconds between draws.
      sales: { chance: 0.15, minOff: 25, maxOff: 75, every: 9999 },
      coinToss: { flight: 1.2, odds: 0.5, volume: 0.7, range: CELL * 2 }, // flight in seconds
      radio: {
        volume: 0.2,
        range: CELL * 25,
        noiseInterval: 1,
        switchVolume: 0.6,
        switchRange: CELL * 2,
      },
    },
    stunTrap: {
      radius: 30, // how near a body must step to set it off
      flash: 60, // drawn flash radius
      armSeconds: 3,
      stunRange: CELL * 5, // stuns every body whose eyes catch it within this
      stunSeconds: 5,
      light: { range: CELL * 8, seconds: 0.5 },
      sounds: { beep: CELL * 8, flash: CELL * 12 },
      volume: 0.8,
    },
    turret: {
      radius: 14,
      maxHealth: 100,
      ammo: 30,
      mass: 1,
      ignores: ["player"],
      armSeconds: 3,
      sight: { angle: Math.PI / 18, range: CELL * 12 }, // laser beam width in radians
      turnSeconds: 5, // per full sweep
      shot: {
        damage: SHOVEL_DAMAGE * 2,
        range: CELL * 12,
        interval: 2,
        aimSeconds: 0.5, // lock-on to first shot
        spark: 5,
      },
      sounds: {
        beep: CELL * 8,
        lock: CELL * 4,
        shot: CELL * 30,
        break: CELL * 10,
        click: CELL * 2, // dry fire
      },
      volume: 0.8,
    },
    teleporter: {
      radius: 48, // how near a body must step to ride it
      armSeconds: 3,
      rearmSeconds: 3,
      distance: { min: CELL * 8, max: CELL * 30 }, // the way it is aimed
      tries: 24,
      flash: 30,
      sounds: { beep: CELL * 8, warp: CELL * 10 },
      volume: 0.8,
    },
    // The cruiser's teleporter, which brings a body back beside it.
    recall: {
      seconds: 3,
      spread: CELL * 2, // lands within this of the cruiser
      flash: 30,
      sounds: { hum: CELL * 8, zap: CELL * 10, fizzle: CELL * 4 },
      volume: 0.8,
    },
    pocketball: {
      radius: 6,
      speed: CELL * 15,
      grace: CELL, // flight distance before it can touch its thrower
      flash: 30,
      sounds: { bounce: CELL * 3, capture: CELL * 8, release: CELL * 8 },
      volume: 0.8,
    },
    bomb: {
      radius: 12,
      fuse: 3,
      // reach: cells per arm of the plus; walls: walls each arm knocks down before stopping.
      blast: { reach: 8, walls: 2, damage: 100 },
      sounds: { blast: CELL * 40 },
      volume: 1,
    },
    flare: {
      radius: 4,
      speed: CELL * 12,
      damage: 10,
      light: { range: CELL * 6, tint: "rgba(255, 60, 40, 0.28)" },
      seconds: 60, // burn time once landed
      sounds: { land: CELL * 4, out: CELL * 2 },
      volume: 0.7,
    },
    shrine: {
      radius: 14,
      // spread "x": one per equal band of the width; danger: exponent on danger weight within its
      // band; terms right/exit 0: only distance from the road counts; clearance: from the start.
      scatter: {
        count: 5,
        seed: 7,
        clearance: CELL * 20,
        spread: "x",
        danger: 1,
        terms: { right: 0, exit: 0 },
      },
      reach: CELL, // an item this near its middle counts as offered
      earReach: CELL * 20, // ghosts hear speakers within this
      revives: "heart",
      transforms: { walkie: "ghostWalkie" },
      safeOfferings: 1, // offerings before it can crumble
      crumbleChance: 1 / 3,
      whisperGap: { min: 6, max: 14 },
      glow: CELL * 1.5,
      volume: 0.3,
      sounds: {
        whisper: CELL * 4,
        revive: CELL * 6,
        transform: CELL * 6,
        crumble: CELL * 12,
      },
    },
    snail: {
      spawning: {
        weight: 10,
        after: 240, // seconds into a world before any spawn
        tries: 24,
        unseenDistance: CELL * 14,
        // Spawn chance falls off nearer than `distance` to these, to never when touching.
        apart: { from: ["snail", "giantSnail"], distance: CELL * 40 },
      },
      radius: 12,
      ignores: ["snail", "giantSnail"],
      targets: ["player"],
      speedShare: 0.2, // of a player's walk
      damage: 500,
      attackCooldown: 1,
      repathInterval: 2,
    },
    giantSnail: {
      spawning: {
        weight: 5,
        after: 480,
        tries: 24,
        unseenDistance: CELL * 14,
        apart: { from: ["snail", "giantSnail"], distance: CELL * 40 },
      },
      radius: CELL - 3,
      ignores: ["snail", "giantSnail"],
      targets: ["player"],
      speedShare: 0.3,
      damage: 500,
      attackCooldown: 1,
      repathInterval: 2,
      breaksWalls: {
        seconds: 5, // pressing a wall this long brings it down
        grindGap: 1,
        sounds: { grind: CELL * 8, crumble: CELL * 16 },
      },
    },
    ghostGirl: {
      spawning: {
        weight: 3,
        after: 60 * 3,
        tries: 24,
        most: 1,
        unseenDistance: CELL * 14,
      },
      radius: 14,
      targets: ["player"],
      absent: { min: 20, max: 180 }, // seconds away between appearances
      appear: {
        near: CELL * 4,
        far: CELL * 12,
        behind: Math.PI / 2, // radians past the edge of her target's view cone
        tries: 24,
        retry: 0.5,
      },
      // Patience per second: drain always, +unseen while unseen, +watched while looked at.
      patience: { start: 15, drain: 1, unseen: 2, watched: 1 },
      // Anger is patience lost; speeds are shares of a sprint.
      chase: {
        from: 3, // anger at which a look can set her chasing
        chance: 0.3,
        chancePerAnger: 0.1,
        speed: 0.5,
        speedPerAnger: 0.1,
        maxSpeed: 1.2,
        seconds: { min: 5, max: 10 },
      },
      hide: {
        range: CELL * 8,
        tries: 12, // per step
        search: 2, // seconds searching before making for the nearest wall
        speed: 1, // share of a sprint
        giveUp: 10, // seconds before vanishing anyway
      },
      flicker: 0.8,
      apparition: {
        opacity: 0.7,
        shake: 1.5, // px
        jolt: { chance: 0.06, size: 5 }, // chance: share of moments; size px
        static: 0.35,
      },
      contact: { damage: 5, interval: 0.25 },
      soundRange: CELL * 16,
    },
    blindDog: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 10,
        tries: 24,
        unseenDistance: CELL * 40,
        group: { min: 1, max: 3, spread: CELL * 16 },
      },
      radius: CELL - 3, // Currently size 2 // 3-> Cell * 1.5 - 3,
      ignores: ["blindDog"],
      maxHealth: SHOVEL_DAMAGE * 10.0,
      contactDamage: 100,
      contactCooldown: 1,
      wanderSpeed: PLAYER_SPEED * 0.6,
      stalkSpeed: PLAYER_SPEED * 0.8,
      chargeSpeed: PLAYER_SPEED * SPRINT * 1.2,
      pounce: {
        reach: CELL * 6, // target within this, with a clear line
        windup: 0.3, // growling crouch before the dash
        speed: PLAYER_SPEED * SPRINT * 4.0,
        recover: 0.6,
        skid: CELL,
      },
      wanderRange: CELL * 8,
      wanderPause: { min: 1, max: 3 },
      repathDistance: CELL,
      // Each noise adds the px it carried past the dog; charges at max; decay is per second.
      suspicion: { max: CELL * 25, decay: CELL * 2 },
      overrun: CELL * 8, // a pounce runs this far past its target
      lunge: CELL * 3, // goes straight for a noise's maker this near
      patience: 8, // seconds near a noise biting nothing before giving up
      boredSeconds: 20, // then ignores that maker this long
      barkGap: { min: 10, max: 16 },
      sounds: {
        bark: CELL * 10,
        roar: CELL * 25,
        snarl: CELL * 4,
        bite: CELL * 6,
        huff: CELL * 4,
        growl: CELL * 5,
        pounce: CELL * 15,
        skid: CELL * 5,
      },
    },
    exploder: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 70,
        tries: 24,
        unseenDistance: CELL * 14,
        group: {
          min: 1,
          max: 1,
          spread: CELL * 3,
          grows: { min: 2, max: 4, by: END_GAME },
        },
      },
      radius: 16,
      // Ignores the crowds, or it would spend itself on the first it felt.
      ignores: ["exploder", "zombie", "hoarder"],
      maxHealth: SHOVEL_DAMAGE * 2,
      wanderSpeed: PLAYER_SPEED,
      chaseSpeed: PLAYER_SPEED,
      litSpeed: PLAYER_SPEED * 0.65,
      senseRange: CELL * 12, // through walls
      wanderRange: CELL * 5,
      wanderPause: { min: 0.5, max: 2 },
      repathDistance: CELL / 2,
      // A route longer than factor x straight line + slack is too long: it goes straight and
      // blows the wall in the way.
      detour: { factor: 2, slack: CELL * 2 },
      fuseRange: CELL * 1.5,
      // Any hurt of at least minDamage lights it, but not from these kinds' blasts.
      fuseOnHurt: { minDamage: 0, except: ["exploder"] },
      fuse: 2.0, // seconds
      // Damage falls from centre to edge; knocks down walls within the radius.
      blast: { radius: CELL * 3, centre: 100, edge: 30 },
      sounds: { fuse: CELL * 6, blast: CELL * 40 },
    },
    sleeper: {
      spawning: {
        weight: SLEEPER_SPAWN_WEIGHT,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["sleeper"],
      radius: 15,
      maxHealth: SLEEPER_HEALTH,
      sightRange: CELL * 8, // all round
      wakeRange: CELL * 5,
      runShare: 1.1, // of a player's sprint
      warnSeconds: 1, // growl before waking; the body must still be there
      rageSeconds: 10,
      wanderRange: CELL * 8,
      repathDistance: CELL / 2,
      attackDamage: SHOVEL_DAMAGE * 3,
      attackCooldown: 1,
      barkGap: {
        dormant: { min: 1, max: 5 },
        enraged: { min: 1.5, max: 3 },
      },
      // Where she sleeps again: distance from where she raged, clearance from bodies she hunts.
      retreat: {
        distance: { min: CELL * 10, max: CELL * 20 },
        clearance: CELL * 12,
        tries: 16,
      },
      alarmRadius: CELL * 18, // a noise carrying this far wakes her and draws her to it
      // after: seconds asleep with none she hunts within range before moving; retry: seconds.
      relocate: { after: 120, range: CELL * 14, retry: 5 },
      sounds: {
        bark: CELL * 8,
        growl: CELL * 6,
        enrage: CELL * 16,
        rageBark: CELL * 12,
        attack: CELL * 6,
        vanish: 0,
      },
    },
    statue: {
      spawning: {
        weight: 5,
        after: 180,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["statue"],
      targets: ["player"], // hunts players only; its blow still lands on any body
      radius: 16,
      mass: 10,
      sightRange: CELL * 16, // all round
      watchRange: Infinity, // as far as each looker looks
      watchMargin: WATCH_MARGIN, // radians each side of a view cone
      watchPad: 12, // px it counts as bigger when asking if seen, for screen lag
      // A patrol round `distance` long, give or take `spread`; retry: seconds between failed plans.
      patrol: { distance: CELL * 30, spread: CELL * 5, tries: 16, retry: 2 },
      huntSeconds: 10, // of moving
      repathInterval: 0.25,
      damage: 90,
      attackCooldown: 1,
      step: { interval: 0.3, range: CELL * 10 },
      strikeRange: CELL * 8, // how far its blow is heard
    },
    stalker: {
      spawning: {
        weight: 10,
        tries: 24,
        unseenDistance: CELL * 30,
      },
      opensDoors: true,
      ignores: ["stalker"],
      targets: ["player"],
      radius: 14,
      maxHealth: SHOVEL_DAMAGE * 5,
      speed: PLAYER_SPEED * 2.0,
      creepSpeed: PLAYER_SPEED * 0.1, // once it sees a player in the dark it hunts
      watchedBy: ["player"], // whose gaze makes it back off
      damage: 100,
      attackCooldown: 1,
      harmlessIn: ["retreat"], // modes its touch does no harm in
      watchRange: CELL * 14, // a gaze counts out to the looker's look range, capped at this
      watchMargin: WATCH_MARGIN,
      retreatDistance: CELL * 12, // kept from every body it hunts when nowhere is out of sight
      retreatSeconds: 25,
      enragedSeconds: 10, // after a hurt
      repathInterval: 0.5,
      ambush: {
        lead: 5, // seconds of its quarry's straight walk it predicts
        walkSpeed: PLAYER_SPEED, // the quarry's assumed speed
        range: CELL * 4, // spots tried this far off the predicted way
        tries: 12,
        pathSamples: 4, // points along the way a spot must be hidden from
        betterBy: CELL, // a new spot must lie this much nearer the way
        interval: 1,
        pounce: CELL * 3, // hunts once the quarry has passed and stands this near
      },
      wander: { range: CELL * 6, pause: { min: 2, max: 5 } },
      sounds: { retreat: CELL * 6, enraged: CELL * 16, attack: CELL * 8 },
    },
    hoarder: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 50,
        tries: 24,
        unseenDistance: CELL * 14,
        group: { min: 3, max: 5, spread: CELL * 2 },
      },
      // Exploders ignored, or its bite would set them off by its nest.
      ignores: ["hoarder", "exploder"],
      radius: 13,
      maxHealth: SHOVEL_DAMAGE * 3,
      wanderSpeed: PLAYER_SPEED * 0.8,
      chaseSpeed: PLAYER_SPEED * 1.1,
      sightRange: CELL * 6,
      search: { count: 16, range: CELL * 15, tries: 64 }, // spots searched round its nest
      nestRadius: CELL * 4, // guarded
      dropRadius: CELL * 1.5,
      spookRange: CELL * 8,
      spookSeconds: 5,
      guardSeconds: 15,
      revengeRange: CELL * 5, // revenge ends once the thief is this near what it stole
      damage: 10,
      attackRange: 30,
      attackCooldown: 1,
      repathInterval: 0.5,
      chitterGap: { min: 5, max: 10 },
      sounds: {
        chitter: CELL * 4,
        alarm: CELL * 10,
        pickUp: CELL * 3,
        attack: CELL * 5,
      },
    },
    landMine: {
      radius: 8,
      armSeconds: 3,
      beepGap: 4,
      triggerRange: CELL * 2,
      ignores: ["landMine", "mineLayer"],
      fuse: 0.6, // seconds from trigger to blast
      blast: { radius: CELL * 2, centre: 120, edge: 60 },
      breaksWalls: false,
      sounds: {
        arm: CELL * 4,
        beep: CELL * 3,
        trigger: CELL * 6,
        blast: CELL * 40,
      },
    },
    mineLayer: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 10,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["mineLayer"],
      radius: 12,
      maxHealth: SHOVEL_DAMAGE,
      speed: PLAYER_SPEED,
      sightRange: CELL * 8, // all round
      treasure: "goldenScrap", // left where it arrives, and circled
      // Circles its treasure from min to max out and back, `step` further each lap, `leg` a leg.
      orbit: {
        min: CELL * 2,
        max: CELL * 24,
        step: CELL * 3,
        leg: CELL * 2,
        tries: 12,
      },
      layGap: { wander: 10, flee: 3 }, // seconds between mines
      mineSpacing: CELL, // never lays within this of another mine
      calmSeconds: 10, // seeing nothing, to stop fleeing
      // homePull: px from what it fears traded per px from home.
      flee: { leg: CELL * 4, tries: 12, homePull: 0.5, repathInterval: 0.5 },
      sounds: { lay: CELL * 3 },
    },
    livingWall: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 10,
        tries: 48,
        unseenDistance: CELL * 14,
      },
      ignores: ["livingWall"],
      radius: CELL * 0.45,
      maxHealth: SHOVEL_DAMAGE * 6,
      mass: 10,
      noticeRange: CELL * 10,
      speed: PLAYER_SPEED * 0.8, // only while no gaze is on it
      fleeSpeed: PLAYER_SPEED * SPRINT * 2,
      fleeSeconds: 3, // after a hurt
      flee: { leg: CELL * 6, tries: 12 },
      watchRange: CELL * 14,
      watchMargin: WATCH_MARGIN,
      damage: 80, // only to a body not facing it as it moves
      attackCooldown: 1,
      repathInterval: 0.5,
      sounds: { attack: CELL * 8, flee: CELL * 10, crumble: CELL * 10 },
    },
    gloom: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 10,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      radius: 12,
      maxHealth: 1,
      speed: PLAYER_SPEED * 2,
      sightRange: CELL * 10, // all round
      darkRadius: CELL * 5,
      // Picking whom to follow, a light-ignoring kind counts as this many fewer live, so it
      // prefers kinds that shun light.
      lightBlindHandicap: 100,
      followDistance: CELL * 2,
      leash: CELL * 16, // keeps following one out of sight within this
      repathInterval: 0.5,
      shroudSeconds: 1, // the dark lasts this long past its last renewal
      wanderRange: CELL * 8,
      wanderPause: { min: 1, max: 3 },
      humVolume: 0.6,
      sounds: { hum: CELL * 6, latch: CELL * 6, disperse: CELL * 8 },
    },
    doppelganger: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 10,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["doppelganger"],
      watchRange: CELL * 14,
      watchMargin: WATCH_MARGIN,
      radius: 14,
      maxHealth: 100,
      speed: PLAYER_SPEED,
      attackRange: CELL * 1.5, // runs at a body this near
      reach: 30, // bite reach
      damage: 35,
      attackCooldown: 2,
      unwatchedSeconds: 2, // then heads for where it last knew a body
      wanderRange: CELL * 6,
      lookSeconds: 2,
      lookSweep: 1.2, // radians either way
      repathDistance: CELL / 2,
      barkGap: { min: 6, max: 12 },
      barkRange: CELL * 4,
      holds: {
        chance: 0.3,
        items: ["shovel", "bandage", "walkie", "scrap"],
      },
      // by "rarity": fears kinds with spawn weight <= asRareAs; by "toughness": fears bodies
      // with full health >= toughness.
      fear: {
        by: "rarity",
        asRareAs: 50,
        toughness: SLEEPER_HEALTH,
        sprintSpeed: PLAYER_SPEED * SPRINT,
        flee: { leg: CELL * 8, tries: 12 },
        lookBackSeconds: 1.5,
      },
      // turn: a body it fells getting up as one of it.
      sounds: { attack: CELL * 5, startle: CELL * 4, turn: CELL * 8 },
    },
    thumper: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 20,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["thumper", "exploder"],
      radius: 16,
      maxHealth: SHOVEL_DAMAGE * 3,
      sprintShare: 1.2, // of a player's sprint
      minRun: CELL * 10, // straight runs this long unless a wall ends one
      turnSeconds: 0.8, // standing between runs
      sightRange: CELL * 8, // down its facing
      headingTries: 12,
      damage: 30,
      attackCooldown: 1,
      thumpInterval: 0.25,
      seeksDark: true, // false: pays light no mind
      rageSeconds: 6, // after a hurt, minding no light
      sounds: {
        thump: CELL * 12,
        slam: CELL * 10,
        attack: CELL * 5,
        recoil: CELL * 6,
        enrage: CELL * 10,
      },
    },
    tricycle: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 15,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["tricycle"],
      targets: ["player"],
      radius: 12,
      maxHealth: SHOVEL_DAMAGE * 4,
      speedShare: 1.3, // of a player's walk
      slowShare: 0.9, // with a player within slowRange ahead
      slowRange: CELL * 4,
      ride: {
        min: CELL * 14,
        max: CELL * 28,
        tries: 8, // spots round it
        through: 4, // spots past a player
        overshoot: { min: CELL * 6, max: CELL * 12 }, // past that player
        width: CELL, // prefers ways at least this wide
        near: CELL * 40, // while a player is about, only to spots this near one
        pass: CELL * 3, // a way this near a player passes them
        pull: 1.2, // a pass's score; setting off straight ahead scores 1, sideways 0
        rest: 15, // seconds after passing a player before it wants to again
        retry: 0.5, // seconds it waits to look again on finding no ride
        plansPerStep: 2, // tricycles planning a ride in one step; more wait a step
      },
      rage: {
        seconds: 6, // after a hurt
        speedShare: 2, // of a player's walk, past a sprint
        overshoot: CELL * 6, // past whatever hurt it
        reaim: 0.75, // seconds between aims at it
      },
      stall: { distance: CELL, seconds: 1 }, // less headway than this on a ride, it plans another
      bellRange: CELL * 8, // rings at a player this near on its way
      bellCooldown: 2,
      damage: 70,
      attackCooldown: 1,
      creakInterval: 0.8,
      sounds: {
        bell: CELL * 10,
        creak: CELL * 3,
        hit: CELL * 6,
        rage: CELL * 14,
      },
    },
    birthdayBoy: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 10,
        tries: 24,
        unseenDistance: CELL * 14,
        most: 8,
      },
      ignores: ["birthdayBoy"],
      radius: 14,
      maxHealth: SHOVEL_DAMAGE * 6,
      wanderShare: 0.6, // of a player's walk
      chaseShare: 0.8, // of a player's sprint
      wanderRange: CELL * 5,
      balloonGap: 10,
      maxBalloons: 10, // of its own about
      balloonSpacing: CELL,
      sightRange: CELL * 8, // down its facing
      guardRadius: CELL * 10, // round a popped balloon
      lingerSeconds: 10, // looking round a pop
      calmSeconds: 10, // with none seen, to calm
      repathInterval: 0.5,
      cryInterval: 10.8, // the rage cry's length
      damage: 30,
      attackCooldown: 1,
      sounds: { place: CELL * 3, angry: CELL * 12, attack: CELL * 5 },
      speech: {
        voice: "child",
        angryVoice: "shout",
        chatter: 0.5, // chance to speak per balloon placed
        placing: [
          "Happy birthday to me!",
          "This one is for my party.",
          "Everyone is invited!",
          "Don't touch my balloons.",
          "Is it time for cake yet?",
        ],
        enraged: [
          "You popped my balloon!",
          "That was mine!",
          "Who popped it?",
          "Now you can't come to my party!",
        ],
      },
    },
    balloon: {
      radius: 8,
      sounds: { pop: CELL * 20 },
    },
    apexPredator: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 15,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["apexPredator"],
      radius: 11,
      mass: 0.2,
      maxHealth: SHOVEL_DAMAGE * 7,
      speedShare: 1.4, // of a player's walk
      wanderShare: 1.0, // of a player's walk
      wanderRange: CELL * 8,
      sightRange: CELL * 7,
      followRange: CELL * 12, // keeps after its target, seen or not, until it is this far off
      standGap: CELL / 4, // stands this far in front of the body it notices
      repathInterval: 0.3,
      calmSeconds: 8,
      damage: 15,
      attackCooldown: 1,
      quackGap: { min: 4, max: 10 },
      angryGap: { min: 1, max: 3 },
      sounds: { quack: CELL * 4, angry: CELL * 10, attack: CELL * 4 },
    },
    peeper: {
      spawning: {
        weight: 10,
        after: 180,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["peeper"],
      targets: ["player"], // pulls and hurts players only; drop for any body with eyes
      radius: 12,
      maxHealth: SHOVEL_DAMAGE * 4,
      pullSeconds: 0.4, // to drag a body's facing onto it
      stare: { damagePerSecond: 10, interval: 0.5 },
      relocate: { after: 120, range: CELL * 14, retry: 5 },
      sounds: {
        seize: CELL * 8,
        stare: CELL * 6,
        squelch: CELL * 4,
        blink: CELL * 16,
      },
    },
    mimic: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 20,
        tries: 24,
        unseenDistance: CELL * 14,
        group: { min: 2, max: 4, spread: CELL * 2 },
      },
      ignores: ["mimic", "exploder"],
      radius: 10,
      mass: 0.5,
      maxHealth: SHOVEL_DAMAGE * 2,
      speedShare: 1.2, // of a player's walk
      wanderRange: CELL * 5,
      sightRange: CELL * 5, // down its facing
      noticeRange: CELL * 2, // a body this near stirs it while hiding
      hideSeconds: { min: 10, max: 30 },
      springDelay: { min: 0, max: 1 },
      revealSeconds: 0.1, // its burst of teeth on springing
      rehideAfter: 5, // seconds before it may copy the item it last copied again
      sameSpot: CELL, // what counts as near the item it last copied
      spacing: CELL / 2, // its hiding spot from any item or posing body
      hideRange: CELL * 8, // furthest it hides from the item it copies
      hideTries: 12, // spots drawn before it passes an item over for now
      repathInterval: 0.5,
      calmSeconds: 8,
      attackDamage: 35,
      attackRange: 30,
      attackCooldown: 2,
      sounds: { settle: CELL * 2, reveal: CELL * 10, attack: CELL * 5 },
    },
    spawner: {
      period: 10, // seconds between rolls
      nothing: 0.5, // chance a roll brings nothing at world start, falling to 0 by certainAfter
      certainAfter: END_GAME,
      headStart: 600, // seconds of rolls a new world starts with
    },
    // F3 menu. enabled: production hosts take requests too (always in dev and under ?debug);
    // cells: how far ahead it spawns; soundRange: the pop, which is not a noise.
    debugSpawn: { enabled: false, cells: 10, soundRange: CELL * 8 },
  },
  // weight: lb; uses: left out means unlimited; loot.weight: share of the loot a new world lays.
  items: {
    shovel: {
      weight: 15,
      uses: 30, // swings, hit or miss
      loot: { weight: 30, rarity: "common" },
      radius: 20,
      reach: 45,
      damage: SHOVEL_DAMAGE,
      knockback: 20,
      cooldown: 1,
      duration: 0.18,
      volume: 0.8,
      hitNoiseRadius: CELL * 14,
      missNoiseRadius: CELL * 3,
      wallNoiseRadius: CELL * 10,
    },
    handgun: {
      weight: 3,
      uses: 6,
      loot: { weight: 6, rarity: "uncommon" },
      damage: SHOVEL_DAMAGE * 2,
      range: CELL * 12,
      cooldown: 0.5,
      noiseRadius: CELL * 30,
      volume: 1,
      duration: 0.08,
      spark: 5,
    },
    shotgun: {
      weight: 8,
      uses: 2,
      loot: { weight: 3, rarity: "rare" },
      damage: SHOVEL_DAMAGE * 2, // per pellet
      range: CELL * 8,
      pellets: 6,
      arc: Math.PI / 6, // radians the pellets fan across
      cooldown: 1,
      noiseRadius: CELL * 36,
      volume: 1,
      duration: 0.12,
      spark: 7,
    },
    fuel: {
      weight: 30,
      loot: { weight: 15, rarity: "common" },
      seconds: 5, // of driving per can
      reach: CELL, // of the cruiser to pour it in
      cooldown: 0.5,
      volume: 0.8,
    },
    scrap: {
      weight: 15,
      value: 1, // credit when sold
      cashoutRadius: CELL * 3, // of the cruiser
      sellInterval: 0.25,
      volume: 0.8,
      dropNoiseRadius: CELL * 8,
      // danger: exponent on danger weight (1: where monsters spawn); offRoad 1: none on the road.
      scatter: {
        count: 50,
        seed: 2,
        clearance: CELL * 3,
        danger: 0.8,
        offRoad: 1,
      },
    },
    goldenScrap: {
      weight: 15,
      value: 5,
      cashoutRadius: CELL * 3,
      sellInterval: 0.25,
      volume: 0.8,
      dropNoiseRadius: CELL * 8,
      scatter: {
        count: 5,
        seed: 3,
        clearance: CELL * 3,
        danger: 3,
        offRoad: 1,
      },
    },
    // Seen and picked up only while it lies in deepdark.
    darkScrap: {
      weight: 15,
      value: 5,
      cashoutRadius: CELL * 3,
      sellInterval: 0.25,
      volume: 0.8,
      dropNoiseRadius: CELL * 8,
      scatter: {
        count: 25,
        seed: 4,
        clearance: CELL * 3,
        danger: 1,
        offRoad: 1,
      },
    },
    // Torn from a falling body with full health >= toughness; never laid as loot.
    heart: {
      weight: 2,
      value: 3,
      cashoutRadius: CELL * 3,
      sellInterval: 0.25,
      volume: 0.8,
      dropNoiseRadius: CELL * 4,
      scatter: { count: 0, seed: 8, clearance: CELL * 3, offRoad: 1 },
      toughness: SLEEPER_HEALTH,
      tearRange: CELL * 4, // how far its wet thud is heard
    },
    // Made only at a shrine; never runs down.
    ghostWalkie: {
      weight: 0,
      cooldown: 0.3,
      volume: 0.6,
      switchRange: CELL * 2,
      reach: CELL * 1.5, // ghosts hear speakers within this of it
    },
    flashlight: {
      weight: 0,
      uses: 300, // seconds of battery
      loot: { weight: 20, rarity: "common" },
      range: CELL * 14,
      angle: Math.PI * (2 / 9), // beam width, radians
      drain: 1, // uses a second while on
      cooldown: 0.25,
      volume: 0.6,
      clickNoiseRadius: CELL,
    },
    corpse: { weight: 50, volume: 0.8 },
    walkie: {
      weight: 0,
      uses: 480, // seconds of battery
      loot: { weight: 12, rarity: "common" },
      drain: 1,
      cooldown: 0.3,
      volume: 0.6,
      switchRange: CELL * 2,
      keyRange: CELL * 1.5,
      speakerNoise: 0.8, // share of the speech's own range its speaker carries
    },
    radio: {
      weight: 8,
      loot: { weight: 8, rarity: "uncommon" },
      cooldown: 0.3,
      volume: 0.7,
      switchVolume: 0.6,
      switchRange: CELL * 2,
      range: CELL * 20, // heard, and a noise
      noiseInterval: 1,
    },
    stunTrap: {
      weight: 4,
      uses: 1,
      loot: { weight: 6, rarity: "uncommon" },
      cooldown: 0.5,
      volume: 0.6,
      placeNoiseRadius: CELL,
    },
    turret: {
      weight: 12,
      uses: 1,
      loot: { weight: 3, rarity: "rare" },
      cooldown: 0.5,
      volume: 0.7,
      placeNoiseRadius: CELL * 1.5,
    },
    teleporter: {
      weight: 5,
      uses: 1,
      loot: { weight: 5, rarity: "uncommon" },
      cooldown: 0.5,
      volume: 0.6,
      placeNoiseRadius: CELL,
    },
    pocketball: {
      weight: 2,
      loot: { weight: 3, rarity: "rare" },
      cooldown: 0.5,
      range: CELL * 6, // throw distance
      volume: 0.7,
      throwNoiseRadius: CELL * 2,
      dropNoiseRadius: CELL * 2,
    },
    bomb: {
      weight: 6,
      uses: 1,
      loot: { weight: 4, rarity: "uncommon" },
      cooldown: 0.5,
      volume: 0.7,
      placeNoiseRadius: CELL * 1.5,
    },
    itemScanner: SCANNER,
    monsterScanner: SCANNER,
    flareGun: {
      weight: 3,
      uses: 3,
      loot: { weight: 6, rarity: "uncommon" },
      cooldown: 1,
      range: CELL * 10,
      volume: 0.8,
      noiseRadius: CELL * 12,
      duration: 0.12,
      spark: 6,
    },
    bandage: {
      weight: 1,
      uses: 1,
      loot: { weight: 12, rarity: "common" },
      heal: 0.75, // share of full health
      revive: 0.25, // share of full health a corpse gets up on
      reach: 45,
      radius: 20,
      cooldown: 1,
      duration: 0.4,
      volume: 0.7,
      noiseRadius: CELL * 1.5,
    },
    loot: {
      // Items a new world lays, each picked by loot weight. danger: exponent on danger weight;
      // offRoad: 1 lays none on the road. A scatter may also set its own danger `terms`.
      scatter: {
        count: 40,
        seed: 4,
        clearance: CELL * 3,
        danger: 0.8,
        offRoad: 1,
      },
      // Laid on top of the loot. spread "x": one in each equal band of the width, start to exit.
      guaranteed: [
        {
          item: "fuel",
          scatter: {
            count: 12,
            seed: 5,
            clearance: CELL * 3,
            spread: "x",
            danger: 1,
            offRoad: 1,
          },
        },
      ],
      // At the most dangerous spot: extra: chance of a second item; rarity: weight multipliers.
      danger: { extra: 0.5, rarity: { common: 1, uncommon: 2, rare: 4 } },
    },
  },
  moves: {
    kick: {
      reach: 32,
      radius: 18,
      damage: 8,
      knockback: 1.6, // kicker body lengths, less for heavier targets
      cooldown: 1.2,
      stamina: STAMINA_MAX * 0.2,
      lunge: { lengths: 1, seconds: 0.08 }, // lengths: kicker body lengths
      noiseRadius: CELL * 6,
    },
  },
  sim: { fixedDt: 1 / 60, maxCatchUpS: 30, maxStepsPerFrame: 240 },
  // full: px out at full volume; silent: px out at silence; pan: px for a full pan.
  voice: {
    full: 100,
    silent: 600,
    pan: 300,
    radio: { full: CELL, silent: CELL * 8, pan: 300 }, // a walkie's speaker
    // Between walkies: floor: breakup always present; rises past `clear` apart, total at `lost`.
    interference: { clear: CELL * 6, lost: CELL * 90, floor: 0.1 },
  },
  // Walkie speaker. Ranges go from `clean` (close walkies) to `worst` (far apart).
  voiceRadio: {
    band: { low: 300, high: 3000 }, // Hz
    honk: { frequency: 1800, gain: 6, q: 1 }, // Hz, dB
    crunch: { clean: 3, worst: 10, makeup: 0.35, steps: 32 }, // drive multiplier; steps: levels
    hiss: { clean: 0.04, worst: 0.3 }, // share of the voice's level
    squelch: { volume: 0.8, open: 0.1, close: 0.2 }, // open/close: seconds
    dropout: {
      clean: 0.05, // per second
      worst: 2, // per second
      length: { min: 0.05, max: 0.3 },
      depth: 0.05,
      swell: 2.5,
    },
    crackle: {
      clean: 0.3, // per second
      worst: 4, // per second
      length: { min: 0.01, max: 0.04 },
      volume: 0.7,
    },
  },
  voiceClips: {
    threshold: 0.4, // mic level 0..1 that starts a clip
    quietSeconds: 0.6, // under threshold this long ends it
    minSeconds: 1.5, // shorter clips are dropped
    maxSeconds: 5,
    keep: 8, // newest clips held
    bitsPerSecond: 32_000,
    pollMs: 50,
  },
  // What counts as speech, per mic frame.
  voiceDetector: {
    minLevel: 0.3, // 0..1 of -60..0 dBFS
    band: { low: 300, high: 3400 }, // Hz
    minBandShare: 0.4, // of the frame's power in the band
    maxFlatness: 0.3, // spectral flatness; white noise is near 0.56
    maxZeroCrossings: 0.2, // per sample
    onsetSeconds: 0.1, // must look like speech this long before it counts
    hangoverSeconds: 0.35, // keeps counting this long after the last
  },
  voiceConnections: {
    levelRampS: 0.05,
    connectDeadlineMs: 15_000,
    pending: { cap: 32, ttlMs: 5000 },
    retry: { firstMs: 2000, maxMs: 60_000 },
    statsIntervalMs: 1000,
  },
  audio: { full: 0, silent: 1000, pan: 500 }, // px, as `voice`
  ui: { debugRefreshMs: 250 },
  hud: { segmentsUpTo: 10 }, // an item with at most this many uses shows one bar segment per use
  // radius: cells round the followed player; size: px square at most.
  minimap: { radius: 12, size: 132, sweepMs: 2400 },
  worldLog: {
    enabled: true, // keeps it on in production; always on in dev and under ?debug
    capacity: 2000, // events kept
    quiet: ["item"], // kept but not printed
    monsterDeaths: false, // `log.kills()` still counts them
  },
} as const satisfies AppConfig;
