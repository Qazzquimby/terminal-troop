import type { Sfx } from "../audio/index.js";
import type { ScrapConfig } from "../items/scrap.js";
import { SCRAP, SCRAP_SOUNDS, ScrapKind } from "../items/scrap.js";
import type { CollisionBody } from "./collision.js";
import { separateBodies } from "./collision.js";
import type { EntityType, Strike, WorldEntity } from "./entities.js";
import { followEntities, updateEntities } from "./entities.js";
import type { Moving } from "./interpolation.js";
import { snapPrevious, storePrevious } from "./interpolation.js";
import type { CruiserConfig } from "./cruiser.js";
import { CruiserKind } from "./cruiser.js";
import { addItem, heldItem, removeItem } from "./inventory.js";
import type { ViewConfig, World, WorldKind } from "./map.js";
import { buildDevWorld, buildWorld, isAreaFree, mulberry32 } from "./map.js";
import type { Controls, Player, PlayerRules, PlayerState } from "./player.js";
import { createPlayer, smoothPlayer, updatePlayer } from "./player.js";
import type { ItemBehaviour, UseRequest, UseSlack } from "./use.js";
import { applyUses, useHeldItem } from "./use.js";
import type { LightConfig, VisionConfig } from "./vision.js";

/** A player's pickup of a ground entity, for the host to remove it. */
export interface PickupRequest {
  readonly by: string;
  readonly entityId: string;
}

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
  readonly scrap: ScrapConfig;
  readonly cruiser: CruiserConfig;
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
  nextEntityId: number;
  /** Whether this client runs the entities; otherwise they follow the host's snapshots. */
  hosting: boolean;
  /** Sim seconds stepped since the session began. */
  time: number;
  /** What each usable item does, by item id. */
  readonly items: Map<string, ItemBehaviour>;
  /** Uses waiting for the host's next step. */
  readonly uses: UseRequest[];
  /** The local player's uses, waiting for the room to hand them to the host. */
  readonly localUses: UseRequest[];
  /** The local player's pickups, waiting for the room to hand them to the host. */
  readonly localPickups: PickupRequest[];
  /** Ground entity ids the local player has picked up, kept out of the host's snapshots. */
  readonly collected: Set<string>;
  /** When, in sim seconds, the host lets each player use an item again. */
  readonly readyAt: Map<string, number>;
  /** Damage the host has dealt to remote players, waiting to be sent to them. */
  readonly strikes: Strike[];
  /** The room's shared credit total. */
  credit: number;
  /** Credits the local player cashed out, waiting for the room to send them. */
  readonly cashOuts: number[];
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

  return {
    localId,
    config,
    local,
    world,
    seed,
    sfx,
    players: new Map([[localId, local]]),
    entities: new Map(),
    entityTypes: new Map(),
    nextEntityId: 1,
    hosting: true,
    time: 0,
    items: new Map(),
    uses: [],
    localUses: [],
    localPickups: [],
    collected: new Set(),
    readyAt: new Map(),
    strikes: [],
    credit: 0,
    cashOuts: [],
  };
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

/** Whether the local player is close enough to the cruiser to cash out. */
function nearCruiser(game: Session, radius: number): boolean {
  for (const entity of game.entities.values()) {
    if (entity.kind !== CruiserKind) continue;
    const distance = Math.hypot(
      entity.x - game.local.x,
      entity.y - game.local.y,
    );
    if (distance <= radius + entity.radius) return true;
  }
  return false;
}

/**
 * Cashes out the scrap the local player holds beside the cruiser: adds to this client's credit
 * and queues the amount for the room to send. Consumes one scrap.
 */
function cashOut(game: Session): void {
  const slot = game.local.held;
  if (slot === null) return;
  const stack = heldItem(game.local.inventory, slot);
  if (stack?.item.id !== SCRAP.id) return;
  if (!nearCruiser(game, game.config.cruiser.cashoutRadius)) return;

  removeItem(game.local.inventory, slot, 1);
  void game.sfx.play(SCRAP_SOUNDS.cashout, game.local, game.local, {
    volume: game.config.scrap.cashoutVolume,
  });
  const value = game.config.scrap.value;
  game.credit += value;
  game.cashOuts.push(value);
}

/**
 * Picks up the ground scrap the local player is standing on, if its inventory has room, and
 * asks the host to remove it from the world.
 */
function pickUp(game: Session): void {
  const { local } = game;
  for (const entity of game.entities.values()) {
    if (entity.kind !== ScrapKind) continue;
    if (game.collected.has(entity.id)) continue;
    if (
      Math.hypot(entity.x - local.x, entity.y - local.y) >
      local.radius + entity.radius
    )
      continue;
    if (addItem(local.inventory, SCRAP, 1) > 0) return;
    game.collected.add(entity.id);
    game.entities.delete(entity.id);
    if (!game.hosting)
      game.localPickups.push({ by: local.id, entityId: entity.id });
    return;
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
  pickUp(game);
  if (controls.use) useHeldItem(game);
  cashOut(game);

  for (const player of remotePlayers(game)) {
    smoothPlayer(player, dt, game.config.net.smoothing);
  }

  applyUses(game);
  if (game.hosting) updateEntities(game, dt);
  else followEntities(game, dt);

  separateSessionBodies(game);
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

  player.tx = state.x;
  player.ty = state.y;
  player.taim = state.aim;
  return known === undefined ? "added" : "updated";
}
