import { createSfx } from "../audio/index.js";
import type { Sfx } from "../audio/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import type { ItemsConfig } from "../items/index.js";
import type { MovesConfig } from "../moves/index.js";
import type {
  FlashConfig,
  MapMemoryConfig,
  RippleConfig,
} from "../render/index.js";
import type { GenerationConfig, SimConfig } from "../sim/index.js";
import type { Station } from "../stations/index.js";

/**
 * A road 8 to 16 cells wide, bending every 12 columns by up to 6 rows, kept 10 rows off the top and
 * bottom; 2 to 5 cells of yard; rooms 3x3 to 8x8. The start is the first 5 columns, the exit the
 * last 5.
 */
export const testGeneration: GenerationConfig = {
  road: { width: { min: 8, max: 16 }, step: 12, meander: 6, margin: 10 },
  yard: {
    depth: { min: 2, max: 5 },
    clutter: { near: 0.1, far: 0.9 },
    tries: 0.6,
  },
  rooms: {
    size: { min: 3, max: 8 },
    minCells: 6,
    solidChance: 0.3,
    hallwayChance: 0.2,
    hallway: { width: 2, length: 14 },
    door: { min: 1, max: 3 },
    loops: 0.1,
    exits: [0.6, 0.3, 0.1],
    building: { min: 3, max: 8 },
  },
  lights: { fixture: 0.5, powered: 0.5, exitShade: 10 },
  danger: { road: 3, right: 3, exit: 20, reach: 10 },
  start: 5,
  exit: 5,
};

/**
 * Tuning for tests that build a whole session. A full stamina bar lasts 3s of sprinting and
 * refills in 4s after a 0.6s rest. A noise seems to come from within a fifth of its distance of
 * where it was made. Walking steps every 0.5s, heard 150px off; sprinting every 0.25s, 450px off;
 * crouching, at half speed, every 0.75s, 60px off. A player new to a world starts within 100px of its
 * rally point. A guest holds what it predicted of an entity for up to 0.5s. Speech is judged by its loudest level over 0.5s: from 0.3 it carries
 * 100px, up to 500px from 0.8, in steps of 50px, rippling every 0.4s.
 */
export const testSimConfig: SimConfig = {
  world: {
    cell: 50,
    cols: 80,
    rows: 60,
    seed: 7,
    wallBounce: 0,
    generation: testGeneration,
  },
  view: { width: 900, height: 600 },
  player: {
    radius: 14,
    speed: 220,
    acceleration: 1100,
    sprintMultiplier: 1.8,
    crouchMultiplier: 0.5,
    inventorySlots: 4,
    maxHealth: 100,
    nameMax: 8,
    knockbackSeconds: 0.15,
    mass: 1,
    load: { full: 100, slowdown: 0.2 },
    switchVolume: 0.4,
  },
  stamina: { max: 90, drain: 30, regen: 22.5, regenDelay: 0.6, recover: 27 },
  arrival: { spread: 100 },
  death: { scatter: 40, reviveHealth: 50 },
  stunned: {
    darkness: 0.95,
    fadeOut: 1,
    ring: { volume: 0.5, fadeSeconds: 1 },
  },
  vision: {
    coneAngle: Math.PI / 2,
    rays: 64,
    surroundingsRadius: 70,
    lookRange: 400,
    footprintSpacing: 12.5,
  },
  light: { range: 200 },
  day: {
    startHour: 8,
    midnight: 1200,
    afternoon: 600,
    night: 1020,
    volume: 0.5,
  },
  net: { smoothing: 12, glide: 0.15, predictionHold: 0.5, snap: 350 },
  noise: { blur: 0.2 },
  footsteps: {
    walk: { interval: 0.5, radius: 150 },
    sprint: { interval: 0.25, radius: 450 },
    crouch: { interval: 0.75, radius: 60 },
  },
  voiceNoise: {
    window: 0.5,
    threshold: 0.3,
    full: 0.8,
    radius: { quiet: 100, loud: 500 },
    step: 50,
    interval: 0.4,
  },
  worldItems: { radius: 8, cooldown: 0.2, dropCooldown: 0.2 },
};

/**
 * Each noise the local player hears ripples for 0.5s, its ring full grown in 0.1s; one unseen
 * glows 50px wide, 10px in from the screen's edge.
 */
