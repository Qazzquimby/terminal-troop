import { z } from "zod";
import { emitNoise } from "./noise.js";
import { playerData } from "./player-data.js";
import type { Session } from "./session.js";

/** How far a player's speech carries, from how loud it goes out. */
export interface VoiceNoiseConfig {
  /** Seconds the loudest level is held for: speech is judged by its peak over this window. */
  readonly window: number;
  /** Level, 0..1, below which speech makes no noise. */
  readonly threshold: number;
  /** Level, 0..1, from which speech carries as far as it can. */
  readonly full: number;
  /** How far speech carries, in pixels: just above the threshold, and at full. */
  readonly radius: { readonly quiet: number; readonly loud: number };
  /** Radii are rounded to a multiple of this, in pixels, so a player reports a new one only now and then. */
  readonly step: number;
  /** Seconds between noises while a player's speech carries. */
  readonly interval: number;
}

/** A level the local player spoke at, and when, in sim seconds. */
export interface SpokenLevel {
  readonly at: number;
  readonly level: number;
}

/**
 * How far each player's speech carries, in pixels; 0 while it makes no noise. A player
 * reports its own, so a client could claim to be quieter than it is.
 */
export const voiceNoise = playerData<number>({
  schema: z.number().min(0),
  initial: () => 0,
});

/** How far speech at `level` (0..1) carries, in pixels: 0 below the threshold. */
export function voiceRadius(level: number, config: VoiceNoiseConfig): number {
  if (level < config.threshold) return 0;
  const t = Math.min(
    1,
    (level - config.threshold) / (config.full - config.threshold),
  );
  const { quiet, loud } = config.radius;
  return Math.round((quiet + (loud - quiet) * t) / config.step) * config.step;
}

/**
 * Records the level (0..1) the local player's mic goes out at now, and sets how far its speech
 * carries from the loudest level within the window.
 */
export function speak(game: Session, level: number): void {
  const config = game.config.voiceNoise;
  const spoken = game.spoken;
  while ((spoken.at(-1)?.level ?? Infinity) <= level) spoken.pop();
  spoken.push({ at: game.time, level });
  while ((spoken[0]?.at ?? game.time) <= game.time - config.window)
    spoken.shift();
  voiceNoise.set(game.local, voiceRadius(spoken[0]?.level ?? 0, config));
}

/**
 * Makes each speaking player's noise for a step of `dt`: one as its speech starts to carry,
 * then one each interval, as far as its speech carries now.
 */
export function emitVoices(game: Session, dt: number): void {
  for (const player of game.players.values()) {
    const radius = voiceNoise.get(player);
    if (radius === 0) {
      player.voiceGap = 0;
      continue;
    }
    player.voiceGap -= dt;
    if (player.voiceGap > 0) continue;
    player.voiceGap = game.config.voiceNoise.interval;
    emitNoise(game, {
      at: { x: player.x, y: player.y },
      radius,
      source: player.id,
    });
  }
}
