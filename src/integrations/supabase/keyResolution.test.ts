import { describe, expect, it } from "vitest";

import { resolveSupabasePublishableKey } from "./keyResolution";

describe("resolveSupabasePublishableKey", () => {
  it("prefers the canonical publishable key", () => {
    expect(resolveSupabasePublishableKey({
      VITE_SUPABASE_PUBLISHABLE_KEY: "canonical",
    })).toBe("canonical");
  });

  it("accepts the legacy alias during migration", () => {
    expect(resolveSupabasePublishableKey({
      VITE_SUPABASE_ANON_KEY: "legacy",
    })).toBe("legacy");
  });

  it("prefers the canonical key when both key formats coexist during migration", () => {
    expect(resolveSupabasePublishableKey({
      VITE_SUPABASE_PUBLISHABLE_KEY: "canonical",
      VITE_SUPABASE_ANON_KEY: "legacy-format",
    })).toBe("canonical");
  });
});
