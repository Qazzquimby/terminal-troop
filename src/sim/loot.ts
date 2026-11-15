import { findLast, sumBy } from "lodash-es";
import { scatterEach } from "./content.js";
import type { Scatter, WorldContent } from "./content.js";
import type { ItemDefinition } from "./inventory.js";
import { isAreaFree } from "./map.js";
import type { Point, Rng } from "./map.js";
import type { Session } from "./session.js";
import { spawnWorldItem } from "./world-items.js";

/** How rare an item is; each rarity's odds follow the danger of where it is laid. */
type Rarity = "common" | "uncommon" | "rare";

/** How likely the world is to lay an item as loot. */
export interface ItemLoot {
  /**
   * Its share of the loot, as a whole number: an item of 30 is laid three times as often as one
   * of 10, where nothing is dangerous.
   */
  readonly weight: number;
  readonly rarity: Rarity;
}

/** An item a new world always lays, however the loot rolls: one at each spot of its scatter. */
interface GuaranteedLoot {
  /** The item's id. */
  readonly item: string;
  readonly scatter: Scatter;
}

/**
 * How a new world lays loot: items picked by their loot weights, and on top of them the items it
 * always lays.
 */
export interface LootConfig {
  /** Where each picked item is laid, one per spot. */
  readonly scatter: Scatter;
  /**
   * Items laid whatever the loot picks, such as what the players need to win; each may still be
   * picked as loot besides, by its loot weight.
   */
  readonly guaranteed: readonly GuaranteedLoot[];
  /** How the danger of a spot, 0..1, changes what is laid there. */
  readonly danger: {
    /** The chance of a second item at a spot of full danger; none at a safe one, linear between. */
    readonly extra: number;
    /**
     * What each rarity's weight is multiplied by at a spot of full danger: 1 at a safe one,
     * linear between. Above 1 favours it where it is dangerous.
     */
    readonly rarity: Readonly<Record<Rarity, number>>;
  };
}

/** How dangerous a spot is, 0 (safe) to 1 (most dangerous). */
export type Danger = (at: Point) => number;

/** Each session's danger, as the world's generator gives it. */
const dangers = new WeakMap<Session, Danger>();

/**
 * Sets how dangerous each spot of `game`'s world is, for the loot it lays: places that spawn more
 * dangerous monsters lay more items, and rarer ones. Every spot is safe until set.
 */
export function setDanger(game: Session, danger: Danger): void {
  dangers.set(game, danger);
}

/** How dangerous `at` is in `game`'s world, 0..1. */
function dangerAt(game: Session, at: Point): number {
  const danger = dangers.get(game)?.(at) ?? 0;
  return Math.min(1, Math.max(0, danger));
}

/** `item`'s loot weight at a spot of `danger`, its rarity's curve applied. */
function lootWeight(
  loot: ItemLoot,
  danger: number,
  curves: LootConfig["danger"]["rarity"],
): number {
  return loot.weight * (1 + (curves[loot.rarity] - 1) * danger);
}

/**
 * One of `items` drawn by its loot weight at a spot of `danger`; null when none has any weight.
 * Draws once from `rng`.
 */
export function pickLoot(
  items: readonly ItemDefinition[],
  danger: number,
  config: LootConfig["danger"],
  rng: Rng,
): ItemDefinition | null {
  const weighted = items.map((item) => ({
    item,
    weight:
      item.loot === undefined
        ? 0
        : Math.max(0, lootWeight(item.loot, danger, config.rarity)),
  }));
  const total = sumBy(weighted, (entry) => entry.weight);
  let draw = rng() * total;
  for (const entry of weighted) {
    if (entry.weight <= 0) continue;
    draw -= entry.weight;
    if (draw < 0) return entry.item;
  }
  return findLast(weighted, (entry) => entry.weight > 0)?.item ?? null;
}

/**
 * The content that lays a new world's loot: at each spot of its scatter, one item picked from
 * every item with a loot weight, and at a dangerous spot maybe a second beside it; then each
 * guaranteed item at each spot of its own scatter.
 */
export function lootContent(config: LootConfig): WorldContent {
  return {
    name: "item/loot",
    register: () => undefined,
    populate(game) {
      const items = [...game.itemDefinitions.values()];
      const { radius } = game.config.worldItems;
      const lay = (at: Point, danger: number, rng: Rng): void => {
        const item = pickLoot(items, danger, config.danger, rng);
        if (item !== null) spawnWorldItem(game, at, item.id);
      };
      scatterEach(game, config.scatter, radius, (at, rng) => {
        const danger = dangerAt(game, at);
        lay(at, danger, rng);
        if (rng() >= config.danger.extra * danger) return;
        const beside = { x: at.x + radius * 2, y: at.y };
        lay(
          isAreaFree(game.world.map, beside.x, beside.y, radius) ? beside : at,
          danger,
          rng,
        );
      });
      for (const { item, scatter } of config.guaranteed) {
        if (!game.itemDefinitions.has(item))
          throw new Error(`guaranteed loot names no item: ${item}`);
        scatterEach(game, scatter, radius, (at) => {
          spawnWorldItem(game, at, item);
        });
      }
    },
  };
}
