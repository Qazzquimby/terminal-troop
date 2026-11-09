import { describe, expect, test } from "vitest";
import { createRoster } from "./presence.js";
import type { Roster } from "./presence.js";

const timing = {
  awayAfterMs: 3500,
  goneSilentMs: 30_000,
  goneHiddenMs: 180_000,
};

const state = { kind: "heard", hidden: false } as const;
const hiddenBeat = { kind: "heard", hidden: true } as const;
const shownBeat = { kind: "heard", hidden: false } as const;
const hello = { kind: "hello" } as const;
const bye = { kind: "bye" } as const;
const voiceFailed = { kind: "voiceFailed" } as const;

/** A roster where "p" is present, heard at 0. */
function withPresent(): Roster {
  const roster = createRoster(timing);
  roster.apply("p", state, 0);
  return roster;
}

/** A roster where "p" went away by silence, last heard at 0. */
function withSilentAway(): Roster {
  const roster = withPresent();
  roster.sweep(3500);
  return roster;
}

/** A roster where "p" is away with its page hidden, last heard at 0. */
function withHiddenAway(): Roster {
  const roster = createRoster(timing);
  roster.apply("p", hiddenBeat, 0);
  return roster;
}

describe("arriving", () => {
  test("a STATE, HELLO or visible heartbeat makes a new player present", () => {
    for (const event of [state, hello, shownBeat]) {
      const roster = createRoster(timing);
      expect(roster.apply("p", event, 5)).toEqual({
        id: "p",
        from: "gone",
        to: "present",
      });
      expect(roster.get("p")).toEqual({ kind: "present", lastHeard: 5 });
    }
  });

  test("a hidden heartbeat makes a new player away", () => {
    const roster = createRoster(timing);
    expect(roster.apply("p", hiddenBeat, 5)).toEqual({
      id: "p",
      from: "gone",
      to: "away",
    });
    expect(roster.get("p")).toEqual({
      kind: "away",
      lastHeard: 5,
      hidden: true,
    });
  });

  test("voice failing or BYE for an unknown player changes nothing", () => {
    const roster = createRoster(timing);
    expect(roster.apply("p", voiceFailed, 0)).toBeNull();
    expect(roster.apply("q", bye, 0)).toBeNull();
    expect([...roster.ids()]).toEqual([]);
  });
});

describe("present", () => {
  test("hearing again keeps it present and moves its last heard time", () => {
    const roster = withPresent();
    expect(roster.apply("p", shownBeat, 2000)).toBeNull();
    expect(roster.get("p")).toEqual({ kind: "present", lastHeard: 2000 });
  });

  test("goes away after awayAfterMs of silence", () => {
    const roster = withPresent();
    expect(roster.sweep(3499)).toEqual([]);
    expect(roster.sweep(3500)).toEqual([
      { id: "p", from: "present", to: "away" },
    ]);
    expect(roster.get("p")).toEqual({
      kind: "away",
      lastHeard: 0,
      hidden: false,
    });
  });

  test("goes away on a hidden heartbeat", () => {
    const roster = withPresent();
    expect(roster.apply("p", hiddenBeat, 100)).toEqual({
      id: "p",
      from: "present",
      to: "away",
    });
  });

  test("is gone on BYE", () => {
    const roster = withPresent();
    expect(roster.apply("p", bye, 100)).toEqual({
      id: "p",
      from: "present",
      to: "gone",
    });
    expect(roster.get("p")).toBeUndefined();
  });

  test("stays present when its voice fails", () => {
    const roster = withPresent();
    expect(roster.apply("p", voiceFailed, 100)).toBeNull();
    expect(roster.get("p")?.kind).toBe("present");
  });
});

