import { z } from "zod";
import {
  defineItem,
  defineAction,
  effect,
  heldItemOf,
  isOn,
  itemInstances,
  liveTransceivers,
  makeNoise,
  makerOf,
  onAir,
  transceiverOf,
  setStateAt,
  sound,
  spendInstanceUses,
  stateAt,
  VOICE_TAG,
  voiceNoise,
} from "../../sim/index.js";
import type {
  ItemInstance,
  ItemTraits,
  Player,
  Point,
  Session,
  VoiceChannel,
} from "../../sim/index.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const onUrl = new URL("./sfx/on.mp3", import.meta.url).href;
const offUrl = new URL("./sfx/off.mp3", import.meta.url).href;
const keyUrl = new URL("./sfx/key.mp3", import.meta.url).href;
const unkeyUrl = new URL("./sfx/unkey.mp3", import.meta.url).href;
const dropUrl = new URL("./sfx/drop.mp3", import.meta.url).href;
const deadUrl = new URL("./sfx/dead.mp3", import.meta.url).href;

/** The walkie talkie. Distances in pixels, times in sim seconds; its uses are its battery. */
export interface WalkieConfig extends ItemTraits {
  /** Seconds switched on each use of its battery lasts. */
  readonly drain: number;
  /** Least time between one player's switches of it. */
  readonly cooldown: number;
  /** Volume of its clicks, 0..1. */
  readonly volume: number;
  /** How far switching it on or off is heard, and so how far that noise carries. */
  readonly switchRange: number;
  /** How far the click of starting and stopping a transmission is heard; it makes no noise. */
  readonly keyRange: number;
  /** How far a walkie's speaker carries, as a share of how far the speech it plays carries. */
  readonly speakerNoise: number;
}

const ITEM = "walkie";

/** The tag a walkie's noise carries, past its maker's kind and the voice tag. */
const WALKIE_TAG = "walkie";

const isWalkie = (instance: ItemInstance): boolean =>
  instance.item === ITEM && isOn(instance.state);

/** Whether `player` holds a walkie that is switched on, as the host keeps its items. */
const holdsLiveWalkie = (game: Session, player: Player): boolean => {
  const held = heldItemOf(game, player);
  return held?.id === ITEM && isOn(held.state);
};

/** Whether `player` may transmit on the walkie band: holding a walkie switched on, or sitting at a set. */
const hasTransmitter = (game: Session, player: Player): boolean =>
  holdsLiveWalkie(game, player) || transceiverOf(game, player) !== null;

/**
 * Whether `player` transmits on the walkie band: on the air, holding a walkie switched on or
 * inside a vehicle with a set. Every other walkie and set switched on plays what it says.
 */
const transmitting = (game: Session, player: Player): boolean =>
  onAir.get(player) && hasTransmitter(game, player);

/** Something on the walkie band that plays a transmission: where it is, and what makes its noise. */
interface Receiver {
  readonly at: Point;
  readonly maker: { readonly id: string };
}

/**
 * Everything on the band that `speaker`'s transmission plays from: every walkie switched on but
 * those it carries, and every vehicle's set with anyone inside but the one it sits in.
 */
function receivers(game: Session, speaker: Player): Receiver[] {
  const walkies = itemInstances(game, ITEM)
    .filter(
      (instance) =>
        isWalkie(instance) &&
        !("carrier" in instance.place && instance.place.carrier === speaker),
    )
    .map((instance) => ({ at: instance.at, maker: makerOf(instance) }));
  const own = transceiverOf(game, speaker);
  const sets = liveTransceivers(game)
    .filter((vehicle) => vehicle !== own)
    .map((vehicle) => ({ at: { x: vehicle.x, y: vehicle.y }, maker: vehicle }));
  return [...walkies, ...sets];
}

/**
 * Walkie voice: a transmitting speaker is heard from every other walkie and set switched on,
 * wherever it is, as through a small speaker.
 */
const walkieChannel: VoiceChannel = {
  routes(game, speaker) {
    if (!transmitting(game, speaker)) return [];
    const from = { x: speaker.x, y: speaker.y };
    return receivers(game, speaker).map(({ at }) => ({
      at,
      via: "radio" as const,
      from,
    }));
  },
};

