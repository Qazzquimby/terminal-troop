import { sumBy } from "lodash-es";
import type { VoiceParams } from "../../sim/index.js";

/*
 * A small formant synthesizer. A line of text becomes a run of sounds, one or two a letter: vowels
 * and voiced consonants are a buzzing glottal pulse at the voice's pitch through three resonances
 * of the throat, the formants, gliding from letter to letter; hissed consonants are noise through
 * a band; stops are a closure then a burst; spaces and punctuation are pauses. It babbles rather
 * than speaks words, in a voice set by its params, and runs headless: it returns samples, which the
 * audio adapter plays from wherever the speaker stands.
 */

type Formants = readonly [number, number, number];

/** One sound in a line. */
interface Segment {
  /** How long it lasts, in letters' time: 1 is one letter at the voice's rate. */
  readonly length: number;
  /** The formants it glides toward, in Hz for an adult's throat. */
  readonly formants: Formants;
  /** How much of the voiced pulse sounds, 0..1. */
  readonly voiced: number;
  /** How much hiss sounds, 0..1, and the band it is in, in Hz. */
  readonly hiss: number;
  readonly band: number;
  /** Whether it ends a sentence asking something: its pitch rises. */
  readonly asks?: boolean;
  /** Whether it ends a sentence or clause: the pitch line starts afresh after it. */
  readonly breaks?: boolean;
  /** Whether it is the gap between words: the next word may be stressed. */
  readonly spaces?: boolean;
}

const VOWELS: Readonly<Record<string, Formants>> = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  o: [570, 840, 2410],
  u: [300, 870, 2240],
  y: [300, 2100, 2900],
};

/** Voiced consonants: formants, and how strongly they buzz and hiss. */
const VOICED: Readonly<
  Record<string, { f: Formants; voiced: number; hiss: number; band: number }>
> = {
  l: { f: [360, 1300, 2700], voiced: 0.7, hiss: 0, band: 0 },
  m: { f: [280, 900, 2200], voiced: 0.45, hiss: 0, band: 0 },
  n: { f: [280, 1700, 2600], voiced: 0.45, hiss: 0, band: 0 },
  r: { f: [420, 1300, 1600], voiced: 0.7, hiss: 0, band: 0 },
  w: { f: [300, 610, 2200], voiced: 0.6, hiss: 0, band: 0 },
  j: { f: [300, 2000, 2700], voiced: 0.5, hiss: 0.3, band: 3500 },
  v: { f: [300, 1400, 2400], voiced: 0.45, hiss: 0.25, band: 4000 },
  z: { f: [300, 1600, 2600], voiced: 0.4, hiss: 0.35, band: 5500 },
};

/** Hissed consonants: the band their noise is in, in Hz. */
const HISSED: Readonly<Record<string, number>> = {
  s: 6000,
  c: 6000,
  x: 5000,
  f: 3500,
  h: 2000,
};

/** Stops: the band of their burst, in Hz, and whether a buzz carries through their closure. */
const STOPS: Readonly<Record<string, { band: number; voiced: boolean }>> = {
  p: { band: 900, voiced: false },
  t: { band: 4500, voiced: false },
  k: { band: 2200, voiced: false },
  q: { band: 2200, voiced: false },
  b: { band: 900, voiced: true },
  d: { band: 4500, voiced: true },
  g: { band: 2200, voiced: true },
};

/** The neutral throat a pause or hiss settles toward. */
const SCHWA: Formants = [500, 1500, 2500];

/** Pauses, in letters' time, by the character that makes them. */
const PAUSES: Readonly<Record<string, number>> = {
  " ": 0.6,
  ",": 2,
  ";": 2,
  ":": 2,
  "-": 1,
  ".": 3,
  "!": 3,
  "?": 3,
};

const pause = (length: number, extra: Partial<Segment> = {}): Segment => ({
  length,
  formants: SCHWA,
  voiced: 0,
  hiss: 0,
  band: 0,
  ...extra,
});

