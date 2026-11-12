import type { Sfx } from "../audio/index.js";
import { arrivalPoint, canStandAt, rallyPoint } from "./arrival.js";
import type { ArrivalConfig } from "./arrival.js";
import { registerBuiltIns } from "./built-ins.js";
import type { CollisionBody } from "./collision.js";
import { separateBodies, solidBodiesBut } from "./collision.js";
import type {
  ContentEvent,
  Delivery,
  EventAddress,
  OutgoingEvent,
} from "./content-event.js";
import { applyEvents } from "./content-event.js";
import type { WorldContent } from "./content.js";
import type { Flash } from "./flashes.js";
import type { EntityType, WorldEntity } from "./entities.js";
import { followEntities, updateEntities } from "./entities.js";
import { emitFootsteps } from "./footsteps.js";
import { followHealth } from "./health.js";
import type { ForcedMove } from "./forced-move.js";
import {
  correctPlayer,
  followForcedMoves,
  positionHeld,
} from "./forced-move.js";
import type { FootstepConfig } from "./footsteps.js";
import type { Moving } from "./interpolation.js";
import { followInventories, reportHeld } from "./inventories.js";
import type { InventoryHold } from "./inventories.js";
import type { Inventory, ItemDefinition } from "./inventory.js";
import { createInventory } from "./inventory.js";
import { snapPrevious, storePrevious } from "./interpolation.js";
import type { Point, Rng, ViewConfig, World, WorldKind } from "./map.js";
import { buildDevWorld, buildWorld, isAreaFree, mulberry32 } from "./map.js";
import type { Controls, Player, PlayerRules, PlayerState } from "./player.js";
import {
  createPlayer,
  smoothPlayer,
  stepDash,
  updatePlayer,
} from "./player.js";
import type { Noise, NoiseConfig } from "./noise.js";
import { checkMove } from "./move-checks.js";
import { trackStamina } from "./stamina-checks.js";
import type { StaminaCheck, StaminaCheckConfig } from "./stamina-checks.js";
import type { MoveCheck, MoveCheckConfig, MoveVerdict } from "./move-checks.js";
import type { PlayerData } from "./player-data.js";
import type { HeldWorldValue, WorldData } from "./world-data.js";
import type { Prediction } from "./prediction.js";
import { settlePredictions } from "./prediction.js";
import { applyContentState, contentState } from "./player-data.js";
import type { ItemBehaviour, UseSlack } from "./use.js";
import { useHeldItem } from "./use.js";
import type { LightConfig, VisionConfig } from "./vision.js";
import { interact } from "./world-items.js";
import type { WorldItemConfig } from "./world-items.js";

/** How remote players follow the state they report. */
interface SyncConfig {
  /** Rate, per second, at which remote players ease towards their reported state. */
  readonly smoothing: number;
  readonly useSlack: UseSlack;
  readonly moves: MoveCheckConfig;
  readonly stamina: StaminaCheckConfig;
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
  readonly worldItems: WorldItemConfig;
  readonly arrival: ArrivalConfig;
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
  readonly players: Map<string, Player>;
  readonly entities: Map<string, WorldEntity>;
  readonly entityTypes: Map<number, EntityType>;
  /** The number each kind is registered and sent as, by name. */
  readonly kindIds: Map<string, number>;
  /** The number the next entity spawned here takes, past that of every entity placed here. */
  nextEntityId: number;
  /** Whether this client runs the entities; otherwise they follow the host's snapshots. */
  hosting: boolean;
  /** Sim seconds stepped since the session began. */
  time: number;
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
   * When, in sim seconds, the host lets each player act again: by what the action is timed
   * under, then by player id.
   */
  readonly readyAt: Map<string, Map<string, number>>;
  /** When, in sim seconds, the local player may next act, by what the action is timed under. */
  readonly localReadyAt: Map<string, number>;
  /** While hosting, how each remote player has moved, by player id. */
  readonly moveChecks: Map<string, MoveCheck>;
  /** While hosting, what this client reckons of each remote player's stamina, by player id. */
  readonly staminaChecks: Map<string, StaminaCheck>;
  /** The content registered with it, in order. */
  readonly contents: WorldContent[];
  /** The flashes shown in the latest step; each step starts by clearing them. */
  readonly flashes: Flash[];
  /** What this client predicted of each entity, held until the host confirms it, by entity id. */
  readonly predictions: Map<string, Prediction>;
  /** The latest forced move this client has heard of on each remote player, by player id. */
  readonly forcedSeen: Map<string, ForcedMove>;
  /** The local player's epoch has settled on the room's count: heard from the host, or hosting. */
  epochSettled: boolean;
  /** For trying out a client that cheats: the local player takes no forced moves. */
  ignoresForcedMoves: boolean;
  /** The number of the local player's latest action; 0 before its first. */
  lastAction: number;
  /**
   * The local player's state changed in a way the others should hear at once; the room sends
   * it in its next frame, and clears this.
   */
  reportNow: boolean;
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
  if (kind === "dev") return buildDevWorld(config.world.cell, config.view);
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
    players: new Map([[localId, local]]),
    entities: new Map(),
    entityTypes: new Map(),
    kindIds: new Map(),
    nextEntityId: 1,
    hosting: true,
    time: 0,
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
    readyAt: new Map(),
    localReadyAt: new Map(),
    moveChecks: new Map(),
    staminaChecks: new Map(),
    contents: [],
    flashes: [],
    predictions: new Map(),
    forcedSeen: new Map(),
    epochSettled: false,
    ignoresForcedMoves: false,
    lastAction: 0,
    reportNow: false,
  };
  registerBuiltIns(game);
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

