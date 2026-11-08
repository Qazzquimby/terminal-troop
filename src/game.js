import {
  EntityKind,
  FOOD_INTERVAL_S,
  FOOD_MAX,
  FOOD_PER_PLAYER,
  NetEvent,
  ROUND_RESULT_S,
  ROUND_S,
  SEND_HZ,
  STALE_S,
  Status,
} from "./config.js";
import { PlayerClass } from "./classes/index.js";
import { applyFear } from "./player.js";
import { recordTrails } from "./map.js";
import { createFood, randomFoodPosition } from "./entities/food.js";
import {
  replicatedStates,
  syncReplicatedEntities,
  touchEntities,
  updateEntities,
} from "./entities/index.js";
import { resolveBodyCollisions } from "./collision.js";
import {
  applyStatePayload,
  applyKnockback,
  createPlayer,
  kill,
  pickSpawn,
  setPlayerClass,
  respawn,
  smoothRemote,
  startRound,
  toStatePayload,
  updateOwned,
} from "./player.js";
import { compareRank } from "./ranking.js";
import {popClone} from "./classes/clone.js";
import deathSound from "./assets/sfx/death.mp3";
import { leaveRoom } from "./net.js";
import { applyWallEdit, tickWallEdits } from "./wall-edits.js";
import { buildWorld, getWorldSize, isAreaFree, mulberry32 } from "./map.js";

export const DUMMY_ID = "dummy";

const NO_CONTROLS = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  primary: false,
  secondary: false,
  primaryPressed: false,
  secondaryPressed: false,
};

function currentRoundStartedAt() {
  const roundMs = ROUND_S * 1000;
  return Math.floor(Date.now() / roundMs) * roundMs;
}

function regenerateMap(game, size = getWorldSize(game.players.size)) {
  Object.assign(
    game.world,
    buildWorld(size.cols, size.rows, mulberry32(game.roundStartedAt)),
  );
  for (const [id, entity] of game.entities) {
    if (!isAreaFree(game.world.map, entity.x, entity.y, entity.radius)) {
      game.entities.delete(id);
    }
  }
  game.trails.clear();
  game.wallEdits.clear();
}

function adoptLargerMap(game, mapInfo) {
  if (mapInfo.roundStartedAt !== game.roundStartedAt) return;
  if (mapInfo.cols * mapInfo.rows <= game.world.map.cols * game.world.map.rows) return;
  regenerateMap(game, {cols: mapInfo.cols, rows: mapInfo.rows});
}

export function createGame(localId, world, name, sfx) {
  const game = {
    localId,
    world,
    sfx,
    players: new Map(),
    entities: new Map(),
    foodTimer: FOOD_INTERVAL_S,
    lastSent: 0,
    nextEntityId: 1,
    roundStartedAt: currentRoundStartedAt(),
    roundResult: null,
    lastActiveAt: performance.now(),
    leaving: false,
    trails: new Map(), // todo, seems not sufficiently generalizable
    wallEdits: new Map(),
  };

  regenerateMap(game);

  const spawn = pickSpawn(game.players, localId, world);
  game.players.set(
    localId,
    createPlayer({
      id: localId,
      name,
      classId: PlayerClass.CLONE,
      status: Status.CHOOSING,
      x: spawn.x,
      y: spawn.y,
    }),
  );

  return game;
}

export function selectClass(game, classId) {
  const me = game.players.get(game.localId);
  if (me.status === Status.ALIVE) {
    me.nextClassId = classId;
    return;
  }

  me.nextClassId = null;
  setPlayerClass(me, classId);
  if (me.status === Status.CHOOSING) respawn(me, game.players, game.world);
}

function sendState(game, net) {
  const me = game.players.get(game.localId);
  if (me.status === Status.CHOOSING) return;
  net.send(NetEvent.STATE, {
    ...toStatePayload(me),
    map: {
      roundStartedAt: game.roundStartedAt,
      cols: game.world.map.cols,
      rows: game.world.map.rows,
    },
    entities: replicatedStates(game, me.id),
  });
}

export function roundSecondsLeft(game) {
  return Math.max(
    0,
    Math.ceil((ROUND_S * 1000 - (Date.now() - game.roundStartedAt)) / 1000),
  );
}

function updateRound(game) {
  const elapsed = Date.now() - game.roundStartedAt;
  const roundMs = ROUND_S * 1000;
  if (elapsed < roundMs) return;

  const winner = [...game.players.values()].sort(compareRank)[0];
  game.roundResult = {
    winnerName: winner && winner.score > 0 ? winner.name : null,
    winnerScore: winner?.score ?? 0,
    until: performance.now() + ROUND_RESULT_S * 1000,
  };
  game.roundStartedAt += Math.floor(elapsed / roundMs) * roundMs;
  regenerateMap(game);

  for (const player of [game.players.get(game.localId), game.players.get(DUMMY_ID)]) {
    if (player && player.status !== Status.CHOOSING) {
      startRound(player, game.players, game.world);
    }
  }
}

function updateAfk(game, controls) {
  const now = performance.now();
  if (controls.move.x !== 0 || controls.move.y !== 0) {
    game.lastActiveAt = now;
    return;
  }

  if (game.leaving || now - game.lastActiveAt <= ROUND_S * 1000) return;

  game.leaving = true;
  void leaveRoom().then(() => location.assign(location.pathname));
}

