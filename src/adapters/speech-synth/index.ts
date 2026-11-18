import type { Sfx } from "../../audio/index.js";
import type { Speech } from "../../sim/index.js";
import { synthesize } from "./synth.js";

/**
 * Speech said by the formant synthesizer at `sampleRate` Hz, played through `sfx` like any other
 * sound: positioned, faded out to its voice's range, under the master volume, and moved by
 * whoever holds its handle as its speaker moves.
 */
export function createSpeechSynth(
  sfx: Pick<Sfx, "playSamples">,
  sampleRate: number,
): Speech {
  return {
    say({ text, voice, at, listener }) {
      return sfx.playSamples(
        synthesize(text, voice, sampleRate),
        sampleRate,
        at,
        listener,
        { volume: voice.volume, range: voice.range },
      );
    },
  };
}
