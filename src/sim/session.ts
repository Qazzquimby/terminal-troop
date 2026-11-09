import { NetEvent, parseStateMessage } from "../net/index.js";
import type { Sfx } from "../audio/index.js";
import type { EntityDefinition, WorldEntity } from "./entities.js";
import { updateEntities } from "./entities.js";
import type { Moving } from "./interpolation.js";
import { snapPrevious, storePrevious } from "./interpolation.js";
import type { ViewConfig, World, WorldKind } from "./map.js";
import { buildDevWorld, buildWorld, isAreaFree, mulberry32 } from "./map.js";
import type { Controls, Player, PlayerRules } from "./player.js";
import {
  createPlayer,
  playerState,
  smoothPlayer,
  updatePlayer,
} from "./player.js";
import type { Transport } from "../net/index.js";
import type { LightConfig, VisionConfig } from "./vision.js";

/** How a session shares state with the room. */
interface SyncConfig {
  /** Most state sends per second. */
  readonly sendHz: number;
  /** Seconds without a state before a remote player is dropped. */
  readonly staleS: number;
  /** Rate, per second, at which remote players ease towards their reported state. */
  readonly smoothing: number;
}

/** The tuning a session runs on; it keeps this for its lifetime. */
export interface SimConfig extends PlayerRules {
  readonly view: ViewConfig;
  readonly vision: VisionConfig;
  readonly light: LightConfig;
  readonly net: SyncConfig;
}

/** Hears when a remote player appears or goes away. */
export interface RosterEvents {
  playerJoined: (id: string) => void;
  playerLeft: (id: string) => void;
}

const NO_ROSTER_EVENTS: RosterEvents = {
  playerJoined: () => undefined,
  playerLeft: () => undefined,
};

export interface Session {
  readonly localId: string;
  readonly config: SimConfig;
  /** The local player; also present in `players`. */
  readonly local: Player;
  readonly world: World;
  readonly sfx: Sfx;
  readonly players: Map<string, Player>;
  readonly roster: RosterEvents;
  readonly entities: Map<string, WorldEntity>;
  readonly entityTypes: Map<number, EntityDefinition>;
  nextEntityId: number;
  lastSent: number;
}

function roomSeed(code: string, base: number): number {
  let seed = base;
  for (const character of code) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  }
  return seed >>> 0;
}

/**
 * The channel a room's players meet on. The world kind is part of it, so clients running
 * different worlds land in separate rooms rather than on mismatched maps.
 */
export function roomKey(code: string, kind: WorldKind): string {
  return kind === "standard" ? code : `${kind}:${code}`;
}

function buildRoomWorld(
  roomCode: string,
  kind: WorldKind,
  config: SimConfig,
): World {
  if (kind === "dev") return buildDevWorld(config.world.cell, config.view);
  return buildWorld(
    config.world,
    mulberry32(roomSeed(roomCode, config.world.seed)),
  );
}

export function createSession(
  localId: string,
  name: string,
  roomCode: string,
  worldKind: WorldKind,
  sfx: Sfx,
  config: SimConfig,
  roster: RosterEvents = NO_ROSTER_EVENTS,
): Session {
  const world = buildRoomWorld(roomCode, worldKind, config);
  const local = createPlayer(localId, name, world, config);

  return {
    localId,
    config,
    local,
    world,
    sfx,
    players: new Map([[localId, local]]),
    roster,
    entities: new Map(),
    entityTypes: new Map(),
    nextEntityId: 1,
    lastSent: -Infinity,
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

export function updateSession(
  game: Session,
  controls: Controls,
  dt: number,
  now: number,
): void {
  movingBodies(game).forEach(storePrevious);
  updatePlayer(game.local, controls, dt, game.world.map, game.config);

  for (const player of remotePlayers(game)) {
    if (now - player.lastSeen > game.config.net.staleS * 1000) {
      removePlayer(game, player.id);
    } else {
      smoothPlayer(player, dt, game.config.net.smoothing);
    }
  }

  updateEntities(game, dt);
}

/** Drops a remote player, on BYE or when it goes stale. */
export function removePlayer(game: Session, id: string): void {
  if (id === game.localId || !game.players.delete(id)) return;
  game.roster.playerLeft(id);
}

export function sendState(
  game: Session,
  transport: Pick<Transport, "send">,
  now: number,
  force = false,
): void {
  if (!force && now - game.lastSent < 1000 / game.config.net.sendHz) return;
  game.lastSent = now;
  void transport.send(NetEvent.STATE, playerState(game.local));
}

export function receiveState(game: Session, payload: unknown): void {
  const state = parseStateMessage(payload, game.config.player.nameMax);
  if (state === null) return;
  if (state.id === game.localId) return;
  if (!isAreaFree(game.world.map, state.x, state.y, game.config.player.radius))
    return;

  let player = game.players.get(state.id);
  if (player === undefined) {
    player = createPlayer(state.id, state.name, game.world, game.config);
    player.x = state.x;
    player.y = state.y;
    player.aim = state.aim;
    snapPrevious(player);
    game.players.set(state.id, player);
    game.roster.playerJoined(state.id);
  }

  player.name = state.name;
  player.tx = state.x;
  player.ty = state.y;
  player.taim = state.aim;
  player.lastSeen = performance.now();
}
