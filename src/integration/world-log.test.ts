import { expect, test } from "vitest";
import { z } from "zod";
import {
  createSession,
  registerContent,
  registerEntityType,
  spawnEntity,
  stun,
  updateSession,
} from "../sim/index.js";
import type { Session, WorldContent } from "../sim/index.js";
import { createWorldLog } from "../world-log/index.js";
import type { WorldLog, WorldLogConfig } from "../world-log/index.js";
import { crew as crewAt, idle, sessionOf } from "./crew.js";
import { testSfx, testSimConfig } from "./sim-config.js";

/** Where the test's bodies stand: clear of walls, away from the players. */
const SPOT = { x: 450, y: 300 };

/**
 * A prey that does nothing, and a biter that, on its first step, kills every prey within 40px:
 * as itself, or as no one when its data says so.
 */
const bodies: WorldContent = {
  name: "entity/test-bodies",
  register(session) {
    registerEntityType(session, "prey", {
      radius: 8,
      maxHealth: 10,
      collides: false,
      data: z.object({}),
      draw: () => undefined,
    });
    registerEntityType(session, "biter", {
      radius: 8,
      maxHealth: 10,
      collides: false,
      data: z.object({ steps: z.number(), anonymous: z.boolean() }),
      update: (_entity, data) => ({ ...data, steps: data.steps + 1 }),
      strikes: (entity, { steps, anonymous }, game) =>
        steps !== 1
          ? []
          : [...game.entities.values()]
              .filter(
                (other) =>
                  other.kind === game.kindIds.get("prey") &&
                  Math.hypot(other.x - entity.x, other.y - entity.y) < 40,
              )
              .map((other) => ({
                target: other.id,
                amount: 100,
                ...(anonymous && { by: null }),
              })),
      draw: () => undefined,
    });
  },
  populate: () => undefined,
};

const CONFIG: WorldLogConfig = { enabled: true, capacity: 100, quiet: [] };

/** A log that keeps what it prints. */
function printingLog(config = CONFIG): { log: WorldLog; lines: string[] } {
  const lines: string[] = [];
  return {
    log: createWorldLog(config, (line) => lines.push(line)),
    lines,
  };
}

const crew = (...ids: string[]) =>
  crewAt(
    {
      spots: { a: { x: 150, y: 300 }, b: { x: 150, y: 450 } },
      content: [bodies],
    },
    ...ids,
  );

test("host and guest alike log a spawn and a kill, naming the killer", async () => {
  const { room, step } = await crew("a", "b");
  const logs = new Map(["a", "b"].map((id) => [id, printingLog()] as const));
  const observeAll = (): void => {
    for (const [id, { log }] of logs) log.observe(sessionOf(room(id)));
  };
  const steps = (count: number): void => {
    for (let i = 0; i < count; i++) {
      step();
      observeAll();
    }
  };
  observeAll();
  const host = sessionOf(room("a"));
  const prey = spawnEntity(host, "prey", SPOT.x, SPOT.y, {});
  steps(30);
  const biter = spawnEntity(host, "biter", SPOT.x + 10, SPOT.y, {
    steps: 0,
    anonymous: false,
  });
  steps(60);

  for (const { log, lines } of logs.values()) {
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(`^\\[world \\d\\d:\\d\\d\\] prey#${prey.id} spawned at \\(`),
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^\\[world \\d\\d:\\d\\d\\] prey#${prey.id} killed by biter#${biter.id}$`,
        ),
      ),
    );
    // Told once, as a kill, and not again as gone.
    expect(log.events("death")).toHaveLength(1);
    expect(log.events("removed")).toEqual([]);
    expect(log.kills("prey")).toEqual([
      { victim: "prey", killer: "biter", count: 1 },
    ]);
    expect(log.counts().prey).toEqual({ spawned: 1, died: 1, alive: 0 });
  }
});

test("a kill dealt by no one is put down to nothing, and the kills table counts each killer", async () => {
  const { room, step } = await crew("a", "b");
  const { log } = printingLog();
  const guest = sessionOf(room("b"));
  const host = sessionOf(room("a"));
  const steps = (count: number): void => {
    for (let i = 0; i < count; i++) {
      step();
      log.observe(guest);
    }
  };
  const fight = (x: number, anonymous: boolean, prey: number): void => {
    for (let i = 0; i < prey; i++)
      spawnEntity(host, "prey", x + i * 5, SPOT.y, {});
    spawnEntity(host, "biter", x, SPOT.y + 10, { steps: 0, anonymous });
    steps(60);
  };
  log.observe(guest);
  fight(SPOT.x, false, 2);
  fight(SPOT.x + 200, true, 1);

  expect(log.events("death").map((event) => event.text)).toContainEqual(
    expect.stringMatching(/^prey#\w+ killed by nothing$/),
  );
  expect(log.kills("prey")).toEqual([
    { victim: "prey", killer: "biter", count: 2 },
    { victim: "prey", killer: "nothing", count: 1 },
  ]);
});

/** A lone session with the test bodies, hosting. */
function loneSession(): Session {
  const game = createSession("a", "A", "LOG", "dev", testSfx(), testSimConfig);
  registerContent(game, [bodies]);
  return game;
}

test("the log keeps at most its capacity, oldest dropped, while the tallies keep counting", () => {
  const game = loneSession();
  const { log } = printingLog({ ...CONFIG, capacity: 5 });
  log.observe(game);
  for (let i = 0; i < 12; i++) {
    spawnEntity(game, "prey", SPOT.x, SPOT.y, {});
    updateSession(game, idle, 1 / 60);
    log.observe(game);
  }
  const kept = log.events();
  expect(kept).toHaveLength(5);
  expect(kept.at(-1)?.text).toMatch(/^prey#\w+ spawned/);
  expect(log.counts().prey?.spawned).toBe(12);
});

test("a stun is logged with how long it lasts, quiet categories are kept but not printed, and a new session starts afresh", () => {
  const game = loneSession();
  const { log, lines } = printingLog({ ...CONFIG, quiet: ["stun"] });
  log.observe(game);
  const prey = spawnEntity(game, "prey", SPOT.x, SPOT.y, {});
  log.observe(game);
  stun(game, prey.id, 2);
  log.observe(game);
  expect(log.events("stun").map((event) => event.text)).toEqual([
    `prey#${prey.id} stunned for 2.0s`,
  ]);
  expect(lines.some((line) => line.includes("stunned"))).toBe(false);

  log.observe(loneSession());
  expect(log.events("stun")).toEqual([]);
  expect(log.kills()).toEqual([]);
});
