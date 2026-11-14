import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import alertUrl from "./sfx/alert.mp3";
import attackUrl from "./sfx/attack.mp3";
import barkUrl from "./sfx/bark.mp3";
import { reportedAt } from "../../integration/heard.js";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  applyEntitySnapshot,
  createSession,
  entitySnapshot,
  INERT_TAG,
  isAreaFree,
  receiveEvent,
  registerContent,
  registerEntityType,
  spawnEntity,
  takeWorldEntries,
  updateSession,
} from "../../sim/index.js";
import type { Session, WorldEntity } from "../../sim/index.js";
import type { ZombieConfig } from "./index.js";
import { ZombieState, zombie as zombieContent, freshZombie } from "./index.js";

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
const { zombie: config } = testEntitiesConfig;

/** The sounds a session's zombies have played, oldest first. */
function played(game: Session): string[] {
  return vi.mocked(game.sfx.play).mock.calls.map(([url]) => url);
}

/** The dev square, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550. */
function world(
  zombie: ZombieConfig = config,
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
  registerContent(game, [zombieContent.create({ zombie })]);
  return game;
}

function standAt(game: Session, x: number, y: number): void {
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
}

function zombieAt(game: Session, x: number, y: number, seed = 1): WorldEntity {
  return spawnEntity(
    game,
    "zombie",
    x,
    y,
    freshZombie(seed, game.worldTime, config),
  );
}

const stateOf = (entity: WorldEntity): ZombieState =>
  ZombieState.parse(entity.data);

/**
 * Hands each event `from` sent to `to`, as the room does, and applies them there at once:
 * sent by the host, which `from` is.
 */
function deliver(from: Session, to: Session = from): void {
  for (const { content, event, to: target, payload } of from.outbox.splice(0))
    receiveEvent(
      to,
      { from: from.localId, to: target, content, event, payload },
      from.localId,
    );
  for (const { event, payload, sender } of to.inbox.splice(0))
    event.receive(to, payload, sender);
}

/** Steps `seconds`, one step a frame, each sound the host sends heard at once. */
function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, idle, DT);
    deliver(game);
  }
}

/** Steps until `done` holds, at most `seconds` long, one step a frame; false if it never did. */
function runUntil(game: Session, seconds: number, done: () => boolean) {
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, idle, DT);
    deliver(game);
    if (done()) return true;
  }
  return false;
}

describe("sighting", () => {
  test("a wandering zombie that sees a player in range chases it", () => {
    const game = world();
    standAt(game, 500, 300);
    const zombie = zombieAt(game, 300, 300);
    run(game, DT);

    expect(stateOf(zombie)).toMatchObject({
      mode: "chase",
      target: { x: 500, y: 300 },
    });
    expect(zombie.vx).toBeCloseTo(config.chaseSpeed);
    expect(zombie.vy).toBeCloseTo(0);
  });

  test("a nearby player behind the zombie is seen", () => {
    const game = world(config, 70);
    standAt(game, 250, 300);
    const zombie = zombieAt(game, 300, 300);
    run(game, DT);

    expect(stateOf(zombie)).toMatchObject({
      mode: "chase",
      target: { x: 250, y: 300 },
    });
    expect(zombie.vx).toBeLessThan(0);
  });

  test("a player behind the zombie beyond its surroundings is not seen", () => {
    const game = world(config, 70);
    standAt(game, 200, 300);
    const zombie = zombieAt(game, 300, 300);
    run(game, DT);

    expect(stateOf(zombie).mode).toBe("wander");
  });

  test("a wall blocks nearby sight behind the zombie", () => {
    const game = world(config, 200);
    standAt(game, 175, 100);
    const zombie = zombieAt(game, 325, 100);
    run(game, DT);

    expect(stateOf(zombie).mode).toBe("wander");
  });

  test("zero sight range also disables nearby sight", () => {
    const game = world({ ...config, sightRange: 0 }, 70);
    standAt(game, 250, 300);
    const zombie = zombieAt(game, 300, 300);
    run(game, DT);

    expect(stateOf(zombie).mode).toBe("wander");
  });

  test("a player out of range is not seen", () => {
    const game = world();
    standAt(game, 650, 300);
    const zombie = zombieAt(game, 300, 300);
    run(game, 0.5);
    expect(stateOf(zombie).mode).toBe("wander");
  });

  test("a player behind a wall is not seen", () => {
    const game = world();
    standAt(game, 375, 100);
    const zombie = zombieAt(game, 125, 100);
    run(game, DT);
    expect(stateOf(zombie).mode).toBe("wander");
  });
});