/**
 * The walkie talkie: E switches it on or off, held or not. While on it spends a use of its
 * battery each `drain` seconds, wherever it is, and is gone once the battery is flat. Holding it
 * on and holding the use button transmits: the holder's mic goes out whatever its voice settings,
 * and every other walkie switched on plays it, making the noise of that speech at the walkie.
 * A vehicle's set is on the same band: holding transmit inside one transmits from it the same
 * way, and while anyone is inside it, it plays every transmission like a walkie switched on.
 */
export const walkie = defineItem(ITEM, (config: WalkieConfig) => {
  const sounds = {
    on: sound({ url: onUrl, volume: config.volume, range: config.switchRange }),
    off: sound({
      url: offUrl,
      volume: config.volume,
      range: config.switchRange,
    }),
    key: sound({
      url: keyUrl,
      volume: config.volume,
      range: config.keyRange,
      noise: false,
    }),
    unkey: sound({
      url: unkeyUrl,
      volume: config.volume,
      range: config.keyRange,
      noise: false,
    }),
  };

  /** The click of starting or stopping a transmission, which every client near it hears. */
  const key = defineAction("key", {
    input: z.object({ on: z.boolean() }),
    apply(game, user, { on }) {
      effect(game, {
        at: { x: user.x, y: user.y },
        sound: on ? sounds.key : sounds.unkey,
      });
    },
  });

  /** How long, on each host, until the next use of every walkie's battery goes. */
  const draining = new WeakMap<Session, number>();
  /** How long, on each host, until walkies next make the noise of what they play. */
  const speaking = new WeakMap<Session, number>();

  /** Spends a use of every walkie switched on, each `drain` seconds. */
  function drainBatteries(game: Session, dt: number): void {
    let due = (draining.get(game) ?? config.drain) - dt;
    while (due <= 0) {
      due += config.drain;
      for (const instance of itemInstances(game, ITEM))
        if (isOn(instance.state)) spendInstanceUses(game, instance);
    }
    draining.set(game, due);
  }

  /**
   * Makes each walkie playing a transmission sound as far as the speech it plays carries, scaled
   * by its speaker, each voice interval while it does.
   */
  function speakerNoise(game: Session, dt: number): void {
    let loudest = 0;
    const speakers: Player[] = [];
    for (const player of game.players.values()) {
      if (!transmitting(game, player)) continue;
      speakers.push(player);
      loudest = Math.max(loudest, voiceNoise.get(player));
    }
    if (loudest === 0) {
      speaking.delete(game);
      return;
    }
    const due = (speaking.get(game) ?? 0) - dt;
    if (due > 0) {
      speaking.set(game, due);
      return;
    }
    speaking.set(game, game.config.voiceNoise.interval);
    const radius = loudest * config.speakerNoise;
    const playing = new Map(
      speakers
        .flatMap((s) => receivers(game, s))
        .map((each) => [
          `${each.maker.id}@${String(each.at.x)},${String(each.at.y)}`,
          each,
        ]),
    );
    for (const { at, maker } of playing.values())
      makeNoise(game, maker, {
        at,
        radius,
        tags: [WALKIE_TAG, VOICE_TAG],
      });
  }

  return {
    name: "Walkie talkie",
    emoji: "📟",
    traits: config,
    drop: sound({ url: dropUrl, volume: config.volume }),
    breaks: sound({ url: deadUrl, volume: config.volume }),
    actions: [key],
    voice: walkieChannel,
    control: {
      cooldown: config.cooldown,
      apply(game, user, { slot }) {
        const on = !isOn(stateAt(game, user, slot));
        setStateAt(game, user, slot, ITEM, on ? { on: true } : undefined);
        effect(game, {
          at: { x: user.x, y: user.y },
          sound: on ? sounds.on : sounds.off,
        });
      },
    },
    act(game, controls) {
      const { local } = game;
      const keyed =
        (controls.holdingUse && holdsLiveWalkie(game, local)) ||
        (controls.transmit === true && transceiverOf(game, local) !== null);
      if (keyed === onAir.get(local)) return;
      onAir.set(local, keyed);
      key.perform(game, { on: keyed });
    },
    step(game, dt) {
      drainBatteries(game, dt);
      speakerNoise(game, dt);
    },
  };
});
