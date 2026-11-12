import { z } from "zod";
import {
  applyDamage,
  broadcastNoise,
  circleAhead,
  contentEvent,
  entitiesIn,
  hostAccepts,
  hurtPlayer,
  knockBack,
  playersIn,
  nextAction,
  predict,
  confirmAction,
  showFlash,
  spendStamina,
  solidBodiesBut,
  startDash,
} from "../../sim/index.js";
import type {
  Circle,
  Content,
  Point,
  Session,
  WorldEntity,
} from "../../sim/index.js";

/** How a kick works. Distances in pixels unless said otherwise, times in sim seconds. */
export interface KickConfig {
  /** How far in front of the kicker, once it has lunged, the hitbox is centred. */
  readonly reach: number;
  /** The radius of the hitbox. */
  readonly radius: number;
  /** Damage dealt to every world entity and other player in the hitbox. */
  readonly damage: number;
  /** How far a kicked entity or player is pushed away from the kicker, in its own body lengths. */
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
  /** How loud a kick is, as a multiple of a listener's hearing range. */
  readonly loudness: number;
}

/** What kicks are timed under, and the content entry's own name. */
const NAME = "move/kick";

/** A body's length: its diameter. */
const bodyLength = (body: { readonly radius: number }): number =>
  body.radius * 2;

/**
 * A kick as a player reports it: where it stands once it has lunged, which way it faces, and its
 * action number.
 */
const Kicked = z.object({
  x: z.number(),
  y: z.number(),
  aim: z.number(),
  action: z.number().int().positive(),
});

/** A kick the host accepted, as every other client shows it. */
const Shown = z.object({
  by: z.string().min(1).max(64),
  x: z.number(),
  y: z.number(),
  hit: z.boolean(),
});

/**
 * The kick: what every player can do empty-handed, whatever it holds, on the secondary action.
 * The kicker lunges a little, up to whatever is in its way, and spends stamina on its own client; the host checks the kick, then hurts and knocks back
 * every world entity and every other player in front of the kicker, and makes a noise. A kicked
 * player takes its blow on its own client. A guest kicker predicts what its kick does to world
 * entities, so its lunge carries on through them at once.
 */
export const kick: Content<"kick", KickConfig> = {
  name: "kick",
  create(configs) {
    const config = configs.kick;
    const hitbox = (at: Point, aim: number): Circle =>
      circleAhead(at, aim, config.reach, config.radius);
    const show = (game: Session, area: Circle, hit: boolean): void => {
      showFlash(game, { at: area.center, radius: area.radius, hit });
    };
    /** Hurts `entity` and knocks it away from a kicker at `at`. */
    const strike = (game: Session, entity: WorldEntity, at: Point): void => {
      applyDamage(entity, config.damage);
      const distance = bodyLength(entity) * config.knockback;
      knockBack(entity, at, distance, game.world.map, "stop");
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
        confirmAction(game, by, at.action);
        if (!hostAccepts(game, by, at, NAME, config.cooldown)) return;
        const area = hitbox(at, at.aim);
        const entities = entitiesIn(game, area);
        for (const entity of entities) strike(game, entity, at);
        const players = playersIn(game, area, by);
        for (const player of players)
          hurtPlayer(game, player, config.damage, {
            from: at,
            distance: bodyLength(player) * config.knockback,
          });
        const hit = entities.length + players.length;
        broadcastNoise(game, {
          at: area.center,
          loudness: config.loudness,
          source: by,
        });
        shown.send(game, { by, ...area.center, hit: hit > 0 });
      },
    });

    return {
      name: NAME,
      events: { kicked, shown },
      register: () => undefined,
      populate: () => undefined,
      act(game, controls) {
        if (!controls.secondary) return;
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
          solidBodiesBut(game, local),
        );
        const area = hitbox(at, local.aim);
        const entities = entitiesIn(game, area);
        const hits =
          entities.length + playersIn(game, area, game.localId).length;
        show(game, area, hits > 0);
        const action = nextAction(game);
        predict(game, action, entities, (entity) => {
          strike(game, entity, at);
        });
        kicked.send(game, { x: at.x, y: at.y, aim: local.aim, action });
      },
    };
  },
};
