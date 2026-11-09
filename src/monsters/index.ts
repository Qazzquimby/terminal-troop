import {
  mulberry32,
  randomFreePosition,
  registerEntityType,
  spawnEntity,
} from "../sim/index.js";
import type { Point, Rng, Session } from "../sim/index.js";
import { chaser, freshChaser } from "./chaser.js";
import type { ChaserConfig } from "./chaser.js";

/** The monsters a world starts with, and how they behave. */
export interface MonsterConfig {
  /** Chasers a new world starts with. */
  readonly chasers: number;
  /** Mixed with the room's seed to place them. */
  readonly seed: number;
  /** Least distance, in pixels, from every player a monster starts at, where the world has room. */
  readonly clearance: number;
  readonly chaser: ChaserConfig;
}

export const MonsterKind = { CHASER: 1 } as const;

/** Random spots tried for each monster before taking the one furthest from the players. */
const SPAWN_ATTEMPTS = 64;

/** Registers every monster kind with `game`. */
export function registerMonsters(game: Session, config: MonsterConfig): void {
  registerEntityType(game, MonsterKind.CHASER, chaser(config.chaser));
}

function distanceToPlayers(game: Session, point: Point): number {
  let nearest = Infinity;
  for (const player of game.players.values()) {
    nearest = Math.min(
      nearest,
      Math.hypot(player.x - point.x, player.y - point.y),
    );
  }
  return nearest;
}

function spawnPoint(
  game: Session,
  rng: Rng,
  radius: number,
  clearance: number,
): Point {
  let best = randomFreePosition(game.world, radius, rng);
  let bestDistance = distanceToPlayers(game, best);
  for (
    let attempt = 1;
    attempt < SPAWN_ATTEMPTS && bestDistance < clearance;
    attempt++
  ) {
    const point = randomFreePosition(game.world, radius, rng);
    const distance = distanceToPlayers(game, point);
    if (distance > bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

/** Spawns the monsters a new world starts with, at spots seeded by the room, away from the players. */
export function spawnMonsters(game: Session, config: MonsterConfig): void {
  const rng = mulberry32(game.seed ^ config.seed);
  for (let i = 0; i < config.chasers; i++) {
    const at = spawnPoint(game, rng, config.chaser.radius, config.clearance);
    spawnEntity(
      game,
      MonsterKind.CHASER,
      at.x,
      at.y,
      freshChaser(Math.floor(rng() * 2 ** 32)),
    );
  }
}
