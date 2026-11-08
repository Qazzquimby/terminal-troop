import { STAMINA_MAX, VIEW_H, VIEW_W, VISION_RAYS } from "./config.js";
import type { Interpolated } from "./interpolation.js";
import { renderAim, renderPosition } from "./interpolation.js";
import type { Point, TileMap, World } from "./map.js";
import type { Player } from "./player.js";
import { aimAt } from "./player.js";
import type { Session } from "./session.js";
import type { VisibilityPolygon, VisionSource } from "./vision.js";
import {
  isVisible,
  lightSources,
  litWalls,
  wallCell,
  visibilityPolygon,
  visionOrigins,
} from "./vision.js";

interface Circle extends Point {
  readonly radius: number;
}

function inView(body: Circle, camera: Point): boolean {
  return (
    body.x + body.radius >= camera.x &&
    body.y + body.radius >= camera.y &&
    body.x - body.radius <= camera.x + VIEW_W &&
    body.y - body.radius <= camera.y + VIEW_H
  );
}

function drawTerrain(
  ctx: CanvasRenderingContext2D,
  world: World,
  camera: Point,
): void {
  const { map } = world;
  const minCol = Math.max(0, Math.floor(camera.x / map.cell));
  const maxCol = Math.min(
    map.cols - 1,
    Math.floor((camera.x + VIEW_W) / map.cell),
  );
  const minRow = Math.max(0, Math.floor(camera.y / map.cell));
  const maxRow = Math.min(
    map.rows - 1,
    Math.floor((camera.y + VIEW_H) / map.cell),
  );

  ctx.fillStyle = "#181818";
  ctx.fillRect(0, 0, world.W, world.H);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#252525";

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      ctx.strokeRect(col * map.cell, row * map.cell, map.cell, map.cell);
    }
  }

  ctx.strokeStyle = "#69727b";
  ctx.strokeRect(0, 0, world.W, world.H);
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  player: Player,
  isSelf: boolean,
): void {
  ctx.fillStyle = isSelf ? "#73cfff" : "#e1bd83";
  ctx.beginPath();
  ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(player.x, player.y);
  ctx.lineTo(
    player.x + Math.cos(player.aim) * player.radius * 1.5,
    player.y + Math.sin(player.aim) * player.radius * 1.5,
  );
  ctx.stroke();

  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.fillStyle = "#eee";
  ctx.fillText(player.name, player.x, player.y - player.radius - 8);
}

function drawStamina(ctx: CanvasRenderingContext2D, player: Player): void {
  const { value, exhausted } = player.stamina;
  if (value >= STAMINA_MAX) return;

  const width = player.radius * 2;
  const x = player.x - player.radius;
  const y = player.y + player.radius + 6;
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(x - 1, y - 1, width + 2, 6);
  ctx.fillStyle = exhausted ? "#b5483f" : "#8fd694";
  ctx.fillRect(x, y, (width * value) / STAMINA_MAX, 4);
}

/**
 * Lit wall tiles, drawn outside the darkness clip: rays stop at wall faces, so walls are never
 * inside a visibility polygon. Fully drawn so a wall reads apart from both floor and darkness.
 */
function drawLitWalls(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  walls: ReadonlySet<number>,
): void {
  ctx.fillStyle = "#4b525a";
  ctx.strokeStyle = "#5f6871";
  ctx.lineWidth = 1;
  walls.forEach((wall) => {
    const { col, row } = wallCell(map, wall);
    const x = col * map.cell;
    const y = row * map.cell;
    ctx.fillRect(x, y, map.cell, map.cell);
    ctx.strokeRect(x + 0.5, y + 0.5, map.cell - 1, map.cell - 1);
  });
}

/** Visibility polygons for the sources that can reach the view, cut off at its far corner. */
function tracePolygons(
  map: TileMap,
  sources: readonly VisionSource[],
  camera: Point,
): VisibilityPolygon[] {
  const polygons: VisibilityPolygon[] = [];

  for (const source of sources) {
    const maxDistance = Math.hypot(
      Math.max(
        Math.abs(source.x - camera.x),
        Math.abs(source.x - camera.x - VIEW_W),
      ),
      Math.max(
        Math.abs(source.y - camera.y),
        Math.abs(source.y - camera.y - VIEW_H),
      ),
    );
    if (!inView({ ...source, radius: source.range ?? maxDistance }, camera))
      continue;

    polygons.push(visibilityPolygon(map, source, VISION_RAYS, maxDistance));
  }

  return polygons;
}

/** Restricts drawing to the union of `polygons`. */
function clipTo(
  ctx: CanvasRenderingContext2D,
  polygons: readonly VisibilityPolygon[],
): void {
  const path = new Path2D();

  for (const { points } of polygons) {
    const [first, ...rest] = points;
    if (first === undefined) continue;

    path.moveTo(first.x, first.y);
    rest.forEach((point) => {
      path.lineTo(point.x, point.y);
    });
    path.closePath();
  }

  ctx.clip(path);
}

/**
 * A render-time copy of the session with every body blended `alpha` of the way from its
 * pre-step position to its current one. Remote players turn along the shortest arc; the local
 * player faces `mouse` (a world point) from where it is drawn. The simulation is left untouched.
 */
export function interpolatedView(
  game: Session,
  alpha: number,
  mouse: Point,
): Session {
  const at = <T extends Interpolated>(body: T): T => ({
    ...body,
    ...renderPosition(body, alpha),
  });
  const placed = at(game.local);
  const local = { ...placed, aim: aimAt(placed, mouse) };
  const players = new Map(
    [...game.players].map(([id, player]) => [
      id,
      player === game.local
        ? local
        : { ...at(player), aim: renderAim(player, alpha) },
    ]),
  );
  const entities = new Map(
    [...game.entities].map(([id, entity]) => [id, at(entity)]),
  );
  return { ...game, local, players, entities };
}

/** Draws the session as of `alpha` (0..1) through the current fixed step. */
export function draw(
  ctx: CanvasRenderingContext2D,
  simulation: Session,
  camera: Point,
  now: number,
  alpha: number,
  mouse: Point,
): void {
  const game = interpolatedView(simulation, alpha, mouse);
  const viewer = game.local;
  const sources = visionOrigins(game, viewer);
  const lights = lightSources(game, viewer);
  const { map } = game.world;
  const seen = tracePolygons(map, sources, camera);
  const lit = tracePolygons(map, lights, camera);

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.save();
  ctx.translate(-camera.x, -camera.y);

  // Inside the darkness: only what is both seen and lit.
  ctx.save();
  clipTo(ctx, seen);
  clipTo(ctx, lit);
  drawTerrain(ctx, game.world, camera);

  game.entities.forEach((entity) => {
    const definition = game.entityTypes.get(entity.kind);
    if (definition === undefined) return;
    if (!inView(entity, camera) || !isVisible(map, sources, lights, entity))
      return;
    ctx.save();
    definition.draw(ctx, entity, now, game);
    ctx.restore();
  });

  game.players.forEach((player) => {
    if (player === viewer || !inView(player, camera)) return;
    if (isVisible(map, sources, lights, player)) drawPlayer(ctx, player, false);
  });
  ctx.restore();

  // Above the darkness: lit wall faces, then the local player and its HUD.
  drawLitWalls(ctx, map, litWalls(seen, lit));
  drawPlayer(ctx, viewer, true);
  drawStamina(ctx, viewer);
  ctx.restore();
}
