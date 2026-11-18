import { omit } from "lodash-es";
import { expect, test, vi } from "vitest";
import type { Room } from "../room/index.js";
import {
  defineItem,
  effect,
  giveItem,
  sound,
  spawnWorldItem,
  spendUses,
  usesAt,
  usesLeft,
  lyingItem,
} from "../sim/index.js";
import type { Controls, Session } from "../sim/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";

const LIT = "flare-lit.mp3";
const OUT = "flare-out.mp3";
const CLICK = "flare-click.mp3";

/**
 * A flare: three uses, each lighting it; its control clicks it and spends two uses, and it
 * fizzles out as its last use is spent.
 */
const flare = defineItem("flare", () => ({
  name: "Flare",
  emoji: "🧨",
  traits: { weight: 0, uses: 3 },
  breaks: sound({ url: OUT }),
  use: {
    cooldown: 0.1,
    apply(game, user) {
      effect(game, {
        at: { x: user.x, y: user.y },
        sound: sound({ url: LIT }),
      });
    },
  },
  draw: () => undefined,
  control: {
    cooldown: 0.1,
    apply(game, user, { slot }) {
      expect(usesAt(game, user, slot)).not.toBeNull();
      spendUses(game, user, slot, 2);
      effect(game, {
        at: { x: user.x, y: user.y },
        sound: sound({ url: CLICK }),
      });
    },
  },
}));

/** An anvil: as heavy as a player can carry before it slows no further. */
const anvil = defineItem("anvil", () => ({
  name: "Anvil",
  emoji: "🧱",
  traits: { weight: 100 },
}));

const SPOT = { x: 300, y: 300 };
const content = [
  flare.create({ flare: undefined }),
  anvil.create({ anvil: undefined }),
];

async function room() {
  const made = await crew(
    { spots: { a: { x: 750, y: 500 }, b: SPOT }, content },
    "a",
    "b",
  );
  for (const each of made.rooms.values())
    vi.spyOn(sessionOf(each).sfx, "play").mockResolvedValue({
      stop: () => undefined,
      setVolume: () => undefined,
      setPosition: () => undefined,
    });
  const host = sessionOf(made.room("a"));
  const guest = sessionOf(made.room("b"));
  /** As the host, gives the guest `item` in `slot`, holds it, and lets the record reach it. */
  const stock = (item: string, slot: number, left?: number): void => {
    expect(giveItem(host, "b", item, slot, left)).toBe(true);
    guest.local.held = slot;
    made.run(300);
  };
  return { ...made, host, guest, stock };
}

/** The uses left on the item in each slot of `game`'s own items, null for none or unlimited. */
const usesShown = (game: Session): (number | null)[] =>
  game.local.inventory.map((item) => (item === null ? null : usesLeft(item)));

/** How many times `room`'s client played `url`. */
const played = (room: Room, url: string): number =>
  vi
    .mocked(sessionOf(room).sfx.play)
    .mock.calls.filter(([played]) => played === url).length;

const use: Controls = { ...idle, use: true };
const interact: Controls = { ...idle, interact: true };

test("each use spends one use: at once on the guest, then in the host's record", async () => {
  const { guest, step, run, stock } = await room();
  stock("flare", 1);
  expect(usesShown(guest)).toEqual([null, 3, null, null]);
  step({ b: use });
  expect(usesShown(guest)[1]).toBe(2);
  run(300);
  expect(usesShown(guest)[1]).toBe(2);
  expect(guest.local.inventory[1]?.left).toBe(2);
});

test("the last use spends the item: it is gone everywhere, and every client hears it go", async () => {
  const { guest, host, room: client, step, run, stock } = await room();
  stock("flare", 1, 1);
  step({ b: use });
  expect(guest.local.inventory[1]).toBeNull();
  run(300);
  expect(guest.local.inventory[1]).toBeNull();
  expect(usesAt(host, playerOn(client("a"), "b"), 1)).toBeNull();
  for (const id of ["a", "b"])
    expect([id, played(client(id), OUT)]).toEqual([id, 1]);
});

test("a part-spent item dropped and picked up again keeps the uses it had left", async () => {
  const { guest, host, step, run, stock } = await room();
  stock("flare", 1, 2);
  step({ b: { ...idle, drop: true } });
  run(300);
  const lying = [...host.entities.values()].find(
    (entity) =>
      JSON.stringify(omit(lyingItem(host, entity), "facing")) ===
      JSON.stringify({ item: "flare", left: 2 }),
  );
  expect(lying).toBeDefined();
  step({ b: interact });
  run(300);
  expect(usesShown(guest)).toContain(2);
});

test("an item laid with uses left is picked up with them", async () => {
  const { guest, host, step, run } = await room();
  spawnWorldItem(host, SPOT, "flare", 1);
  run(300);
  step({ b: interact });
  run(300);
  expect(usesShown(guest)[0]).toBe(1);
});

test("with nothing to pick up, E works the held item's control on the host", async () => {
  const { guest, room: client, step, run, stock } = await room();
  stock("flare", 1);
  step({ b: interact });
  expect(usesShown(guest)[1]).toBe(1);
  run(300);
  expect(usesShown(guest)[1]).toBe(1);
  for (const id of ["a", "b"])
    expect([id, played(client(id), CLICK)]).toEqual([id, 1]);
});

test("with something to pick up, E picks it up rather than work the held item's control", async () => {
  const { guest, host, room: client, step, run, stock } = await room();
  stock("flare", 1);
  spawnWorldItem(host, SPOT, "anvil");
  run(300);
  step({ b: interact });
  run(300);
  expect(guest.local.inventory.map((item) => item?.id ?? null)).toContain(
    "anvil",
  );
  expect(usesShown(guest)[1]).toBe(3);
  expect(played(client("b"), CLICK)).toBe(0);
});

test("a guest carrying 100lb walks 20% slower, on its own client and the host alike", async () => {
  const { guest, host, room: client, place, run, stock } = await room();
  const walk: Controls = { ...idle, move: { x: 1, y: 0 } };
  /** How far the guest walks in half a second from SPOT, as `game` has it. */
  const stride = (): { own: number; host: number } => {
    place("b", SPOT);
    run(300);
    run(500, { b: walk });
    run(300);
    return {
      own: guest.local.x - SPOT.x,
      host: playerOn(client("a"), "b").x - SPOT.x,
    };
  };
  const light = stride();
  expect(light.own).toBeGreaterThan(50);
  stock("anvil", 1);
  const heavy = stride();
  expect(host.hosting).toBe(true);
  expect(heavy.own / light.own).toBeCloseTo(0.8, 1);
  expect(heavy.host / light.host).toBeCloseTo(0.8, 1);
});
