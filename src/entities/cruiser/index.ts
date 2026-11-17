import { z } from "zod";
import {
  credit,
  defineEntity,
  effect,
  INERT_TAG,
  inRect,
  livingPlayers, sound,
  worldData,
} from "../../sim/index.js";
import type {
  LightEmission,
  Player,
  Point,
  Session,
  WorldEntity,
} from "../../sim/index.js";
import {
  cruiserNear,
  CruiserState,
  FRESH,
  stepCruiser,
  vehicle,
} from "./drive.js";
import type { DrivingConfig } from "./drive.js";
import { drawCruiser } from "./draw.js";
import { door, stepDoor } from "./door.js";
import type { CruiserDoorConfig } from "./door.js";
import { stepRevival } from "./revive.js";
import type { ReviveConfig } from "./revive.js";
import { stock } from "./stock.js";
import {
  coinToss,
  gamble,
  saleOn,
  sales,
  stepCoinToss,
  stepSales,
} from "./finances.js";
import type { FinancesConfig } from "./finances.js";
import type { StockConfig } from "./stock.js";
import { playRadio, radioPlaying, stationOf, tuner } from "./radio.js";
import { recalling, startRecall } from "../recall/index.js";
import type { CruiserRadioConfig } from "./radio.js";

export { refuel } from "./drive.js";
export { sales } from "./finances.js";
import departUrl from "./sfx/depart.mp3";
import escapeUrl from "./sfx/escape.mp3";

/** How the cruiser takes the players out once it reaches the exit. */
interface EscapeConfig {
  /** Seconds the cruiser waits in the exit before everyone in it escapes. */
  readonly delay: number;
  /** Volume of the departure's sounds, 0..1. */
  readonly volume: number;
  /** Credit the team must have banked for the cruiser to leave; it keeps it. */
  readonly quota: number;
}

/** The cruiser's two headlights, one each side of its front, each a cone like a flashlight's. */
interface HeadlightConfig {
  /** How far each reaches, in pixels. */
  readonly range: number;
  /** Width of each cone, in radians. */
  readonly angle: number;
  /** How far each sits to the side of the cruiser's middle, in pixels. */
  readonly spread: number;
}

/**
 * A car that starts at the world's rally point, its headlights always on, unfuelled; players get
 * in it, and fuelled, one of them can drive it.
 */
export interface CruiserConfig
  extends DrivingConfig, StockConfig, FinancesConfig {
  /**
   * Its body, in pixels: a box `length` from back to front and `width` across, turned the way it
   * points. It is drawn, meets walls, rams bodies and is seen as that box.
   */
  readonly length: number;
  readonly width: number;
  readonly headlights: HeadlightConfig;
  readonly escape: EscapeConfig;
  readonly revive: ReviveConfig;
  readonly radio: CruiserRadioConfig;
  readonly door: CruiserDoorConfig;
}

const NAME = "cruiser";

/** The cruiser's stock, its shop's wares on sale as the world's sales have them. */
function withSales(held: ReturnType<typeof stock>): ReturnType<typeof stock> {
  return { ...held, shop: { ...held.shop, sale: saleOn } };
}

/**
 * Its headlights, front left and front right at the front of its body, `ahead` of its middle,
 * both shining the way it points, `heading`.
 */
function headlights(
  config: HeadlightConfig,
  ahead: number,
  heading: number,
): LightEmission[] {
  const forward = { x: Math.cos(heading), y: Math.sin(heading) };
  const side = { x: -forward.y, y: forward.x };
  return [-1, 1].map((hand) => ({
    from: {
      x: forward.x * ahead + side.x * config.spread * hand,
      y: forward.y * ahead + side.y * config.spread * hand,
    },
    range: config.range,
    shape: { kind: "cone", direction: heading, angle: config.angle },
  }));
}

/** How wide an escaping player's flash is, in its own radii. */
const ESCAPE_FLASH = 3;

/**
 * The departure: when, on the world's clock, the cruiser last came to rest in the exit, null while
 * it is out of it; and every player that has escaped, by id. The host keeps it, and every client
 * holds it, so the countdown carries over to a new host.
 */
export const departure = worldData({
  schema: z.object({
    since: z.number().nullable(),
    escaped: z.array(z.string()),
  }),
  initial: { since: null, escaped: [] },
});

/** The world's cruiser, or null when it has none. */
function theCruiser(game: Session): WorldEntity | null {
  const id = game.kindIds.get(NAME);
  for (const entity of game.entities.values())
    if (entity.kind === id) return entity;
  return null;
}

/** Where the world's cruiser stands, or null when it has none. */
function cruiserAt(game: Session): Point | null {
  const entity = theCruiser(game);
  return entity === null ? null : { x: entity.x, y: entity.y };
}

/** Whether `player` has escaped the world. */
export function hasEscaped(game: Session, player: Pick<Player, "id">): boolean {
  return departure.get(game).escaped.includes(player.id);
}

/**
 * Seconds until everyone in the exit escapes, while the cruiser waits there; null while it is
 * away from it.
 */
