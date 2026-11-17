import { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import {
  defineEntity,
  hurtSinceLastStep,
  INERT_TAG,
  removeFromWorld,
  sound,
  spawn,
} from "../../sim/index.js";
import type { Player, Point, Session, WorldEntity } from "../../sim/index.js";
import { detonateCross } from "../blast.js";
import type { CrossBlast } from "../blast.js";
import { Time } from "../hunt.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const blastUrl = new URL("./sfx/blast.mp3", import.meta.url).href;

/** A bomb lying where a body put it down. Distances in pixels, times in sim seconds. */
export interface BombConfig {
  readonly radius: number;
  /** Seconds from being put down to going off. */
  readonly fuse: number;
  /** Its plus-shaped burst: how far each arm reaches, the walls it breaks, and its damage. */
  readonly blast: CrossBlast;
  /** How far, in pixels, its bang is heard, and so how far its noise carries. */
  readonly sounds: { readonly blast: number };
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
}

/** When it was put down. Everyone reads it, to draw its fuse burning down. */
const BombState = z.object({ laidAt: Time });

type BombState = z.output<typeof BombState>;

const NAME = "bomb";

/**
 * Puts a fresh bomb down in the middle of the cell `by` stands in, its burst then lining up with
 * the grid as the walls do, which only the host does; the use of a bomb item calls it. Returns
 * where it lies.
 */
export function placeBomb(game: Session, by: Player): Point {
  const { cell } = game.world.map;
  const at = {
    x: (Math.floor(by.x / cell) + 0.5) * cell,
    y: (Math.floor(by.y / cell) + 0.5) * cell,
  };
  const state: BombState = { laidAt: game.worldTime };
  spawn(game, NAME, at, state);
  return at;
}

/** How many times a second its fuse spark flickers, at first and as it is about to go. */
const FLICKER = { first: 2, last: 12 } as const;

/**
 * The bomb, and a spark on its fuse flickering faster as it burns down. `now` is in ms,
 * `worldTime` the world's clock in sim seconds.
 */
function drawBomb(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  state: BombState,
  now: number,
  worldTime: number,
  fuse: number,
): void {
  drawEmoji(ctx, entity, "💣", entity.radius * 2.2);
  const burnt = Math.min(1, Math.max(0, (worldTime - state.laidAt) / fuse));
  const rate = FLICKER.first + (FLICKER.last - FLICKER.first) * burnt;
  if (Math.floor((now / 1000) * rate * 2) % 2 !== 0) return;
  ctx.save();
  ctx.fillStyle = "#ffcf3a";
  ctx.beginPath();
  ctx.arc(
    entity.x + entity.radius * 0.6,
    entity.y - entity.radius * 0.9,
    2.5,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();
}

/**
 * A bomb: some seconds after it is put down it bursts in a plus along the grid, Bomberman's way,
 * each arm reaching some cells and knocking down the first walls in its way, and hurts every body
 * the burst touches, players and world entities alike, with a bang heard far off. A hurt, as
 * another bomb's burst or a mine's, sets it off at once. Hunters pay it no mind.
 */
export const bomb = defineEntity(NAME, (config: BombConfig) => {
  const bang = sound({
    url: blastUrl,
    volume: config.volume,
    range: config.sounds.blast,
  });
  return {
    radius: config.radius,
    maxHealth: Infinity,
    collides: false,
    tags: [INERT_TAG],
    data: BombState,
    update(entity, state, _dt, game) {
      entity.vx = 0;
      entity.vy = 0;
      const struck = hurtSinceLastStep(game, entity.id) !== null;
      if (!struck && game.worldTime < state.laidAt + config.fuse) return state;
      detonateCross(game, entity, config.blast, bang);
      removeFromWorld(game, entity);
      return state;
    },
    draw(ctx, entity, state, now, game) {
      drawBomb(ctx, entity, state, now, game.worldTime, config.fuse);
    },
  };
});
