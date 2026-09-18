import { describe, expect, it, vi } from "vitest";

import { createSupabaseDataGateway } from "./dataGateway.js";
import type { SupabaseDataGatewayEnv } from "./dataGatewayClientFactory.js";

const ENV: SupabaseDataGatewayEnv = {
  url: "https://proj.supabase.co",
  anonKey: "anon-key",
  serviceRoleKey: "service-role-key",
};

describe("createSupabaseDataGateway", () => {
  it("asService runs work with an elevated (service-role) client", async () => {
    const createClientImpl = vi.fn((url, key) => ({ url, key }));
    const gateway = createSupabaseDataGateway(ENV, { createClientImpl });

    const result = await gateway.asService(async (client) => {
      expect(client).toEqual({ url: "https://proj.supabase.co", key: "service-role-key" });
      return "service-result";
    });

    expect(result).toBe("service-result");
    expect(createClientImpl).toHaveBeenCalledWith("https://proj.supabase.co", "service-role-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it("asActor binds the actor's resolved access token (RLS-safe)", async () => {
    const createClientImpl = vi.fn((url, key, options) => ({ url, key, options }));
    const gateway = createSupabaseDataGateway(ENV, {
      createClientImpl,
      resolveAccessToken: (claims) => (claims?.sub ? `token-for-${claims.sub}` : null),
    });

    await gateway.asActor({ sub: "user-123", role: "authenticated" }, async (client) => {
      expect(client).toEqual({
        url: "https://proj.supabase.co",
        key: "anon-key",
        options: {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: "Bearer token-for-user-123" } },
        },
      });
    });
  });

  it("asActor falls back to an anon client when no token resolves (fail-safe, not elevated)", async () => {
    const createClientImpl = vi.fn((url, key, options) => ({ url, key, options }));
    const gateway = createSupabaseDataGateway(ENV, { createClientImpl });

    await gateway.asActor(null, async () => {});

    expect(createClientImpl).toHaveBeenCalledWith("https://proj.supabase.co", "anon-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: {} },
    });
  });

  it("propagates the work return value and errors", async () => {
    const gateway = createSupabaseDataGateway(ENV, { createClientImpl: () => ({}) });
    await expect(
      gateway.asService(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