/** The sounds `text` is said as, in order. */
export function segmentsOf(text: string): Segment[] {
  const segments: Segment[] = [];
  let last: Formants = SCHWA;
  for (const raw of text.toLowerCase()) {
    const vowel = VOWELS[raw];
    const voiced = VOICED[raw];
    const hissed = HISSED[raw];
    const stop = STOPS[raw];
    const paused = PAUSES[raw];
    if (vowel !== undefined) {
      segments.push({
        length: 1.2,
        formants: vowel,
        voiced: 1,
        hiss: 0,
        band: 0,
      });
      last = vowel;
    } else if (voiced !== undefined) {
      segments.push({ length: 0.8, formants: voiced.f, ...voiced });
    } else if (hissed !== undefined) {
      segments.push({
        length: 0.9,
        formants: last,
        voiced: 0,
        hiss: 1,
        band: hissed,
      });
    } else if (stop !== undefined) {
      segments.push(
        pause(0.45, { formants: last, voiced: stop.voiced ? 0.25 : 0 }),
      );
      segments.push({
        length: 0.3,
        formants: last,
        voiced: stop.voiced ? 0.5 : 0,
        hiss: 0.8,
        band: stop.band,
      });
    } else if (paused !== undefined) {
      segments.push(
        pause(paused, {
          asks: raw === "?",
          breaks: paused >= 2,
          spaces: raw === " ",
        }),
      );
    } else if (/\p{L}|\p{N}/u.test(raw)) {
      // Any other letter or digit: a vowel, so foreign words and numbers still babble.
      segments.push({
        length: 1,
        formants: SCHWA,
        voiced: 1,
        hiss: 0,
        band: 0,
      });
    }
  }
  return segments;
}

/** Seconds `segments` take at `rate` letters a second. */
const secondsOf = (segments: readonly Segment[], rate: number): number =>
  sumBy(segments, "length") / Math.max(rate, Number.EPSILON);

/** A seeded generator of numbers in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from `text`, so a line sounds the same each time, on every client. */
function seedOf(text: string): number {
  let hash = 2166136261;
  for (const character of text)
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
  return hash >>> 0;
}

/** A two-pole band-pass filter whose centre and width may change as it runs. */
class Resonator {
  private b0 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(private readonly sampleRate: number) {}

