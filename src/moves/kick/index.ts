import { z } from "zod";
import {
  circleAhead,
  dash,
  defineAction,
  effect,
  entitiesIn,
  hurt,
  playersIn,
  push,
  sound,
} from "../../sim/index.js";
import type { Content, Player } from "../../sim/index.js";
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
  };
  /** How far, in pixels, a kick's noise carries. */
  readonly noiseRadius: number;
}

/** A body's length: its diameter. */
const bodyLength = (body: { readonly radius: number }): number =>
  body.radius * 2;

/** A kick as its kicker sends it: which way it faces. */
const Kick = z.object({ aim: z.number() });

const SOUNDS = { use: sound({ url: useUrl }) } as const;

/**
 * The kick: what every player can do empty-handed, whatever it holds, on the secondary action.
 * The kicker lunges a little the way it faces, up to whatever is in its way. The kick hurts and
 * knocks back every world entity and every other player in front of where the lunge ends, and
 * makes a noise.
 */
export const kick: Content<"kick", KickConfig> = {
  name: "kick",
  create(configs) {
    const config = configs.kick;
    const lungeLength = (kicker: Player): number =>
      bodyLength(kicker) * config.lunge.lengths;

    const kicking = defineAction("kick", {
      input: Kick,
      cooldown: config.cooldown,
      stamina: config.stamina,
      apply(game, kicker, { aim }) {
        const at = dash(game, kicker, {
          aim,
          distance: lungeLength(kicker),
          seconds: config.lunge.seconds,
        });
        const area = circleAhead(at, aim, config.reach, config.radius);
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

    return {
      name: "move/kick",
      actions: [kicking],
      register: () => undefined,
      populate: () => undefined,
      act(game, controls) {
        if (controls.secondary) kicking.perform(game, { aim: game.local.aim });
      },
    };
  },
};
