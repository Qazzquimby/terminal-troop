import {
  ITEM_TAG,
  INERT_TAG,
  defineItem,
  effect,
  hasKindTag,
  instanceKey,
  makerOf,
  sound,
} from "../../sim/index.js";
import type {
  ItemInstance,
  ItemTraits,
  Point,
  Session,
  WorldEntity,
} from "../../sim/index.js";
import { powerSwitch } from "../switch.js";

/**
 * A scanner: switched on and off with the use control, like a flashlight, its uses its battery,
 * spent one each `drain` seconds it is on. On, it beeps, a sound heard and a noise made where it
 * is, more often the nearer the best target it senses and the more squarely it points at it; with
 * nothing in range it is silent. Dropped switched on, it beeps on where it lies, pointing the way
 * it faced as it fell.
 */
export interface ScannerConfig extends ItemTraits {
  /** How far it senses a target, in pixels. */
  readonly range: number;
  /** Seconds between beeps for a target just inside its range, behind its holder. */
  readonly slowest: number;
  /** Seconds between beeps for a target right at its holder, dead ahead. */
  readonly fastest: number;
  /**
   * How much a target's closeness still counts with its holder facing straight away from it,
   * 0..1: at 1 facing makes no difference, at 0 a target behind counts for nothing.
   */
  readonly behind: number;
  /** Seconds each of its uses lasts switched on. */
  readonly drain: number;
  /** Least time between two switches, in sim seconds. */
  readonly cooldown: number;
  /** Volume of its beep and its click, 0..1. */
  readonly volume: number;
  /** How far, in pixels, its beep is heard, and so how far its noise carries. */
  readonly beepRange: number;
  /** How far, in pixels, its switch's click is heard. */
  readonly clickRange: number;
}

/**
 * How strongly a scanner held at `from`, facing `aim` radians, senses a target at `at`, 0..1:
 * its closeness within `range`, scaled from `behind` facing straight away up to 1 facing it.
 * 0 out of range.
 */
export function signal(
  from: Point,
  aim: number,
  at: Point,
  config: Pick<ScannerConfig, "range" | "behind">,
): number {
  const dx = at.x - from.x;
  const dy = at.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance > config.range) return 0;
  if (distance === 0) return 1;
  const closeness = 1 - distance / config.range;
  // 1 facing it, 0 facing straight away.
  const facing = (1 + Math.cos(Math.atan2(dy, dx) - aim)) / 2;
  return closeness * (config.behind + (1 - config.behind) * facing);
}

/** Seconds between beeps for a signal of `strength`, 0..1, slowest at 0 and fastest at 1. */
export const beepInterval = (
  strength: number,
  config: Pick<ScannerConfig, "slowest" | "fastest">,
): number => config.slowest - (config.slowest - config.fastest) * strength;

/** What a scanner senses. */
interface ScannerSpec {
  readonly name: string;
  readonly emoji: string;
  /** Where its beep's sound file is. */
  readonly beepUrl: string;
  /** Whether `entity` is something it senses. */
  readonly senses: (game: Session, entity: WorldEntity) => boolean;
}

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const clickUrl = new URL("./sfx/click.mp3", import.meta.url).href;
const dropUrl = new URL("./sfx/drop.mp3", import.meta.url).href;

/**
 * The scanner `id`: switched on, the host beeps each one held or lying, at the pace the strongest
 * signal among what it senses sets.
 */
function defineScanner<N extends string>(id: N, spec: ScannerSpec) {
  return defineItem(id, (config: ScannerConfig) => {
    const power = powerSwitch(id, config.drain);
    const beep = sound({
      url: spec.beepUrl,
      volume: config.volume,
      range: config.beepRange,
    });
    const click = sound({
      url: clickUrl,
      volume: config.volume,
      range: config.clickRange,
    });
    /** Seconds since each one's last beep, by instance, per session, while it is on. */
    const sinceBeep = new WeakMap<Session, Map<string, number>>();

    /** The strongest signal `scanner` senses, 0 for none; never itself, lying. */
    const strongest = (game: Session, scanner: ItemInstance): number => {
      let best = 0;
      const self = "lying" in scanner.place ? scanner.place.lying : null;
      for (const entity of game.entities.values()) {
        if (entity === self || !spec.senses(game, entity)) continue;
        best = Math.max(
          best,
          signal(scanner.at, scanner.facing, entity, config),
        );
      }
      return best;
    };

    return {
      name: spec.name,
      emoji: spec.emoji,
      traits: config,
      drop: sound({ url: dropUrl, volume: config.volume }),
      use: power.use(config.cooldown, { sound: click }),
      draw() {
        // A switch shows only as the beeps it makes.
      },
      step(game, dt) {
        const previous = sinceBeep.get(game) ?? new Map<string, number>();
        const times = new Map<string, number>();
        sinceBeep.set(game, times);
        for (const scanner of power.step(game, dt)) {
          const key = instanceKey(scanner);
          const since = (previous.get(key) ?? 0) + dt;
          const strength = strongest(game, scanner);
          if (strength === 0 || since < beepInterval(strength, config)) {
            times.set(key, since);
            continue;
          }
          times.set(key, 0);
          effect(game, { at: scanner.at, sound: beep }, makerOf(scanner));
        }
      },
    };
  });
}

/** Senses every item lying in the world, corpses included. */
export const itemScanner = defineScanner("itemScanner", {
  name: "Item scanner",
  emoji: "📡",
  beepUrl: new URL("./sfx/item-beep.mp3", import.meta.url).href,
  senses: (game, entity) => hasKindTag(game, entity.id, [ITEM_TAG]),
});

/** Senses every living world entity that is neither an item nor inert: monsters, in short. */
export const monsterScanner = defineScanner("monsterScanner", {
  name: "Monster scanner",
  emoji: "📟",
  beepUrl: new URL("./sfx/monster-beep.mp3", import.meta.url).href,
  senses: (game, entity) =>
    entity.health > 0 && !hasKindTag(game, entity.id, [ITEM_TAG, INERT_TAG]),
});
