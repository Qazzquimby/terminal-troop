import { describe, expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { createPlayer, createSession } from "../sim/index.js";
import type { Session } from "../sim/index.js";
import { voiceMix } from "../voice/index.js";
import type { PeerMix } from "../voice/index.js";
import { syncVoicePeers } from "./voice-peers.js";

const falloff = { full: 100, silent: 600, pan: 300 };

describe("syncVoicePeers", () => {
  function addRemote(session: Session, id: string, dx: number): void {
    const player = createPlayer(id, id, session.local, testSimConfig);
    player.x = session.local.x + dx;
    player.y = session.local.y;
    session.players.set(id, player);
  }

  /** A session with remote players `dx` to the right of the local one, and a recording room. */
  function setup(...remotes: [string, number][]) {
    const session = createSession(
      "me",
      "ME",
      "ROOM1",
      "dev",
      testSfx(),
      testSimConfig,
    );
    for (const [id, dx] of remotes) addRemote(session, id, dx);
    const calls: string[] = [];
    const mixes = new Map<string, PeerMix>();
    const room = {
      setPeerMix(id: string, mix: PeerMix) {
        calls.push(`mix ${id}`);
        mixes.set(id, mix);
      },
      setPeers(ids: ReadonlySet<string>) {
        calls.push(`peers ${[...ids].sort().join(",")}`);
      },
    };
    return { session, calls, mixes, room };
  }

  test("a new player gets its proximity mix before the room hears of it", () => {
    const { session, calls, mixes, room } = setup(["far", 450]);
    const peers = syncVoicePeers(
      session,
      session.players.keys(),
      room,
      new Set(),
      falloff,
    );
    expect(calls).toEqual(["mix far", "peers far"]);
    expect([...peers]).toEqual(["far"]);
    const expected = voiceMix(
      session.local,
      {
        x: session.local.x + 450,
        y: session.local.y,
      },
      falloff,
    );
    expect(mixes.get("far")).toEqual(expected);
    expect(expected.volume).toBeLessThan(1);
  });

  test("unchanged players call nothing and keep the same set", () => {
    const { session, calls, room } = setup(["a", 0], ["b", 0]);
    const peers = syncVoicePeers(
      session,
      session.players.keys(),
      room,
      new Set(),
      falloff,
    );
    calls.length = 0;
    expect(
      syncVoicePeers(session, session.players.keys(), room, peers, falloff),
    ).toBe(peers);
    expect(calls).toEqual([]);
  });

  test("only players new to the set get a mix", () => {
    const { session, calls, room } = setup(["a", 0]);
    const peers = syncVoicePeers(
      session,
      session.players.keys(),
      room,
      new Set(),
      falloff,
    );
    calls.length = 0;
    addRemote(session, "b", 0);
    syncVoicePeers(session, session.players.keys(), room, peers, falloff);
    expect(calls).toEqual(["mix b", "peers a,b"]);
  });

  test("a player gone from the session leaves the set", () => {
    const { session, calls, room } = setup(["a", 0], ["b", 0]);
    const peers = syncVoicePeers(
      session,
      session.players.keys(),
      room,
      new Set(),
      falloff,
    );
    calls.length = 0;
    session.players.delete("a");
    expect([
      ...syncVoicePeers(session, session.players.keys(), room, peers, falloff),
    ]).toEqual(["b"]);
    expect(calls).toEqual(["peers b"]);
  });

  test("the same count with a different player still updates", () => {
    const { session, calls, room } = setup(["a", 0]);
    const peers = syncVoicePeers(
      session,
      session.players.keys(),
      room,
      new Set(),
      falloff,
    );
    calls.length = 0;
    session.players.delete("a");
    addRemote(session, "c", 0);
    syncVoicePeers(session, session.players.keys(), room, peers, falloff);
    expect(calls).toEqual(["mix c", "peers c"]);
  });

  test("an id without a player stays out of the set", () => {
    const { session, calls, room } = setup(["a", 0]);
    const peers = syncVoicePeers(
      session,
      ["a", "ghost"],
      room,
      new Set(),
      falloff,
    );
    expect([...peers]).toEqual(["a"]);
    expect(calls).toEqual(["mix a", "peers a"]);
  });

  test("the local player is never a voice peer", () => {
    const { session, calls, room } = setup();
    expect([
      ...syncVoicePeers(
        session,
        session.players.keys(),
        room,
        new Set(["gone"]),
        falloff,
      ),
    ]).toEqual([]);
    expect(calls).toEqual(["peers "]);
  });
});
