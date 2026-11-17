import type {
  AmbientLight,
  Body,
  DarkSource,
  Entity,
  Footprint,
  Interpolated,
  LightSource,
  Player,
  Point,
  Session,
  TileMap,
  VisibilityPolygon,
  VisionSource,
  WallFace,
  World,
  WorldEntity,
} from "../sim/index.js";
import {
  AREA,
  aimAt,
  footprintPoints,
  ambientLightAt,
  ambientPolygons,
  canSeeFrom,
  darkSources,
  eyesOf,
  frontsNow,
  intoDeepdark,
  isDeepdark,
  nearDeepdark,
  daylightNow,
  emittedLights,
  inDarkness,
  footprintOf,
  glyphOf,
  heldItemOf,
  isAboard,
  isGhost,
  isStunned,
  isBodyVisible,
  isSolid,
  isVisible,
  perceives,
  pickupTarget,
  stunLeft,
  lightSources,
  litWalls,
  movement,
  pocketRect,
  pocketsIn,
  renderAim,
  drawnLocal,
  renderPosition,
  visibilityPolygon,
  visionOrigins,
} from "../sim/index.js";
import type { Camera } from "./camera.js";
import { drawClock } from "./clock.js";
import type { Eye } from "./spectate.js";
import type {
  Area,
  MapMemory,
  MapMemoryConfig,
  RememberedTerrain,
} from "./map-memory.js";
import { inkMask } from "./ink.js";
import type { AgeGrid, InkFadeConfig } from "./ink.js";
import { flashDisc } from "./flashes.js";
import type { Flashes } from "./flashes.js";
import { edgeGlow, rippleRing } from "./ripples.js";
import type { Ripple, RippleConfig, Ripples } from "./ripples.js";

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

/** The part of the world the camera covers. */
function viewArea(camera: Camera): Area {
  return {
    x: camera.x,
    y: camera.y,
    width: viewWidth(camera),
    height: viewHeight(camera),
  };
}

function inView(body: Circle, camera: Camera): boolean {
  return (
    body.x + body.radius >= camera.x &&
    body.y + body.radius >= camera.y &&
    body.x - body.radius <= camera.x + viewWidth(camera) &&
    body.y - body.radius <= camera.y + viewHeight(camera)
  );
}

/** The ground's colours: the road a little lighter than the rest, the exit marked out in green. */
const TERRAIN = {
  road: "#1f1f22",
  exit: "rgba(90, 220, 140, 0.12)",
  exitEdge: "rgba(90, 220, 140, 0.55)",
};

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

  // Its translucent exit fill must not outlast it: an emoji takes its alpha from the fill style.
  ctx.save();
  ctx.fillStyle = "#181818";
  ctx.fillRect(0, 0, world.W, world.H);
  // Any pocket in view, off the map: a floor like any room's, its cells marked out.
  const view = {
    x: camera.x,
    y: camera.y,
    w: viewWidth(camera),
    h: viewHeight(camera),
  };
  for (const pocket of pocketsIn(map, view)) {
    const floor = pocketRect(map, pocket);
    ctx.fillRect(floor.x, floor.y, floor.w, floor.h);
    ctx.strokeStyle = "#252525";
    for (let y = floor.y; y < floor.y + floor.h; y += map.cell)
      for (let x = floor.x; x < floor.x + floor.w; x += map.cell)
        ctx.strokeRect(x, y, map.cell, map.cell);
  }
  ctx.fillStyle = TERRAIN.road;
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      if (world.layout.area[row * map.cols + col] === AREA.road)
        ctx.fillRect(col * map.cell, row * map.cell, map.cell, map.cell);
    }
  }
  const { exit } = world.layout;
  ctx.fillStyle = TERRAIN.exit;
  ctx.fillRect(exit.x, exit.y, exit.w, exit.h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#252525";

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      ctx.strokeRect(col * map.cell, row * map.cell, map.cell, map.cell);
    }
  }

  ctx.save();
  ctx.setLineDash([12, 8]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = TERRAIN.exitEdge;
  ctx.strokeRect(exit.x, exit.y, exit.w, exit.h);
  ctx.restore();

  ctx.strokeStyle = "#69727b";
  ctx.strokeRect(0, 0, world.W, world.H);
  ctx.restore();
}

/** How opaque an away player is drawn. */
const AWAY_ALPHA = 0.4;

/**
 * A player with the item it holds in front of it, and its latest use while that lasts. An away
 * player is drawn faint, with "away" under its name.
 */
function drawPlayer(
  ctx: CanvasRenderingContext2D,
  game: Session,
  player: Player,
  isSelf: boolean,
  away = false,
): void {
  ctx.save();
  if (away) ctx.globalAlpha = AWAY_ALPHA;
  drawBody(ctx, player, lookOf(player), isSelf);
  if (player.use !== null)
    game.items.get(player.use.item)?.draw?.(ctx, player.use, game.time);
  const held = heldItemOf(game, player);
  if (held !== null)
    drawHeldItem(ctx, player, player.aim, glyphOf(held, held.state));
  if (away) {
    ctx.font = "10px system-ui";
    ctx.fillStyle = "#aaa";
    ctx.fillText("away", player.x, player.y - player.radius - 22);
  }
  ctx.restore();
}

