import { describe, expect, test } from "vitest";
import { connectionStats } from "./stats.js";

const candidates = (local: string, remote: string) => [
  ["L", { type: "local-candidate", candidateType: local }],
  ["R", { type: "remote-candidate", candidateType: remote }],
];

const pair = (id: string, extra: object = {}) => [
  id,
  {
    type: "candidate-pair",
    localCandidateId: "L",
    remoteCandidateId: "R",
    ...extra,
  },
];

function report(entries: unknown[][]): ReadonlyMap<string, unknown> {
  return new Map(entries.map(([id, stat]) => [String(id), stat] as const));
}

describe("connectionStats", () => {
  test("the route is the candidate types of the pair the transport selected", () => {
    const stats = report([
      ["T", { type: "transport", selectedCandidatePairId: "P" }],
      pair("P"),
      ...candidates("relay", "srflx"),
    ]);
    expect(connectionStats(stats).route).toEqual({
      local: "relay",
      remote: "srflx",
    });
  });

  test.each([
    ["marked selected", { selected: true }],
    ["nominated and succeeded", { nominated: true, state: "succeeded" }],
  ])("without a transport, a pair %s is the one in use", (_, extra) => {
    const stats = report([pair("P", extra), ...candidates("host", "host")]);
    expect(connectionStats(stats).route).toEqual({
      local: "host",
      remote: "host",
    });
  });

  test("no route before a pair is picked", () => {
    const stats = report([
      pair("P", { nominated: false, state: "in-progress" }),
      ...candidates("host", "srflx"),
    ]);
    expect(connectionStats(stats).route).toBeNull();
  });

  test("received bytes add up the incoming audio streams only", () => {
    const stats = report([
      ["A", { type: "inbound-rtp", kind: "audio", bytesReceived: 300 }],
      ["B", { type: "inbound-rtp", kind: "audio", bytesReceived: 200 }],
      ["V", { type: "inbound-rtp", kind: "video", bytesReceived: 9000 }],
      ["O", { type: "outbound-rtp", kind: "audio", bytesSent: 700 }],
    ]);
    expect(connectionStats(stats)).toEqual({ route: null, bytesReceived: 500 });
  });
});
