import { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import {
  defineEntity,
  effect,
  INERT_TAG,
  inRect,
  worldData,
} from "../../sim/index.js";
import type { LightEmission, Player, Point, Session } from "../../sim/index.js";
// The departure's sounds, once their assets land; importing a missing file breaks the build.
// import departUrl from "./sfx/depart.mp3";
// import escapeUrl from "./sfx/escape.mp3";

/** How the cruiser takes the players out once it reaches the exit. */
interface EscapeConfig {
  /** Seconds the cruiser waits in the exit before everyone in it escapes. */
  readonly delay: number;
  /** Volume of the departure's sounds, 0..1. */
  readonly volume: number;
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

/** A car that starts at the world's rally point, its headlights always on. */
export interface CruiserConfig {
  readonly headlights: HeadlightConfig;
  readonly escape: EscapeConfig;
}

const NAME = "cruiser";

/** The cruiser's body; its emoji is drawn to that size. */
const BODY_RADIUS = 10;

/**
 * Which way the cruiser faces, in radians: along the road, towards the exit. It does not turn
 * until it can be driven.
 */
const FACING = 0;

/** Its headlights, front left and front right, both shining the way it faces. */
function headlights(config: HeadlightConfig): LightEmission[] {
  const ahead = { x: Math.cos(FACING), y: Math.sin(FACING) };
  const side = { x: -ahead.y, y: ahead.x };
  return [-1, 1].map((hand) => ({
    from: {
      x: ahead.x * BODY_RADIUS + side.x * config.spread * hand,
      y: ahead.y * BODY_RADIUS + side.y * config.spread * hand,
    },
    range: config.range,
    shape: { kind: "cone", direction: FACING, angle: config.angle },
  }));
}

const CRUISER_GLYPH = "🚗";

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

/** Where the world's cruiser stands, or null when it has none. */
function cruiserAt(game: Session): Point | null {
  const id = game.kindIds.get(NAME);
  for (const entity of game.entities.values())
    if (entity.kind === id) return { x: entity.x, y: entity.y };
  return null;
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
 * The exit's rule, run on the host each step: once the cruiser comes to the exit a countdown
 * starts, and when it runs out every player in the exit escapes, and the countdown starts afresh
 * for whoever is left. Leaving the exit stops it. Nothing else follows an escape yet.
 */
function stepDeparture(game: Session, config: EscapeConfig): void {
  const held = departure.get(game);
  const at = cruiserAt(game);
  const { exit } = game.world.layout;
  if (at === null || !inRect(exit, at)) {
    if (held.since !== null) departure.set(game, { ...held, since: null });
    return;
  }
  if (held.since === null) {
    departure.set(game, { ...held, since: game.worldTime });
    // effect(game, { at, sound: depart }, game.local);
    return;
  }
  if (game.worldTime < held.since + config.delay) return;
  const leaving = [...game.players.values()].filter(
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
        // sound: escape,
      },
      player,
    );
}

/**
 * A car that starts where new players arrive, its two headlights always shining ahead. Once it reaches the
 * world's exit, it takes everyone there out after a delay.
 */
export const cruiser = defineEntity(NAME, (config: CruiserConfig) => ({
  radius: BODY_RADIUS,
  maxHealth: Infinity,
  collides: false,
  tags: [INERT_TAG],
  data: z.object({}),
  light: () => headlights(config.headlights),
  draw(ctx, entity) {
    drawEmoji(ctx, entity, CRUISER_GLYPH, BODY_RADIUS * 2);
  },
  spawn: { at: "rally", data: {} },
  world: { departure },
  step(game) {
    stepDeparture(game, config.escape);
  },
}));
