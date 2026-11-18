import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { entityContent } from "../entities/index.js";
import { interpolatedView } from "../render/index.js";
import { aimAt, mulberry32, spawnEntity } from "../sim/index.js";
import type { Controls, Point, Session } from "../sim/index.js";
import { crew as crewAt, idle, jitter, sessionOf } from "./crew.js";
import { testEntitiesConfig } from "./sim-config.js";

beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(5));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Where each player stands: `b` with the peeper to its right, `a` well off. */
const SPOTS = { a: { x: 100, y: 550 }, b: { x: 450, y: 300 } } as const;
const PEEPER = { x: 600, y: 300 };

/** How far apart two facings are, in radians, the short way round. */
const turn = (a: number, b: number): number =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** Mouse held at `at`. */
const mouse = (at: Point): Controls => ({ ...idle, aim: at });

/** Host `a` and guest `b` on a jittery net, the peeper spawned by the host beside `b`. */
async function crew() {
  const setup = await crewAt(
    {
      spots: SPOTS,
      // The peeper alone, none of the dev square's own monsters about.
      content: entityContent(testEntitiesConfig).filter(
        (content) => content.name === "entity/peeper",
      ),
      delay: jitter(),
    },
    "a",
    "b",
  );
  const host = sessionOf(setup.room("a"));
  const guest = sessionOf(setup.room("b"));
  const now = host.worldTime;
  spawnEntity(host, "peeper", PEEPER.x, PEEPER.y, {
    held: [],
    since: now,
    attackAt: now,
    attacking: false,
    nearAt: now,
  });
  return { ...setup, host, guest };
}

/** The local aim `game` draws, its mouse at `at`. */
const drawnAim = (game: Session, at: Point): number =>
  interpolatedView(game, 1, at).local.aim;

test("a guest's aim is dragged onto the peeper, on its own client and on the host, and it is hurt", async () => {
  const { host, guest, run } = await crew();
  // The guest's mouse is held up the screen, away from the peeper.
  const up = { x: SPOTS.b.x, y: 0 };
  run(2000, { a: mouse({ x: 1000, y: 550 }), b: mouse(up) });
  const onto = aimAt(guest.local, PEEPER);
  expect(turn(guest.local.aim, onto)).toBeLessThan(0.05);
  expect(turn(drawnAim(guest, up), onto)).toBeLessThan(0.05);
  expect(turn(host.players.get("b")?.aim ?? 0, onto)).toBeLessThan(0.1);
  expect(guest.local.health).toBeLessThan(guest.config.player.maxHealth);
  expect(host.players.get("b")?.health).toBeLessThan(
    host.config.player.maxHealth,
  );
});

test("the host's own aim is dragged onto the peeper, as it draws it too", async () => {
  const { host, run, place } = await crew();
  place("a", { x: 450, y: 450 });
  place("b", { x: 100, y: 550 });
  const left = { x: 0, y: 450 };
  run(2000, { a: mouse(left), b: mouse({ x: 0, y: 550 }) });
  const onto = aimAt(host.local, PEEPER);
  expect(turn(host.local.aim, onto)).toBeLessThan(0.05);
  expect(turn(drawnAim(host, left), onto)).toBeLessThan(0.05);
});
