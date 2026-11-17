import type { Sfx } from "../audio/index.js";
import { arrivalPoint, canStandAt, rallyPoint } from "./arrival.js";
import type { ArrivalConfig } from "./arrival.js";
import { registerBuiltIns } from "./built-ins.js";
import type { CollisionBody } from "./collision.js";
import { separateBodies } from "./collision.js";
import type {
  ContentEvent,
  Delivery,
  EventAddress,
  OutgoingEvent,
} from "./content-event.js";
import { applyEvents } from "./content-event.js";
import type { WorldContent } from "./content.js";
import type { Flash } from "./flashes.js";
import { hearDay } from "./day.js";
import type { DayConfig } from "./day.js";
import type { EntityType, WorldEntity } from "./entities.js";
import { followEntities, updateEntities } from "./entities.js";
import { emitFootsteps } from "./footsteps.js";
import { layBodies } from "./death.js";
import type { EngagementConfig } from "./bodies.js";
import type { DeathConfig } from "./death.js";
import { isAboard, playersOutside } from "./aboard.js";
import { isGhost } from "./ghosts.js";
import { followHealth } from "./health.js";
import type { FootstepConfig } from "./footsteps.js";
import { followInventories } from "./inventories.js";
import type { InventoryHold } from "./inventories.js";
import type { Inventory, ItemDefinition } from "./inventory.js";
import { createInventory } from "./inventory.js";
import { storePrevious } from "./interpolation.js";
import type { Moving } from "./interpolation.js";
import type { Point, Rng, ViewConfig, World, WorldKind } from "./map.js";
import { buildWorld } from "./generation.js";
import { buildDevWorld, danger, mulberry32 } from "./map.js";
import { setDanger } from "./loot.js";
import type { Controls, Player, PlayerRules } from "./player.js";
import { createPlayer } from "./player.js";
import type { Noise, NoiseConfig } from "./noise.js";
import type { PlayerData } from "./player-data.js";
import type { HeldWorldValue, WorldData } from "./world-data.js";
import type { Prediction } from "./prediction.js";
import { emitVoices } from "./voice-noise.js";
import type { SpokenLevel, VoiceNoiseConfig } from "./voice-noise.js";
import { followEchoes, noClips } from "./echoes.js";
import type { EchoConfig, VoiceClips } from "./echoes.js";
import { settlePredictions } from "./prediction.js";
import {
  createPilot,
  forgetPlayer,
  moveRemotePlayers,
  steerLocal,
} from "./steering.js";
import type { Corrections, Feed, Pilot, PlayerEntry } from "./steering.js";
import { hearStatuses } from "./status.js";
import type { StunnedConfig } from "./status.js";
import type { ItemBehaviour } from "./use.js";
import { useHeldItem } from "./use.js";
import { cabinCommand } from "./vehicle.js";
import type { LightConfig, VisionConfig } from "./vision.js";
import { dropHeld, interact } from "./world-items.js";
import { followWalls } from "./walls.js";
import type { WorldItemConfig } from "./world-items.js";
import { followPlayings } from "./item-sounds.js";

/** How clients follow the host. */
interface SyncConfig {
  /** Rate, per second, at which remote players turn towards the facing they last reported. */
  readonly smoothing: number;
  /**
   * Seconds a body a client does not run takes to move, at a steady speed, to each new position
   * the host reports for it. A little longer than the time between reports keeps it moving
   * between them, at the speed it really goes, that much behind the host.
   */
  readonly glide: number;
  /**
   * Furthest, in pixels, a reported position may be from the last before a body is placed there
   * at once rather than glided to: no body runs that far between reports, so one that does was
   * moved there, as by a teleport, and should not streak across the world.
   */
  readonly snap: number;
  /** Longest, in sim seconds, a guest holds what it predicted of an entity unconfirmed. */
  readonly predictionHold: number;
}

/** The tuning a session runs on; it keeps this for its lifetime. */
export interface SimConfig extends PlayerRules {
  readonly view: ViewConfig;
  readonly vision: VisionConfig;
  readonly light: LightConfig;
  readonly net: SyncConfig;
  readonly noise: NoiseConfig;
  readonly footsteps: FootstepConfig;
  readonly voiceNoise: VoiceNoiseConfig;
  /** How clips of players' voices travel, for entities that speak in them. */
  readonly echoes: EchoConfig;
  readonly worldItems: WorldItemConfig;
  readonly arrival: ArrivalConfig;
  readonly death: DeathConfig;
  /** How near a player world entities must be to act on one another. */
  readonly engagement: EngagementConfig;
  readonly stunned: StunnedConfig;
  /** How the world's day passes, and its daylight with it. */
  readonly day: DayConfig;
}

