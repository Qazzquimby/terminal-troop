import { z } from "zod";
import { hasEscaped } from "../entities/index.js";
import {
  entityWho,
  falls,
  isGhost,
  ITEM_TAG,
  PLAYER_TAG,
  rises,
  stunLeft,
  stunnedIds,
  who,
} from "../sim/index.js";
import type { Fall, Rise, Session, Who, WorldEntity } from "../sim/index.js";

/** What an item lying in the world keeps of which item it is. */
const Lying = z.object({ item: z.string() });

/** What a log calls an item lying in the world, as its kind. */
const ITEM_KIND = "item";

/** `entity` as the log names it: a lying item by the item it is, `<item>#<id>`. */
function nameEntity(game: Session, entity: WorldEntity): Who {
  const named = entityWho(game, entity);
  if (game.entityTypes.get(entity.kind)?.tags.includes(ITEM_TAG) !== true)
    return named;
  const lying = Lying.safeParse(entity.data);
  return {
    id: entity.id,
    kind: ITEM_KIND,
    label: `${lying.success ? lying.data.item : named.kind}#${entity.id}`,
  };
}

/*
 * A log of what happens in the world, for playtesting and debugging: what spawned, what killed
 * what, who died, came back or got away. Every client keeps its own, guests included, from state
 * each already holds: entities appearing in and going from its snapshots, players turning ghost
 * and back, the statuses record, and the host's record of the latest falls (`falls`), which names
 * each body and its killer as it fell, so a body gone before any snapshot showed it dead is still
 * told. Nothing here sends anything.
 */

/**
 * What a world event is about, to filter on:
 * - world: a new world, and what it held when this client first saw it
 * - spawn: an entity appeared
 * - death: a body's health ran out, any body, players included
 * - removed: an entity went without dying, as one carried off
 * - item: an item appeared lying in the world, or went from it, as dropped or picked up
 * - player: a player joined, left, came back to life or escaped
 * - stun: a body was stunned
 */
type Category =
  "world" | "spawn" | "death" | "removed" | "item" | "player" | "stun";

/** One thing that happened in the world. */
interface WorldEvent {
  /** When, on the world's clock. */
  readonly at: number;
  readonly category: Category;
  /** The body it happened to, as named then; null for the world itself. */
  readonly subject: Who | null;
  /** For a death, what dealt the last of it, as named then; null for no one. */
  readonly by?: Who | null;
  /** The line it prints as, after its time. */
  readonly text: string;
  /** Whether it prints to stand out: a player's death, revival or escape. */
  readonly loud?: boolean;
}

/** What befell a player, as `players()` lists it. */
interface PlayerRow {
  /** When, on the world's clock, and as mm:ss. */
  readonly at: number;
  readonly time: string;
  readonly player: string;
  readonly what: "died" | "revived" | "escaped";
  /** What caused it, by label; null for no one, or nothing known. */
  readonly by: string | null;
}

/** How the world log keeps and shows what it logs. */
export interface WorldLogConfig {
  /**
   * Logs in production too. Development builds and `?debug` log whatever this says; this is for
   * a production build without `?debug`.
   */
  readonly enabled: boolean;
  /** Most events kept, the oldest dropped first; tallies cover the whole world regardless. */
  readonly capacity: number;
  /** Categories kept and tallied but not printed to the console, as too noisy to follow. */
  readonly quiet: readonly Category[];
  /**
   * Prints deaths no player took part in, neither dying nor killing, such as monsters killing
   * monsters. Kept and tallied either way.
   */
  readonly monsterDeaths: boolean;
}

/** What killed one kind, and how often. */
interface KillRow {
  readonly victim: string;
  readonly killer: string;
  readonly count: number;
}

/** How many of a kind have spawned, died and are in the world now. */
interface KindCount {
  readonly spawned: number;
  readonly died: number;
  readonly alive: number;
}

/** Picks events: by category, kind or any text in the line; or by a test of each. */
type EventFilter = string | ((event: WorldEvent) => boolean);

/** What the log has of the world being watched, as read from the console. */
export interface WorldLog {
  /** Notes what changed in `game` since the last call; a different session starts afresh. */
  observe(game: Session): void;
  /** The events kept, oldest first, those `filter` picks when given. */
  events(filter?: EventFilter): WorldEvent[];
  /** What killed `victim`'s kind this world, most kills first; every kind's when left out. */
  kills(victim?: string): KillRow[];
  /** Per kind, how many have spawned, died and are in the world now. */
  counts(): Record<string, KindCount>;
  /** Every player death, revival and escape this world, oldest first, with what caused each. */
  players(): PlayerRow[];
}

/** How a loud line stands out in the console. */
const LOUD_STYLE = "font-weight: bold; color: #ff6b6b";

/** Prints `line` to the console, a loud one as a styled warning. */
function printToConsole(line: string, loud: boolean): void {
  if (loud) console.warn(`%c${line}`, LOUD_STYLE);
  else console.info(line);
}

/** "Nothing" kills what no body killed, such as a fall the world itself dealt. */
const NOTHING = "nothing";

