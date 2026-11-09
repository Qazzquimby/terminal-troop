import type { WorldKind } from "../sim/index.js";

const ROOM_CODE = /^[A-Z0-9]{3,8}$/;

/** What the lobby shows for a code that does not parse. */
export const INVALID_ROOM_CODE = "Room code must be 3–8 letters/numbers.";

/** A room code as typed, trimmed and upper-cased; null unless it is 3–8 letters or digits. */
export function parseRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return ROOM_CODE.test(code) ? code : null;
}

/** A fresh room code with one letter or digit per byte of `bytes`. */
export function randomRoomCode(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => (value % 36).toString(36))
    .join("")
    .toUpperCase();
}

/**
 * The channel a room's players meet on. The world kind is part of it, so clients running
 * different worlds land in separate rooms rather than on mismatched maps.
 */
export function roomKey(code: string, kind: WorldKind): string {
  return kind === "standard" ? code : `${kind}:${code}`;
}

/** The name a player goes by: `raw` trimmed and cut to `nameMax`, or `fallback` when empty. */
export function playerName(
  raw: string,
  nameMax: number,
  fallback: string,
): string {
  const name = raw.trim().slice(0, nameMax);
  return name === "" ? fallback : name;
}
