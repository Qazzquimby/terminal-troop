import { expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  hurt,
  receiveEvent,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { freshZombie, zombie as zombieContent } from "../zombie/index.js";
import {
  apexPredator as duckContent,
  ApexPredatorState,
  freshApexPredator,
} from "./index.js";

const DT = 1 / 60;
const { apexPredator: config } = testEntitiesConfig;

/** The dev square, 18x12 cells of 50px; the local player, ME, stands at (x, y). */
function world(x: number, y: number): Session {
  const game = createSession(
    "me",
    "ME",
    "PARTY",
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
    duckContent.create({ apexPredator: config }),
    zombieContent.create({ zombie: testEntitiesConfig.zombie }),
  ]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  return game;
}

/** Steps `seconds`, the local player standing, aiming at the point `aim`, each event heard at once. */
function run(
  game: Session,
  seconds: number,
  aim: Point = { x: 1000, y: 325 },
): void {
  const controls = {
    move: { x: 0, y: 0 },
    aim,
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

function duckAt(
  game: Session,
  at: Point,
  change: Partial<ApexPredatorState> = {},
): WorldEntity {
  return spawnEntity(game, "apexPredator", at.x, at.y, {
    ...freshApexPredator(game.worldTime, 1),
    ...change,
  });
}

const stateOf = (entity: WorldEntity): ApexPredatorState =>
  ApexPredatorState.parse(entity.data);

const played = (game: Session, file: string): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith(file));

test("three test shovel hits fell it, and it is light", () => {
  const game = world(875, 575);
  const duck = duckAt(game, { x: 425, y: 325 });
  expect(duck.maxHealth).toBe(testItemsConfig.shovel.damage * 3);
  expect(config.mass).toBeLessThan(1);
});

test("calm, it goes to stand in front of the body it notices, and does it no harm", () => {
  const game = world(425, 325);
  const duck = duckAt(game, { x: 225, y: 325 }, { facing: 0 });
  run(game, 6);
  // The player looks east, away from the duck; it goes round and stands east of it, close.
  expect(duck.x).toBeGreaterThan(game.local.x);
  expect(Math.hypot(duck.x - game.local.x, duck.y - game.local.y)).toBeLessThan(
    game.local.radius + duck.radius + config.standGap + 15,
  );
  expect(stateOf(duck).mode).toBe("calm");
  expect(game.local.health).toBe(game.local.maxHealth);
});

test("hurt, it turns angry on whatever hurt it, with an angry quack, and pecks it", () => {
  const game = world(425, 325);
  const duck = duckAt(game, { x: 460, y: 325 }, { facing: Math.PI });
  hurt(game, duck, 1, game.localId);
  run(game, DT * 2);
  const state = stateOf(duck);
  expect(state.mode).toBe("angry");
  expect(state.foe).toBe(game.localId);
  expect(played(game, "angry-quack.mp3")).toBe(true);
  run(game, 3);
  const lost = game.local.maxHealth - game.local.health;
  expect(lost).toBeGreaterThan(0);
  expect(lost % config.damage).toBe(0);
});

test("hurt by a monster, it turns on the monster: any body, not just players", () => {
  const game = world(875, 575);
  const duck = duckAt(game, { x: 425, y: 325 });
  const zombie = spawnEntity(
    game,
    "zombie",
    460,
    325,
    freshZombie(1, 0, testEntitiesConfig.zombie),
  );
  hurt(game, duck, 1, zombie.id);
  run(game, DT * 2);
  expect(stateOf(duck).foe).toBe(zombie.id);
});

test("angry, with no body seen for a while, it calms", () => {
  const game = world(875, 575);
  const duck = duckAt(game, { x: 125, y: 75 }, { mode: "angry", seenAt: 0 });
  run(game, config.calmSeconds - 1);
  expect(stateOf(duck).mode).toBe("angry");
  run(game, 1.5);
  expect(stateOf(duck).mode).toBe("calm");
});

test("a sprint outruns it, a walk does not", () => {
  const { speed, sprintMultiplier } = testSimConfig.player;
  expect(speed * config.speedShare).toBeGreaterThan(speed);
  expect(speed * config.speedShare).toBeLessThan(speed * sprintMultiplier);
});