/** Draws the white facing line from `at` in `direction` (radians) out to `radius`. */
export function drawFacing(
  ctx: PathContext,
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

/**
 * The fill an emoji is drawn with. A colour emoji keeps its own colours but takes the fill style's
 * alpha, so whatever translucent fill was set last would leave it faint.
 */
const EMOJI_FILL = "#fff";

/** What drawing a glyph needs of a context. */
type TextContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "fillStyle"
  | "font"
  | "textAlign"
  | "textBaseline"
  | "fillText"
>;

/** Draws `glyph` centred on `at`, about `size` pixels tall, as opaque as the context's alpha. */
export function drawEmoji(
  ctx: TextContext,
  at: Point,
  glyph: string,
  size: number,
): void {
  ctx.save();
  ctx.fillStyle = EMOJI_FILL;
  ctx.font = `${String(size)}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, at.x, at.y);
  ctx.restore();
}

/** Seconds a stunned body's stars take to circle its head once. */
const STUN_SPIN = 1.2;

/** Pixels above a stunned body's top that its stars circle; a player's clear its name and bar. */
const STUN_ABOVE = { entity: 6, player: 34 } as const;

/**
 * How dark `viewer`'s view goes for being stunned, 0..1: the stunned config's darkness while the
 * stun lasts, clearing over its last seconds; 0 when it is not stunned.
 */
export function blindness(game: Session, viewer: Player): number {
  const left = stunLeft(game, viewer.id);
  if (left === null) return 0;
  const { darkness, fadeOut } = game.config.stunned;
  return darkness * Math.min(1, fadeOut > 0 ? left / fadeOut : 1);
}

/**
 * Stars circling `gap` pixels above a stunned body's head, a player or a world entity of any
 * kind, at `now` in milliseconds.
 */
function drawStunned(
  ctx: CanvasRenderingContext2D,
  entity: Entity,
  now: number,
  gap: number,
): void {
  const seconds = now / 1000;
  const turn = ((seconds % STUN_SPIN) / STUN_SPIN) * Math.PI * 2;
  const above = entity.y - entity.radius - gap;
  for (const offset of [0, Math.PI]) {
    const angle = turn + offset;
    drawEmoji(
      ctx,
      {
        x: entity.x + Math.cos(angle) * entity.radius * 0.8,
        y: above + Math.sin(angle) * 3,
      },
      "⭐",
      9,
    );
  }
}

/** How large a crouching player's body is drawn, as a fraction of its radius. */
const CROUCHED_SCALE = 0.7;

/** What a player looks like, past where it stands: its name, its facing, and whether it crouches. */
interface PlayerLook {
  readonly name: string;
  /** Radians. */
  readonly aim: number;
  readonly crouched: boolean;
}

const lookOf = (player: Player): PlayerLook => ({
  name: player.name,
  aim: player.aim,
  crouched: movement.get(player).mode === "crouch",
});

/** What drawing a body as a player needs of a context. */
type BodyContext = PathContext &
  TextContext &
  Pick<CanvasRenderingContext2D, "arc" | "fillRect">;

/** A player's body, drawn smaller while it crouches, its facing line, and its name. */
function drawBody(
  ctx: BodyContext,
  body: Entity,
  { name, aim, crouched }: PlayerLook,
  isSelf: boolean,
): void {
  ctx.fillStyle = isSelf ? "#73cfff" : "#e1bd83";
  ctx.beginPath();
  ctx.arc(
    body.x,
    body.y,
    body.radius * (crouched ? CROUCHED_SCALE : 1),
    0,
    Math.PI * 2,
  );
  ctx.fill();

  drawFacing(ctx, body, aim, body.radius * 1.5);

  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.fillStyle = "#eee";
  ctx.fillText(name, body.x, body.y - body.radius - 8);
}

/** How far over a player's top its health bar shows, clear of its name. */
const PLAYER_BAR_ABOVE = 26;

/**
 * `body` drawn as another player looks to whoever sees it, as `look` has it: its body, facing and
 * name, the glyph `held` it holds, if any, and its health bar where a player's shows. For a body
 * passing itself off as a player.
 */
export function drawLikePlayer(
  ctx: BodyContext,
  body: Entity,
  look: PlayerLook,
  held: string | null,
): void {
  ctx.save();
  drawBody(ctx, body, look, false);
  if (held !== null) drawHeldItem(ctx, body, look.aim, held);
  ctx.restore();
  drawHealthBar(ctx, body, body.y - body.radius - PLAYER_BAR_ABOVE);
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

/** The colour of the ring round the item interacting would pick up. */
const TARGET_RING = "#ffe37a";

/**
 * A pulsing ring round `item`, the lying item interacting would pick up now, so the player sees
 * which of several at its feet it would take.
 */
function drawPickupTarget(
  ctx: CanvasRenderingContext2D,
  item: Point & { readonly radius: number },
  now: number,
): void {
  const pulse = 0.5 + 0.5 * Math.sin((now / 1000) * Math.PI * 3);
  ctx.save();
  ctx.strokeStyle = TARGET_RING;
  ctx.globalAlpha = 0.55 + 0.35 * pulse;
  ctx.lineWidth = 2;
  ctx.shadowColor = TARGET_RING;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(item.x, item.y, item.radius + 3 + pulse * 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** A red health bar at `barY`, shown only once a body that can fall has taken damage. */
export function drawHealthBar(
  ctx: Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect">,
  body: Entity,
  barY: number,
): void {
  const { health, maxHealth, radius } = body;
  if (!Number.isFinite(health) || health >= maxHealth || health <= 0) return;

  const width = radius * 2;
  const x = body.x - radius;
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(x - 1, barY - 1, width + 2, 5);
  ctx.fillStyle = "#d8473a";
  ctx.fillRect(x, barY, (width * health) / maxHealth, 3);
}

/**
 * A held item is a small glyph floating in front of its holder, a player or a monster carrying
 * it, at `facing` (radians); not a world body.
 */
export function drawHeldItem(
  ctx: TextContext,
  holder: Point & { readonly radius: number },
  facing: number,
  emoji: string,
): void {
  const distance = holder.radius + 4;
  ctx.save();
  ctx.fillStyle = EMOJI_FILL;
  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    emoji,
    holder.x + Math.cos(facing) * distance,
    holder.y + Math.sin(facing) * distance,
  );
  ctx.restore();
}

/** What drawing filled and stroked paths needs of a context. */
type PathContext = Pick<
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
>;

const LIT_WALL = { fill: "#4b525a", edge: "#5f6871" };

/**
 * Remembered floor and wall faces, drawn faint under everything: what is in sight is drawn over
 * them as usual.
 */
export function drawRemembered(
  ctx: PathContext &
    Pick<CanvasRenderingContext2D, "save" | "restore" | "globalAlpha" | "rect">,
  terrain: RememberedTerrain,
  { floor, wall }: MapMemoryConfig,
  cell: number,
): void {
  ctx.save();
  ctx.globalAlpha = floor.alpha;
  ctx.beginPath();
  for (const { x, y } of terrain.floor) ctx.rect(x, y, cell, cell);
  ctx.fillStyle = floor.fill;
  ctx.fill();
  ctx.strokeStyle = floor.grid;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = wall.alpha;
  drawLitWalls(ctx, terrain.walls, wall);
  ctx.restore();
}

/**
 * Lit wall faces, drawn outside the darkness clip: rays stop at wall faces, so walls are never
 * inside a visibility polygon. Shallow bands distinguish walls from both floor and darkness.
 */
export function drawLitWalls(
  ctx: PathContext,
  walls: VisibilityPolygon["walls"],
  colours: { readonly fill: string; readonly edge: string } = LIT_WALL,
): void {
  const depth = 4;
  ctx.fillStyle = colours.fill;
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

  ctx.strokeStyle = colours.edge;
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

/**
 * The cell of `map` holding `at` drawn as a wall seen from `viewer` looks: dark through, with a lit
 * band along each face that looks onto open floor on the viewer's side, as `drawLitWalls` draws a
 * real wall's. For a body passing itself off as a wall.
 */
export function drawWallBlock(
  ctx: PathContext & Pick<CanvasRenderingContext2D, "fillRect">,
  map: TileMap,
  at: Point,
  viewer: Point,
): void {
  const { cell } = map;
  const col = Math.floor(at.x / cell);
  const row = Math.floor(at.y / cell);
  const left = col * cell;
  const top = row * cell;
  const right = left + cell;
  const bottom = top + cell;
  ctx.fillStyle = "#000";
  ctx.fillRect(left, top, cell, cell);
  const sides = [
    {
      normal: { x: -1, y: 0 },
      from: { x: left, y: top },
      to: { x: left, y: bottom },
    },
    {
      normal: { x: 1, y: 0 },
      from: { x: right, y: top },
      to: { x: right, y: bottom },
    },
    {
      normal: { x: 0, y: -1 },
      from: { x: left, y: top },
      to: { x: right, y: top },
    },
    {
      normal: { x: 0, y: 1 },
      from: { x: left, y: bottom },
      to: { x: right, y: bottom },
    },
  ];
  const faces = sides.filter(
    ({ normal, from }) =>
      !isSolid(map, col + normal.x, row + normal.y) &&
      normal.x * (viewer.x - from.x) + normal.y * (viewer.y - from.y) > 0,
  );
  drawLitWalls(ctx, new Map([[0, faces]]));
}

/**
 * Each noise the local player heard lately, as of `now` in ms, as a ring spreading from where it
 * seemed to come from.
 */
/**
 * Draws each flash as of `time` in ms: a filled disc and its ring, fading out, with a shot's
 * tracer streaking in to it.
 */
export function drawFlashes(
  ctx: Pick<
    CanvasRenderingContext2D,
    | "save"
    | "restore"
    | "beginPath"
    | "arc"
    | "moveTo"
    | "lineTo"
    | "fill"
    | "stroke"
    | "fillStyle"
    | "strokeStyle"
    | "lineWidth"
    | "globalAlpha"
  >,
  flashes: Pick<Flashes, "config" | "list">,
  time: number,
): void {
  const { config } = flashes;
  for (const flash of flashes.list) {
    const disc = flashDisc(flash, time, config);
    if (disc === null) continue;
    ctx.save();
    if (disc.from !== undefined) {
      ctx.strokeStyle = config.tracer.colour;
      ctx.lineWidth = config.tracer.width;
      ctx.globalAlpha = disc.fade;
      ctx.beginPath();
      ctx.moveTo(disc.from.x, disc.from.y);
      ctx.lineTo(disc.x, disc.y);
      ctx.stroke();
    }
    ctx.fillStyle = disc.colour;
    ctx.strokeStyle = disc.colour;
    ctx.lineWidth = config.width;
    ctx.beginPath();
    ctx.arc(disc.x, disc.y, disc.radius, 0, Math.PI * 2);
    ctx.globalAlpha = disc.fade * config.fill;
    ctx.fill();
    ctx.globalAlpha = disc.fade;
    ctx.stroke();
    ctx.restore();
  }
}

/** Rings for `rings`, in world space. */
function drawRipples(
  ctx: CanvasRenderingContext2D,
  config: RippleConfig,
  rings: readonly Ripple[],
  now: number,
  camera: Camera,
): void {
  ctx.save();
  ctx.strokeStyle = config.colour;
  for (const ripple of rings) {
    const ring = rippleRing(ripple, now, config);
    if (ring === null || !inView(ring, camera)) continue;
    ctx.globalAlpha = ring.alpha;
    ctx.lineWidth = ring.width;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Where `point`, in world space, falls on the screen, in screen pixels. */
function onScreen(point: Point, camera: Camera): Point {
  return {
    x: (point.x - camera.x) / camera.zoom,
    y: (point.y - camera.y) / camera.zoom,
  };
}

/**
 * Soft glows at the screen's edge for `glows`, in screen space, each the way its noise seemed to
 * come from as seen from `listener`.
 */
function drawEdgeGlows(
  ctx: CanvasRenderingContext2D,
  config: RippleConfig,
  glows: readonly Ripple[],
  now: number,
  camera: Camera,
  listener: Point,
): void {
  const from = onScreen(listener, camera);
  ctx.save();
  for (const ripple of glows) {
    const glow = edgeGlow(
      ripple,
      now,
      config,
      camera.view,
      from,
      onScreen(ripple.at, camera),
    );
    if (glow === null) continue;
    const gradient = ctx.createRadialGradient(
      glow.x,
      glow.y,
      0,
      glow.x,
      glow.y,
      glow.radius,
    );
    gradient.addColorStop(0, config.edge.colour);
    gradient.addColorStop(1, "transparent");
    ctx.globalAlpha = glow.alpha;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(glow.x, glow.y, glow.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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

/** A canvas to composite into, kept between frames. */
interface Layer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

/** How many pixels the edges of sight and light fade out over. */
const EDGE_FADE = 16;

/**
 * The tints laid over the ground each kind of light reaches, faded at their edges: yellow where a
 * flashlight or the cruiser's headlights shine, a faint blue for sunlight out of doors, and a
 * faint warm white in a room lit by its fixture.
 */
const LIGHT_TINT = "rgba(255, 217, 138, 0.22)";
const AMBIENT_TINT: Readonly<Record<AmbientLight, string>> = {
  sun: "rgba(150, 190, 255, 0.12)",
  fixture: "rgba(255, 244, 214, 0.1)",
};

let sceneCache: Layer | null = null;
let maskCache: Layer | null = null;
let memoryCache: Layer | null = null;
let inkCache: Layer | null = null;

/**
 * Keeps what is drawn on `ctx` only as far as ink is left over `ages` (see `inkMask`): the mask,
 * a few spots to a cell, is drawn stretched and smoothed over the cells, so the ragged edge where
 * remembered terrain has faded is soft, as ink soaking away. `scratch` holds the mask.
 */
function fadeLikeInk(
  ctx: CanvasRenderingContext2D,
  scratch: Layer,
  ages: AgeGrid,
  fade: InkFadeConfig,
  cell: number,
): void {
  if (fade.seconds <= 0 || ages.cols <= 0 || ages.rows <= 0) return;
  const mask = inkMask(ages, fade);
  const layer = sized(scratch, mask.width, mask.height);
  layer.ctx.putImageData(
    new ImageData(mask.data, mask.width, mask.height),
    0,
    0,
  );
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    layer.canvas,
    ages.col * cell,
    ages.row * cell,
    ages.cols * cell,
    ages.rows * cell,
  );
  ctx.restore();
}

function createLayer(): Layer {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no 2d canvas context");
  return { canvas, ctx };
}

function sized(layer: Layer, width: number, height: number): Layer {
  if (layer.canvas.width !== width || layer.canvas.height !== height) {
    layer.canvas.width = width;
    layer.canvas.height = height;
  }
  return layer;
}

/** Runs `render` with the context transformed from world space to view space. */
function applyCamera(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  render: () => void,
): void {
  ctx.save();
  ctx.scale(1 / camera.zoom, 1 / camera.zoom);
  ctx.translate(-camera.x, -camera.y);
  render();
  ctx.restore();
}

/** Fills the union of `polygons` in the current path. */
function fillPolygons(
  ctx: CanvasRenderingContext2D,
  polygons: readonly VisibilityPolygon[],
): void {
  ctx.beginPath();
  for (const { points } of polygons) {
    const [first, ...rest] = points;
    if (first === undefined) continue;
    ctx.moveTo(first.x, first.y);
    rest.forEach((point) => {
      ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
  }
  ctx.fill();
}

/**
 * Renders the union of `polygons` onto `layer` in `colour`, its edge faded over `EDGE_FADE`
 * pixels. The canvas is padded so the fade does not bite into the view's border.
 */
function featheredMask(
  layer: Layer,
  polygons: readonly VisibilityPolygon[],
  camera: Camera,
  width: number,
  height: number,
  colour: string,
): Layer {
  const mask = startMask(layer, camera, width, height);
  mask.ctx.fillStyle = colour;
  fillPolygons(mask.ctx, polygons);
  mask.ctx.restore();
  return mask;
}

/**
 * `layer` sized to the view padded by `EDGE_FADE` all round and cleared, its context saved, then
 * set to blur what is drawn over the fade and to draw in world space. The caller restores it.
 */
function startMask(
  layer: Layer,
  camera: Camera,
  width: number,
  height: number,
): Layer {
  const pad = EDGE_FADE;
  const mask = sized(layer, width + pad * 2, height + pad * 2);
  const { ctx } = mask;
  ctx.clearRect(0, 0, mask.canvas.width, mask.canvas.height);
  ctx.save();
  ctx.filter = `blur(${String(EDGE_FADE / 2)}px)`;
  ctx.translate(pad, pad);
  ctx.scale(1 / camera.zoom, 1 / camera.zoom);
  ctx.translate(-camera.x, -camera.y);
  return mask;
}

/** Keeps `scene` only where `mask` reaches, its edge soft. */
function keepWithin(scene: Layer, mask: Layer): void {
  scene.ctx.save();
  scene.ctx.globalCompositeOperation = "destination-in";
  scene.ctx.drawImage(mask.canvas, -EDGE_FADE, -EDGE_FADE);
  scene.ctx.restore();
}

/** Takes the scene away wherever `mask` reaches, its edge soft: darkness no light lights. */
function unlight(scene: Layer, mask: Layer): void {
  scene.ctx.save();
  scene.ctx.globalCompositeOperation = "destination-out";
  scene.ctx.drawImage(mask.canvas, -EDGE_FADE, -EDGE_FADE);
  scene.ctx.restore();
}

/**
 * The lit wall faces of `walls` but those `dark` says lie in darkness, each judged by its
 * middle, a little out from the wall; all of them with no darkness given off.
 */
function outOfDarkness(
  walls: VisibilityPolygon["walls"],
  dark: ((point: Point) => boolean) | undefined,
): VisibilityPolygon["walls"] {
  if (dark === undefined) return walls;
  const kept = new Map<number, readonly WallFace[]>();
  for (const [key, faces] of walls) {
    const lit = faces.filter(
      ({ from, to, normal }) =>
        !dark({
          x: (from.x + to.x) / 2 + normal.x * SHROUD_WALL_INSET,
          y: (from.y + to.y) / 2 + normal.y * SHROUD_WALL_INSET,
        }),
    );
    if (lit.length > 0) kept.set(key, lit);
  }
  return kept;
}

/** How far out from a wall face its middle is judged for darkness, in pixels. */
const SHROUD_WALL_INSET = 2;

/** Wisps of smoke each shroud of darkness is drawn with, turning slowly about its heart. */
const SHROUD_WISPS = 7;
const SHROUD_SMOKE = "rgba(70, 52, 92, 0.22)";
const SHROUD_CLEAR = "rgba(70, 52, 92, 0)";

/**
 * Draws each of `darks` the viewer sees any of, from its heart or round its edge, as wisps of
 * dark smoke drifting about it, so darkness something gives off shows as a shape against the
 * night. Darkness in view but out of sight is not drawn, so it gives nothing away.
 */
function drawShrouds(
  ctx: CanvasRenderingContext2D,
  darks: readonly DarkSource[],
  sources: readonly VisionSource[],
  map: TileMap,
  camera: Camera,
  now: number,
): void {
  const seconds = now / 1000;
  for (const dark of darks) {
    if (!inView({ ...dark, radius: dark.range }, camera)) continue;
    const seen = [0, 1, 2, 3, 4, 5, 6, 7, 8].some((i) => {
      const angle = (i * Math.PI) / 4;
      const out = i === 8 ? 0 : dark.range * 0.7;
      const at = {
        x: dark.x + Math.cos(angle) * out,
        y: dark.y + Math.sin(angle) * out,
      };
      return sources.some((source) => canSeeFrom(map, source, at));
    });
    if (!seen) continue;
    for (let wisp = 0; wisp < SHROUD_WISPS; wisp++) {
      const turn = (wisp % 2 === 0 ? 1 : -1) * seconds * 0.25;
      const angle = (wisp * Math.PI * 2) / SHROUD_WISPS + turn;
      const breathe = 0.85 + 0.15 * Math.sin(seconds * 0.9 + wisp * 1.7);
      const out = dark.range * 0.45 * breathe;
      const x = dark.x + Math.cos(angle) * out;
      const y = dark.y + Math.sin(angle) * out;
      const size = dark.range * 0.55;
      const smoke = ctx.createRadialGradient(x, y, 0, x, y, size);
      smoke.addColorStop(0, SHROUD_SMOKE);
      smoke.addColorStop(1, SHROUD_CLEAR);
      ctx.fillStyle = smoke;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * A mask of the deepdark behind its front, at `front` pixels across the world, but where `lit`,
 * lights traced out to their reach into deepdark, reaches; edges soft, as `featheredMask`'s.
 */
function deepdarkMask(
  layer: Layer,
  front: number,
  lit: readonly VisibilityPolygon[],
  camera: Camera,
): Layer {
  const { width, height } = camera.view;
  const pad = EDGE_FADE;
  const mask = startMask(layer, camera, width, height);
  const { ctx } = mask;
  ctx.fillStyle = "#000";
  const left = camera.x - pad * camera.zoom;
  ctx.fillRect(
    left,
    camera.y - pad * camera.zoom,
    front - left,
    viewHeight(camera) + pad * 2 * camera.zoom,
  );
  ctx.globalCompositeOperation = "destination-out";
  fillPolygons(ctx, lit);
  ctx.restore();
  return mask;
}

/**
 * Whether the eyes of a body at `at` glow now, glimpsed for the deepdark config's `eyes.for`
 * seconds in each `eyes.every`, each body at a moment set by its id, so a pack does not blink
 * as one.
 */
function eyesGlow(game: Session, id: string, now: number): boolean {
  const { every, for: lasting } = game.config.deepdark.eyes;
  if (every <= 0) return false;
  let offset = 0;
  for (let i = 0; i < id.length; i++)
    offset = (offset * 31 + id.charCodeAt(i)) % 1000;
  const phase = (now / 1000 + (offset / 1000) * every) % every;
  return phase < lasting;
}

/**
 * The eyes of every body in deepdark that the viewer's sight reaches but no light shows, glowing
 * now and then: two points of the deepdark config's eye colour, set the way the body faces.
 * Drawn over the darkness, so the black gives away that something lurks there, and no more.
 */
function drawDeepdarkEyes(
  ctx: CanvasRenderingContext2D,
  game: Session,
  camera: Camera,
  now: number,
  viewer: Player,
  sources: readonly VisionSource[],
  darks: readonly DarkSource[],
): void {
  const { map } = game.world;
  const { colour } = game.config.deepdark.eyes;
  const bodies: Body[] = [
    ...game.entities.values(),
    ...[...game.players.values()].filter(
      (player) => player !== viewer && !isGhost(player) && !isAboard(player),
    ),
  ];
  ctx.save();
  ctx.fillStyle = colour;
  ctx.shadowColor = colour;
  for (const body of bodies) {
    if (!inView(body, camera) || !eyesGlow(game, body.id, now)) continue;
    if (!perceives(game, viewer.id, body.id)) continue;
    const sight = eyesOf(game, body);
    if (sight === null || !isDeepdark(game, body, darks)) continue;
    if (!sources.some((source) => canSeeFrom(map, source, body))) continue;
    const facing = sight.cone?.direction ?? Math.PI / 2;
    const ahead = body.radius * 0.45;
    const apart = body.radius * 0.3;
    const size = Math.max(1.5, body.radius * 0.12);
    ctx.shadowBlur = size * 4;
    for (const side of [-1, 1]) {
      const x =
        body.x +
        Math.cos(facing) * ahead +
        Math.cos(facing + Math.PI / 2) * apart * side;
      const y =
        body.y +
        Math.sin(facing) * ahead +
        Math.sin(facing + Math.PI / 2) * apart * side;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Lays `mask`'s warm shapes over the scene, only where the scene still shows. */
function layLight(scene: Layer, mask: Layer): void {
  scene.ctx.save();
  scene.ctx.globalCompositeOperation = "source-atop";
  scene.ctx.drawImage(mask.canvas, -EDGE_FADE, -EDGE_FADE);
  scene.ctx.restore();
}

/** Draws world entity `entity` as its kind does, with its stun, and its health bar if it shows one. */
function drawEntity(
  ctx: CanvasRenderingContext2D,
  game: Session,
  entity: WorldEntity,
  now: number,
): void {
  const definition = game.entityTypes.get(entity.kind);
  if (definition === undefined) return;
  ctx.save();
  // Each kind draws from an opaque fill, so a glyph it draws is never faint for what came before.
  ctx.fillStyle = EMOJI_FILL;
  definition.draw(ctx, entity, now, game);
  ctx.restore();
  if (isStunned(game, entity.id))
    drawStunned(ctx, entity, now, STUN_ABOVE.entity);
  if (definition.healthBar)
    drawHealthBar(ctx, entity, entity.y - entity.radius - 8);
}

/**
 * Every world entity and living player in view that `shows` lets through, but `but`, each with
 * its health bar; of the entities, only those the body `by` perceives, and, unless `dark`, none
 * of a kind seen in the dark, which `drawSeenInDark` draws over the darkness. A ghost is never
 * drawn.
 */
function drawBodies(
  ctx: CanvasRenderingContext2D,
  game: Session,
  camera: Camera,
  now: number,
  isAway: (id: string) => boolean,
  but: Player | null,
  shows: (body: Footprint) => boolean,
  by: string | null,
  dark: boolean,
): void {
  game.entities.forEach((entity) => {
    const definition = game.entityTypes.get(entity.kind);
    if (definition === undefined) return;
    if (definition.seenInDark && !dark) return;
    if (!perceives(game, by, entity.id)) return;
    if (!inView(entity, camera) || !shows(footprintOf(game, entity))) return;
    drawEntity(ctx, game, entity, now);
  });
  game.players.forEach((player) => {
    if (player === but || isGhost(player) || isAboard(player)) return;
    if (!inView(player, camera)) return;
    if (!shows(player)) return;
    drawPlayer(ctx, game, player, false, isAway(player.id));
    drawHealthBar(ctx, player, player.y - player.radius - PLAYER_BAR_ABOVE);
    if (isStunned(game, player.id))
      drawStunned(ctx, player, now, STUN_ABOVE.player);
  });
}

/**
 * Every world entity in view of a kind seen in the dark that `viewer` perceives and that any of
 * `sources`, its sight, reaches some part of, light or no light. Drawn over the darkness, so
 * nothing masks it.
 */
function drawSeenInDark(
  ctx: CanvasRenderingContext2D,
  game: Session,
  camera: Camera,
  now: number,
  viewer: Player,
  sources: readonly VisionSource[],
): void {
  const { map } = game.world;
  const reached = (point: Point): boolean =>
    sources.some((source) => canSeeFrom(map, source, point));
  game.entities.forEach((entity) => {
    if (game.entityTypes.get(entity.kind)?.seenInDark !== true) return;
    if (!perceives(game, viewer.id, entity.id) || !inView(entity, camera))
      return;
    const footprint = footprintOf(game, entity);
    const points = footprintPoints(
      footprint,
      game.config.vision.footprintSpacing,
    );
    if (points.some(reached)) drawEntity(ctx, game, entity, now);
  });
}

/** Every wall in view, drawn whole, as a free camera sees through them. */
function drawWalls(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  camera: Camera,
): void {
  const { cell, cols, rows, solid } = map;
  const minCol = Math.max(0, Math.floor(camera.x / cell));
  const maxCol = Math.min(
    cols - 1,
    Math.floor((camera.x + viewWidth(camera)) / cell),
  );
  const minRow = Math.max(0, Math.floor(camera.y / cell));
  const maxRow = Math.min(
    rows - 1,
    Math.floor((camera.y + viewHeight(camera)) / cell),
  );
  ctx.fillStyle = LIT_WALL.fill;
  ctx.strokeStyle = LIT_WALL.edge;
  ctx.lineWidth = 1;
  for (let row = minRow; row <= maxRow; row++)
    for (let col = minCol; col <= maxCol; col++) {
      if (solid[row * cols + col] !== 1) continue;
      ctx.fillRect(col * cell, row * cell, cell, cell);
      ctx.strokeRect(col * cell, row * cell, cell, cell);
    }
}

/**
 * A ghost's free camera: everything in view, through walls and darkness alike, with every noise
 * heard lately as a ring.
 */
function drawFree(
  ctx: CanvasRenderingContext2D,
  game: Session,
  camera: Camera,
  now: number,
  isAway: (id: string) => boolean,
  flashes: Flashes,
  ripples: Ripples,
): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, camera.view.width, camera.view.height);
  applyCamera(ctx, camera, () => {
    drawTerrain(ctx, game.world, camera);
    drawWalls(ctx, game.world.map, camera);
    drawBodies(ctx, game, camera, now, isAway, null, () => true, null, true);
    drawFlashes(ctx, flashes, now);
    drawRipples(ctx, ripples.config, ripples.list, now, camera);
  });
}

/** What a ghost's view says along the top of the screen: what it looks through, and the keys. */
function eyeText(eye: Eye): string | null {
  switch (eye.kind) {
    case "self":
      return null;
    case "watch":
      return `Dead · watching ${eye.player.name} · click to switch · Space: free camera`;
    case "free":
      return "Dead · free camera · WASD to move · Space: watch a player";
  }
}

/** Draws the ghost's banner along the top of the screen, if it is one. */
function drawEyeBanner(
  ctx: CanvasRenderingContext2D,
  eye: Eye,
  camera: Camera,
): void {
  const text = eyeText(eye);
  if (text === null) return;
  const { width } = camera.view;
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(0, 0, width, 28);
  ctx.font = "14px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#c9d4ff";
  ctx.fillText(text, width / 2, 14);
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
  const placed = { ...game.local, ...drawnLocal(game, alpha) };
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
 * player `isAway` picks out drawn as away, the blows seen landing as `flashes`, and what the
 * local player heard as `ripples`. What
 * the local player sees is added to `memory`, and what it remembers out of sight is drawn faint.
 */
export function draw(
  ctx: CanvasRenderingContext2D,
  simulation: Session,
  camera: Camera,
  now: number,
  alpha: number,
  mouse: Point,
  isAway: (id: string) => boolean,
  flashes: Flashes,
  ripples: Ripples,
  memory: MapMemory,
  eye: Eye = { kind: "self" },
): void {
  const game = interpolatedView(simulation, alpha, mouse);
  if (eye.kind === "free") {
    drawFree(ctx, game, camera, now, isAway, flashes, ripples);
    drawEyeBanner(ctx, eye, camera);
    return;
  }
  const viewer =
    eye.kind === "watch"
      ? (game.players.get(eye.player.id) ?? game.local)
      : game.local;
  const sources = visionOrigins(game, viewer);
  const lights = lightSources(game, viewer);
  const { map } = game.world;
  const { rays } = game.config.vision;
  const area = viewArea(camera);
  const daylight = daylightNow(game);
  const fronts = frontsNow(game);
  const ambient = (point: Point) =>
    ambientLightAt(game.world, point, daylight, fronts) !== null;
  // Darkness something gives off, which no light lights: nothing in it shows.
  const darks = darkSources(game);
  const deep = (point: Point) => isDeepdark(game, point, darks);
  // Deepdark no light lights but out to its reach into it.
  const unlitDeep = (point: Point) =>
    deep(point) &&
    !lights.some((light) => canSeeFrom(map, intoDeepdark(light), point));
  const dark = (point: Point) =>
    (darks.length > 0 && inDarkness(map, darks, point)) || unlitDeep(point);
  const sunlit = ambientPolygons(game.world, area, "sun", daylight, fronts);
  const fixtureLit = ambientPolygons(game.world, area, "fixture", 1, fronts);
  const seen = tracePolygons(map, sources, camera, rays);
  const lit = [
    ...tracePolygons(map, lights, camera, rays),
    ...sunlit,
    ...fixtureLit,
  ];
  const walls = outOfDarkness(litWalls(seen, lit), dark);
  // A stunned viewer sees nothing, so learns nothing of the map.
  const blind = blindness(game, viewer);
  if (blind === 0) memory.see({ seen, lit, walls }, area, now);

  const { width, height } = camera.view;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  // Remembered terrain, drawn on its own layer so the ink fading it eats into it alone; in
  // deepdark it fades faster.
  const { cell } = map;
  const { memoryFade } = game.config.deepdark;
  const remembered = memory.within(area, now, viewer, (col, row) =>
    nearDeepdark(game, { x: (col + 0.5) * cell, y: (row + 0.5) * cell }, darks)
      ? memoryFade
      : 1,
  );
  const recall = sized((memoryCache ??= createLayer()), width, height);
  recall.ctx.clearRect(0, 0, width, height);
  applyCamera(recall.ctx, camera, () => {
    drawRemembered(recall.ctx, remembered, memory.config, map.cell);
    fadeLikeInk(
      recall.ctx,
      (inkCache ??= createLayer()),
      remembered.ages,
      memory.config.fade,
      map.cell,
    );
  });
  ctx.drawImage(recall.canvas, 0, 0);

  // Inside the darkness: only what is both seen and lit, its edges faded, with the ground each
  // light reaches tinted its colour: sunlight blue, a room's fixture warm white, and an emissive
  // light such as a flashlight or the cruiser's headlights yellow.
  const scene = sized((sceneCache ??= createLayer()), width, height);
  const sceneCtx = scene.ctx;
  sceneCtx.clearRect(0, 0, width, height);
  applyCamera(sceneCtx, camera, () => {
    drawTerrain(sceneCtx, game.world, camera);
    drawBodies(
      sceneCtx,
      game,
      camera,
      now,
      isAway,
      viewer,
      (body) =>
        isBodyVisible(
          map,
          sources,
          lights,
          body,
          game.config.vision.footprintSpacing,
          ambient,
          dark,
        ),
      viewer.id,
      false,
    );
    drawFlashes(sceneCtx, flashes, now);
  });
  const mask = (maskCache ??= createLayer());
  keepWithin(scene, featheredMask(mask, seen, camera, width, height, "#fff"));
  keepWithin(scene, featheredMask(mask, lit, camera, width, height, "#fff"));

  for (const [polygons, colour] of [
    [sunlit, AMBIENT_TINT.sun],
    [fixtureLit, AMBIENT_TINT.fixture],
  ] as const) {
    if (polygons.length === 0) continue;
    layLight(
      scene,
      featheredMask(mask, polygons, camera, width, height, colour),
    );
  }
  // Each colour of emitted light laid on its own, a flare's red apart from a flashlight's yellow.
  const byTint = new Map<string, LightSource[]>();
  for (const light of emittedLights(game)) {
    const colour = light.tint ?? LIGHT_TINT;
    byTint.set(colour, [...(byTint.get(colour) ?? []), light]);
  }
  for (const [colour, emitted] of byTint) {
    const tint = featheredMask(
      mask,
      tracePolygons(map, emitted, camera, rays),
      camera,
      width,
      height,
      colour,
    );
    layLight(scene, tint);
  }
  if (darks.length > 0) {
    const shade = tracePolygons(map, darks, camera, rays);
    if (shade.length > 0)
      unlight(scene, featheredMask(mask, shade, camera, width, height, "#000"));
  }
  // Behind the deepdark front, all is black but what lights reach, out to their reach into it.
  if (fronts.deep > camera.x)
    unlight(
      scene,
      deepdarkMask(
        mask,
        fronts.deep,
        tracePolygons(map, lights.map(intoDeepdark), camera, rays),
        camera,
      ),
    );
  ctx.drawImage(scene.canvas, 0, 0);
  applyCamera(ctx, camera, () => {
    drawShrouds(ctx, darks, sources, map, camera, now);
    if (blind === 0)
      drawDeepdarkEyes(ctx, game, camera, now, viewer, sources, darks);
  });

  // What the local player hears: a ring for a player's noise or one whose maker it can see, a
  // glow at the screen's edge for any other.
  const seenMade = (ripple: Ripple): boolean =>
    blind === 0 &&
    (ripple.player ||
      (inView({ ...ripple.origin, radius: 0 }, camera) &&
        isVisible(map, sources, lights, ripple.origin, ambient, dark)));
  const rings = ripples.list.filter(seenMade);
  const glows = ripples.list.filter((ripple) => !seenMade(ripple));

  // Above the darkness: lit wall faces; a stunned viewer's blindness over all it would see;
  // then rings, the player and its HUD, then edge glows.
  applyCamera(ctx, camera, () => {
    drawLitWalls(ctx, walls);
    drawSeenInDark(ctx, game, camera, now, viewer, sources);
  });
  if (blind > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${String(blind)})`;
    ctx.fillRect(0, 0, width, height);
  }
  applyCamera(ctx, camera, () => {
    drawRipples(ctx, ripples.config, rings, now, camera);
    // The item E would pick up, chosen as the interaction chooses it, on the simulation proper,
    // and drawn where the view shows it.
    const target = eye.kind === "self" ? pickupTarget(simulation) : null;
    const shown = target === null ? undefined : game.entities.get(target.id);
    if (shown !== undefined) drawPickupTarget(ctx, shown, now);
    // Inside a vehicle, the viewer is out of sight in it, as every other occupant is.
    if (!isAboard(viewer)) drawPlayer(ctx, game, viewer, viewer === game.local);
    drawHealthBar(ctx, viewer, viewer.y - viewer.radius - PLAYER_BAR_ABOVE);
    drawStamina(ctx, viewer, game.config.stamina.max);
    if (isStunned(game, viewer.id))
      drawStunned(ctx, viewer, now, STUN_ABOVE.player);
  });
  if (glows.length > 0)
    drawEdgeGlows(ctx, ripples.config, glows, now, camera, viewer);
  drawClock(ctx, game, viewer, camera.view, now);
  drawEyeBanner(ctx, eye, camera);
}
