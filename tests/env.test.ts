import { expect, test } from "vitest";
import { loadClientEnv } from "../src/env.js";

const URL = "https://example.supabase.co";

test("no Supabase vars means local-only play", () => {
  const result = loadClientEnv(
    { VITE_SUPABASE_URL: undefined, VITE_SUPABASE_PUBLISHABLE_KEY: undefined },
    "development",
  );
  expect(result).toEqual({ success: true, data: { supabase: null } });
});

test("empty strings count as unset", () => {
  const result = loadClientEnv(
    { VITE_SUPABASE_URL: "", VITE_SUPABASE_PUBLISHABLE_KEY: "" },
    "production",
  );
  expect(result).toEqual({ success: true, data: { supabase: null } });
});

test("both vars set configures Supabase", () => {
  const result = loadClientEnv(
    { VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: "pk" },
    "development",
  );
  expect(result).toEqual({
    success: true,
    data: { supabase: { url: URL, publishableKey: "pk" } },
  });
});

test("one var without the other is an error naming the missing one", () => {
  const result = loadClientEnv(
    { VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: undefined },
    "development",
  );
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.message).toContain("publishableKey");
});

test("a malformed URL is an error that does not echo the value", () => {
  const result = loadClientEnv(
    {
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
