import {
  BOOST_MULT,
  BOOST_S,
  DEAD_S,
  EAT_INVULNERABLE_S,
  EntityKind,
  NetEvent,
  Relation,
  SCORE_PLAYER,
  SPAWN_CLEARANCE,
  SPAWN_INVULNERABLE_S,
  SPAWN_SAMPLES,
  SPAWN_WARNING_S,
  REMOTE_SNAP_DIST,
  Status,
} from "./config.js";
import { CLASS_DEFS } from "./classes/index.js";
import { moveWithCollision } from "./collision.js";
import { randomFreePosition } from "./map.js";
import { relationTo } from "./ranking.js";
import eatSound from "./assets/sfx/eat_food.mp3";

export function createPlayer({
  id,
  name,
  classId ,
  x,
  y,
  isDummy = false,
  status = Status.ALIVE,
}) {
  const player = {
    id,
    name,
    classId,
    kind: EntityKind.PLAYER,
    radius: CLASS_DEFS[classId].radius,
    collides: true,
    solid: true,
    get interactive() {
      return this.status === Status.ALIVE;
    },
    status,
    x,
    y,
    tx: x,
    ty: y,
    vx: 0,
    vy: 0,
    aim: 0,
    score: 0,
    scoredAt: Date.now(),
    boostLeft: 0,
    stateTimer: 0,
    stunLeft: 0,
    invulnerableLeft: 0,
    lastSeen: performance.now(),
    isDummy,
    classState: null,
    nextClassId: null,
    classNet: {},
    fearLeft: 0,
    fearX: 0,
    fearY: 0,
    cooldowns: { primary: 0, secondary: 0 },
  };
  return player;
}

export function setPlayerClass(player, classId) {
  player.classId = classId;
  player.radius = CLASS_DEFS[classId].radius;
}

export function respawn(player, players, world) {
  clearTransient(player);
  if (player.nextClassId !== null) {
    setPlayerClass(player, player.nextClassId);
    player.nextClassId = null;
  }
  const spawn = pickSpawn(players, player.id, world);
  player.x = spawn.x;
  player.y = spawn.y;
  player.tx = spawn.x;
  player.ty = spawn.y;
  player.status = Status.SPAWNING;
  player.stateTimer = SPAWN_WARNING_S;
}

function updateDead(player, dt, players, world) {
  player.stateTimer -= dt;
  if (player.stateTimer > 0) return;
  respawn(player, players, world);
}

function resetAbilities(player) {
  const def = CLASS_DEFS[player.classId];
  player.cooldowns = { primary: 0, secondary: 0 };
  player.classState = def.createState ? def.createState() : null;
  refreshClassNet(player);
}

function updateSpawning(player, dt) {
  player.stateTimer -= dt;
  if (player.stateTimer <= 0) {
    player.status = Status.ALIVE;
    player.invulnerableLeft = SPAWN_INVULNERABLE_S;
    resetAbilities(player);
  }
}

function moveDefault(ctx) {
  const { self, controls, dt, game } = ctx;
  const def = CLASS_DEFS[self.classId];
  const boost = self.boostLeft > 0 ? BOOST_MULT : 1;
  const intent = {
    moveX: controls.move.x,
    moveY: controls.move.y,
    accel: def.accel,
    friction: def.friction,
    maxSpeed: def.maxSpeed,
    phase: false,
  };
  def.adjustIntent?.(ctx, intent);

  const carriedSpeed = Math.hypot(self.vx, self.vy);
  self.vx += intent.moveX * intent.accel * boost * dt;
  self.vy += intent.moveY * intent.accel * boost * dt;

  const damp = Math.exp(-intent.friction * dt);
  const retainedSpeed = carriedSpeed * damp;
  self.vx *= damp;
  self.vy *= damp;

  const maxSpeed = Math.max(intent.maxSpeed * boost, retainedSpeed);
  const speed = Math.hypot(self.vx, self.vy);
  if (speed > maxSpeed) {
    self.vx = (self.vx / speed) * maxSpeed;
    self.vy = (self.vy / speed) * maxSpeed;
  }

  if (intent.phase) {
    self.x = Math.max(self.radius, Math.min(game.world.W - self.radius, self.x + self.vx * dt));
    self.y = Math.max(self.radius, Math.min(game.world.H - self.radius, self.y + self.vy * dt));
  } else {
    moveWithCollision(self, self.radius, dt, game.world.map, def.bounce);
  }
}

function applyMovement(ctx) {
  const def = CLASS_DEFS[ctx.self.classId];
  if (def.move) {
    def.move(ctx, moveDefault);
    return;
  }
  moveDefault(ctx);
}

function useAbility(player, ctx, def, slot, pressed) {
  const ability = def[slot];
  if (!ability || player.cooldowns[slot] > 0) return;
  if (!pressed && !(ability.repeatWhileHeld && ctx.controls[slot])) return;
  if (ability.use(ctx) === false) return;
  player.cooldowns[slot] = ability.cooldown;
}

export function applyFear(player, fromX, fromY, duration) {
  player.fearLeft = duration;
  player.fearX = fromX;
  player.fearY = fromY;
  player.vx = 0;
  player.vy = 0;
}

