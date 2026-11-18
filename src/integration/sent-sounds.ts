import { z } from "zod";
import { declaredSound } from "../sim/index.js";

const Sent = z.object({
  effects: z.array(z.object({ sound: z.string().optional() })),
});

/**
 * The sounds a sent payload of effects carries, by the last part of their urls; none for a
 * payload of anything else.
 */
export function sentSounds(payload: unknown): string[] {
  const parsed = Sent.safeParse(payload);
  if (!parsed.success) return [];
  return parsed.data.effects.flatMap(({ sound }) => {
    if (sound === undefined) return [];
    const url = declaredSound(sound)?.url ?? sound;
    return [url.split("/").at(-1) ?? url];
  });
}
