import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  ITEM_TAG,
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
  dashEnd,
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

type Cue = keyof BlindDogConfig["sounds"];

/** Each of its sounds' files. */
const files: Record<Cue, string> = {
  roar: "roar.ogg",
  snarl: "growl.ogg",
  bite: "bite.wav",
  huff: "huff.mp3",
  growl: "growl.mp3",
  pounce: "lunge.wav",
  skid: "skid.mp3",
  bark: "breathe.wav",
};

/** How many times its `cue` has played. */
function played(game: Session, cue: Cue): number {
  return vi
    .mocked(game.sfx.play)
    .mock.calls.filter(([url]) => url.endsWith(`/blind-dog/sfx/${files[cue]}`))
    .length;
}

/** Whether its `cue` has played. */
const sounded = (game: Session, cue: Cue): boolean => played(game, cue) > 0;

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
    expect(sounded(game, "snarl")).toBe(true);
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
    // Past its pounce reach, however its hearing places the noise.
    const { game, noise } = world();
    const hound = blindDogAt(game, 150, 300);
    for (let i = 0; i < 2; i++) {
      noise({ by: game.local, at: { x: 500, y: 300 }, radius: 700 });
      run(game, DT);
      expect(stateOf(hound).mode).toBe("stalk");
    }
    noise({ by: game.local, at: { x: 500, y: 300 }, radius: 700 });
    run(game, DT);
    expect(stateOf(hound).mode).toBe("charge");
  });
});

describe("charging", () => {
  test("a big noise beyond its reach makes it roar and run there, at its charging speed", () => {
    const { game, noise } = world();
    const hound = blindDogAt(game, 100, 300);
    noise({ by: game.local, at: { x: 800, y: 300 }, radius: 2000 });
    run(game, DT);

    const state = stateOf(hound);
    expect(state.mode).toBe("charge");
    expect(sounded(game, "roar")).toBe(true);
    expect(Math.hypot(hound.vx, hound.vy)).toBeCloseTo(config.chargeSpeed);
    // Where it heard the noise, as near as a blind dog's ears tell it.
    const end = state.route.at(-1) ?? { x: 0, y: 0 };
    expect(Math.hypot(end.x - 800, end.y - 300)).toBeLessThan(50);
  });

  test("a dash runs its length, short of the first wall", () => {
    const map = createSession("me", "ME", "C", "dev", testSfx(), testSimConfig)
      .world.map;
    const open = dashEnd(map, 20, { x: 100, y: 300 }, 0, 400);
    expect(open.x).toBeCloseTo(500);
    expect(open.y).toBeCloseTo(300);
    const walled = dashEnd(
      map,
      config.radius,
      { x: 150, y: 300 },
      0,
      300 + config.overrun,
    );
    expect(walled.x).toBeLessThanOrEqual(900 - config.radius);
    expect(walled.x).toBeGreaterThan(900 - config.radius - 7);
  });

  test("steers for each new noise as it runs, and once it has pounced settles, its suspicion spent", () => {
    const { game, noise } = world();
    const hound = blindDogAt(game, 100, 300);
    noise({ by: game.local, at: { x: 800, y: 300 }, radius: 2000 });
    run(game, DT);
    noise({ by: game.local, at: { x: 450, y: 520 }, radius: 1500 });
    run(game, DT);
    expect(stateOf(hound).mode).toBe("charge");
    expect(hound.vy).toBeGreaterThan(0);

    run(game, 4);
    const state = stateOf(hound);
    expect(state.mode).toBe("wander");
    expect(state.suspicion).toBe(0);
  });
});