export const testRippleConfig: RippleConfig = {
  duration: 0.5,
  expand: 0.1,
  edge: {
    radius: 50,
    inset: 10,
    alpha: { sharp: 1, soft: 0.2 },
    colour: "#f80",
  },
  width: { sharp: 2, soft: 10 },
  alpha: { sharp: 1, soft: 0.2 },
  colour: "#fff",
};

/** Remembered terrain is saved at most once a second, for the three worlds entered last. */
export const testMapMemoryConfig: MapMemoryConfig = {
  saveInterval: 1,
  maxRooms: 3,
  floor: { fill: "#111", grid: "#222", alpha: 0.5 },
  wall: { fill: "#333", edge: "#444", alpha: 0.5 },
  fade: {
    seconds: 10,
    spread: 0.6,
    blot: 3,
    detail: 4,
    refresh: 0.25,
    reach: 6,
    nearest: 1,
  },
};

/** A kind the spawner never picks: it has no weight. */
const NEVER = { weight: 0, tries: 24 } as const;

/**
 * Three zombies scattered in the 4000x3000 test world, two in the dev square; they walk at 50px/s,
 * chase at 200px/s, see 300px, have 40 health, bark every 4 to 8 seconds, and hit for 25 at most
 * every 1.5 seconds. The spawner brings nothing unless a test gives a kind weight: it then rolls
 * every 5 seconds, half of them bringing nothing as a world begins and every one 20 seconds in,
 * and a new world starts with 30 seconds of rolls. A zombie it brings arrives alone, never within
 * 1100px of a player. A cruiser starts at the rally point, its two headlights
 * 45 degree cones reaching 400px. A stun trap arms in 3s and stuns for 5s within 250px. The
 * snail creeps at a fifth of a player's pace and kills what it touches. No blind dog nor exploder
 * appears unless a test spawns one: a blind dog 144px across, felled by three test shovel hits,
 * charging at full suspicion of 1000; a
 * exploder that feels players 600px off, lights a 1s fuse within 100px of one and bursts 150px
 * round, from 100 damage to 30. Nor does a sleeper or a statue. No stalker nor hoarder appears
 * unless a test spawns one: a
 * stalker at 1.2 times the test player's walk, creeping at 0.1 times it, watched 700px down a player's cone, retreating
 * 600px clear; hoarders at 0.8 and 1.1 times it, seeing 300px, guarding 200px round their
 * nest, spooked within 400px, avenging a theft until the thief is 250px from it. No mine layer
 * appears unless a test spawns one: one at the test player's walk, felled by a test shovel hit,
 * seeing 400px all round; its land mines arm in 3s and go off within 100px, bursting 100px round
 * from 120 damage to 60. No giant snail appears unless a test spawns one: 94px across, at 0.3
 * times the test player's walk, breaking a wall it presses for 5s.
 */
