import type { Sfx } from "../audio/index.js";
import type { CollisionBody } from "./collision.js";
import { separateBodies } from "./collision.js";
import type { EntityType, Strike, WorldEntity } from "./entities.js";
import { followEntities, updateEntities } from "./entities.js";
import type { Moving } from "./interpolation.js";
import { snapPrevious, storePrevious } from "./interpolation.js";
import type { ViewConfig, World, WorldKind } from "./map.js";
import { buildDevWorld, buildWorld, isAreaFree, mulberry32 } from "./map.js";
import type { Controls, Player, PlayerRules, PlayerState } from "./player.js";
import { createPlayer, smoothPlayer, updatePlayer } from "./player.js";
import type { ItemEffect, UseRequest, UseSlack } from "./use.js";
import { applyUses } from "./use.js";
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
  nextEntityId: number;
  /** Whether this client runs the entities; otherwise they follow the host's snapshots. */
  hosting: boolean;
  /** Sim seconds stepped since the session began. */
  time: number;
  /** What each usable item does, by item id. */
  readonly items: Map<string, ItemEffect>;
  /** Uses waiting for the host's next step. */
  readonly uses: UseRequest[];
  /** When, in sim seconds, the host lets each player use an item again. */
  readonly readyAt: Map<string, number>;
  /** Damage the host has dealt to remote players, waiting to be sent to them. */
  readonly strikes: Strike[];
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
    readyAt: new Map(),
    strikes: [],
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

export function updateSession(
  game: Session,
  controls: Controls,
  dt: number,
): void {
  game.time += dt;
  movingBodies(game).forEach(storePrevious);
  updatePlayer(game.local, controls, dt, game.world.map, game.config);

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
