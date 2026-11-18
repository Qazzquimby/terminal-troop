import type { SpatialFalloff } from "./audio/index.js";
import type { EntitiesConfig } from "./entities/index.js";
import type {
  CameraConfig,
  FlashConfig,
  MapMemoryConfig,
  RippleConfig,
  SpectateConfig,
} from "./render/index.js";
import type { PositionMemoryConfig } from "./position-memory/index.js";
import type { RoomConfig } from "./room/index.js";
import type { SimClockConfig, SimConfig } from "./sim/index.js";
import type { ItemsConfig } from "./items/index.js";
import type { MovesConfig } from "./moves/index.js";
import type { GreetingConfig } from "./net/index.js";
import type { HudConfig, MinimapConfig, UiConfig } from "./ui/index.js";
import type { WheelConfig } from "./input/index.js";

import type {
  RadioSoundConfig,
  VoiceClipConfig,
  VoiceConnectionConfig,
  VoiceDetectorConfig,
  VoiceFalloff,
} from "./voice/index.js";
import type { WorldLogConfig } from "./world-log/index.js";

/** Every tunable, grouped by concern; each group has the shape its module declares. */
interface AppConfig extends SimConfig {
  readonly sim: SimClockConfig;
  readonly room: RoomConfig;
  /** For transports whose peers connect some time after joining. */
  readonly greeting: GreetingConfig;
  readonly camera: CameraConfig;
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
  readonly ui: UiConfig;
  readonly hud: HudConfig;
  readonly minimap: MinimapConfig;
  readonly wheel: WheelConfig;
  readonly worldLog: WorldLogConfig;
}

const CELL = 50;
const STAMINA_MAX = 100;
/** What one shovel hit deals; a gun's shot deals two. */
const SHOVEL_DAMAGE = 15;
/** The sleeper's full health: ten shovel hits. A body this hard to kill or harder drops a heart. */
const SLEEPER_HEALTH = SHOVEL_DAMAGE * 10;
/**
 * The sleeper's share of the spawner's picks. The doppelganger runs from any kind brought this
 * rarely or more rarely.
 */
const SLEEPER_SPAWN_WEIGHT = 50;
/** A player's walking pace, in pixels a second, and how much faster it sprints. */
const PLAYER_SPEED = 120;
const SPRINT = 1.8;
/**
 * How far past either edge of a body's view cone a kind held back by being looked at still counts
 * as looked at, so it does not stutter in and out at the edge: 10 degrees, in radians. Each such
 * kind takes it as its `watchMargin`, and may be given its own.
 */
const WATCH_MARGIN = (10 * Math.PI) / 180;
/**
 * Seconds into a world at which it reaches its end game: the spawner is at full pace, and groups
 * that grow with the world have grown to their full size. A world has no fixed length, so this
 * is where its threat stops rising.
 */
const END_GAME = 20 * 60;
/** Cells out from the exit that are dark by day and most dangerous. */
const EXIT_REACH = 20;
/**
 * How near a living player must be for a monster that keeps to its own patch to stir: 50 cells,
 * past any sight, hearing or noise that reaches a player. Farther off, it lies dormant, standing as
 * if stunned, so a big world's far monsters cost the host nothing. Kinds that roam the whole world
 * (the stalker, statue and snails), move with no player near (the sleeper as she relocates, the
 * ghost girl) or are placed rather than living (mines, turrets) never lie dormant.
 */
const DORMANT_BEYOND = CELL * 50;

// Scanners keep a flashlight's power: five minutes of battery, a use a second switched on.
// Each senses its targets 20 cells out, past a flashlight's 14, beeping every 1.5s for one at
// the edge of that, down to 8 times a second for one at its feet dead ahead; behind its
// holder a target counts a quarter as much as ahead. Its beep is heard, and is a noise, 4
// cells round; its click a cell. Uncommon, a little rarer than a flare gun, and light.
const SCANNER = {
  weight: 2,
  uses: 300,
  loot: { weight: 5, rarity: "uncommon" },
  range: CELL * 20,
  slowest: 1.5,
  fastest: 0.125,
  behind: 0.25,
  drain: 1,
  cooldown: 0.25,
  volume: 0.5,
  beepRange: CELL * 4,
  clickRange: CELL,
} as const;

