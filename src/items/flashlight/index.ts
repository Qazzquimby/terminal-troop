import { defineItem } from "../../sim/index.js";
import type { ItemTraits } from "../../sim/index.js";
import { powerSwitch } from "../switch.js";
// The switch's click, once its asset lands; importing a missing file breaks the build.
// import clickUrl from "./sfx/click.mp3";

/**
 * A flashlight: switched on and off with the use control, it lights a long cone the way its holder
 * faces while it is held and on. Its uses are its battery, spent one each `drain` seconds it
 * shines; a flat one is gone.
 */
export interface FlashlightConfig extends ItemTraits {
  /** How far its beam reaches, in pixels. */
  readonly range: number;
  /** Width of its beam, in radians. */
  readonly angle: number;
  /** Seconds of shining each of its uses lasts. */
  readonly drain: number;
  /** Least time between two switches, in sim seconds. */
  readonly cooldown: number;
  /** Volume of its click, 0..1. */
  readonly volume: number;
  /** How far, in pixels, its click is heard, and so how far its noise carries. */
  readonly clickNoiseRadius: number;
}

const ITEM = "flashlight";

export const flashlight = defineItem(ITEM, (config: FlashlightConfig) => {
  // const click = sound({ url: clickUrl, volume: config.volume, range: config.clickNoiseRadius });
  const power = powerSwitch(ITEM, config.drain);

  return {
    name: "Flashlight",
    emoji: "🔦",
    traits: config,
    player: power.on,
    use: power.use(config.cooldown, {
      noise: config.clickNoiseRadius,
      // sound: click,
    }),
    draw() {
      // A switch shows only as the light it casts.
    },
    light(_game, holder) {
      if (!power.on.get(holder)) return null;
      return {
        range: config.range,
        shape: { kind: "cone", direction: holder.aim, angle: config.angle },
      };
    },
    act(game) {
      power.act(game);
    },
    step(game, dt) {
      power.drain(game, dt);
    },
  };
});
