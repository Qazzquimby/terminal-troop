import { expect, test } from "vitest";
import { entityContent } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import type { ItemsConfig } from "../items/index.js";
import { moveContent } from "../moves/index.js";
import type { Room } from "../room/index.js";
import {
  alter,
  CORPSE_ITEM,
  credit,
  driverOf,
  giveItem,
  hurtPlayer,
  isAreaFree,
  isGhost,
  itemIn,
  itemInstances,
  itemName,
  playersIn,
  spawnEntity,
  voiceRoutes,
} from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { crew as crewAt, idle, playerOn, sessionOf } from "./crew.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testMovesConfig,
  testSimConfig,
} from "./sim-config.js";

/** No zombies, now or later. */
const entities: EntitiesConfig = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
  },
};

/** No scrap on the ground, so nothing lies about but what the test lays. */
const items: ItemsConfig = {
  ...testItemsConfig,
  scrap: {
    ...testItemsConfig.scrap,
    scatter: { ...testItemsConfig.scrap.scatter, count: 0 },
  },
};

const { kick } = testMovesConfig;
const PLAYER_LENGTH = testSimConfig.player.radius * 2;
/** Spots in the dev square, `b` where a kick from `a`, facing right, lands. */
const SPOTS = {
  a: { x: 150, y: 300 },
  b: { x: 150 + PLAYER_LENGTH + kick.reach, y: 300 },
  c: { x: 750, y: 450 },
} as const;

const crew = (...ids: string[]) =>
  crewAt(
    {
      spots: SPOTS,
      content: [
        ...entityContent(entities),
        ...itemContent(items),
        ...moveContent(testMovesConfig),
      ],
    },
    ...ids,
  );

/** As the host `room`, deals player `id` all its health. */
const kill = (room: Room, id: string): void => {
  hurtPlayer(sessionOf(room), playerOn(room, id), Infinity);
};

const corpses = (game: Session) => itemInstances(game, CORPSE_ITEM);

