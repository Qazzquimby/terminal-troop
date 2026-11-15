import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import {
  createSession,
  hurtPlayer,
  lastHurtBy,
  registerContent,
  registerEntityType,
  spawnEntity,
  stun,
  updateSession,
} from "../sim/index.js";
import type { Session, WorldContent, WorldEntity } from "../sim/index.js";
import { blindDog, freshBlindDog } from "./blind-dog/index.js";
import { exploder, freshExploder } from "./exploder/index.js";
import { freshHoarder, hoarder, HoarderState } from "./hoarder/index.js";
import { freshSleeper, sleeper } from "./sleeper/index.js";
import { freshSnail, snail } from "./snail/index.js";
import { freshStalker, stalker } from "./stalker/index.js";
import { freshStatue, statue } from "./statue/index.js";
import { freshZombie, zombie } from "./zombie/index.js";

/*
 * Every monster leaves the snail be: none hunts, notices or strikes it. Each case sets a monster
 * beside a body it would go for; a post shows it does, and a snail, stunned so it strikes nothing
 * back, that it passes over it.
 */

const DT = 1 / 60;
const idle = {
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

/** Where the monster stands, and the body beside it, touching it. */
const AT = { x: 400, y: 300 };

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

/** A post at (x, y): a body with no eyes nor will of its own, neither player nor monster. */
function postAt(game: Session, x: number, y: number): WorldEntity {
  if (!game.kindIds.has("post"))
    registerEntityType(game, "post", {
      radius: testEntitiesConfig.snail.radius,
      maxHealth: 1_000_000,
      data: z.object({}),
      draw: () => undefined,
    });
  return spawnEntity(game, "post", x, y, {});
}

/** A snail at (x, y), stunned for good so it strikes nothing back. */
function snailAt(game: Session, x: number, y: number): WorldEntity {
  const body = spawnEntity(game, "snail", x, y, freshSnail(null, 0));
  stun(game, body.id, 1000);
  return body;
}

interface Case {
  readonly name: string;
  readonly content: {
    create: (config: typeof testEntitiesConfig) => WorldContent;
  };
  /** Spawns the monster at `AT`, ready to go for a body touching it. */
  readonly spawn: (game: Session) => WorldEntity;
  /** Long enough for it to go for, and strike, a body beside it. */
  readonly seconds: number;
}

const config = testEntitiesConfig;

const CASES: readonly Case[] = [
  {
    name: "zombie",
    content: zombie,
    spawn: (game) =>
      spawnEntity(game, "zombie", AT.x, AT.y, freshZombie(1, 0, config.zombie)),
    seconds: 2,
  },
  {
    name: "blind dog",
    content: blindDog,
    spawn: (game) =>
      spawnEntity(game, "blindDog", AT.x, AT.y, freshBlindDog(1, 0)),
    seconds: 2,
  },
  {
    name: "exploder",
    content: exploder,
    spawn: (game) =>
      spawnEntity(game, "exploder", AT.x, AT.y, freshExploder(1, 0)),
    seconds: 6,
  },
  {
    name: "sleeper",
    content: sleeper,
    spawn: (game) =>
      spawnEntity(game, "sleeper", AT.x, AT.y, freshSleeper(0, config.sleeper)),
    seconds: config.sleeper.warnSeconds + 2,
  },
  {
    name: "statue",
    content: statue,
    spawn: (game) => spawnEntity(game, "statue", AT.x, AT.y, freshStatue(0)),
    seconds: 2,
  },
  {
    name: "stalker",
    content: stalker,
    spawn: (game) => spawnEntity(game, "stalker", AT.x, AT.y, freshStalker(0)),
    seconds: 3,
  },
  {
    name: "hoarder",
    content: hoarder,
    // Away from its nest, a body it sees close by spooks it into a bite.
    spawn: (game) => {
      const bug = spawnEntity(game, "hoarder", 100, 300, freshHoarder(0));
      run(game, DT);
      Object.assign(bug, { x: AT.x, y: AT.y, prevX: AT.x, prevY: AT.y });
      bug.data = { ...HoarderState.parse(bug.data), facing: 0, route: [] };
      return bug;
    },
    seconds: 2,
  },
];

/** A dark dev square with `content` and the snail, its one player dead. */
function world(content: Case["content"]): Session {
  const game = createSession(
    "me",
    "ME",
    "UNNOTICED",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [content.create(config), snail.create(config)]);
  Object.assign(game.local, { x: 850, y: 575, prevX: 850, prevY: 575 });
  hurtPlayer(game, game.local, Infinity);
  return game;
}

/** Sets the monster down with a body of `place`'s touching it, steps a while, and gives the body. */
function besideMonster(
  { content, spawn, seconds }: Case,
  place: (game: Session, x: number, y: number) => WorldEntity,
): { game: Session; body: WorldEntity } {
  const game = world(content);
  const monster = spawn(game);
  const body = place(game, AT.x + monster.radius + 13, AT.y);
  run(game, seconds);
  return { game, body };
}

describe.each(CASES)("the $name", (kind) => {
  test("goes for a body beside it", () => {
    const { game, body } = besideMonster(kind, postAt);
    expect(lastHurtBy(game, body.id, Infinity)).not.toBeNull();
  });

  test("passes over a snail beside it", () => {
    const { game, body } = besideMonster(kind, snailAt);
    expect(lastHurtBy(game, body.id, Infinity)).toBeNull();
  });
});
