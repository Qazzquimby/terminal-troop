import { expect, test, vi } from "vitest";
import { itemContent } from "../items/index.js";
import type { Room } from "../room/index.js";
import {
  giveItem,
  isOn,
  itemInstances,
  onAir,
  spawnWorldItem,
  voiceNoise,
  voiceRoutes,
} from "../sim/index.js";
import type { Controls, ItemInstance, Session } from "../sim/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";
import { testItemsConfig } from "./sim-config.js";

const SILENT = {
  stop: () => undefined,
  setVolume: () => undefined,
  setPosition: () => undefined,
};

/** Where the guest stands, and where a walkie or radio lies, far from both players. */
const SPOT = { x: 300, y: 300 };
const FAR = { x: 600, y: 150 };

async function room() {
  const made = await crew(
    {
      spots: { a: { x: 750, y: 500 }, b: SPOT },
      content: itemContent(testItemsConfig),
    },
    "a",
    "b",
  );
  for (const each of made.rooms.values()) {
    vi.spyOn(sessionOf(each).sfx, "play").mockResolvedValue(SILENT);
    vi.spyOn(sessionOf(each).sfx, "stream").mockReturnValue({
      ...SILENT,
      stop: vi.fn(),
    });
  }
  const host = sessionOf(made.room("a"));
  const guest = sessionOf(made.room("b"));
  /** As the host, gives the guest `item` in slot 1 with `left` uses, holds it, and lets it arrive. */
  const stock = (item: string, left?: number): void => {
    expect(giveItem(host, "b", item, 1, left)).toBe(true);
    guest.local.held = 1;
    made.run(300);
  };
  return { ...made, host, guest, stock };
}

/** Every `item` in `game`'s world, as it knows them. */
const all = (game: Session, item: string): ItemInstance[] =>
  itemInstances(game, item);

/** How many times `room`'s client played a sound whose url ends with `/name`. */
const played = (room: Room, name: string): number =>
  vi
    .mocked(sessionOf(room).sfx.play)
    .mock.calls.filter(([url]) => url.endsWith(`/${name}`)).length;

const interact: Controls = { ...idle, interact: true };
const talk: Controls = { ...idle, holdingUse: true };

test("E switches a held walkie on and off, on the host's record, which every client sees", async () => {
  const { host, guest, room: client, step, run, stock } = await room();
  stock("walkie");
  step({ b: interact });
  run(300);
  for (const game of [host, guest])
    expect(all(game, "walkie").map((each) => isOn(each.state))).toEqual([true]);
  expect(isOn(guest.local.inventory[1]?.state)).toBe(true);
  for (const id of ["a", "b"]) expect(played(client(id), "on.mp3")).toBe(1);

  run(500);
  step({ b: interact });
  run(300);
  expect(all(guest, "walkie").map((each) => isOn(each.state))).toEqual([false]);
  for (const id of ["a", "b"]) expect(played(client(id), "off.mp3")).toBe(1);
});

test("a walkie switched on spends a use each second, dropped and picked up it stays on, and it dies flat", async () => {
  const { host, guest, room: client, step, run, stock } = await room();
  stock("walkie", 4);
  step({ b: interact });
  run(2000);
  const [carried] = all(host, "walkie");
  expect(carried?.left).toBeGreaterThanOrEqual(1);
  expect(carried?.left).toBeLessThanOrEqual(3);

  step({ b: { ...idle, drop: true } });
  run(300);
  const [lying] = all(host, "walkie");
  expect(lying !== undefined && "lying" in lying.place).toBe(true);
  expect(isOn(lying?.state)).toBe(true);

  run(4000);
  expect(all(host, "walkie")).toEqual([]);
  expect(all(guest, "walkie")).toEqual([]);
  for (const id of ["a", "b"]) expect(played(client(id), "dead.mp3")).toBe(1);
});

test("a walkie lying switched off keeps its battery, and is picked up off", async () => {
  const { host, guest, step, run } = await room();
  spawnWorldItem(host, SPOT, "walkie", 5);
  run(3000);
  expect(all(host, "walkie").map((each) => each.left)).toEqual([5]);
  step({ b: interact });
  run(300);
  expect(guest.local.inventory.find((item) => item?.id === "walkie")).toEqual(
    expect.objectContaining({ left: 5 }),
  );
  expect(isOn(all(guest, "walkie")[0]?.state)).toBe(false);
});

