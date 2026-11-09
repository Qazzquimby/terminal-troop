import { NetEvent, StateMessage } from "../net/index.js";
import {
  PLAYER_RADIUS,
  SEND_HZ,
  STALE_S,
  WORLD_COLS,
  WORLD_ROWS,
  WORLD_SEED,
} from "./config.js";
import type { Sfx } from "../audio/index.js";
import type { EntityDefinition, WorldEntity } from "./entities.js";
import { updateEntities } from "./entities.js";
import type { Moving } from "./interpolation.js";
import { snapPrevious, storePrevious } from "./interpolation.js";
import type { World, WorldKind } from "./map.js";
import { buildDevWorld, buildWorld, isAreaFree, mulberry32 } from "./map.js";
import type { Controls, Player } from "./player.js";
import {
  createPlayer,
  playerState,
  smoothPlayer,
  updatePlayer,
} from "./player.js";
import type { Transport } from "../net/index.js";

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

function roomSeed(code: string): number {
  let seed = WORLD_SEED;
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

function buildRoomWorld(roomCode: string, kind: WorldKind): World {
  if (kind === "dev") return buildDevWorld();
  return buildWorld(WORLD_COLS, WORLD_ROWS, mulberry32(roomSeed(roomCode)));
}

export function createSession(
  localId: string,
  name: string,
  roomCode: string,
  worldKind: WorldKind,
  sfx: Sfx,
  roster: RosterEvents = NO_ROSTER_EVENTS,
): Session {
  const world = buildRoomWorld(roomCode, worldKind);
  const local = createPlayer(localId, name, world);

  return {
    localId,
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
  updatePlayer(game.local, controls, dt, game.world.map);

  game.players.forEach((player, id) => {
    if (id === game.localId) return;
    if (now - player.lastSeen > STALE_S * 1000) {
      removePlayer(game, id);
    } else {
      smoothPlayer(player, dt);
    }
  });

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
  if (!force && now - game.lastSent < 1000 / SEND_HZ) return;
  game.lastSent = now;
  void transport.send(NetEvent.STATE, playerState(game.local));
}

export function receiveState(game: Session, payload: unknown): void {
  const parsed = StateMessage.safeParse(payload);
  if (!parsed.success) return;
  const state = parsed.data;
  if (state.id === game.localId) return;
  if (!isAreaFree(game.world.map, state.x, state.y, PLAYER_RADIUS)) return;

  let player = game.players.get(state.id);
  if (player === undefined) {
    player = createPlayer(state.id, state.name, game.world);
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
