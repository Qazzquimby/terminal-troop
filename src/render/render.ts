import type {
  Interpolated,
  Player,
  Point,
  Session,
  TileMap,
  VisibilityPolygon,
  VisionSource,
  World,
} from "../sim/index.js";
import {
  aimAt,
  isVisible,
  lightSources,
  litWalls,
  renderAim,
  renderPosition,
  visibilityPolygon,
  visionOrigins,
} from "../sim/index.js";
import type { Camera } from "./camera.js";

interface Circle extends Point {
  readonly radius: number;
}

/** The width of the world the camera covers, in world units. */
function viewWidth(camera: Camera): number {
  return camera.view.width * camera.zoom;
}

/** The height of the world the camera covers, in world units. */
function viewHeight(camera: Camera): number {
  return camera.view.height * camera.zoom;
}

function inView(body: Circle, camera: Camera): boolean {
  return (
    body.x + body.radius >= camera.x &&
    body.y + body.radius >= camera.y &&
    body.x - body.radius <= camera.x + viewWidth(camera) &&
    body.y - body.radius <= camera.y + viewHeight(camera)
  );
}

function drawTerrain(
  ctx: CanvasRenderingContext2D,
  world: World,
  camera: Camera,
): void {
  const { map } = world;
  const minCol = Math.max(0, Math.floor(camera.x / map.cell));
  const maxCol = Math.min(
    map.cols - 1,
    Math.floor((camera.x + viewWidth(camera)) / map.cell),
  );
  const minRow = Math.max(0, Math.floor(camera.y / map.cell));
  const maxRow = Math.min(
    map.rows - 1,
    Math.floor((camera.y + viewHeight(camera)) / map.cell),
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

/** How opaque an away player is drawn. */
const AWAY_ALPHA = 0.4;

/** An away player is drawn faint, with "away" under its name. */
function drawPlayer(
  ctx: CanvasRenderingContext2D,
  player: Player,
  isSelf: boolean,
  away = false,
): void {
  ctx.save();
  if (away) ctx.globalAlpha = AWAY_ALPHA;
  drawBody(ctx, player, isSelf);
  if (away) {
    ctx.font = "10px system-ui";
    ctx.fillStyle = "#aaa";
    ctx.fillText("away", player.x, player.y - player.radius - 22);
  }
  ctx.restore();
}

/** Draws the white facing line from `at` in `direction` (radians) out to `radius`. */
export function drawFacing(
  ctx: CanvasRenderingContext2D,
  at: Point,
  direction: number,
  radius: number,
): void {
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(
    at.x + Math.cos(direction) * radius,
    at.y + Math.sin(direction) * radius,
  );
  ctx.stroke();
}

function drawBody(
  ctx: CanvasRenderingContext2D,
  player: Player,
  isSelf: boolean,
): void {
  ctx.fillStyle = isSelf ? "#73cfff" : "#e1bd83";
  ctx.beginPath();
  ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
  ctx.fill();

  drawFacing(ctx, player, player.aim, player.radius * 1.5);

  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.fillStyle = "#eee";
  ctx.fillText(player.name, player.x, player.y - player.radius - 8);
}

function drawStamina(
  ctx: CanvasRenderingContext2D,
  player: Player,
  max: number,
): void {
  const { value, exhausted } = player.stamina;
  if (value >= max) return;

  const width = player.radius * 2;
  const x = player.x - player.radius;
  const y = player.y + player.radius + 6;
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(x - 1, y - 1, width + 2, 6);
  ctx.fillStyle = exhausted ? "#b5483f" : "#8fd694";
  ctx.fillRect(x, y, (width * value) / max, 4);
}

/** The held item is a small glyph floating in front of the player, not a world body. */
function drawHeldItem(
  ctx: CanvasRenderingContext2D,
  player: Player,
  emoji: string,
): void {
  const distance = player.radius + 4;
  ctx.save();
  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    emoji,
    player.x + Math.cos(player.aim) * distance,
    player.y + Math.sin(player.aim) * distance,
  );
  ctx.restore();
}

/**
 * Lit wall faces, drawn outside the darkness clip: rays stop at wall faces, so walls are never
 * inside a visibility polygon. Shallow bands distinguish walls from both floor and darkness.
 */
export function drawLitWalls(
  ctx: Pick<
    CanvasRenderingContext2D,
    | "fillStyle"
    | "strokeStyle"
    | "lineWidth"
    | "beginPath"
    | "moveTo"
    | "lineTo"
    | "closePath"
    | "fill"
    | "stroke"
  >,
  walls: VisibilityPolygon["walls"],
): void {
  const depth = 4;
  ctx.fillStyle = "#4b525a";
  ctx.beginPath();
  for (const faces of walls.values()) {
    for (const { from, to, normal } of faces) {
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.lineTo(to.x - normal.x * depth, to.y - normal.y * depth);
      ctx.lineTo(from.x - normal.x * depth, from.y - normal.y * depth);
      ctx.closePath();
    }
  }
  ctx.fill();

  ctx.strokeStyle = "#5f6871";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const faces of walls.values()) {
    for (const { from, to } of faces) {
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
  }
  ctx.stroke();
}

/** Visibility polygons for the sources that can reach the view, cut off at its far corner. */
function tracePolygons(
  map: TileMap,
  sources: readonly VisionSource[],
  camera: Camera,
  rays: number,
): VisibilityPolygon[] {
  const polygons: VisibilityPolygon[] = [];

  for (const source of sources) {
    const maxDistance = Math.hypot(
      Math.max(
        Math.abs(source.x - camera.x),
        Math.abs(source.x - camera.x - viewWidth(camera)),
      ),
      Math.max(
        Math.abs(source.y - camera.y),
        Math.abs(source.y - camera.y - viewHeight(camera)),
      ),
    );
    if (!inView({ ...source, radius: source.range ?? maxDistance }, camera))
      continue;

    polygons.push(visibilityPolygon(map, source, rays, maxDistance));
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

/**
 * Draws the session as of `alpha` (0..1) through the current fixed step, with each remote
 * player `isAway` picks out drawn as away and `held` (an item glyph) in front of the local one.
 */
export function draw(
  ctx: CanvasRenderingContext2D,
  simulation: Session,
  camera: Camera,
  now: number,
  alpha: number,
  mouse: Point,
  isAway: (id: string) => boolean,
  held: string | null,
): void {
  const game = interpolatedView(simulation, alpha, mouse);
  const viewer = game.local;
  const sources = visionOrigins(game, viewer);
  const lights = lightSources(game, viewer);
  const { map } = game.world;
  const { rays } = game.config.vision;
  const seen = tracePolygons(map, sources, camera, rays);
  const lit = tracePolygons(map, lights, camera, rays);

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, camera.view.width, camera.view.height);
  ctx.save();
  const scale = 1 / camera.zoom;
  ctx.scale(scale, scale);
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
    if (isVisible(map, sources, lights, player))
      drawPlayer(ctx, player, false, isAway(player.id));
  });
  ctx.restore();

  // Above the darkness: lit wall faces, then the local player and its HUD.
  drawLitWalls(ctx, litWalls(seen, lit));
  drawPlayer(ctx, viewer, true);
  viewer.use?.draw(ctx, now);
  if (held !== null) drawHeldItem(ctx, viewer, held);
  drawStamina(ctx, viewer, game.config.stamina.max);
  ctx.restore();
}