describe("pouncing", () => {
  /** Steps until it is in `mode`, at most `seconds`; each step's spot, in order. */
  function until(
    game: Session,
    hound: WorldEntity,
    mode: BlindDogState["mode"],
    seconds = 5,
  ): Point[] {
    const path: Point[] = [];
    for (let t = 0; t < seconds && stateOf(hound).mode !== mode; t += DT) {
      run(game, DT);
      path.push({ x: hound.x, y: hound.y });
    }
    expect(stateOf(hound).mode).toBe(mode);
    return path;
  }

  /** How far `at` is off the line through `from` and `to`. */
  function offLine(at: Point, from: Point, to: Point): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return (
      Math.abs((at.x - from.x) * dy - (at.y - from.y) * dx) / Math.hypot(dx, dy)
    );
  }

  const gap = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

  /** A hound at (150, 300) crouched to pounce at a big noise at (350, 300). */
  function crouched(): {
    game: Session;
    noise: (made: Pending) => void;
    hound: WorldEntity;
  } {
    const { game, noise } = world();
    const hound = blindDogAt(game, 150, 300);
    noise({ by: game.local, at: { x: 350, y: 300 }, radius: 1500 });
    run(game, DT);
    expect(stateOf(hound).mode).toBe("crouch");
    return { game, noise, hound };
  }

  test("within reach it crouches, growling and still, facing its target, then leaps with a roar", () => {
    const { game, hound } = crouched();
    const state = stateOf(hound);
    expect(state.facing).toBeCloseTo(0, 1);
    expect(Math.hypot(hound.vx, hound.vy)).toBe(0);
    expect(sounded(game, "growl")).toBe(true);
    expect(sounded(game, "pounce")).toBe(false);

    run(game, config.pounce.windup / 2);
    expect(stateOf(hound).mode).toBe("crouch");
    expect(hound.x).toBe(150);

    until(game, hound, "pounce", config.pounce.windup);
    run(game, DT);
    expect(Math.hypot(hound.vx, hound.vy)).toBeCloseTo(config.pounce.speed);
    expect(sounded(game, "pounce")).toBe(true);
  });

  test("it dashes in a straight line through its target and the overrun past it, then skids", () => {
    const { game, hound } = crouched();
    const start = { x: hound.x, y: hound.y };
    const { heard, dash } = stateOf(hound);
    if (heard === null || dash === null) throw new Error("no target");
    expect(gap(start, dash.to)).toBeCloseTo(
      gap(start, heard) + config.overrun,
      0,
    );

    const path = until(game, hound, "skid");
    for (const at of path)
      expect(offLine(at, start, dash.to)).toBeLessThan(0.01);
    // It gets there, then starts to skid on.
    expect(gap(hound, dash.to)).toBeLessThan(config.pounce.speed * DT);
    expect(sounded(game, "skid")).toBe(true);

    until(game, hound, "wander", config.pounce.recover + 0.1);
    expect(gap(start, hound)).toBeGreaterThan(gap(start, dash.to));
    expect(stateOf(hound).suspicion).toBe(0);
  });

  test("it does not steer for a noise it hears mid-dash", () => {
    const { game, noise, hound } = crouched();
    const start = { x: hound.x, y: hound.y };
    until(game, hound, "pounce");
    const { dash } = stateOf(hound);
    if (dash === null) throw new Error("no dash");

    noise({ by: game.local, at: { x: 450, y: 560 }, radius: 1500 });
    const path = until(game, hound, "skid");
    for (const at of path)
      expect(offLine(at, start, dash.to)).toBeLessThan(0.01);
    expect(stateOf(hound).dash?.to).toEqual(dash.to);
  });

  test("a wall stops it short", () => {
    const { game, noise } = world();
    const hound = blindDogAt(game, 300, 300);
    noise({ by: game.local, at: { x: 550, y: 300 }, radius: 1500 });
    run(game, DT);
    expect(stateOf(hound).mode).toBe("crouch");

    until(game, hound, "skid");
    expect(hound.x).toBeLessThanOrEqual(900 - config.radius);
    expect(hound.x).toBeGreaterThan(900 - config.radius - 10);
    until(game, hound, "wander", config.pounce.recover + 0.1);
    expect(hound.x).toBeLessThanOrEqual(900 - config.radius);
  });

  test("it bites a body in its path once, and passes by one beside it", () => {
    const { game, noise } = world();
    const body = { radius: 10, data: z.object({}), draw: () => undefined };
    registerEntityType(game, "deer", { ...body, maxHealth: 10_000 });
    const hound = blindDogAt(game, 150, 300);
    const inPath = spawnEntity(game, "deer", 500, 310, {});
    const beside = spawnEntity(game, "deer", 500, 300 + config.radius + 40, {});
    noise({ by: game.local, at: { x: 350, y: 300 }, radius: 1500 });
    run(game, DT);
    until(game, hound, "skid");

    expect(inPath.health).toBe(10_000 - config.contactDamage);
    expect(beside.health).toBe(10_000);
  });

  test("it pounces at the body making a noise within lunge range, through and past it", () => {
    const { game, noise } = world();
    const body = { radius: 10, data: z.object({}), draw: () => undefined };
    registerEntityType(game, "deer", { ...body, maxHealth: 10_000 });
    const hound = blindDogAt(game, 150, 300);
    const deer = spawnEntity(game, "deer", 330, 300, {});
    noise({ by: deer, at: { x: 330, y: 300 }, radius: 300 });
    run(game, DT);
    const { mode, dash } = stateOf(hound);
    expect(mode).toBe("crouch");
    // Straight at the body itself, not where its noise seemed to be.
    expect(dash?.to).toEqual({ x: 330 + config.overrun, y: 300 });

    until(game, hound, "skid");
    // Through the body, not shoving it along.
    expect(hound.x).toBeGreaterThan(
      330 + config.overrun - config.pounce.speed * DT,
    );
    expect(deer.x).toBeCloseTo(330, 0);
    expect(deer.health).toBe(10_000 - config.contactDamage);
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
    expect(stateOf(hound).bites).toEqual([game.local.id]);
    expect(other.health).toBe(config.maxHealth);
    expect(sounded(game, "bite")).toBe(true);

    run(game, config.contactCooldown / 2);
    expect(stateOf(hound).bites).toEqual([]);
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

describe("a noise that goes on", () => {
  /** Steps `seconds`, `by` making a noise where it stands every half second. */
  function keepsUp(
    game: Session,
    noise: (made: Pending) => void,
    by: WorldEntity,
    seconds: number,
  ): void {
    for (let t = 0; t < seconds; t += 0.5) {
      noise({ by, at: { x: by.x, y: by.y }, radius: 1500 });
      run(game, 0.5);
    }
  }

  test("it pounces through the body making it and bites it, again and again", () => {
    const { game, noise } = world();
    registerEntityType(game, "deer", {
      radius: 10,
      maxHealth: 10_000,
      data: z.object({}),
      draw: () => undefined,
    });
    const hound = blindDogAt(game, 150, 300);
    const deer = spawnEntity(game, "deer", 450, 300, {});
    keepsUp(game, noise, deer, 10);

    // A pounce, a skid, a turn and back: about one bite every 3 seconds.
    expect(deer.health).toBeLessThanOrEqual(10_000 - config.contactDamage * 3);
    expect(stateOf(hound).bored).toBeNull();
  });

  test("what it cannot bite, it gives up on after its patience, huffing, and pays no mind a while", () => {
    const { game, noise } = world();
    registerEntityType(game, "radio", {
      radius: 8,
      maxHealth: 1,
      tags: [ITEM_TAG],
      data: z.object({}),
      draw: () => undefined,
    });
    const hound = blindDogAt(game, 150, 300);
    const radio = spawnEntity(game, "radio", 450, 300, {});
    keepsUp(game, noise, radio, config.patience + 3);

    const bored = stateOf(hound);
    expect(bored.bored?.id).toBe(radio.id);
    expect(bored.mode).toBe("wander");
    expect(suspicionAt(bored, game.worldTime, config)).toBe(0);
    expect(radio.health).toBe(1);
    expect(sounded(game, "huff")).toBe(true);

    keepsUp(game, noise, radio, 3);
    expect(stateOf(hound)).toMatchObject({ mode: "wander", source: null });

    // Once its boredom is over, it turns to the noise again.
    const until = bored.bored?.until ?? 0;
    keepsUp(game, noise, radio, until - game.worldTime + 1);
    expect(stateOf(hound).source).toBe(radio.id);
  });
});

describe("barking", () => {
  const barker: BlindDogConfig = { ...config, barkGap: { min: 0.5, max: 0.5 } };
  const barks = (game: Session): number => played(game, "bark");

  test("it barks now and then as it roams, a gap after it arrives, making a noise", () => {
    const { game } = world(barker);
    const hound = blindDogAt(game, 150, 300);
    run(game, 0.3);
    expect(barks(game)).toBe(0);
    run(game, 0.3);
    expect(barks(game)).toBe(1);
    run(game, 0.5);
    expect(barks(game)).toBe(2);
    expect(stateOf(hound).mode).toBe("wander");
  });

  test("its bark is a noise other kinds hear, but other blind dogs pay no mind", () => {
    const { game } = world(barker);
    const hound = blindDogAt(game, 150, 300);
    const other = blindDogAt(game, 450, 300);
    for (let step = 0; step < 60 && game.noises.length === 0; step++)
      run(game, DT);
    const made = game.noises.find((noise) => noise.source === hound.id);
    expect(made?.radius).toBe(config.sounds.bark);
    expect(made?.tags).toContain("blindDog");
    run(game, DT);
    expect(stateOf(other)).toMatchObject({ mode: "wander", suspicion: 0 });
  });

  test("it does not bark as it charges, roaring instead", () => {
    const { game, noise } = world(barker);
    const hound = blindDogAt(game, 150, 300);
    noise({ by: game.local, at: { x: 850, y: 300 }, radius: 2000 });
    run(game, 1);
    expect(stateOf(hound).mode).not.toBe("wander");
    expect(barks(game)).toBe(0);
  });
});
