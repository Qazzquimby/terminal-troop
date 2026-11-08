import { AbilitySlot, RELATION_COLORS, ROUND_WARNING_S, Status } from "./config.js";
import { CLASS_DEFS } from "./classes/index.js";

function deltaArrow(delta) {
  if (delta > 0) return "▲";
  if (delta < 0) return "▼";
  return "";
}

export function renderScoreboard(listEl, standings) {
  const rows = standings.map((row) => {
    const item = document.createElement("li");
    item.className = "score-row";
    item.style.backgroundColor = RELATION_COLORS[row.relation];

    const identity = document.createElement("span");
    identity.textContent = `${row.rank}. ${row.name}`;

    const score = document.createElement("span");
    score.textContent = `${row.score} ${deltaArrow(row.delta)}`.trim();

    item.append(identity, score);
    return item;
  });

  listEl.replaceChildren(...rows);
}

export function renderRoundTimer(element, secondsLeft) {
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  element.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
  element.classList.toggle("warning", secondsLeft <= ROUND_WARNING_S);
}

export function renderRoundResult(element, result, now) {
  if (!result || now >= result.until) {
    element.hidden = true;
    return;
  }

  element.textContent = result.winnerName
    ? `${result.winnerName} wins with ${result.winnerScore}`
    : "Round over – no winner";
  element.hidden = false;
}

function buildAbilitySlots(container, classId) {
  const slots = [];

  for (const slot of Object.values(AbilitySlot)) {
    const ability = CLASS_DEFS[classId][slot];
    if (!ability) continue;

    const slotEl = document.createElement("div");
    slotEl.className = "ability-slot";

    const fillEl = document.createElement("div");
    fillEl.className = "ability-fill";

    const textEl = document.createElement("span");
    textEl.className = "ability-text";

    slotEl.append(fillEl, textEl);
    container.append(slotEl);
    slots.push({ slot, ability, fillEl, textEl, slotEl });
  }

  return slots;
}

export function createAbilityHud(container) {
  let classId = null;
  let slots = [];

  return function updateAbilityHud(player) {
    if (!player || player.status !== Status.ALIVE) {
      container.hidden = true;
      return;
    }

    container.hidden = false;
    if (player.classId !== classId) {
      classId = player.classId;
      slots = buildAbilitySlots(container, classId);
    }

    for (const { slot, ability, fillEl, textEl, slotEl } of slots) {
      const remaining = player.cooldowns[slot];
      const level = ability.meter?.(player);
      const value = level === undefined ? remaining / ability.cooldown : level;
      const fill = Math.max(0, Math.min(1, value)) * 100;
      fillEl.style.width = `${fill}%`;
      textEl.textContent = remaining > 0
        ? `${ability.label || ""} ${remaining.toFixed(1)}`.trim()
        : ability.label || "";
      slotEl.classList.toggle(
        "ready",
        level !== undefined ? level >= 1 : remaining <= 0,
      );
    }
  };
}

export function createClassPicker(container, onSelect) {
  const buttons = new Map();

  Object.entries(CLASS_DEFS).forEach(([classId, definition], index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${index + 1} ${definition.name}`;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => onSelect(Number(classId)));
    container.append(button);
    buttons.set(Number(classId), button);
  });

  return function updateClassPicker(enabled, selectedId) {
    for (const [classId, button] of buttons) {
      button.disabled = !enabled;
      button.setAttribute("aria-pressed", String(classId === selectedId));
    }
  };
}
