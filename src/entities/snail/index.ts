import { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import {
  defineEntity,
  hasKindTag,
  inRect,
  INERT_TAG,
  isAreaFree,
  rounded,
  spawn,
  worldData,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Point,
  Session,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import { MAX_WAYPOINTS, planRoute, steer } from "../route.js";

/** How the world comes to hold its snail. Times in sim seconds, distances in pixels. */
interface SnailSpawningConfig {
  /** Seconds into the world before the first may arrive. */
  readonly firstDelay: number;
  /** Seconds between later tries, each only while fewer than the most are alive. */
  readonly gap: number;
  /** Most alive at once. */
  readonly maxAlive: number;
  /** Points tried for a spawn before skipping it. */
  readonly tries: number;
  /** Least distance a spawn keeps from every player, so none sees it appear. */
  readonly unseenDistance: number;
}

/**
 * The snail: picks one player when it arrives and creeps after them, slow, never stopping, and
 * kills whatever it touches. It cannot die. Distances in pixels.
 */
export interface SnailConfig {
  readonly spawning: SnailSpawningConfig;
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

/** What players call it. */
const SNAIL_TITLE = "The Unhurried";

const NAME = "snail";

const SNAIL_GLYPH = "🐌";

/** A point, sent to a tenth of a pixel. */
const Waypoint = z.object({ x: rounded(1), y: rounded(1) });

/** A moment on the world's clock, in sim seconds, sent to a hundredth. */
const Time = rounded(2);

/**
 * The player it is after, by id, null while there is none to pick; its route there, when it next
 * plans it, when it may next strike and whether it strikes this step. Only the host reads them.
 */
export const SnailState = z.object({
  quarry: z.string().nullable(),
  route: z.array(Waypoint).max(MAX_WAYPOINTS),
  repathAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
});

type SnailState = z.output<typeof SnailState>;

/** A player drawn at random, by id, or null when there is none. */
function pickQuarry(game: Session): string | null {
  const ids = [...game.players.keys()];
  return ids[Math.floor(Math.random() * ids.length)] ?? null;
}

/** A fresh snail's state at world time `now`, after the player `quarry`. */
export function freshSnail(quarry: string | null, now: number): SnailState {
  return {
    quarry,
    route: [],
    repathAt: now,
    attackAt: now,
    attacking: false,
  };
}

/** A body the snail touches: a player or a world entity, anything but itself and inert things. */
function touching(game: Session, self: WorldEntity): { id: string }[] {
  const bodies = [...game.players.values(), ...game.entities.values()];
  return bodies.filter(
    (body) =>
      body.id !== self.id &&
      Math.hypot(body.x - self.x, body.y - self.y) <=
        self.radius + body.radius + 1 &&
      !hasKindTag(game, body.id, [INERT_TAG]),
  );
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

/** Keeps after its quarry, picking another while it is gone, and replans its route when due. */
function hunt(
  state: SnailState,
  self: WorldEntity,
  game: Session,
  config: SnailConfig,
): SnailState {
  const now = game.worldTime;
  const kept =
    state.quarry !== null && game.players.has(state.quarry)
      ? state
      : { ...state, quarry: pickQuarry(game), repathAt: now };
  const quarry =
    kept.quarry === null ? undefined : game.players.get(kept.quarry);
  if (quarry === undefined) return { ...kept, route: [] };
  if (now < kept.repathAt) return kept;
  return {
    ...kept,
    route: routeTo(game, self, quarry),
    repathAt: now + config.repathInterval,
  };
}

/** Strikes once the cooldown is over, when it touches anything. */
function attack(
  state: SnailState,
  self: WorldEntity,
  game: Session,
  config: SnailConfig,
): SnailState {
  const attacking =
    game.worldTime >= state.attackAt && touching(game, self).length > 0;
  if (!attacking) return { ...state, attacking };
  return {
    ...state,
    attacking,
    attackAt: game.worldTime + config.attackCooldown,
  };
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
      return touching(game, entity).map((body) => ({
        target: body.id,
        amount: config.damage,
      }));
    },
    draw(ctx, entity) {
      drawEmoji(ctx, entity, SNAIL_GLYPH, entity.radius * 2);
      ctx.font = "9px system-ui";
      ctx.textAlign = "center";
      ctx.fillStyle = "#c9b8e8";
      ctx.fillText(SNAIL_TITLE, entity.x, entity.y + entity.radius + 10);
    },
  };
}

/**
 * When, on the world's clock, the next snail may arrive; null until a host first steps the world.
 * Kept in the world so a new host goes on from it.
 */
const snailSpawning = worldData({
  schema: z.object({ nextAt: z.number() }).nullable(),
  initial: null,
});

function countAlive(game: Session): number {
  const id = game.kindIds.get(NAME);
  let count = 0;
  for (const entity of game.entities.values()) if (entity.kind === id) count++;
  return count;
}

/**
 * A free point out of the world's start and far enough from every player that none sees it
 * appear, or null when none of the tries finds one. Light does not keep it away.
 */
function unseenPoint(game: Session, config: SnailConfig): Point | null {
  const { world } = game;
  for (let attempt = 0; attempt < config.spawning.tries; attempt++) {
    const at = { x: Math.random() * world.W, y: Math.random() * world.H };
    if (!isAreaFree(world.map, at.x, at.y, config.radius)) continue;
    if (inRect(world.layout.start, at)) continue;
    const seen = [...game.players.values()].some(
      (player) =>
        Math.hypot(player.x - at.x, player.y - at.y) <
        config.spawning.unseenDistance,
    );
    if (!seen) return at;
  }
  return null;
}

/**
 * Brings a snail into the world once one is due and fewer than the most are alive, out of every
 * player's sight. Runs on the host.
 */
function stepSpawning(game: Session, config: SnailConfig): void {
  const now = game.worldTime;
  const held = snailSpawning.get(game);
  const { spawning } = config;
  if (held === null) {
    snailSpawning.set(game, { nextAt: now + spawning.firstDelay });
    return;
  }
  if (now < held.nextAt) return;
  snailSpawning.set(game, { nextAt: now + spawning.gap });
  if (countAlive(game) >= spawning.maxAlive) return;
  const at = unseenPoint(game, config);
  if (at === null) return;
  spawn(game, NAME, at, freshSnail(pickQuarry(game), now));
}

/**
 * The snail, "The Unhurried": rare, and never more than a few. When it arrives it picks a player
 * and creeps after them at a fraction of their pace, round the walls, for as long as they are in
 * the world. Whatever it touches, player or monster, takes damage enough to kill it, and nothing
 * kills it. It makes no sound, pays light no mind, and a stun holds it like anything else.
 */
export const snail = defineEntity(NAME, (config: SnailConfig) => ({
  ...definition(config),
  world: { spawning: snailSpawning },
  step(game: Session) {
    stepSpawning(game, config);
  },
}));
