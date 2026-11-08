import { MAP_CELL, Status, VIEW_H, VIEW_W } from "./config.js";
import { isSolid } from "./map.js";
import { canSee, canSeePoint, visionOrigins, visibilityPolygon, xrayRadius } from "./vision.js";
import { bodies } from "./collision.js";
import { ENTITY_DEFS } from "./entities/index.js";
import { CLASS_DEFS, PlayerClass } from "./classes/index.js";
import { trailTiles } from "./map.js";

let visionCanvas;

export function draw(ctx, world, game, now, camera) {
  const me = game.players.get(game.localId);
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  ctx.save();
  ctx.translate(-camera.x, -camera.y);
  drawGrid(ctx, world);
  drawWalls(ctx, world);
  if (me?.classId === PlayerClass.MONSTER) drawMonsterTrails(ctx, game, world, now, me);

  for (const body of bodies(game)) {
    const def = ENTITY_DEFS[body.kind];
    const visible = def.isVisible
      ? def.isVisible(body, me, game)
      : canSee(game, me, body);
    if (visible) def.draw(ctx, body, me, now, game);
  }

  drawVisionShade(ctx, world, me, game);
  ctx.restore();
  drawOverlay(ctx, game);
}

function drawGrid(ctx, world) {
  ctx.strokeStyle = "#242424";
  ctx.lineWidth = 1;
  for (let x = 0; x <= world.W; x += MAP_CELL) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, world.H);
    ctx.stroke();
  }
  for (let y = 0; y <= world.H; y += MAP_CELL) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(world.W, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "#444";
  ctx.strokeRect(0, 0, world.W, world.H);
}

function drawWalls(ctx, world) {
  for (let row = 0; row < world.map.rows; row++) {
    for (let col = 0; col < world.map.cols; col++) {
      if (!isSolid(world.map, col, row)) continue;
      ctx.fillStyle = "#343434";
      ctx.fillRect(col * world.map.cell, row * world.map.cell, world.map.cell, world.map.cell);
    }
  }
}

function drawMonsterTrails(ctx, game, world, now, me) {
  const cell = world.map.cell;
  for (const tile of trailTiles(game.trails, world.map, now)) {
    const center = {x: (tile.col + 0.5) * cell, y: (tile.row + 0.5) * cell};
    if (!canSeePoint(game, me, center)) continue;
    ctx.globalAlpha = tile.strength * 0.45;
    ctx.fillStyle = "#a5e66e";
    ctx.fillRect(tile.col * cell + 3, tile.row * cell + 3, cell - 6, cell - 6);
  }
  ctx.globalAlpha = 1;
}

function drawVisionShade(ctx, world, origin, game) {
  if (!visionCanvas) visionCanvas = document.createElement("canvas");
  if (visionCanvas.width !== world.W || visionCanvas.height !== world.H) {
    visionCanvas.width = world.W;
    visionCanvas.height = world.H;
  }

  const shade = visionCanvas.getContext("2d");
  shade.globalCompositeOperation = "source-over";
  shade.globalAlpha = 1;
  shade.clearRect(0, 0, world.W, world.H);
  shade.fillStyle = "rgba(0, 0, 0, 0.40)";
  shade.fillRect(0, 0, world.W, world.H);
  shade.globalCompositeOperation = "destination-out";
  shade.fillStyle = "#fff";

  for (const visionOrigin of visionOrigins(game, origin)) {
    const points = visibilityPolygon(world.map, visionOrigin);
    if (points.length === 0) continue;
    shade.beginPath();
    shade.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) shade.lineTo(points[i].x, points[i].y);
    shade.closePath();
    shade.fill();
  }

  const radius = xrayRadius(origin);
  if (radius > 0) {
    shade.beginPath();
    shade.arc(origin.x, origin.y, radius, 0, Math.PI * 2);
    shade.fill();
  }

  shade.globalCompositeOperation = "source-over";
  ctx.drawImage(visionCanvas, 0, 0);
}


function drawOverlay(ctx, game) {
  const me = game.players.get(game.localId);

  if (me && me.status === Status.CHOOSING) {
    ctx.font = "bold 20px system-ui";
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.fillText(
      `Choose a class (1-${Object.keys(CLASS_DEFS).length})`,
      VIEW_W / 2,
      VIEW_H / 2,
    );
  } else if (me && me.status === Status.DEAD) {
    ctx.font = "bold 20px system-ui";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ff4d4d";
    ctx.fillText("Caught! Respawning…", VIEW_W / 2, VIEW_H / 2);
  }
}
