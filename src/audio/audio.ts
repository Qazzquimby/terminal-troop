import { nextInList, placeInList } from "./playlist.js";

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
  /**
   * Whether the decoded sound is kept for the next time its url plays; true when left out. False
   * for a sound played once, such as a clip of a player's voice sent as a data url.
   */
  cache?: boolean;
  /**
   * The channel it plays on, such as the radios': its volume, set with `setChannelVolume`, scales
   * it, on top of its own volume and the master volume. None when left out.
   */
  channel?: string;
}

/** How sound made rather than loaded plays: never looped, nor kept. */
type SampleOptions = Omit<PlayOptions, "loop" | "cache">;

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
   * Given a list of urls, it streams them one after another, the offset reckoned across the whole
   * list once each one's length is read from its metadata, round again from the first if looped:
   * a radio station's songs, say.
   */
  stream: (
    url: string | readonly string[],
    origin: Point | null,
    listener: Point | null,
    options?: StreamOptions,
  ) => SoundHandle;
  /**
   * Plays `samples`, mono at `sampleRate` Hz, once, placed as a sound from a file is: sound made
   * here rather than loaded, such as a synthesized voice.
   */
  playSamples: (
    samples: Float32Array,
    sampleRate: number,
    origin: Point | null,
    listener: Point | null,
    options?: SampleOptions,
  ) => Promise<SoundHandle>;
  stop: (id: string, fadeTime?: number) => void;
  /**
   * Hears every positioned sound still playing from `listener` now, as sounds started from here
   * on do: a long sound fades and pans as the listener moves off from where it was made, rather
   * than keeping the mix it started with. Null hears them unpositioned.
   */
  listen: (listener: Point | null) => void;
  /**
   * Turns the ear `turn` radians clockwise, as the camera turns the world on the screen: a sound
   * pans by whether it shows left or right of the listener, not by which way it lies in the world.
   * 0, the world's up at the top, until set. Positioned sounds playing are mixed anew for it.
   */
  setEarTurn: (turn: number) => void;
  /** The ear's turn, as last set. */
  earTurn: () => number;
  stopAll: (fadeTime?: number) => void;
  /** Scales every sound; 0..1. */
  setMasterVolume: (value: number) => void;
  /** Scales every sound on `channel`, playing now or played from here on; 0..1, full until set. */
  setChannelVolume: (channel: string, value: number) => void;
  /** The one shared AudioContext, created on first use. */
  audioContext: () => AudioContext;
  /** The master gain: audio connected here plays at the master volume. */
  output: () => AudioNode;
}

/**
 * How far right of the listener an offset of `dx`, `dy` (world pixels) shows, with the world
 * turned `turn` radians clockwise on the screen, as the camera's roll turns it.
 */
export function sideways(dx: number, dy: number, turn: number): number {
  return turn === 0 ? dx : dx * Math.cos(turn) - dy * Math.sin(turn);
}

/**
 * Volume falls linearly from `full` to `silent`; how far right or left of the listener a sound
 * shows on the screen, with the world turned `turn` radians clockwise on it, becomes stereo pan.
 */
