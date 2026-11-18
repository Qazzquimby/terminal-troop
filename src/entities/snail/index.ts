import { z } from "zod";
import { upright } from "../../lib/upright/index.js";
import { drawEmoji } from "../../render/index.js";
import {
  defineEntity,
  livingBody,
  rounded,
  sound,
  UNNOTICED_TAG,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Point,
  Session,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import { preyFor, touching } from "../bodies.js";
import type { Hunting } from "../hunt.js";
import { strikeIf } from "../hunt.js";
import { MAX_WAYPOINTS, planRoute, steer } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";
import { breakingCost, pressWalls } from "../wall-press.js";
import type { WallPress, WallPressSounds } from "../wall-press.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const grindUrl = new URL("./sfx/grind.mp3", import.meta.url).href;
const crumbleUrl = new URL("./sfx/crumble.mp3", import.meta.url).href;

/**
 * A snail that breaks walls: how long it presses one, and how far, in pixels, its grind and the
 * crumble of a wall coming down are heard.
 */
interface SnailWallPress extends WallPress {
  readonly sounds: { readonly grind: number; readonly crumble: number };
}

/**
 * A snail, of whatever kind: picks one body of the kinds it targets when it arrives, and creeps
 * after it, slow, never stopping, and kills whatever it touches. It cannot die. Distances in
 * pixels.
 */
export interface SnailConfig extends Hunting {
  /** How the world's spawner brings it. */
  readonly spawning: SpawningConfig;
  /** Its radius; at a cell less a little, it fills two cells by two, as walls meet it. */
  readonly radius: number;
  /** Its speed, as a share of a player's walking speed. */
  readonly speedShare: number;
  /** Damage dealt to each body it touches. */
  readonly damage: number;
  /** Seconds between two touches' damage. */
  readonly attackCooldown: number;
  /** Seconds between plans of its route to its quarry. */
  readonly repathInterval: number;
  /**
   * How it presses through the walls in its way, where that is quicker than going round; left
   * out, walls stop it.
   */
  readonly breaksWalls?: SnailWallPress;
}

const SNAIL_GLYPH = "🐌";

/** A point, sent to a tenth of a pixel. */
const Waypoint = z.object({ x: rounded(1), y: rounded(1) });

/** A moment on the world's clock, in sim seconds, sent to a hundredth. */
const Time = rounded(2);

/**
 * The body it is after, by id, null while there is none to pick; its route there, when it next
 * plans it, when it may next strike, whether it strikes this step, and the seconds it has pressed
 * the wall in its way, 0 while it presses none. Every client reads its quarry, to name it under
 * the snail, and its route and pressing, to show the dust it raises; only the host reads the rest.
 */
export const SnailState = z.object({
  quarry: z.string().nullable(),
  route: z.array(Waypoint).max(MAX_WAYPOINTS),
  repathAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
  pressed: rounded(2),
});

type SnailState = z.output<typeof SnailState>;

/**
 * A living body `self` may hunt drawn at random, by id, or null when there is none; `self` is null
 * for a snail yet to arrive.
 */
function pickQuarry(
  game: Session,
  self: WorldEntity | null,
  config: SnailConfig,
): string | null {
  const ids = preyFor(game, self, config).map((body) => body.id);
  return ids[Math.floor(Math.random() * ids.length)] ?? null;
}

/** A fresh snail's state at world time `now`, after the body `quarry`; for any kind of snail. */
export function freshSnail(quarry: string | null, now: number): SnailState {
  return {
    quarry,
    route: [],
    repathAt: now,
    attackAt: now,
    attacking: false,
    pressed: 0,
  };
}

/** Its speed, in pixels a second. */
function speedOf(game: Session, config: SnailConfig): number {
  return game.config.player.speed * config.speedShare;
}

/**
 * Its route to `to`: planned round the walls, or through them where it breaks them and that is
 * quicker, or straight at it when no route short enough reaches it, sliding along whatever wall
 * is in the way, or pressing through it.
 */
function routeTo(
  game: Session,
  self: WorldEntity,
  to: Point,
  config: SnailConfig,
): Point[] {
  const { map } = game.world;
  const press = config.breaksWalls;
  const wallCost =
    press === undefined
      ? undefined
      : breakingCost(press, speedOf(game, config), map.cell);
  return (
    planRoute(map, self.radius, self, to, undefined, wallCost) ?? [
      { x: to.x, y: to.y },
    ]
  );
}

/**
 * Keeps after its quarry, picking another while it is gone or dead, and replans its route when
 * due.
 */
function hunt(
  state: SnailState,
  self: WorldEntity,
  game: Session,
  config: SnailConfig,
): SnailState {
  const now = game.worldTime;
  const kept =
    livingBody(game, state.quarry) !== null
      ? state
      : { ...state, quarry: pickQuarry(game, self, config), repathAt: now };
  const quarry = livingBody(game, kept.quarry);
  if (quarry === null) return { ...kept, route: [] };
  if (now < kept.repathAt) return kept;
  return {
    ...kept,
    route: routeTo(game, self, quarry, config),
    repathAt: now + config.repathInterval,
  };
}

/**
 * The name shown under a snail: its quarry's, as players see it over that player's head; null
 * while it has no quarry, or one with no name.
 */
export function quarryName(game: Session, state: SnailState): string | null {
  if (state.quarry === null) return null;
  return game.players.get(state.quarry)?.name ?? null;
}

/** Strikes once the cooldown is over, when it touches anything. */
function attack(
  state: SnailState,
  self: WorldEntity,
  game: Session,
  config: SnailConfig,
): SnailState {
  return strikeIf(
    state,
    game.worldTime,
    touching(game, self, config.ignores).length > 0,
    config.attackCooldown,
  );
}

/** Presses the wall in its way, if it breaks walls; otherwise presses none. */
function press(
  state: SnailState,
  self: WorldEntity,
  game: Session,
  dt: number,
  config: SnailConfig,
  sounds: WallPressSounds | null,
): SnailState {
  const breaks = config.breaksWalls;
  if (breaks === undefined || sounds === null) return { ...state, pressed: 0 };
  const toward = state.route[0] ?? null;
  const pressed = pressWalls(
    game,
    self,
    toward,
    state.pressed,
    dt,
    breaks,
    sounds,
  );
  return { ...state, pressed };
}

/** Dust colour, raised where it presses a wall. */
const DUST = "rgba(170, 150, 130, 0.5)";

/** Where dust puffs at the wall it presses: along its way and across it, in radii, and how big. */
const PUFFS = [
  [1, -0.6, 0.3],
  [1.1, 0.1, 0.35],
  [0.95, 0.7, 0.25],
  [1.25, -0.2, 0.2],
] as const;

/**
 * Dust raised at the face it presses towards `toward`, thicker the longer it has pressed, out of
 * `seconds` before the wall comes down; it shifts each tenth of a second, so it seems to churn.
 */
function drawDust(
  ctx: CanvasRenderingContext2D,
  self: WorldEntity,
  toward: Point,
  share: number,
  now: number,
): void {
  const angle = Math.atan2(toward.y - self.y, toward.x - self.x);
  const churn = Math.floor(now * 10) % 2 === 0 ? 1 : -1;
  ctx.save();
  ctx.translate(self.x, self.y);
  ctx.rotate(angle);
  ctx.fillStyle = DUST;
  ctx.globalAlpha = 0.4 + 0.6 * share;
  for (const [ahead, side, size] of PUFFS) {
    ctx.beginPath();
    ctx.arc(
      self.radius * ahead,
      self.radius * side * churn,
      self.radius * size * (0.7 + share * 0.6),
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
}

function definition(
  config: SnailConfig,
  sounds: WallPressSounds | null,
): EntityDefinition<SnailState> {
  return {
    radius: config.radius,
    // It cannot die, whatever it takes.
    maxHealth: Infinity,
    // No monster hunts, chases or strikes it.
    tags: [UNNOTICED_TAG],
    data: SnailState,
    update(entity, state, dt, game) {
      const next = attack(
        hunt(state, entity, game, config),
        entity,
        game,
        config,
      );
      const route = steer(entity, next.route, speedOf(game, config), dt);
      return press({ ...next, route }, entity, game, dt, config, sounds);
    },
    strikes(entity, state, game): Strike[] {
      if (!state.attacking) return [];
      return touching(game, entity, config.ignores).map((body) => ({
        target: body.id,
        amount: config.damage,
      }));
    },
    draw(ctx, entity, state, now, game) {
      drawEmoji(ctx, entity, SNAIL_GLYPH, entity.radius * 2);
      const toward = state.route[0];
      const seconds = config.breaksWalls?.seconds;
      if (state.pressed > 0 && toward !== undefined && seconds !== undefined)
        drawDust(
          ctx,
          entity,
          toward,
          Math.min(1, state.pressed / seconds),
          now,
        );
      const name = quarryName(game, state);
      if (name === null) return;
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillStyle = "#eee";
      upright(ctx, entity, () => {
        ctx.fillText(name, entity.x, entity.y + entity.radius + 14);
      });
    },
  };
}

/**
 * A kind of snail, `name`: rare. When it arrives it picks a body of the kinds its config targets
 * (players), and creeps after it at a fraction of a player's pace, round the walls, for as long as
 * it lives or stays, then picks another; with none to pick it stands. Its quarry's name shows
 * under it on every screen. Whatever it touches, player or monster, takes damage enough to kill
 * it, and nothing kills it. No monster hunts, notices or strikes it. It pays light no mind, and a
 * stun holds it like anything else. Its config sizes it, and may have it press through the walls
 * in its way where that is quicker than going round: grinding as it presses, dust rising, and the
 * wall crumbling after a while of it.
 */
function snailKind<N extends string>(name: N) {
  return defineEntity(name, (config: SnailConfig) => {
    const breaks = config.breaksWalls;
    const sounds =
      breaks === undefined
        ? null
        : {
            grind: sound({ url: grindUrl, range: breaks.sounds.grind }),
            crumble: sound({ url: crumbleUrl, range: breaks.sounds.crumble }),
          };
    return {
      ...definition(config, sounds),
      ...arrivals({
        kind: name,
        radius: config.radius,
        config: config.spawning,
        // Light does not keep it away.
        rules: { inLight: true },
        fresh: (_seed: number, game: Session) =>
          freshSnail(pickQuarry(game, null, config), game.worldTime),
      }),
    };
  });
}

/** The snail: small and slow, walls stop it. */
export const snail = snailKind("snail");

/**
 * The giant snail: a snail two cells by two, somewhat faster, that presses through a wall in its
 * way when that is quicker than going round.
 */
export const giantSnail = snailKind("giantSnail");
