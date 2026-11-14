import { expect, test } from "vitest";
import type { World } from "./map.js";
import { testGeneration } from "../integration/sim-config.js";
import { movement } from "./movement.js";
import type { Controls, Player, PlayerRules } from "./player.js";
import type { CollisionBody } from "./collision.js";
import {
  createPlayer,
  loadFactor,
  startDash,
  stepDash,
  updatePlayer,
} from "./player.js";

const STEP = 1 / 60;
const PLAYER_SPEED = 220;
const SPRINT_MULTIPLIER = 1.8;
const CROUCH_MULTIPLIER = 0.5;
const STAMINA_MAX = 100;

const rules: PlayerRules = {
  player: {
    radius: 14,
    speed: PLAYER_SPEED,
    acceleration: 1100,
    sprintMultiplier: SPRINT_MULTIPLIER,
    crouchMultiplier: CROUCH_MULTIPLIER,
    maxHealth: 100,
    inventorySlots: 4,
    nameMax: 8,
    knockbackSeconds: 0.15,
    load: { full: 100, slowdown: 0.2 },
  },
  stamina: {
    max: STAMINA_MAX,
    drain: STAMINA_MAX / 3,
    regen: STAMINA_MAX / 4,
    regenDelay: 0.6,
    recover: STAMINA_MAX * 0.3,
  },
  world: {
    cell: 50,
    cols: 100,
    rows: 100,
    seed: 1,
    wallBounce: 0,
    generation: testGeneration,
  },
};

/** A world of open floor; only its map matters to a player moving. */
type OpenWorld = Pick<World, "W" | "H" | "map">;

function openWorld(): OpenWorld {
  const map = { cell: 50, cols: 100, rows: 100, solid: new Uint8Array(10000) };
  return { W: 5000, H: 5000, map };
}

/** Steps `player` `steps` times, moving right unless `held` says otherwise. */
function hold(
  player: Player,
  world: OpenWorld,
  held: Partial<Controls>,
  steps: number,
) {
  const controls: Controls = {
    move: { x: 1, y: 0 },
    aim: { x: 0, y: 0 },
    sprint: false,
    crouch: false,
    select: null,
    use: false,
    secondary: false,
    interact: false,
    drop: false,
    holdingUse: false,
    ...held,
  };
  for (let i = 0; i < steps; i++) {
    updatePlayer(player, controls, STEP, world.map, rules);
  }
}

function run(player: Player, world: OpenWorld, sprint: boolean, steps: number) {
  hold(player, world, { sprint }, steps);
}

function startPlayer(): Player {
  return createPlayer("p", "P", { x: 500, y: 2500 }, rules);
}

test("walking reaches normal top speed", () => {
  const world = openWorld();
  const player = startPlayer();
  run(player, world, false, 60);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED);
});

test("carrying weight slows the top speed evenly, to 20% slower at 100lb and no slower past it", () => {
  const topSpeed = (pounds: number, sprint = false): number => {
    const world = openWorld();
    const player = startPlayer();
    const controls: Controls = {
      move: { x: 1, y: 0 },
      aim: { x: 0, y: 0 },
      sprint,
      crouch: false,
      select: null,
      use: false,
      secondary: false,
      interact: false,
      drop: false,
      holdingUse: false,
    };
    for (let i = 0; i < 60; i++)
      updatePlayer(player, controls, STEP, world.map, rules, pounds);
    return player.vx;
  };
  expect(topSpeed(0)).toBeCloseTo(PLAYER_SPEED);
  expect(topSpeed(30)).toBeCloseTo(PLAYER_SPEED * 0.94);
  expect(topSpeed(100)).toBeCloseTo(PLAYER_SPEED * 0.8);
  expect(topSpeed(250)).toBeCloseTo(PLAYER_SPEED * 0.8);
  expect(topSpeed(50, true)).toBeCloseTo(
    PLAYER_SPEED * SPRINT_MULTIPLIER * 0.9,
  );
});

test("load factor is 1 for nothing, falls linearly, and holds at the limit", () => {
  const load = { full: 100, slowdown: 0.2 };
  expect(loadFactor(0, load)).toBe(1);
  expect(loadFactor(15, load)).toBeCloseTo(0.97);
  expect(loadFactor(100, load)).toBeCloseTo(0.8);
  expect(loadFactor(1000, load)).toBeCloseTo(0.8);
});

test("holding sprint reaches the higher top speed", () => {
  const world = openWorld();
  const player = startPlayer();
  run(player, world, true, 60);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED * SPRINT_MULTIPLIER);
});

test("releasing sprint decelerates back to normal speed", () => {
  const world = openWorld();
  const player = startPlayer();
  run(player, world, true, 60);

  run(player, world, false, 1);
  expect(player.vx).toBeLessThan(PLAYER_SPEED * SPRINT_MULTIPLIER);
  expect(player.vx).toBeGreaterThan(PLAYER_SPEED);

  run(player, world, false, 60);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED);
});

test("holding sprint while standing still does not drain stamina", () => {
  const world = openWorld();
  const player = startPlayer();
  hold(player, world, { move: { x: 0, y: 0 }, sprint: true }, 300);
  expect(player.stamina.value).toBe(STAMINA_MAX);
});

