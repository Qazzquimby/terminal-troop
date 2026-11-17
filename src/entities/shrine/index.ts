import { z } from "zod";
import {
  addVoiceChannel,
  defineEntity,
  effect,
  ghostCorpses,
  ghostEarChannel,
  INERT_TAG,
  itemInstances,
  removeFromWorld,
  revive,
  rounded,
  sound,
  spawnWorldItem,
} from "../../sim/index.js";
import type {
  ItemInstance,
  Point,
  Scatter,
  Session,
  Sound,
  WorldEntity,
} from "../../sim/index.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const whisperUrl = new URL("./sfx/whisper.mp3", import.meta.url).href;
const reviveUrl = new URL("./sfx/revive.mp3", import.meta.url).href;
const transformUrl = new URL("./sfx/transform.mp3", import.meta.url).href;
const crumbleUrl = new URL("./sfx/crumble.mp3", import.meta.url).href;

/**
 * A shrine: lies far from the road, where the living and the ghosts hear each other, and takes
 * what is laid on it. Distances in pixels, times in sim seconds.
 */
export interface ShrineConfig {
  readonly radius: number;
  /** Where a new world puts its shrines. */
  readonly scatter: Scatter;
  /** How near its middle an item must lie to be offered to it. */
  readonly reach: number;
  /** How near it a living speaker must be for the ghosts to hear it. */
  readonly earReach: number;
  /** The item that, offered, brings back a random ghost beside it. */
  readonly revives: string;
  /** What each item offered to it becomes, by item id. */
  readonly transforms: Readonly<Record<string, string>>;
  /** Offerings it takes before any may crumble it. */
  readonly safeOfferings: number;
  /** The chance, 0..1, each offering past those crumbles it. */
  readonly crumbleChance: number;
  /** Seconds between its whispers, drawn between the two. */
  readonly whisperGap: { readonly min: number; readonly max: number };
  /** How far its faint glow reaches. */
  readonly glow: number;
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
  /** How far, in pixels, each of its sounds is heard, and so how far the noise each makes carries. */
  readonly sounds: {
    readonly whisper: number;
    readonly revive: number;
    readonly transform: number;
    readonly crumble: number;
  };
}

const NAME = "shrine";

/** How many offerings it has taken, and when it next whispers. */
const ShrineState = z.object({
  offerings: z.number().int().min(0),
  whisperAt: rounded(2),
});
type ShrineState = z.output<typeof ShrineState>;

/** Its sounds, each heard, and making noise, out to its range. */
interface Sounds {
  readonly whisper: Sound;
  readonly revive: Sound;
  readonly transform: Sound;
  readonly crumble: Sound;
}

const LOOK = {
  stone: "#4a4f5a",
  rim: "#8a93a6",
  glow: "rgba(159, 227, 255, 0.10)",
  flame: "#9fe3ff",
} as const;

/** The shrines in the world. */
function shrines(game: Session): WorldEntity[] {
  const kind = game.kindIds.get(NAME);
  return [...game.entities.values()].filter((entity) => entity.kind === kind);
}

const between = (gap: { min: number; max: number }): number =>
  gap.min + Math.random() * (gap.max - gap.min);

/** The items lying within `reach` of `shrine`'s middle, nearest first. */
function offered(
  game: Session,
  shrine: WorldEntity,
  reach: number,
): (ItemInstance & { readonly place: { readonly lying: WorldEntity } })[] {
  const found = [];
  for (const instance of itemInstances(game)) {
    const { place } = instance;
    if (!("lying" in place)) continue;
    const gap = Math.hypot(place.lying.x - shrine.x, place.lying.y - shrine.y);
    if (gap <= reach) found.push({ ...instance, place, gap });
  }
  return found.sort((a, b) => a.gap - b.gap);
}

/**
 * Takes the first item lying on `shrine` it can take: one that revives, while a ghost's corpse is
 * anywhere to bring back, brings that ghost back beside it; one it transforms becomes its other
 * item where it lay. Returns whether it took one.
 */