function separateSessionBodies(game: Session): void {
  const entities = [...game.entities.values()].filter(
    (entity) => entity.collides,
  );
  const bodies = [...game.players.values(), ...entities];
  const movable = new Set<CollisionBody>([game.local]);
  if (game.hosting) {
    entities.forEach((entity) => movable.add(entity));
  }

  separateBodies(bodies, game.world.map, movable);

  if (game.hosting) {
    entities.forEach((entity) => {
      entity.tx = entity.x;
      entity.ty = entity.y;
    });
  }
}

export function updateSession(
  game: Session,
  controls: Controls,
  dt: number,
): void {
  game.time += dt;
  game.worldTime += dt;
  game.noises.length = 0;
  game.flashes.length = 0;
  movingBodies(game).forEach(storePrevious);
  updatePlayer(game.local, controls, dt, game.world.map, game.config);
  stepDash(game.local, dt, game.world.map, solidBodiesBut(game, game.local));
  reportHeld(game);
  if (controls.use) useHeldItem(game);
  if (controls.interact) interact(game);
  for (const content of game.contents) content.act?.(game, controls);

  for (const player of remotePlayers(game)) {
    smoothPlayer(player, dt, game.config.net.smoothing);
    stepDash(player, dt, game.world.map, solidBodiesBut(game, player));
  }

  applyEvents(game);
  followInventories(game);
  followForcedMoves(game);
  emitFootsteps(game, dt);
  settlePredictions(game);
  if (game.hosting) {
    trackStamina(game, dt);
    updateEntities(game, dt);
    for (const content of game.contents) content.step?.(game, dt);
  } else followEntities(game, dt);

  separateSessionBodies(game);
  followHealth(game);
}

/**
 * The local player's state, as its STATE reports it. While it slides where the host forced it,
 * it reports where the slide ends, where every client is already moving it.
 */
export function playerState(game: Session): PlayerState {
  const { local } = game;
  const at = local.dash?.to ?? local;
  return {
    id: local.id,
    name: local.name,
    x: at.x,
    y: at.y,
    aim: local.aim,
    epoch: local.epoch,
    content: contentState(game),
  };
}

/** Drops a remote player; false when there is none by that id. */
export function removePlayer(game: Session, id: string): boolean {
  if (id === game.localId) return false;
  game.moveChecks.delete(id);
  game.staminaChecks.delete(id);
  return game.players.delete(id);
}

/**
 * Applies a remote player's reported state: "added" when the player is new to the session,
 * "rejected" for the local player's own id or a position inside a wall. A known player's position
 * stays put while `positionHeld` holds it back; the rest applies, since forced moves only move
 * players. While hosting, a position beyond the player's reach is not taken: the player is
 * corrected back where it last stood.
 */
export function applyRemoteState(
  game: Session,
  state: PlayerState,
): "added" | "updated" | "rejected" {
  if (state.id === game.localId) return "rejected";
  if (!isAreaFree(game.world.map, state.x, state.y, game.config.player.radius))
    return "rejected";

  const known = game.players.get(state.id);
  const player =
    known ?? createPlayer(state.id, state.name, state, game.config);
  if (known === undefined) {
    player.aim = state.aim;
    snapPrevious(player);
    game.players.set(state.id, player);
  }

  player.name = state.name;
  applyContentState(game, player, state.content);

  player.taim = state.aim;
  player.heardEpoch = Math.max(player.heardEpoch, state.epoch);
  if (known !== undefined && positionHeld(game, state)) return "updated";
  const verdict: MoveVerdict = game.hosting
    ? checkMove(game, player.id, state)
    : { kind: "take" };
  if (verdict.kind === "take") {
    player.tx = state.x;
    player.ty = state.y;
    player.epoch = state.epoch;
  } else correctPlayer(game, player, verdict.to);
  return known === undefined ? "added" : "updated";
}
