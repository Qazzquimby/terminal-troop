import { expect, test } from "vitest";
import { loadClientEnv } from "./env.js";

const URL = "https://example.supabase.co";

const UNSET = {
  VITE_SUPABASE_URL: undefined,
  VITE_SUPABASE_PUBLISHABLE_KEY: undefined,
  VITE_TRANSPORT: undefined,
  VITE_ICE_SERVERS: undefined,
  VITE_WORLD: undefined,
};

/** What the transport settings load as when left unset. */
const DEFAULT_NET = { transport: "supabase", iceServers: null };

test("no Supabase vars means local-only play", () => {
  const result = loadClientEnv(UNSET, "development");
  expect(result).toEqual({
    success: true,
    data: { supabase: null, ...DEFAULT_NET, world: "standard" },
  });
});

test("empty strings count as unset", () => {
  const result = loadClientEnv(
    {
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_PUBLISHABLE_KEY: "",
      VITE_TRANSPORT: "",
      VITE_ICE_SERVERS: "",
      VITE_WORLD: "",
    },
    "production",
  );
  expect(result).toEqual({
    success: true,
    data: { supabase: null, ...DEFAULT_NET, world: "standard" },
  });
});

test("both vars set configures Supabase", () => {
  const result = loadClientEnv(
    { ...UNSET, VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: "pk" },
    "development",
  );
  expect(result).toEqual({
    success: true,
    data: {
      supabase: { url: URL, publishableKey: "pk" },
      ...DEFAULT_NET,
      world: "standard",
    },
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
    data: { supabase: null, ...DEFAULT_NET, world: "dev" },
  });
});

test("an unknown VITE_WORLD is an error naming the world", () => {
  const result = loadClientEnv({ ...UNSET, VITE_WORLD: "moon" }, "development");
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.message).toContain("world");
});

test("VITE_TRANSPORT=trystero selects data channels, with TURN servers from VITE_ICE_SERVERS", () => {
  const turn = {
    urls: "turn:turn.example:3478",
    username: "u",
    credential: "c",
  };
  const result = loadClientEnv(
    {
      ...UNSET,
      VITE_TRANSPORT: "trystero",
      VITE_ICE_SERVERS: JSON.stringify([turn]),
    },
    "production",
  );
  expect(result).toEqual({
    success: true,
    data: {
      supabase: null,
      transport: "trystero",
      iceServers: [turn],
      world: "standard",
    },
  });
});

test("an unknown VITE_TRANSPORT is an error naming the transport", () => {
  const result = loadClientEnv(
    { ...UNSET, VITE_TRANSPORT: "carrier-pigeon" },
    "development",
  );
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.message).toContain("transport");
});

test("VITE_ICE_SERVERS that is not a JSON list of servers is an error that does not echo it", () => {
  for (const text of ["turn:secret-host", '{"urls":"turn:secret-host"}']) {
    const result = loadClientEnv(
      { ...UNSET, VITE_ICE_SERVERS: text },
      "development",
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("iceServers");
      expect(result.error.message).not.toContain("secret-host");
    }
  }
});
