import { describe, expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  hurt,
  lastHurtBy,
  makeNoise,
  receiveEvent,
  registerContent,
  spawnEntity,
  stun,
  updateSession,
} from "../../sim/index.js";
import type {
  Point,
  Session,
  WorldContent,
  WorldEntity,
} from "../../sim/index.js";
import { freshZombie, zombie as zombieContent } from "../zombie/index.js";
import type { BlisterConfig } from "./index.js";
import {
  blastDamage,
  blister as blisterContent,
  BlisterState,
  freshBlister,
} from "./index.js";

const DT = 1 / 60;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
  drop: false,
  holdingUse: false,
};
const { blister: config } = testEntitiesConfig;

/** The dev square, 18x12 cells, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550. */
function world(
  blister: BlisterConfig = config,
  others: readonly WorldContent[] = [],
): {
  game: Session;
  noise: (at: Point, radius: number) => void;
} {
  const game = createSession(
    "me",
    "ME",
    "POP",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  const pending: { at: Point; radius: number }[] = [];
  const noiser: WorldContent = {
    name: "move/noiser",
    register: () => undefined,
    populate: () => undefined,
    act(session) {
      for (const made of pending.splice(0))
        makeNoise(session, session.local, made);
    },
  };
  registerContent(game, [
    blisterContent.create({ blister }),
    noiser,
    ...others,
  ]);
  standAt(game, 875, 575);
  return { game, noise: (at, radius) => pending.push({ at, radius }) };
}

function standAt(game: Session, x: number, y: number): void {
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
}

function blisterAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(game, "blister", x, y, freshBlister(1, game.worldTime));
}

const stateOf = (entity: WorldEntity): BlisterState =>
  BlisterState.parse(entity.data);

function played(game: Session): string[] {
  return vi.mocked(game.sfx.play).mock.calls.map(([url]) => url);
}

const sounded = (game: Session, file: string): boolean =>
  played(game).some((url) => url.endsWith(file));

/** Steps `seconds`, each sound the host sends heard at once. */
function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, idle, DT);
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

const solidAt = (game: Session, col: number, row: number): boolean =>
  game.world.map.solid[row * game.world.map.cols + col] === 1;

test("its burst deals 100 where it stands, falling evenly to 30 at the edge", () => {
  const { radius } = config.blast;
  expect(blastDamage(0, config)).toBe(100);
  expect(blastDamage(radius / 2, config)).toBeCloseTo(65);
  expect(blastDamage(radius, config)).toBe(30);
  expect(blastDamage(radius * 2, config)).toBe(30);
});

describe("hunting", () => {
  test("it feels a player behind a pillar and chases it round, silently", () => {
    const { game } = world();
    standAt(game, 250, 25);
    const sac = blisterAt(game, 250, 400);
    run(game, DT);

    const state = stateOf(sac);
    expect(state).toMatchObject({ mode: "chase", straight: false });
    expect(state.fuseAt).toBeNull();
    expect(Math.hypot(sac.vx, sac.vy)).toBeCloseTo(config.chaseSpeed);
    run(game, 0.5);
    expect(played(game)).toEqual([]);
  });

  test("a player beyond its sense range is not hunted, but a noise draws it", () => {
    const { game, noise } = world();
    standAt(game, 850, 300);
    const sac = blisterAt(game, 100, 300);
    noise({ x: 450, y: 300 }, 500);
    run(game, DT);
    const state = stateOf(sac);
    expect(state.mode).toBe("wander");
    expect(state.goal?.x).toBeGreaterThan(350);
    expect(Math.hypot(sac.vx, sac.vy)).toBeCloseTo(config.wanderSpeed);
  });

  test("with no route short enough it heads straight at its prey, and lights its fuse at the wall in the way", () => {
    const { game } = world();
    // A wall down column 9, open only at the bottom row.
    for (let row = 0; row < 11; row++)
      game.world.map.solid[row * game.world.map.cols + 9] = 1;
    standAt(game, 650, 100);
    const sac = blisterAt(game, 380, 100);
    run(game, DT);
    expect(stateOf(sac)).toMatchObject({ mode: "chase", straight: true });
    expect(stateOf(sac).fuseAt).toBeNull();

    run(game, 0.6);
    expect(stateOf(sac).fuseAt).not.toBeNull();
    expect(sac.x).toBeLessThanOrEqual(450 - config.radius + 1);
  });
});

