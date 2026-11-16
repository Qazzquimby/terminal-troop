import { expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  besideWall,
  createSession,
  hurt,
  receiveEvent,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { spawnAllowed } from "../spawn-rules.js";
import { freshZombie, zombie } from "../zombie/index.js";
import {
  freshLivingWall,
  livingWall as livingWallContent,
  LivingWallState,
} from "./index.js";

const DT = 1 / 60;
const { livingWall: config } = testEntitiesConfig;

/**
 * The dev square, 18x12 cells of 50px, walled round its edge, its pillars at x 200-300, y 50-150
 * and x 600-700, y 450-550, all dark; the local player stands at (x, y).
 */
function world(x: number, y: number): Session {
  const game = createSession(
    "me",
    "ME",
    "STONE",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  registerContent(game, [
    livingWallContent.create({ livingWall: config }),
    zombie.create({ zombie: testEntitiesConfig.zombie }),
  ]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  return game;
}

/** Steps `seconds`, the local player looking at `look`, each sound the host sends heard at once. */
function run(game: Session, seconds: number, look: Point): void {
  const controls = {
    move: { x: 0, y: 0 },
    aim: look,
    sprint: false,
    crouch: false,
    select: null,
    cycle: 0,
    use: false,
    holdingUse: false,
    secondary: false,
    interact: false,
    drop: false,
  };
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, controls, DT);
    for (const { content, event, to, payload } of game.outbox.splice(0))
      receiveEvent(
        game,
        { from: game.localId, to, content, event, payload },
        game.localId,
      );
    for (const { event, payload, sender } of game.inbox.splice(0))
      event.receive(game, payload, sender);
  }
}

function wallAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(game, "livingWall", x, y, freshLivingWall(game.worldTime));
}

const stateOf = (entity: WorldEntity): LivingWallState =>
  LivingWallState.parse(entity.data);

const sounded = (game: Session, file: string): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith(file));

/** Away to the right, where nothing in these tests stands. */
const AWAY = { x: 900, y: 325 };

test("with no body near, it settles into the middle of its cell and stands there", () => {
  const game = world(875, 575);
  const wall = wallAt(game, 80, 340);
  run(game, 1, AWAY);
  expect(wall.x).toBeCloseTo(75, 0);
  expect(wall.y).toBeCloseTo(325, 0);
  run(game, 1, AWAY);
  expect(wall.vx).toBe(0);
  expect(wall.vy).toBe(0);
});

test("a body within its notice, looking away, is crept up on at 0.8 times a walk", () => {
  const game = world(575, 325);
  const wall = wallAt(game, 175, 325);
  run(game, 0.5, AWAY);
  expect(Math.hypot(wall.vx, wall.vy)).toBeCloseTo(config.speed);
  expect(config.speed).toBeCloseTo(testSimConfig.player.speed * 0.8);
  expect(wall.x).toBeGreaterThan(200);
});

test("looked at, it stands still as stone, and moves again once the gaze leaves it", () => {
  const game = world(475, 325);
  const wall = wallAt(game, 175, 325);
  run(game, 1, { x: 0, y: 325 });
  expect(wall.x).toBeCloseTo(175);
  expect(stateOf(wall).held).toBe(true);
  run(game, 0.5, AWAY);
  expect(stateOf(wall).held).toBe(false);
  expect(wall.x).toBeGreaterThan(200);
});

test("it strikes a body it reaches from behind for 80, with a sound", () => {
  const game = world(475, 325);
  wallAt(game, 275, 325);
  run(game, 1.5, AWAY);
  expect(game.local.health).toBe(game.local.maxHealth - config.damage);
  expect(sounded(game, "attack.mp3")).toBe(true);
});

test("a body facing it is never struck: its gaze holds it", () => {
  const game = world(475, 325);
  wallAt(game, 430, 325);
  run(game, 3, { x: 0, y: 325 });
  expect(game.local.health).toBe(game.local.maxHealth);
  expect(sounded(game, "attack.mp3")).toBe(false);
});

test("any body is prey, a zombie as much as a player", () => {
  const game = world(875, 575);
  const zed = spawnEntity(
    game,
    "zombie",
    425,
    325,
    freshZombie(1, 0, testEntitiesConfig.zombie),
  );
  const wall = wallAt(game, 175, 325);
  run(game, 0.25, AWAY);
  expect(Math.hypot(wall.x - zed.x, wall.y - zed.y)).toBeLessThan(250);
  expect(wall.vx !== 0 || wall.vy !== 0).toBe(true);
});

test("hurt, it grinds away from what hurt it at twice a sprint, then lurks again", () => {
  const game = world(475, 325);
  const wall = wallAt(game, 375, 325);
  // Looked at, so it stands until hurt.
  run(game, 0.1, { x: 0, y: 325 });
  hurt(game, wall, 15, game.localId);
  run(game, 0.2, { x: 0, y: 325 });
  expect(stateOf(wall).mode).toBe("flee");
  expect(Math.hypot(wall.vx, wall.vy)).toBeCloseTo(config.fleeSpeed);
  expect(config.fleeSpeed).toBeCloseTo(
    testSimConfig.player.speed * testSimConfig.player.sprintMultiplier * 2,
  );
  expect(Math.hypot(wall.x - 475, wall.y - 325)).toBeGreaterThan(200);
  expect(sounded(game, "flee.mp3")).toBe(true);
  run(game, config.fleeSeconds, { x: 0, y: 325 });
  expect(stateOf(wall).mode).toBe("lurk");
});

test("it crumbles as it dies, with a sound", () => {
  const game = world(475, 325);
  const wall = wallAt(game, 375, 325);
  hurt(game, wall, config.maxHealth, game.localId);
  run(game, 0.1, AWAY);
  expect(game.entities.has(wall.id)).toBe(false);
  expect(sounded(game, "crumble.mp3")).toBe(true);
});

test("it may only appear in a cell with a wall on one of its sides", () => {
  const game = world(875, 575);
  const rules = { besideWall: true };
  // Against the world's top edge, and beside the pillar at x 200-300, y 50-150.
  expect(spawnAllowed(game, { x: 425, y: 25 }, rules)).toBe(true);
  expect(spawnAllowed(game, { x: 325, y: 125 }, rules)).toBe(true);
  // Out in the open, a cell off any wall; only diagonal to the pillar.
  expect(spawnAllowed(game, { x: 425, y: 325 }, rules)).toBe(false);
  expect(spawnAllowed(game, { x: 325, y: 175 }, rules)).toBe(false);
  expect(spawnAllowed(game, { x: 425, y: 325 })).toBe(true);
  // A wall cell itself is no place to stand beside one.
  expect(besideWall(game.world.map, { x: 225, y: 75 })).toBe(false);
});
