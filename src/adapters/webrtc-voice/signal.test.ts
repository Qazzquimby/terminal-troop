import { describe, expect, test } from "vitest";
import { isPolite, signalFor } from "./signal.js";

const ME = "player-b";
const OFFER = { type: "offer", sdp: "v=0\r\n" };
const CANDIDATE = {
  candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
};

describe("signal messages", () => {
  test("a description addressed to us parses", () => {
    const message = { from: "player-a", to: ME, description: OFFER };
    expect(signalFor(message, ME)).toEqual(message);
  });

  test("a candidate addressed to us parses, with null mid and index", () => {
    const candidate = { ...CANDIDATE, sdpMid: null, sdpMLineIndex: null };
    const message = { from: "player-a", to: ME, candidate };
    expect(signalFor(message, ME)).toEqual(message);
  });

  test("messages addressed to someone else are ignored", () => {
    expect(
      signalFor({ from: "player-a", to: "player-c", description: OFFER }, ME),
    ).toBeNull();
    expect(
      signalFor({ from: "player-a", to: "player-c", candidate: CANDIDATE }, ME),
    ).toBeNull();
  });

  test("messages from ourselves are ignored", () => {
    expect(signalFor({ from: ME, to: ME, description: OFFER }, ME)).toBeNull();
  });

  test.each([
    ["no payload", null],
    ["missing body", { from: "player-a", to: ME }],
    ["missing sender", { to: ME, description: OFFER }],
    [
      "unknown description type",
      { from: "player-a", to: ME, description: { type: "hack", sdp: "" } },
    ],
    [
      "description without sdp",
      { from: "player-a", to: ME, description: { type: "offer" } },
    ],
    [
      "candidate with a bad index",
      {
        from: "player-a",
        to: ME,
        candidate: { ...CANDIDATE, sdpMLineIndex: -1 },
      },
    ],
    ["empty sender id", { from: "", to: ME, description: OFFER }],
  ])("rejects %s", (_name, payload) => {
    expect(signalFor(payload, ME)).toBeNull();
  });
});

describe("negotiation roles", () => {
  test("exactly one side of a pair is polite", () => {
    const pairs = [
      ["a", "b"],
      ["0f3c", "0f3b"],
      ["4d6e1a2b-0000", "4d6e1a2b-0001"],
    ] as const;
    for (const [one, other] of pairs) {
      expect(isPolite(one, other)).not.toBe(isPolite(other, one));
    }
  });

  test("the lower id is polite", () => {
    expect(isPolite("a", "b")).toBe(true);
    expect(isPolite("b", "a")).toBe(false);
  });
});
