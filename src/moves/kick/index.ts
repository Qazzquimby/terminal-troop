import { z } from "zod";
import {
  applyDamage,
  broadcastNoise,
  circleAhead,
  contentEvent,
  entitiesIn,
  hostAccepts,
  knockBack,
  showEffect,
  spendStamina,
  startDash,
} from "../../sim/index.js";
import type {
  Circle,
  Content,
  Effect,
  Point,
  Session,
} from "../../sim/index.js";

/** How a kick works. Distances in pixels unless said otherwise, times in sim seconds. */
export interface KickConfig {
  /** How far in front of the kicker, once it has lunged, the hitbox is centred. */
  readonly reach: number;
  /** The radius of the hitbox. */
  readonly radius: number;
  /** Damage dealt to every world entity in the hitbox. */
  readonly damage: number;
  /** How far a kicked entity is pushed away from the kicker, in its own body lengths. */
  readonly knockback: number;
  /** Minimum time between kicks. */
  readonly cooldown: number;
  /** Stamina a kick costs; a player with less does not kick. */
  readonly stamina: number;
  /** The kicker's lunge forward as it kicks. */
  readonly lunge: {
    /** How far, in the kicker's own body lengths. */
    readonly lengths: number;
    readonly seconds: number;
  };
  /** How long a kick is shown. */
  readonly duration: number;
  /** How loud a kick is, as a multiple of a listener's hearing range. */
  readonly loudness: number;
}

/** What kicks are timed under, and the content entry's own name. */
const NAME = "move/kick";

/** A body's length: its diameter. */
const bodyLength = (body: { readonly radius: number }): number =>
  body.radius * 2;

/** A kick as a player reports it: where it stands once it has lunged, and which way it faces. */
const Kicked = z.object({ x: z.number(), y: z.number(), aim: z.number() });

/** A kick the host accepted, as every other client shows it. */
const Shown = z.object({
  by: z.string().min(1).max(64),
  x: z.number(),
  y: z.number(),
  hit: z.boolean(),
});

/** A flash over the hitbox that swells and fades; orange when it connected. */
function kickEffect(
  area: Circle,
  hit: boolean,
  startedAt: number,
  duration: number,
): Effect {
  const { center, radius } = area;
  const color = hit ? "#f0a35e" : "#cfd6dd";
  return {
    startedAt,
    duration,
    draw(ctx, progress) {
      const fade = 1 - progress;
      ctx.globalAlpha = fade * 0.35;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(
        center.x,
        center.y,
        radius * (0.6 + 0.4 * progress),
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.globalAlpha = fade;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
    },
  };
}

/**
 * The kick: what every player can do empty-handed, whatever it holds. The kicker lunges a little
 * and spends stamina on its own client; the host checks the kick, then hurts and knocks back
 * every world entity in front of the kicker, never a player, and makes a noise.
 */
export const kick: Content<"kick", KickConfig> = {
  name: "kick",
  create(configs) {
    const config = configs.kick;
    const hitbox = (at: Point, aim: number): Circle =>
      circleAhead(at, aim, config.reach, config.radius);
    const show = (game: Session, area: Circle, hit: boolean): void => {
      showEffect(game, kickEffect(area, hit, game.time, config.duration));
    };

    const shown = contentEvent({
      schema: Shown,
      to: "all",
      from: "host",
      receive(game, { by, x, y, hit }) {
        if (by !== game.localId)
          show(game, { center: { x, y }, radius: config.radius }, hit);
      },
    });

    const kicked = contentEvent({
      schema: Kicked,
      to: "host",
      receive(game, at, by) {
        if (!hostAccepts(game, by, at, NAME, config.cooldown)) return;
        const area = hitbox(at, at.aim);
        const hit = entitiesIn(game, area);
        for (const entity of hit) {
          applyDamage(entity, config.damage);
          const distance = bodyLength(entity) * config.knockback;
          knockBack(entity, at, distance, game.world.map, "stop");
        }
        broadcastNoise(game, {
          at: area.center,
          loudness: config.loudness,
          source: by,
        });
        shown.send(game, { by, ...area.center, hit: hit.length > 0 });
      },
    });

    return {
      name: NAME,
      events: { kicked, shown },
      register: () => undefined,
      populate: () => undefined,
      act(game, controls) {
        if (!controls.kick) return;
        const { local } = game;
        if (game.time < (game.localReadyAt.get(NAME) ?? -Infinity)) return;
        const stamina = spendStamina(local.stamina, config.stamina);
        if (stamina === null) return;
        local.stamina = stamina;
        game.localReadyAt.set(NAME, game.time + config.cooldown);
        const { lengths, seconds } = config.lunge;
        const at = startDash(
          local,
          local.aim,
          bodyLength(local) * lengths,
          seconds,
          game.world.map,
        );
        const area = hitbox(at, local.aim);
        show(game, area, entitiesIn(game, area).length > 0);
        kicked.send(game, { x: at.x, y: at.y, aim: local.aim });
      },
    };
  },
};
