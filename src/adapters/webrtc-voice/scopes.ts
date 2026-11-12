import type { Scope } from "../../lib/scope/index.js";

/** Runs `fn` after `ms` unless `scope` is disposed first. */
export function later(scope: Scope, ms: number, fn: () => void): () => void {
  const stop = (): void => {
    clearTimeout(timer);
    scope.signal.removeEventListener("abort", stop);
  };
  const timer = setTimeout(() => {
    stop();
    fn();
  }, ms);
  scope.signal.addEventListener("abort", stop);
  return stop;
}

export function disposeQuietly(scope: Scope): void {
  scope.dispose().catch((error: unknown) => {
    console.warn("Voice cleanup failed", error);
  });
}
