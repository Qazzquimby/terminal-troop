import { z } from "zod";
import { PLAYER_NAME_MAX } from "./config.js";

const PlayerId = z.string().min(1).max(64);

// z.number() rejects NaN and ±Infinity.
export const StateMessage = z.object({
  id: PlayerId,
  name: z.string().transform((name) => name.slice(0, PLAYER_NAME_MAX)),
  x: z.number(),
  y: z.number(),
  aim: z.number(),
});

/** HELLO and BYE carry only the sender's id. */
export const PresenceMessage = z.object({ id: PlayerId });

const SessionDescription = z.object({
  type: z.enum(["offer", "answer", "pranswer", "rollback"]),
  sdp: z.string().max(100_000),
});

const IceCandidate = z.object({
  candidate: z.string().max(4096),
  sdpMid: z.string().max(256).nullable(),
  sdpMLineIndex: z.number().int().min(0).nullable(),
});

const Addressed = { from: PlayerId, to: PlayerId };

/** SIGNAL: one voice connection-setup step from one player to another. */
const SignalMessage = z.union([
  z.object({ ...Addressed, description: SessionDescription }),
  z.object({ ...Addressed, candidate: IceCandidate }),
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