export function updateGame(game, input, dt, net) {
  const me = game.players.get(game.localId);
  const controls = input.getControls();
  updateAfk(game, controls);
  updateOwned(me, controls, dt, game, net);

  const dummy = game.players.get(DUMMY_ID);
  if (dummy) updateOwned(dummy, NO_CONTROLS, dt, game, net);
  updateRound(game);

  const now = performance.now();
  for (const [id, player] of game.players) {
    if (id === game.localId || player.isDummy) continue;
    smoothRemote(player, dt);
    if (now - player.lastSeen > STALE_S * 1000) game.players.delete(id);
  }

  if (me.status === Status.ALIVE && me.classId === PlayerClass.MONSTER) {
    recordTrails(game.trails, game, now);
  }
  tickWallEdits(game, dt);
  updateEntities(game, dt, net);
  resolveBodyCollisions(game);

  for (const player of [me, dummy]) {
    if (!player || player.status !== Status.ALIVE) continue;
    touchEntities(game, player, net);
  }

  if (isHost(game)) spawnFood(game, dt, net);

  if (now - game.lastSent >= 1000 / SEND_HZ) {
    game.lastSent = now;
    sendState(game, net);
  }
}


function isHost(game) {
  let host = null;
  for (const [id, player] of game.players) {
    if (player.isDummy) continue;
    if (host === null || id < host) host = id;
  }
  return host === game.localId;
}

function spawnFood(game, dt, net) {
  game.foodTimer -= dt;
  if (game.foodTimer > 0) return;
  game.foodTimer = FOOD_INTERVAL_S / game.players.size;
  let foodCount = 0;
  for (const entity of game.entities.values()) {
    if (entity.kind === EntityKind.FOOD) foodCount++;
  }
  if (foodCount >= FOOD_MAX + FOOD_PER_PLAYER * (game.players.size - 1)) return;

  const position = randomFoodPosition(game.world);
  const id = `${game.localId}:${game.nextEntityId++}`;
  game.entities.set(id, createFood(id, position.x, position.y));
  net.send(NetEvent.FOOD_SPAWN, { id, x: position.x, y: position.y });
}


export function toggleDummy(game) {
  if (game.players.has(DUMMY_ID)) {
    game.players.delete(DUMMY_ID);
    return;
  }

  const spawn = pickSpawn(game.players, DUMMY_ID, game.world);
  game.players.set(
    DUMMY_ID,
    createPlayer({
      id: DUMMY_ID,
      name: "DUMMY",
      classId: PlayerClass.TRACER,
      x: spawn.x,
      y: spawn.y,
      isDummy: true,
    }),
  );
}

export function handleState(game, payload) {
  if (payload.id === game.localId) return;

  adoptLargerMap(game, payload.map);

  let player = game.players.get(payload.id);
  if (!player) {
    player = createPlayer({
      id: payload.id,
      name: payload.name,
      classId: payload.classId,
      x: payload.x,
      y: payload.y,
    });
    game.players.set(payload.id, player);
  }

  setPlayerClass(player, payload.classId);
  applyStatePayload(player, payload);
  syncReplicatedEntities(game, player, payload.entities);
}

export function handleClonePopped(game, payload) {
  const entity = game.entities.get(payload.id);
  if (!entity) return;
  popClone(game, entity);
}

export function handleFear(game, payload) {
  if (payload.victim !== game.localId) return;
  const player = game.players.get(game.localId);
  if (!player || player.status !== Status.ALIVE) return;
  applyFear(player, payload.x, payload.y, payload.duration);
}

export function handleImpulse(game, payload) {
  if (payload.target !== game.localId) return;

  const me = game.players.get(game.localId);
  if (me.status !== Status.ALIVE) return;
  applyKnockback(me, payload.dvx, payload.dvy, payload.stun);
}

export function handleCatch(game, payload) {
  if (payload.victim !== game.localId) return;

  const me = game.players.get(game.localId);
  if (me.status !== Status.ALIVE) return;
  kill(me);
  game.sfx.play(deathSound, me, me);
}

export function handleBye(game, payload) {
  game.players.delete(payload.id);
}

export function handleWallEdit(game, payload) {
  applyWallEdit(game, payload);
}

export function handleFoodSpawn(game, payload) {
  if (game.entities.has(payload.id)) return;
  game.entities.set(payload.id, createFood(payload.id, payload.x, payload.y));
}

export function handleFoodEaten(game, payload) {
  game.entities.delete(payload.id);
}

export function handleFoodSync(game, payload) {
  for (const food of payload.foods) {
    if (game.entities.has(food.id)) continue;
    game.entities.set(food.id, createFood(food.id, food.x, food.y, 0));
  }
}

export function handleHello(game, net) {
  sendState(game, net);
  if (!isHost(game)) return;

  net.send(NetEvent.FOOD_SYNC, {
    foods: [...game.entities.values()]
      .filter((entity) => entity.kind === EntityKind.FOOD)
      .map((food) => ({ id: food.id, x: food.x, y: food.y })),
  });
}
