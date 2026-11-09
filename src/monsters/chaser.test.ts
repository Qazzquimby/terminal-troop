import { describe, expect, test, vi } from "vitest";
import alertUrl from "../assets/sfx/zombie/alert.mp3";
import attackUrl from "../assets/sfx/zombie/attack.mp3";
import barkUrl from "../assets/sfx/zombie/bark.mp3";
import {
  testMonsterConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import {
  createSession,
  isAreaFree,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import type { Session, WorldEntity } from "../sim/index.js";
import type { ChaserConfig } from "./chaser.js";
import { ChaserState, freshChaser } from "./chaser.js";
import { MonsterKind, createMonsters } from "./index.js";

const DT = 1 / 60;
const idle = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, sprint: false };
const { chaser: config } = testMonsterConfig;

/** The sounds a session's chasers have played, oldest first. */
function played(game: Session): string[] {
  return vi.mocked(game.sfx.play).mock.calls.map(([url]) => url);
}

/** The dev square, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550. */
function world(chaser: ChaserConfig = config): Session {
  const game = createSession(
    "me",
    "ME",
    "CHASE",
    "dev",
    testSfx(),
    testSimConfig,
  );
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
  return spawnEntity(game, MonsterKind.CHASER, x, y, freshChaser(seed));
}

const stateOf = (entity: WorldEntity): ChaserState =>
  ChaserState.parse(entity.data);

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, idle, DT);
  }
}

/** Steps until `done` holds, at most `seconds` long; false if it never did. */
function runUntil(game: Session, seconds: number, done: () => boolean) {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, idle, DT);
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

  test("plans anew only once the player moves meaningfully from the target", () => {
    const game = world();
    standAt(game, 600, 300);
    const zombie = chaserAt(game, 300, 300);
    run(game, DT);

    standAt(game, 600, 300 + config.repathDistance / 2);
    run(game, DT);
    expect(stateOf(zombie)).toMatchObject({ target: { x: 600, y: 300 } });

    standAt(game, 600, 300 + config.repathDistance * 2);
    run(game, DT);
    expect(stateOf(zombie)).toMatchObject({
      target: { x: 600, y: 300 + config.repathDistance * 2 },
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
    expect(stateOf(zombie)).toMatchObject({ mode: "wander", route: [] });
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

  test("barks for the first time after 8 to 16 seconds", () => {
    const game = world(blind);
    chaserAt(game, 450, 300);

    run(game, 8 - DT);
    expect(played(game)).toEqual([]);

    expect(runUntil(game, 8, () => played(game).length > 0)).toBe(true);
    expect(played(game)).toEqual([barkUrl]);
  });

  test("alerts as it starts a chase", () => {
    const game = world();
    standAt(game, 500, 300);
    chaserAt(game, 300, 300);
    run(game, DT);
    expect(played(game)).toEqual([alertUrl]);
  });

  test("attacks on reaching its target, at most every 2 seconds", () => {
    const game = world();
    standAt(game, 300, 400);
    chaserAt(game, 100, 400);
    const attacks = (): number =>
      played(game).filter((url) => url === attackUrl).length;

    expect(runUntil(game, 3, () => attacks() > 0)).toBe(true);
    run(game, 1.9);
    expect(attacks()).toBe(1);
    run(game, 0.2);
    expect(attacks()).toBe(2);
  });
});
