import type { SoundHandle } from "../audio/index.js";
import type { ItemInstance } from "./item-instances.js";
import { itemInstances } from "./item-instances.js";
import type { Session } from "./session.js";

/** A long sound an item plays where it is, for as long as it says: a radio's song, say. */
interface ItemPlaying {
  /**
   * Names this playing of it, the same wherever the item goes: one that keeps its key plays on
   * as the item is picked up and dropped, and a new key starts it afresh.
   */
  readonly key: string;
  readonly url: string;
  /** When it started, on the world's clock: a client that comes upon it joins it that far in. */
  readonly since: number;
  /** How loud it plays, 0..1; full when left out. */
  readonly volume?: number;
  /** How far it is heard, in pixels, fading to silence there. */
  readonly range?: number;
  /** Whether it starts again at its end. */
  readonly loop?: boolean;
}

/** What each item plays, by item id, as its content says. */
export type ItemPlays = (
  instance: ItemInstance,
  game: Session,
) => ItemPlaying | null;

/** What this client streams of each session's items, by item id and key. */
const streaming = new WeakMap<Session, Map<string, SoundHandle>>();

/**
 * What every item in the world plays now, by item id and key, wherever it is: the first of any
 * one key, should two items play under it.
 */
function itemPlayings(
  game: Session,
): Map<
  string,
  { readonly playing: ItemPlaying; readonly at: ItemInstance["at"] }
> {
  const wanted = new Map<
    string,
    { readonly playing: ItemPlaying; readonly at: ItemInstance["at"] }
  >();
  for (const instance of itemInstances(game)) {
    const playing = game.items.get(instance.item)?.plays?.(instance, game);
    if (playing === undefined || playing === null) continue;
    const key = `${instance.item}:${playing.key}`;
    if (!wanted.has(key)) wanted.set(key, { playing, at: instance.at });
  }
  return wanted;
}

/**
 * Keeps what this client streams in step with what items play: starts each new one as far in as
 * the world's clock has it, moves each playing one to where its item is now, and stops each that
 * no item plays any more.
 */
export function followItemSounds(game: Session): void {
  const playing = streaming.get(game) ?? new Map<string, SoundHandle>();
  streaming.set(game, playing);
  const wanted = itemPlayings(game);
  for (const [key, handle] of playing) {
    if (wanted.has(key)) continue;
    handle.stop(0.3);
    playing.delete(key);
  }
  for (const [key, { playing: sound, at }] of wanted) {
    const handle = playing.get(key);
    if (handle !== undefined) {
      handle.setPosition(at, game.local);
      continue;
    }
    playing.set(
      key,
      game.sfx.stream(sound.url, at, game.local, {
        offset: Math.max(0, game.worldTime - sound.since),
        ...(sound.volume !== undefined && { volume: sound.volume }),
        ...(sound.range !== undefined && { range: sound.range }),
        ...(sound.loop !== undefined && { loop: sound.loop }),
      }),
    );
  }
}
