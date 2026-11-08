import { EntityKind, REMOTE_SNAP_DIST, Status } from "../config.js";
import { moveWithCollision } from "../collision.js";
import { bodies } from "../collision.js";
import { smoothRemote } from "../player.js";
import { FOOD_DEF } from "./food.js";
import { PLAYER_DEF } from "./player-entity.js";
import { RECALL_MARKER_DEF } from "./recall-marker.js";
import { CLONE_DEF } from "./clone.js";
import { STICKY_BOMB_DEF } from "./sticky-bomb.js";
import {ILLUSION_DEF} from "./monster-illusion.js";
import { BLINK_TRAIL_DEF } from "./blink-trail.js";
import { ROCKET_DEF } from "./rocket.js";
import { HOOK_DEF } from "./hook.js";
import { PORTAL_BLUE_DEF, PORTAL_ORANGE_DEF } from "./portal.js";

export const ENTITY_DEFS = Object.freeze({
  [EntityKind.PLAYER]: PLAYER_DEF,
  [EntityKind.FOOD]: FOOD_DEF,
  [EntityKind.RECALL_MARKER]: RECALL_MARKER_DEF,
  [EntityKind.CLONE]: CLONE_DEF,
  [EntityKind.STICKY_BOMB]: STICKY_BOMB_DEF,
  [EntityKind.ILLUSION]: ILLUSION_DEF,
  [EntityKind.ROCKET]: ROCKET_DEF,
  [EntityKind.HOOK]: HOOK_DEF,
  [EntityKind.PORTAL_BLUE]: PORTAL_BLUE_DEF,
  [EntityKind.PORTAL_ORANGE]: PORTAL_ORANGE_DEF,
  [EntityKind.BLINK_TRAIL]: BLINK_TRAIL_DEF,
});

export function replicatedStates(game, ownerId) {
  return [...game.entities.values()]
    .filter((entity) => entity.ownerId === ownerId && ENTITY_DEFS[entity.kind].replicated)
    .map(({ id, kind, x, y, vx, vy, toX, toY }) => ({ id, kind, x, y, vx, vy, toX, toY }));
}

export function syncReplicatedEntities(game, owner, states = []) {
  const stateIds = new Set(states.map((state) => state.id));

  for (const state of states) {
    let entity = game.entities.get(state.id);
    const isNew = !entity;
    if (isNew) {
      entity = ENTITY_DEFS[state.kind].create(owner, state.id, state);
      game.entities.set(state.id, entity);
    }

    entity.isRemote = true;
    entity.tx = state.x;
    entity.ty = state.y;
    if (
      isNew ||
      Math.hypot(state.x - entity.x, state.y - entity.y) > REMOTE_SNAP_DIST
    ) {
      entity.x = state.x;
      entity.y = state.y;
    }
    entity.vx = state.vx;
    entity.vy = state.vy;
  }

  for (const [id, entity] of game.entities) {
    if (
      entity.ownerId === owner.id &&
      ENTITY_DEFS[entity.kind].replicated &&
      !stateIds.has(id)
    ) {
      game.entities.delete(id);
    }
  }
}

export function updateEntities(game, dt, net) {
  for (const [id, entity] of game.entities) {
    const def = ENTITY_DEFS[entity.kind];
    if (def.despawnWithOwner) {
      const owner = game.players.get(entity.ownerId);
      if (!owner || owner.status !== Status.ALIVE) {
        game.entities.delete(id);
        continue;
      }
    }

    def.update?.(entity, dt, game, net);
    if (entity.isRemote) {
      smoothRemote(entity, dt);
      continue;
    }
    if (entity.vx === 0 && entity.vy === 0) continue;

    entity.vx *= Math.exp(-entity.friction * dt);
    entity.vy *= Math.exp(-entity.friction * dt);
    if (entity.collides) {
      moveWithCollision(entity, entity.radius, dt, game.world.map);
    } else {
      entity.x += entity.vx * dt;
      entity.y += entity.vy * dt;
    }
  }
}

export function touchEntities(game, toucher, net) {
  for (const body of bodies(game)) {
    if (body === toucher || !body.interactive) continue;
    const def = ENTITY_DEFS[body.kind];
    if (!def.onTouch) continue;
    if (Math.hypot(body.x - toucher.x, body.y - toucher.y) > toucher.radius + body.radius) continue;
    def.onTouch(body, toucher, game, net);
  }
}
