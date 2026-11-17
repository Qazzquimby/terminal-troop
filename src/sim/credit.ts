import { z } from "zod";
import { worldData } from "./world-data.js";

/**
 * The team's credit: what its scrap has sold for, less what it has spent at a vehicle's shop and
 * on revivals. Revivals may put it in debt, below 0. Shared by everyone in the world. The host alone changes it; every client holds it.
 */
export const credit = worldData({
  schema: z.number(),
  initial: 0,
});
