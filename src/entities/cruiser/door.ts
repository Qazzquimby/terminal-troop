import { changeEntity, effect, sound } from "../../sim/index.js";
import type { Session, VehicleDoor, WorldEntity } from "../../sim/index.js";
import { CruiserState, FRESH } from "./drive.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const closeUrl = new URL("./sfx/door-close.mp3", import.meta.url).href;
const openUrl = new URL("./sfx/door-open.mp3", import.meta.url).href;

/**
 * The cruiser's door and the power that keeps it shut. Power runs 0..1 of full; rates are of full
 * a second.
 */
export interface CruiserDoorConfig {
  /** Power closing it takes at once; it closes only with this much left. */
  readonly close: number;
  /** Power it burns each second it stays closed; with none left it swings open. */
  readonly drain: number;
  /** Power it gains back each second it stands open. */
  readonly recharge: number;
  /** Volume of its opening and closing, 0..1. */
  readonly volume: number;
  /** How far its opening and closing is heard, and so how far that noise carries, in pixels. */
  readonly range: number;
}

/** `vehicle`'s state, or a fresh one if it does not parse. */
function stateOf(vehicle: WorldEntity): CruiserState {
  const parsed = CruiserState.safeParse(vehicle.data);
  return parsed.success ? parsed.data : FRESH;
}

/** The sounds of the door, opening and closing, as `config` has them. */
function doorSounds(config: CruiserDoorConfig) {
  const at = { volume: config.volume, range: config.range };
  return {
    open: sound({ url: openUrl, ...at }),
    close: sound({ url: closeUrl, ...at }),
  };
}

/** Makes the door's sound, and the noise it carries, where `vehicle` is. */
function slam(
  game: Session,
  vehicle: WorldEntity,
  closing: boolean,
  config: CruiserDoorConfig,
): void {
  const sounds = doorSounds(config);
  effect(
    game,
    {
      at: { x: vehicle.x, y: vehicle.y },
      sound: closing ? sounds.close : sounds.open,
      noise: config.range,
    },
    vehicle,
  );
}

/**
 * The cruiser's door: open, those inside are in reach of the world; closed, they are shut away.
 * Closing it takes a chunk of its power, and it only closes with that much left.
 */
export function door(config: CruiserDoorConfig): VehicleDoor {
  return {
    closed: (vehicle) => stateOf(vehicle).shut,
    canClose: (vehicle) => stateOf(vehicle).charge >= config.close,
    charge: (vehicle) => stateOf(vehicle).charge,
    swing(game, vehicle, _by, close) {
      changeEntity(game, vehicle, (data) => {
        const state = CruiserState.parse(data);
        if (state.shut === close) return state;
        const charge = close ? state.charge - config.close : state.charge;
        return { ...state, shut: close, charge: Math.max(0, charge) };
      });
      slam(game, vehicle, close, config);
    },
  };
}

/**
 * The door's power over a step of `dt` on the host: closed, it burns power, and swings open with
 * none left; open, it charges back up to full.
 */
export function stepDoor(
  game: Session,
  entity: WorldEntity,
  state: CruiserState,
  dt: number,
  config: CruiserDoorConfig,
): CruiserState {
  if (!state.shut) {
    if (state.charge >= 1) return state;
    return {
      ...state,
      charge: Math.min(1, state.charge + config.recharge * dt),
    };
  }
  const charge = Math.max(0, state.charge - config.drain * dt);
  if (charge > 0) return { ...state, charge };
  slam(game, entity, false, config);
  return { ...state, shut: false, charge };
}
