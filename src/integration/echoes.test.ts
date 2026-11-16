import { expect, test, vi } from "vitest";
import type { Sfx } from "../audio/index.js";
import { entityContent } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { spawnEntity, VOICE_TAG } from "../sim/index.js";
import type { Noise, Session } from "../sim/index.js";
import type { Voice, VoiceClip } from "../voice/index.js";
import { crew, nullVoice, sessionOf } from "./crew.js";
import { testEntitiesConfig, testSfx } from "./sim-config.js";

/** No zombies to get in the way. */
const entities: EntitiesConfig = {
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
  },
};

const CLIP: VoiceClip = { mime: "audio/webm;codecs=opus", data: "SGVsbG8=" };

/** A null voice holding `clips`, with the peers in `muted` muted. */
function voiceWith(
  clips: readonly VoiceClip[],
  muted: readonly string[] = [],
): Voice {
  const voice = nullVoice();
  return {
    ...voice,
    clipCount: () => clips.length,
    clip: (index) => clips[index % Math.max(1, clips.length)] ?? null,
    status: () => ({ ...voice.status(), mutedPeers: [...muted] }),
  };
}

/** Each client's sound effects, every url it plays recorded. */
function recording(): {
  sfx: (id: string) => Sfx;
  played: (id: string) => string[];
} {
  const made = new Map<string, Sfx>();
  return {
    sfx(id) {
      const sfx = testSfx();
      vi.spyOn(sfx, "play");
      made.set(id, sfx);
      return sfx;
    },
    played: (id) =>
      vi
        .mocked(made.get(id)?.play ?? (() => Promise.reject(new Error())))
        .mock.calls.map(([url]) => url),
  };
}

const echoes = (urls: readonly string[]): string[] =>
  urls.filter((url) => url.startsWith("data:"));

/**
 * Host `a`, `b`, whose voice a doppelganger copies, and `c`, all close by in the dev square,
 * `b` holding `clips` and `c` muting those in `muted`. The doppelganger stands among them.
 */
async function setup(
  clips: readonly VoiceClip[],
  muted: readonly string[] = [],
) {
  const sounds = recording();
  const team = await crew(
    {
      spots: {
        a: { x: 425, y: 300 },
        b: { x: 475, y: 300 },
        c: { x: 450, y: 350 },
      },
      content: entityContent(entities),
      sfx: sounds.sfx,
      voice: (id) =>
        id === "b" ? voiceWith(clips) : voiceWith([], id === "c" ? muted : []),
    },
    "a",
    "b",
    "c",
  );
  const host: Session = sessionOf(team.room("a"));
  // Far enough off that no one is in its reach, and it has nobody's last whereabouts.
  const double = spawnEntity(host, "doppelganger", 800, 100, {
    mode: "wander",
    copies: "b",
    name: "B",
    held: null,
    facing: 0,
    seed: 3,
    route: [],
    lookFrom: 0,
    lookUntil: null,
    known: null,
    quarry: null,
    watchedAt: host.worldTime + 60,
    barkAt: null,
    attackAt: 0,
    attacking: false,
    stepAt: 0,
  });
  return { ...team, ...sounds, host, double };
}

/** Steps `ms`, collecting every noise each client's session made. */
function listen(team: Awaited<ReturnType<typeof setup>>, ms: number): Noise[] {
  const heard: Noise[] = [];
  for (let at = 0; at < ms; at += 1000 / 60) {
    team.step();
    heard.push(...team.host.noises);
  }
  return heard;
}

test("it speaks in its player's recorded voice every 6 to 12s, heard by everyone but that player", async () => {
  const team = await setup([CLIP]);
  const heard = listen(team, 13_000);
  const url = `data:${CLIP.mime};base64,${CLIP.data}`;
  expect(echoes(team.played("a"))).toContain(url);
  expect(echoes(team.played("c"))).toContain(url);
  expect(echoes(team.played("b"))).toEqual([]);
  // And speaking makes a voice's noise where it stands, as far as its bark carries.
  const spoken = heard.filter(
    (noise) =>
      noise.source === team.double.id && noise.tags.includes(VOICE_TAG),
  );
  expect(spoken.length).toBeGreaterThan(0);
  expect(spoken[0]?.radius).toBe(testEntitiesConfig.doppelganger.barkRange);
});

test("a player holding no clips of its speech is never echoed, and no voice's noise is made", async () => {
  const team = await setup([]);
  const heard = listen(team, 13_000);
  for (const id of ["a", "b", "c"]) expect(echoes(team.played(id))).toEqual([]);
  expect(heard.some((noise) => noise.tags.includes(VOICE_TAG))).toBe(false);
});

test("a player who muted the copied player hears nothing of it echoed either", async () => {
  const team = await setup([CLIP], ["b"]);
  listen(team, 13_000);
  expect(echoes(team.played("a")).length).toBeGreaterThan(0);
  expect(echoes(team.played("c"))).toEqual([]);
});
