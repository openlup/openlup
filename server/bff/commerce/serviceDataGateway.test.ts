import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(() => ({ rpc: vi.fn() })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

const ENV_KEYS = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("commerce service data gateway", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockClear();
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
  });

  it("returns null when service-role env is missing", async () => {
    const { readCommerceServiceDataGateway } = await import("./serviceDataGateway.js");
    process.env.SUPABASE_URL = "https://example.supabase.co";

    expect(readCommerceServiceDataGateway()).toBeNull();
  });

  it("builds a service gateway from standard Supabase env", async () => {
    const { readCommerceServiceDataGateway } = await import("./serviceDataGateway.js");
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

    const gateway = readCommerceServiceDataGateway();
    await gateway!.asService(async () => undefined);

    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-key",
      expect.any(Object),
    );
  });

  it("keeps the legacy SUPABASE_SERVICE_KEY fallback for checkout resume", async () => {
    const { readCommerceServiceDataGatewayWithLegacyServiceKeyFallback } = await import(
      "./serviceDataGateway.js"
    );
    process.env.VITE_SUPABASE_URL = "https://fallback.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "legacy-service-key";

    const gateway = readCommerceServiceDataGatewayWithLegacyServiceKeyFallback();
    await gateway!.asService(async () => undefined);

    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://fallback.supabase.co",
      "legacy-service-key",
      expect.any(Object),
    );
  });
});