function effectiveControls(player, controls) {
  let result = controls;
  if (player.fearLeft > 0) {
    const angle = Math.atan2(player.y - player.fearY, player.x - player.fearX);
    result = {...result, move: {x: Math.cos(angle), y: Math.sin(angle)}};
  }
  return player.stunLeft > 0 ? withoutInput(result) : result;
}

function withoutInput(controls) {
  return {
    ...controls,
    move: { x: 0, y: 0 },
    primary: false,
    secondary: false,
    primaryPressed: false,
    secondaryPressed: false,
  };
}

export function updateOwned(player, controls, dt, game, net) {
  if (player.boostLeft > 0) player.boostLeft = Math.max(0, player.boostLeft - dt);
  player.cooldowns.primary = Math.max(0, player.cooldowns.primary - dt);
  player.cooldowns.secondary = Math.max(0, player.cooldowns.secondary - dt);
  player.stunLeft = Math.max(0, player.stunLeft - dt);
  player.invulnerableLeft = Math.max(0, player.invulnerableLeft - dt);

  if (player.status === Status.DEAD) {
    updateDead(player, dt, game.players, game.world);
    return;
  }

  if (player.status === Status.SPAWNING) {
    updateSpawning(player, dt);
    return;
  }

  player.fearLeft = Math.max(0, player.fearLeft - dt);
  const activeControls = effectiveControls(player, controls);
  player.aim = Math.atan2(activeControls.aim.y - player.y, activeControls.aim.x - player.x);
  const ctx = { self: player, controls: activeControls, dt, game, net };
  const def = CLASS_DEFS[player.classId];
  def.update?.(ctx);
  useAbility(player, ctx, def, "primary", controls.primaryPressed);
  useAbility(player, ctx, def, "secondary", controls.secondaryPressed);
  applyMovement(ctx);
  refreshClassNet(player);
}

function refreshClassNet(player) {
  player.classNet = CLASS_DEFS[player.classId].netState?.(player) ?? {};
}

function clearTransient(player) {
  player.classNet = {};
  player.fearLeft = 0;
}

export function kill(player) {
  clearTransient(player);
  player.status = Status.DEAD;
  player.stateTimer = DEAD_S;
  player.vx = 0;
  player.vy = 0;
  player.stunLeft = 0;
}

export function applyKnockback(player, dvx, dvy, stunS) {
  player.vx += dvx;
  player.vy += dvy;
  player.stunLeft = Math.max(player.stunLeft, stunS);
}

export function startRound(player, players, world) {
  player.score = 0;
  player.scoredAt = Date.now();
  player.boostLeft = 0;
  player.vx = 0;
  player.vy = 0;
  respawn(player, players, world);
}

export function addScore(player, points) {
  player.score += points;
  player.scoredAt = Date.now();
  player.invulnerableLeft = Math.max(player.invulnerableLeft, EAT_INVULNERABLE_S);
  CLASS_DEFS[player.classId].onScore?.(player);
}

export function catchPlayer(catcher, victim, game, net) {
  if (relationTo(catcher, victim) !== Relation.ABOVE) return;
  if (victim.invulnerableLeft > 0) return;

  addScore(catcher, SCORE_PLAYER);
  catcher.boostLeft = BOOST_S;
  kill(victim);
  if (catcher.id === game.localId) {
    game.sfx.play(eatSound, catcher, game.players.get(game.localId));
  }
  if (!victim.isDummy) net.send(NetEvent.CATCH, { victim: victim.id });
}

export function pickSpawn(players, selfId, world) {
  const others = [];
  for (const player of players.values()) {
    if (player.id !== selfId && player.status !== Status.DEAD) others.push(player);
  }

  let best = randomFreePosition(world, SPAWN_CLEARANCE);
  let bestDistance = -1;

  for (let i = 0; i < SPAWN_SAMPLES; i++) {
    const candidate = randomFreePosition(world, SPAWN_CLEARANCE);
    let nearest = Infinity;

    for (const other of others) {
      nearest = Math.min(nearest, Math.hypot(other.x - candidate.x, other.y - candidate.y));
    }

    if (nearest > bestDistance) {
      bestDistance = nearest;
      best = candidate;
    }
  }

  return best;
}

export function smoothRemote(player, dt) {
  const t = Math.min(1, dt * 12);
  player.x += (player.tx - player.x) * t;
  player.y += (player.ty - player.y) * t;
}

export function toStatePayload(player) {
  return {
    id: player.id,
    name: player.name,
    classId: player.classId,
    status: player.status,
    x: player.x,
    y: player.y,
    aim: player.aim,
    score: player.score,
    scoredAt: player.scoredAt,
    invulnerableLeft: player.invulnerableLeft,
    classNet: player.classNet,
  };
}

export function applyStatePayload(player, payload) {
  const wasAlive = player.status === Status.ALIVE;
  const shouldSnap =
    Math.hypot(payload.x - player.x, payload.y - player.y) > REMOTE_SNAP_DIST;

  player.name = payload.name;
  setPlayerClass(player, payload.classId);
  player.status = payload.status;
  player.aim = payload.aim;
  player.score = payload.score;
  player.scoredAt = payload.scoredAt;
  player.classNet = payload.classNet;
  player.invulnerableLeft = payload.invulnerableLeft;
  player.tx = payload.x;
  player.ty = payload.y;
  player.lastSeen = performance.now();

  if (!wasAlive || payload.status !== Status.ALIVE || shouldSnap) {
    player.x = payload.x;
    player.y = payload.y;
  }
}
