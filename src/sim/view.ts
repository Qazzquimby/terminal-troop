import { daylightNow } from "./day.js";
import type { Fronts } from "./light.js";
import {
  ambientLightAt,
  darkSources,
  frontsNow,
  inDarkness,
  intoDeepdark,
  isDeepdark,
} from "./light.js";
import type { DarkSource } from "./light.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";
import { shadowCasters, shadowsOf } from "./shadow.js";
import type { Occluder, ShadowsOf } from "./shadow.js";
import type { Footprint } from "./shape.js";
import { footprintPoints } from "./shape.js";
import {
  canSeeFrom,
  directionalVision,
  emittedLights,
  isBodyVisible,
  litFrom,
  sightLights,
} from "./vision.js";
import type { LightSource, VisionSource } from "./vision.js";

/*
 * What a viewer's screen shows, worked out on the sim so that the renderer and any rule asking
 * "would this viewer see it drawn?" use the one test and never disagree (#457). A body shows
 * where some part of it is both seen, from one of the viewer's vision sources along a clear line,
 * and lit: by a light that reaches it unshadowed, or by its place's own light, and not where
 * darkness given off or unlit deepdark swallows it.
 */

/** Whoever a view is of: where they stand and the way they aim. */
export interface Viewer extends Point {
  readonly id: string;
  readonly aim: number;
}

/** How a view is narrowed or widened from what the screen shows. */
export interface ViewOptions {
  /**
   * Whether the small circle the viewer sees all round it counts as a vision source; true by
   * default, as on screen. The light it gives stays either way, so what lies in the cone and in
   * the circle still shows.
   */
  readonly near?: boolean;
  /** Radians the view cone is widened by on each side; 0 by default, as on screen. */
  readonly margin?: number;
}

/**
 * Where `viewer` sees from: its view cone, unbounded but by walls, the circle round it unless
 * `near` is false, and the bodies it owns that grant it sight. Cheap: no light is looked at.
 */
function viewSources(
  game: Session,
  viewer: Viewer,
  { near = true, margin = 0 }: ViewOptions = {},
): VisionSource[] {
  const vision = {
    ...game.config.vision,
    coneAngle: game.config.vision.coneAngle + margin * 2,
  };
  const [cone, round] = directionalVision(viewer, viewer.aim, vision);
  const owned = [...game.entities.values()].filter(
    (entity) => entity.ownerId === viewer.id && entity.grantsVision,
  );
  return near ? [cone, round, ...owned] : [cone, ...owned];
}

/** Everything a view is worked out from, and the test of whether a body shows in it. */
export interface View {
  readonly sources: readonly VisionSource[];
  /** The viewer's own sight's lights, the first of `lights`. */
  readonly sight: readonly LightSource[];
  /** Every light the viewer sees by: its own sight's, then each given off. */
  readonly lights: readonly LightSource[];
  readonly occluders: readonly Occluder[];
  readonly shadows: ShadowsOf;
  readonly daylight: number;
  readonly fronts: Fronts;
  readonly darks: readonly DarkSource[];
  /** Whether the place's own light lights a point. */
  readonly ambient: (point: Point) => boolean;
  /** Whether a point is deepdark. */
  readonly deep: (point: Point) => boolean;
  /** Whether no light can show a point: darkness given off, or deepdark no light reaches. */
  readonly dark: (point: Point) => boolean;
  /** Whether any part of `body` shows on the viewer's screen. */
  readonly shows: (body: Footprint) => boolean;
}

/** `viewer`'s view of `game` as it stands, as its screen draws it. */
export function viewOf(
  game: Session,
  viewer: Viewer,
  options: ViewOptions = {},
): View {
  const sources = viewSources(game, viewer, options);
  const sight = sightLights(game, viewer);
  const lights = [...sight, ...emittedLights(game)];
  // Every body standing in a light given off or carried shadows it (#384).
  const occluders = shadowCasters(game);
  const shadows = shadowsOf(occluders);
  const { map } = game.world;
  const daylight = daylightNow(game);
  const fronts = frontsNow(game);
  const ambient = (point: Point): boolean =>
    ambientLightAt(game.world, point, daylight, fronts) !== null;
  // Darkness something gives off, which no light lights: nothing in it shows.
  const darks = darkSources(game);
  const deep = (point: Point): boolean => isDeepdark(game, point, darks);
  // Deepdark no light lights but out to its reach into it.
  const unlitDeep = (point: Point): boolean =>
    deep(point) &&
    !lights.some((light) =>
      litFrom(map, intoDeepdark(light), point, shadows(light)),
    );
  const dark = (point: Point): boolean =>
    (darks.length > 0 && inDarkness(map, darks, point)) || unlitDeep(point);
  const { footprintSpacing } = game.config.vision;
  const shows = (body: Footprint): boolean =>
    isBodyVisible(map, sources, lights, body, footprintSpacing, {
      ambient,
      dark,
      shadows,
    });
  return {
    sources,
    sight,
    lights,
    occluders,
    shadows,
    daylight,
    fronts,
    darks,
    ambient,
    deep,
    dark,
    shows,
  };
}

/**
 * Whether `body` shows on `viewer`'s screen, as `viewOf(...).shows` judges it, narrowed or widened
 * by `options`. It first asks only whether any part of the body is in sight, so a body out of
 * sight costs no look at the lights.
 */
export function showsTo(
  game: Session,
  viewer: Viewer,
  body: Footprint,
  options: ViewOptions = {},
): boolean {
  const sources = viewSources(game, viewer, options);
  const { map } = game.world;
  const points = footprintPoints(body, game.config.vision.footprintSpacing);
  const inSight = points.some((point) =>
    sources.some((source) => canSeeFrom(map, source, point)),
  );
  return inSight && viewOf(game, viewer, options).shows(body);
}
