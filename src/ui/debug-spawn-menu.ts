/** One thing the spawn menu offers: what it shows, the group it is listed under, and its key. */
interface MenuChoice {
  readonly label: string;
  /** The kind's name or item's id, matched by the filter as well as the label. */
  readonly kind: string;
  /** The heading it is listed under, such as "monster" or "item". */
  readonly what: string;
}

/**
 * The choices `filter` keeps, in order: those whose label, key or group holds every word of it,
 * ignoring case. All of them for an empty filter.
 */
export function filterChoices<T extends MenuChoice>(
  choices: readonly T[],
  filter: string,
): T[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return choices.filter((choice) => {
    const text = `${choice.label} ${choice.kind} ${choice.what}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** A key that changes whenever the choices offered do. */
const keyOf = (choices: readonly MenuChoice[]): string =>
  choices.map(({ what, kind }) => `${what}:${kind}`).join("\n");

/**
 * The debug spawn menu in `root`: a filter field over a list of buttons, one per choice, grouped
 * by what each is. Clicking one calls `pick` with it, as Enter in the filter does with the first
 * shown. While the filter has focus the game's keys type into it; clicking the game leaves it.
 */
export function createSpawnMenu<T extends MenuChoice>(
  root: HTMLElement,
  pick: (choice: T) => void,
) {
  const form = document.createElement("form");
  const filter = document.createElement("input");
  filter.type = "search";
  filter.placeholder = "spawn… (Enter picks the first)";
  filter.className = "debug-spawn-filter";
  filter.setAttribute("aria-label", "Filter what to spawn");
  const list = document.createElement("div");
  list.className = "debug-spawn-list";
  form.append(filter);
  root.replaceChildren(form, list);
  root.hidden = true;

  let choices: readonly T[] = [];
  let key = "";
  let shown: T[] = [];

  const render = (): void => {
    shown = filterChoices(choices, filter.value);
    const nodes: HTMLElement[] = [];
    let group: string | null = null;
    for (const choice of shown) {
      if (choice.what !== group) {
        group = choice.what;
        const heading = document.createElement("p");
        heading.className = "debug-spawn-group";
        heading.textContent = group;
        nodes.push(heading);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = choice.label;
      button.title = choice.kind;
      button.addEventListener("click", () => {
        pick(choice);
      });
      nodes.push(button);
    }
    list.replaceChildren(...nodes);
  };

  filter.addEventListener("input", render);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const first = shown[0];
    if (first !== undefined) pick(first);
  });

  return {
    /** Shows or hides the menu; it starts hidden. */
    setVisible(visible: boolean): void {
      root.hidden = !visible;
      if (!visible && document.activeElement === filter) filter.blur();
    },
    /** Offers `next`; the list is rebuilt only when what it offers changes. */
    setChoices(next: readonly T[]): void {
      const nextKey = keyOf(next);
      if (nextKey === key) return;
      key = nextKey;
      choices = next;
      render();
    },
  };
}
