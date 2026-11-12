import type { EnvResult } from "jimkit-env/client";
import { defineEnv, defineVars } from "jimkit-env/client";
import { z } from "zod";
import { WORLD_KINDS } from "./sim/index.js";

const env = defineEnv({
  vars: defineVars({
    VITE_SUPABASE_URL: {
      client: true,
      description:
        "Supabase project URL. Set together with the key for online play.",
    },
    VITE_SUPABASE_PUBLISHABLE_KEY: {
      client: true,
      description:
        "Supabase publishable key. Set together with the URL for online play.",
    },
    VITE_TRANSPORT: {
      client: true,
      description:
        'How online rooms carry messages: "supabase" (default), every message through Supabase Realtime, or "trystero", WebRTC data channels between the players with Supabase only introducing them.',
    },
    VITE_ICE_SERVERS: {
      client: true,
      description:
        'JSON array of RTCIceServer objects for the "trystero" transport, e.g. a TURN server for players who cannot connect directly. Unset keeps public STUN servers only.',
    },
    VITE_WORLD: {
      client: true,
      description:
        'World to play in: "standard" (default) or "dev", a one-screen square for testing.',
    },
  }),
  structure: {
    server: () => ({}),
    client: (flat) => {
      const url = flat.VITE_SUPABASE_URL ?? "";
      const publishableKey = flat.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
      const transport = flat.VITE_TRANSPORT ?? "";
      const iceServers = flat.VITE_ICE_SERVERS ?? "";
      const world = flat.VITE_WORLD ?? "";
      // Neither set: local-only play. One set: the schema reports what's missing.
      return {
        supabase:
          url === "" && publishableKey === "" ? null : { url, publishableKey },
        transport: transport === "" ? "supabase" : transport,
        iceServers: iceServers === "" ? null : parseJson(iceServers),
        world: world === "" ? "standard" : world,
      };
    },
  },
});

/** The value `text` holds as JSON, or `text` itself when it holds none, for the schema to reject. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().exactOptional(),
  credential: z.string().exactOptional(),
});

const ClientEnv = z.object({
  supabase: z
    .object({ url: z.url(), publishableKey: z.string().min(1) })
    .nullable(),
  transport: z.enum(["supabase", "trystero"]),
  iceServers: z.array(IceServer).nullable(),
  world: z.enum(WORLD_KINDS),
});

export type ClientEnv = z.infer<typeof ClientEnv>;
export type EnvMode = "development" | "production";

/** Values as Vite inlines them: pass literal `import.meta.env.X` accesses. */
interface EnvValues {
  readonly VITE_SUPABASE_URL: string | undefined;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string | undefined;
  readonly VITE_TRANSPORT: string | undefined;
  readonly VITE_ICE_SERVERS: string | undefined;
  readonly VITE_WORLD: string | undefined;
}

export function loadClientEnv(
  values: EnvValues,
  mode: EnvMode,
): EnvResult<ClientEnv> {
  const result = env.loadClient({
    files: [values],
    schemas: { development: ClientEnv, production: ClientEnv },
    mode,
  });
  return result.success ? { success: true, data: result.data.client } : result;
}
