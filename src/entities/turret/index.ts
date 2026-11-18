import { z } from "zod";
import {
  bodyById,
  canSeeFrom,
  defineEntity,
  distanceToWall,
  effect,
  INERT_TAG,
  isStunned,
  livingBody,
  rounded,
  shoot,
  sound,
  spawn,
} from "../../sim/index.js";
import type {
  Body,
  Player,
  Point,
  Session,
  WorldEntity,
} from "../../sim/index.js";
import { nearestSeenBody, preyFor } from "../bodies.js";
import { Time } from "../hunt.js";
import type { Hunting } from "../hunt.js";
import {
  Arming,
  arming,
  drawArmingLight,
  placedAhead,
  stepArming,
} from "../placed.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const beepUrl = new URL("./sfx/beep.mp3", import.meta.url).href;
const lockUrl = new URL("./sfx/lock.mp3", import.meta.url).href;
const shotUrl = new URL("./sfx/shot.mp3", import.meta.url).href;
const breakUrl = new URL("./sfx/break.mp3", import.meta.url).href;
const clickUrl = new URL("./sfx/click.mp3", import.meta.url).href;

/**
 * A turret lying where a player put it down: it sets up, then sweeps a narrow beam round and round,
 * and shoots at what it catches in it. Whom it shoots at is its config's `ignores` and `targets`,
 * as for a monster: as the ticket asks, every living body but players, inert things such as the
 * cruiser and items. Distances in pixels, times in sim seconds.
 */
export interface TurretConfig extends Hunting {
  readonly radius: number;
  /** Its health: shots, kicks and blasts wear it down, and at none it breaks. */
  readonly maxHealth: number;
  /** How hard it is to push, in player masses; sized to its radius when left out. */
  readonly mass?: number;
  /** Seconds from being put down until it has set up and starts sweeping. */
  readonly armSeconds: number;
  /** Its view, the beam its laser shows: how wide, in radians, and how far it reaches. */
  readonly sight: { readonly angle: number; readonly range: number };
  /** Seconds it takes to sweep once all the way round. */
  readonly turnSeconds: number;
  /**
   * Shots it holds as it is put down. Once they are spent it still sweeps and locks on, but where
   * it would shoot it only clicks.
   */
  readonly ammo: number;
  /** Its shots, each a handgun's, the first `aimSeconds` after it locks on. */
  readonly shot: {
    readonly damage: number;
    readonly range: number;
    readonly interval: number;
    readonly aimSeconds: number;
    readonly spark: number;
  };
  /** How far, in pixels, each of its sounds is heard, and so how far its noise carries. */
  readonly sounds: {
    readonly beep: number;
    readonly lock: number;
    readonly shot: number;
    readonly break: number;
    /** Its click, out of ammo, where it would have shot. */
    readonly click: number;
  };
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
}

/**
 * Whether it has set up; the way it faced as of `turnedAt`, from which, sweeping, it turns on at a
 * steady pace, and locked on, faces its target; the body it is locked on, null while it sweeps;
 * when its next shot is due; and how many shots it has fired, so how much of its ammo is left.
 * Everyone reads them, to draw it, its beam and its ammo.
 */
export const TurretState = Arming.extend({
  facing: rounded(2),
  turnedAt: Time,
  target: z.string().nullable(),
  shotAt: Time,
  fired: z.number().int().nonnegative(),
});

type TurretState = z.output<typeof TurretState>;

const NAME = "turret";

const TAU = Math.PI * 2;

const COLOURS = {
  base: "#4b525a",
  rim: "#22272c",
  barrel: "#2c3136",
  beam: "rgba(255, 50, 40, 0.35)",
  locked: "rgba(255, 40, 30, 0.85)",
  dry: "rgba(160, 160, 160, 0.6)",
  ammo: "#ffb43a",
} as const;

/**
 * Puts a fresh turret down just ahead of `by`, facing `aim`, which only the host does; the use of
 * a turret item calls it, on the host and on its user's own client alike. Returns where it lies.
 */
