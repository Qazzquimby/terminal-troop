import { z } from "zod";
import { drawEmoji, drawFacing } from "../../render/index.js";
import {
  defineEntity,
  drawLying,
  effect,
  eyesOf,
  glyphOf,
  hurtSinceLastStep,
  inView,
  livingBody,
  isAreaFree,
  perceives,
  rounded,
  seemsItem,
  sound,
} from "../../sim/index.js";
import type {
  Body,
  Dormancy,
  EntityDefinition,
  Eyes,
  Point,
  Rng,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import {
  drawRing,
  facingEyes,
  hitterOf,
  nearestSeenBody,
  playEach,
  seenPrey,
} from "../bodies.js";
import {
  between,
  nearest,
  NEVER_PREY,
  preyNear,
  Route,
  Seed,
  strikeEach,
  strikeIf,
  Time,
  walk,
  wanderOn,
  Waypoint,
  withSeed,
} from "../hunt.js";
import type { Hunting } from "../hunt.js";
import { planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const settleUrl = new URL("./sfx/settle.mp3", import.meta.url).href;
const revealUrl = new URL("./sfx/reveal.mp3", import.meta.url).href;
const attackUrl = new URL("./sfx/attack.mp3", import.meta.url).href;

const NAME = "mimic";

/**
 * How a mimic hides among items and springs on what comes near. Distances in pixels, times in
 * sim seconds.
 */
export interface MimicConfig extends Hunting, Dormancy {
  /** How the world's spawner brings them, in groups. */
  readonly spawning: SpawningConfig;
  readonly radius: number;
  /** How hard it is to push, in player masses; sized to its radius when left out. */
  readonly mass?: number;
  readonly maxHealth: number;
  /** Its speed, whatever it does, as a share of a player's walk. */
  readonly speedShare: number;
  /** Furthest a wander leg takes it. */
  readonly wanderRange: number;
  /** How far it sees bodies and items down its facing, or close round it, while it moves. */
  readonly sightRange: number;
  /** How near, all round it along a clear line, a body must come to stir it while it hides. */
  readonly noticeRange: number;
  /** Seconds it hides as an item, drawn between the two each time, unless something stirs it. */
  readonly hideSeconds: { readonly min: number; readonly max: number };
  /** Seconds from a body stirring it to its springing, drawn between the two. */
  readonly springDelay: { readonly min: number; readonly max: number };
  /** Seconds its burst of teeth shows as it throws off its disguise. */
  readonly revealSeconds: number;
  /**
   * Seconds after it leaves a hiding spot before it may copy the item it copied there again. It
   * would rather copy something new whenever it sees something.
   */
  readonly rehideAfter: number;
  /** How near where the item it last copied lay an item must lie to count as that item. */
  readonly sameSpot: number;
  /** How near any item, or body posing as one, it will not hide. */
  readonly spacing: number;
  /** Furthest from the item it copies, centre to centre, that it hides. */
  readonly hideRange: number;
  /** Spots it draws round an item for somewhere to hide before passing the item over for now. */
  readonly hideTries: number;
  /** Seconds between plans of its chase. */
  readonly repathInterval: number;
  /** Seconds hunting without seeing a body before it goes back to looking for somewhere to hide. */
  readonly calmSeconds: number;
  /** Damage dealt to each body within attack range as it bites. */
  readonly attackDamage: number;
  /** How near, centre to centre, a body must be to be bitten; at least touching. */
  readonly attackRange: number;
  /** Seconds between bites. */
  readonly attackCooldown: number;
  /** How far each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    /** The squelch of it taking an item's shape. */
    readonly settle: number;
    /** Its shriek as it throws off its disguise. */
    readonly reveal: number;
    readonly attack: number;
  };
}

/**
 * Everyone reads its mode, `posing`, `posedAs`, `springAt`, `revealedAt` and its facing, to draw
 * it; the rest only the host reads.
 * - wander: walks legs, looking for an item to copy, and turns on any body it sees
 * - seek: heads along `route` for `hideAt`, somewhere near an item it saw, to pose there as
 *   `copying`, the item that one seemed to be
 * - hide: stands still as `posing`, the item it passes for, until `hideUntil`; a body coming near
 *   sets `springAt`, when it throws off its disguise and turns on `foe`
 * - hunt: chases `foe`, else any body it sees, biting what is in reach, until it has seen none
 *   for a while
 * `spot` is where the item it last copied lay, and `leftAt` when it last left hiding.
 */
export const MimicState = z.object({
  mode: z.enum(["wander", "seek", "hide", "hunt"]),
  posing: z.string().max(64).nullable(),
  posedAs: z.string().max(64).nullable(),
  springAt: Time.nullable(),
  revealedAt: Time.nullable(),
  hideUntil: Time,
  copying: z.string().max(64).nullable(),
  hideAt: Waypoint.nullable(),
  spot: Waypoint.nullable(),
  leftAt: Time,
  foe: z.string().max(80).nullable(),
  seenAt: Time,
  repathAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
  route: Route,
  facing: rounded(2),
  seed: Seed,
});

export type MimicState = z.output<typeof MimicState>;

/** A fresh mimic's state at world time `now`, looking for somewhere to hide. */
export function freshMimic(now: number, seed: number): MimicState {
  return {
    mode: "wander",
    posing: null,
    posedAs: null,
    springAt: null,
    revealedAt: null,
    hideUntil: now,
    copying: null,
    hideAt: null,
    spot: null,
    leftAt: now,
    foe: null,
    seenAt: now,
    repathAt: now,
    attackAt: now,
    attacking: false,
    route: [],
    facing: 0,
    seed: seed | 0,
  };
}

/** Its eyes: hiding, it watches all round it out to its notice range; else as a zombie sees. */
function mimicEyes(
  state: MimicState,
  game: Session,
  config: MimicConfig,
): Eyes {
  if (state.mode === "hide") return { cone: null, around: config.noticeRange };
  return facingEyes(state.facing, game, config.sightRange);
}

/** A way for `self` to `to`; straight there when no route is found. */
const routeTo = (game: Session, self: WorldEntity, to: Point): Point[] =>
  planRoute(game.world.map, self.radius, self, to) ?? [to];

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Whether any item, or body posing as one, but `self` lies within `spacing` of `at`. */
function crowded(
  game: Session,
  self: WorldEntity,
  at: Point,
  config: MimicConfig,
): boolean {
  for (const entity of game.entities.values()) {
    if (entity.id === self.id || distance(entity, at) > config.spacing)
      continue;
    if (seemsItem(game, entity) !== null) return true;
  }
  return false;
}

/**
 * The items it would copy now, best first, of those it sees and perceives: anything that seems an
 * item to it, a lying item or another body posing as one. None where the item it last copied lay
 * until it has wandered a while; something new beats that, then the nearest.
 */
function itemsToCopy(
  state: MimicState,
  self: WorldEntity,
  game: Session,
  config: MimicConfig,
): WorldEntity[] {
  const sight = eyesOf(game, self);
  if (sight === null) return [];
  const { spot } = state;
  const atSpot = (item: Point): boolean =>
    spot !== null && distance(item, spot) <= config.sameSpot;
  const settled = game.worldTime >= state.leftAt + config.rehideAfter;
  const items: WorldEntity[] = [];
  for (const entity of game.entities.values()) {
    if (entity.id === self.id || seemsItem(game, entity) === null) continue;
    if (!perceives(game, self.id, entity.id)) continue;
    if (!inView(game, sight, entity, config.sightRange)) continue;
    if (atSpot(entity) && !settled) continue;
    items.push(entity);
  }
  const by = (a: WorldEntity, b: WorldEntity): number =>
    atSpot(a) === atSpot(b)
      ? distance(self, a) - distance(self, b)
      : Number(atSpot(a)) - Number(atSpot(b));
  return items.sort(by);
}

/** Somewhere to hide near an item, and the way there. */
interface HidingSpot {
  readonly at: Point;
  readonly route: Point[];
}

/**
 * Somewhere open `self` fits and can walk to, within hide range of `item` and clear of every item
 * and body posing as one, drawn by `rng`; null when none of its tries finds one.
 */
function hidingSpot(
  self: WorldEntity,
  item: Point,
  game: Session,
  config: MimicConfig,
  rng: Rng,
): HidingSpot | null {
  const { map } = game.world;
  for (let attempt = 0; attempt < config.hideTries; attempt++) {
    const angle = rng() * Math.PI * 2;
    const reach = config.hideRange * Math.sqrt(rng());
    const at = {
      x: item.x + Math.cos(angle) * reach,
      y: item.y + Math.sin(angle) * reach,
    };
    if (!isAreaFree(map, at.x, at.y, self.radius)) continue;
    if (crowded(game, self, at, config)) continue;
    // Keeps to the open ways, as a wanderer does.
    const route = planRoute(
      map,
      self.radius,
      self,
      at,
      undefined,
      undefined,
      false,
    );
    if (route !== null) return { at, route };
  }
  return null;
}

/**
 * Sets off to hide near the best item it sees, as that item seems to be: one that is itself a
 * copy is copied as what it passes for, so a chain of copies is always of a real item. Null when
 * it sees none with somewhere to hide near it.
 */
function setOff(
  state: MimicState,
  self: WorldEntity,
  game: Session,
  config: MimicConfig,
): MimicState | null {
  for (const item of itemsToCopy(state, self, game, config)) {
    const copying = seemsItem(game, item)?.item;
    if (copying === undefined) continue;
    const { result, seed } = withSeed(state.seed, (rng) =>
      hidingSpot(self, item, game, config, rng),
    );
    if (result === null) continue;
    return {
      ...state,
      mode: "seek",
      copying,
      hideAt: { x: result.at.x, y: result.at.y },
      spot: { x: item.x, y: item.y },
      route: result.route,
      seed,
    };
  }
  return null;
}

/** Takes the shape of the item it set off to copy, standing still, for a while drawn from its seed. */
function hide(
  state: MimicState,
  posing: string,
  game: Session,
  config: MimicConfig,
): MimicState {
  const { result, seed } = withSeed(state.seed, (rng) =>
    between(rng, config.hideSeconds),
  );
  return {
    ...state,
    mode: "hide",
    posing,
    posedAs: posing,
    copying: null,
    hideAt: null,
    route: [],
    springAt: null,
    foe: null,
    hideUntil: game.worldTime + result,
    seed,
  };
}

/** Leaves its hiding spot, as itself, to wander or to hunt `foe`. */
function unhide(
  state: MimicState,
  game: Session,
  mode: "wander" | "hunt",
): MimicState {
  const now = game.worldTime;
  return {
    ...state,
    mode,
    posing: null,
    springAt: null,
    leftAt: now,
    seenAt: now,
    repathAt: now,
    revealedAt: mode === "hunt" ? now : state.revealedAt,
  };
}

/** Starts or steers a hunt of `found`, replanning its way now and then. */
function chase(
  state: MimicState,
  self: WorldEntity,
  found: Body,
  game: Session,
  config: MimicConfig,
): MimicState {
  const now = game.worldTime;
  const fresh = state.mode !== "hunt" || found.id !== state.foe;
  const replan = fresh || now >= state.repathAt || state.route.length === 0;
  return {
    ...state,
    mode: "hunt",
    copying: null,
    hideAt: null,
    foe: found.id,
    seenAt: now,
    route: replan ? routeTo(game, self, found) : state.route,
    repathAt: replan ? now + config.repathInterval : state.repathAt,
  };
}

/**
 * Who it goes after: whatever just hurt it; else its foe, while it sees it; else the nearest body
 * it sees. Null for none.
 */
function quarry(
  state: MimicState,
  self: WorldEntity,
  game: Session,
  config: MimicConfig,
): Body | null {
  const hitter = hitterOf(game, self, config);
  if (hitter !== null) return hitter;
  const seen = seenPrey(game, self, config, config.sightRange);
  return seen.find((body) => body.id === state.foe) ?? nearest(self, seen);
}

/**
 * Hiding: stands as its item. Hurt, it springs at once on whatever hurt it; a body coming near
 * draws when it springs; once that comes it springs on its foe. With nothing come near by the
 * time its hiding ends, it slips off to hide elsewhere.
 */
function lurk(
  state: MimicState,
  self: WorldEntity,
  game: Session,
  config: MimicConfig,
): MimicState {
  const now = game.worldTime;
  if (hurtSinceLastStep(game, self.id) !== null) {
    const hitter = hitterOf(game, self, config);
    const sprung = unhide(state, game, "hunt");
    return hitter === null ? sprung : chase(sprung, self, hitter, game, config);
  }
  if (state.springAt === null) {
    const near = nearestSeenBody(game, self, config, config.noticeRange);
    if (near === null)
      return now >= state.hideUntil ? unhide(state, game, "wander") : state;
    const { result, seed } = withSeed(state.seed, (rng) =>
      between(rng, config.springDelay),
    );
    return { ...state, springAt: now + result, foe: near.id, seed };
  }
  if (now < state.springAt) return state;
  const sprung = unhide(state, game, "hunt");
  const foe = livingBody(game, state.foe);
  return foe === null ? sprung : chase(sprung, self, foe, game, config);
}

/** What it does next, by its mode and what it sees. */
function think(
  state: MimicState,
  self: WorldEntity,
  game: Session,
  config: MimicConfig,
): MimicState {
  if (state.mode === "hide") return lurk(state, self, game, config);
  const found = quarry(state, self, game, config);
  if (found !== null) return chase(state, self, found, game, config);
  if (state.mode === "hunt") {
    if (game.worldTime - state.seenAt < config.calmSeconds) return state;
    return { ...state, mode: "wander", foe: null, route: [] };
  }
  // It keeps the item's shape in mind on the way, whatever becomes of the item.
  if (
    state.mode === "seek" &&
    state.copying !== null &&
    state.hideAt !== null
  ) {
    if (distance(self, state.hideAt) <= self.radius)
      return hide(state, state.copying, game, config);
    if (state.route.length > 0) return state;
    // Its way spent short of the spot, pushed or blocked, it looks again.
  }
  const off = setOff(state, self, game, config);
  if (off !== null) return off;
  const wandering = {
    ...state,
    mode: "wander" as const,
    copying: null,
    hideAt: null,
  };
  return wanderOn(wandering, self, game.world.map, config.wanderRange);
}

/** The bodies near enough `self` to be bitten. */
function inReach(self: WorldEntity, game: Session, config: MimicConfig) {
  return preyNear(
    game,
    self,
    (prey) => Math.max(config.attackRange, self.radius + prey.radius + 1),
    [...config.ignores, ...NEVER_PREY],
  );
}

interface MimicSounds {
  readonly settle: Sound;
  readonly reveal: Sound;
  readonly attack: Sound;
}

/** Its own glyph, for a mimic that has passed for nothing yet. */
const OWN_GLYPH = "📦";

/** A gaping maw across `body`'s lower half, `open` from 0 to 1, lined with teeth. */
function drawMaw(
  ctx: CanvasRenderingContext2D,
  body: Point & { readonly radius: number },
  open: number,
): void {
  const width = body.radius * 1.4;
  const height = body.radius * (0.35 + 0.45 * open);
  const top = body.y + body.radius * 0.05;
  ctx.save();
  ctx.fillStyle = "#4a0610";
  ctx.beginPath();
  ctx.ellipse(body.x, top, width / 2, height / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f4efe2";
  const teeth = 5;
  for (let i = 0; i < teeth; i++) {
    const x = body.x - width / 2 + (width / teeth) * (i + 0.5);
    const half = width / teeth / 2;
    // Upper teeth point down, lower ones up.
    for (const [edge, tip] of [
      [top - height / 2, top - height / 2 + height * 0.4],
      [top + height / 2, top + height / 2 - height * 0.4],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(x - half, edge);
      ctx.lineTo(x + half, edge);
      ctx.lineTo(x, tip);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

const COLOURS = {
  wander: "#8d6e4a",
  seek: "#b08a52",
  hide: "#8d6e4a",
  hunt: "#d8473a",
} as const;

function mimicDefinition(
  config: MimicConfig,
  sounds: MimicSounds,
): EntityDefinition<MimicState> {
  return {
    radius: config.radius,
    mass: config.mass,
    maxHealth: config.maxHealth,
    // A bar over an item would give it away.
    healthBar: false,
    dormantBeyond: config.dormantBeyond,
    data: MimicState,
    eyes: (_entity, state, game) => mimicEyes(state, game, config),
    posesAsItem: (_entity, state) =>
      state.mode === "hide" && state.posing !== null
        ? { item: state.posing }
        : null,
    // Reached for, it springs on whoever reached, then and there.
    grabbed: (_entity, state, by, game) =>
      state.mode === "hide"
        ? { ...state, springAt: game.worldTime, foe: by.id }
        : state,
    update(entity, state, dt, game) {
      const now = game.worldTime;
      const thought = think(state, entity, game, config);
      const struck = strikeIf(
        thought,
        now,
        thought.mode === "hunt" && inReach(entity, game, config).length > 0,
        config.attackCooldown,
      );
      playEach(game, entity, [
        struck.mode === "hide" && state.mode !== "hide" && sounds.settle,
        // Turning on a body it saw as itself, it shrieks as it would bursting out of hiding.
        struck.mode === "hunt" &&
          state.mode !== "hunt" &&
          state.mode !== "hide" &&
          sounds.reveal,
        struck.attacking && sounds.attack,
      ]);
      if (struck.revealedAt !== state.revealedAt)
        // It bursts out of its disguise in a flash, shrieking.
        effect(
          game,
          {
            at: { x: entity.x, y: entity.y },
            sound: sounds.reveal,
            flash: { radius: entity.radius * 2.5, hit: true },
          },
          entity,
        );
      if (struck.mode === "hide") {
        entity.vx = 0;
        entity.vy = 0;
        return struck;
      }
      const { speed } = game.config.player;
      return walk(entity, struck, speed * config.speedShare, dt);
    },
    // Bites everything in reach at once, as a zombie does.
    strikes: (entity, state, game): Strike[] =>
      state.attacking
        ? strikeEach(inReach(entity, game, config), config.attackDamage)
        : [],
    draw(ctx, entity, state, now, game) {
      if (state.mode === "hide" && state.posing !== null) {
        // About to spring, it twitches, the one tell it gives.
        const twitch = state.springAt === null ? 0 : Math.sin(now / 30) * 0.8;
        drawLying(
          ctx,
          { x: entity.x + twitch, y: entity.y },
          { item: state.posing },
          now,
          game,
        );
        return;
      }
      const posed =
        state.posedAs === null
          ? undefined
          : game.itemDefinitions.get(state.posedAs);
      const glyph = posed === undefined ? OWN_GLYPH : glyphOf(posed, undefined);
      const since =
        state.revealedAt === null
          ? Infinity
          : game.worldTime - state.revealedAt;
      const burst =
        since < config.revealSeconds ? 1 - since / config.revealSeconds : 0;
      const hunting = state.mode === "hunt";
      const shake = hunting ? Math.sin(now / 40) * (1 + burst * 2) : 0;
      const body = {
        x: entity.x + shake,
        y: entity.y,
        radius: entity.radius * (1 + burst * 0.4),
      };
      drawEmoji(ctx, body, glyph, body.radius * 2);
      drawMaw(
        ctx,
        body,
        hunting ? 0.5 + 0.5 * Math.abs(Math.sin(now / 150)) : 0,
      );
      drawRing(ctx, body, COLOURS[state.mode], 2, 0);
      drawFacing(ctx, body, state.facing, body.radius * 1.5);
    },
  };
}

/**
 * The mimic: wanders until it sees something that seems an item, a lying one or another mimic
 * posing as one, goes somewhere open within its hide range of it and takes its shape, standing
 * still there for a while as a second one of it. Any number may copy the same item, and a copy of
 * a copy is of the real item. A body coming near, player or monster, stirs it, and moments later
 * it throws off its disguise and hunts as a zombie does; so does one reaching to pick it up, or
 * hurting it, at once. Hiding long enough with no one near, it slips off to copy something new,
 * and the item it last copied again only after a while wandering. While it poses
 * as an item it is one to every rule that tells items apart: hunters pass it over, the scanner
 * reads it as one, and a player's pickup reaches for it. The world's spawner brings them in packs.
 */
export const mimic = defineEntity(NAME, (config: MimicConfig) => {
  const sounds: MimicSounds = {
    settle: sound({ url: settleUrl, range: config.sounds.settle }),
    reveal: sound({ url: revealUrl, range: config.sounds.reveal }),
    attack: sound({ url: attackUrl, range: config.sounds.attack }),
  };
  return {
    ...mimicDefinition(config, sounds),
    ...arrivals({
      kind: NAME,
      radius: config.radius,
      config: config.spawning,
      fresh: (seed: number, game: Session) =>
        freshMimic(game.worldTime, Math.floor(seed * 2 ** 31)),
    }),
  };
});
