import { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import { defineEntity, livingBody, rounded } from "../../sim/index.js";
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

/**
 * The snail: picks one body of the kinds it targets when it arrives, and creeps after it, slow,
 * never stopping, and kills whatever it touches. It cannot die. Distances in pixels.
 */
export interface SnailConfig extends Hunting {
  /** How the world's spawner brings it. */
  readonly spawning: SpawningConfig;
  readonly radius: number;
  /** Its speed, as a share of a player's walking speed. */
  readonly speedShare: number;
  /** Damage dealt to each body it touches. */
  readonly damage: number;
  /** Seconds between two touches' damage. */
  readonly attackCooldown: number;
  /** Seconds between plans of its route to its quarry. */
  readonly repathInterval: number;
}

const NAME = "snail";

const SNAIL_GLYPH = "🐌";

/** A point, sent to a tenth of a pixel. */
const Waypoint = z.object({ x: rounded(1), y: rounded(1) });

/** A moment on the world's clock, in sim seconds, sent to a hundredth. */
const Time = rounded(2);

/**
 * The body it is after, by id, null while there is none to pick; its route there, when it next
 * plans it, when it may next strike and whether it strikes this step. Every client reads its
 * quarry, to name it under the snail; only the host reads the rest.
 */
export const SnailState = z.object({
  quarry: z.string().nullable(),
  route: z.array(Waypoint).max(MAX_WAYPOINTS),
  repathAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
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

/** A fresh snail's state at world time `now`, after the body `quarry`. */
export function freshSnail(quarry: string | null, now: number): SnailState {
  return {
    quarry,
    route: [],
    repathAt: now,
    attackAt: now,
    attacking: false,
  };
}

/**
 * Its route to `to`: planned round the walls, or straight at it when no route short enough
 * reaches it, sliding along whatever wall is in the way.
 */
function routeTo(game: Session, self: WorldEntity, to: Point): Point[] {
  return (
    planRoute(game.world.map, self.radius, self, to) ?? [{ x: to.x, y: to.y }]
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
    route: routeTo(game, self, quarry),
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

function definition(config: SnailConfig): EntityDefinition<SnailState> {
  return {
    radius: config.radius,
    // It cannot die, whatever it takes.
    maxHealth: Infinity,
    data: SnailState,
    update(entity, state, dt, game) {
      const next = attack(
        hunt(state, entity, game, config),
        entity,
        game,
        config,
      );
      const speed = game.config.player.speed * config.speedShare;
      return { ...next, route: steer(entity, next.route, speed, dt) };
    },
    strikes(entity, state, game): Strike[] {
      if (!state.attacking) return [];
      return touching(game, entity, config.ignores).map((body) => ({
        target: body.id,
        amount: config.damage,
      }));
    },
    draw(ctx, entity, state, _now, game) {
      drawEmoji(ctx, entity, SNAIL_GLYPH, entity.radius * 2);
      const name = quarryName(game, state);
      if (name === null) return;
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillStyle = "#eee";
      ctx.fillText(name, entity.x, entity.y + entity.radius + 14);
    },
  };
}
/**
 * The snail: rare. When it arrives it picks a body of the kinds its config targets (players), and
 * creeps after it at a fraction of a player's pace, round the walls, for as long as it lives or
 * stays, then picks another; with none to pick it stands. Its quarry's name shows under it on
 * every screen. Whatever it touches, player or monster, takes damage enough to kill it, and
 * nothing kills it. It makes no sound, pays light no mind, and a stun holds it like anything else.
 */
export const snail = defineEntity(NAME, (config: SnailConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    // Light does not keep it away.
    rules: { inLight: true },
    fresh: (_seed: number, game: Session) =>
      freshSnail(pickQuarry(game, null, config), game.worldTime),
  }),
}));