describe("away", () => {
  test("comes back on a STATE or a visible heartbeat", () => {
    for (const event of [state, shownBeat]) {
      const roster = withHiddenAway();
      expect(roster.apply("p", event, 100)).toEqual({
        id: "p",
        from: "away",
        to: "present",
      });
    }
  });

  test("a hidden heartbeat keeps it away and moves its last heard time", () => {
    const roster = withSilentAway();
    expect(roster.apply("p", hiddenBeat, 4000)).toBeNull();
    expect(roster.get("p")).toEqual({
      kind: "away",
      lastHeard: 4000,
      hidden: true,
    });
  });

  test("is gone on BYE", () => {
    const roster = withHiddenAway();
    expect(roster.apply("p", bye, 100)).toEqual({
      id: "p",
      from: "away",
      to: "gone",
    });
  });

  test("is gone when its voice fails", () => {
    const roster = withHiddenAway();
    expect(roster.apply("p", voiceFailed, 100)).toEqual({
      id: "p",
      from: "away",
      to: "gone",
    });
    expect(roster.get("p")).toBeUndefined();
  });

  test("with its page last visible, is gone after goneSilentMs of silence", () => {
    const roster = withSilentAway();
    expect(roster.sweep(29_999)).toEqual([]);
    expect(roster.sweep(30_000)).toEqual([
      { id: "p", from: "away", to: "gone" },
    ]);
  });

  test("with its page last hidden, is gone only after goneHiddenMs of silence", () => {
    const roster = withHiddenAway();
    expect(roster.sweep(30_000)).toEqual([]);
    expect(roster.sweep(179_999)).toEqual([]);
    expect(roster.get("p")?.kind).toBe("away");
    expect(roster.sweep(180_000)).toEqual([
      { id: "p", from: "away", to: "gone" },
    ]);
  });

  test("a present player silent long enough goes straight to gone", () => {
    const roster = withPresent();
    expect(roster.sweep(30_000)).toEqual([
      { id: "p", from: "present", to: "gone" },
    ]);
  });
});

describe("a hidden peer that only heartbeats", () => {
  test("stays away while its heartbeats keep coming, however slowly", () => {
    const roster = withHiddenAway();
    for (let time = 60_000; time <= 600_000; time += 60_000) {
      expect(roster.sweep(time)).toEqual([]);
      roster.apply("p", hiddenBeat, time);
    }
    expect(roster.get("p")?.kind).toBe("away");
  });

  test("stays away for 179s after its last heartbeat, then is gone", () => {
    const roster = withPresent();
    roster.apply("p", hiddenBeat, 1000);
    for (let time = 2000; time <= 180_000; time += 1000) {
      expect(roster.sweep(time)).toEqual([]);
    }
    expect(roster.get("p")?.kind).toBe("away");
    expect(roster.sweep(181_000)).toEqual([
      { id: "p", from: "away", to: "gone" },
    ]);
  });
});

describe("after BYE", () => {
  test("STATE and heartbeats are ignored until a HELLO", () => {
    const roster = withPresent();
    roster.apply("p", bye, 100);
    expect(roster.apply("p", state, 200)).toBeNull();
    expect(roster.apply("p", hiddenBeat, 300)).toBeNull();
    expect(roster.apply("p", voiceFailed, 300)).toBeNull();
    expect(roster.get("p")).toBeUndefined();

    expect(roster.apply("p", hello, 400)).toEqual({
      id: "p",
      from: "gone",
      to: "present",
    });
    expect(roster.apply("p", hiddenBeat, 500)).toEqual({
      id: "p",
      from: "present",
      to: "away",
    });
  });

  test("other players are unaffected", () => {
    const roster = withPresent();
    roster.apply("p", bye, 100);
    expect(roster.apply("q", state, 200)?.to).toBe("present");
    expect([...roster.ids()]).toEqual(["q"]);
  });
});

test("a sweep reports every player that changed", () => {
  const roster = createRoster(timing);
  roster.apply("a", state, 0);
  roster.apply("b", state, 0);
  roster.apply("c", state, 3000);
  expect(roster.sweep(3500)).toEqual([
    { id: "a", from: "present", to: "away" },
    { id: "b", from: "present", to: "away" },
  ]);
  expect([...roster.ids()].sort()).toEqual(["a", "b", "c"]);
});
