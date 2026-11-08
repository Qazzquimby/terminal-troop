import { Shape } from "./config.js";

export function drawShape(ctx, player, def, color, isSelf) {
  ctx.beginPath();
  if (def.shape === Shape.CIRCLE) {
    ctx.arc(player.x, player.y, def.radius, 0, Math.PI * 2);
  } else if (def.shape === Shape.SQUARE) {
    ctx.rect(player.x - def.radius, player.y - def.radius, def.radius * 2, def.radius * 2);
  } else {
    const r = def.radius;
    ctx.moveTo(player.x, player.y - r);
    ctx.lineTo(player.x + r * 0.866, player.y + r * 0.5);
    ctx.lineTo(player.x - r * 0.866, player.y + r * 0.5);
    ctx.closePath();
  }

  ctx.fillStyle = color;
  ctx.fill();

  if (isSelf) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

export function drawSymbol(ctx, player, def) {
  ctx.font = `${Math.round(def.radius * 1.5)}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(def.symbol, player.x, player.y);
  ctx.textBaseline = "alphabetic";
}

export function drawLabel(ctx, player, def) {
  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.fillStyle = "#ddd";
  ctx.fillText(player.name, player.x, player.y - def.radius - 10);
}
