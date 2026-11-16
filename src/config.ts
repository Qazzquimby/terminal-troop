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
  VoiceConnectionConfig,
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
/** A player's walking pace, in pixels a second, and how much faster it sprints. */
const PLAYER_SPEED = 120;
const SPRINT = 1.8;

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
      // Half the rooms have a light fixture, and a third have power, so one room in six is lit.
      // The road and yards are always lit, by sunlight. Monsters never appear in light.
      lights: { fixture: 1.0, powered: 1 / 30 },
      // Monsters spawn, and loot is richer, up to 4x by distance from the road and 4x towards the
      // exit: 16x at the far right corner over the road at the start.
      danger: { road: 3, right: 3 },
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
  // A ghost's free camera glides at 8 cells a second, nearly twice a sprint.
  spectate: { speed: CELL * 8 },
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
  // It fades like ink soaking away: blots about 3 cells across go from 4s after last seen, the
  // last at 10s, each darkening faster as its time comes. Terrain in sight is renewed 4x a second.
  mapMemory: {
    saveInterval: 5,
    maxRooms: 50,
    floor: { fill: "#181818", grid: "#2a2a2a", alpha: 0.4 },
    wall: { fill: "#5a5a5a", edge: "#6a6a6a", alpha: 0.5 },
    fade: { seconds: 10, spread: 0.6, blot: 3, detail: 4, refresh: 0.25 },
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
    surroundingsRadius: CELL * 1.4,
    lookRange: CELL * 7,
    // Any part of a body in sight shows it, checked every quarter cell over its footprint: a
    // cruiser 4 cells across stays drawn while its nose is in view.
    footprintSpacing: CELL / 4,
  },
  light: { range: CELL * 6 },
  // A guest holds a hit it predicted for up to a second before the host confirms it. Bodies it
  // follows take 0.15s, one and a half snapshots at 10 a second, to reach each reported position,
  // so a late snapshot does not stop them.
  net: { smoothing: 12, glide: 0.15, predictionHold: 1 },
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
      spawning: {
        weight: 100,
        tries: 24,
        unseenDistance: 700,
        group: { min: 1, max: 5, spread: CELL * 2 },
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
      // Everyone in the exit escapes once the cruiser has waited there 20s.
      escape: { delay: 20, volume: 0.8 },
      // A corpse carried within a cell of the cruiser's body brings its player back beside it.
      revive: { reach: CELL, volume: 0.8 },
      // Its cabin stores 6 items, 2 rows of 3; an item going in or out clunks a cell off, inside
      // its body, so only something pressed against it hears.
      storage: { slots: 6, noiseRadius: CELL, volume: 0.7 },
      // Sells for the team's credit, which a scrap's sale adds 1 to, so a price is that many scrap.
      // The register rings 2 cells off.
      shop: {
        wares: [
          { item: "walkie", price: 2 },
          { item: "flashlight", price: 3 },
          { item: "shovel", price: 3 },
        ],
        noiseRadius: CELL * 2,
        volume: 0.8,
      },
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
    // Arms 3s after it is put down, then beeps, heard 8 cells off. Whatever steps on it sets it
    // off: a bang heard 12 cells off, and a flash that stuns for 5s every body, players included,
    // whose eyes catch it within 5 cells, lighting 8 cells round it for half a second.
    stunTrap: {
      radius: 10,
      armSeconds: 3,
      stunRange: CELL * 5,
      stunSeconds: 5,
      light: { range: CELL * 8, seconds: 0.5 },
      sounds: { beep: CELL * 8, flash: CELL * 12 },
      volume: 0.8,
    },
    // None in the first 4 minutes of a world, never within 14 cells of a player. It creeps after a
    // player it picks, standing while there is none, at a fifth of a player's walk, kills
    // whatever it touches, at most once a second, and replans its way every 2 seconds. No monster
    // hunts or strikes it: its kind carries the unnoticed tag.
    snail: {
      spawning: {
        weight: 10,
        after: 240,
        tries: 24,
        unseenDistance: CELL * 14,
      },
      radius: 12,
      ignores: ["snail"],
      targets: ["player"],
      speedShare: 0.2,
      damage: 500,
      attackCooldown: 1,
      repathInterval: 2,
    },
    // A blind hound, can spawn in light or darkness, never arriving within 30 cells of a
    // player. Five shovel hits fell it; touching it costs 100 health, once a second.
    blindDog: {
      spawning: { weight: 30, tries: 24, unseenDistance: CELL * 30 },
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
    // A swollen thing that comes alone, out of the dark, never within 14 cells of a player. It
    // feels prey through walls 12 cells round. A gun's shot sets it off; two kill it outright.
    exploder: {
      spawning: { weight: 70, tries: 24, unseenDistance: CELL * 14 },
      radius: 16,
      // It passes over the crowds, zombies and hoarder beetles, or it would spend itself and the
      // walls round it on the first it felt; players and the rarer monsters it hunts.
      ignores: ["exploder", "zombie", "hoarder"],
      maxHealth: SHOVEL_DAMAGE * 2,
      wanderSpeed: PLAYER_SPEED * 0.8,
      chaseSpeed: PLAYER_SPEED * 1.1,
      // Once its fuse is lit it slows to half a player's walk, so whoever it chases can get clear.
      litSpeed: PLAYER_SPEED * 0.5,
      senseRange: CELL * 12,
      wanderRange: CELL * 5,
      wanderPause: { min: 0.5, max: 2 },
      repathDistance: CELL / 2,
      // A route more than twice as long as the straight line, plus 2 cells, is too long: it
      // heads straight at its prey instead, and sets itself off at the wall in the way.
      detour: { factor: 2, slack: CELL * 2 },
      // Within 2 cells of a body it hunts it lights a 1s fuse, and keeps coming. Any hurt lights it
      // too, but another exploder's burst, so one burst does not set off every exploder near it.
      fuseRange: CELL * 3,
      fuseOnHurt: { minDamage: 0, except: ["exploder"] },
      fuse: 2.5,
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
    // enraged, every 1.5 to 3s, 12 cells; her growl 6, her scream as she wakes 16.
    sleeper: {
      spawning: { weight: 50, tries: 24, unseenDistance: CELL * 14 },
      ignores: ["sleeper"],
      radius: 15,
      maxHealth: SHOVEL_DAMAGE * 5,
      sightRange: CELL * 8,
      wakeRange: CELL * 5,
      warnSeconds: 1,
      rageSeconds: 10,
      wanderRange: CELL * 8,
      repathDistance: CELL / 2,
      attackDamage: SHOVEL_DAMAGE * 3,
      attackCooldown: 1,
      barkGap: {
        dormant: { min: 13, max: 16 },
        enraged: { min: 1.5, max: 3 },
      },
      retreat: {
        distance: { min: CELL * 10, max: CELL * 20 },
        clearance: CELL * 12,
        tries: 16,
      },
      sounds: {
        bark: CELL * 8,
        growl: CELL * 6,
        enrage: CELL * 16,
        rageBark: CELL * 12,
        attack: CELL * 6,
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
        weight: 7,
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
      step: { interval: 0.3, range: CELL * 14 },
      strikeRange: CELL * 8,
    },
    // Alone, in the dark: none in the first 4 minutes of a world, never within 30 cells of a
    // player. Five shovel hits fell it; it moves at 1.2 times a walk, and touching it costs 100
    // health, once a second. Any body but another stalker sees it down its view cone as far as that
    // body looks, a player 10 cells, but never past 14, as far as a flashlight reaches. Seen, it
    // backs off for 25s, keeping 12 cells from every body it hunts where it can; hurt, it rages for
    // 10s. It replans twice a second. Its hiss as it backs off carries 6 cells, its shriek of rage
    // 16, its strike 8.
    stalker: {
      spawning: {
        weight: 10,
        after: 0,
        tries: 24,
        unseenDistance: CELL * 30,
      },
      ignores: ["stalker"],
      targets: ["player"],
      radius: 14,
      maxHealth: SHOVEL_DAMAGE * 5,
      speed: PLAYER_SPEED * 1.2,
      damage: 100,
      attackCooldown: 1,
      watchRange: CELL * 14,
      retreatDistance: CELL * 12,
      retreatSeconds: 25,
      enragedSeconds: 10,
      repathInterval: 0.5,
      sounds: { retreat: CELL * 6, enraged: CELL * 16, attack: CELL * 8 },
    },
    // Groups of 3 to 5 sharing a nest, never arriving within 14 cells of a player. Three shovel hits fell one. It forages at 0.8 times a walk and chases at 1.1, sees 6 cells,
    // and searches 16 spots up to 15 cells from its nest. It guards 4 cells round the nest for 15s,
    // is spooked by any body within 8 cells for 5s, and bites its quarry for 10 once a second. A
    // nest's revenge lasts until the thief is 5 cells from what it stole. Its chitter carries 4
    // cells every 5 to 10s, its alarm 10, its pick-up 3, its bite 5.
    hoarder: {
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
    // The world's spawner rolls every 10s. As a world begins half the rolls bring nothing, the
    // chance falling evenly until, 20 minutes in, every roll brings something: one every 20s at
    // first, one every 10s from then on. Each roll that brings something picks a kind by its
    // `spawning.weight`. A new world starts with 5 minutes of rolls at the starting chance:
    // about 15 spawns.
    spawner: { period: 2, nothing: 0.7, certainAfter: 1200, headStart: 300 },
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
      scatter: { count: 50, seed: 2, clearance: CELL * 3, danger: 1 },
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
    // so the cruiser can always be driven out; fuel may still be picked as loot besides.
    loot: {
      scatter: { count: 40, seed: 4, clearance: CELL * 3, danger: 1 },
      guaranteed: [
        {
          item: "fuel",
          scatter: { count: 15, seed: 5, clearance: CELL * 3, spread: "x" },
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
  // across, in a 132px square, small enough for the cabin to fit a 720p window.
  minimap: { radius: 12, size: 132 },
  // The world log is always on in development and under ?debug; `enabled` keeps it on in
  // production too, as playtests run on the deployed build. It is console-only and cheap.
  // It keeps the latest 2000 events; items dropped and picked up are kept but not printed.
  worldLog: { enabled: true, capacity: 2000, quiet: ["item"] },
} as const satisfies AppConfig;