export function spatialMix(
  origin: Point | null,
  listener: Point | null,
  falloff: SpatialFalloff,
  turn = 0,
): Mix {
  if (origin === null || listener === null) return { volume: 1, pan: 0 };

  const dx = origin.x - listener.x;
  const dy = origin.y - listener.y;
  const beyond = Math.hypot(dx, dy) - falloff.full;
  const side = sideways(dx, dy, turn);

  return {
    volume: Math.min(
      1,
      Math.max(0, 1 - beyond / (falloff.silent - falloff.full)),
    ),
    pan: Math.max(-1, Math.min(1, side / falloff.pan)),
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
  /** Sets its gain anew for its channel's volume now. */
  rescale: () => void;
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
  /** How long each long sound is, by url, read once. */
  const durations = new Map<string, Promise<number>>();
  const activeLoops = new Map<string, SoundHandle>();
  const pendingLoops = new Map<string, symbol>();
  const streams = new Set<SoundHandle>();
  /** Every positioned sound playing and not fading out, mixed anew as the listener moves. */
  const positioned = new Set<Placed>();
  /** Radians the ear is turned clockwise, as the camera turns the world on the screen. */
  let turn = 0;
  /** Who positioned sounds were last heard by, to mix them anew when the ear turns. */
  let lastListener: Point | null = null;

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

  /** How loud each channel plays, by name: full for one never set. */
  const channelVolumes = new Map<string, number>();
  /** Every sound playing on a channel, by channel, rescaled as its volume changes. */
  const onChannel = new Map<string, Set<Placed>>();
  const channelVolume = (channel: string | undefined): number =>
    channel === undefined ? 1 : (channelVolumes.get(channel) ?? 1);

  function setChannelVolume(channel: string, value: number): void {
    channelVolumes.set(channel, value);
    for (const out of onChannel.get(channel) ?? []) out.rescale();
  }

  /**
   * The decoded sound at `url`, fetched once. A sound that fails to load or decode resolves to
   * null, warned about once, and is not fetched again: assets can lag behind the code using them.
   */
  function loadBuffer(url: string, cache = true): Promise<AudioBuffer | null> {
    const cached = cache ? buffers.get(url) : undefined;
    if (cached !== undefined) return cached;

    const promise = fetchBuffer(getAudioContext(), url).catch(
      (error: unknown) => {
        console.warn(`Sound "${url}" is unavailable:`, error);
        return null;
      },
    );

    if (cache) buffers.set(url, promise);
    return promise;
  }

  async function play(
    url: string,
    origin: Point | null,
    listener: Point | null,
    { cache = true, ...options }: PlayOptions = {},
  ): Promise<SoundHandle> {
    const buffer = await loadBuffer(url, cache);
    if (buffer === null) return silentHandle;
    return playBuffer(buffer, origin, listener, options);
  }

  function playSamples(
    samples: Float32Array,
    sampleRate: number,
    origin: Point | null,
    listener: Point | null,
    options: SampleOptions = {},
  ): Promise<SoundHandle> {
    if (samples.length === 0) return Promise.resolve(silentHandle);
    const buffer = getAudioContext().createBuffer(
      1,
      samples.length,
      sampleRate,
    );
    buffer.getChannelData(0).set(samples);
    return playBuffer(buffer, origin, listener, options);
  }

  /** Plays `buffer` from `origin` for `listener`, as `play` does once its sound has loaded. */
  async function playBuffer(
    buffer: AudioBuffer,
    origin: Point | null,
    listener: Point | null,
    { volume = 1, loop = false, range, channel }: Omit<PlayOptions, "cache">,
  ): Promise<SoundHandle> {
    const fades = rangedFalloff(falloff, range);
    const context = getAudioContext();

    // Browsers usually require an AudioContext to be resumed after a user interaction.
    await context.resume();

    const source = context.createBufferSource();
    const out = placed(context, fades, origin, listener, volume, channel);
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
   * mixes it anew for wherever the listener goes. On a `channel`, that channel's volume scales it
   * too, as it changes.
   */
  function placed(
    context: AudioContext,
    fades: SpatialFalloff,
    origin: Point | null,
    listener: Point | null,
    volume: number,
    channel?: string,
  ): Placed {
    // Copied: the origin is where the sound was made, not whatever the caller's point does next.
    const copy = (point: Point | null) =>
      point === null ? null : { x: point.x, y: point.y };
    let from = copy(origin);
    let mix = spatialMix(from, listener, fades, turn);
    let baseVolume = volume;
    let released = false;
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    const level = () => mix.volume * baseVolume * channelVolume(channel);
    gain.gain.value = level();
    panner.pan.value = mix.pan;
    gain.connect(panner);
    panner.connect(getMaster(context));
    const sharing =
      channel === undefined
        ? null
        : (onChannel.get(channel) ?? new Set<Placed>());
    const out: Placed = {
      gain,
      setVolume(value: number): void {
        baseVolume = value;
        gain.gain.value = level();
      },
      rescale(): void {
        if (!released) gain.gain.value = level();
      },
      setPosition(newOrigin: Point | null, newListener: Point | null): void {
        from = copy(newOrigin);
        mix = spatialMix(from, newListener, fades, turn);
        gain.gain.value = level();
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
        sharing?.delete(out);
      },
      disconnect(): void {
        out.release();
        gain.disconnect();
        panner.disconnect();
      },
    };
    if (from !== null) positioned.add(out);
    if (channel !== undefined && sharing !== null) {
      sharing.add(out);
      onChannel.set(channel, sharing);
    }
    return out;
  }

  function listen(listener: Point | null): void {
    lastListener = listener === null ? null : { x: listener.x, y: listener.y };
    for (const out of positioned) out.listen(listener);
  }

  function setEarTurn(next: number): void {
    const value = Number.isFinite(next) ? next : 0;
    if (value === turn) return;
    turn = value;
    if (lastListener !== null) listen(lastListener);
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

  /**
   * How long the sound at `url` is, in seconds, read once from its metadata alone; 0 for one that
   * will not load or does not say.
   */
  function durationOf(url: string): Promise<number> {
    const cached = durations.get(url);
    if (cached !== undefined) return cached;
    const promise = new Promise<number>((resolve) => {
      const probe = new Audio();
      probe.preload = "metadata";
      probe.addEventListener(
        "loadedmetadata",
        () => {
          const { duration } = probe;
          resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
          probe.removeAttribute("src");
          probe.load();
        },
        { once: true },
      );
      probe.addEventListener(
        "error",
        () => {
          console.warn(`Sound "${url}" is unavailable`);
          resolve(0);
        },
        { once: true },
      );
      probe.src = url;
    });
    durations.set(url, promise);
    return promise;
  }

  function stream(
    url: string | readonly string[],
    origin: Point | null,
    listener: Point | null,
    {
      volume = 1,
      loop = false,
      range,
      offset = 0,
      channel,
    }: StreamOptions = {},
  ): SoundHandle {
    const fades = rangedFalloff(falloff, range);
    const context = getAudioContext();
    const element = new Audio();
    element.preload = "auto";

    const source = context.createMediaElementSource(element);
    const out = placed(context, fades, origin, listener, volume, channel);
    const { gain } = out;
    source.connect(gain);
    let stopped = false;

    /** Plays `src` from `from` seconds in, wrapping round its end if it loops. */
    const cue = (src: string, from: number, loops: boolean): void => {
      element.loop = loops;
      element.addEventListener(
        "loadedmetadata",
        () => {
          const { duration } = element;
          if (!Number.isFinite(duration) || duration <= 0) return;
          element.currentTime = loops ? from % duration : from;
        },
        { once: true },
      );
      element.src = src;
      void context.resume().then(() => element.play().catch(() => undefined));
    };

    if (typeof url === "string") cue(url, offset, loop);
    else {
      // The list is reckoned from when it started, by this client's clock, so each next sound
      // starts where the world's clock has it however late the last one loaded.
      const started = performance.now() / 1000 - offset;
      let current: number | null = null;
      const next = async (): Promise<void> => {
        const lengths = await Promise.all(url.map(durationOf));
        if (stopped) return;
        const at = placeInList(
          lengths,
          performance.now() / 1000 - started,
          loop,
        );
        // The sound that just ended may still be reckoned as playing: the one after it, then.
        const place =
          current !== null && (at === null || at.index === current)
            ? nextInList(lengths, current, loop)
            : at;
        const src = place === null ? undefined : url[place.index];
        if (place === null || src === undefined) return;
        current = place.index;
        cue(src, place.offset, false);
      };
      element.addEventListener("ended", () => void next());
      void next();
    }

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
    playSamples,
    playLoop,
    stream,
    stop,
    listen,
    setEarTurn,
    earTurn: () => turn,
    stopAll,
    setMasterVolume,
    setChannelVolume,
    audioContext: getAudioContext,
    output: () => getMaster(getAudioContext()),
  };
}