describe("bursting", () => {
  test("near a player it lights a fuse, keeps coming, and bursts a second later, hurting by distance", () => {
    const { game } = world();
    standAt(game, 540, 300);
    const sac = blisterAt(game, 450, 300);
    run(game, DT);
    const lit = stateOf(sac).fuseAt;
    expect(lit).toBeCloseTo(game.worldTime + config.fuse, 1);
    expect(sounded(game, "fuse.mp3")).toBe(true);
    run(game, 0.3);
    expect(sac.x).toBeGreaterThan(460);

    run(game, config.fuse);
    expect(game.entities.has(sac.id)).toBe(false);
    expect(sounded(game, "blast.mp3")).toBe(true);
    const lost = testSimConfig.player.maxHealth - game.local.health;
    expect(lost).toBeGreaterThan(70);
    expect(lost).toBeLessThan(100);
    expect(lastHurtBy(game, game.localId)).toBe(sac.id);
  });

  test("its burst knocks down the walls it reaches", () => {
    const { game } = world();
    expect(solidAt(game, 5, 2)).toBe(true);
    standAt(game, 330, 200);
    blisterAt(game, 250, 200);
    run(game, config.fuse + 0.2);
    expect(solidAt(game, 5, 2)).toBe(false);
    expect(solidAt(game, 12, 9)).toBe(true);
  });

  test("its burst sets off another blister it hurts", () => {
    const { game } = world({ ...config, senseRange: 0, fuseRange: 0 });
    const first = blisterAt(game, 400, 300);
    const second = blisterAt(game, 500, 300);
    hurt(game, first, 1, null);
    run(game, DT);
    expect(stateOf(first).fuseAt).not.toBeNull();
    expect(stateOf(second).fuseAt).toBeNull();
    run(game, config.fuse + DT);
    expect(game.entities.has(first.id)).toBe(false);
    run(game, DT * 2);
    expect(stateOf(second).fuseAt).not.toBeNull();
  });

  test("hurt by no one, it lights its fuse at once and goes for the nearest player, however far", () => {
    const { game } = world({ ...config, senseRange: 50 });
    standAt(game, 800, 500);
    const sac = blisterAt(game, 100, 300);
    hurt(game, sac, 10, null);
    run(game, DT);
    const state = stateOf(sac);
    expect(state.fuseAt).not.toBeNull();
    expect(state.mode).toBe("chase");
    expect(state.goal).toMatchObject({ x: 800, y: 500 });
  });

  test("hurt by a zombie, it lights its fuse and chases the zombie, not the player nearer it", () => {
    const zombie = zombieContent.create({ zombie: testEntitiesConfig.zombie });
    const { game } = world({ ...config, senseRange: 50 }, [zombie]);
    standAt(game, 200, 300);
    const sac = blisterAt(game, 100, 300);
    const biter = spawnEntity(
      game,
      "zombie",
      800,
      500,
      freshZombie(1, game.worldTime, testEntitiesConfig.zombie),
    );
    // Held still, so where the blister heads is where the zombie stands.
    stun(game, biter.id, 5);
    hurt(game, sac, 10, biter.id);
    run(game, DT);
    const state = stateOf(sac);
    expect(state.fuseAt).not.toBeNull();
    expect(state.attacker).toBe(biter.id);
    expect(state.goal).toMatchObject({ x: 800, y: 500 });
    run(game, DT * 10);
    expect(stateOf(sac).goal).toMatchObject({ x: 800, y: 500 });
  });

  test("stunned with its fuse lit, it still bursts on time", () => {
    const { game } = world();
    standAt(game, 540, 300);
    const sac = blisterAt(game, 450, 300);
    run(game, DT);
    expect(stateOf(sac).fuseAt).not.toBeNull();
    stun(game, sac.id, 5);
    const x = sac.x;
    run(game, config.fuse - 0.2);
    expect(sac.x).toBe(x);
    expect(game.entities.has(sac.id)).toBe(true);
    run(game, 0.3);
    expect(game.entities.has(sac.id)).toBe(false);
    expect(game.local.health).toBeLessThan(testSimConfig.player.maxHealth);
  });
});
