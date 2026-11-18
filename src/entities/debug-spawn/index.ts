import { z } from "zod";
import {
  defineAction,
  effect,
  isAreaFree,
  nearestFreePoint,
  sound,
  spawnWorldItem,
} from "../../sim/index.js";
import type { Content, Point, Session, TileMap } from "../../sim/index.js";
import { arrive, arrivingKinds } from "../spawning.js";

/** The debug spawn menu: what the host lets players spawn in front of themselves, and where. */
export interface DebugSpawnConfig {
  /**
   * Whether the host takes spawn requests. Development builds and `?debug` turn it on for their
   * own client whatever this says; this is for a production build without `?debug`.
   */
  readonly enabled: boolean;
  /** How far in front of the asker a spawn lands, in world cells, short of any wall in the way. */
  readonly cells: number;
  /** How far, in pixels, the pop of a spawn is heard; it makes no noise in the world. */
  readonly soundRange: number;
}

/** Whether a client takes debug spawns while it hosts: always in development or under `?debug`, else as `config` says. */
export const takesDebugSpawns = (
  config: DebugSpawnConfig,
  development: boolean,
  debug: boolean,
): boolean => development || debug || config.enabled;

/** What a debug spawn brings: a kind the spawner brings, or an item, by its id. */
type SpawnWhat = "monster" | "item";

/** One choice in the spawn menu. */
export interface SpawnChoice {
  readonly what: SpawnWhat;
  /** The kind's name, or the item's id. */
  readonly kind: string;
  /** What the menu shows. */
  readonly label: string;
}

/** A spawn as the asker's client sends it: what, and which way the asker faces, in radians. */
const Request = z.object({
  what: z.enum(["monster", "item"]),
  kind: z.string().min(1).max(64),
  aim: z.number(),
});
type Request = z.infer<typeof Request>;

/** Pixels between the points tried along the way ahead. */
const STEP = 4;

/**
 * Where a body of `radius` spawned `distance` pixels from `from` the way `aim` faces lands: there,
 * or, with a wall across the way, the farthest point short of it the body fits. With nowhere along
 * the way it fits, the free point nearest `from`.
 */
export function spawnPointAhead(
  map: TileMap,
  from: Point,
  aim: number,
  distance: number,
  radius: number,
): Point {
  const dx = Math.cos(aim);
  const dy = Math.sin(aim);
  let fits: Point | null = isAreaFree(map, from.x, from.y, radius)
    ? from
    : null;
  const steps = Math.max(1, Math.ceil(distance / STEP));
  for (let i = 1; i <= steps; i++) {
    const along = (distance * i) / steps;
    const at = { x: from.x + dx * along, y: from.y + dy * along };
    // A wall across the way itself, however thin the body.
    if (!isAreaFree(map, at.x, at.y, 1)) break;
    if (isAreaFree(map, at.x, at.y, radius)) fits = at;
  }
  return fits ?? nearestFreePoint(map, radius, from);
}

/**
 * Everything the menu offers in `game`: every kind the spawner brings, then every item, each list
 * by name.
 */
export function spawnChoices(game: Session): SpawnChoice[] {
  const monsters = arrivingKinds(game).map(({ kind }): SpawnChoice => ({
    what: "monster",
    kind,
    label: kind,
  }));
  const items = [...game.itemDefinitions.values()].map(
    ({ id, name }): SpawnChoice => ({ what: "item", kind: id, label: name }),
  );
  const byLabel = (a: SpawnChoice, b: SpawnChoice) =>
    a.label.localeCompare(b.label);
  return [...monsters.sort(byLabel), ...items.sort(byLabel)];
}

/** The radius of a body of `kind` spawned as `what`; undefined for one `game` does not know. */
function radiusOf(
  game: Session,
  what: SpawnWhat,
  kind: string,
): number | undefined {
  if (what === "item")
    return game.itemDefinitions.has(kind)
      ? game.config.worldItems.radius
      : undefined;
  return arrivingKinds(game).find((each) => each.kind === kind)?.radius;
}

/** The spawns each session's local player has asked for, waiting for its next step. */
const asked = new WeakMap<Session, SpawnChoice[]>();

/**
 * Asks the host to spawn `choice` in front of `game`'s local player, in its next step. The host
 * spawns it if it takes debug spawns.
 */
export function requestSpawn(game: Session, choice: SpawnChoice): void {
  asked.set(game, [...(asked.get(game) ?? []), choice]);
}

/**
 * The debug spawn menu's part of the world: a spawn the local player asks for goes to the host as
 * an action, which the host takes only if it takes debug spawns, and then spawns the kind or item
 * that many cells the way the asker faces, short of any wall, with a pop and a flash. Any body
 * acting can ask; the menu is a player's.
 */
export const debugSpawn: Content<"debugSpawn", DebugSpawnConfig> = {
  name: "debugSpawn",
  create(configs) {
    const config = configs.debugSpawn;
    const pop = sound({
      url: new URL("./sfx/spawn.mp3", import.meta.url).href,
      range: config.soundRange,
      noise: false,
    });

    const spawning = defineAction("spawn", {
      input: Request,
      check: (game, _asker, { what, kind }) =>
        config.enabled && radiusOf(game, what, kind) !== undefined,
      apply(game, asker, { what, kind, aim }: Request) {
        const radius = radiusOf(game, what, kind);
        if (radius === undefined) return;
        const at = spawnPointAhead(
          game.world.map,
          asker,
          aim,
          config.cells * game.world.map.cell,
          radius,
        );
        // Only the host spawns; the asker's client predicts only the pop, as any action's effect.
        if (game.hosting) {
          if (what === "monster") arrive(game, kind, at);
          else spawnWorldItem(game, at, kind);
        }
        effect(game, {
          at,
          sound: pop,
          flash: { radius: radius * 2, hit: true },
        });
      },
    });

    return {
      name: "entity/debug-spawn",
      actions: [spawning],
      register: () => undefined,
      populate: () => undefined,
      act(game) {
        const choices = asked.get(game);
        if (choices === undefined) return;
        asked.delete(game);
        for (const { what, kind } of choices)
          spawning.perform(game, { what, kind, aim: game.local.aim });
      },
    };
  },
};
