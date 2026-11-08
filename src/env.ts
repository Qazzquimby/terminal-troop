import type { EnvResult } from "jimkit-env/client";
import { defineEnv, defineVars } from "jimkit-env/client";
import { z } from "zod";

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
  }),
  structure: {
    server: () => ({}),
    client: (flat) => {
      const url = flat.VITE_SUPABASE_URL ?? "";
      const publishableKey = flat.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
      // Neither set: local-only play. One set: the schema reports what's missing.
      return {
        supabase:
          url === "" && publishableKey === "" ? null : { url, publishableKey },
      };
    },
  },
});

const ClientEnv = z.object({
  supabase: z
    .object({ url: z.url(), publishableKey: z.string().min(1) })
    .nullable(),
});

export type ClientEnv = z.infer<typeof ClientEnv>;
export type EnvMode = "development" | "production";

/** Values as Vite inlines them: pass literal `import.meta.env.X` accesses. */
interface EnvValues {
  readonly VITE_SUPABASE_URL: string | undefined;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string | undefined;
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
