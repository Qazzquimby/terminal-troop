import { mapValues } from "lodash-es";
import { createRollingWindow } from "./perf-stats.js";
import type { Transport } from "./transport.js";

export interface MessageRates {
  readonly sentPerS: number;
  readonly receivedPerS: number;
}

/**
 * Wraps a transport and counts messages sent and received over the last second. Everything
 * passes through unchanged. `clock` returns ms on the same timeline as `rates(now)`.
 */
export function createCountingTransport(
  inner: Transport,
  clock: () => number,
): { transport: Transport; rates: (now: number) => MessageRates } {
  const sent = createRollingWindow<null>();
  const received = createRollingWindow<null>();

  return {
    transport: {
      label: inner.label,
      join: (room, handlers) =>
        inner.join(
          room,
          mapValues(handlers, (handler) => (payload: unknown) => {
            received.push(clock(), null);
            handler?.(payload);
          }),
        ),
      leave: () => inner.leave(),
      send: (event, payload) => {
        sent.push(clock(), null);
        return inner.send(event, payload);
      },
    },
    rates: (now) => ({
      sentPerS: sent.values(now).length,
      receivedPerS: received.values(now).length,
    }),
  };
}
