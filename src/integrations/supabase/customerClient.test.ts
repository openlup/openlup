/** @vitest-environment jsdom -- a browser storage adapter; the node env only
 * ever had a store because the shared setup fakes one on `globalThis`. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(() => ({ mocked: true })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

describe("customer Supabase client", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockClear();
  });

  it("is lazy and only detects customer callback URL sessions", async () => {
    const {
      getCustomerSupabase,
      shouldDetectCustomerSessionInUrl,
      CUSTOMER_AUTH_STORAGE_KEY,
    } = await import("./customerClient");

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(shouldDetectCustomerSessionInUrl(new URL("https://openlup.test/konto/auth/callback"))).toBe(true);
    expect(shouldDetectCustomerSessionInUrl(new URL("https://openlup.test/account/auth/callback"))).toBe(true);
    expect(shouldDetectCustomerSessionInUrl(new URL("https://openlup.test/admin/auth/callback"))).toBe(false);

    expect(getCustomerSupabase()).toEqual({ mocked: true });
    expect(getCustomerSupabase()).toEqual({ mocked: true });
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "test-anon-key",
      {
        auth: {
          storage: localStorage,
          storageKey: CUSTOMER_AUTH_STORAGE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: shouldDetectCustomerSessionInUrl,
        },
      },
    );
  });
});
