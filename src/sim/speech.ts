import { z } from "zod";
import type { SoundHandle } from "../audio/index.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";

/*
 * Speech: a body saying a line of text aloud in a voice. Content says it through an effect (see
 * `say` in the actions framework), naming the voice by id; every client that perceives the speaker
 * hears it synthesized where the speaker stands, following it as it moves, and sees the line over
 * it a while. The synthesizer is an adapter behind the `Speech` port, so the sim never makes sound
 * itself. A line makes a voice's noise out to its voice's range, so whatever listens hears it.
 */

/** How a voice sounds; the synthesizer reads these, and the sim only its range and rate. */
export interface VoiceParams {
  /** Its speaking pitch, in Hz: about 120 for a man, 210 for a woman, 300 for a child. */
  readonly pitch: number;
  /** Semitones its pitch rises and falls over a line; 0 drones on one note. */
  readonly intonation: number;
  /** How fast it speaks, in letters a second. */
  readonly rate: number;
  /**
   * Scales the resonances of its throat: above 1 a smaller one, a child's; below 1 a larger one,
   * a giant's.
   */
  readonly formant: number;
  /** 0..1: how much each pitch period wavers in pitch and loudness, from smooth to gravel. */
  readonly roughness: number;
  /** 0..1: how much breath is in it, from none to a whisper with no pitch at all. */
  readonly breathiness: number;
  /** A ring modulator's frequency over it, in Hz, for a robotic edge; 0 for none. */
  readonly ring: number;
  /** How loud it plays, 0..1. */
  readonly volume: number;
  /** How far it is heard, in pixels: by players' ears, and as a noise by whatever listens. */
  readonly range: number;
}

/** The voices bodies speak in, and how lines show. */
export interface SpeechConfig {
  /** Every voice, by id. */
  readonly voices: Readonly<Record<string, VoiceParams>>;
  /** The id of the voice a line in an unknown voice is said in. */
  readonly fallback: string;
  /** Seconds a line shows over its speaker after it has been said. */
  readonly captionHold: number;
}

/** A line to say: its text in `voice`, from `at`, heard by a listener at `listener`. */
export interface SpokenLine {
  readonly text: string;
  readonly voice: VoiceParams;
  readonly at: Point;
  readonly listener: Point | null;
}

/** Port to a speech synthesizer. The audio adapter provides it; a session without one is silent. */
export interface Speech {
  readonly say: (line: SpokenLine) => Promise<SoundHandle>;
}

const silent: SoundHandle = {
  stop: () => undefined,
  setVolume: () => undefined,
  setPosition: () => undefined,
};

/** Says nothing. */
export const noSpeech: Speech = { say: () => Promise.resolve(silent) };

/** Longest line, in characters, that travels in an effect. */
export const MAX_LINE = 280;

/** A line as it travels: what is said, and the id of the voice it is said in. */
export const SaidLine = z.object({
  text: z.string().min(1).max(MAX_LINE),
  voice: z.string().min(1).max(32),
});
export type SaidLine = z.infer<typeof SaidLine>;

/** Said by a config naming no voice at all: middling, and heard a few cells off. */
const BARE_VOICE: VoiceParams = {
  pitch: 140,
  intonation: 4,
  rate: 12,
  formant: 1,
  roughness: 0,
  breathiness: 0,
  ring: 0,
  volume: 0.8,
  range: 250,
};

/** The voice `id` names, or the fallback for one no config names. */
export function voiceOf(config: SpeechConfig, id: string): VoiceParams {
  const named = (key: string): VoiceParams | undefined =>
    Object.hasOwn(config.voices, key) ? config.voices[key] : undefined;
  return named(id) ?? named(config.fallback) ?? BARE_VOICE;
}

/** About how long, in seconds, `voice` takes to say `text`. */
const lineSeconds = (text: string, voice: VoiceParams): number =>
  text.length / Math.max(voice.rate, Number.EPSILON);

/** A line showing over its speaker until `until`, in sim seconds. */
interface Caption {
  readonly text: string;
  readonly until: number;
}

/** What each session's speakers are saying: the sound, and the line shown, by speaker id. */
interface Mouths {
  readonly sounds: Map<string, Promise<SoundHandle>>;
  readonly captions: Map<string, Caption>;
}

const mouths = new WeakMap<Session, Mouths>();

function mouthsOf(game: Session): Mouths {
  let held = mouths.get(game);
  if (held === undefined) {
    held = { sounds: new Map(), captions: new Map() };
    mouths.set(game, held);
  }
  return held;
}

/** The body, player or world entity, with id `id`; undefined for none. */
const speakerOf = (game: Session, id: string): Point | undefined =>
  game.entities.get(id) ?? game.players.get(id);

/**
 * Has `by` voice `playing` on this client: a speaker says one thing at a time, so what it said
 * before stops. It follows `by` as it moves until it ends or `by` is gone.
 */
export function speakFrom(
  game: Session,
  by: string,
  playing: Promise<SoundHandle>,
): void {
  const { sounds } = mouthsOf(game);
  void sounds.get(by)?.then((handle) => {
    handle.stop();
  });
  sounds.set(by, playing);
}

/**
 * Says `line` from `by` on this client alone, standing at `at` unless `by` is a body: heard in
 * its voice, and shown over it for as long as it takes to say and the hold after.
 */
export function sayHere(
  game: Session,
  by: string,
  at: Point,
  line: SaidLine,
): void {
  if (line.text === "") return;
  const { speech } = game.config;
  const voice = voiceOf(speech, line.voice);
  const from = speakerOf(game, by) ?? at;
  speakFrom(
    game,
    by,
    game.speech.say({
      text: line.text,
      voice,
      at: { x: from.x, y: from.y },
      listener: game.local,
    }),
  );
  mouthsOf(game).captions.set(by, {
    text: line.text,
    until: game.time + lineSeconds(line.text, voice) + speech.captionHold,
  });
}

/** The line showing over `id` now; null for none. */
export function captionOf(game: Session, id: string): string | null {
  const caption = mouths.get(game)?.captions.get(id);
  return caption !== undefined && game.time < caption.until
    ? caption.text
    : null;
}

/**
 * Each step on every client: moves what each speaker is saying to where it now stands, stopping
 * it once the speaker is gone, and drops lines done showing.
 */
export function followSpeakers(game: Session): void {
  const held = mouths.get(game);
  if (held === undefined) return;
  for (const [id, handle] of held.sounds) {
    const speaker = speakerOf(game, id);
    void handle.then((sound) => {
      if (speaker === undefined) sound.stop();
      else sound.setPosition(speaker, game.local);
    });
    if (speaker === undefined) held.sounds.delete(id);
  }
  for (const [id, caption] of held.captions)
    if (game.time >= caption.until || speakerOf(game, id) === undefined)
      held.captions.delete(id);
}
