import { cabinGamble, credit } from "../sim/index.js";
import type { CabinGamble } from "../sim/index.js";
import { button, make } from "./cabin.js";
import type { CabinPanel, CabinSend } from "./cabin.js";
import { creditText } from "./hud.js";

/*
 * The cabin's coin toss: double or nothing on the team's credit. The bet is picked here, on this
 * client alone; the toss itself goes to the vehicle through `send`, and the host decides how the
 * coin comes down, so every occupant sees the same coin and the same outcome.
 */

/** `bet` kept to what the team can stake: a whole credit at least, and no more than it has. */
export function clampBet(bet: number, banked: number): number {
  return Math.max(1, Math.min(Math.floor(bet), Math.floor(banked)));
}

/** What the coin panel says under the coin: who has the coin up, else how the last one landed. */
export function tossCaption(gamble: CabinGamble): string {
  const { tossing, last } = gamble;
  if (tossing !== null)
    return `${tossing.by} bets ${creditText(tossing.bet)}...`;
  if (last === null) return "call it. double or nothing.";
  return last.won
    ? `${last.by} WON ${creditText(last.bet * 2)}!!`
    : `${last.by} lost ${creditText(last.bet)}. ouch`;
}

/** What the coin's face shows: a question while it is up, else how the last came down. */
const face = (gamble: CabinGamble): string => {
  if (gamble.tossing !== null || gamble.last === null) return "?";
  return gamble.last.won ? "$" : "✕";
};

/**
 * The coin toss: a bet picked with − and + (or ALL IN), and FLIP, which stakes it from the team's
 * credit. The coin spins while it is up, and lands showing a win or a loss.
 */
export function coinTossPanel(send: CabinSend): CabinPanel {
  const element = make("section", "cabin-panel cabin-coin");
  const title = make("h3", "cabin-title", "DOUBLE-OR-NOTHING™ (coin)");
  const coin = make("div", "cabin-coin-face", "?");
  const caption = make("p", "cabin-caption cabin-coin-caption");
  let bet = 1;
  let banked = 0;
  const amount = make("span", "cabin-bet-amount");
  const setBet = (to: number): void => {
    bet = clampBet(to, banked);
    amount.textContent = creditText(bet);
  };
  const less = button("cabin-bet-step", "−", () => {
    setBet(bet - 1);
  });
  const more = button("cabin-bet-step", "+", () => {
    setBet(bet + 1);
  });
  const all = button("cabin-bet-all", "ALL IN", () => {
    setBet(banked);
  });
  const flip = button("cabin-flip", "FLIP ⟳", () => {
    send({ toss: bet });
  });
  const stake = make("div", "cabin-bet");
  stake.append(less, amount, more, all);
  element.append(title, coin, caption, stake, flip);
  setBet(bet);
  let landed: number | null = null;
  return {
    element,
    update(view, game) {
      const gamble = cabinGamble(game, view.vehicle);
      element.hidden = gamble === null;
      if (gamble === null) return;
      banked = credit.get(game);
      if (bet > banked && banked >= 1) setBet(banked);
      const up = gamble.tossing !== null;
      const broke = banked < 1;
      flip.disabled = up || broke || bet > banked;
      less.disabled = up || bet <= 1;
      more.disabled = up || bet >= banked;
      all.disabled = up || broke;
      coin.classList.toggle("cabin-coin-spinning", up);
      const n = gamble.last?.n ?? 0;
      // A toss that came down before this cabin first showed lands without a show.
      landed ??= n;
      if (!up && n !== landed) {
        landed = n;
        coin.classList.remove("cabin-coin-won", "cabin-coin-lost");
        // Read layout so the landing animation starts again for a toss that lands like the last.
        coin.getBoundingClientRect();
        coin.classList.add(
          gamble.last?.won === true ? "cabin-coin-won" : "cabin-coin-lost",
        );
      }
      const shown = face(gamble);
      if (coin.textContent !== shown) coin.textContent = shown;
      const text = broke && !up ? "no credit to bet" : tossCaption(gamble);
      if (caption.textContent !== text) caption.textContent = text;
    },
  };
}
