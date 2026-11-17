import { z } from "zod";
import { drawEmoji, drawFacing } from "../../render/index.js";
import {
  bodiesIn,
  changeEntity,
  defineEntity,
  effect,
  hasKindTag,
  hurtSinceLastStep,
  INERT_TAG,
  ITEM_TAG,
  livingBody,
  hurt,
  rounded,
  sound,
  spawn,
} from "../../sim/index.js";
import type {
  Body,
  Dormancy,
  EntityDefinition,
  Point,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import {
  drawRing,
  facingEyes,
  isKillable,
  playEach,
  seenPrey,
  touching,
  touchStrikes,
} from "../bodies.js";
import {
  avenged,
  nearest,
  Route,
  strikeIf,
  Time,
  walk,
  wanderLeg,
  Waypoint,
} from "../hunt.js";
import type { Hunting } from "../hunt.js";
import { planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const placeUrl = new URL("./sfx/place.mp3", import.meta.url).href;
const popUrl = new URL("./sfx/pop.mp3", import.meta.url).href;
const enrageUrl = new URL("./sfx/enrage.mp3", import.meta.url).href;
const attackUrl = new URL("./sfx/attack.mp3", import.meta.url).href;

const NAME = "birthdayBoy";

const BALLOON = "balloon";

/**
 * The colours birthday boys wear, and their balloons with them; no two about at once share one, so
 * there are never more about than this holds.
 */
export const PALETTE = [
  "#e8413c",
  "#f08c22",
  "#f2d43a",
  "#5cc24a",
  "#3ab0e8",
  "#4a5ce8",
  "#a84ae8",
  "#f06ec4",
] as const;

/**
 * The birthday boy: wanders, leaving balloons behind, and storms back to any that pops. Distances
 * in pixels, times in sim seconds.
 */
export interface BirthdayBoyConfig extends Hunting, Dormancy {
  /** How the world's spawner brings them; its `most` should be no more than the palette holds. */
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  /** Its wandering speed, as a share of a player's walk. */
  readonly wanderShare: number;
  /** Its speed on patrol and enraged, as a share of a player's sprint. */
  readonly chaseShare: number;
  /** Furthest a wander leg takes it. */
  readonly wanderRange: number;
  /** Seconds between the balloons it leaves as it wanders. */
  readonly balloonGap: number;
  /** Most of its own balloons about at once; it leaves no more until one pops. */
  readonly maxBalloons: number;
  /** It leaves no balloon within this of another of its own. */
  readonly balloonSpacing: number;
  /** How far it sees, down its facing or close round it. */
  readonly sightRange: number;
  /** On patrol, how near a popped balloon a body it sees must be to enrage it. */
  readonly guardRadius: number;
  /** Seconds it stands looking round a popped balloon's spot before it wanders off again. */
  readonly lingerSeconds: number;
  /** Seconds enraged without seeing a body before it calms and wanders again. */
  readonly calmSeconds: number;
  /** Seconds between plans of its way to where it last saw its quarry. */
  readonly repathInterval: number;
  /** Damage dealt each touch while enraged. */
  readonly damage: number;
  /** Seconds between two touches' damage. */
  readonly attackCooldown: number;
  /** How far each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly place: number;
    readonly enrage: number;
    readonly attack: number;
  };
}

/** A balloon a birthday boy leaves. */
export interface BalloonConfig {
  readonly radius: number;
  /** How far its pop is heard, and so how far the noise it makes carries. */
  readonly sounds: { readonly pop: number };
}

/**
 * Everyone reads its colour, mode and facing, to draw it; the rest only the host reads.
 * - wander: walks slowly about, leaving balloons
 * - patrol: hurries to `spot`, where one of its balloons popped, and looks round it till
 *   `lingerUntil`
 * - enraged: chases where it last saw its quarry, `lastSeen`, at `seenAt`
 */
export const BirthdayBoyState = z.object({
  colour: z
    .number()
    .int()
    .min(0)
    .max(PALETTE.length - 1),
  mode: z.enum(["wander", "patrol", "enraged"]),
  route: Route,
  facing: rounded(2),
  spot: Waypoint.nullable(),
  lingerUntil: Time.nullable(),
  lastSeen: Waypoint.nullable(),
  seenAt: Time,
  repathAt: Time,
  balloonAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
});

export type BirthdayBoyState = z.output<typeof BirthdayBoyState>;

/** Whose a balloon is, by id, and its colour, which outlives its owner. */
export const BalloonState = z.object({
  owner: z.string().max(64),
  colour: z
    .number()
    .int()
    .min(0)
    .max(PALETTE.length - 1),
});

export type BalloonState = z.output<typeof BalloonState>;

/** The world entities of the kind `kind`. */
function allOf(game: Session, kind: string): WorldEntity[] {
  const id = game.kindIds.get(kind);
  return [...game.entities.values()].filter((entity) => entity.kind === id);
}

/** The first colour of the palette no birthday boy about wears; the first of all when all are. */
export function freeColour(game: Session): number {
  const worn = new Set<number>();
  for (const boy of allOf(game, NAME)) {
    const parsed = BirthdayBoyState.safeParse(boy.data);
    if (parsed.success) worn.add(parsed.data.colour);
  }
  const free = PALETTE.findIndex((_, index) => !worn.has(index));
  return free === -1 ? 0 : free;
}

/** A fresh birthday boy's state at world time `now`, wearing `colour`, about to wander. */
export function freshBirthdayBoy(
  now: number,
  colour: number,
  config: BirthdayBoyConfig,
): BirthdayBoyState {
  return {
    colour,
    mode: "wander",
    route: [],
    facing: 0,
    spot: null,
    lingerUntil: null,
    lastSeen: null,
    seenAt: now,
    repathAt: now,
    balloonAt: now + config.balloonGap,
    attackAt: now,
    attacking: false,
  };
}

/** The balloons `owner` left that are still about. */
export function balloonsOf(game: Session, owner: string): WorldEntity[] {
  return allOf(game, BALLOON).filter(
    (balloon) => BalloonState.safeParse(balloon.data).data?.owner === owner,
  );
}

/** `state` as a pop of one of its balloons at `at` leaves it: on patrol there, unless enraged. */
function heedPop(state: BirthdayBoyState, at: Point): BirthdayBoyState {
  if (state.mode === "enraged") return state;
  return {
    ...state,
    mode: "patrol",
    spot: { x: at.x, y: at.y },
    route: [],
    lingerUntil: null,
  };
}

/** Its speed in `mode`, in pixels a second. */
function speedOf(
  game: Session,
  mode: BirthdayBoyState["mode"],
  config: BirthdayBoyConfig,
): number {
  const { speed, sprintMultiplier } = game.config.player;
  return mode === "wander"
    ? speed * config.wanderShare
    : speed * sprintMultiplier * config.chaseShare;
}

/**
 * The body it goes after, if any: whatever hurt it; else, enraged, any killable body it sees, or on
 * patrol one it sees within its guard radius of the popped balloon, the nearest that spot.
 * Wandering, it pays what it sees no mind.
 */
function quarry(
  state: BirthdayBoyState,
  self: WorldEntity,
  game: Session,
  config: BirthdayBoyConfig,
): Body | null {
  const hurt = hurtSinceLastStep(game, self.id);
  const foe = livingBody(game, avenged(game, self, hurt?.by ?? null, config));
  if (foe !== null) return foe;
  if (state.mode === "wander") return null;
  const seen = seenPrey(game, self, config, config.sightRange).filter((body) =>
    isKillable(game, body),
  );
  const { spot } = state;
  const near =
    state.mode === "patrol" && spot !== null
      ? seen.filter(
          (body) =>
            Math.hypot(body.x - spot.x, body.y - spot.y) <= config.guardRadius,
        )
      : seen;
  return nearest(spot ?? self, near);
}

/** A way for `self` to `to`; straight there when no route is found. */
const routeTo = (game: Session, self: WorldEntity, to: Point): Point[] =>
  planRoute(game.world.map, self.radius, self, to) ?? [to];

/** Back to wandering, the popped balloon forgotten. */
const calm = (state: BirthdayBoyState): BirthdayBoyState => ({
  ...state,
  mode: "wander",
  route: [],
  spot: null,
  lingerUntil: null,
  lastSeen: null,
});

/** What it does next, by its mode and what it sees. */
function think(
  state: BirthdayBoyState,
  self: WorldEntity,
  game: Session,
  config: BirthdayBoyConfig,
): BirthdayBoyState {
  const now = game.worldTime;
  const found = quarry(state, self, game, config);
  if (found !== null) {
    const fresh = state.mode !== "enraged";
    const replan = fresh || now >= state.repathAt || state.route.length === 0;
    return {
      ...state,
      mode: "enraged",
      lastSeen: { x: found.x, y: found.y },
      seenAt: now,
      route: replan ? routeTo(game, self, found) : state.route,
      repathAt: replan ? now + config.repathInterval : state.repathAt,
    };
  }
  if (state.mode === "enraged")
    return now - state.seenAt >= config.calmSeconds ? calm(state) : state;
  if (state.mode === "patrol") {
    const { spot } = state;
    if (spot === null) return calm(state);
    if (state.route.length > 0) return state;
    const there = Math.hypot(spot.x - self.x, spot.y - self.y);
    if (there > game.world.map.cell / 2 && state.lingerUntil === null)
      return { ...state, route: routeTo(game, self, spot) };
    if (state.lingerUntil === null)
      return { ...state, lingerUntil: now + config.lingerSeconds };
    return now >= state.lingerUntil ? calm(state) : state;
  }
  if (state.route.length > 0) return state;
  const leg = wanderLeg(
    game.world.map,
    self,
    Math.random,
    self.radius,
    config.wanderRange,
  );
  return { ...state, route: leg ?? [] };
}

/**
 * As it wanders, once its time comes, it leaves a balloon of its colour where it stands, with a
 * sound: none while it has its most about, or where one of its own already stands near.
 */
function leaveBalloon(
  state: BirthdayBoyState,
  self: WorldEntity,
  game: Session,
  config: BirthdayBoyConfig,
  placed: Sound,
): BirthdayBoyState {
  const now = game.worldTime;
  if (state.mode !== "wander" || now < state.balloonAt) return state;
  const own = balloonsOf(game, self.id);
  const crowded = own.some(
    (balloon) =>
      Math.hypot(balloon.x - self.x, balloon.y - self.y) <
      config.balloonSpacing,
  );
  if (own.length < config.maxBalloons && !crowded) {
    const balloon: BalloonState = { owner: self.id, colour: state.colour };
    spawn(game, BALLOON, { x: self.x, y: self.y }, balloon);
    playEach(game, self, [placed]);
  }
  return { ...state, balloonAt: now + config.balloonGap };
}

interface BoySounds {
  readonly place: Sound;
  readonly enrage: Sound;
  readonly attack: Sound;
}

/** How fast it turns its head, standing on patrol, in radians a second. */
const LOOK_ROUND = 2;

function boyDefinition(
  config: BirthdayBoyConfig,
  sounds: BoySounds,
): EntityDefinition<BirthdayBoyState> {
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    dormantBeyond: config.dormantBeyond,
    data: BirthdayBoyState,
    eyes: (_entity, state, game) =>
      facingEyes(state.facing, game, config.sightRange),
    update(entity, state, dt, game) {
      const now = game.worldTime;
      const thought = leaveBalloon(
        think(state, entity, game, config),
        entity,
        game,
        config,
        sounds.place,
      );
      const struck = strikeIf(
        thought,
        now,
        thought.mode === "enraged" &&
          touching(game, entity, config.ignores).length > 0,
        config.attackCooldown,
      );
      playEach(game, entity, [
        struck.mode === "enraged" && state.mode !== "enraged" && sounds.enrage,
        struck.attacking && sounds.attack,
      ]);
      const walked = walk(
        entity,
        struck,
        speedOf(game, struck.mode, config),
        dt,
      );
      // Standing at a popped balloon, it looks all round for whoever popped it.
      const looking = walked.mode === "patrol" && walked.lingerUntil !== null;
      return looking
        ? {
            ...walked,
            facing: (walked.facing + LOOK_ROUND * dt) % (Math.PI * 2),
          }
        : walked;
    },
    strikes(entity, state, game): Strike[] {
      return touchStrikes(
        game,
        entity,
        state.attacking,
        config.ignores,
        config.damage,
      );
    },
    // Its balloons all pop as it falls.
    dies(entity, _state, game) {
      for (const balloon of balloonsOf(game, entity.id))
        hurt(game, balloon, balloon.health, entity.id);
    },
    draw(ctx, entity, state, now) {
      const colour = PALETTE[state.colour] ?? PALETTE[0];
      const enraged = state.mode === "enraged";
      // Enraged, it shakes with fury.
      const shake = enraged ? Math.sin(now / 25) * 1.5 : 0;
      const body = { x: entity.x + shake, y: entity.y, radius: entity.radius };
      ctx.save();
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.arc(body.x, body.y, body.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      drawEmoji(ctx, body, enraged ? "😡" : "🥳", body.radius * 2);
      drawRing(ctx, body, colour, 3, 0);
      if (enraged) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 120);
        drawRing(ctx, body, `rgba(255, 40, 30, ${pulse.toFixed(2)})`, 2, 4);
      }
      drawFacing(ctx, body, state.facing, body.radius * 1.5);
    },
  };
}

/** Kind tags whose touch never pops a balloon: birthday boys, other balloons, items lying about. */
const SPARES = [NAME, BALLOON, ITEM_TAG] as const;

/**
 * The bang and puff as `balloon` pops, heard far round, sending its owner, if still about, on
 * patrol to where it stood.
 */
function burst(
  game: Session,
  balloon: WorldEntity,
  state: BalloonState,
  pop: Sound,
): void {
  const at = { x: balloon.x, y: balloon.y };
  effect(
    game,
    { at, sound: pop, flash: { radius: balloon.radius * 2, hit: false } },
    balloon,
  );
  const owner = game.entities.get(state.owner);
  if (owner === undefined) return;
  changeEntity(game, owner, (data) => {
    const parsed = BirthdayBoyState.safeParse(data);
    return parsed.success ? heedPop(parsed.data, at) : data;
  });
}

/**
 * The first body touching `balloon` that pops it, null for none: any but those `SPARES` names,
 * and but an inert thing standing still, as a door or a mine, which it may be left against.
 */
function popper(game: Session, balloon: WorldEntity): Body | null {
  return (
    bodiesIn(
      game,
      { center: balloon, radius: balloon.radius },
      balloon.id,
    ).find(
      (body) =>
        !hasKindTag(game, body.id, SPARES) &&
        !(
          hasKindTag(game, body.id, [INERT_TAG]) &&
          body.vx === 0 &&
          body.vy === 0
        ),
    ) ?? null
  );
}

/** How far the string holds a balloon over the spot it was left, in pixels. */
const STRING = 18;

function drawBalloon(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  state: BalloonState,
  now: number,
): void {
  const colour = PALETTE[state.colour] ?? PALETTE[0];
  const { x, y, radius } = entity;
  // It sways on its string, each balloon to its own time.
  const phase = (x + y) / 37;
  const sway = Math.sin(now / 700 + phase) * 3;
  const top = { x: x + sway, y: y - STRING + Math.sin(now / 500 + phase) };
  ctx.save();
  ctx.strokeStyle = "#d8d8d8";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x - sway, y - STRING / 2, top.x, top.y + radius);
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.ellipse(top.x, top.y, radius * 0.85, radius, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
  ctx.beginPath();
  ctx.ellipse(
    top.x - radius * 0.3,
    top.y - radius * 0.35,
    radius * 0.2,
    radius * 0.3,
    -0.5,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();
}

/**
 * A birthday boy: wanders slowly, leaving a balloon of its own colour behind every so often; no
 * two about wear the same colour. When one of its balloons pops it hurries there and looks round,
 * and the first killable body it sees near the spot, player or monster, the nearest it, sends it
 * into a rage: it chases that body down, wherever it last saw one, striking whatever it touches,
 * until it has seen none for a while. Whatever hurts it enrages it too. Its balloons all pop as it
 * falls.
 */
export const birthdayBoy = defineEntity(NAME, (config: BirthdayBoyConfig) => {
  const sounds: BoySounds = {
    place: sound({ url: placeUrl, range: config.sounds.place }),
    enrage: sound({ url: enrageUrl, range: config.sounds.enrage }),
    attack: sound({ url: attackUrl, range: config.sounds.attack }),
  };
  return {
    ...boyDefinition(config, sounds),
    ...arrivals({
      kind: NAME,
      radius: config.radius,
      config: config.spawning,
      fresh: (_seed: number, game: Session) =>
        freshBirthdayBoy(game.worldTime, freeColour(game), config),
    }),
  };
});

/**
 * A birthday boy's balloon, on a string, in its colour: any body but a birthday boy, another
 * balloon or an item lying about that touches it pops it, as does any hurt, with a bang heard far
 * round that sends its owner to the spot. Hunters pay it no mind.
 */
export const balloon = defineEntity(BALLOON, (config: BalloonConfig) => {
  const pop = sound({ url: popUrl, range: config.sounds.pop });
  return {
    radius: config.radius,
    maxHealth: 1,
    collides: false,
    healthBar: false,
    tags: [INERT_TAG],
    data: BalloonState,
    update(entity, state, _dt, game) {
      entity.vx = 0;
      entity.vy = 0;
      // A touch is a hurt, down to whatever touched it, that bursts it as any hurt does.
      const by = popper(game, entity);
      if (by !== null) hurt(game, entity, entity.health, by.id);
      return state;
    },
    dies(entity, state, game) {
      burst(game, entity, state, pop);
    },
    draw(ctx, entity, state, now) {
      drawBalloon(ctx, entity, state, now);
    },
  };
});
