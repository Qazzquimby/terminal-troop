import { expect, test } from "vitest";
import { loadClientEnv } from "./env.js";

const URL = "https://example.supabase.co";

const UNSET = {
  VITE_SUPABASE_URL: undefined,
  VITE_SUPABASE_PUBLISHABLE_KEY: undefined,
  VITE_WORLD: undefined,
};

test("no Supabase vars means local-only play", () => {
  const result = loadClientEnv(UNSET, "development");
  expect(result).toEqual({
    success: true,
    data: { supabase: null, world: "standard" },
  });
});

test("empty strings count as unset", () => {
  const result = loadClientEnv(
    {
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_PUBLISHABLE_KEY: "",
      VITE_WORLD: "",
    },
    "production",
  );
  expect(result).toEqual({
    success: true,
    data: { supabase: null, world: "standard" },
  });
});

test("both vars set configures Supabase", () => {
  const result = loadClientEnv(
    { ...UNSET, VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: "pk" },
    "development",
  );
  expect(result).toEqual({
    success: true,
    data: { supabase: { url: URL, publishableKey: "pk" }, world: "standard" },
  });
});

test("one var without the other is an error naming the missing one", () => {
  const result = loadClientEnv(
    { ...UNSET, VITE_SUPABASE_URL: URL },
    "development",
  );
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.message).toContain("publishableKey");
});

test("a malformed URL is an error that does not echo the value", () => {
  const result = loadClientEnv(
    {
      ...UNSET,
      VITE_SUPABASE_URL: "not a url",
      VITE_SUPABASE_PUBLISHABLE_KEY: "secret-pk",
    },
    "development",
  );
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.message).toContain("supabase.url");
    expect(result.error.message).not.toContain("secret-pk");
  }
});

test("VITE_WORLD=dev selects the dev square", () => {
  const result = loadClientEnv({ ...UNSET, VITE_WORLD: "dev" }, "development");
  expect(result).toEqual({
    success: true,
    data: { supabase: null, world: "dev" },
  });
});

test("an unknown VITE_WORLD is an error naming the world", () => {
  const result = loadClientEnv({ ...UNSET, VITE_WORLD: "moon" }, "development");
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.message).toContain("world");
});
