import { afterEach, expect, test, vi } from "vitest";
import { createSfx } from "../audio/index.js";
import { entityContent } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import { moveContent } from "../moves/index.js";
import {
  declaredSounds,
  effect,
  hurtPlayer,
  isGhost,
  spawnEntity,
} from "../sim/index.js";
import type { Point, Sound } from "../sim/index.js";
import { crew, playerOn, sessionOf } from "./crew.js";
import { settle, stubAudio } from "./fake-audio.js";
import type { FakeSound } from "./fake-audio.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testMovesConfig,
  testSfx,
} from "./sim-config.js";

/** How sounds fade with no range of their own, as `testSfx` has it. */
const FALLOFF = { full: 0, silent: 1000, pan: 500 };

/** No zombies; a sleeper that barely scratches, so her quarry outlives every sound she makes. */
const entities: EntitiesConfig = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
  },
  sleeper: { ...testEntitiesConfig.sleeper, attackDamage: 1 },
};

const content = [
  ...entityContent(entities),
  ...itemContent(testItemsConfig),
  ...moveContent(testMovesConfig),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Host `a`, alive at (450, 300), and `b`, whose sounds play through a real sfx on stubbed audio,
 * killed by the host so it watches as a ghost.
 */
async function ghostCrew() {
  const audio = stubAudio();
  const team = await crew(
    {
      spots: { a: { x: 450, y: 300 }, b: { x: 100, y: 500 } },
      content,
      sfx: (id) => (id === "b" ? createSfx(FALLOFF) : testSfx()),
    },
    "a",
    "b",
  );
  const host = sessionOf(team.room("a"));
  const ghost = sessionOf(team.room("b"));
  hurtPlayer(host, playerOn(team.room("a"), "b"), Infinity);
  team.run(300);
  expect(isGhost(ghost.local)).toBe(true);
  /** Where the ghost watches from, as its spectator puts it. */
  const watch = (at: Point): void => {
    Object.assign(ghost.local, { x: at.x, y: at.y });
  };
  return { ...team, audio, host, ghost, watch };
}

/** The last part of a sound's url. */
const fileOf = (url: string): string => url.split("/").at(-1) ?? url;

const SLEEPER_SOUNDS = [
  "bark.mp3",
  "growl.mp3",
  "enrage.mp3",
  "rage-bark.mp3",
  "attack.mp3",
];

/** The sleeper's sounds the ghost has had played, by file. */
const sleeperSounds = (sounds: readonly FakeSound[]): FakeSound[] =>
  sounds.filter(
    ({ url }) =>
      url.includes("/sleeper/") && SLEEPER_SOUNDS.includes(fileOf(url)),
  );

/**
 * Wakes a sleeper at (650, 300) by host `a`, barking at once, and steps until the ghost has had
 * every one of her sounds played, calling `watching` each step for where it watches from.
 */
async function hearHerOut(
  team: Awaited<ReturnType<typeof ghostCrew>>,
  watching: (sleeper: Point) => Point,
): Promise<void> {
  const { host, audio, step, watch } = team;
  const now = host.worldTime;
  const sleeper = spawnEntity(host, "sleeper", 650, 300, {
    mode: "dormant",
    until: now,
    route: [],
    target: null,
    barkAt: now,
    attackAt: now,
    attacking: false,
    foe: null,
    victim: null,
    nearAt: now,
  });
  for (let frame = 0; frame < 60 * 8; frame++) {
    watch(watching(sleeper));
    step();
    await settle();
    const heard = new Set(sleeperSounds(audio.sounds()).map((s) => s.url));
    if (heard.size === SLEEPER_SOUNDS.length) return;
  }
  const heard = sleeperSounds(audio.sounds()).map(({ url }) => fileOf(url));
  throw new Error(`heard only ${heard.join(", ")}`);
}

test("a ghost far from the sleeper hears none of her sounds", async () => {
  const team = await ghostCrew();
  await hearHerOut(team, (sleeper) => ({ x: sleeper.x + 5000, y: sleeper.y }));
  const sounds = sleeperSounds(team.audio.sounds());
  expect(new Set(sounds.map(({ url }) => fileOf(url)))).toEqual(
    new Set(SLEEPER_SOUNDS),
  );
  for (const sound of sounds) expect(sound.volume()).toBe(0);
});

test("a ghost that heard the sleeper close by stops hearing each of her sounds once it watches from far off", async () => {
  const team = await ghostCrew();
  await hearHerOut(team, (sleeper) => ({ x: sleeper.x, y: sleeper.y }));
  const sounds = sleeperSounds(team.audio.sounds());
  for (const sound of sounds) expect(sound.volume()).toBeGreaterThan(0);

  team.watch({ x: 5000, y: 5000 });
  team.step();
  await settle();
  for (const sound of sounds) expect(sound.volume()).toBe(0);
});

/** How far `sound` is heard: its range, or as far as the falloff carries one without. */
const reach = (sound: Sound): number => sound.range ?? FALLOFF.silent;

/** Makes every sound content declares, by turns, as the host's effects at `at`. */
async function makeEach(
  team: Awaited<ReturnType<typeof ghostCrew>>,
  sounds: readonly Sound[],
  at: (sound: Sound) => Point,
): Promise<Map<string, FakeSound>> {
  const { host, audio, step } = team;
  for (const sound of sounds)
    effect(host, { at: at(sound), sound }, { id: host.localId });
  for (let frame = 0; frame < 30; frame++) {
    step();
    await settle();
  }
  const played = new Map(audio.sounds().map((each) => [each.url, each]));
  for (const { url } of sounds) expect(played.has(url), url).toBe(true);
  return played;
}

/** Every sound any content declares that can be heard at all. */
const audible = (): Sound[] =>
  declaredSounds().filter(
    (sound) => reach(sound) > 0 && (sound.volume ?? 1) > 0,
  );

test("a ghost hears no sound of any content made beyond its reach", async () => {
  const team = await ghostCrew();
  const at = { x: 400, y: 300 };
  team.watch(at);
  const sounds = audible();
  expect(sounds.length).toBeGreaterThan(SLEEPER_SOUNDS.length);
  const played = await makeEach(team, sounds, (sound) => ({
    x: at.x + reach(sound) + 1,
    y: at.y,
  }));
  for (const { url } of sounds) expect(played.get(url)?.volume(), url).toBe(0);
});

test("every sound of any content still playing goes silent once a ghost watches from beyond its reach", async () => {
  const team = await ghostCrew();
  const at = { x: 400, y: 300 };
  team.watch(at);
  const sounds = audible();
  const played = await makeEach(team, sounds, () => at);
  for (const { url } of sounds)
    expect(played.get(url)?.volume(), url).toBeGreaterThan(0);

  const furthest = Math.max(...sounds.map(reach));
  team.watch({ x: at.x + furthest + 1, y: at.y });
  team.step();
  for (const { url } of sounds) expect(played.get(url)?.volume(), url).toBe(0);
});