export function departingIn(game: Session, delay: number): number | null {
  const { since } = departure.get(game);
  return since === null ? null : Math.max(0, since + delay - game.worldTime);
}

/**
 * The exit's rule, run on the host each step: once the cruiser comes to the exit with the team's
 * quota banked a countdown starts, and when it runs out every player in the exit escapes, and the
 * countdown starts afresh for whoever is left. Leaving the exit, or the credit dropping short of
 * the quota, stops it. Nothing else follows an escape yet.
 */
function stepDeparture(game: Session, config: EscapeConfig): void {
  const held = departure.get(game);
  const at = cruiserAt(game);
  const { exit } = game.world.layout;
  if (at === null || !inRect(exit, at) || credit.get(game) < config.quota) {
    if (held.since !== null) departure.set(game, { ...held, since: null });
    return;
  }
  if (held.since === null) {
    departure.set(game, { ...held, since: game.worldTime });
    effect(game, { at, sound: sound({url:departUrl, range: 20, volume: 0.3, noise: false}) }, game.local);
    return;
  }
  if (game.worldTime < held.since + config.delay) return;
  const leaving = livingPlayers(game).filter(
    (player) => inRect(exit, player) && !held.escaped.includes(player.id),
  );
  departure.set(game, {
    since: null,
    escaped: [...held.escaped, ...leaving.map((player) => player.id)],
  });
  for (const player of leaving)
    effect(
      game,
      {
        at: { x: player.x, y: player.y },
        flash: { radius: player.radius * ESCAPE_FLASH, hit: true },
        sound: sound({url:escapeUrl, noise: false}),
      },
      player,
    );
}

/**
 * How much more credit the team needs banked before the cruiser leaves, while it stands in the
 * exit short of the quota; null while it is away from the exit, or the quota is met.
 */
export function shortOfQuota(game: Session, quota: number): number | null {
  const at = cruiserAt(game);
  if (at === null || !inRect(game.world.layout.exit, at)) return null;
  const short = quota - credit.get(game);
  return short > 0 ? short : null;
}

/** The cruiser nearest `at`, within `reach` of touching its body; null for none. */
export const nearCruiser = (
  game: Session,
  at: Point & { readonly radius: number },
  reach: number,
): WorldEntity | null => cruiserNear(game, NAME, at, reach);

/**
 * A car that starts where new players arrive, its two headlights always shining ahead. Anyone
 * beside it may get in, any number at once, fuel or none: inside, nothing out in the world sees
 * or strikes them while its door is shut, though they are heard from it, its horn too. Its door
 * stands open until someone inside shuts it, which takes power, burns more while shut, and swings
 * open when the power runs out; open, the power charges back up. It starts without fuel; once
 * fuelled its engine runs, and those inside take the wheel, any number together, and drive it,
 * burning fuel as it moves, ramming what it drives into and knocking down the walls it crashes
 * into, until it breaks down. Those inside share a storage, and buy items at its shop with the team's credit.
 * Those outside walk through it. Once it reaches the world's exit, it takes everyone there out
 * after a delay. It carries a set on the walkie band, which those inside hear every transmission
 * on and transmit from, and a radio anyone inside tunes, which plays its station from the car and
 * draws whatever hears it. Its teleporter, worked from the cabin, sends for a body out in the
 * world, one at a time, and a recall brings it to the car, a player into it, as the recall kind
 * has it.
 */
export const cruiser = defineEntity(NAME, (config: CruiserConfig) => ({
  radius: config.length / 2,
  box: {
    length: config.length,
    width: config.width,
    heading: (_entity, state) => state.heading,
  },
  maxHealth: Infinity,
  mass: 4,
  collides: false,
  tags: [INERT_TAG],
  data: CruiserState,
  light: (_entity, state) =>
    headlights(config.headlights, config.length / 2, state.heading),
  vehicle: {
    ...vehicle(config),
    ...withSales(stock(config)),
    gamble: gamble(config),
    transceiver: true,
    door: door(config.door),
    tune: tuner(config.radio),
    station: stationOf,
    teleporter: {
      sending: (game, entity) => recalling(game, entity.id),
      send: (game, entity, _by, target) => {
        startRecall(game, entity, target);
      },
    },
  },
  plays: (_entity, state) => radioPlaying(state, config.radio),
  update(entity, state, dt, game) {
    const driven = stepCruiser(game, entity, state, dt, config);
    const next = stepDoor(game, entity, driven, dt, config.door);
    playRadio(game, entity, next, config.radio);
    return next;
  },
  draw(ctx, entity, state, _now, game) {
    drawCruiser(ctx, entity, state, game, config, {
      fullTank: config.gauge,
      breakdown: config.crash.breakdown,
    });
  },
  spawn: { at: "rally", data: FRESH },
  world: { departure, sales, coinToss },
  step(game) {
    const at = theCruiser(game);
    stepDeparture(game, config.escape);
    stepSales(game, at, config.shop.wares, config);
    stepCoinToss(game, at, config.coinToss);
    stepRevival(game, config.revive, (at) =>
      nearCruiser(game, at, config.revive.reach),
    );
  },
}));
