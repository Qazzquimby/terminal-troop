import { NetEvent } from "./config.js";

export function applyWallEdit(game, { col, row, solid, duration }) {
  const { map } = game.world;
  const index = row * map.cols + col;
  const edit = game.wallEdits.get(index) ?? { original: map.solid[index] };
  edit.left = duration;
  game.wallEdits.set(index, edit);
  map.solid[index] = solid ? 1 : 0;
}

export function requestWallEdit(game, net, edit) {
  applyWallEdit(game, edit);
  net.send(NetEvent.WALL_EDIT, edit);
}

export function tickWallEdits(game, dt) {
  const { map } = game.world;
  for (const [index, edit] of game.wallEdits) {
    edit.left -= dt;
    if (edit.left > 0) continue;
    map.solid[index] = edit.original;
    game.wallEdits.delete(index);
  }
}