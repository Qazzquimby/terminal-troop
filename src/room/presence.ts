/** How long silence lasts before a remote player counts as away, then gone. */
export interface PresenceTiming {
  /** Milliseconds of silence before a present player is away. */
  readonly awayAfterMs: number;
  /** Milliseconds of silence before an away player whose page was last visible is gone. */
  readonly goneSilentMs: number;
  /** Milliseconds of silence before an away player whose page was last hidden is gone. */
  readonly goneHiddenMs: number;
}

/**
 * - present: heard from recently, with its page visible
 * - away: silent for a while, or its page hidden; `hidden` is the last flag it sent
 *
 * A player with no presence is gone.
 */
export type Presence =
  | { readonly kind: "present"; readonly lastHeard: number }
  | {
      readonly kind: "away";
      readonly lastHeard: number;
      readonly hidden: boolean;
    };

/**
 * - heard: a STATE (hidden: false) or a heartbeat carrying its page's hidden flag
 * - hello: the player joined; clears a BYE and counts as heard with its page visible
 * - bye: the player left
 * - voiceFailed: its voice connection stayed down past its deadline
 */
export type PresenceEvent =
  | { readonly kind: "heard"; readonly hidden: boolean }
  | { readonly kind: "hello" }
  | { readonly kind: "bye" }
  | { readonly kind: "voiceFailed" };

type PresenceKind = Presence["kind"] | "gone";

export interface PresenceChange {
  readonly id: string;
  readonly from: PresenceKind;
  readonly to: PresenceKind;
}

/** The presence of every remote player, moved along by events and by time passing. */
export interface Roster {
  /** The change `event` from `id` makes at `now`, or null when its kind stays the same. */
  apply(id: string, event: PresenceEvent, now: number): PresenceChange | null;
  /** Moves every player along by the silence up to `now`. */
  sweep(now: number): PresenceChange[];
  /** Undefined for a gone player. */
  get(id: string): Presence | undefined;
  /** Every player present or away. */
  ids(): Iterable<string>;
}

/** Where `presence` stands after the silence up to `now`. */
function aged(
  presence: Presence,
  now: number,
  timing: PresenceTiming,
): Presence | undefined {
  const silent = now - presence.lastHeard;
  const hidden = presence.kind === "away" && presence.hidden;
  if (silent >= (hidden ? timing.goneHiddenMs : timing.goneSilentMs))
    return undefined;
  if (presence.kind === "present" && silent >= timing.awayAfterMs)
    return { kind: "away", lastHeard: presence.lastHeard, hidden: false };
  return presence;
}

/** Where `presence` stands after `event`; null for an event that leaves it alone. */
function next(
  presence: Presence | undefined,
  event: PresenceEvent,
  now: number,
): Presence | undefined | null {
  switch (event.kind) {
    case "hello":
      return { kind: "present", lastHeard: now };
    case "heard":
      return event.hidden
        ? { kind: "away", lastHeard: now, hidden: true }
        : { kind: "present", lastHeard: now };
    case "bye":
      return undefined;
    case "voiceFailed":
      return presence?.kind === "away" ? undefined : null;
  }
}

export function createRoster(timing: PresenceTiming): Roster {
  const players = new Map<string, Presence>();
  /** Players who said BYE, ignored until they say HELLO. */
  const left = new Set<string>();

  function set(id: string, to: Presence | undefined): PresenceChange | null {
    const from = players.get(id);
    if (to === undefined) players.delete(id);
    else players.set(id, to);
    const fromKind = from?.kind ?? "gone";
    const toKind = to?.kind ?? "gone";
    return fromKind === toKind ? null : { id, from: fromKind, to: toKind };
  }

  return {
    apply(id, event, now) {
      if (event.kind === "hello") left.delete(id);
      else if (event.kind === "bye") left.add(id);
      else if (left.has(id)) return null;
      const to = next(players.get(id), event, now);
      return to === null ? null : set(id, to);
    },

    sweep(now) {
      const changes: PresenceChange[] = [];
      for (const [id, presence] of players) {
        const change = set(id, aged(presence, now, timing));
        if (change !== null) changes.push(change);
      }
      return changes;
    },

    get: (id) => players.get(id),

    ids: () => players.keys(),
  };
}
