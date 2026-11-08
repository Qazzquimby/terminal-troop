import { AbilitySlot } from "./config.js";
import { CLASS_DEFS } from "./classes/index.js";

const SLOTS = Object.values(AbilitySlot);

export function createAbilityUseDetector() {
  let previous = {
    [AbilitySlot.PRIMARY]: 0,
    [AbilitySlot.SECONDARY]: 0,
  };

  let previousClassId = null;

  return function detectAbilityUse(player) {
    if (!player || player.classId !== previousClassId) {
      previousClassId = player?.classId ?? null;

      previous = Object.fromEntries(
        SLOTS.map((slot) => [slot, player?.cooldowns[slot] ?? 0]),
      );

      return [];
    }

    const used = [];
    const definition = CLASS_DEFS[player.classId];

    for (const slot of SLOTS) {
      const cooldown = player.cooldowns[slot];

      if (definition[slot] && cooldown > previous[slot]) {
        used.push(slot);
      }

      previous[slot] = cooldown;
    }

    return used;
  };
}


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

    const mix = spatialMix(origin, listener);

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

        gain.gain.value = mix.volume * value;
      },

      setPosition(newOrigin, newListener) {
        if (stopped) return;

        const newMix = spatialMix(
          newOrigin,
          newListener,
        );

        gain.gain.value = newMix.volume * volume;
        panner.pan.value = newMix.pan;
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

    const handle = await play(
      url,
      origin,
      listener,
      {
        ...options,
        loop: true,
      },
    );

    activeLoops.set(id, handle);

    return handle;
  }


  function stop(id, fadeTime = 0.1) {
    const handle = activeLoops.get(id);

    if (!handle) return;

    handle.stop(fadeTime);
    activeLoops.delete(id);
  }


  function stopAll(fadeTime = 0.1) {
    for (const handle of activeLoops.values()) {
      handle.stop(fadeTime);
    }

    activeLoops.clear();
  }


  async function playAbility(event, listener) {
    const ability = CLASS_DEFS[event.classId][event.slot];

    if (!ability?.sound) return;

    return play(
      ability.sound,
      event,
      listener,
      {
        volume: ability.volume ?? 1,
      },
    );
  }


  return {
    play,
    playLoop,
    stop,
    stopAll,
    playAbility,
  };
}