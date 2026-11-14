import { applyPlayerEntries, hearPlayer } from "../sim/index.js";
import type { Player, PlayerEntry, Point, Session } from "../sim/index.js";
import { testSimConfig } from "./sim-config.js";

/** Player `id` as a host's snapshot carries it: at rest at `at`, unless `fields` say otherwise. */
export function entryOf(
  id: string,
  at: Point,
  fields: Partial<PlayerEntry> = {},
): PlayerEntry {
  return {
    id,
    name: id.toUpperCase(),
    step: null,
    x: at.x,
    y: at.y,
    vx: 0,
    vy: 0,
    stamina: {
      value: testSimConfig.stamina.max,
      exhausted: false,
      rested: testSimConfig.stamina.regenDelay,
    },
    crouched: false,
    dash: null,
    ride: null,
    steer: { move: { x: 0, y: 0 }, sprint: false, held: null },
    content: {},
    ...fields,
  };
}

/** Takes a host snapshot of player `id` at `at` on `game`, adding the player if new. */
export function heardAt(
  game: Session,
  id: string,
  at: Point,
  fields: Partial<PlayerEntry> = {},
): Player {
  applyPlayerEntries(game, [entryOf(id, at, fields)], () => true);
  const player = game.players.get(id);
  if (player === undefined) throw new Error(`${id} was not added`);
  return player;
}

/**
 * Hears player `id` report itself on `game`, as starting at `at` if it is new: facing `aim`, with
 * the reported state `content`.
 */
export function reportedAt(
  game: Session,
  id: string,
  at: Point,
  aim = 0,
  content: Readonly<Record<string, unknown>> = {},
): Player {
  hearPlayer(game, { id, name: id.toUpperCase(), aim, content, at });
  const player = game.players.get(id);
  if (player === undefined) throw new Error(`${id} was not added`);
  return player;
}
