import { describe, expect, test, vi } from "vitest";
import alertUrl from "./sfx/alert.mp3";
import attackUrl from "./sfx/attack.mp3";
import barkUrl from "./sfx/bark.mp3";
import {
  testMonsterConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import {
  applyEntitySnapshot,
  applyRemoteState,
  createSession,
  cueEntities,
  entitySnapshot,
  isAreaFree,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import type { Session, WorldEntity } from "../sim/index.js";
import type { ChaserConfig } from "./chaser.js";
import { ChaserState, freshChaser } from "./chaser.js";
import { MonsterKind, createMonsters } from "./index.js";

const DT = 1 / 60;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  select: null,
  use: false,
};
const { chaser: config } = testMonsterConfig;

/** The sounds a session's chasers have played, oldest first. */
function played(game: Session): string[] {
  return vi.mocked(game.sfx.play).mock.calls.map(([url]) => url);
}

/** The dev square, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550. */
function world(
  chaser: ChaserConfig = config,
  surroundingsRadius = testSimConfig.vision.surroundingsRadius,
): Session {
  const game = createSession("me", "ME", "CHASE", "dev", testSfx(), {
    ...testSimConfig,
    vision: { ...testSimConfig.vision, surroundingsRadius },
  });
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  createMonsters({ ...testMonsterConfig, chaser }).register(game);
  return game;
}

function standAt(game: Session, x: number, y: number): void {
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
}

function chaserAt(game: Session, x: number, y: number, seed = 1): WorldEntity {
  return spawnEntity(game, MonsterKind.CHASER, x, y, freshChaser(seed, config));
}

const stateOf = (entity: WorldEntity): ChaserState =>
  ChaserState.parse(entity.data);

/** Steps `seconds`, one step a frame. */
function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, idle, DT);
    cueEntities(game);
  }
}

/** Steps until `done` holds, at most `seconds` long, one step a frame; false if it never did. */
function runUntil(game: Session, seconds: number, done: () => boolean) {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, idle, DT);
    cueEntities(game);
    if (done()) return true;
  }
  return false;
}

describe("sighting", () => {
  test("a wandering chaser that sees a player in range chases it", () => {
    const game = world();
    standAt(game, 500, 300);
    const zombie = chaserAt(game, 300, 300);
    run(game, DT);

    expect(stateOf(zombie)).toMatchObject({
      mode: "chase",
      target: { x: 500, y: 300 },
    });
    expect(zombie.vx).toBeCloseTo(config.chaseSpeed);
    expect(zombie.vy).toBeCloseTo(0);
  });

  test("a nearby player behind the chaser is seen", () => {
    const game = world(config, 70);
    standAt(game, 250, 300);
    const zombie = chaserAt(game, 300, 300);
    run(game, DT);

    expect(stateOf(zombie)).toMatchObject({
      mode: "chase",
      target: { x: 250, y: 300 },
    });
    expect(zombie.vx).toBeLessThan(0);
  });

  test("a player behind the chaser beyond its surroundings is not seen", () => {
    const game = world(config, 70);
    standAt(game, 200, 300);
    const zombie = chaserAt(game, 300, 300);
    run(game, DT);

    expect(stateOf(zombie).mode).toBe("wander");
  });

  test("a wall blocks nearby sight behind the chaser", () => {
    const game = world(config, 200);
    standAt(game, 175, 100);
    const zombie = chaserAt(game, 325, 100);
    run(game, DT);

    expect(stateOf(zombie).mode).toBe("wander");
  });

  test("zero sight range also disables nearby sight", () => {
    const game = world({ ...config, sightRange: 0 }, 70);
    standAt(game, 250, 300);
    const zombie = chaserAt(game, 300, 300);
    run(game, DT);

    expect(stateOf(zombie).mode).toBe("wander");
  });

  test("a player out of range is not seen", () => {
    const game = world();
    standAt(game, 650, 300);
    const zombie = chaserAt(game, 300, 300);
    run(game, 0.5);
    expect(stateOf(zombie).mode).toBe("wander");
  });

  test("a player behind a wall is not seen", () => {
    const game = world();
    standAt(game, 375, 100);
    const zombie = chaserAt(game, 125, 100);
    run(game, DT);
    expect(stateOf(zombie).mode).toBe("wander");
  });
});

