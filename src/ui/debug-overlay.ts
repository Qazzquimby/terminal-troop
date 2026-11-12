import type { MessageRates } from "../net/index.js";
import type { PerfSnapshot } from "../perf-stats/index.js";
import { remotePlayers } from "../sim/index.js";
import type { Session } from "../sim/index.js";

/** UI tuning. */
export interface UiConfig {
  /** Least time between debug overlay refreshes, in ms. */
  readonly debugRefreshMs: number;
}

/** A remote player's presence kind and when it was last heard from. */
interface RemotePresence {
  readonly kind: string;
  readonly lastHeard: number;
}

/** What the overlay reads from the room. */
interface RoomView {
  /** Undefined for a remote player who is gone. */
  presenceOf(id: string): RemotePresence | undefined;
  hostId(): string | undefined;
}

interface RoomDebugInfo {
  readonly net: MessageRates;
  readonly playerCount: number;
  /** The host's name, "you" for the local player, its id when its name is unknown, or "none". */
  readonly host: string;
  /** Remote players, their presence, and the age of the last message from each. */
  readonly remotes: readonly {
    name: string;
    presence: string;
    ageMs: number;
  }[];
}

/**
 * The room part of the overlay for `session` at `now`, given the current message rates and
 * the room; a player without a presence shows as gone.
 */
export function roomDebugInfo(
  session: Session,
  now: number,
  rates: MessageRates,
  room: RoomView,
): RoomDebugInfo {
  const hostId = room.hostId();
  return {
    net: rates,
    playerCount: session.players.size,
    host:
      hostId === undefined
        ? "none"
        : hostId === session.localId
          ? "you"
          : (session.players.get(hostId)?.name ?? hostId),
    remotes: remotePlayers(session).map((player) => {
      const presence = room.presenceOf(player.id);
      return {
        name: player.name,
        presence: presence?.kind ?? "gone",
        ageMs: now - (presence?.lastHeard ?? now),
      };
    }),
  };
}

export interface DebugInfo {
  readonly perf: PerfSnapshot;
  /** Null outside a room. */
  readonly room: RoomDebugInfo | null;
  /** The mic and each voice connection, one line or more each. */
  readonly voice: readonly string[];
}

const ms = (value: number): string => value.toFixed(1);
const percent = (share: number): string => `${(share * 100).toFixed(0)}%`;

function formatDebug({ perf, room, voice }: DebugInfo): string {
  const lines = [
    `fps     ${perf.fps.toFixed(0)}`,
    `frame   avg ${ms(perf.frameMsAvg)}  max ${ms(perf.frameMsMax)} ms`,
    `draw    avg ${ms(perf.drawMsAvg)} ms`,
  ];
  if (room === null) return [...lines, ...voice].join("\n");

  lines.push(
    `steps   avg ${perf.stepsAvg.toFixed(2)}  0: ${percent(perf.zeroStepShare)}  2+: ${percent(perf.multiStepShare)}`,
    `update  avg ${ms(perf.updateMsAvg)} ms`,
    `net     sent ${String(room.net.sentPerS)}/s  recv ${String(room.net.receivedPerS)}/s`,
    `host    ${room.host}`,
    `players ${String(room.playerCount)}`,
    ...room.remotes.map(
      (remote) =>
        `  ${remote.name.padEnd(8)} ${remote.presence.padEnd(7)} ${remote.ageMs.toFixed(0)} ms`,
    ),
    ...voice,
  );
  return lines.join("\n");
}

/** A text overlay that refreshes at most once per `debugRefreshMs`, and only while visible. */
export function createDebugOverlay(
  element: HTMLElement,
  open: boolean,
  config: UiConfig,
) {
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
      if (!visible || now - lastRefresh < config.debugRefreshMs) return;
      lastRefresh = now;
      element.textContent = formatDebug(read());
    },
  };
}