  /** Centres it on `frequency` Hz, `width` Hz wide, peaking at a gain of 1. */
  tune(frequency: number, width: number): void {
    const nyquistSafe = Math.min(frequency, this.sampleRate * 0.45);
    const w0 = (2 * Math.PI * nyquistSafe) / this.sampleRate;
    const q = Math.max(nyquistSafe / Math.max(width, 1), 0.3);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  next(x: number): number {
    const y = this.b0 * (x - this.x2) - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Formant bandwidths, in Hz, widened a little for a breathy voice. */
const WIDTHS: Formants = [90, 110, 160];
/** How loud each formant sounds against the first. */
const FORMANT_GAINS: Formants = [1, 0.55, 0.3];
/** Samples between retuning the filters as the throat glides. */
const RETUNE = 32;
/** Seconds the throat takes to glide most of the way to the next sound. */
const GLIDE = 0.025;
/** Seconds loudness takes to settle, so sounds start and stop without a click. */
const EDGE = 0.006;
/** The loudest a line is made, before its voice's volume. */
const PEAK = 0.9;

/** The pitch, in semitones off the voice's own, at the start and end of each segment. */
function pitchLine(
  segments: readonly Segment[],
  voice: VoiceParams,
  random: () => number,
): { start: number; end: number }[] {
  const { intonation } = voice;
  const line: { start: number; end: number }[] = [];
  // Each clause falls from above the voice's pitch to below it, a word now and then stressed.
  let clause: Segment[] = [];
  const flush = (asks: boolean): void => {
    const total = sumBy(clause, "length");
    let done = 0;
    let stress = (random() - 0.5) * intonation * 0.6;
    for (const segment of clause) {
      if (segment.spaces === true) stress = (random() - 0.5) * intonation * 0.6;
      const from = total === 0 ? 0 : done / total;
      done += segment.length;
      const to = total === 0 ? 0 : done / total;
      const fall = (t: number): number =>
        intonation * (0.5 - t) +
        stress +
        (asks && t > 0.7 ? (intonation * 2 * (t - 0.7)) / 0.3 : 0);
      line.push({ start: fall(from), end: fall(to) });
    }
    clause = [];
  };
  for (const segment of segments) {
    clause.push(segment);
    if (segment.breaks === true) flush(segment.asks === true);
  }
  flush(false);
  return line;
}

/**
 * `text` said in `voice`, as mono samples at `sampleRate` Hz, peaking at 0.9; the same each time
 * for the same line and voice. Empty for a line with nothing to say.
 */
export function synthesize(
  text: string,
  voice: VoiceParams,
  sampleRate: number,
): Float32Array {
  const segments = segmentsOf(text);
  if (!segments.some((segment) => segment.voiced > 0 || segment.hiss > 0))
    return new Float32Array(0);
  const random = seeded(seedOf(text));
  const pitches = pitchLine(segments, voice, random);
  const letter = 1 / Math.max(voice.rate, Number.EPSILON);
  const total = Math.ceil(secondsOf(segments, voice.rate) * sampleRate);
  const out = new Float32Array(total);

  const roughness = Math.min(Math.max(voice.roughness, 0), 1);
  const breath = Math.min(Math.max(voice.breathiness, 0), 1);
  const scale = Math.max(voice.formant, 0.1);
  const formants = SCHWA.map((f) => f * scale);
  const glide = 1 - Math.exp(-RETUNE / (GLIDE * sampleRate));
  const edge = 1 - Math.exp(-1 / (EDGE * sampleRate));
  const resonators = formants.map(() => new Resonator(sampleRate));
  const hissFilter = new Resonator(sampleRate);
  let voicedLevel = 0;
  let hissLevel = 0;
  let phase = 0;
  let periodPitch = 1;
  let periodGain = 1;
  let tilt = 0;
  let sample = 0;

  segments.forEach((segment, index) => {
    const pitch = pitches[index] ?? { start: 0, end: 0 };
    const count = Math.round(segment.length * letter * sampleRate);
    const targets = segment.formants.map((f) => f * scale);
    hissFilter.tune(segment.band * Math.sqrt(scale), segment.band * 0.5);
    for (let n = 0; n < count && sample < total; n += 1, sample += 1) {
      if (sample % RETUNE === 0) {
        resonators.forEach((resonator, f) => {
          const current = formants[f] ?? 0;
          const next = current + ((targets[f] ?? current) - current) * glide;
          formants[f] = next;
          resonator.tune(next, (WIDTHS[f] ?? 100) * (1 + breath));
        });
      }
      voicedLevel += (segment.voiced - voicedLevel) * edge;
      hissLevel += (segment.hiss - hissLevel) * edge;

      const t = count === 0 ? 0 : n / count;
      const semitones = pitch.start + (pitch.end - pitch.start) * t;
      const f0 = voice.pitch * 2 ** (semitones / 12) * periodPitch;
      phase += f0 / sampleRate;
      if (phase >= 1) {
        phase -= 1;
        // Each period wavers a little in pitch and loudness: a rough voice wavers more.
        periodPitch = 1 + (random() - 0.5) * roughness * 0.12;
        periodGain = 1 + (random() - 0.5) * roughness * 0.8;
      }
      // A falling sawtooth, softened so its highest harmonics drop away as a throat's do.
      tilt += (1 - 2 * phase - tilt) * 0.35;
      const noise = random() * 2 - 1;
      const source =
        voicedLevel * ((1 - breath) * tilt * periodGain + breath * noise * 0.6);
      let voiced = 0;
      resonators.forEach((resonator, f) => {
        voiced += resonator.next(source) * (FORMANT_GAINS[f] ?? 0);
      });
      const hissed = hissFilter.next(noise) * hissLevel * 0.7;
      let value = voiced + hissed;
      if (voice.ring > 0) {
        // Half through a ring modulator: a robot's metallic edge.
        const carrier = Math.sin(
          (2 * Math.PI * voice.ring * sample) / sampleRate,
        );
        value = value * 0.5 + value * carrier * 0.5;
      }
      out[sample] = value;
    }
  });

  let peak = 0;
  for (const value of out) peak = Math.max(peak, Math.abs(value));
  if (peak > 0) {
    const gain = PEAK / peak;
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) * gain;
  }
  return out;
}
