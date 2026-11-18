import { z } from "zod";
import {
  bodiesIn,
  bodyById,
  defineEntity,
  effect,
  hasKindTag,
  hurt,
  INERT_TAG,
  isAreaFree,
  isSweepFree,
  ITEM_TAG,
  removeFromWorld,
  rounded,
  sound,
  spawn,
} from "../../sim/index.js";
import type { Body, Player, Session, WorldEntity } from "../../sim/index.js";
import { Time } from "../hunt.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const landUrl = new URL("./sfx/land.mp3", import.meta.url).href;
const outUrl = new URL("./sfx/out.mp3", import.meta.url).href;

/** A flare, shot from a flare gun. Distances in pixels, speeds in pixels a second. */
export interface FlareConfig {
  readonly radius: number;
  readonly speed: number;
  /** Damage it deals to a body it strikes in flight, which stops it there. */
  readonly damage: number;
  /** The light it gives off, in flight and once landed: how far it reaches, and its colour. */
  readonly light: { readonly range: number; readonly tint: string };
  /** Seconds it burns once landed before it goes out. */
  readonly seconds: number;
  /** How far, in pixels, each of its sounds is heard, and so how far its noise carries. */
  readonly sounds: { readonly land: number; readonly out: number };
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
}

/**
 * Which way it flies, in radians, how much further it flies, who shot it, and when it landed,
 * null while it flies. Everyone reads them, to draw it.
 */
const FlareState = z.object({
  heading: rounded(3),
  left: rounded(1, z.number().min(0)),
  by: z.string().min(1).max(64),
  landedAt: Time.nullable(),
});

type FlareState = z.output<typeof FlareState>;

const NAME = "flare";

/** A shot of a flare: which way, in radians, and how far it flies before it drops. */
export interface FlareShot {
  readonly aim: number;
  readonly range: number;
}

/**
 * Shoots a flare from `by` as `shot` says, which only the host does; the use of a flare gun calls
 * it. It leaves from just ahead of the shooter, or from the shooter itself when a wall is that
 * close. Any body may shoot one.
 */
export function fireFlare(
  game: Session,
  by: Player | WorldEntity,
  shot: FlareShot,
): void {
  const kind = game.kindIds.get(NAME);
  const radius =
    (kind === undefined ? undefined : game.entityTypes.get(kind))?.radius ?? 0;
  const reach = by.radius + radius + 1;
  const ahead = {
    x: by.x + Math.cos(shot.aim) * reach,
    y: by.y + Math.sin(shot.aim) * reach,
  };
  const from = isAreaFree(game.world.map, ahead.x, ahead.y, radius)
    ? ahead
    : { x: by.x, y: by.y };
  const state: FlareState = {
    heading: shot.aim,
    left: shot.range,
    by: by.id,
    landedAt: null,
  };
  spawn(game, NAME, from, state);
}

/** The body a flare in flight has flown into, if any, but whoever shot it, inert things and items. */
function struckBody(
  game: Session,
  flare: WorldEntity,
  state: FlareState,
): Body | null {
  return (
    bodiesIn(game, { center: flare, radius: flare.radius }, flare.id).find(
      (body) =>
        body.id !== state.by &&
        !hasKindTag(game, body.id, [INERT_TAG, ITEM_TAG]),
    ) ?? null
  );
}

const LOOK = { core: "#fff1e0", glow: "rgba(255, 60, 40, 0.45)" } as const;

/** A white-hot core in a red glow that flickers as it burns. `now` is in ms. */
function drawFlare(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  now: number,
): void {
  const flicker = 1 + 0.25 * Math.sin(now / 37) * Math.sin(now / 91);
  ctx.save();
  ctx.fillStyle = LOOK.glow;
  ctx.beginPath();
  ctx.arc(entity.x, entity.y, entity.radius * 3 * flicker, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = LOOK.core;
  ctx.beginPath();
  ctx.arc(entity.x, entity.y, entity.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * A flare: flies straight the way it was shot until it has flown its range or meets a wall or a
 * body, which it hurts a little; there it lands with a hiss and burns, lighting the ground round
 * it red, for some seconds, then goes out with a fizzle. It lights as it flies too. Its light is
 * light like any other: what shuns light keeps from it, and what is seen by it is seen.
 */
export const flare = defineEntity(NAME, (config: FlareConfig) => {
  const { volume } = config;
  const landed = sound({ url: landUrl, volume, range: config.sounds.land });
  const out = sound({ url: outUrl, volume, range: config.sounds.out });
  const light = { range: config.light.range, tint: config.light.tint };
  const land = (game: Session, entity: WorldEntity, state: FlareState) => {
    effect(
      game,
      {
        at: { x: entity.x, y: entity.y },
        sound: landed,
        flash: { radius: entity.radius * 3, hit: false },
      },
      entity,
    );
    return { ...state, left: 0, landedAt: game.worldTime };
  };
  return {
    radius: config.radius,
    maxHealth: Infinity,
    collides: false,
    castsShadow: false,
    tags: [INERT_TAG],
    data: FlareState,
    light: () => light,
    update(entity, state, dt, game) {
      entity.vx = 0;
      entity.vy = 0;
      if (state.landedAt !== null) {
        if (game.worldTime >= state.landedAt + config.seconds) {
          effect(
            game,
            { at: { x: entity.x, y: entity.y }, sound: out },
            entity,
          );
          removeFromWorld(game, entity);
        }
        return state;
      }
      const step = Math.min(config.speed * dt, state.left);
      const to = {
        x: entity.x + Math.cos(state.heading) * step,
        y: entity.y + Math.sin(state.heading) * step,
      };
      if (!isSweepFree(game.world.map, entity.radius, entity, to))
        return land(game, entity, state);
      entity.x = to.x;
      entity.y = to.y;
      const next = { ...state, left: Math.max(0, state.left - step) };
      const struck = struckBody(game, entity, next);
      if (struck !== null) {
        const body = bodyById(game, struck.id);
        if (body !== null) hurt(game, body, config.damage, entity.id);
        return land(game, entity, next);
      }
      return next.left <= 0 ? land(game, entity, next) : next;
    },
    draw(ctx, entity, _state, now) {
      drawFlare(ctx, entity, now);
    },
  };
});
