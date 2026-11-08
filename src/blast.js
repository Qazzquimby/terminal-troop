import { NetEvent, Status } from "./config.js";
import { applyKnockback } from "./player.js";

function blastImpulses(players, centers, { radius, impulse }) {
  const impulses = new Map();

  for (const player of players) {
    if (player.status !== Status.ALIVE) continue;

    let dvx = 0;
    let dvy = 0;
    for (const center of centers) {
      const dx = player.x - center.x;
      const dy = player.y - center.y;
      const distance = Math.hypot(dx, dy);
      if (distance >= radius) continue;

      const strength = impulse * (1 - distance / radius);
      const divisor = Math.max(distance, 1);
      dvx += (dx / divisor) * strength;
      dvy += (dy / divisor) * strength;
    }

    if (dvx !== 0 || dvy !== 0) impulses.set(player, { dvx, dvy });
  }

  return impulses;
}

export function applyBlast(game, net, ownerId, centers, blast) {
  for (const [player, impulse] of blastImpulses(game.players.values(), centers, blast)) {
    const isOwner = player.id === ownerId;
    const stun = isOwner ? 0 : blast.stun;
    if (isOwner || player.isDummy) {
      applyKnockback(player, impulse.dvx, impulse.dvy, stun);
    } else {
      net.send(NetEvent.IMPULSE, {
        target: player.id,
        dvx: impulse.dvx,
        dvy: impulse.dvy,
        stun,
      });
    }
  }
}