/** `seconds` on the world's clock as mm:ss. */
function clockTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`;
}

/** What the log remembers of the world it watches, as of its last look. */
interface Watch {
  readonly game: Session;
  /** Each entity seen, as last named. */
  readonly entities: Map<string, Who>;
  /** Whether any entity has been seen; the first seen are what the world held, not spawns. */
  primed: boolean;
  /** Each player seen, whether a ghost, and whether escaped. */
  readonly players: Map<
    string,
    { named: Who; ghost: boolean; escaped: boolean }
  >;
  readonly stunned: Set<string>;
  /** The number of the next fall to log. */
  nextFall: number;
  /** Entities logged as fallen, so their going is not logged again. */
  readonly fallen: Set<string>;
  /** The number of the next rising to log. */
  nextRise: number;
  /** Players logged as risen whose coming back to life is not yet seen, so it is not told twice. */
  readonly risen: Set<string>;
  /** What befell each player, oldest first; never dropped. */
  readonly befell: PlayerRow[];
  /** Kills by victim kind, then by killer kind. */
  readonly kills: Map<string, Map<string, number>>;
  readonly spawned: Map<string, number>;
  readonly died: Map<string, number>;
}

const watching = (game: Session): Watch => ({
  game,
  entities: new Map(),
  primed: false,
  players: new Map(),
  stunned: new Set(),
  nextFall: 0,
  fallen: new Set(),
  nextRise: 0,
  risen: new Set(),
  befell: [],
  kills: new Map(),
  spawned: new Map(),
  died: new Map(),
});

const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

/** Whether to log the world: always in development or under `?debug`, else as `config` says. */
export const logsWorld = (
  config: WorldLogConfig,
  development: boolean,
  debug: boolean,
): boolean => development || debug || config.enabled;

/**
 * A world log, printing each event with `print` as `[world mm:ss] <text>` unless its category is
 * quiet, or it is a death no player took part in and `config.monsterDeaths` is off. A player's
 * death, revival or escape prints loud. It keeps at most `config.capacity` events, and starts
 * afresh with each new session.
 */
export function createWorldLog(
  config: WorldLogConfig,
  print: (line: string, loud: boolean) => void = printToConsole,
): WorldLog {
  let kept: WorldEvent[] = [];
  let watch: Watch | null = null;

  function log(
    game: Session,
    event: Omit<WorldEvent, "at">,
    at = game.worldTime,
    hushed = false,
  ): void {
    const full = { ...event, at };
    kept.push(full);
    if (kept.length > config.capacity) kept = kept.slice(-config.capacity);
    if (!hushed && !config.quiet.includes(event.category))
      print(`[world ${clockTime(at)}] ${event.text}`, event.loud === true);
  }

  /** Notes what befell player `named`, caused by `by`, for `players()`. */
  function befall(
    w: Watch,
    named: Who,
    what: PlayerRow["what"],
    by: Who | null,
    at: number,
  ): void {
    w.befell.push({
      at,
      time: clockTime(at),
      player: named.label,
      what,
      by: by?.label ?? null,
    });
  }

  function logFall(w: Watch, fall: Fall): void {
    const { victim, by } = fall;
    const killer = by === null ? NOTHING : by.kind;
    const byText =
      by === null ? NOTHING : by.id === victim.id ? "itself" : by.label;
    let tally = w.kills.get(victim.kind);
    if (tally === undefined)
      w.kills.set(victim.kind, (tally = new Map<string, number>()));
    bump(tally, killer);
    bump(w.died, victim.kind);
    const player = victim.kind === PLAYER_TAG;
    if (player) befall(w, victim, "died", by, fall.at);
    else w.fallen.add(victim.id);
    const hushed = !config.monsterDeaths && !player && by?.kind !== PLAYER_TAG;
    log(
      w.game,
      {
        category: "death",
        subject: victim,
        by,
        text: `${victim.label} killed by ${byText}`,
        loud: player,
      },
      fall.at,
      hushed,
    );
  }

  function logRise(w: Watch, rise: Rise): void {
    const { body, by } = rise;
    w.risen.add(body.id);
    befall(w, body, "revived", by, rise.at);
    log(
      w.game,
      {
        category: "player",
        subject: body,
        by,
        text: `${body.label} revived by ${by === null ? NOTHING : by.label}`,
        loud: true,
      },
      rise.at,
    );
  }

  /**
   * Notes what the world holds as this client first sees it: once it hosts, or once a host's
   * snapshot has reached it. Until then a guest holds nothing of the world, and the whole of it
   * arriving at once is no spawn.
   */
  function prime(w: Watch): void {
    const { game } = w;
    if (!game.hosting && game.heard.size === 0) return;
    w.primed = true;
    const held = new Map<string, number>();
    for (const entity of game.entities.values()) {
      const named = nameEntity(game, entity);
      w.entities.set(entity.id, named);
      bump(held, named.kind);
      bump(w.spawned, named.kind);
    }
    const list = [...held]
      .map(([kind, count]) => `${kind}×${String(count)}`)
      .join(", ");
    log(game, {
      category: "world",
      subject: null,
      text: `world holds ${String(game.entities.size)} entities${list === "" ? "" : `: ${list}`}`,
    });
  }

  function observeEntities(w: Watch): void {
    const { game } = w;
    if (!w.primed) {
      prime(w);
      return;
    }
    for (const entity of game.entities.values()) {
      if (w.entities.has(entity.id)) continue;
      const named = nameEntity(game, entity);
      w.entities.set(entity.id, named);
      bump(w.spawned, named.kind);
      const item = named.kind === ITEM_KIND;
      const at = `(${String(Math.round(entity.x))}, ${String(Math.round(entity.y))})`;
      log(game, {
        category: item ? "item" : "spawn",
        subject: named,
        text: `${named.label} ${item ? "appeared" : "spawned"} at ${at}`,
      });
    }
    for (const [id, named] of w.entities) {
      if (game.entities.has(id)) continue;
      w.entities.delete(id);
      if (w.fallen.delete(id)) continue;
      const item = named.kind === ITEM_KIND;
      log(game, {
        category: item ? "item" : "removed",
        subject: named,
        text: `${named.label} gone`,
      });
    }
  }

  function observePlayers(w: Watch): void {
    const { game } = w;
    for (const player of game.players.values()) {
      const ghost = isGhost(player);
      const escaped = hasEscaped(game, player);
      const seen = w.players.get(player.id);
      const named = who(game, player.id);
      w.players.set(player.id, { named, ghost, escaped });
      const say = (text: string, loud = false) => {
        log(game, {
          category: "player",
          subject: named,
          text: `${named.label} ${text}`,
          loud,
        });
      };
      if (seen === undefined) say(ghost ? "joined, dead" : "joined");
      // One brought back by a body was told as its rising was; any other way back is told here.
      else if (seen.ghost && !ghost && !w.risen.delete(player.id)) {
        befall(w, named, "revived", null, game.worldTime);
        say("revived", true);
      }
      // Seen alive, any rising told is done with, so a later way back is not mistaken for it.
      if (!ghost) w.risen.delete(player.id);
      if (escaped && seen?.escaped !== true) {
        befall(w, named, "escaped", null, game.worldTime);
        say("escaped", true);
      }
    }
    for (const [id, { named }] of w.players) {
      if (game.players.has(id)) continue;
      w.players.delete(id);
      log(game, {
        category: "player",
        subject: named,
        text: `${named.label} left`,
      });
    }
  }

  function observeStuns(w: Watch): void {
    const { game } = w;
    const now = new Set(stunnedIds(game));
    for (const id of now) {
      if (w.stunned.has(id)) continue;
      const named = who(game, id);
      const left = stunLeft(game, id) ?? 0;
      log(game, {
        category: "stun",
        subject: named,
        text: `${named.label} stunned for ${left.toFixed(1)}s`,
      });
    }
    w.stunned.clear();
    for (const id of now) w.stunned.add(id);
  }

  return {
    observe(game) {
      if (watch?.game !== game) {
        watch = watching(game);
        kept = [];
      }
      const w = watch;
      // Falls first: a body that fell and went in one look is told as fallen, not as gone.
      for (const fall of falls.get(game))
        if (fall.n >= w.nextFall) {
          logFall(w, fall);
          w.nextFall = fall.n + 1;
        }
      // Risings before players: one told as risen is not told again as it comes back.
      for (const rise of rises.get(game))
        if (rise.n >= w.nextRise) {
          logRise(w, rise);
          w.nextRise = rise.n + 1;
        }
      observeEntities(w);
      observePlayers(w);
      observeStuns(w);
    },
    events(filter) {
      if (filter === undefined) return [...kept];
      if (typeof filter === "function") return kept.filter(filter);
      return kept.filter(
        (event) =>
          event.category === filter ||
          event.subject?.kind === filter ||
          event.text.includes(filter),
      );
    },
    kills(victim) {
      const rows = [...(watch?.kills ?? [])].flatMap(([kind, by]) =>
        [...by].map(([killer, count]) => ({ victim: kind, killer, count })),
      );
      return rows
        .filter((row) => victim === undefined || row.victim === victim)
        .sort((a, b) => b.count - a.count);
    },
    players() {
      return [...(watch?.befell ?? [])];
    },
    counts() {
      if (watch === null) return {};
      const alive = new Map<string, number>();
      for (const [id, named] of watch.entities)
        if (!watch.fallen.has(id)) bump(alive, named.kind);
      const kinds = new Set([
        ...watch.spawned.keys(),
        ...watch.died.keys(),
        ...alive.keys(),
      ]);
      const { spawned, died } = watch;
      return Object.fromEntries(
        [...kinds].map((kind) => [
          kind,
          {
            spawned: spawned.get(kind) ?? 0,
            died: died.get(kind) ?? 0,
            alive: alive.get(kind) ?? 0,
          },
        ]),
      );
    },
  };
}
