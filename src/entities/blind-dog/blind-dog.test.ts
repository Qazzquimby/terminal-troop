import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  makeNoise,
  receiveEvent,
  registerContent,
  registerEntityType,
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
import {
  chargeEnd,
  freshBlindDog,
  blindDog as blindDogContent,
  BlindDogState,
  suspicionAt,
} from "./index.js";
import type { BlindDogConfig } from "./index.js";

const DT = 1 / 60;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  secondary: false,
  interact: false,
  drop: false,
  holdingUse: false,
};
const { blindDog: config } = testEntitiesConfig;

/** A noise to make in the next step, by whom. */
interface Pending {
  by: { readonly id: string };
  at: Point;
  radius: number;
}

/** The dev square, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550. */
function world(blindDog: BlindDogConfig = config): {
  game: Session;
  noise: (made: Pending) => void;
} {
  const game = createSession(
    "me",
    "ME",
    "HOUND",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  const pending: Pending[] = [];
  const noiser: WorldContent = {
    name: "move/noiser",
    register: () => undefined,
    populate: () => undefined,
    act(session) {
      for (const { by, at, radius } of pending.splice(0))
        makeNoise(session, by, { at, radius });
    },
  };
  registerContent(game, [blindDogContent.create({ blindDog }), noiser]);
  Object.assign(game.local, { x: 50, y: 575, prevX: 50, prevY: 575 });
  return { game, noise: (made) => pending.push(made) };
}

function blindDogAt(game: Session, x: number, y: number): WorldEntity {
  return spawnEntity(game, "blindDog", x, y, freshBlindDog(1, game.worldTime));
}

const stateOf = (entity: WorldEntity): BlindDogState =>
  BlindDogState.parse(entity.data);

function played(game: Session): string[] {
  return vi.mocked(game.sfx.play).mock.calls.map(([url]) => url);
}

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

describe("hearing", () => {
  test("a quiet noise makes it walk there, snarling, suspicious by how loud it was", () => {
    const { game, noise } = world();
    const hound = blindDogAt(game, 150, 300);
    noise({ by: game.local, at: { x: 450, y: 300 }, radius: 500 });
    run(game, DT);

    const state = stateOf(hound);
    expect(state.mode).toBe("stalk");
    expect(suspicionAt(state, game.worldTime, config)).toBeCloseTo(200, 0);
    expect(Math.hypot(hound.vx, hound.vy)).toBeCloseTo(config.stalkSpeed);
    expect(hound.vx).toBeGreaterThan(0);
    expect(played(game).some((url) => url.endsWith("snarl.mp3"))).toBe(true);
  });

  test("its own kind's noise goes unheard", () => {
    const { game, noise } = world();
    const hound = blindDogAt(game, 150, 300);
    const other = blindDogAt(game, 700, 150);
    noise({ by: other, at: { x: 450, y: 300 }, radius: 2000 });
    run(game, DT);

    expect(stateOf(hound)).toMatchObject({ mode: "wander", suspicion: 0 });
  });

  test("suspicion ebbs over time", () => {
    const { game, noise } = world();
    const hound = blindDogAt(game, 150, 300);
    noise({ by: game.local, at: { x: 450, y: 300 }, radius: 800 });
    run(game, DT);
    const state = stateOf(hound);
    expect(suspicionAt(state, game.worldTime + 1, config)).toBeCloseTo(
      500 - config.suspicion.decay,
      0,
    );
    expect(suspicionAt(state, game.worldTime + 60, config)).toBe(0);
  });

  test("several quieter noises add up to a charge", () => {
    const { game, noise } = world();
    const hound = blindDogAt(game, 150, 300);
    for (let i = 0; i < 2; i++) {
      noise({ by: game.local, at: { x: 450, y: 300 }, radius: 700 });
      run(game, DT);
      expect(stateOf(hound).mode).toBe("stalk");
    }
    noise({ by: game.local, at: { x: 450, y: 300 }, radius: 700 });
    run(game, DT);
    expect(stateOf(hound).mode).toBe("charge");
  });
});

describe("charging", () => {
  test("a big noise makes it roar and run at and on past it, at its charging speed", () => {
    const { game, noise } = world();
    const hound = blindDogAt(game, 150, 300);
    noise({ by: game.local, at: { x: 450, y: 300 }, radius: 1500 });
    run(game, DT);

    const state = stateOf(hound);
    expect(state.mode).toBe("charge");
    expect(played(game).some((url) => url.endsWith("roar.mp3"))).toBe(true);
    expect(Math.hypot(hound.vx, hound.vy)).toBeCloseTo(config.chargeSpeed);
    expect(state.route.at(-1)?.x).toBeGreaterThan(700);
  });

  test("a charge runs the overrun past the noise, short of the first wall", () => {
    const map = createSession("me", "ME", "C", "dev", testSfx(), testSimConfig)
      .world.map;
    const open = chargeEnd(
      map,
      20,
      { x: 100, y: 300 },
      { x: 300, y: 300 },
      200,
    );
    expect(open.x).toBeCloseTo(500);
    const walled = chargeEnd(
      map,
      config.radius,
      { x: 150, y: 300 },
      { x: 450, y: 300 },
      config.overrun,
    );
    expect(walled.x).toBeLessThanOrEqual(900 - config.radius);
    expect(walled.x).toBeGreaterThan(900 - config.radius - 13);
  });

  test("steers for each new noise as it runs, and once there settles, its suspicion spent", () => {
    const { game, noise } = world();
    const hound = blindDogAt(game, 150, 300);
    noise({ by: game.local, at: { x: 450, y: 300 }, radius: 1500 });
    run(game, DT);
    noise({ by: game.local, at: { x: 450, y: 520 }, radius: 1500 });
    run(game, DT);
    expect(hound.vy).toBeGreaterThan(0);

    run(game, 4);
    const state = stateOf(hound);
    expect(state.mode).toBe("wander");
    expect(state.suspicion).toBe(0);
  });
});

describe("biting", () => {
  test("whatever it touches loses 100 health, at most once a cooldown", () => {
    const { game } = world();
    const hound = blindDogAt(game, 450, 300);
    const other = blindDogAt(game, 450 - config.radius * 2 - 1, 300);
    Object.assign(game.local, {
      x: 450 + config.radius + 14,
      y: 300,
      prevX: 450 + config.radius + 14,
      prevY: 300,
    });
    run(game, DT);

    expect(game.local.health).toBe(
      testSimConfig.player.maxHealth - config.contactDamage,
    );
    expect(stateOf(hound).biting).toBe(true);
    expect(other.health).toBe(config.maxHealth);
    expect(played(game).some((url) => url.endsWith("bite.mp3"))).toBe(true);

    run(game, config.contactCooldown / 2);
    expect(stateOf(hound).biting).toBe(false);
  });

  test("it bites any body it touches but the kinds it ignores", () => {
    const { game } = world({ ...config, ignores: ["blindDog", "rock"] });
    const body = { radius: 10, data: z.object({}), draw: () => undefined };
    registerEntityType(game, "deer", { ...body, maxHealth: 1000 });
    registerEntityType(game, "rock", { ...body, maxHealth: 1000 });
    blindDogAt(game, 450, 300);
    const deer = spawnEntity(game, "deer", 450 + config.radius + 10, 300, {});
    const rock = spawnEntity(game, "rock", 450 - config.radius - 10, 300, {});
    run(game, DT);
    expect(deer.health).toBe(1000 - config.contactDamage);
    expect(rock.health).toBe(1000);
  });

  test("a stunned one neither moves nor bites", () => {
    const { game, noise } = world();
    const hound = blindDogAt(game, 450, 300);
    stun(game, hound.id, 5);
    Object.assign(game.local, { x: 450 + config.radius + 14, y: 300 });
    noise({ by: game.local, at: { x: 750, y: 300 }, radius: 1500 });
    run(game, 0.5);
    expect(game.local.health).toBe(testSimConfig.player.maxHealth);
    expect(hound.x).toBe(450);
  });
});
