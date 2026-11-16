import type { Session } from "./session.js";

/**
 * How a world's day passes, on its world clock: from morning, at its start, to midnight. Every
 * client steps the world clock and takes the host's, so all see the same hour and the same light.
 */
export interface DayConfig {
  /** The hour of the day a new world starts at, on a 24-hour clock. */
  readonly startHour: number;
  /** Sim seconds from a world's start to midnight; the clock stops there. */
  readonly midnight: number;
  /** Sim seconds from a world's start to afternoon, when daylight starts to recede. */
  readonly afternoon: number;
  /** Sim seconds from a world's start to night, when no daylight is left. */
  readonly night: number;
  /** How loud the sounds marking afternoon and nightfall play, 0..1. */
  readonly volume: number;
}

/** Part of the day: daylight is whole in the morning, recedes through the afternoon, gone at night. */
export type DayPhase = "morning" | "afternoon" | "night";

/** The part of the day `time` sim seconds into a world falls in. */
export function dayPhase(config: DayConfig, time: number): DayPhase {
  if (time >= config.night) return "night";
  if (time >= config.afternoon) return "afternoon";
  return "morning";
}

/**
 * How much daylight is left `time` sim seconds into a world, 0..1: whole until afternoon,
 * receding evenly through it, none from night on.
 */
export function daylight(config: DayConfig, time: number): number {
  if (time < config.afternoon) return 1;
  const span = config.night - config.afternoon;
  if (span <= 0 || time >= config.night) return 0;
  return 1 - (time - config.afternoon) / span;
}

/** How much daylight `game`'s world has now, 0..1, by its world clock. */
export const daylightNow = (game: Session): number =>
  daylight(game.config.day, game.worldTime);

const MINUTES_A_DAY = 24 * 60;

/**
 * The time of day `time` sim seconds into a world, in whole minutes after its first midnight:
 * the start hour at the start, advancing evenly to midnight (24:00) and holding there.
 */
export function clockMinutes(config: DayConfig, time: number): number {
  const start = config.startHour * 60;
  const share =
    config.midnight <= 0 ? 1 : Math.min(1, Math.max(0, time / config.midnight));
  return Math.floor(start + (MINUTES_A_DAY - start) * share);
}

/** A time of day as a 12-hour clock shows it: "8:05" and "AM". */
export function clockFace(minutes: number): {
  readonly digits: string;
  readonly meridiem: "AM" | "PM";
} {
  const of =
    ((Math.floor(minutes) % MINUTES_A_DAY) + MINUTES_A_DAY) % MINUTES_A_DAY;
  const hour = Math.floor(of / 60);
  const minute = of % 60;
  return {
    digits: `${String(hour % 12 === 0 ? 12 : hour % 12)}:${String(minute).padStart(2, "0")}`,
    meridiem: hour < 12 ? "AM" : "PM",
  };
}

// The turn of the day, heard by everyone wherever they are: a long, low wind dropping as the
// afternoon comes on, and a far-off toll as night falls.
const turnUrls: Readonly<Record<Exclude<DayPhase, "morning">, string>> = {
  afternoon: new URL("./sfx/afternoon.mp3", import.meta.url).href,
  night: new URL("./sfx/nightfall.mp3", import.meta.url).href,
};

/** The world clock passing further than this in one step jumped, as to a host's clock on joining. */
const JUMP = 1;

/** The part of the day each session last heard it in, and when on its world clock. */
const heard = new WeakMap<Session, { phase: DayPhase; time: number }>();

/**
 * Plays the turn of the day as `game`'s world clock passes into afternoon or night. A clock
 * that jumps past a turn, as a late joiner's does when it takes the host's, plays nothing.
 */
export function hearDay(game: Session): void {
  const time = game.worldTime;
  const phase = dayPhase(game.config.day, time);
  const last = heard.get(game);
  heard.set(game, { phase, time });
  if (last === undefined || last.phase === phase || phase === "morning") return;
  if (Math.abs(time - last.time) > JUMP) return;
  void game.sfx.play(turnUrls[phase], null, null, {
    volume: game.config.day.volume,
  });
}
