import { z } from "zod";
import { changeWorld, credit, effect, worldData } from "../../sim/index.js";
import type {
  Session,
  VehicleGamble,
  Ware,
  WorldEntity,
} from "../../sim/index.js";
// The coin's flip and its landing, once their assets land; importing a missing file breaks the
// build. Until then the toss makes its noise without a sound.
import { sound } from "../../sim/index.js";
import flipUrl from "./sfx/coin-flip.mp3";
import winUrl from "./sfx/coin-win.mp3";
import loseUrl from "./sfx/coin-lose.mp3";
// import saleUrl from "./sfx/sale.mp3";

/** A draw in [0, 1), as `Math.random` makes. */
type Rng = () => number;

/** How the cruiser's shop puts its wares on sale, and how its coin toss plays. */
export interface FinancesConfig {
  readonly sales: {
    /** Chance each ware is on sale, 0..1, drawn afresh every `every` seconds. */
    readonly chance: number;
    /** Least and most off a sale takes, in whole percent; drawn in steps of 5. */
    readonly minOff: number;
    readonly maxOff: number;
    /** Seconds of world time between one draw of the sales and the next. */
    readonly every: number;
  };
  readonly coinToss: {
    /** Seconds the coin spends in the air before it comes down. */
    readonly flight: number;
    /** Chance the coin comes down a win, 0..1. */
    readonly odds: number;
    /** Volume of the coin's sounds, 0..1. */
    readonly volume: number;
    /** How far, in pixels, the coin's sounds carry. */
    readonly range: number;
  };
}

/**
 * The shop's sales: how much is off each ware on sale, in whole percent, by item id, and when on
 * the world's clock they were last drawn, null before the first. The host draws them; every
 * client holds them, so every cabin shows the same prices and a new host carries them on.
 */
export const sales = worldData({
  schema: z.object({
    drawn: z.number().nullable(),
    off: z.record(z.string(), z.number().int().min(0).max(100)),
  }),
  initial: { drawn: null, off: {} },
});

/**
 * Draws which of `wares` are on sale, and how much off each: each one is, with `chance`, between
 * `minOff` and `maxOff` percent off in steps of 5.
 */
export function drawSales(
  wares: readonly Ware[],
  config: FinancesConfig["sales"],
  rng: Rng,
): Record<string, number> {
  const off: Record<string, number> = {};
  const steps = Math.floor((config.maxOff - config.minOff) / 5);
  for (const ware of wares) {
    if (rng() >= config.chance) continue;
    off[ware.item] = config.minOff + 5 * Math.floor(rng() * (steps + 1));
  }
  return off;
}

/**
 * The sales' rule, run on the host each step: every `every` seconds of world time, from the
 * first step on, the sales are drawn afresh. A new sale chimes at the cruiser.
 */
export function stepSales(
  game: Session,
  cruiser: WorldEntity | null,
  wares: readonly Ware[],
  config: FinancesConfig,
  rng: Rng = Math.random,
): void {
  if (!game.hosting) return;
  const held = sales.get(game);
  if (held.drawn !== null && game.worldTime < held.drawn + config.sales.every)
    return;
  const off = drawSales(wares, config.sales, rng);
  sales.set(game, { drawn: game.worldTime, off });
  if (cruiser !== null && Object.keys(off).length > 0)
    effect(
      game,
      {
        at: { x: cruiser.x, y: cruiser.y },
        // sound: sound({ url: saleUrl, volume: config.coinToss.volume, range: config.coinToss.range }),
      },
      cruiser,
    );
}

/** How much is off `item` at the shop now, in whole percent; 0 for none. */
export const saleOn = (game: Session, item: string): number =>
  sales.get(game).off[item] ?? 0;

const TossSchema = z.object({
  by: z.string(),
  bet: z.number().int().min(1),
});

/**
 * The coin toss: the coin in the air, with when on the world's clock it went up, null for none;
 * and the last to come down. The host keeps it, and every client holds it, for its cabin to show.
 */
export const coinToss = worldData({
  schema: z.object({
    up: TossSchema.extend({ since: z.number() }).nullable(),
    last: TossSchema.extend({
      n: z.number().int(),
      won: z.boolean(),
    }).nullable(),
  }),
  initial: { up: null, last: null },
});

/** The cruiser's coin toss: it goes up as staked, and comes down in `stepCoinToss`. */
export function gamble(config: FinancesConfig): VehicleGamble {
  return {
    tossing(game) {
      const { up } = coinToss.get(game);
      return up === null ? null : { by: up.by, bet: up.bet };
    },
    last: (game) => coinToss.get(game).last,
    toss(game, vehicle, by, bet) {
      changeWorld(game, coinToss, (held) => ({
        ...held,
        up: { by: by.name, bet, since: game.worldTime },
      }));
      effect(game, {
        at: { x: vehicle.x, y: vehicle.y },
        noise: config.coinToss.range,
        sound: sound({
          url: flipUrl,
          volume: config.coinToss.volume,
          range: config.coinToss.range,
        }),
      });
    },
  };
}

/** How wide a winning toss's flash is, in pixels. */
const WIN_FLASH = 40;

/**
 * The coin toss's rule, run on the host each step: once the coin has been up `flight` seconds the
 * host decides how it comes down, a win with `odds`, and a win pays the team back double the bet.
 * A win rings and flashes at the cruiser; a loss groans.
 */
export function stepCoinToss(
  game: Session,
  cruiser: WorldEntity | null,
  config: FinancesConfig["coinToss"],
  rng: Rng = Math.random,
): void {
  if (!game.hosting) return;
  const held = coinToss.get(game);
  const { up } = held;
  if (up === null || game.worldTime < up.since + config.flight) return;
  const won = rng() < config.odds;
  if (won) credit.set(game, credit.get(game) + up.bet * 2);
  coinToss.set(game, {
    up: null,
    last: { by: up.by, bet: up.bet, n: (held.last?.n ?? 0) + 1, won },
  });
  if (cruiser === null) return;
  effect(
    game,
    {
      at: { x: cruiser.x, y: cruiser.y },
      noise: config.range,
      ...(won && { flash: { radius: WIN_FLASH, hit: true } }),
      sound: sound({
        url: won ? winUrl : loseUrl,
        volume: config.volume,
        range: config.range,
      }),
    },
    cruiser,
  );
}