export interface Session {
  readonly localId: string;
  readonly config: SimConfig;
  /** The local player; also present in `players`. */
  readonly local: Player;
  readonly world: World;
  /** Seeded by the room code, so the same on every client in the room. */
  readonly seed: number;
  /** Where the world's starting things gather and new players arrive; seeded like `seed`. */
  readonly rally: Point;
  readonly sfx: Sfx;
  /** The local player's recorded speech, for entities that speak in its voice. */
  readonly clips: VoiceClips;
  readonly players: Map<string, Player>;
  readonly entities: Map<string, WorldEntity>;
  readonly entityTypes: Map<number, EntityType>;
  /** The number each kind is registered and sent as, by name. */
  readonly kindIds: Map<string, number>;
  /** The number the next entity spawned here takes, past that of every entity placed here. */
  nextEntityId: number;
  /** Whether this client runs the entities; otherwise they follow the host's snapshots. */
  hosting: boolean;
  /**
   * Whether this client knows who hosts, itself or another: until then, as it joins a room, its
   * actions have no one to hear them, so it takes none.
   */
  hostKnown: boolean;
  /** Sim seconds stepped since the session began. */
  time: number;
  /** Steps run since the session began. */
  step: number;
  /**
   * Sim seconds on the world's clock, which entities keep their deadlines by. Every client steps
   * it, and takes the host's from each snapshot, so whoever hosts next goes on from it.
   */
  worldTime: number;
  /** What each usable item does, by item id. */
  readonly items: Map<string, ItemBehaviour>;
  /** Every item this client knows, by item id. */
  readonly itemDefinitions: Map<string, ItemDefinition>;
  /** The items every player starts with, as the room's items stock them. */
  readonly starting: Inventory;
  /** What the local player's client predicted of its own items, until the host settles it. */
  inventoryHold: InventoryHold | null;
  /** The state each content entry keeps on every player, by the entry's name. */
  readonly playerData: Map<string, PlayerData<unknown>>;
  /** The state each content entry keeps once for the world, by the entry's name. */
  readonly worldData: Map<string, WorldData<unknown>>;
  /** Each entry's world state as held; an entry with nothing here reads as its initial value. */
  readonly worldValues: Map<WorldData<unknown>, HeldWorldValue>;
  /** The world entries set while hosting since the room last took them to send. */
  readonly worldChanged: Set<WorldData<unknown>>;
  /** Each content entry's events, by the entry's name, then by key. */
  readonly events: Map<string, Map<string, ContentEvent<unknown>>>;
  /** Where each registered event travels. */
  readonly eventAddresses: Map<ContentEvent<unknown>, EventAddress>;
  /** Events received, waiting for the next step. */
  readonly inbox: Delivery[];
  /** Events sent, waiting for the room to route them. */
  readonly outbox: OutgoingEvent[];
  /** The noises made in the latest step; each step starts by clearing them. */
  readonly noises: Noise[];
  /**
   * The levels the local player spoke at within the voice window that are louder than every
   * level after them, oldest first: the first is the loudest.
   */
  readonly spoken: SpokenLevel[];
  /**
   * When, in sim seconds, the host lets each player act again: by what the action is timed
   * under, then by player id.
   */
  readonly readyAt: Map<string, Map<string, number>>;
  /** When, in sim seconds, the local player may next act, by what the action is timed under. */
  readonly localReadyAt: Map<string, number>;
  /** The local player's own steps, kept while another client hosts. */
  readonly pilot: Pilot;
  /** While hosting, how this client runs each remote player from what it sends, by player id. */
  readonly feeds: Map<string, Feed>;
  /** Each player as the latest host snapshot carried it, by player id. */
  readonly heard: Map<string, PlayerEntry>;
  /** How the host has corrected where this client put its own player. */
  readonly corrections: Corrections;
  /** The content registered with it, in order. */
  readonly contents: WorldContent[];
  /** The flashes shown in the latest step; each step starts by clearing them. */
  readonly flashes: Flash[];
  /** What this client predicted of each entity, held until the host confirms it, by entity id. */
  readonly predictions: Map<string, Prediction>;
  /** The number of the local player's latest action; 0 before its first. */
  lastAction: number;
}

/** Where the local player starts. */
export interface Start {
  /**
   * Where it stood when last in this world. Taken if a player can stand there; otherwise the
   * player arrives as if new to the world.
   */
  readonly at?: Point | undefined;
  /** Picks the spot a player new to the world arrives at; `Math.random` by default. */
  readonly rng?: Rng | undefined;
  /** The local player's recorded speech; none when left out. */
  readonly clips?: VoiceClips | undefined;
}

/** The seed of the room `code` in worlds seeded by `base`. */
export function roomSeed(code: string, base: number): number {
  let seed = base;
  for (const character of code) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  }
  return seed >>> 0;
}

function buildRoomWorld(
  seed: number,
  kind: WorldKind,
  config: SimConfig,
): World {
  if (kind === "dev")
    return buildDevWorld(
      config.world.cell,
      config.view,
      config.world.generation.danger,
    );
  return buildWorld(config.world, mulberry32(seed));
}

