/** A position in world pixels. */
interface Point {
  readonly x: number;
  readonly y: number;
}

interface Mix {
  volume: number;
  pan: number;
}

/** Distances that shape a spatial mix, in pixels. */
interface Falloff {
  /** Volume is full up to this distance. */
  readonly full: number;
  /** Volume reaches zero at this distance. */
  readonly silent: number;
  /** Horizontal offset at which pan saturates. */
  readonly pan: number;
}

const SFX_FALLOFF: Falloff = { full: 0, silent: 1000, pan: 500 };

interface PlayOptions {
  volume?: number;
  loop?: boolean;
}

/** @public */
export interface SoundHandle {
  stop: (fadeTime?: number) => void;
  setVolume: (value: number) => void;
  setPosition: (origin: Point | null, listener: Point | null) => void;
}

export interface Sfx {
  play: (
    url: string,
    origin: Point | null,
    listener: Point | null,
    options?: PlayOptions,
  ) => Promise<SoundHandle>;
  playLoop: (
    id: string,
    url: string,
    origin: Point | null,
    listener: Point | null,
    options?: PlayOptions,
  ) => Promise<SoundHandle | null>;
  stop: (id: string, fadeTime?: number) => void;
  stopAll: (fadeTime?: number) => void;
  /** Scales every sound; 0..1. */
  setMasterVolume: (value: number) => void;
  /** The one shared AudioContext, created on first use. */
  audioContext: () => AudioContext;
  /** The master gain: audio connected here plays at the master volume. */
  output: () => AudioNode;
}

/** Volume falls linearly from `full` to `silent`; horizontal offset becomes stereo pan. */
export function spatialMix(
  origin: Point | null,
  listener: Point | null,
  falloff: Falloff = SFX_FALLOFF,
): Mix {
  if (origin === null || listener === null) return { volume: 1, pan: 0 };

  const dx = origin.x - listener.x;
  const dy = origin.y - listener.y;
  const beyond = Math.hypot(dx, dy) - falloff.full;

  return {
    volume: Math.min(
      1,
      Math.max(0, 1 - beyond / (falloff.silent - falloff.full)),
    ),
    pan: Math.max(-1, Math.min(1, dx / falloff.pan)),
  };
}

export function createSfx(): Sfx {
  let audioContext: AudioContext | null = null;
  let master: GainNode | null = null;
  let masterVolume = 1;

  const buffers = new Map<string, Promise<AudioBuffer>>();
  const activeLoops = new Map<string, SoundHandle>();
  const pendingLoops = new Map<string, symbol>();

  function getAudioContext(): AudioContext {
    audioContext ??= new AudioContext();
    return audioContext;
  }

  /** Every sound passes through this gain on its way out. */
  function getMaster(context: AudioContext): GainNode {
    if (master === null) {
      master = context.createGain();
      master.gain.value = masterVolume;
      master.connect(context.destination);
    }
    return master;
  }

  function setMasterVolume(value: number): void {
    masterVolume = value;
    if (master !== null) master.gain.value = value;
  }

  function loadBuffer(url: string): Promise<AudioBuffer> {
    const cached = buffers.get(url);
    if (cached !== undefined) return cached;

    const context = getAudioContext();
    const promise = fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `Failed to load audio "${url}": ${String(response.status)}`,
          );
        }
        return response.arrayBuffer();
      })
      .then((data) => context.decodeAudioData(data));

    buffers.set(url, promise);
    return promise;
  }

  async function play(
    url: string,
    origin: Point | null,
    listener: Point | null,
    { volume = 1, loop = false }: PlayOptions = {},
  ): Promise<SoundHandle> {
    const context = getAudioContext();
    const buffer = await loadBuffer(url);

    // Browsers usually require an AudioContext to be resumed after a user interaction.
    await context.resume();

    let mix = spatialMix(origin, listener);
    let baseVolume = volume;

    const source = context.createBufferSource();
    const gain = context.createGain();
    const panner = context.createStereoPanner();

    source.buffer = buffer;
    source.loop = loop;
    gain.gain.value = mix.volume * baseVolume;
    panner.pan.value = mix.pan;

    source.connect(gain);
    gain.connect(panner);
    panner.connect(getMaster(context));
    source.start();

    let stopped = false;

    source.onended = () => {
      stopped = true;
      source.disconnect();
      gain.disconnect();
      panner.disconnect();
    };

    return {
      stop(fadeTime = 0.1) {
        if (stopped) return;
        stopped = true;

        const now = context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);

        if (fadeTime <= 0) {
          gain.gain.setValueAtTime(0, now);
          source.stop();
          return;
        }

        gain.gain.linearRampToValueAtTime(0, now + fadeTime);
        source.stop(now + fadeTime);
      },

      setVolume(value) {
        if (stopped) return;
        baseVolume = value;
        gain.gain.value = mix.volume * baseVolume;
      },

      setPosition(newOrigin, newListener) {
        if (stopped) return;
        mix = spatialMix(newOrigin, newListener);
        gain.gain.value = mix.volume * baseVolume;
        panner.pan.value = mix.pan;
      },
    };
  }

  /** Resolves to null if a newer playLoop/stop for the same id superseded this one. */
  async function playLoop(
    id: string,
    url: string,
    origin: Point | null,
    listener: Point | null,
    options: PlayOptions = {},
  ): Promise<SoundHandle | null> {
    // If this ID is already playing, stop the old one.
    stop(id);

    const request = Symbol();
    pendingLoops.set(id, request);

    try {
      const handle = await play(url, origin, listener, {
        ...options,
        loop: true,
      });

      if (pendingLoops.get(id) !== request) {
        handle.stop(0);
        return null;
      }

      activeLoops.set(id, handle);
      return handle;
    } finally {
      if (pendingLoops.get(id) === request) pendingLoops.delete(id);
    }
  }

  function stop(id: string, fadeTime = 0.1): void {
    pendingLoops.delete(id);
    const handle = activeLoops.get(id);
    if (handle === undefined) return;

    handle.stop(fadeTime);
    activeLoops.delete(id);
  }

  function stopAll(fadeTime = 0.1): void {
    pendingLoops.clear();
    activeLoops.forEach((handle) => {
      handle.stop(fadeTime);
    });
    activeLoops.clear();
  }

  return {
    play,
    playLoop,
    stop,
    stopAll,
    setMasterVolume,
    audioContext: getAudioContext,
    output: () => getMaster(getAudioContext()),
  };
}
