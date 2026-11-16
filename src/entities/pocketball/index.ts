import { z } from "zod";
import {
  bodiesIn,
  cabinStorage,
  defineEntity,
  effect,
  hasKindTag,
  INERT_TAG,
  isAreaFree,
  ITEM_TAG,
  itemInstances,
  livingBodies,
  massOf,
  moveWithCollision,
  nearestFreePoint,
  pocketAt,
  pocketCentre,
  removeFromWorld,
  rounded,
  sound,
  soundDrop,
  spawn,
  spawnWorldItem,
  teleport,
} from "../../sim/index.js";
import type {
  Body,
  ItemInstance,
  Player,
  Point,
  Session,
  Sound,
  WorldEntity,
} from "../../sim/index.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const bounceUrl = new URL("./sfx/bounce.mp3", import.meta.url).href;
const captureUrl = new URL("./sfx/capture.mp3", import.meta.url).href;
const releaseUrl = new URL("./sfx/release.mp3", import.meta.url).href;

/**
 * A pocketball in flight, thrown by a player. Distances in pixels, speeds in pixels a second.
 */
export interface PocketballConfig {
  readonly radius: number;
  readonly speed: number;
  /** How far it flies before it can touch whoever threw it, so it leaves their hand. */
  readonly grace: number;
  /** The radius of the flash where it catches or lets out a body. */
  readonly flash: number;
  /** How far, in pixels, each of its sounds is heard, and so how far its noise carries. */
  readonly sounds: {
    readonly bounce: number;
    readonly capture: number;
    readonly release: number;
  };
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
}

const NAME = "pocketball";

/** The item a pocketball is when it is not in flight: carried, stowed or lying about. */
export const POCKETBALL_ITEM = "pocketball";

/** The key on a pocketball item's own state naming the pocket that holds what it caught. */
const POCKET_KEY = "pocket";

const Pocket = z.number().int().min(0).max(10_000);

/** The pocket a pocketball keeping `state` holds its catch in; null for an empty ball. */
export function pocketOf(state: ItemInstance["state"]): number | null {
  const parsed = Pocket.safeParse(state?.[POCKET_KEY]);
  return parsed.success ? parsed.data : null;
}

/** The own state of a pocketball holding its catch in `pocket`, or of an empty one for null. */
const pocketState = (pocket: number | null): ItemInstance["state"] =>
  pocket === null ? undefined : { [POCKET_KEY]: pocket };

/** The glyph a pocketball is drawn with: white and empty, or red and full. */
export const pocketballGlyph = (pocket: number | null): string =>
  pocket === null ? "⚪" : "🔴";

/**
 * Which way it flies, in radians, how far it has flown and how much further it flies, who threw
 * it, and the pocket holding its catch, if it has one.
 */
const ThrownState = z.object({
  heading: rounded(3),
  flown: rounded(1, z.number().min(0)),
  left: rounded(1, z.number().min(0)),
  by: z.string().min(1).max(64),
  pocket: Pocket.nullable(),
});

type ThrownState = z.output<typeof ThrownState>;

/** A throw of a pocketball: which way, in radians, how far it flies, and what it holds. */
export interface Throw {
  readonly aim: number;
  /** How far it flies in all, bounces included, before it drops, in pixels. */
  readonly range: number;
  /** The pocket holding its catch; null for an empty ball. */
  readonly pocket: number | null;
}

/**
 * Throws a pocketball from `by` as `made` says, which only the host does; the use of a pocketball
 * item calls it. It leaves from just ahead of the thrower, or from the thrower itself when a wall
 * is that close.
 */
export function throwPocketball(
  game: Session,
  by: Player,
  { aim, range, pocket }: Throw,
): void {
  const kind = game.kindIds.get(NAME);
  const type = kind === undefined ? undefined : game.entityTypes.get(kind);
  const radius = type?.radius ?? 0;
  const reach = by.radius + radius + 1;
  const ahead = {
    x: by.x + Math.cos(aim) * reach,
    y: by.y + Math.sin(aim) * reach,
  };
  const from = isAreaFree(game.world.map, ahead.x, ahead.y, radius)
    ? ahead
    : { x: by.x, y: by.y };
  const state: ThrownState = {
    heading: aim,
    flown: 0,
    left: range,
    by: by.id,
    pocket,
  };
  spawn(game, NAME, from, state);
}