/** A new session, holding the engine's own player state but no content yet. */
export function createSession(
  localId: string,
  name: string,
  roomCode: string,
  worldKind: WorldKind,
  sfx: Sfx,
  config: SimConfig,
  start: Start = {},
): Session {
  const seed = roomSeed(roomCode, config.world.seed);
  const world = buildRoomWorld(seed, worldKind, config);
  const { radius } = config.player;
  const rally = rallyPoint(world, seed, radius);
  const position =
    start.at !== undefined && canStandAt(world, start.at, radius)
      ? start.at
      : arrivalPoint(
          world,
          rally,
          radius,
          config.arrival.spread,
          start.rng ?? Math.random,
        );
  const local = createPlayer(localId, name, position, config);

  const game: Session = {
    localId,
    config,
    local,
    world,
    seed,
    rally,
    sfx,
    clips: start.clips ?? noClips,
    players: new Map([[localId, local]]),
    entities: new Map(),
    entityTypes: new Map(),
    kindIds: new Map(),
    nextEntityId: 1,
    hosting: true,
    hostKnown: true,
    time: 0,
    step: 0,
    worldTime: 0,
    items: new Map(),
    itemDefinitions: new Map(),
    starting: createInventory(config.player.inventorySlots),
    inventoryHold: null,
    playerData: new Map(),
    worldData: new Map(),
    worldValues: new Map(),
    worldChanged: new Set(),
    events: new Map(),
    eventAddresses: new Map(),
    inbox: [],
    outbox: [],
    noises: [],
    spoken: [],
    readyAt: new Map(),
    localReadyAt: new Map(),
    pilot: createPilot(),
    feeds: new Map(),
    heard: new Map(),
    corrections: { count: 0, total: 0, largest: 0 },
    contents: [],
    flashes: [],
    predictions: new Map(),
    lastAction: 0,
  };
  registerBuiltIns(game);
  // Loot is richer where monsters spawn more: the world's danger, from how it was laid out.
  setDanger(game, (at) => danger(world, at));
  return game;
}

/** Every player in the session except the local one. */
export function remotePlayers(game: Session): Player[] {
  return [...game.players.values()].filter((player) => player !== game.local);
}

/** Every body a step can move. A new kind of body belongs here so it interpolates. */
function movingBodies(game: Session): Moving[] {
  return [...game.players.values(), ...game.entities.values()];
}

/**
 * As the host, steps each entity that collides out of every other body it overlaps. Players
 * step out of what they overlap as they move.
 */
function separateEntities(game: Session): void {
  const entities = [...game.entities.values()].filter(
    (entity) => entity.collides,
  );
  const bodies = [...playersOutside(game), ...entities];
  separateBodies(bodies, game.world.map, new Set<CollisionBody>(entities));
  entities.forEach((entity) => {
    entity.tx = entity.x;
    entity.ty = entity.y;
  });
}

/**
 * `controls` as a body inside a vehicle has them: its hands are in the cabin, so it uses, kicks
 * with and drops nothing, whatever is pressed.
 */
const handsInside = (controls: Controls): Controls => ({
  ...controls,
  use: false,
  secondary: false,
  drop: false,
  holdingUse: false,
});

export function updateSession(
  game: Session,
  controls: Controls,
  dt: number,
): void {
  game.time += dt;
  game.step += 1;
  game.worldTime += dt;
  game.noises.length = 0;
  game.flashes.length = 0;
  movingBodies(game).forEach(storePrevious);
  followWalls(game);
  steerLocal(game, controls, dt);
  const acting = isAboard(game.local) ? handsInside(controls) : controls;
  if (!isGhost(game.local)) {
    if (acting.use) useHeldItem(game);
    if (acting.interact) interact(game);
    if (acting.drop) dropHeld(game);
    // Inside, with nothing to drop, the drop key gets out of the vehicle, wheel or cabin.
    if (controls.drop && isAboard(game.local)) cabinCommand(game, "exit");
    if (acting.honk === true && game.local.ride?.driving === true)
      cabinCommand(game, "honk");
    if (acting.cabin !== undefined && acting.cabin !== null)
      cabinCommand(game, acting.cabin);
  }
  for (const content of game.contents) content.act?.(game, acting);

  applyEvents(game);
  moveRemotePlayers(game, dt);
  followInventories(game);
  emitFootsteps(game, dt);
  emitVoices(game, dt);
  settlePredictions(game);
  if (game.hosting) {
    updateEntities(game, dt);
    layBodies(game);
    for (const content of game.contents) content.step?.(game, dt);
    separateEntities(game);
  } else followEntities(game, dt);

  followHealth(game);
  followPlayings(game);
  followEchoes(game);
  // Sounds still playing are heard from where the local player is now, a ghost's view included.
  game.sfx.listen(game.local);
  hearStatuses(game);
  hearDay(game);
}

/** Drops a remote player; false when there is none by that id. */
export function removePlayer(game: Session, id: string): boolean {
  if (id === game.localId) return false;
  forgetPlayer(game, id);
  return game.players.delete(id);
}
