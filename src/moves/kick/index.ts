import { z } from "zod";
import {
  allowMove,
  applyDamage,
  broadcastNoise,
  circleAhead,
  contentEvent,
  dashEnd,
  entitiesIn,
  hostReady,
  hostSpends,
  hurtPlayer,
  knockBack,
  makeSound,
  playersIn,
  nextAction,
  predict,
  confirmAction,
  couldStand,
  showFlash,
  spendStamina,
  solidBodiesBut,
  sound,
  startDash,
} from "../../sim/index.js";
import type {
  Circle,
  Content,
  Player,
  Point,
  Session,
  WorldEntity,
} from "../../sim/index.js";
import useUrl from "./sfx/use.mp3";

/** How a kick works. Distances in pixels unless said otherwise, times in sim seconds. */
export interface KickConfig {
  /** How far in front of the kicker, once it has lunged, the hitbox is centred. */
  readonly reach: number;
  /** The radius of the hitbox. */
  readonly radius: number;
  /** Damage dealt to every world entity and other player in the hitbox. */
  readonly damage: number;
  /** How far a kicked entity or player is pushed away from the kicker, in its own body lengths. */
  readonly knockback: number;
  /** Minimum time between kicks. */
  readonly cooldown: number;
  /** Stamina a kick costs; a player with less does not kick. */
  readonly stamina: number;
  /** The kicker's lunge forward as it kicks. */
  readonly lunge: {
    /** How far, in the kicker's own body lengths. */
    readonly lengths: number;
    readonly seconds: number;
    /**
     * How far, in pixels, a reported lunge's end may be from the host's own reckoning of it,
     * from where and which way the kicker reports it started.
     */
    readonly slack: number;
  };
  /** How far, in pixels, a kick's noise carries. */
  readonly noiseRadius: number;
}

/** What kicks are timed under, and the content entry's own name. */
const NAME = "move/kick";

/** A body's length: its diameter. */
const bodyLength = (body: { readonly radius: number }): number =>
  body.radius * 2;

const Spot = z.object({ x: z.number(), y: z.number() });

/**
 * A kick as a player reports it: where its lunge started and where it ended, which way it faces,
 * and its action number.
 */
const Kicked = z.object({
  from: Spot,
  to: Spot,
  aim: z.number(),
  action: z.number().int().positive(),
});

/** A kick the host accepted, as every other client shows it. */
const Shown = z.object({
  by: z.string().min(1).max(64),
  x: z.number(),
  y: z.number(),
  hit: z.boolean(),
});

const SOUNDS = { use: sound({ url: useUrl }) } as const;

/**
 * The kick: what every player can do empty-handed, whatever it holds, on the secondary action.
 * The kicker lunges a little, up to whatever is in its way, and spends stamina on its own client;
 * the host spends it from its own reckoning of the kicker's stamina too, and turns down a kick it
 * reckons the kicker cannot afford.
 * The kicker reports where its lunge started, which the host holds to the checks on its moves,
 * and which way it faced. The host works out the lunge itself from there, as far as the reported
 * end but no further than a lunge goes nor through walls, and turns down a kick whose reported
 * end is too far from its own. Bodies the kicker may have seen elsewhere do not stop it. It then
 * hurts and knocks back every world entity and every other player in front of where it reckons
 * the lunge ends, and makes a noise. A kicked player takes its blow on its own client. A guest
 * kicker predicts what its kick does to world entities from its own lunge end, so its lunge
 * carries on through them at once.
 */
