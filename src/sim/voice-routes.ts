import { z } from "zod";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import { playerData } from "./player-data.js";
import type { Session } from "./session.js";

/**
 * How a voice sounds where it is heard:
 * - air: as spoken, from where the speaker stands or wherever a route puts it
 * - radio: through a small speaker, a walkie talkie's say
 */
export type VoiceVia = "air" | "radio";

/** One way a speaker's voice reaches a listener: where it is heard from, and how it sounds. */
export interface VoiceRoute {
  /** Where it seems to come from; null for no place, heard at full volume dead centre. */
  readonly at: Point | null;
  readonly via: VoiceVia;
  /**
   * Where the voice went into whatever carried it here, for a route that carries it from one
   * place to another: the walkie talkie it was said into, say. Left out for one that does not.
   */
  readonly from?: Point;
}

/**
 * A way voice travels past the air between two players, which content adds to a session: a
 * walkie talkie carrying a speaker's voice to every walkie switched on, say, or ghosts hearing
 * each other wherever they are. Runs on every client, for its local player as the listener.
 */
export interface VoiceChannel {
  /** The routes it adds from `speaker` to `listener`; none when it does not carry them. */
  routes(game: Session, speaker: Player, listener: Player): VoiceRoute[];
  /**
   * Whether it keeps `listener` from hearing `speaker` at all, by any route: a living player not
   * hearing a ghost, say. Never when left out.
   */
  silences?(game: Session, speaker: Player, listener: Player): boolean;
  /**
   * Whether `listener` cannot hear `speaker` where it stands, though other routes may still carry
   * it: a ghost, heard by the living only through what hears ghosts. Never when left out.
   */
  hides?(game: Session, speaker: Player, listener: Player): boolean;
}

/**
 * Whether each player is on the air: pressing to talk into something that sends its voice past
 * the air, such as a walkie talkie it holds. The player reports its own, and its mic goes out
 * while it is set, whatever its voice settings. What it is on the air through is the channel's
 * to say.
 */
export const onAir = playerData<boolean>({
  schema: z.boolean(),
  initial: () => false,
});

/** The channels voice travels through in each session, past the air. */
const channels = new WeakMap<Session, VoiceChannel[]>();

/** Adds `channel` to the ways voice travels in `game`. */
export function addVoiceChannel(game: Session, channel: VoiceChannel): void {
  channels.set(game, [...(channels.get(game) ?? []), channel]);
}

/**
 * Every way `listener` hears `speaker`: through the air from where the speaker stands, unless a
 * channel hides it there, and by every channel that carries its voice; none when a channel
 * silences it.
 */
export function voiceRoutes(
  game: Session,
  speaker: Player,
  listener: Player,
): VoiceRoute[] {
  const added = channels.get(game) ?? [];
  if (
    added.some(
      (channel) => channel.silences?.(game, speaker, listener) ?? false,
    )
  )
    return [];
  const carried = added.flatMap((channel) =>
    channel.routes(game, speaker, listener),
  );
  const hidden = added.some(
    (channel) => channel.hides?.(game, speaker, listener) ?? false,
  );
  return hidden
    ? carried
    : [{ at: { x: speaker.x, y: speaker.y }, via: "air" }, ...carried];
}
