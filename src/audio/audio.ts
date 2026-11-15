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
export interface SpatialFalloff {
  /** Volume is full up to this distance. */
  readonly full: number;
  /** Volume reaches zero at this distance. */
  readonly silent: number;
  /** Horizontal offset at which pan saturates. */
  readonly pan: number;
}

interface PlayOptions {
  volume?: number;
  loop?: boolean;
  /**
   * How far a positioned sound is heard, in pixels: it fades to silence there instead of at the
   * falloff's own distance.
   */
  range?: number;
}

interface StreamOptions extends PlayOptions {
  /** Seconds into the sound it starts from; 0 when left out. */
  offset?: number;
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
  /**
   * Streams the long sound at `url`, such as a song, from `offset` seconds in, rather than
   * loading it whole first. Looped, an offset past its end wraps round. `stopAll` stops it too.
   */
  stream: (
    url: string,
    origin: Point | null,
    listener: Point | null,
    options?: StreamOptions,
  ) => SoundHandle;
  stop: (id: string, fadeTime?: number) => void;
  /**
   * Hears every positioned sound still playing from `listener` now, as sounds started from here
   * on do: a long sound fades and pans as the listener moves off from where it was made, rather
   * than keeping the mix it started with. Null hears them unpositioned.
   */
  listen: (listener: Point | null) => void;
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
  falloff: SpatialFalloff,
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

/**
 * `falloff` for a sound heard out to `range` pixels: silent there, and full no further out than
 * the falloff has it, nor past the range.
 */
export function rangedFalloff(
  falloff: SpatialFalloff,
  range: number | undefined,
): SpatialFalloff {
  if (range === undefined) return falloff;
  const silent = Math.max(range, Number.EPSILON);
  return { ...falloff, full: Math.min(falloff.full, silent / 2), silent };
}

/** Where a sound plays from, for whom and how loud, on its way out. */
interface Placed {
  readonly gain: GainNode;
  setVolume: (value: number) => void;
  setPosition: (origin: Point | null, listener: Point | null) => void;
  /** Mixes it anew for `listener`, from where it was last placed. */
  listen: (listener: Point | null) => void;
  /** Leaves its mix as it is from now on, as it fades out. */
  release: () => void;
  disconnect: () => void;
}

/** A handle to a sound that never played: there is nothing to stop, fade or move. */
const silentHandle: SoundHandle = {
  stop: () => undefined,
  setVolume: () => undefined,
  setPosition: () => undefined,
};

async function fetchBuffer(
  context: BaseAudioContext,
  url: string,
): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load audio "${url}": ${String(response.status)}`,
    );
  }
  return context.decodeAudioData(await response.arrayBuffer());
}

/** Positioned sounds fade and pan by `falloff`, or out to their own range. */
export function createSfx(falloff: SpatialFalloff): Sfx {
  let audioContext: AudioContext | null = null;
  let master: GainNode | null = null;
  let masterVolume = 1;

  const buffers = new Map<string, Promise<AudioBuffer | null>>();
  const activeLoops = new Map<string, SoundHandle>();
  const pendingLoops = new Map<string, symbol>();
  const streams = new Set<SoundHandle>();
  /** Every positioned sound playing and not fading out, mixed anew as the listener moves. */
  const positioned = new Set<Placed>();

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

  /**
   * The decoded sound at `url`, fetched once. A sound that fails to load or decode resolves to
   * null, warned about once, and is not fetched again: assets can lag behind the code using them.
   */
  function loadBuffer(url: string): Promise<AudioBuffer | null> {
    const cached = buffers.get(url);
    if (cached !== undefined) return cached;

    const promise = fetchBuffer(getAudioContext(), url).catch(
      (error: unknown) => {
        console.warn(`Sound "${url}" is unavailable:`, error);
        return null;
      },
    );

    buffers.set(url, promise);
    return promise;
  }

  async function play(
    url: string,
    origin: Point | null,
    listener: Point | null,
    { volume = 1, loop = false, range }: PlayOptions = {},
  ): Promise<SoundHandle> {
    const fades = rangedFalloff(falloff, range);
    const context = getAudioContext();
    const buffer = await loadBuffer(url);
    if (buffer === null) return silentHandle;

    // Browsers usually require an AudioContext to be resumed after a user interaction.
    await context.resume();

    const source = context.createBufferSource();
    const out = placed(context, fades, origin, listener, volume);
    const { gain } = out;

    source.buffer = buffer;
    source.loop = loop;
    source.connect(gain);
    source.start();

    let stopped = false;

    source.onended = () => {
      stopped = true;
      source.disconnect();
      out.disconnect();
    };

    return {
      stop(fadeTime = 0.1) {
        if (stopped) return;
        stopped = true;
        out.release();

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
        if (!stopped) out.setVolume(value);
      },
      setPosition(newOrigin, newListener) {
        if (!stopped) out.setPosition(newOrigin, newListener);
      },
    };
  }

  /**
   * A gain and a panner, into the master, that place a sound at `volume` from `origin` for
   * `listener`, fading by `fades`; sound goes in at the gain. While it has an origin, `listen`
   * mixes it anew for wherever the listener goes.
   */
  function placed(
    context: AudioContext,
    fades: SpatialFalloff,
    origin: Point | null,
    listener: Point | null,
    volume: number,
  ): Placed {
    // Copied: the origin is where the sound was made, not whatever the caller's point does next.
    const copy = (point: Point | null) =>
      point === null ? null : { x: point.x, y: point.y };
    let from = copy(origin);
    let mix = spatialMix(from, listener, fades);
    let baseVolume = volume;
    let released = false;
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    gain.gain.value = mix.volume * baseVolume;
    panner.pan.value = mix.pan;
    gain.connect(panner);
    panner.connect(getMaster(context));
    const out: Placed = {
      gain,
      setVolume(value: number): void {
        baseVolume = value;
        gain.gain.value = mix.volume * baseVolume;
      },
      setPosition(newOrigin: Point | null, newListener: Point | null): void {
        from = copy(newOrigin);
        mix = spatialMix(from, newListener, fades);
        gain.gain.value = mix.volume * baseVolume;
        panner.pan.value = mix.pan;
        if (from === null || released) positioned.delete(out);
        else positioned.add(out);
      },
      listen(newListener: Point | null): void {
        out.setPosition(from, newListener);
      },
      release(): void {
        released = true;
        positioned.delete(out);
      },
      disconnect(): void {
        out.release();
        gain.disconnect();
        panner.disconnect();
      },
    };
    if (from !== null) positioned.add(out);
    return out;
  }

  function listen(listener: Point | null): void {
    for (const out of positioned) out.listen(listener);
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

  function stream(
    url: string,
    origin: Point | null,
    listener: Point | null,
    { volume = 1, loop = false, range, offset = 0 }: StreamOptions = {},
  ): SoundHandle {
    const fades = rangedFalloff(falloff, range);
    const context = getAudioContext();
    const element = new Audio(url);
    element.loop = loop;
    element.preload = "auto";
    element.addEventListener(
      "loadedmetadata",
      () => {
        const { duration } = element;
        if (!Number.isFinite(duration) || duration <= 0) return;
        element.currentTime = loop ? offset % duration : offset;
      },
      { once: true },
    );

    const source = context.createMediaElementSource(element);
    const out = placed(context, fades, origin, listener, volume);
    const { gain } = out;
    source.connect(gain);
    void context.resume().then(() => element.play().catch(() => undefined));

    let stopped = false;
    const handle: SoundHandle = {
      stop(fadeTime = 0.1) {
        if (stopped) return;
        stopped = true;
        out.release();
        streams.delete(handle);
        const fade = Math.max(fadeTime, 0);
        const now = context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + fade);
        setTimeout(() => {
          element.pause();
          element.removeAttribute("src");
          element.load();
          source.disconnect();
          out.disconnect();
        }, fade * 1000);
      },
      setVolume(value) {
        if (!stopped) out.setVolume(value);
      },
      setPosition(newOrigin, newListener) {
        if (!stopped) out.setPosition(newOrigin, newListener);
      },
    };
    streams.add(handle);
    return handle;
  }

  function stopAll(fadeTime = 0.1): void {
    pendingLoops.clear();
    activeLoops.forEach((handle) => {
      handle.stop(fadeTime);
    });
    activeLoops.clear();
    [...streams].forEach((handle) => {
      handle.stop(fadeTime);
    });
  }

  return {
    play,
    playLoop,
    stream,
    stop,
    listen,
    stopAll,
    setMasterVolume,
    audioContext: getAudioContext,
    output: () => getMaster(getAudioContext()),
  };
}