export const testEntitiesConfig = {
  spawner: { period: 5, nothing: 0.5, certainAfter: 20, headStart: 30 },
  zombie: {
    spawn: { count: { density: 0.25, min: 2 }, seed: 3, clearance: 400 },
    spawning: { ...NEVER, unseenDistance: 1100 },
    radius: 15,
    mass: 1,
    ignores: ["zombie", "exploder"],
    maxHealth: 40,
    attackDamage: 25,
    wanderSpeed: 50,
    chaseSpeed: 200,
    sightRange: 300,
    wanderRange: 200,
    wanderPause: { min: 0.5, max: 1 },
    repathDistance: 25,
    barkGap: { min: 4, max: 8 },
    attackRange: 32,
    attackCooldown: 1.5,
    chase: { limit: 15, rest: 5 },
    sounds: { bark: 400, alert: 500, attack: 250 },
  },
  cruiser: {
    length: 20,
    width: 12,
    handling: {
      speed: 300,
      reverse: 100,
      acceleration: 150,
      braking: 450,
      drag: 100,
      turnRate: 1.2,
      grip: 150,
    },
    reach: 25,
    burn: 1,
    standing: 12.5,
    gauge: 30,
    engine: {
      idle: { interval: 1, radius: 150 },
      drive: { interval: 0.5, radius: 700 },
    },
    crash: { speed: 150, damage: 50, breakdown: 250, noiseRadius: 1000 },
    ram: { speed: 100, damage: 20, cooldown: 0.5, noiseRadius: 500 },
    horn: { noiseRadius: 900, volume: 1 },
    headlights: { range: 400, angle: Math.PI / 4, spread: 7 },
    escape: { delay: 20, volume: 1 },
    revive: { reach: 50, volume: 1 },
    storage: { slots: 6, noiseRadius: 50, volume: 1 },
    shop: {
      wares: [
        { item: "walkie", price: 2 },
        { item: "flashlight", price: 3 },
        { item: "shovel", price: 3 },
      ],
      noiseRadius: 100,
      volume: 1,
    },
    radio: {
      volume: 0.7,
      range: 1250,
      noiseInterval: 1,
      switchVolume: 0.6,
      switchRange: 100,
    },
  },
  stunTrap: {
    radius: 10,
    armSeconds: 3,
    stunRange: 250,
    stunSeconds: 5,
    light: { range: 400, seconds: 0.5 },
    sounds: { beep: 100, flash: 600 },
    volume: 1,
  },
  turret: {
    radius: 14,
    maxHealth: 60,
    mass: 1,
    ignores: ["player"],
    armSeconds: 3,
    sight: { angle: Math.PI / 18, range: 600 },
    turnSeconds: 3,
    shot: { damage: 30, range: 600, interval: 2, aimSeconds: 0.5, spark: 5 },
    sounds: { beep: 400, lock: 200, shot: 1500, break: 500 },
    volume: 1,
  },
  teleporter: {
    radius: 16,
    armSeconds: 3,
    rearmSeconds: 3,
    distance: { min: 400, max: 1500 },
    tries: 24,
    flash: 30,
    sounds: { beep: 400, warp: 500 },
    volume: 1,
  },
  snail: {
    spawning: { ...NEVER, unseenDistance: 1100 },
    radius: 12,
    ignores: ["snail", "giantSnail"],
    targets: ["player"],
    speedShare: 0.2,
    damage: 500,
    attackCooldown: 1,
    repathInterval: 1,
  },
  giantSnail: {
    spawning: { ...NEVER, unseenDistance: 1100 },
    radius: 47,
    ignores: ["snail", "giantSnail"],
    targets: ["player"],
    speedShare: 0.3,
    damage: 500,
    attackCooldown: 1,
    repathInterval: 1,
    breaksWalls: {
      seconds: 5,
      grindGap: 1,
      sounds: { grind: 400, crumble: 800 },
    },
  },
  blindDog: {
    spawning: { ...NEVER, unseenDistance: 1100 },
    radius: 72,
    ignores: ["blindDog"],
    maxHealth: 75,
    contactDamage: 100,
    contactCooldown: 1,
    wanderSpeed: 60,
    stalkSpeed: 80,
    chargeSpeed: 260,
    pounce: { reach: 300, windup: 0.3, speed: 400, recover: 0.6, skid: 50 },
    wanderRange: 300,
    wanderPause: { min: 0.5, max: 1 },
    repathDistance: 50,
    suspicion: { max: 1000, decay: 100 },
    overrun: 400,
    lunge: 150,
    patience: 4,
    boredSeconds: 10,
    // Long enough that no test but the bark's own hears one.
    barkGap: { min: 1000, max: 1000 },
    sounds: {
      bark: 500,
      roar: 1000,
      snarl: 200,
      bite: 300,
      huff: 200,
      growl: 250,
      pounce: 750,
      skid: 250,
    },
  },
  exploder: {
    spawning: { ...NEVER, unseenDistance: 700 },
    radius: 16,
    ignores: ["exploder", "zombie", "hoarder"],
    maxHealth: 45,
    wanderSpeed: 80,
    chaseSpeed: 120,
    litSpeed: 60,
    senseRange: 600,
    wanderRange: 200,
    wanderPause: { min: 0.5, max: 1 },
    repathDistance: 25,
    detour: { factor: 2, slack: 100 },
    fuseRange: 100,
    fuseOnHurt: { minDamage: 0, except: ["exploder"] },
    fuse: 1,
    blast: { radius: 150, centre: 100, edge: 30 },
    sounds: { fuse: 300, blast: 2000 },
  },
  sleeper: {
    spawning: { ...NEVER, unseenDistance: 1100 },
    radius: 15,
    ignores: ["sleeper"],
    maxHealth: 75,
    sightRange: 400,
    wakeRange: 250,
    warnSeconds: 1,
    rageSeconds: 10,
    wanderRange: 200,
    repathDistance: 25,
    attackDamage: 45,
    attackCooldown: 1,
    barkGap: { dormant: { min: 3, max: 6 }, enraged: { min: 1.5, max: 3 } },
    retreat: {
      distance: { min: 200, max: 400 },
      clearance: 300,
      tries: 16,
    },
    alarmRadius: 900,
    relocate: { after: 120, range: 700, retry: 5 },
    sounds: {
      bark: 400,
      growl: 300,
      enrage: 800,
      rageBark: 600,
      attack: 300,
      vanish: 800,
    },
  },
  statue: {
    spawning: { ...NEVER, unseenDistance: 1100 },
    radius: 16,
    ignores: ["statue"],
    targets: ["player"],
    sightRange: 800,
    patrol: { distance: 300, spread: 50, tries: 16, retry: 2 },
    huntSeconds: 10,
    repathInterval: 0.25,
    damage: 90,
    attackCooldown: 1,
    step: { interval: 0.3, range: 700 },
    strikeRange: 400,
  },
  stalker: {
    spawning: { ...NEVER, unseenDistance: 700 },
    radius: 14,
    ignores: ["stalker"],
    targets: ["player"],
    maxHealth: 75,
    speed: 264,
    creepSpeed: 22,
    watchedBy: ["player"],
    damage: 100,
    attackCooldown: 1,
    watchRange: 700,
    retreatDistance: 600,
    retreatSeconds: 25,
    enragedSeconds: 10,
    repathInterval: 0.25,
    sounds: { retreat: 300, enraged: 800, attack: 400 },
  },
  hoarder: {
    spawning: {
      ...NEVER,
      unseenDistance: 700,
      group: { min: 3, max: 5, spread: 100 },
    },
    radius: 13,
    ignores: ["hoarder", "exploder"],
    maxHealth: 45,
    wanderSpeed: 176,
    chaseSpeed: 242,
    sightRange: 300,
    search: { count: 12, range: 600, tries: 48 },
    nestRadius: 200,
    dropRadius: 60,
    spookRange: 400,
    spookSeconds: 5,
    guardSeconds: 15,
    revengeRange: 250,
    damage: 10,
    attackRange: 30,
    attackCooldown: 1,
    repathInterval: 0.25,
    chitterGap: { min: 5, max: 10 },
    sounds: { chitter: 200, alarm: 500, pickUp: 150, attack: 250 },
  },
  landMine: {
    radius: 8,
    armSeconds: 3,
    beepGap: 4,
    triggerRange: 100,
    ignores: ["landMine", "mineLayer"],
    fuse: 0.3,
    blast: { radius: 100, centre: 120, edge: 60 },
    breaksWalls: false,
    sounds: { arm: 200, beep: 150, trigger: 300, blast: 2000 },
  },
  mineLayer: {
    spawning: { ...NEVER, unseenDistance: 700 },
    ignores: ["mineLayer"],
    radius: 12,
    maxHealth: 25,
    speed: 220,
    sightRange: 400,
    treasure: "goldenScrap",
    orbit: { min: 100, max: 1200, step: 150, leg: 100, tries: 12 },
    layGap: { wander: 10, flee: 3 },
    mineSpacing: 50,
    calmSeconds: 10,
    flee: { leg: 200, tries: 12, homePull: 0.5, repathInterval: 0.5 },
    sounds: { lay: 150 },
  },
} satisfies EntitiesConfig;

