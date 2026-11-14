import { expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  canSeeFrom,
  createPlayer,
  createSession,
  directionalVision,
  receiveEvent,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Player, Point, Session, WorldEntity } from "../../sim/index.js";
import type { SkulkerConfig } from "./index.js";
import {
  freshSkulker,
  skulker as skulkerContent,
  SkulkerState,
} from "./index.js";

const DT = 1 / 60;
const { skulker: config } = testEntitiesConfig;

/** The dev square, 18x12 cells of 50px, all dark; the local player stands at (x, y). */
function world(x: number, y: number, skulker: SkulkerConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "SKULK",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  registerContent(game, [skulkerContent.create({ skulker })]);
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

function skulkerAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(
    game,
    "skulker",
    x,
    y,
    freshSkulker(game.worldTime, config.maxHealth),
  );
}

const stateOf = (entity: WorldEntity): SkulkerState =>
  SkulkerState.parse(entity.data);

const sounded = (game: Session, file: string): boolean =>
  vi.mocked(game.sfx.play).mock.calls.some(([url]) => url.endsWith(file));

/** Whether `player`, facing as it does, has the point `at` in its view cone, out to `range`. */
function watches(
  game: Session,
  player: Player,
  at: Point,
  range: number,
): boolean {
  const [cone] = directionalVision(
    player,
    player.aim,
    game.config.vision,
    range,
  );
  return canSeeFrom(game.world.map, cone, at);
}

test("it creeps up behind a player faster than a walk and kills it at a touch", () => {
  const game = world(700, 300);
  const skulker = skulkerAt(game, 150, 300);
  run(game, 0.5, { x: 900, y: 300 });

  expect(stateOf(skulker).mode).toBe("hunt");
  expect(skulker.vx).toBeCloseTo(config.speed);
  expect(config.speed).toBeCloseTo(testSimConfig.player.speed * 1.2);

  run(game, 2.5, { x: 900, y: 300 });
  expect(game.local.health).toBe(0);
  expect(sounded(game, "attack.mp3")).toBe(true);
});

test("caught in a player's gaze, it hisses and backs off home for the retreat's length, then hunts again", () => {
  const game = world(700, 300);
  const skulker = skulkerAt(game, 200, 300);
  run(game, 0.5, { x: 900, y: 300 });
  const home = stateOf(skulker).home;
  expect(home).toEqual({ x: 200, y: 300 });
  const before = skulker.x;
  expect(before).toBeGreaterThan(200);

  run(game, DT, { x: 0, y: 300 });
  expect(stateOf(skulker).mode).toBe("retreat");
  expect(sounded(game, "retreat.mp3")).toBe(true);
  run(game, 1, { x: 0, y: 300 });
  expect(skulker.x).toBeLessThan(before);
  expect(game.local.health).toBe(game.local.maxHealth);

  // Looked away from, it keeps retreating until the time is up, then hunts.
  run(game, config.retreatSeconds - 1.5, { x: 900, y: 300 });
  expect(stateOf(skulker).mode).toBe("retreat");
  run(game, 1, { x: 900, y: 300 });
  expect(stateOf(skulker).mode).toBe("hunt");
});

test("a retreat keeps its distance from a player where it can", () => {
  const game = world(700, 300);
  const skulker = skulkerAt(game, 300, 300);
  run(game, DT, { x: 0, y: 300 });
  expect(stateOf(skulker).mode).toBe("retreat");
  const start = Math.hypot(skulker.x - 700, skulker.y - 300);
  for (let i = 0; i < 60; i++) {
    run(game, DT, { x: 0, y: 300 });
    expect(Math.hypot(skulker.x - 700, skulker.y - 300)).toBeGreaterThanOrEqual(
      start - 1,
    );
  }
});

test("its hunt goes round another player's gaze, never stepping into it", () => {
  const range = 400;
  const game = world(560, 560, { ...config, watchRange: range });
  // A second player, further off, looks down and to the left; the straight way to the local
  // player crosses its view, though neither end is in it.
  const watcher = createPlayer(
    "them",
    "THEM",
    { x: 600, y: 60 },
    testSimConfig,
  );
  watcher.aim = (Math.PI * 3) / 4;
  watcher.taim = (Math.PI * 3) / 4;
  game.players.set(watcher.id, watcher);
  const skulker = skulkerAt(game, 60, 300);
  const crossing = { x: 400, y: 404 };
  expect(watches(game, watcher, crossing, range)).toBe(true);

  for (let i = 0; i < 240 && game.local.health > 0; i++) {
    run(game, DT, { x: 900, y: 560 });
    expect(stateOf(skulker).mode).toBe("hunt");
    expect(watches(game, watcher, skulker, range)).toBe(false);
  }
  expect(game.local.health).toBe(0);
});

test("hurt, it shrieks and rages at the nearest living thing, watched or not, then hunts again", () => {
  const game = world(700, 300);
  const skulker = skulkerAt(game, 400, 300);
  run(game, DT, { x: 0, y: 300 });
  expect(stateOf(skulker).mode).toBe("retreat");

  skulker.health -= 15;
  run(game, DT, { x: 0, y: 300 });
  expect(stateOf(skulker).mode).toBe("enraged");
  expect(sounded(game, "enraged.mp3")).toBe(true);
  run(game, 1.5, { x: 0, y: 300 });
  expect(game.local.health).toBe(0);

  run(game, config.enragedSeconds, { x: 0, y: 300 });
  expect(stateOf(skulker).mode).toBe("hunt");
});
