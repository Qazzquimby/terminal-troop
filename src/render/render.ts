import type {
  AmbientLight,
  Entity,
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
  AREA,
  aimAt,
  ambientLightAt,
  ambientPolygons,
  emittedLights,
  heldItemOf,
  isGhost,
  isStunned,
  isVisible,
  stunLeft,
  lightSources,
  litWalls,
  movement,
  renderAim,
  drawnLocal,
  renderPosition,
  visibilityPolygon,
  visionOrigins,
} from "../sim/index.js";
import type { Camera } from "./camera.js";
import type { Eye } from "./spectate.js";
import type {
  Area,
  MapMemory,
  MapMemoryConfig,
  RememberedTerrain,
} from "./map-memory.js";
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
  drawBody(ctx, player, isSelf);
  if (player.use !== null)
    game.items.get(player.use.item)?.draw?.(ctx, player.use, game.time);
  const held = heldItemOf(game, player);
  if (held !== null) drawHeldItem(ctx, player, player.aim, held.emoji);
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

/** A player's body, drawn smaller while it crouches, its facing line, and its name. */
function drawBody(
  ctx: CanvasRenderingContext2D,
  player: Player,
  isSelf: boolean,
): void {
  const crouched = movement.get(player).mode === "crouch";
  ctx.fillStyle = isSelf ? "#73cfff" : "#e1bd83";
  ctx.beginPath();
  ctx.arc(
    player.x,
    player.y,
    player.radius * (crouched ? CROUCHED_SCALE : 1),
    0,
    Math.PI * 2,
  );
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
  const pad = EDGE_FADE;
  const mask = sized(layer, width + pad * 2, height + pad * 2);
  const { ctx } = mask;
  ctx.clearRect(0, 0, mask.canvas.width, mask.canvas.height);
  ctx.save();
  ctx.filter = `blur(${String(EDGE_FADE / 2)}px)`;
  ctx.translate(pad, pad);
  ctx.scale(1 / camera.zoom, 1 / camera.zoom);
  ctx.translate(-camera.x, -camera.y);
  ctx.fillStyle = colour;
  fillPolygons(ctx, polygons);
  ctx.restore();
  return mask;
}

/** Keeps `scene` only where `mask` reaches, its edge soft. */
function keepWithin(scene: Layer, mask: Layer): void {
  scene.ctx.save();
  scene.ctx.globalCompositeOperation = "destination-in";
  scene.ctx.drawImage(mask.canvas, -EDGE_FADE, -EDGE_FADE);
  scene.ctx.restore();
}

/** Lays `mask`'s warm shapes over the scene, only where the scene still shows. */
function layLight(scene: Layer, mask: Layer): void {
  scene.ctx.save();
  scene.ctx.globalCompositeOperation = "source-atop";
  scene.ctx.drawImage(mask.canvas, -EDGE_FADE, -EDGE_FADE);
  scene.ctx.restore();
}

/**
 * Every world entity and living player in view that `shows` lets through, but `but`, each with
 * its health bar. A ghost is never drawn.
 */
function drawBodies(
  ctx: CanvasRenderingContext2D,
  game: Session,
  camera: Camera,
  now: number,
  isAway: (id: string) => boolean,
  but: Player | null,
  shows: (body: Circle) => boolean,
): void {
  game.entities.forEach((entity) => {
    const definition = game.entityTypes.get(entity.kind);
    if (definition === undefined) return;
    if (!inView(entity, camera) || !shows(entity)) return;
    ctx.save();
    // Each kind draws from an opaque fill, so a glyph it draws is never faint for what came before.
    ctx.fillStyle = EMOJI_FILL;
    definition.draw(ctx, entity, now, game);
    ctx.restore();
    if (isStunned(game, entity.id))
      drawStunned(ctx, entity, now, STUN_ABOVE.entity);
    drawHealthBar(ctx, entity, entity.y - entity.radius - 8);
  });
  game.players.forEach((player) => {
    if (player === but || isGhost(player) || !inView(player, camera)) return;
    if (!shows(player)) return;
    drawPlayer(ctx, game, player, false, isAway(player.id));
    drawHealthBar(ctx, player, player.y - player.radius - 26);
    if (isStunned(game, player.id))
      drawStunned(ctx, player, now, STUN_ABOVE.player);
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
    drawBodies(ctx, game, camera, now, isAway, null, () => true);
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
  const ambient = (point: Point) => ambientLightAt(game.world, point) !== null;
  const sunlit = ambientPolygons(game.world, area, "sun");
  const fixtureLit = ambientPolygons(game.world, area, "fixture");
  const seen = tracePolygons(map, sources, camera, rays);
  const lit = [
    ...tracePolygons(map, lights, camera, rays),
    ...sunlit,
    ...fixtureLit,
  ];
  const walls = litWalls(seen, lit);
  // A stunned viewer sees nothing, so learns nothing of the map.
  const blind = blindness(game, viewer);
  if (blind === 0) memory.see({ seen, lit, walls }, area);

  const { width, height } = camera.view;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  applyCamera(ctx, camera, () => {
    drawRemembered(ctx, memory.within(area), memory.config, map.cell);
  });

  // Inside the darkness: only what is both seen and lit, its edges faded, with the ground each
  // light reaches tinted its colour: sunlight blue, a room's fixture warm white, and an emissive
  // light such as a flashlight or the cruiser's headlights yellow.
  const scene = sized((sceneCache ??= createLayer()), width, height);
  const sceneCtx = scene.ctx;
  sceneCtx.clearRect(0, 0, width, height);
  applyCamera(sceneCtx, camera, () => {
    drawTerrain(sceneCtx, game.world, camera);
    drawBodies(sceneCtx, game, camera, now, isAway, viewer, (body) =>
      isVisible(map, sources, lights, body, ambient),
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
  const emitted = emittedLights(game);
  if (emitted.length > 0) {
    const tint = featheredMask(
      mask,
      tracePolygons(map, emitted, camera, rays),
      camera,
      width,
      height,
      LIGHT_TINT,
    );
    layLight(scene, tint);
  }
  ctx.drawImage(scene.canvas, 0, 0);

  // What the local player hears: a ring for a player's noise or one whose maker it can see, a
  // glow at the screen's edge for any other.
  const seenMade = (ripple: Ripple): boolean =>
    blind === 0 &&
    (ripple.player ||
      (inView({ ...ripple.origin, radius: 0 }, camera) &&
        isVisible(map, sources, lights, ripple.origin, ambient)));
  const rings = ripples.list.filter(seenMade);
  const glows = ripples.list.filter((ripple) => !seenMade(ripple));

  // Above the darkness: lit wall faces; a stunned viewer's blindness over all it would see;
  // then rings, the player and its HUD, then edge glows.
  applyCamera(ctx, camera, () => {
    drawLitWalls(ctx, walls);
  });
  if (blind > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${String(blind)})`;
    ctx.fillRect(0, 0, width, height);
  }
  applyCamera(ctx, camera, () => {
    drawRipples(ctx, ripples.config, rings, now, camera);
    drawPlayer(ctx, game, viewer, viewer === game.local);
    drawHealthBar(ctx, viewer, viewer.y - viewer.radius - 26);
    drawStamina(ctx, viewer, game.config.stamina.max);
    if (isStunned(game, viewer.id))
      drawStunned(ctx, viewer, now, STUN_ABOVE.player);
  });
  if (glows.length > 0)
    drawEdgeGlows(ctx, ripples.config, glows, now, camera, viewer);
  drawEyeBanner(ctx, eye, camera);
}
