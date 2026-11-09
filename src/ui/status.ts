import type { RoomState } from "../room/index.js";

/** The status line for `state`, naming the transport by `transportLabel` once joined. */
export function statusText(state: RoomState, transportLabel: string): string {
  switch (state.kind) {
    case "lobby":
      return state.error ?? "Create or join a room to start.";
    case "connecting":
      return "Connecting…";
    case "joined": {
      const count = state.session.players.size;
      return `Room ${state.code} (${transportLabel}) · ${String(count)} player${count === 1 ? "" : "s"}`;
    }
  }
}

interface StatusElements {
  readonly status: HTMLElement;
  readonly create: HTMLButtonElement;
  readonly join: HTMLButtonElement;
  readonly copy: HTMLButtonElement;
}

/**
 * The status line and the room buttons. A notice replaces the status line until the room
 * state changes from the one it was given with.
 */
export function createStatusView(elements: StatusElements) {
  let notice: { text: string; state: RoomState } | null = null;

  return {
    notice(text: string, state: RoomState): void {
      notice = { text, state };
    },
    show(state: RoomState, transportLabel: string): void {
      if (notice !== null && notice.state !== state) notice = null;
      elements.status.textContent =
        notice?.text ?? statusText(state, transportLabel);
      elements.create.disabled = state.kind === "connecting";
      elements.join.disabled = state.kind === "connecting";
      elements.copy.hidden = state.kind !== "joined";
    },
  };
}
