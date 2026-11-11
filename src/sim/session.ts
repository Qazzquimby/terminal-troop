import type { Sfx } from "../audio/index.js";
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
import type { EntityType, WorldEntity } from "./entities.js";
import { followEntities, updateEntities } from "./entities.js";
import type { Moving } from "./interpolation.js";
import type { ItemDefinition } from "./inventory.js";
import { snapPrevious, storePrevious } from "./interpolation.js";
import type { ViewConfig, World, WorldKind } from "./map.js";
import { buildDevWorld, buildWorld, isAreaFree, mulberry32 } from "./map.js";
import type { Controls, Player, PlayerRules, PlayerState } from "./player.js";
import { createPlayer, smoothPlayer, updatePlayer } from "./player.js";
import type { PlayerData } from "./player-data.js";
import { applyContentState, contentState } from "./player-data.js";
import type { ItemBehaviour, UseSlack } from "./use.js";
import { reportHeld, useHeldItem } from "./use.js";
import type { LightConfig, VisionConfig } from "./vision.js";

/** How remote players follow the state they report. */
interface SyncConfig {
  /** Rate, per second, at which remote players ease towards their reported state. */
  readonly smoothing: number;
  readonly useSlack: UseSlack;
}

/** The tuning a session runs on; it keeps this for its lifetime. */
export interface SimConfig extends PlayerRules {
  readonly view: ViewConfig;
  readonly vision: VisionConfig;
  readonly light: LightConfig;
  readonly net: SyncConfig;
}

export interface Session {
  readonly localId: string;
  readonly config: SimConfig;
  /** The local player; also present in `players`. */
  readonly local: Player;
  readonly world: World;
  /** Seeded by the room code, so the same on every client in the room. */
  readonly seed: number;
  readonly sfx: Sfx;
  readonly players: Map<string, Player>;
  readonly entities: Map<string, WorldEntity>;
  readonly entityTypes: Map<number, EntityType>;
  /** The number each kind is registered and sent as, by name. */
  readonly kindIds: Map<string, number>;
  nextEntityId: number;
  /** Whether this client runs the entities; otherwise they follow the host's snapshots. */
  hosting: boolean;
  /** Sim seconds stepped since the session began. */
  time: number;
  /** What each usable item does, by item id. */
  readonly items: Map<string, ItemBehaviour>;
  /** Every item this client knows, by item id. */
  readonly itemDefinitions: Map<string, ItemDefinition>;
  /** The state each content entry keeps on every player, by the entry's name. */
  readonly playerData: Map<string, PlayerData<unknown>>;
  /** Each content entry's events, by the entry's name, then by key. */
  readonly events: Map<string, Map<string, ContentEvent<unknown>>>;
  /** Where each registered event travels. */
  readonly eventAddresses: Map<ContentEvent<unknown>, EventAddress>;
  /** Events received, waiting for the next step. */
  readonly inbox: Delivery[];
  /** Events sent, waiting for the room to route them. */
  readonly outbox: OutgoingEvent[];
  /** When, in sim seconds, the host lets each player use an item again. */
  readonly readyAt: Map<string, number>;
  /**
   * The local player's state changed in a way the others should hear at once; the room sends
   * it in its next frame, and clears this.
   */
  reportNow: boolean;
}

function roomSeed(code: string, base: number): number {
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
): Session {
  const seed = roomSeed(roomCode, config.world.seed);
  const world = buildRoomWorld(seed, worldKind, config);
  const local = createPlayer(localId, name, world, config);

  const game: Session = {
    localId,
    config,
    local,
    world,
    seed,
    sfx,
    players: new Map([[localId, local]]),
    entities: new Map(),
    entityTypes: new Map(),
    kindIds: new Map(),
    nextEntityId: 1,
    hosting: true,
    time: 0,
    items: new Map(),
    itemDefinitions: new Map(),
    playerData: new Map(),
    events: new Map(),
    eventAddresses: new Map(),
    inbox: [],
    outbox: [],
    readyAt: new Map(),
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
  movingBodies(game).forEach(storePrevious);
  updatePlayer(game.local, controls, dt, game.world.map, game.config);
  reportHeld(game.local);
  if (controls.use) useHeldItem(game);

  for (const player of remotePlayers(game)) {
    smoothPlayer(player, dt, game.config.net.smoothing);
  }

  applyEvents(game);
  if (game.hosting) updateEntities(game, dt);
  else followEntities(game, dt);

  separateSessionBodies(game);
}

/** The local player's state, as its STATE reports it. */
export function playerState(game: Session): PlayerState {
  const { local } = game;
  return {
    id: local.id,
    name: local.name,
    x: local.x,
    y: local.y,
    aim: local.aim,
    health: local.health,
    content: contentState(game),
  };
}

/** Drops a remote player; false when there is none by that id. */
export function removePlayer(game: Session, id: string): boolean {
  if (id === game.localId) return false;
  return game.players.delete(id);
}

/**
 * Applies a remote player's reported state: "added" when the player is new to the session,
 * "rejected" for the local player's own id or a position inside a wall.
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
    known ?? createPlayer(state.id, state.name, game.world, game.config);
  if (known === undefined) {
    player.x = state.x;
    player.y = state.y;
    player.aim = state.aim;
    snapPrevious(player);
    game.players.set(state.id, player);
  }

  player.name = state.name;
  player.health = Math.min(state.health, player.maxHealth);
  applyContentState(game, player, state.content);

  player.tx = state.x;
  player.ty = state.y;
  player.taim = state.aim;
  return known === undefined ? "added" : "updated";
}
