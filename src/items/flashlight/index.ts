import { defineItem, isOn, sound } from "../../sim/index.js";
import type { ItemTraits } from "../../sim/index.js";
import { powerSwitch } from "../switch.js";
// The switch's click, once its asset lands; importing a missing file breaks the build.
// import clickUrl from "./sfx/click.mp3";
// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const dropUrl = new URL("./sfx/drop.mp3", import.meta.url).href;

/**
 * A flashlight: switched on and off with the use control, it lights a long cone the way it points
 * while it is on: the way its holder faces while held, and, dropped, the way it faced as it fell.
 * Its uses are its battery, spent one each `drain` seconds it shines; a flat one is gone.
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
    drop: sound({ url: dropUrl, volume: config.volume }),
    use: power.use(config.cooldown, {
      noise: config.clickNoiseRadius,
      // sound: click,
    }),
    draw() {
      // A switch shows only as the light it casts.
    },
    light({ state, facing }) {
      if (!isOn(state)) return null;
      return {
        range: config.range,
        shape: { kind: "cone", direction: facing, angle: config.angle },
      };
    },
    step(game, dt) {
      power.step(game, dt);
    },
  };
});
