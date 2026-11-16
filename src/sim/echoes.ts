import { z } from "zod";
import type { SoundHandle } from "../audio/index.js";
import { effect } from "./actions.js";
import { contentEvent } from "./content-event.js";
import type { WorldEntity } from "./entities.js";
import { playerData } from "./player-data.js";
import type { Session } from "./session.js";
import { VOICE_TAG } from "./voice-noise.js";

/*
 * Echoes: a world entity speaking in a player's own voice. Each client keeps a few clips of its
 * own player's speech, cut between pauses, which only ever holds what its mic already sent out to
 * the others (see the voice adapter). The host asks the client of the player whose voice is wanted
 * for one; that client sends it to every other client, which plays it from the entity, following
 * it as it moves. The player's own client plays nothing: nobody hears their own voice echoed.
 * Clips never pass through the host unless it is the player asked, and none are kept anywhere but
 * on the speaker's own client.
 */

/** A clip of a player's own speech, as its client recorded it: its media type, its bytes in base64. */
interface VoiceClip {
  readonly mime: string;
  readonly data: string;
}

/**
 * Port to the local player's recorded speech, and to how this client hears voices. The voice
 * adapter provides it; a session without one holds no clips.
 */
export interface VoiceClips {
  /** How many clips of the local player's own speech are held now. */
  count(): number;
  /** The held clip at `index`, counting round; null with none held. */
  clip(index: number): VoiceClip | null;
  /** Whether the local player muted `id`'s voice: an echo of it is silent too. */
  muted(id: string): boolean;
  /** How loud incoming voices play, 0..1. */
  volume(): number;
}

/** Holds no clips, mutes no one, and plays voices at full. */
export const noClips: VoiceClips = {
  count: () => 0,
  clip: () => null,
  muted: () => false,
  volume: () => 1,
};

/** How echoes travel. */
export interface EchoConfig {
  /** Longest clip, in base64 characters, a client sends or accepts. */
  readonly maxChars: number;
}

/**
 * How many clips of its own speech each player's client holds: the host asks only one that holds
 * some. A player reports its own.
 */
export const clipsHeld = playerData<number>({
  schema: z.number().int().min(0),
  initial: () => 0,
});

/** An audio media type, perhaps with parameters such as its codec. */
const Mime = z
  .string()
  .max(64)
  .regex(/^audio\/[\w.+-]+(;[\w=.+\- ]*)*$/);

const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

const EntityId = z.string().min(1).max(80);

/** Sent by the speaker's client to every other: play this clip from that entity. */
const echo = contentEvent({
  schema: z.object({
    by: EntityId,
    range: z.number().min(0),
    mime: Mime,
    data: Base64,
  }),
  to: "all",
  receive(game, { by, range, mime, data }, sender) {
    if (sender === game.localId) return;
    if (data.length > game.config.echoes.maxChars) return;
    if (game.clips.muted(sender)) return;
    const entity = game.entities.get(by);
    if (entity === undefined) return;
    const playing = game.sfx.play(
      `data:${mime};base64,${data}`,
      entity,
      game.local,
      { range, volume: game.clips.volume(), cache: false },
    );
    const echoes = echoesOf(game);
    // An entity says one thing at a time: what it said before stops.
    void echoes.get(by)?.then((handle) => {
      handle.stop();
    });
    echoes.set(by, playing);
  },
});

/** Sent by the host to the speaker's client: send the others clip `pick` of yours, from `by`. */
const ask = contentEvent({
  schema: z.object({
    by: EntityId,
    range: z.number().min(0),
    pick: z.number().int().min(0),
  }),
  to: "player",
  from: "host",
  receive(game, { by, range, pick }) {
    const clip = game.clips.clip(pick);
    if (clip === null || clip.data.length > game.config.echoes.maxChars) return;
    echo.send(game, { by, range, ...clip });
  },
});

/** The events echoes travel by, by key. */
export const echoEvents = { ask, echo };

/** Each session's echoes playing, by the entity each plays from. */
const playing = new WeakMap<Session, Map<string, Promise<SoundHandle>>>();

function echoesOf(game: Session): Map<string, Promise<SoundHandle>> {
  let echoes = playing.get(game);
  if (echoes === undefined) {
    echoes = new Map();
    playing.set(game, echoes);
  }
  return echoes;
}

/**
 * As the host, has `by` speak in player `of`'s voice, heard out to `range`: clip `pick` of those
 * `of`'s client holds plays from `by` on every client but `of`'s own, and `by` makes a voice's
 * noise as far. Does nothing, and returns false, while `of` holds no clips, or is not in the
 * session: an entity never makes a voice's noise that nobody hears.
 */
export function echoVoice(
  game: Session,
  by: WorldEntity,
  of: string,
  range: number,
  pick: number,
): boolean {
  if (!game.hosting) return false;
  const player = game.players.get(of);
  if (player === undefined || clipsHeld.get(player) === 0) return false;
  ask.send(game, of, { by: by.id, range, pick: Math.floor(pick) });
  effect(game, { at: by, noise: range, tags: [VOICE_TAG] }, by);
  return true;
}

/**
 * Each step on every client: reports how many clips the local player holds, and moves each echo
 * playing to where its entity now stands, stopping those whose entity is gone.
 */
export function followEchoes(game: Session): void {
  const held = game.clips.count();
  if (clipsHeld.get(game.local) !== held) clipsHeld.set(game.local, held);
  const echoes = playing.get(game);
  if (echoes === undefined) return;
  for (const [id, handle] of echoes) {
    const entity = game.entities.get(id);
    void handle.then((sound) => {
      if (entity === undefined) sound.stop();
      else sound.setPosition(entity, game.local);
    });
    if (entity === undefined) echoes.delete(id);
  }
}