/**
 * Every pocket spoken for: one a pocketball names, carried, stowed, lying about or in flight, or
 * one any body or thing is in.
 */
function takenPockets(game: Session): Set<number> {
  const taken = new Set<number>();
  const note = (pocket: number | null): void => {
    if (pocket !== null) taken.add(pocket);
  };
  for (const instance of itemInstances(game, POCKETBALL_ITEM))
    note(pocketOf(instance.state));
  const thrown = game.kindIds.get(NAME);
  for (const entity of game.entities.values()) {
    note(pocketAt(game.world.map, entity));
    if (entity.kind === thrown) {
      const parsed = ThrownState.safeParse(entity.data);
      if (parsed.success) note(parsed.data.pocket);
    }
    for (const stowed of cabinStorage(game, entity.id) ?? [])
      if (stowed?.id === POCKETBALL_ITEM) note(pocketOf(stowed.state));
  }
  for (const player of game.players.values())
    note(pocketAt(game.world.map, player));
  return taken;
}

/** The first pocket nobody has spoken for. */
function freePocket(game: Session): number {
  const taken = takenPockets(game);
  let pocket = 0;
  while (taken.has(pocket)) pocket++;
  return pocket;
}

/** Whether `body` stops a ball: a player, or a world entity solid to other bodies. */
const stopsBall = (game: Session, body: Body): boolean =>
  game.entities.get(body.id)?.collides ?? true;

/**
 * Whether a ball can catch `body`: anything alive and movable that fits in a pocket, players
 * included, but inert things such as the cruiser, and items lying about.
 */
const catchable = (game: Session, body: Body): boolean => {
  if (hasKindTag(game, body.id, [INERT_TAG, ITEM_TAG])) return false;
  if (!(massOf(game, body) < Infinity)) return false;
  const { x, y } = pocketCentre(game.world.map, 0);
  return isAreaFree(game.world.map, x, y, body.radius);
};

/**
 * The body `ball` has flown into, if any: the nearest it touches that stops it, but its thrower
 * until it has left the thrower's hand.
 */
function struckBody(
  game: Session,
  ball: WorldEntity,
  state: ThrownState,
  config: PocketballConfig,
): Body | null {
  const struck = bodiesIn(
    game,
    { center: ball, radius: ball.radius },
    ball.id,
  ).filter(
    (body) =>
      stopsBall(game, body) &&
      (body.id !== state.by || state.flown >= config.grace),
  );
  struck.sort(
    (a, b) =>
      Math.hypot(a.x - ball.x, a.y - ball.y) -
      Math.hypot(b.x - ball.x, b.y - ball.y),
  );
  return struck[0] ?? null;
}

/** What a ball's catching and letting out look and sound like. */
interface Burst {
  readonly sound: Sound;
  readonly flash: number;
}

/** A flash and `burst`'s sound at `at`, made by `ball`. */
function burstAt(
  game: Session,
  ball: WorldEntity,
  at: Point,
  burst: Burst,
): void {
  const flash = { radius: burst.flash, hit: true };
  effect(game, { at: { x: at.x, y: at.y }, sound: burst.sound, flash }, ball);
}

/**
 * Catches `body` in a free pocket: it vanishes in a flash where it stood and appears in the pocket
 * in another, and the ball drops where it struck, keeping the pocket.
 */
function capture(
  game: Session,
  ball: WorldEntity,
  body: Body,
  burst: Burst,
): void {
  const pocket = freePocket(game);
  const to = pocketCentre(game.world.map, pocket);
  burstAt(game, ball, body, burst);
  teleport(game, body, to);
  burstAt(game, ball, to, burst);
  drop(game, ball, pocket);
}

