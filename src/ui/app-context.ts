import type { InputContext } from "./engine/actions.js";

/** The contexts the app itself is in; `text` is layered on top while a text field has focus. */
type AppContext = Exclude<InputContext, "text">;

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);

function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement)
    return TEXT_INPUT_TYPES.has(target.type);
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * Owns which context input is in: the app's own context (`play` or `menu`), switched to
 * `text` while focus is in a text field and back when focus leaves it.
 */
export function trackInputContext(
  initial: AppContext,
  setContext: (context: InputContext, time: number) => void,
): { set: (context: AppContext, time: number) => void } {
  let app = initial;
  let typing = isTextField(document.activeElement);
  const apply = (time: number): void => {
    setContext(typing ? "text" : app, time);
  };

  document.addEventListener("focusin", (event) => {
    typing = isTextField(event.target);
    apply(event.timeStamp);
  });
  // Focus moving straight to another text field stays in `text`.
  document.addEventListener("focusout", (event) => {
    typing = isTextField(event.relatedTarget);
    apply(event.timeStamp);
  });
  apply(performance.now());

  return {
    set(context, time) {
      app = context;
      apply(time);
    },
  };
}
