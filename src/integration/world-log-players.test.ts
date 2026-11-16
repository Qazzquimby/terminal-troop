import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import type { Room } from "../room/index.js";
import {
  CORPSE_ITEM,
  hurtPlayer,
  isGhost,
  itemInstances,
  revive,
  spawnEntity,
} from "../sim/index.js";
import type { Controls, Session, WorldEntity } from "../sim/index.js";
import { createWorldLog } from "../world-log/index.js";
import { crew as crewAt, idle, jitter, playerOn, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

/*
 * A player's death is logged on every client, host and guest alike, naming what killed it,
 * whatever that was: a monster's bite, a burst, a cruiser driven into it.
 */

/** No monsters but those the test brings, a small cruiser, and nothing lying about. */
const entities: EntitiesConfig = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
  },
  cruiser: { ...testEntitiesConfig.cruiser, length: 80, width: 48 },
};
const items: ItemsConfig = {
  ...testItemsConfig,
  scrap: {
    ...testItemsConfig.scrap,
    scatter: { ...testItemsConfig.scrap.scatter, count: 0 },
  },
};

const SPOTS = { a: { x: 150, y: 450 }, b: { x: 450, y: 450 } } as const;

/** A crew of `a`, hosting, and `b`, each logging the world, and a way to step them both. */
async function logged() {
  const crew = await crewAt(
    {
      spots: SPOTS,
      delay: jitter(),
      content: [...entityContent(entities), ...itemContent(items)],
    },
    "a",
    "b",
  );
  const lines = new Map<string, string[]>([
    ["a", []],
    ["b", []],
  ]);
  /** The lines each client printed loud. */
  const loud = new Map<string, string[]>([
    ["a", []],
    ["b", []],
  ]);
  const logs = [...lines].map(([id, kept]) => ({
    id,
    log: createWorldLog(
      { enabled: true, capacity: 500, quiet: [], monsterDeaths: false },
      (line, isLoud) => {
        kept.push(line);
        if (isLoud) loud.get(id)?.push(line);
      },
    ),
  }));
  const step = (controls: Readonly<Record<string, Controls>> = {}): void => {
    crew.step(controls);
    for (const { id, log } of logs) log.observe(sessionOf(crew.room(id)));
  };
  step();
  return {
    ...crew,
    step,
    lines,
    loud,
    logs: new Map(logs.map(({ id, log }) => [id, log])),
    host: sessionOf(crew.room("a")),
  };
}

/** Steps until player `id` is a ghost on every client, or `limit` steps pass. */
function untilDead(
  room: (id: string) => Room,
  step: () => void,
  id: string,
  limit = 60 * 20,
): void {
  for (let i = 0; i < limit; i++) {
    if (["a", "b"].every((each) => isGhost(playerOn(room(each), id)))) break;
    step();
  }
  // A few more, for the news to reach every client.
  for (let i = 0; i < 10; i++) step();
}

/** Expects every client's log to say `victim` was killed by `killer`, once. */
function expectKilled(
  lines: ReadonlyMap<string, readonly string[]>,
  victim: string,
  killer: string,
): void {
  for (const [, kept] of lines) {
    const deaths = kept.filter((line) =>
      line.includes(`] ${victim} killed by `),
    );
    expect(deaths).toEqual([
      expect.stringMatching(
        new RegExp(`^\\[world \\d\\d:\\d\\d\\] ${victim} killed by ${killer}$`),
      ),
    ]);
  }
}