/**
 * Items: a shovel that hits 40px ahead for 25, so a test zombie falls to its second hit, at most
 * twice a second; three scrap, each selling for 2 within 150px of the cruiser, one every quarter
 * second, clattering 400px round as it drops. A handgun with 6 shots of 50 out to 600px; a
 * shotgun with 2 blasts of six shots of 5, fanned across 30 degrees out to 400px; a flashlight
 * whose 45 degree beam reaches 600px, its battery 10 seconds. A walkie with a 10-second battery
 * whose speaker carries half as far as the speech it plays; a radio heard, and making noise,
 * 1000px round each second. All weigh nothing, so what a player carries does not slow it, and no
 * loot is laid.
 */
export const testItemsConfig: ItemsConfig = {
  shovel: {
    weight: 0,
    loot: { weight: 30, rarity: "common" },
    radius: 20,
    reach: 40,
    damage: 25,
    knockback: 20,
    cooldown: 0.5,
    duration: 0.1,
    volume: 1,
    hitNoiseRadius: 300,
    missNoiseRadius: 100,
    wallNoiseRadius: 200,
  },
  handgun: {
    weight: 0,
    uses: 6,
    damage: 50,
    range: 600,
    cooldown: 0.5,
    noiseRadius: 1500,
    volume: 1,
    duration: 0.1,
    spark: 5,
  },
  shotgun: {
    weight: 0,
    uses: 2,
    damage: 5,
    range: 400,
    pellets: 6,
    arc: Math.PI / 6,
    cooldown: 1,
    noiseRadius: 1800,
    volume: 1,
    duration: 0.1,
    spark: 5,
  },
  fuel: {
    weight: 0,
    seconds: 15,
    reach: 50,
    cooldown: 0.5,
    volume: 1,
  },
  scrap: {
    weight: 0,
    value: 2,
    cashoutRadius: 150,
    sellInterval: 0.25,
    volume: 1,
    dropNoiseRadius: 400,
    scatter: { count: 3, seed: 5, clearance: 200 },
  },
  // None laid, so worlds under test hold what they did before it; worth 5, to tell from scrap's 2.
  goldenScrap: {
    weight: 0,
    value: 5,
    cashoutRadius: 150,
    sellInterval: 0.25,
    volume: 1,
    dropNoiseRadius: 400,
    scatter: { count: 0, seed: 3, clearance: 200, danger: 3 },
  },
  flashlight: {
    weight: 0,
    uses: 10,
    range: 600,
    angle: Math.PI / 4,
    drain: 1,
    cooldown: 0.25,
    volume: 1,
    clickNoiseRadius: 50,
  },
  corpse: { weight: 50, volume: 1 },
  bandage: {
    weight: 0,
    uses: 1,
    heal: 0.75,
    revive: 0.25,
    reach: 40,
    radius: 20,
    cooldown: 0.5,
    duration: 0.4,
    volume: 1,
    noiseRadius: 75,
  },
  walkie: {
    weight: 0,
    uses: 10,
    drain: 1,
    cooldown: 0.2,
    volume: 1,
    switchRange: 100,
    keyRange: 75,
    speakerNoise: 0.5,
  },
  radio: {
    weight: 0,
    cooldown: 0.2,
    volume: 1,
    switchVolume: 1,
    switchRange: 100,
    range: 1000,
    noiseInterval: 1,
  },
  stunTrap: {
    weight: 0,
    uses: 1,
    cooldown: 0.5,
    volume: 1,
    placeNoiseRadius: 50,
  },
  turret: {
    weight: 0,
    uses: 1,
    cooldown: 0.5,
    volume: 1,
    placeNoiseRadius: 50,
  },
  teleporter: {
    weight: 0,
    uses: 1,
    cooldown: 0.5,
    volume: 1,
    placeNoiseRadius: 50,
  },
  loot: {
    scatter: { count: 0, seed: 6, clearance: 200 },
    guaranteed: [],
    danger: { extra: 0.5, rarity: { common: 1, uncommon: 2, rare: 4 } },
  },
};

