export { isSweepFree } from "./collision.js";
export {
  applyEntitySnapshot,
  cueEntities,
  entitySnapshot,
  registerEntityType,
  spawnEntity,
} from "./entities.js";
export type { EntityDefinition, Strike, WorldEntity } from "./entities.js";
export { kindId } from "./kinds.js";
export type { EntityKind } from "./kinds.js";
export { CruiserKind, createCruiser } from "./cruiser.js";
export type { CruiserConfig } from "./cruiser.js";
export { renderAim, renderPosition } from "./interpolation.js";
export type { Interpolated } from "./interpolation.js";
export { addItem, createInventory, heldEmoji } from "./inventory.js";
export type { HeldSlot, Inventory, ItemDefinition } from "./inventory.js";
export {
  isAreaFree,
  mulberry32,
  mulberry32Next,
  randomFreePosition,
  WORLD_KINDS,
} from "./map.js";
export type {
  Point,
  Rng,
  TileMap,
  ViewConfig,
  World,
  WorldKind,
} from "./map.js";
export { applyDamage } from "./entity.js";
export type { Entity } from "./entity.js";
export { aimAt, createPlayer, playerState } from "./player.js";
export type { Controls, Player } from "./player.js";
export { registerItem, requestUse, showUse } from "./use.js";
export type { ItemBehaviour, ItemUse, UseRequest } from "./use.js";

export {
  applyRemoteState,
  createSession,
  remotePlayers,
  removePlayer,
  updateSession,
} from "./session.js";
export type { Session, SimConfig } from "./session.js";
export { createSimClock } from "./sim-clock.js";
export type { SimClockConfig } from "./sim-clock.js";
export {
  canSeeFrom,
  directionalVision,
  isVisible,
  lightSources,
  litWalls,
  visibilityPolygon,
  visionOrigins,
} from "./vision.js";
export type { VisibilityPolygon, VisionSource } from "./vision.js";
