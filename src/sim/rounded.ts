import { z } from "zod";

/**
 * A number that travels rounded to `decimals` places, which keeps it short as JSON; what
 * arrives is taken as it is. `schema` checks the number both ways.
 */
export function rounded(decimals: number, schema = z.number()) {
  const scale = 10 ** decimals;
  return z.codec(schema, schema, {
    decode: (wire) => wire,
    encode: (value) => Math.round(value * scale) / scale,
  });
}
