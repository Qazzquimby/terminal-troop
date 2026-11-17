import { z } from "zod";
import {
  effect,
  heldItemOf,
  heldSlot,
  itemIn,
  playerData,
  spendUses,
} from "../sim/index.js";
import type {
  Effect,
  PlayerData,
  Player,
  Session,
  UseSpec,
} from "../sim/index.js";

/**
 * A held item's power switch, as a flashlight has: using it flips it on or off, it goes off once
 * its player holds it no more, and while on and held its uses are its battery, one spent each
 * `drain` seconds; a flat one is gone. Whether it is on is the player's to report.
 */
export interface PowerSwitch {
  /** Whether each player's one is switched on; the item's player data. */
  readonly on: PlayerData<boolean>;
  /** The slot `player` holds one in, by the host's record, or null when it holds none. */
  slotOf(game: Session, player: Player): number | null;
  /**
   * The item's use: flips the switch, at most once each `cooldown` seconds, spending no use, and
   * clicks as `click` says, where its user stands.
   */
  use(cooldown: number, click: Omit<Effect, "at">): UseSpec;
  /** Switches the local player's off once it holds none: the item's `act`. */
  act(game: Session): void;
  /**
   * As the host, runs the battery of every player's that is on and held, `dt` seconds on, and
   * returns those players with the slot each holds it in.
   */
  drain(
    game: Session,
    dt: number,
  ): { readonly player: Player; readonly slot: number }[];
}

/** A power switch for the item `item`, its battery a use each `drain` seconds it is on. */
export function powerSwitch(item: string, drain: number): PowerSwitch {
  const on = playerData({ schema: z.boolean(), initial: () => false });
  /** Seconds each player's has been on since it last spent a use, per session. */
  const spent = new WeakMap<Session, Map<string, number>>();
  const slotOf = (game: Session, player: Player): number | null => {
    const slot = heldSlot.get(player);
    return slot !== null && itemIn(game, player.id, slot) === item
      ? slot
      : null;
  };
  return {
    on,
    slotOf,
    use: (cooldown, click) => ({
      cooldown,
      spends: 0,
      apply(game, user) {
        // The switch is the player's to report: only its own client flips it.
        if (user === game.local) on.set(user, !on.get(user));
        effect(game, { ...click, at: { x: user.x, y: user.y } });
      },
    }),
    act(game) {
      const { local } = game;
      if (on.get(local) && heldItemOf(game, local)?.id !== item)
        on.set(local, false);
    },
    drain(game, dt) {
      const times = spent.get(game) ?? new Map<string, number>();
      spent.set(game, times);
      const running: { player: Player; slot: number }[] = [];
      for (const player of game.players.values()) {
        const slot = slotOf(game, player);
        if (!on.get(player) || slot === null) continue;
        running.push({ player, slot });
        const time = (times.get(player.id) ?? 0) + dt;
        if (time < drain) {
          times.set(player.id, time);
          continue;
        }
        times.set(player.id, time - drain);
        spendUses(game, player, slot);
      }
      return running;
    },
  };
}
