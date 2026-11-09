import { element } from "./dom.js";
import type { Settings, SettingsStore } from "../settings/index.js";

/** Another player in the room, as the voice section lists them. */
export interface MenuPeer {
  readonly id: string;
  readonly name: string;
  readonly muted: boolean;
}

/** Everyone in `players` except `localId`, ordered by name, each marked muted if listed in `mutedIds`. */
export function menuPeers(
  players: Iterable<{ readonly id: string; readonly name: string }>,
  localId: string,
  mutedIds: readonly string[],
): MenuPeer[] {
  const muted = new Set(mutedIds);
  return [...players]
    .filter(({ id }) => id !== localId)
    .map(({ id, name }) => ({ id, name, muted: muted.has(id) }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function peerRow(peer: MenuPeer): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "settings-peer";
  row.dataset.peerId = peer.id;
  const name = document.createElement("span");
  name.className = "settings-peer-name";
  name.textContent = peer.name;
  const label = document.createElement("label");
  label.className = "settings-choice";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = peer.muted;
  label.append(checkbox, "Mute");
  row.append(name, label);
  return row;
}

/**
 * Binds the `#settings` dialog to `store`: controls show the stored settings and edits update it.
 * Opens as a modal; `toggle` and the close button close it. `onOpenChange` hears every open and
 * close, with its time. The voice section lists the peers given to `setPeers`, and
 * `onPeerMutedChange` hears each Mute checkbox the player ticks or clears.
 */
export function createSettingsMenu(
  dialog: HTMLDialogElement,
  store: SettingsStore,
  onOpenChange: (open: boolean, time: number) => void,
  onPeerMutedChange: (id: string, muted: boolean) => void,
) {
  const control = (id: string) => element(`#${id}`, HTMLInputElement, dialog);
  const openMic = control("voice-mode-open");
  const pushToTalk = control("voice-mode-ptt");
  const muted = control("voice-muted");
  const voiceVolume = control("voice-volume");
  const masterVolume = control("master-volume");
  const peerList = element("#voice-peers", HTMLUListElement, dialog);
  const emptyPeers = element(
    "#voice-peers-empty",
    HTMLParagraphElement,
    dialog,
  );

  function render(settings: Settings): void {
    openMic.checked = settings.voice.mode === "open";
    pushToTalk.checked = settings.voice.mode === "pushToTalk";
    muted.checked = settings.voice.muted;
    voiceVolume.valueAsNumber = settings.voice.volume;
    masterVolume.valueAsNumber = settings.audio.masterVolume;
  }

  dialog.addEventListener("input", () => {
    store.update({
      voice: {
        mode: pushToTalk.checked ? "pushToTalk" : "open",
        muted: muted.checked,
        volume: voiceVolume.valueAsNumber,
      },
      audio: { masterVolume: masterVolume.valueAsNumber },
    });
  });

  peerList.addEventListener("input", (event) => {
    event.stopPropagation();
    const { target } = event;
    if (!(target instanceof HTMLInputElement)) return;
    const row = target.closest("li");
    const id = row?.dataset.peerId;
    if (id !== undefined) onPeerMutedChange(id, target.checked);
  });

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
  });

  dialog.addEventListener("close", (event) => {
    onOpenChange(false, event.timeStamp);
  });

  render(store.get());
  store.subscribe(render);

  function open(time: number): void {
    if (dialog.open) return;
    dialog.showModal();
    onOpenChange(true, time);
    (pushToTalk.checked ? pushToTalk : openMic).focus();
  }

  return {
    open,
    toggle(time: number): void {
      if (dialog.open) dialog.close();
      else open(time);
    },
    /** Lists `peers` in order, leaving a focused checkbox in place when the same peers stay listed. */
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
          peer.name;
        element("input", HTMLInputElement, row).checked = peer.muted;
      });
    },
  };
}
