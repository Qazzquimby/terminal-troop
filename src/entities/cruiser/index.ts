import { z } from "zod";
import {
  defineEntity,
  effect,
  INERT_TAG,
  inRect,
  livingPlayers,
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
import { stepRevival } from "./revive.js";
import type { ReviveConfig } from "./revive.js";

export { refuel } from "./drive.js";
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

/**
 * A car that starts at the world's rally point, its headlights always on, unfuelled; fuelled, a
 * player can drive it.
 */
export interface CruiserConfig extends DrivingConfig {
  /** Half its size, in pixels: its body is a square this far from its centre each way. */
  readonly radius: number;
  readonly headlights: HeadlightConfig;
  readonly escape: EscapeConfig;
  readonly revive: ReviveConfig;
}

const NAME = "cruiser";

/**
 * Its headlights, front left and front right at the front of its body of `radius`, both shining
 * the way it points, `heading`.
 */
function headlights(
  config: HeadlightConfig,
  radius: number,
  heading: number,
): LightEmission[] {
  const ahead = { x: Math.cos(heading), y: Math.sin(heading) };
  const side = { x: -ahead.y, y: ahead.x };
  return [-1, 1].map((hand) => ({
    from: {
      x: ahead.x * radius + side.x * config.spread * hand,
      y: ahead.y * radius + side.y * config.spread * hand,
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
        // sound: escape,
      },
      player,
    );
}

/** The cruiser nearest `at`, within `reach` of touching its body; null for none. */
export const nearCruiser = (
  game: Session,
  at: Point & { readonly radius: number },
  reach: number,
): WorldEntity | null => cruiserNear(game, NAME, at, reach);

/**
 * A car that starts where new players arrive, its two headlights always shining ahead. It starts without
 * fuel; once fuelled its engine runs, and a player beside it can take the wheel and drive it,
 * burning fuel as it moves, ramming what it drives into and knocking down the walls it crashes
 * into, until it breaks down. Others do not ride along, and walk through it. Once it reaches the
 * world's exit, it takes everyone there out after a delay.
 */
export const cruiser = defineEntity(NAME, (config: CruiserConfig) => ({
  radius: config.radius,
  maxHealth: Infinity,
  collides: false,
  tags: [INERT_TAG],
  data: CruiserState,
  light: (_entity, state) =>
    headlights(config.headlights, config.radius, state.heading),
  vehicle: vehicle(config),
  update: (entity, state, dt, game) =>
    stepCruiser(game, entity, state, dt, config),
  draw(ctx, entity, state, _now, game) {
    drawCruiser(ctx, entity, state, game, {
      fullTank: config.gauge,
      breakdown: config.crash.breakdown,
    });
  },
  spawn: { at: "rally", data: FRESH },
  world: { departure },
  step(game) {
    stepDeparture(game, config.escape);
    stepRevival(game, (at) => nearCruiser(game, at, config.revive.reach));
  },
}));
