import {
  effect,
  instanceKey,
  isOn,
  itemInstances,
  setInstanceState,
  setStateAt,
  spendInstanceUses,
  stateAt,
} from "../sim/index.js";
import type { Effect, ItemInstance, Session, UseSpec } from "../sim/index.js";

/**
 * An item's power switch, as a flashlight has: using it flips it on or off, kept in the item's
 * own state, so it stays as it was wherever the item goes. While on, held or lying, its uses are
 * its battery, one spent each `drain` seconds; a flat one is gone. Put away in a pocket it goes
 * off.
 */
export interface PowerSwitch {
  /**
   * The item's use: flips the switch, at most once each `cooldown` seconds, spending no use, and
   * clicks as `click` says, where its user stands. Its user's own client shows it at once.
   */
  use(cooldown: number, click: Omit<Effect, "at">): UseSpec;
  /**
   * As the host, switches off each one put away in a pocket, runs the battery of each one still
   * on, `dt` seconds on, and returns those, held or lying.
   */
  step(game: Session, dt: number): ItemInstance[];
}

/** A power switch for the item `item`, its battery a use each `drain` seconds it is on. */
export function powerSwitch(item: string, drain: number): PowerSwitch {
  /** Seconds each one has been on since it last spent a use, by instance, per session. */
  const spent = new WeakMap<Session, Map<string, number>>();
  return {
    use: (cooldown, click) => ({
      cooldown,
      spends: 0,
      apply(game, user, { slot }) {
        const on = !isOn(stateAt(game, user, slot));
        setStateAt(game, user, slot, item, on ? { on: true } : undefined, {
          predict: true,
        });
        effect(game, { ...click, at: { x: user.x, y: user.y } });
      },
    }),
    step(game, dt) {
      const before = spent.get(game) ?? new Map<string, number>();
      const times = new Map<string, number>();
      spent.set(game, times);
      const running: ItemInstance[] = [];
      for (const instance of itemInstances(game, item)) {
        if (!isOn(instance.state)) continue;
        const { place } = instance;
        if ("held" in place && !place.held) {
          setInstanceState(game, instance, undefined);
          continue;
        }
        const key = instanceKey(instance);
        const time = (before.get(key) ?? 0) + dt;
        if (time < drain) {
          times.set(key, time);
          running.push(instance);
          continue;
        }
        times.set(key, time - drain);
        if (spendInstanceUses(game, instance) !== 0) running.push(instance);
      }
      return running;
    },
  };
}