describe("chasing", () => {
  test("runs a bit slower than a walking player", () => {
    expect(config.chaseSpeed).toBeLessThan(testSimConfig.player.speed);
  });

  test("chasers remain separated from players and one another", () => {
    const game = world();
    standAt(game, 500, 300);
    const first = chaserAt(game, 300, 300);
    const second = chaserAt(game, 300, 300);

    for (let step = 0; step < 240; step++) {
      updateSession(game, idle, DT);
      for (const [a, b] of [
        [game.local, first],
        [game.local, second],
        [first, second],
      ] as const) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
          a.radius + b.radius - 1e-2,
        );
      }
    }
  });

  test("plans anew only once the player moves meaningfully from the target", () => {
    const game = world();
    standAt(game, 600, 300);
    const zombie = chaserAt(game, 300, 300);
    run(game, DT);

    standAt(game, 600, 300 + config.repathDistance / 2);
    run(game, DT);
    expect(stateOf(zombie).target).toMatchObject({ x: 600, y: 300 });

    standAt(game, 600, 300 + config.repathDistance * 2);
    run(game, DT);
    expect(stateOf(zombie).target).toMatchObject({
      x: 600,
      y: 300 + config.repathDistance * 2,
    });
  });

  test("gives up where the player was last seen, then wanders", () => {
    const game = world();
    standAt(game, 300, 400);
    const zombie = chaserAt(game, 100, 400);
    run(game, DT);
    expect(stateOf(zombie).mode).toBe("chase");

    standAt(game, 875, 25);
    const gaveUp = runUntil(game, 3, () => stateOf(zombie).mode === "wander");
    expect(gaveUp).toBe(true);
    expect(zombie.x).toBeCloseTo(300, 0);
    expect(zombie.y).toBeCloseTo(400, 0);
    expect(stateOf(zombie)).toMatchObject({
      mode: "wander",
      route: [],
      target: null,
    });
  });

  test("a player sighted again before the chaser gives up keeps the chase", () => {
    const game = world();
    standAt(game, 300, 400);
    const zombie = chaserAt(game, 100, 400);
    run(game, DT);
    standAt(game, 875, 25);
    run(game, 0.5);
    standAt(game, 400, 400);
    run(game, DT);
    expect(stateOf(zombie)).toMatchObject({
      mode: "chase",
      target: { x: 400, y: 400 },
    });
  });
});

describe("wandering", () => {
  const blind = { ...config, sightRange: 0 };

  test("walks slowly from place to place, clear of the walls", () => {
    const game = world(blind);
    standAt(game, 100, 500);
    const zombie = chaserAt(game, 450, 300);
    let travelled = 0;
    let fastest = 0;
    for (let step = 0; step < 600; step++) {
      const { x, y } = zombie;
      updateSession(game, idle, DT);
      const moved = Math.hypot(zombie.x - x, zombie.y - y);
      travelled += moved;
      fastest = Math.max(fastest, moved / DT);
      expect(
        isAreaFree(game.world.map, zombie.x, zombie.y, config.radius),
      ).toBe(true);
    }
    expect(travelled).toBeGreaterThan(config.wanderSpeed);
    expect(fastest).toBeLessThanOrEqual(config.wanderSpeed + 1e-6);
    expect(stateOf(zombie).mode).toBe("wander");
  });

  test("the same seed walks the same way", () => {
    const walk = (seed: number) => {
      const game = world(blind);
      standAt(game, 100, 500);
      const zombie = chaserAt(game, 450, 300, seed);
      run(game, 6);
      return { x: zombie.x, y: zombie.y };
    };
    expect(walk(5)).toEqual(walk(5));
    expect(walk(5)).not.toEqual(walk(6));
  });
});

