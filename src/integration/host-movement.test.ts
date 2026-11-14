import { expect, test } from "vitest";
import type { Controls, Point, Session } from "../sim/index.js";
import { moveContent } from "../moves/index.js";
import { crew, idle, jitter, playerOn, sessionOf } from "./crew.js";
import { testMovesConfig, testSimConfig } from "./sim-config.js";

/** The host `a`, the guest `b` that moves and the guest `c` that watches, apart in the dev square. */
const SPOTS = {
  a: { x: 450, y: 300 },
  b: { x: 150, y: 300 },
  c: { x: 750, y: 150 },
};

/** Three clients on a hub whose sends arrive 60 to 180ms later. */
const jittered = () => crew({ spots: SPOTS, delay: jitter() }, "a", "b", "c");

const walk = (x: number, y: number): Controls => ({
  ...idle,
  move: { x, y },
});

const gap = (one: Point, other: Point): number =>
  Math.hypot(one.x - other.x, one.y - other.y);

/** `b`'s player on every client: its own, the host's and the watcher's. */
function copiesOfB(room: (id: string) => Parameters<typeof sessionOf>[0]) {
  return {
    own: sessionOf(room("b")).local,
    host: playerOn(room("a"), "b"),
    watcher: playerOn(room("c"), "b"),
  };
}

test("a guest moves at once, and the host runs it to the same spot without correcting it", async () => {
  const { room, run, step } = await jittered();
  const guest: Session = sessionOf(room("b"));
  const before = guest.corrections.count;
  const start = { x: guest.local.x, y: guest.local.y };
  step({ b: walk(1, 0) });
  expect(guest.local.x).toBeGreaterThan(start.x);
  run(600, { b: walk(1, 0) });
  run(400, { b: walk(0, 1) });
  run(300, { b: walk(-0.6, -0.8) });
  run(1000);
  const { own, host, watcher } = copiesOfB(room);
  expect(own.x).toBeGreaterThan(start.x + 100);
  expect(gap(own, host)).toBeLessThan(0.01);
  expect(gap(own, watcher)).toBeLessThan(0.5);
  expect(guest.corrections.count).toBe(before);
});

test("a guest's sprint drains and exhausts its stamina on the host, which the guest agrees with", async () => {
  const { room, run } = await jittered();
  const guest = sessionOf(room("b"));
  const before = guest.corrections.count;
  const { own, host, watcher } = copiesOfB(room);
  const { max } = testSimConfig.stamina;
  // Back and forth, past the 3s a full bar lasts.
  for (let leg = 0; leg < 8; leg++)
    run(500, { b: { ...walk(leg % 2 === 0 ? 1 : -1, 0), sprint: true } });
  expect(own.stamina.exhausted).toBe(true);
  run(300);
  expect(host.stamina.exhausted).toBe(true);
  expect(watcher.stamina.exhausted).toBe(true);
  expect(host.stamina.value).toBeLessThan(max / 2);
  // Every step the host ran of the guest ended as the guest's own run of it did.
  expect(guest.corrections.count).toBe(before);
  run(5000);
  expect(own.stamina.value).toBe(max);
  expect(host.stamina.value).toBe(max);
  expect(watcher.stamina.value).toBe(max);
});

/** The same three, kicking. */
const kicking = () =>
  crew(
    {
      spots: SPOTS,
      delay: jitter(),
      content: moveContent(testMovesConfig),
    },
    "a",
    "b",
    "c",
  );

/** Controls that kick towards `at`. */
const kickAt = (at: { x: number; y: number }): Controls => ({
  ...idle,
  aim: at,
  secondary: true,
});

