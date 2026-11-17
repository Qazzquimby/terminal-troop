import { element } from "./dom.js";
import type { Settings, SettingsStore } from "../settings/index.js";
import type { MicDevice, VoiceDiagnostics } from "../voice/index.js";
import {
  deviceLabel,
  micNeedsRequest,
  micStatusText,
  peerVoiceView,
} from "./voice-diagnostics.js";

/** Another player in the room, as the voice section lists them. */
export interface MenuPeer {
  readonly id: string;
  readonly name: string;
  readonly muted: boolean;
  readonly away: boolean;
}

/** What the menu asks of the rest of the app. */
export interface SettingsMenuHandlers {
  /** Every open and close, with its time. */
  onOpenChange(open: boolean, time: number): void;
  /** A Mute checkbox the player ticked or cleared. */
  onPeerMutedChange(id: string, muted: boolean): void;
  /** Retry pressed on a player's voice connection. */
  onPeerRetry(id: string): void;
  /** Request mic access pressed. */
  onRequestMic(): void;
  /** Test mic turned on or off; it turns off when the menu closes. */
  onMicTest(on: boolean): void;
}

/**
 * The remote `players`, ordered by name, each marked muted if listed in `mutedIds` and away
 * if `isAway` says so.
 */
export function menuPeers(
  players: Iterable<{ readonly id: string; readonly name: string }>,
  mutedIds: readonly string[],
  isAway: (id: string) => boolean,
): MenuPeer[] {
  const muted = new Set(mutedIds);
  return [...players]
    .map(({ id, name }) => ({
      id,
      name,
      muted: muted.has(id),
      away: isAway(id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function peerLabel(peer: MenuPeer): string {
  return peer.away ? `${peer.name} (away)` : peer.name;
}

function span(className: string): HTMLSpanElement {
  const made = document.createElement("span");
  made.className = className;
  return made;
}

function peerRow(peer: MenuPeer): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "settings-peer";
  row.dataset.peerId = peer.id;
  const name = span("settings-peer-name");
  name.textContent = peerLabel(peer);
  const label = document.createElement("label");
  label.className = "settings-choice";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = peer.muted;
  label.append(checkbox, "Mute");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "settings-peer-retry";
  retry.textContent = "Retry";
  const state = span("settings-peer-state");
  const detail = span("settings-peer-detail");
  const hint = document.createElement("p");
  hint.className = "settings-peer-hint";
  hint.hidden = true;
  row.append(name, label, retry, state, detail, hint);
  return row;
}

/** The device picker's choices: the default, each listed device, and a saved one gone missing. */
function deviceOptions(
  devices: readonly MicDevice[],
  saved: string | null,
): HTMLOptionElement[] {
  const options = [new Option("Browser default", "")];
  for (const device of devices) {
    options.push(new Option(deviceLabel(devices, device.id), device.id));
  }
  if (saved !== null && !devices.some((device) => device.id === saved)) {
    options.push(new Option("Saved device (not found)", saved));
  }
  return options;
}

/**
 * Binds the `#settings` dialog to `store`: controls show the stored settings and edits update it.
 * Opens as a modal; `toggle` and the close button close it. The voice section lists the peers
 * given to `setPeers`, and `showVoice` keeps the mic and each peer's connection up to date.
 */
export function createSettingsMenu(
  dialog: HTMLDialogElement,
  store: SettingsStore,
  handlers: SettingsMenuHandlers,
) {
  const control = (id: string) => element(`#${id}`, HTMLInputElement, dialog);
  const openMic = control("voice-mode-open");
  const pushToTalk = control("voice-mode-ptt");
  const muted = control("voice-muted");
  const voiceVolume = control("voice-volume");
  const masterVolume = control("master-volume");
  const micTest = control("mic-test");
  const input = element("#voice-input", HTMLSelectElement, dialog);
  const micStatus = element("#mic-status", HTMLParagraphElement, dialog);
  const micRequest = element("#mic-request", HTMLButtonElement, dialog);
  const micLevel = element("#mic-level", HTMLMeterElement, dialog);
  const peerList = element("#voice-peers", HTMLUListElement, dialog);
  const emptyPeers = element(
    "#voice-peers-empty",
    HTMLParagraphElement,
    dialog,
  );
  /** The device list the picker was last built from. */
  let listed = "";

  function showDevices(devices: readonly MicDevice[]): void {
    const saved = store.get().voice.inputDevice;
    const key = JSON.stringify([devices, saved]);
    if (key === listed) return;
    listed = key;
    input.replaceChildren(...deviceOptions(devices, saved));
    input.value = saved ?? "";
  }

  function render(settings: Settings): void {
    openMic.checked = settings.voice.mode === "open";
    pushToTalk.checked = settings.voice.mode === "pushToTalk";
    muted.checked = settings.voice.muted;
    voiceVolume.valueAsNumber = settings.voice.volume;
    masterVolume.valueAsNumber = settings.audio.masterVolume;
    input.value = settings.voice.inputDevice ?? "";
  }

  dialog.addEventListener("input", (event) => {
    if (event.target === micTest) {
      handlers.onMicTest(micTest.checked);
      return;
    }
    store.update({
      voice: {
        mode: pushToTalk.checked ? "pushToTalk" : "open",
        muted: muted.checked,
        volume: voiceVolume.valueAsNumber,
        inputDevice: input.value === "" ? null : input.value,
      },
      audio: { masterVolume: masterVolume.valueAsNumber },
    });
  });

  micRequest.addEventListener("click", () => {
    handlers.onRequestMic();
  });

  peerList.addEventListener("input", (event) => {
    event.stopPropagation();
    const { target } = event;
    if (!(target instanceof HTMLInputElement)) return;
    const row = target.closest("li");
    const id = row?.dataset.peerId;
    if (id !== undefined) handlers.onPeerMutedChange(id, target.checked);
  });

  peerList.addEventListener("click", (event) => {
    const { target } = event;
    if (!(target instanceof HTMLButtonElement)) return;
    const id = target.closest("li")?.dataset.peerId;
    if (id !== undefined) handlers.onPeerRetry(id);
  });

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
  });

  dialog.addEventListener("close", (event) => {
    if (micTest.checked) {
      micTest.checked = false;
      handlers.onMicTest(false);
    }
    handlers.onOpenChange(false, event.timeStamp);
  });

  render(store.get());
  store.subscribe(render);

  function open(time: number): void {
    if (dialog.open) return;
    dialog.showModal();
    handlers.onOpenChange(true, time);
    (pushToTalk.checked ? pushToTalk : openMic).focus();
  }

  return {
    open,
    toggle(time: number): void {
      if (dialog.open) dialog.close();
      else open(time);
    },
    /** Lists `peers` in order, leaving a focused control in place when the same peers stay listed. */
    setPeers(peers: readonly MenuPeer[]): void {
      emptyPeers.hidden = peers.length > 0;
      const rows = [...peerList.children];
      const sameRows =
        rows.length === peers.length &&
        rows.every(
          (row, index) =>
            row instanceof HTMLElement &&
            row.dataset.peerId === peers[index]?.id,
        );
      if (!sameRows) {
        peerList.replaceChildren(...peers.map(peerRow));
        return;
      }
      rows.forEach((row, index) => {
        const peer = peers[index];
        if (peer === undefined) return;
        element(".settings-peer-name", HTMLSpanElement, row).textContent =
          peerLabel(peer);
        element("input", HTMLInputElement, row).checked = peer.muted;
      });
    },
    /** Shows the mic and each listed peer's connection as of `now`; `read` runs only while open. */
    showVoice(now: number, read: () => VoiceDiagnostics): void {
      if (!dialog.open) return;
      const voice = read();
      const { mic } = voice;
      micStatus.textContent = micStatusText(mic);
      micStatus.dataset.permission = mic.permission;
      micRequest.hidden = !micNeedsRequest(mic);
      micLevel.value = mic.level;
      micTest.checked = mic.testing;
      showDevices(mic.devices);
      const byId = new Map(voice.peers.map((peer) => [peer.id, peer]));
      for (const row of peerList.children) {
        if (!(row instanceof HTMLElement)) continue;
        const peer = byId.get(row.dataset.peerId ?? "");
        const view = peer === undefined ? null : peerVoiceView(peer, now);
        element(".settings-peer-state", HTMLSpanElement, row).textContent =
          view?.state ?? "no voice connection";
        element(".settings-peer-detail", HTMLSpanElement, row).textContent =
          view?.detail ?? "";
        const hint = element(".settings-peer-hint", HTMLParagraphElement, row);
        hint.hidden = (view?.hint ?? null) === null;
        hint.textContent = view?.hint ?? "";
      }
    },
  };
}
