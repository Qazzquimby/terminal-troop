import { element } from "./dom.js";
import type { Settings, SettingsStore } from "./engine/settings.js";

/**
 * Binds the `#settings` dialog to `store`: controls show the stored settings and edits update it.
 * Opens as a modal; `toggle` and the close button close it. `onOpenChange` hears every open and
 * close, with its time.
 */
export function createSettingsMenu(
  dialog: HTMLDialogElement,
  store: SettingsStore,
  onOpenChange: (open: boolean, time: number) => void,
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

  // Escape closes the dialog through its action, so the native cancel is suppressed to keep one press = one toggle.
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
  };
}
