import { changeEntity, effect, makeNoise, sound } from "../../sim/index.js";
import type {
  Playing,
  Session,
  Tuning,
  VehicleSpec,
  WorldEntity,
} from "../../sim/index.js";
import {
  nextStation,
  RADIO_TAG,
  stationName,
  stationPlaying,
} from "../../stations/index.js";
import { CruiserState } from "./drive.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const tuneUrl = new URL("./sfx/radio-tune.mp3", import.meta.url).href;
const offUrl = new URL("./sfx/radio-off.mp3", import.meta.url).href;

/** The cruiser's radio. Distances in pixels, times in sim seconds. */
export interface CruiserRadioConfig {
  /** Volume of its station, 0..1. */
  readonly volume: number;
  /** How far its station is heard, and so how far the noise it makes while it plays carries. */
  readonly range: number;
  /** Seconds between the noises it makes while it plays. */
  readonly noiseInterval: number;
  /** Volume of its dial's click, 0..1. */
  readonly switchVolume: number;
  /** How far turning its dial is heard, and so how far that noise carries. */
  readonly switchRange: number;
}

/**
 * What the radio does as anyone inside turns it: tunes it to the next station, switching it on,
 * or switches it off, with a click heard round the car.
 */
export function tuner(
  config: CruiserRadioConfig,
): NonNullable<VehicleSpec["tune"]> {
  const sounds = {
    tune: sound({
      url: tuneUrl,
      volume: config.switchVolume,
      range: config.switchRange,
    }),
    off: sound({
      url: offUrl,
      volume: config.switchVolume,
      range: config.switchRange,
    }),
  };
  return (game: Session, vehicle: WorldEntity, _by, to: Tuning) => {
    changeEntity(game, vehicle, (data) => {
      const state = CruiserState.parse(data);
      const station = to === "off" ? null : nextStation(state.station);
      return { ...state, station };
    });
    effect(game, {
      at: { x: vehicle.x, y: vehicle.y },
      sound: to === "off" ? sounds.off : sounds.tune,
    });
  };
}

/**
 * What the radio plays while it is on: its station, live, so tuning in joins the song where the
 * world's clock has it, and every client hears the same part of it.
 */
export const radioPlaying = (
  state: CruiserState,
  config: CruiserRadioConfig,
): Playing | null =>
  state.station === null ? null : stationPlaying(state.station, config);

/** The name of the station `vehicle`'s radio plays, as this client has it; null while it is off. */
export function stationOf(vehicle: WorldEntity): string | null {
  const parsed = CruiserState.safeParse(vehicle.data);
  const station = parsed.success ? parsed.data.station : null;
  return station === null ? null : stationName(station);
}

/** When each cruiser's radio next makes its noise, on the world's clock, by entity id, per session. */
const nextNoise = new WeakMap<Session, Map<string, number>>();

/**
 * The radio on the host: while it plays, it makes a noise as far as it is heard each interval,
 * drawing whatever hears it to the car.
 */
export function playRadio(
  game: Session,
  entity: WorldEntity,
  state: CruiserState,
  config: CruiserRadioConfig,
): void {
  const due = nextNoise.get(game) ?? new Map<string, number>();
  nextNoise.set(game, due);
  if (state.station === null) {
    due.delete(entity.id);
    return;
  }
  if (game.worldTime < (due.get(entity.id) ?? -Infinity)) return;
  due.set(entity.id, game.worldTime + config.noiseInterval);
  makeNoise(game, entity, {
    at: { x: entity.x, y: entity.y },
    radius: config.range,
    tags: [RADIO_TAG],
  });
}
