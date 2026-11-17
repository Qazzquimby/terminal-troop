import { z } from "zod";
import { drawEmoji, drawFacing } from "../../render/index.js";
import {
  defineEntity,
  eyesOf,
  hurtSinceLastStep,
  livingBody,
  rounded,
  sound,
} from "../../sim/index.js";
import type {
  Body,
  Dormancy,
  EntityDefinition,
  Point,
  Session,
  Sound,
  WorldEntity,
} from "../../sim/index.js";
import {
  drawRing,
  facingEyes,
  isKillable,
  playEach,
  seenPrey,
  strikesOnTouch,
  touching,
} from "../bodies.js";
import {
  avenged,
  nearest,
  periodicCall,
  Route,
  Seed,
  strikeIf,
  Time,
  walk,
  wanderOn,
} from "../hunt.js";
import type { Hunting } from "../hunt.js";
import { planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const quackUrl = new URL("./sfx/quack.mp3", import.meta.url).href;
const angryUrl = new URL("./sfx/angry-quack.mp3", import.meta.url).href;
const attackUrl = new URL("./sfx/peck.mp3", import.meta.url).href;

const NAME = "apexPredator";

/**
 * The apex predator, a duck: stands in front of whatever body it notices, harmless, until hurt.
 * Distances in pixels, times in sim seconds.
 */
export interface ApexPredatorConfig extends Hunting, Dormancy {
  readonly spawning: SpawningConfig;
  readonly radius: number;
  /** How hard it is to push, in player masses: light, so a blow sends it far. */
  readonly mass: number;
  readonly maxHealth: number;
  /** Its speed, calm or angry, as a share of a player's walk. */
  readonly speedShare: number;
  /** Its speed wandering with no one about, as a share of a player's walk. */
  readonly wanderShare: number;
  /** Furthest a wander leg takes it. */
  readonly wanderRange: number;
  /** How far it sees, down its facing or close round it. */
  readonly sightRange: number;
  /** How far past the edge of the body it stands before it leaves between them. */
  readonly standGap: number;
  /** Seconds between plans of its way. */
  readonly repathInterval: number;
  /** Seconds angry without seeing a body before it calms. */
  readonly calmSeconds: number;
  /** Damage dealt each touch while angry. */
  readonly damage: number;
  /** Seconds between two touches' damage. */
  readonly attackCooldown: number;
  /** Seconds between calm quacks, drawn between the two after each. */
  readonly quackGap: { readonly min: number; readonly max: number };
  /** Seconds between angry quacks, drawn between the two after each. */
  readonly angryGap: { readonly min: number; readonly max: number };
  /** How far each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly quack: number;
    readonly angry: number;
    readonly attack: number;
  };
}

/**
 * Everyone reads its mode and facing, to draw it; the rest only the host reads.
 * - calm: goes to stand just in front of the nearest body it notices, facing it
 * - angry: chases `foe`, whoever last hurt it, or failing that any killable body it sees
 */
export const ApexPredatorState = z.object({
  mode: z.enum(["calm", "angry"]),
  route: Route,
  facing: rounded(2),
  foe: z.string().max(64).nullable(),
  seenAt: Time,
  repathAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
  quackAt: Time.nullable(),
  seed: Seed,
});

export type ApexPredatorState = z.output<typeof ApexPredatorState>;

/** A fresh duck's state at world time `now`, calm. */
export function freshApexPredator(
  now: number,
  seed: number,
): ApexPredatorState {
  return {
    mode: "calm",
    route: [],
    facing: 0,
    foe: null,
    seenAt: now,
    repathAt: now,
    attackAt: now,
    attacking: false,
    quackAt: null,
    seed,
  };
}

/**
 * Which way `body` faces: down its eyes' cone, else the way it moves, else towards `from`, so a
 * duck with no better idea stands between it and where the duck came from.
 */
function facingOf(game: Session, body: Body, from: Point): number {
  const cone = eyesOf(game, body)?.cone ?? null;
  if (cone !== null) return cone.direction;
  if (body.vx !== 0 || body.vy !== 0) return Math.atan2(body.vy, body.vx);
  return Math.atan2(from.y - body.y, from.x - body.x);
}

/**
 * Where `self` heads next to stand in `body`'s way: the spot just in front of it, as it faces; or,
 * from behind or beside it, first to its flank on `self`'s side, so it goes round rather than
 * into it. The second is whether that is the spot in front itself.
 */
function towardsFront(
  game: Session,
  self: WorldEntity,
  body: Body,
  config: ApexPredatorConfig,
): [Point, boolean] {
  const facing = facingOf(game, body, self);
  const ahead = { x: Math.cos(facing), y: Math.sin(facing) };
  const reach = body.radius + self.radius + config.standGap;
  const dx = self.x - body.x;
  const dy = self.y - body.y;
  if (dx * ahead.x + dy * ahead.y >= reach / 2)
    return [{ x: body.x + ahead.x * reach, y: body.y + ahead.y * reach }, true];
  // Its flank on the duck's side, a little ahead, clear of it.
  const side = dx * -ahead.y + dy * ahead.x >= 0 ? 1 : -1;
  const out = reach * 1.2;
  return [
    {
      x: body.x - ahead.y * side * out + ahead.x * reach * 0.6,
      y: body.y + ahead.x * side * out + ahead.y * reach * 0.6,
    },
    false,
  ];
}

/** A way for `self` to `to`; straight there when no route is found. */
const routeTo = (game: Session, self: WorldEntity, to: Point): Point[] =>
  planRoute(game.world.map, self.radius, self, to) ?? [to];

/**
 * Who it goes after, angry: whatever just hurt it; else the foe it has, while it sees it; else the
 * nearest killable body it sees. Null for none.
 */
function quarry(
  state: ApexPredatorState,
  self: WorldEntity,
  game: Session,
  config: ApexPredatorConfig,
): Body | null {
  const hurt = hurtSinceLastStep(game, self.id);
  const hitter = livingBody(
    game,
    avenged(game, self, hurt?.by ?? null, config),
  );
  if (hitter !== null) return hitter;
  if (state.mode !== "angry") return null;
  const seen = seenPrey(game, self, config, config.sightRange).filter((body) =>
    isKillable(game, body),
  );
  return seen.find((body) => body.id === state.foe) ?? nearest(self, seen);
}

/** What it does next, by its mode and what it sees. */
function think(
  state: ApexPredatorState,
  self: WorldEntity,
  game: Session,
  config: ApexPredatorConfig,
): ApexPredatorState {
  const now = game.worldTime;
  const found = quarry(state, self, game, config);
  if (found !== null) {
    const fresh = state.mode !== "angry" || found.id !== state.foe;
    const replan = fresh || now >= state.repathAt || state.route.length === 0;
    return {
      ...state,
      mode: "angry",
      foe: found.id,
      seenAt: now,
      route: replan ? routeTo(game, self, found) : state.route,
      repathAt: replan ? now + config.repathInterval : state.repathAt,
    };
  }
  if (state.mode === "angry") {
    if (now - state.seenAt < config.calmSeconds) return state;
    return { ...state, mode: "calm", foe: null, route: [] };
  }
  // Calm: the nearest body it notices, any body at all, is the one it gets in front of.
  const you = nearest(self, seenPrey(game, self, config, config.sightRange));
  if (you !== null) {
    if (now < state.repathAt && state.route.length > 0) return state;
    const [spot, front] = towardsFront(game, self, you, config);
    const there =
      front && Math.hypot(spot.x - self.x, spot.y - self.y) <= self.radius / 2;
    return {
      ...state,
      foe: null,
      route: there ? [] : routeTo(game, self, spot),
      repathAt: now + config.repathInterval,
      // Standing in your way, it looks you in the eye.
      facing: there ? Math.atan2(you.y - self.y, you.x - self.x) : state.facing,
    };
  }
  return wanderOn(state, self, game.world.map, config.wanderRange);
}

/** Its speed: brisker than a walk with someone to stand before or chase, an amble without. */
function speedOf(
  game: Session,
  state: ApexPredatorState,
  self: WorldEntity,
  config: ApexPredatorConfig,
): number {
  const { speed } = game.config.player;
  const busy =
    state.mode === "angry" ||
    seenPrey(game, self, config, config.sightRange).length > 0;
  return speed * (busy ? config.speedShare : config.wanderShare);
}

interface DuckSounds {
  readonly quack: Sound;
  readonly angry: Sound;
  readonly attack: Sound;
}

function duckDefinition(
  config: ApexPredatorConfig,
  sounds: DuckSounds,
): EntityDefinition<ApexPredatorState> {
  return {
    radius: config.radius,
    mass: config.mass,
    maxHealth: config.maxHealth,
    dormantBeyond: config.dormantBeyond,
    data: ApexPredatorState,
    eyes: (_entity, state, game) =>
      facingEyes(state.facing, game, config.sightRange),
    update(entity, state, dt, game) {
      const now = game.worldTime;
      const thought = think(state, entity, game, config);
      const struck = strikeIf(
        thought,
        now,
        thought.mode === "angry" &&
          touching(game, entity, config.ignores).length > 0,
        config.attackCooldown,
      );
      const angry = struck.mode === "angry";
      const call = periodicCall(
        struck.quackAt,
        now,
        struck.seed,
        angry ? config.angryGap : config.quackGap,
      );
      const roused = angry && state.mode !== "angry";
      playEach(game, entity, [
        (roused || (angry && call.calls)) && sounds.angry,
        !angry && call.calls && sounds.quack,
        struck.attacking && sounds.attack,
      ]);
      const quacked = {
        ...struck,
        // Roused, it next quacks angrily a gap on, not at the calm quack's time.
        quackAt: roused ? now + config.angryGap.min : call.at,
        seed: call.seed,
      };
      const standing = quacked.route.length === 0;
      const walked = walk(
        entity,
        quacked,
        speedOf(game, quacked, entity, config),
        dt,
      );
      return standing ? { ...walked, facing: quacked.facing } : walked;
    },
    strikes: strikesOnTouch(config),
    draw(ctx, entity, state, now) {
      const angry = state.mode === "angry";
      // Angry, it shakes with fury and glows red.
      const shake = angry ? Math.sin(now / 25) * 1.5 : 0;
      const body = { x: entity.x + shake, y: entity.y, radius: entity.radius };
      if (angry) {
        ctx.save();
        ctx.fillStyle = "rgba(230, 30, 20, 0.45)";
        ctx.beginPath();
        ctx.arc(body.x, body.y, body.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        const pulse = 0.5 + 0.5 * Math.sin(now / 120);
        drawRing(ctx, body, `rgba(255, 40, 30, ${pulse.toFixed(2)})`, 2, 3);
      }
      drawEmoji(ctx, body, "🦆", body.radius * 2.2);
      if (angry)
        drawEmoji(
          ctx,
          { x: body.x + body.radius * 0.8, y: body.y - body.radius },
          "💢",
          body.radius,
        );
      drawFacing(ctx, body, state.facing, body.radius * 1.5);
    },
  };
}

/**
 * The apex predator: a duck that goes to stand just in front of the nearest body it notices,
 * player or monster, facing it, quacking now and then, and does nothing more. Hurt it and it turns
 * on whatever hurt it, then on any killable body it sees, chasing and pecking at a little over a
 * walk, so a sprint outruns it, until it has seen none for a while.
 */
export const apexPredator = defineEntity(NAME, (config: ApexPredatorConfig) => {
  const sounds: DuckSounds = {
    quack: sound({ url: quackUrl, range: config.sounds.quack }),
    angry: sound({ url: angryUrl, range: config.sounds.angry }),
    attack: sound({ url: attackUrl, range: config.sounds.attack }),
  };
  return {
    ...duckDefinition(config, sounds),
    ...arrivals({
      kind: NAME,
      radius: config.radius,
      config: config.spawning,
      fresh: (seed: number, game: Session) =>
        freshApexPredator(game.worldTime, Math.floor(seed * 2 ** 31)),
    }),
  };
});
