/** The element matching `selector` under `root`; throws if it is missing or of another type. */
export function element<T extends Element>(
  selector: string,
  type: new () => T,
  root: ParentNode = document,
): T {
  const found = root.querySelector(selector);
  if (!(found instanceof type))
    throw new Error(`Missing ${type.name} ${selector}`);
  return found;
}
