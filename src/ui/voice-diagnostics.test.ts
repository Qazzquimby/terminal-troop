import { describe, expect, test } from "vitest";
import type {
  MicPermission,
  MicState,
  PeerDiagnostics,
  VoiceDiagnostics,
} from "../voice/index.js";
import {
  TURN_HINT,
  deviceLabel,
  micNeedsRequest,
  micStatusText,
  peerVoiceView,
  voiceDebugLines,
} from "./voice-diagnostics.js";

const DEVICES = [
  { id: "usb", label: "USB mic" },
  { id: "hidden", label: "" },
];

function mic(
  permission: MicPermission,
  state: MicState,
): VoiceDiagnostics["mic"] {
  return {
    permission,
    state,
    devices: DEVICES,
    device: state === "live" ? "usb" : null,
    level: 0.5,
    testing: false,
  };
}

describe("mic status text", () => {
  test.each<[MicPermission, MicState, RegExp]>([
    ["unavailable", "unavailable", /secure page \(https\)/],
    ["denied", "denied", /blocked.*address bar.*Request mic access again/],
    ["prompt", "pending", /not asked for yet.*Test mic/],
    ["prompt", "unavailable", /Request mic access again/],
    ["granted", "live", /^Microphone on: USB mic\.$/],
    ["granted", "unavailable", /No microphone found/],
    ["granted", "pending", /allowed.*Test mic/],
  ])("%s with the mic %s", (permission, state, text) => {
    expect(micStatusText(mic(permission, state))).toMatch(text);
  });

  test.each<[MicState, boolean]>([
    ["pending", false],
    ["live", false],
    ["denied", true],
    ["unavailable", true],
  ])("a mic %s offers asking again: %s", (state, offered) => {
    expect(micNeedsRequest(mic("prompt", state))).toBe(offered);
  });
});

test("devices without labels are numbered, and an unknown one is the default", () => {
  expect(deviceLabel(DEVICES, "usb")).toBe("USB mic");
  expect(deviceLabel(DEVICES, "hidden")).toBe("Microphone 2");
  expect(deviceLabel(DEVICES, "gone")).toBe("browser default");
  expect(deviceLabel(DEVICES, null)).toBe("none");
});

function peer(overrides: Partial<PeerDiagnostics>): PeerDiagnostics {
  return {
    id: "them",
    state: "connected",
    ice: "connected",
    signaling: "stable",
    since: 1000,
    route: { local: "srflx", remote: "host" },
    bytesReceived: 4096,
    receiving: true,
    failures: 0,
    ...overrides,
  };
}

describe("peer voice view", () => {
  test("a connected peer shows its time in state, route and incoming audio", () => {
    expect(peerVoiceView(peer({}), 13_500)).toEqual({
      state: "connected 12s",
      detail: "ice connected · sig stable · srflx/host · audio in",
      hint: null,
    });
    expect(peerVoiceView(peer({ receiving: false }), 1000).detail).toContain(
      "no audio in",
    );
  });

  test.each<Partial<PeerDiagnostics>>([
    { state: "failed", ice: "failed", route: null },
    { state: "closed", ice: "closed" },
    { state: "pending", ice: null, signaling: null, failures: 2 },
    { state: "connecting", ice: "checking", failures: 1 },
  ])("a connection that gave up hints at TURN: %o", (overrides) => {
    expect(peerVoiceView(peer(overrides), 2000).hint).toBe(TURN_HINT);
  });

  test("a peer without a connection is starting, or waiting to retry after a failure", () => {
    const idle = {
      state: "pending",
      ice: null,
      signaling: null,
      route: null,
    } as const;
    expect(peerVoiceView(peer(idle), 1000)).toEqual({
      state: "starting 0s",
      detail: "no route",
      hint: null,
    });
    expect(peerVoiceView(peer({ ...idle, failures: 1 }), 4000)).toEqual({
      state: "waiting to retry 3s",
      detail: "no route · 1 failed",
      hint: TURN_HINT,
    });
  });

  test("a peer still connecting for the first time has no hint", () => {
    const view = peerVoiceView(
      peer({ state: "connecting", ice: "checking", route: null }),
      2000,
    );
    expect(view).toEqual({
      state: "connecting 1s",
      detail: "ice checking · sig stable · no route",
      hint: null,
    });
  });
});

test("debug lines list the mic, then each peer by name with its hint", () => {
  const lines = voiceDebugLines(
    {
      mic: { ...mic("granted", "live"), testing: true },
      peers: [peer({ state: "failed", ice: "failed", route: null })],
    },
    (id) => id.toUpperCase(),
    3000,
  );
  expect(lines).toEqual([
    "mic     live granted [#####.....] test",
    "        USB mic",
    "voice   THEM     failed 2s",
    "          ice failed · sig stable · no route",
    "          failed: strict network? needs a TURN server",
  ]);
});
