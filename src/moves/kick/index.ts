import { z } from "zod";
import {
  applyDamage,
  broadcastNoise,
  circleAhead,
  contentEvent,
  dashEnd,
  entitiesIn,
  hostAccepts,
  hurtPlayer,
  knockBack,
  playersIn,
  showFlash,
  spendStamina,
  solidBodiesBut,
  startDash,
} from "../../sim/index.js";
import type {
  Circle,
  Content,
  Player,
  Point,
  Session,
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
    /** How far, in pixels, a reported lunge's end may be from the host's own reckoning of it. */
    readonly slack: number;
  };
  /** How far, in pixels, a kick's noise carries. */
  readonly noiseRadius: number;
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

/**
 * The kick: what every player can do empty-handed, whatever it holds, on the secondary action.
 * The kicker lunges a little, up to whatever is in its way, and spends stamina on its own client.
 * The host works out the lunge itself, from where it last heard the kicker stand and face, and
 * turns down a kick whose reported end is too far from its own. It then hurts and knocks back
 * every world entity and every other player in front of where it reckons the lunge ends, and
 * makes a noise. A kicked player takes its blow on its own client.
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

    const shown = contentEvent({
      schema: Shown,
      to: "all",
      from: "host",
      receive(game, { by, x, y, hit }) {
        if (by !== game.localId)
          show(game, { center: { x, y }, radius: config.radius }, hit);
      },
    });

    /**
     * Where a remote `kicker`'s lunge ends as this client sees the world, from where and which
     * way it last reported standing.
     */
    const lungeEnd = (game: Session, kicker: Player): Point =>
      dashEnd(
        { x: kicker.tx, y: kicker.ty, radius: kicker.radius },
        kicker.taim,
        bodyLength(kicker) * config.lunge.lengths,
        game.world.map,
        solidBodiesBut(game, kicker),
      );

    const kicked = contentEvent({
      schema: Kicked,
      to: "host",
      receive(game, reported, by) {
        const kicker = game.players.get(by);
        if (kicker === undefined) return;
        const own = kicker === game.local;
        const aim = own ? reported.aim : kicker.taim;
        const at = own ? reported : lungeEnd(game, kicker);
        const off = Math.hypot(reported.x - at.x, reported.y - at.y);
        if (off > config.lunge.slack) return;
        if (!hostAccepts(game, by, at, NAME, config.cooldown)) return;
        const area = hitbox(at, aim);
        const entities = entitiesIn(game, area);
        for (const entity of entities) {
          applyDamage(entity, config.damage);
          const distance = bodyLength(entity) * config.knockback;
          knockBack(entity, at, distance, game.world.map, "stop");
        }
        const players = playersIn(game, area, by);
        for (const player of players)
          hurtPlayer(game, player, config.damage, {
            from: at,
            distance: bodyLength(player) * config.knockback,
          });
        const hit = entities.length + players.length;
        broadcastNoise(game, {
          at: area.center,
          radius: config.noiseRadius,
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
        // The kicker's state goes with the kick, so the host reckons the lunge from where it
        // stood and faced as it kicked.
        game.reportNow = true;
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
        const hits =
          entitiesIn(game, area).length +
          playersIn(game, area, game.localId).length;
        show(game, area, hits > 0);
        kicked.send(game, { x: at.x, y: at.y, aim: local.aim });
      },
    };
  },
};