const STILL = { move: { x: 0, y: 0 } };

/** Presses crouch for one step, standing still. */
function pressCrouch(player: Player, world: OpenWorld) {
  hold(player, world, { ...STILL, crouch: true }, 1);
}

test("a crouch press crouches, standing still too, until the next press stands it up", () => {
  const world = openWorld();
  const player = startPlayer();
  pressCrouch(player, world);
  expect(movement.get(player)).toEqual({ mode: "crouch", moving: false });
  hold(player, world, STILL, 30);
  expect(movement.get(player)).toEqual({ mode: "crouch", moving: false });

  pressCrouch(player, world);
  expect(movement.get(player)).toEqual({ mode: "walk", moving: false });
});

test("crouching moves at the lower top speed, and reports it crouches", () => {
  const world = openWorld();
  const player = startPlayer();
  pressCrouch(player, world);
  hold(player, world, {}, 60);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED * CROUCH_MULTIPLIER);
  expect(movement.get(player)).toEqual({ mode: "crouch", moving: true });
});

test("sprinting stands a crouching player up, and it stays up after", () => {
  const world = openWorld();
  const player = startPlayer();
  pressCrouch(player, world);
  hold(player, world, { sprint: true }, 60);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED * SPRINT_MULTIPLIER);
  expect(movement.get(player).mode).toBe("sprint");

  hold(player, world, {}, 60);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED);
  expect(movement.get(player).mode).toBe("walk");
});

test("holding sprint while crouched and standing still keeps it crouched", () => {
  const world = openWorld();
  const player = startPlayer();
  pressCrouch(player, world);
  hold(player, world, { ...STILL, sprint: true }, 30);
  expect(movement.get(player).mode).toBe("crouch");
  expect(player.stamina.value).toBe(STAMINA_MAX);
});

test("running out of stamina drops sprint to walk speed until recovered", () => {
  const world = openWorld();
  const player = startPlayer();
  run(player, world, true, 60 * 4);
  expect(player.stamina.exhausted).toBe(true);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED);

  // Sprint stays held: exhausted players walk and regenerate.
  while (player.stamina.exhausted) {
    run(player, world, true, 1);
    expect(player.vx).toBeLessThanOrEqual(PLAYER_SPEED);
  }
  run(player, world, true, 15);
  expect(player.vx).toBeCloseTo(PLAYER_SPEED * SPRINT_MULTIPLIER);
});

/** Steps `player`'s dash `steps` times past `others`. */
function dash(
  player: Player,
  world: OpenWorld,
  steps: number,
  others: CollisionBody[] = [],
) {
  for (let i = 0; i < steps; i++) stepDash(player, STEP, world.map, others);
}

const post = (x: number, y: number): CollisionBody => ({
  x,
  y,
  vx: 0,
  vy: 0,
  radius: 15,
});

test("a dash carries the player its distance over its time, then ends", () => {
  const world = openWorld();
  const player = startPlayer();
  const landing = startDash(player, Math.PI / 2, 28, 0.1, world.map, []);
  expect(landing.x).toBeCloseTo(500);
  expect(landing.y).toBeCloseTo(2528);
  dash(player, world, 12);
  expect(player.x).toBeCloseTo(500);
  expect(player.y).toBeCloseTo(2528);
  expect(player.dash).toBeNull();
});

test("a dash stops at a wall, and says where", () => {
  const world = openWorld();
  const player = startPlayer();
  player.x = 20;
  const landing = startDash(player, Math.PI, 28, 0.1, world.map, []);
  expect(landing.x).toBeGreaterThanOrEqual(14);
  expect(landing.x).toBeLessThan(18);
  dash(player, world, 12);
  expect(player.x).toBeCloseTo(14);
});

test("a dash stops touching a body in its way, and says where", () => {
  const world = openWorld();
  const player = startPlayer();
  const others = [post(540, 2500)];
  const landing = startDash(player, 0, 28, 0.1, world.map, others);
  expect(landing.x).toBeCloseTo(511);
  dash(player, world, 12, others);
  expect(player.x).toBeCloseTo(511);
});

test("a dash goes on once a body in its way has moved off", () => {
  const world = openWorld();
  const player = startPlayer();
  const others = [post(531, 2500)];
  startDash(player, 0, 28, 0.1, world.map, others);
  dash(player, world, 2, others);
  expect(player.x).toBeCloseTo(502);
  others.length = 0;
  dash(player, world, 10, others);
  expect(player.x).toBeGreaterThan(520);
});

test("a knockback with nowhere to go holds the player where it stands for its time", () => {
  const world = openWorld();
  const player = startPlayer();
  const at = { x: player.x, y: player.y };
  player.dash = { vx: 0, vy: 0, seconds: 0.1, to: at };
  dash(player, world, 3, [post(at.x + 30, at.y)]);
  expect({ x: player.x, y: player.y }).toEqual(at);
  dash(player, world, 9);
  expect({ x: player.x, y: player.y }).toEqual(at);
  expect(player.dash).toBeNull();
});
