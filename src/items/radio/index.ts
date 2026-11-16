import {
  defineItem,
  effect,
  isOn,
  itemInstances,
  makeNoise,
  makerOf,
  setStateAt,
  sound,
  stateAt,
} from "../../sim/index.js";
import type { ItemInstance, ItemTraits, Session } from "../../sim/index.js";
import {
  RADIO_TAG,
  stationCount,
  stationPlaying,
} from "../../stations/index.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const onUrl = new URL("./sfx/on.mp3", import.meta.url).href;
const offUrl = new URL("./sfx/off.mp3", import.meta.url).href;
const dropUrl = new URL("./sfx/drop.mp3", import.meta.url).href;

/** The radio. Distances in pixels, times in sim seconds. */
export interface RadioConfig extends ItemTraits {
  /** Least time between one player's switches of it. */
  readonly cooldown: number;
  /** Volume of its song, 0..1. */
  readonly volume: number;
  /** Volume of its switch's click, 0..1. */
  readonly switchVolume: number;
  /** How far switching it on or off is heard, and so how far that noise carries. */
  readonly switchRange: number;
  /** How far its song is heard, and so how far the noise it makes while it plays carries. */
  readonly range: number;
  /** Seconds between the noises it makes while it plays. */
  readonly noiseInterval: number;
}

const ITEM = "radio";

/** The station a radio switched on in state `state` plays, by number; null for none. */
function tuneOf(
  state: ItemInstance["state"],
): { readonly station: number; readonly since: number } | null {
  if (!isOn(state)) return null;
  const station = state?.station;
  const since = state?.since;
  if (typeof station !== "number" || typeof since !== "number") return null;
  return { station, since };
}

/**
 * The radio: E switches it on or off, held or not. Switched on, it picks a station at random and
 * plays its songs in a shuffled order, round and round, streamed from where the world's clock has
 * it, as far as its range,
 * making a noise that far each interval wherever it is. It never runs down.
 */
export const radio = defineItem(ITEM, (config: RadioConfig) => {
  const sounds = {
    on: sound({
      url: onUrl,
      volume: config.switchVolume,
      range: config.switchRange,
    }),
    off: sound({
      url: offUrl,
      volume: config.switchVolume,
      range: config.switchRange,
    }),
  };
  /** How long, on each host, until radios next make their noise. */
  const playing = new WeakMap<Session, number>();

  return {
    name: "Radio",
    emoji: "📻",
    traits: config,
    drop: sound({ url: dropUrl, volume: config.switchVolume }),
    control: {
      cooldown: config.cooldown,
      apply(game, user, { slot }) {
        const on = !isOn(stateAt(game, user, slot));
        // Only the host's switch counts, so the station is drawn there alone.
        const station = Math.floor(Math.random() * stationCount());
        setStateAt(
          game,
          user,
          slot,
          ITEM,
          on ? { on: true, station, since: game.worldTime } : undefined,
        );
        effect(game, {
          at: { x: user.x, y: user.y },
          sound: on ? sounds.on : sounds.off,
        });
      },
    },
    plays(instance) {
      const tune = tuneOf(instance.state);
      return tune === null
        ? null
        : stationPlaying(tune.station, tune.since, config);
    },
    step(game, dt) {
      const due = (playing.get(game) ?? 0) - dt;
      if (due > 0) {
        playing.set(game, due);
        return;
      }
      playing.set(game, config.noiseInterval);
      for (const instance of itemInstances(game, ITEM))
        if (tuneOf(instance.state) !== null)
          makeNoise(game, makerOf(instance), {
            at: instance.at,
            radius: config.range,
            tags: [RADIO_TAG],
          });
    },
  };
});
