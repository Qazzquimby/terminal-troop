import { fireFlare } from "../../entities/index.js";
import { defineItem, effect, sound } from "../../sim/index.js";
import type { ItemTraits } from "../../sim/index.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const shotUrl = new URL("./sfx/shot.mp3", import.meta.url).href;

/** The flare gun. Distances in pixels, times in sim seconds. */
export interface FlareGunConfig extends ItemTraits {
  /** Least time between two shots. */
  readonly cooldown: number;
  /** How far a flare flies before it drops, when nothing stops it first. */
  readonly range: number;
  /** Volume of a shot, 0..1. */
  readonly volume: number;
  /** How far a shot is heard, and so how far its noise carries. */
  readonly noiseRadius: number;
  /** How long its muzzle flash shows. */
  readonly duration: number;
  /** The radius of its muzzle flash. */
  readonly spark: number;
}

const ID = "flareGun";

/**
 * A flare gun: the use control shoots a flare the way its holder aims, with a pop and a red muzzle
 * flash. The flare flies until it meets a wall or a body or has flown its range, then burns there,
 * lighting the ground round it red for a while. Each shot spends a use.
 */
export const flareGun = defineItem(ID, (config: FlareGunConfig) => {
  const pop = sound({
    url: shotUrl,
    volume: config.volume,
    range: config.noiseRadius,
  });
  return {
    name: "Flare Gun",
    emoji: "🎇",
    traits: config,
    use: {
      cooldown: config.cooldown,
      apply(game, user, { aim }) {
        fireFlare(game, user, { aim, range: config.range });
        effect(game, {
          at: {
            x: user.x + Math.cos(aim) * user.radius,
            y: user.y + Math.sin(aim) * user.radius,
          },
          sound: pop,
          use: { item: ID, hit: false },
        });
      },
    },
    draw(ctx, { center, startedAt }, time) {
      const progress = (time - startedAt) / config.duration;
      if (progress < 0 || progress > 1) return;
      ctx.save();
      ctx.globalAlpha = 1 - progress;
      ctx.fillStyle = "#ff5a3a";
      ctx.beginPath();
      ctx.arc(
        center.x,
        center.y,
        config.spark * (1 - progress / 2),
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();
    },
  };
});
