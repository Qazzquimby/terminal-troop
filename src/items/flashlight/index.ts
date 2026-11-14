import { z } from "zod";
import {
  heldItemOf,
  defineItem,
  effect,
  heldSlot,
  itemIn,
  playerData,
  spendUses,
} from "../../sim/index.js";
import type { ItemTraits, Player, Session } from "../../sim/index.js";
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

/**
 * Whether each player's flashlight is switched on, as the player reports it: using one flips it,
 * and it goes off once the player holds none, put away, dropped or flat.
 */
const switchedOn = playerData({
  schema: z.boolean(),
  initial: () => false,
});

/** The slot `player` holds a flashlight in, by the host's record, or null when it holds none. */
function flashlightSlot(game: Session, player: Player): number | null {
  const slot = heldSlot.get(player);
  return slot !== null && itemIn(game, player.id, slot) === ITEM ? slot : null;
}

export const flashlight = defineItem(ITEM, (config: FlashlightConfig) => {
  // const click = sound({ url: clickUrl, volume: config.volume, range: config.clickNoiseRadius });
  /** Seconds each player's flashlight has shone since it last spent a use, per session. */
  const shone = new WeakMap<Session, Map<string, number>>();

  return {
    name: "Flashlight",
    emoji: "🔦",
    traits: config,
    player: switchedOn,
    use: {
      cooldown: config.cooldown,
      spends: 0,
      apply(game, user) {
        // The switch is the player's to report: only its own client flips it.
        if (user === game.local) switchedOn.set(user, !switchedOn.get(user));
        effect(game, {
          at: { x: user.x, y: user.y },
          noise: config.clickNoiseRadius,
          // sound: click,
        });
      },
    },
    draw() {
      // A switch shows only as the light it casts.
    },
    light(_game, holder) {
      if (!switchedOn.get(holder)) return null;
      return {
        range: config.range,
        shape: { kind: "cone", direction: holder.aim, angle: config.angle },
      };
    },
    act(game) {
      const { local } = game;
      if (switchedOn.get(local) && heldItemOf(game, local)?.id !== ITEM)
        switchedOn.set(local, false);
    },
    step(game, dt) {
      const times = shone.get(game) ?? new Map<string, number>();
      shone.set(game, times);
      for (const player of game.players.values()) {
        const slot = flashlightSlot(game, player);
        if (!switchedOn.get(player) || slot === null) continue;
        const time = (times.get(player.id) ?? 0) + dt;
        if (time < config.drain) {
          times.set(player.id, time);
          continue;
        }
        times.set(player.id, time - config.drain);
        spendUses(game, player, slot);
      }
    },
  };
});