describe("sounds", () => {
  const blind = { ...config, sightRange: 0 };

  test("barks for the first time within its bark gap", () => {
    const { min, max } = config.barkGap;
    const game = world(blind);
    chaserAt(game, 450, 300);

    run(game, min - DT);
    expect(played(game)).toEqual([]);

    expect(runUntil(game, max - min, () => played(game).length > 0)).toBe(true);
    expect(played(game)).toEqual([barkUrl]);
  });

  test("alerts as it starts a chase", () => {
    const game = world();
    standAt(game, 500, 300);
    chaserAt(game, 300, 300);
    run(game, DT);
    expect(played(game)).toEqual([alertUrl]);
  });

  test("a large chaser can attack without overlapping its target", () => {
    const game = world({
      ...config,
      radius: Math.max(config.radius, testSimConfig.player.radius + 40),
    });
    standAt(game, 500, 300);
    const zombie = chaserAt(game, 300, 300);

    expect(runUntil(game, 3, () => played(game).includes(attackUrl))).toBe(
      true,
    );
    expect(
      Math.hypot(zombie.x - game.local.x, zombie.y - game.local.y),
    ).toBeGreaterThanOrEqual(zombie.radius + game.local.radius - 1e-5);
  });

  test("attacks on reaching its target, at most once per cooldown", () => {
    const game = world();
    standAt(game, 300, 400);
    chaserAt(game, 100, 400);
    const attacks = (): number =>
      played(game).filter((url) => url === attackUrl).length;

    expect(runUntil(game, 3, () => attacks() > 0)).toBe(true);
    run(game, config.attackCooldown - 0.1);
    expect(attacks()).toBe(1);
    run(game, 0.2);
    expect(attacks()).toBe(2);
  });

  test("many steps in one frame play each sound at most once", () => {
    const game = world(blind);
    const zombie = chaserAt(game, 450, 300);
    for (let step = 0; step < 30 / DT; step++) updateSession(game, idle, DT);
    expect(stateOf(zombie).barks).toBeGreaterThan(1);
    cueEntities(game);
    expect(played(game)).toEqual([barkUrl]);
    cueEntities(game);
    expect(played(game)).toHaveLength(1);
  });

  test("a client following snapshots hears what they change, from where it stands", () => {
    const host = world();
    standAt(host, 500, 300);
    chaserAt(host, 300, 300);
    const follower = world();
    follower.hosting = false;
    standAt(follower, 100, 500);
    applyEntitySnapshot(follower, entitySnapshot(host));
    cueEntities(follower);
    expect(played(follower)).toEqual([]);

    run(host, DT);
    applyEntitySnapshot(follower, entitySnapshot(host));
    cueEntities(follower);
    expect(played(follower)).toEqual([alertUrl]);
    expect(vi.mocked(follower.sfx.play).mock.calls[0]?.[2]).toBe(
      follower.local,
    );
  });

  test("each attack strikes the local player in range for its damage", () => {
    const game = world();
    standAt(game, 300, 400);
    chaserAt(game, 100, 400);
    const full = game.local.health;
    expect(runUntil(game, 3, () => game.local.health < full)).toBe(true);
    expect(game.local.health).toBe(full - config.attackDamage);
    expect(played(game)).toContain(attackUrl);
  });

  test("an attack on a remote player waits to be sent to it", () => {
    const game = world();
    standAt(game, 100, 100);
    applyRemoteState(game, {
      id: "them",
      name: "THEM",
      x: 300,
      y: 400,
      aim: 0,
      health: 100,
    });
    chaserAt(game, 100, 400);
    expect(runUntil(game, 3, () => game.strikes.length > 0)).toBe(true);
    expect(game.strikes).toEqual([
      { target: "them", amount: config.attackDamage },
    ]);
    expect(game.players.get("them")?.health).toBe(100);
  });
});
