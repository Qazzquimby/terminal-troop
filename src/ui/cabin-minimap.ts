import { AREA, destroyedWalls, livingPlayers } from "../sim/index.js";
import type { Player, Session } from "../sim/index.js";
import { button, make } from "./cabin.js";
import type { CabinPanel } from "./cabin.js";

/** The cabin's minimap. */
export interface MinimapConfig {
  /** How far round the player it follows it shows, in cells. */
  readonly radius: number;
  /** Its side on screen, in pixels. */
  readonly size: number;
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

/** Each area's colour on the minimap; a knocked-down wall shows as rubble. */
const COLOURS: Readonly<Record<number, string>> = {
  [AREA.wall]: "#2b0033",
  [AREA.road]: "#9a9a9a",
  [AREA.yard]: "#3f8f2a",
  [AREA.room]: "#c79a5a",
  [AREA.door]: "#ffe600",
};
const RUBBLE = "#6b4a3a";
const OFF_MAP = "#000";

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
 * It shows no monsters: the car knows where its crew are, not what hunts them.
 */
export function minimapPanel(config: MinimapConfig): CabinPanel {
  const element = make("section", "cabin-panel cabin-minimap");
  const title = make("h3", "cabin-title", "CREW-O-LOCATOR 3000");
  const canvas = make("canvas", "cabin-minimap-canvas");
  canvas.width = config.size;
  canvas.height = config.size;
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
  element.append(title, canvas, row);

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
    const facing = player.aim;
    ctx.strokeStyle = "#00ffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(middle, middle);
    ctx.lineTo(
      middle + Math.cos(facing) * scale * 1.5,
      middle + Math.sin(facing) * scale * 1.5,
    );
    ctx.stroke();
    ctx.fillStyle = "#ff0044";
    ctx.beginPath();
    ctx.arc(middle, middle, Math.max(3, scale * 0.5), 0, Math.PI * 2);
    ctx.fill();
  };

  return {
    element,
    update(_view, game) {
      targets = minimapTargets(game);
      target = cycleTarget(targets, target, 0);
      const player = target === null ? undefined : game.players.get(target);
      const text = player === undefined ? "nobody alive?!" : player.name;
      if (name.textContent !== text) name.textContent = text;
      previous.disabled = targets.length < 2;
      next.disabled = targets.length < 2;
      if (player !== undefined) draw(game, player);
    },
  };
}
