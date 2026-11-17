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
import type { Noise, Point, Session, WorldEntity } from "../../sim/index.js";
import { freshSnail, snail as snailContent } from "../snail/index.js";
import {
  balloon as balloonContent,
  BalloonState,
  balloonsOf,
  birthdayBoy as boyContent,
  BirthdayBoyState,
  freeColour,
  freshBirthdayBoy,
  PALETTE,
} from "./index.js";

const DT = 1 / 60;
const { birthdayBoy: config, balloon: balloonConfig } = testEntitiesConfig;

/**
 * The dev square, 18x12 cells of 50px, walled round its edge, its pillars at x 200-300, y 50-150
 * and x 600-700, y 450-550, all dark; the local player, ME, stands at (x, y).
 */
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
    boyContent.create({ birthdayBoy: config }),
    balloonContent.create({ balloon: balloonConfig }),
    snailContent.create({ snail: testEntitiesConfig.snail }),
  ]);
  Object.assign(game.local, { x, y, prevX: x, prevY: y });
  return game;
}

/** Steps `seconds`, the local player standing, each event the host sends heard at once. */
function run(game: Session, seconds: number): Noise[] {
  const heard: Noise[] = [];
  const controls = {
    move: { x: 0, y: 0 },
    aim: { x: 0, y: 0 },
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
    heard.push(...game.noises);
  }
  return heard;
}

function boyAt(
  game: Session,
  at: Point,
  change: Partial<BirthdayBoyState> = {},
): WorldEntity {
  return spawnEntity(game, "birthdayBoy", at.x, at.y, {
    ...freshBirthdayBoy(game.worldTime, freeColour(game), config),
    ...change,
  });
}

function balloonAt(game: Session, at: Point, owner: WorldEntity): WorldEntity {
  const state: BalloonState = { owner: owner.id, colour: 0 };
  return spawnEntity(game, "balloon", at.x, at.y, state);
}

const stateOf = (entity: WorldEntity): BirthdayBoyState =>
  BirthdayBoyState.parse(entity.data);

/** A corner far from where these tests run, behind a pillar from the middle. */
const FAR = { x: 875, y: 575 };

test("six test shovel hits fell it", () => {
  const game = world(FAR.x, FAR.y);
  const boy = boyAt(game, { x: 425, y: 325 });
  expect(boy.maxHealth).toBe(testItemsConfig.shovel.damage * 6);
});

test("each new one wears a colour no other about wears, eight in all", () => {
  const game = world(FAR.x, FAR.y);
  const colours = Array.from(
    { length: PALETTE.length },
    (_, index) => stateOf(boyAt(game, { x: 75 + index * 40, y: 325 })).colour,
  );
  expect(new Set(colours).size).toBe(PALETTE.length);
  expect(config.spawning.most).toBeLessThanOrEqual(PALETTE.length);
});

test("wandering, it leaves a balloon of its colour every 10s, and walks through it", () => {
  const game = world(FAR.x, FAR.y);
  const boy = boyAt(game, { x: 425, y: 325 });
  run(game, config.balloonGap + 0.1);
  const [first] = balloonsOf(game, boy.id);
  expect(first).toBeDefined();
  expect(BalloonState.parse(first?.data).colour).toBe(stateOf(boy).colour);
  // Standing on it as it is left, it has not popped it.
  run(game, 1);
  expect(balloonsOf(game, boy.id)).toHaveLength(1);
  expect(stateOf(boy).mode).toBe("wander");
});

test("a body touching a balloon pops it, heard 20 cells round, and its boy hurries there", () => {
  const game = world(FAR.x, FAR.y);
  const boy = boyAt(game, { x: 75, y: 325 }, { balloonAt: 1000 });
  const popped = balloonAt(game, FAR, boy);
  const heard = run(game, DT * 2);
  expect(game.entities.has(popped.id)).toBe(false);
  expect(
    heard.some(
      (noise) =>
        noise.source === popped.id && noise.radius === balloonConfig.sounds.pop,
    ),
  ).toBe(true);
  // The dev square's cells are 50px.
  expect(balloonConfig.sounds.pop).toBe(50 * 20);
  const state = stateOf(boy);
  expect(state.mode).toBe("patrol");
  expect(state.spot).toEqual(FAR);
  expect(
    vi
      .mocked(game.sfx.play)
      .mock.calls.some(([url]) => url.endsWith("pop.mp3")),
  ).toBe(true);
});

test("on patrol, a killable body it sees near the popped balloon enrages it, and it strikes for 30 a second", () => {
  const game = world(425, 325);
  const boy = boyAt(
    game,
    { x: 125, y: 325 },
    { mode: "patrol", spot: { x: 400, y: 325 }, facing: 0, balloonAt: 1000 },
  );
  run(game, DT * 2);
  expect(stateOf(boy).mode).toBe("enraged");
  expect(
    vi
      .mocked(game.sfx.play)
      .mock.calls.some(([url]) => url.endsWith("enrage.mp3")),
  ).toBe(true);
  run(game, 3);
  const lost = game.local.maxHealth - game.local.health;
  expect(lost).toBeGreaterThan(0);
  expect(lost % config.damage).toBe(0);
});

test("on patrol, a snail by the balloon is no quarry: it cannot be killed", () => {
  const game = world(FAR.x, FAR.y);
  spawnEntity(game, "snail", 425, 325, freshSnail(null, 0));
  const boy = boyAt(
    game,
    { x: 125, y: 325 },
    { mode: "patrol", spot: { x: 400, y: 325 }, facing: 0, balloonAt: 1000 },
  );
  run(game, DT * 4);
  expect(stateOf(boy).mode).toBe("patrol");
});

test("enraged, with no body seen for 10s, it calms and wanders again", () => {
  const game = world(FAR.x, FAR.y);
  const boy = boyAt(
    game,
    { x: 425, y: 325 },
    {
      mode: "enraged",
      facing: Math.PI,
      lastSeen: { x: 425, y: 325 },
      seenAt: 0,
      balloonAt: 1000,
    },
  );
  run(game, config.calmSeconds - 1);
  expect(stateOf(boy).mode).toBe("enraged");
  run(game, 1.5);
  expect(stateOf(boy).mode).toBe("wander");
});

test("as it falls, all its balloons pop", () => {
  const game = world(FAR.x, FAR.y);
  const boy = boyAt(game, { x: 75, y: 75 }, { balloonAt: 1000 });
  const other = boyAt(game, { x: 75, y: 575 }, { balloonAt: 1000 });
  balloonAt(game, { x: 425, y: 325 }, boy);
  balloonAt(game, { x: 525, y: 325 }, boy);
  balloonAt(game, { x: 425, y: 225 }, other);
  hurt(game, boy, boy.maxHealth, null);
  run(game, DT * 3);
  expect(game.entities.has(boy.id)).toBe(false);
  expect(balloonsOf(game, boy.id)).toHaveLength(0);
  expect(balloonsOf(game, other.id)).toHaveLength(1);
});
