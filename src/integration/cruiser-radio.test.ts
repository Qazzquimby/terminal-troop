import { expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import { entityContent } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import {
  giveItem,
  onAir,
  updateSession,
  voiceNoise,
  voiceRoutes,
} from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { minimapTargets } from "../ui/index.js";
import { crew, idle, playerOn, sessionOf } from "./crew.js";
import { testEntitiesConfig, testItemsConfig } from "./sim-config.js";

const SILENT = {
  stop: () => undefined,
  setVolume: () => undefined,
  setPosition: () => undefined,
};

const entities: EntitiesConfig = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
  },
  cruiser: { ...testEntitiesConfig.cruiser, length: 80, width: 48 },
};

/** No scrap on the ground, so interact never picks anything up. */
const items: ItemsConfig = {
  ...testItemsConfig,
  scrap: {
    ...testItemsConfig.scrap,
    scatter: { ...testItemsConfig.scrap.scatter, count: 0 },
  },
};

const { radio } = testEntitiesConfig.cruiser;

/** Where the cruiser waits, and where a player with a walkie stands, well away from it. */
const CAR = { x: 450, y: 300 };
const AWAY = { x: 750, y: 550 };

function cruiserOf(game: Session): WorldEntity {
  const kind = game.kindIds.get("cruiser");
  const found = [...game.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (found === undefined) throw new Error("no cruiser");
  return found;
}

/** Puts the host's cruiser at `at`, at rest, pointing right, unfuelled. */
function park(game: Session, at: Point): WorldEntity {
  const cruiser = cruiserOf(game);
  Object.assign(cruiser, {
    ...at,
    prevX: at.x,
    prevY: at.y,
    tx: at.x,
    ty: at.y,
    vx: 0,
    vy: 0,
    data: { fuel: 0, damage: 0, heading: 0 },
  });
  return cruiser;
}

/**
 * A host, "a", standing away from the cruiser, and a guest, "b", inside it off the wheel; every
 * client's sounds mocked.
 */
async function car() {
  const made = await crew(
    {
      spots: { a: AWAY, b: { x: CAR.x, y: CAR.y + 50 } },
      content: [...entityContent(entities), ...itemContent(items)],
    },
    "a",
    "b",
  );
  /** Each client's streams' stop functions, in the order they started. */
  const stops = new Map<Session, Mock<() => void>[]>();
  for (const each of made.rooms.values()) {
    const game = sessionOf(each);
    const list: Mock<() => void>[] = [];
    stops.set(game, list);
    vi.spyOn(game.sfx, "play").mockResolvedValue(SILENT);
    vi.spyOn(game.sfx, "stream").mockImplementation(() => {
      const stop = vi.fn<() => void>();
      list.push(stop);
      return { ...SILENT, stop };
    });
  }
  const host = sessionOf(made.room("a"));
  const guest = sessionOf(made.room("b"));
  const cruiser = park(host, CAR);
  made.run(300);
  made.step({ b: { ...idle, interact: true } });
  made.run(300);
  expect(guest.local.ride?.vehicle).toBe(cruiser.id);
  /** As the host, gives the host's player a walkie, holds it and switches it on. */
  const walkie = (): void => {
    expect(giveItem(host, "a", "walkie", 1)).toBe(true);
    host.local.held = 1;
    made.run(300);
    made.step({ a: { ...idle, interact: true } });
    made.run(300);
  };
  /** The stop function of the `nth` stream `game` started. */
  const stopOf = (game: Session, nth: number) => stops.get(game)?.[nth];
  return { ...made, host, guest, cruiser, walkie, stopOf };
}

const transmit: Controls = { ...idle, transmit: true };
const talk: Controls = { ...idle, holdingUse: true };

test("holding transmit inside the cruiser goes out on the walkie band from the car, to every walkie switched on, as through a walkie", async () => {
  const { host, guest, room, step, run, cruiser, walkie } = await car();
  walkie();
  step({ b: transmit });
  expect(onAir.get(guest.local)).toBe(true);
  run(300, { b: transmit });

  const speaker = playerOn(room("a"), "b");
  const from = { x: cruiser.x, y: cruiser.y };
  expect(speaker).toMatchObject(from);
  expect(voiceRoutes(host, speaker, host.local)).toEqual([
    { at: from, via: "air" },
    { at: { x: host.local.x, y: host.local.y }, via: "radio", from },
  ]);

  // Let go, it stops.
  step();
  run(300);
  expect(onAir.get(playerOn(room("a"), "b"))).toBe(false);
  expect(voiceRoutes(host, speaker, host.local)).toHaveLength(1);
});

test("holding transmit on foot, with no set to talk into, puts no one on the air", async () => {
  const { host, step, run, walkie } = await car();
  walkie();
  step({ a: transmit });
  run(300, { a: transmit });
  expect(onAir.get(host.local)).toBe(false);
});

test("whoever is inside the cruiser hears every walkie transmission from the car, and its speaker makes the speech's noise there", async () => {
  const { host, guest, room, step, run, cruiser, walkie } = await car();
  walkie();
  step({ a: talk });
  run(300, { a: talk });

  const speaker = playerOn(room("b"), "a");
  expect(voiceRoutes(guest, speaker, guest.local)).toContainEqual({
    at: { x: cruiser.x, y: cruiser.y },
    via: "radio",
    from: { x: speaker.x, y: speaker.y },
  });

  voiceNoise.set(host.local, 400);
  const noises: Session["noises"][number][] = [];
  for (let i = 0; i < 60; i++) {
    step({ a: talk });
    noises.push(
      ...host.noises.filter((noise) => noise.tags.includes("walkie")),
    );
  }
  expect(noises.map((noise) => noise.at)).toContainEqual({
    x: cruiser.x,
    y: cruiser.y,
  });

  // Once nobody is inside, its set is off.
  step({ b: { ...idle, cabin: "exit" } });
  run(300, { a: talk });
  expect(
    voiceRoutes(guest, playerOn(room("b"), "a"), guest.local),
  ).not.toContainEqual(
    expect.objectContaining({ at: { x: cruiser.x, y: cruiser.y } }),
  );
});

test("the cruiser's radio: tune switches it on and steps through the stations, it plays from the car on every client and draws noise each second, off stops it", async () => {
  const { host, guest, room, step, run, cruiser, stopOf } = await car();
  const streams = (game: Session) => vi.mocked(game.sfx.stream).mock.calls;

  step({ b: { ...idle, cabin: "radio" } });
  run(300);
  for (const game of [host, guest]) {
    expect(streams(game)).toHaveLength(1);
    expect(streams(game)[0]?.[0]).toMatch(/\/songs\/song-1\.mp3$/);
    expect(streams(game)[0]?.[1]).toEqual({ x: cruiser.x, y: cruiser.y });
    expect(streams(game)[0]?.[3]).toMatchObject({
      loop: true,
      range: radio.range,
      volume: radio.volume,
    });
  }
  // The dial clicks where the car is.
  expect(
    vi
      .mocked(host.sfx.play)
      .mock.calls.some(([url]) => url.endsWith("/radio-tune.mp3")),
  ).toBe(true);

  const noises: number[] = [];
  for (let i = 0; i < 180; i++) {
    step();
    noises.push(
      ...host.noises
        .filter((noise) => noise.tags.includes("radio"))
        .map((noise) => noise.radius),
    );
  }
  expect(noises).toEqual(Array(3).fill(radio.range));

  run(400);
  step({ b: { ...idle, cabin: "radio" } });
  run(300);
  expect(streams(guest)).toHaveLength(2);
  expect(streams(guest)[1]?.[0]).toMatch(/\/songs\/song-2\.mp3$/);
  expect(stopOf(guest, 0)).toHaveBeenCalled();
  expect(stopOf(guest, 1)).not.toHaveBeenCalled();

  run(400);
  step({ b: { ...idle, cabin: "radioOff" } });
  run(300);
  expect(stopOf(guest, 1)).toHaveBeenCalled();
  const after: number[] = [];
  for (let i = 0; i < 120; i++) {
    updateSession(host, idle, 1 / 60);
    after.push(
      ...host.noises
        .filter((noise) => noise.tags.includes("radio"))
        .map((noise) => noise.radius),
    );
  }
  expect(after).toEqual([]);
  expect(playerOn(room("a"), "b").ride?.vehicle).toBe(cruiser.id);
});

test("the minimap follows the living players, everyone else before the local player", async () => {
  const { host, guest, room } = await car();
  expect(minimapTargets(host)).toEqual(["b", "a"]);
  expect(minimapTargets(guest)).toEqual(["a", "b"]);
  playerOn(room("b"), "a").health = 0;
  expect(minimapTargets(guest)).toEqual(["b"]);
});