test("a guest kicked by another lands where the host knocks it, on every client", async () => {
  const { room, run, step, place } = await kicking();
  place("a", { x: 450, y: 500 });
  place("b", { x: 400, y: 300 });
  place("c", { x: 340, y: 300 });
  run(1000);
  const guest = sessionOf(room("b"));
  const { own, host, watcher } = copiesOfB(room);
  const before = { x: own.x, y: own.y };
  step({ c: kickAt({ x: 500, y: 300 }) });
  run(1000);
  // Knocked two body lengths from where the kicker's lunge ends.
  expect(host.x - before.x).toBeGreaterThan(50);
  expect(Math.abs(host.y - before.y)).toBeLessThan(1);
  expect(host.health).toBe(
    testSimConfig.player.maxHealth - testMovesConfig.kick.damage,
  );
  expect(gap(own, host)).toBeLessThan(0.01);
  expect(gap(watcher, host)).toBeLessThan(0.5);
  expect(guest.corrections.count).toBeGreaterThan(0);
});

test("a guest kicking the host's player lunges at once and knocks it back on every client", async () => {
  const { room, run, step, place } = await kicking();
  place("b", { x: 400, y: 300 });
  place("a", { x: 460, y: 300 });
  run(1000);
  const kicker = sessionOf(room("b"));
  const before = kicker.local.x;
  step({ b: kickAt({ x: 600, y: 300 }) });
  step();
  expect(kicker.local.x).toBeGreaterThan(before);
  run(1000);
  const hostSelf = sessionOf(room("a")).local;
  expect(hostSelf.x).toBeGreaterThan(480);
  expect(playerOn(room("b"), "a").x).toBeCloseTo(hostSelf.x, 0);
  expect(playerOn(room("c"), "a").x).toBeCloseTo(hostSelf.x, 0);
  expect(gap(kicker.local, playerOn(room("a"), "b"))).toBeLessThan(0.01);
});

test("a new host runs every player on from where it last heard them", async () => {
  const { room, rooms, run, step } = await jittered();
  const moving = { b: walk(1, 0), c: walk(0, 1) };
  run(500, moving);
  const largest = { b: 0, c: 0 };
  const last = {
    b: { ...sessionOf(room("b")).local },
    c: { ...sessionOf(room("c")).local },
  };
  void room("a").leave();
  rooms.delete("a");
  for (let i = 0; i < 300; i++) {
    step(i < 200 ? moving : {});
    for (const id of ["b", "c"] as const) {
      const { local } = sessionOf(room(id));
      largest[id] = Math.max(largest[id], gap(local, last[id]));
      last[id] = { ...local };
    }
  }
  const newHost = room("b").hostId();
  expect(newHost === "b" || newHost === "c").toBe(true);
  // Nobody jumps: no step moves a player further than a walking step and a bit.
  const walkStep = (testSimConfig.player.speed / 60) * 1.5;
  expect(largest.b).toBeLessThan(walkStep);
  expect(largest.c).toBeLessThan(walkStep);
  for (const id of ["b", "c"])
    for (const other of ["b", "c"])
      if (id !== other)
        expect(
          gap(sessionOf(room(id)).local, playerOn(room(other), id)),
        ).toBeLessThan(0.5);
});

test("a guest that turned just before the host left goes on uncorrected with the new host", async () => {
  const { room, rooms, run } = await jittered();
  run(500, { b: walk(1, 0), c: walk(1, 0) });
  // Too late for the old host to have run it: the new host learns of it from the guest.
  const turned = { b: walk(0, 1), c: walk(0, 1) };
  run(100, turned);
  const before = {
    b: sessionOf(room("b")).corrections.count,
    c: sessionOf(room("c")).corrections.count,
  };
  void room("a").leave();
  rooms.delete("a");
  run(1500, turned);
  run(500);
  const newHost = room("b").hostId();
  const guest = newHost === "b" ? "c" : "b";
  expect(newHost === "b" || newHost === "c").toBe(true);
  expect(sessionOf(room(guest)).corrections.count).toBe(before[guest]);
  expect(
    gap(sessionOf(room(guest)).local, playerOn(room(newHost ?? ""), guest)),
  ).toBeLessThan(0.01);
});
