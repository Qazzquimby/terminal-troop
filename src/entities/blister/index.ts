import { z } from "zod";
import {
  defineEntity,
  destroyWalls,
  effect,
  bodyById,
  hurt,
  hurtSinceLastStep,
  isAreaFree,
  isStunned,
  livingBody,
  livingPlayers,
  rounded,
  sound,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Point,
  Session,
  Sound,
  TileMap,
  WorldEntity,
} from "../../sim/index.js";
import {
  between,
  clearestNoise,
  walk,
  nearest,
  preyNear,
  Route,
  Seed,
  Time,
  Waypoint,
  wanderLeg,
  withSeed,
} from "../hunt.js";
import { planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const fuseUrl = new URL("./sfx/fuse.mp3", import.meta.url).href;
const blastUrl = new URL("./sfx/blast.mp3", import.meta.url).href;

/**
 * How a blister roams, hunts and bursts, and how often they come. Distances are in pixels, speeds
 * in pixels per second, times in seconds.
 */
export interface BlisterConfig {
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  readonly wanderSpeed: number;
  readonly chaseSpeed: number;
  /** How far it feels players, walls or no walls. */
  readonly senseRange: number;
  /** Furthest a wander leg heads from where it starts, as the crow flies. */
  readonly wanderRange: number;
  /** Seconds it stands after a wander leg or a lost chase, drawn between the two. */
  readonly wanderPause: { readonly min: number; readonly max: number };
  /** How far its prey or a noise must be from where it heads before it plans anew. */
  readonly repathDistance: number;
  /**
   * The longest route to its prey it takes: `factor` times the straight line, plus `slack`.
   * Past that it heads straight at its prey and sets itself off at the wall in the way.
   */
  readonly detour: { readonly factor: number; readonly slack: number };
  /** How near a player, walls or no walls, lights its fuse. */
  readonly fuseRange: number;
  /** Seconds from lighting its fuse to bursting. */
  readonly fuse: number;
  /** How far its burst reaches, and the damage it deals where it stands and at the edge. */
  readonly blast: {
    readonly radius: number;
    readonly centre: number;
    readonly edge: number;
  };
  /** How far, in pixels, each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: { readonly fuse: number; readonly blast: number };
}

/**
 * A blister's state. Each field says who reads it: everyone, to draw it, or only the host, which
 * sends it so that whoever hosts next goes on from it. Its sounds reach every client as effects.
 * - wander: walks `route`, towards `goal`, the last noise it heard, if any; then stands until
 *   `standUntil` and picks a new leg
 * - chase: walks `route` to `goal`, where its prey is, or with `straight` heads right at it
 */
export const BlisterState = z.object({
  /** Host. */
  mode: z.enum(["wander", "chase"]),
  /** Host. */
  seed: Seed,
  /** Host. */
  route: Route,
  /** Host. */
  standUntil: Time.nullable(),
  /** Host. */
  goal: Waypoint.nullable(),
  /** Host. */
  straight: z.boolean(),
  /** When it bursts; null while its fuse is unlit. Everyone, to draw it swelling. */
  fuseAt: Time.nullable(),
  /** The body that last hurt it, which it chases while that lives; null for none. Host. */
  attacker: z.string().nullable(),
  /** Whether it bursts in this step. Host. */
  burst: z.boolean(),
  /** Radians, sent to a hundredth. Everyone. */
  facing: rounded(2),
});

export type BlisterState = z.output<typeof BlisterState>;

/** The kind's name. */
const NAME = "blister";

/** It pays no mind to its own kind's noise. */
const DEAF_TO = [NAME];

/** A fresh blister's state at world time `now`, its random draws seeded by `seed`. */
export function freshBlister(seed: number, now: number): BlisterState {
  return {
    mode: "wander",
    seed: seed | 0,
    route: [],
    standUntil: now,
    goal: null,
    straight: false,
    fuseAt: null,
    attacker: null,
    burst: false,
    facing: 0,
  };
}

/** Stands a while from now, a pause drawn from its seed. */
function stand(
  state: BlisterState,
  game: Session,
  config: BlisterConfig,
): BlisterState {
  const { result, seed } = withSeed(state.seed, (rng) =>
    between(rng, config.wanderPause),
  );
  return { ...state, seed, standUntil: game.worldTime + result };
}

/** How far a body at `from` walks along `route`. */
function lengthOf(from: Point, route: readonly Point[]): number {
  let length = 0;
  let at = from;
  for (const next of route) {
    length += Math.hypot(next.x - at.x, next.y - at.y);
    at = next;
  }
  return length;
}

const near = (a: Point | null, b: Point, within: number): boolean =>
  a !== null && Math.hypot(a.x - b.x, a.y - b.y) <= within;

/**
 * Hunts `prey` from `at`: by a route, unless none is short enough, then straight at it. It keeps
 * a route that already heads near enough it.
 */
function hunt(
  state: BlisterState,
  at: Point,
  prey: Point,
  map: TileMap,
  config: BlisterConfig,
): BlisterState {
  const goal = { x: prey.x, y: prey.y };
  if (state.mode === "chase" && state.straight)
    return { ...state, goal, route: [goal] };
  if (
    state.mode === "chase" &&
    state.route.length > 0 &&
    near(state.goal, prey, config.repathDistance)
  )
    return state;
  const route = planRoute(map, config.radius, at, prey);
  const { factor, slack } = config.detour;
  const longest = Math.hypot(prey.x - at.x, prey.y - at.y) * factor + slack;
  const straight = route === null || lengthOf(at, route) > longest;
  return {
    ...state,
    mode: "chase",
    goal,
    straight,
    standUntil: null,
    route: straight ? [goal] : route,
  };
}

/**
 * Wanders: heads for the clearest noise it hears, where a route reaches it, and otherwise walks
 * its leg, stands a while once it ends, then picks another.
 */
function wander(
  state: BlisterState,
  at: Point,
  game: Session,
  config: BlisterConfig,
): BlisterState {
  const { map } = game.world;
  const listened = withSeed(state.seed, (rng) =>
    clearestNoise(game, { at, rng, ignores: DEAF_TO }),
  );
  const roaming = { ...state, seed: listened.seed, mode: "wander" as const };
  const noise = listened.result?.at ?? null;
  if (noise !== null && !near(state.goal, noise, config.repathDistance)) {
    const route = planRoute(map, config.radius, at, noise);
    if (route !== null && route.length > 0)
      return { ...roaming, route, goal: noise, standUntil: null };
  }
  if (roaming.route.length > 0) return roaming;
  if (roaming.standUntil === null)
    return stand({ ...roaming, goal: null }, game, config);
  if (game.worldTime < roaming.standUntil) return roaming;
  const leg = withSeed(roaming.seed, (rng) =>
    wanderLeg(map, at, rng, config.radius, config.wanderRange),
  );
  return {
    ...roaming,
    seed: leg.seed,
    route: leg.result ?? [],
    goal: null,
    standUntil: null,
  };
}

/** The players, the only bodies it hunts. */
function players(game: Session): Point[] {
  return [...livingPlayers(game)];
}

/**
 * What it hunts: whatever body hurt it, wherever it is, while it lives; otherwise the nearest
 * player within its sense range, walls or no walls, or, just hurt by no one it can chase, the
 * nearest player anywhere. Null for none.
 */
function quarry(
  state: BlisterState,
  self: Point,
  game: Session,
  hurt: boolean,
  config: BlisterConfig,
): Point | null {
  const attacker = livingBody(game, state.attacker);
  if (attacker !== null) return attacker;
  const found = nearest(self, players(game));
  if (found === null) return null;
  const distance = Math.hypot(found.x - self.x, found.y - self.y);
  return hurt || distance <= config.senseRange ? found : null;
}

/** What it does next: hunts a player it feels, keeps on after one it lost, or wanders. */
function think(
  state: BlisterState,
  self: Point,
  game: Session,
  hurt: boolean,
  config: BlisterConfig,
): BlisterState {
  const prey = quarry(state, self, game, hurt, config);
  if (prey !== null) return hunt(state, self, prey, game.world.map, config);
  if (state.mode === "chase" && state.route.length > 0) return state;
  if (state.mode === "chase")
    return stand(
      { ...state, mode: "wander", goal: null, straight: false },
      game,
      config,
    );
  return wander(state, self, game, config);
}

/** Whether a wall stands right in the way of a body at `at` heading straight for `goal`. */
function walledOff(
  map: TileMap,
  half: number,
  at: Point,
  goal: Point,
): boolean {
  const dx = goal.x - at.x;
  const dy = goal.y - at.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return false;
  const ahead = Math.min(length, 4);
  return !isAreaFree(
    map,
    at.x + (dx / length) * ahead,
    at.y + (dy / length) * ahead,
    half,
  );
}

/**
 * Lights its fuse, if it is not lit, once it is hurt, a player is near enough, or a wall stands
 * in its straight way to its prey.
 */
function ignite(
  state: BlisterState,
  self: Point,
  game: Session,
  hurt: boolean,
  config: BlisterConfig,
): BlisterState {
  if (state.fuseAt !== null) return state;
  const closest = nearest(self, players(game));
  const close =
    closest !== null &&
    Math.hypot(closest.x - self.x, closest.y - self.y) <= config.fuseRange;
  const blocked =
    state.mode === "chase" &&
    state.straight &&
    state.goal !== null &&
    walledOff(game.world.map, config.radius, self, state.goal);
  if (!hurt && !close && !blocked) return state;
  return { ...state, fuseAt: game.worldTime + config.fuse };
}

/** The damage its burst deals to a body `distance` from it, its middle to theirs. */
export function blastDamage(distance: number, config: BlisterConfig): number {
  const { radius, centre, edge } = config.blast;
  const along = Math.min(1, Math.max(0, distance / radius));
  return centre + (edge - centre) * along;
}

/** A blister's sounds, each heard, and making noise, out to its range. */
interface Sounds {
  readonly fuse: Sound;
  readonly blast: Sound;
}

/**
 * Bursts, as the host: sounds and shows the burst on every client, knocks down the walls it
 * reaches, hurts every body it reaches by how near it is, and is gone. It hurts directly rather
 * than by its strikes, so a blister stunned with its fuse lit still bursts on time.
 */
function burst(
  entity: WorldEntity,
  state: BlisterState,
  game: Session,
  config: BlisterConfig,
  sounds: Sounds,
): BlisterState {
  const { radius } = config.blast;
  entity.vx = 0;
  entity.vy = 0;
  destroyWalls(game, { center: { x: entity.x, y: entity.y }, radius });
  effect(
    game,
    { at: entity, sound: sounds.blast, flash: { radius, hit: true } },
    entity,
  );
  const reach = (body: { readonly radius: number }) => radius + body.radius;
  for (const body of preyNear(game, entity, reach, [])) {
    const distance = Math.hypot(body.x - entity.x, body.y - entity.y);
    const caught = bodyById(game, body.id);
    if (caught !== null)
      hurt(game, caught, blastDamage(distance, config), entity.id);
  }
  hurt(game, entity, entity.health, entity.id);
  return { ...state, burst: true };
}

/** Whether its fuse has burnt down, and it has yet to burst. */
const due = (state: BlisterState, game: Session): boolean =>
  !state.burst && state.fuseAt !== null && game.worldTime >= state.fuseAt;

const LOOK = {
  skin: "#9fae4c",
  blotch: "#6f7a2e",
  ring: "#c9d47a",
  lit: "#ff5a2a",
  flare: "#fff4c8",
} as const;

/** How many times a second it blinks as its fuse burns down, from first to last. */
const BLINK = { first: 3, last: 14 } as const;

/** A swollen pale-green sac, mottled; once lit it swells and blinks, ever faster. */
function drawBlister(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  state: BlisterState,
  game: Session,
  config: BlisterConfig,
): void {
  const { x, y } = entity;
  const left =
    state.fuseAt === null ? null : Math.max(0, state.fuseAt - game.worldTime);
  const burning = left === null ? 0 : 1 - Math.min(1, left / config.fuse);
  const radius = entity.radius * (1 + 0.35 * burning);
  const rate = BLINK.first + (BLINK.last - BLINK.first) * burning;
  const flashing =
    left !== null && Math.floor(game.worldTime * rate * 2) % 2 === 0;
  ctx.save();
  ctx.fillStyle = flashing ? LOOK.lit : LOOK.skin;
  ctx.strokeStyle = flashing ? LOOK.flare : LOOK.ring;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = LOOK.blotch;
  for (const [angle, out, size] of [
    [state.facing + 0.4, 0.45, 0.28],
    [state.facing + 2.6, 0.5, 0.22],
    [state.facing - 1.8, 0.35, 0.18],
  ] as const) {
    ctx.beginPath();
    ctx.arc(
      x + Math.cos(angle) * radius * out,
      y + Math.sin(angle) * radius * out,
      radius * size,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
}

function definition(
  config: BlisterConfig,
  sounds: Sounds,
): EntityDefinition<BlisterState> {
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    data: BlisterState,
    update(entity, state, dt, game) {
      if (state.burst) return state;
      const struck = hurtSinceLastStep(game, entity.id);
      const hurt = struck !== null;
      const by = struck?.by ?? null;
      const sensed =
        by === null || by === entity.id ? state : { ...state, attacker: by };
      const thought = think(sensed, entity, game, hurt, config);
      const lit = ignite(thought, entity, game, hurt, config);
      if (state.fuseAt === null && lit.fuseAt !== null)
        effect(game, { at: entity, sound: sounds.fuse }, entity);
      if (due(lit, game)) return burst(entity, lit, game, config, sounds);
      const speed =
        lit.mode === "chase" ? config.chaseSpeed : config.wanderSpeed;
      return walk(entity, lit, speed, dt);
    },
    draw(ctx, entity, state, _now, game) {
      drawBlister(ctx, entity, state, game, config);
    },
  };
}

/**
 * Bursts each stunned blister whose fuse has burnt down: a stun stops it moving, not its fuse.
 * Its update, skipped while it is stunned, bursts the rest.
 */
function burstStunned(
  game: Session,
  config: BlisterConfig,
  sounds: Sounds,
): void {
  const kind = game.kindIds.get(NAME);
  for (const entity of [...game.entities.values()]) {
    if (entity.kind !== kind || !isStunned(game, entity.id)) continue;
    const parsed = BlisterState.safeParse(entity.data);
    if (!parsed.success || !due(parsed.data, game)) continue;
    entity.data = burst(entity, parsed.data, game, config, sounds);
  }
}

/**
 * A blister: comes alone, out of the dark, and makes no sound but its fuse and its burst. It
 * wanders towards any noise, feels players through walls nearby and chases them down, by a route
 * where one is short enough, else straight at them. Near a player, hurt, or stopped by a wall in
 * its straight way, it lights a short fuse and keeps coming, then bursts, knocking the walls
 * round it down and hurting everything near, worst nearest. Once hurt, it goes for whatever body
 * hurt it, wherever it is, or with none to chase, for the nearest player.
 */
export const blister = defineEntity(NAME, (config: BlisterConfig) => {
  const sounds: Sounds = {
    fuse: sound({ url: fuseUrl, range: config.sounds.fuse }),
    blast: sound({ url: blastUrl, range: config.sounds.blast }),
  };
  return {
    ...definition(config, sounds),
    ...arrivals({
      kind: NAME,
      radius: config.radius,
      config: config.spawning,
      fresh: (seed: number, game: Session) =>
        freshBlister(Math.floor(seed * 2 ** 32), game.worldTime),
    }),
    step(game: Session) {
      burstStunned(game, config, sounds);
    },
  };
});
