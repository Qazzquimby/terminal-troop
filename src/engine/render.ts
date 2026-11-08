import { STAMINA_MAX, VIEW_H, VIEW_W, VISION_RAYS } from "./config.js";
import type { Interpolated } from "./interpolation.js";
import { renderAim, renderPosition } from "./interpolation.js";
import type { Point, World } from "./map.js";
import type { Player } from "./player.js";
import { aimAt } from "./player.js";
import type { Session } from "./session.js";
import { canSeePoint, visibilityPolygon, visionOrigins } from "./vision.js";

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
      const x = col * map.cell;
      const y = row * map.cell;
      if (map.solid[row * map.cols + col] === 1) {
        ctx.fillStyle = "#41464c";
        ctx.fillRect(x, y, map.cell, map.cell);
      }
      ctx.strokeRect(x, y, map.cell, map.cell);
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

function drawShade(
  ctx: CanvasRenderingContext2D,
  game: Session,
  viewer: Player,
  camera: Point,
): void {
  const maxDistance = Math.hypot(VIEW_W, VIEW_H);
  ctx.save();

  for (const origin of visionOrigins(game, viewer)) {
    if (!inView({ ...origin, radius: maxDistance }, camera)) continue;
    const [first, ...rest] = visibilityPolygon(
      game.world.map,
      origin,
      VISION_RAYS,
      maxDistance,
    );
    if (first === undefined) continue;

    const path = new Path2D();
    path.rect(camera.x, camera.y, VIEW_W, VIEW_H);
    path.moveTo(first.x, first.y);
    rest.forEach((point) => {
      path.lineTo(point.x, point.y);
    });
    path.closePath();
    ctx.clip(path, "evenodd");
  }

  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.fillRect(camera.x, camera.y, VIEW_W, VIEW_H);
  ctx.restore();
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

  ctx.fillStyle = "#090b0e";
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.save();
  ctx.translate(-camera.x, -camera.y);
  drawTerrain(ctx, game.world, camera);

  game.entities.forEach((entity) => {
    const definition = game.entityTypes.get(entity.kind);
    if (definition === undefined) return;
    if (!inView(entity, camera) || !canSeePoint(game, viewer, entity)) return;
    ctx.save();
    definition.draw(ctx, entity, now, game);
    ctx.restore();
  });

  game.players.forEach((player) => {
    const isSelf = player === viewer;
    if (!inView(player, camera)) return;
    if (isSelf || canSeePoint(game, viewer, player))
      drawPlayer(ctx, player, isSelf);
  });

  drawShade(ctx, game, viewer, camera);
  drawStamina(ctx, viewer);
  ctx.restore();
}
