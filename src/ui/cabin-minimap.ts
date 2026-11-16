import {
  AREA,
  cabinTeleporter,
  destroyedWalls,
  livingPlayers,
  perceives,
} from "../sim/index.js";
import type { CabinTeleporter, Player, Session } from "../sim/index.js";
import { button, make } from "./cabin.js";
import type { CabinPanel, CabinSend } from "./cabin.js";

/** The cabin's minimap. */
export interface MinimapConfig {
  /** How far round the player it follows it shows, in cells. */
  readonly radius: number;
  /** Its side on screen, in pixels: the most it is ever drawn at, shrinking only to fit. */
  readonly size: number;
  /** Milliseconds its radar sweep takes to go round once. */
  readonly sweepMs: number;
}

/**
 * The living players the minimap may follow, by id: everyone else first, the local player last,
 * each in the order the session has them.
 */
export function minimapTargets(game: Session): string[] {
  const living = livingPlayers(game);
  return [
    ...living.filter((player) => player !== game.local),
    ...living.filter((player) => player === game.local),
  ].map((player) => player.id);
}

/**
 * The player the minimap follows `step` along `targets` from `current`, wrapping round both ends.
 * One no longer among them, or none yet, gives way to the first; null while there is no one.
 */
export function cycleTarget(
  targets: readonly string[],
  current: string | null,
  step: number,
): string | null {
  const at = current === null ? -1 : targets.indexOf(current);
  if (at === -1) return targets[0] ?? null;
  const count = targets.length;
  return targets[(((at + step) % count) + count) % count] ?? null;
}

/** How the teleporter's button shows: whether at all, whether it may be pressed, and its label. */
export interface TeleportButton {
  readonly shown: boolean;
  readonly enabled: boolean;
  readonly text: string;
  /** Whether the teleporter is bringing the player the minimap follows. */
  readonly charging: boolean;
}

/**
 * The teleporter's button, for the vehicle's `teleporter` (null for a vehicle without one) and the
 * player the minimap follows, if any: it sends for a player out in the world, one at a time, never
 * one already inside a vehicle.
 */
export function teleportButton(
  teleporter: CabinTeleporter | null,
  player: Pick<Player, "id" | "ride"> | undefined,
): TeleportButton {
  if (teleporter === null)
    return { shown: false, enabled: false, text: "", charging: false };
  if (player === undefined)
    return { shown: true, enabled: false, text: "TELEPORT", charging: false };
  const charging = teleporter.sending === player.id;
  if (charging)
    return { shown: true, enabled: false, text: "⚡ CHARGING... ⚡", charging };
  const enabled = player.ride === null && teleporter.sending === null;
  const text =
    player.ride !== null
      ? "TELEPORT (already aboard)"
      : teleporter.sending !== null
        ? "TELEPORT (busy)"
        : "⚡ TELEPORT HERE ⚡";
  return { shown: true, enabled, text, charging };
}

/*
 * The minimap is a radar screen: one phosphor green, in a few shades, on near black. Solid walls
 * return the brightest echo, rooms and rubble a dimmer one, open ground barely any.
 */
const PHOSPHOR = {
  void: "#010803",
  ground: "#06200c",
  floor: "#0f3d1a",
  wall: "#24873a",
  bright: "#b8ffb0",
} as const;

/** Each area's shade on the minimap; a knocked-down wall shows as rubble. */
const COLOURS: Readonly<Record<number, string>> = {
  [AREA.wall]: PHOSPHOR.wall,
  [AREA.road]: PHOSPHOR.ground,
  [AREA.yard]: PHOSPHOR.ground,
  [AREA.room]: PHOSPHOR.floor,
  [AREA.door]: PHOSPHOR.floor,
};
const RUBBLE = PHOSPHOR.floor;
const OFF_MAP = PHOSPHOR.void;

/** How many fading slices trail the sweep line, and the angle they cover, in radians. */
const SWEEP_TRAIL = 8;
const SWEEP_ARC = Math.PI / 3;

/**
 * The sweep line's angle at `ms`, in radians clockwise from pointing right on screen, as canvas
 * angles go: straight up at 0 ms, going round once every `periodMs`.
 */
export function sweepAngle(ms: number, periodMs: number): number {
  const turn = (((ms % periodMs) + periodMs) % periodMs) / periodMs;
  return turn * Math.PI * 2 - Math.PI / 2;
}

/** The radar's range rings, crosshair and sweep at `ms`, over a square canvas centred on `middle`. */
function radarOverlay(
  ctx: CanvasRenderingContext2D,
  middle: number,
  ms: number,
  sweepMs: number,
): void {
  ctx.strokeStyle = PHOSPHOR.wall;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const ring of [1 / 3, 2 / 3, 1]) {
    const r = middle * ring - 0.5;
    ctx.moveTo(middle + r, middle);
    ctx.arc(middle, middle, r, 0, Math.PI * 2);
  }
  ctx.moveTo(middle, 0);
  ctx.lineTo(middle, middle * 2);
  ctx.moveTo(0, middle);
  ctx.lineTo(middle * 2, middle);
  ctx.stroke();
  const angle = sweepAngle(ms, sweepMs);
  const slice = SWEEP_ARC / SWEEP_TRAIL;
  ctx.fillStyle = PHOSPHOR.bright;
  for (let step = 0; step < SWEEP_TRAIL; step++) {
    ctx.globalAlpha = 0.25 * (1 - step / SWEEP_TRAIL);
    ctx.beginPath();
    ctx.moveTo(middle, middle);
    ctx.arc(
      middle,
      middle,
      middle,
      angle - slice * (step + 1),
      angle - slice * step,
    );
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PHOSPHOR.bright;
  ctx.beginPath();
  ctx.moveTo(middle, middle);
  ctx.lineTo(
    middle + Math.cos(angle) * middle,
    middle + Math.sin(angle) * middle,
  );
  ctx.stroke();
}