test("holding the use button on a held walkie switched on puts the guest on the air, with a click every client hears and no noise", async () => {
  const { host, guest, room: client, step, run, stock } = await room();
  stock("walkie");
  step({ b: talk });
  run(300, { b: talk });
  expect(onAir.get(guest.local)).toBe(false);

  step({ b: interact });
  run(300);
  step({ b: talk });
  expect(onAir.get(guest.local)).toBe(true);
  expect(host.noises).toEqual([]);
  run(300, { b: talk });
  expect(onAir.get(playerOn(client("a"), "b"))).toBe(true);
  for (const id of ["a", "b"]) expect(played(client(id), "key.mp3")).toBe(1);

  step();
  run(300);
  expect(onAir.get(playerOn(client("a"), "b"))).toBe(false);
  for (const id of ["a", "b"]) expect(played(client(id), "unkey.mp3")).toBe(1);
});

test("a transmission plays from every other walkie switched on, wherever it is, and from no walkie off", async () => {
  const { host, room: client, step, run, stock } = await room();
  stock("walkie");
  step({ b: interact });
  run(300);
  spawnWorldItem(host, FAR, "walkie", undefined, { on: true });
  spawnWorldItem(host, { x: 650, y: 150 }, "walkie");
  run(300, { b: talk });

  const listener = sessionOf(client("a"));
  const speaker = playerOn(client("a"), "b");
  expect(voiceRoutes(listener, speaker, listener.local)).toEqual([
    { at: { x: speaker.x, y: speaker.y }, via: "air" },
    { at: FAR, via: "radio" },
  ]);

  run(300);
  expect(voiceRoutes(listener, speaker, listener.local)).toEqual([
    { at: { x: speaker.x, y: speaker.y }, via: "air" },
  ]);
});

test("a walkie playing speech makes noise where it is, as far as the speech carries scaled by its speaker", async () => {
  const { host, guest, step, run, stock } = await room();
  stock("walkie");
  step({ b: interact });
  run(300);
  spawnWorldItem(host, FAR, "walkie", undefined, { on: true });
  run(100);
  voiceNoise.set(guest.local, 400);
  const heard: { at: unknown; radius: number; tags: readonly string[] }[] = [];
  for (let i = 0; i < 60; i++) {
    step({ b: talk });
    heard.push(...host.noises.filter((noise) => noise.tags.includes("walkie")));
  }
  expect(heard.length).toBeGreaterThan(0);
  expect(heard[0]).toMatchObject({
    at: FAR,
    radius: 400 * testItemsConfig.walkie.speakerNoise,
  });
  expect(heard[0]?.tags).toContain("voice");
});

test("a radio switched on plays a song on every client from where the world's clock has it, and makes a large noise each second, held or lying", async () => {
  const { host, guest, room: client, step, run, stock } = await room();
  stock("radio");
  step({ b: interact });
  run(300);
  const [on] = all(guest, "radio");
  expect(isOn(on?.state)).toBe(true);
  expect(typeof on?.state?.song).toBe("number");
  expect(on?.state?.since).toBeGreaterThan(0);
  for (const id of ["a", "b"]) {
    const streams = vi.mocked(sessionOf(client(id)).sfx.stream).mock.calls;
    expect(streams).toHaveLength(1);
    expect(streams[0]?.[0]).toMatch(/\/songs\/song-\d\.mp3$/);
    expect(streams[0]?.[3]).toMatchObject({
      loop: true,
      range: testItemsConfig.radio.range,
    });
  }

  step({ b: { ...idle, drop: true } });
  run(300);
  expect(vi.mocked(guest.sfx.stream).mock.calls).toHaveLength(1);
  const noises: number[] = [];
  for (let i = 0; i < 180; i++) {
    step();
    noises.push(
      ...host.noises
        .filter((noise) => noise.tags.includes("radio"))
        .map((noise) => noise.radius),
    );
  }
  expect(noises).toEqual(Array(3).fill(testItemsConfig.radio.range));
});

test("a radio switched off stops its song", async () => {
  const { guest, step, run, stock } = await room();
  const stop = vi.fn();
  vi.mocked(guest.sfx.stream).mockReturnValue({ ...SILENT, stop });
  stock("radio");
  step({ b: interact });
  run(500);
  expect(stop).not.toHaveBeenCalled();
  step({ b: interact });
  run(300);
  expect(stop).toHaveBeenCalled();
});