function cruiserOf(game: Session): WorldEntity {
  const kind = game.kindIds.get("cruiser");
  const found = [...game.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (found === undefined) throw new Error("no cruiser");
  return found;
}

/** A spot a player fits, `distance` from the cruiser's middle. */
function byCruiser(game: Session, distance: number): Point {
  const cruiser = cruiserOf(game);
  for (let turn = 0; turn < 64; turn++) {
    const angle = (turn / 64) * Math.PI * 2;
    const at = {
      x: cruiser.x + Math.cos(angle) * distance,
      y: cruiser.y + Math.sin(angle) * distance,
    };
    if (isAreaFree(game.world.map, at.x, at.y, testSimConfig.player.radius))
      return at;
  }
  throw new Error("no room by the cruiser");
}

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Faces right of where `game`'s local player stands, kicking. */
const kickRight = (game: Session): Controls => ({
  ...idle,
  secondary: true,
  aim: { x: game.local.x + 1000, y: game.local.y },
});

test("a guest whose health runs out is a ghost everywhere: what it carried lands nearby, and its body lies as its named corpse", async () => {
  const { rooms, room, run } = await crew("a", "b", "c");
  const host = sessionOf(room("a"));
  expect(giveItem(host, "b", "walkie")).toBe(true);
  run(300);
  const fell = { ...playerOn(room("a"), "b") };
  kill(room("a"), "b");
  run(1000);
  for (const each of rooms.values()) {
    const game = sessionOf(each);
    expect(isGhost(playerOn(each, "b"))).toBe(true);
    const [corpse, ...others] = corpses(game);
    expect(others).toEqual([]);
    expect(corpse?.at).toEqual({ x: fell.x, y: fell.y });
    expect(
      itemName(game, { id: CORPSE_ITEM, name: "Corpse", state: corpse?.state }),
    ).toBe("B's corpse");
    const [walkie] = itemInstances(game, "walkie");
    expect(walkie !== undefined && "lying" in walkie.place).toBe(true);
    expect(
      distance(walkie?.at ?? { x: Infinity, y: 0 }, fell),
    ).toBeLessThanOrEqual(testSimConfig.death.scatter);
  }
  expect(
    sessionOf(room("b")).local.inventory.every((item) => item === null),
  ).toBe(true);
  expect(itemIn(host, "b", 0)).toBe(null);
});

test("scrap a falling player carried clatters as it lands, a noise monsters hear", async () => {
  const { room, run, step } = await crew("a", "b");
  const host = sessionOf(room("a"));
  expect(giveItem(host, "b", "scrap")).toBe(true);
  run(300);
  const fell = { ...playerOn(room("a"), "b") };
  kill(room("a"), "b");
  const clatters = [];
  for (let at = 0; at < 1000; at += 1000 / 60) {
    step();
    clatters.push(
      ...host.noises.filter(
        (noise) => noise.radius === testItemsConfig.scrap.dropNoiseRadius,
      ),
    );
  }
  expect(clatters).toHaveLength(1);
  expect(distance(clatters[0]?.at ?? fell, fell)).toBeLessThanOrEqual(
    testSimConfig.death.scatter,
  );
});

test("a ghost is not kicked, makes no noise as it moves, and acts not at all", async () => {
  const { room, run, step } = await crew("a", "b");
  kill(room("a"), "b");
  run(500);
  const host = sessionOf(room("a"));
  const health = playerOn(room("a"), "b").health;
  step({ a: kickRight(host) });
  run(500);
  expect(playerOn(room("a"), "b").health).toBe(health);
  for (let at = 0; at < 1000; at += 1000 / 60) {
    step({ b: { ...idle, move: { x: 0, y: 1 }, secondary: true } });
    expect(host.noises.filter((noise) => noise.source === "b")).toEqual([]);
  }
  // Its body stays where it fell on the host, kicking nobody.
  expect(playerOn(room("a"), "a").health).toBe(testSimConfig.player.maxHealth);
});

test("ghosts hear each other wherever they are; the living hear no ghost", async () => {
  const { room, run } = await crew("a", "b", "c");
  kill(room("a"), "b");
  kill(room("a"), "c");
  run(1000);
  const onB = sessionOf(room("b"));
  expect(
    voiceRoutes(onB, playerOn(room("b"), "c"), onB.local).some(
      (route) => route.at === null,
    ),
  ).toBe(true);
  const onA = sessionOf(room("a"));
  expect(voiceRoutes(onA, playerOn(room("a"), "b"), onA.local)).toEqual([]);
  // A ghost hears the living through the air, as anyone does.
  expect(voiceRoutes(onB, playerOn(room("b"), "a"), onB.local)).toHaveLength(1);
});

test("a corpse carried to the cruiser brings its player back beside it, alive, on every client, for credit the team may not have", async () => {
  const { rooms, room, run, place } = await crew("a", "b");
  const host = sessionOf(room("a"));
  const reach = testEntitiesConfig.cruiser.revive.reach;
  kill(room("a"), "b");
  run(500);
  const [corpse] = corpses(host);
  if (corpse === undefined || !("lying" in corpse.place))
    throw new Error("no corpse lying");
  host.entities.delete(corpse.place.lying.id);
  expect(
    giveItem(host, "a", CORPSE_ITEM, undefined, undefined, corpse.state),
  ).toBe(true);
  run(500);
  expect(isGhost(playerOn(room("a"), "b"))).toBe(true);
  credit.set(host, 2);
  place("a", byCruiser(host, cruiserOf(host).radius + reach / 2));
  run(1000);
  const cruiser = cruiserOf(host);
  for (const each of rooms.values()) {
    // The revival costs what it costs, into debt.
    expect(credit.get(sessionOf(each))).toBe(
      2 - testEntitiesConfig.cruiser.revive.cost,
    );
    const b = playerOn(each, "b");
    expect(isGhost(b)).toBe(false);
    expect(b.health).toBe(testSimConfig.death.reviveHealth);
    expect(distance(b, cruiser)).toBeLessThanOrEqual(
      testSimConfig.arrival.spread + 1,
    );
    expect(corpses(sessionOf(each))).toEqual([]);
  }
});

test("a host that dies goes on hosting as a ghost; the next host keeps its body, and brings it back at the cruiser", async () => {
  const { room, run } = await crew("a", "b");
  kill(room("a"), "a");
  run(1000);
  expect(room("a").hostId()).toBe("a");
  expect(isGhost(sessionOf(room("a")).local)).toBe(true);
  expect(corpses(sessionOf(room("b")))).toHaveLength(1);
  await room("a").leave();
  run(5000);
  const guest = sessionOf(room("b"));
  expect(guest.hosting).toBe(true);
  run(1000);
  // Still one body: the new host does not lay another.
  expect(corpses(guest)).toHaveLength(1);
});

test("a player who dies at the wheel is put out of the cruiser, and falls beside it", async () => {
  const { room, run } = await crew("a", "b");
  const host = sessionOf(room("a"));
  const cruiser = cruiserOf(host);
  const driver = playerOn(room("a"), "b");
  alter(host, driver, (taken) => {
    Object.assign(taken, {
      x: cruiser.x,
      y: cruiser.y,
      ride: {
        vehicle: cruiser.id,
        driving: true,
        heading: 0,
        speed: 0,
        turn: 0,
      },
    });
  });
  expect(driverOf(host, cruiser.id)).toBe(driver);
  kill(room("a"), "b");
  run(500);
  expect(driverOf(host, cruiser.id)).toBe(null);
  const [corpse] = corpses(host);
  if (corpse === undefined) throw new Error("no corpse");
  expect(distance(corpse.at, cruiser)).toBeGreaterThan(cruiser.radius);
  // Lying by the cruiser does not bring it back; only one carried there does.
  expect(isGhost(driver)).toBe(true);
});

test("a zombie pays a ghost no mind, though it chases the living", async () => {
  const { room, run, place } = await crew("a", "b");
  const host = sessionOf(room("a"));
  kill(room("a"), "b");
  place("a", { x: 750, y: 100 });
  run(500);
  const b = playerOn(room("a"), "b");
  expect(playersIn(host, { center: b, radius: 1 })).toEqual([]);
  // Out of the way: a zombie hunts what lies about as it would anything not marked inert.
  for (const { place: lies } of itemInstances(host))
    if ("lying" in lies) host.entities.delete(lies.lying.id);
  const zombie = spawnEntity(host, "zombie", b.x - 80, b.y, {
    mode: "wander",
    seed: 1,
    route: [],
    target: null,
    standUntil: host.worldTime + 60,
    noiseTarget: null,
    barkAt: host.worldTime + 60,
    attackAt: 0,
    attacking: false,
    restUntil: 0,
    facing: 0,
  });
  run(1000);
  expect(zombie.data).toMatchObject({ mode: "wander" });
  place("a", { x: b.x, y: b.y });
  run(1000);
  expect(zombie.data).toMatchObject({ mode: "chase" });
});