/**
 * The world's layout drawn a pixel a cell, as every client knows it: built once, and again as
 * walls come down.
 */
function layoutImage(game: Session): HTMLCanvasElement {
  const { map, layout } = game.world;
  const canvas = document.createElement("canvas");
  canvas.width = map.cols;
  canvas.height = map.rows;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return canvas;
  for (let row = 0; row < map.rows; row++)
    for (let col = 0; col < map.cols; col++) {
      const index = row * map.cols + col;
      const area = layout.area[index] ?? AREA.wall;
      const down = area === AREA.wall && map.solid[index] !== 1;
      ctx.fillStyle = down ? RUBBLE : (COLOURS[area] ?? OFF_MAP);
      ctx.fillRect(col, row, 1, 1);
    }
  return canvas;
}

/**
 * The minimap: the world round one living player, walls and all, whatever the local player can see
 * from the cabin, the player marked with the way it faces. Buttons step through who it follows.
 * It shows no monsters: the car knows where its crew are, not what hunts them. Under it, for a
 * vehicle with a teleporter, a button sends for the player it follows. Only what a kind draws
 * over it for the local player, if the local player perceives it, shows over all that.
 */
export function minimapPanel(
  config: MinimapConfig,
  send: CabinSend,
): CabinPanel {
  const element = make("section", "cabin-panel cabin-minimap");
  const title = make("h3", "cabin-title", "CREW-O-LOCATOR 3000");
  const canvas = make("canvas", "cabin-minimap-canvas");
  canvas.width = config.size;
  canvas.height = config.size;
  // Never wider than its own size on screen, whatever else styles canvases; narrower to fit.
  canvas.style.width = `${String(config.size)}px`;
  const name = make("span", "cabin-minimap-name");
  let target: string | null = null;
  let targets: readonly string[] = [];
  const previous = button("cabin-minimap-step", "◀◀", () => {
    target = cycleTarget(targets, target, -1);
  });
  const next = button("cabin-minimap-step", "▶▶", () => {
    target = cycleTarget(targets, target, 1);
  });
  const row = make("div", "cabin-minimap-row");
  row.append(previous, name, next);
  const teleport = button("cabin-teleport", "", () => {
    if (target !== null) send({ teleport: target });
  });
  teleport.title =
    "Teleports them beside the car after a few seconds. They drop everything they carry.";
  element.append(title, canvas, row, teleport);

  const ctx = canvas.getContext("2d");
  /** The layout image, and the session and count of fallen walls it was drawn for. */
  let drawn: {
    readonly game: Session;
    readonly walls: number;
    readonly image: HTMLCanvasElement;
  } | null = null;
  const layout = (game: Session): HTMLCanvasElement => {
    const walls = destroyedWalls.get(game).length;
    if (drawn?.game !== game || drawn.walls !== walls)
      drawn = { game, walls, image: layoutImage(game) };
    return drawn.image;
  };

  const draw = (game: Session, player: Player): void => {
    if (ctx === null) return;
    const { cell } = game.world.map;
    const span = config.radius * 2;
    const scale = config.size / span;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = OFF_MAP;
    ctx.fillRect(0, 0, config.size, config.size);
    ctx.drawImage(
      layout(game),
      player.x / cell - config.radius,
      player.y / cell - config.radius,
      span,
      span,
      0,
      0,
      config.size,
      config.size,
    );
    const middle = config.size / 2;
    radarOverlay(ctx, middle, performance.now(), config.sweepMs);
    const facing = player.aim;
    ctx.strokeStyle = PHOSPHOR.bright;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(middle, middle);
    ctx.lineTo(
      middle + Math.cos(facing) * scale * 1.5,
      middle + Math.sin(facing) * scale * 1.5,
    );
    ctx.stroke();
    ctx.fillStyle = PHOSPHOR.bright;
    ctx.beginPath();
    ctx.arc(middle, middle, Math.max(3, scale * 0.5), 0, Math.PI * 2);
    ctx.fill();
    for (const entity of game.entities.values()) {
      if (!perceives(game, game.localId, entity.id)) continue;
      ctx.save();
      game.entityTypes
        .get(entity.kind)
        ?.minimap(ctx, entity, config.size, performance.now());
      ctx.restore();
    }
  };

  return {
    element,
    update(view, game) {
      targets = minimapTargets(game);
      target = cycleTarget(targets, target, 0);
      const player = target === null ? undefined : game.players.get(target);
      const text = player === undefined ? "nobody alive?!" : player.name;
      if (name.textContent !== text) name.textContent = text;
      previous.disabled = targets.length < 2;
      next.disabled = targets.length < 2;
      const shows = teleportButton(cabinTeleporter(game, view.vehicle), player);
      teleport.hidden = !shows.shown;
      teleport.disabled = !shows.enabled;
      teleport.classList.toggle("cabin-teleport-charging", shows.charging);
      if (teleport.textContent !== shows.text)
        teleport.textContent = shows.text;
      if (player !== undefined) draw(game, player);
    },
  };
}