/**
 * Moves: a kick that lunges one body length and hits 30px ahead of where it lands for 10, so a
 * test zombie falls to its fourth, sending what it hits two of the kicker's body lengths away. It costs
 * a third of the test stamina bar, at most twice a second.
 */
export const testMovesConfig: MovesConfig = {
  kick: {
    reach: 30,
    radius: 20,
    damage: 10,
    knockback: 2,
    cooldown: 0.5,
    stamina: 30,
    lunge: { lengths: 1, seconds: 0.1 },
    noiseRadius: 300,
  },
};

/** A flash lasts 0.5s, swelling from half its size. */
export const testFlashConfig: FlashConfig = {
  duration: 0.5,
  start: 0.5,
  fill: 0.3,
  width: 2,
  colour: { hit: "#f00", miss: "#888" },
  tracer: { width: 1, colour: "#ff0" },
};

const SILENT: Awaited<ReturnType<Sfx["play"]>> = {
  stop: () => undefined,
  setVolume: () => undefined,
  setPosition: () => undefined,
};

/** Radio stations for tests, in place of the song files that ship. */
export const testStations: readonly Station[] = [
  {
    name: "Alpha FM",
    songs: ["/songs/Alpha FM/a1.opus", "/songs/Alpha FM/a2.opus"],
  },
  {
    name: "Beta FM",
    songs: [
      "/songs/Beta FM/b1.mp3",
      "/songs/Beta FM/b2.ogg",
      "/songs/Beta FM/b3.opus",
    ],
  },
];

/** Sound effects for sessions under test; nothing plays. */
export function testSfx(): Sfx {
  return {
    ...createSfx({ full: 0, silent: 1000, pan: 500 }),
    play: () => Promise.resolve(SILENT),
    playLoop: () => Promise.resolve(SILENT),
    stream: () => SILENT,
  };
}
