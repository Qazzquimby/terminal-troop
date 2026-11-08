import { STAMINA_MAX, VIEW_H, VIEW_W, VISION_RAYS } from "./config.js";
import type { Point, World } from "./map.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import type { VisionSource } from "./vision.js";
import {
  isVisible,
  lightSources,
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

function clipSources(
  ctx: CanvasRenderingContext2D,
  game: Session,
  sources: readonly VisionSource[],
  camera: Point,
): void {
  const path = new Path2D();

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

    const [first, ...rest] = visibilityPolygon(
      game.world.map,
      source,
      VISION_RAYS,
      maxDistance,
    );
    if (first === undefined) continue;

    path.moveTo(first.x, first.y);
    rest.forEach((point) => {
      path.lineTo(point.x, point.y);
    });
    path.closePath();
  }

  ctx.clip(path);
}

export function draw(
  ctx: CanvasRenderingContext2D,
  game: Session,
  camera: Point,
  now: number,
): void {
  const viewer = game.local;
  const sources = visionOrigins(game, viewer);
  const lights = lightSources(game, viewer);

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.save();
  ctx.translate(-camera.x, -camera.y);
  clipSources(ctx, game, sources, camera);
  clipSources(ctx, game, lights, camera);
  drawTerrain(ctx, game.world, camera);

  game.entities.forEach((entity) => {
    const definition = game.entityTypes.get(entity.kind);
    if (definition === undefined) return;
    if (
      !inView(entity, camera) ||
      !isVisible(game.world.map, sources, lights, entity)
    ) return;
    ctx.save();
    definition.draw(ctx, entity, now, game);
    ctx.restore();
  });

  game.players.forEach((player) => {
    const isSelf = player === viewer;
    if (!inView(player, camera)) return;
    if (isSelf || isVisible(game.world.map, sources, lights, player))
      drawPlayer(ctx, player, isSelf);
  });

  drawStamina(ctx, viewer);
  ctx.restore();
}
