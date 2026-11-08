import { element } from "./dom.js";
import type { Settings, SettingsStore } from "./engine/settings.js";

/**
 * Binds the `#settings` dialog to `store`: controls show the stored settings and edits update it.
 * Opens as a modal; Escape and the close button close it.
 */
export function createSettingsMenu(
  dialog: HTMLDialogElement,
  store: SettingsStore,
) {
  const control = (id: string) => element(`#${id}`, HTMLInputElement, dialog);
  const openMic = control("voice-mode-open");
  const pushToTalk = control("voice-mode-ptt");
  const muted = control("voice-muted");
  const voiceVolume = control("voice-volume");
  const masterVolume = control("master-volume");

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

  // The game's key handler skips focused inputs, so the dialog closes itself on Escape.
  dialog.addEventListener("keydown", (event) => {
    if (event.code !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
  });

  // A control left focused in the closed dialog would count as typing and swallow game keys.
  dialog.addEventListener("close", () => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && dialog.contains(focused))
      focused.blur();
  });

  render(store.get());
  store.subscribe(render);

  function open(): void {
    if (dialog.open) return;
    dialog.showModal();
    (pushToTalk.checked ? pushToTalk : openMic).focus();
  }

  return {
    isOpen: (): boolean => dialog.open,
    open,
    toggle(): void {
      if (dialog.open) dialog.close();
      else open();
    },
  };
}
