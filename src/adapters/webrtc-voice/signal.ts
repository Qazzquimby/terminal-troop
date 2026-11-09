import { z } from "zod";

const PlayerId = z.string().min(1).max(64);

/** Names one RTCPeerConnection, so the other side can tell a new connection from an old one. */
const ConnId = z.string().min(1).max(64);

const SessionDescription = z.object({
  type: z.enum(["offer", "answer", "pranswer", "rollback"]),
  sdp: z.string().max(100_000),
});

const IceCandidate = z.object({
  candidate: z.string().max(4096),
  sdpMid: z.string().max(256).nullable(),
  sdpMLineIndex: z.number().int().min(0).nullable(),
});

/** `conn` is the sender's connection; a message without one comes from an unknown connection. */
const Addressed = { from: PlayerId, to: PlayerId, conn: ConnId.optional() };

/**
 * SIGNAL: one voice connection-setup step from one player to another. `ready` says the
 * sender opened connection `conn` and waits for an offer on it.
 */
const SignalMessage = z.union([
  z.object({ ...Addressed, description: SessionDescription }),
  z.object({ ...Addressed, candidate: IceCandidate }),
  z.object({ ...Addressed, conn: ConnId, ready: z.literal(true) }),
]);
export type SignalMessage = z.infer<typeof SignalMessage>;

/**
 * Signals are broadcast to the whole room. Returns the message only when it is valid and
 * addressed to `localId` by someone else.
 */
export function signalFor(
  payload: unknown,
  localId: string,
): SignalMessage | null {
  const parsed = SignalMessage.safeParse(payload);
  if (!parsed.success) return null;
  const { from, to } = parsed.data;
  return to === localId && from !== localId ? parsed.data : null;
}

/** Whether `message` opens a negotiation: an offer, or a ready asking for one. */
export function opensNegotiation(message: SignalMessage): boolean {
  if ("ready" in message) return true;
  return "description" in message && message.description.type === "offer";
}

/**
 * Whether two SDPs are the same description, sent again: their origin lines name the same
 * session and version. A copy sent later also lists the candidates gathered since, so the
 * rest of the text can differ.
 */
export function sameDescription(sdp: string, other: string): boolean {
  const origin = (text: string): string | undefined =>
    text.split(/\r?\n/).find((line) => line.startsWith("o="));
  const first = origin(sdp);
  return first !== undefined && first === origin(other);
}

/**
 * Which side of a pair yields when both start negotiating at once. Both players compute it
 * from the two ids, so exactly one of them is polite.
 */
export function isPolite(localId: string, remoteId: string): boolean {
  return localId < remoteId;
}
