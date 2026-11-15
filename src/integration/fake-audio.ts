import { vi } from "vitest";

/** A sound a fake AudioContext is playing: its url, and how loud it goes out now. */
export interface FakeSound {
  readonly url: string;
  /** The gain it goes out at now, 0..1. */
  volume: () => number;
  /** Whether it is still playing. */
  playing: () => boolean;
  /** Ends it, as when it plays to its end. */
  end: () => void;
}

class FakeParam {
  value = 1;
  cancelScheduledValues(): void {
    // Nothing is scheduled ahead: each change takes at once.
  }
  setValueAtTime(value: number): void {
    this.value = value;
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
}

class FakeNode {
  connect(): void {
    // Where a node leads matters to nothing these fakes report.
  }
  disconnect(): void {
    // As above.
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakePanner extends FakeNode {
  readonly pan = new FakeParam();
}

/**
 * Stubs `fetch` and `AudioContext` so that every sound the real sfx plays decodes and plays at
 * once, whatever its url, and can be read back: its url and the gain it goes out at. Undo with
 * `vi.unstubAllGlobals()`.
 */
export function stubAudio(): { readonly sounds: () => readonly FakeSound[] } {
  const sounds: FakeSound[] = [];

  class FakeSource extends FakeNode {
    buffer: { readonly url: string } | null = null;
    loop = false;
    onended: (() => void) | null = null;
    private out: FakeGain | null = null;
    private ended = false;
    override connect(node?: unknown): void {
      if (node instanceof FakeGain) this.out = node;
    }
    start(): void {
      const { buffer, out } = this;
      if (buffer === null || out === null) return;
      sounds.push({
        url: buffer.url,
        volume: () => out.gain.value,
        playing: () => !this.ended,
        end: () => {
          this.stop();
        },
      });
    }
    stop(): void {
      if (this.ended) return;
      this.ended = true;
      this.onended?.();
    }
  }

  vi.stubGlobal("fetch", (url: string) =>
    Promise.resolve(new Response(url, { status: 200 })),
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      readonly currentTime = 0;
      readonly destination = new FakeNode();
      createGain(): FakeGain {
        return new FakeGain();
      }
      createStereoPanner(): FakePanner {
        return new FakePanner();
      }
      createBufferSource(): FakeSource {
        return new FakeSource();
      }
      decodeAudioData(data: ArrayBuffer): Promise<{ readonly url: string }> {
        return Promise.resolve({ url: new TextDecoder().decode(data) });
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
    },
  );
  return { sounds: () => sounds };
}

/** Lets every sound asked for so far load and start. */
export async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
