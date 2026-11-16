import {
  CORPSE_ITEM,
  bodiesIn,
  circleAhead,
  defineItem,
  effect,
  heal,
  isRevivable,
  itemInstances,
  revive,
  spendUses,
} from "../../sim/index.js";
import type {
  Body,
  Circle,
  ItemInstance,
  ItemTraits,
  Point,
  Session,
  WorldEntity,
} from "../../sim/index.js";
// Its rip as it is wrapped on, once its asset lands; importing a missing file breaks the build.
// Until then it is wrapped on silently, though its noise still carries.
// import applyUrl from "./sfx/apply.mp3";

/** How a bandage is wrapped on. Distances in pixels, times in sim seconds. */
export interface BandageConfig extends ItemTraits {
  /** Share of a living body's full health one gives back, 0..1; never past its full. */
  readonly heal: number;
  /** Share of its player's full health a corpse comes back with, 0..1. */
  readonly revive: number;
  /** How far in front of its user it reaches for a body, from the user's centre. */
  readonly reach: number;
  /** The radius of what it reaches. */
  readonly radius: number;
  /** Least time between one player's uses. */
  readonly cooldown: number;
  /** How long its green flash shows. */
  readonly duration: number;
  /** Volume of its rip, 0..1. */
  readonly volume: number;
  /** How far, in pixels, its rip is heard, and so how far its noise carries. */
  readonly noiseRadius: number;
}

const ITEM = "bandage";

/** The green of a bandage's flash. */
const GREEN = "#7dff8a";

/** Whether `body` has health to win back: alive, short of its full, which has an end. */
const wounded = (body: Body): boolean =>
  body.health > 0 &&
  Number.isFinite(body.maxHealth) &&
  body.health < body.maxHealth;

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** The corpse lying in `area` nearest its centre whose player can come back, if any. */
function corpseIn(
  game: Session,
  area: Circle,
): (ItemInstance & { readonly place: { readonly lying: WorldEntity } }) | null {
  let best = null;
  for (const instance of itemInstances(game, CORPSE_ITEM)) {
    const { place } = instance;
    if (!("lying" in place) || !isRevivable(game, instance.state)) continue;
    const gap = distance(place.lying, area.center);
    if (gap > area.radius + place.lying.radius) continue;
    if (best === null || gap < distance(best.place.lying, area.center))
      best = { ...instance, place };
  }
  return best;
}

/** The wounded body in `area` nearest its centre, but `but`, if any. */
function woundedIn(game: Session, area: Circle, but: string): Body | null {
  const near = bodiesIn(game, area, but)
    .filter(wounded)
    .sort((a, b) => distance(a, area.center) - distance(b, area.center));
  return near[0] ?? null;
}

/**
 * A green cross on `center`, `progress` of the way, 0..1, through swelling up from `radius` and
 * fading out.
 */
function drawCross(
  ctx: CanvasRenderingContext2D,
  { x, y }: Point,
  radius: number,
  progress: number,
): void {
  const arm = radius * (0.6 + 0.6 * progress);
  const width = arm * 0.7;
  ctx.save();
  ctx.globalAlpha = (1 - progress) * 0.8;
  ctx.fillStyle = GREEN;
  ctx.fillRect(x - width / 2, y - arm, width, arm * 2);
  ctx.fillRect(x - arm, y - width / 2, arm * 2, width);
  ctx.restore();
}

/**
 * A bandage: used, it is wrapped on the first of these it finds, and spent.
 * - a corpse lying in front of its user, whose player stands back up beside it, alive on a share
 *   of its full health
 * - else a wounded body in front of it, any body, player or monster, given back a share of its
 *   full health
 * - else its user itself, if wounded
 * With none of them, it is not spent. Every client hears its rip, and sees a green flash on
 * whoever it is wrapped on.
 */
export const bandage = defineItem(ITEM, (config: BandageConfig) => {
  // const rip = sound({ url: applyUrl, volume: config.volume, range: config.noiseRadius });
  const show = (game: Session, on: Point & { readonly radius: number }) => {
    effect(game, {
      at: { x: on.x, y: on.y },
      use: { item: ITEM, hit: true },
      noise: config.noiseRadius,
      // sound: rip,
    });
  };
  return {
    name: "Bandage",
    emoji: "🩹",
    traits: config,
    use: {
      cooldown: config.cooldown,
      // Spent only once it is wrapped on something.
      spends: 0,
      apply(game, user, { slot, aim }) {
        const area = circleAhead(user, aim, config.reach, config.radius);
        const corpse = corpseIn(game, area);
        if (corpse !== null) {
          const { lying } = corpse.place;
          // The host brings it back; its own client sees the corpse rise in the host's snapshot.
          revive(
            game,
            corpse.state,
            lying,
            user.id,
            (player) => player.maxHealth * config.revive,
          );
          show(game, lying);
          spendUses(game, user, slot);
          return;
        }
        const body =
          woundedIn(game, area, user.id) ?? (wounded(user) ? user : null);
        if (body === null) return;
        heal(game, body, body.maxHealth * config.heal);
        show(game, body);
        spendUses(game, user, slot);
      },
    },
    draw(ctx, use, time) {
      const progress = (time - use.startedAt) / config.duration;
      if (progress >= 0 && progress <= 1)
        drawCross(ctx, use.center, config.radius, progress);
    },
  };
});
