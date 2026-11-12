import { expect, test } from "vitest";
import { z } from "zod";
import { moveContent } from "../moves/index.js";
import { NetEvent } from "../net/index.js";
import type { Room } from "../room/index.js";
import { hurtPlayer, registerEntityType, spawnEntity } from "../sim/index.js";
import type { Controls, Session, WorldContent } from "../sim/index.js";
import { crew as crewAt, idle, playerOn, sessionOf } from "./crew.js";
import { testMovesConfig, testSimConfig } from "./sim-config.js";

const { kick } = testMovesConfig;
const FULL = testSimConfig.player.maxHealth;
const PLAYER_LENGTH = testSimConfig.player.radius * 2;
/** A spot clear of walls, with room to its right for a kick and a push. */
const LEFT = { x: 150, y: 300 };
/** Where each client's player stands at first: `b` where a kick from `a`, facing right, lands. */
const SPOTS = {
  a: LEFT,
  b: { x: LEFT.x + PLAYER_LENGTH + kick.reach, y: LEFT.y },
  c: { x: 750, y: 450 },
  d: { x: 450, y: 450 },
} as const;
/** Damage the biter deals. */
const BITE = 7;

/** Bites the players within 40px of it for BITE each, on its first step only. */
const biter: WorldContent = {
  name: "entity/biter",
  register(session) {
    registerEntityType(session, "biter", {
      radius: 10,
      maxHealth: 10,
      data: z.object({ steps: z.number() }),
      update: (_entity, { steps }) => ({ steps: steps + 1 }),
      strikes: (entity, { steps }, game) =>
        steps !== 1
          ? []
          : [...game.players.values()]
              .filter(
                (player) =>
                  Math.hypot(player.x - entity.x, player.y - entity.y) < 40,
              )
              .map((player) => ({ target: player.id, amount: BITE })),
      draw: () => undefined,
    });
  },
  populate: () => undefined,
};

/** Clients `ids` with the kick and the biter, joined to one room on a JSON hub, the first hosting. */
const crew = (...ids: string[]) =>
  crewAt(
    { spots: SPOTS, content: [...moveContent(testMovesConfig), biter] },
    ...ids,
  );

/** Faces right of where `game`'s local player stands, kicking. */
const kickRight = (game: Session): Controls => ({
  ...idle,
  secondary: true,
  aim: { x: game.local.x + 1000, y: game.local.y },
});

/** Player `id`'s health on every client in `rooms`, its own included. */
const healthEverywhere = (rooms: ReadonlyMap<string, Room>, id: string) =>
  [...rooms.values()].map((room) => playerOn(room, id).health);

/** As the host `room`, deals `amount` to player `id`. */
const hurt = (room: Room, id: string, amount: number): void => {
  hurtPlayer(sessionOf(room), playerOn(room, id), amount);
};

test("a kick on a guest lowers its health on every client, and the guest's own word on its health counts for nothing", async () => {
  const { hub, rooms, room, step, run } = await crew("a", "b", "c");
  step({ a: kickRight(sessionOf(room("a"))) });
  run(1000);
  expect(healthEverywhere(rooms, "b")).toEqual([
    FULL - kick.damage,
    FULL - kick.damage,
    FULL - kick.damage,
  ]);

  const guest = sessionOf(room("b")).local;
  guest.health = FULL;
  hub.listener("dev:FRIEND").send(NetEvent.STATE, {
    id: "b",
    name: "B",
    x: guest.x,
    y: guest.y,
    aim: 0,
    health: FULL,
    epoch: guest.epoch,
    content: {},
  });
  run(500);
  expect(healthEverywhere(rooms, "b")).toEqual([
    FULL - kick.damage,
    FULL - kick.damage,
    FULL - kick.damage,
  ]);
});

test("a zombie's strike on the host's own player comes off the host's record, and the guests see it", async () => {
  const { rooms, room, run } = await crew("a", "b", "c");
  const host = sessionOf(room("a"));
  spawnEntity(host, "biter", host.local.x, host.local.y, { steps: 0 });
  run(500);
  expect(healthEverywhere(rooms, "a")).toEqual([
    FULL - BITE,
    FULL - BITE,
    FULL - BITE,
  ]);
  expect(healthEverywhere(rooms, "b")).toEqual([FULL, FULL, FULL]);
});

test("a player that joins late sees each player's health as the host has it, and starts at full", async () => {
  const { rooms, room, client, run } = await crew("a", "b");
  hurt(room("a"), "a", 10);
  hurt(room("a"), "b", 30);
  run(500);
  const late = client("c");
  rooms.set("c", late);
  await late.join("FRIEND", "C");
  run(1000);
  expect(healthEverywhere(rooms, "a")).toEqual([
    FULL - 10,
    FULL - 10,
    FULL - 10,
  ]);
  expect(healthEverywhere(rooms, "b")).toEqual([
    FULL - 30,
    FULL - 30,
    FULL - 30,
  ]);
  expect(healthEverywhere(rooms, "c")).toEqual([FULL, FULL, FULL]);
});

test("a new host goes on from the health the old one recorded", async () => {
  const { rooms, room, run } = await crew("a", "b", "c", "d");
  hurt(room("a"), "b", 10);
  hurt(room("a"), "c", 30);
  run(500);
  await room("a").leave();
  rooms.delete("a");
  run(3000);
  expect(room("b").hostId()).toBe("b");
  expect(healthEverywhere(rooms, "b")).toEqual([
    FULL - 10,
    FULL - 10,
    FULL - 10,
  ]);
  expect(healthEverywhere(rooms, "c")).toEqual([
    FULL - 30,
    FULL - 30,
    FULL - 30,
  ]);
  hurt(room("b"), "c", 5);
  run(500);
  expect(healthEverywhere(rooms, "c")).toEqual([
    FULL - 35,
    FULL - 35,
    FULL - 35,
  ]);
  expect(healthEverywhere(rooms, "d")).toEqual([FULL, FULL, FULL]);
});

test("the health a client shows, health bars and its own included, is the host's record, whatever it sets", async () => {
  const { rooms, room, step, run } = await crew("a", "b");
  hurt(room("a"), "b", 20);
  const guest = sessionOf(room("b"));
  expect(guest.local.health).toBe(FULL);
  run(500);
  expect(guest.local.health).toBe(FULL - 20);
  guest.local.health = FULL;
  const seen = guest.players.get("a");
  if (seen !== undefined) seen.health = 1;
  step();
  expect(guest.local.health).toBe(FULL - 20);
  expect(healthEverywhere(rooms, "a")).toEqual([FULL, FULL]);
  expect(healthEverywhere(rooms, "b")).toEqual([FULL - 20, FULL - 20]);
});
