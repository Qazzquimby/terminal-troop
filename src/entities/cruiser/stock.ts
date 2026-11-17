import {sound, type Storage, type VehicleShop, type Ware} from "../../sim/index.js";
// The storage's clunk and the shop's cash register, once their assets land; importing a missing
// file breaks the build. Until then each makes its noise without a sound.
import clunkUrl from "./sfx/clunk.mp3";
import registerUrl from "./sfx/register.mp3";

/** What the cruiser keeps in its cabin: a storage those inside share, and a shop. */
export interface StockConfig {
  readonly storage: {
    /** How many items it holds, one a slot; the cabin lays them out three to a row. */
    readonly slots: number;
    /** How far, in pixels, an item going in or out clunks. */
    readonly noiseRadius: number;
    /** Volume of the clunk, 0..1. */
    readonly volume: number;
  };
  readonly shop: {
    /** What it sells, and for how much of the team's credit. */
    readonly wares: readonly Ware[];
    /** How far, in pixels, a purchase's cash register rings. */
    readonly noiseRadius: number;
    /** Volume of the register, 0..1. */
    readonly volume: number;
  };
}

/** The cruiser's storage and shop, as its vehicle has them. */
export function stock(config: StockConfig): {
  readonly storage: Storage;
  readonly shop: VehicleShop;
} {
  return {
    storage: {
      slots: config.storage.slots,
      noise: config.storage.noiseRadius,
      sound: sound({ url: clunkUrl, volume: config.storage.volume, range: config.storage.noiseRadius }),
    },
    shop: {
      wares: config.shop.wares,
      noise: config.shop.noiseRadius,
      sound: sound({ url: registerUrl, volume: config.shop.volume, range: config.shop.noiseRadius }),
    },
  };
}