/**
 * Lets out every body and thing in `pocket` around where `ball` is, each at the nearest spot clear
 * of walls for it, in a flash; the ball is spent.
 */
function release(
  game: Session,
  ball: WorldEntity,
  pocket: number,
  burst: Burst,
): void {
  const { map } = game.world;
  const inside = livingBodies(game).filter(
    (body) => body.id !== ball.id && pocketAt(map, body) === pocket,
  );
  burstAt(game, ball, pocketCentre(map, pocket), burst);
  for (const body of inside)
    teleport(game, body, nearestFreePoint(map, body.radius, ball));
  burstAt(game, ball, ball, burst);
  removeFromWorld(game, ball);
}

/** The ball drops to the ground where it is, as a pocketball item holding `pocket`. */
function drop(game: Session, ball: WorldEntity, pocket: number | null): void {
  const at = nearestFreePoint(
    game.world.map,
    game.config.worldItems.radius,
    ball,
  );
  removeFromWorld(game, ball);
  spawnWorldItem(game, at, POCKETBALL_ITEM, undefined, pocketState(pocket));
  soundDrop(game, POCKETBALL_ITEM, at, ball);
}

/**
 * The ball as it lands, having struck `body` or flown its range for null: a full ball lets its
 * catch out there and is spent; an empty one catches what it struck, if it can, and drops.
 */
function land(
  game: Session,
  ball: WorldEntity,
  state: ThrownState,
  body: Body | null,
  bursts: { readonly capture: Burst; readonly release: Burst },
): void {
  if (state.pocket !== null) release(game, ball, state.pocket, bursts.release);
  else if (body !== null && catchable(game, body))
    capture(game, ball, body, bursts.capture);
  else drop(game, ball, null);
}

/**
 * A thrown pocketball: flies straight the way it was thrown, bouncing off walls with a tap, until
 * it has flown its range or touches a body that stops it. Empty, it catches that body, if it can,
 * into a pocket off the map, and drops where it struck, full; otherwise it just drops. Full, it
 * lets out whatever is in its pocket where it lands or strikes, and is spent. Hunters pay it no
 * mind.
 */
export const pocketball = defineEntity(NAME, (config: PocketballConfig) => {
  const { volume } = config;
  const bounce = sound({ url: bounceUrl, volume, range: config.sounds.bounce });
  const bursts = {
    capture: {
      sound: sound({ url: captureUrl, volume, range: config.sounds.capture }),
      flash: config.flash,
    },
    release: {
      sound: sound({ url: releaseUrl, volume, range: config.sounds.release }),
      flash: config.flash,
    },
  };
  return {
    radius: config.radius,
    maxHealth: Infinity,
    collides: false,
    tags: [INERT_TAG],
    data: ThrownState,
    update(entity, state, dt, game) {
      entity.vx = 0;
      entity.vy = 0;
      const step = Math.min(config.speed * dt, state.left);
      const vx = Math.cos(state.heading) * config.speed;
      const vy = Math.sin(state.heading) * config.speed;
      const flying = { x: entity.x, y: entity.y, vx, vy };
      if (step > 0)
        moveWithCollision(
          flying,
          entity.radius,
          step / config.speed,
          game.world.map,
          1,
        );
      entity.x = flying.x;
      entity.y = flying.y;
      if (
        Math.sign(flying.vx) !== Math.sign(vx) ||
        Math.sign(flying.vy) !== Math.sign(vy)
      )
        effect(
          game,
          { at: { x: entity.x, y: entity.y }, sound: bounce },
          entity,
        );
      const next: ThrownState = {
        ...state,
        heading: Math.atan2(flying.vy, flying.vx),
        flown: state.flown + step,
        left: Math.max(0, state.left - step),
      };
      const struck = struckBody(game, entity, next, config);
      if (struck !== null || next.left <= 0)
        land(game, entity, next, struck, bursts);
      return next;
    },
    draw(ctx, entity, state) {
      ctx.save();
      ctx.font = `${String(entity.radius * 2)}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(pocketballGlyph(state.pocket), entity.x, entity.y);
      ctx.restore();
    },
  };
});
