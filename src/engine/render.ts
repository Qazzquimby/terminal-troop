import { VIEW_H, VIEW_W, VISION_RAYS } from "./config.js";
import type { Point, World } from "./map.js";
import type { Player } from "./player.js";
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
    for (const point of rest) path.lineTo(point.x, point.y);
    path.closePath();
    ctx.clip(path, "evenodd");
  }

  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.fillRect(camera.x, camera.y, VIEW_W, VIEW_H);
  ctx.restore();
}

export function draw(
  ctx: CanvasRenderingContext2D,
  game: Session,
  camera: Point,
  now: number,
): void {
  const viewer = game.local;

  ctx.fillStyle = "#090b0e";
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.save();
  ctx.translate(-camera.x, -camera.y);
  drawTerrain(ctx, game.world, camera);

  for (const entity of game.entities.values()) {
    const definition = game.entityTypes.get(entity.kind);
    if (definition === undefined) continue;
    if (!inView(entity, camera) || !canSeePoint(game, viewer, entity)) continue;
    ctx.save();
    definition.draw(ctx, entity, now, game);
    ctx.restore();
  }

  for (const player of game.players.values()) {
    const isSelf = player === viewer;
    if (!inView(player, camera)) continue;
    if (isSelf || canSeePoint(game, viewer, player))
      drawPlayer(ctx, player, isSelf);
  }

  drawShade(ctx, game, viewer, camera);
  ctx.restore();
}
