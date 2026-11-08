
// -----------------------------------------------------------------------------
// Audio
// -----------------------------------------------------------------------------

const MAX_SOUND_DISTANCE = 1000;
const PAN_DISTANCE = 500;

function spatialMix(origin, listener) {
  if (!origin || !listener) {
    return {
      volume: 1,
      pan: 0,
    };
  }

  const dx = origin.x - listener.x;
  const dy = origin.y - listener.y;

  const distance = Math.hypot(dx, dy);

  // Simple linear distance attenuation.
  const volume = Math.max(
    0,
    1 - distance / MAX_SOUND_DISTANCE,
  );

  // Horizontal position becomes stereo pan.
  const pan = Math.max(
    -1,
    Math.min(1, dx / PAN_DISTANCE),
  );

  return {
    volume,
    pan,
  };
}


export function createSfx() {
  let audioContext = null;

  // URL -> Promise<AudioBuffer>
  const buffers = new Map();

  // ID -> active looping sound
  const activeLoops = new Map();
  const pendingLoops = new Map();


  function getAudioContext() {
    if (!audioContext) {
      audioContext = new AudioContext();
    }

    return audioContext;
  }


  async function loadBuffer(url) {
    if (!buffers.has(url)) {
      const context = getAudioContext();

      const promise = fetch(url)
        .then((response) => {
          if (!response.ok) {
            throw new Error(
              `Failed to load audio "${url}": ${response.status}`,
            );
          }

          return response.arrayBuffer();
        })
        .then((data) => context.decodeAudioData(data));

      buffers.set(url, promise);
    }

    return buffers.get(url);
  }


  async function play(
    url,
    origin,
    listener,
    {
      volume = 1,
      loop = false,
    } = {},
  ) {
    const context = getAudioContext();

    const buffer = await loadBuffer(url);

    // Browsers usually require an AudioContext to be resumed
    // after a user interaction.
    await context.resume();

    let mix = spatialMix(origin, listener);

    const source = context.createBufferSource();
    const gain = context.createGain();
    const panner = context.createStereoPanner();

    source.buffer = buffer;
    source.loop = loop;

    gain.gain.value = mix.volume * volume;
    panner.pan.value = mix.pan;

    source.connect(gain);
    gain.connect(panner);
    panner.connect(context.destination);

    source.start();

    let stopped = false;

    source.onended = () => {
      stopped = true;
      source.disconnect();
      gain.disconnect();
      panner.disconnect();
    };

    const handle = {
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

        gain.gain.linearRampToValueAtTime(
          0,
          now + fadeTime,
        );

        source.stop(now + fadeTime);
      },

      setVolume(value) {
        if (stopped) return;

        volume = value;
        gain.gain.value = mix.volume * volume;
      },

      setPosition(newOrigin, newListener) {
        if (stopped) return;

        mix = spatialMix(
          newOrigin,
          newListener,
        );

        gain.gain.value = mix.volume * volume;
        panner.pan.value = mix.pan;
      },
    };

    return handle;
  }


  async function playLoop(
    id,
    url,
    origin,
    listener,
    options = {},
  ) {
    // If this ID is already playing, stop the old one.
    stop(id);

    const request = Symbol();
    pendingLoops.set(id, request);

    try {
      const handle = await play(
        url,
        origin,
        listener,
        {
          ...options,
          loop: true,
        },
      );

      if (pendingLoops.get(id) !== request) {
        handle.stop(0);
        return;
      }

      activeLoops.set(id, handle);
      return handle;
    } finally {
      if (pendingLoops.get(id) === request) pendingLoops.delete(id);
    }
  }


  function stop(id, fadeTime = 0.1) {
    pendingLoops.delete(id);
    const handle = activeLoops.get(id);

    if (!handle) return;

    handle.stop(fadeTime);
    activeLoops.delete(id);
  }


  function stopAll(fadeTime = 0.1) {
    pendingLoops.clear();
    for (const handle of activeLoops.values()) {
      handle.stop(fadeTime);
    }

    activeLoops.clear();
  }



  return {
    play,
    playLoop,
    stop,
    stopAll,
  };
}