export function placeTurret(game: Session, by: Player, aim: number): Point {
  const at = placedAhead(game, by, aim, NAME);
  const state: TurretState = {
    ...arming(game),
    facing: aim,
    turnedAt: game.worldTime,
    target: null,
    shotAt: game.worldTime,
    fired: 0,
  };
  spawn(game, NAME, at, state);
  return at;
}

/** `angle` wrapped into [0, 2π). */
const wrapped = (angle: number): number => ((angle % TAU) + TAU) % TAU;

/**
 * The way the turret faces at world time `now`: still while it sets up or is locked on, and
 * sweeping round from `facing` once it has set up.
 */
function facingAt(
  state: TurretState,
  now: number,
  config: TurretConfig,
): number {
  if (!state.armed || state.target !== null) return state.facing;
  return wrapped(
    state.facing + ((now - state.turnedAt) / config.turnSeconds) * TAU,
  );
}

const angleTo = (from: Point, to: Point): number =>
  Math.atan2(to.y - from.y, to.x - from.x);

/**
 * The body the turret is locked on, while it still sees it: alive, out in the world, one it shoots
 * at, and in range along a clear line. Null once it has lost it.
 */
function heldTarget(
  game: Session,
  self: WorldEntity,
  state: TurretState,
  config: TurretConfig,
): Body | null {
  const body = livingBody(game, state.target);
  if (body === null) return null;
  if (!preyFor(game, self, config, { at: body, range: 0 }).includes(body))
    return null;
  const range = config.sight.range;
  return canSeeFrom(game.world.map, { x: self.x, y: self.y, range }, body)
    ? body
    : null;
}

/**
 * A turret: sets up some seconds after it is put down, beeping once it has; then sweeps its narrow
 * beam round at a steady pace. The first body it catches in its beam that it shoots at, it locks
 * on: it turns to follow it and shoots it a handgun's shot every few seconds, which stops at the
 * first body in its way, friend or foe, as any shot does. It holds so many shots; once they are
 * spent it goes on sweeping and locking on, but clicks dry where it would shoot, its locked beam
 * grey and its ammo ring empty. Once it no longer sees its target it
 * sweeps again from where it faces. Stunned, it is blind and holds its fire, its laser out, its
 * motor turning on regardless. Shots, kicks and
 * blasts hurt it and kicks shove it; hunters pay it no mind. It breaks once worn down.
 */