for (const victim of ["a", "b"]) {
  const label = `player ${victim.toUpperCase()}`;
  const where = victim === "a" ? "the host" : "a guest";

  test(`a zombie killing ${where} is logged everywhere, naming the zombie`, async () => {
    const { room, step, lines, host } = await logged();
    const prey = playerOn(room("a"), victim);
    const zombie = spawnEntity(host, "zombie", prey.x + 20, prey.y, {
      mode: "wander",
      seed: 1,
      route: [],
      target: null,
      standUntil: host.worldTime,
      noiseTarget: null,
      barkAt: host.worldTime + 60,
      attackAt: 0,
      attacking: false,
      restUntil: 0,
      facing: 0,
    });
    untilDead(room, step, victim);
    expectKilled(lines, label, `zombie#${zombie.id}`);
  });

  test(`an exploder's burst killing ${where} is logged everywhere, naming the exploder`, async () => {
    const { room, step, lines, host } = await logged();
    const prey = playerOn(room("a"), victim);
    hurtPlayer(host, prey, prey.maxHealth - 1);
    const exploder = spawnEntity(host, "exploder", prey.x + 30, prey.y, {
      mode: "wander",
      seed: 1,
      route: [],
      standUntil: host.worldTime,
      goal: null,
      straight: false,
      // Lit, to burst as it first steps.
      fuseAt: host.worldTime,
      attacker: null,
      burst: false,
      facing: 0,
      health: null,
    });
    untilDead(room, step, victim);
    expectKilled(lines, label, `exploder#${exploder.id}`);
  });

  test(`a cruiser driven into ${where} is logged everywhere, naming its driver`, async () => {
    const { room, step, lines, host, place } = await logged();
    const driver = victim === "a" ? "b" : "a";
    const prey = playerOn(room("a"), victim);
    hurtPlayer(host, prey, prey.maxHealth - 1);
    const cruiser = cruiserOf(host);
    const at = { x: 150, y: 300 };
    Object.assign(cruiser, {
      ...at,
      prevX: at.x,
      prevY: at.y,
      tx: at.x,
      ty: at.y,
    });
    cruiser.data = { fuel: 10, damage: 0, heading: 0 };
    place(driver, { x: at.x, y: at.y + 50 });
    place(victim, { x: 600, y: 300 });
    for (let i = 0; i < 30; i++) step();
    // Each press, then long enough for it to reach the host and the answer to come back.
    const press = (controls: Partial<Controls>): void => {
      step({ [driver]: { ...idle, ...controls } });
      for (let i = 0; i < 30; i++) step();
    };
    press({ interact: true });
    press({ interact: true });
    expect(playerOn(room("a"), driver).ride).toMatchObject({ driving: true });
    for (let i = 0; i < 60 * 5 && !isGhost(prey); i++)
      step({ [driver]: { ...idle, move: { x: 0, y: -1 } } });
    untilDead(room, step, victim);
    expectKilled(lines, label, `player ${driver.toUpperCase()}`);
  });
}

test("a player's death and revival print loud everywhere, and players() lists each with its cause", async () => {
  const { room, step, loud, logs, host } = await logged();
  const prey = playerOn(room("a"), "b");
  const zombie = spawnEntity(host, "zombie", prey.x + 20, prey.y, {
    mode: "wander",
    seed: 1,
    route: [],
    target: null,
    standUntil: host.worldTime,
    noiseTarget: null,
    barkAt: host.worldTime + 60,
    attackAt: 0,
    attacking: false,
    restUntil: 0,
    facing: 0,
  });
  untilDead(room, step, "b");
  const [corpse] = itemInstances(host, CORPSE_ITEM);
  if (corpse === undefined) throw new Error("no corpse");
  revive(host, corpse.state, { x: 150, y: 450 }, "a");
  for (let i = 0; i < 30; i++) step();

  for (const [id, log] of logs) {
    expect(
      log.players().map(({ player, what, by }) => ({ player, what, by })),
    ).toEqual([
      { player: "player B", what: "died", by: `zombie#${zombie.id}` },
      { player: "player B", what: "revived", by: "player A" },
    ]);
    const shouted = loud.get(id) ?? [];
    expect(shouted).toEqual([
      expect.stringMatching(/\] player B killed by zombie#/),
      expect.stringMatching(/\] player B revived by player A$/),
    ]);
  }
});

function cruiserOf(game: Session): WorldEntity {
  const kind = game.kindIds.get("cruiser");
  const found = [...game.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (found === undefined) throw new Error("no cruiser");
  return found;
}
