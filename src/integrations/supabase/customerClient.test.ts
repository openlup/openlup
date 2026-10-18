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
          storage: expect.objectContaining({ getItem: expect.any(Function), setItem: expect.any(Function), removeItem: expect.any(Function) }),
          storageKey: CUSTOMER_AUTH_STORAGE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: shouldDetectCustomerSessionInUrl,
        },
      },
    );
  });
});

it("keeps the SDK storage usable when reads or writes are denied", async () => {
  vi.resetModules();
  const { getCustomerSupabase } = await import("./customerClient");
  getCustomerSupabase();
  const storage = (mockCreateClient.mock.calls[mockCreateClient.mock.calls.length - 1] as unknown as [string, string, { auth: { storage: Storage } }])[2].auth.storage;
  const read = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("denied"); });
  const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("denied"); });
  try {
    expect(storage.getItem("synthetic-key")).toBeNull();
    expect(() => storage.setItem("synthetic-key", "synthetic-value")).not.toThrow();
    expect(storage.getItem("synthetic-key")).toBe("synthetic-value");
    storage.removeItem("synthetic-key");
    expect(storage.getItem("synthetic-key")).toBeNull();
  } finally { read.mockRestore(); write.mockRestore(); }
});

it("offers only the supported configured SDK sign-in descriptor", async () => {
  const { customerSocialProviders } = await import("./customerClient");
  expect(customerSocialProviders([])).toEqual([]);
  expect(customerSocialProviders(["apple", "facebook"])).toEqual([]);
  expect(customerSocialProviders(["google", "apple"])).toEqual([{ kind: "google", displayName: "Google" }]);
});