export const turret = defineEntity(NAME, (config: TurretConfig) => {
  const { volume } = config;
  const beep = sound({ url: beepUrl, volume, range: config.sounds.beep });
  const lock = sound({ url: lockUrl, volume, range: config.sounds.lock });
  const report = sound({ url: shotUrl, volume, range: config.sounds.shot });
  const broken = sound({ url: breakUrl, volume, range: config.sounds.break });
  const click = sound({ url: clickUrl, volume, range: config.sounds.click });

  /** Sweeps on from where it faces now, having lost its target. */
  const sweep = (state: TurretState, now: number): TurretState => ({
    ...state,
    facing: facingAt(state, now, config),
    turnedAt: now,
    target: null,
  });

  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    mass: config.mass,
    tags: [INERT_TAG],
    data: TurretState,
    eyes(_entity, state, game) {
      if (!state.armed) return null;
      return {
        cone: {
          direction: facingAt(state, game.worldTime, config),
          angle: config.sight.angle,
          range: config.sight.range,
        },
        around: 0,
      };
    },
    update(entity, state, _dt, game) {
      entity.vx = 0;
      entity.vy = 0;
      const now = game.worldTime;
      if (!state.armed) {
        const armed = stepArming(game, entity, state, {
          seconds: config.armSeconds,
          noise: config.sounds.beep,
          sound: beep,
        });
        return armed.armed ? { ...armed, turnedAt: now } : armed;
      }
      if (state.target === null) {
        const seen = nearestSeenBody(game, entity, config, config.sight.range);
        if (seen === null) return state;
        effect(game, { at: entity, sound: lock }, entity);
        return {
          ...state,
          facing: angleTo(entity, seen),
          turnedAt: now,
          target: seen.id,
          shotAt: now + config.shot.aimSeconds,
        };
      }
      const target = heldTarget(game, entity, state, config);
      if (target === null) return sweep(state, now);
      const aim = angleTo(entity, target);
      if (now < state.shotAt) return { ...state, facing: aim };
      const next = {
        ...state,
        facing: aim,
        shotAt: now + config.shot.interval,
      };
      if (state.fired >= config.ammo) {
        effect(game, { at: entity, sound: click }, entity);
        return next;
      }
      shoot(
        game,
        entity,
        { aim, range: config.shot.range, damage: config.shot.damage },
        { spark: config.shot.spark },
      );
      effect(game, { at: entity, sound: report }, entity);
      return { ...next, fired: state.fired + 1 };
    },
    dies(entity, _state, game) {
      effect(
        game,
        {
          at: { x: entity.x, y: entity.y },
          sound: broken,
          flash: { radius: entity.radius * 2, hit: true },
        },
        entity,
      );
    },
    draw(ctx, entity, state, now, game) {
      const target =
        state.target === null ? null : bodyById(game, state.target);
      const facing =
        target === null
          ? facingAt(state, game.worldTime, config)
          : angleTo(entity, target);
      const left = Math.max(0, config.ammo - state.fired);
      if (state.armed && !isStunned(game, entity.id))
        drawBeam(ctx, game, entity, facing, target, left > 0, config);
      drawBody(ctx, entity, facing);
      drawAmmo(ctx, entity, config.ammo === 0 ? 0 : left / config.ammo);
      drawArmingLight(ctx, entity, state, now);
    },
  };
});

/**
 * Its laser: a thin line the way it faces, out to its sight range or the first wall; locked on, a
 * bright one to its target, or a grey one once it is out of ammo.
 */
function drawBeam(
  ctx: CanvasRenderingContext2D,
  game: Session,
  self: WorldEntity,
  facing: number,
  target: Point | null,
  loaded: boolean,
  config: TurretConfig,
): void {
  const direction = { x: Math.cos(facing), y: Math.sin(facing) };
  const length =
    target === null
      ? distanceToWall(game.world.map, self, direction, config.sight.range)
      : Math.hypot(target.x - self.x, target.y - self.y);
  ctx.save();
  ctx.strokeStyle =
    target === null ? COLOURS.beam : loaded ? COLOURS.locked : COLOURS.dry;
  ctx.lineWidth = target === null ? 1 : 1.5;
  ctx.beginPath();
  ctx.moveTo(
    self.x + direction.x * self.radius,
    self.y + direction.y * self.radius,
  );
  ctx.lineTo(self.x + direction.x * length, self.y + direction.y * length);
  ctx.stroke();
  ctx.restore();
}

/**
 * Its ammo: an amber ring round its base, from the top clockwise, as full as the share `left` of
 * its shots it has left; none once it is out.
 */
function drawAmmo(
  ctx: CanvasRenderingContext2D,
  self: WorldEntity,
  left: number,
): void {
  if (left <= 0) return;
  ctx.save();
  ctx.strokeStyle = COLOURS.ammo;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(
    self.x,
    self.y,
    self.radius + 3,
    -Math.PI / 2,
    -Math.PI / 2 + left * TAU,
  );
  ctx.stroke();
  ctx.restore();
}

/** Its body: a round base with a barrel pointing the way it faces. */
function drawBody(
  ctx: CanvasRenderingContext2D,
  self: WorldEntity,
  facing: number,
): void {
  ctx.save();
  ctx.fillStyle = COLOURS.base;
  ctx.strokeStyle = COLOURS.rim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(self.x, self.y, self.radius, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.translate(self.x, self.y);
  ctx.rotate(facing);
  ctx.fillStyle = COLOURS.barrel;
  ctx.fillRect(0, -2.5, self.radius * 1.5, 5);
  ctx.restore();
}