function takeOffering(
  game: Session,
  shrine: WorldEntity,
  config: ShrineConfig,
  sounds: Sounds,
): boolean {
  for (const item of offered(game, shrine, config.reach)) {
    const at: Point = { x: item.place.lying.x, y: item.place.lying.y };
    if (item.item === config.revives) {
      const corpses = ghostCorpses(game);
      const corpse = corpses[Math.floor(Math.random() * corpses.length)];
      if (corpse === undefined) continue;
      removeFromWorld(game, item.place.lying);
      const risen = revive(game, corpse.state, shrine, shrine.id);
      effect(
        game,
        {
          at: risen ?? shrine,
          sound: sounds.revive,
          flash: { radius: shrine.radius * 4, hit: false },
        },
        shrine,
      );
      return true;
    }
    const into = config.transforms[item.item];
    if (into === undefined || !game.itemDefinitions.has(into)) continue;
    removeFromWorld(game, item.place.lying);
    spawnWorldItem(game, at, into);
    effect(
      game,
      {
        at,
        sound: sounds.transform,
        flash: { radius: shrine.radius * 2, hit: false },
      },
      shrine,
    );
    return true;
  }
  return false;
}

/** What a shrine does this step, as the host. */
function stepShrine(
  entity: WorldEntity,
  state: ShrineState,
  game: Session,
  config: ShrineConfig,
  sounds: Sounds,
): ShrineState {
  let next = state;
  if (game.worldTime >= state.whisperAt) {
    effect(game, { at: entity, sound: sounds.whisper }, entity);
    next = { ...next, whisperAt: game.worldTime + between(config.whisperGap) };
  }
  if (!takeOffering(game, entity, config, sounds)) return next;
  const offerings = next.offerings + 1;
  if (
    offerings > config.safeOfferings &&
    Math.random() < config.crumbleChance
  ) {
    effect(
      game,
      {
        at: { x: entity.x, y: entity.y },
        sound: sounds.crumble,
        flash: { radius: entity.radius * 3, hit: true },
      },
      entity,
    );
    removeFromWorld(game, entity);
  }
  return { ...next, offerings };
}

/** A squat stone with a pale flame flickering on it, in a faint glow. */
function drawShrine(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  now: number,
): void {
  const { x, y, radius } = entity;
  const flicker = 0.75 + 0.25 * Math.sin(now / 180 + entity.x);
  ctx.save();
  ctx.fillStyle = LOOK.glow;
  ctx.beginPath();
  ctx.arc(x, y, radius * 2.2 * flicker, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = LOOK.stone;
  ctx.strokeStyle = LOOK.rim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.rect(x - radius, y - radius * 0.6, radius * 2, radius * 1.4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = LOOK.flame;
  ctx.globalAlpha = flicker;
  ctx.beginPath();
  ctx.ellipse(
    x,
    y - radius * 0.8,
    radius * 0.25,
    radius * 0.45 * flicker,
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();
}

/**
 * A shrine: a new world lays a few, rarely and far from the road. It is a ghost ear: every
 * ghost's voice is heard from it, fading with distance, and every ghost hears whoever speaks
 * within its reach. An item laid on it is offered: one that revives brings a random ghost back
 * beside it, while any ghost's corpse is about; one it transforms becomes its other item. Past
 * its first offerings, each may crumble it. It whispers now and then, and glows faintly.
 */
export const shrine = defineEntity(NAME, (config: ShrineConfig) => {
  const make = (url: string, range: number): Sound =>
    sound({ url, volume: config.volume, range });
  const sounds: Sounds = {
    whisper: sound({
      url: whisperUrl,
      volume: config.volume,
      range: config.sounds.whisper,
      noise: false,
    }),
    revive: make(reviveUrl, config.sounds.revive),
    transform: make(transformUrl, config.sounds.transform),
    crumble: make(crumbleUrl, config.sounds.crumble),
  };
  return {
    radius: config.radius,
    maxHealth: Infinity,
    collides: false,
    tags: [INERT_TAG],
    data: ShrineState,
    spawn: {
      at: "scatter" as const,
      ...config.scatter,
      data: (rng) => ({
        offerings: 0,
        whisperAt: rng() * config.whisperGap.max,
      }),
    },
    register(game) {
      addVoiceChannel(
        game,
        ghostEarChannel((each) =>
          shrines(each).map((found) => ({
            at: { x: found.x, y: found.y },
            via: "air" as const,
            reach: config.earReach,
          })),
        ),
      );
    },
    light: () => ({ range: config.glow, tint: "rgba(159, 227, 255, 0.18)" }),
    update(entity, state, _dt, game) {
      entity.vx = 0;
      entity.vy = 0;
      return stepShrine(entity, state, game, config, sounds);
    },
    draw(ctx, entity, _state, now) {
      drawShrine(ctx, entity, now);
    },
  };
});
