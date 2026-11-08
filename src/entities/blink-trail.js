import { EntityKind, RELATION_COLORS } from "../config.js";
import { relationTo } from "../ranking.js";
import { canSeePoint } from "../vision.js";
import { createEntity } from "./entity.js";

const TRAIL_S = 0.4;

export function createBlinkTrail(owner, id, from, to) {
  return createEntity({
    id,
    kind: EntityKind.BLINK_TRAIL,
    x: from.x,
    y: from.y,
    toX: to.x,
    toY: to.y,
    radius: owner.radius,
    friction: 0,
    collides: false,
    solid: false,
    interactive: false,
    ownerId: owner.id,
    lifeLeft: TRAIL_S,
  });
}

export const BLINK_TRAIL_DEF = Object.freeze({
  despawnWithOwner: false,
  replicated: true,
  create(owner, id, state) {
    return createBlinkTrail(owner, id, state, { x: state.toX, y: state.toY });
  },
  update(entity, dt, game) {
    entity.lifeLeft -= dt;
    if (entity.lifeLeft <= 0 && !entity.isRemote) game.entities.delete(entity.id);
  },
  isVisible(entity, viewer, game) {
    return (
      canSeePoint(game, viewer, entity) ||
      canSeePoint(game, viewer, { x: entity.toX, y: entity.toY })
    );
  },
  draw(ctx, entity, viewer, now, game) {
    const owner = game.players.get(entity.ownerId);
    const fade = Math.max(0, entity.lifeLeft / TRAIL_S);
    ctx.save();
    ctx.globalAlpha = fade * 0.6;
    ctx.strokeStyle = RELATION_COLORS[relationTo(viewer, owner)];
    ctx.lineWidth = entity.radius * 2 * fade;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(entity.x, entity.y);
    ctx.lineTo(entity.toX, entity.toY);
    ctx.stroke();
    ctx.restore();
  },
});
