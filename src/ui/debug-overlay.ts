import type { MessageRates } from "../net/index.js";
import type { PerfSnapshot } from "../perf-stats/index.js";
import { remotePlayers } from "../sim/index.js";
import type { Session } from "../sim/index.js";

const REFRESH_MS = 250;

interface RoomDebugInfo {
  readonly net: MessageRates;
  readonly playerCount: number;
  /** Remote players and the age of their last state update. */
  readonly remotes: readonly { name: string; ageMs: number }[];
}

/** The room part of the overlay for `session` at `now`, given the current message rates. */
export function roomDebugInfo(
  session: Session,
  now: number,
  rates: MessageRates,
): RoomDebugInfo {
  return {
    net: rates,
    playerCount: session.players.size,
    remotes: remotePlayers(session).map((player) => ({
      name: player.name,
      ageMs: now - player.lastSeen,
    })),
  };
}

export interface DebugInfo {
  readonly perf: PerfSnapshot;
  /** Null outside a room. */
  readonly room: RoomDebugInfo | null;
}

const ms = (value: number): string => value.toFixed(1);
const percent = (share: number): string => `${(share * 100).toFixed(0)}%`;

function formatDebug({ perf, room }: DebugInfo): string {
  const lines = [
    `fps     ${perf.fps.toFixed(0)}`,
    `frame   avg ${ms(perf.frameMsAvg)}  max ${ms(perf.frameMsMax)} ms`,
    `draw    avg ${ms(perf.drawMsAvg)} ms`,
  ];
  if (room === null) return lines.join("\n");

  lines.push(
    `steps   avg ${perf.stepsAvg.toFixed(2)}  0: ${percent(perf.zeroStepShare)}  2+: ${percent(perf.multiStepShare)}`,
    `update  avg ${ms(perf.updateMsAvg)} ms`,
    `net     sent ${String(room.net.sentPerS)}/s  recv ${String(room.net.receivedPerS)}/s`,
    `players ${String(room.playerCount)}`,
    ...room.remotes.map(
      (remote) => `  ${remote.name.padEnd(8)} ${remote.ageMs.toFixed(0)} ms`,
    ),
  );
  return lines.join("\n");
}

/** A text overlay that refreshes a few times a second, and only while visible. */
export function createDebugOverlay(element: HTMLElement, open: boolean) {
  let visible = open;
  let lastRefresh = -Infinity;
  element.hidden = !visible;

  return {
    toggle(): void {
      visible = !visible;
      element.hidden = !visible;
      lastRefresh = -Infinity;
    },
    /** `read` runs only when the text is due for a refresh. */
    update(now: number, read: () => DebugInfo): void {
      if (!visible || now - lastRefresh < REFRESH_MS) return;
      lastRefresh = now;
      element.textContent = formatDebug(read());
    },
  };
}