export const config = {
  // A road 8 to 24 cells wide meanders left to right, bending every 16 columns by up to 8 rows,
  // with 3 to 7 cells of yard either side: clutter by a tenth of the tries by the road, nine
  // tenths at the yard's far edge. Past it, buildings of 3x3 to 9x9 rooms, a fifth of cuts laying a
  // 2-wide hallway up to 16 long, doors 1 to 3 wide. Each building (rooms sharing walls) is a tree of
  // doors with a tenth of its spare inner walls doored too, so a few ways loop, and 1 door out (6 in
  // 10), 2 (3 in 10) or 3 (1 in 10). The start is the road's first 6 columns, the exit its last 8.
  world: {
    cell: CELL,
    cols: 140,
    rows: 80,
    seed: 1,
    wallBounce: 0,
    generation: {
      road: { width: { min: 6, max: 12 }, step: 10, meander: 10, margin: 18 },
      yard: {
        depth: { min: 4, max: 10 },
        clutter: { near: 0.2, far: 0.9 },
        tries: 0.6,
      },
      rooms: {
        size: { min: 3, max: 9 },
        minCells: 6,
        solidChance: 0.3,
        hallwayChance: 0.2,
        hallway: { width: 2, length: 16 },
        door: { min: 1, max: 3 },
        loops: 0.1,
        exits: [0.6, 0.3, 0.1],
        building: { min: 3, max: 8 },
      },
      // Every room has a light fixture, and one in thirty has power to light it. The road and
      // yards are lit by sunlight while the day lasts, but for 20 cells round the exit, which is
      // dark. Monsters never appear in light.
      lights: { fixture: 1.0, powered: 1 / 30, exitShade: EXIT_REACH },
      // Monsters spawn, and loot is richer, up to 4x by distance from the road and 4x towards the
      // right: 16x at the far right corner over the road at the start. On top of that, +20 in the
      // exit itself, falling evenly to nothing 20 cells out: about 24x on the road at the exit,
      // half again the corners, so the way out is the most dangerous place in the world.
      danger: { road: 3, right: 3, exit: 20, reach: EXIT_REACH },
      start: 6,
      exit: 8,
    },
  },
  view: { width: 900, height: 600 },
  // One notch of scroll is 40px: under a click of most wheels (100px in Chromium, 3 lines of 16px
  // in Firefox) and a short trackpad flick. A part-notch is forgotten after a quarter second idle.
  wheel: { notch: 40, line: 16, page: 600, idleMs: 250 },
  // Eases out from 1:1 by a fifth of the gap each 60Hz frame. Follows the player by a quarter of
  // the gap each 60Hz frame: about 7px behind at a walk and 12px at a sprint, so a lunge leads
  // it. A jump of more than 4 cells, such as a respawn, is cut to rather than panned across.
  camera: {
    zoom: 1.25,
    zoomRate: 13.4,
    followRate: 18,
    snapDistance: CELL * 4,
  },
  // A ghost's free camera glides at 8 cells a second, nearly twice a sprint. Each notch of the
  // wheel zooms a ghost's view by a fifth, from half the living's zoom (twice as close) out to
  // two and a half times it (about 2.5x as wide), eased at the camera's own zoom rate.
  spectate: { speed: CELL * 8, zoom: { min: 0.5, max: 2.5, step: 1.2 } },
  // Noises the local player hears, each drawn as a ring snapping out to the noise's radius in
  // 0.15s, then fading over the rest of 0.9s. One made by something other than a player that it
  // can't see glows warm and soft at the screen's edge instead, the way it seemed to come from.
  ripples: {
    duration: 0.9,
    expand: 0.15,
    width: { sharp: 1.5, soft: 7 },
    alpha: { sharp: 0.2, soft: 0.05 },
    colour: "#9fd3ff",
    edge: {
      radius: 90,
      inset: 12,
      alpha: { sharp: 0.25, soft: 0.03 },
      colour: "#ffb070",
    },
  },
  // Terrain seen before and out of sight now: grey, the floor barely there, walls easier to read.
  // It fades like ink soaking away, from far to near: out of sight, terrain 6 cells from the
  // viewer (about the screen's edge) goes in 7 to 10s, in blots about 3 cells across, each
  // darkening faster as its time comes; 12 cells away twice as fast, 3 cells away half as fast,
  // so the ragged edge creeps inward toward the viewer. Terrain in sight is renewed 4x a second.
  mapMemory: {
    saveInterval: 5,
    maxRooms: 50,
    floor: { fill: "#181818", grid: "#2a2a2a", alpha: 0.4 },
    wall: { fill: "#5a5a5a", edge: "#6a6a6a", alpha: 0.5 },
    fade: {
      seconds: 10,
      spread: 0.3,
      blot: 3,
      detail: 4,
      refresh: 0.25,
      reach: 6,
      nearest: 1,
    },
  },
  // Where the player stands, saved every 2s while it moves, so a reload puts it back there.
  positionMemory: { saveInterval: 2, maxRooms: 50 },
  // A kick's flash: three quarters of its size at first, swelling to full as it fades over 0.3s.
  // A shot's flash streaks in on a thin pale-yellow tracer that fades with it.
  flashes: {
    duration: 0.3,
    start: 0.75,
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
    nameMax: 8,
    knockbackSeconds: 0.15,
    // The unit every body's mass is reckoned in: a body no heavier than its pusher takes the
    // whole push, a heavier one less, in proportion.
    mass: 1,
    // Every pound carried slows a player evenly, to 20% slower at 100lb and no slower past it:
    // a shovel and a scrap (30lb) cost 6%.
    load: { full: 100, slowdown: 0.5 },
    // A quiet click on switching slot, heard only by the one switching.
    switchVolume: 0.4,
  },
  stamina: {
    max: STAMINA_MAX,
    // A full bar lasts 6s.
    drain: STAMINA_MAX / 6,
    // Empty to full in 10s.
    regen: STAMINA_MAX / 10,
    regenDelay: 0.6,
    recover: STAMINA_MAX * 0.3,
  },
  // A player new to a world starts within 2 cells of its rally point, where the cruiser waits.
  arrival: { spread: CELL * 2 },
  // A player who falls drops what it carried within a cell of where it fell. Revived, it comes
  // back on half its health, near whatever revived it.
  death: { scatter: CELL, reviveHealth: 50 },
  // World entities act on one another, hunting, striking, setting off or catching, only while
  // both are within 15 cells of a living player: about a screen and a half across, so a fight a
  // player could see or hear plays out, and none wipes the world out off-screen (#360).
  engagement: { range: CELL * 15 },
  // A stunned player sees next to nothing, its view clearing over the last second of the stun,
  // its ears ringing at half volume until then, the ring fading out over a second.
  stunned: {
    darkness: 0.95,
    fadeOut: 1,
    ring: { volume: 0.5, fadeSeconds: 1 },
  },
  // A player looks down its cone, holding a statue and the like, out to 10 cells, light or no
  // light: past a flashlight's 6, short of a statue's 16-cell sight.
  vision: {
    coneAngle: Math.PI / 2,
    rays: 360,
    surroundingsRadius: CELL * 0.7,
    lookRange: CELL * 7,
    // Any part of a body in sight shows it, checked every quarter cell over its footprint: a
    // cruiser 4 cells across stays drawn while its nose is in view.
    footprintSpacing: CELL / 4,
  },
  light: { range: CELL * 6 },
  // A world starts at 8am and reaches midnight in 20 minutes, when the spawner hits its end game.
  // Afternoon comes 10 minutes in, and daylight recedes to the road's centre line until night,
  // 17 minutes in, when none is left. Each turn is marked by a sound, at half volume.
  day: {
    startHour: 8,
    midnight: END_GAME,
    afternoon: 10 * 60,
    night: 17 * 60,
    volume: 0.5,
  },
  // Deepdark, darker than night: lights reach half as far into it, and a body's own sight, a
  // player's 6 cells in the dark and every monster's eyes, half as far too. It is drawn wholly
  // black, but for the red eyes of what lurks in it, glimpsed for 0.6s every 4s. Remembered
  // terrain in it fades 3x as fast. Darkness, where no sunlight falls, sets out from the left
  // edge 3 minutes in and deepdark 6 minutes in; both reach the right edge at midnight, 20
  // minutes in. A gloom's darkness is deepdark too.
  deepdark: {
    light: 0.5,
    sight: 0.5,
    memoryFade: 3,
    eyes: { every: 4, for: 0.6, colour: "#ff3b30" },
    fronts: { dark: 3 * 60, deep: 6 * 60, end: END_GAME },
  },
  // A guest holds a hit it predicted for up to a second before the host confirms it. Bodies it
  // follows take 0.15s, one and a half snapshots at 10 a second, to reach each reported position,
  // so a late snapshot does not stop them. One reported 7 cells from its last, further than a
  // sprint carries in a second and a half, was moved there, as by a teleport (whose shortest jump
  // is 8 cells), and is placed there at once rather than streaking across.
  net: { smoothing: 12, glide: 0.15, predictionHold: 1, snap: CELL * 7 },
  // A noise 10 cells off seems to come from anywhere within 2.5 cells of it.
  noise: { blur: 0.25 },
  // Each step is heard by anything within its radius: a sprint carries well past a zombie's
  // sight, a walk a few cells, a crouch barely past arm's length.
  footsteps: {
    walk: { interval: 0.5, radius: CELL * 3 },
    sprint: { interval: 0.3, radius: CELL * 7 },
    crouch: { interval: 0.7, radius: 0 },
  },
  // Speech is judged by its loudest moment over the last 0.3, so the gaps between words don't
  // silence it. The mic level runs from -60 dBFS (0) to full scale (1): a quiet room sits below
  // 0.35 (-39 dBFS), talking at about 0.5 (-30 dBFS) carries 4 cells, under a walk's 5, and a
  // shout at 0.85 (-9 dBFS) or more carries 10, past a walk but short of a sprint's 16. Rounded to
  // whole cells, so a player reports a new radius only as its loudness steps; a speaker ripples
  // every 0.5s, a walking step's pace.
  voiceNoise: {
    window: 0.3,
    threshold: 0.35,
    full: 0.85,
    radius: { quiet: CELL * 2, loud: CELL * 10 },
    step: CELL,
    interval: 0.5,
  },
  // A clip of a player's speech goes out at most 64,000 base64 characters, about 47KB: a
  // recorder's 5s at 32kbps fits with room to spare, well inside a broadcast's 256KB.
  echoes: { maxChars: 64_000 },
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
    // A door, shut, in three in four of the world's 1-wide doorways (about a third of them, doorways
    // being 1 to 3 wide); a wider doorway gets none.
    // 300 health. A player within a cell and a bit of one works it; its swing carries 8 cells.
    // A body that opens doors takes half a second to; any other bashes it for 20 every second,
    // 15s to break one, and a route goes through one shut where that saves more than 10 cells.
    door: {
      radius: CELL / 2,
      maxHealth: 300,
      seed: 4,
      frequency: 0.75,
      reach: CELL * 1.2,
      openSeconds: 0.5,
      bash: { damage: 20, cooldown: 1 },
      toll: 10,
      sounds: { swing: CELL * 8, hit: CELL * 10, break: CELL * 16 },
    },
    zombie: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 100,
        tries: 24,
        unseenDistance: 700,
        // In groups of 1 to 5 as a world begins, 3 on average, growing to 5 to 11, 8 on average,
        // by its end game; a crowd that size wants room, so it spreads up to 3 cells.
        group: {
          min: 1,
          max: 5,
          spread: CELL * 3,
          grows: { min: 5, max: 11, by: END_GAME },
        },
      },
      radius: 15,
      // A person's weight, as a player's: a kick sends it as far as it would a player.
      mass: 1,
      // It hunts any living body but its own kind and exploders: a zombie that bit an exploder would
      // set it off, and a crowd of them would level the buildings before any player came.
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
      // A chase lasts 15s at most, then it turns away and pays what it sees no mind for 5s.
      chase: { limit: 15, rest: 5 },
      sounds: { bark: CELL * 8, alert: CELL * 10, attack: CELL * 5 },
    },
    // Four cells long and 2.4 across, the box it is drawn, meets walls, rams and is seen as. It
    // drives like a heavy car: up to 6 cells a second, 2s to accelerate, turning a full circle in
    // about 5s once past 3 cells a second, slower below. A can of fuel
    // drives it 15s, about 90 cells at speed; the gauge shows two cans. A player within half a
    // cell of its body can get in.
    cruiser: {
      length: CELL * 4,
      width: CELL * 2.4,
      handling: {
        speed: CELL * 6,
        reverse: CELL * 2,
        acceleration: CELL * 3,
        braking: CELL * 9,
        drag: CELL * 2,
        turnRate: 1.2,
        grip: CELL * 3,
      },
      reach: CELL / 2,
      burn: 1,
      // Under a quarter cell a second it stands, burning nothing: what it creeps at, throttled
      // nose-first into a wall at an angle.
      standing: CELL / 4,
      gauge: 30,
      // Its engine idles 3 cells off once a second, so a fuelled car is barely heard; driven, it
      // is heard 14 cells off twice a second, past a walk, short of a sprint.
      engine: {
        idle: { interval: 1, radius: 0 },
        drive: { interval: 0.5, radius: CELL * 14 },
      },
      // Losing half its top speed against a wall knocks the wall down and stops it dead, for 50
      // damage; the fifth crash breaks it down. Heard 20 cells off.
      crash: {
        speed: CELL * 3,
        damage: 50,
        breakdown: 250,
        noiseRadius: CELL * 20,
      },
      // From 2 cells a second it hurts what it hits as hard as a zombie has health, and shoves
      // it aside, once a half second each.
      ram: {
        speed: CELL * 2,
        damage: 50,
        cooldown: 0.5,
        noiseRadius: CELL * 10,
      },
      // Its horn, sounded by anyone inside, is heard 18 cells off: past a driven engine's 14,
      // short of a crash's 20.
      horn: { noiseRadius: CELL * 18, volume: 0.9 },
      // Two headlights at its front, one each side 38px from its middle, by the lamps drawn on
      // it, each a 40 degree cone reaching 12 cells.
      headlights: { range: CELL * 12, angle: Math.PI * (2 / 9), spread: 38 },
      // Everyone in the exit escapes once the cruiser has waited there 20s, and only while the
      // team has 30$ banked (#402): 30 scrap, about five of the shop's dearer wares. It keeps it.
      escape: { delay: 20, volume: 0.8, quota: 30 },
      // A corpse carried within a cell of the cruiser's body brings its player back beside it,
      // for 6$ of the team's credit, a pocketball's price, into debt if need be (#403).
      revive: { reach: CELL, volume: 0.3, cost: 6 },
      // Its door stands open: those inside are seen and struck like anyone where the car is.
      // Shutting it takes a fifth of its power, and shut it burns a twentieth a second, so a full
      // door stays shut 16s; open, it charges back to full in 50s. It thunks 3 cells out (#377).
      door: {
        close: 0.2,
        drain: 0.02,
        recharge: 0.01,
        volume: 0.8,
        range: CELL * 3,
      },
      // Its cabin stores 6 items, 2 rows of 3; an item going in or out clunks a cell off, inside
      // its body, so only something pressed against it hears.
      storage: { slots: 6, noiseRadius: CELL, volume: 0.7 },
      // Sells for the team's credit, which a scrap's sale adds 1 to, so a price is that many scrap.
      // A flare gun goes for 4, a teleporter 5, a bomb and a pocketball 6 and a turret 8, dear as
      // they are rare. The register rings 2 cells off.
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
      // Each ware is on sale with a 15% chance, 25 to 75% off (#404), drawn afresh by the host every
      // 2 minutes of world time, so a run sees a few rounds of sales without them churning.
      sales: { chance: 0.15, minOff: 25, maxOff: 75, every: 9999 },
      // The coin toss in the cabin's finances (#404): a fair coin, a second in the air, heard as
      // far as the shop's register.
      coinToss: { flight: 1.2, odds: 0.5, volume: 0.7, range: CELL * 2 },
      // Its radio plays as loud and as far as a radio carried about: heard, and a noise, 25 cells
      // round every second while it plays. Its dial clicks 2 cells out.
      radio: {
        volume: 0.2,
        range: CELL * 25,
        noiseInterval: 1,
        switchVolume: 0.6,
        switchRange: CELL * 2,
      },
    },
    // Arms 3s after it is put down, then beeps, heard 8 cells off. Whatever steps on it, anywhere
    // within its 30px radius, sets it off: a bang heard 12 cells off, a flash drawn 60px round, and
    // a flash that stuns for 5s every body, players included, whose eyes catch it within 5 cells,
    // lighting 8 cells round it for half a second. Its radius, its size and so how near a body must
    // step to set it off, was 10px; tripled so it is easier to walk into.
    stunTrap: {
      radius: 30,
      flash: 60,
      armSeconds: 3,
      stunRange: CELL * 5,
      stunSeconds: 5,
      light: { range: CELL * 8, seconds: 0.5 },
      sounds: { beep: CELL * 8, flash: CELL * 12 },
      volume: 0.8,
    },
    // Sets up 3s after it is put down, as the stun trap arms, then beeps, heard 8 cells off. Its
    // laser is a 10 degree beam out 12 cells, a handgun's reach, sweeping round once every 3s. It
    // locks on any living body it catches but players, inert things and items, chirping 4 cells
    // out, and half a second later fires a handgun's shot at it, then one every 2s, as loud as a
    // handgun. It holds 30 shots; spent, it still sweeps and locks on, but clicks dry, heard 2
    // cells off, where it would shoot. It has 100 health, four handgun shots or seven shovel hits,
    // and breaks with a crunch heard 10 cells off; a kick shoves it as it would a player.
    turret: {
      radius: 14,
      maxHealth: 100,
      ammo: 30,
      mass: 1,
      ignores: ["player"],
      armSeconds: 3,
      sight: { angle: Math.PI / 18, range: CELL * 12 },
      turnSeconds: 5,
      shot: {
        damage: SHOVEL_DAMAGE * 2,
        range: CELL * 12,
        interval: 2,
        aimSeconds: 0.5,
        spark: 5,
      },
      sounds: {
        beep: CELL * 8,
        lock: CELL * 4,
        shot: CELL * 30,
        break: CELL * 10,
        click: CELL * 2,
      },
      volume: 0.8,
    },
    // Charges 3s after it is laid, then beeps, heard 8 cells off. It sends whatever steps on it,
    // anywhere within its 48px radius, 8 to 30 cells the way it is aimed, to the first clear spot
    // of 24 drawn, with a flash a body wide and a warp heard 10 cells off at both ends; it charges
    // again over 3s and beeps. Its radius, its size and so how near a body must step to ride it,
    // was 16px; tripled so it is easier to walk onto.
    teleporter: {
      radius: 48,
      armSeconds: 3,
      rearmSeconds: 3,
      distance: { min: CELL * 8, max: CELL * 30 },
      tries: 24,
      flash: 30,
      sounds: { beep: CELL * 8, warp: CELL * 10 },
      volume: 0.8,
    },
    // The cruiser's teleporter locks on a body and takes it 3s later to within 2 cells of the
    // cruiser, as a revival or a new arrival lands, leaving what it carried where it stood. Its
    // charging hum is heard 8 cells round the body, as far as a teleporter pad's beep, warning it
    // and drawing what hunts it; a zap heard 10 cells off and a flash a body wide at both ends, as
    // a pad's warp; a fizzle heard 4 cells off if it loses the body.
    recall: {
      seconds: 3,
      spread: CELL * 2,
      flash: 30,
      sounds: { hum: CELL * 8, zap: CELL * 10, fizzle: CELL * 4 },
      volume: 0.8,
    },
    // A thrown pocketball flies 15 cells a second, so its 6 cells take 0.4s, and can't touch its
    // thrower until it has flown a cell. Each bounce taps 3 cells out; catching or letting out a
    // body flashes a body wide at both ends with a pop heard 8 cells off.
    pocketball: {
      radius: 6,
      speed: CELL * 15,
      grace: CELL,
      flash: 30,
      sounds: { bounce: CELL * 3, capture: CELL * 8, release: CELL * 8 },
      volume: 0.8,
    },
    // Goes off 3s after it is put down, Bomberman's way: a plus along the grid, each arm 8 cells
    // long. Each arm breaks through the first wall in its way and stops at the second, knocking it
    // down too. 100 damage, a player's whole health, to any body in it, wherever in it it stands;
    // its bang is heard 40 cells off, as the exploder's and a land mine's are.
    bomb: {
      radius: 12,
      fuse: 3,
      blast: { reach: 8, walls: 2, damage: 100 },
      sounds: { blast: CELL * 40 },
      volume: 1,
    },
    // A flare flies 12 cells a second, so its 10 cells take under a second, and stings a body it
    // strikes for 10. Landed, it burns for a minute, lighting 6 cells round it red, a player's own
    // sight in the dark; it lights as it flies too. It lands with a hiss heard 4 cells off and goes
    // out with a fizzle heard 2.
    flare: {
      radius: 4,
      speed: CELL * 12,
      damage: 10,
      light: { range: CELL * 6, tint: "rgba(255, 60, 40, 0.28)" },
      seconds: 60,
      sounds: { land: CELL * 4, out: CELL * 2 },
      volume: 0.7,
    },
    // A new world lays 2, by danger weight to the fifth, so they lie far off the road, rarer and
    // further out than golden scrap (cubed). An item counts as laid on one within a cell of its
    // middle, a step from where a player stands beside it; ghosts hear whoever speaks within 3
    // cells of it, about a conversation's distance. A heart brings a ghost back; a walkie becomes a
    // ghost walkie. The first offering is safe; each after it crumbles the shrine 1 time in 3. It
    // whispers every 6 to 14s, heard 4 cells off and making no noise, and glows a cell and a half
    // round. Its revival and transformation carry 6 cells, its crumbling 12.
    shrine: {
      radius: 14,
      scatter: { count: 2, seed: 7, clearance: CELL * 20, danger: 5 },
      reach: CELL,
      earReach: CELL * 3,
      revives: "heart",
      transforms: { walkie: "ghostWalkie" },
      safeOfferings: 1,
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
    // None in the first 4 minutes of a world, never within 14 cells of a player. It creeps after a
    // player it picks, standing while there is none, at a fifth of a player's walk, kills
    // whatever it touches, at most once a second, and replans its way every 2 seconds. No monster
    // hunts or strikes it: its kind carries the unnoticed tag. It would rather arrive far from
    // any snail, giant or not: a spot within 40 cells of one, over a quarter of the world's width,
    // is that much less likely, falling to never touching one.
    snail: {
      spawning: {
        weight: 10,
        after: 240,
        tries: 24,
        unseenDistance: CELL * 14,
        apart: { from: ["snail", "giantSnail"], distance: CELL * 40 },
      },
      radius: 12,
      ignores: ["snail", "giantSnail"],
      targets: ["player"],
      speedShare: 0.2,
      damage: 500,
      attackCooldown: 1,
      repathInterval: 2,
    },
    // The snail's big sister, rarer and later: none in the first 8 minutes of a world. Two cells
    // by two, as the blind dog is, and at 0.3 of a player's walk somewhat faster. Where breaking
    // a wall is quicker than going round it presses into the wall, and after 5 seconds of it the
    // wall comes down. Its grind, once a second as it presses, carries 8 cells; the crumble 16,
    // short of the noise that wakes a sleeper. It keeps apart from other snails as the snail does.
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
        seconds: 5,
        grindGap: 1,
        sounds: { grind: CELL * 8, crumble: CELL * 16 },
      },
    },
    // The ghost girl haunts one player, picked at random, rare and none in the first 5 minutes.
    // She stays away 20s to 3min, then appears 4 to 12 cells off, at least 90 degrees past the
    // edge of her target's view cone (so within the 90 degrees straight behind it), with a clear
    // line to it; trying 24 spots, then again half a second later. She stares with 15 patience,
    // losing 1 a second, 2 more while unseen and 1 more while looked at. From 3 anger a look sets
    // her on her target 30% of the time, 10% more for each anger past 3. She chases at half a
    // sprint, a tenth of a sprint faster per anger past 3, never past 1.2 sprints, for 5 to 10s,
    // then flickers for 0.8s and vanishes. Touching her costs 20 health a second, 5 every 0.25s.
    // Slipping away, she walks at sprint to a spot within 8 cells her target cannot see,
    // trying 12 a step for 2s before making for the nearest wall; after 10s she is gone anyway.
    // Her sounds carry 16 cells, past the furthest she appears.
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
      absent: { min: 20, max: 180 },
      appear: {
        near: CELL * 4,
        far: CELL * 12,
        behind: Math.PI / 2,
        tries: 24,
        retry: 0.5,
      },
      patience: { start: 15, drain: 1, unseen: 2, watched: 1 },
      chase: {
        from: 3,
        chance: 0.3,
        chancePerAnger: 0.1,
        speed: 0.5,
        speedPerAnger: 0.1,
        maxSpeed: 1.2,
        seconds: { min: 5, max: 10 },
      },
      hide: {
        range: CELL * 8,
        tries: 12,
        search: 2,
        speed: 1,
        giveUp: 10,
      },
      flicker: 0.8,
      contact: { damage: 5, interval: 0.25 },
      soundRange: CELL * 16,
    },
    // A blind hound, can spawn in light or darkness, never arriving within 30 cells of a
    // player. Five shovel hits fell it; touching it costs 100 health, once a second.
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
      // Within 6 cells of its target, with a clear line, it crouches 0.3s, growling, then dashes
      // at 1.8x a player's sprint through the target and 8 cells (`overrun`) on, unsteered, then
      // skids a cell and finds its feet in 0.6s. A player already moving sideways as it growls
      // is out of the line before it lands.
      pounce: {
        reach: CELL * 6,
        windup: 0.3,
        speed: PLAYER_SPEED * SPRINT * 4.0,
        recover: 0.6,
        skid: CELL,
      },
      wanderRange: CELL * 8,
      wanderPause: { min: 1, max: 3 },
      repathDistance: CELL,
      // Suspicion counts how loud each noise was where it stood, in pixels past it the noise
      // carried, and ebbs 2 cells' worth a second. It charges at 25 cells' worth: at a gunshot
      // within 5 cells at once, at a walk 2 cells off in about 6s, at a sprint 5 cells off in
      // under a second.
      suspicion: { max: CELL * 25, decay: CELL * 2 },
      // A pounce runs 8 cells past its target.
      overrun: CELL * 8,
      // Within 3 cells of the body making the noise it goes straight for it and bites. Kept 8
      // seconds near a noise biting nothing (a radio lying about, a body out of reach), it gives
      // up and pays that maker no mind for 20 seconds.
      lunge: CELL * 3,
      patience: 8,
      boredSeconds: 20,
      // It barks every 10 to 16s as it roams or stalks, a little more often than a dormant
      // sleeper, so a player hears it coming. Other blind dogs pay it no mind.
      barkGap: { min: 10, max: 16 },
      // Its roar carries 25 cells, its snarl as it turns to a noise 4, its bite 6, its huff as it
      // gives up 4, its growl as it crouches to pounce 5, its roar as it leaps 15, its skid 5, its
      // bark 10.
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
    // A swollen thing out of the dark, never within 14 cells of a player. It comes alone as a world
    // begins, in groups of 2 to 4, 3 on average, by its end game, up to 3 cells apart. It feels
    // prey through walls 12 cells round.
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
      // It passes over the crowds, zombies and hoarder beetles, or it would spend itself and the
      // walls round it on the first it felt; players and the rarer monsters it hunts.
      ignores: ["exploder", "zombie", "hoarder"],
      maxHealth: SHOVEL_DAMAGE * 2,
      wanderSpeed: PLAYER_SPEED,
      chaseSpeed: PLAYER_SPEED,
      // Once its fuse is lit it slows to half a player's walk, so whoever it chases can get clear.
      litSpeed: PLAYER_SPEED * 0.65,
      senseRange: CELL * 12,
      wanderRange: CELL * 5,
      wanderPause: { min: 0.5, max: 2 },
      repathDistance: CELL / 2,
      // A route more than twice as long as the straight line, plus 2 cells, is too long: it
      // heads straight at its prey instead, and sets itself off at the wall in the way.
      detour: { factor: 2, slack: CELL * 2 },
      // Within 2 cells of a body it hunts it lights a 1s fuse, and keeps coming. Any hurt lights it
      // too, but another exploder's burst, so one burst does not set off every exploder near it.
      fuseRange: CELL * 1.5,
      fuseOnHurt: { minDamage: 0, except: ["exploder"] },
      fuse: 2.0, // seconds
      // Bursts 3 cells round, knocking the walls there down: 100 damage where it stands, 30 at
      // the edge. The fuse hisses 6 cells out; the burst is heard 40 cells off.
      blast: { radius: CELL * 3, centre: 100, edge: 30 },
      sounds: { fuse: CELL * 6, blast: CELL * 40 },
    },
    // She arrives in the dark, never within 14 cells of a player. Five shovel hits fell her. She
    // sees 8 cells all round her, wakes to any body she sees within 5 cells if it is still there
    // after her 1s growl, and
    // rages 10s; she runs at a player's sprint. Enraged, she hits as hard as the shovel does
    // thrice, once a second, and wanders 8 cells at a time. She sleeps again 10 to 20 cells off,
    // at least 12 from every body she hunts. Her bark carries 8 cells every 3 to 6s while dormant;
    // enraged, every 1.5 to 3s, 12 cells; her growl 6, her scream as she wakes 16. Any noise she
    // hears that carries 18 cells (a cell taken as a metre), a horn, a gunshot, a crash, a blast,
    // wakes her screaming and draws her to it. Asleep 2 minutes with no body she hunts within 14
    // cells, she moves to wherever she might have arrived, trying again every 5s while a player
    // stands within 14 cells to watch her go or she finds nowhere; her whisper as she goes and
    // comes carries 16 cells, just past where anyone could see it.
    sleeper: {
      spawning: {
        weight: SLEEPER_SPAWN_WEIGHT,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["sleeper"],
      radius: 15,
      maxHealth: SLEEPER_HEALTH,
      sightRange: CELL * 8,
      wakeRange: CELL * 5,
      runShare: 1.1,
      warnSeconds: 1,
      rageSeconds: 10,
      wanderRange: CELL * 8,
      repathDistance: CELL / 2,
      attackDamage: SHOVEL_DAMAGE * 3,
      attackCooldown: 1,
      barkGap: {
        dormant: { min: 1, max: 5 },
        enraged: { min: 1.5, max: 3 },
      },
      retreat: {
        distance: { min: CELL * 10, max: CELL * 20 },
        clearance: CELL * 12,
        tries: 16,
      },
      alarmRadius: CELL * 18,
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
    // None in the first 3 minutes of a world; it arrives in the dark, never within 14 cells of a
    // player. It
    // sees 16 cells all round it and walks a round 30 cells long, give or take 5, planning it
    // anew every 2s while no leg can be found. A hunt lasts 10s of moving, its route to its
    // quarry planned every quarter second. Its touch deals 90, once a second. Its tread carries 14
    // cells, between a walk and a sprint, every 0.3s, a sprint's pace; its blow 8.
    statue: {
      spawning: {
        weight: 5,
        after: 180,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["statue"],
      // It hunts players alone, though its blow still lands on any body it touches.
      targets: ["player"],
      radius: 16,
      // Solid stone: a kick or a swing barely rocks it, a tenth of the way it would a player.
      mass: 10,
      sightRange: CELL * 16,
      patrol: { distance: CELL * 30, spread: CELL * 5, tries: 16, retry: 2 },
      huntSeconds: 10,
      repathInterval: 0.25,
      damage: 90,
      attackCooldown: 1,
      step: { interval: 0.3, range: CELL * 10 },
      strikeRange: CELL * 8,
    },
    // Alone, in the dark: none in the first 4 minutes of a world, never within 30 cells of a
    // player. Five shovel hits fell it; it moves at 1.2 times a walk, creeping at 0.1 times a walk
    // once it sees a player in the dark it hunts, and touching it costs 100 health, once a second.
    // Only a player's gaze counts: a player sees it down its view cone, 10 degrees wider each side,
    // as far as it looks, 10 cells, but never past 14, as far as a flashlight reaches. Seen, it
    // backs off for 25s, out of every player's sight within 14 cells by the quickest way, or where
    // none is out of sight keeping 12 cells from every body it hunts; hurt, it rages for 10s. With
    // no player in the dark it heads home and wanders up to 6 cells round it, standing 2 to 5s
    // between legs. It replans twice a second. Its hiss as it backs off carries 6 cells, its
    // shriek of rage 16, its strike 8. It opens the closed doors in its way, in half a second
    // (see `door`), rather than bashing them.
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
      creepSpeed: PLAYER_SPEED * 0.1,
      watchedBy: ["player"],
      damage: 100,
      attackCooldown: 1,
      watchRange: CELL * 14,
      watchMargin: WATCH_MARGIN,
      retreatDistance: CELL * 12,
      retreatSeconds: 25,
      enragedSeconds: 10,
      repathInterval: 0.5,
      wander: { range: CELL * 6, pause: { min: 2, max: 5 } },
      sounds: { retreat: CELL * 6, enraged: CELL * 16, attack: CELL * 8 },
    },
    // Groups of 3 to 5 sharing a nest, never arriving within 14 cells of a player. Three shovel hits fell one. It forages at 0.8 times a walk and chases at 1.1, sees 6 cells,
    // and searches 16 spots up to 15 cells from its nest. It guards 4 cells round the nest for 15s,
    // is spooked by any body within 8 cells for 5s, and bites its quarry for 10 once a second. A
    // nest's revenge lasts until the thief is 5 cells from what it stole. Its chitter carries 4
    // cells every 5 to 10s, its alarm 10, its pick-up 3, its bite 5.
    hoarder: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 50,
        tries: 24,
        unseenDistance: CELL * 14,
        group: { min: 3, max: 5, spread: CELL * 2 },
      },
      // It leaves exploders be, or its bite would set them off by its nest.
      ignores: ["hoarder", "exploder"],
      radius: 13,
      maxHealth: SHOVEL_DAMAGE * 3,
      wanderSpeed: PLAYER_SPEED * 0.8,
      chaseSpeed: PLAYER_SPEED * 1.1,
      sightRange: CELL * 6,
      search: { count: 16, range: CELL * 15, tries: 64 },
      nestRadius: CELL * 4,
      dropRadius: CELL * 1.5,
      spookRange: CELL * 8,
      spookSeconds: 5,
      guardSeconds: 15,
      revengeRange: CELL * 5,
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
    // Arms 3s after it is laid, beeping 4 cells round, then beeps every 4s, heard 3 cells off. Any
    // body within 2 cells of it, but another mine or a mine layer, sets it off: a beep heard 6
    // cells off, and 0.3s later a burst 2 cells round, 120 damage where it lies and 60 at the edge,
    // heard 40 cells off as the exploder's is. It leaves the walls standing.
    landMine: {
      radius: 8,
      armSeconds: 3,
      beepGap: 4,
      triggerRange: CELL * 2,
      ignores: ["landMine", "mineLayer"],
      fuse: 0.6,
      blast: { radius: CELL * 2, centre: 120, edge: 60 },
      breaksWalls: false,
      sounds: {
        arm: CELL * 4,
        beep: CELL * 3,
        trigger: CELL * 6,
        blast: CELL * 40,
      },
    },
    // Alone, in light or dark, none in the first 2 minutes of a world, never within 14 cells of a
    // player; as rare as the stalker. One shovel hit fells it; it moves at a player's walk and sees
    // 8 cells all round it. It leaves golden scrap where it arrives and circles it, from 2 cells out
    // to 24, each lap 3 cells further out and then back in, 2 cells a leg, laying a mine every 10s,
    // never within a cell of another. Seeing any body but its own kind, it flees 4 spots off at a
    // time, the best of 12, a cell of distance from home costing half a cell of distance from what
    // it fears, replanning twice a second and laying a mine every 3s, until it has seen none for
    // 10s. Laying a mine clicks 3 cells off.
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
      sightRange: CELL * 8,
      treasure: "goldenScrap",
      orbit: {
        min: CELL * 2,
        max: CELL * 24,
        step: CELL * 3,
        leg: CELL * 2,
        tries: 12,
      },
      layGap: { wander: 10, flee: 3 },
      mineSpacing: CELL,
      calmSeconds: 10,
      flee: { leg: CELL * 4, tries: 12, homePull: 0.5, repathInterval: 0.5 },
      sounds: { lay: CELL * 3 },
    },
    // Alone, against a wall, in the dark: none in the first 2 minutes of a world, never within 14
    // cells of a player; as rare as the stalker. Stone: six shovel hits fell it, and it is as hard
    // to push as the statue. It moves on a body within 10 cells at 0.8 times a walk, while no
    // body's gaze falls on it within 14 cells, the stalker's watch range. Touching one that is
    // not facing it as it moves costs 80 health, once a second. Hurt, it flees at twice a sprint
    // for 3s, 6 cells a leg, the best of 12. It replans twice a second. Its blow carries 8 cells,
    // its grinding flight 10, its crumbling death 10.
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
      speed: PLAYER_SPEED * 0.8,
      fleeSpeed: PLAYER_SPEED * SPRINT * 2,
      fleeSeconds: 3,
      flee: { leg: CELL * 6, tries: 12 },
      watchRange: CELL * 14,
      watchMargin: WATCH_MARGIN,
      damage: 80,
      attackCooldown: 1,
      repathInterval: 0.5,
      sounds: { attack: CELL * 8, flee: CELL * 10, crumble: CELL * 10 },
    },
    // Alone, in the dark, none in the first 3 minutes of a world, never within 14 cells of a
    // player; as rare as the stalker. Any blow breaks it: 1 health. It moves at twice a walk and
    // sees 10 cells all round it. Its darkness reaches 5 cells. Weighing rarity, it counts a kind
    // that ignores light as 100 more than live, so it takes a kind that shuns light first, and one
    // that ignores light only with none of those in sight. It keeps within 2 cells of whom it
    // follows, chooses anew and replans twice a second, and keeps following one it has lost sight
    // of within 16 cells. Its shroud lasts 1s past its last renewal. With no one to follow it
    // drifts up to 8 cells a leg, hanging 1 to 3s between legs. Its hum carries 6 cells, at 0.6;
    // its breath as it takes someone up 6, its sigh as it breaks 8.
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
      sightRange: CELL * 10,
      darkRadius: CELL * 5,
      lightBlindHandicap: 100,
      followDistance: CELL * 2,
      leash: CELL * 16,
      repathInterval: 0.5,
      shroudSeconds: 1,
      wanderRange: CELL * 8,
      wanderPause: { min: 1, max: 3 },
      humVolume: 0.6,
      sounds: { hum: CELL * 6, latch: CELL * 6, disperse: CELL * 8 },
    },
    // Alone, in the dark: none in the first 3 minutes of a world, never within 14 cells of a
    // player; as rare as the stalker. A player's size, health and walk. Watched by any body within
    // 14 cells, the stalker's watch range, it wanders up to 6 cells a leg, looking round 2s at
    // each stop, its head turning up to about 70 degrees either way. Unwatched for 2s, it heads for
    // where it last saw or heard a body. Any body within 1.5 cells it runs at and bites as a zombie
    // does: 35 within 30px, every 2s, heard 5 cells off. It speaks every 6 to 12s, heard 4 cells
    // off, as far as talking carries. Three in ten arrive holding a shovel, a bandage, a walkie or
    // scrap.
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
      attackRange: CELL * 1.5,
      reach: 30,
      damage: 35,
      attackCooldown: 2,
      unwatchedSeconds: 2,
      wanderRange: CELL * 6,
      lookSeconds: 2,
      lookSweep: 1.2,
      repathDistance: CELL / 2,
      barkGap: { min: 6, max: 12 },
      barkRange: CELL * 4,
      holds: {
        chance: 0.3,
        items: ["shovel", "bandage", "walkie", "scrap"],
      },
      // Seeing a monster the spawner brings as rarely as the sleeper or more rarely (spawning
      // weight 50 or less: not zombies nor exploders), it sprints at a player's sprint to the
      // best of 12 spots 8 cells off, stands 1.5s looking back, and, seeing nothing, walks
      // another 8 cells off. Its gasp carries 4 cells, as far as talking.
      fear: {
        asRareAs: SLEEPER_SPAWN_WEIGHT,
        sprintSpeed: PLAYER_SPEED * SPRINT,
        flee: { leg: CELL * 8, tries: 12 },
        lookBackSeconds: 1.5,
      },
      // A body it fells getting up as one of it is heard 8 cells off.
      sounds: { attack: CELL * 5, startle: CELL * 4, turn: CELL * 8 },
    },
    // Alone, 2 minutes into a world on, never within 14 cells of a player; twice as common as the
    // stalker. A little bigger than a player; three shovel hits fell it. It runs at 1.2 times a
    // player's sprint in straight runs of 10 cells at least, a wall ending one sooner, standing
    // 0.8s to turn between them, trying 12 headings for a run with nothing to make for. It sees 8
    // cells down its facing, as a zombie does, and makes for any body it sees or that hurts it,
    // but its own kind and exploders, which it would set off. It strikes what it touches for 30,
    // once a second. Its feet thump 4 times a second, heard 12 cells off, past a sprint's 7; a
    // slam into a wall carries 10, a blow 5.
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
      sprintShare: 1.2,
      minRun: CELL * 10,
      turnSeconds: 0.8,
      sightRange: CELL * 8,
      headingTries: 12,
      damage: 30,
      attackCooldown: 1,
      thumpInterval: 0.25,
      sounds: { thump: CELL * 12, slam: CELL * 10, attack: CELL * 5 },
    },
    // Alone, 3 minutes into a world on, never within 14 cells of a player; as rare as the stalker.
    // Smaller than a player; four shovel hits break it. It rides at 1.3 times a walk, to spots 10
    // to 25 cells off, of 12 tried the one setting off most nearly the way it heads, along ways 2
    // cells wide where there are any. It runs down players alone, passing through every other
    // body: one within 8 cells on its way hears its bell, at most every 2s, heard 10 cells off;
    // one within 4 cells ahead slows it to 0.9 times a walk; one it touches takes 70, once a
    // second. Its wheels creak every 0.8s, heard 3 cells off; a body run down, 6.
    tricycle: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 40,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      ignores: ["tricycle"],
      targets: ["player"],
      radius: 12,
      maxHealth: SHOVEL_DAMAGE * 4,
      speedShare: 1.3,
      slowShare: 0.9,
      slowRange: CELL * 4,
      ride: { min: CELL * 10, max: CELL * 25, tries: 12, width: CELL },
      bellRange: CELL * 8,
      bellCooldown: 2,
      damage: 70,
      attackCooldown: 1,
      creakInterval: 0.8,
      sounds: { bell: CELL * 10, creak: CELL * 3, hit: CELL * 6 },
    },
    // Alone, 3 minutes into a world on, never within 14 cells of a player; as rare as the stalker,
    // and never more than 8 about, one to each colour. Player-sized; six shovel hits fell it. It
    // wanders legs of up to 5 cells at 0.6 times a walk, leaving a balloon every 10s, at most 10
    // of its own about and none within a cell of another. One popping sends it at 0.8 times a
    // sprint to the spot, where it looks round 10s; any killable body it sees within 10 cells of
    // the spot, or whatever hurts it, enrages it, and it chases where it last saw one at 0.8 times
    // a sprint, replanning every 0.5s, striking what it touches for 30 a second, until 10s pass
    // with none seen. It sees 8 cells down its facing, as a zombie does. A balloon set down is
    // heard 3 cells off, its rage cry 12, a blow 5.
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
      wanderShare: 0.6,
      chaseShare: 0.8,
      wanderRange: CELL * 5,
      balloonGap: 10,
      maxBalloons: 10,
      balloonSpacing: CELL,
      sightRange: CELL * 8,
      guardRadius: CELL * 10,
      lingerSeconds: 10,
      calmSeconds: 10,
      repathInterval: 0.5,
      damage: 30,
      attackCooldown: 1,
      sounds: { place: CELL * 3, enrage: CELL * 12, attack: CELL * 5 },
    },
    // A birthday boy's balloon, small; its pop is heard 20 cells round.
    balloon: {
      radius: 8,
      sounds: { pop: CELL * 20 },
    },
    // The apex predator, a duck, light and small. Calm, it goes at 1.1 times a walk to stand a
    // quarter cell in front of the nearest body it notices within 6 cells, quacking every 4 to 10s
    // heard 4 cells off; with no one about it ambles legs of up to 4 cells at half a walk. Hurt, it
    // chases whatever hurt it, then any killable body it sees, at 1.1 times a walk, so a sprint
    // outruns it, pecking for 15 a second, an angry quack every 1 to 3s heard 10 cells off, until
    // 8s pass with none seen. Three shovel hits fell it; a fifth of a player's mass, a blow sends
    // it five times as far.
    apexPredator: {
      dormantBeyond: DORMANT_BEYOND,
      spawning: {
        weight: 15,
        tries: 24,
        unseenDistance: CELL * 14,
        most: 6,
      },
      ignores: ["apexPredator"],
      radius: 11,
      mass: 0.2,
      maxHealth: SHOVEL_DAMAGE * 3,
      speedShare: 1.1,
      wanderShare: 0.5,
      wanderRange: CELL * 4,
      sightRange: CELL * 6,
      standGap: CELL / 4,
      repathInterval: 0.3,
      calmSeconds: 8,
      damage: 15,
      attackCooldown: 1,
      quackGap: { min: 4, max: 10 },
      angryGap: { min: 1, max: 3 },
      sounds: { quack: CELL * 4, angry: CELL * 10, attack: CELL * 4 },
    },
    // The world's spawner rolls every 10s. As a world begins half the rolls bring nothing, the
    // chance falling evenly until, 20 minutes in, every roll brings something: one every 20s at
    // first, one every 10s from then on. Each roll that brings something picks a kind by its
    // `spawning.weight`. A new world starts with 5 minutes of rolls at the starting chance:
    // about 15 spawns.
    spawner: {
      period: 2,
      nothing: 0.7,
      certainAfter: END_GAME,
      headStart: 300,
    },
  },
  // Each item's weight in pounds; its uses, unlimited when left out; and its loot weight, its
  // share of the loot a new world lays, with its rarity.
  items: {
    // Wears out after 30 swings, hits and misses alike.
    shovel: {
      weight: 15,
      uses: 30,
      loot: { weight: 30, rarity: "common" },
      radius: 20,
      reach: 45,
      damage: SHOVEL_DAMAGE,
      knockback: 20,
      cooldown: 1,
      duration: 0.18,
      volume: 0.8,
      // A swing that hits rings out 14 cells; a miss whooshes 3; one that only clangs off a wall
      // carries 10, short of a hit.
      hitNoiseRadius: CELL * 14,
      missNoiseRadius: CELL * 3,
      wallNoiseRadius: CELL * 10,
    },
    // Six shots, each as hard as two shovel hits, straight out 12 cells, at most two a second.
    // The loudest thing a player does: heard 30 cells off, nearly twice a sprint. Rarer than a
    // shovel by five, and light.
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
    // Two blasts, each six handgun shots fanned across 30 degrees, out 8 cells; louder still.
    // Rarer than the handgun by half, and heavier.
    shotgun: {
      weight: 8,
      uses: 2,
      loot: { weight: 3, rarity: "rare" },
      damage: SHOVEL_DAMAGE * 2,
      range: CELL * 8,
      pellets: 6,
      arc: Math.PI / 6,
      cooldown: 1,
      noiseRadius: CELL * 36,
      volume: 1,
      duration: 0.12,
      spark: 7,
    },
    // A heavy can, 30lb, worth 15s of driving, poured in within a cell of the cruiser. Laid
    // half as often as a shovel: about three in a world of 20 items, enough to cross it.
    fuel: {
      weight: 30,
      loot: { weight: 15, rarity: "common" },
      seconds: 5,
      reach: CELL,
      cooldown: 0.5,
      volume: 0.8,
    },
    // Sells within 3 cells of the cruiser, a scrap every quarter second, from any slot. Dropped, by a
    // player or a hoarder, it clatters 8 cells round, which monsters hear. A new world lays 50,
    // favouring danger as much as monsters do, so it lies where they spawn.
    scrap: {
      weight: 15,
      value: 1,
      cashoutRadius: CELL * 3,
      sellInterval: 0.25,
      volume: 0.8,
      dropNoiseRadius: CELL * 8,
      scatter: {
        count: 50,
        seed: 2,
        clearance: CELL * 3,
        danger: 1,
        offRoad: 1,
      },
    },
    // Scrap worth 5, sold, carried and dropped as plain scrap is. A new world lays only 5, a tenth
    // as many as plain scrap, favouring danger thrice over as strongly as monsters do: its spots
    // are drawn by danger weight cubed, so the most dangerous corner is 4096 times as likely as the
    // road at the start, where plain scrap's is 16.
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
    // Scrap worth 3, sold, carried and dropped as plain scrap is, but seen and picked up only
    // while it lies in deepdark. A new world lays 25, half as many as plain scrap, favouring
    // danger as plain scrap does.
    darkScrap: {
      weight: 15,
      value: 3,
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
    // Torn from any body as hard to kill as the sleeper or harder as it falls, with a wet thud heard
    // 4 cells off. Worth 3, sold, carried and dropped as scrap is; never laid as loot.
    heart: {
      weight: 2,
      value: 3,
      cashoutRadius: CELL * 3,
      sellInterval: 0.25,
      volume: 0.8,
      dropNoiseRadius: CELL * 4,
      scatter: { count: 0, seed: 8, clearance: CELL * 3, offRoad: 1 },
      toughness: SLEEPER_HEALTH,
      tearRange: CELL * 4,
    },
    // Made only at a shrine. Never runs down. Ghosts hear whoever speaks within a cell and a half,
    // the walkie's key range, so its holder. Its switch clicks 2 cells out, as a walkie's.
    ghostWalkie: {
      weight: 0,
      cooldown: 0.3,
      volume: 0.6,
      switchRange: CELL * 2,
      reach: CELL * 1.5,
    },
    // Five minutes of battery, a use a second it shines. Its beam is a 40 degree cone reaching 14
    // cells, past a player's own 6 cells of sight in the dark. Its click carries a cell.
    flashlight: {
      weight: 2,
      uses: 300,
      loot: { weight: 20, rarity: "common" },
      range: CELL * 14,
      angle: Math.PI * (2 / 9),
      drain: 1,
      cooldown: 0.25,
      volume: 0.6,
      clickNoiseRadius: CELL,
    },
    // 8 minutes of battery switched on, a use a second, so the toolbar counts it down in seconds.
    // Its switch clicks 2 cells out; the click of keying it barely past arm's length, making no
    // noise. A walkie playing speech is heard 80% as far as the speech itself carries. Weightless,
    // so carrying one never slows anyone.
    // A fallen player's body: 50lb, as the ticket says, slowing its carrier by a tenth.
    corpse: { weight: 50, volume: 0.8 },
    walkie: {
      weight: 0,
      uses: 480,
      loot: { weight: 12, rarity: "common" },
      drain: 1,
      cooldown: 0.3,
      volume: 0.6,
      switchRange: CELL * 2,
      keyRange: CELL * 1.5,
      speakerNoise: 0.8,
    },
    // Never runs down. Its song is heard, and makes a noise, 25 cells round, past a sprint's 16,
    // every second while it plays; its switch clicks 2 cells out.
    radio: {
      weight: 8,
      loot: { weight: 8, rarity: "uncommon" },
      cooldown: 0.3,
      volume: 0.7,
      switchVolume: 0.6,
      switchRange: CELL * 2,
      range: CELL * 20,
      noiseInterval: 1,
    },
    // One use: put down where its entitholder stands. As likely as a handgun, and light.
    stunTrap: {
      weight: 4,
      uses: 1,
      loot: { weight: 6, rarity: "uncommon" },
      cooldown: 0.5,
      volume: 0.6,
      placeNoiseRadius: CELL,
    },
    // One use: set down just ahead of its holder, facing the way it aims. Rare, as the shotgun,
    // and heavy, a box of a gun on a stand.
    turret: {
      weight: 12,
      uses: 1,
      loot: { weight: 3, rarity: "rare" },
      cooldown: 0.5,
      volume: 0.7,
      placeNoiseRadius: CELL * 1.5,
    },
    // One use: laid just ahead of its holder, aimed the way it aims. A little rarer than a stun
    // trap, and light.
    teleporter: {
      weight: 5,
      uses: 1,
      loot: { weight: 5, rarity: "uncommon" },
      cooldown: 0.5,
      volume: 0.6,
      placeNoiseRadius: CELL,
    },
    // Thrown 6 cells. Rare, as the turret, as it takes a monster out of the world for as long as
    // it is kept, and light. Its throw whooshes 2 cells out, and it lands with a clack heard 2.
    pocketball: {
      weight: 2,
      loot: { weight: 3, rarity: "rare" },
      cooldown: 0.5,
      range: CELL * 6,
      volume: 0.7,
      throwNoiseRadius: CELL * 2,
      dropNoiseRadius: CELL * 2,
    },
    // One use: set down in the middle of the cell its holder stands in, its fuse lit with a hiss
    // heard a cell and a half off. Uncommon, between the teleporter and the turret, and heavy-ish.
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
    // Three flares, each shot 10 cells, at most one a second. Its pop is heard 12 cells off, quieter
    // than a handgun. As common as a stun trap, and light.
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
    // One use, light, and as common as a walkie. Wrapped on whoever is within a shovel's reach in
    // front, or on its user: three quarters of a body's full health back, or a corpse up on a
    // quarter of its own. Its rip carries a cell and a half.
    bandage: {
      weight: 1,
      uses: 1,
      loot: { weight: 12, rarity: "common" },
      heal: 0.75,
      revive: 0.25,
      reach: 45,
      radius: 20,
      cooldown: 1,
      duration: 0.4,
      volume: 0.7,
      noiseRadius: CELL * 1.5,
    },
    // A new world lays 40 items, each picked by loot weight, at spots favouring danger as much as
    // monsters do, so loot lies where they spawn. At the most dangerous spot there is an even
    // chance of a second, an uncommon item is twice as likely, a rare one four times. On top of
    // those it always lays 15 cans of fuel, one in each fifteenth of its width from start to exit,
    // so the cruiser can always be driven out; fuel may still be picked as loot besides. Within
    // its band each can lies by danger weight squared, as a rare item favours danger, so it is
    // found off the road where monsters spawn. The bands keep the exit, the most dangerous place,
    // from drawing more than its own band's can.
    // No item is laid on the road, loot, fuel or scrap (offRoad: 1): the road is where players
    // drive and walk, so nothing lies there to be found. Each scatter may also set its own
    // `terms` (road, right, exit, reach) to favour distance from the road or the exit side more or
    // less than monsters do; none does yet, so loot still lies where monsters spawn.
    loot: {
      scatter: {
        count: 40,
        seed: 4,
        clearance: CELL * 3,
        danger: 1,
        offRoad: 1,
      },
      guaranteed: [
        {
          item: "fuel",
          scatter: {
            count: 15,
            seed: 5,
            clearance: CELL * 3,
            spread: "x",
            danger: 2,
            offRoad: 1,
          },
        },
      ],
      danger: { extra: 0.5, rarity: { common: 1, uncommon: 2, rare: 4 } },
    },
  },
  moves: {
    // A lunge of one body length into a kick that lands a little short of the shovel; five
    // kicks fell a zombie, each sending it two of the kicker's body lengths away, less for
    // anything heavier than the kicker.
    kick: {
      reach: 32,
      radius: 18,
      damage: 8,
      knockback: 1.6,
      cooldown: 0.8,
      stamina: STAMINA_MAX * 0.2,
      lunge: { lengths: 1, seconds: 0.08 },
      noiseRadius: CELL * 6,
    },
  },
  sim: { fixedDt: 1 / 60, maxCatchUpS: 30, maxStepsPerFrame: 240 },
  // A voice through a walkie talkie's small speaker is full only within a cell of it and gone 8
  // cells off, where a voice in the air carries 12. Carried between walkies it always breaks up a
  // tenth, and breaks up more past 6 cells apart, all the way 90 cells apart: most of the world's
  // 140 cell width.
  voice: {
    full: 100,
    silent: 600,
    pan: 300,
    radio: { full: CELL, silent: CELL * 8, pan: 300 },
    interference: { clear: CELL * 6, lost: CELL * 90, floor: 0.1 },
  },
  // A cheap walkie's speaker: 300 to 3000 Hz with a honk at 1.8 kHz, driven into clipping 3x
  // clean, 10x at worst, crushed to 32 levels. Static hisses at 4% of the voice clean, 30% at worst,
  // and bursts at 80% for a tenth of a second as a transmission opens, a fifth as it closes. Clean,
  // the voice drops out once in 20s and pops 0.3 times a second at 70%; at worst twice and 4 times a
  // second.
  voiceRadio: {
    band: { low: 300, high: 3000 },
    honk: { frequency: 1800, gain: 6, q: 1 },
    crunch: { clean: 3, worst: 10, makeup: 0.35, steps: 32 },
    hiss: { clean: 0.04, worst: 0.3 },
    squelch: { volume: 0.8, open: 0.1, close: 0.2 },
    dropout: {
      clean: 0.05,
      worst: 2,
      length: { min: 0.05, max: 0.3 },
      depth: 0.05,
      swell: 2.5,
    },
    crackle: {
      clean: 0.3,
      worst: 4,
      length: { min: 0.01, max: 0.04 },
      volume: 0.7,
    },
  },
  // A clip of a player's own speech starts once what goes out reaches 0.4, past a quiet room's
  // 0.35 and short of talking's 0.5, and ends after 0.6s under it, longer than the gap between
  // words; under 1.5s of speech is dropped, so a cough, a "yeah" or a lone word is not kept, and
  // 5s is the most a clip runs. The newest 8 are held, at 32kbps: 20KB each. The mic is looked at 20 times
  // a second.
  voiceClips: {
    threshold: 0.4,
    quietSeconds: 0.6,
    minSeconds: 1.5,
    maxSeconds: 5,
    keep: 8,
    bitsPerSecond: 32_000,
    pollMs: 50,
  },
  // What counts as speech, for the noise a mic makes in the world and the clips cut from it: a
  // frame past a quiet room's level (0.3, -42 dBFS) with at least 40% of its power between 300
  // and 3400 Hz (white noise has 13%; a man's pitch sits under 300 Hz, its harmonics over),
  // peaky rather than flat (a voice's harmonics sit well under 0.3, white noise near 0.56), and
  // crossing zero no more than once in 5 samples (a voice about once in 20 at 48 kHz, noise once
  // in 2). Frames must look like speech for 0.1s before it counts, twice a key's clack as the
  // mic's 43ms window sees it, and it counts on 0.35s past the last, through a syllable's dip.
  voiceDetector: {
    minLevel: 0.3,
    band: { low: 300, high: 3400 },
    minBandShare: 0.4,
    maxFlatness: 0.3,
    maxZeroCrossings: 0.2,
    onsetSeconds: 0.1,
    hangoverSeconds: 0.35,
  },
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
  // The cabin's minimap shows 12 cells round the player it follows, about a screen's width
  // across, in a 132px square at most, small enough for the cabin to fit a 720p window. Its radar
  // sweep goes round every 2.4 seconds.
  minimap: { radius: 12, size: 132, sweepMs: 2400 },
  // The world log is always on in development and under ?debug; `enabled` keeps it on in
  // production too, as playtests run on the deployed build. It is console-only and cheap.
  // It keeps the latest 2000 events; items dropped and picked up are kept but not printed.
  worldLog: {
    enabled: true,
    capacity: 2000,
    quiet: ["item"],
    // Monsters killing monsters bury the deaths that matter; `log.kills()` still counts them.
    monsterDeaths: false,
  },
} as const satisfies AppConfig;