describe("chasing", () => {
  test("runs a bit slower than a walking player", () => {
    expect(config.chaseSpeed).toBeLessThan(testSimConfig.player.speed);
  });

  test("zombies remain separated from players and one another", () => {
    const game = world();
    standAt(game, 500, 300);
    const first = zombieAt(game, 300, 300);
    const second = zombieAt(game, 300, 300);

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
    const zombie = zombieAt(game, 300, 300);
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
    const zombie = zombieAt(game, 100, 400);
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

  test("a player sighted again before the zombie gives up keeps the chase", () => {
    const game = world();
    standAt(game, 300, 400);
    const zombie = zombieAt(game, 100, 400);
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
    const zombie = zombieAt(game, 450, 300);
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
      const zombie = zombieAt(game, 450, 300, seed);
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
    zombieAt(game, 450, 300);

    run(game, min - DT);
    expect(played(game)).toEqual([]);

    expect(runUntil(game, max - min, () => played(game).length > 0)).toBe(true);
    expect(played(game)).toEqual([barkUrl]);
  });

  test("alerts as it starts a chase", () => {
    const game = world();
    standAt(game, 500, 300);
    zombieAt(game, 300, 300);
    run(game, DT);
    expect(played(game)).toEqual([alertUrl]);
  });

  test("a large zombie can attack without overlapping its target", () => {
    const game = world({
      ...config,
      radius: Math.max(config.radius, testSimConfig.player.radius + 40),
    });
    standAt(game, 500, 300);
    const zombie = zombieAt(game, 300, 300);

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
    zombieAt(game, 100, 400);
    const attacks = (): number =>
      played(game).filter((url) => url === attackUrl).length;

    expect(runUntil(game, 3, () => attacks() > 0)).toBe(true);
    run(game, config.attackCooldown - 0.1);
    expect(attacks()).toBe(1);
    run(game, 0.2);
    expect(attacks()).toBe(2);
  });

  test("a client following the host's snapshots alone sounds nothing", () => {
    const host = world(blind);
    zombieAt(host, 450, 300);
    const follower = world(blind);
    follower.hosting = false;
    for (let step = 0; step < config.barkGap.max / DT; step++) {
      updateSession(host, idle, DT);
      deliver(host);
      applyEntitySnapshot(follower, entitySnapshot(host));
      updateSession(follower, idle, DT);
    }
    expect(played(host)).toContain(barkUrl);
    // It sends the host only what its own player steers with.
    expect(follower.outbox.map(({ content }) => content)).not.toContain(
      "core/actions",
    );
    expect(played(follower)).toEqual([]);
  });

  test("a client following the host hears what its zombies do, from where it stands", () => {
    const host = world();
    standAt(host, 500, 300);
    zombieAt(host, 300, 300);
    const follower = world();
    follower.hosting = false;
    standAt(follower, 100, 500);
    applyEntitySnapshot(follower, entitySnapshot(host));
    deliver(host, follower);
    expect(played(follower)).toEqual([]);

    updateSession(host, idle, DT);
    applyEntitySnapshot(follower, entitySnapshot(host));
    expect(played(follower)).toEqual([]);
    deliver(host, follower);
    expect(played(follower)).toEqual([alertUrl]);
    expect(vi.mocked(follower.sfx.play).mock.calls[0]?.[2]).toBe(
      follower.local,
    );
  });

  test("each attack strikes the local player in range for its damage", () => {
    const game = world();
    standAt(game, 300, 400);
    zombieAt(game, 100, 400);
    const full = game.local.health;
    expect(runUntil(game, 3, () => game.local.health < full)).toBe(true);
    expect(game.local.health).toBe(full - config.attackDamage);
    expect(played(game)).toContain(attackUrl);
  });

  test("an attack on a remote player comes off the host's record of its health", () => {
    const game = world();
    standAt(game, 100, 100);
    reportedAt(game, "them", { x: 300, y: 400 });
    zombieAt(game, 100, 400);
    const them = () => game.players.get("them")?.health;
    expect(runUntil(game, 3, () => them() !== 100)).toBe(true);
    expect(them()).toBe(100 - config.attackDamage);
    expect(game.outbox).toEqual([]);
    expect(takeWorldEntries(game, false)).toMatchObject({
      "core/health.players": [1, { them: 100 - config.attackDamage }],
    });
  });
});

describe("hearing", () => {
  const blind = { ...config, sightRange: 0 };
  const { footsteps } = testSimConfig;

  /**
   * A remote player at (x, y), steering right in `mode` into another that stands just right of
   * it, so the host runs it moving in that gait where it stands; its next step makes a footstep.
   */
  function moverAt(
    game: Session,
    x: number,
    y: number,
    mode: "walk" | "sprint" | "crouch",
  ): void {
    const diameter = testSimConfig.player.radius * 2;
    reportedAt(game, "post", { x: x + diameter, y });
    const them = reportedAt(game, "them", { x, y });
    receiveEvent(
      game,
      {
        from: "them",
        to: null,
        content: "core/steering",
        event: "steer",
        payload: {
          step: 0,
          move: { x: 1, y: 0 },
          sprint: mode === "sprint",
          held: null,
          ...(mode === "crouch" && { crouch: true }),
        },
      },
      game.localId,
    );
    // The host runs the player a few steps behind the first it hears.
    run(game, 0.2);
    expect(them.x).toBeCloseTo(x, 0);
    them.stride = 0;
  }

  const distanceTo = (zombie: WorldEntity, x: number, y: number): number =>
    Math.hypot(zombie.x - x, zombie.y - y);

  test("a wandering zombie turns towards a player sprinting within the sprint radius, placing it roughly", () => {
    expect(footsteps.sprint.radius).toBeGreaterThan(300);
    const game = world(blind);
    standAt(game, 100, 500);
    moverAt(game, 750, 300, "sprint");
    const zombie = zombieAt(game, 450, 300);
    run(game, DT);

    const state = stateOf(zombie);
    if (state.mode !== "wander" || state.noiseTarget === null)
      throw new Error("heard nothing");
    const { noiseTarget } = state;
    const spread = 300 * testSimConfig.noise.blur;
    expect(
      Math.hypot(noiseTarget.x - 750, noiseTarget.y - 300),
    ).toBeLessThanOrEqual(spread);
    expect(zombie.vx).toBeGreaterThan(0);

    run(game, 2);
    expect(distanceTo(zombie, 750, 300)).toBeLessThan(300 - 80);
  });

  test("a bark is heard as far as its sound carries, tagged as a zombie's, and other zombies ignore it", () => {
    const game = world(blind);
    standAt(game, 100, 500);
    const barker = zombieAt(game, 450, 300, 1);
    const listener = zombieAt(game, 450 + config.sounds.bark / 2, 300, 2);
    barker.data = { ...stateOf(barker), barkAt: game.worldTime };
    listener.data = { ...stateOf(listener), barkAt: game.worldTime + 100 };
    const barked = runUntil(game, 0.2, () =>
      game.noises.some(({ source }) => source === barker.id),
    );
    expect(barked).toBe(true);
    expect(game.noises).toEqual([
      {
        at: { x: 450, y: 300 },
        radius: config.sounds.bark,
        source: barker.id,
        tags: ["zombie"],
      },
    ]);
    expect(stateOf(listener)).toMatchObject({ noiseTarget: null });
  });

  test("a player walking beyond the walk radius is not heard", () => {
    expect(footsteps.walk.radius).toBeLessThan(300);
    const game = world(blind);
    standAt(game, 100, 500);
    moverAt(game, 750, 300, "walk");
    const zombie = zombieAt(game, 450, 300);
    run(game, 2);
    expect(stateOf(zombie)).toMatchObject({ noiseTarget: null });
  });

  test("a player crouching beyond the crouch radius, where its walking is heard, goes unheard", () => {
    expect(footsteps.crouch.radius).toBeLessThan(120);
    expect(footsteps.walk.radius).toBeGreaterThan(120);
    const heard = (mode: "walk" | "crouch"): boolean => {
      const game = world(blind);
      standAt(game, 100, 500);
      moverAt(game, 570, 300, mode);
      const zombie = zombieAt(game, 450, 300);
      return runUntil(game, 1, () => {
        const state = stateOf(zombie);
        return state.mode === "wander" && state.noiseTarget !== null;
      });
    };
    expect(heard("walk")).toBe(true);
    expect(heard("crouch")).toBe(false);
  });

  test("standing at the noise, it forgets it and wanders on", () => {
    const game = world(blind);
    standAt(game, 100, 500);
    moverAt(game, 600, 300, "sprint");
    const zombie = zombieAt(game, 450, 300);
    run(game, DT);
    expect(stateOf(zombie)).not.toMatchObject({ noiseTarget: null });

    game.players.delete("them");
    game.players.delete("post");
    run(game, 5);
    expect(stateOf(zombie)).toMatchObject({
      mode: "wander",
      noiseTarget: null,
    });
  });

  test("sight overrides hearing", () => {
    const game = world();
    standAt(game, 450, 450);
    moverAt(game, 650, 300, "sprint");
    const zombie = zombieAt(game, 450, 300);
    Object.assign(zombie, {
      data: { ...stateOf(zombie), facing: Math.PI / 2 },
    });
    run(game, DT);
    expect(stateOf(zombie)).toMatchObject({
      mode: "chase",
      target: { x: 450, y: 450 },
    });
  });
});

describe("prey", () => {
  /** The world with a living kind, "deer", and one tagged inert, "mine", besides zombies. */
  function wild(): Session {
    const game = world();
    const body = { radius: 10, data: z.object({}), draw: () => undefined };
    registerEntityType(game, "deer", { ...body, maxHealth: 100 });
    registerEntityType(game, "mine", {
      ...body,
      maxHealth: 100,
      tags: [INERT_TAG],
    });
    // Far past the zombie's sight, so only what is placed near it draws it.
    standAt(game, 750, 50);
    return game;
  }

  test("chases and strikes any living thing it sees, not just players", () => {
    const game = wild();
    const deer = spawnEntity(game, "deer", 400, 400, {});
    const zombie = zombieAt(game, 200, 400);
    run(game, DT);
    expect(stateOf(zombie)).toMatchObject({
      mode: "chase",
      target: { x: 400, y: 400 },
    });

    expect(runUntil(game, 3, () => deer.health < deer.maxHealth)).toBe(true);
    expect(deer.health).toBe(deer.maxHealth - config.attackDamage);
    expect(played(game)).toContain(attackUrl);
  });

  test("passes over other zombies and things tagged inert", () => {
    const game = wild();
    const mine = spawnEntity(game, "mine", 300, 400, {});
    const other = zombieAt(game, 350, 400, 2);
    Object.assign(other, { data: { ...stateOf(other), barkAt: 1e6 } });
    const zombie = zombieAt(game, 200, 400);
    run(game, 1);
    expect(stateOf(zombie).mode).toBe("wander");
    expect(mine.health).toBe(mine.maxHealth);
    expect(other.health).toBe(other.maxHealth);
  });
});
