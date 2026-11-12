import type {
  MicDevice,
  PeerDiagnostics,
  VoiceDiagnostics,
} from "../voice/index.js";

type MicReport = VoiceDiagnostics["mic"];

/** Shown for a connection that failed: without a relay, strict networks never connect. */
export const TURN_HINT =
  "Couldn't connect. One of you may be behind a strict network (NAT or firewall); that needs a TURN relay server, which this game doesn't have yet.";

/** A device's label, or a numbered stand-in while the browser hides labels. */
export function deviceLabel(
  devices: readonly MicDevice[],
  id: string | null,
): string {
  if (id === null) return "none";
  const index = devices.findIndex((device) => device.id === id);
  const device = devices[index];
  if (device === undefined) return "browser default";
  return device.label === "" ? `Microphone ${String(index + 1)}` : device.label;
}

/** What the mic is doing and, when it isn't working, what the player can do about it. */
export function micStatusText(mic: MicReport): string {
  switch (mic.permission) {
    case "unavailable":
      return "This browser offers no microphone here. Voice needs a secure page (https) in a browser with microphone support.";
    case "denied":
      return "Microphone blocked. Click the lock or microphone icon in the address bar, allow the microphone for this site, then press Request mic access again.";
    case "prompt":
      return mic.state === "pending"
        ? "Mic not asked for yet. Turn on Test mic or join a room, and allow the microphone when the browser asks."
        : "No microphone yet. Press Request mic access again and allow it when the browser asks.";
    case "granted":
      break;
  }
  switch (mic.state) {
    case "live":
      return `Microphone on: ${deviceLabel(mic.devices, mic.device)}.`;
    case "unavailable":
      return "No microphone found. Plug one in or pick another, then press Request mic access again.";
    case "pending":
    case "denied":
      return "Microphone allowed. Turn on Test mic or join a room to start it.";
  }
}

/** Whether the mic needs the player to ask for it again. */
export function micNeedsRequest(mic: MicReport): boolean {
  return mic.state === "denied" || mic.state === "unavailable";
}

const seconds = (ms: number): string =>
  `${String(Math.max(0, Math.floor(ms / 1000)))}s`;

/** Whether a peer's connection has given up, so the TURN hint applies. */
function failing(peer: PeerDiagnostics): boolean {
  if (peer.state === "failed" || peer.state === "closed") return true;
  return peer.failures > 0 && peer.state !== "connected";
}

/** A peer without a connection is waiting to retry after a failure, or about to start. */
function stateLabel(peer: PeerDiagnostics): string {
  if (peer.state !== "pending") return peer.state;
  return peer.failures > 0 ? "waiting to retry" : "starting";
}

interface PeerVoiceView {
  /** The connection state and how long it has held, e.g. "connected 12s". */
  readonly state: string;
  /** ICE and signaling states, route, and incoming audio. */
  readonly detail: string;
  readonly hint: string | null;
}

/** How one peer's voice connection reads at `now`. */
export function peerVoiceView(
  peer: PeerDiagnostics,
  now: number,
): PeerVoiceView {
  const route =
    peer.route === null
      ? "no route"
      : `${peer.route.local}/${peer.route.remote}`;
  const audio =
    peer.state !== "connected"
      ? null
      : peer.receiving
        ? "audio in"
        : "no audio in";
  const failures = peer.failures > 0 ? `${String(peer.failures)} failed` : null;
  return {
    state: `${stateLabel(peer)} ${seconds(now - peer.since)}`,
    detail: [
      peer.ice === null ? null : `ice ${peer.ice}`,
      peer.signaling === null ? null : `sig ${peer.signaling}`,
      route,
      audio,
      failures,
    ]
      .filter((part) => part !== null)
      .join(" · "),
    hint: failing(peer) ? TURN_HINT : null,
  };
}

/** A text meter, `width` cells wide, for a level 0..1. */
function bar(level: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, level)) * width);
  return "#".repeat(filled) + ".".repeat(width - filled);
}

/** The debug overlay's voice lines: the mic, then each peer by name. */
export function voiceDebugLines(
  voice: VoiceDiagnostics,
  nameOf: (id: string) => string,
  now: number,
): string[] {
  const { mic } = voice;
  const lines = [
    `mic     ${mic.state} ${mic.permission} [${bar(mic.level, 10)}]${mic.testing ? " test" : ""}`,
    `        ${deviceLabel(mic.devices, mic.device)}`,
  ];
  for (const peer of voice.peers) {
    const view = peerVoiceView(peer, now);
    lines.push(
      `voice   ${nameOf(peer.id).padEnd(8)} ${view.state}`,
      `          ${view.detail}`,
    );
    if (view.hint !== null)
      lines.push("          failed: strict network? needs a TURN server");
  }
  return lines;
}