export const kick: Content<"kick", KickConfig> = {
  name: "kick",
  create(configs) {
    const config = configs.kick;
    const hitbox = (at: Point, aim: number): Circle =>
      circleAhead(at, aim, config.reach, config.radius);
    const show = (game: Session, area: Circle, hit: boolean): void => {
      showFlash(game, { at: area.center, radius: area.radius, hit });
    };
    /** Hurts `entity` and knocks it away from a kicker at `at`. */
    const strike = (game: Session, entity: WorldEntity, at: Point): void => {
      applyDamage(entity, config.damage);
      const distance = bodyLength(entity) * config.knockback;
      knockBack(entity, at, distance, game.world.map, "stop");
    };

    const shown = contentEvent({
      schema: Shown,
      to: "all",
      from: "host",
      receive(game, { by, x, y, hit }) {
        if (by !== game.localId)
          show(game, { center: { x, y }, radius: config.radius }, hit);
      },
    });

    /**
     * Where a remote `kicker`'s lunge ends as this client sees the walls, if it started `from`
     * facing `aim` and went as far as `to` does; null when `to` is too far from there, or
     * `from` too far from where the kicker was lately heard to stand.
     */
    const lungeEnd = (
      game: Session,
      kicker: Player,
      { from, to, aim }: z.infer<typeof Kicked>,
    ): Point | null => {
      const length = bodyLength(kicker) * config.lunge.lengths;
      if (!couldStand(game, kicker.id, from, length)) return null;
      const end = dashEnd(
        { ...from, radius: kicker.radius },
        aim,
        Math.min(length, Math.hypot(to.x - from.x, to.y - from.y)),
        game.world.map,
        [],
      );
      const off = Math.hypot(to.x - end.x, to.y - end.y);
      return off > config.lunge.slack ? null : end;
    };

    const kicked = contentEvent({
      schema: Kicked,
      to: "host",
      receive(game, reported, by) {
        confirmAction(game, by, reported.action);
        const kicker = game.players.get(by);
        if (kicker === undefined) return;
        if (!hostSpends(game, by, config.stamina)) return;
        const { aim } = reported;
        const at =
          kicker === game.local
            ? reported.to
            : lungeEnd(game, kicker, reported);
        if (at === null) return;
        if (!hostReady(game, by, NAME, config.cooldown)) return;
        allowMove(
          game,
          by,
          Math.hypot(at.x - reported.from.x, at.y - reported.from.y) +
            config.lunge.slack,
          config.lunge.seconds,
        );
        const area = hitbox(at, aim);
        const entities = entitiesIn(game, area);
        for (const entity of entities) strike(game, entity, at);
        const players = playersIn(game, area, by);
        for (const player of players)
          hurtPlayer(game, player, config.damage, {
            from: at,
            distance: bodyLength(player) * config.knockback,
          });
        const hit = entities.length + players.length;
        broadcastNoise(game, {
          at: area.center,
          radius: config.noiseRadius,
          source: by,
        });
        shown.send(game, { by, ...area.center, hit: hit > 0 });
      },
    });

    return {
      name: NAME,
      events: { kicked, shown },
      register: () => undefined,
      populate: () => undefined,
      act(game, controls) {
        if (!controls.secondary) return;
        const { local } = game;
        if (game.time < (game.localReadyAt.get(NAME) ?? -Infinity)) return;
        const stamina = spendStamina(local.stamina, config.stamina);
        if (stamina === null) return;
        local.stamina = stamina;
        game.localReadyAt.set(NAME, game.time + config.cooldown);
        // The kicker's state goes with the kick, so the host checks where the lunge started
        // against a fresh report.
        game.reportNow = true;
        const from = local.dash?.to ?? { x: local.x, y: local.y };
        const { lengths, seconds } = config.lunge;
        const at = startDash(
          local,
          local.aim,
          bodyLength(local) * lengths,
          seconds,
          game.world.map,
          solidBodiesBut(game, local),
        );
        const area = hitbox(at, local.aim);
        const entities = entitiesIn(game, area);
        const hits =
          entities.length + playersIn(game, area, game.localId).length;
        show(game, area, hits > 0);
        makeSound(game, SOUNDS.use, at, game.localId);
        const action = nextAction(game);
        predict(game, action, entities, (entity) => {
          strike(game, entity, at);
        });
        kicked.send(game, {
          from,
          to: { x: at.x, y: at.y },
          aim: local.aim,
          action,
        });
      },
    };
  },
};
