import { z } from "zod";
import {
  circleAhead,
  dash,
  dashEnd,
  defineAction,
  effect,
  entitiesIn,
  hurt,
  playersIn,
  push,
  solidBodiesBut,
  sound,
} from "../../sim/index.js";
import type { Content, Player, Point, Session } from "../../sim/index.js";
import useUrl from "./sfx/use.mp3";

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
    /**
     * How far, in pixels, a reported lunge's end may be from the host's own reckoning of it,
     * from where and which way the kicker reports it started.
     */
    readonly slack: number;
  };
  /** How far, in pixels, a kick's noise carries. */
  readonly noiseRadius: number;
}

/** A body's length: its diameter. */
const bodyLength = (body: { readonly radius: number }): number =>
  body.radius * 2;

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const Spot = z.object({ x: z.number(), y: z.number() });

/** A kick as its kicker sends it: where its lunge started and ended, and which way it faces. */
const Lunge = z.object({ from: Spot, to: Spot, aim: z.number() });
type Lunge = z.infer<typeof Lunge>;

const SOUNDS = { use: sound({ url: useUrl }) } as const;

/**
 * The kick: what every player can do empty-handed, whatever it holds, on the secondary action.
 * The kicker lunges a little, up to whatever is in its way, and reports where its lunge started
 * and ended and which way it faced. The host works out the lunge itself from there, as far as the
 * reported end but no further than a lunge goes nor through walls, and turns down a kick whose
 * reported end is too far from its own. Bodies the kicker may have seen elsewhere do not stop it.
 * The kick hurts and knocks back every world entity and every other player in front of where the
 * lunge ends, and makes a noise.
 */
export const kick: Content<"kick", KickConfig> = {
  name: "kick",
  create(configs) {
    const config = configs.kick;
    const lungeLength = (kicker: Player): number =>
      bodyLength(kicker) * config.lunge.lengths;

    /**
     * Where `lunge` ends as this client sees the walls: from where it started along its aim, as
     * far as its reported end but no further than a lunge goes.
     */
    const lungeEnd = (game: Session, kicker: Player, lunge: Lunge): Point =>
      dashEnd(
        { ...lunge.from, radius: kicker.radius },
        lunge.aim,
        Math.min(lungeLength(kicker), distance(lunge.from, lunge.to)),
        game.world.map,
        [],
      );

    const kicking = defineAction("kick", {
      input: Lunge,
      cooldown: config.cooldown,
      stamina: config.stamina,
      stood: (kicker, { from }) => ({ at: from, leeway: lungeLength(kicker) }),
      check: (game, kicker, lunge) =>
        distance(lungeEnd(game, kicker, lunge), lunge.to) <= config.lunge.slack,
      apply(game, kicker, lunge) {
        const at = lungeEnd(game, kicker, lunge);
        dash(game, kicker, {
          aim: lunge.aim,
          distance: lungeLength(kicker),
          seconds: config.lunge.seconds,
        });
        const area = circleAhead(at, lunge.aim, config.reach, config.radius);
        const struck = [
          ...entitiesIn(game, area),
          ...playersIn(game, area, kicker.id),
        ];
        for (const body of struck) {
          hurt(game, body, config.damage);
          push(game, body, at, bodyLength(body) * config.knockback);
        }
        effect(game, {
          at: area.center,
          sound: SOUNDS.use,
          flash: { radius: area.radius, hit: struck.length > 0 },
          noise: config.noiseRadius,
        });
      },
    });

    /** The local player's lunge if it kicked now: up to whatever is in its way. */
    const lunge = (game: Session): Lunge => {
      const { local } = game;
      const from = local.dash?.to ?? { x: local.x, y: local.y };
      const to =
        local.dash?.to ??
        dashEnd(
          local,
          local.aim,
          lungeLength(local),
          game.world.map,
          solidBodiesBut(game, local),
        );
      return { from, to: { x: to.x, y: to.y }, aim: local.aim };
    };

    return {
      name: "move/kick",
      actions: [kicking],
      register: () => undefined,
      populate: () => undefined,
      act(game, controls) {
        if (controls.secondary) kicking.perform(game, lunge(game));
      },
    };
  },
};
