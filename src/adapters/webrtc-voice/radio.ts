import type { RadioSoundConfig } from "../../voice/index.js";

/** What a peer's voice through a speaker plays at now, as `PeerLevels` has it. */
export interface RadioLevels {
  readonly radioGain: number;
  readonly radioPan: number;
  /** Whether a transmission plays through it at all, at any volume. */
  readonly radioKeyed: boolean;
  /** How much the transmission breaks up, 0..1. */
  readonly radioInterference: number;
}

/** The steady character of a voice through a speaker at one interference. */
export interface RadioTone {
  /** Gain driving the voice into clipping. */
  readonly drive: number;
  /** Steady static, as a share of the voice's volume. */
  readonly hiss: number;
  /** Dropouts a second. */
  readonly dropouts: number;
  /** Crackles a second. */
  readonly crackles: number;
}

const lerp = (from: number, to: number, t: number): number =>
  from + (to - from) * t;

/** How a voice through a speaker sounds at `interference`, 0..1, blended from clean to worst. */
export function radioTone(
  interference: number,
  config: RadioSoundConfig,
): RadioTone {
  const t = Math.min(1, Math.max(0, interference));
  return {
    drive: lerp(config.crunch.clean, config.crunch.worst, t),
    hiss: lerp(config.hiss.clean, config.hiss.worst, t),
    // Dropouts stay rare until the walkies are well apart, then come thick.
    dropouts: lerp(config.dropout.clean, config.dropout.worst, t * t),
    crackles: lerp(config.crackle.clean, config.crackle.worst, t),
  };
}

/** One break in a transmission: the voice dropping out, or a pop of static, for `length` seconds. */
export interface RadioGlitch {
  readonly kind: "dropout" | "crackle";
  readonly length: number;
}

/**
 * The glitches that start in the next `dt` seconds of a transmission of `tone`, each kind at most
 * once, by its rate a second. `random` returns 0..1.
 */
export function rollGlitches(
  random: () => number,
  tone: RadioTone,
  dt: number,
  config: RadioSoundConfig,
): RadioGlitch[] {
  const glitches: RadioGlitch[] = [];
  const roll = (
    kind: RadioGlitch["kind"],
    rate: number,
    length: { min: number; max: number },
  ): void => {
    if (rate <= 0 || dt <= 0) return;
    if (random() >= 1 - Math.exp(-rate * dt)) return;
    glitches.push({
      kind,
      length: lerp(length.min, length.max, random()),
    });
  };
  roll("dropout", tone.dropouts, config.dropout.length);
  roll("crackle", tone.crackles, config.crackle.length);
  return glitches;
}

/**
 * A soft clip crushed to `steps` levels, `samples` long: what a cheap speaker's amplifier does to
 * a voice driven into it.
 */
export function crunchCurve(
  steps: number,
  samples = 1024,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const knee = 2;
  const half = Math.max(1, steps) / 2;
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    const clipped = Math.tanh(knee * x) / Math.tanh(knee);
    curve[i] = Math.round(clipped * half) / half;
  }
  return curve;
}

/** Seconds of static looped under every speaker. */
const NOISE_SECONDS = 2;
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

/** White noise, made once per context, for static. */
function noiseBuffer(context: BaseAudioContext): AudioBuffer {
  const made = noiseBuffers.get(context);
  if (made !== undefined) return made;
  const length = Math.floor(context.sampleRate * NOISE_SECONDS);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) samples[i] = Math.random() * 2 - 1;
  noiseBuffers.set(context, buffer);
  return buffer;
}

/** A band-pass made of a high-pass into a low-pass, as a pair of nodes. */
function band(
  context: BaseAudioContext,
  config: RadioSoundConfig,
): [BiquadFilterNode, BiquadFilterNode] {
  const highpass = context.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = config.band.low;
  const lowpass = context.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = config.band.high;
  highpass.connect(lowpass);
  return [highpass, lowpass];
}

/**
 * A voice through a cheap speaker, and the static it brings. `input` is where the voice goes in.
 * `update` sets it from the peer's levels; call it often (each frame), since it also rolls the
 * glitches of the time since the last call.
 */
export interface RadioNodes {
  readonly input: AudioNode;
  update(levels: RadioLevels, ramp: number): void;
  disconnect(): void;
}

/** Interference changes smaller than this leave the steady tone alone. */
const TONE_EPSILON = 0.01;
/** Time constant, in seconds, of a glitch's edges. */
const EDGE = 0.004;

/**
 * A speaker's playback nodes, playing into `output`:
 *
 *   voice -> band -> honk -> drive -> crunch -> makeup -> dropout -> level -> panner -> output
 *   noise -> band -> hiss ------------------------------------------^
 *   noise -> band -> burst (squelch, crackle) -------------------------------^
 *
 * The bursts skip `level`, so a squelch as a transmission closes outlasts its voice fading out.
 */
