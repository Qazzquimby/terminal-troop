import { expect } from "vitest";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { updateSession } from "../sim/index.js";
import type {
  Controls,
  Player,
  Point,
  Session,
  WorldContent,
} from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  testRoomConfig,
} from "./room-helpers.js";
import { testSfx, testSimConfig } from "./sim-config.js";

export const DT = 1 / 60;

export const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
};

export function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

export function standAt(game: Session, at: Point): void {
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });
}

/** The player `id` as `room` knows it. */
export function playerOn(room: Room, id: string): Player {
  const player = sessionOf(room).players.get(id);
  if (player === undefined) throw new Error(`no player ${id}`);
  return player;
}

/** How a crew starts: where each client's player stands, by client id, and the content each runs. */
interface CrewSetup {
  readonly spots: Readonly<Record<string, Point>>;
  readonly content?: readonly WorldContent[];
}

/** Clients `ids` joined to one room on a JSON hub, the first hosting, each at its spot. */
export async function crew(setup: CrewSetup, ...ids: string[]) {
  const { spots, content = [] } = setup;
  const hub = createHub();
  const clock = createManualClock();
  const client = (id: string): Room =>
    createRoom({
      localId: id,
      world: "dev",
      transport: hub.transport(id, []).port,
      voice: createNullVoice({
        mode: "open",
        muted: false,
        volume: 1,
        inputDevice: null,
      }),
      sfx: testSfx(),
      scope: createScope(),
      clock,
      config: testRoomConfig,
      sim: testSimConfig,
      content: [...content],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  const rooms = new Map(ids.map((id) => [id, client(id)]));
  const room = (id: string): Room => {
    const found = rooms.get(id);
    if (found === undefined) throw new Error(`no client ${id}`);
    return found;
  };
  for (const [id, each] of rooms) await each.join("FRIEND", id.toUpperCase());
  clock.advance(1000);
  /** One sim step and frame on each client still in the room, `controls` by client id. */
  const step = (controls: Readonly<Record<string, Controls>> = {}): void => {
    for (const [id, each] of rooms) {
      if (each.state().kind !== "joined") continue;
      updateSession(sessionOf(each), controls[id] ?? idle, DT);
      each.frame(clock.now());
    }
    clock.advance(clock.now() + DT * 1000);
  };
  /** Steps for `ms` of time. */
  const run = (
    ms: number,
    controls: Readonly<Record<string, Controls>> = {},
  ): void => {
    for (let at = 0; at < ms; at += DT * 1000) step(controls);
  };
  // Copies easing from where each player first arrived can shove the others aside, so twice.
  for (let round = 0; round < 2; round++) {
    for (const [id, each] of rooms) {
      const at = spots[id];
      if (at !== undefined) standAt(sessionOf(each), at);
    }
    run(1000);
  }
  expect(room(ids[0] ?? "").hostId()).toBe(ids[0]);
  return { hub, clock, rooms, room, client, step, run };
}
