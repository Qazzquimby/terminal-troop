import { expect } from "vitest";
import { createScope } from "../lib/scope/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { alter, updateSession } from "../sim/index.js";
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
  delayed,
  testRoomConfig,
} from "./room-helpers.js";
import { testSfx, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;

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

/**
 * Puts player `id` at `at`, at rest, as the host would: where the host runs it, as part of the
 * step it is in, and where every other client shows it. The player's own client, if another
 * hosts, takes it from the host's snapshots, as it would any correction. With no host among
 * `games`, every client puts it there.
 */
export function teleport(
  games: readonly Session[],
  id: string,
  at: Point,
): void {
  const hosted = games.some((game) => game.hosting);
  const put = (player: Player): void => {
    Object.assign(player, {
      ...at,
      prevX: at.x,
      prevY: at.y,
      tx: at.x,
      ty: at.y,
      vx: 0,
      vy: 0,
      dash: null,
    });
  };
  for (const game of games) {
    const player = game.players.get(id);
    if (player === undefined) continue;
    if (game.hosting) alter(game, player, put);
    else if (player !== game.local || !hosted) put(player);
  }
}

/** The player `id` as `room` knows it. */
export function playerOn(room: Room, id: string): Player {
  const player = sessionOf(room).players.get(id);
  if (player === undefined) throw new Error(`no player ${id}`);
  return player;
}

/**
 * How a crew starts: where each client's player stands, by client id, the content each runs, and
 * how many milliseconds each send takes to arrive, if any.
 */
interface CrewSetup {
  readonly spots: Readonly<Record<string, Point>>;
  readonly content?: readonly WorldContent[];
  readonly delay?: () => number;
}

/** Clients `ids` joined to one room on a JSON hub, the first hosting, each at its spot. */
export async function crew(setup: CrewSetup, ...ids: string[]) {
  const { spots, content = [], delay } = setup;
  const hub = createHub();
  const clock = createManualClock();
  const nets = new Map<string, ReturnType<typeof delayed>>();
  const port = (id: string) => {
    const inner = hub.transport(id, []).port;
    if (delay === undefined) return inner;
    const net = delayed(inner, delay);
    nets.set(id, net);
    return net.port;
  };
  const client = (id: string): Room =>
    createRoom({
      localId: id,
      world: "dev",
      transport: port(id),
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
  /** Stamps what each client sent as sent now. */
  const stamp = (): void => {
    for (const net of nets.values()) net.stamp(clock.now());
  };
  /** Delivers what has arrived by now. */
  const deliver = (): void => {
    for (const net of nets.values()) net.flush(clock.now());
  };
  for (const [id, each] of rooms) {
    await each.join("FRIEND", id.toUpperCase());
    stamp();
    for (const net of nets.values()) net.flush(Infinity);
  }
  clock.advance(1000);
  /** One sim step and frame on each client still in the room, `controls` by client id. */
  const step = (controls: Readonly<Record<string, Controls>> = {}): void => {
    for (const [id, each] of rooms) {
      if (each.state().kind !== "joined") continue;
      updateSession(sessionOf(each), controls[id] ?? idle, DT);
      each.frame(clock.now());
      stamp();
    }
    clock.advance(clock.now() + DT * 1000);
    deliver();
  };
  /** Steps for `ms` of time. */
  const run = (
    ms: number,
    controls: Readonly<Record<string, Controls>> = {},
  ): void => {
    for (let at = 0; at < ms; at += DT * 1000) step(controls);
  };
  /** Every client's session still in the room. */
  const games = (): Session[] =>
    [...rooms.values()]
      .filter((each) => each.state().kind === "joined")
      .map(sessionOf);
  // Players arriving where each first stood can shove the others aside, so twice.
  for (let round = 0; round < 2; round++) {
    for (const [id, at] of Object.entries(spots)) teleport(games(), id, at);
    run(1000);
  }
  expect(room(ids[0] ?? "").hostId()).toBe(ids[0]);
  /** Puts player `id` at `at` on every client. */
  const place = (id: string, at: Point): void => {
    teleport(games(), id, at);
  };
  return { hub, clock, rooms, room, client, step, run, place, nets, stamp };
}