export function radioNodes(
  context: BaseAudioContext,
  output: AudioNode,
  initial: RadioLevels,
  config: RadioSoundConfig,
  random: () => number = Math.random,
): RadioNodes {
  const [highpass, lowpass] = band(context, config);
  const honk = context.createBiquadFilter();
  honk.type = "peaking";
  honk.frequency.value = config.honk.frequency;
  honk.gain.value = config.honk.gain;
  honk.Q.value = config.honk.q;
  const drive = context.createGain();
  const crunch = context.createWaveShaper();
  crunch.curve = crunchCurve(config.crunch.steps);
  const makeup = context.createGain();
  makeup.gain.value = config.crunch.makeup;
  const dropout = context.createGain();
  dropout.gain.value = 1;
  const level = context.createGain();
  level.gain.value = initial.radioGain;
  const panner = context.createStereoPanner();
  panner.pan.value = initial.radioPan;

  const noise = context.createBufferSource();
  noise.buffer = noiseBuffer(context);
  noise.loop = true;
  const [noiseHighpass, noiseLowpass] = band(context, config);
  const hiss = context.createGain();
  const burst = context.createGain();
  burst.gain.value = 0;

  lowpass.connect(honk);
  honk.connect(drive);
  drive.connect(crunch);
  crunch.connect(makeup);
  makeup.connect(dropout);
  dropout.connect(level);
  level.connect(panner);
  panner.connect(output);
  noise.connect(noiseHighpass);
  noiseLowpass.connect(hiss);
  noiseLowpass.connect(burst);
  hiss.connect(level);
  burst.connect(panner);
  noise.start();

  let tone = radioTone(initial.radioInterference, config);
  let toneOf = initial.radioInterference;
  drive.gain.value = tone.drive;
  hiss.gain.value = tone.hiss;
  let keyed = false;
  /** The volume the transmission last played at, for the squelch as it closes. */
  let lastGain = initial.radioGain;
  let lastUpdate: number | null = null;
  /** When the dropout playing now ends; the steady tone waits for it. */
  let dropoutUntil = -Infinity;

  /** A burst of static from `at`, rising at once and fading over `length` seconds. */
  function pop(at: number, volume: number, length: number): void {
    burst.gain.cancelScheduledValues(at);
    burst.gain.setTargetAtTime(volume, at, EDGE);
    burst.gain.setTargetAtTime(0, at + EDGE * 2, length / 3);
  }

  function glitch(now: number, { kind, length }: RadioGlitch, gain: number) {
    if (kind === "crackle") {
      pop(now, gain * config.crackle.volume, length);
      return;
    }
    if (now < dropoutUntil) return;
    dropoutUntil = now + length;
    dropout.gain.setTargetAtTime(config.dropout.depth, now, EDGE);
    dropout.gain.setTargetAtTime(1, dropoutUntil, EDGE);
    hiss.gain.setTargetAtTime(tone.hiss * config.dropout.swell, now, EDGE);
    hiss.gain.setTargetAtTime(tone.hiss, dropoutUntil, EDGE);
  }

  return {
    input: highpass,
    update(levels, ramp) {
      const now = context.currentTime;
      const dt = lastUpdate === null ? 0 : now - lastUpdate;
      lastUpdate = now;
      level.gain.setTargetAtTime(levels.radioGain, now, ramp);
      panner.pan.setTargetAtTime(levels.radioPan, now, ramp);

      if (levels.radioKeyed !== keyed) {
        keyed = levels.radioKeyed;
        const gain = keyed ? levels.radioGain : lastGain;
        pop(
          now,
          gain * config.squelch.volume,
          keyed ? config.squelch.open : config.squelch.close,
        );
      }
      if (!keyed) return;
      lastGain = levels.radioGain;

      if (
        Math.abs(levels.radioInterference - toneOf) > TONE_EPSILON &&
        now >= dropoutUntil
      ) {
        toneOf = levels.radioInterference;
        tone = radioTone(toneOf, config);
        drive.gain.setTargetAtTime(tone.drive, now, ramp);
        hiss.gain.setTargetAtTime(tone.hiss, now, ramp);
      }
      for (const rolled of rollGlitches(random, tone, dt, config))
        glitch(now, rolled, levels.radioGain);
    },
    disconnect() {
      noise.stop();
      for (const node of [
        highpass,
        lowpass,
        honk,
        drive,
        crunch,
        makeup,
        dropout,
        level,
        panner,
        noise,
        noiseHighpass,
        noiseLowpass,
        hiss,
        burst,
      ])
        node.disconnect();
    },
  };
}
