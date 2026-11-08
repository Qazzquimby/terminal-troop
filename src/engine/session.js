import {
  NetEvent,
  PLAYER_RADIUS,
  SEND_HZ,
  STALE_S,
  WORLD_COLS,
  WORLD_ROWS,
  WORLD_SEED,
} from "./config.js";
import { buildWorld, isAreaFree, mulberry32 } from "./map.js";
import {
  createPlayer,
  playerState,
  smoothPlayer,
  updatePlayer,
} from "./player.js";
import { updateEntities } from "./entities.js";

function roomSeed(code) {
  let seed = WORLD_SEED;
  for (const character of code) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  }
  return seed >>> 0;
}

export function createSession(localId, name, roomCode, sfx) {
  const world = buildWorld(
    WORLD_COLS,
    WORLD_ROWS,
    mulberry32(roomSeed(roomCode)),
  );
  const player = createPlayer(localId, name, world);

  return {
    localId,
    world,
    sfx,
    players: new Map([[localId, player]]),
    entities: new Map(),
    entityTypes: new Map(),
    nextEntityId: 1,
    lastSent: -Infinity,
  };
}

export function updateSession(game, controls, dt, now) {
  const me = game.players.get(game.localId);
  updatePlayer(me, controls, dt, game.world.map);

  for (const [id, player] of game.players) {
    if (id === game.localId) continue;
    if (now - player.lastSeen > STALE_S * 1000) {
      game.players.delete(id);
    } else {
      smoothPlayer(player, dt);
    }
  }

  updateEntities(game, dt);
}

export function sendState(game, net, now, force = false) {
  if (!force && now - game.lastSent < 1000 / SEND_HZ) return;
  game.lastSent = now;
  net.send(NetEvent.STATE, playerState(game.players.get(game.localId)));
}

export function receiveState(game, state) {
  if (
    !state ||
    typeof state.id !== "string" ||
    state.id.length === 0 ||
    state.id.length > 64 ||
    state.id === game.localId ||
    typeof state.name !== "string" ||
    !Number.isFinite(state.x) ||
    !Number.isFinite(state.y) ||
    !Number.isFinite(state.aim) ||
    !isAreaFree(game.world.map, state.x, state.y, PLAYER_RADIUS)
  ) {
    return;
  }

  let player = game.players.get(state.id);
  if (!player) {
    player = createPlayer(state.id, state.name.slice(0, 8), game.world);
    player.x = state.x;
    player.y = state.y;
    game.players.set(state.id, player);
  }

  player.name = state.name.slice(0, 8);
  player.tx = state.x;
  player.ty = state.y;
  player.aim = state.aim;
  player.lastSeen = performance.now();
}
