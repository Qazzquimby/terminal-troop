import type { SoundHandle } from "../audio/index.js";
import type { ItemInstance } from "./item-instances.js";
import { itemInstances } from "./item-instances.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";

/**
 * A long sound an item or an entity holds where it is, for as long as it says: a radio's song, a
 * car radio's station or a running engine, say. It starts when what holds it first says so,
 * follows it as it moves, and stops once it no longer does.
 */
export interface Playing {
  /**
   * Names this playing of it, the same wherever the thing goes: one that keeps its key plays on
   * as an item is picked up and dropped, and a new key starts it afresh.
   */
  readonly key: string;
  /**
   * What it plays: one sound, or a list of them played one after another, each from its start,
   * and round again from the first when it loops.
   */
  readonly url: string | readonly string[];
  /** When it started, on the world's clock: a client that comes upon it joins it that far in. */
  readonly since: number;
  /** How loud it plays, 0..1; full when left out. */
  readonly volume?: number;
  /** How far it is heard, in pixels, fading to silence there. */
  readonly range?: number;
  /** Whether it starts again at its end. */
  readonly loop?: boolean;
  /** The sound channel it plays on, whose volume each client sets for itself; none when left out. */
  readonly channel?: string;
  /**
   * Where it plays from, when not where what holds it is: a teleporter's hum at the car that sent
   * for a body, say, held by the beam on the body. Followed as it moves, as its holder is.
   */
  readonly at?: Point;
}

/**
 * What an item or entity plays now: nothing, one long sound, or several at once, each under its
 * own key, such as a car's radio and its engine.
 */
export type Plays = Playing | readonly Playing[] | null;

/** Every sound in `plays`. */
function eachOf(plays: Plays | undefined): readonly Playing[] {
  if (plays === null || plays === undefined) return [];
  return "key" in plays ? [plays] : plays;
}

/** What each item plays, by item id, as its content says. */
export type ItemPlays = (instance: ItemInstance, game: Session) => Plays;

/** What this client streams of each session's items and entities, by key. */
const streaming = new WeakMap<Session, Map<string, SoundHandle>>();

/** Something played now, and where. */
interface Heard {
  readonly playing: Playing;
  readonly at: Point;
}

/**
 * What every item and entity in the world plays now, wherever it is: an item's by item id and
 * key, the first of any one key should two items play under it, and an entity's by its own id
 * and key.
 */
function playings(game: Session): Map<string, Heard> {
  const wanted = new Map<string, Heard>();
  for (const instance of itemInstances(game)) {
    const plays = game.items.get(instance.item)?.plays?.(instance, game);
    for (const playing of eachOf(plays)) {
      const key = `${instance.item}:${playing.key}`;
      if (!wanted.has(key))
        wanted.set(key, { playing, at: playing.at ?? instance.at });
    }
  }
  for (const entity of game.entities.values()) {
    const plays = game.entityTypes.get(entity.kind)?.plays(entity, game);
    for (const playing of eachOf(plays))
      wanted.set(`#${entity.id}:${playing.key}`, {
        playing,
        at: playing.at ?? { x: entity.x, y: entity.y },
      });
  }
  return wanted;
}

/**
 * Keeps what this client streams in step with what items and entities play: starts each new one
 * as far in as the world's clock has it, moves each playing one to where what plays it is now,
 * and stops each that nothing plays any more.
 */
export function followPlayings(game: Session): void {
  const playing = streaming.get(game) ?? new Map<string, SoundHandle>();
  streaming.set(game, playing);
  const wanted = playings(game);
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
        ...(sound.channel !== undefined && { channel: sound.channel }),
      }),
    );
  }
}
