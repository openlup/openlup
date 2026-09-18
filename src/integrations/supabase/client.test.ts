/** @vitest-environment jsdom -- a browser storage adapter; the node env only
 * ever had a store because the shared setup fakes one on `globalThis`. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(() => ({ mocked: true })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

describe("supabase client", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockClear();
  });

  it("creates the Supabase client with admin-only URL session detection", async () => {
    const { supabase, shouldDetectAdminSessionInUrl } = await import("./client");

    expect(supabase).toEqual({ mocked: true });
    expect(shouldDetectAdminSessionInUrl(new URL("https://openlup.test/admin/auth/callback"))).toBe(true);
    expect(shouldDetectAdminSessionInUrl(new URL("https://openlup.test/konto/auth/callback"))).toBe(false);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "test-anon-key",
      {
        auth: {
          storage: localStorage,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: shouldDetectAdminSessionInUrl,
        },
      },
    );
  });

  it("reads the auth callback type from the search query or the hash", async () => {
    const { readAuthCallbackTypeFrom } = await import("./client");

    expect(readAuthCallbackTypeFrom("?type=recovery", "")).toBe("recovery");
    // The magic-link verify redirect carries the type in the hash, not the query.
    expect(readAuthCallbackTypeFrom("", "#access_token=abc&type=magiclink&expires_in=3600")).toBe(
      "magiclink",
    );
    // Search wins when both are present; null when neither carries a type.
    expect(readAuthCallbackTypeFrom("?type=invite", "#type=magiclink")).toBe("invite");
    expect(readAuthCallbackTypeFrom("", "#access_token=abc")).toBeNull();
  });
});
